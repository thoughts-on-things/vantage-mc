//! Vantage CLI.
//!
//! Subcommands:
//!   vantage mesh  <region.mca> <out.vtile> [cx0 cz0 cx1 cz1]
//!       Decode a rectangular range of chunks (region-local coords 0..31,
//!       inclusive; default 0 0 0 0 = one chunk), build a culled cube mesh, and
//!       write a v1 `.vtile`. This is the P1 vertical slice: world file -> tile.
//!
//!   vantage histo <region.mca> [localX localZ]
//!       P0-style block histogram for one chunk (default 0 0). Also runs when no
//!       subcommand is given, for back-compat: `vantage <region.mca> [lx lz]`.

const std = @import("std");
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

pub fn main(init: std.process.Init) !void {
    const a = init.arena.allocator();
    const args = try init.minimal.args.toSlice(a);
    if (args.len < 2) return usage();

    // Dispatch. If args[1] is a known subcommand use it, else treat args[1] as a
    // region path for the legacy histogram form.
    if (std.mem.eql(u8, args[1], "mesh")) {
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
        \\  vantage mesh    <region.mca> <out.vtile> [cx0 cz0 cx1 cz1]
        \\  vantage meshtex <region.mca> <out.vtile> <assets/minecraft dir> [cx0 cz0 cx1 cz1]
        \\  vantage histo   <region.mca> [localX localZ]
        \\  vantage biomes  <region.mca> [cx0 cz0 cx1 cz1]
        \\  vantage resolve <assets/minecraft dir> <block-name>
        \\  vantage texinfo <assets/minecraft dir> <block-name...>
        \\
    , .{});
    return error.MissingArgument;
}

fn runTexinfo(init: std.process.Init, a: std.mem.Allocator, args: []const []const u8) !void {
    if (args.len < 2) return usage();
    const root = args[0];
    const resolver: model.Resolver = .{ .arena = a, .io = init.io, .root = root };
    var builder = try texture.Builder.init(a, init.io, root);

    // Track which (texture -> layer) we assign so we can report a sample pixel.
    var samples: std.ArrayList([]const u8) = .empty;
    for (args[1..]) |block| {
        const parts = resolver.resolveBlock(block) catch |e| {
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

    const resolver: model.Resolver = .{ .arena = a, .io = init.io, .root = root };
    const parts = try resolver.resolveBlock(block);

    std.debug.print("block: {s}\nassets: {s}\nparts: {d}\n", .{ block, root, parts.len });
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
    const m = try mesh.buildTextured(a, g, resolver, &builder, maps);
    const arr = try builder.finish();

    const geo = try tile.serializeTexturedBiome(a, m, g.biome_names);
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
        \\mesh:      {d} vertices, {d} triangles
        \\tile:      {s}  ({d} bytes)
        \\texarray:  {s}  ({d} bytes)
        \\
    , .{
        region_path,           assets,
        stats.chunks_loaded,   stats.chunks_missing,
        cx0,                   cz0,
        cx1,                   cz1,
        stats.distinct_blocks, stats.distinct_biomes,
        g.sx,                  g.sy,
        g.sz,                  g.min_y,
        arr.layer_count,       arr.width,
        arr.height,            m.vertex_count,
        m.triangleCount(),     out_path,
        geo.len,               tex_path,
        tex_blob.len,
    });

    // Resolved tint colours per biome present — confirms the colormap loaded and
    // that biomes map to distinct grass/foliage/water (savanna gold vs plains green).
    if (g.biome_names.len > 1) {
        std.debug.print("biome tints (grass / foliage / water):\n", .{});
        for (g.biome_names[1..]) |bname| {
            const info = biome.lookup(bname);
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
    }
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
}
