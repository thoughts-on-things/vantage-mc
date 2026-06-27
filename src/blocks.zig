//! P1 block appearance table.
//!
//! A *temporary* stand-in for the full model/texture resolver (P2). It maps a
//! block name to a single average sRGB color and a `solid` flag used purely for
//! face culling. Every non-air block is treated as a full opaque cube — good
//! enough to get recognizable terrain into a browser, and thrown away wholesale
//! once the real resource-pack resolver lands.
//!
//! Lookup rules:
//!   * air variants            -> not solid, never drawn
//!   * known names (table)     -> solid, curated average color
//!   * unknown non-air names    -> solid, deterministic hash color (so nothing
//!                                is silently invisible while we build out P2)

const std = @import("std");

pub const Block = struct {
    solid: bool,
    color: [3]u8,
};

pub const air: Block = .{ .solid = false, .color = .{ 0, 0, 0 } };

pub fn isAir(name: []const u8) bool {
    return std.mem.eql(u8, name, "minecraft:air") or
        std.mem.eql(u8, name, "minecraft:cave_air") or
        std.mem.eql(u8, name, "minecraft:void_air");
}

/// Strip a leading `minecraft:` (or any `namespace:`) so the table keys stay short.
fn baseName(name: []const u8) []const u8 {
    if (std.mem.indexOfScalar(u8, name, ':')) |i| return name[i + 1 ..];
    return name;
}

pub fn lookup(name: []const u8) Block {
    if (isAir(name)) return air;
    const base = baseName(name);
    if (table.get(base)) |rgb| return .{ .solid = true, .color = rgb };
    return .{ .solid = true, .color = hashColor(base) };
}

/// Deterministic, reasonably-saturated fallback color for an unknown block so it
/// stands out against the curated palette but is stable across runs.
fn hashColor(base: []const u8) [3]u8 {
    var h: u64 = 1469598103934665603; // FNV-1a
    for (base) |c| {
        h ^= c;
        h *%= 1099511628211;
    }
    // Spread the hash over a mid-bright color; avoid near-black / near-white.
    return .{
        @intCast(80 + (h >> 0 & 0x7F)),
        @intCast(80 + (h >> 16 & 0x7F)),
        @intCast(80 + (h >> 32 & 0x7F)),
    };
}

/// Curated average colors for common overworld blocks (keys are namespace-stripped).
/// Values are eyeballed averages of the vanilla textures; biome tint is ignored
/// for P1 (grass/leaves/water use a representative plains/temperate color).
const table = std.StaticStringMap([3]u8).initComptime(.{
    // stone family
    .{ "stone", [3]u8{ 127, 127, 127 } },
    .{ "cobblestone", [3]u8{ 122, 122, 122 } },
    .{ "deepslate", [3]u8{ 70, 70, 74 } },
    .{ "cobbled_deepslate", [3]u8{ 77, 77, 80 } },
    .{ "granite", [3]u8{ 149, 103, 85 } },
    .{ "diorite", [3]u8{ 188, 188, 190 } },
    .{ "andesite", [3]u8{ 136, 138, 138 } },
    .{ "tuff", [3]u8{ 108, 109, 102 } },
    .{ "calcite", [3]u8{ 223, 224, 220 } },
    .{ "dripstone_block", [3]u8{ 130, 100, 85 } },
    .{ "bedrock", [3]u8{ 85, 85, 85 } },
    .{ "gravel", [3]u8{ 131, 127, 126 } },
    .{ "smooth_stone", [3]u8{ 158, 158, 158 } },
    .{ "stone_bricks", [3]u8{ 122, 122, 122 } },

    // dirt / surface
    .{ "dirt", [3]u8{ 134, 96, 67 } },
    .{ "coarse_dirt", [3]u8{ 119, 85, 59 } },
    .{ "rooted_dirt", [3]u8{ 144, 110, 82 } },
    .{ "grass_block", [3]u8{ 110, 162, 71 } },
    .{ "dirt_path", [3]u8{ 148, 122, 65 } },
    .{ "farmland", [3]u8{ 95, 64, 38 } },
    .{ "podzol", [3]u8{ 91, 67, 32 } },
    .{ "mycelium", [3]u8{ 111, 99, 100 } },
    .{ "moss_block", [3]u8{ 89, 109, 45 } },
    .{ "mud", [3]u8{ 60, 54, 52 } },
    .{ "clay", [3]u8{ 160, 166, 179 } },
    .{ "snow", [3]u8{ 240, 245, 247 } },
    .{ "snow_block", [3]u8{ 240, 245, 247 } },
    .{ "powder_snow", [3]u8{ 245, 248, 250 } },

    // sand
    .{ "sand", [3]u8{ 219, 207, 163 } },
    .{ "red_sand", [3]u8{ 190, 102, 33 } },
    .{ "sandstone", [3]u8{ 216, 203, 155 } },

    // water / ice / lava
    .{ "water", [3]u8{ 60, 110, 200 } },
    .{ "ice", [3]u8{ 160, 190, 230 } },
    .{ "packed_ice", [3]u8{ 140, 180, 225 } },
    .{ "blue_ice", [3]u8{ 130, 175, 230 } },
    .{ "lava", [3]u8{ 207, 92, 23 } },
    .{ "magma_block", [3]u8{ 140, 70, 40 } },

    // ores
    .{ "coal_ore", [3]u8{ 96, 96, 96 } },
    .{ "deepslate_coal_ore", [3]u8{ 66, 66, 70 } },
    .{ "iron_ore", [3]u8{ 140, 127, 114 } },
    .{ "deepslate_iron_ore", [3]u8{ 95, 90, 92 } },
    .{ "copper_ore", [3]u8{ 140, 120, 100 } },
    .{ "gold_ore", [3]u8{ 150, 140, 95 } },
    .{ "redstone_ore", [3]u8{ 140, 95, 95 } },
    .{ "deepslate_redstone_ore", [3]u8{ 95, 70, 72 } },
    .{ "lapis_ore", [3]u8{ 100, 110, 140 } },
    .{ "diamond_ore", [3]u8{ 110, 150, 150 } },
    .{ "emerald_ore", [3]u8{ 110, 150, 120 } },

    // wood
    .{ "oak_log", [3]u8{ 102, 81, 50 } },
    .{ "spruce_log", [3]u8{ 60, 46, 30 } },
    .{ "birch_log", [3]u8{ 200, 196, 184 } },
    .{ "jungle_log", [3]u8{ 110, 86, 52 } },
    .{ "acacia_log", [3]u8{ 105, 70, 45 } },
    .{ "dark_oak_log", [3]u8{ 60, 45, 26 } },
    .{ "mangrove_log", [3]u8{ 90, 50, 45 } },
    .{ "oak_planks", [3]u8{ 162, 130, 78 } },
    .{ "spruce_planks", [3]u8{ 114, 84, 48 } },
    .{ "oak_leaves", [3]u8{ 70, 120, 50 } },
    .{ "spruce_leaves", [3]u8{ 56, 86, 56 } },
    .{ "birch_leaves", [3]u8{ 80, 120, 55 } },
    .{ "jungle_leaves", [3]u8{ 60, 120, 30 } },
    .{ "dark_oak_leaves", [3]u8{ 60, 100, 40 } },

    // nether / misc
    .{ "netherrack", [3]u8{ 97, 38, 38 } },
    .{ "soul_sand", [3]u8{ 85, 65, 52 } },
    .{ "soul_soil", [3]u8{ 78, 60, 48 } },
    .{ "obsidian", [3]u8{ 20, 18, 30 } },
    .{ "glowstone", [3]u8{ 200, 170, 100 } },
    .{ "glass", [3]u8{ 200, 225, 235 } },
    .{ "terracotta", [3]u8{ 152, 94, 67 } },
    .{ "amethyst_block", [3]u8{ 150, 110, 200 } },
    .{ "pumpkin", [3]u8{ 198, 118, 24 } },
    .{ "melon", [3]u8{ 110, 150, 40 } },
    .{ "hay_block", [3]u8{ 178, 147, 22 } },
});

test "air is not solid; air variants recognized" {
    try std.testing.expect(!lookup("minecraft:air").solid);
    try std.testing.expect(!lookup("minecraft:cave_air").solid);
    try std.testing.expect(!lookup("minecraft:void_air").solid);
}

test "known block returns curated color" {
    const b = lookup("minecraft:stone");
    try std.testing.expect(b.solid);
    try std.testing.expectEqual([3]u8{ 127, 127, 127 }, b.color);
}

test "namespace stripping and unknown hash fallback" {
    try std.testing.expectEqual([3]u8{ 134, 96, 67 }, lookup("dirt").color);
    const u = lookup("minecraft:totally_made_up_block");
    try std.testing.expect(u.solid);
    // Deterministic across calls.
    try std.testing.expectEqual(u.color, lookup("minecraft:totally_made_up_block").color);
}
