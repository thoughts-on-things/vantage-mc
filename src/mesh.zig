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
const lighting = @import("light.zig");

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
    /// Eligible for greedy plane-merging: a full unit-square face on a cube
    /// boundary, axis-aligned, full-tile UV, with a cullface, from an occluder
    /// block. Such faces are emitted by the greedy pass (merged into big tiled
    /// quads); everything else (overlays, sub-cube models, cross/plants) stays
    /// per-block. Set by `markGreedy` once the block's occluder-ness is known.
    greedy: bool = false,
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

/// A built tile: the opaque terrain mesh plus a separate transparent fluid mesh
/// (water). They are meshed together but drawn in two passes — the fluid mesh
/// blends over the already-drawn opaque one, so the seabed shows through.
pub const Built = struct { solid: Mesh2 = .{}, fluid: Mesh2 = .{}, light_ms: i64 = 0 };

/// Baked-light quality. `flat` lights each face by the single cell it faces (hard
/// per-face steps). `smooth` averages the four cells around each vertex (the AO
/// neighbourhood) for soft, BlueMap-grade gradients. Set at bake time (`--light`).
pub const LightQuality = enum { flat, smooth };

/// Build the textured mesh. `maps` are the biome colormaps and `reg` the
/// data-pack biome registry used to resolve each tinted face's colour from the
/// biome at its block position. Water is split into a transparent `fluid` mesh
/// (see `emitFluid`); everything else goes into the opaque `solid` mesh.
pub fn buildTextured(
    arena: std.mem.Allocator,
    g: grid.Grid,
    resolver: model.Resolver,
    tex: *texture.Builder,
    maps: biome.Colormaps,
    reg: *biome.Registry,
    quality: LightQuality,
    progress: ?std.Progress.Node,
) !Built {
    var mesh: Mesh2 = .{}; // opaque terrain
    var fluid: Mesh2 = .{}; // transparent water
    if (g.ids.len == 0) return .{ .solid = mesh, .fluid = fluid };

    const cache = try arena.alloc(?Cached, g.names.len);
    @memset(cache, null);

    // Precompute RGB per (biome, tint-kind) so per-face tinting is a lookup.
    const tint_colors = try buildTintTable(arena, g, maps, reg);
    const nkind = @as(usize, biome.Tint.count);

    // Precompute occluder-ness and water-ness per block id (bakes every present
    // type once) so cull/AO tests are a flat array read, not a re-bake. Water is
    // never an occluder, so the floor under it still meshes. `waterish` also
    // covers waterlogged blocks (seagrass, kelp, waterlogged stairs/…) so the
    // water reads as one continuous body, not a shell around each plant.
    const id_occluder = try arena.alloc(bool, g.names.len);
    const is_water = try arena.alloc(bool, g.names.len); // pure water (no block model)
    const waterish = try arena.alloc(bool, g.names.len); // water OR waterlogged
    for (id_occluder, is_water, waterish, 0..) |*o, *w, *wi, id| {
        const nm = g.nameOf(@intCast(id));
        w.* = id != 0 and isWater(nm);
        wi.* = id != 0 and (w.* or isWaterlogged(nm, g.stateOf(@intCast(id))));
        o.* = if (id == 0) false else (try getCached(arena, g, resolver, tex, cache, @intCast(id))).occluder;
    }
    const water_layer: f32 = @floatFromInt(tex.layerFor("block/water_still"));

    // Per-id greedy-face table: which cached face (if any) is the greedy face in
    // each of the 6 directions. Built once from the populated cache so the greedy
    // pass can find a cell's mergeable face by a flat lookup.
    const greedy_faces = try arena.alloc([6]i16, g.names.len);
    for (greedy_faces, 0..) |*gf, id| {
        gf.* = .{ -1, -1, -1, -1, -1, -1 };
        const c = cache[id] orelse continue;
        for (c.faces, 0..) |f, fi| {
            if (!f.greedy) continue;
            if (f.cull) |cd| gf[dirIndex(cd)] = @intCast(fi);
        }
    }

    // Compute sky + block light and flood-fill it into the grid, so each face can
    // read the light of the cell it faces (see light.zig). This world — like many
    // — saves no light in its region files, so we derive it the way BlueMap does.
    const emission = try arena.alloc(u8, g.names.len);
    for (emission, 0..) |*e, id| e.* = if (id == 0) 0 else lighting.emissionOf(g.nameOf(@intCast(id)));
    const t_light0 = std.Io.Timestamp.now(resolver.io, .awake);
    const light_node: ?std.Progress.Node = if (progress) |p| p.start("computing light", 0) else null;
    try lighting.compute(arena, g, id_occluder, emission);
    if (light_node) |n| n.end();
    const light_ms = t_light0.durationTo(std.Io.Timestamp.now(resolver.io, .awake)).toMilliseconds();

    // Mesh the geometry. Each cell's work reads only the (immutable) grid and the
    // pre-baked per-id caches, so we split the Y range across threads and append
    // the partials in Y order — byte-identical to a single-threaded pass.
    const mesh_node: ?std.Progress.Node = if (progress) |p| p.start("meshing geometry", 0) else null;
    defer if (mesh_node) |n| n.end();
    const ctx: MeshCtx = .{
        .g = g,
        .cache = cache,
        .id_occluder = id_occluder,
        .is_water = is_water,
        .waterish = waterish,
        .tint_colors = tint_colors,
        .nkind = nkind,
        .water_layer = water_layer,
        .quality = quality,
        .greedy_faces = greedy_faces,
    };
    const cpu = std.Thread.getCpuCount() catch 1;
    const n_threads = @max(1, @min(cpu, g.sy));
    if (n_threads <= 1) {
        try meshRange(&ctx, 0, g.sy, arena, &mesh, &fluid);
    } else {
        const partials = try arena.alloc(Partial, n_threads);
        const threads = try arena.alloc(std.Thread, n_threads);
        const slab = (g.sy + n_threads - 1) / n_threads;
        for (partials, 0..) |*p, i| {
            const y0 = @min(g.sy, i * slab);
            p.* = .{ .arena = std.heap.ArenaAllocator.init(std.heap.page_allocator), .y0 = y0, .y1 = @min(g.sy, y0 + slab) };
        }
        for (partials, threads) |*p, *t| t.* = try std.Thread.spawn(.{}, meshWorker, .{ &ctx, p });
        for (threads) |t| t.join();
        for (partials) |*p| {
            defer p.arena.deinit();
            if (p.err) |e| return e;
            try appendMesh(arena, &mesh, &p.solid);
            try appendMesh(arena, &fluid, &p.fluid);
        }
    }

    // Greedy pass: merge the full-cube occluder faces (which the per-block pass
    // skipped) into big tiled quads. The 6 directions are independent, so they
    // run as 6 workers into disjoint meshes, concatenated in direction order.
    const gp = try arena.alloc(GreedyPartial, 6);
    const gthreads = try arena.alloc(std.Thread, 6);
    for (gp, 0..) |*p, di| p.* = .{ .arena = std.heap.ArenaAllocator.init(std.heap.page_allocator), .di = di };
    for (gp, gthreads) |*p, *t| t.* = try std.Thread.spawn(.{}, greedyWorker, .{ &ctx, p });
    for (gthreads) |t| t.join();
    for (gp) |*p| {
        defer p.arena.deinit();
        if (p.err) |e| return e;
        try appendMesh(arena, &mesh, &p.mesh);
    }

    return .{ .solid = mesh, .fluid = fluid, .light_ms = light_ms };
}

/// Immutable, shareable context for the per-cell mesh pass (read by every thread).
const MeshCtx = struct {
    g: grid.Grid,
    cache: []?Cached,
    id_occluder: []const bool,
    is_water: []const bool,
    waterish: []const bool,
    tint_colors: [][3]u8,
    nkind: usize,
    water_layer: f32,
    quality: LightQuality,
    /// Per block id, the cached-face index of its greedy face in each of the 6
    /// directions (see `dirIndex`), or -1. The greedy pass uses this to find a
    /// cell's mergeable face; the per-block pass skips faces marked `greedy`.
    greedy_faces: [][6]i16,
};

/// One thread's slice of the mesh: its own arena (page-backed) and Y range.
const Partial = struct {
    solid: Mesh2 = .{},
    fluid: Mesh2 = .{},
    arena: std.heap.ArenaAllocator,
    y0: usize,
    y1: usize,
    err: ?anyerror = null,
};

fn meshWorker(ctx: *const MeshCtx, p: *Partial) void {
    meshRange(ctx, p.y0, p.y1, p.arena.allocator(), &p.solid, &p.fluid) catch |e| {
        p.err = e;
    };
}

/// Mesh the Y range [y0, y1) into `mesh` (opaque) and `fluid` (water), in y,z,x
/// order so threaded partials concatenate byte-identically. All grid/cache reads
/// are immutable; only the two output meshes (per-thread) are written.
fn meshRange(ctx: *const MeshCtx, y0: usize, y1: usize, alloc: std.mem.Allocator, mesh: *Mesh2, fluid: *Mesh2) !void {
    const g = ctx.g;
    var y = y0;
    while (y < y1) : (y += 1) {
        var z: usize = 0;
        while (z < g.sz) : (z += 1) {
            var x: usize = 0;
            while (x < g.sx) : (x += 1) {
                const id = g.ids[g.index(x, y, z)];
                if (id == grid.AIR) continue;
                const bid: usize = g.biomeAt(x, y, z);
                const wx: f32 = @floatFromInt(@as(i64, g.min_x) + @as(i64, @intCast(x)));
                const wy: f32 = @floatFromInt(@as(i64, g.min_y) + @as(i64, @intCast(y)));
                const wz: f32 = @floatFromInt(@as(i64, g.min_z) + @as(i64, @intCast(z)));

                // Pure water: transparent pass only (no block model). Boundary
                // faces, surface lip, depth — see emitFluid.
                if (ctx.is_water[id]) {
                    const rgb = ctx.tint_colors[bid * ctx.nkind + @intFromEnum(biome.Tint.water)];
                    try emitFluid(alloc, fluid, g, ctx.id_occluder, ctx.waterish, ctx.water_layer, x, y, z, wx, wy, wz, rgb, bid);
                    continue;
                }

                const cb = ctx.cache[id].?; // populated by the occluder pre-pass
                const xi: isize = @intCast(x);
                const yi: isize = @intCast(y);
                const zi: isize = @intCast(z);
                for (cb.faces) |face| {
                    if (face.greedy) continue; // emitted (merged) by the greedy pass
                    if (face.cull) |c| {
                        const off = dirOffset(c);
                        if (ctx.id_occluder[g.at(xi + off[0], yi + off[1], zi + off[2])]) continue;
                    }
                    const rgb = ctx.tint_colors[bid * ctx.nkind + @intFromEnum(face.tint)];
                    var ao = [4]u8{ 255, 255, 255, 255 };
                    if (face.ao) {
                        for (0..4) |ci| ao[ci] = cornerAo(g, ctx.id_occluder, x, y, z, face.ao_off[ci]);
                    }
                    // A face is lit by the cell it faces (the air the cullface
                    // looks into); billboards with no cullface read their own cell.
                    const lo: [3]i8 = if (face.cull) |c| dirOffset(c) else .{ 0, 0, 0 };
                    const flat_l = g.lightAt(xi + lo[0], yi + lo[1], zi + lo[2]);
                    var lights = [4]u8{ flat_l, flat_l, flat_l, flat_l };
                    // Smooth lighting: average each vertex's neighbourhood (same
                    // cells as AO). Only full, cullface-bearing faces have the AO
                    // offsets; billboards stay flat-lit.
                    if (ctx.quality == .smooth and face.ao) {
                        const base = [3]i8{ face.verts[0].n[0], face.verts[0].n[1], face.verts[0].n[2] };
                        for (0..4) |ci| lights[ci] = cornerLight(g, ctx.id_occluder, x, y, z, base, face.ao_off[ci]);
                    }
                    try emitBaked(alloc, mesh, wx, wy, wz, face, rgb, ao, lights, bid);
                }

                // Waterlogged block (seagrass, kelp, waterlogged stair/…): it just
                // rendered its model into the opaque mesh; now lay continuous water
                // over its cell so it sits *in* the water instead of in a shell.
                if (ctx.waterish[id]) {
                    const rgb = ctx.tint_colors[bid * ctx.nkind + @intFromEnum(biome.Tint.water)];
                    try emitFluid(alloc, fluid, g, ctx.id_occluder, ctx.waterish, ctx.water_layer, x, y, z, wx, wy, wz, rgb, bid);
                }
            }
        }
    }
}

/// Append `src`'s vertex streams to `dst`, offsetting indices by `dst`'s current
/// vertex count — concatenates a thread's partial mesh into the combined one.
fn appendMesh(alloc: std.mem.Allocator, dst: *Mesh2, src: *const Mesh2) !void {
    const base = dst.vertex_count;
    try dst.positions.appendSlice(alloc, src.positions.items);
    try dst.uv.appendSlice(alloc, src.uv.items);
    try dst.layer.appendSlice(alloc, src.layer.items);
    try dst.color.appendSlice(alloc, src.color.items);
    try dst.normals.appendSlice(alloc, src.normals.items);
    try dst.biome.appendSlice(alloc, src.biome.items);
    for (src.indices.items) |idx| try dst.indices.append(alloc, idx + base);
    dst.vertex_count += src.vertex_count;
}

// ---------------------------------------------------------------------------
// Greedy plane-merging (P3): full-cube occluder faces (marked `greedy` at bake
// time) are merged into big quads with repeat-wrapped, tiled UV — one quad for a
// run of identical adjacent faces instead of one per block. The merge key folds
// in block id, biome and the per-vertex AO + light, so only locally-uniform runs
// merge; a 1×1 merge is byte-identical to the per-block quad, and lighting
// gradients simply fragment the run (no visual change, just fewer merges).
// ---------------------------------------------------------------------------

/// One of the 6 face directions, with its normal axis and the two in-plane axes
/// the greedy sweep merges across (slice perpendicular to `nax`, merge in u,v).
const GDir = struct { dir: model.Dir, n: [3]i8, nax: u2, uax: u2, vax: u2 };

const gdirs = [6]GDir{
    .{ .dir = .east, .n = .{ 1, 0, 0 }, .nax = 0, .uax = 1, .vax = 2 },
    .{ .dir = .west, .n = .{ -1, 0, 0 }, .nax = 0, .uax = 1, .vax = 2 },
    .{ .dir = .up, .n = .{ 0, 1, 0 }, .nax = 1, .uax = 0, .vax = 2 },
    .{ .dir = .down, .n = .{ 0, -1, 0 }, .nax = 1, .uax = 0, .vax = 2 },
    .{ .dir = .south, .n = .{ 0, 0, 1 }, .nax = 2, .uax = 0, .vax = 1 },
    .{ .dir = .north, .n = .{ 0, 0, -1 }, .nax = 2, .uax = 0, .vax = 1 },
};

fn dirIndex(d: model.Dir) usize {
    return switch (d) {
        .east => 0,
        .west => 1,
        .up => 2,
        .down => 3,
        .south => 4,
        .north => 5,
    };
}

/// Merge key for one cell-face: same key ⇒ identical, tileable face. Block id
/// pins the texture/uv/rotation; biome pins the tint; AO+light pin the shading.
const GKey = struct { id: u16, biome: u16, ao: [4]u8, light: [4]u8 };

const Rect = struct { u: usize, v: usize, w: usize, h: usize, key: GKey };

/// Classic 2D greedy rectangle cover of a U×V slice: grow a run in u while the
/// key matches, then grow the whole row-band in v while every cell matches, mark
/// it used and emit one rectangle. `used` is a caller-owned U*V scratch buffer.
fn greedyMerge(
    present: []const bool,
    keys: []const GKey,
    used: []bool,
    U: usize,
    V: usize,
    out: *std.ArrayList(Rect),
    alloc: std.mem.Allocator,
) !void {
    @memset(used[0 .. U * V], false);
    var v: usize = 0;
    while (v < V) : (v += 1) {
        var u: usize = 0;
        while (u < U) {
            const start = v * U + u;
            if (!present[start] or used[start]) {
                u += 1;
                continue;
            }
            const k = keys[start];
            var w: usize = 1;
            while (u + w < U) : (w += 1) {
                const j = v * U + (u + w);
                if (!present[j] or used[j] or !std.meta.eql(keys[j], k)) break;
            }
            var h: usize = 1;
            outer: while (v + h < V) : (h += 1) {
                var t: usize = 0;
                while (t < w) : (t += 1) {
                    const j = (v + h) * U + (u + t);
                    if (!present[j] or used[j] or !std.meta.eql(keys[j], k)) break :outer;
                }
            }
            var dv: usize = 0;
            while (dv < h) : (dv += 1) {
                var du: usize = 0;
                while (du < w) : (du += 1) used[(v + dv) * U + (u + du)] = true;
            }
            try out.append(alloc, .{ .u = u, .v = v, .w = w, .h = h, .key = k });
            u += w;
        }
    }
}

/// Mesh one of the 6 greedy directions: for each slice perpendicular to the
/// direction, fill the (present, key) mask from the grid, greedy-merge it, and
/// emit the merged quads. Reads only immutable grid/cache state, so the 6
/// directions run as independent workers into disjoint output meshes.
fn meshGreedyDir(ctx: *const MeshCtx, alloc: std.mem.Allocator, mesh: *Mesh2, di: usize) !void {
    const g = ctx.g;
    const gd = gdirs[di];
    const dims = [3]usize{ g.sx, g.sy, g.sz };
    const N = dims[gd.nax];
    const U = dims[gd.uax];
    const V = dims[gd.vax];
    if (N == 0 or U == 0 or V == 0) return;

    const present = try alloc.alloc(bool, U * V);
    const keys = try alloc.alloc(GKey, U * V);
    const used = try alloc.alloc(bool, U * V);
    var rects: std.ArrayList(Rect) = .empty;
    const noff = gd.n;

    var s: usize = 0;
    while (s < N) : (s += 1) {
        @memset(present, false);
        var v: usize = 0;
        while (v < V) : (v += 1) {
            var u: usize = 0;
            while (u < U) : (u += 1) {
                var cell = [3]usize{ 0, 0, 0 };
                cell[gd.nax] = s;
                cell[gd.uax] = u;
                cell[gd.vax] = v;
                const x = cell[0];
                const y = cell[1];
                const z = cell[2];
                const id = g.ids[g.index(x, y, z)];
                if (id == grid.AIR) continue;
                const fi = ctx.greedy_faces[id][di];
                if (fi < 0) continue;
                const xi: isize = @intCast(x);
                const yi: isize = @intCast(y);
                const zi: isize = @intCast(z);
                if (ctx.id_occluder[g.at(xi + noff[0], yi + noff[1], zi + noff[2])]) continue;
                const face = ctx.cache[id].?.faces[@intCast(fi)];
                var ao = [4]u8{ 255, 255, 255, 255 };
                for (0..4) |ci| ao[ci] = cornerAo(g, ctx.id_occluder, x, y, z, face.ao_off[ci]);
                const flat_l = g.lightAt(xi + noff[0], yi + noff[1], zi + noff[2]);
                var lights = [4]u8{ flat_l, flat_l, flat_l, flat_l };
                if (ctx.quality == .smooth) {
                    const base_n = [3]i8{ face.verts[0].n[0], face.verts[0].n[1], face.verts[0].n[2] };
                    for (0..4) |ci| lights[ci] = cornerLight(g, ctx.id_occluder, x, y, z, base_n, face.ao_off[ci]);
                }
                const idx = v * U + u;
                present[idx] = true;
                keys[idx] = .{ .id = id, .biome = g.biomeAt(x, y, z), .ao = ao, .light = lights };
            }
        }
        rects.clearRetainingCapacity();
        try greedyMerge(present, keys, used, U, V, &rects, alloc);
        for (rects.items) |r| {
            var base = [3]usize{ 0, 0, 0 };
            base[gd.nax] = s;
            base[gd.uax] = r.u;
            base[gd.vax] = r.v;
            try emitGreedyQuad(alloc, mesh, ctx, gd, di, base, r);
        }
    }
}

/// Emit one merged greedy quad. Positions and UV are the unit face scaled across
/// the merged w×h footprint (UV tiles via repeat-wrap); the per-corner AO/light
/// come straight from the (uniform) merge key, so at w=h=1 this is byte-identical
/// to `emitBaked`.
fn emitGreedyQuad(alloc: std.mem.Allocator, mesh: *Mesh2, ctx: *const MeshCtx, gd: GDir, di: usize, base: [3]usize, r: Rect) !void {
    const g = ctx.g;
    const id = r.key.id;
    const face = ctx.cache[id].?.faces[@intCast(ctx.greedy_faces[id][di])];
    const w_f: f32 = @floatFromInt(r.w);
    const h_f: f32 = @floatFromInt(r.h);
    const base_world = [3]f32{
        @as(f32, @floatFromInt(g.min_x)) + @as(f32, @floatFromInt(base[0])),
        @as(f32, @floatFromInt(g.min_y)) + @as(f32, @floatFromInt(base[1])),
        @as(f32, @floatFromInt(g.min_z)) + @as(f32, @floatFromInt(base[2])),
    };
    const rgb = ctx.tint_colors[@as(usize, r.key.biome) * ctx.nkind + @intFromEnum(face.tint)];
    const bid_f: f32 = @floatFromInt(r.key.biome);

    // Affine UV basis from the unit face: uv00 at (su,sv)=(0,0); the per-axis
    // deltas tile across the run (×w along uax, ×h along vax).
    var uv00 = [2]f32{ 0, 0 };
    var uv10 = [2]f32{ 0, 0 };
    var uv01 = [2]f32{ 0, 0 };
    for (face.verts) |vtx| {
        const su = vtx.pos[gd.uax];
        const sv = vtx.pos[gd.vax];
        if (su == 0 and sv == 0) uv00 = vtx.uv else if (su == 1 and sv == 0) uv10 = vtx.uv else if (su == 0 and sv == 1) uv01 = vtx.uv;
    }
    const duv_u = [2]f32{ uv10[0] - uv00[0], uv10[1] - uv00[1] };
    const duv_v = [2]f32{ uv01[0] - uv00[0], uv01[1] - uv00[1] };

    const vbase = mesh.vertex_count;
    for (face.verts, 0..) |vtx, ci| {
        const su = vtx.pos[gd.uax]; // 0 or 1
        const sv = vtx.pos[gd.vax]; // 0 or 1
        var pos = base_world;
        pos[gd.uax] += su * w_f;
        pos[gd.vax] += sv * h_f;
        pos[gd.nax] += vtx.pos[gd.nax]; // boundary side (0 or 1)
        try mesh.positions.appendSlice(alloc, &.{ pos[0], pos[1], pos[2] });
        try mesh.uv.appendSlice(alloc, &.{
            uv00[0] + su * w_f * duv_u[0] + sv * h_f * duv_v[0],
            uv00[1] + su * w_f * duv_u[1] + sv * h_f * duv_v[1],
        });
        try mesh.layer.append(alloc, face.layer);
        try mesh.color.appendSlice(alloc, &.{ rgb[0], rgb[1], rgb[2], r.key.ao[ci] });
        try mesh.normals.appendSlice(alloc, &.{ vtx.n[0], vtx.n[1], vtx.n[2], @bitCast(r.key.light[ci]) });
        try mesh.biome.append(alloc, bid_f);
    }
    try mesh.indices.appendSlice(alloc, &.{ vbase + 0, vbase + 1, vbase + 2, vbase + 0, vbase + 2, vbase + 3 });
    mesh.vertex_count += 4;
}

/// One greedy direction's output: its own page-backed arena and mesh.
const GreedyPartial = struct {
    mesh: Mesh2 = .{},
    arena: std.heap.ArenaAllocator,
    di: usize,
    err: ?anyerror = null,
};

fn greedyWorker(ctx: *const MeshCtx, p: *GreedyPartial) void {
    meshGreedyDir(ctx, p.arena.allocator(), &p.mesh, p.di) catch |e| {
        p.err = e;
    };
}

fn isWater(name: []const u8) bool {
    return std.mem.eql(u8, model.stripNs(name), "water");
}

/// Whether a block holds water in its cell (so water should flow through it
/// rather than wall it off). Explicit `waterlogged=true` comes from the
/// blockstate; the always-water-filled plants are defined in game *code*, not
/// data, so a small curated set is unavoidable — kept minimal and version-stable.
fn isWaterlogged(name: []const u8, state: []const u8) bool {
    if (std.mem.indexOf(u8, state, "waterlogged=true") != null) return true;
    const always = [_][]const u8{ "seagrass", "tall_seagrass", "kelp", "kelp_plant", "bubble_column" };
    const b = model.stripNs(name);
    for (always) |w| if (std.mem.eql(u8, b, w)) return true;
    return false;
}

/// Emit a water cell's boundary faces into the transparent `mesh`. A face draws
/// only when its neighbour is neither opaque (would hide it) nor waterish (water
/// or waterlogged — merged), so an ocean interior is empty and only the surface
/// sheet + exposed edges cost geometry. Cells open to sky get the classic 14/16
/// surface lip. A 0..1 depth factor (cells below, capped) rides in the colour
/// alpha; the shader turns it into opacity so shallow water is clear and deep
/// water reads as solid blue — smooth accumulation, not hard per-block shading.
fn emitFluid(
    arena: std.mem.Allocator,
    mesh: *Mesh2,
    g: grid.Grid,
    id_occluder: []const bool,
    waterish: []const bool,
    layer: f32,
    x: usize,
    y: usize,
    z: usize,
    wx: f32,
    wy: f32,
    wz: f32,
    rgb: [3]u8,
    bid: usize,
) !void {
    const xi: isize = @intCast(x);
    const yi: isize = @intCast(y);
    const zi: isize = @intCast(z);
    // Lowered surface when open to sky above (the classic lip); a covered or
    // submerged cell fills full height so columns join seamlessly.
    const top: f32 = if (g.at(xi, yi + 1, zi) == grid.AIR) 14.0 / 16.0 else 1.0;
    // Depth: count waterish cells directly below (capped) -> 0..1 in the alpha.
    var below: u32 = 0;
    var yy: isize = yi - 1;
    while (below < 32 and waterish[g.at(xi, yy, zi)]) : (yy -= 1) below += 1;
    const depth = depthFactor(below);
    const bid_f: f32 = @floatFromInt(bid);

    for (tex_faces) |tf| {
        const nb = g.at(xi + tf.d[0], yi + tf.d[1], zi + tf.d[2]);
        if (id_occluder[nb] or waterish[nb]) continue; // hidden by solid / merged with water
        const lp: i8 = @bitCast(g.lightAt(xi + tf.d[0], yi + tf.d[1], zi + tf.d[2]));
        const base = mesh.vertex_count;
        for (0..4) |i| {
            const cs = tf.corners[i];
            const py: f32 = if (cs[1] == 1) top else 0.0;
            try mesh.positions.appendSlice(arena, &.{
                wx + @as(f32, @floatFromInt(cs[0])),
                wy + py,
                wz + @as(f32, @floatFromInt(cs[2])),
            });
            try mesh.uv.appendSlice(arena, &.{ @floatFromInt(tf.uvsel[i][0]), @floatFromInt(1 - tf.uvsel[i][1]) });
            try mesh.layer.append(arena, layer);
            try mesh.color.appendSlice(arena, &.{ rgb[0], rgb[1], rgb[2], depth });
            try mesh.normals.appendSlice(arena, &.{ tf.n[0], tf.n[1], tf.n[2], lp });
            try mesh.biome.append(arena, bid_f);
        }
        try mesh.indices.appendSlice(arena, &.{ base, base + 1, base + 2, base, base + 2, base + 3 });
        mesh.vertex_count += 4;
    }
}

/// Water depth as a 0..1 factor (0 = surface/shallow, 1 = deep) for `below`
/// cells of water, saturating near ~16 deep. The shader maps it to opacity.
fn depthFactor(below: u32) u8 {
    const t = @min(@as(f32, @floatFromInt(below)) / 16.0, 1.0);
    return @intFromFloat(t * 255.0);
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

/// Smooth per-vertex light: average the sky and block light of the (up to four)
/// non-occluding cells touching this corner — the outward neighbour (`base`) plus
/// the two edge cells and the diagonal (`off`, the same neighbourhood AO uses).
/// Occluders are skipped so a vertex by a wall isn't darkened twice (that's the
/// AO term's job); if every cell is solid, fall back to the outward cell.
fn cornerLight(g: grid.Grid, id_occluder: []const bool, x: usize, y: usize, z: usize, base: [3]i8, off: [3][3]i8) u8 {
    var sky: u32 = 0;
    var blk: u32 = 0;
    var cnt: u32 = 0;
    const cells = [4][3]i8{ base, off[0], off[1], off[2] };
    for (cells) |c| {
        const ix = @as(isize, @intCast(x)) + c[0];
        const iy = @as(isize, @intCast(y)) + c[1];
        const iz = @as(isize, @intCast(z)) + c[2];
        if (id_occluder[g.at(ix, iy, iz)]) continue;
        const l = g.lightAt(ix, iy, iz);
        sky += l >> 4;
        blk += l & 0x0F;
        cnt += 1;
    }
    if (cnt == 0) return g.lightAt(
        @as(isize, @intCast(x)) + base[0],
        @as(isize, @intCast(y)) + base[1],
        @as(isize, @intCast(z)) + base[2],
    );
    const s: u8 = @intCast(sky / cnt);
    const b: u8 = @intCast(blk / cnt);
    return (s << 4) | b;
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

/// Opaque fluids carry no geometry in their model (rendered specially in-game),
/// so resolving them yields nothing. Render lava as its own opaque full cube.
/// (Water is *not* here — it's transparent and handled by emitFluid instead.)
fn fluidTex(name: []const u8) ?FluidTex {
    const b = model.stripNs(name);
    if (std.mem.eql(u8, b, "lava")) return .{ .path = "block/lava_still", .tint = .none };
    return null;
}

fn bake(arena: std.mem.Allocator, name: []const u8, state: []const u8, resolver: model.Resolver, tex: *texture.Builder) !Cached {
    var list: std.ArrayList(BakedFace) = .empty;

    // Water contributes no opaque geometry and never occludes: it's drawn in the
    // separate transparent pass (emitFluid), so the seabed/shore under it meshes.
    if (isWater(name)) return .{ .faces = &.{}, .occluder = false };

    // Lava: an opaque full-cube surface; it occludes so the interior of a lava
    // body doesn't emit every face.
    if (fluidTex(name)) |f| {
        const layer: f32 = @floatFromInt(tex.layerFor(f.path));
        try bakeFullCube(arena, &list, layer, f.tint);
        markGreedy(list.items, true);
        return .{ .faces = try list.toOwnedSlice(arena), .occluder = true };
    }

    const parts = resolver.resolveBlock(name, state) catch {
        // Fallback: a flat-color full cube via a solid texture-array layer
        // (unresolved blocks). Opaque fallbacks occlude.
        const occluder = !isTransparent(name);
        const layer: f32 = @floatFromInt(try tex.solidLayer(blocks.lookup(name).color));
        try bakeFullCube(arena, &list, layer, .none);
        markGreedy(list.items, occluder);
        return .{ .faces = try list.toOwnedSlice(arena), .occluder = occluder };
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

    const occluder = !isTransparent(name) and isFullCube(parts);
    markGreedy(list.items, occluder);
    return .{
        .faces = try list.toOwnedSlice(arena),
        .occluder = occluder,
    };
}

/// Mark which of a block's baked faces may be greedy plane-merged. Only occluder
/// blocks qualify, and only their full-cube boundary faces (see `isGreedyGeom`);
/// overlays, sub-cube elements and cross/plant billboards are left per-block.
fn markGreedy(face_list: []BakedFace, occluder: bool) void {
    if (!occluder) return;
    for (face_list) |*f| f.greedy = isGreedyGeom(f.*);
}

/// True when a baked face is a full unit-square face lying on a cube boundary:
/// axis-aligned unit normal, every vertex on the 0/1 cube corners, full-tile UV,
/// and a cullface. Such a face tiles seamlessly, so the greedy pass can merge a
/// run of them into one big quad with repeat-wrapped UV. Rotated full cubes (logs
/// on an axis) still pass — a 90° rotation about the block centre maps cube
/// corners to cube corners — while sub-cube models and nudged overlays do not.
fn isGreedyGeom(bf: BakedFace) bool {
    if (bf.cull == null) return false;
    const n = bf.verts[0].n;
    const nsum: u32 = @as(u32, @abs(n[0])) + @as(u32, @abs(n[1])) + @as(u32, @abs(n[2]));
    if (nsum != 1) return false; // exactly one axis-aligned unit normal component
    var mn = [3]f32{ 1, 1, 1 };
    var mx = [3]f32{ 0, 0, 0 };
    for (bf.verts) |v| {
        if (v.n[0] != n[0] or v.n[1] != n[1] or v.n[2] != n[2]) return false;
        for (0..3) |a| {
            const p = v.pos[a];
            if (p != 0.0 and p != 1.0) return false;
            mn[a] = @min(mn[a], p);
            mx[a] = @max(mx[a], p);
        }
        if ((v.uv[0] != 0.0 and v.uv[0] != 1.0) or (v.uv[1] != 0.0 and v.uv[1] != 1.0)) return false;
    }
    const nax: usize = if (n[0] != 0) 0 else if (n[1] != 0) 1 else 2;
    for (0..3) |a| {
        if (a == nax) {
            if (mn[a] != mx[a]) return false; // single boundary plane
        } else if (mn[a] != 0.0 or mx[a] != 1.0) return false; // spans the full edge
    }
    return true;
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

/// `rgb` is the face's biome tint (shared by all 4 verts); `ao` and `light` are
/// per-vertex — AO brightness in the colour's alpha, packed sky/block light in
/// the normal's spare 4th byte (equal across verts for flat-quality faces).
fn emitBaked(arena: std.mem.Allocator, mesh: *Mesh2, wx: f32, wy: f32, wz: f32, face: BakedFace, rgb: [3]u8, ao: [4]u8, light: [4]u8, bid: usize) !void {
    const base = mesh.vertex_count;
    const bid_f: f32 = @floatFromInt(bid);
    for (face.verts, 0..) |v, i| {
        try mesh.positions.appendSlice(arena, &.{ wx + v.pos[0], wy + v.pos[1], wz + v.pos[2] });
        try mesh.uv.appendSlice(arena, &.{ v.uv[0], v.uv[1] });
        try mesh.layer.append(arena, face.layer);
        try mesh.color.appendSlice(arena, &.{ rgb[0], rgb[1], rgb[2], ao[i] });
        try mesh.normals.appendSlice(arena, &.{ v.n[0], v.n[1], v.n[2], @bitCast(light[i]) });
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

test "greedyMerge covers a uniform field with one rectangle" {
    const a = std.testing.allocator;
    const U = 3;
    const V = 2;
    const k = GKey{ .id = 1, .biome = 0, .ao = .{ 255, 255, 255, 255 }, .light = .{ 240, 240, 240, 240 } };
    var present = [_]bool{true} ** (U * V);
    var keys = [_]GKey{k} ** (U * V);
    var used = [_]bool{false} ** (U * V);
    var out: std.ArrayList(Rect) = .empty;
    defer out.deinit(a);
    try greedyMerge(&present, &keys, &used, U, V, &out, a);
    try std.testing.expectEqual(@as(usize, 1), out.items.len);
    try std.testing.expectEqual(@as(usize, 3), out.items[0].w);
    try std.testing.expectEqual(@as(usize, 2), out.items[0].h);
}

test "greedyMerge splits on differing keys" {
    const a = std.testing.allocator;
    const U = 2;
    const V = 2;
    const k1 = GKey{ .id = 1, .biome = 0, .ao = .{ 255, 255, 255, 255 }, .light = .{ 240, 240, 240, 240 } };
    const k2 = GKey{ .id = 2, .biome = 0, .ao = .{ 255, 255, 255, 255 }, .light = .{ 240, 240, 240, 240 } };
    var present = [_]bool{true} ** 4;
    var keys = [_]GKey{ k1, k1, k1, k2 }; // row 0 uniform; row 1 splits at (1,1)
    var used = [_]bool{false} ** 4;
    var out: std.ArrayList(Rect) = .empty;
    defer out.deinit(a);
    try greedyMerge(&present, &keys, &used, U, V, &out, a);
    try std.testing.expectEqual(@as(usize, 3), out.items.len);
}

test "greedyMerge skips absent cells" {
    const a = std.testing.allocator;
    const U = 2;
    const V = 1;
    const k = GKey{ .id = 1, .biome = 0, .ao = .{ 255, 255, 255, 255 }, .light = .{ 240, 240, 240, 240 } };
    var present = [_]bool{ false, true };
    var keys = [_]GKey{ k, k };
    var used = [_]bool{false} ** 2;
    var out: std.ArrayList(Rect) = .empty;
    defer out.deinit(a);
    try greedyMerge(&present, &keys, &used, U, V, &out, a);
    try std.testing.expectEqual(@as(usize, 1), out.items.len);
    try std.testing.expectEqual(@as(usize, 1), out.items[0].u);
    try std.testing.expectEqual(@as(usize, 1), out.items[0].w);
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
