//! Dense block grid spanning a rectangular range of chunks.
//!
//! A dense voxel grid is the simplest structure the meshers can share. Each voxel stores an
//! interned block id (0 = air) into a per-grid `names` table, so both the
//! flat-color mesher and the textured mesher can recover the block name (and
//! resolve its model) without re-reading NBT. ~2 bytes/voxel.

const std = @import("std");
const region = @import("region.zig");
const nbt = @import("nbt.zig");
const chunk = @import("chunk.zig");

pub const AIR: u16 = 0;

/// Biome data is stored at 4×4×4-block resolution (matching Anvil), so the
/// biome grid's dimensions are the block dimensions divided by this.
pub const BIOME_STEP = 4;

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
    /// Packed light per voxel: `(sky << 4) | block`, each 0..15. Allocated here
    /// but flood-filled by the mesher's light pass (see `light.zig`) — Minecraft
    /// worlds frequently omit saved light, so we compute it the way BlueMap does.
    /// Filled for *every* cell including air, because a face's brightness comes
    /// from the light of the air cell it faces, not the block it belongs to.
    /// Cells start at open sky (0xF0) before the light pass runs.
    light: []u8 = &.{},
    /// names[0] = "" (air sentinel); names[id] is the block name for id>=1.
    names: [][]const u8,
    /// Parallel to `names`: the block-state key for each id ("" if stateless).
    states: [][]const u8 = &.{},
    /// Biome grid dimensions (= block dims / BIOME_STEP). Zero when no biomes.
    bsx: usize = 0,
    bsy: usize = 0,
    bsz: usize = 0,
    /// Interned biome id per 4×4×4 cell (0 = no-data sentinel).
    biome_ids: []u16 = &.{},
    /// biome_names[0] = "" sentinel; biome_names[id] is the biome name for id>=1.
    biome_names: [][]const u8 = &.{},

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

    /// Packed light at world-local grid coords; out-of-bounds (and ungenerated
    /// cells) read as open sky (sky 15, block 0). Signed so the mesher can sample
    /// the neighbour a face looks toward without special-casing edges.
    pub fn lightAt(self: Grid, x: isize, y: isize, z: isize) u8 {
        const open_sky: u8 = 15 << 4;
        if (self.light.len == 0) return open_sky;
        if (x < 0 or y < 0 or z < 0) return open_sky;
        const ux: usize = @intCast(x);
        const uy: usize = @intCast(y);
        const uz: usize = @intCast(z);
        if (ux >= self.sx or uy >= self.sy or uz >= self.sz) return open_sky;
        return self.light[self.index(ux, uy, uz)];
    }

    pub fn nameOf(self: Grid, id: u16) []const u8 {
        return self.names[id];
    }

    pub fn stateOf(self: Grid, id: u16) []const u8 {
        return if (id < self.states.len) self.states[id] else "";
    }

    pub fn biomeIndex(self: Grid, bx: usize, by: usize, bz: usize) usize {
        return (by * self.bsz + bz) * self.bsx + bx;
    }

    /// Interned biome id for the block at world-local coords (0 = no data).
    pub fn biomeAt(self: Grid, x: usize, y: usize, z: usize) u16 {
        if (self.biome_ids.len == 0) return 0;
        const bx = x / BIOME_STEP;
        const by = y / BIOME_STEP;
        const bz = z / BIOME_STEP;
        if (bx >= self.bsx or by >= self.bsy or bz >= self.bsz) return 0;
        return self.biome_ids[self.biomeIndex(bx, by, bz)];
    }

    pub fn biomeNameOf(self: Grid, id: u16) []const u8 {
        return self.biome_names[id];
    }
};

pub const Stats = struct {
    chunks_loaded: usize = 0,
    chunks_missing: usize = 0,
    distinct_blocks: usize = 0,
    distinct_biomes: usize = 0,
};

/// A half-open XZ sub-box of a grid, in grid-local block coords. Tiled renders
/// assemble each tile with a 1-chunk apron of neighbour data (so culling, AO,
/// light, and biome blending are seam-free across tile borders) but mesh and
/// surface-map only the interior — the apron cells belong to adjacent tiles.
pub const Interior = struct {
    x0: usize,
    z0: usize,
    x1: usize,
    z1: usize,

    /// The whole grid (no apron).
    pub fn full(g: Grid) Interior {
        return .{ .x0 = 0, .z0 = 0, .x1 = g.sx, .z1 = g.sz };
    }

    pub fn contains(self: Interior, x: usize, z: usize) bool {
        return x >= self.x0 and x < self.x1 and z >= self.z0 and z < self.z1;
    }
};

/// A top-down surface map: per world column, the Y of the topmost non-air block
/// and the biome there. Drives fast hover-picking in the viewer — it marches
/// this 2D grid along the camera ray instead of raycasting millions of
/// triangles, so identifying a biome is O(columns along the ray), independent of
/// mesh size. `min_x`/`min_z` give the world origin so the frontend can map a
/// world (x,z) back to a column index.
pub const Surface = struct {
    sx: usize,
    sz: usize,
    min_x: i32,
    min_z: i32,
    biome: []u16, // sx*sz, biome id at the top (0 = no data)
    height: []i16, // sx*sz, world Y of the topmost non-air block (min_y-1 if empty)
};

/// Build the surface map by scanning each column from the top down for the first
/// non-air block. Water/plants count (the hover over an ocean reports the ocean,
/// not the seabed). Cheap relative to meshing — it stops at the first hit.
/// `interior`, if given, restricts the map to that sub-box (a tiled render's
/// interior, excluding the apron); null covers the whole grid.
pub fn buildSurface(arena: std.mem.Allocator, g: Grid, interior: ?Interior) !Surface {
    const in = interior orelse Interior.full(g);
    const sx = in.x1 - in.x0;
    const sz = in.z1 - in.z0;
    const n = sx * sz;
    const biome = try arena.alloc(u16, n);
    const height = try arena.alloc(i16, n);
    @memset(biome, 0);
    const empty: i16 = @intCast(g.min_y - 1);
    var z: usize = in.z0;
    while (z < in.z1) : (z += 1) {
        var x: usize = in.x0;
        while (x < in.x1) : (x += 1) {
            const ci = (z - in.z0) * sx + (x - in.x0);
            height[ci] = empty;
            var y: usize = g.sy;
            while (y > 0) {
                y -= 1;
                if (g.ids[g.index(x, y, z)] != AIR) {
                    height[ci] = @intCast(g.min_y + @as(i32, @intCast(y)));
                    biome[ci] = g.biomeAt(x, y, z);
                    break;
                }
            }
        }
    }
    return .{
        .sx = sx,
        .sz = sz,
        .min_x = g.min_x + @as(i32, @intCast(in.x0)),
        .min_z = g.min_z + @as(i32, @intCast(in.z0)),
        .biome = biome,
        .height = height,
    };
}

const Interner = struct {
    arena: std.mem.Allocator,
    names: std.ArrayList([]const u8) = .empty,
    /// Parallel to `names`: the block-state key per id ("" for biomes / stateless).
    states: std.ArrayList([]const u8) = .empty,
    ids: std.StringHashMap(u16),
    /// When true, air names collapse to id 0 (block grid); when false, id 0 is a
    /// plain "" sentinel and every distinct name gets an id (biome grid).
    skip_air: bool,

    fn init(arena: std.mem.Allocator, skip_air: bool) !Interner {
        var self: Interner = .{ .arena = arena, .ids = std.StringHashMap(u16).init(arena), .skip_air = skip_air };
        try self.names.append(arena, ""); // id 0 = air / no-data sentinel
        try self.states.append(arena, "");
        return self;
    }

    /// Intern a (name, state) pair. Distinct states of the same block get
    /// distinct ids so the resolver can pick the right variant per orientation.
    fn intern(self: *Interner, name: []const u8, state: []const u8) !u16 {
        if (self.skip_air and isAir(name)) return AIR;
        const key = if (state.len == 0) name else try std.fmt.allocPrint(self.arena, "{s}\x00{s}", .{ name, state });
        const gop = try self.ids.getOrPut(key);
        if (!gop.found_existing) {
            const id: u16 = @intCast(self.names.items.len);
            try self.names.append(self.arena, name);
            try self.states.append(self.arena, state);
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
            try loaded.append(arena, ch);
        }
    }
    return buildGrid(arena, loaded.items, stats);
}

/// Build a dense grid from already-decoded chunks (single- or multi-region),
/// sizing it to their tight bounds. Cross-region culling is automatic because
/// adjacent regions' chunks share one grid. All allocations come from `arena`.
pub fn buildGrid(arena: std.mem.Allocator, loaded: []const chunk.Chunk, stats: *Stats) !Grid {
    var min_cx: i32 = std.math.maxInt(i32);
    var max_cx: i32 = std.math.minInt(i32);
    var min_cz: i32 = std.math.maxInt(i32);
    var max_cz: i32 = std.math.minInt(i32);
    var min_sy: i32 = std.math.maxInt(i32);
    var max_sy: i32 = std.math.minInt(i32);
    for (loaded) |ch| {
        min_cx = @min(min_cx, ch.x);
        max_cx = @max(max_cx, ch.x);
        min_cz = @min(min_cz, ch.z);
        max_cz = @max(max_cz, ch.z);
        for (ch.sections) |s| {
            min_sy = @min(min_sy, s.y);
            max_sy = @max(max_sy, s.y);
        }
    }

    if (loaded.len == 0) {
        return .{ .sx = 0, .sy = 0, .sz = 0, .min_x = 0, .min_y = 0, .min_z = 0, .ids = &.{}, .names = &.{} };
    }

    const sx: usize = @intCast((max_cx - min_cx + 1) * 16);
    const sz: usize = @intCast((max_cz - min_cz + 1) * 16);
    const sy: usize = @intCast((max_sy - min_sy + 1) * 16);
    const min_x = min_cx * 16;
    const min_z = min_cz * 16;
    const min_y = min_sy * 16;
    const bsx = sx / BIOME_STEP;
    const bsy = sy / BIOME_STEP;
    const bsz = sz / BIOME_STEP;

    var grid: Grid = .{
        .sx = sx,
        .sy = sy,
        .sz = sz,
        .min_x = min_x,
        .min_y = min_y,
        .min_z = min_z,
        .ids = try arena.alloc(u16, sx * sy * sz),
        .light = try arena.alloc(u8, sx * sy * sz),
        .names = undefined,
        .states = undefined,
        .bsx = bsx,
        .bsy = bsy,
        .bsz = bsz,
        .biome_ids = try arena.alloc(u16, bsx * bsy * bsz),
        .biome_names = undefined,
    };
    @memset(grid.ids, AIR);
    @memset(grid.light, 15 << 4); // default: open sky, no block light
    @memset(grid.biome_ids, 0);

    var interner = try Interner.init(arena, true);
    var biomes = try Interner.init(arena, false);

    for (loaded) |ch| {
        for (ch.sections) |s| {
            // Intern this section's palette once (by name + state).
            const sec_ids = try arena.alloc(u16, s.names.len);
            for (s.names, s.states, sec_ids) |name, state, *id| id.* = try interner.intern(name, state);

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

            // Splat this section's 4×4×4 biome cells into the biome grid.
            if (s.biome_names.len == 0) continue;
            const sec_biome_ids = try arena.alloc(u16, s.biome_names.len);
            for (s.biome_names, sec_biome_ids) |name, *id| id.* = try biomes.intern(name, "");
            const cb_x = base_x / BIOME_STEP;
            const cb_y = base_y / BIOME_STEP;
            const cb_z = base_z / BIOME_STEP;
            var cy: u32 = 0;
            while (cy < 4) : (cy += 1) {
                var cz_: u32 = 0;
                while (cz_ < 4) : (cz_ += 1) {
                    var cx_: u32 = 0;
                    while (cx_ < 4) : (cx_ += 1) {
                        const bid = sec_biome_ids[s.biomeIndexAt(cx_, cy, cz_)];
                        grid.biome_ids[grid.biomeIndex(cb_x + cx_, cb_y + cy, cb_z + cz_)] = bid;
                    }
                }
            }
        }
    }

    grid.names = try interner.names.toOwnedSlice(arena);
    grid.states = try interner.states.toOwnedSlice(arena);
    grid.biome_names = try biomes.names.toOwnedSlice(arena);
    stats.distinct_blocks = grid.names.len - 1;
    stats.distinct_biomes = grid.biome_names.len - 1;
    return grid;
}

pub fn decodeChunk(arena: std.mem.Allocator, reg: region.Region, cx: u5, cz: u5) !?chunk.Chunk {
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
    var it = try Interner.init(a, true);
    try std.testing.expectEqual(AIR, try it.intern("minecraft:air", ""));
    const s1 = try it.intern("minecraft:stone", "");
    const d1 = try it.intern("minecraft:dirt", "");
    try std.testing.expectEqual(s1, try it.intern("minecraft:stone", ""));
    try std.testing.expect(s1 != d1);
    try std.testing.expectEqualStrings("minecraft:stone", it.names.items[s1]);
}

test "interner: distinct states of one block get distinct ids" {
    var arena_inst = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_inst.deinit();
    const a = arena_inst.allocator();
    var it = try Interner.init(a, true);
    const x = try it.intern("minecraft:oak_log", "axis=x");
    const y = try it.intern("minecraft:oak_log", "axis=y");
    try std.testing.expect(x != y);
    try std.testing.expectEqual(x, try it.intern("minecraft:oak_log", "axis=x"));
    try std.testing.expectEqualStrings("minecraft:oak_log", it.names.items[x]);
    try std.testing.expectEqualStrings("axis=x", it.states.items[x]);
    try std.testing.expectEqualStrings("axis=y", it.states.items[y]);
}

test "biome interner does not air-filter and assigns ids from 1" {
    var arena_inst = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_inst.deinit();
    const a = arena_inst.allocator();
    var it = try Interner.init(a, false);
    const p = try it.intern("minecraft:plains", "");
    const sv = try it.intern("minecraft:savanna", "");
    try std.testing.expectEqual(@as(u16, 1), p);
    try std.testing.expectEqual(@as(u16, 2), sv);
    try std.testing.expectEqual(p, try it.intern("minecraft:plains", ""));
}

test "buildSurface finds the topmost block and its biome per column" {
    var arena_inst = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_inst.deinit();
    const a = arena_inst.allocator();
    // 2x4x1 grid (sx=2, sy=4, sz=1). Column x=0 has a block at y=2; x=1 empty.
    var ids = [_]u16{0} ** 8;
    var names = [_][]const u8{ "", "minecraft:stone" };
    var biome_ids = [_]u16{ 0, 5 }; // one 4x4x4 cell per column-ish (bsx=... small grid)
    var biome_names = [_][]const u8{ "", "minecraft:plains", "minecraft:ocean", "x", "y", "z" };
    var g: Grid = .{
        .sx = 2,
        .sy = 4,
        .sz = 1,
        .min_x = 10,
        .min_y = -64,
        .min_z = 20,
        .ids = &ids,
        .names = &names,
        .bsx = 2,
        .bsy = 1,
        .bsz = 1,
        .biome_ids = &biome_ids,
        .biome_names = &biome_names,
    };
    g.ids[g.index(0, 2, 0)] = 1; // top of column x=0 is y=2
    const s = try buildSurface(a, g, null);
    try std.testing.expectEqual(@as(usize, 2), s.sx);
    try std.testing.expectEqual(@as(i32, 10), s.min_x);
    try std.testing.expectEqual(@as(i16, -64 + 2), s.height[0]); // world Y of the block
    try std.testing.expectEqual(@as(u16, 0), s.biome[0]); // biome cell (0,0,0) is id 0
    try std.testing.expectEqual(@as(i16, -64 - 1), s.height[1]); // empty column

    // Interior restriction: only column x=1 (empty), origin shifts by the apron.
    const si = try buildSurface(a, g, .{ .x0 = 1, .z0 = 0, .x1 = 2, .z1 = 1 });
    try std.testing.expectEqual(@as(usize, 1), si.sx);
    try std.testing.expectEqual(@as(usize, 1), si.sz);
    try std.testing.expectEqual(@as(i32, 11), si.min_x);
    try std.testing.expectEqual(@as(i32, 20), si.min_z);
    try std.testing.expectEqual(@as(i16, -64 - 1), si.height[0]);
}

test "biomeAt maps blocks to 4x4x4 cells" {
    // 8x8x8 block grid -> 2x2x2 biome grid; fill cell (1,0,0) with id 7.
    var biome_ids = [_]u16{0} ** 8;
    var biome_names = [_][]const u8{ "", "a", "b", "c", "d", "e", "f", "g" };
    const g: Grid = .{
        .sx = 8,
        .sy = 8,
        .sz = 8,
        .min_x = 0,
        .min_y = 0,
        .min_z = 0,
        .ids = &.{},
        .names = &.{},
        .bsx = 2,
        .bsy = 2,
        .bsz = 2,
        .biome_ids = &biome_ids,
        .biome_names = &biome_names,
    };
    biome_ids[g.biomeIndex(1, 0, 0)] = 7;
    try std.testing.expectEqual(@as(u16, 7), g.biomeAt(4, 0, 0)); // x=4 -> cell x=1
    try std.testing.expectEqual(@as(u16, 7), g.biomeAt(7, 3, 3)); // still cell (1,0,0)
    try std.testing.expectEqual(@as(u16, 0), g.biomeAt(0, 0, 0)); // cell (0,0,0) empty
}
