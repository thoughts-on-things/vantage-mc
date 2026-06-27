//! Minimal language-file reader — human-readable display names from game data.
//!
//! `assets/minecraft/lang/en_us.json` is a flat `{ "key": "Display Name" }` map.
//! We use it so the biome legend reads "Dripstone Caves" instead of the raw
//! `dripstone_caves` id, with no per-name table of our own. Missing file or key
//! falls back to a prettified id, so it always produces something readable.

const std = @import("std");
const json = std.json;

pub const Lang = struct {
    map: std.StringHashMap([]const u8),

    /// Load `<assets_root>/lang/en_us.json`. Any failure yields an empty map
    /// (callers then fall back to prettified ids).
    pub fn load(arena: std.mem.Allocator, io: std.Io, assets_root: []const u8) Lang {
        var self: Lang = .{ .map = std.StringHashMap([]const u8).init(arena) };
        const path = std.fmt.allocPrint(arena, "{s}/lang/en_us.json", .{assets_root}) catch return self;
        const bytes = std.Io.Dir.cwd().readFileAlloc(io, path, arena, .unlimited) catch return self;
        const v = json.parseFromSliceLeaky(json.Value, arena, bytes, .{}) catch return self;
        if (v != .object) return self;
        var it = v.object.iterator();
        while (it.next()) |e| {
            if (e.value_ptr.* == .string) self.map.put(e.key_ptr.*, e.value_ptr.*.string) catch {};
        }
        return self;
    }

    pub fn get(self: Lang, key: []const u8) ?[]const u8 {
        return self.map.get(key);
    }

    /// Display name for a biome id (e.g. "minecraft:dripstone_caves"), via the
    /// `biome.<namespace>.<path>` translation key, falling back to a prettified
    /// id ("dripstone_caves" -> "Dripstone Caves").
    pub fn biomeName(self: Lang, arena: std.mem.Allocator, id: []const u8) []const u8 {
        var ns: []const u8 = "minecraft";
        var path: []const u8 = id;
        if (std.mem.indexOfScalar(u8, id, ':')) |i| {
            ns = id[0..i];
            path = id[i + 1 ..];
        }
        const key = std.fmt.allocPrint(arena, "biome.{s}.{s}", .{ ns, path }) catch return prettify(arena, path);
        return self.get(key) orelse prettify(arena, path);
    }
};

/// "dripstone_caves" -> "Dripstone Caves". Falls back to the input on alloc fail.
pub fn prettify(arena: std.mem.Allocator, base: []const u8) []const u8 {
    const buf = arena.alloc(u8, base.len) catch return base;
    @memcpy(buf, base);
    var cap = true;
    for (buf) |*ch| {
        if (ch.* == '_') {
            ch.* = ' ';
            cap = true;
        } else if (cap and ch.* >= 'a' and ch.* <= 'z') {
            ch.* = ch.* - 32;
            cap = false;
        } else {
            cap = false;
        }
    }
    return buf;
}

test "prettify title-cases and de-snakes" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try std.testing.expectEqualStrings("Dripstone Caves", prettify(a, "dripstone_caves"));
    try std.testing.expectEqualStrings("Plains", prettify(a, "plains"));
    try std.testing.expectEqualStrings("Old Growth Pine Taiga", prettify(a, "old_growth_pine_taiga"));
}

test "biomeName falls back to prettified id when lang is empty" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const lang: Lang = .{ .map = std.StringHashMap([]const u8).init(a) };
    try std.testing.expectEqualStrings("Deep Dark", lang.biomeName(a, "minecraft:deep_dark"));
}
