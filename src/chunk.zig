//! Chunk decode: parsed NBT root -> per-section block grids.
//!
//! A modern (1.18+) chunk stores its blocks in up to 24 sections of 16^3.
//! Each section's `block_states` holds a `palette` (list of block-state
//! entries; see `decodePaletteEntry` for the accepted forms) and an optional packed `data` long-array
//! of palette indices in the non-spanning post-1.16 layout. We unpack each
//! section into a flat `[]u16` of palette indices in Minecraft's YZX order
//! (index = (y*16 + z)*16 + x), which the grid assembler then reads.
//!
//! Each section also carries a `biomes` paletted array, but at 4×4×4 (one cell
//! per 4³ blocks = 64 cells/section). Its palette entries are plain strings (not
//! compounds), and the packed layout uses a *1*-bit minimum (vs 4 for blocks)
//! with no minimum-4 floor — so a 2-biome section packs at 1 bit/cell.

const std = @import("std");
const nbt = @import("nbt.zig");

pub const SECTION_DIM = 16;
pub const SECTION_BLOCKS = SECTION_DIM * SECTION_DIM * SECTION_DIM; // 4096
pub const BIOME_DIM = 4; // biomes are stored at 4×4×4 per section
pub const BIOME_CELLS = BIOME_DIM * BIOME_DIM * BIOME_DIM; // 64

pub const Section = struct {
    /// Section Y index (signed; e.g. -4..19 for a -64..320 world).
    y: i32,
    /// Palette block names (slices into the NBT arena).
    names: [][]const u8,
    /// Per-palette-entry normalized block-state key ("axis=x", "facing=north,
    /// half=bottom", …), sorted by property; "" when the entry has no Properties.
    states: [][]const u8,
    /// 4096 palette indices in YZX order. For a single-entry palette this is
    /// empty and every block is `names[0]`.
    indices: []u16,
    /// Biome palette names (slices into the NBT arena). May be empty if the
    /// section has no biome data.
    biome_names: [][]const u8 = &.{},
    /// 64 biome palette indices in YZX order over the 4×4×4 cell grid. Empty for
    /// a single-entry biome palette (every cell is `biome_names[0]`).
    biome_indices: []u16 = &.{},

    /// Palette index at section-local (x, y, z), each 0..15.
    pub fn paletteIndexAt(self: Section, x: u32, y: u32, z: u32) u16 {
        if (self.indices.len == 0) return 0;
        return self.indices[(y * SECTION_DIM + z) * SECTION_DIM + x];
    }

    /// Biome palette index at section-local cell (x, y, z), each 0..3. Returns 0
    /// for a single-entry (or absent) biome palette.
    pub fn biomeIndexAt(self: Section, x: u32, y: u32, z: u32) u16 {
        if (self.biome_indices.len == 0) return 0;
        return self.biome_indices[(y * BIOME_DIM + z) * BIOME_DIM + x];
    }
};

pub const Chunk = struct {
    /// Chunk coordinates (in chunks, not blocks) as recorded in the chunk NBT.
    x: i32,
    z: i32,
    sections: []Section,
    data_version: i32,
    /// Palette entries in a shape we don't recognize (decoded as air). Non-zero
    /// almost always means a newer Minecraft changed the chunk format.
    unknown_palette_entries: usize = 0,
};

pub const Error = error{ BadFormat, NoSections, PreModernChunk } || std.mem.Allocator.Error;

/// bits-per-index = max(4, ceil(log2(palette_len))).
pub fn bitsForPalette(n: usize) u6 {
    return bitsFor(n, 4);
}

/// bits-per-cell for a biome palette = max(1, ceil(log2(palette_len))).
pub fn bitsForBiome(n: usize) u6 {
    return bitsFor(n, 1);
}

fn bitsFor(n: usize, min_bits: u6) u6 {
    var b: u6 = min_bits;
    while ((@as(usize, 1) << b) < n) b += 1;
    return b;
}

/// Decode a parsed chunk root compound into sections. All allocations come from
/// `arena`; names alias the NBT buffer (also arena-owned), so nothing is copied.
pub fn decode(arena: std.mem.Allocator, root: []const nbt.Entry) Error!Chunk {
    const data_version: i32 = blk: {
        const t = nbt.get(root, "DataVersion") orelse break :blk 0;
        break :blk if (t.* == .int) t.int else 0;
    };
    const x_pos: i32 = readInt(root, "xPos");
    const z_pos: i32 = readInt(root, "zPos");

    const sections_tag = nbt.get(root, "sections") orelse {
        // Pre-1.18 chunks nest everything under `Level` (capitalized keys,
        // different palette layout) — unsupported, but worth telling apart from
        // a merely empty chunk so the CLI can explain a blank render.
        if (nbt.get(root, "Level") != null) return error.PreModernChunk;
        return error.NoSections;
    };
    if (sections_tag.* != .list) return error.BadFormat;
    const raw_sections = sections_tag.list.items;

    var out: std.ArrayList(Section) = .empty;
    var unknown_palette_entries: usize = 0;
    for (raw_sections) |sec| {
        if (sec != .compound) continue;
        const sy: i32 = blk: {
            const t = nbt.get(sec.compound, "Y") orelse continue;
            break :blk switch (t.*) {
                .byte => |v| v,
                .int => |v| v,
                .short => |v| v,
                else => continue,
            };
        };
        // Reject corrupt section Ys before they can overflow the grid's i32
        // extent math (valid dimensions stay within ±127 sections = ±2032 blocks).
        if (sy < -128 or sy > 127) continue;

        const bs = nbt.get(sec.compound, "block_states") orelse continue;
        if (bs.* != .compound) continue;

        const palette_tag = nbt.get(bs.compound, "palette") orelse continue;
        if (palette_tag.* != .list) continue;
        const palette = palette_tag.list.items;
        if (palette.len == 0) continue;

        const names = try arena.alloc([]const u8, palette.len);
        const states = try arena.alloc([]const u8, palette.len);
        for (palette, names, states) |p, *nm, *st| {
            const entry = try decodePaletteEntry(arena, p);
            nm.* = entry.name;
            st.* = entry.state;
            if (!entry.known) unknown_palette_entries += 1;
        }

        const data_tag = nbt.get(bs.compound, "data");
        var indices: []u16 = &.{};
        if (palette.len > 1 and data_tag != null and data_tag.?.* == .long_array) {
            indices = try unpack(arena, data_tag.?.long_array, palette.len, SECTION_BLOCKS, bitsForPalette(palette.len));
        } else if (palette.len > 1) {
            // >1 palette entry but no data array is malformed; skip the section.
            continue;
        }

        const biomes = try decodeBiomes(arena, sec.compound);

        try out.append(arena, .{
            .y = sy,
            .names = names,
            .states = states,
            .indices = indices,
            .biome_names = biomes.names,
            .biome_indices = biomes.indices,
        });
    }

    return .{
        .x = x_pos,
        .z = z_pos,
        .sections = try out.toOwnedSlice(arena),
        .data_version = data_version,
        .unknown_palette_entries = unknown_palette_entries,
    };
}

const PaletteEntry = struct { name: []const u8, state: []const u8, known: bool };

/// Decode one block-state palette entry. Accepted forms:
///   - compound `{Name, Properties}` (1.18 .. 26.3 snapshot 6)
///   - compound `{id, properties}` (26.3 snapshot 7+)
///   - string `"minecraft:stone"`: 26.3+ compact form for a block's default
///     state. We don't know each block's default properties, so the state key
///     is "" and the model resolver falls back to its default variant.
///   - compound `{"": "minecraft:stone"}`: the same compact string inside a
///     palette that also holds compounds. NBT lists are homogeneous, so since
///     25w09a mixed lists wrap non-compound elements in an empty-key compound.
/// Anything else decodes as air with `known = false` so callers can warn.
fn decodePaletteEntry(arena: std.mem.Allocator, p: nbt.Tag) Error!PaletteEntry {
    const unknown: PaletteEntry = .{ .name = "minecraft:air", .state = "", .known = false };
    switch (p) {
        .string => |s| return .{ .name = s, .state = "", .known = true },
        .compound => |c| {
            if (c.len == 1 and c[0].name.len == 0 and c[0].tag == .string)
                return .{ .name = c[0].tag.string, .state = "", .known = true };
            const n = nbt.get(c, "id") orelse nbt.get(c, "Name") orelse return unknown;
            if (n.* != .string) return unknown;
            var state: []const u8 = "";
            if (nbt.get(c, "properties") orelse nbt.get(c, "Properties")) |pr| {
                if (pr.* == .compound) state = try buildStateKey(arena, pr.compound);
            }
            return .{ .name = n.string, .state = state, .known = true };
        },
        else => return unknown,
    }
}

/// Build a normalized state key from a block's `Properties` compound: each
/// string property as "k=v", sorted by key, joined with ",". Sorting makes the
/// key canonical so it matches blockstate variant keys (which are sorted too).
fn buildStateKey(arena: std.mem.Allocator, props: []const nbt.Entry) Error![]const u8 {
    var pairs: std.ArrayList([]const u8) = .empty;
    for (props) |e| {
        const v = switch (e.tag) {
            .string => |s| s,
            else => continue,
        };
        try pairs.append(arena, try std.fmt.allocPrint(arena, "{s}={s}", .{ e.name, v }));
    }
    if (pairs.items.len == 0) return "";
    std.mem.sort([]const u8, pairs.items, {}, lessThanStr);
    return std.mem.join(arena, ",", pairs.items);
}

fn lessThanStr(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.lessThan(u8, a, b);
}

/// Biome sub-compound result for one section.
const Biomes = struct { names: [][]const u8 = &.{}, indices: []u16 = &.{} };

/// Parse a section's `biomes` compound: a string palette plus an optional packed
/// 4×4×4 (64-cell) index array. Absent/single-entry palettes yield empty indices.
fn decodeBiomes(arena: std.mem.Allocator, sec: []const nbt.Entry) Error!Biomes {
    const bt = nbt.get(sec, "biomes") orelse return .{};
    if (bt.* != .compound) return .{};
    const palette_tag = nbt.get(bt.compound, "palette") orelse return .{};
    if (palette_tag.* != .list) return .{};
    const palette = palette_tag.list.items;
    if (palette.len == 0) return .{};

    const names = try arena.alloc([]const u8, palette.len);
    for (palette, names) |p, *nm| {
        nm.* = if (p == .string) p.string else "minecraft:plains";
    }

    var indices: []u16 = &.{};
    const data_tag = nbt.get(bt.compound, "data");
    if (palette.len > 1 and data_tag != null and data_tag.?.* == .long_array) {
        indices = try unpack(arena, data_tag.?.long_array, palette.len, BIOME_CELLS, bitsForBiome(palette.len));
    }
    return .{ .names = names, .indices = indices };
}

/// Unpack a non-spanning packed long-array into `cells` palette indices at
/// `bits` bits each (post-1.16 layout: indices never straddle a 64-bit word).
fn unpack(arena: std.mem.Allocator, data: []const i64, palette_len: usize, cells: usize, bits: u6) Error![]u16 {
    const per_long: usize = 64 / @as(usize, bits);
    const mask: u64 = (@as(u64, 1) << bits) - 1;

    const out = try arena.alloc(u16, cells);
    // Walk each long's indices low bits first; entries never span longs. A
    // short array leaves the tail at palette entry 0.
    var i: usize = 0;
    for (data) |raw| {
        if (i >= cells) break;
        var word: u64 = @bitCast(raw);
        const end = @min(i + per_long, cells);
        while (i < end) : (i += 1) {
            const pidx = word & mask;
            word >>= bits;
            out[i] = if (pidx >= palette_len) 0 else @intCast(pidx);
        }
    }
    @memset(out[i..], 0);
    return out;
}

fn readInt(root: []const nbt.Entry, name: []const u8) i32 {
    const t = nbt.get(root, name) orelse return 0;
    return switch (t.*) {
        .int => |v| v,
        .byte => |v| v,
        .short => |v| v,
        .long => |v| @intCast(v),
        else => 0,
    };
}

test "bitsForPalette" {
    try std.testing.expectEqual(@as(u6, 4), bitsForPalette(1));
    try std.testing.expectEqual(@as(u6, 4), bitsForPalette(16));
    try std.testing.expectEqual(@as(u6, 5), bitsForPalette(17));
    try std.testing.expectEqual(@as(u6, 6), bitsForPalette(33));
}

test "bitsForBiome uses a 1-bit minimum (no min-4 floor)" {
    try std.testing.expectEqual(@as(u6, 1), bitsForBiome(1));
    try std.testing.expectEqual(@as(u6, 1), bitsForBiome(2));
    try std.testing.expectEqual(@as(u6, 2), bitsForBiome(3));
    try std.testing.expectEqual(@as(u6, 2), bitsForBiome(4));
    try std.testing.expectEqual(@as(u6, 3), bitsForBiome(5));
    try std.testing.expectEqual(@as(u6, 4), bitsForBiome(16));
}

test "unpack round-trips packed 5-bit indices" {
    const arena = std.testing.allocator;
    // 20-entry palette -> 5 bits (2^4=16 < 20 <= 2^5=32), 12 indices per long.
    const palette_len = 20;
    const bits: u6 = 5;
    const per_long: usize = 64 / @as(usize, bits);
    const longs = try arena.alloc(i64, (4096 + per_long - 1) / per_long);
    defer arena.free(longs);
    @memset(longs, 0);
    // Write index (i % 13) at every block position.
    var i: usize = 0;
    while (i < 4096) : (i += 1) {
        const v: u64 = @intCast(i % palette_len);
        const li = i / per_long;
        const shift: u6 = @intCast((i % per_long) * @as(usize, bits));
        var w: u64 = @bitCast(longs[li]);
        w |= v << shift;
        longs[li] = @bitCast(w);
    }
    const got = try unpack(arena, longs, palette_len, 4096, bits);
    defer arena.free(got);
    try std.testing.expectEqual(@as(usize, 4096), got.len);
    i = 0;
    while (i < 4096) : (i += 1) {
        try std.testing.expectEqual(@as(u16, @intCast(i % palette_len)), got[i]);
    }
}

test "unpack zero-fills a short array and out-of-palette indices" {
    const arena = std.testing.allocator;
    // 4 bits, 16 per long: one long covers cells 0..15, the rest are missing.
    const word: u64 = 0xF0 | 0x3; // cell 0 = 3, cell 1 = 15 (>= palette_len)
    const longs = [_]i64{@bitCast(word)};
    const got = try unpack(arena, &longs, 5, 40, 4);
    defer arena.free(got);
    try std.testing.expectEqual(@as(u16, 3), got[0]);
    try std.testing.expectEqual(@as(u16, 0), got[1]);
    for (got[2..]) |v| try std.testing.expectEqual(@as(u16, 0), v);
}

test "unpack round-trips packed 1-bit biome cells" {
    const arena = std.testing.allocator;
    // 2-entry biome palette -> 1 bit, 64 cells per long, 1 long total.
    const palette_len = 2;
    const bits: u6 = 1;
    const longs = try arena.alloc(i64, 1);
    defer arena.free(longs);
    var w: u64 = 0;
    var i: usize = 0;
    while (i < BIOME_CELLS) : (i += 1) {
        if (i % 2 == 1) w |= @as(u64, 1) << @intCast(i);
    }
    longs[0] = @bitCast(w);
    const got = try unpack(arena, longs, palette_len, BIOME_CELLS, bits);
    defer arena.free(got);
    try std.testing.expectEqual(@as(usize, BIOME_CELLS), got.len);
    i = 0;
    while (i < BIOME_CELLS) : (i += 1) {
        try std.testing.expectEqual(@as(u16, @intCast(i % 2)), got[i]);
    }
}

/// Minimal big-endian NBT writer for building serialized test chunks.
const TestNbt = struct {
    buf: std.ArrayList(u8) = .empty,
    a: std.mem.Allocator,

    fn byte(self: *TestNbt, v: u8) !void {
        try self.buf.append(self.a, v);
    }
    fn int(self: *TestNbt, comptime T: type, v: T) !void {
        var b: [@sizeOf(T)]u8 = undefined;
        std.mem.writeInt(T, &b, v, .big);
        try self.buf.appendSlice(self.a, &b);
    }
    fn str(self: *TestNbt, s: []const u8) !void {
        try self.int(u16, @intCast(s.len));
        try self.buf.appendSlice(self.a, s);
    }
    /// Named tag header: type byte + name.
    fn named(self: *TestNbt, t: nbt.TagType, name: []const u8) !void {
        try self.byte(@backingInt(t));
        try self.str(name);
    }
    fn stringTag(self: *TestNbt, name: []const u8, v: []const u8) !void {
        try self.named(.string, name);
        try self.str(v);
    }
    fn end(self: *TestNbt) !void {
        try self.byte(0);
    }
};

/// Serialize a one-section chunk whose block palette is a list of compounds
/// written by `writePalette` (which must emit exactly `palette_len` entries).
fn serializeTestChunk(a: std.mem.Allocator, palette_len: i32, writePalette: *const fn (*TestNbt) anyerror!void) ![]u8 {
    var w: TestNbt = .{ .a = a };
    try w.named(.compound, "");
    try w.named(.int, "DataVersion");
    try w.int(i32, 5023);
    try w.named(.list, "sections");
    try w.byte(@backingInt(nbt.TagType.compound));
    try w.int(i32, 1);
    try w.named(.byte, "Y");
    try w.byte(0);
    try w.named(.compound, "block_states");
    try w.named(.list, "palette");
    try w.byte(@backingInt(nbt.TagType.compound));
    try w.int(i32, palette_len);
    try writePalette(&w);
    try w.named(.long_array, "data");
    const longs = SECTION_BLOCKS * 4 / 64;
    try w.int(i32, longs);
    for (0..longs) |_| try w.int(i64, 0);
    try w.end(); // block_states
    try w.end(); // section
    try w.end(); // root
    return w.buf.items;
}

fn writeMixedPalette(w: *TestNbt) anyerror!void {
    // Compact default state, wrapped because the list also holds compounds.
    try w.stringTag("", "minecraft:stone");
    try w.end();
    // Pre-26.3 layout.
    try w.stringTag("Name", "minecraft:oak_log");
    try w.named(.compound, "Properties");
    try w.stringTag("axis", "x");
    try w.end();
    try w.end();
    // 26.3 renamed layout.
    try w.stringTag("id", "minecraft:oak_stairs");
    try w.named(.compound, "properties");
    try w.stringTag("half", "bottom");
    try w.stringTag("facing", "north");
    try w.end();
    try w.end();
    // Unrecognized shape.
    try w.named(.int, "mystery");
    try w.int(i32, 7);
    try w.end();
}

test "decode accepts every block-state palette entry format" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();

    const bytes = try serializeTestChunk(a, 4, writeMixedPalette);
    var parser: nbt.Parser = .{ .buf = bytes, .arena = a };
    const root = try parser.parseRoot();

    const ch = try decode(a, root);
    try std.testing.expectEqual(@as(usize, 1), ch.sections.len);
    const s = ch.sections[0];
    try std.testing.expectEqualStrings("minecraft:stone", s.names[0]);
    try std.testing.expectEqualStrings("", s.states[0]);
    try std.testing.expectEqualStrings("minecraft:oak_log", s.names[1]);
    try std.testing.expectEqualStrings("axis=x", s.states[1]);
    try std.testing.expectEqualStrings("minecraft:oak_stairs", s.names[2]);
    try std.testing.expectEqualStrings("facing=north,half=bottom", s.states[2]);
    try std.testing.expectEqualStrings("minecraft:air", s.names[3]);
    try std.testing.expectEqual(@as(usize, 1), ch.unknown_palette_entries);
}

test "decode accepts an all-string compact palette" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();

    var palette = [_]nbt.Tag{ .{ .string = "minecraft:stone" }, .{ .string = "minecraft:dirt" } };
    var data: [SECTION_BLOCKS * 4 / 64]i64 = @splat(0);
    var block_states = [_]nbt.Entry{
        .{ .name = "palette", .tag = .{ .list = .{ .elem = .string, .items = &palette } } },
        .{ .name = "data", .tag = .{ .long_array = &data } },
    };
    var section = [_]nbt.Entry{
        .{ .name = "Y", .tag = .{ .byte = 0 } },
        .{ .name = "block_states", .tag = .{ .compound = &block_states } },
    };
    var sections = [_]nbt.Tag{.{ .compound = &section }};
    const root = [_]nbt.Entry{
        .{ .name = "sections", .tag = .{ .list = .{ .elem = .compound, .items = &sections } } },
    };

    const ch = try decode(a, &root);
    try std.testing.expectEqualStrings("minecraft:stone", ch.sections[0].names[0]);
    try std.testing.expectEqualStrings("minecraft:dirt", ch.sections[0].names[1]);
    try std.testing.expectEqual(@as(usize, 0), ch.unknown_palette_entries);
}
