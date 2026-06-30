//! Tiled-map generator (P4): split a world into a quadtree of small, streamable
//! tiles plus a manifest, instead of one monolithic `.vtile`.
//!
//! ## Why
//!
//! The single-tile path (`render`) emits one giant blob for the whole render
//! window. That caps how much world the browser can load and forces every vertex
//! on screen regardless of where the camera looks. Tiling makes payload and draw
//! cost scale with the *screen*, not the world: the frontend streams only the
//! tiles the camera can see, and (later) coarse LOD tiles for the distance.
//!
//! ## The tile grid
//!
//! Level-0 (hires) tiles are {@link TILE}×{@link TILE} blocks in XZ, full height,
//! aligned to the world origin: tile `(tx,tz)` covers world X in `[tx·TILE,
//! tx·TILE+TILE)` and Z likewise. They form an XZ quadtree — the parent of
//! `(l,tx,tz)` is `(l+1, tx>>1, tz>>1)` — so coarser levels (P4 slice 2) double
//! the footprint each step.
//!
//! ## Correctness at the seam
//!
//! Each tile is meshed from its *own* grid, assembled over the tile plus an
//! {@link APRON}-block ring of neighbour blocks. The apron is context only: the
//! mesher emits faces for the tile interior alone (see `mesh.Interior`), reading
//! the apron for cross-tile face culling, ambient occlusion, and the light
//! flood-fill. APRON = 16 makes the computed light essentially exact at the seam
//! (sky light spreads ≤15 blocks horizontally, block light ≤14 from any emitter),
//! and every solid block lives in exactly one tile's interior — so faces emit
//! once: no seams, no double-draw, and greedy quads stay bounded to the tile.
//!
//! ## Shared resources
//!
//! One texture array (`textures.vtexarr`) and one biome legend serve the whole
//! map, so every tile shares a single GPU material and the biome layer stays
//! global. All tiles accumulate into one `texture.Builder` (layer ids are global)
//! and remap their biome ids through one {@link BiomeAtlas}; per-tile tiles carry
//! an empty legend and global biome ids, and the manifest holds the legend.
//!
//! ## Output layout (`out_dir`)
//!
//!   map.json            the manifest (tiles, world bounds, legend, texture ref)
//!   textures.vtexarr    the shared texture array
//!   t0_<tx>_<tz>.vtile  one quantized tile per populated leaf

const std = @import("std");
const grid = @import("grid.zig");
const mesh = @import("mesh.zig");
const tile = @import("tile.zig");
const texture = @import("texture.zig");
const model = @import("model.zig");
const biome = @import("biome.zig");
const lang = @import("lang.zig");
const world = @import("world.zig");

/// Leaf tile footprint in blocks (2×2 chunks). Matches BlueMap's hires tiling and
/// keeps tiles chunk-aligned for future per-chunk dirty tracking.
pub const TILE: i32 = 32;

/// Neighbour-block apron each tile's grid carries for correct cross-tile face
/// culling, AO, and light. 16 = one chunk; see the module note on why that makes
/// the seam light essentially exact.
pub const APRON: i32 = 16;

pub const Options = struct {
    quality: mesh.LightQuality = .smooth,
    blend_biomes: bool = true,
};

/// A manifest tile entry: its quadtree address, its file, a content hash for
/// cache-busting, vertex count, and the world-space AABB used for frustum culling
/// and camera framing on the frontend.
const Entry = struct {
    l: u8,
    x: i32,
    z: i32,
    file: []const u8,
    hash: u64,
    verts: u32,
    box: [6]f32, // minX,minY,minZ, maxX,maxY,maxZ
};

/// Global biome interner shared across every tile. Keyed by raw biome name (e.g.
/// `minecraft:plains`) so ids are stable; carries the parallel display names that
/// become the manifest legend. id 0 = "" (the no-data sentinel), matching the
/// per-grid biome convention so a tile's local id 0 maps straight to global 0.
const BiomeAtlas = struct {
    arena: std.mem.Allocator,
    ids: std.StringHashMap(u16),
    raw: std.ArrayList([]const u8) = .empty,
    display: std.ArrayList([]const u8) = .empty,

    fn init(arena: std.mem.Allocator) !BiomeAtlas {
        var self: BiomeAtlas = .{ .arena = arena, .ids = std.StringHashMap(u16).init(arena) };
        try self.raw.append(arena, "");
        try self.display.append(arena, "");
        return self;
    }

    /// Intern a (raw, display) pair, returning its stable global id. Names are
    /// duped into the atlas arena so they outlive the per-tile arenas.
    fn intern(self: *BiomeAtlas, raw_name: []const u8, display_name: []const u8) !u16 {
        const gop = try self.ids.getOrPut(raw_name);
        if (!gop.found_existing) {
            const id: u16 = @intCast(self.raw.items.len);
            const key = try self.arena.dupe(u8, raw_name);
            gop.key_ptr.* = key;
            try self.raw.append(self.arena, key);
            try self.display.append(self.arena, try self.arena.dupe(u8, display_name));
            gop.value_ptr.* = id;
        }
        return gop.value_ptr.*;
    }
};

/// Remap a freshly-assembled tile grid's biome ids onto the global atlas, in
/// place, so per-vertex biome ids written into the tile index the manifest
/// legend. The grid's name table is repointed at the atlas's global raw names so
/// the tint table (which looks names up in the biome registry) and `biomeAt`
/// (which now returns global ids) stay consistent. `names` resolves display names.
fn remapBiomes(arena: std.mem.Allocator, g: *grid.Grid, atlas: *BiomeAtlas, names: lang.Lang) !void {
    if (g.biome_names.len == 0) return;
    const lut = try arena.alloc(u16, g.biome_names.len);
    lut[0] = 0; // "" sentinel -> global 0
    for (g.biome_names[1..], 1..) |raw, i| {
        lut[i] = try atlas.intern(raw, names.biomeName(arena, raw));
    }
    for (g.biome_ids) |*cell| cell.* = lut[cell.*];
    // Repoint the grid's name table at the global (superset) names. Valid through
    // this tile's synchronous build — the atlas only appends on the next tile.
    g.biome_names = atlas.raw.items;
}

/// Generate a tiled map under `out_dir`. Discovers the world's region directory,
/// loads it once, then meshes every populated leaf tile into its own quantized
/// `.vtile`, accumulating a shared texture array + biome legend, and writes the
/// manifest. `progress`, if given, advances once per tile slot scanned.
pub fn run(
    init: std.process.Init,
    a: std.mem.Allocator,
    region_dir: []const u8,
    assets: []const u8,
    out_dir: []const u8,
    opts: Options,
    progress: ?std.Progress.Node,
) !void {
    const io = init.io;
    const loaded = try world.loadRegions(a, io, region_dir);
    const bounds = world.populatedBounds(loaded);
    if (bounds.count == 0) {
        std.debug.print("no populated chunks found.\n", .{});
        return;
    }
    // Decode every chunk once up front; each tile's grid (tile + apron) is then
    // assembled from the store, so apron-shared chunks aren't re-decoded per tile.
    var store = try world.decodeAll(a, loaded);

    // Shared, build-once resources.
    const resolver: model.Resolver = .{ .arena = a, .io = io, .root = assets };
    var builder = try texture.Builder.init(a, io, assets);
    const maps = biome.Colormaps.load(a, io, assets);
    const data_root = dataRootFromAssets(a, assets);
    var reg = biome.Registry.init(a, io, data_root);
    const names = lang.Lang.load(a, io, assets);
    var atlas = try BiomeAtlas.init(a);
    // One bake cache for the whole map: each distinct block model is resolved and
    // baked once, not once per tile (the dominant cost of naive per-tile meshing).
    var bake_cache = mesh.BakeCache.init(a);

    try ensureDir(io, out_dir);

    // World-block bounds, and the leaf-tile index range covering them.
    const bx0: i32 = bounds.min_cx * 16;
    const bx1: i32 = bounds.max_cx * 16 + 15;
    const bz0: i32 = bounds.min_cz * 16;
    const bz1: i32 = bounds.max_cz * 16 + 15;
    const tx0 = @divFloor(bx0, TILE);
    const tx1 = @divFloor(bx1, TILE);
    const tz0 = @divFloor(bz0, TILE);
    const tz1 = @divFloor(bz1, TILE);

    var entries: std.ArrayList(Entry) = .empty;
    var wmin_y: f32 = std.math.inf(f32);
    var wmax_y: f32 = -std.math.inf(f32);

    const total: usize = @intCast((tx1 - tx0 + 1) * (tz1 - tz0 + 1));
    const node: ?std.Progress.Node = if (progress) |p| p.start("meshing tiles", total) else null;

    // One arena reused across tiles, reset (retaining capacity) per tile rather than
    // torn down — so each tile's grid/mesh/blob is reclaimed without re-mmapping and
    // munmapping multi-MB buffers 36× (which dwarfed the actual meshing). Peak RAM is
    // still one tile, since reset frees the contents and only keeps the backing pages.
    var tarena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer tarena.deinit();

    var tz = tz0;
    while (tz <= tz1) : (tz += 1) {
        var tx = tx0;
        while (tx <= tx1) : (tx += 1) {
            if (node) |n| n.completeOne();

            // Skip tiles whose *interior* chunks are all absent. Their apron may
            // still overlap populated chunks, but with an empty interior the tile
            // produces no geometry — assembling + lighting it (over the apron) would
            // be pure waste. On a sparse world this is the bulk of the scanned slots.
            if (!interiorHasChunks(&store, tx, tz)) continue;

            _ = tarena.reset(.retain_capacity); // reclaim the previous tile's allocations
            const ta = tarena.allocator();

            // Assemble the tile + apron grid over its chunk range.
            const cx0 = @divFloor(tx * TILE - APRON, 16);
            const cx1 = @divFloor(tx * TILE + TILE - 1 + APRON, 16);
            const cz0 = @divFloor(tz * TILE - APRON, 16);
            const cz1 = @divFloor(tz * TILE + TILE - 1 + APRON, 16);
            var stats: grid.Stats = .{};
            var g = try world.assembleFromStore(ta, &store, cx0, cz0, cx1, cz1, &stats);
            if (g.ids.len == 0) continue; // no chunks overlap this tile

            try remapBiomes(ta, &g, &atlas, names);

            const interior: mesh.Interior = .{
                .x0 = tx * TILE,
                .x1 = tx * TILE + TILE - 1,
                .z0 = tz * TILE,
                .z1 = tz * TILE + TILE - 1,
            };
            const built = try mesh.buildTextured(ta, g, resolver, &builder, maps, &reg, opts.quality, opts.blend_biomes, interior, &bake_cache, null);
            const vc = built.solid.vertex_count + built.fluid.vertex_count;
            if (vc == 0) continue; // interior is all air — no tile

            const surface = try grid.buildSurfaceRect(ta, g, @intCast(interior.x0), @intCast(interior.z0), @intCast(interior.x1), @intCast(interior.z1));
            // Empty per-tile legend: biome ids are global, the manifest holds the legend.
            const blob = try tile.serializeWithSurfaceQuantized(ta, built.solid, built.fluid, surface, &.{});

            const file = try std.fmt.allocPrint(a, "t0_{d}_{d}.vtile", .{ tx, tz });
            const path = try std.fmt.allocPrint(ta, "{s}/{s}", .{ out_dir, file });
            try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = blob });

            const box = meshBounds(built);
            wmin_y = @min(wmin_y, box[1]);
            wmax_y = @max(wmax_y, box[4]);
            try entries.append(a, .{
                .l = 0,
                .x = tx,
                .z = tz,
                .file = file,
                .hash = std.hash.Wyhash.hash(0, blob),
                .verts = vc,
                .box = box,
            });
        }
    }
    if (node) |n| n.end();

    // Shared texture array.
    const arr = try builder.finish();
    const tex_blob = try texture.serialize(a, arr);
    const tex_path = try std.fmt.allocPrint(a, "{s}/textures.vtexarr", .{out_dir});
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = tex_path, .data = tex_blob });

    // Manifest.
    const manifest = try buildManifest(a, entries.items, atlas, .{
        .min_x = bx0,
        .min_z = bz0,
        .max_x = bx1,
        .max_z = bz1,
        .min_y = if (std.math.isInf(wmin_y)) -64 else wmin_y,
        .max_y = if (std.math.isInf(wmax_y)) 320 else wmax_y,
    });
    const man_path = try std.fmt.allocPrint(a, "{s}/map.json", .{out_dir});
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = man_path, .data = manifest });

    std.debug.print(
        \\map:      {s}
        \\tiles:    {d} populated (of {d} scanned), grid t[{d}..{d}] × t[{d}..{d}]
        \\world:    X[{d}..{d}] Z[{d}..{d}] Y[{d:.0}..{d:.0}]  ({d} biomes)
        \\textures: {d} layers ({d} bytes)
        \\
    , .{
        out_dir,
        entries.items.len,
        total,
        tx0,
        tx1,
        tz0,
        tz1,
        bx0,
        bx1,
        bz0,
        bz1,
        if (std.math.isInf(wmin_y)) -64 else wmin_y,
        if (std.math.isInf(wmax_y)) 320 else wmax_y,
        atlas.raw.items.len - 1,
        arr.layer_count,
        tex_blob.len,
    });
}

/// Whether any chunk in tile `(tx,tz)`'s interior (its own footprint, not the
/// apron) is populated — the gate for whether a tile is worth assembling. A tile
/// spans `TILE/16` chunks per axis.
fn interiorHasChunks(store: *const world.ChunkStore, tx: i32, tz: i32) bool {
    const cpt = @divExact(TILE, 16); // chunks per tile axis
    var cz = tz * cpt;
    while (cz < tz * cpt + cpt) : (cz += 1) {
        var cx = tx * cpt;
        while (cx < tx * cpt + cpt) : (cx += 1) {
            if (store.get(.{ cx, cz }) != null) return true;
        }
    }
    return false;
}

/// World AABB of a built tile's geometry (solid + fluid), as
/// `minX,minY,minZ, maxX,maxY,maxZ`. Used for frustum culling and framing.
fn meshBounds(built: mesh.Built) [6]f32 {
    var lo = [3]f32{ std.math.inf(f32), std.math.inf(f32), std.math.inf(f32) };
    var hi = [3]f32{ -std.math.inf(f32), -std.math.inf(f32), -std.math.inf(f32) };
    for ([_]*const mesh.Mesh2{ &built.solid, &built.fluid }) |m| {
        const p = m.positions.items;
        var i: usize = 0;
        while (i + 2 < p.len) : (i += 3) {
            inline for (0..3) |k| {
                lo[k] = @min(lo[k], p[i + k]);
                hi[k] = @max(hi[k], p[i + k]);
            }
        }
    }
    return .{ lo[0], lo[1], lo[2], hi[0], hi[1], hi[2] };
}

const WorldBox = struct { min_x: i32, min_z: i32, max_x: i32, max_z: i32, min_y: f32, max_y: f32 };

/// Serialize the manifest as JSON. Hand-rolled (no std.json dependency) so the
/// shape is explicit and stable — this is the generator↔frontend contract. Built
/// by appending into an `ArrayList(u8)`, matching the rest of the codebase's
/// allocator-passing idiom (the intermediate format strings live in `a`'s arena).
fn buildManifest(a: std.mem.Allocator, entries: []const Entry, atlas: BiomeAtlas, w: WorldBox) ![]u8 {
    var s: std.ArrayList(u8) = .empty;
    try appendFmt(a, &s,
        \\{{"format":"vantage-map","version":1,"tileMagic":"VTL6","tileSize":{d},"apron":{d},
    , .{ TILE, APRON });
    try appendFmt(a, &s,
        \\"textures":"textures.vtexarr","world":{{"minX":{d},"minZ":{d},"maxX":{d},"maxZ":{d},"minY":{d:.0},"maxY":{d:.0}}},
    , .{ w.min_x, w.min_z, w.max_x, w.max_z, w.min_y, w.max_y });

    // Legend (display names, indexed by global biome id).
    try s.appendSlice(a, "\"legend\":[");
    for (atlas.display.items, 0..) |name, i| {
        if (i > 0) try s.append(a, ',');
        try appendJsonString(a, &s, name);
    }
    try s.appendSlice(a, "],\"tiles\":[");
    for (entries, 0..) |e, i| {
        if (i > 0) try s.append(a, ',');
        try appendFmt(a, &s,
            \\{{"l":{d},"x":{d},"z":{d},"file":"{s}","h":"{x}","v":{d},"box":[{d:.2},{d:.2},{d:.2},{d:.2},{d:.2},{d:.2}]}}
        , .{ e.l, e.x, e.z, e.file, e.hash, e.verts, e.box[0], e.box[1], e.box[2], e.box[3], e.box[4], e.box[5] });
    }
    try s.appendSlice(a, "]}");
    return s.toOwnedSlice(a);
}

fn appendFmt(a: std.mem.Allocator, s: *std.ArrayList(u8), comptime fmt: []const u8, args: anytype) !void {
    const chunk = try std.fmt.allocPrint(a, fmt, args);
    try s.appendSlice(a, chunk);
}

/// Append a JSON string literal, escaping the characters JSON requires. Biome
/// display names are plain text, but escape defensively.
fn appendJsonString(a: std.mem.Allocator, s: *std.ArrayList(u8), str: []const u8) !void {
    try s.append(a, '"');
    for (str) |c| switch (c) {
        '"' => try s.appendSlice(a, "\\\""),
        '\\' => try s.appendSlice(a, "\\\\"),
        '\n' => try s.appendSlice(a, "\\n"),
        '\r' => try s.appendSlice(a, "\\r"),
        '\t' => try s.appendSlice(a, "\\t"),
        else => try s.append(a, c),
    };
    try s.append(a, '"');
}

/// Create `path` (and parents) if absent; idempotent when it already exists.
fn ensureDir(io: std.Io, path: []const u8) !void {
    try std.Io.Dir.cwd().createDirPath(io, path);
}

/// Map `<root>/assets/minecraft` -> `<root>/data/minecraft` (data pack beside the
/// resource pack in an extracted jar). "" if the layout doesn't match.
fn dataRootFromAssets(a: std.mem.Allocator, assets: []const u8) []const u8 {
    var p = assets;
    if (std.mem.endsWith(u8, p, "/")) p = p[0 .. p.len - 1];
    const suffix = "assets/minecraft";
    if (!std.mem.endsWith(u8, p, suffix)) return "";
    return std.fmt.allocPrint(a, "{s}data/minecraft", .{p[0 .. p.len - suffix.len]}) catch "";
}

test "BiomeAtlas interns stably, reserving id 0 for the sentinel" {
    var ar = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer ar.deinit();
    const a = ar.allocator();
    var atlas = try BiomeAtlas.init(a);
    try std.testing.expectEqual(@as(u16, 1), try atlas.intern("minecraft:plains", "Plains"));
    try std.testing.expectEqual(@as(u16, 2), try atlas.intern("minecraft:savanna", "Savanna"));
    try std.testing.expectEqual(@as(u16, 1), try atlas.intern("minecraft:plains", "Plains"));
    try std.testing.expectEqual(@as(usize, 3), atlas.raw.items.len); // "", plains, savanna
    try std.testing.expectEqualStrings("Savanna", atlas.display.items[2]);
}

test "buildManifest emits the locked contract shape" {
    // Use an arena: buildManifest allocates intermediate format chunks into the
    // passed allocator by design (freed wholesale in production's arena).
    var ar = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer ar.deinit();
    const a = ar.allocator();
    var atlas = try BiomeAtlas.init(a);
    _ = try atlas.intern("minecraft:plains", "Plains");
    const entries = [_]Entry{.{
        .l = 0,
        .x = -1,
        .z = 2,
        .file = "t0_-1_2.vtile",
        .hash = 0xABCD,
        .verts = 100,
        .box = .{ -32, -64, 64, 0, 80, 96 },
    }};
    const json = try buildManifest(a, &entries, atlas, .{ .min_x = -32, .min_z = 0, .max_x = 31, .max_z = 63, .min_y = -64, .max_y = 80 });
    try std.testing.expect(std.mem.indexOf(u8, json, "\"format\":\"vantage-map\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"tileSize\":32") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"legend\":[\"\",\"Plains\"]") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"file\":\"t0_-1_2.vtile\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"h\":\"abcd\"") != null);
}
