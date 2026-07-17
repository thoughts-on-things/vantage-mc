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
const extract = @import("extract.zig");
const serve = @import("serve.zig");
pub const discovery = @import("discovery.zig");
pub const version = @import("build_options").version;

pub fn main(init: std.process.Init) !void {
    const a = init.arena.allocator();
    const args = try init.minimal.args.toSlice(a);
    if (args.len < 2) return usage();

    // Dispatch. If args[1] is a known subcommand use it, else treat args[1] as a
    // region path for the legacy histogram form.
    if (std.mem.eql(u8, args[1], "--help") or std.mem.eql(u8, args[1], "-h") or std.mem.eql(u8, args[1], "help")) {
        printUsage();
        return;
    } else if (std.mem.eql(u8, args[1], "--version") or std.mem.eql(u8, args[1], "version")) {
        std.debug.print("vantage {s}\n", .{@import("build_options").version});
        return;
    } else if (std.mem.eql(u8, args[1], "render")) {
        return runRender(init, a, args[2..]);
    } else if (std.mem.eql(u8, args[1], "desktop-discover")) {
        return runDesktopDiscover(init, a);
    } else if (std.mem.eql(u8, args[1], "desktop-render")) {
        return runDesktopRender(init, a, args[2..]);
    } else if (std.mem.eql(u8, args[1], "serve")) {
        return runServe(init, a, args[2..]);
    } else if (std.mem.eql(u8, args[1], "live")) {
        return runLive(init, a, args[2..]);
    } else if (std.mem.eql(u8, args[1], "server")) {
        return runServer(init, a, args[2..]);
    } else if (std.mem.eql(u8, args[1], "extract")) {
        return runExtract(init, a, args[2..]);
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
    printUsage();
    return error.MissingArgument;
}

fn printUsage() void {
    std.debug.print(
        \\usage:
        \\  vantage render  <world-save-dir> [--assets <dir>] [--out <dir>] [--tile-chunks <n>]
        \\                  [--radius <chunks>] [--light flat|smooth] [--biome-blend on|off] [--caves full|<y>]
        \\                  [--threads <n>] [--memory <MiB>] [--gz <1..12>]
        \\      Render the whole populated world as streamable tiles + manifest.json
        \\      (default out: web/public). --radius caps to a window around spawn.
        \\      Missing assets are extracted automatically from your newest client jar.
        \\  vantage serve   [render-dir] [--port <n>] [--host <addr>] [--open]
        \\      View a render in your browser — a local web server with the viewer
        \\      built in (default dir: web/public, port: 8268). --open launches the
        \\      browser; --host 0.0.0.0 shares the map on your local network.
        \\  vantage live    <world-save-dir> [--out <dir>] [--tile-chunks <n>] [--radius <chunks>]
        \\                  [--light flat|smooth] [--biome-blend on|off] [--caves full|<y>]
        \\                  [--threads <n>] [--memory <MiB>] [--gz <1..12>] [--port <n>] [--host <addr>] [--open]
        \\      Open a world in the browser NOW — no full pre-render. Every tile is
        \\      listed up front and baked on demand as it scrolls into view, caching
        \\      into --out (default web/public) so panning back is instant.
        \\  vantage server  <world-save-dir> [live render flags] [--port <n>] [--host <addr>]
        \\                  [--token-env <name>] [--allow-origin <origin>] [--max-connections <n>]
        \\                  [--scan-interval <seconds>]
        \\      Run the hardened Vantage server data plane for launchers and web apps.
        \\      Binds to 127.0.0.1 by default for an authenticating reverse proxy.
        \\      Non-loopback binds require a >=32-byte bearer secret in the environment
        \\      (VANTAGE_SERVER_TOKEN by default). TLS belongs at the reverse proxy.
        \\  vantage extract [client.jar]
        \\      Extract the assets a render needs into ~/.cache/vantage/assets/<version>.
        \\      With no argument, uses the newest jar in your .minecraft/versions.
        \\  vantage mesh    <region.mca> <out.vtile> [cx0 cz0 cx1 cz1]
        \\  vantage meshtex <region.mca> <out.vtile> <assets/minecraft dir> [cx0 cz0 cx1 cz1] [--light flat|smooth] [--biome-blend on|off]
        \\  vantage histo   <region.mca> [localX localZ]
        \\  vantage biomes  <region.mca> [cx0 cz0 cx1 cz1]
        \\  vantage resolve <assets/minecraft dir> <block-name> [state e.g. axis=x]
        \\  vantage texinfo <assets/minecraft dir> <block-name...>
        \\
    , .{});
}

/// Line-delimited desktop protocol. Human CLI output remains unchanged; the
/// Tauri host filters only records carrying a `VANTAGE_` prefix.
fn runDesktopDiscover(init: std.process.Init, a: std.mem.Allocator) !void {
    const worlds = try discovery.discover(
        a,
        init.io,
        discovery.environmentFromProcess(init.environ_map),
        &.{},
    );
    for (worlds) |info| {
        var json: std.ArrayList(u8) = .empty;
        try json.appendSlice(a, "{\"path\":");
        try appendJsonString(a, &json, info.path);
        try json.appendSlice(a, ",\"name\":");
        try appendJsonString(a, &json, info.name);
        try json.print(a, ",\"lastPlayedMs\":{d},\"dataVersion\":{d},\"source\":", .{ info.last_played_ms, info.data_version });
        try appendJsonString(a, &json, @tagName(info.source));
        try json.appendSlice(a, ",\"iconPath\":");
        if (info.icon_path) |icon| try appendJsonString(a, &json, icon) else try json.appendSlice(a, "null");
        try json.append(a, '}');
        std.debug.print("VANTAGE_WORLD {s}\n", .{json.items});
    }
    std.debug.print("VANTAGE_DISCOVERY_DONE {{\"count\":{d}}}\n", .{worlds.len});
}

fn runDesktopRender(init: std.process.Init, a: std.mem.Allocator, args: []const []const u8) !void {
    if (args.len < 2) return usage();
    var progress: RenderProgress = .{
        .callback = emitDesktopProgress,
    };
    var render_args: std.ArrayList([]const u8) = .empty;
    try render_args.append(a, args[0]);
    try render_args.appendSlice(a, &.{ "--out", args[1] });
    try render_args.appendSlice(a, args[2..]);
    progress.setPhase(.scanning);
    renderWorldArgs(init, a, render_args.items, &progress) catch |err| {
        progress.setPhase(.failed);
        return err;
    };
    progress.setPhase(.done);
}

fn emitDesktopProgress(_: ?*anyopaque, snapshot: RenderProgress.Snapshot) void {
    std.debug.print(
        "VANTAGE_PROGRESS {{\"phase\":\"{s}\",\"completed\":{d},\"total\":{d}}}\n",
        .{ @tagName(snapshot.phase), snapshot.completed, snapshot.total },
    );
}

/// Scan args for `--light flat|smooth` (default `smooth`). The bake-time light
/// quality: `smooth` averages light over each vertex's neighbourhood, `flat`
/// lights per face. Tolerant of position — both meshtex and render accept it.
fn parseLightQuality(args: []const []const u8) error{InvalidArgument}!mesh.LightQuality {
    var i: usize = 0;
    while (i + 1 < args.len) : (i += 1) {
        if (!std.mem.eql(u8, args[i], "--light")) continue;
        if (std.mem.eql(u8, args[i + 1], "flat")) return .flat;
        if (std.mem.eql(u8, args[i + 1], "smooth")) return .smooth;
        return badValue("--light", args[i + 1], "flat|smooth");
    }
    return .smooth;
}

/// Scan args for `--caves full|<y>` (default `55`). Faces
/// below this world Y that only look into dark (sky-light-0) cells are culled —
/// they are invisible from any above-ground view and dominate tile size on
/// modern worlds. `full` keeps every cave: tiles grow, but the viewer's
/// depth-slice cave view has real geometry to reveal (the manifest gains
/// `"caves": true` so the UI knows to offer it). `off` is an alias of `full`
/// kept for old scripts.
fn parseCaveY(args: []const []const u8) error{InvalidArgument}!?i32 {
    var i: usize = 0;
    while (i + 1 < args.len) : (i += 1) {
        if (!std.mem.eql(u8, args[i], "--caves")) continue;
        if (std.mem.eql(u8, args[i + 1], "full") or std.mem.eql(u8, args[i + 1], "off")) return null;
        return std.fmt.parseInt(i32, args[i + 1], 10) catch badValue("--caves", args[i + 1], "full|<y>");
    }
    return 55;
}

/// Scan args for `--threads <n>`. Null means "not given" — the memory planner
/// chooses a safe value from the logical CPU count. `--threads 1` renders tiles
/// serially; the memory budget remains a hard upper bound on parallel bakes.
fn parseThreads(args: []const []const u8) error{InvalidArgument}!?usize {
    var i: usize = 0;
    while (i + 1 < args.len) : (i += 1) {
        if (!std.mem.eql(u8, args[i], "--threads")) continue;
        return std.fmt.parseInt(usize, args[i + 1], 10) catch badValue("--threads", args[i + 1], "<n>");
    }
    return null;
}

/// Scan args for `--memory <MiB>`. This bounds concurrent tile working sets,
/// not the process's small long-lived asset/index state. Null selects an
/// adaptive fraction of physical RAM; explicit values make container/host
/// policy predictable.
fn parseMemoryMiB(args: []const []const u8) error{InvalidArgument}!?usize {
    var i: usize = 0;
    while (i + 1 < args.len) : (i += 1) {
        if (!std.mem.eql(u8, args[i], "--memory")) continue;
        const mib = std.fmt.parseInt(usize, args[i + 1], 10) catch return badValue("--memory", args[i + 1], "64..");
        if (mib < 64) return badValue("--memory", args[i + 1], "64..");
        return mib;
    }
    return null;
}

const MiB: usize = 1024 * 1024;

/// Conservative peak for one tile arena. The dense id/light grid is three
/// bytes per voxel; NBT decode, lighting scratch, parallel mesh partials, the
/// final compact mesh, and compression temporarily coexist. Four dense-grid
/// equivalents plus fixed headroom tracks measured pathological/full-cave tiles while
/// still allowing useful parallelism for the default 8-chunk tile.
fn estimatedTileWorkingSet(tile_chunks: i32) usize {
    const edge: usize = @intCast((tile_chunks + 2) * 16); // one-chunk apron on each side
    const voxels = std.math.mul(usize, edge * edge, 384) catch return std.math.maxInt(usize);
    const dense_and_scratch = std.math.mul(usize, voxels, 14) catch return std.math.maxInt(usize);
    return std.math.add(usize, dense_and_scratch, 64 * MiB) catch std.math.maxInt(usize);
}

/// Default to one eighth of physical RAM, clamped so small hosts keep room for
/// the OS/viewer and large workstations do not turn every logical core into a
/// 150+ MiB tile arena. `--memory` overrides this capacity directly.
fn bakeMemoryBudget(explicit_mib: ?usize) usize {
    if (explicit_mib) |mib| return std.math.mul(usize, mib, MiB) catch std.math.maxInt(usize);
    const physical: usize = @intCast(@min(std.process.totalSystemMemory() catch 4 * 1024 * MiB, std.math.maxInt(usize)));
    return std.math.clamp(physical / 8, 512 * MiB, 1024 * MiB);
}

fn bakeWorkerCount(cpu_count: usize, work_items: usize, requested: ?usize, memory_bytes: usize, per_worker: usize) usize {
    const cpu_limit = @max(1, requested orelse cpu_count);
    const memory_limit = @max(1, memory_bytes / @max(1, per_worker));
    return @max(1, @min(@min(cpu_limit, memory_limit), @max(1, work_items)));
}

test "bake admission is bounded by memory, cpu, request, and work" {
    try std.testing.expectEqual(@as(usize, 4), bakeWorkerCount(16, 64, null, 800 * MiB, 200 * MiB));
    try std.testing.expectEqual(@as(usize, 2), bakeWorkerCount(16, 64, 2, 800 * MiB, 200 * MiB));
    try std.testing.expectEqual(@as(usize, 1), bakeWorkerCount(16, 1, null, 800 * MiB, 200 * MiB));
    try std.testing.expectEqual(@as(usize, 1), bakeWorkerCount(16, 64, null, 64 * MiB, 200 * MiB));
}

test "tile working-set estimate grows with tile area" {
    try std.testing.expect(estimatedTileWorkingSet(8) > estimatedTileWorkingSet(4));
    try std.testing.expect(estimatedTileWorkingSet(16) > estimatedTileWorkingSet(8));
}

/// Scan args for `--biome-blend on|off` (default `on`). When on, biome tint
/// colours (grass/foliage/water) are bilinearly blended across biome borders for
/// smooth vanilla-style gradients; off steps hard at each biome cell.
fn parseBiomeBlend(args: []const []const u8) error{InvalidArgument}!bool {
    var i: usize = 0;
    while (i + 1 < args.len) : (i += 1) {
        if (!std.mem.eql(u8, args[i], "--biome-blend")) continue;
        if (std.mem.eql(u8, args[i + 1], "off")) return false;
        if (std.mem.eql(u8, args[i + 1], "on")) return true;
        return badValue("--biome-blend", args[i + 1], "on|off");
    }
    return true;
}

fn badValue(flag: []const u8, got: []const u8, want: []const u8) error{InvalidArgument} {
    std.debug.print("invalid value for {s}: '{s}' (expected {s})\n", .{ flag, got, want });
    return error.InvalidArgument;
}

/// Consume and return the value following a `--flag` token, erroring if absent.
fn flagValue(args: []const []const u8, argi: *usize) error{MissingArgument}![]const u8 {
    argi.* += 1;
    if (argi.* >= args.len) {
        std.debug.print("missing value for {s}\n", .{args[argi.* - 1]});
        return error.MissingArgument;
    }
    return args[argi.*];
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
    const built = try mesh.buildTextured(a, g, resolver, &builder, maps, &reg, try parseLightQuality(args), try parseBiomeBlend(args), null, try parseCaveY(args), 0, null);
    const arr = try builder.finish();

    // Resolve human-readable biome names from the language file for the legend.
    const names = lang.Lang.load(a, init.io, assets);
    const display = try a.alloc([]const u8, g.biome_names.len);
    if (display.len > 0) display[0] = ""; // air/no-data sentinel
    for (g.biome_names[1..], 1..) |bn, i| display[i] = names.biomeName(a, bn);

    const surface = try grid.buildSurface(a, g, null);
    const geo = try tile.serializeWithLightmap(a, built, surface, display);
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
    while (p.len > 0 and (p[p.len - 1] == '/' or p[p.len - 1] == '\\')) p = p[0 .. p.len - 1];
    const suffix = "assets/minecraft";
    if (p.len < suffix.len) return "";
    // Separator-insensitive suffix match so native Windows paths work too.
    for (p[p.len - suffix.len ..], suffix) |c, s| {
        const norm: u8 = if (c == '\\') '/' else c;
        if (norm != s) return "";
    }
    return std.fmt.allocPrint(a, "{s}data/minecraft", .{p[0 .. p.len - suffix.len]}) catch "";
}

/// A world located and indexed: its region directory + extracted assets, the
/// region location tables (payloads stream per tile), the populated-chunk set,
/// spawn, and the centre chunk the `--radius` cap and spawn-outward order pivot
/// on. Shared by `render` (batch) and `live` (on-demand).
const WorldLoad = struct {
    region_dir: []const u8,
    assets: []const u8,
    loaded: []const world.LoadedRegion,
    bounds: world.ChunkBounds,
    populated: std.AutoHashMap(u64, void),
    spawn: ?[3]i32,
    centre_cx: i32,
    centre_cz: i32,
};

/// Locate a world's region dir + assets (auto-discovering/auto-extracting
/// assets when not passed) and index it — the setup `render` and `live` share.
/// Returns a `WorldLoad` with `bounds.count == 0` for an empty world; callers
/// decide how to report that.
fn resolveWorld(init: std.process.Init, a: std.mem.Allocator, save: []const u8, assets_opt: ?[]const u8) !WorldLoad {
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
    const assets = assets_opt orelse (try findAssets(a, init.io, home)) orelse
        (try autoExtract(init, a, home)) orelse {
        std.debug.print(
            \\no extracted assets found, and no Minecraft installation to extract from.
            \\Point `vantage extract` at any client jar first:
            \\  vantage extract <path/to/client.jar>    (or pass --assets <assets/minecraft dir>)
            \\
        , .{});
        return error.NoAssets;
    };

    std.debug.print("world:   {s}\nassets:  {s}\n", .{ region_dir, assets });

    const loaded = try world.loadRegions(a, init.io, region_dir);
    const bounds = world.populatedBounds(loaded);
    const populated = if (bounds.count == 0)
        std.AutoHashMap(u64, void).init(a)
    else
        try world.populatedChunks(a, loaded);
    const spawn = world.readSpawn(a, init.io, save);

    // The optional --radius cap and spawn-outward order centre on the spawn
    // point when known (that's where the interesting builds are), else the
    // populated centre.
    const centre_cx: i32 = if (spawn) |s| @divFloor(s[0], 16) else @divFloor(bounds.min_cx + bounds.max_cx, 2);
    const centre_cz: i32 = if (spawn) |s| @divFloor(s[2], 16) else @divFloor(bounds.min_cz + bounds.max_cz, 2);

    return .{
        .region_dir = region_dir,
        .assets = assets,
        .loaded = loaded,
        .bounds = bounds,
        .populated = populated,
        .spawn = spawn,
        .centre_cx = centre_cx,
        .centre_cz = centre_cz,
    };
}

/// The tiles containing at least one populated chunk (within `--radius` of the
/// centre, if set), sorted spawn-outward: nearest-to-centre first so a
/// progressive/on-demand view blooms from where the builds are. Ties break on
/// (z, x) for a deterministic order.
fn enumerateTilesSpawnOutward(
    a: std.mem.Allocator,
    populated: std.AutoHashMap(u64, void),
    radius: i32,
    centre_cx: i32,
    centre_cz: i32,
    tile_chunks: i32,
) ![]u64 {
    var tile_set = std.AutoHashMap(u64, void).init(a);
    var pit = populated.keyIterator();
    while (pit.next()) |key| {
        const cx: i32 = @bitCast(@as(u32, @truncate(key.* >> 32)));
        const cz: i32 = @bitCast(@as(u32, @truncate(key.*)));
        if (radius > 0 and (@abs(cx - centre_cx) > radius or @abs(cz - centre_cz) > radius)) continue;
        try tile_set.put(world.packChunk(@divFloor(cx, tile_chunks), @divFloor(cz, tile_chunks)), {});
    }
    var list: std.ArrayList(u64) = .empty;
    var tit = tile_set.keyIterator();
    while (tit.next()) |k| try list.append(a, k.*);
    const keys = list.items;

    const centre_tx = @divFloor(centre_cx, tile_chunks);
    const centre_tz = @divFloor(centre_cz, tile_chunks);
    const SortCtx = struct { tx: i32, tz: i32 };
    std.mem.sort(u64, keys, SortCtx{ .tx = centre_tx, .tz = centre_tz }, struct {
        fn lt(c: SortCtx, x: u64, y: u64) bool {
            const xx: i32 = @bitCast(@as(u32, @truncate(x >> 32)));
            const xz: i32 = @bitCast(@as(u32, @truncate(x)));
            const yx: i32 = @bitCast(@as(u32, @truncate(y >> 32)));
            const yz: i32 = @bitCast(@as(u32, @truncate(y)));
            const dx1: i64 = xx - c.tx;
            const dz1: i64 = xz - c.tz;
            const dx2: i64 = yx - c.tx;
            const dz2: i64 = yz - c.tz;
            const d1 = dx1 * dx1 + dz1 * dz1;
            const d2 = dx2 * dx2 + dz2 * dz2;
            if (d1 != d2) return d1 < d2;
            if (xz != yz) return xz < yz;
            return xx < yx;
        }
    }.lt);
    return keys;
}

/// `vantage render <save-dir>` — the friendly entry point: auto-discover the
/// world's region directory and the extracted assets, then render the WHOLE
/// populated world as a grid of streamable tiles + a manifest. Each tile
/// spans `--tile-chunks`² chunks and is meshed with a 1-chunk apron of
/// neighbour data, so culling, AO, light (range 15 < 16-block apron), and
/// biome blending are seam-free across tile borders.
pub const RenderPhase = enum(u8) {
    idle,
    scanning,
    tiles,
    lowres,
    finalizing,
    done,
    failed,
};

pub const RenderProgress = struct {
    phase: std.atomic.Value(u8) = .init(@intFromEnum(RenderPhase.idle)),
    completed: std.atomic.Value(usize) = .init(0),
    total: std.atomic.Value(usize) = .init(0),
    callback: ?*const fn (?*anyopaque, Snapshot) void = null,
    callback_context: ?*anyopaque = null,

    pub const Snapshot = struct {
        phase: RenderPhase,
        completed: usize,
        total: usize,

        pub fn fraction(self: Snapshot) f32 {
            if (self.total == 0) return 0;
            return @as(f32, @floatFromInt(self.completed)) / @as(f32, @floatFromInt(self.total));
        }
    };

    pub fn snapshot(self: *const RenderProgress) Snapshot {
        return .{
            .phase = @enumFromInt(self.phase.load(.acquire)),
            .completed = self.completed.load(.acquire),
            .total = self.total.load(.acquire),
        };
    }

    fn setPhase(self: *RenderProgress, phase: RenderPhase) void {
        self.phase.store(@intFromEnum(phase), .release);
        self.notify();
    }

    fn beginTiles(self: *RenderProgress, total: usize) void {
        self.completed.store(0, .release);
        self.total.store(total, .release);
        self.setPhase(.tiles);
    }

    fn setCompleted(self: *RenderProgress, completed: usize) void {
        self.completed.store(completed, .release);
        self.notify();
    }

    fn notify(self: *RenderProgress) void {
        if (self.callback) |callback| callback(self.callback_context, self.snapshot());
    }
};

pub const RenderOptions = struct {
    save_dir: []const u8,
    out_dir: []const u8,
    full_caves: bool = false,
};

/// Typed, in-process render entry point shared by the desktop app and future
/// embedders. The CLI remains an argument adapter around the same implementation.
pub fn renderWorld(
    init: std.process.Init,
    a: std.mem.Allocator,
    options: RenderOptions,
    progress: *RenderProgress,
) !void {
    var args: [5][]const u8 = undefined;
    var len: usize = 0;
    args[len] = options.save_dir;
    len += 1;
    args[len] = "--out";
    len += 1;
    args[len] = options.out_dir;
    len += 1;
    if (options.full_caves) {
        args[len] = "--caves";
        len += 1;
        args[len] = "full";
        len += 1;
    }
    progress.setPhase(.scanning);
    renderWorldArgs(init, a, args[0..len], progress) catch |err| {
        progress.setPhase(.failed);
        return err;
    };
    progress.setPhase(.done);
}

pub fn runRender(init: std.process.Init, a: std.mem.Allocator, args: []const []const u8) !void {
    return renderWorldArgs(init, a, args, null);
}

fn renderWorldArgs(
    init: std.process.Init,
    a: std.mem.Allocator,
    args: []const []const u8,
    observer: ?*RenderProgress,
) !void {
    if (args.len < 1) return usage();
    const save = args[0];
    var assets_opt: ?[]const u8 = null;
    var out_dir: []const u8 = "web/public";
    var tile_chunks: i32 = 8; // tile span in chunks (128×128 blocks)
    var radius: i32 = 0; // optional cap: only tiles within ±radius chunks of spawn/centre (0 = whole world)
    // Level 7 is the measured Pareto point for quantized tiles: much less CPU
    // than 9 for only a small payload increase. Users can still choose 1..12.
    var gz_level: i32 = 7;
    const quality = try parseLightQuality(args);
    const blend_biomes = try parseBiomeBlend(args);
    const cave_y = try parseCaveY(args);
    const requested_threads = try parseThreads(args);
    const memory_budget = bakeMemoryBudget(try parseMemoryMiB(args));
    var argi: usize = 1;
    while (argi < args.len) : (argi += 1) {
        const arg = args[argi];
        if (std.mem.eql(u8, arg, "--assets")) {
            assets_opt = try flagValue(args, &argi);
        } else if (std.mem.eql(u8, arg, "--out")) {
            out_dir = try flagValue(args, &argi);
        } else if (std.mem.eql(u8, arg, "--tile-chunks")) {
            const v = try flagValue(args, &argi);
            const n = std.fmt.parseInt(i32, v, 10) catch return badValue("--tile-chunks", v, "1..32");
            tile_chunks = std.math.clamp(n, 1, 32);
        } else if (std.mem.eql(u8, arg, "--radius")) {
            const v = try flagValue(args, &argi);
            radius = std.fmt.parseInt(i32, v, 10) catch return badValue("--radius", v, "<chunks>");
        } else if (std.mem.eql(u8, arg, "--gz")) {
            const v = try flagValue(args, &argi);
            const n = std.fmt.parseInt(i32, v, 10) catch return badValue("--gz", v, "1..12");
            gz_level = std.math.clamp(n, 1, 12);
        } else if (std.mem.eql(u8, arg, "--light") or std.mem.eql(u8, arg, "--biome-blend") or
            std.mem.eql(u8, arg, "--caves") or std.mem.eql(u8, arg, "--threads") or std.mem.eql(u8, arg, "--memory"))
        {
            // Parsed by their dedicated scanners above; skip the value here.
            argi += 1;
        } else if (std.mem.startsWith(u8, arg, "-")) {
            std.debug.print("unknown flag for render: {s} (see `vantage --help`)\n", .{arg});
            return error.InvalidArgument;
        }
    }

    const wl = try resolveWorld(init, a, save, assets_opt);
    if (wl.bounds.count == 0) {
        std.debug.print("no populated chunks found.\n", .{});
        return;
    }
    const loaded = wl.loaded;
    const bounds = wl.bounds;
    const spawn = wl.spawn;
    const assets = wl.assets;

    // The tiles that contain at least one populated chunk, sorted spawn-outward.
    // Sparse worlds (exploration trails across hundreds of regions) stay
    // proportional to what exists, not to the bounding box.
    const tile_keys = try enumerateTilesSpawnOutward(a, wl.populated, radius, wl.centre_cx, wl.centre_cz, tile_chunks);

    std.debug.print("regions: {d} files · {d} populated chunks · extent {d}×{d} chunks · {d} tiles of {d}×{d} chunks\n", .{
        loaded.len,    bounds.count, bounds.spanX(), bounds.spanZ(),
        tile_keys.len, tile_chunks,  tile_chunks,
    });
    if (observer) |p| {
        p.beginTiles(tile_keys.len);
    }

    // ---- parallel tile rendering --------------------------------------------
    // Workers pull tile indices from an atomic counter; each renders into its
    // own slot of `results`, so the manifest keeps its deterministic (z,x)
    // order no matter how tiles interleave. Peak memory is one tile's working
    // set per thread (each worker keeps a reusable arena).
    const cpu_count = std.Thread.getCpuCount() catch 4;
    const worker_bytes = estimatedTileWorkingSet(tile_chunks);
    const thread_count = bakeWorkerCount(cpu_count, tile_keys.len, requested_threads, memory_budget, worker_bytes);
    std.debug.print("bakes:   {d} concurrent · {d} MiB budget · ~{d} MiB/worker\n", .{
        thread_count,
        memory_budget / MiB,
        worker_bytes / MiB,
    });

    const tiles_dir = try std.fmt.allocPrint(a, "{s}/tiles", .{out_dir});
    try std.Io.Dir.cwd().createDirPath(init.io, tiles_dir);

    // Lowres source maps are external-memory checkpoints. Keeping one ~80 KiB
    // map per tile in the run arena made a 24k-tile world retain ~1.9 GiB before
    // its pyramid even began. Workers now spill them here and the level builder
    // reads only one parent group/neighbour apron at a time.
    const lod_cache_dir = try std.fmt.allocPrint(a, "{s}/.vantage-lod", .{out_dir});
    std.Io.Dir.cwd().deleteTree(init.io, lod_cache_dir) catch {};
    try std.Io.Dir.cwd().createDirPath(init.io, lod_cache_dir);
    defer std.Io.Dir.cwd().deleteTree(init.io, lod_cache_dir) catch {};

    // Long-lived shared bake state (resolver + memo, atlas, biome
    // registry/colormaps/lang, world biome table). When tiles already run in
    // parallel each tile meshes single-threaded; a one-worker render lets each
    // tile use every core.
    const sh = try setupShared(init.io, a, assets, loaded, .{
        .tile_chunks = tile_chunks,
        .out_dir = out_dir,
        .quality = quality,
        .blend_biomes = blend_biomes,
        .cave_y = cave_y,
        .gz_level = gz_level,
        .mesh_threads = if (thread_count > 1) 1 else 0,
        .lod_cache_dir = lod_cache_dir,
    });

    var manifest_tiles: std.ArrayList(TileEntry) = .empty;
    const tile_blocks: i64 = @as(i64, tile_chunks) * 16;

    const root = std.Progress.start(init.io, .{ .root_name = "vantage render" });
    defer root.end();
    const tiles_node = root.start("rendering tiles", tile_keys.len);

    const t0 = std.Io.Timestamp.now(init.io, .awake);

    const results = try a.alloc(TileResult, tile_keys.len);
    for (results) |*r| r.* = .{};
    var next_tile = std.atomic.Value(usize).init(0);
    var done_tiles = std.atomic.Value(usize).init(0);

    // std.Progress paints its live bar only on a TTY. When stderr is piped —
    // CI, or a supervisor like beacon tailing the process — emit plain
    // `rendering tiles [done/total]` lines instead (throttled to ~1% steps)
    // so the wrapper can surface real progress.
    const plain_progress = !(std.Io.File.stderr().isTty(init.io) catch false);

    var live: Live = .{};

    var ctx: RenderCtx = .{
        .shared = sh,
        .tile_keys = tile_keys,
        .results = results,
        .next = &next_tile,
        .done = &done_tiles,
        .live = &live,
        .plain_progress = plain_progress,
        .progress = tiles_node,
        .observer = observer,
    };

    // Progressive render: a background thread republishes manifest.json (and the
    // atlas, when it grows) as tiles land, so `vantage serve` shows the world
    // streaming in live instead of only after the whole bake finishes.
    var flush_ctx: FlushCtx = .{
        .io = init.io,
        .out_dir = out_dir,
        .live = &live,
        .builder = &sh.builder,
        .world_mutex = &sh.world_mutex,
        .world_display = &sh.world_display,
        .done = &done_tiles,
        .total = tile_keys.len,
        .spawn = spawn,
        .tile_chunks = tile_chunks,
        .cave_y = cave_y,
    };
    const flush_thread: ?std.Thread = std.Thread.spawn(.{}, flushWorker, .{&flush_ctx}) catch null;

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
    // Stop the progressive flusher before the final manifest write below takes over.
    if (flush_thread) |t| {
        flush_ctx.stop.store(true, .release);
        t.join();
    }
    tiles_node.end();
    if (observer) |p| p.setPhase(.lowres);

    // Merge per-tile results in key order (deterministic manifest).
    var stats: grid.Stats = .{};
    var total_solid_verts: u64 = 0;
    var total_fluid_verts: u64 = 0;
    var max_section_verts: u64 = 0;
    var world_y_min: i32 = std.math.maxInt(i32);
    var world_y_max: i32 = std.math.minInt(i32);
    var total_tris: u64 = 0;
    var total_bytes: u64 = 0;
    var total_raw_bytes: u64 = 0;
    var read_ms: i64 = 0;
    var light_ms: i64 = 0;
    var mesh_ms: i64 = 0;
    var write_ms: i64 = 0;
    var tiles_failed: usize = 0;
    var first_tile_err: ?anyerror = null;
    for (results, tile_keys) |*r, key| {
        if (r.err) |e| {
            // One bad tile (a corrupt region, a decode blow-up) must not
            // take down the whole map — render everything else and say so.
            const tx: i32 = @bitCast(@as(u32, @truncate(key >> 32)));
            const tz: i32 = @bitCast(@as(u32, @truncate(key)));
            std.debug.print("tile ({d},{d}) failed: {s}\n", .{ tx, tz, @errorName(e) });
            tiles_failed += 1;
            if (first_tile_err == null) first_tile_err = e;
            continue;
        }
        stats.chunks_loaded += r.stats.chunks_loaded;
        stats.chunks_missing += r.stats.chunks_missing;
        stats.chunks_premodern += r.stats.chunks_premodern;
        stats.chunks_unreadable += r.stats.chunks_unreadable;
        read_ms += r.read_ms;
        light_ms += r.light_ms;
        mesh_ms += r.mesh_ms;
        write_ms += r.write_ms;
        if (!r.written) continue;
        try manifest_tiles.append(a, r.entry);
        total_solid_verts += r.solid_verts;
        total_fluid_verts += r.fluid_verts;
        max_section_verts = @max(max_section_verts, @max(r.solid_verts, r.fluid_verts));
        world_y_min = @min(world_y_min, r.y_min);
        world_y_max = @max(world_y_max, r.y_max);
        total_tris += r.tris;
        total_bytes += r.entry.bytes;
        total_raw_bytes += r.raw_bytes;
    }

    // Every tile failing means something systemic (not one corrupt spot) —
    // surface the first error instead of shipping an empty manifest that
    // would wipe the previous render.
    if (tiles_failed > 0 and tiles_failed == tile_keys.len) return first_tile_err.?;
    if (tiles_failed > 0) std.debug.print(
        "  note: {d} tile(s) failed and were skipped — the map has gaps there (details above)\n",
        .{tiles_failed},
    );

    // A world saved before 1.18 stores chunks in the legacy `Level` layout and
    // decodes to nothing — explain that instead of writing an empty map.
    if (stats.chunks_loaded == 0 and stats.chunks_premodern > 0) {
        std.debug.print(
            \\this world's chunks use the pre-1.18 format, which vantage can't read.
            \\Open and save it in Minecraft 1.18+ (which upgrades the chunks), then re-run.
            \\
        , .{});
        return error.WorldTooOld;
    }
    if (stats.chunks_premodern > 0) std.debug.print(
        "  note: {d} chunk(s) still in the pre-1.18 format were skipped\n",
        .{stats.chunks_premodern},
    );
    if (stats.chunks_unreadable > 0) std.debug.print(
        "  note: {d} chunk(s) skipped: lz4-compressed or external .mcc chunks are not supported yet\n",
        .{stats.chunks_unreadable},
    );

    // ---- lowres LOD pyramid -------------------------------------------------
    // Downsample the per-tile color maps 2× per level until the world fits in
    // one tile. Every level ≥1 ships as gzipped VLR1 tiles; the viewer keeps
    // coarse levels resident far beyond the hires ring, so zooming out shows
    // the whole world instead of a fogged edge.
    const lod_node = root.start("lowres pyramid", 0);
    const pyramid = try buildLowresPyramid(a, init.io, out_dir, lod_cache_dir, manifest_tiles.items, tile_blocks);
    const lowres_levels = pyramid.levels;
    const lowres_count = pyramid.count;
    const lowres_bytes = pyramid.bytes;
    lod_node.end();

    if (observer) |p| p.setPhase(.finalizing);
    const tex_node = root.start("writing textures + manifest", 0);
    const arr = try sh.builder.finish();
    // Atomic (temp + rename) like the progressive flusher: a browser still
    // polling as the render finishes never reads a half-rewritten atlas/manifest.
    try writeAtlas(init.io, a, out_dir, arr);

    const manifest = try buildManifest(a, .{
        .tile_chunks = tile_chunks,
        .spawn = spawn,
        .biomes = sh.world_display.items,
        .tiles = manifest_tiles.items,
        .lowres = lowres_levels,
        .max_section_verts = max_section_verts,
        .caves = cave_y == null,
        .y_range = if (world_y_min < world_y_max) .{ world_y_min, world_y_max } else null,
        .texture_layers = arr.layer_count,
    });
    try atomicWrite(init.io, a, out_dir, "manifest.json", manifest);
    // Re-rendering onto an existing output dir can leave tiles from a previous
    // bake behind; now that the manifest is written, sweep anything tile-shaped
    // it doesn't reference.
    const stale_removed = sweepStaleTiles(a, init.io, out_dir, manifest_tiles.items, lowres_levels);
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
        \\→ view it:  vantage serve {s} --open
        \\
    , .{
        bounds.count,
        stats.chunks_loaded,
        sh.memo.count(),
        sh.world_raw.items.len - 1,
        manifest_tiles.items.len,
        @as(f64, @floatFromInt(total_bytes)) / (1024.0 * 1024.0),
        @as(f64, @floatFromInt(total_raw_bytes)) / (1024.0 * 1024.0),
        arr.layer_count,
        lowres_count,
        lowres_levels.len,
        @as(f64, @floatFromInt(lowres_bytes)) / (1024.0 * 1024.0),
        total_solid_verts + total_fluid_verts,
        total_tris,
        total_fluid_verts,
        out_dir,
        out_dir,
    });
    if (stale_removed > 0) std.debug.print("cleanup: removed {d} stale tile file(s) from a previous render\n", .{stale_removed});
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

/// Shared, mutex-guarded record of finished tiles — appended by each worker as
/// it writes a `.vtile`, drained by the progressive flusher into a live manifest
/// while the rest are still meshing. Tiles, biome ids and atlas layers are all
/// append-only, so a snapshot taken mid-render is always internally consistent:
/// every listed tile only references legend/atlas entries that already exist.
const Live = struct {
    mutex: std.Io.Mutex = .init,
    completed: std.ArrayList(TileEntry) = .empty,
    max_section_verts: u64 = 0,
    y_min: i32 = std.math.maxInt(i32),
    y_max: i32 = std.math.minInt(i32),
};

/// Inputs to the background flusher thread that publishes progressive manifests.
const FlushCtx = struct {
    io: std.Io,
    out_dir: []const u8,
    live: *Live,
    builder: *texture.Builder,
    world_mutex: *std.Io.Mutex,
    world_display: *std.ArrayList([]const u8),
    done: *std.atomic.Value(usize),
    total: usize,
    spawn: ?[3]i32,
    tile_chunks: i32,
    cave_y: ?i32,
    /// Atlas layers last written to disk — the atlas is re-serialized only when
    /// it grows past this (layers are append-only, so it's always a superset).
    last_layers: u32 = 0,
    /// Tiles in the last published manifest — a flush with no new tiles and no
    /// atlas growth is skipped, so the final stretch of a big render doesn't
    /// re-serialize an unchanged multi-MB manifest every tick.
    last_tiles: usize = 0,
    stop: std.atomic.Value(bool) = .init(false),
};

/// Poll the shared `Live` state every ~400 ms and publish a manifest of the
/// tiles finished so far, re-writing the texture atlas whenever it has grown, so
/// a browser pointed at `vantage serve` watches the world stream in tile by tile.
fn flushWorker(fc: *FlushCtx) void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    while (!fc.stop.load(.acquire)) {
        std.Io.sleep(fc.io, std.Io.Duration.fromMilliseconds(400), .awake) catch {};
        _ = arena.reset(.retain_capacity);
        flushOnce(fc, arena.allocator()) catch {}; // a dropped flush retries next tick
    }
}

/// Publish one progressive manifest (+ atlas, if it grew) — the mid-render
/// snapshot the browser polls. Any allocation failure just drops this tick; the
/// next one retries. The final, authoritative manifest is written by the caller
/// once the workers join.
fn flushOnce(fc: *FlushCtx, a: std.mem.Allocator) !void {
    fc.live.mutex.lockUncancelable(fc.io);
    const tiles = a.dupe(TileEntry, fc.live.completed.items) catch |e| {
        fc.live.mutex.unlock(fc.io); // never propagate an error while holding the lock
        return e;
    };
    const msv = fc.live.max_section_verts;
    const ymin = fc.live.y_min;
    const ymax = fc.live.y_max;
    fc.live.mutex.unlock(fc.io);

    // Skip when there's nothing new to show: no tiles yet, or neither the tile
    // list nor the atlas has grown since the last publish.
    const atlas_grew = fc.builder.layerCount() > fc.last_layers;
    if (tiles.len == 0 or (tiles.len == fc.last_tiles and !atlas_grew)) return;

    // Atlas: re-serialize only when it grew. Written before the manifest that
    // references the new tiles, so the atlas is never behind the tile list.
    if (atlas_grew) {
        fc.builder.mutex.lockUncancelable(fc.io);
        const arr = fc.builder.finishAlloc(a) catch |e| {
            fc.builder.mutex.unlock(fc.io);
            return e;
        };
        fc.builder.mutex.unlock(fc.io);
        try writeAtlas(fc.io, a, fc.out_dir, arr);
        fc.last_layers = arr.layer_count;
    }

    fc.world_mutex.lockUncancelable(fc.io);
    const biomes = a.dupe([]const u8, fc.world_display.items) catch |e| {
        fc.world_mutex.unlock(fc.io);
        return e;
    };
    fc.world_mutex.unlock(fc.io);

    const manifest = try buildManifest(a, .{
        .tile_chunks = fc.tile_chunks,
        .spawn = fc.spawn,
        .biomes = biomes,
        .tiles = tiles,
        .max_section_verts = msv,
        .caves = fc.cave_y == null,
        .y_range = if (ymin < ymax) .{ ymin, ymax } else null,
        .rendering = true,
        .progress = .{ fc.done.load(.monotonic), fc.total },
        .texture_layers = fc.last_layers,
    });
    try atomicWrite(fc.io, a, fc.out_dir, "manifest.json", manifest);
    fc.last_tiles = tiles.len;
}

/// Write `dir/name` by writing a temp file and renaming over it, so a browser
/// polling the file never reads a half-written manifest or atlas.
fn atomicWrite(io: std.Io, a: std.mem.Allocator, dir: []const u8, name: []const u8, data: []const u8) !void {
    const tmp = try std.fmt.allocPrint(a, "{s}/.{s}.tmp", .{ dir, name });
    const final = try std.fmt.allocPrint(a, "{s}/{s}", .{ dir, name });
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = tmp, .data = data });
    try std.Io.Dir.cwd().rename(tmp, std.Io.Dir.cwd(), final, io);
}

/// Serialize + gzip the texture array and write it atomically to
/// `dir/terrain.vtexarr` (the progressive flusher's superset flush and the final
/// write share this).
fn writeAtlas(io: std.Io, a: std.mem.Allocator, dir: []const u8, arr: texture.Array) !void {
    const blob = try compress.gzipCompress(a, try texture.serialize(a, arr), 6);
    try atomicWrite(io, a, dir, "terrain.vtexarr", blob);
}

/// Long-lived, thread-safe state shared by every tile bake — built once by
/// `setupShared`, then used by BOTH the batch `render` command and the
/// on-demand `live` server. It owns the caches whose addresses the bake path
/// captures (resolver memo, texture atlas, biome registry, world biome table),
/// so it lives on the heap and travels as a single `*Shared`: pointers into it
/// stay valid for the process lifetime. Concurrent bakes are safe — every
/// mutating cache takes its own lock (the atlas/registry/resolver) or the
/// `world_mutex` (the world-level biome table), and `sa` is a locked view of
/// the run arena.
const Shared = struct {
    io: std.Io,
    /// The run arena (single-threaded); `sa` is its locked, thread-safe view.
    base: std.mem.Allocator,
    sa: std.mem.Allocator = undefined,
    loaded: []const world.LoadedRegion,
    tile_chunks: i32,
    out_dir: []const u8,
    quality: mesh.LightQuality,
    blend_biomes: bool,
    cave_y: ?i32,
    gz_level: i32,
    /// Batch-only external-memory checkpoints for the lowres pyramid. Null for
    /// live bakes, which do not build/retain color maps.
    lod_cache_dir: ?[]const u8,
    /// Thread budget for each tile's internal mesh pass: 1 when tiles already
    /// run in parallel, 0 (= all cores) for a single-worker bake.
    mesh_threads: usize,

    locked: LockedAllocator = undefined,
    resolver_lock: std.Io.Mutex = .init,
    memo: std.StringHashMap([]model.ResolvedModel) = undefined,
    resolver: model.Resolver = undefined,
    builder: texture.Builder = undefined,
    maps: biome.Colormaps = undefined,
    reg: biome.Registry = undefined,
    names: lang.Lang = undefined,
    surf_colors: lowres.SurfaceColors = undefined,

    /// The world-level biome table (guarded by `world_mutex`): resource names
    /// and legend labels, id-indexed, kept globally consistent across tiles.
    world_mutex: std.Io.Mutex = .init,
    world_raw: std.ArrayList([]const u8) = .empty,
    world_display: std.ArrayList([]const u8) = .empty,
    world_biome_ids: std.StringHashMap(u16) = undefined,
};

/// Per-render knobs for `setupShared` (everything not derived from the world).
const SharedConfig = struct {
    tile_chunks: i32,
    out_dir: []const u8,
    quality: mesh.LightQuality,
    blend_biomes: bool,
    cave_y: ?i32,
    gz_level: i32,
    mesh_threads: usize,
    lod_cache_dir: ?[]const u8 = null,
};

/// Build the long-lived bake context once: model resolver (+ memo), texture
/// atlas, biome registry/colormaps/lang, and the world-level biome table. The
/// struct is heap-allocated on `a` so every self-reference (`&sh.memo`,
/// `&sh.builder`, …) stays valid after this returns.
fn setupShared(io: std.Io, a: std.mem.Allocator, assets: []const u8, loaded: []const world.LoadedRegion, cfg: SharedConfig) !*Shared {
    const sh = try a.create(Shared);
    sh.* = .{
        .io = io,
        .base = a,
        .loaded = loaded,
        .tile_chunks = cfg.tile_chunks,
        .out_dir = cfg.out_dir,
        .quality = cfg.quality,
        .blend_biomes = cfg.blend_biomes,
        .cave_y = cfg.cave_y,
        .gz_level = cfg.gz_level,
        .mesh_threads = cfg.mesh_threads,
        .lod_cache_dir = cfg.lod_cache_dir,
    };
    sh.locked = .{ .child = a, .io = io };
    sh.sa = sh.locked.allocator();
    sh.memo = std.StringHashMap([]model.ResolvedModel).init(sh.sa);
    sh.resolver = .{ .arena = sh.sa, .io = io, .root = assets, .memo = &sh.memo, .lock = &sh.resolver_lock };
    sh.builder = try texture.Builder.init(sh.sa, io, assets);
    sh.maps = biome.Colormaps.load(a, io, assets);
    sh.reg = biome.Registry.init(sh.sa, io, dataRootFromAssets(a, assets));
    sh.names = lang.Lang.load(a, io, assets);
    sh.world_biome_ids = std.StringHashMap(u16).init(sh.sa);
    try sh.world_raw.append(sh.sa, ""); // id 0 = the "no-data" sentinel
    try sh.world_display.append(sh.sa, "");
    sh.surf_colors = lowres.SurfaceColors.init(sh.sa, sh.resolver, &sh.builder, sh.maps, &sh.reg);
    return sh;
}

/// Everything the tile workers share for a batch render: the long-lived bake
/// context plus this run's work queue, result slots, and progress plumbing.
const RenderCtx = struct {
    shared: *Shared,
    tile_keys: []const u64,
    results: []TileResult,
    next: *std.atomic.Value(usize),
    /// Count of finished tiles (any outcome) — drives the plain-text
    /// progress lines. Distinct from `next`, which hands out work and runs
    /// ahead of completion.
    done: *std.atomic.Value(usize),
    /// Finished-tile ledger for the progressive flusher; each worker appends its
    /// entry here as it writes a `.vtile`.
    live: *Live,
    /// Emit `rendering tiles [done/total]` lines (stderr is not a TTY, so
    /// std.Progress' live bar is invisible to whoever is reading us).
    plain_progress: bool,
    progress: std.Progress.Node,
    observer: ?*RenderProgress,
};

/// One tile's outcome, written only by the worker that owns the slot.
const TileResult = struct {
    err: ?anyerror = null,
    /// False for empty tiles (nothing meshed) — skipped in the manifest.
    written: bool = false,
    entry: TileEntry = .{ .tx = 0, .tz = 0, .bytes = 0 },
    /// World-Y extent of this tile's grid (min inclusive, max exclusive) —
    /// aggregated into the manifest's `yRange` for the viewer's depth slider.
    y_min: i32 = 0,
    y_max: i32 = 0,
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
        // Publish a written tile to the progressive ledger (a small critical
        // section — one append, once per tile) so the flusher can stream it out.
        const r = &ctx.results[idx];
        if (r.written) {
            ctx.live.mutex.lockUncancelable(ctx.shared.io);
            ctx.live.completed.append(ctx.shared.sa, r.entry) catch {};
            ctx.live.max_section_verts = @max(ctx.live.max_section_verts, @max(r.solid_verts, r.fluid_verts));
            ctx.live.y_min = @min(ctx.live.y_min, r.y_min);
            ctx.live.y_max = @max(ctx.live.y_max, r.y_max);
            ctx.live.mutex.unlock(ctx.shared.io);
        }
        ctx.progress.completeOne();
        const done = ctx.done.fetchAdd(1, .monotonic) + 1;
        if (ctx.observer) |p| p.setCompleted(done);
        if (ctx.plain_progress) {
            // ~1% steps (every tile on small worlds) keeps the line count
            // bounded no matter how many tiles a world has.
            const total = ctx.tile_keys.len;
            const step = @max(total / 100, 1);
            if (done % step == 0 or done == total)
                std.debug.print("rendering tiles [{d}/{d}]\n", .{ done, total });
        }
    }
}

/// Render tile `idx` of a batch run into its result slot.
fn renderOneTile(ctx: *RenderCtx, ta: std.mem.Allocator, idx: usize) !void {
    const key = ctx.tile_keys[idx];
    const tx: i32 = @bitCast(@as(u32, @truncate(key >> 32)));
    const tz: i32 = @bitCast(@as(u32, @truncate(key)));
    // The pyramid consumes every tile's colour map, so retain it (`cmap = true`).
    try bakeTile(ctx.shared, ta, tx, tz, true, &ctx.results[idx]);
}

/// Bake tile `(tx,tz)`: assemble its chunk window (+1 apron), remap biome ids
/// onto the world table, compute light, mesh, serialize, gzip, and write the
/// `.vtile`. Fills `res` with the outcome (bytes, verts, y-extent, timings);
/// `res.written` stays false for a tile that meshes to nothing (all air /
/// cave-culled), which never lands a file. Shared caches are thread-safe, so
/// this runs concurrently from the batch workers OR from live-server request
/// threads. `keep_cmap` retains the lowres colour map (the batch pyramid needs
/// it; the live server, which builds no pyramid, passes false so nothing
/// accumulates across a long session).
fn bakeTile(sh: *Shared, ta: std.mem.Allocator, tx: i32, tz: i32, keep_cmap: bool, res: *TileResult) !void {
    return bakeTileFromRegions(sh, ta, sh.loaded, tx, tz, keep_cmap, res);
}

/// Snapshot-aware bake used by the long-running server. Batch rendering and
/// local live sessions call `bakeTile`, which supplies their immutable catalog.
fn bakeTileFromRegions(
    sh: *Shared,
    ta: std.mem.Allocator,
    regions: []const world.LoadedRegion,
    tx: i32,
    tz: i32,
    keep_cmap: bool,
    res: *TileResult,
) !void {
    const io = sh.io;
    const tile_chunks = sh.tile_chunks;

    // Window = the tile's chunks plus a 1-chunk apron on every side.
    const cx0 = tx * tile_chunks - 1;
    const cz0 = tz * tile_chunks - 1;
    const cx1 = (tx + 1) * tile_chunks;
    const cz1 = (tz + 1) * tile_chunks;

    const t_r0 = std.Io.Timestamp.now(io, .awake);
    const g = try world.assembleWindow(ta, io, regions, cx0, cz0, cx1, cz1, &res.stats, null);
    res.read_ms = t_r0.durationTo(std.Io.Timestamp.now(io, .awake)).toMilliseconds();
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
        sh.world_mutex.lockUncancelable(io);
        defer sh.world_mutex.unlock(io);
        if (remap.len > 0) remap[0] = 0;
        for (g.biome_names[1..], 1..) |bn, gi| {
            const gop = try sh.world_biome_ids.getOrPut(bn);
            if (!gop.found_existing) {
                const dup = try sh.sa.dupe(u8, bn); // bn lives in the tile arena
                gop.key_ptr.* = dup;
                const id: u16 = @intCast(sh.world_raw.items.len);
                try sh.world_raw.append(sh.sa, dup);
                try sh.world_display.append(sh.sa, sh.names.biomeName(sh.sa, dup));
                gop.value_ptr.* = id;
            }
            remap[gi] = gop.value_ptr.*;
        }
        raw_names = try ta.dupe([]const u8, sh.world_raw.items);
        display_names = try ta.dupe([]const u8, sh.world_display.items);
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

    const t_m0 = std.Io.Timestamp.now(io, .awake);
    const built = try mesh.buildTextured(ta, g2, sh.resolver, &sh.builder, sh.maps, &sh.reg, sh.quality, sh.blend_biomes, interior, sh.cave_y, sh.mesh_threads, null);
    res.light_ms = built.light_ms;
    res.mesh_ms = t_m0.durationTo(std.Io.Timestamp.now(io, .awake)).toMilliseconds() - built.light_ms;
    if (built.solid.vertex_count == 0 and built.fluid.vertex_count == 0) return;

    const surface = try grid.buildSurface(ta, g2, interior);
    const geo = try tile.serializeWithLightmap(ta, built, surface, display_names);

    // Spill the tile's lowres source map to the batch checkpoint directory.
    // It stays in this tile arena only until the write completes; the pyramid
    // later reads four children at a time, keeping host memory independent of
    // world tile count.
    if (keep_cmap) {
        const tile_blocks: i64 = @as(i64, tile_chunks) * 16;
        const cmap = try lowres.buildColorMap(ta, g2, interior, &sh.surf_colors, @intCast(bx0), @intCast(bz0), @intCast(tile_blocks));
        try writeColorMapCache(io, ta, sh.lod_cache_dir.?, 0, tx, tz, cmap);
    }

    // Tiles ship gzip-wrapped (~8× smaller): any static host can serve
    // them and the viewer inflates via native DecompressionStream.
    const t_w0 = std.Io.Timestamp.now(io, .awake);
    const zipped = try compress.gzipCompress(ta, geo, sh.gz_level);
    const tiles_dir = try std.fmt.allocPrint(ta, "{s}/tiles", .{sh.out_dir});
    const tile_name = try std.fmt.allocPrint(ta, "t.{d}.{d}.vtile", .{ tx, tz });
    try atomicWrite(io, ta, tiles_dir, tile_name, zipped);
    res.write_ms = t_w0.durationTo(std.Io.Timestamp.now(io, .awake)).toMilliseconds();

    res.entry = .{ .tx = tx, .tz = tz, .bytes = zipped.len };
    res.y_min = g2.min_y;
    res.y_max = g2.min_y + @as(i32, @intCast(g2.sy));
    res.solid_verts = built.solid.vertex_count;
    res.fluid_verts = built.fluid.vertex_count;
    res.tris = built.solid.triangleCount() + built.fluid.triangleCount();
    res.raw_bytes = geo.len;
    res.written = true;
}

/// One rendered tile's manifest record.
const TileEntry = struct {
    tx: i32,
    tz: i32,
    bytes: usize,
    /// Per-tile source revision for continuous server sessions. Zero omits the
    /// field from static/local manifests.
    revision: u64 = 0,
};

/// One lowres tile / one pyramid level, for the manifest's `lowres` section.
const LowresTileEntry = struct { x: i32, z: i32, bytes: usize };
const LowresLevel = struct {
    level: u5,
    tile_blocks: i64,
    span: u32,
    tiles: []const LowresTileEntry,
};

const LowresPyramid = struct {
    levels: []const LowresLevel,
    count: usize,
    bytes: u64,
};

fn colorMapCachePath(a: std.mem.Allocator, dir: []const u8, level: u5, x: i32, z: i32) ![]u8 {
    return std.fmt.allocPrint(a, "{s}/c.{d}.{d}.{d}.vcm", .{ dir, level, x, z });
}

fn writeColorMapCache(io: std.Io, a: std.mem.Allocator, dir: []const u8, level: u5, x: i32, z: i32, m: lowres.ColorMap) !void {
    const path = try colorMapCachePath(a, dir, level, x, z);
    const data = try lowres.serializeCache(a, m);
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = data });
}

fn readColorMapCache(io: std.Io, a: std.mem.Allocator, dir: []const u8, level: u5, key: u64) !lowres.ColorMap {
    const x: i32 = @bitCast(@as(u32, @truncate(key >> 32)));
    const z: i32 = @bitCast(@as(u32, @truncate(key)));
    const path = try colorMapCachePath(a, dir, level, x, z);
    const data = try std.Io.Dir.cwd().readFileAlloc(io, path, a, .unlimited);
    return lowres.parseCache(a, data);
}

fn deleteColorMapLevel(io: std.Io, dir: []const u8, level: u5, keys: []const u64) void {
    var scratch = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer scratch.deinit();
    for (keys) |key| {
        _ = scratch.reset(.retain_capacity);
        const x: i32 = @bitCast(@as(u32, @truncate(key >> 32)));
        const z: i32 = @bitCast(@as(u32, @truncate(key)));
        const path = colorMapCachePath(scratch.allocator(), dir, level, x, z) catch continue;
        std.Io.Dir.cwd().deleteFile(io, path) catch {};
    }
}

/// External-memory quadtree construction. Only a four-child parent group (or a
/// tile plus its three apron neighbours) is resident at once. World size now
/// grows temporary disk by ~80 KiB/tile, while process memory remains flat.
fn buildLowresPyramid(
    a: std.mem.Allocator,
    io: std.Io,
    out_dir: []const u8,
    cache_dir: []const u8,
    hires: []const TileEntry,
    tile_blocks: i64,
) !LowresPyramid {
    var initial: std.ArrayList(u64) = .empty;
    for (hires) |t| try initial.append(a, world.packChunk(t.tx, t.tz));
    var current = try initial.toOwnedSlice(a);
    var current_level: u5 = 0;
    var levels: std.ArrayList(LowresLevel) = .empty;
    var total_count: usize = 0;
    var total_bytes: u64 = 0;

    // An origin-anchored quadtree can end as the 2×2 around (0,0); ≤4 tiles is
    // therefore the practical root rather than waiting for an impossible one.
    var level: u5 = 1;
    while (current.len > 4 and level <= 10) : (level += 1) {
        const lvl_blocks = tile_blocks << level;
        var parents = std.AutoHashMap(u64, [2][2]?u64).init(a);
        for (current) |key| {
            const x: i32 = @bitCast(@as(u32, @truncate(key >> 32)));
            const z: i32 = @bitCast(@as(u32, @truncate(key)));
            const px = @divFloor(x, 2);
            const pz = @divFloor(z, 2);
            const qx: usize = @intCast(x - px * 2);
            const qz: usize = @intCast(z - pz * 2);
            const gop = try parents.getOrPut(world.packChunk(px, pz));
            if (!gop.found_existing) gop.value_ptr.* = .{ .{ null, null }, .{ null, null } };
            gop.value_ptr.*[qz][qx] = key;
        }

        var next_list: std.ArrayList(u64) = .empty;
        var scratch = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer scratch.deinit();
        var pit = parents.iterator();
        while (pit.next()) |entry| {
            _ = scratch.reset(.free_all);
            const sa = scratch.allocator();
            var maps: [2][2]?lowres.ColorMap = .{ .{ null, null }, .{ null, null } };
            var refs: [2][2]?*const lowres.ColorMap = .{ .{ null, null }, .{ null, null } };
            for (0..2) |qz| {
                for (0..2) |qx| {
                    if (entry.value_ptr.*[qz][qx]) |child_key| {
                        maps[qz][qx] = try readColorMapCache(io, sa, cache_dir, current_level, child_key);
                        if (maps[qz][qx]) |*m| refs[qz][qx] = m;
                    }
                }
            }
            const px: i32 = @bitCast(@as(u32, @truncate(entry.key_ptr.* >> 32)));
            const pz: i32 = @bitCast(@as(u32, @truncate(entry.key_ptr.*)));
            const parent = try lowres.downsample(
                sa,
                refs,
                @intCast(@as(i64, px) * lvl_blocks),
                @intCast(@as(i64, pz) * lvl_blocks),
                @as(u32, 1) << level,
            );
            try writeColorMapCache(io, sa, cache_dir, level, px, pz, parent);
            try next_list.append(a, entry.key_ptr.*);
        }

        const next = try next_list.toOwnedSlice(a);
        std.mem.sort(u64, next, {}, struct {
            fn lt(_: void, x: u64, y: u64) bool {
                return x < y;
            }
        }.lt);
        deleteColorMapLevel(io, cache_dir, current_level, current);

        var next_index = std.AutoHashMap(u64, void).init(a);
        for (next) |key| try next_index.put(key, {});
        var entries: std.ArrayList(LowresTileEntry) = .empty;
        for (next) |key| {
            _ = scratch.reset(.free_all);
            const sa = scratch.allocator();
            const px: i32 = @bitCast(@as(u32, @truncate(key >> 32)));
            const pz: i32 = @bitCast(@as(u32, @truncate(key)));
            const center = try readColorMapCache(io, sa, cache_dir, level, key);
            var right: ?lowres.ColorMap = if (next_index.contains(world.packChunk(px + 1, pz)))
                try readColorMapCache(io, sa, cache_dir, level, world.packChunk(px + 1, pz))
            else
                null;
            var down: ?lowres.ColorMap = if (next_index.contains(world.packChunk(px, pz + 1)))
                try readColorMapCache(io, sa, cache_dir, level, world.packChunk(px, pz + 1))
            else
                null;
            var corner: ?lowres.ColorMap = if (next_index.contains(world.packChunk(px + 1, pz + 1)))
                try readColorMapCache(io, sa, cache_dir, level, world.packChunk(px + 1, pz + 1))
            else
                null;
            const blob = try lowres.serialize(
                sa,
                center,
                if (right) |*m| m else null,
                if (down) |*m| m else null,
                if (corner) |*m| m else null,
            );
            const zipped = try compress.gzipCompress(sa, blob, 6);
            const path = try std.fmt.allocPrint(sa, "{s}/tiles/l{d}.{d}.{d}.vlr", .{ out_dir, level, px, pz });
            try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = zipped });
            try entries.append(a, .{ .x = px, .z = pz, .bytes = zipped.len });
            total_count += 1;
            total_bytes += zipped.len;
        }
        try levels.append(a, .{
            .level = level,
            .tile_blocks = lvl_blocks,
            .span = @as(u32, 1) << level,
            .tiles = try entries.toOwnedSlice(a),
        });
        current = next;
        current_level = level;
    }
    deleteColorMapLevel(io, cache_dir, current_level, current);
    return .{ .levels = try levels.toOwnedSlice(a), .count = total_count, .bytes = total_bytes };
}

const ManifestInput = struct {
    tile_chunks: i32,
    spawn: ?[3]i32,
    /// Biome display names, id-indexed (index 0 = the "" no-data sentinel).
    biomes: []const []const u8,
    tiles: []const TileEntry,
    lowres: []const LowresLevel = &.{},
    /// Largest per-section vertex count across every tile — the viewer sizes
    /// its one shared quad index buffer from this before the first tile lands.
    max_section_verts: u64 = 0,
    /// True when cave culling was off (`--caves full`) — the tiles carry every
    /// cave, so the viewer can offer its depth-slice cave view.
    caves: bool = false,
    /// World-Y extent across all tiles [min, max) — bounds for the depth slider.
    y_range: ?[2]i32 = null,
    /// Progressive render: true while tiles are still being baked (the viewer
    /// polls and streams new tiles in), false in the final manifest.
    rendering: bool = false,
    /// [done, total] tiles, surfaced to the viewer's progress readout while
    /// `rendering` is true.
    progress: ?[2]usize = null,
    /// Atlas layer count backing `terrain.vtexarr`. The viewer re-fetches the
    /// texture array when this grows between progressive polls (layers are
    /// append-only, so a superset is always safe for already-loaded tiles).
    texture_layers: u32 = 0,
    /// On-demand live server (`vantage live`): every populated tile is listed
    /// up front but baked lazily on first fetch, so the viewer gates a tile's
    /// insertion on the atlas covering its layers (the atlas grows in
    /// viewport order, not tile-list order). Implies `rendering`.
    dynamic: bool = false,
};

/// Whether `name` is a render-owned tile file: `t.<x>.<z>.vtile` (hires) or
/// `l<level>.<x>.<z>.vlr` (lowres). The stale sweep only ever touches names
/// this recognizes — anything else in the output dir is left alone.
fn isTileFileName(name: []const u8) bool {
    if (std.mem.startsWith(u8, name, "t.") and std.mem.endsWith(u8, name, ".vtile")) {
        var it = std.mem.splitScalar(u8, name["t.".len .. name.len - ".vtile".len], '.');
        for (0..2) |_| {
            _ = std.fmt.parseInt(i32, it.next() orelse return false, 10) catch return false;
        }
        return it.next() == null;
    }
    if (name.len > 1 and name[0] == 'l' and std.mem.endsWith(u8, name, ".vlr")) {
        var it = std.mem.splitScalar(u8, name[1 .. name.len - ".vlr".len], '.');
        _ = std.fmt.parseInt(u5, it.next() orelse return false, 10) catch return false;
        for (0..2) |_| {
            _ = std.fmt.parseInt(i32, it.next() orelse return false, 10) catch return false;
        }
        return it.next() == null;
    }
    return false;
}

/// Delete tile files in `{out_dir}/tiles` left over from a previous render —
/// names the just-written manifest no longer references (a re-render with a
/// different tile grid or a shrunken world leaves them behind: unreachable,
/// but they waste disk and confuse anyone inspecting the directory). Only
/// exact tile-shaped names (see `isTileFileName`) are candidates. Returns the
/// number removed; all failures are swallowed — a stale file is cosmetic,
/// never worth failing a finished render over.
fn sweepStaleTiles(
    a: std.mem.Allocator,
    io: std.Io,
    out_dir: []const u8,
    tiles: []const TileEntry,
    lowres_levels: []const LowresLevel,
) usize {
    var expected = std.StringHashMap(void).init(a);
    for (tiles) |t| {
        const name = std.fmt.allocPrint(a, "t.{d}.{d}.vtile", .{ t.tx, t.tz }) catch return 0;
        expected.put(name, {}) catch return 0;
    }
    for (lowres_levels) |lvl| {
        for (lvl.tiles) |t| {
            const name = std.fmt.allocPrint(a, "l{d}.{d}.{d}.vlr", .{ lvl.level, t.x, t.z }) catch return 0;
            expected.put(name, {}) catch return 0;
        }
    }

    const dir_path = std.fmt.allocPrint(a, "{s}/tiles", .{out_dir}) catch return 0;
    var dir = std.Io.Dir.cwd().openDir(io, dir_path, .{ .iterate = true }) catch return 0;
    defer dir.close(io);

    // Collect first, delete after: removing entries mid-iteration can skip
    // files on some filesystems. Entry names point into the iterator's reused
    // buffer, so they must be duped.
    var stale: std.ArrayList([]const u8) = .empty;
    var it = dir.iterate();
    while (true) {
        const e = (it.next(io) catch break) orelse break;
        if (e.kind != .file) continue;
        if (!isTileFileName(e.name)) continue;
        if (expected.contains(e.name)) continue;
        stale.append(a, a.dupe(u8, e.name) catch break) catch break;
    }
    var removed: usize = 0;
    for (stale.items) |name| {
        dir.deleteFile(io, name) catch continue;
        removed += 1;
    }
    return removed;
}

test "parseTilePath extracts tile coords, rejects everything else" {
    try std.testing.expectEqual([2]i32{ 0, 0 }, parseTilePath("tiles/t.0.0.vtile").?);
    try std.testing.expectEqual([2]i32{ -3, 12 }, parseTilePath("tiles/t.-3.12.vtile").?);
    try std.testing.expect(parseTilePath("manifest.json") == null);
    try std.testing.expect(parseTilePath("terrain.vtexarr") == null);
    try std.testing.expect(parseTilePath("tiles/l3.0.0.vlr") == null); // lowres, not hires
    try std.testing.expect(parseTilePath("tiles/t.0.vtile") == null); // one coord
    try std.testing.expect(parseTilePath("tiles/t.a.b.vtile") == null); // non-numeric
    try std.testing.expect(parseTilePath("t.0.0.vtile") == null); // missing tiles/ prefix
}

test "isTileFileName accepts render-owned tiles and nothing else" {
    try std.testing.expect(isTileFileName("t.0.0.vtile"));
    try std.testing.expect(isTileFileName("t.-12.4.vtile"));
    try std.testing.expect(isTileFileName("l3.-1.7.vlr"));
    // Wrong shape, wrong extension, non-numeric keys, extra segments.
    try std.testing.expect(!isTileFileName("t.0.vtile"));
    try std.testing.expect(!isTileFileName("t.0.0.0.vtile"));
    try std.testing.expect(!isTileFileName("t.a.b.vtile"));
    try std.testing.expect(!isTileFileName("t.0.0.vtile.bak"));
    try std.testing.expect(!isTileFileName("l.0.0.vlr"));
    try std.testing.expect(!isTileFileName("l3.0.vlr"));
    try std.testing.expect(!isTileFileName("manifest.json"));
    try std.testing.expect(!isTileFileName("terrain.vtexarr"));
    try std.testing.expect(!isTileFileName("notes.txt"));
}

/// Serialize the world manifest — the small JSON the viewer streams tiles from.
/// Hand-rolled (the shape is tiny and fixed) to stay off the std.json churn.
fn buildManifest(a: std.mem.Allocator, m: ManifestInput) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    // Format 5 = VTL9 tiles (losslessly packed RG8 lightmaps).
    try out.print(a, "{{\n  \"format\": 5,\n  \"tileChunks\": {d},\n  \"tileBlocks\": {d},\n  \"maxSectionVerts\": {d},\n  \"textures\": \"terrain.vtexarr\",\n  \"textureLayers\": {d},\n", .{
        m.tile_chunks, m.tile_chunks * 16, m.max_section_verts, m.texture_layers,
    });
    if (m.rendering) try out.appendSlice(a, "  \"rendering\": true,\n");
    if (m.dynamic) try out.appendSlice(a, "  \"dynamic\": true,\n");
    if (m.progress) |p| try out.print(a, "  \"progress\": {{ \"done\": {d}, \"total\": {d} }},\n", .{ p[0], p[1] });
    if (m.caves) try out.appendSlice(a, "  \"caves\": true,\n");
    if (m.y_range) |yr| try out.print(a, "  \"yRange\": {{ \"min\": {d}, \"max\": {d} }},\n", .{ yr[0], yr[1] });
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
        if (t.revision == 0) {
            try out.print(a, "    {{ \"x\": {d}, \"z\": {d}, \"path\": \"tiles/t.{d}.{d}.vtile\", \"bytes\": {d} }}{s}\n", .{
                t.tx, t.tz, t.tx, t.tz, t.bytes, if (i + 1 < m.tiles.len) "," else "",
            });
        } else {
            try out.print(a, "    {{ \"x\": {d}, \"z\": {d}, \"path\": \"tiles/t.{d}.{d}.vtile\", \"bytes\": {d}, \"revision\": \"{x}\" }}{s}\n", .{
                t.tx, t.tz, t.tx, t.tz, t.bytes, t.revision, if (i + 1 < m.tiles.len) "," else "",
            });
        }
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

test "parseCaveY: full/off disable culling, a number sets the horizon" {
    try std.testing.expectEqual(@as(?i32, 55), try parseCaveY(&.{}));
    try std.testing.expectEqual(@as(?i32, null), try parseCaveY(&.{ "--caves", "full" }));
    try std.testing.expectEqual(@as(?i32, null), try parseCaveY(&.{ "--caves", "off" }));
    try std.testing.expectEqual(@as(?i32, 40), try parseCaveY(&.{ "--caves", "40" }));
    // The reject path (`--caves deep`) prints its complaint to stderr, which
    // `zig build test` treats as failure — covered by manual CLI use instead.
}

test "buildManifest carries caves + yRange for the depth slider" {
    const a = std.testing.allocator;
    const json = try buildManifest(a, .{
        .tile_chunks = 8,
        .spawn = null,
        .biomes = &.{""},
        .tiles = &.{.{ .tx = 0, .tz = 0, .bytes = 1 }},
        .caves = true,
        .y_range = .{ -64, 320 },
    });
    defer a.free(json);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"caves\": true") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"yRange\": { \"min\": -64, \"max\": 320 }") != null);
    // Default (culled) renders advertise neither key.
    const plain = try buildManifest(a, .{
        .tile_chunks = 8,
        .spawn = null,
        .biomes = &.{""},
        .tiles = &.{.{ .tx = 0, .tz = 0, .bytes = 1 }},
    });
    defer a.free(plain);
    try std.testing.expect(std.mem.indexOf(u8, plain, "caves") == null);
    try std.testing.expect(std.mem.indexOf(u8, plain, "yRange") == null);
}

/// `vantage extract [client.jar]` — populate the asset cache from a client jar.
/// With no argument, auto-discovers the newest jar in the local Minecraft
/// installation, so a fresh `vantage render <save>` works with zero setup.
/// `vantage serve [render-dir] [--port n] [--host addr] [--open]` — host a
/// rendered world plus the embedded web viewer on a local HTTP server.
fn runServe(init: std.process.Init, a: std.mem.Allocator, args: []const []const u8) !void {
    var opts: serve.Options = .{ .dir = "web/public" };
    var argi: usize = 0;
    while (argi < args.len) : (argi += 1) {
        const arg = args[argi];
        if (std.mem.eql(u8, arg, "--port")) {
            const v = try flagValue(args, &argi);
            opts.port = std.fmt.parseInt(u16, v, 10) catch return badValue("--port", v, "1..65535");
        } else if (std.mem.eql(u8, arg, "--host")) {
            opts.host = try flagValue(args, &argi);
        } else if (std.mem.eql(u8, arg, "--open")) {
            opts.open = true;
        } else if (!std.mem.startsWith(u8, arg, "-")) {
            opts.dir = arg;
        } else {
            std.debug.print("unknown flag for serve: {s} (see `vantage --help`)\n", .{arg});
            return error.InvalidArgument;
        }
    }
    return serve.run(init.io, a, opts);
}

/// On-demand ("live") server state: keeps the world loaded and bakes tiles
/// lazily as the viewer fetches them, so a huge world is explorable in seconds
/// with a flat memory footprint — only the region tables + assets stay resident;
/// each tile bakes into `out_dir` (a session cache) and its working set
/// evaporates. The bake path and its shared caches (atlas, biome table) are the
/// same thread-safe ones the batch render uses, so concurrent request-thread
/// bakes are safe.
const BakedTile = struct {
    bytes: usize,
    revision: u64,
};

/// Ref-counted, independently allocated view of the live region catalog. A
/// refresh swaps the current pointer in O(1); in-flight bakes retain their old
/// snapshot until completion, then its arena is reclaimed in one operation.
/// This avoids both use-after-free and the unbounded arena growth that repeated
/// table rescans would otherwise cause on a months-long server process.
const RegionSnapshot = struct {
    arena: std.heap.ArenaAllocator,
    loaded: []const world.LoadedRegion,
    tile_keys: []const u64,
    /// Membership and revision in one O(1) lookup. The revision was computed
    /// with a small region-coordinate index while this epoch was assembled.
    tile_revisions: std.AutoHashMap(u64, u64),
    metadata_revision: u64,
    catalog_revision: u64,
    refs: usize = 1, // the LiveServer's owner reference
    retired: bool = false,

    fn destroy(self: *RegionSnapshot) void {
        self.arena.deinit();
        std.heap.page_allocator.destroy(self);
    }
};

fn createRegionSnapshot(
    io: std.Io,
    region_dir: []const u8,
    radius: i32,
    centre_cx: i32,
    centre_cz: i32,
    tile_chunks: i32,
    known_metadata_revision: ?u64,
) !*RegionSnapshot {
    // Capture the cheap gate before loading tables. If Minecraft saves during
    // construction, the next poll observes a different gate and retries; doing
    // this afterward could label an older catalog with the newer fingerprint.
    const metadata_revision = known_metadata_revision orelse blk: {
        var metadata_arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer metadata_arena.deinit();
        break :blk try world.catalogMetadataRevision(metadata_arena.allocator(), io, region_dir);
    };
    const snapshot = try std.heap.page_allocator.create(RegionSnapshot);
    errdefer std.heap.page_allocator.destroy(snapshot);
    snapshot.arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    errdefer snapshot.arena.deinit();
    const a = snapshot.arena.allocator();
    const loaded = try world.loadRegions(a, io, region_dir);
    const bounds = world.populatedBounds(loaded);
    const populated = if (bounds.count == 0)
        std.AutoHashMap(u64, void).init(a)
    else
        try world.populatedChunks(a, loaded);
    const tile_keys = try enumerateTilesSpawnOutward(a, populated, radius, centre_cx, centre_cz, tile_chunks);
    var region_revisions = try world.indexRegionRevisions(a, loaded);
    var tile_revisions = std.AutoHashMap(u64, u64).init(a);
    for (tile_keys) |key| {
        const tx: i32 = @bitCast(@as(u32, @truncate(key >> 32)));
        const tz: i32 = @bitCast(@as(u32, @truncate(key)));
        try tile_revisions.put(key, world.tileRevisionIndexed(&region_revisions, tx, tz, tile_chunks));
    }
    region_revisions.deinit();
    snapshot.* = .{
        .arena = snapshot.arena,
        .loaded = loaded,
        .tile_keys = tile_keys,
        .tile_revisions = tile_revisions,
        .metadata_revision = metadata_revision,
        .catalog_revision = world.catalogRevision(loaded),
    };
    return snapshot;
}

const LiveServer = struct {
    sh: *Shared,
    /// Every populated tile, spawn-outward — the manifest lists them all; each
    /// bakes on first fetch.
    tile_keys: []const u64,
    spawn: ?[3]i32,

    /// Guards the session cache ledger + the live manifest aggregates below.
    mutex: std.Io.Mutex = .init,
    ready: std.Io.Condition = .init,
    /// Immutable membership gate: arbitrary URLs cannot make the host bake
    /// coordinates that were not advertised by this world's manifest.
    known: std.AutoHashMap(u64, void) = undefined,
    /// Tiles baked THIS session → gzipped bytes on disk (0 = an empty tile, or
    /// one that failed to bake: a gap). A tile is served from the on-disk cache
    /// only when it's here, so the cache always agrees with THIS session's
    /// atlas — a prior session's tiles, baked against a different atlas layer
    /// order, are simply re-baked on first fetch.
    baked: std.AutoHashMap(u64, BakedTile) = undefined,
    /// Keys currently being filled. Duplicate requests wait on `ready` and
    /// share the first result instead of stampeding the same expensive bake.
    baking: std.AutoHashMap(u64, void) = undefined,
    /// Admission control for the actual memory-heavy work. Connection threads
    /// may wait cheaply, but only this many tile arenas can exist at once.
    bake_slots: std.Io.Semaphore = .{},
    /// `vantage server` continuously refreshes this catalog; local `live`
    /// leaves it null and uses the immutable fields above.
    region_dir: ?[]const u8 = null,
    radius: i32 = 0,
    centre_cx: i32 = 0,
    centre_cz: i32 = 0,
    snapshot: ?*RegionSnapshot = null,
    scan_interval_ns: i96 = 5 * std.time.ns_per_s,
    last_scan: std.Io.Timestamp = .zero,
    scanning: bool = false,
    max_section_verts: u64 = 0,
    y_min: i32 = std.math.maxInt(i32),
    y_max: i32 = std.math.minInt(i32),

    fn producer(self: *LiveServer) serve.Producer {
        return .{ .ctx = self, .func = produce };
    }

    /// Record a finished bake in the session ledger (bytes, and the running
    /// max-section-verts / y-extent the live manifest reports). `res` is null
    /// for an empty or failed tile (recorded as 0 bytes so it isn't re-baked).
    fn record(self: *LiveServer, key: u64, revision: u64, res: ?*const TileResult) void {
        self.mutex.lockUncancelable(self.sh.io);
        defer self.mutex.unlock(self.sh.io);
        self.recordLocked(key, revision, res);
        _ = self.baking.remove(key);
        self.ready.broadcast(self.sh.io);
    }

    fn recordLocked(self: *LiveServer, key: u64, revision: u64, res: ?*const TileResult) void {
        self.baked.put(key, .{ .bytes = if (res) |r| r.entry.bytes else 0, .revision = revision }) catch {};
        if (res) |r| {
            self.max_section_verts = @max(self.max_section_verts, @max(r.solid_verts, r.fluid_verts));
            self.y_min = @min(self.y_min, r.y_min);
            self.y_max = @max(self.y_max, r.y_max);
        }
    }

    fn acquireSnapshot(self: *LiveServer) ?*RegionSnapshot {
        self.mutex.lockUncancelable(self.sh.io);
        defer self.mutex.unlock(self.sh.io);
        const current = self.snapshot orelse return null;
        current.refs += 1;
        return current;
    }

    fn releaseSnapshot(self: *LiveServer, snapshot: *RegionSnapshot) void {
        var destroy = false;
        self.mutex.lockUncancelable(self.sh.io);
        snapshot.refs -= 1;
        destroy = snapshot.refs == 0 and snapshot.retired;
        self.mutex.unlock(self.sh.io);
        if (destroy) snapshot.destroy();
    }

    fn retireOwnerLocked(self: *LiveServer, snapshot: *RegionSnapshot) bool {
        _ = self;
        snapshot.retired = true;
        snapshot.refs -= 1;
        return snapshot.refs == 0;
    }

    /// Throttled world refresh. A cheap directory metadata fingerprint is the
    /// common path; the 4 KiB location tables and tile catalog are rebuilt only
    /// after that fingerprint advances. I/O happens outside the state mutex;
    /// concurrent manifest polls keep using the prior consistent snapshot.
    fn maybeRefresh(self: *LiveServer) void {
        const region_dir = self.region_dir orelse return;
        const io = self.sh.io;
        const now = std.Io.Timestamp.now(io, .awake);
        self.mutex.lockUncancelable(io);
        if (self.scanning or (self.last_scan.nanoseconds != 0 and self.last_scan.durationTo(now).nanoseconds < self.scan_interval_ns)) {
            self.mutex.unlock(io);
            return;
        }
        self.scanning = true;
        self.last_scan = now;
        self.mutex.unlock(io);

        var scan_arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer scan_arena.deinit();
        const metadata_revision = world.catalogMetadataRevision(scan_arena.allocator(), io, region_dir) catch |e| {
            self.mutex.lockUncancelable(io);
            self.scanning = false;
            self.mutex.unlock(io);
            std.debug.print("server: region metadata scan failed: {s}; retaining the previous snapshot\n", .{@errorName(e)});
            return;
        };

        self.mutex.lockUncancelable(io);
        const metadata_unchanged = if (self.snapshot) |current| current.metadata_revision == metadata_revision else false;
        if (metadata_unchanged) self.scanning = false;
        self.mutex.unlock(io);
        if (metadata_unchanged) return;

        const candidate = createRegionSnapshot(io, region_dir, self.radius, self.centre_cx, self.centre_cz, self.sh.tile_chunks, metadata_revision) catch |e| {
            self.mutex.lockUncancelable(io);
            self.scanning = false;
            self.mutex.unlock(io);
            std.debug.print("server: region catalog refresh failed: {s}; retaining the previous snapshot\n", .{@errorName(e)});
            return;
        };

        var old_to_destroy: ?*RegionSnapshot = null;
        var changed = false;
        self.mutex.lockUncancelable(io);
        const current = self.snapshot;
        if (current == null or current.?.catalog_revision != candidate.catalog_revision) {
            self.snapshot = candidate;
            changed = true;
            if (current) |old| {
                if (self.retireOwnerLocked(old)) old_to_destroy = old;
            }
        }
        self.scanning = false;
        self.mutex.unlock(io);

        if (!changed) candidate.destroy();
        if (old_to_destroy) |old| old.destroy();
        if (changed) std.debug.print("server: world snapshot advanced ({d} render tiles)\n", .{candidate.tile_keys.len});
    }
};

/// The `serve.Producer` hook: synthesize the paths the live server owns — the
/// manifest, the texture atlas, and un-cached tiles — and fall through
/// (null) to static disk serving for everything else.
fn produce(ctx: *anyopaque, io: std.Io, arena: std.mem.Allocator, path: []const u8) !?serve.Produced {
    _ = io;
    const self: *LiveServer = @ptrCast(@alignCast(ctx));
    if (std.mem.eql(u8, path, "manifest.json"))
        return .{ .body = try liveManifest(self, arena), .content_type = "application/json" };
    if (std.mem.eql(u8, path, "terrain.vtexarr"))
        return .{ .body = try liveAtlas(self, arena), .content_type = "application/octet-stream" };
    if (parseTilePath(path)) |xz|
        return .{ .body = try liveTile(self, arena, xz[0], xz[1]), .content_type = "application/octet-stream" };
    return null; // not ours — static disk serves it (lowres, favicon, …)
}

/// Parse `tiles/t.<x>.<z>.vtile` → `{x, z}`; null for any other path.
fn parseTilePath(path: []const u8) ?[2]i32 {
    const prefix = "tiles/t.";
    const suffix = ".vtile";
    if (!std.mem.startsWith(u8, path, prefix) or !std.mem.endsWith(u8, path, suffix)) return null;
    const mid = path[prefix.len .. path.len - suffix.len];
    const dot = std.mem.indexOfScalar(u8, mid, '.') orelse return null;
    const x = std.fmt.parseInt(i32, mid[0..dot], 10) catch return null;
    const z = std.fmt.parseInt(i32, mid[dot + 1 ..], 10) catch return null;
    return .{ x, z };
}

/// Serve one tile: from the session cache if already baked (0 bytes = a valid
/// empty body), else join or lead a single in-flight fill. Leaders wait for a
/// memory-budgeted bake permit before allocating their tile arena. A failure
/// becomes a gap (an empty body the viewer marks empty), never a retry storm.
fn liveTile(self: *LiveServer, arena: std.mem.Allocator, tx: i32, tz: i32) ![]const u8 {
    const key = world.packChunk(tx, tz);
    const snapshot = self.acquireSnapshot();
    defer if (snapshot) |current| self.releaseSnapshot(current);
    const regions = if (snapshot) |current| current.loaded else self.sh.loaded;
    const revision = if (snapshot) |current| current.tile_revisions.get(key) orelse return "" else 0;
    if (snapshot == null and !self.known.contains(key)) return "";

    self.mutex.lockUncancelable(self.sh.io);
    while (true) {
        if (self.baked.get(key)) |cached| if (cached.revision == revision) {
            self.mutex.unlock(self.sh.io);
            return if (cached.bytes == 0) "" else readCachedTile(self, arena, tx, tz);
        };
        if (!self.baking.contains(key)) {
            self.baking.put(key, {}) catch |e| {
                self.mutex.unlock(self.sh.io);
                return e;
            };
            self.mutex.unlock(self.sh.io);
            break;
        }
        self.ready.waitUncancelable(self.sh.io, &self.mutex);
    }

    self.bake_slots.waitUncancelable(self.sh.io);
    defer self.bake_slots.post(self.sh.io);

    var res: TileResult = .{};
    bakeTileFromRegions(self.sh, arena, regions, tx, tz, false, &res) catch |e| {
        std.debug.print("live: tile ({d},{d}) failed: {s} — leaving a gap\n", .{ tx, tz, @errorName(e) });
        self.record(key, revision, null);
        return ""; // empty body → the viewer marks it empty, no retry
    };
    self.record(key, revision, if (res.written) &res else null);
    if (!res.written) return ""; // meshed to nothing (all air / cave-culled)
    return readCachedTile(self, arena, tx, tz);
}

/// Read a session-cached tile off disk into the request arena (it was written
/// by THIS session's bake, so it agrees with the current atlas).
fn readCachedTile(self: *LiveServer, arena: std.mem.Allocator, tx: i32, tz: i32) ![]const u8 {
    const path = try std.fmt.allocPrint(arena, "{s}/tiles/t.{d}.{d}.vtile", .{ self.sh.out_dir, tx, tz });
    return std.Io.Dir.cwd().readFileAlloc(self.sh.io, path, arena, .unlimited);
}

/// Build the live manifest: every populated tile listed (with its baked size,
/// 0 until fetched), the running atlas/biome/extent state, and progress. Stays
/// `rendering: true` until every tile has been baked at least once.
fn liveManifest(self: *LiveServer, arena: std.mem.Allocator) ![]const u8 {
    const io = self.sh.io;
    self.maybeRefresh();
    const snapshot = self.acquireSnapshot();
    defer if (snapshot) |current| self.releaseSnapshot(current);
    const tile_keys = if (snapshot) |current| current.tile_keys else self.tile_keys;

    self.mutex.lockUncancelable(io);
    const tiles = arena.alloc(TileEntry, tile_keys.len) catch |e| {
        self.mutex.unlock(io);
        return e;
    };
    var done: usize = 0;
    for (tile_keys, tiles) |key, *t| {
        const tx: i32 = @bitCast(@as(u32, @truncate(key >> 32)));
        const tz: i32 = @bitCast(@as(u32, @truncate(key)));
        const revision = if (snapshot) |current_snapshot| current_snapshot.tile_revisions.get(key).? else 0;
        const cached = self.baked.get(key);
        const current = if (cached) |entry| entry.revision == revision else false;
        if (current) done += 1;
        t.* = .{
            .tx = tx,
            .tz = tz,
            .bytes = if (current) cached.?.bytes else 0,
            .revision = revision,
        };
    }
    const msv = self.max_section_verts;
    const ymin = self.y_min;
    const ymax = self.y_max;
    self.mutex.unlock(io);

    self.sh.world_mutex.lockUncancelable(io);
    const biomes = arena.dupe([]const u8, self.sh.world_display.items) catch |e| {
        self.sh.world_mutex.unlock(io);
        return e;
    };
    self.sh.world_mutex.unlock(io);

    return buildManifest(arena, .{
        .tile_chunks = self.sh.tile_chunks,
        .spawn = self.spawn,
        .biomes = biomes,
        .tiles = tiles,
        .max_section_verts = msv,
        .caves = self.sh.cave_y == null,
        .y_range = if (ymin < ymax) .{ ymin, ymax } else null,
        // Continuous servers keep polling even after the current snapshot is
        // warm so newly-saved terrain can advance tile revisions in place.
        .rendering = snapshot != null or done < tile_keys.len,
        .dynamic = true,
        .progress = .{ done, tile_keys.len },
        .texture_layers = self.sh.builder.layerCount(),
    });
}

/// Serialize + gzip the current atlas into the request arena — a fresh snapshot
/// per fetch (the viewer re-fetches when a tile needs a layer it lacks).
fn liveAtlas(self: *LiveServer, arena: std.mem.Allocator) ![]const u8 {
    const io = self.sh.io;
    self.sh.builder.mutex.lockUncancelable(io);
    const arr = self.sh.builder.finishAlloc(arena) catch |e| {
        self.sh.builder.mutex.unlock(io);
        return e;
    };
    self.sh.builder.mutex.unlock(io);
    return compress.gzipCompress(arena, try texture.serialize(arena, arr), 6);
}

/// `vantage live <save-dir> [render flags] [--port n] [--host addr] [--open]` —
/// open a world in the browser NOW: the whole populated map is listed up front
/// but each tile is baked on demand as it scrolls into view, so there's no
/// hour-long pre-render. Tiles cache into `--out` (default web/public), so
/// panning back is instant.
fn runLive(init: std.process.Init, a: std.mem.Allocator, args: []const []const u8) !void {
    return runLiveMode(init, a, args, false);
}

/// `vantage server` shares the live renderer but replaces its local embedded
/// viewer with a versioned, authenticated data plane. Keeping one bake engine
/// means both products retain the same memory admission and in-flight request
/// coalescing guarantees.
fn runServer(init: std.process.Init, a: std.mem.Allocator, args: []const []const u8) !void {
    return runLiveMode(init, a, args, true);
}

fn runLiveMode(init: std.process.Init, a: std.mem.Allocator, args: []const []const u8, server_mode: bool) !void {
    if (args.len < 1) return usage();
    const save = args[0];
    var assets_opt: ?[]const u8 = null;
    var out_dir: []const u8 = if (server_mode) "vantage-server-cache" else "web/public"; // doubles as the on-demand tile cache
    var tile_chunks: i32 = 8;
    var radius: i32 = 0;
    var gz_level: i32 = 6; // live favours bake-and-serve latency over the last few % of size
    var port: u16 = 8268;
    var host: []const u8 = "127.0.0.1";
    var open = false;
    var token_env: []const u8 = "VANTAGE_SERVER_TOKEN";
    var allowed_origins: std.ArrayList([]const u8) = .empty;
    var max_connections: usize = 64;
    var scan_interval_seconds: u32 = 5;
    const quality = try parseLightQuality(args);
    const blend_biomes = try parseBiomeBlend(args);
    const cave_y = try parseCaveY(args);
    const requested_threads = try parseThreads(args);
    const memory_budget = bakeMemoryBudget(try parseMemoryMiB(args));
    var argi: usize = 1;
    while (argi < args.len) : (argi += 1) {
        const arg = args[argi];
        if (std.mem.eql(u8, arg, "--assets")) {
            assets_opt = try flagValue(args, &argi);
        } else if (std.mem.eql(u8, arg, "--out")) {
            out_dir = try flagValue(args, &argi);
        } else if (std.mem.eql(u8, arg, "--tile-chunks")) {
            const v = try flagValue(args, &argi);
            const n = std.fmt.parseInt(i32, v, 10) catch return badValue("--tile-chunks", v, "1..32");
            tile_chunks = std.math.clamp(n, 1, 32);
        } else if (std.mem.eql(u8, arg, "--radius")) {
            const v = try flagValue(args, &argi);
            radius = std.fmt.parseInt(i32, v, 10) catch return badValue("--radius", v, "<chunks>");
        } else if (std.mem.eql(u8, arg, "--gz")) {
            const v = try flagValue(args, &argi);
            const n = std.fmt.parseInt(i32, v, 10) catch return badValue("--gz", v, "1..12");
            gz_level = std.math.clamp(n, 1, 12);
        } else if (std.mem.eql(u8, arg, "--port")) {
            const v = try flagValue(args, &argi);
            port = std.fmt.parseInt(u16, v, 10) catch return badValue("--port", v, "1..65535");
        } else if (std.mem.eql(u8, arg, "--host")) {
            host = try flagValue(args, &argi);
        } else if (std.mem.eql(u8, arg, "--open")) {
            open = true;
        } else if (server_mode and std.mem.eql(u8, arg, "--token-env")) {
            token_env = try flagValue(args, &argi);
        } else if (server_mode and std.mem.eql(u8, arg, "--allow-origin")) {
            const origin = try flagValue(args, &argi);
            if (!validCorsOrigin(origin)) return badValue("--allow-origin", origin, "an exact http(s) origin without a path");
            try allowed_origins.append(a, origin);
        } else if (server_mode and std.mem.eql(u8, arg, "--max-connections")) {
            const v = try flagValue(args, &argi);
            const n = std.fmt.parseInt(usize, v, 10) catch return badValue("--max-connections", v, "1..4096");
            max_connections = std.math.clamp(n, 1, 4096);
        } else if (server_mode and std.mem.eql(u8, arg, "--scan-interval")) {
            const v = try flagValue(args, &argi);
            const n = std.fmt.parseInt(u32, v, 10) catch return badValue("--scan-interval", v, "1..3600 seconds");
            scan_interval_seconds = std.math.clamp(n, 1, 3600);
        } else if (std.mem.eql(u8, arg, "--light") or std.mem.eql(u8, arg, "--biome-blend") or
            std.mem.eql(u8, arg, "--caves") or std.mem.eql(u8, arg, "--threads") or std.mem.eql(u8, arg, "--memory"))
        {
            argi += 1; // value parsed by the dedicated scanners above
        } else if (std.mem.startsWith(u8, arg, "-")) {
            std.debug.print("unknown flag for live: {s} (see `vantage --help`)\n", .{arg});
            return error.InvalidArgument;
        }
    }

    if (server_mode and open) {
        std.debug.print("--open is only available for `vantage live`; the server command exposes a data API, not a web page\n", .{});
        return error.InvalidArgument;
    }

    var bearer_sha256: ?[32]u8 = null;
    if (server_mode) {
        if (token_env.len == 0) return badValue("--token-env", token_env, "a non-empty environment variable name");
        if (init.environ_map.get(token_env)) |token| {
            if (token.len < 32) {
                std.debug.print("{s} must contain at least 32 bytes; generate a high-entropy secret and keep it out of command-line arguments\n", .{token_env});
                return error.InvalidArgument;
            }
            var digest: [32]u8 = undefined;
            std.crypto.hash.sha2.Sha256.hash(token, &digest, .{});
            bearer_sha256 = digest;
        }
        const loopback = std.mem.eql(u8, host, "127.0.0.1") or std.mem.eql(u8, host, "::1");
        if (!loopback and bearer_sha256 == null) {
            std.debug.print("refusing an unauthenticated non-loopback bind ({s}); set {s} or bind to 127.0.0.1 behind an authenticating proxy\n", .{ host, token_env });
            return error.InvalidArgument;
        }
        if (allowed_origins.items.len > 0 and bearer_sha256 == null) {
            std.debug.print("--allow-origin requires bearer authentication; set {s} so a browser origin cannot expose an unauthenticated world\n", .{token_env});
            return error.InvalidArgument;
        }
    }

    const wl = try resolveWorld(init, a, save, assets_opt);
    if (wl.bounds.count == 0) {
        std.debug.print("no populated chunks found.\n", .{});
        return;
    }
    const tile_keys = try enumerateTilesSpawnOutward(a, wl.populated, radius, wl.centre_cx, wl.centre_cz, tile_chunks);

    std.debug.print("regions: {d} files · {d} populated chunks · {d} tiles of {d}×{d} chunks — baked on demand\n", .{
        wl.loaded.len, wl.bounds.count, tile_keys.len, tile_chunks, tile_chunks,
    });

    const cpu_count = std.Thread.getCpuCount() catch 4;
    const worker_bytes = estimatedTileWorkingSet(tile_chunks);
    const bake_count = bakeWorkerCount(cpu_count, tile_keys.len, requested_threads, memory_budget, worker_bytes);
    std.debug.print("bakes:   {d} concurrent · {d} MiB budget · ~{d} MiB/worker\n", .{
        bake_count,
        memory_budget / MiB,
        worker_bytes / MiB,
    });

    const sh = try setupShared(init.io, a, wl.assets, wl.loaded, .{
        .tile_chunks = tile_chunks,
        .out_dir = out_dir,
        .quality = quality,
        .blend_biomes = blend_biomes,
        .cave_y = cave_y,
        .gz_level = gz_level,
        // Each tile meshes single-threaded; parallelism comes from serving
        // several tile fetches (browser connections) at once.
        .mesh_threads = 1,
    });

    const tiles_dir = try std.fmt.allocPrint(a, "{s}/tiles", .{out_dir});
    try std.Io.Dir.cwd().createDirPath(init.io, tiles_dir);

    const server = try a.create(LiveServer);
    var known = std.AutoHashMap(u64, void).init(sh.sa);
    for (tile_keys) |key| try known.put(key, {});
    const region_snapshot = if (server_mode)
        try createRegionSnapshot(init.io, wl.region_dir, radius, wl.centre_cx, wl.centre_cz, tile_chunks, null)
    else
        null;
    server.* = .{
        .sh = sh,
        .tile_keys = tile_keys,
        .spawn = wl.spawn,
        .known = known,
        .baked = std.AutoHashMap(u64, BakedTile).init(sh.sa),
        .baking = std.AutoHashMap(u64, void).init(sh.sa),
        .bake_slots = .{ .permits = bake_count },
        .region_dir = if (server_mode) wl.region_dir else null,
        .radius = radius,
        .centre_cx = wl.centre_cx,
        .centre_cz = wl.centre_cz,
        .snapshot = region_snapshot,
        .scan_interval_ns = @as(i96, scan_interval_seconds) * std.time.ns_per_s,
    };

    // Seed the nearest tile synchronously: fail fast if assets/pipeline are
    // broken (rather than per-request in the browser), and start the atlas +
    // maxSectionVerts non-empty so the very first manifest is well-sized.
    const seed_keys = if (region_snapshot) |snapshot| snapshot.tile_keys else tile_keys;
    if (seed_keys.len > 0) {
        var seed = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer seed.deinit();
        const tx: i32 = @bitCast(@as(u32, @truncate(seed_keys[0] >> 32)));
        const tz: i32 = @bitCast(@as(u32, @truncate(seed_keys[0])));
        const regions = if (region_snapshot) |snapshot| snapshot.loaded else sh.loaded;
        const revision = if (region_snapshot) |snapshot| snapshot.tile_revisions.get(seed_keys[0]).? else 0;
        var res: TileResult = .{};
        bakeTileFromRegions(sh, seed.allocator(), regions, tx, tz, false, &res) catch |e| {
            std.debug.print("live: initial bake failed ({s}) — check the world/assets\n", .{@errorName(e)});
            return e;
        };
        server.record(world.packChunk(tx, tz), revision, if (res.written) &res else null);
    }

    std.debug.print("live: rendering on demand — tiles bake as you explore (cache: {s}/tiles)\n", .{out_dir});
    if (server_mode) {
        std.debug.print("server: protocol v1 · auth {s} · endpoint http://{s}:{d}/v1/worlds/default/manifest.json\n", .{
            if (bearer_sha256 == null) "proxy/loopback" else "bearer",
            host,
            port,
        });
    }
    return serve.run(init.io, a, .{
        .dir = out_dir,
        .port = port,
        .host = host,
        .open = open,
        .producer = server.producer(),
        .api = if (server_mode) .{
            .bearer_sha256 = bearer_sha256,
            .allowed_origins = allowed_origins.items,
            .max_connections = max_connections,
        } else null,
    });
}

fn validCorsOrigin(value: []const u8) bool {
    const uri = std.Uri.parse(value) catch return false;
    if (!std.mem.eql(u8, uri.scheme, "http") and !std.mem.eql(u8, uri.scheme, "https")) return false;
    if (uri.host == null or uri.user != null or uri.password != null) return false;
    if (!uri.path.isEmpty() or uri.query != null or uri.fragment != null) return false;
    return true;
}

test "CORS origins are absolute HTTP origins without paths or credentials" {
    try std.testing.expect(validCorsOrigin("https://launcher.example"));
    try std.testing.expect(validCorsOrigin("http://127.0.0.1:3000"));
    try std.testing.expect(!validCorsOrigin("https://launcher.example/path"));
    try std.testing.expect(!validCorsOrigin("https://user@launcher.example"));
    try std.testing.expect(!validCorsOrigin("file:///tmp/launcher"));
    try std.testing.expect(!validCorsOrigin("launcher.example"));
}

fn runExtract(init: std.process.Init, a: std.mem.Allocator, args: []const []const u8) !void {
    const home = init.environ_map.get("HOME") orelse
        init.environ_map.get("USERPROFILE") orelse "";
    const jar = if (args.len >= 1 and !std.mem.startsWith(u8, args[0], "-"))
        args[0]
    else
        (try findClientJar(a, init.io, init.environ_map, home)) orelse {
            std.debug.print(
                \\no Minecraft client jar found under .minecraft/versions.
                \\Pass one explicitly:  vantage extract <path/to/client.jar>
                \\
            , .{});
            return error.NoClientJar;
        };
    const dest = try assetCachePathForJar(a, home, jar);
    const summary = try extract.extractJar(init.io, jar, dest);
    std.debug.print("extracted {d} files ({Bi:.1}) from {s}\n  -> {s}\n", .{ summary.files, summary.bytes, jar, dest });
}

/// When a render finds no cached assets, extract them from the newest local
/// client jar automatically (announcing what happened). Returns the resulting
/// `assets/minecraft` dir, or null when there is nothing to extract from.
fn autoExtract(init: std.process.Init, a: std.mem.Allocator, home: []const u8) !?[]const u8 {
    if (home.len == 0) return null;
    const jar = (try findClientJar(a, init.io, init.environ_map, home)) orelse return null;
    const dest = try assetCachePathForJar(a, home, jar);
    std.debug.print("no cached assets found — extracting from {s} (one-time)\n", .{jar});
    const summary = extract.extractJar(init.io, jar, dest) catch |e| {
        std.debug.print("extraction failed ({t}); pass --assets or run `vantage extract <jar>`\n", .{e});
        return null;
    };
    std.debug.print("extracted {d} files ({Bi:.1}) -> {s}\n", .{ summary.files, summary.bytes, dest });
    return try std.fmt.allocPrint(a, "{s}/assets/minecraft", .{dest});
}

/// `~/.cache/vantage/assets/<version>` for a jar, versioned by the jar's file
/// stem ("26.2.jar" -> "26.2") so `findAssets` picks the newest via its
/// natural version sort.
fn assetCachePathForJar(a: std.mem.Allocator, home: []const u8, jar_path: []const u8) ![]const u8 {
    const base = std.fs.path.basename(jar_path);
    const stem = if (std.mem.endsWith(u8, base, ".jar")) base[0 .. base.len - ".jar".len] else base;
    const name = if (stem.len == 0) "default" else stem;
    return std.fmt.allocPrint(a, "{s}/.cache/vantage/assets/{s}", .{ home, name });
}

/// Find the newest client jar in the local Minecraft installation
/// (`.minecraft/versions/<v>/<v>.jar`), checking the platform's launcher
/// locations. Returns null when Minecraft isn't installed locally.
fn findClientJar(a: std.mem.Allocator, io: std.Io, environ: anytype, home: []const u8) !?[]const u8 {
    var roots_buf: [3][]const u8 = undefined;
    var roots_len: usize = 0;
    if (environ.get("APPDATA")) |appdata| { // Windows launcher default
        roots_buf[roots_len] = try std.fmt.allocPrint(a, "{s}/.minecraft", .{appdata});
        roots_len += 1;
    }
    if (home.len > 0) {
        // macOS launcher default, then the Linux/portable default.
        roots_buf[roots_len] = try std.fmt.allocPrint(a, "{s}/Library/Application Support/minecraft", .{home});
        roots_len += 1;
        roots_buf[roots_len] = try std.fmt.allocPrint(a, "{s}/.minecraft", .{home});
        roots_len += 1;
    }

    // Prefer vanilla-looking versions (they start with a digit: "1.21.11",
    // "26.2", "25w34b") over modded profiles ("fabric-loader-…", "forge-…"),
    // which would otherwise win the lexical tie-break; within a tier, newest
    // wins by natural version order. Modded jars still work as a last resort —
    // most bundle the vanilla assets.
    var best_jar: ?[]const u8 = null;
    var best_name: []const u8 = "";
    var best_vanilla = false;
    for (roots_buf[0..roots_len]) |root| {
        const versions = try std.fmt.allocPrint(a, "{s}/versions", .{root});
        var dir = std.Io.Dir.cwd().openDir(io, versions, .{ .iterate = true }) catch continue;
        defer dir.close(io);
        var it = dir.iterate();
        while (try it.next(io)) |e| {
            if (e.kind != .directory) continue;
            const jar = try std.fmt.allocPrint(a, "{s}/{s}/{s}.jar", .{ versions, e.name, e.name });
            if (!fileExists(io, jar)) continue;
            const vanilla = e.name.len > 0 and std.ascii.isDigit(e.name[0]);
            const better = best_jar == null or
                (vanilla and !best_vanilla) or
                (vanilla == best_vanilla and versionLessThan(best_name, e.name));
            if (better) {
                best_jar = jar;
                best_name = try a.dupe(u8, e.name);
                best_vanilla = vanilla;
            }
        }
    }
    return best_jar;
}

fn fileExists(io: std.Io, path: []const u8) bool {
    var f = std.Io.Dir.cwd().openFile(io, path, .{}) catch return false;
    f.close(io);
    return true;
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
        if (best_path == null or versionLessThan(best_name, e.name)) {
            best_path = candidate;
            best_name = try a.dupe(u8, e.name);
        }
    }
    return best_path;
}

/// Natural-order compare for version-ish directory names, so "1.21.10" beats
/// "1.21.4", and the year-versioned scheme ("26.2", 2026+) beats both (lexical
/// order gets all of these wrong). Digit runs compare numerically, everything
/// else byte-wise. A `-suffix` marks a pre-release, so "26.2" beats
/// "26.2-pre-4" — otherwise auto-picking would prefer release candidates over
/// the release they precede.
fn versionLessThan(a_name: []const u8, b_name: []const u8) bool {
    var i: usize = 0;
    var j: usize = 0;
    while (i < a_name.len and j < b_name.len) {
        const ac = a_name[i];
        const bc = b_name[j];
        if (std.ascii.isDigit(ac) and std.ascii.isDigit(bc)) {
            var ie = i;
            while (ie < a_name.len and std.ascii.isDigit(a_name[ie])) ie += 1;
            var je = j;
            while (je < b_name.len and std.ascii.isDigit(b_name[je])) je += 1;
            const an = std.fmt.parseInt(u64, a_name[i..ie], 10) catch 0;
            const bn = std.fmt.parseInt(u64, b_name[j..je], 10) catch 0;
            if (an != bn) return an < bn;
            i = ie;
            j = je;
        } else {
            if (ac != bc) return ac < bc;
            i += 1;
            j += 1;
        }
    }
    // One name is a prefix of the other. If the remainder starts with `-`, the
    // longer name is a pre-release of the shorter — it sorts BELOW the release.
    if (i >= a_name.len and j < b_name.len and b_name[j] == '-') return false;
    if (j >= b_name.len and i < a_name.len and a_name[i] == '-') return true;
    return (a_name.len - i) < (b_name.len - j);
}

test versionLessThan {
    try std.testing.expect(versionLessThan("1.21.4", "1.21.10"));
    try std.testing.expect(versionLessThan("1.9", "1.21.4"));
    try std.testing.expect(versionLessThan("1.20", "1.20.1"));
    try std.testing.expect(!versionLessThan("1.21.10", "1.21.4"));
    // Year-versioned releases (25.x/26.x, 2026+) sort above every 1.x release.
    try std.testing.expect(versionLessThan("1.21.11", "26.2"));
    try std.testing.expect(versionLessThan("25.4", "26.2"));
    try std.testing.expect(versionLessThan("26.2", "26.10"));
    try std.testing.expect(!versionLessThan("default", "1.21.4") or versionLessThan("1.21.4", "default"));
    // Pre-releases sort below the release they precede, but above older releases.
    try std.testing.expect(versionLessThan("26.2-pre-4", "26.2"));
    try std.testing.expect(!versionLessThan("26.2", "26.2-pre-4"));
    try std.testing.expect(versionLessThan("26.2-pre-4", "26.2-pre-5"));
    try std.testing.expect(versionLessThan("26.1.2", "26.2-pre-4"));
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
    _ = serve;
    _ = discovery;
}
