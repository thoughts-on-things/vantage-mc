//! Naive culled cube mesher (P1).
//!
//! For every solid cell, emit each of its 6 faces only when the neighbor in that
//! direction is non-solid. This is the simplest mesh that already does the most
//! important thing BlueMap does — hide interior faces — without yet doing greedy
//! merging (P3). Output is indexed (4 verts + 6 indices per quad), the first
//! step away from BlueMap's vertex-duplicating non-indexed PRBM.
//!
//! Faces carry flat per-face normals (for lighting) and the cell's flat color.

const std = @import("std");
const grid = @import("grid.zig");
const blocks = @import("blocks.zig");
const model = @import("model.zig");
const texture = @import("texture.zig");
const biome = @import("biome.zig");

pub const Mesh = struct {
    positions: std.ArrayList(f32) = .empty, // 3 per vertex (world coords)
    colors: std.ArrayList(u8) = .empty, // 4 per vertex (RGBA)
    normals: std.ArrayList(i8) = .empty, // 4 per vertex (xyz + pad)
    indices: std.ArrayList(u32) = .empty,
    vertex_count: u32 = 0,

    pub fn quadCount(self: Mesh) u32 {
        return self.vertex_count / 4;
    }
    pub fn triangleCount(self: Mesh) usize {
        return self.indices.items.len / 3;
    }
};

const Face = struct {
    /// Neighbor offset to test for culling.
    d: [3]i8,
    /// Outward normal.
    n: [3]i8,
    /// Four CCW corners (offsets within the unit cube) viewed from outside.
    corners: [4][3]u8,
};

// Corner offsets chosen so triangles (0,1,2) and (0,2,3) wind CCW outward.
const faces = [6]Face{
    .{ .d = .{ 1, 0, 0 }, .n = .{ 1, 0, 0 }, .corners = .{ .{ 1, 0, 1 }, .{ 1, 0, 0 }, .{ 1, 1, 0 }, .{ 1, 1, 1 } } }, // +X
    .{ .d = .{ -1, 0, 0 }, .n = .{ -1, 0, 0 }, .corners = .{ .{ 0, 0, 0 }, .{ 0, 0, 1 }, .{ 0, 1, 1 }, .{ 0, 1, 0 } } }, // -X
    .{ .d = .{ 0, 1, 0 }, .n = .{ 0, 1, 0 }, .corners = .{ .{ 0, 1, 0 }, .{ 0, 1, 1 }, .{ 1, 1, 1 }, .{ 1, 1, 0 } } }, // +Y
    .{ .d = .{ 0, -1, 0 }, .n = .{ 0, -1, 0 }, .corners = .{ .{ 0, 0, 0 }, .{ 1, 0, 0 }, .{ 1, 0, 1 }, .{ 0, 0, 1 } } }, // -Y
    .{ .d = .{ 0, 0, 1 }, .n = .{ 0, 0, 1 }, .corners = .{ .{ 0, 0, 1 }, .{ 1, 0, 1 }, .{ 1, 1, 1 }, .{ 0, 1, 1 } } }, // +Z
    .{ .d = .{ 0, 0, -1 }, .n = .{ 0, 0, -1 }, .corners = .{ .{ 1, 0, 0 }, .{ 0, 0, 0 }, .{ 0, 1, 0 }, .{ 1, 1, 0 } } }, // -Z
};

pub fn build(arena: std.mem.Allocator, g: grid.Grid) !Mesh {
    var mesh: Mesh = .{};
    if (g.ids.len == 0) return mesh;

    var y: usize = 0;
    while (y < g.sy) : (y += 1) {
        var z: usize = 0;
        while (z < g.sz) : (z += 1) {
            var x: usize = 0;
            while (x < g.sx) : (x += 1) {
                const id = g.ids[g.index(x, y, z)];
                if (id == grid.AIR) continue;
                const color = blocks.lookup(g.nameOf(id)).color;
                const wx: f32 = @floatFromInt(@as(i64, g.min_x) + @as(i64, @intCast(x)));
                const wy: f32 = @floatFromInt(@as(i64, g.min_y) + @as(i64, @intCast(y)));
                const wz: f32 = @floatFromInt(@as(i64, g.min_z) + @as(i64, @intCast(z)));
                for (faces) |f| {
                    const nb = g.at(
                        @as(isize, @intCast(x)) + f.d[0],
                        @as(isize, @intCast(y)) + f.d[1],
                        @as(isize, @intCast(z)) + f.d[2],
                    );
                    if (nb != grid.AIR) continue; // interior face, cull
                    try emitQuad(arena, &mesh, wx, wy, wz, f, color);
                }
            }
        }
    }
    return mesh;
}

fn emitQuad(
    arena: std.mem.Allocator,
    mesh: *Mesh,
    wx: f32,
    wy: f32,
    wz: f32,
    f: Face,
    color: [3]u8,
) !void {
    const base = mesh.vertex_count;
    for (f.corners) |c| {
        try mesh.positions.appendSlice(arena, &.{
            wx + @as(f32, @floatFromInt(c[0])),
            wy + @as(f32, @floatFromInt(c[1])),
            wz + @as(f32, @floatFromInt(c[2])),
        });
        try mesh.colors.appendSlice(arena, &.{ color[0], color[1], color[2], 255 });
        try mesh.normals.appendSlice(arena, &.{ f.n[0], f.n[1], f.n[2], 0 });
    }
    try mesh.indices.appendSlice(arena, &.{
        base + 0, base + 1, base + 2,
        base + 0, base + 2, base + 3,
    });
    mesh.vertex_count += 4;
}

// ---------------------------------------------------------------------------
// Textured mesher (P2.3): emits geometry from resolved block models with UVs,
// a texture-array layer per face, and a per-vertex tint multiply.
// ---------------------------------------------------------------------------

pub const Mesh2 = struct {
    positions: std.ArrayList(f32) = .empty, // 3/vert (world coords)
    normals: std.ArrayList(i8) = .empty, // 4/vert (xyz + pad)
    uv: std.ArrayList(f32) = .empty, // 2/vert
    layer: std.ArrayList(f32) = .empty, // 1/vert (texture-array layer)
    color: std.ArrayList(u8) = .empty, // 4/vert (tint multiply RGBA)
    biome: std.ArrayList(f32) = .empty, // 1/vert (grid biome id, for the biome layer)
    indices: std.ArrayList(u32) = .empty,
    vertex_count: u32 = 0,

    pub fn triangleCount(self: Mesh2) usize {
        return self.indices.items.len / 3;
    }
};

/// Per-direction geometry winding (CCW outward, matching the flat mesher) plus
/// the uv-corner selectors that orient the texture upright on each face.
const TexFace = struct {
    dir: model.Dir,
    d: [3]i8, // neighbor offset
    n: [3]i8, // normal
    corners: [4][3]u1, // box-min/max selector per corner (x,y,z)
    uvsel: [4][2]u1, // (u,v) selector per corner: 0 -> uv[0]/uv[1], 1 -> uv[2]/uv[3]
};

const tex_faces = [6]TexFace{
    .{ .dir = .up, .d = .{ 0, 1, 0 }, .n = .{ 0, 1, 0 }, .corners = .{ .{ 0, 1, 0 }, .{ 0, 1, 1 }, .{ 1, 1, 1 }, .{ 1, 1, 0 } }, .uvsel = .{ .{ 0, 0 }, .{ 0, 1 }, .{ 1, 1 }, .{ 1, 0 } } },
    .{ .dir = .down, .d = .{ 0, -1, 0 }, .n = .{ 0, -1, 0 }, .corners = .{ .{ 0, 0, 0 }, .{ 1, 0, 0 }, .{ 1, 0, 1 }, .{ 0, 0, 1 } }, .uvsel = .{ .{ 0, 0 }, .{ 1, 0 }, .{ 1, 1 }, .{ 0, 1 } } },
    .{ .dir = .north, .d = .{ 0, 0, -1 }, .n = .{ 0, 0, -1 }, .corners = .{ .{ 1, 0, 0 }, .{ 0, 0, 0 }, .{ 0, 1, 0 }, .{ 1, 1, 0 } }, .uvsel = .{ .{ 0, 1 }, .{ 1, 1 }, .{ 1, 0 }, .{ 0, 0 } } },
    .{ .dir = .south, .d = .{ 0, 0, 1 }, .n = .{ 0, 0, 1 }, .corners = .{ .{ 0, 0, 1 }, .{ 1, 0, 1 }, .{ 1, 1, 1 }, .{ 0, 1, 1 } }, .uvsel = .{ .{ 0, 1 }, .{ 1, 1 }, .{ 1, 0 }, .{ 0, 0 } } },
    .{ .dir = .west, .d = .{ -1, 0, 0 }, .n = .{ -1, 0, 0 }, .corners = .{ .{ 0, 0, 0 }, .{ 0, 0, 1 }, .{ 0, 1, 1 }, .{ 0, 1, 0 } }, .uvsel = .{ .{ 0, 1 }, .{ 1, 1 }, .{ 1, 0 }, .{ 0, 0 } } },
    .{ .dir = .east, .d = .{ 1, 0, 0 }, .n = .{ 1, 0, 0 }, .corners = .{ .{ 1, 0, 1 }, .{ 1, 0, 0 }, .{ 1, 1, 0 }, .{ 1, 1, 1 } }, .uvsel = .{ .{ 0, 1 }, .{ 1, 1 }, .{ 1, 0 }, .{ 0, 0 } } },
};

const BakedVertex = struct { pos: [3]f32, uv: [2]f32, n: [3]i8 };
const BakedFace = struct {
    verts: [4]BakedVertex,
    layer: f32,
    /// Which biome colormap (if any) tints this face; resolved to RGB per block
    /// position at emit time, since the same model bakes once but tints by biome.
    tint: biome.Tint,
    cull: ?model.Dir,
    /// Whether to compute per-vertex ambient occlusion for this face (only full,
    /// cullface-bearing faces — billboards/cross models stay full-bright).
    ao: bool = false,
    /// Per corner, the three neighbour offsets (side1, side2, corner) sampled in
    /// the face's outward plane for AO. World-space (already rotation-baked).
    ao_off: [4][3][3]i8 = undefined,
};
const Cached = struct {
    faces: []BakedFace,
    occluder: bool,
};

/// Per-vertex AO brightness by occlusion level 0..3 (darkest concave corner ->
/// fully open). Tuned gentle so creases read without crushing the texture.
const AO_LUT = [4]u8{ 130, 178, 218, 255 };

/// Build the textured mesh. `maps` are the biome colormaps and `reg` the
/// data-pack biome registry used to resolve each tinted face's colour from the
/// biome at its block position.
pub fn buildTextured(
    arena: std.mem.Allocator,
    g: grid.Grid,
    resolver: model.Resolver,
    tex: *texture.Builder,
    maps: biome.Colormaps,
    reg: *biome.Registry,
) !Mesh2 {
    var mesh: Mesh2 = .{};
    if (g.ids.len == 0) return mesh;

    const cache = try arena.alloc(?Cached, g.names.len);
    @memset(cache, null);

    // Precompute RGB per (biome, tint-kind) so per-face tinting is a lookup.
    const tint_colors = try buildTintTable(arena, g, maps, reg);
    const nkind = @as(usize, biome.Tint.count);

    // Precompute occluder-ness per block id (bakes every present type once) so
    // AO neighbour tests and cull tests are a flat array read, not a re-bake.
    const id_occluder = try arena.alloc(bool, g.names.len);
    for (id_occluder, 0..) |*o, id| {
        o.* = if (id == 0) false else (try getCached(arena, g, resolver, tex, cache, @intCast(id))).occluder;
    }

    var y: usize = 0;
    while (y < g.sy) : (y += 1) {
        var z: usize = 0;
        while (z < g.sz) : (z += 1) {
            var x: usize = 0;
            while (x < g.sx) : (x += 1) {
                const id = g.ids[g.index(x, y, z)];
                if (id == grid.AIR) continue;
                const cb = cache[id].?; // populated by the occluder pre-pass
                const bid: usize = g.biomeAt(x, y, z);
                const wx: f32 = @floatFromInt(@as(i64, g.min_x) + @as(i64, @intCast(x)));
                const wy: f32 = @floatFromInt(@as(i64, g.min_y) + @as(i64, @intCast(y)));
                const wz: f32 = @floatFromInt(@as(i64, g.min_z) + @as(i64, @intCast(z)));
                for (cb.faces) |face| {
                    if (face.cull) |c| {
                        const off = dirOffset(c);
                        if (id_occluder[
                            g.at(
                                @as(isize, @intCast(x)) + off[0],
                                @as(isize, @intCast(y)) + off[1],
                                @as(isize, @intCast(z)) + off[2],
                            )
                        ]) continue;
                    }
                    const rgb = tint_colors[bid * nkind + @intFromEnum(face.tint)];
                    var ao = [4]u8{ 255, 255, 255, 255 };
                    if (face.ao) {
                        for (0..4) |ci| ao[ci] = cornerAo(g, id_occluder, x, y, z, face.ao_off[ci]);
                    }
                    try emitBaked(arena, &mesh, wx, wy, wz, face, rgb, ao, bid);
                }
            }
        }
    }
    return mesh;
}

/// Ambient-occlusion brightness for one face corner: 3-4 = open, 0 = a full
/// concave pocket. side1 & side2 both solid forces the darkest level.
fn cornerAo(g: grid.Grid, id_occluder: []const bool, x: usize, y: usize, z: usize, off: [3][3]i8) u8 {
    const s1 = occ(g, id_occluder, x, y, z, off[0]);
    const s2 = occ(g, id_occluder, x, y, z, off[1]);
    const cn = occ(g, id_occluder, x, y, z, off[2]);
    const level: usize = if (s1 == 1 and s2 == 1) 0 else 3 - @as(usize, s1 + s2 + cn);
    return AO_LUT[level];
}

fn occ(g: grid.Grid, id_occluder: []const bool, x: usize, y: usize, z: usize, o: [3]i8) u8 {
    const nb = g.at(
        @as(isize, @intCast(x)) + o[0],
        @as(isize, @intCast(y)) + o[1],
        @as(isize, @intCast(z)) + o[2],
    );
    return if (id_occluder[nb]) 1 else 0;
}

/// `[biome_id][tint_kind] -> RGB` flat table. Index 0 covers the no-data biome
/// (resolves to plains-like defaults), so a missing biome never indexes OOB.
fn buildTintTable(arena: std.mem.Allocator, g: grid.Grid, maps: biome.Colormaps, reg: *biome.Registry) ![][3]u8 {
    const nkind = @as(usize, biome.Tint.count);
    const nbiome = @max(1, g.biome_names.len);
    const kinds = [_]biome.Tint{ .none, .grass, .foliage, .water, .spruce, .birch, .lily };
    const out = try arena.alloc([3]u8, nbiome * nkind);
    for (0..nbiome) |bi| {
        const name = if (bi < g.biome_names.len) g.biome_names[bi] else "";
        const info = if (name.len == 0) biome.default_biome else reg.lookup(name);
        for (kinds) |k| out[bi * nkind + @intFromEnum(k)] = biome.colorFor(maps, k, info);
    }
    return out;
}

fn getCached(
    arena: std.mem.Allocator,
    g: grid.Grid,
    resolver: model.Resolver,
    tex: *texture.Builder,
    cache: []?Cached,
    id: u16,
) !Cached {
    if (cache[id]) |c| return c;
    const c = try bake(arena, g.nameOf(id), g.stateOf(id), resolver, tex);
    cache[id] = c;
    return c;
}

const FluidTex = struct { path: []const u8, tint: biome.Tint };

/// Fluids carry no geometry in their model (they're rendered specially in-game),
/// so resolving them yields nothing. Render them as a tinted full cube instead —
/// water takes the biome water colour, lava its own texture.
fn fluidTex(name: []const u8) ?FluidTex {
    const b = model.stripNs(name);
    if (std.mem.eql(u8, b, "water")) return .{ .path = "block/water_still", .tint = .water };
    if (std.mem.eql(u8, b, "lava")) return .{ .path = "block/lava_still", .tint = .none };
    return null;
}

fn bake(arena: std.mem.Allocator, name: []const u8, state: []const u8, resolver: model.Resolver, tex: *texture.Builder) !Cached {
    var list: std.ArrayList(BakedFace) = .empty;

    // Fluids: a full cube surface so oceans/rivers/lava show; they occlude so the
    // interior of a body of water doesn't emit every face.
    if (fluidTex(name)) |f| {
        const layer: f32 = @floatFromInt(tex.layerFor(f.path));
        try bakeFullCube(arena, &list, layer, f.tint);
        return .{ .faces = try list.toOwnedSlice(arena), .occluder = true };
    }

    const parts = resolver.resolveBlock(name, state) catch {
        // Fallback: a flat-color full cube via a solid texture-array layer
        // (unresolved blocks). Opaque fallbacks occlude.
        const layer: f32 = @floatFromInt(try tex.solidLayer(blocks.lookup(name).color));
        try bakeFullCube(arena, &list, layer, .none);
        return .{ .faces = try list.toOwnedSlice(arena), .occluder = !isTransparent(name) };
    };

    for (parts) |rm| {
        for (rm.elements, 0..) |el, ei| {
            const x0: f32 = @floatCast(el.from[0] / 16.0);
            const y0: f32 = @floatCast(el.from[1] / 16.0);
            const z0: f32 = @floatCast(el.from[2] / 16.0);
            const x1: f32 = @floatCast(el.to[0] / 16.0);
            const y1: f32 = @floatCast(el.to[1] / 16.0);
            const z1: f32 = @floatCast(el.to[2] / 16.0);
            const lo = [3]f32{ x0, y0, z0 };
            const hi = [3]f32{ x1, y1, z1 };
            // Nudge inner elements (e.g. grass overlay) outward to avoid z-fighting.
            const nudge: f32 = @as(f32, @floatFromInt(ei)) * 0.0008;

            for (el.faces) |mf| {
                const tf = texFaceFor(mf.dir);
                const layer: f32 = @floatFromInt(tex.layerFor(mf.texture));
                const tint: biome.Tint = if (mf.tintindex >= 0) biome.blockTint(name) else .none;
                // The cullface direction must rotate with the model, or rotated
                // blocks (logs, deepslate axis variants) cull against the wrong
                // neighbor and punch holes.
                const cull: ?model.Dir = if (mf.cullface) |cf| rotateDir(cf, rm.x, rm.y) else null;
                // AO only on cullface-bearing faces (real exposed block faces);
                // cross/plant billboards have no cullface and stay full-bright.
                const ao_on = mf.cullface != null;
                // Face texture rotation (0/90/180/270) cycles which uv corner each
                // vertex samples, rotating the texture on the face.
                const uvsteps: usize = (@as(usize, mf.rotation) / 90) % 4;
                var bf: BakedFace = .{ .verts = undefined, .layer = layer, .tint = tint, .cull = cull, .ao = ao_on };
                for (0..4) |i| {
                    const cs = tf.corners[i];
                    var p = [3]f32{
                        if (cs[0] == 1) hi[0] else lo[0],
                        if (cs[1] == 1) hi[1] else lo[1],
                        if (cs[2] == 1) hi[2] else lo[2],
                    };
                    var n = [3]f32{ @floatFromInt(tf.n[0]), @floatFromInt(tf.n[1]), @floatFromInt(tf.n[2]) };
                    if (el.rotation) |er| applyElementRot(&p, &n, er);
                    rotate(&p, &n, rm.x, rm.y);
                    if (ao_on) bf.ao_off[i] = cornerAoOffsets(n, p);
                    const uvsel = tf.uvsel[(i + uvsteps) % 4];
                    const u: f32 = @floatCast((if (uvsel[0] == 1) mf.uv[2] else mf.uv[0]) / 16.0);
                    const v: f32 = @floatCast((if (uvsel[1] == 1) mf.uv[3] else mf.uv[1]) / 16.0);
                    bf.verts[i] = .{
                        .pos = .{ p[0] + n[0] * nudge, p[1] + n[1] * nudge, p[2] + n[2] * nudge },
                        .uv = .{ u, 1.0 - v },
                        .n = .{ quantNormal(n[0]), quantNormal(n[1]), quantNormal(n[2]) },
                    };
                }
                try list.append(arena, bf);
            }
        }
    }

    return .{
        .faces = try list.toOwnedSlice(arena),
        .occluder = !isTransparent(name) and isFullCube(parts),
    };
}

fn bakeFullCube(arena: std.mem.Allocator, list: *std.ArrayList(BakedFace), layer: f32, tint: biome.Tint) !void {
    for (tex_faces) |tf| {
        var bf: BakedFace = .{ .verts = undefined, .layer = layer, .tint = tint, .cull = tf.dir, .ao = true };
        const n = [3]f32{ @floatFromInt(tf.n[0]), @floatFromInt(tf.n[1]), @floatFromInt(tf.n[2]) };
        for (0..4) |i| {
            const cs = tf.corners[i];
            const p = [3]f32{ @floatFromInt(cs[0]), @floatFromInt(cs[1]), @floatFromInt(cs[2]) };
            bf.ao_off[i] = cornerAoOffsets(n, p);
            bf.verts[i] = .{
                .pos = p,
                .uv = .{ @floatFromInt(tf.uvsel[i][0]), @floatFromInt(1 - tf.uvsel[i][1]) },
                .n = tf.n,
            };
        }
        try list.append(arena, bf);
    }
}

/// The three neighbour offsets (side1, side2, corner) for one face corner's AO,
/// in the plane just outside the face. `n` is the (rotated) face normal; `p` the
/// corner position in 0..1 cube space — its side on each tangent axis picks the
/// neighbour direction. Correct for axis-aligned cube faces (the vast majority);
/// approximate for sub-cube elements, which is why AO is gated to cullface faces.
fn cornerAoOffsets(n: [3]f32, p: [3]f32) [3][3]i8 {
    const base = [3]i8{ quantNormal(n[0]), quantNormal(n[1]), quantNormal(n[2]) };
    var du = [3]i8{ 0, 0, 0 };
    var dv = [3]i8{ 0, 0, 0 };
    var have_u = false;
    for (0..3) |a| {
        if (base[a] != 0) continue;
        const sign: i8 = if (p[a] > 0.5) 1 else -1;
        if (!have_u) {
            du[a] = sign;
            have_u = true;
        } else {
            dv[a] = sign;
        }
    }
    return .{ addv(base, du), addv(base, dv), addv(addv(base, du), dv) };
}

fn addv(a: [3]i8, b: [3]i8) [3]i8 {
    return .{ a[0] + b[0], a[1] + b[1], a[2] + b[2] };
}

/// `rgb` is the face's biome tint (shared by all 4 verts); `ao` is the per-vertex
/// ambient-occlusion brightness, carried in the colour's alpha channel.
fn emitBaked(arena: std.mem.Allocator, mesh: *Mesh2, wx: f32, wy: f32, wz: f32, face: BakedFace, rgb: [3]u8, ao: [4]u8, bid: usize) !void {
    const base = mesh.vertex_count;
    const bid_f: f32 = @floatFromInt(bid);
    for (face.verts, 0..) |v, i| {
        try mesh.positions.appendSlice(arena, &.{ wx + v.pos[0], wy + v.pos[1], wz + v.pos[2] });
        try mesh.uv.appendSlice(arena, &.{ v.uv[0], v.uv[1] });
        try mesh.layer.append(arena, face.layer);
        try mesh.color.appendSlice(arena, &.{ rgb[0], rgb[1], rgb[2], ao[i] });
        try mesh.normals.appendSlice(arena, &.{ v.n[0], v.n[1], v.n[2], 0 });
        try mesh.biome.append(arena, bid_f);
    }
    try mesh.indices.appendSlice(arena, &.{ base + 0, base + 1, base + 2, base + 0, base + 2, base + 3 });
    mesh.vertex_count += 4;
}

fn texFaceFor(dir: model.Dir) TexFace {
    for (tex_faces) |tf| {
        if (tf.dir == dir) return tf;
    }
    return tex_faces[0];
}

fn dirVecF(dir: model.Dir) [3]f32 {
    return switch (dir) {
        .down => .{ 0, -1, 0 },
        .up => .{ 0, 1, 0 },
        .north => .{ 0, 0, -1 },
        .south => .{ 0, 0, 1 },
        .west => .{ -1, 0, 0 },
        .east => .{ 1, 0, 0 },
    };
}

fn vecToDir(v: [3]f32) model.Dir {
    const ax = @abs(v[0]);
    const ay = @abs(v[1]);
    const az = @abs(v[2]);
    if (ax >= ay and ax >= az) return if (v[0] > 0) .east else .west;
    if (ay >= az) return if (v[1] > 0) .up else .down;
    return if (v[2] > 0) .south else .north;
}

/// Rotate a face direction by the model's x/y rotation (same convention as the
/// geometry rotation), so cullface stays aligned with the rotated face.
fn rotateDir(dir: model.Dir, xdeg: u16, ydeg: u16) model.Dir {
    const xk: u2 = @intCast((xdeg / 90) % 4);
    const yk: u2 = @intCast((ydeg / 90) % 4);
    if (xk == 0 and yk == 0) return dir;
    var v = dirVecF(dir);
    rotAxis(&v, .x, xk, false);
    rotAxis(&v, .y, yk, false);
    return vecToDir(v);
}

fn dirOffset(dir: model.Dir) [3]i8 {
    return switch (dir) {
        .down => .{ 0, -1, 0 },
        .up => .{ 0, 1, 0 },
        .north => .{ 0, 0, -1 },
        .south => .{ 0, 0, 1 },
        .west => .{ -1, 0, 0 },
        .east => .{ 1, 0, 0 },
    };
}

fn quantNormal(f: f32) i8 {
    if (f > 0.5) return 1;
    if (f < -0.5) return -1;
    return 0;
}

/// Apply an element-local `rotation` (arbitrary angle about one axis through
/// `origin`) to a vertex position and its normal. `rescale` expands the
/// perpendicular axes by 1/cos(angle) so rotated faces reach the block edges
/// (the cross/plant models rely on this for their diagonal × shape).
fn applyElementRot(p: *[3]f32, n: *[3]f32, rot: model.Rotation) void {
    const ax: u2 = switch (rot.axis) {
        .x => 0,
        .y => 1,
        .z => 2,
    };
    const o = [3]f32{
        @floatCast(rot.origin[0] / 16.0),
        @floatCast(rot.origin[1] / 16.0),
        @floatCast(rot.origin[2] / 16.0),
    };
    const ang: f32 = @floatCast(rot.angle * std.math.pi / 180.0);
    const c = @cos(ang);
    const s = @sin(ang);

    var v = [3]f32{ p[0] - o[0], p[1] - o[1], p[2] - o[2] };
    rotAxisAngle(&v, ax, c, s);
    if (rot.rescale and @abs(c) > 1.0e-4) {
        const sc = 1.0 / @abs(c);
        if (ax != 0) v[0] *= sc;
        if (ax != 1) v[1] *= sc;
        if (ax != 2) v[2] *= sc;
    }
    p.* = .{ v[0] + o[0], v[1] + o[1], v[2] + o[2] };
    rotAxisAngle(n, ax, c, s); // direction only — no translate, no rescale
}

/// Rotate a vector about axis `ax` (0=x,1=y,2=z) by (cos, sin).
fn rotAxisAngle(v: *[3]f32, ax: u2, c: f32, s: f32) void {
    switch (ax) {
        0 => {
            const a = v[1] * c - v[2] * s;
            const b = v[1] * s + v[2] * c;
            v[1] = a;
            v[2] = b;
        },
        1 => {
            const a = v[0] * c + v[2] * s;
            const b = -v[0] * s + v[2] * c;
            v[0] = a;
            v[2] = b;
        },
        2 => {
            const a = v[0] * c - v[1] * s;
            const b = v[0] * s + v[1] * c;
            v[0] = a;
            v[1] = b;
        },
        3 => unreachable,
    }
}

/// Rotate position and normal around the block center (0.5) by the blockstate
/// variant's x then y rotation (degrees, multiples of 90).
fn rotate(p: *[3]f32, n: *[3]f32, xdeg: u16, ydeg: u16) void {
    const xk: u2 = @intCast((xdeg / 90) % 4);
    const yk: u2 = @intCast((ydeg / 90) % 4);
    if (xk == 0 and yk == 0) return;
    rotAxis(p, .x, xk, true);
    rotAxis(n, .x, xk, false);
    rotAxis(p, .y, yk, true);
    rotAxis(n, .y, yk, false);
}

const Axis = enum { x, y };
fn rotAxis(v: *[3]f32, axis: Axis, k: u2, recenter: bool) void {
    const c: f32 = if (recenter) 0.5 else 0.0;
    // Work on a local copy centered at origin (normals use c=0).
    var px = v[0] - c;
    var py = v[1] - c;
    var pz = v[2] - c;
    var i: u2 = 0;
    while (i < k) : (i += 1) {
        switch (axis) {
            // +90° about X: (x, y, z) -> (x, -z, y)
            .x => {
                const ny = -pz;
                const nz = py;
                py = ny;
                pz = nz;
            },
            // +90° about Y: (x, y, z) -> (z, y, -x)
            .y => {
                const nx = pz;
                const nz = -px;
                px = nx;
                pz = nz;
            },
        }
    }
    v[0] = px + c;
    v[1] = py + c;
    v[2] = pz + c;
}

fn isFullCube(parts: []model.ResolvedModel) bool {
    for (parts) |rm| {
        for (rm.elements) |el| {
            if (el.from[0] == 0 and el.from[1] == 0 and el.from[2] == 0 and
                el.to[0] == 16 and el.to[1] == 16 and el.to[2] == 16 and el.faces.len >= 6)
                return true;
        }
    }
    return false;
}

/// Blocks that should NOT occlude their neighbours' faces (you can see past
/// them), so adjacent faces still draw. Leaves are deliberately excluded: they
/// are full cubes and *should* occlude, or a canopy renders every internal
/// alpha-cutout face as overlapping slivers. Their feathery edges still show
/// because outer faces (against air) are never culled.
fn isTransparent(name: []const u8) bool {
    // Water occludes (oceans are otherwise a solid block of internal faces); you
    // see the surface, not the floor — fine for a map. Genuinely see-through
    // blocks (glass, panes, bars) stay non-occluding.
    const needles = [_][]const u8{ "glass", "slime", "honey", "pane", "barrier", "_bars" };
    for (needles) |nd| {
        if (std.mem.indexOf(u8, name, nd) != null) return true;
    }
    return false;
}

test "applyElementRot turns the cross plane diagonal (45deg y, rescale)" {
    // A point on the -x face of the cross plane maps to the block's +z edge.
    var p = [3]f32{ 0.05, 0.5, 0.5 };
    var n = [3]f32{ 0, 0, -1 };
    applyElementRot(&p, &n, .{ .origin = .{ 8, 8, 8 }, .axis = .y, .angle = 45, .rescale = true });
    try std.testing.expectApproxEqAbs(@as(f32, 0.05), p[0], 0.01);
    try std.testing.expectApproxEqAbs(@as(f32, 0.5), p[1], 0.01);
    try std.testing.expectApproxEqAbs(@as(f32, 0.95), p[2], 0.01);
    // The normal rotates with it (now points diagonally), staying unit-ish.
    const len = @sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
    try std.testing.expectApproxEqAbs(@as(f32, 1.0), len, 0.01);
}

test "cornerAoOffsets samples the right in-plane neighbours" {
    // Up face (+Y), min corner (x=0,z=0): tangents point toward -x and -z.
    const lo = cornerAoOffsets(.{ 0, 1, 0 }, .{ 0, 1, 0 });
    try std.testing.expectEqual([3]i8{ -1, 1, 0 }, lo[0]); // side along -x
    try std.testing.expectEqual([3]i8{ 0, 1, -1 }, lo[1]); // side along -z
    try std.testing.expectEqual([3]i8{ -1, 1, -1 }, lo[2]); // diagonal corner
    // Up face, max corner (x=1,z=1): tangents point toward +x and +z.
    const hi = cornerAoOffsets(.{ 0, 1, 0 }, .{ 1, 1, 1 });
    try std.testing.expectEqual([3]i8{ 1, 1, 0 }, hi[0]);
    try std.testing.expectEqual([3]i8{ 0, 1, 1 }, hi[1]);
    try std.testing.expectEqual([3]i8{ 1, 1, 1 }, hi[2]);
}

test "rotateDir matches the geometry/normal rotation convention" {
    // x=90 about X maps +Y (up) -> +Z (south); identity for zero rotation.
    try std.testing.expectEqual(model.Dir.up, rotateDir(.up, 0, 0));
    try std.testing.expectEqual(model.Dir.south, rotateDir(.up, 90, 0));
    // Cross-check directly against the normal rotation used for geometry.
    for ([_]model.Dir{ .down, .up, .north, .south, .west, .east }) |d| {
        var n = dirVecF(d);
        rotAxis(&n, .x, 1, false);
        rotAxis(&n, .y, 1, false);
        try std.testing.expectEqual(vecToDir(n), rotateDir(d, 90, 90));
    }
}

test "single solid cell yields 6 culled-free faces" {
    const a = std.testing.allocator;
    var ids = [_]u16{1};
    var names = [_][]const u8{ "", "minecraft:stone" };
    const g: grid.Grid = .{
        .sx = 1,
        .sy = 1,
        .sz = 1,
        .min_x = 0,
        .min_y = 0,
        .min_z = 0,
        .ids = &ids,
        .names = &names,
    };
    var mesh = try build(a, g);
    defer {
        mesh.positions.deinit(a);
        mesh.colors.deinit(a);
        mesh.normals.deinit(a);
        mesh.indices.deinit(a);
    }
    try std.testing.expectEqual(@as(u32, 24), mesh.vertex_count); // 6 faces * 4
    try std.testing.expectEqual(@as(usize, 36), mesh.indices.items.len); // 6 * 6
    try std.testing.expectEqual(@as(usize, 12), mesh.triangleCount());
}

test "two adjacent cells cull their shared faces" {
    const a = std.testing.allocator;
    var ids = [_]u16{ 1, 1 };
    var names = [_][]const u8{ "", "minecraft:stone" };
    const g: grid.Grid = .{
        .sx = 2,
        .sy = 1,
        .sz = 1,
        .min_x = 0,
        .min_y = 0,
        .min_z = 0,
        .ids = &ids,
        .names = &names,
    };
    var mesh = try build(a, g);
    defer {
        mesh.positions.deinit(a);
        mesh.colors.deinit(a);
        mesh.normals.deinit(a);
        mesh.indices.deinit(a);
    }
    // 12 faces total minus the 2 shared interior faces = 10 quads.
    try std.testing.expectEqual(@as(u32, 10), mesh.quadCount());
}
