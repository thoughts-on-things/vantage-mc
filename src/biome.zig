//! Biome colour data — what makes grass plains-green and savanna-gold.
//!
//! Minecraft tints certain block faces (those whose model marks a `tintindex`)
//! by biome. Grass and foliage colours come from two 256×256 gradient images
//! (`textures/colormap/{grass,foliage}.png`) indexed by the biome's temperature
//! and downfall; water is a flat per-biome constant; a few biomes hard-override
//! grass/foliage outright (badlands, swamp). This module owns:
//!
//!   * a curated table of vanilla biome temperature/downfall/overrides,
//!   * the colormap-lookup formula (the same math the game uses),
//!   * `blockTint` — which colormap (if any) a given block's tinted faces use.
//!
//! The mesher precomputes, per biome present in a grid, the RGB for each `Tint`
//! kind, so per-face tinting is a table lookup (see mesh.zig).

const std = @import("std");
const texture = @import("texture.zig");

pub const COLORMAP_DIM = 256;

/// Strip a leading `namespace:` (e.g. "minecraft:plains" -> "plains").
fn stripNs(name: []const u8) []const u8 {
    if (std.mem.indexOfScalar(u8, name, ':')) |i| return name[i + 1 ..];
    return name;
}

/// The colour source for a tinted block face. Most are biome-dependent; spruce,
/// birch and lily are biome-independent constants the game also hard-codes.
pub const Tint = enum(u8) {
    none = 0,
    grass,
    foliage,
    water,
    spruce,
    birch,
    lily,

    pub const count = 7;
};

/// Per-biome colour parameters. `grass`/`foliage` overrides (0xRRGGBB) win over
/// the colormap when present; `water` is always a flat constant.
pub const BiomeInfo = struct {
    temperature: f32,
    downfall: f32,
    grass: ?u24 = null,
    foliage: ?u24 = null,
    water: u24 = 0x3F76E4, // vanilla default water
};

/// Default for any biome not in the table (plains-like temperate).
pub const default_biome: BiomeInfo = .{ .temperature = 0.8, .downfall = 0.4 };

pub fn lookup(name: []const u8) BiomeInfo {
    return table.get(stripNs(name)) orelse default_biome;
}

/// Loaded 256×256 RGBA colormaps. Either may be empty if the asset is missing,
/// in which case a plains-ish fallback colour is used.
pub const Colormaps = struct {
    grass: []const u8 = &.{},
    foliage: []const u8 = &.{},

    pub fn load(arena: std.mem.Allocator, io: std.Io, root: []const u8) Colormaps {
        return .{
            .grass = loadOne(arena, io, root, "grass"),
            .foliage = loadOne(arena, io, root, "foliage"),
        };
    }

    fn loadOne(arena: std.mem.Allocator, io: std.Io, root: []const u8, which: []const u8) []const u8 {
        const path = std.fmt.allocPrint(arena, "{s}/textures/colormap/{s}.png", .{ root, which }) catch return &.{};
        const dec = texture.decodeRgba(arena, io, path) catch return &.{};
        if (dec.width != COLORMAP_DIM or dec.height != COLORMAP_DIM) return &.{};
        return dec.pixels;
    }
};

/// Plains-ish fallbacks for when a colormap asset is absent.
const grass_fallback: [3]u8 = .{ 121, 182, 91 };
const foliage_fallback: [3]u8 = .{ 110, 160, 80 };

/// Final RGB for a tint kind in a given biome. Pure given the colormaps.
pub fn colorFor(maps: Colormaps, tint: Tint, info: BiomeInfo) [3]u8 {
    return switch (tint) {
        .none => .{ 255, 255, 255 },
        .grass => if (info.grass) |c| unpackRgb(c) else colormapColor(maps.grass, info, grass_fallback),
        .foliage => if (info.foliage) |c| unpackRgb(c) else colormapColor(maps.foliage, info, foliage_fallback),
        .water => unpackRgb(info.water),
        .spruce => .{ 0x61, 0x99, 0x61 }, // FoliageColor.getSpruceColor
        .birch => .{ 0x80, 0xa7, 0x55 }, // FoliageColor.getBirchColor
        .lily => .{ 0x20, 0x80, 0x30 }, // lily pad
    };
}

/// The colormap lookup the game uses: clamp temp/downfall to [0,1], scale
/// downfall by temperature, then index the triangular gradient at
/// (x=(1-t)*255, y=(1-d)*255).
fn colormapColor(map: []const u8, info: BiomeInfo, fallback: [3]u8) [3]u8 {
    if (map.len < COLORMAP_DIM * COLORMAP_DIM * 4) return fallback;
    const t = std.math.clamp(info.temperature, 0.0, 1.0);
    const d = std.math.clamp(info.downfall, 0.0, 1.0) * t;
    const x: usize = @intFromFloat((1.0 - t) * 255.0);
    const y: usize = @intFromFloat((1.0 - d) * 255.0);
    const idx = (y * COLORMAP_DIM + x) * 4;
    return .{ map[idx + 0], map[idx + 1], map[idx + 2] };
}

fn unpackRgb(c: u24) [3]u8 {
    return .{ @intCast((c >> 16) & 0xFF), @intCast((c >> 8) & 0xFF), @intCast(c & 0xFF) };
}

/// Which tint a block's faces use *when the model marks them with a tintindex*.
/// Only consulted for tintindex>=0 faces, so the default (grass) is harmless for
/// everything else. Names are namespace-stripped before matching.
pub fn blockTint(name: []const u8) Tint {
    const b = stripNs(name);
    if (std.mem.endsWith(u8, b, "_leaves") or std.mem.eql(u8, b, "leaves")) {
        if (std.mem.indexOf(u8, b, "spruce") != null) return .spruce;
        if (std.mem.indexOf(u8, b, "birch") != null) return .birch;
        return .foliage;
    }
    if (std.mem.eql(u8, b, "lily_pad")) return .lily;
    if (std.mem.indexOf(u8, b, "vine") != null) return .foliage;
    if (std.mem.eql(u8, b, "water") or
        std.mem.eql(u8, b, "bubble_column") or
        std.mem.eql(u8, b, "water_cauldron")) return .water;
    // grass family, sugar cane, and anything else tinted defaults to grass.
    return .grass;
}

/// Curated vanilla biome temperature/downfall (+ a few colour overrides). Values
/// match the vanilla worldgen biome JSONs (which live in the data pack, not the
/// assets we read). Biomes absent here fall back to `default_biome`.
const table = std.StaticStringMap(BiomeInfo).initComptime(.{
    // temperate
    .{ "plains", BiomeInfo{ .temperature = 0.8, .downfall = 0.4 } },
    .{ "sunflower_plains", BiomeInfo{ .temperature = 0.8, .downfall = 0.4 } },
    .{ "meadow", BiomeInfo{ .temperature = 0.5, .downfall = 0.8, .water = 0x0E4ECF } },
    .{ "forest", BiomeInfo{ .temperature = 0.7, .downfall = 0.8 } },
    .{ "flower_forest", BiomeInfo{ .temperature = 0.7, .downfall = 0.8 } },
    .{ "birch_forest", BiomeInfo{ .temperature = 0.6, .downfall = 0.6 } },
    .{ "old_growth_birch_forest", BiomeInfo{ .temperature = 0.6, .downfall = 0.6 } },
    .{ "dark_forest", BiomeInfo{ .temperature = 0.7, .downfall = 0.8 } },
    .{ "cherry_grove", BiomeInfo{ .temperature = 0.5, .downfall = 0.8, .grass = 0xB6DB61, .foliage = 0xB6DB61, .water = 0x5DB7EF } },

    // cold / taiga
    .{ "taiga", BiomeInfo{ .temperature = 0.25, .downfall = 0.8 } },
    .{ "snowy_taiga", BiomeInfo{ .temperature = -0.5, .downfall = 0.4, .water = 0x3D57D6 } },
    .{ "old_growth_pine_taiga", BiomeInfo{ .temperature = 0.3, .downfall = 0.8 } },
    .{ "old_growth_spruce_taiga", BiomeInfo{ .temperature = 0.25, .downfall = 0.8 } },
    .{ "grove", BiomeInfo{ .temperature = -0.2, .downfall = 0.8 } },
    .{ "snowy_plains", BiomeInfo{ .temperature = 0.0, .downfall = 0.5 } },
    .{ "ice_spikes", BiomeInfo{ .temperature = 0.0, .downfall = 0.5 } },
    .{ "snowy_slopes", BiomeInfo{ .temperature = -0.3, .downfall = 0.9 } },
    .{ "frozen_peaks", BiomeInfo{ .temperature = -0.7, .downfall = 0.9 } },
    .{ "jagged_peaks", BiomeInfo{ .temperature = -0.7, .downfall = 0.9 } },
    .{ "stony_peaks", BiomeInfo{ .temperature = 1.0, .downfall = 0.3 } },

    // warm / dry
    .{ "savanna", BiomeInfo{ .temperature = 2.0, .downfall = 0.0 } },
    .{ "savanna_plateau", BiomeInfo{ .temperature = 2.0, .downfall = 0.0 } },
    .{ "windswept_savanna", BiomeInfo{ .temperature = 2.0, .downfall = 0.0 } },
    .{ "desert", BiomeInfo{ .temperature = 2.0, .downfall = 0.0 } },
    .{ "badlands", BiomeInfo{ .temperature = 2.0, .downfall = 0.0, .grass = 0x90814D, .foliage = 0x9E814D } },
    .{ "eroded_badlands", BiomeInfo{ .temperature = 2.0, .downfall = 0.0, .grass = 0x90814D, .foliage = 0x9E814D } },
    .{ "wooded_badlands", BiomeInfo{ .temperature = 2.0, .downfall = 0.0, .grass = 0x90814D, .foliage = 0x9E814D } },

    // windswept hills
    .{ "windswept_hills", BiomeInfo{ .temperature = 0.2, .downfall = 0.3 } },
    .{ "windswept_gravelly_hills", BiomeInfo{ .temperature = 0.2, .downfall = 0.3 } },
    .{ "windswept_forest", BiomeInfo{ .temperature = 0.2, .downfall = 0.3 } },
    .{ "stony_shore", BiomeInfo{ .temperature = 0.2, .downfall = 0.3 } },

    // jungle
    .{ "jungle", BiomeInfo{ .temperature = 0.95, .downfall = 0.9 } },
    .{ "sparse_jungle", BiomeInfo{ .temperature = 0.95, .downfall = 0.8 } },
    .{ "bamboo_jungle", BiomeInfo{ .temperature = 0.95, .downfall = 0.9 } },

    // swamp (grass/foliage are special-cased in game; approximate constants)
    .{ "swamp", BiomeInfo{ .temperature = 0.8, .downfall = 0.9, .grass = 0x6A7039, .foliage = 0x6A7039, .water = 0x617B64 } },
    .{ "mangrove_swamp", BiomeInfo{ .temperature = 0.8, .downfall = 0.9, .grass = 0x6A7039, .foliage = 0x8DB127, .water = 0x3A7A6A } },

    // mushroom / caves / special
    .{ "mushroom_fields", BiomeInfo{ .temperature = 0.9, .downfall = 1.0 } },
    .{ "dripstone_caves", BiomeInfo{ .temperature = 0.8, .downfall = 0.4 } },
    .{ "lush_caves", BiomeInfo{ .temperature = 0.5, .downfall = 0.5 } },
    .{ "deep_dark", BiomeInfo{ .temperature = 0.8, .downfall = 0.4 } },

    // beaches / rivers
    .{ "beach", BiomeInfo{ .temperature = 0.8, .downfall = 0.4 } },
    .{ "snowy_beach", BiomeInfo{ .temperature = 0.05, .downfall = 0.3, .water = 0x3D57D6 } },
    .{ "river", BiomeInfo{ .temperature = 0.5, .downfall = 0.5 } },
    .{ "frozen_river", BiomeInfo{ .temperature = 0.0, .downfall = 0.5, .water = 0x3938C9 } },

    // oceans (water colour is the visible difference)
    .{ "ocean", BiomeInfo{ .temperature = 0.5, .downfall = 0.5 } },
    .{ "deep_ocean", BiomeInfo{ .temperature = 0.5, .downfall = 0.5 } },
    .{ "warm_ocean", BiomeInfo{ .temperature = 0.5, .downfall = 0.5, .water = 0x43D5EE } },
    .{ "lukewarm_ocean", BiomeInfo{ .temperature = 0.5, .downfall = 0.5, .water = 0x45ADF5 } },
    .{ "deep_lukewarm_ocean", BiomeInfo{ .temperature = 0.5, .downfall = 0.5, .water = 0x45ADF5 } },
    .{ "cold_ocean", BiomeInfo{ .temperature = 0.5, .downfall = 0.5, .water = 0x3D57D6 } },
    .{ "deep_cold_ocean", BiomeInfo{ .temperature = 0.5, .downfall = 0.5, .water = 0x3D57D6 } },
    .{ "frozen_ocean", BiomeInfo{ .temperature = 0.0, .downfall = 0.5, .water = 0x3938C9 } },
    .{ "deep_frozen_ocean", BiomeInfo{ .temperature = 0.5, .downfall = 0.5, .water = 0x3938C9 } },
});

test "blockTint classification" {
    try std.testing.expectEqual(Tint.grass, blockTint("minecraft:grass_block"));
    try std.testing.expectEqual(Tint.grass, blockTint("minecraft:short_grass"));
    try std.testing.expectEqual(Tint.grass, blockTint("minecraft:sugar_cane"));
    try std.testing.expectEqual(Tint.foliage, blockTint("minecraft:oak_leaves"));
    try std.testing.expectEqual(Tint.foliage, blockTint("minecraft:jungle_leaves"));
    try std.testing.expectEqual(Tint.spruce, blockTint("minecraft:spruce_leaves"));
    try std.testing.expectEqual(Tint.birch, blockTint("minecraft:birch_leaves"));
    try std.testing.expectEqual(Tint.water, blockTint("minecraft:water"));
    try std.testing.expectEqual(Tint.lily, blockTint("minecraft:lily_pad"));
    try std.testing.expectEqual(Tint.foliage, blockTint("minecraft:vine"));
}

test "biome table lookup + default fallback" {
    try std.testing.expectEqual(@as(f32, 2.0), lookup("minecraft:savanna").temperature);
    try std.testing.expectEqual(@as(f32, 0.0), lookup("savanna").downfall);
    try std.testing.expectEqual(@as(u24, 0x90814D), lookup("minecraft:badlands").grass.?);
    // unknown -> default plains-like
    try std.testing.expectEqual(@as(f32, 0.8), lookup("minecraft:made_up").temperature);
}

test "colormap lookup samples the (1-t, 1-d) corner of a gradient" {
    const a = std.testing.allocator;
    // Synthetic 256x256 map where pixel (x,y) encodes (x, y, 0).
    const map = try a.alloc(u8, COLORMAP_DIM * COLORMAP_DIM * 4);
    defer a.free(map);
    var y: usize = 0;
    while (y < COLORMAP_DIM) : (y += 1) {
        var x: usize = 0;
        while (x < COLORMAP_DIM) : (x += 1) {
            const i = (y * COLORMAP_DIM + x) * 4;
            map[i + 0] = @intCast(x);
            map[i + 1] = @intCast(y);
            map[i + 2] = 0;
            map[i + 3] = 255;
        }
    }
    const maps: Colormaps = .{ .grass = map, .foliage = map };
    // hot & dry (savanna 2.0/0.0): t clamps to 1 -> x=0; d=0 -> y=255.
    const hot = colorFor(maps, .grass, .{ .temperature = 2.0, .downfall = 0.0 });
    try std.testing.expectEqual(@as(u8, 0), hot[0]); // x
    try std.testing.expectEqual(@as(u8, 255), hot[1]); // y
    // temperate plains (0.8/0.4): x=(1-0.8)*255≈50.99 -> 50 (int truncation, as
    // in game); d=0.4*0.8=0.32 -> y=(1-0.32)*255≈173.4 -> 173.
    const plains = colorFor(maps, .grass, .{ .temperature = 0.8, .downfall = 0.4 });
    try std.testing.expectEqual(@as(u8, 50), plains[0]);
    try std.testing.expectEqual(@as(u8, 173), plains[1]);
}

test "overrides and constants bypass the colormap" {
    const maps: Colormaps = .{}; // empty -> would hit fallback for colormap kinds
    const bad = colorFor(maps, .grass, lookup("minecraft:badlands"));
    try std.testing.expectEqual([3]u8{ 0x90, 0x81, 0x4D }, bad);
    const spruce = colorFor(maps, .spruce, default_biome);
    try std.testing.expectEqual([3]u8{ 0x61, 0x99, 0x61 }, spruce);
    const water = colorFor(maps, .water, lookup("minecraft:warm_ocean"));
    try std.testing.expectEqual([3]u8{ 0x43, 0xD5, 0xEE }, water);
}
