//! Chunk decode: parsed NBT root -> per-section block grids.
//!
//! A modern (1.18+) chunk stores its blocks in up to 24 sections of 16^3.
//! Each section's `block_states` holds a `palette` (list of block-state
//! compounds, we keep only the `Name`) and an optional packed `data` long-array
//! of palette indices in the non-spanning post-1.16 layout. We unpack each
//! section into a flat `[]u16` of palette indices in Minecraft's YZX order
//! (index = (y*16 + z)*16 + x), which the grid assembler then reads.

const std = @import("std");
const nbt = @import("nbt.zig");

pub const SECTION_DIM = 16;
pub const SECTION_BLOCKS = SECTION_DIM * SECTION_DIM * SECTION_DIM; // 4096

pub const Section = struct {
    /// Section Y index (signed; e.g. -4..19 for a -64..320 world).
    y: i32,
    /// Palette block names (slices into the NBT arena).
    names: [][]const u8,
    /// 4096 palette indices in YZX order. For a single-entry palette this is
    /// empty and every block is `names[0]`.
    indices: []u16,

    /// Palette index at section-local (x, y, z), each 0..15.
    pub fn paletteIndexAt(self: Section, x: u32, y: u32, z: u32) u16 {
        if (self.indices.len == 0) return 0;
        return self.indices[(y * SECTION_DIM + z) * SECTION_DIM + x];
    }
};

pub const Chunk = struct {
    /// Chunk coordinates (in chunks, not blocks) as recorded in the chunk NBT.
    x: i32,
    z: i32,
    sections: []Section,
    data_version: i32,
};

pub const Error = error{ BadFormat, NoSections } || std.mem.Allocator.Error;

/// bits-per-index = max(4, ceil(log2(palette_len))).
pub fn bitsForPalette(n: usize) u6 {
    var b: u6 = 4;
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

    const sections_tag = nbt.get(root, "sections") orelse return error.NoSections;
    if (sections_tag.* != .list) return error.BadFormat;
    const raw_sections = sections_tag.list.items;

    var out: std.ArrayList(Section) = .empty;
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

        const bs = nbt.get(sec.compound, "block_states") orelse continue;
        if (bs.* != .compound) continue;

        const palette_tag = nbt.get(bs.compound, "palette") orelse continue;
        if (palette_tag.* != .list) continue;
        const palette = palette_tag.list.items;
        if (palette.len == 0) continue;

        const names = try arena.alloc([]const u8, palette.len);
        for (palette, names) |p, *nm| {
            nm.* = "minecraft:air";
            if (p == .compound) {
                if (nbt.get(p.compound, "Name")) |n| {
                    if (n.* == .string) nm.* = n.string;
                }
            }
        }

        const data_tag = nbt.get(bs.compound, "data");
        var indices: []u16 = &.{};
        if (palette.len > 1 and data_tag != null and data_tag.?.* == .long_array) {
            indices = try unpack(arena, data_tag.?.long_array, palette.len);
        } else if (palette.len > 1) {
            // >1 palette entry but no data array is malformed; skip the section.
            continue;
        }

        try out.append(arena, .{ .y = sy, .names = names, .indices = indices });
    }

    return .{
        .x = x_pos,
        .z = z_pos,
        .sections = try out.toOwnedSlice(arena),
        .data_version = data_version,
    };
}

/// Unpack the non-spanning packed long-array into 4096 palette indices.
fn unpack(arena: std.mem.Allocator, data: []const i64, palette_len: usize) Error![]u16 {
    const bits = bitsForPalette(palette_len);
    const per_long: usize = 64 / @as(usize, bits);
    const mask: u64 = (@as(u64, 1) << bits) - 1;

    const out = try arena.alloc(u16, SECTION_BLOCKS);
    var i: usize = 0;
    while (i < SECTION_BLOCKS) : (i += 1) {
        const long_idx = i / per_long;
        if (long_idx >= data.len) {
            out[i] = 0;
            continue;
        }
        const shift: u6 = @intCast((i % per_long) * @as(usize, bits));
        const raw_long: u64 = @bitCast(data[long_idx]);
        const pidx: u64 = (raw_long >> shift) & mask;
        out[i] = if (pidx >= palette_len) 0 else @intCast(pidx);
    }
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
    const got = try unpack(arena, longs, palette_len);
    defer arena.free(got);
    try std.testing.expectEqual(@as(usize, 4096), got.len);
    i = 0;
    while (i < 4096) : (i += 1) {
        try std.testing.expectEqual(@as(u16, @intCast(i % palette_len)), got[i]);
    }
}
