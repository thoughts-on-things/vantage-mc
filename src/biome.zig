//! Biome colour — read from game data, not hard-coded.
//!
//! Minecraft tints certain block faces (those whose model marks a `tintindex`)
//! by biome. The numbers that drive that tint — temperature, downfall, and any
//! grass/foliage/water overrides — live in the **data pack**
//! (`data/minecraft/worldgen/biome/<name>.json`), not the resource pack. So this
//! module reads them per biome via `Registry` rather than carrying a table, which
//! keeps it correct across Minecraft versions and for modded biomes with no code
//! changes. Grass/foliage colours then come from the vanilla 256×256 colormap
//! gradients (`textures/colormap/{grass,foliage}.png`) indexed by temperature and
//! downfall; water is a flat per-biome colour.
//!
//! What stays in code is *game logic with no data source*: the colormap lookup
//! formula, the `grass_color_modifier` algorithms (swamp/dark_forest), and
//! `blockTint` — which colormap a block uses, which Minecraft hard-codes in Java.
//!
//! The mesher precomputes, per biome present in a grid, the RGB for each `Tint`
//! kind, so per-face tinting is a table lookup (see mesh.zig).

const std = @import("std");
const json = std.json;
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

/// `grass_color_modifier` from the biome's effects — a post-process the game
/// applies to the grass colour (no data source for the algorithm itself).
pub const GrassModifier = enum { none, swamp, dark_forest };

/// Per-biome colour parameters, as read from the data pack. `grass`/`foliage`
/// overrides (0xRRGGBB) win over the colormap when present.
pub const BiomeInfo = struct {
    temperature: f32 = 0.8,
    downfall: f32 = 0.4,
    grass: ?u24 = null,
    foliage: ?u24 = null,
    dry_foliage: ?u24 = null,
    water: u24 = 0x3F76E4, // vanilla default water
    grass_modifier: GrassModifier = .none,
};

/// Temperate default for biomes with no data file (modded/unknown, or when the
/// data pack wasn't extracted) — renders rather than failing.
pub const default_biome: BiomeInfo = .{};

/// Loads and caches biome colour parameters from the data pack. `data_root`
/// points at `data/minecraft` (or is empty when unavailable, in which case every
/// biome resolves to `default_biome`). `missing` counts unresolved lookups so
/// the CLI can warn that biome colours are degraded.
pub const Registry = struct {
    arena: std.mem.Allocator,
    io: std.Io,
    data_root: []const u8,
    cache: std.StringHashMap(BiomeInfo),
    missing: usize = 0,

    pub fn init(arena: std.mem.Allocator, io: std.Io, data_root: []const u8) Registry {
        return .{ .arena = arena, .io = io, .data_root = data_root, .cache = std.StringHashMap(BiomeInfo).init(arena) };
    }

    pub fn lookup(self: *Registry, name: []const u8) BiomeInfo {
        const base = stripNs(name);
        if (self.cache.get(base)) |b| return b;
        const info = self.load(base) catch blk: {
            self.missing += 1;
            break :blk default_biome;
        };
        self.cache.put(base, info) catch {};
        return info;
    }

    fn load(self: *Registry, base: []const u8) !BiomeInfo {
        if (self.data_root.len == 0) return error.NoData;
        const path = try std.fmt.allocPrint(self.arena, "{s}/worldgen/biome/{s}.json", .{ self.data_root, base });
        const bytes = try std.Io.Dir.cwd().readFileAlloc(self.io, path, self.arena, .unlimited);
        const v = try json.parseFromSliceLeaky(json.Value, self.arena, bytes, .{});
        if (v != .object) return error.BadFormat;
        const o = v.object;

        var info: BiomeInfo = .{
            .temperature = asF32(o.get("temperature"), 0.8),
            .downfall = asF32(o.get("downfall"), 0.4),
        };
        if (o.get("effects")) |e| {
            if (e == .object) {
                const eo = e.object;
                info.grass = parseColor(eo.get("grass_color"));
                info.foliage = parseColor(eo.get("foliage_color"));
                info.dry_foliage = parseColor(eo.get("dry_foliage_color"));
                if (parseColor(eo.get("water_color"))) |w| info.water = w;
                info.grass_modifier = parseModifier(eo.get("grass_color_modifier"));
            }
        }
        return info;
    }
};

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
        .grass => grassColor(maps, info),
        .foliage => if (info.foliage) |c| unpackRgb(c) else colormapColor(maps.foliage, info, foliage_fallback),
        .water => unpackRgb(info.water),
        .spruce => .{ 0x61, 0x99, 0x61 }, // FoliageColor.getSpruceColor
        .birch => .{ 0x80, 0xa7, 0x55 }, // FoliageColor.getBirchColor
        .lily => .{ 0x20, 0x80, 0x30 }, // lily pad
    };
}

fn grassColor(maps: Colormaps, info: BiomeInfo) [3]u8 {
    const base = if (info.grass) |c| unpackRgb(c) else colormapColor(maps.grass, info, grass_fallback);
    return applyGrassModifier(base, info.grass_modifier);
}

/// The `grass_color_modifier` post-process, matching the game's `GrassColor`:
/// swamp returns a fixed colour; dark_forest darkens toward 0x28340A.
fn applyGrassModifier(c: [3]u8, m: GrassModifier) [3]u8 {
    return switch (m) {
        .none => c,
        .swamp => .{ 0x6A, 0x70, 0x39 },
        .dark_forest => blk: {
            const packed_c: u32 = (@as(u32, c[0]) << 16) | (@as(u32, c[1]) << 8) | c[2];
            const m2: u32 = ((packed_c & 0xFEFEFE) + 0x28340A) >> 1;
            break :blk .{ @intCast((m2 >> 16) & 0xFF), @intCast((m2 >> 8) & 0xFF), @intCast(m2 & 0xFF) };
        },
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

/// Parse a biome-effects colour, accepting both modern hex strings ("#3f76e4")
/// and the legacy packed-integer form older versions used.
fn parseColor(v: ?json.Value) ?u24 {
    const val = v orelse return null;
    switch (val) {
        .string => |s| {
            const hex = if (s.len > 0 and s[0] == '#') s[1..] else s;
            const n = std.fmt.parseInt(u32, hex, 16) catch return null;
            return @intCast(n & 0xFFFFFF);
        },
        .integer => |i| return @intCast(@as(u32, @intCast(i & 0xFFFFFF))),
        else => return null,
    }
}

fn parseModifier(v: ?json.Value) GrassModifier {
    const val = v orelse return .none;
    if (val != .string) return .none;
    if (std.mem.eql(u8, val.string, "swamp")) return .swamp;
    if (std.mem.eql(u8, val.string, "dark_forest")) return .dark_forest;
    return .none;
}

fn asF32(v: ?json.Value, default: f32) f32 {
    const val = v orelse return default;
    return switch (val) {
        .float => |f| @floatCast(f),
        .integer => |i| @floatFromInt(i),
        else => default,
    };
}

/// Which tint a block's faces use *when the model marks them with a tintindex*.
/// This mapping has no data source — Minecraft hard-codes it in Java (the
/// `BlockColors` registry) — so it stays a heuristic here. Only consulted for
/// tintindex>=0 faces, so the default (grass) is harmless for everything else;
/// new `*_leaves`/`*vine*` blocks classify correctly without changes.
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

test "parseColor accepts hex strings and integers" {
    try std.testing.expectEqual(@as(u24, 0x3F76E4), parseColor(.{ .string = "#3f76e4" }).?);
    try std.testing.expectEqual(@as(u24, 0x90814D), parseColor(.{ .string = "90814d" }).?);
    try std.testing.expectEqual(@as(u24, 0x3F76E4), parseColor(.{ .integer = 4159204 }).?);
    try std.testing.expect(parseColor(null) == null);
    try std.testing.expect(parseColor(.{ .bool = true }) == null);
}

test "grass_color_modifier matches the game's algorithm" {
    // swamp ignores the input and returns a fixed colour.
    try std.testing.expectEqual([3]u8{ 0x6A, 0x70, 0x39 }, applyGrassModifier(.{ 0x91, 0xBD, 0x59 }, .swamp));
    // dark_forest: ((c & 0xFEFEFE) + 0x28340A) >> 1 on the packed value.
    // plains grass 0x91BD59 -> (0x90BC58 + 0x28340A)>>1 = 0xB8F062>>1 = 0x5C7831.
    try std.testing.expectEqual([3]u8{ 0x5C, 0x78, 0x31 }, applyGrassModifier(.{ 0x91, 0xBD, 0x59 }, .dark_forest));
    // none is identity.
    try std.testing.expectEqual([3]u8{ 0x91, 0xBD, 0x59 }, applyGrassModifier(.{ 0x91, 0xBD, 0x59 }, .none));
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
    const badlands: BiomeInfo = .{ .temperature = 2.0, .downfall = 0.0, .grass = 0x90814D, .foliage = 0x9E814D };
    try std.testing.expectEqual([3]u8{ 0x90, 0x81, 0x4D }, colorFor(maps, .grass, badlands));
    try std.testing.expectEqual([3]u8{ 0x9E, 0x81, 0x4D }, colorFor(maps, .foliage, badlands));
    try std.testing.expectEqual([3]u8{ 0x61, 0x99, 0x61 }, colorFor(maps, .spruce, default_biome));
    const warm_ocean: BiomeInfo = .{ .temperature = 0.5, .downfall = 0.5, .water = 0x43D5EE };
    try std.testing.expectEqual([3]u8{ 0x43, 0xD5, 0xEE }, colorFor(maps, .water, warm_ocean));
}
