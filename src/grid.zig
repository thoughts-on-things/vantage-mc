//! Dense block grid spanning a rectangular range of chunks.
//!
//! P1 used a dense voxel grid for simplicity over the chunk+neighbor streaming
//! the production mesher will eventually use; P2 keeps it. Each voxel stores an
//! interned block id (0 = air) into a per-grid `names` table, so both the
//! flat-color mesher and the textured mesher can recover the block name (and
//! resolve its model) without re-reading NBT. ~2 bytes/voxel.

const std = @import("std");
const region = @import("region.zig");
const nbt = @import("nbt.zig");
const chunk = @import("chunk.zig");

pub const AIR: u16 = 0;

pub const Grid = struct {
    /// Dimensions in blocks.
    sx: usize,
    sy: usize,
    sz: usize,
    /// World-space coordinate of grid cell (0,0,0).
    min_x: i32,
    min_y: i32,
    min_z: i32,
    /// Interned block id per voxel (0 = air).
    ids: []u16,
    /// names[0] = "" (air sentinel); names[id] is the block name for id>=1.
    names: [][]const u8,

    pub fn index(self: Grid, x: usize, y: usize, z: usize) usize {
        return (y * self.sz + z) * self.sx + x; // y-major, then z, then x
    }

    /// Block id at world-local grid coords; out-of-bounds reads as air. Signed so
    /// the mesher can probe neighbors at -1 / dim without special-casing edges.
    pub fn at(self: Grid, x: isize, y: isize, z: isize) u16 {
        if (x < 0 or y < 0 or z < 0) return AIR;
        const ux: usize = @intCast(x);
        const uy: usize = @intCast(y);
        const uz: usize = @intCast(z);
        if (ux >= self.sx or uy >= self.sy or uz >= self.sz) return AIR;
        return self.ids[self.index(ux, uy, uz)];
    }

    pub fn nameOf(self: Grid, id: u16) []const u8 {
        return self.names[id];
    }
};

pub const Stats = struct {
    chunks_loaded: usize = 0,
    chunks_missing: usize = 0,
    distinct_blocks: usize = 0,
};

const Interner = struct {
    arena: std.mem.Allocator,
    names: std.ArrayList([]const u8) = .empty,
    ids: std.StringHashMap(u16),

    fn init(arena: std.mem.Allocator) !Interner {
        var self: Interner = .{ .arena = arena, .ids = std.StringHashMap(u16).init(arena) };
        try self.names.append(arena, ""); // id 0 = air sentinel
        return self;
    }

    fn intern(self: *Interner, name: []const u8) !u16 {
        if (isAir(name)) return AIR;
        const gop = try self.ids.getOrPut(name);
        if (!gop.found_existing) {
            const id: u16 = @intCast(self.names.items.len);
            try self.names.append(self.arena, name);
            gop.value_ptr.* = id;
        }
        return gop.value_ptr.*;
    }
};

fn isAir(name: []const u8) bool {
    return std.mem.eql(u8, name, "minecraft:air") or
        std.mem.eql(u8, name, "minecraft:cave_air") or
        std.mem.eql(u8, name, "minecraft:void_air");
}

/// Assemble a grid over region-local chunk coords [cx0..cx1] x [cz0..cz1]
/// (inclusive, each 0..31). Chunks that are absent or fail to decode are skipped
/// (counted in `stats`), never fatal.
pub fn assemble(
    arena: std.mem.Allocator,
    region_bytes: []const u8,
    cx0: u5,
    cz0: u5,
    cx1: u5,
    cz1: u5,
    stats: *Stats,
) !Grid {
    const reg = region.Region.fromBytes(region_bytes);

    var loaded: std.ArrayList(chunk.Chunk) = .empty;
    var min_cx: i32 = std.math.maxInt(i32);
    var max_cx: i32 = std.math.minInt(i32);
    var min_cz: i32 = std.math.maxInt(i32);
    var max_cz: i32 = std.math.minInt(i32);
    var min_sy: i32 = std.math.maxInt(i32);
    var max_sy: i32 = std.math.minInt(i32);

    var cz: u32 = cz0;
    while (cz <= cz1) : (cz += 1) {
        var cx: u32 = cx0;
        while (cx <= cx1) : (cx += 1) {
            const ch = decodeChunk(arena, reg, @intCast(cx), @intCast(cz)) catch {
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
            min_cx = @min(min_cx, ch.x);
            max_cx = @max(max_cx, ch.x);
            min_cz = @min(min_cz, ch.z);
            max_cz = @max(max_cz, ch.z);
            for (ch.sections) |s| {
                min_sy = @min(min_sy, s.y);
                max_sy = @max(max_sy, s.y);
            }
            try loaded.append(arena, ch);
        }
    }

    if (loaded.items.len == 0) {
        return .{ .sx = 0, .sy = 0, .sz = 0, .min_x = 0, .min_y = 0, .min_z = 0, .ids = &.{}, .names = &.{} };
    }

    const sx: usize = @intCast((max_cx - min_cx + 1) * 16);
    const sz: usize = @intCast((max_cz - min_cz + 1) * 16);
    const sy: usize = @intCast((max_sy - min_sy + 1) * 16);
    const min_x = min_cx * 16;
    const min_z = min_cz * 16;
    const min_y = min_sy * 16;

    var grid: Grid = .{
        .sx = sx,
        .sy = sy,
        .sz = sz,
        .min_x = min_x,
        .min_y = min_y,
        .min_z = min_z,
        .ids = try arena.alloc(u16, sx * sy * sz),
        .names = undefined,
    };
    @memset(grid.ids, AIR);

    var interner = try Interner.init(arena);

    for (loaded.items) |ch| {
        for (ch.sections) |s| {
            // Intern this section's palette once.
            const sec_ids = try arena.alloc(u16, s.names.len);
            for (s.names, sec_ids) |name, *id| id.* = try interner.intern(name);

            const base_x: usize = @intCast(ch.x * 16 - min_x);
            const base_z: usize = @intCast(ch.z * 16 - min_z);
            const base_y: usize = @intCast(s.y * 16 - min_y);
            var by: u32 = 0;
            while (by < 16) : (by += 1) {
                var bz: u32 = 0;
                while (bz < 16) : (bz += 1) {
                    var bx: u32 = 0;
                    while (bx < 16) : (bx += 1) {
                        const id = sec_ids[s.paletteIndexAt(bx, by, bz)];
                        if (id == AIR) continue;
                        grid.ids[grid.index(base_x + bx, base_y + by, base_z + bz)] = id;
                    }
                }
            }
        }
    }

    grid.names = try interner.names.toOwnedSlice(arena);
    stats.distinct_blocks = grid.names.len - 1;
    return grid;
}

fn decodeChunk(arena: std.mem.Allocator, reg: region.Region, cx: u5, cz: u5) !?chunk.Chunk {
    const raw = (try reg.rawChunk(cx, cz)) orelse return null;
    const nbt_bytes = try region.decompress(arena, raw);
    var parser = nbt.Parser{ .buf = nbt_bytes, .arena = arena };
    const root = try parser.parseRoot();
    return try chunk.decode(arena, root);
}

test "empty grid reads as air everywhere" {
    const g: Grid = .{ .sx = 0, .sy = 0, .sz = 0, .min_x = 0, .min_y = 0, .min_z = 0, .ids = &.{}, .names = &.{} };
    try std.testing.expectEqual(AIR, g.at(0, 0, 0));
    try std.testing.expectEqual(AIR, g.at(-1, 5, 100));
}

test "interner: air is 0, names get stable ids" {
    var arena_inst = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_inst.deinit();
    const a = arena_inst.allocator();
    var it = try Interner.init(a);
    try std.testing.expectEqual(AIR, try it.intern("minecraft:air"));
    const s1 = try it.intern("minecraft:stone");
    const d1 = try it.intern("minecraft:dirt");
    try std.testing.expectEqual(s1, try it.intern("minecraft:stone"));
    try std.testing.expect(s1 != d1);
    try std.testing.expectEqualStrings("minecraft:stone", it.names.items[s1]);
}
