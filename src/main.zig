//! Vantage CLI.
//!
//! Subcommands:
//!   vantage mesh  <region.mca> <out.vtile> [cx0 cz0 cx1 cz1]
//!       Decode a rectangular range of chunks (region-local coords 0..31,
//!       inclusive; default 0 0 0 0 = one chunk), build a culled cube mesh, and
//!       write a v1 `.vtile` — the asset-free flat-color path.
//!
//!   vantage histo <region.mca> [localX localZ]
//!       Block histogram for one chunk (default 0 0). Also runs when no
//!       subcommand is given, for back-compat: `vantage <region.mca> [lx lz]`.

const std = @import("std");
const compress = @import("compress.zig");
const nbt = @import("nbt.zig");
const region = @import("region.zig");
const chunk = @import("chunk.zig");
const grid = @import("grid.zig");
const mesh = @import("mesh.zig");
const tile = @import("tile.zig");
const blocks = @import("blocks.zig");
const model = @import("model.zig");
const texture = @import("texture.zig");
const biome = @import("biome.zig");
const lang = @import("lang.zig");
const world = @import("world.zig");
const lowres = @import("lowres.zig");

pub fn main(init: std.process.Init) !void {
    const a = init.arena.allocator();
    const args = try init.minimal.args.toSlice(a);
    if (args.len < 2) return usage();

    // Dispatch. If args[1] is a known subcommand use it, else treat args[1] as a
    // region path for the legacy histogram form.
    if (std.mem.eql(u8, args[1], "render")) {
        return runRender(init, a, args[2..]);
    } else if (std.mem.eql(u8, args[1], "mesh")) {
        return runMesh(init, a, args[2..]);
    } else if (std.mem.eql(u8, args[1], "meshtex")) {
        return runMeshTex(init, a, args[2..]);
    } else if (std.mem.eql(u8, args[1], "histo")) {
        return runHisto(init, a, args[2..]);
    } else if (std.mem.eql(u8, args[1], "biomes")) {
        return runBiomes(init, a, args[2..]);
    } else if (std.mem.eql(u8, args[1], "resolve")) {
        return runResolve(init, a, args[2..]);
    } else if (std.mem.eql(u8, args[1], "texinfo")) {
        return runTexinfo(init, a, args[2..]);
    } else {
        return runHisto(init, a, args[1..]);
    }
}

fn usage() error{MissingArgument} {
    std.debug.print(
        \\usage:
        \\  vantage render  <world-save-dir> [--assets <dir>] [--out <dir>] [--tile-chunks <n>]
        \\                  [--radius <chunks>] [--light flat|smooth] [--biome-blend on|off] [--caves off|<y>]
        \\                  [--threads <n>]
        \\      Render the whole populated world as streamable tiles + manifest.json
        \\      (default out: web/public). --radius caps to a window around spawn.
        \\  vantage mesh    <region.mca> <out.vtile> [cx0 cz0 cx1 cz1]
        \\  vantage meshtex <region.mca> <out.vtile> <assets/minecraft dir> [cx0 cz0 cx1 cz1] [--light flat|smooth] [--biome-blend on|off]
        \\  vantage histo   <region.mca> [localX localZ]
        \\  vantage biomes  <region.mca> [cx0 cz0 cx1 cz1]
        \\  vantage resolve <assets/minecraft dir> <block-name> [state e.g. axis=x]
        \\  vantage texinfo <assets/minecraft dir> <block-name...>
        \\
    , .{});
    return error.MissingArgument;
}

/// Scan args for `--light flat|smooth` (default `smooth`). The bake-time light
/// quality: `smooth` averages light over each vertex's neighbourhood, `flat`
/// lights per face. Tolerant of position — both meshtex and render accept it.
fn parseLightQuality(args: []const []const u8) mesh.LightQuality {
    var i: usize = 0;
    while (i + 1 < args.len) : (i += 1) {
        if (!std.mem.eql(u8, args[i], "--light")) continue;
        if (std.mem.eql(u8, args[i + 1], "flat")) return .flat;
        if (std.mem.eql(u8, args[i + 1], "smooth")) return .smooth;
    }
    return .smooth;
}

/// Scan args for `--caves off|<y>` (default `55`). Faces
/// below this world Y that only look into dark (sky-light-0) cells are culled —
/// they are invisible from any above-ground view and dominate tile size on
/// modern worlds. `off` renders full cave geometry.
fn parseCaveY(args: []const []const u8) ?i32 {
    var i: usize = 0;
    while (i + 1 < args.len) : (i += 1) {
        if (!std.mem.eql(u8, args[i], "--caves")) continue;
        if (std.mem.eql(u8, args[i + 1], "off")) return null;
        return std.fmt.parseInt(i32, args[i + 1], 10) catch 55;
    }
    return 55;
}

/// Scan args for `--threads <n>`. Null means "not given" — the render defaults
/// to the logical CPU count. `--threads 1` renders tiles serially.
fn parseThreads(args: []const []const u8) ?usize {
    var i: usize = 0;
    while (i + 1 < args.len) : (i += 1) {
        if (!std.mem.eql(u8, args[i], "--threads")) continue;
        return std.fmt.parseInt(usize, args[i + 1], 10) catch null;
    }
    return null;
}

/// Scan args for `--biome-blend on|off` (default `on`). When on, biome tint
/// colours (grass/foliage/water) are bilinearly blended across biome borders for
/// smooth vanilla-style gradients; off steps hard at each biome cell.
fn parseBiomeBlend(args: []const []const u8) bool {
    var i: usize = 0;
    while (i + 1 < args.len) : (i += 1) {
        if (!std.mem.eql(u8, args[i], "--biome-blend")) continue;
        if (std.mem.eql(u8, args[i + 1], "off")) return false;
        if (std.mem.eql(u8, args[i + 1], "on")) return true;
    }
    return true;
}

fn runTexinfo(init: std.process.Init, a: std.mem.Allocator, args: []const []const u8) !void {
    if (args.len < 2) return usage();
    const root = args[0];
    const resolver: model.Resolver = .{ .arena = a, .io = init.io, .root = root };
    var builder = try texture.Builder.init(a, init.io, root);

    // Track which (texture -> layer) we assign so we can report a sample pixel.
    var samples: std.ArrayList([]const u8) = .empty;
    for (args[1..]) |block| {
        const parts = resolver.resolveBlock(block, "") catch |e| {
            std.debug.print("{s}: resolve failed: {s}\n", .{ block, @errorName(e) });
            continue;
        };
        for (parts) |rm| {
            for (rm.elements) |el| {
                for (el.faces) |f| {
                    _ = builder.layerFor(f.texture);
                    try samples.append(a, f.texture);
                }
            }
        }
    }

    const arr = try builder.finish();
    std.debug.print("texture array: {d}x{d}, {d} layers ({d} bytes)\n\n", .{
        arr.width, arr.height, arr.layer_count, arr.pixels.len,
    });
    // Report unique texture -> layer + center pixel.
    var seen = std.StringHashMap(void).init(a);
    for (samples.items) |path| {
        if (seen.contains(path)) continue;
        try seen.put(path, {});
        const layer = builder.layerFor(path);
        const center = (layer * texture.TILE * texture.TILE + (texture.TILE / 2) * texture.TILE + texture.TILE / 2) * 4;
        std.debug.print("  layer {d:>3}  {s:<34}  center rgba=({d},{d},{d},{d})\n", .{
            layer,                  path,
            arr.pixels[center + 0], arr.pixels[center + 1],
            arr.pixels[center + 2], arr.pixels[center + 3],
        });
    }
}

fn runResolve(init: std.process.Init, a: std.mem.Allocator, args: []const []const u8) !void {
    if (args.len < 2) return usage();
    const root = args[0];
    const block = args[1];
    const state = if (args.len > 2) args[2] else ""; // e.g. "axis=x"

    const resolver: model.Resolver = .{ .arena = a, .io = init.io, .root = root };
    const parts = try resolver.resolveBlock(block, state);

    std.debug.print("block: {s}\nstate: {s}\nassets: {s}\nparts: {d}\n", .{ block, state, root, parts.len });
    for (parts, 0..) |rm, pi| {
        std.debug.print("\npart[{d}]  rot(x={d},y={d}) uvlock={}  elements={d}\n", .{
            pi, rm.x, rm.y, rm.uvlock, rm.elements.len,
        });
        for (rm.elements, 0..) |el, ei| {
            std.debug.print("  element[{d}] from({d:.0},{d:.0},{d:.0}) to({d:.0},{d:.0},{d:.0})\n", .{
                ei, el.from[0], el.from[1], el.from[2], el.to[0], el.to[1], el.to[2],
            });
            for (el.faces) |f| {
                std.debug.print("     {s:<6} tex={s:<34} uv=[{d:.0},{d:.0},{d:.0},{d:.0}] cull={s:<5} tint={d} rot={d}\n", .{
                    @tagName(f.dir),
                    f.texture,
                    f.uv[0],
                    f.uv[1],
                    f.uv[2],
                    f.uv[3],
                    if (f.cullface) |c| @tagName(c) else "-",
                    f.tintindex,
                    f.rotation,
                });
            }
        }
    }
}

fn runMesh(init: std.process.Init, a: std.mem.Allocator, args: []const []const u8) !void {
    if (args.len < 2) return usage();
    const region_path = args[0];
    const out_path = args[1];

    var cx0: u5 = 0;
    var cz0: u5 = 0;
    var cx1: u5 = 0;
    var cz1: u5 = 0;
    if (args.len >= 6) {
        cx0 = @truncate(try std.fmt.parseInt(u8, args[2], 10));
        cz0 = @truncate(try std.fmt.parseInt(u8, args[3], 10));
        cx1 = @truncate(try std.fmt.parseInt(u8, args[4], 10));
        cz1 = @truncate(try std.fmt.parseInt(u8, args[5], 10));
    }
    if (cx1 < cx0 or cz1 < cz0) return error.BadRange;

    const bytes = try std.Io.Dir.cwd().readFileAlloc(init.io, region_path, a, .unlimited);

    var stats: grid.Stats = .{};
    const g = try grid.assemble(a, bytes, cx0, cz0, cx1, cz1, &stats);
    const m = try mesh.build(a, g);
    const blob = try tile.serialize(a, m);

    try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = out_path, .data = blob });

    std.debug.print(
        \\region:    {s}
        \\chunks:    {d} loaded, {d} missing  (range {d},{d}..{d},{d})
        \\grid:      {d} x {d} x {d} blocks  (minY={d})
        \\mesh:      {d} vertices, {d} quads, {d} triangles
        \\tile:      {s}  ({d} bytes)
        \\
    , .{
        region_path,
        stats.chunks_loaded,
        stats.chunks_missing,
        cx0,
        cz0,
        cx1,
        cz1,
        g.sx,
        g.sy,
        g.sz,
        g.min_y,
        m.vertex_count,
        m.quadCount(),
        m.triangleCount(),
        out_path,
        blob.len,
    });
}

fn runMeshTex(init: std.process.Init, a: std.mem.Allocator, args: []const []const u8) !void {
    if (args.len < 3) return usage();
    const region_path = args[0];
    const out_path = args[1];
    const assets = args[2];

    var cx0: u5 = 0;
    var cz0: u5 = 0;
    var cx1: u5 = 0;
    var cz1: u5 = 0;
    if (args.len >= 7) {
        cx0 = @truncate(try std.fmt.parseInt(u8, args[3], 10));
        cz0 = @truncate(try std.fmt.parseInt(u8, args[4], 10));
        cx1 = @truncate(try std.fmt.parseInt(u8, args[5], 10));
        cz1 = @truncate(try std.fmt.parseInt(u8, args[6], 10));
    }
    if (cx1 < cx0 or cz1 < cz0) return error.BadRange;

    const bytes = try std.Io.Dir.cwd().readFileAlloc(init.io, region_path, a, .unlimited);

    var stats: grid.Stats = .{};
    const g = try grid.assemble(a, bytes, cx0, cz0, cx1, cz1, &stats);

    const resolver: model.Resolver = .{ .arena = a, .io = init.io, .root = assets };
    var builder = try texture.Builder.init(a, init.io, assets);
    const maps = biome.Colormaps.load(a, init.io, assets);
    const data_root = dataRootFromAssets(a, assets);
    var reg = biome.Registry.init(a, init.io, data_root);
    const built = try mesh.buildTextured(a, g, resolver, &builder, maps, &reg, parseLightQuality(args), parseBiomeBlend(args), null, parseCaveY(args), null);
    const arr = try builder.finish();

    // Resolve human-readable biome names from the language file for the legend.
    const names = lang.Lang.load(a, init.io, assets);
    const display = try a.alloc([]const u8, g.biome_names.len);
    if (display.len > 0) display[0] = ""; // air/no-data sentinel
    for (g.biome_names[1..], 1..) |bn, i| display[i] = names.biomeName(a, bn);

    const surface = try grid.buildSurface(a, g, null);
    const geo = try tile.serializeWithSurfaceQuantized(a, built.solid, built.fluid, surface, display);
    const tex_blob = try texture.serialize(a, arr);

    const tex_path = try texArrayPath(a, out_path);
    try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = out_path, .data = geo });
    try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = tex_path, .data = tex_blob });

    std.debug.print(
        \\region:    {s}
        \\assets:    {s}
        \\chunks:    {d} loaded, {d} missing  (range {d},{d}..{d},{d})
        \\blocks:    {d} distinct, {d} biomes
        \\grid:      {d} x {d} x {d} blocks  (minY={d})
        \\textures:  {d} layers ({d}x{d})
        \\mesh:      {d} vertices, {d} triangles ({d} water verts)
        \\tile:      {s}  ({d} bytes)
        \\texarray:  {s}  ({d} bytes)
        \\
    , .{
        region_path,                                               assets,
        stats.chunks_loaded,                                       stats.chunks_missing,
        cx0,                                                       cz0,
        cx1,                                                       cz1,
        stats.distinct_blocks,                                     stats.distinct_biomes,
        g.sx,                                                      g.sy,
        g.sz,                                                      g.min_y,
        arr.layer_count,                                           arr.width,
        arr.height,                                                built.solid.vertex_count + built.fluid.vertex_count,
        built.solid.triangleCount() + built.fluid.triangleCount(), built.fluid.vertex_count,
        out_path,                                                  geo.len,
        tex_path,                                                  tex_blob.len,
    });

    // Resolved tint colours per biome present — confirms the data pack loaded and
    // that biomes map to distinct grass/foliage/water (savanna gold vs plains green).
    if (g.biome_names.len > 1) {
        std.debug.print("biome data: {s}\nbiome tints (grass / foliage / water):\n", .{
            if (data_root.len > 0) data_root else "(none — using temperate defaults)",
        });
        for (g.biome_names[1..]) |bname| {
            const info = reg.lookup(bname);
            const gr = biome.colorFor(maps, .grass, info);
            const fo = biome.colorFor(maps, .foliage, info);
            const wa = biome.colorFor(maps, .water, info);
            std.debug.print("  {s:<28} #{x:0>2}{x:0>2}{x:0>2} / #{x:0>2}{x:0>2}{x:0>2} / #{x:0>2}{x:0>2}{x:0>2}\n", .{
                model.stripNs(bname),
                gr[0],
                gr[1],
                gr[2],
                fo[0],
                fo[1],
                fo[2],
                wa[0],
                wa[1],
                wa[2],
            });
        }
        if (reg.missing > 0) std.debug.print(
            "  note: {d} biome(s) had no data file — extract data/minecraft/worldgen/biome\n",
            .{reg.missing},
        );
    }
}

/// Map `<root>/assets/minecraft` -> `<root>/data/minecraft` (the data pack lives
/// beside the resource pack in an extracted client jar). Returns "" if the assets
/// path isn't in that layout, in which case the registry falls back to defaults.
fn dataRootFromAssets(a: std.mem.Allocator, assets: []const u8) []const u8 {
    var p = assets;
    if (std.mem.endsWith(u8, p, "/")) p = p[0 .. p.len - 1];
    const suffix = "assets/minecraft";
    if (!std.mem.endsWith(u8, p, suffix)) return "";
    return std.fmt.allocPrint(a, "{s}data/minecraft", .{p[0 .. p.len - suffix.len]}) catch "";
}

/// `vantage render <save-dir>` — the friendly entry point: auto-discover the
/// world's region directory and the extracted assets, then render the WHOLE
/// populated world as a grid of streamable tiles + a manifest. Each tile
/// spans `--tile-chunks`² chunks and is meshed with a 1-chunk apron of
/// neighbour data, so culling, AO, light (range 15 < 16-block apron), and
/// biome blending are seam-free across tile borders.
fn runRender(init: std.process.Init, a: std.mem.Allocator, args: []const []const u8) !void {
    if (args.len < 1) return usage();
    const save = args[0];
    var assets_opt: ?[]const u8 = null;
    var out_dir: []const u8 = "web/public";
    var tile_chunks: i32 = 8; // tile span in chunks (128×128 blocks)
    var radius: i32 = 0; // optional cap: only tiles within ±radius chunks of spawn/centre (0 = whole world)
    const quality = parseLightQuality(args);
    const blend_biomes = parseBiomeBlend(args);
    const cave_y = parseCaveY(args);
    var argi: usize = 1;
    while (argi < args.len) : (argi += 1) {
        if (std.mem.eql(u8, args[argi], "--assets") and argi + 1 < args.len) {
            assets_opt = args[argi + 1];
            argi += 1;
        } else if (std.mem.eql(u8, args[argi], "--out") and argi + 1 < args.len) {
            out_dir = args[argi + 1];
            argi += 1;
        } else if (std.mem.eql(u8, args[argi], "--tile-chunks") and argi + 1 < args.len) {
            tile_chunks = std.math.clamp(std.fmt.parseInt(i32, args[argi + 1], 10) catch tile_chunks, 1, 32);
            argi += 1;
        } else if (std.mem.eql(u8, args[argi], "--radius") and argi + 1 < args.len) {
            radius = std.fmt.parseInt(i32, args[argi + 1], 10) catch radius;
            argi += 1;
        }
    }

    const region_dir = (try world.findRegionDir(a, init.io, save)) orelse {
        std.debug.print(
            \\no Minecraft region files found under:
            \\  {s}
            \\Point me at a world save folder (the one with level.dat), e.g.
            \\  ~/Library/Application Support/minecraft/saves/<World>
            \\
        , .{save});
        return error.NoRegions;
    };

    const home = init.environ_map.get("HOME") orelse
        init.environ_map.get("USERPROFILE") orelse ""; // Windows has no HOME
    const assets = assets_opt orelse (try findAssets(a, init.io, home)) orelse {
        std.debug.print(
            \\no extracted assets found. Get them from a client jar first:
            \\  just extract <client.jar>     (or pass --assets <assets/minecraft dir>)
            \\
        , .{});
        return error.NoAssets;
    };

    std.debug.print("world:   {s}\nassets:  {s}\n", .{ region_dir, assets });

    const loaded = try world.loadRegions(a, init.io, region_dir);
    const bounds = world.populatedBounds(loaded);
    if (bounds.count == 0) {
        std.debug.print("no populated chunks found.\n", .{});
        return;
    }
    const populated = try world.populatedChunks(a, loaded);
    const spawn = world.readSpawn(a, init.io, save);

    // The optional --radius cap centres on the spawn point when known (that's
    // where the interesting builds are), else the populated centre.
    const centre_cx: i32 = if (spawn) |s| @divFloor(s[0], 16) else @divFloor(bounds.min_cx + bounds.max_cx, 2);
    const centre_cz: i32 = if (spawn) |s| @divFloor(s[2], 16) else @divFloor(bounds.min_cz + bounds.max_cz, 2);

    // Enumerate the tiles that contain at least one populated chunk. Sparse
    // worlds (exploration trails across hundreds of regions) stay proportional
    // to what exists, not to the bounding box.
    var tile_set = std.AutoHashMap(u64, void).init(a);
    var pit = populated.keyIterator();
    while (pit.next()) |key| {
        const cx: i32 = @bitCast(@as(u32, @truncate(key.* >> 32)));
        const cz: i32 = @bitCast(@as(u32, @truncate(key.*)));
        if (radius > 0 and (@abs(cx - centre_cx) > radius or @abs(cz - centre_cz) > radius)) continue;
        try tile_set.put(world.packChunk(@divFloor(cx, tile_chunks), @divFloor(cz, tile_chunks)), {});
    }
    var tile_keys_list: std.ArrayList(u64) = .empty;
    var tit = tile_set.keyIterator();
    while (tit.next()) |k| try tile_keys_list.append(a, k.*);
    const tile_keys = tile_keys_list.items;
    std.mem.sort(u64, tile_keys, {}, struct {
        fn lt(_: void, x: u64, y: u64) bool {
            // Sort by (z, x) for deterministic output and region-major locality.
            const xz: i32 = @bitCast(@as(u32, @truncate(x)));
            const yz: i32 = @bitCast(@as(u32, @truncate(y)));
            if (xz != yz) return xz < yz;
            const xx: i32 = @bitCast(@as(u32, @truncate(x >> 32)));
            const yx: i32 = @bitCast(@as(u32, @truncate(y >> 32)));
            return xx < yx;
        }
    }.lt);

    std.debug.print("regions: {d} files · {d} populated chunks · extent {d}×{d} chunks · {d} tiles of {d}×{d} chunks\n", .{
        loaded.len,    bounds.count, bounds.spanX(), bounds.spanZ(),
        tile_keys.len, tile_chunks,  tile_chunks,
    });

    // Long-lived shared state: the model resolver (+ cross-tile memo), texture
    // builder (one texture array for every tile), biome registry/colormaps/lang,
    // and the world-level biome table that keeps per-vertex biome ids globally
    // consistent across tiles. Tiles render on worker threads, so everything
    // long-lived allocates through `sa` — a mutex-guarded view of the run arena
    // — and each shared cache takes its own lock around structural mutation.
    var locked: LockedAllocator = .{ .child = a, .io = init.io };
    const sa = locked.allocator();

    var resolver_lock: std.Io.Mutex = .init;
    var memo = std.StringHashMap([]model.ResolvedModel).init(sa);
    const resolver: model.Resolver = .{ .arena = sa, .io = init.io, .root = assets, .memo = &memo, .lock = &resolver_lock };
    var builder = try texture.Builder.init(sa, init.io, assets);
    const maps = biome.Colormaps.load(a, init.io, assets);
    const data_root = dataRootFromAssets(a, assets);
    var reg = biome.Registry.init(sa, init.io, data_root);
    const names = lang.Lang.load(a, init.io, assets);

    var world_mutex: std.Io.Mutex = .init;
    var world_raw: std.ArrayList([]const u8) = .empty; // biome resource names, id-indexed
    var world_display: std.ArrayList([]const u8) = .empty; // legend labels, id-indexed
    var world_biome_ids = std.StringHashMap(u16).init(sa);
    try world_raw.append(sa, "");
    try world_display.append(sa, "");

    var manifest_tiles: std.ArrayList(TileEntry) = .empty;

    // Lowres LOD source data: every tile also yields a per-column color map
    // (kept for the whole run — ~80 KB per tile), downsampled into the quadtree
    // pyramid after the main loop.
    var surf_colors = lowres.SurfaceColors.init(sa, resolver, &builder, maps, &reg);
    var color_maps = std.AutoHashMap(u64, *lowres.ColorMap).init(a);
    const tile_blocks: i64 = @as(i64, tile_chunks) * 16;

    const tiles_dir = try std.fmt.allocPrint(a, "{s}/tiles", .{out_dir});
    try std.Io.Dir.cwd().createDirPath(init.io, tiles_dir);

    const root = std.Progress.start(init.io, .{ .root_name = "vantage render" });
    defer root.end();
    const tiles_node = root.start("rendering tiles", tile_keys.len);

    const t0 = std.Io.Timestamp.now(init.io, .awake);

    // ---- parallel tile rendering --------------------------------------------
    // Workers pull tile indices from an atomic counter; each renders into its
    // own slot of `results`, so the manifest keeps its deterministic (z,x)
    // order no matter how tiles interleave. Peak memory is one tile's working
    // set per thread (each worker keeps a reusable arena).
    const cpu_count = std.Thread.getCpuCount() catch 4;
    const thread_count = @max(1, @min(parseThreads(args) orelse cpu_count, tile_keys.len));

    const results = try a.alloc(TileResult, tile_keys.len);
    for (results) |*r| r.* = .{};
    var next_tile = std.atomic.Value(usize).init(0);

    var ctx: RenderCtx = .{
        .io = init.io,
        .sa = sa,
        .loaded = loaded,
        .tile_keys = tile_keys,
        .tile_chunks = tile_chunks,
        .out_dir = out_dir,
        .quality = quality,
        .blend_biomes = blend_biomes,
        .cave_y = cave_y,
        .resolver = resolver,
        .builder = &builder,
        .maps = maps,
        .reg = &reg,
        .names = &names,
        .surf_colors = &surf_colors,
        .world_mutex = &world_mutex,
        .world_raw = &world_raw,
        .world_display = &world_display,
        .world_biome_ids = &world_biome_ids,
        .results = results,
        .next = &next_tile,
        .progress = tiles_node,
    };

    {
        var group: std.Io.Group = .init;
        for (0..thread_count - 1) |_| {
            // If a helper can't get a thread, the remaining workers cover it.
            group.concurrent(init.io, tileWorker, .{&ctx}) catch break;
        }
        tileWorker(&ctx); // the calling thread is worker 0
        group.await(init.io) catch |err| switch (err) {
            error.Canceled => unreachable, // nothing cancels the render
        };
    }
    tiles_node.end();

    // Merge per-tile results in key order (deterministic manifest).
    var stats: grid.Stats = .{};
    var total_solid_verts: u64 = 0;
    var total_fluid_verts: u64 = 0;
    var total_tris: u64 = 0;
    var total_bytes: u64 = 0;
    var total_raw_bytes: u64 = 0;
    var read_ms: i64 = 0;
    var light_ms: i64 = 0;
    var mesh_ms: i64 = 0;
    var write_ms: i64 = 0;
    for (results, tile_keys) |*r, key| {
        if (r.err) |e| {
            const tx: i32 = @bitCast(@as(u32, @truncate(key >> 32)));
            const tz: i32 = @bitCast(@as(u32, @truncate(key)));
            std.debug.print("tile ({d},{d}) failed: {s}\n", .{ tx, tz, @errorName(e) });
            return e;
        }
        stats.chunks_loaded += r.stats.chunks_loaded;
        stats.chunks_missing += r.stats.chunks_missing;
        read_ms += r.read_ms;
        light_ms += r.light_ms;
        mesh_ms += r.mesh_ms;
        write_ms += r.write_ms;
        if (!r.written) continue;
        try manifest_tiles.append(a, r.entry);
        if (r.cmap) |cm| try color_maps.put(key, cm);
        total_solid_verts += r.solid_verts;
        total_fluid_verts += r.fluid_verts;
        total_tris += r.tris;
        total_bytes += r.entry.bytes;
        total_raw_bytes += r.raw_bytes;
    }

    // ---- lowres LOD pyramid -------------------------------------------------
    // Downsample the per-tile color maps 2× per level until the world fits in
    // one tile. Every level ≥1 ships as gzipped VLR1 tiles; the viewer keeps
    // coarse levels resident far beyond the hires ring, so zooming out shows
    // the whole world instead of a fogged edge.
    const lod_node = root.start("lowres pyramid", 0);
    var lowres_levels: std.ArrayList(LowresLevel) = .empty;
    var lowres_count: usize = 0;
    var lowres_bytes: u64 = 0;
    {
        var cur = color_maps;
        var level: u5 = 1;
        // Stop once a level fits in ≤4 tiles: an origin-anchored quadtree never
        // merges tiles straddling (0,0), so "count == 1" may never come — the
        // 2×2 around the origin is the practical root.
        while (cur.count() > 4 and level <= 10) : (level += 1) {
            const lvl_blocks: i64 = tile_blocks << level;

            // Group this level's children under their parent tile (quadrants).
            var parents = std.AutoHashMap(u64, [2][2]?*const lowres.ColorMap).init(a);
            var it = cur.iterator();
            while (it.next()) |e| {
                const tx: i32 = @bitCast(@as(u32, @truncate(e.key_ptr.* >> 32)));
                const tz: i32 = @bitCast(@as(u32, @truncate(e.key_ptr.*)));
                const px = @divFloor(tx, 2);
                const pz = @divFloor(tz, 2);
                const qx: usize = @intCast(tx - px * 2);
                const qz: usize = @intCast(tz - pz * 2);
                const gop = try parents.getOrPut(world.packChunk(px, pz));
                if (!gop.found_existing) gop.value_ptr.* = .{ .{ null, null }, .{ null, null } };
                gop.value_ptr.*[qz][qx] = e.value_ptr.*;
            }

            var next = std.AutoHashMap(u64, *lowres.ColorMap).init(a);
            var par_it = parents.iterator();
            while (par_it.next()) |e| {
                const px: i32 = @bitCast(@as(u32, @truncate(e.key_ptr.* >> 32)));
                const pz: i32 = @bitCast(@as(u32, @truncate(e.key_ptr.*)));
                const m = try a.create(lowres.ColorMap);
                m.* = try lowres.downsample(
                    a,
                    e.value_ptr.*,
                    @intCast(@as(i64, px) * lvl_blocks),
                    @intCast(@as(i64, pz) * lvl_blocks),
                    @as(u32, 1) << level,
                );
                try next.put(e.key_ptr.*, m);
            }

            // Serialize with neighbour aprons (needs the whole level built).
            var keys: std.ArrayList(u64) = .empty;
            var kit = next.keyIterator();
            while (kit.next()) |k| try keys.append(a, k.*);
            std.mem.sort(u64, keys.items, {}, struct {
                fn lt(_: void, x: u64, y: u64) bool {
                    return x < y;
                }
            }.lt);
            var entries: std.ArrayList(LowresTileEntry) = .empty;
            for (keys.items) |k| {
                const px: i32 = @bitCast(@as(u32, @truncate(k >> 32)));
                const pz: i32 = @bitCast(@as(u32, @truncate(k)));
                const m = next.get(k).?;
                const blob = try lowres.serialize(
                    a,
                    m.*,
                    if (next.get(world.packChunk(px + 1, pz))) |p| p else null,
                    if (next.get(world.packChunk(px, pz + 1))) |p| p else null,
                    if (next.get(world.packChunk(px + 1, pz + 1))) |p| p else null,
                );
                const zipped = try compress.gzipCompress(a, blob, 6);
                const path = try std.fmt.allocPrint(a, "{s}/tiles/l{d}.{d}.{d}.vlr", .{ out_dir, level, px, pz });
                try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = path, .data = zipped });
                try entries.append(a, .{ .x = px, .z = pz, .bytes = zipped.len });
                lowres_count += 1;
                lowres_bytes += zipped.len;
            }
            try lowres_levels.append(a, .{
                .level = level,
                .tile_blocks = lvl_blocks,
                .span = @as(u32, 1) << level,
                .tiles = try entries.toOwnedSlice(a),
            });
            cur = next;
        }
    }
    lod_node.end();

    const tex_node = root.start("writing textures + manifest", 0);
    const arr = try builder.finish();
    const tex_blob = try compress.gzipCompress(a, try texture.serialize(a, arr), 6);
    const tex_path = try std.fmt.allocPrint(a, "{s}/terrain.vtexarr", .{out_dir});
    try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = tex_path, .data = tex_blob });

    const manifest = try buildManifest(a, .{
        .tile_chunks = tile_chunks,
        .spawn = spawn,
        .biomes = world_display.items,
        .tiles = manifest_tiles.items,
        .lowres = lowres_levels.items,
    });
    const manifest_path = try std.fmt.allocPrint(a, "{s}/manifest.json", .{out_dir});
    try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = manifest_path, .data = manifest });
    tex_node.end();
    const t_end = std.Io.Timestamp.now(init.io, .awake);

    std.debug.print(
        \\
        \\chunks:  {d} populated ({d} decodes incl. apron overlap)
        \\blocks:  {d} block states, {d} biomes
        \\tiles:   {d} written ({d:.1} MB gzipped, {d:.1} MB raw) + texture array ({d} layers)
        \\lowres:  {d} LOD tiles across {d} levels ({d:.1} MB)
        \\mesh:    {d} vertices, {d} triangles ({d} water verts)
        \\out:     {s}/manifest.json
        \\
        \\→ view it:  just serve   then open http://127.0.0.1:8753/   (first run: cd web && npm install)
        \\
    , .{
        bounds.count,
        stats.chunks_loaded,
        memo.count(),
        world_raw.items.len - 1,
        manifest_tiles.items.len,
        @as(f64, @floatFromInt(total_bytes)) / (1024.0 * 1024.0),
        @as(f64, @floatFromInt(total_raw_bytes)) / (1024.0 * 1024.0),
        arr.layer_count,
        lowres_count,
        lowres_levels.items.len,
        @as(f64, @floatFromInt(lowres_bytes)) / (1024.0 * 1024.0),
        total_solid_verts + total_fluid_verts,
        total_tris,
        total_fluid_verts,
        out_dir,
    });
    std.debug.print("timings: wall {d}ms on {d} thread(s) · cpu: read {d}ms · light {d}ms · geometry {d}ms · write {d}ms\n", .{
        t0.durationTo(t_end).toMilliseconds(), thread_count, read_ms, light_ms, mesh_ms, write_ms,
    });
}

/// Mutex-guarded view of a non-thread-safe allocator (the run arena), for
/// allocations that outlive one tile while tiles render on worker threads.
/// Everything still lives — and is freed — with the arena.
const LockedAllocator = struct {
    child: std.mem.Allocator,
    io: std.Io,
    mutex: std.Io.Mutex = .init,

    fn allocator(self: *LockedAllocator) std.mem.Allocator {
        return .{ .ptr = self, .vtable = &vtable };
    }

    const vtable: std.mem.Allocator.VTable = .{
        .alloc = alloc,
        .resize = resize,
        .remap = remap,
        .free = free,
    };

    fn alloc(ctx: *anyopaque, len: usize, alignment: std.mem.Alignment, ret_addr: usize) ?[*]u8 {
        const self: *LockedAllocator = @ptrCast(@alignCast(ctx));
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        return self.child.vtable.alloc(self.child.ptr, len, alignment, ret_addr);
    }
    fn resize(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ret_addr: usize) bool {
        const self: *LockedAllocator = @ptrCast(@alignCast(ctx));
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        return self.child.vtable.resize(self.child.ptr, memory, alignment, new_len, ret_addr);
    }
    fn remap(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ret_addr: usize) ?[*]u8 {
        const self: *LockedAllocator = @ptrCast(@alignCast(ctx));
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        return self.child.vtable.remap(self.child.ptr, memory, alignment, new_len, ret_addr);
    }
    fn free(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, ret_addr: usize) void {
        const self: *LockedAllocator = @ptrCast(@alignCast(ctx));
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        self.child.vtable.free(self.child.ptr, memory, alignment, ret_addr);
    }
};

/// Everything the tile workers share. Fields are either immutable for the
/// duration of the parallel section or guarded by the lock noted on their type
/// (resolver memo, texture builder, biome registry, surface-color memo) or by
/// `world_mutex` (the world-level biome table).
const RenderCtx = struct {
    io: std.Io,
    /// Locked view of the run arena — safe for cross-thread allocations.
    sa: std.mem.Allocator,
    loaded: []const world.LoadedRegion,
    tile_keys: []const u64,
    tile_chunks: i32,
    out_dir: []const u8,
    quality: mesh.LightQuality,
    blend_biomes: bool,
    cave_y: ?i32,
    resolver: model.Resolver,
    builder: *texture.Builder,
    maps: biome.Colormaps,
    reg: *biome.Registry,
    names: *const lang.Lang,
    surf_colors: *lowres.SurfaceColors,
    world_mutex: *std.Io.Mutex,
    world_raw: *std.ArrayList([]const u8),
    world_display: *std.ArrayList([]const u8),
    world_biome_ids: *std.StringHashMap(u16),
    results: []TileResult,
    next: *std.atomic.Value(usize),
    progress: std.Progress.Node,
};

/// One tile's outcome, written only by the worker that owns the slot.
const TileResult = struct {
    err: ?anyerror = null,
    /// False for empty tiles (nothing meshed) — skipped in the manifest.
    written: bool = false,
    entry: TileEntry = .{ .tx = 0, .tz = 0, .bytes = 0 },
    cmap: ?*lowres.ColorMap = null,
    solid_verts: u64 = 0,
    fluid_verts: u64 = 0,
    tris: u64 = 0,
    raw_bytes: u64 = 0,
    stats: grid.Stats = .{},
    read_ms: i64 = 0,
    light_ms: i64 = 0,
    mesh_ms: i64 = 0,
    write_ms: i64 = 0,
};

/// Worker loop: pull the next tile index, render it, repeat. Each worker keeps
/// one arena, reset (capacity retained) between tiles, so peak memory is one
/// tile's working set per thread.
fn tileWorker(ctx: *RenderCtx) void {
    var tile_arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer tile_arena.deinit();
    while (true) {
        const idx = ctx.next.fetchAdd(1, .monotonic);
        if (idx >= ctx.tile_keys.len) return;
        _ = tile_arena.reset(.retain_capacity);
        renderOneTile(ctx, tile_arena.allocator(), idx) catch |e| {
            ctx.results[idx].err = e;
        };
        ctx.progress.completeOne();
    }
}

/// Render tile `idx`: assemble its chunk window (+1 apron), remap biome ids
/// onto the world table, mesh, serialize, gzip, and write the `.vtile`.
fn renderOneTile(ctx: *RenderCtx, ta: std.mem.Allocator, idx: usize) !void {
    const res = &ctx.results[idx];
    const key = ctx.tile_keys[idx];
    const tile_chunks = ctx.tile_chunks;
    const tx: i32 = @bitCast(@as(u32, @truncate(key >> 32)));
    const tz: i32 = @bitCast(@as(u32, @truncate(key)));

    // Window = the tile's chunks plus a 1-chunk apron on every side.
    const cx0 = tx * tile_chunks - 1;
    const cz0 = tz * tile_chunks - 1;
    const cx1 = (tx + 1) * tile_chunks;
    const cz1 = (tz + 1) * tile_chunks;

    const t_r0 = std.Io.Timestamp.now(ctx.io, .awake);
    const g = try world.assembleWindow(ta, ctx.loaded, cx0, cz0, cx1, cz1, &res.stats, null);
    res.read_ms = t_r0.durationTo(std.Io.Timestamp.now(ctx.io, .awake)).toMilliseconds();
    if (g.ids.len == 0) return;

    // Remap this grid's interned biome ids onto the world-level table so every
    // tile's vertex biome ids agree (and one legend serves them all). The
    // snapshots taken under the lock are what this tile meshes/serializes
    // against — another worker may grow (and reallocate) the live table, but
    // every id this tile uses is below the snapshot's length.
    const remap = try ta.alloc(u16, g.biome_names.len);
    var raw_names: [][]const u8 = &.{};
    var display_names: [][]const u8 = &.{};
    {
        ctx.world_mutex.lockUncancelable(ctx.io);
        defer ctx.world_mutex.unlock(ctx.io);
        if (remap.len > 0) remap[0] = 0;
        for (g.biome_names[1..], 1..) |bn, gi| {
            const gop = try ctx.world_biome_ids.getOrPut(bn);
            if (!gop.found_existing) {
                const dup = try ctx.sa.dupe(u8, bn); // bn lives in the tile arena
                gop.key_ptr.* = dup;
                const id: u16 = @intCast(ctx.world_raw.items.len);
                try ctx.world_raw.append(ctx.sa, dup);
                try ctx.world_display.append(ctx.sa, ctx.names.biomeName(ctx.sa, dup));
                gop.value_ptr.* = id;
            }
            remap[gi] = gop.value_ptr.*;
        }
        raw_names = try ta.dupe([]const u8, ctx.world_raw.items);
        display_names = try ta.dupe([]const u8, ctx.world_display.items);
    }
    for (g.biome_ids) |*b| b.* = remap[b.*];
    var g2 = g;
    g2.biome_names = raw_names;

    // The tile's interior (its own chunks, apron excluded) in grid coords.
    const bx0 = @as(i64, tx) * tile_chunks * 16;
    const bz0 = @as(i64, tz) * tile_chunks * 16;
    const bx1 = bx0 + @as(i64, tile_chunks) * 16;
    const bz1 = bz0 + @as(i64, tile_chunks) * 16;
    const interior: grid.Interior = .{
        .x0 = @intCast(std.math.clamp(bx0 - g2.min_x, 0, @as(i64, @intCast(g2.sx)))),
        .z0 = @intCast(std.math.clamp(bz0 - g2.min_z, 0, @as(i64, @intCast(g2.sz)))),
        .x1 = @intCast(std.math.clamp(bx1 - g2.min_x, 0, @as(i64, @intCast(g2.sx)))),
        .z1 = @intCast(std.math.clamp(bz1 - g2.min_z, 0, @as(i64, @intCast(g2.sz)))),
    };
    if (interior.x0 >= interior.x1 or interior.z0 >= interior.z1) return;

    const t_m0 = std.Io.Timestamp.now(ctx.io, .awake);
    const built = try mesh.buildTextured(ta, g2, ctx.resolver, ctx.builder, ctx.maps, ctx.reg, ctx.quality, ctx.blend_biomes, interior, ctx.cave_y, null);
    res.light_ms = built.light_ms;
    res.mesh_ms = t_m0.durationTo(std.Io.Timestamp.now(ctx.io, .awake)).toMilliseconds() - built.light_ms;
    if (built.solid.vertex_count == 0 and built.fluid.vertex_count == 0) return;

    const surface = try grid.buildSurface(ta, g2, interior);
    const geo = try tile.serializeWithSurfaceQuantized(ta, built.solid, built.fluid, surface, display_names);

    // The tile's lowres source map (long-lived: feeds the pyramid later).
    const tile_blocks: i64 = @as(i64, tile_chunks) * 16;
    const cmap = try ctx.sa.create(lowres.ColorMap);
    cmap.* = try lowres.buildColorMap(ctx.sa, g2, interior, ctx.surf_colors, @intCast(bx0), @intCast(bz0), @intCast(tile_blocks));
    res.cmap = cmap;

    // Tiles ship gzip-wrapped (~8× smaller): any static host can serve
    // them and the viewer inflates via native DecompressionStream.
    const t_w0 = std.Io.Timestamp.now(ctx.io, .awake);
    const zipped = try compress.gzipCompress(ta, geo, 6);
    const tile_path = try std.fmt.allocPrint(ta, "{s}/tiles/t.{d}.{d}.vtile", .{ ctx.out_dir, tx, tz });
    try std.Io.Dir.cwd().writeFile(ctx.io, .{ .sub_path = tile_path, .data = zipped });
    res.write_ms = t_w0.durationTo(std.Io.Timestamp.now(ctx.io, .awake)).toMilliseconds();

    res.entry = .{ .tx = tx, .tz = tz, .bytes = zipped.len };
    res.solid_verts = built.solid.vertex_count;
    res.fluid_verts = built.fluid.vertex_count;
    res.tris = built.solid.triangleCount() + built.fluid.triangleCount();
    res.raw_bytes = geo.len;
    res.written = true;
}

/// One rendered tile's manifest record.
const TileEntry = struct { tx: i32, tz: i32, bytes: usize };

/// One lowres tile / one pyramid level, for the manifest's `lowres` section.
const LowresTileEntry = struct { x: i32, z: i32, bytes: usize };
const LowresLevel = struct {
    level: u5,
    tile_blocks: i64,
    span: u32,
    tiles: []const LowresTileEntry,
};

const ManifestInput = struct {
    tile_chunks: i32,
    spawn: ?[3]i32,
    /// Biome display names, id-indexed (index 0 = the "" no-data sentinel).
    biomes: []const []const u8,
    tiles: []const TileEntry,
    lowres: []const LowresLevel = &.{},
};

/// Serialize the world manifest — the small JSON the viewer streams tiles from.
/// Hand-rolled (the shape is tiny and fixed) to stay off the std.json churn.
fn buildManifest(a: std.mem.Allocator, m: ManifestInput) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.print(a, "{{\n  \"format\": 2,\n  \"tileChunks\": {d},\n  \"tileBlocks\": {d},\n  \"textures\": \"terrain.vtexarr\",\n", .{
        m.tile_chunks, m.tile_chunks * 16,
    });
    if (m.spawn) |s| try out.print(a, "  \"spawn\": {{ \"x\": {d}, \"y\": {d}, \"z\": {d} }},\n", .{ s[0], s[1], s[2] });
    try out.appendSlice(a, "  \"biomes\": [");
    for (m.biomes, 0..) |name, i| {
        if (i > 0) try out.appendSlice(a, ", ");
        try appendJsonString(a, &out, name);
    }
    try out.appendSlice(a, "],\n");
    if (m.lowres.len > 0) {
        try out.print(a, "  \"lowres\": {{\n    \"grid\": {d},\n    \"levels\": [\n", .{lowres.CELLS + 1});
        for (m.lowres, 0..) |lvl, li| {
            try out.print(a, "      {{ \"level\": {d}, \"tileBlocks\": {d}, \"span\": {d}, \"tiles\": [\n", .{
                lvl.level, lvl.tile_blocks, lvl.span,
            });
            for (lvl.tiles, 0..) |t, i| {
                try out.print(a, "        {{ \"x\": {d}, \"z\": {d}, \"path\": \"tiles/l{d}.{d}.{d}.vlr\", \"bytes\": {d} }}{s}\n", .{
                    t.x, t.z, lvl.level, t.x, t.z, t.bytes, if (i + 1 < lvl.tiles.len) "," else "",
                });
            }
            try out.print(a, "      ] }}{s}\n", .{if (li + 1 < m.lowres.len) "," else ""});
        }
        try out.appendSlice(a, "    ]\n  },\n");
    }
    try out.appendSlice(a, "  \"tiles\": [\n");
    for (m.tiles, 0..) |t, i| {
        try out.print(a, "    {{ \"x\": {d}, \"z\": {d}, \"path\": \"tiles/t.{d}.{d}.vtile\", \"bytes\": {d} }}{s}\n", .{
            t.tx, t.tz, t.tx, t.tz, t.bytes, if (i + 1 < m.tiles.len) "," else "",
        });
    }
    try out.appendSlice(a, "  ]\n}\n");
    return out.toOwnedSlice(a);
}

fn appendJsonString(a: std.mem.Allocator, out: *std.ArrayList(u8), s: []const u8) !void {
    try out.append(a, '"');
    for (s) |ch| switch (ch) {
        '"' => try out.appendSlice(a, "\\\""),
        '\\' => try out.appendSlice(a, "\\\\"),
        '\n' => try out.appendSlice(a, "\\n"),
        '\r' => try out.appendSlice(a, "\\r"),
        '\t' => try out.appendSlice(a, "\\t"),
        else => if (ch < 0x20) {
            try out.print(a, "\\u{x:0>4}", .{ch});
        } else {
            try out.append(a, ch);
        },
    };
    try out.append(a, '"');
}

/// Auto-detect an extracted `assets/minecraft` under `~/.cache/vantage/assets/<ver>/`,
/// preferring the highest-named version. Returns null if none is found.
fn findAssets(a: std.mem.Allocator, io: std.Io, home: []const u8) !?[]const u8 {
    if (home.len == 0) return null;
    const base = try std.fmt.allocPrint(a, "{s}/.cache/vantage/assets", .{home});
    var dir = std.Io.Dir.cwd().openDir(io, base, .{ .iterate = true }) catch return null;
    defer dir.close(io);
    var best_path: ?[]const u8 = null;
    var best_name: []const u8 = "";
    var it = dir.iterate();
    while (try it.next(io)) |e| {
        if (e.kind != .directory) continue;
        const candidate = try std.fmt.allocPrint(a, "{s}/{s}/assets/minecraft", .{ base, e.name });
        const bs = try std.fmt.allocPrint(a, "{s}/blockstates", .{candidate});
        if (!dirExists(io, bs)) continue;
        if (best_path == null or std.mem.lessThan(u8, best_name, e.name)) {
            best_path = candidate;
            best_name = try a.dupe(u8, e.name);
        }
    }
    return best_path;
}

fn dirExists(io: std.Io, path: []const u8) bool {
    var d = std.Io.Dir.cwd().openDir(io, path, .{}) catch return false;
    d.close(io);
    return true;
}

/// `foo.vtile` -> `foo.vtexarr`; otherwise append `.vtexarr`.
fn texArrayPath(a: std.mem.Allocator, out_path: []const u8) ![]u8 {
    const stem = if (std.mem.endsWith(u8, out_path, ".vtile"))
        out_path[0 .. out_path.len - ".vtile".len]
    else
        out_path;
    return std.fmt.allocPrint(a, "{s}.vtexarr", .{stem});
}

fn runHisto(init: std.process.Init, a: std.mem.Allocator, args: []const []const u8) !void {
    if (args.len < 1) return usage();
    const path = args[0];
    const lx: u5 = if (args.len > 1) @truncate(try std.fmt.parseInt(u8, args[1], 10)) else 0;
    const lz: u5 = if (args.len > 2) @truncate(try std.fmt.parseInt(u8, args[2], 10)) else 0;

    const bytes = try std.Io.Dir.cwd().readFileAlloc(init.io, path, a, .unlimited);
    std.debug.print("region file: {s} ({d} bytes)\n", .{ path, bytes.len });

    const reg = region.Region.fromBytes(bytes);
    const raw = (try reg.rawChunk(lx, lz)) orelse {
        std.debug.print("chunk ({d},{d}) is absent in this region\n", .{ lx, lz });
        return;
    };
    const chunk_nbt = try region.decompress(a, raw);
    var parser = nbt.Parser{ .buf = chunk_nbt, .arena = a };
    const root = try parser.parseRoot();
    const ch = try chunk.decode(a, root);

    std.debug.print("chunk ({d},{d}): DataVersion={d}, {d} sections\n", .{
        ch.x, ch.z, ch.data_version, ch.sections.len,
    });

    var hist = std.StringHashMap(u64).init(a);
    var total_nonair: u64 = 0;
    for (ch.sections) |s| {
        var by: u32 = 0;
        while (by < 16) : (by += 1) {
            var bz: u32 = 0;
            while (bz < 16) : (bz += 1) {
                var bx: u32 = 0;
                while (bx < 16) : (bx += 1) {
                    const name = s.names[s.paletteIndexAt(bx, by, bz)];
                    if (blocks.isAir(name)) continue;
                    total_nonair += 1;
                    try bump(&hist, name);
                }
            }
        }
    }

    std.debug.print("\nnon-air blocks: {d}\ndistinct types: {d}\n\ntop blocks:\n", .{
        total_nonair, hist.count(),
    });
    try printTop(a, &hist, 25);
}

/// Histogram of biome cells over a chunk range — verifies biome decode and
/// enumerates which biomes a region actually contains.
fn runBiomes(init: std.process.Init, a: std.mem.Allocator, args: []const []const u8) !void {
    if (args.len < 1) return usage();
    const path = args[0];
    var cx0: u5 = 0;
    var cz0: u5 = 0;
    var cx1: u5 = 0;
    var cz1: u5 = 0;
    if (args.len >= 5) {
        cx0 = @truncate(try std.fmt.parseInt(u8, args[1], 10));
        cz0 = @truncate(try std.fmt.parseInt(u8, args[2], 10));
        cx1 = @truncate(try std.fmt.parseInt(u8, args[3], 10));
        cz1 = @truncate(try std.fmt.parseInt(u8, args[4], 10));
    }

    const bytes = try std.Io.Dir.cwd().readFileAlloc(init.io, path, a, .unlimited);
    const reg = region.Region.fromBytes(bytes);

    var hist = std.StringHashMap(u64).init(a);
    var sections: u64 = 0;
    var cz: u32 = cz0;
    while (cz <= cz1) : (cz += 1) {
        var cx: u32 = cx0;
        while (cx <= cx1) : (cx += 1) {
            const raw = (try reg.rawChunk(@intCast(cx), @intCast(cz))) orelse continue;
            const chunk_nbt = try region.decompress(a, raw);
            var parser = nbt.Parser{ .buf = chunk_nbt, .arena = a };
            const root = try parser.parseRoot();
            const ch = try chunk.decode(a, root);
            for (ch.sections) |s| {
                if (s.biome_names.len == 0) continue;
                sections += 1;
                var cell: u32 = 0;
                while (cell < chunk.BIOME_CELLS) : (cell += 1) {
                    const idx = if (s.biome_indices.len == 0) 0 else s.biome_indices[cell];
                    try bump(&hist, s.biome_names[idx]);
                }
            }
        }
    }

    std.debug.print("biome cells over chunks ({d},{d})..({d},{d}): {d} sections, {d} distinct biomes\n\n", .{
        cx0, cz0, cx1, cz1, sections, hist.count(),
    });
    try printTop(a, &hist, 50);
}

fn bump(hist: *std.StringHashMap(u64), name: []const u8) !void {
    const gop = try hist.getOrPut(name);
    if (!gop.found_existing) gop.value_ptr.* = 0;
    gop.value_ptr.* += 1;
}

const Pair = struct { name: []const u8, count: u64 };

fn printTop(a: std.mem.Allocator, hist: *std.StringHashMap(u64), limit: usize) !void {
    const pairs = try a.alloc(Pair, hist.count());
    var it = hist.iterator();
    var k: usize = 0;
    while (it.next()) |e| : (k += 1) {
        pairs[k] = .{ .name = e.key_ptr.*, .count = e.value_ptr.* };
    }
    std.mem.sort(Pair, pairs, {}, struct {
        fn desc(_: void, x: Pair, y: Pair) bool {
            return x.count > y.count;
        }
    }.desc);
    for (pairs[0..@min(limit, pairs.len)]) |p| {
        std.debug.print("  {d:>9}  {s}\n", .{ p.count, p.name });
    }
}

// Pull unit tests from the modules into the default test run.
test {
    std.testing.refAllDecls(@This());
    _ = blocks;
    _ = chunk;
    _ = grid;
    _ = mesh;
    _ = tile;
    _ = model;
    _ = texture;
    _ = biome;
    _ = lang;
    _ = world;
}
