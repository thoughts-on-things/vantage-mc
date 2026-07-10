//! Lowres LOD pyramid — the data behind whole-world zoom-out.
//!
//! Every rendered tile also yields a per-column *color map*: the top block's
//! average texture color, biome-tinted and shaded by sky light (with a depth
//! darkening for water), plus the surface height. Maps downsample 2× per level
//! into a quadtree; each level-L lowres tile covers `tile_blocks << L` blocks
//! with a fixed 128×128 cell grid, so triangle density per block² falls 4× per
//! level and the whole world is a handful of tiles at the top.
//!
//! Serialized as `VLR1` (gzip-wrapped like hires tiles):
//!   "VLR1", u32 ver=1, u32 gw, u32 gh, i32 origin_x, i32 origin_z, u32 span,
//!   i16 height[gw*gh], u8 rgb[3*gw*gh], pad to 4.
//! The grid is `cells+1` per edge: the last row/column duplicates the first
//! cells of the +x/+z neighbour tiles, so adjacent heightfield meshes share
//! edge vertices and tile seamlessly. `span` is blocks per cell; sample (i,j)
//! sits at world (origin_x + (i+0.5)·span, origin_z + (j+0.5)·span).

const std = @import("std");
const grid = @import("grid.zig");
const model = @import("model.zig");
const texture = @import("texture.zig");
const biome = @import("biome.zig");
const blocks = @import("blocks.zig");

/// Cells per lowres tile edge (the serialized grid adds +1 apron).
pub const CELLS: u32 = 128;

/// Height sentinel for cells with no terrain (unpopulated chunks).
pub const EMPTY: i16 = std.math.minInt(i16);

/// A per-cell (color, height) map over a square footprint. Level 0 maps come
/// from `buildColorMap` (one cell per block column); higher levels from
/// `downsample` (2× the span per level, always CELLS×CELLS cells).
pub const ColorMap = struct {
    /// Cells per edge (CELLS for tile maps).
    size: u32,
    /// World block coords of cell (0,0)'s corner.
    min_x: i32,
    min_z: i32,
    /// Blocks per cell edge (1 at level 0, 2^L at level L).
    span: u32,
    rgb: []u8, // 3 per cell
    height: []i16, // world Y of the top block, EMPTY if none

    pub fn idx(self: ColorMap, x: usize, z: usize) usize {
        return z * self.size + x;
    }
};

/// Memoized top-face colors: block (name,state) -> average texture RGB + tint
/// kind. Shared across every tile of a render (like the model-resolver memo).
pub const SurfaceColors = struct {
    arena: std.mem.Allocator,
    resolver: model.Resolver,
    tex: *texture.Builder,
    maps: biome.Colormaps,
    reg: *biome.Registry,
    memo: std.StringHashMap(Base),
    /// Guards `memo` when tiles build color maps on multiple threads.
    mutex: std.Io.Mutex = .init,

    pub const Base = struct { rgb: [3]u8, tint: biome.Tint };

    pub fn init(
        arena: std.mem.Allocator,
        resolver: model.Resolver,
        tex: *texture.Builder,
        maps: biome.Colormaps,
        reg: *biome.Registry,
    ) SurfaceColors {
        return .{
            .arena = arena,
            .resolver = resolver,
            .tex = tex,
            .maps = maps,
            .reg = reg,
            .memo = std.StringHashMap(Base).init(arena),
        };
    }

    /// The untinted average color of a block's top texture (and whether/what to
    /// tint it), from its resolved model's up face. Falls back to any face,
    /// then to the curated flat block color, so it never fails.
    pub fn baseFor(self: *SurfaceColors, name: []const u8, state: []const u8) Base {
        self.mutex.lockUncancelable(self.resolver.io);
        defer self.mutex.unlock(self.resolver.io);
        const key = std.fmt.allocPrint(self.arena, "{s}\x00{s}", .{ name, state }) catch return fallbackBase(name);
        const gop = self.memo.getOrPut(key) catch return fallbackBase(name);
        if (gop.found_existing) return gop.value_ptr.*;
        gop.value_ptr.* = self.computeBase(name, state);
        return gop.value_ptr.*;
    }

    fn computeBase(self: *SurfaceColors, name: []const u8, state: []const u8) Base {
        const parts = self.resolver.resolveBlock(name, state) catch return fallbackBase(name);
        // Prefer the up face (what a map sees); else the first face at all.
        var chosen: ?model.Face = null;
        for (parts) |rm| {
            for (rm.elements) |el| {
                for (el.faces) |f| {
                    if (chosen == null) chosen = f;
                    if (f.dir == .up) {
                        chosen = f;
                        break;
                    }
                }
            }
        }
        const face = chosen orelse return fallbackBase(name);
        const layer = self.tex.layerFor(face.texture);
        const avg = averageLayer(self.tex.layerPixels(layer)) orelse return fallbackBase(name);
        const tint: biome.Tint = if (face.tintindex >= 0) biome.blockTint(name) else .none;
        return .{ .rgb = avg, .tint = tint };
    }
};

fn fallbackBase(name: []const u8) SurfaceColors.Base {
    return .{ .rgb = blocks.lookup(name).color, .tint = .none };
}

/// Alpha-weighted average RGB of one 16×16 RGBA texture layer; null when the
/// layer is fully transparent.
fn averageLayer(pixels: []const u8) ?[3]u8 {
    var r: u64 = 0;
    var g: u64 = 0;
    var b: u64 = 0;
    var w: u64 = 0;
    var i: usize = 0;
    while (i < pixels.len) : (i += 4) {
        const a: u64 = pixels[i + 3];
        r += @as(u64, pixels[i + 0]) * a;
        g += @as(u64, pixels[i + 1]) * a;
        b += @as(u64, pixels[i + 2]) * a;
        w += a;
    }
    if (w == 0) return null;
    return .{ @intCast(r / w), @intCast(g / w), @intCast(b / w) };
}

fn isWaterish(name: []const u8) bool {
    return std.mem.indexOf(u8, name, "water") != null or
        std.mem.indexOf(u8, name, "kelp") != null or
        std.mem.indexOf(u8, name, "seagrass") != null or
        std.mem.indexOf(u8, name, "bubble_column") != null;
}

/// Canopy-ish blocks: they give a column its COLOR but not its HEIGHT. Lowres
/// heights follow the ground (like the game's MOTION_BLOCKING_NO_LEAVES
/// heightmap) because level-1 underlays live hires tiles — a cell at canopy
/// height would float above the hires forest floor and show through every gap
/// in the leaves. Ground height keeps the underlay strictly beneath resident
/// hires terrain while distant forests still read green.
fn isFoliage(name: []const u8) bool {
    const needles = [_][]const u8{
        "leaves", "log",       "_wood",   "mushroom", "bamboo", "vine",
        "azalea", "propagule", "sapling", "cocoa",
    };
    for (needles) |nd| {
        if (std.mem.indexOf(u8, name, nd) != null) return true;
    }
    return false;
}

/// Minecraft's lightmap brightness curve (matches the viewer shader), with the
/// same readability floor so lowres and hires shading agree.
fn lightAmt(sky: f32) f32 {
    const l = sky / 15.0;
    const curve = l / (4.0 - 3.0 * l);
    return 0.12 + 0.88 * curve;
}

/// Build the level-0 color map for a tile: one cell per block column over the
/// FULL tile footprint (`size`² blocks from world (`min_x`,`min_z`)), colored
/// like the map view of the world — top texture × biome tint × sky light,
/// water darkened by depth toward deep-blue. Columns outside the assembled
/// grid's interior (unpopulated edge chunks) read EMPTY, keeping every tile's
/// map the same shape for the quadtree downsampler.
pub fn buildColorMap(
    arena: std.mem.Allocator,
    g: grid.Grid,
    interior: grid.Interior,
    colors: *SurfaceColors,
    min_x: i32,
    min_z: i32,
    size: u32,
) !ColorMap {
    const n: usize = @as(usize, size) * size;
    const rgb = try arena.alloc(u8, 3 * n);
    const height = try arena.alloc(i16, n);
    @memset(rgb, 0);
    @memset(height, EMPTY);

    var cz: usize = 0;
    while (cz < size) : (cz += 1) {
        var cx: usize = 0;
        while (cx < size) : (cx += 1) {
            const gx = @as(i64, min_x) + @as(i64, @intCast(cx)) - g.min_x;
            const gz = @as(i64, min_z) + @as(i64, @intCast(cz)) - g.min_z;
            if (gx < 0 or gz < 0) continue;
            const x: usize = @intCast(gx);
            const z: usize = @intCast(gz);
            if (!interior.contains(x, z)) continue;
            const ci = cz * size + cx;
            var y: usize = g.sy;
            while (y > 0) {
                y -= 1;
                const id = g.ids[g.index(x, y, z)];
                if (id == grid.AIR) continue;

                height[ci] = @intCast(g.min_y + @as(i32, @intCast(y)));
                const name = g.nameOf(id);
                const info = colors.reg.lookup(g.biomeNameOf(g.biomeAt(x, y, z)));
                const sky: f32 = @floatFromInt(g.lightAt(@intCast(x), @as(isize, @intCast(y)) + 1, @intCast(z)) >> 4);
                var c: [3]f32 = undefined;

                if (isWaterish(name)) {
                    // Water: composite the biome water tint over the seabed's
                    // color with the SAME depth-driven alpha and cooling the
                    // hires water shader uses, so the lowres ring is
                    // indistinguishable from real translucent water at range.
                    var depth: usize = 0;
                    var wy = y;
                    var seabed: u16 = grid.AIR;
                    while (wy > 0) : (depth += 1) {
                        wy -= 1;
                        const below = g.ids[g.index(x, wy, z)];
                        if (below == grid.AIR) break;
                        if (!isWaterish(g.nameOf(below))) {
                            seabed = below;
                            break;
                        }
                    }
                    // Record the SEABED height, not the surface: level-1 lowres
                    // underlays the live hires disc, and hires water is
                    // translucent (no depth write) — a lowres plane at surface
                    // height would depth-kill any deeper hires seabed and
                    // shatter shorelines. At the seabed it hides under
                    // everything; where only lowres is resident the flattened
                    // water is imperceptible at range.
                    height[ci] = @intCast(g.min_y + @as(i32, @intCast(wy)));
                    const d = @min(@as(f32, @floatFromInt(depth)), 14.0) / 14.0;
                    const wcol = biome.colorFor(colors.maps, .water, info);
                    const cool = [3]f32{ 0.55, 0.66, 0.85 };
                    var sb = [3]f32{ 0.55, 0.5, 0.4 }; // generic sediment fallback
                    if (seabed != grid.AIR) {
                        const sbase = colors.baseFor(g.nameOf(seabed), g.stateOf(seabed));
                        for (0..3) |k| sb[k] = @as(f32, @floatFromInt(sbase.rgb[k])) / 255.0;
                        if (sbase.tint != .none) {
                            const tc = biome.colorFor(colors.maps, sbase.tint, info);
                            for (0..3) |k| sb[k] *= @as(f32, @floatFromInt(tc[k])) / 255.0;
                        }
                    }
                    const alpha = std.math.lerp(0.5, 0.74, d);
                    for (0..3) |k| {
                        var w = @as(f32, @floatFromInt(wcol[k])) / 255.0;
                        w *= std.math.lerp(1.0, cool[k], 0.7 * d) * 0.9;
                        c[k] = std.math.lerp(sb[k], w, alpha);
                    }
                } else {
                    const base = colors.baseFor(name, g.stateOf(id));
                    for (0..3) |k| c[k] = @as(f32, @floatFromInt(base.rgb[k])) / 255.0;
                    if (base.tint != .none) {
                        const tc = biome.colorFor(colors.maps, base.tint, info);
                        for (0..3) |k| c[k] *= @as(f32, @floatFromInt(tc[k])) / 255.0;
                    }
                    // Trees: canopy colors the cell, the GROUND heights it (see
                    // isFoliage). Skips the air gaps under leaf overhangs too.
                    if (isFoliage(name)) {
                        var gy = y;
                        while (gy > 0) {
                            gy -= 1;
                            const bid = g.ids[g.index(x, gy, z)];
                            if (bid == grid.AIR) continue;
                            if (isFoliage(g.nameOf(bid))) continue;
                            height[ci] = @intCast(g.min_y + @as(i32, @intCast(gy)));
                            break;
                        }
                    }
                }

                const amt = lightAmt(sky);
                for (0..3) |k| {
                    rgb[3 * ci + k] = @intFromFloat(std.math.clamp(c[k] * amt, 0.0, 1.0) * 255.0);
                }
                break;
            }
        }
    }

    return .{ .size = size, .min_x = min_x, .min_z = min_z, .span = 1, .rgb = rgb, .height = height };
}

/// Build a level-L map from up to 4 level-(L-1) children (quadrants; null =
/// unpopulated). Output has the same cell count as its children — half the
/// cells per child, double the span. Color averages the 2×2 finer cells
/// (non-empty only); height takes the max so ridgelines survive downsampling.
pub fn downsample(
    arena: std.mem.Allocator,
    children: [2][2]?*const ColorMap, // [qz][qx]
    min_x: i32,
    min_z: i32,
    span: u32,
) !ColorMap {
    var size: u32 = CELLS;
    for (children) |row| {
        for (row) |c| {
            if (c) |cc| size = cc.size;
        }
    }
    const n: usize = @as(usize, size) * size;
    const rgb = try arena.alloc(u8, 3 * n);
    const height = try arena.alloc(i16, n);
    @memset(rgb, 0);

    const half: usize = size / 2;
    var z: usize = 0;
    while (z < size) : (z += 1) {
        var x: usize = 0;
        while (x < size) : (x += 1) {
            const ci = z * size + x;
            height[ci] = EMPTY;
            const child = children[z / half][x / half] orelse continue;
            const lx = (x % half) * 2;
            const lz = (z % half) * 2;
            var r: u32 = 0;
            var gr: u32 = 0;
            var b: u32 = 0;
            var cnt: u32 = 0;
            var hmax: i16 = EMPTY;
            for (0..2) |dz| {
                for (0..2) |dx| {
                    const si = child.idx(lx + dx, lz + dz);
                    const h = child.height[si];
                    if (h == EMPTY) continue;
                    cnt += 1;
                    hmax = @max(hmax, h);
                    r += child.rgb[3 * si + 0];
                    gr += child.rgb[3 * si + 1];
                    b += child.rgb[3 * si + 2];
                }
            }
            if (cnt == 0) continue;
            height[ci] = hmax;
            rgb[3 * ci + 0] = @intCast(r / cnt);
            rgb[3 * ci + 1] = @intCast(gr / cnt);
            rgb[3 * ci + 2] = @intCast(b / cnt);
        }
    }

    return .{ .size = size, .min_x = min_x, .min_z = min_z, .span = span, .rgb = rgb, .height = height };
}

pub const MAGIC = "VLR1";

/// Serialize a lowres tile with a 1-cell apron duplicated from the +x/+z
/// neighbours (same level), so adjacent heightfield meshes share edge samples.
pub fn serialize(
    arena: std.mem.Allocator,
    m: ColorMap,
    right: ?*const ColorMap, // +x neighbour
    down: ?*const ColorMap, // +z neighbour
    corner: ?*const ColorMap, // +x+z neighbour
) ![]u8 {
    const gw = m.size + 1;
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(arena, MAGIC);
    try appendU32(arena, &out, 1);
    try appendU32(arena, &out, gw);
    try appendU32(arena, &out, gw);
    try appendI32(arena, &out, m.min_x);
    try appendI32(arena, &out, m.min_z);
    try appendU32(arena, &out, m.span);

    // Sample (x,z) of the apron grid: inside → m; last col → right's col 0;
    // last row → down's row 0; far corner → corner's cell (0,0).
    const S = struct {
        fn cell(mm: ColorMap, rr: ?*const ColorMap, dd: ?*const ColorMap, cc: ?*const ColorMap, x: usize, z: usize) ?struct { c: [3]u8, h: i16 } {
            const inside_x = x < mm.size;
            const inside_z = z < mm.size;
            const src: *const ColorMap = if (inside_x and inside_z) &mm else if (!inside_x and inside_z) (rr orelse return null) else if (inside_x and !inside_z) (dd orelse return null) else (cc orelse return null);
            const sx = if (inside_x) x else 0;
            const sz = if (inside_z) z else 0;
            const i = src.idx(sx, sz);
            return .{ .c = .{ src.rgb[3 * i], src.rgb[3 * i + 1], src.rgb[3 * i + 2] }, .h = src.height[i] };
        }
    };

    // Heights first (offset 28, 2-aligned), then RGB, then pad to 4.
    var z: usize = 0;
    while (z < gw) : (z += 1) {
        var x: usize = 0;
        while (x < gw) : (x += 1) {
            const h: i16 = if (S.cell(m, right, down, corner, x, z)) |s| s.h else EMPTY;
            var buf: [2]u8 = undefined;
            std.mem.writeInt(i16, &buf, h, .little);
            try out.appendSlice(arena, &buf);
        }
    }
    z = 0;
    while (z < gw) : (z += 1) {
        var x: usize = 0;
        while (x < gw) : (x += 1) {
            const c: [3]u8 = if (S.cell(m, right, down, corner, x, z)) |s| s.c else .{ 0, 0, 0 };
            try out.appendSlice(arena, &c);
        }
    }
    while (out.items.len % 4 != 0) try out.append(arena, 0);
    return out.toOwnedSlice(arena);
}

fn appendU32(arena: std.mem.Allocator, out: *std.ArrayList(u8), v: u32) !void {
    var buf: [4]u8 = undefined;
    std.mem.writeInt(u32, &buf, v, .little);
    try out.appendSlice(arena, &buf);
}

fn appendI32(arena: std.mem.Allocator, out: *std.ArrayList(u8), v: i32) !void {
    var buf: [4]u8 = undefined;
    std.mem.writeInt(i32, &buf, v, .little);
    try out.appendSlice(arena, &buf);
}

test "downsample averages colors, maxes heights, and skips empty cells" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();

    // One child quadrant (top-left), CELLS×CELLS, uniform except one cell pair.
    const n: usize = CELLS * CELLS;
    const rgb = try a.alloc(u8, 3 * n);
    const height = try a.alloc(i16, n);
    @memset(rgb, 100);
    @memset(height, 64);
    // Cells (0,0) and (1,0) feed output cell (0,0): different colors + heights.
    rgb[0] = 200; // (0,0).r
    height[0] = 80;
    height[1] = 70;
    // Cells feeding output (1,0): all empty.
    height[2] = EMPTY;
    height[3] = EMPTY;
    height[CELLS + 2] = EMPTY;
    height[CELLS + 3] = EMPTY;

    const child: ColorMap = .{ .size = CELLS, .min_x = 0, .min_z = 0, .span = 1, .rgb = rgb, .height = height };
    const out = try downsample(a, .{ .{ &child, null }, .{ null, null } }, 0, 0, 2);

    try std.testing.expectEqual(@as(i16, 80), out.height[0]); // max of 80,70,64,64
    try std.testing.expectEqual(@as(u8, (200 + 100 + 100 + 100) / 4), out.rgb[0]);
    try std.testing.expectEqual(EMPTY, out.height[1]); // all-empty 2×2
    try std.testing.expectEqual(EMPTY, out.height[CELLS * CELLS - 1]); // missing quadrant
}

test "serialize writes an apron row/col from neighbours" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();

    const n: usize = CELLS * CELLS;
    const mk = struct {
        fn map(al: std.mem.Allocator, h: i16, r: u8) !ColorMap {
            const rgb = try al.alloc(u8, 3 * n);
            const hh = try al.alloc(i16, n);
            @memset(rgb, r);
            @memset(hh, h);
            return .{ .size = CELLS, .min_x = 0, .min_z = 0, .span = 1, .rgb = rgb, .height = hh };
        }
    };
    const m = try mk.map(a, 60, 10);
    const right = try mk.map(a, 61, 20);

    const blob = try serialize(a, m, &right, null, null);
    const gw: usize = CELLS + 1;
    try std.testing.expectEqualStrings(MAGIC, blob[0..4]);
    const heights = std.mem.bytesAsSlice(i16, blob[28 .. 28 + 2 * gw * gw]);
    try std.testing.expectEqual(@as(i16, 60), heights[0]);
    try std.testing.expectEqual(@as(i16, 61), heights[gw - 1]); // apron col ← right
    try std.testing.expectEqual(EMPTY, heights[gw * gw - 1]); // missing corner
    const rgb_off = 28 + 2 * gw * gw;
    try std.testing.expectEqual(@as(u8, 10), blob[rgb_off]);
    try std.testing.expectEqual(@as(u8, 20), blob[rgb_off + 3 * (gw - 1)]);
    try std.testing.expectEqual(@as(usize, 0), blob.len % 4);
}
