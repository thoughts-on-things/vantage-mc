//! World-level helpers for the friendly `render` command.
//!
//! Locates a save's overworld region directory (classic `<save>/region` or the
//! newer `<save>/dimensions/minecraft/overworld/region`), loads its region
//! files once, scans the populated chunk bounds from their location tables, and
//! assembles a block grid spanning many regions — so cross-region face culling
//! is automatic, with no seams between regions.

const std = @import("std");
const region = @import("region.zig");
const grid = @import("grid.zig");
const chunk = @import("chunk.zig");
const compress = @import("compress.zig");
const nbt = @import("nbt.zig");

pub const LoadedRegion = struct {
    x: i32,
    z: i32,
    /// The file's location table — its first 4 KiB (shorter if truncated).
    /// Chunk payloads are NOT held here: they're read from `path` per tile
    /// window, so memory stays flat no matter how many regions a world has.
    table: []const u8,
    path: []const u8,
};

pub const ChunkBounds = struct {
    min_cx: i32 = 0,
    min_cz: i32 = 0,
    max_cx: i32 = 0,
    max_cz: i32 = 0,
    count: usize = 0,

    pub fn spanX(self: ChunkBounds) i32 {
        return self.max_cx - self.min_cx + 1;
    }
    pub fn spanZ(self: ChunkBounds) i32 {
        return self.max_cz - self.min_cz + 1;
    }
};

/// Find the overworld region directory for a save path. Accepts a save dir
/// (either layout) or a region dir handed in directly. Returns null if none has
/// `.mca` files.
pub fn findRegionDir(arena: std.mem.Allocator, io: std.Io, save_dir: []const u8) !?[]const u8 {
    const subs = [_][]const u8{
        "", // already a region dir
        "/region",
        "/dimensions/minecraft/overworld/region",
    };
    for (subs) |sub| {
        const path = try std.fmt.allocPrint(arena, "{s}{s}", .{ save_dir, sub });
        if (try dirHasMca(io, path)) return path;
    }
    return null;
}

fn dirHasMca(io: std.Io, path: []const u8) !bool {
    var dir = std.Io.Dir.cwd().openDir(io, path, .{ .iterate = true }) catch return false;
    defer dir.close(io);
    var it = dir.iterate();
    while (try it.next(io)) |e| {
        if (e.kind == .file and parseRegionName(e.name) != null) return true;
    }
    return false;
}

/// Index every `r.X.Z.mca` file in a region directory (once). Only the 4 KiB
/// location table of each file is read here — a large world's region set can
/// be tens of GB, which used to be loaded whole and held for the entire
/// render, OOM-killing the process. Payloads stream in `assembleWindow`.
pub fn loadRegions(arena: std.mem.Allocator, io: std.Io, region_dir: []const u8) ![]LoadedRegion {
    var out: std.ArrayList(LoadedRegion) = .empty;
    var dir = try std.Io.Dir.cwd().openDir(io, region_dir, .{ .iterate = true });
    defer dir.close(io);
    var it = dir.iterate();
    while (try it.next(io)) |e| {
        if (e.kind != .file) continue;
        const xz = parseRegionName(e.name) orelse continue;
        const path = try std.fmt.allocPrint(arena, "{s}/{s}", .{ region_dir, e.name });
        const table = readLocationTable(arena, io, path) catch continue;
        try out.append(arena, .{ .x = xz[0], .z = xz[1], .table = table, .path = path });
    }
    return out.toOwnedSlice(arena);
}

fn readLocationTable(arena: std.mem.Allocator, io: std.Io, path: []const u8) ![]const u8 {
    var file = try std.Io.Dir.cwd().openFile(io, path, .{});
    defer file.close(io);
    const buf = try arena.alloc(u8, region.SECTOR);
    const n = try file.readPositionalAll(io, buf, 0);
    return buf[0..n];
}

/// "r.-2.1.mca" -> {-2, 1}.
fn parseRegionName(name: []const u8) ?[2]i32 {
    if (!std.mem.startsWith(u8, name, "r.")) return null;
    if (!std.mem.endsWith(u8, name, ".mca")) return null;
    const mid = name["r.".len .. name.len - ".mca".len];
    const dot = std.mem.indexOfScalar(u8, mid, '.') orelse return null;
    const x = std.fmt.parseInt(i32, mid[0..dot], 10) catch return null;
    const z = std.fmt.parseInt(i32, mid[dot + 1 ..], 10) catch return null;
    return .{ x, z };
}

/// Bounding box + count of populated chunks, read from region location tables
/// already in memory (no extra I/O).
pub fn populatedBounds(regions: []const LoadedRegion) ChunkBounds {
    var b: ChunkBounds = .{
        .min_cx = std.math.maxInt(i32),
        .min_cz = std.math.maxInt(i32),
        .max_cx = std.math.minInt(i32),
        .max_cz = std.math.minInt(i32),
    };
    for (regions) |r| {
        if (r.table.len < region.SECTOR) continue;
        var i: usize = 0;
        while (i < 1024) : (i += 1) {
            const e = i * 4;
            const off = (@as(u32, r.table[e]) << 16) | (@as(u32, r.table[e + 1]) << 8) | r.table[e + 2];
            if (off == 0 and r.table[e + 3] == 0) continue;
            const cx = r.x * 32 + @as(i32, @intCast(i % 32));
            const cz = r.z * 32 + @as(i32, @intCast(i / 32));
            b.min_cx = @min(b.min_cx, cx);
            b.max_cx = @max(b.max_cx, cx);
            b.min_cz = @min(b.min_cz, cz);
            b.max_cz = @max(b.max_cz, cz);
            b.count += 1;
        }
    }
    if (b.count == 0) b = .{};
    return b;
}

/// Pack signed chunk coords into one map key.
pub fn packChunk(cx: i32, cz: i32) u64 {
    return (@as(u64, @as(u32, @bitCast(cx))) << 32) | @as(u32, @bitCast(cz));
}

/// The set of populated chunk coords (packed with `packChunk`), read from the
/// region location tables already in memory — no chunk I/O. Sparse worlds (a
/// few trails across hundreds of regions) tile-enumerate from this instead of
/// the bounding box, so empty tiles are never visited.
pub fn populatedChunks(arena: std.mem.Allocator, regions: []const LoadedRegion) !std.AutoHashMap(u64, void) {
    var set = std.AutoHashMap(u64, void).init(arena);
    for (regions) |r| {
        if (r.table.len < region.SECTOR) continue;
        var i: usize = 0;
        while (i < 1024) : (i += 1) {
            const e = i * 4;
            const off = (@as(u32, r.table[e]) << 16) | (@as(u32, r.table[e + 1]) << 8) | r.table[e + 2];
            if (off == 0 and r.table[e + 3] == 0) continue;
            const cx = r.x * 32 + @as(i32, @intCast(i % 32));
            const cz = r.z * 32 + @as(i32, @intCast(i / 32));
            try set.put(packChunk(cx, cz), {});
        }
    }
    return set;
}

/// World spawn from `<save>/level.dat` (gzip-wrapped NBT). Modern saves
/// (1.21.5+) store `Data.spawn.pos` as a 3-int array; older ones store
/// `Data.SpawnX/Y/Z`. Null when the file is absent or unreadable — callers
/// fall back to centring on the populated bounds.
pub fn readSpawn(arena: std.mem.Allocator, io: std.Io, save_dir: []const u8) ?[3]i32 {
    const path = std.fmt.allocPrint(arena, "{s}/level.dat", .{save_dir}) catch return null;
    const raw = std.Io.Dir.cwd().readFileAlloc(io, path, arena, .unlimited) catch return null;
    const bytes = compress.inflateGzip(arena, raw) catch return null;
    var parser = nbt.Parser{ .buf = bytes, .arena = arena };
    const root = parser.parseRoot() catch return null;
    const data = nbt.get(root, "Data") orelse return null;
    if (data.* != .compound) return null;

    // Modern layout: spawn { pos: [x, y, z], dimension, yaw, pitch }.
    if (nbt.get(data.compound, "spawn")) |sp| {
        if (sp.* == .compound) {
            if (nbt.get(sp.compound, "pos")) |pos| {
                if (pos.* == .int_array and pos.int_array.len >= 3) {
                    return .{ pos.int_array[0], pos.int_array[1], pos.int_array[2] };
                }
            }
        }
    }

    // Legacy layout: SpawnX / SpawnY / SpawnZ ints.
    const sx = nbt.get(data.compound, "SpawnX") orelse return null;
    const sy = nbt.get(data.compound, "SpawnY") orelse return null;
    const sz = nbt.get(data.compound, "SpawnZ") orelse return null;
    if (sx.* != .int or sy.* != .int or sz.* != .int) return null;
    return .{ sx.int, sy.int, sz.int };
}

/// Assemble a grid over the world-chunk window [cx0..cx1] x [cz0..cz1] (inclusive,
/// world chunk coords), reading from whichever loaded regions overlap it. Chunk
/// payloads are read from disk here (positional reads guided by the in-memory
/// location tables) into `arena` — a tile's window is the only chunk data ever
/// resident, so memory doesn't scale with world size. Decoded chunks share one
/// grid, so faces cull across region boundaries. `prog`, if given, advances
/// once per chunk attempted.
pub fn assembleWindow(
    arena: std.mem.Allocator,
    io: std.Io,
    loaded: []const LoadedRegion,
    cx0: i32,
    cz0: i32,
    cx1: i32,
    cz1: i32,
    stats: *grid.Stats,
    prog: ?std.Progress.Node,
) !grid.Grid {
    var chunks: std.ArrayList(chunk.Chunk) = .empty;
    for (loaded) |r| {
        const rcx0 = r.x * 32;
        const rcz0 = r.z * 32;
        const rcx1 = rcx0 + 31;
        const rcz1 = rcz0 + 31;
        if (rcx1 < cx0 or rcx0 > cx1 or rcz1 < cz0 or rcz0 > cz1) continue;
        // One handle per overlapping region for the whole window — workers on
        // other tiles hold their own, so there's no shared-seek state.
        var file = std.Io.Dir.cwd().openFile(io, r.path, .{}) catch {
            // The file vanished or turned unreadable since the scan; its
            // chunks are counted missing as the window walks them below.
            continue;
        };
        defer file.close(io);
        var wz = @max(cz0, rcz0);
        while (wz <= @min(cz1, rcz1)) : (wz += 1) {
            var wx = @max(cx0, rcx0);
            while (wx <= @min(cx1, rcx1)) : (wx += 1) {
                if (prog) |p| p.completeOne();
                const lx: u5 = @intCast(wx - rcx0);
                const lz: u5 = @intCast(wz - rcz0);
                const loc = region.locate(r.table, lx, lz) orelse {
                    stats.chunks_missing += 1;
                    continue;
                };
                const ch = decodeChunkAt(arena, io, file, loc) catch |err| {
                    switch (err) {
                        error.PreModernChunk => stats.chunks_premodern += 1,
                        error.UnsupportedCompression, error.ExternalChunk => stats.chunks_unreadable += 1,
                        else => {},
                    }
                    stats.chunks_missing += 1;
                    continue;
                } orelse {
                    stats.chunks_missing += 1;
                    continue;
                };
                if (ch.sections.len == 0) {
                    stats.chunks_missing += 1;
                    continue;
                }
                stats.chunks_loaded += 1;
                try chunks.append(arena, ch);
            }
        }
    }
    return grid.buildGrid(arena, chunks.items, stats);
}

/// Read one chunk's sectors from an open region file and decode it. The raw
/// sector buffer, NBT bytes, and decoded sections all come from `arena` (the
/// caller's per-tile arena), freed together when the tile completes.
fn decodeChunkAt(arena: std.mem.Allocator, io: std.Io, file: std.Io.File, loc: region.Loc) !?chunk.Chunk {
    const size: usize = @as(usize, loc.sector_count) * region.SECTOR;
    if (size == 0) return null;
    const buf = try arena.alloc(u8, size);
    const n = try file.readPositionalAll(io, buf, @as(u64, loc.offset_sectors) * region.SECTOR);
    const raw = (try region.rawChunkFromSectors(buf[0..n])) orelse return null;
    const nbt_bytes = try region.decompress(arena, raw);
    var parser = nbt.Parser{ .buf = nbt_bytes, .arena = arena };
    const root = try parser.parseRoot();
    return try chunk.decode(arena, root);
}

test "parseRegionName" {
    try std.testing.expectEqual([2]i32{ -2, 1 }, parseRegionName("r.-2.1.mca").?);
    try std.testing.expectEqual([2]i32{ 0, 0 }, parseRegionName("r.0.0.mca").?);
    try std.testing.expect(parseRegionName("r.0.mca") == null);
    try std.testing.expect(parseRegionName("level.dat") == null);
    try std.testing.expect(parseRegionName("r.0.0.mcc") == null);
}
