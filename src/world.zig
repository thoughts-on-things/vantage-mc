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
    bytes: []const u8,
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

/// Read every `r.X.Z.mca` file in a region directory into memory (once).
pub fn loadRegions(arena: std.mem.Allocator, io: std.Io, region_dir: []const u8) ![]LoadedRegion {
    var out: std.ArrayList(LoadedRegion) = .empty;
    var dir = try std.Io.Dir.cwd().openDir(io, region_dir, .{ .iterate = true });
    defer dir.close(io);
    var it = dir.iterate();
    while (try it.next(io)) |e| {
        if (e.kind != .file) continue;
        const xz = parseRegionName(e.name) orelse continue;
        const path = try std.fmt.allocPrint(arena, "{s}/{s}", .{ region_dir, e.name });
        const bytes = std.Io.Dir.cwd().readFileAlloc(io, path, arena, .unlimited) catch continue;
        try out.append(arena, .{ .x = xz[0], .z = xz[1], .bytes = bytes });
    }
    return out.toOwnedSlice(arena);
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
        if (r.bytes.len < region.SECTOR) continue;
        var i: usize = 0;
        while (i < 1024) : (i += 1) {
            const e = i * 4;
            const off = (@as(u32, r.bytes[e]) << 16) | (@as(u32, r.bytes[e + 1]) << 8) | r.bytes[e + 2];
            if (off == 0 and r.bytes[e + 3] == 0) continue;
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
        if (r.bytes.len < region.SECTOR) continue;
        var i: usize = 0;
        while (i < 1024) : (i += 1) {
            const e = i * 4;
            const off = (@as(u32, r.bytes[e]) << 16) | (@as(u32, r.bytes[e + 1]) << 8) | r.bytes[e + 2];
            if (off == 0 and r.bytes[e + 3] == 0) continue;
            const cx = r.x * 32 + @as(i32, @intCast(i % 32));
            const cz = r.z * 32 + @as(i32, @intCast(i / 32));
            try set.put(packChunk(cx, cz), {});
        }
    }
    return set;
}

/// World spawn from `<save>/level.dat` (gzip-wrapped NBT: Data.SpawnX/Y/Z).
/// Null when the file is absent or unreadable — callers fall back to centring
/// on the populated bounds.
pub fn readSpawn(arena: std.mem.Allocator, io: std.Io, save_dir: []const u8) ?[3]i32 {
    const path = std.fmt.allocPrint(arena, "{s}/level.dat", .{save_dir}) catch return null;
    const raw = std.Io.Dir.cwd().readFileAlloc(io, path, arena, .unlimited) catch return null;
    const bytes = compress.inflateGzip(arena, raw) catch return null;
    var parser = nbt.Parser{ .buf = bytes, .arena = arena };
    const root = parser.parseRoot() catch return null;
    const data = nbt.get(root, "Data") orelse return null;
    if (data.* != .compound) return null;
    const sx = nbt.get(data.compound, "SpawnX") orelse return null;
    const sy = nbt.get(data.compound, "SpawnY") orelse return null;
    const sz = nbt.get(data.compound, "SpawnZ") orelse return null;
    if (sx.* != .int or sy.* != .int or sz.* != .int) return null;
    return .{ sx.int, sy.int, sz.int };
}

/// Assemble a grid over the world-chunk window [cx0..cx1] x [cz0..cz1] (inclusive,
/// world chunk coords), reading from whichever loaded regions overlap it. Decoded
/// chunks share one grid, so faces cull across region boundaries. `prog`, if
/// given, advances once per chunk attempted.
pub fn assembleWindow(
    arena: std.mem.Allocator,
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
        const reg = region.Region.fromBytes(r.bytes);
        var wz = @max(cz0, rcz0);
        while (wz <= @min(cz1, rcz1)) : (wz += 1) {
            var wx = @max(cx0, rcx0);
            while (wx <= @min(cx1, rcx1)) : (wx += 1) {
                if (prog) |p| p.completeOne();
                const lx: u5 = @intCast(wx - rcx0);
                const lz: u5 = @intCast(wz - rcz0);
                const ch = grid.decodeChunk(arena, reg, lx, lz) catch {
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

test "parseRegionName" {
    try std.testing.expectEqual([2]i32{ -2, 1 }, parseRegionName("r.-2.1.mca").?);
    try std.testing.expectEqual([2]i32{ 0, 0 }, parseRegionName("r.0.0.mca").?);
    try std.testing.expect(parseRegionName("r.0.mca") == null);
    try std.testing.expect(parseRegionName("level.dat") == null);
    try std.testing.expect(parseRegionName("r.0.0.mcc") == null);
}
