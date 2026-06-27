//! Dense block grid spanning a rectangular range of chunks.
//!
//! P1 uses a straightforward dense voxel grid rather than the chunk+neighbor
//! streaming the production mesher will use: decode every requested chunk, find
//! the combined bounds, allocate one `[]Cell` covering them, and splat each
//! block in. Cross-chunk face culling then falls out for free because adjacent
//! chunks share the same array. Memory is ~4 bytes/voxel (e.g. a 4x4-chunk slice
//! of a full-height world is ~6 MB), which is fine at P1 scale.

const std = @import("std");
const region = @import("region.zig");
const nbt = @import("nbt.zig");
const chunk = @import("chunk.zig");
const blocks = @import("blocks.zig");

pub const Cell = struct {
    color: [3]u8 = .{ 0, 0, 0 },
    solid: bool = false,
};

pub const Grid = struct {
    /// Dimensions in blocks.
    sx: usize,
    sy: usize,
    sz: usize,
    /// World-space coordinate of grid cell (0,0,0).
    min_x: i32,
    min_y: i32,
    min_z: i32,
    cells: []Cell,

    pub fn index(self: Grid, x: usize, y: usize, z: usize) usize {
        // y-major, then z, then x.
        return (y * self.sz + z) * self.sx + x;
    }

    /// Cell at world-local grid coords; out-of-bounds reads as air. Signed so
    /// the mesher can probe neighbors at -1 / dim without special-casing edges.
    pub fn at(self: Grid, x: isize, y: isize, z: isize) Cell {
        if (x < 0 or y < 0 or z < 0) return .{};
        const ux: usize = @intCast(x);
        const uy: usize = @intCast(y);
        const uz: usize = @intCast(z);
        if (ux >= self.sx or uy >= self.sy or uz >= self.sz) return .{};
        return self.cells[self.index(ux, uy, uz)];
    }
};

pub const Stats = struct {
    chunks_loaded: usize = 0,
    chunks_missing: usize = 0,
};

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

    // Pass 1: decode every requested chunk and collect bounds.
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
        return .{ .sx = 0, .sy = 0, .sz = 0, .min_x = 0, .min_y = 0, .min_z = 0, .cells = &.{} };
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
        .cells = try arena.alloc(Cell, sx * sy * sz),
    };
    @memset(grid.cells, .{});

    // Pass 2: splat each chunk's blocks into the grid.
    for (loaded.items) |ch| {
        // Resolve each section's palette to Cells once, then fill.
        for (ch.sections) |s| {
            const resolved = try arena.alloc(Cell, s.names.len);
            for (s.names, resolved) |name, *cell| {
                const b = blocks.lookup(name);
                cell.* = .{ .color = b.color, .solid = b.solid };
            }
            const base_x: usize = @intCast(ch.x * 16 - min_x);
            const base_z: usize = @intCast(ch.z * 16 - min_z);
            const base_y: usize = @intCast(s.y * 16 - min_y);
            var by: u32 = 0;
            while (by < 16) : (by += 1) {
                var bz: u32 = 0;
                while (bz < 16) : (bz += 1) {
                    var bx: u32 = 0;
                    while (bx < 16) : (bx += 1) {
                        const pidx = s.paletteIndexAt(bx, by, bz);
                        const cell = resolved[pidx];
                        if (!cell.solid) continue;
                        grid.cells[grid.index(base_x + bx, base_y + by, base_z + bz)] = cell;
                    }
                }
            }
        }
    }

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
    const g: Grid = .{ .sx = 0, .sy = 0, .sz = 0, .min_x = 0, .min_y = 0, .min_z = 0, .cells = &.{} };
    try std.testing.expect(!g.at(0, 0, 0).solid);
    try std.testing.expect(!g.at(-1, 5, 100).solid);
}
