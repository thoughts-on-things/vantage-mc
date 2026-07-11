//! Meshers: culled cubes, textured block models, and greedy plane-merging.
//!
//! The baseline pass emits, for every solid cell, each of its 6 faces only when
//! the neighbor in that direction is non-solid — hiding interior faces, the most
//! important thing any Minecraft mesher does. Output is indexed (4 verts +
//! 6 indices per quad).
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
// Textured mesher: emits geometry from resolved block models with UVs,
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
/// neighbourhood) for soft gradients. Set at bake time (`--light`).
pub const LightQuality = enum { flat, smooth };

/// Build the textured mesh. `maps` are the biome colormaps and `reg` the
/// data-pack biome registry used to resolve each tinted face's colour from the
/// biome at its block position. Water is split into a transparent `fluid` mesh
/// (see `emitFluid`); everything else goes into the opaque `solid` mesh.
/// `interior`, if given, meshes only that XZ sub-box — the apron cells outside
/// it still feed culling/AO/light/biome-blend reads but emit no geometry.
/// `cave_y` enables cave culling below that world Y (see `MeshCtx.caveCulled`).
/// `max_threads` caps the internal mesh/greedy parallelism (0 = one thread per
/// core) — pass 1 when the caller already runs tiles in parallel, so N tile
/// workers don't each spawn N mesh threads.
pub fn buildTextured(
    arena: std.mem.Allocator,
    g: grid.Grid,
    resolver: model.Resolver,
    tex: *texture.Builder,
    maps: biome.Colormaps,
    reg: *biome.Registry,
    quality: LightQuality,
    blend_biomes: bool,
    interior: ?grid.Interior,
    cave_y: ?i32,
    max_threads: usize,
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

    // Precompute occluder-ness and fluid-ness per block id (bakes every present
    // type once) so cull/AO tests are a flat array read, not a re-bake. Fluids
    // are never geometry occluders, so the floor under them still meshes and
    // the neighbour sliver above a 14/16 surface still draws. `waterish` also
    // covers waterlogged blocks (seagrass, kelp, waterlogged stairs/…) so the
    // water reads as one continuous body, not a shell around each plant.
    const id_occluder = try arena.alloc(bool, g.names.len);
    const is_water = try arena.alloc(bool, g.names.len); // pure water (no block model)
    const is_lava = try arena.alloc(bool, g.names.len); // pure lava (no block model)
    const waterish = try arena.alloc(bool, g.names.len); // water OR waterlogged
    // Fluid level per id for the surface heights: pure water/lava read their
    // blockstate `level`; waterlogged blocks count as a source (0); the rest -1.
    const fluid_level = try arena.alloc(i16, g.names.len);
    var any_water = false;
    var any_lava = false;
    for (id_occluder, is_water, is_lava, waterish, fluid_level, 0..) |*o, *w, *lv, *wi, *lvl, id| {
        const nm = g.nameOf(@intCast(id));
        w.* = id != 0 and isWater(nm);
        lv.* = id != 0 and isLava(nm);
        wi.* = id != 0 and (w.* or isWaterlogged(nm, g.stateOf(@intCast(id))));
        lvl.* = if (w.* or lv.*) @intCast(parseLevel(g.stateOf(@intCast(id)))) else if (wi.*) 0 else -1;
        o.* = if (id == 0) false else (try getCached(arena, g, resolver, tex, cache, @intCast(id))).occluder;
        if (wi.*) any_water = true;
        if (lv.*) any_lava = true;
    }
    // Fluid texture layers, loaded only when the grid holds that fluid so a dry
    // tile doesn't pull unused animation frames into the shared atlas.
    const water_layers: FluidLayers = if (any_water) .{
        .still = @floatFromInt(tex.layerFor("block/water_still")),
        .flow = @floatFromInt(tex.layerFor("block/water_flow")),
    } else .{};
    const lava_layers: FluidLayers = if (any_lava) .{
        .still = @floatFromInt(tex.layerFor("block/lava_still")),
        .flow = @floatFromInt(tex.layerFor("block/lava_flow")),
    } else .{};

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
    // read the light of the cell it faces (see light.zig). Many worlds save no
    // light in their region files, so we derive it ourselves.
    const emission = try arena.alloc(u8, g.names.len);
    for (emission, 0..) |*e, id| e.* = if (id == 0) 0 else lighting.emissionOf(g.nameOf(@intCast(id)));
    // Lava stays opaque to LIGHT (closing the sky column, walling the flood)
    // even though it no longer occludes geometry; its cells still seed their
    // own emission, so the glow spreads outward from the body itself.
    const light_occluder = try arena.alloc(bool, g.names.len);
    for (light_occluder, id_occluder, is_lava) |*lo, o, lv| lo.* = o or lv;
    const t_light0 = std.Io.Timestamp.now(resolver.io, .awake);
    const light_node: ?std.Progress.Node = if (progress) |p| p.start("computing light", 0) else null;
    try lighting.compute(arena, g, light_occluder, emission, waterish);
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
        .is_lava = is_lava,
        .waterish = waterish,
        .tint_colors = tint_colors,
        .nkind = nkind,
        .water_layers = water_layers,
        .lava_layers = lava_layers,
        .quality = quality,
        .blend_biomes = blend_biomes,
        .fluid_level = fluid_level,
        .greedy_faces = greedy_faces,
        .interior = interior orelse grid.Interior.full(g),
        .cave_y = cave_y,
    };
    const cpu = std.Thread.getCpuCount() catch 1;
    const budget = if (max_threads == 0) cpu else max_threads;
    const n_threads = @max(1, @min(budget, g.sy));
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
        // A failed spawn (thread exhaustion) runs that slab inline instead of
        // failing the whole build.
        var n_spawned: usize = 0;
        for (partials) |*p| {
            if (std.Thread.spawn(.{}, meshWorker, .{ &ctx, p })) |t| {
                threads[n_spawned] = t;
                n_spawned += 1;
            } else |_| meshWorker(&ctx, p);
        }
        for (threads[0..n_spawned]) |t| t.join();
        for (partials) |*p| {
            defer p.arena.deinit();
            if (p.err) |e| return e;
            try appendMesh(arena, &mesh, &p.solid);
            try appendMesh(arena, &fluid, &p.fluid);
        }
    }

    // Greedy pass: merge the full-cube occluder faces (which the per-block pass
    // skipped) into big tiled quads. The 6 directions are independent, so they
    // run as 6 workers into disjoint meshes, concatenated in direction order
    // (inline when the thread budget is 1).
    const gp = try arena.alloc(GreedyPartial, 6);
    for (gp, 0..) |*p, di| p.* = .{ .arena = std.heap.ArenaAllocator.init(std.heap.page_allocator), .di = di };
    if (n_threads <= 1) {
        for (gp) |*p| greedyWorker(&ctx, p);
    } else {
        const gthreads = try arena.alloc(std.Thread, 6);
        var n_spawned: usize = 0;
        for (gp) |*p| {
            if (std.Thread.spawn(.{}, greedyWorker, .{ &ctx, p })) |t| {
                gthreads[n_spawned] = t;
                n_spawned += 1;
            } else |_| greedyWorker(&ctx, p);
        }
        for (gthreads[0..n_spawned]) |t| t.join();
    }
    for (gp) |*p| {
        defer p.arena.deinit();
        if (p.err) |e| return e;
        try appendMesh(arena, &mesh, &p.mesh);
    }

    return .{ .solid = mesh, .fluid = fluid, .light_ms = light_ms };
}

/// A fluid's texture-array layers: the still texture (flat tops, bottoms) and
/// the flow texture (sides, and tops that slope — see `emitFluid`).
const FluidLayers = struct { still: f32 = 0, flow: f32 = 0 };

/// Which fluid `emitFluid` is drawing. Water goes to the transparent mesh
/// (biome-tinted, depth in alpha); lava to the opaque solid mesh (untinted,
/// lit by its own full-bright cell).
const Fluid = enum { water, lava };

/// Immutable, shareable context for the per-cell mesh pass (read by every thread).
const MeshCtx = struct {
    g: grid.Grid,
    cache: []?Cached,
    id_occluder: []const bool,
    is_water: []const bool,
    is_lava: []const bool,
    waterish: []const bool,
    tint_colors: [][3]u8,
    nkind: usize,
    water_layers: FluidLayers = .{},
    lava_layers: FluidLayers = .{},
    quality: LightQuality,
    /// Blend biome tint colours across borders (vanilla-style grass/foliage/water
    /// gradients) rather than stepping per biome cell. See `blendedTint`.
    blend_biomes: bool,
    /// Per block id, the fluid level for the liquid surface algorithm: 0 = source
    /// (or waterlogged), 1..7 = flowing (decreasing height), >=8 = falling/full,
    /// -1 = not a fluid surface. Drives the real Minecraft fluid heights so flowing
    /// water/lava slopes into waves (see `liquidCornerHeight`).
    fluid_level: []const i16,
    /// Per block id, the cached-face index of its greedy face in each of the 6
    /// directions (see `dirIndex`), or -1. The greedy pass uses this to find a
    /// cell's mergeable face; the per-block pass skips faces marked `greedy`.
    greedy_faces: [][6]i16,
    /// The XZ sub-box to emit geometry for (the whole grid unless this is a
    /// tiled render with an apron). Cells outside are read but never emitted.
    interior: grid.Interior,
    /// Cave culling: when set, faces below this world Y that look into a dark
    /// cell (sky light 0) are skipped — cutting the invisible cave geometry
    /// that otherwise dominates tile size on modern (1.18+) worlds. Faces looking into water
    /// are always kept, so deep ocean floors survive (sky light attenuates to
    /// 0 under ~15 blocks of water). Null = render everything.
    cave_y: ?i32,

    /// Whether cell (x,y,z) is in the dark below the cave-culling horizon.
    fn caveDark(ctx: *const MeshCtx, x: isize, y: isize, z: isize) bool {
        const cave_y = ctx.cave_y orelse return false;
        if (y < 0 or @as(i64, ctx.g.min_y) + @as(i64, y) >= cave_y) return false;
        return ctx.g.lightAt(x, y, z) >> 4 == 0; // dark = no sky light reaches it
    }

    /// Whether the face lit by cell (x,y,z) is invisible cave geometry. Faces
    /// looking into water are never culled (ocean/lake floors).
    fn caveCulled(ctx: *const MeshCtx, x: isize, y: isize, z: isize) bool {
        if (!ctx.caveDark(x, y, z)) return false;
        return !ctx.waterish[ctx.g.at(x, y, z)];
    }
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
        var z: usize = ctx.interior.z0;
        while (z < ctx.interior.z1) : (z += 1) {
            var x: usize = ctx.interior.x0;
            while (x < ctx.interior.x1) : (x += 1) {
                const id = g.ids[g.index(x, y, z)];
                if (id == grid.AIR) continue;
                const bid: usize = g.biomeAt(x, y, z);
                const wx: f32 = @floatFromInt(@as(i64, g.min_x) + @as(i64, @intCast(x)));
                const wy: f32 = @floatFromInt(@as(i64, g.min_y) + @as(i64, @intCast(y)));
                const wz: f32 = @floatFromInt(@as(i64, g.min_z) + @as(i64, @intCast(z)));

                const xi: isize = @intCast(x);
                const yi: isize = @intCast(y);
                const zi: isize = @intCast(z);

                // Pure water: transparent pass only (no block model). Boundary
                // faces, surface lip, depth — see emitFluid. Dark underground
                // water below the cave horizon is culled with the caves.
                if (ctx.is_water[id]) {
                    if (!ctx.caveDark(xi, yi, zi)) try emitFluid(alloc, fluid, ctx, .water, x, y, z, wx, wy, wz, bid);
                    continue;
                }
                // Pure lava: opaque fluid-height geometry into the solid mesh.
                // Its cells carry no sky light (lava closes the light column),
                // so cave culling happens per-face inside emitFluid against the
                // cell each face looks into, like solid blocks do.
                if (ctx.is_lava[id]) {
                    try emitFluid(alloc, mesh, ctx, .lava, x, y, z, wx, wy, wz, bid);
                    continue;
                }

                const cb = ctx.cache[id].?; // populated by the occluder pre-pass
                for (cb.faces) |face| {
                    if (face.greedy) continue; // emitted (merged) by the greedy pass
                    if (face.cull) |c| {
                        const off = dirOffset(c);
                        if (ctx.id_occluder[g.at(xi + off[0], yi + off[1], zi + off[2])]) continue;
                        if (ctx.caveCulled(xi + off[0], yi + off[1], zi + off[2])) continue;
                    } else if (ctx.caveCulled(xi, yi, zi)) continue;
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
                    try emitBaked(alloc, mesh, ctx, wx, wy, wz, face, rgb, ao, lights, bid);
                }

                // Waterlogged block (seagrass, kelp, waterlogged stair/…): it just
                // rendered its model into the opaque mesh; now lay continuous water
                // over its cell so it sits *in* the water instead of in a shell.
                if (ctx.waterish[id] and !ctx.caveDark(xi, yi, zi)) {
                    try emitFluid(alloc, fluid, ctx, .water, x, y, z, wx, wy, wz, bid);
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
// Greedy plane-merging: full-cube occluder faces (marked `greedy` at bake
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

    // Interior bounds per axis (Y is never restricted); iteration stays inside
    // them, so merged rects can't cross into the apron.
    const lo3 = [3]usize{ ctx.interior.x0, 0, ctx.interior.z0 };
    const hi3 = [3]usize{ ctx.interior.x1, g.sy, ctx.interior.z1 };

    const present = try alloc.alloc(bool, U * V);
    const keys = try alloc.alloc(GKey, U * V);
    const used = try alloc.alloc(bool, U * V);
    var rects: std.ArrayList(Rect) = .empty;
    const noff = gd.n;

    var s: usize = lo3[gd.nax];
    while (s < hi3[gd.nax]) : (s += 1) {
        @memset(present, false);
        var v: usize = lo3[gd.vax];
        while (v < hi3[gd.vax]) : (v += 1) {
            var u: usize = lo3[gd.uax];
            while (u < hi3[gd.uax]) : (u += 1) {
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
                if (ctx.caveCulled(xi + noff[0], yi + noff[1], zi + noff[2])) continue;
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
    const blend = ctx.blend_biomes and isBlendable(face.tint);
    const min_xf: f32 = @floatFromInt(g.min_x);
    const min_yf: f32 = @floatFromInt(g.min_y);
    const min_zf: f32 = @floatFromInt(g.min_z);

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
        const col = if (blend) blendedTint(ctx, face.tint, pos[0] - min_xf, pos[1] - min_yf, pos[2] - min_zf) else rgb;
        try mesh.color.appendSlice(alloc, &.{ col[0], col[1], col[2], r.key.ao[ci] });
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

fn isLava(name: []const u8) bool {
    return std.mem.eql(u8, model.stripNs(name), "lava");
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

/// Parse the `level=N` fluid level out of a blockstate key (default 0 = source).
fn parseLevel(state: []const u8) u8 {
    const i = std.mem.indexOf(u8, state, "level=") orelse return 0;
    var j = i + "level=".len;
    var v: u8 = 0;
    while (j < state.len and state[j] >= '0' and state[j] <= '9') : (j += 1) v = v *% 10 +% (state[j] - '0');
    return v;
}

/// Fluid "own" surface height (0..1) for a level, matching the game:
/// source (0) → 14/16, flowing 1..7 → (14 − level·1.9)/16, falling (≥8) → full.
fn liquidBaseHeight(level: i16) f32 {
    if (level >= 8) return 1.0;
    return (14.0 - @as(f32, @floatFromInt(level)) * 1.9) / 16.0;
}

/// One top corner's surface height (0..1) for the fluid cell at (x,y,z), averaged
/// over the 2×2 of cells meeting at the corner (`xo`,`zo` ∈ {−1,0}). `merge` is
/// the same-fluid group (waterish for water, is_lava for lava). Mirrors the
/// game's liquid renderer: a same-liquid block directly above any of the
/// 2×2 forces a full corner; a source neighbour pins it to 14/16; otherwise it is
/// the average base height, with air cells counting as 0 (pulling the corner down)
/// and solid cells ignored. Deterministic per world corner, so adjacent cells
/// agree on the shared height → watertight.
fn liquidCornerHeight(ctx: *const MeshCtx, merge: []const bool, x: isize, y: isize, z: isize, xo: isize, zo: isize) f32 {
    const g = ctx.g;
    var ix = xo;
    while (ix <= xo + 1) : (ix += 1) {
        var iz = zo;
        while (iz <= zo + 1) : (iz += 1) {
            if (merge[g.at(x + ix, y + 1, z + iz)]) return 1.0;
        }
    }
    var sum: f32 = 0;
    var count: f32 = 0;
    ix = xo;
    while (ix <= xo + 1) : (ix += 1) {
        var iz = zo;
        while (iz <= zo + 1) : (iz += 1) {
            const id = g.at(x + ix, y, z + iz);
            if (merge[id]) {
                const lvl = ctx.fluid_level[id];
                if (lvl == 0) return 14.0 / 16.0; // a source corner is fixed at 14/16
                sum += liquidBaseHeight(lvl);
                count += 1;
            } else if (id == grid.AIR) {
                count += 1; // air contributes 0 height, lowering the average
            }
        }
    }
    if (sum == 0 or count == 0) return 3.0 / 16.0; // "shouldn't happen" fallback
    return sum / count;
}

/// Quantize a unit-normal component to i8 (−127..127); finer than `quantNormal`
/// (which snaps to cube axes) so the sloped water surface keeps its tilt.
fn quantSlope(f: f32) i8 {
    return @intFromFloat(std.math.clamp(@round(f * 127.0), -127.0, 127.0));
}

/// Emit a fluid cell's boundary faces — water into the transparent mesh, lava
/// into the opaque solid mesh. A face draws only when its neighbour is neither
/// opaque (would hide it) nor the same fluid (merged), so an ocean interior is
/// empty and only the surface sheet + exposed edges cost geometry. The top
/// surface uses real Minecraft fluid corner heights (see `liquidCornerHeight`),
/// so flowing fluid slopes into waves; the up face's normal carries that slope
/// so the ridges catch light.
///
/// Textures follow the game's fluid renderer: a flat top samples the *still*
/// texture; a sloping top samples the *flow* texture's centred half-scale
/// window rotated to the downhill direction; side faces always sample the flow
/// texture (its frames scroll downward), the window tracking the surface
/// height; bottoms are still. All windows stay inside [0,1] so tile UV
/// quantization and mip sampling are unaffected.
///
/// Water rides a 0..1 depth factor (cells below, capped) in the colour alpha —
/// the shader turns it into opacity so shallow water is clear and deep water
/// reads as solid blue. Lava is untinted/opaque and lit by its OWN cell (block
/// light 15 → full bright, like the game) rather than the cell a face looks
/// into, and cave-culls per face since lava cells themselves carry no sky light.
fn emitFluid(
    arena: std.mem.Allocator,
    mesh: *Mesh2,
    ctx: *const MeshCtx,
    kind: Fluid,
    x: usize,
    y: usize,
    z: usize,
    wx: f32,
    wy: f32,
    wz: f32,
    bid: usize,
) !void {
    const g = ctx.g;
    const id_occluder = ctx.id_occluder;
    // Same-fluid merge group: faces between two cells of the group are interior.
    const merge = if (kind == .water) ctx.waterish else ctx.is_lava;
    const layers = if (kind == .water) ctx.water_layers else ctx.lava_layers;
    const blend = ctx.blend_biomes and kind == .water;
    const base_rgb: [3]u8 = if (kind == .water)
        ctx.tint_colors[bid * ctx.nkind + @intFromEnum(biome.Tint.water)]
    else
        .{ 255, 255, 255 };
    const min_xf: f32 = @floatFromInt(g.min_x);
    const min_yf: f32 = @floatFromInt(g.min_y);
    const min_zf: f32 = @floatFromInt(g.min_z);
    const xi: isize = @intCast(x);
    const yi: isize = @intCast(y);
    const zi: isize = @intCast(z);
    // Per-corner surface heights (real Minecraft fluid levels). A falling cell
    // (level ≥ 8) or a source with same liquid directly above fills full height;
    // otherwise each top corner averages the fluid around it (see
    // `liquidCornerHeight`). `cornerH[cx][cz]` indexes the local (x,z) corner.
    const self_level = ctx.fluid_level[g.at(xi, yi, zi)];
    const full_top = self_level >= 8 or (self_level == 0 and merge[g.at(xi, yi + 1, zi)]);
    var cornerH: [2][2]f32 = .{ .{ 1, 1 }, .{ 1, 1 } };
    if (!full_top) {
        inline for (0..2) |cx| {
            inline for (0..2) |cz| {
                const xo: isize = if (cx == 0) -1 else 0;
                const zo: isize = if (cz == 0) -1 else 0;
                cornerH[cx][cz] = liquidCornerHeight(ctx, merge, xi, yi, zi, xo, zo);
            }
        }
    }
    // Surface (up-face) normal from the corner-height gradient, so wave ridges
    // shade; the side/bottom faces keep their axis normals.
    const dhdx = ((cornerH[1][0] + cornerH[1][1]) - (cornerH[0][0] + cornerH[0][1])) * 0.5;
    const dhdz = ((cornerH[0][1] + cornerH[1][1]) - (cornerH[0][0] + cornerH[1][0])) * 0.5;
    const inv = 1.0 / @sqrt(dhdx * dhdx + dhdz * dhdz + 1.0);
    const up_n = [3]i8{ quantSlope(-dhdx * inv), quantSlope(inv), quantSlope(-dhdz * inv) };
    // A tilted surface is flowing: its top face samples the flow texture's
    // centred half-scale window rotated so the pattern runs downhill (the
    // gradient points uphill; a=0 flows toward +Z). Flat cells — the common
    // case — skip the trig.
    const flowing = @abs(dhdx) > 1e-4 or @abs(dhdz) > 1e-4;
    var fcos: f32 = 1;
    var fsin: f32 = 0;
    if (flowing) {
        const fa = std.math.atan2(-dhdx, -dhdz);
        fcos = @cos(fa);
        fsin = @sin(fa);
    }
    // Depth: count same-fluid cells directly below (capped) -> 0..1 in the
    // alpha (water opacity; lava is opaque and full-alpha).
    var depth: u8 = 255;
    if (kind == .water) {
        var below: u32 = 0;
        var yy: isize = yi - 1;
        while (below < 32 and merge[g.at(xi, yy, zi)]) : (yy -= 1) below += 1;
        depth = depthFactor(below);
    }
    const own_light: i8 = @bitCast(g.lightAt(xi, yi, zi));
    const bid_f: f32 = @floatFromInt(bid);

    for (tex_faces) |tf| {
        const nb = g.at(xi + tf.d[0], yi + tf.d[1], zi + tf.d[2]);
        if (id_occluder[nb] or merge[nb]) continue; // hidden by solid / merged with same fluid
        if (kind == .lava and ctx.caveCulled(xi + tf.d[0], yi + tf.d[1], zi + tf.d[2])) continue;
        const lp: i8 = if (kind == .lava) own_light else @bitCast(g.lightAt(xi + tf.d[0], yi + tf.d[1], zi + tf.d[2]));
        const is_up = tf.n[1] > 0;
        const is_side = tf.n[1] == 0;
        const flow_top = is_up and flowing;
        const layer = if (flow_top or is_side) layers.flow else layers.still;
        const base = mesh.vertex_count;
        for (0..4) |i| {
            const cs = tf.corners[i];
            const py: f32 = if (cs[1] == 1) cornerH[@as(usize, cs[0])][@as(usize, cs[2])] else 0.0;
            const px = wx + @as(f32, @floatFromInt(cs[0]));
            const pyw = wy + py;
            const pz = wz + @as(f32, @floatFromInt(cs[2]));
            try mesh.positions.appendSlice(arena, &.{ px, pyw, pz });
            var u: f32 = @floatFromInt(tf.uvsel[i][0]);
            var v: f32 = @floatFromInt(tf.uvsel[i][1]);
            if (flow_top) {
                const cx = @as(f32, @floatFromInt(cs[0])) - 0.5;
                const cz = @as(f32, @floatFromInt(cs[2])) - 0.5;
                u = 0.5 + 0.5 * (cx * fcos - cz * fsin);
                v = 0.5 + 0.5 * (cx * fsin + cz * fcos);
            } else if (is_side) {
                u *= 0.5;
                v = 0.5 - py * 0.5;
            }
            try mesh.uv.appendSlice(arena, &.{ u, v });
            try mesh.layer.append(arena, layer);
            const col = if (blend) blendedTint(ctx, .water, px - min_xf, pyw - min_yf, pz - min_zf) else base_rgb;
            try mesh.color.appendSlice(arena, &.{ col[0], col[1], col[2], depth });
            const nrm: [3]i8 = if (is_up) up_n else .{ tf.n[0], tf.n[1], tf.n[2] };
            try mesh.normals.appendSlice(arena, &.{ nrm[0], nrm[1], nrm[2], lp });
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
/// Tints that vary by biome and so should blend across borders. The rest
/// (spruce/birch/lily leaf colours, `none`) are constants — no blending needed.
fn isBlendable(t: biome.Tint) bool {
    return switch (t) {
        .grass, .foliage, .water => true,
        else => false,
    };
}

/// One biome cell's precomputed tint colour for `kind`, clamping the cell coords
/// to the grid edge so a border blend extrapolates the edge biome rather than
/// reading biome 0 (the "" sentinel) past the world edge.
fn cellTint(ctx: *const MeshCtx, bx: i32, by: usize, bz: i32, kind: usize) [3]u8 {
    const g = ctx.g;
    const cx: usize = @intCast(std.math.clamp(bx, 0, @as(i32, @intCast(g.bsx - 1))));
    const cz: usize = @intCast(std.math.clamp(bz, 0, @as(i32, @intCast(g.bsz - 1))));
    const id = g.biome_ids[g.biomeIndex(cx, by, cz)];
    return ctx.tint_colors[@as(usize, id) * ctx.nkind + kind];
}

/// Biome tint for a blendable `kind`, bilinearly interpolated across the
/// quarter-resolution biome grid in X/Z so colours ramp smoothly over biome
/// borders (matching vanilla's grass/foliage/water blend) instead of stepping at
/// each 4-block biome cell. `lx`,`ly`,`lz` are world-LOCAL coords (use the vertex
/// corner); Y picks the nearest biome layer (vanilla blends horizontally only).
/// Because two faces meeting at an edge sample the same field there, per-block and
/// merged greedy quads stay seamless. Blends in sRGB byte space, as vanilla does.
fn blendedTint(ctx: *const MeshCtx, kind: biome.Tint, lx: f32, ly: f32, lz: f32) [3]u8 {
    const g = ctx.g;
    const k = @intFromEnum(kind);
    if (g.biome_ids.len == 0 or g.bsx == 0 or g.bsy == 0 or g.bsz == 0)
        return ctx.tint_colors[k]; // biome 0 fallback
    // Biome cells are 4 blocks wide with centres at block 2,6,10,… so a corner at
    // block p maps to cell coordinate p/4 − 0.5; bilinear over the 4 nearest cells.
    const fx = lx * 0.25 - 0.5;
    const fz = lz * 0.25 - 0.5;
    const x0f = @floor(fx);
    const z0f = @floor(fz);
    const tx = fx - x0f;
    const tz = fz - z0f;
    const x0: i32 = @intFromFloat(x0f);
    const z0: i32 = @intFromFloat(z0f);
    const by: usize = @intCast(std.math.clamp(@as(i32, @intFromFloat(@floor(ly * 0.25))), 0, @as(i32, @intCast(g.bsy - 1))));
    const c00 = cellTint(ctx, x0, by, z0, k);
    const c10 = cellTint(ctx, x0 + 1, by, z0, k);
    const c01 = cellTint(ctx, x0, by, z0 + 1, k);
    const c11 = cellTint(ctx, x0 + 1, by, z0 + 1, k);
    var out: [3]u8 = undefined;
    inline for (0..3) |i| {
        const top = @as(f32, @floatFromInt(c00[i])) * (1 - tx) + @as(f32, @floatFromInt(c10[i])) * tx;
        const bot = @as(f32, @floatFromInt(c01[i])) * (1 - tx) + @as(f32, @floatFromInt(c11[i])) * tx;
        out[i] = @intFromFloat(@round(std.math.clamp(top * (1 - tz) + bot * tz, 0, 255)));
    }
    return out;
}

fn buildTintTable(arena: std.mem.Allocator, g: grid.Grid, maps: biome.Colormaps, reg: *biome.Registry) ![][3]u8 {
    const nkind = @as(usize, biome.Tint.count);
    const nbiome = @max(1, g.biome_names.len);
    const kinds = [_]biome.Tint{ .none, .grass, .foliage, .water, .spruce, .birch, .lily, .redstone, .stem };
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

fn bake(arena: std.mem.Allocator, name: []const u8, state: []const u8, resolver: model.Resolver, tex: *texture.Builder) !Cached {
    var list: std.ArrayList(BakedFace) = .empty;

    // Fluids contribute no baked geometry and never occlude — both are drawn by
    // emitFluid with real surface heights (water into the transparent pass,
    // lava as opaque fluid geometry), so the terrain under/behind them meshes
    // and the neighbour sliver above a 14/16 surface still draws.
    if (isWater(name) or isLava(name)) return .{ .faces = &.{}, .occluder = false };

    const parts = resolver.resolveBlock(name, state) catch {
        // Fallback: a flat-color full cube via a solid texture-array layer
        // (unresolved blocks). Opaque fallbacks occlude.
        const occluder = !isTransparent(name);
        const layer: f32 = @floatFromInt(try tex.solidLayer(blocks.lookup(name).color));
        try bakeFullCube(arena, &list, layer, .none);
        markGreedy(list.items, occluder);
        return .{ .faces = try list.toOwnedSlice(arena), .occluder = occluder };
    };

    // Block entities (chests, beds, signs, …) resolve to a model with *no*
    // elements — the game draws them with block-entity renderers, which a baked
    // map can't run. Emit an approximate colored box so builds don't show holes
    // where their furniture is. Never an occluder: the box is smaller than the
    // cell, so it must not cull its neighbours' faces.
    if (!partsHaveGeometry(parts)) {
        if (blockEntityBox(name)) |box| {
            const layer: f32 = @floatFromInt(try tex.solidLayer(box.color));
            try bakeBox(arena, &list, layer, box.height);
            return .{ .faces = try list.toOwnedSlice(arena), .occluder = false };
        }
    }

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
                //
                // `uvlock` counter-rotates faces *parallel to the rotation axis*
                // so their texture stays world-aligned while the geometry turns
                // (stair/slab tops keep their grain when the block faces east).
                // Cycle counts were derived from the corner/uvsel tables and the
                // documented rotation convention (y+90: north→east from above;
                // x+90: up→north): the +normal face counter-cycles, the −normal
                // face cycles forward. Faces perpendicular to the axis relocate
                // without spinning, so they need no correction. Combined x+y
                // rotations (top-half stairs) are left uncorrected — the cycle
                // model can't express the mirror an x=180 flip introduces.
                const xk = (@as(usize, rm.x) / 90) % 4;
                const yk = (@as(usize, rm.y) / 90) % 4;
                var lock: usize = 0;
                if (rm.uvlock) {
                    if (yk != 0 and xk == 0) {
                        if (tf.dir == .up) lock = (4 - yk) % 4;
                        if (tf.dir == .down) lock = yk;
                    } else if (xk != 0 and yk == 0) {
                        if (tf.dir == .west) lock = xk;
                        if (tf.dir == .east) lock = (4 - xk) % 4;
                    }
                }
                const uvsteps: usize = ((@as(usize, mf.rotation) / 90) + lock) % 4;
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
                        // Model uv and the uploaded texture rows share the same
                        // origin (v=0 = top texel row), so v passes through
                        // unflipped — flipping here turns every asymmetric
                        // texture (flowers, grass side overlay) upside down.
                        .uv = .{ u, v },
                        // `shade: false` (vines, cross plants, ladders…): store an
                        // up normal so the shader's face-direction shading reads
                        // 1.0 — the game draws these at full brightness, and the
                        // side-face darkening is why foliage looked muddy.
                        .n = if (el.shade)
                            .{ quantNormal(n[0]), quantNormal(n[1]), quantNormal(n[2]) }
                        else
                            .{ 0, 1, 0 },
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
///
/// A face is also disqualified when another face shares its boundary plane (same
/// cull direction) — the coincident-overlay pattern (grass_block_side +
/// grass_block_side_overlay, mycelium, podzol, nylium…). Greedy-merging the base
/// would shunt it into the separate greedy mesh drawn *after* the per-block
/// overlay, so at distance (once the tiny outward nudge drops below depth
/// precision) the untinted base wins the depth test and z-fights/flickers. Kept
/// per-block, base and overlay emit in element order (base then overlay) into the
/// same mesh, so LEQUAL + draw order lets the overlay win deterministically.
fn markGreedy(face_list: []BakedFace, occluder: bool) void {
    if (!occluder) return;
    for (face_list, 0..) |*f, i| {
        if (!isGreedyGeom(f.*)) {
            f.greedy = false;
            continue;
        }
        var shares_plane = false;
        for (face_list, 0..) |other, j| {
            if (i == j) continue;
            if (other.cull) |oc| {
                if (f.cull) |fc| {
                    if (oc == fc) {
                        shares_plane = true;
                        break;
                    }
                }
            }
        }
        f.greedy = !shares_plane;
    }
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

fn partsHaveGeometry(parts: []const model.ResolvedModel) bool {
    for (parts) |rm| {
        if (rm.elements.len > 0) return true;
    }
    return false;
}

/// Approximate stand-in for a block whose visuals live in a block-entity
/// renderer (no model elements). Curated colors/heights for the common,
/// visually significant ones; null leaves the block invisible (correct for
/// markers like light or structure_void, which also resolve to no geometry).
const EntityBox = struct { color: [3]u8, height: f32 };

fn blockEntityBox(name: []const u8) ?EntityBox {
    const b = model.stripNs(name);
    if (std.mem.eql(u8, b, "chest") or std.mem.eql(u8, b, "trapped_chest"))
        return .{ .color = .{ 140, 100, 45 }, .height = 0.875 };
    if (std.mem.eql(u8, b, "ender_chest"))
        return .{ .color = .{ 25, 55, 60 }, .height = 0.875 };
    if (std.mem.endsWith(u8, b, "_bed"))
        return .{ .color = .{ 180, 60, 60 }, .height = 0.5625 };
    if (std.mem.endsWith(u8, b, "sign"))
        return .{ .color = .{ 120, 95, 60 }, .height = 1.0 };
    if (std.mem.endsWith(u8, b, "banner"))
        return .{ .color = .{ 205, 205, 205 }, .height = 1.0 };
    if (std.mem.endsWith(u8, b, "_skull") or std.mem.endsWith(u8, b, "_head"))
        return .{ .color = .{ 225, 220, 200 }, .height = 0.5 };
    if (std.mem.endsWith(u8, b, "shulker_box"))
        return .{ .color = .{ 150, 105, 160 }, .height = 1.0 };
    if (std.mem.eql(u8, b, "decorated_pot"))
        return .{ .color = .{ 160, 90, 60 }, .height = 1.0 };
    if (std.mem.eql(u8, b, "conduit"))
        return .{ .color = .{ 130, 180, 170 }, .height = 0.5 };
    return null;
}

/// Like `bakeFullCube` but `height` (0..1] scales Y — a squashed cube for
/// chest/bed/skull stand-ins. Faces keep their cull dirs: sides/bottom are
/// flush with the cell so neighbour culling stays correct, and a culled top
/// under a solid block matches the in-game view (you can't see it there either).
fn bakeBox(arena: std.mem.Allocator, list: *std.ArrayList(BakedFace), layer: f32, height: f32) !void {
    for (tex_faces) |tf| {
        var bf: BakedFace = .{ .verts = undefined, .layer = layer, .tint = .none, .cull = tf.dir, .ao = true };
        const n = [3]f32{ @floatFromInt(tf.n[0]), @floatFromInt(tf.n[1]), @floatFromInt(tf.n[2]) };
        for (0..4) |i| {
            const cs = tf.corners[i];
            const p = [3]f32{ @floatFromInt(cs[0]), @as(f32, @floatFromInt(cs[1])) * height, @floatFromInt(cs[2]) };
            bf.ao_off[i] = cornerAoOffsets(n, .{ @floatFromInt(cs[0]), @floatFromInt(cs[1]), @floatFromInt(cs[2]) });
            bf.verts[i] = .{
                .pos = p,
                .uv = .{ @floatFromInt(tf.uvsel[i][0]), @floatFromInt(tf.uvsel[i][1]) },
                .n = tf.n,
            };
        }
        try list.append(arena, bf);
    }
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
                .uv = .{ @floatFromInt(tf.uvsel[i][0]), @floatFromInt(tf.uvsel[i][1]) },
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
fn emitBaked(arena: std.mem.Allocator, mesh: *Mesh2, ctx: *const MeshCtx, wx: f32, wy: f32, wz: f32, face: BakedFace, rgb: [3]u8, ao: [4]u8, light: [4]u8, bid: usize) !void {
    const base = mesh.vertex_count;
    const bid_f: f32 = @floatFromInt(bid);
    const blend = ctx.blend_biomes and isBlendable(face.tint);
    const ox = wx - @as(f32, @floatFromInt(ctx.g.min_x));
    const oy = wy - @as(f32, @floatFromInt(ctx.g.min_y));
    const oz = wz - @as(f32, @floatFromInt(ctx.g.min_z));
    for (face.verts, 0..) |v, i| {
        const col = if (blend) blendedTint(ctx, face.tint, ox + v.pos[0], oy + v.pos[1], oz + v.pos[2]) else rgb;
        try mesh.positions.appendSlice(arena, &.{ wx + v.pos[0], wy + v.pos[1], wz + v.pos[2] });
        try mesh.uv.appendSlice(arena, &.{ v.uv[0], v.uv[1] });
        try mesh.layer.append(arena, face.layer);
        try mesh.color.appendSlice(arena, &.{ col[0], col[1], col[2], ao[i] });
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
            // Blockstate x+90 tips the model's top toward north: up -> north.
            // Verified against vanilla assets (barrel facing=up is the default
            // model, facing=north is x=90): (x, y, z) -> (x, z, -y).
            .x => {
                const ny = pz;
                const nz = -py;
                py = ny;
                pz = nz;
            },
            // Blockstate y+90 turns the model clockwise seen from above:
            // north -> east (ladder facing=east is y=90 on a north-facing
            // model): (x, y, z) -> (-z, y, x).
            .y => {
                const nx = -pz;
                const nz = px;
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
    // Vanilla conventions: x=90 tips up -> north (barrel facing=up is the
    // default model, facing=north is x=90); y=90 turns north -> east (ladder).
    try std.testing.expectEqual(model.Dir.up, rotateDir(.up, 0, 0));
    try std.testing.expectEqual(model.Dir.north, rotateDir(.up, 90, 0));
    try std.testing.expectEqual(model.Dir.east, rotateDir(.north, 0, 90));
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

test "blendedTint ramps linearly between two biome cells" {
    const a = std.testing.allocator;
    const nkind = @as(usize, biome.Tint.count);
    const gk = @intFromEnum(biome.Tint.grass);
    // Two biome cells in X (bsx=2): cell 0 -> biome id 1 (black), cell 1 -> id 2 (red).
    var biome_ids = [_]u16{ 1, 2 };
    // tint_colors rows for biome ids 0,1,2; only the grass column matters here.
    const tint = try a.alloc([3]u8, 3 * nkind);
    defer a.free(tint);
    @memset(tint, .{ 0, 0, 0 });
    tint[1 * nkind + gk] = .{ 0, 0, 0 };
    tint[2 * nkind + gk] = .{ 100, 0, 0 };
    const g: grid.Grid = .{
        .sx = 8,
        .sy = 4,
        .sz = 4,
        .min_x = 0,
        .min_y = 0,
        .min_z = 0,
        .ids = &.{},
        .names = &.{},
        .bsx = 2,
        .bsy = 1,
        .bsz = 1,
        .biome_ids = &biome_ids,
    };
    const ctx: MeshCtx = .{
        .g = g,
        .cache = &.{},
        .id_occluder = &.{},
        .is_water = &.{},
        .is_lava = &.{},
        .waterish = &.{},
        .tint_colors = tint,
        .nkind = nkind,
        .quality = .flat,
        .blend_biomes = true,
        .fluid_level = &.{},
        .greedy_faces = &.{},
        .interior = grid.Interior.full(g),
        .cave_y = null,
    };
    // Cell centres sit at block 2 and 6; the midpoint (block 4) is the 50% blend.
    try std.testing.expectEqual(@as(u8, 0), blendedTint(&ctx, .grass, 2, 0, 0)[0]);
    try std.testing.expectEqual(@as(u8, 100), blendedTint(&ctx, .grass, 6, 0, 0)[0]);
    try std.testing.expectEqual(@as(u8, 50), blendedTint(&ctx, .grass, 4, 0, 0)[0]);
    // Past the edge the nearest cell is held (no bleed to biome 0/black beyond).
    try std.testing.expectEqual(@as(u8, 0), blendedTint(&ctx, .grass, 0, 0, 0)[0]);
    try std.testing.expectEqual(@as(u8, 100), blendedTint(&ctx, .grass, 8, 0, 0)[0]);
}

test "greedy pass emits only interior cells (apron feeds reads, not geometry)" {
    // meshGreedyDir allocates scratch it never frees (arena-per-region in prod).
    var arena_inst = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_inst.deinit();
    const a = arena_inst.allocator();
    // A 4×1×4 slab of one block; interior = the middle 2×2. The up-faces of the
    // 4 interior cells merge into ONE 2×2 quad positioned inside the interior;
    // the 12 apron cells emit nothing.
    var ids = [_]u16{1} ** 16;
    var names = [_][]const u8{ "", "minecraft:stone" };
    const g: grid.Grid = .{
        .sx = 4,
        .sy = 1,
        .sz = 4,
        .min_x = 0,
        .min_y = 0,
        .min_z = 0,
        .ids = &ids,
        .names = &names,
    };
    // Hand-baked full up-face (unit square at y=1), greedy-eligible.
    const up = dirIndex(.up);
    var faces_buf = [_]BakedFace{.{
        .verts = .{
            .{ .pos = .{ 0, 1, 0 }, .uv = .{ 0, 0 }, .n = .{ 0, 1, 0 } },
            .{ .pos = .{ 0, 1, 1 }, .uv = .{ 0, 1 }, .n = .{ 0, 1, 0 } },
            .{ .pos = .{ 1, 1, 1 }, .uv = .{ 1, 1 }, .n = .{ 0, 1, 0 } },
            .{ .pos = .{ 1, 1, 0 }, .uv = .{ 1, 0 }, .n = .{ 0, 1, 0 } },
        },
        .layer = 0,
        .tint = .none,
        .cull = .up,
        .ao = false,
        .greedy = true,
        .ao_off = .{.{ .{ 0, 1, 0 }, .{ 0, 1, 0 }, .{ 0, 1, 0 } }} ** 4,
    }};
    var cache = [_]?Cached{ null, .{ .faces = &faces_buf, .occluder = true } };
    var greedy_faces = [_][6]i16{ .{ -1, -1, -1, -1, -1, -1 }, .{ -1, -1, -1, -1, -1, -1 } };
    greedy_faces[1][up] = 0;
    const nkind = @as(usize, biome.Tint.count);
    const tint = try a.alloc([3]u8, 1 * nkind); // only biome id 0 present
    @memset(tint, .{ 255, 255, 255 });
    var id_occluder = [_]bool{ false, true };
    const ctx: MeshCtx = .{
        .g = g,
        .cache = &cache,
        .id_occluder = &id_occluder,
        .is_water = &.{ false, false },
        .is_lava = &.{ false, false },
        .waterish = &.{ false, false },
        .tint_colors = tint,
        .nkind = nkind,
        .quality = .flat,
        .blend_biomes = false,
        .fluid_level = &.{ -1, -1 },
        .greedy_faces = &greedy_faces,
        .interior = .{ .x0 = 1, .z0 = 1, .x1 = 3, .z1 = 3 },
        .cave_y = null,
    };
    var out: Mesh2 = .{};
    try meshGreedyDir(&ctx, a, &out, up);
    try std.testing.expectEqual(@as(u32, 4), out.vertex_count); // one merged quad
    // Every vertex lies within the interior box [1,3]×[1,3] (world == grid here).
    var i: usize = 0;
    while (i < out.vertex_count) : (i += 1) {
        const px = out.positions.items[i * 3 + 0];
        const pz = out.positions.items[i * 3 + 2];
        try std.testing.expect(px >= 1 and px <= 3);
        try std.testing.expect(pz >= 1 and pz <= 3);
    }
}

test "fluid level parsing and base height" {
    try std.testing.expectEqual(@as(u8, 0), parseLevel(""));
    try std.testing.expectEqual(@as(u8, 0), parseLevel("waterlogged=true"));
    try std.testing.expectEqual(@as(u8, 3), parseLevel("level=3"));
    try std.testing.expectEqual(@as(u8, 8), parseLevel("level=8,foo=bar"));
    // Source renders at 14/16; falling/full at 1.0; flowing steps down.
    try std.testing.expectApproxEqAbs(@as(f32, 14.0 / 16.0), liquidBaseHeight(0), 1e-6);
    try std.testing.expectEqual(@as(f32, 1.0), liquidBaseHeight(8));
    try std.testing.expectApproxEqAbs(@as(f32, (14.0 - 7.0 * 1.9) / 16.0), liquidBaseHeight(7), 1e-6);
    try std.testing.expect(liquidBaseHeight(1) < liquidBaseHeight(0)); // flowing sits below source
}

test "emitFluid: a lone lava source emits fluid-height geometry, flow-textured sides" {
    var arena_inst = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_inst.deinit();
    const a = arena_inst.allocator();

    // 1×1×1 grid holding a single lava source; everything around is out-of-grid
    // (reads as air), so all 6 faces are exposed.
    var ids = [_]u16{1};
    var lightbuf = [_]u8{0x0F}; // block light 15 (lava's own glow)
    var names = [_][]const u8{ "", "minecraft:lava" };
    const g: grid.Grid = .{
        .sx = 1,
        .sy = 1,
        .sz = 1,
        .min_x = 0,
        .min_y = 0,
        .min_z = 0,
        .ids = &ids,
        .light = &lightbuf,
        .names = &names,
    };
    const nkind = @as(usize, biome.Tint.count);
    const tint = try a.alloc([3]u8, 1 * nkind);
    @memset(tint, .{ 10, 20, 30 });
    const ctx: MeshCtx = .{
        .g = g,
        .cache = &.{},
        .id_occluder = &.{ false, false },
        .is_water = &.{ false, false },
        .is_lava = &.{ false, true },
        .waterish = &.{ false, false },
        .tint_colors = tint,
        .nkind = nkind,
        .lava_layers = .{ .still = 5, .flow = 6 },
        .quality = .flat,
        .blend_biomes = false,
        .fluid_level = &.{ -1, 0 },
        .greedy_faces = &.{},
        .interior = grid.Interior.full(g),
        .cave_y = null,
    };
    var out: Mesh2 = .{};
    try emitFluid(a, &out, &ctx, .lava, 0, 0, 0, 0, 0, 0, 0);

    try std.testing.expectEqual(@as(u32, 24), out.vertex_count); // 6 faces
    // Every top vertex sits at the source height 14/16; none at full height.
    var top_verts: usize = 0;
    var i: usize = 0;
    while (i < out.vertex_count) : (i += 1) {
        const py = out.positions.items[i * 3 + 1];
        try std.testing.expect(py == 0.0 or py < 0.9);
        if (py > 0.0) {
            try std.testing.expectApproxEqAbs(@as(f32, 14.0 / 16.0), py, 1e-6);
            top_verts += 1;
        }
    }
    try std.testing.expectEqual(@as(usize, 12), top_verts); // top quad + 2 per side face
    // Faces: a flat source top samples the STILL layer; sides the FLOW layer.
    var still_faces: usize = 0;
    var flow_faces: usize = 0;
    var f: usize = 0;
    while (f < 6) : (f += 1) {
        const layer = out.layer.items[f * 4];
        if (layer == 5) still_faces += 1 else if (layer == 6) flow_faces += 1;
        // Untinted (white) + opaque alpha, lit by the cell's own block light 15.
        try std.testing.expectEqual(@as(u8, 255), out.color.items[f * 16 + 0]);
        try std.testing.expectEqual(@as(u8, 255), out.color.items[f * 16 + 3]);
        try std.testing.expectEqual(@as(i8, 0x0F), out.normals.items[f * 16 + 3]);
    }
    try std.testing.expectEqual(@as(usize, 2), still_faces); // flat top + bottom
    try std.testing.expectEqual(@as(usize, 4), flow_faces); // 4 sides
    // Side-face UVs stay in the flow texture's top-left quadrant-ish window:
    // u ∈ {0, .5}, v from (1-h)/2 at the surface down to .5 at the base.
    var k: usize = 0;
    while (k < out.vertex_count) : (k += 1) {
        const u = out.uv.items[k * 2];
        const v = out.uv.items[k * 2 + 1];
        try std.testing.expect(u >= 0.0 and u <= 1.0 and v >= 0.0 and v <= 1.0);
    }
}
