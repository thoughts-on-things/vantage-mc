//! Vantage — P0 parsing spike.
//!
//! Reads a Minecraft Anvil region file, locates a chunk, decompresses it,
//! parses the NBT, unpacks every section's paletted block-state array, and
//! prints a block histogram. This validates the whole read foundation
//! (region -> zlib -> NBT -> palette bit-unpacking) against real world data.
//!
//! Usage: vantage <region.mca> [localX localZ]   (local coords 0..31, default 0 0)

const std = @import("std");
const nbt = @import("nbt.zig");
const region = @import("region.zig");

const SECTION_BLOCKS = 4096; // 16 * 16 * 16

pub fn main(init: std.process.Init) !void {
    // The runtime hands us a process-lifetime arena and the parsed args.
    const a = init.arena.allocator();

    const args = try init.minimal.args.toSlice(a);
    if (args.len < 2) {
        std.debug.print("usage: vantage <region.mca> [localX localZ]\n", .{});
        return error.MissingArgument;
    }
    const path = args[1];
    const lx: u5 = if (args.len > 2) @truncate(try std.fmt.parseInt(u8, args[2], 10)) else 0;
    const lz: u5 = if (args.len > 3) @truncate(try std.fmt.parseInt(u8, args[3], 10)) else 0;

    const bytes = try std.Io.Dir.cwd().readFileAlloc(init.io, path, a, .unlimited);
    std.debug.print("region file: {s} ({d} bytes)\n", .{ path, bytes.len });

    const reg = region.Region.fromBytes(bytes);
    const raw = (try reg.rawChunk(lx, lz)) orelse {
        std.debug.print("chunk ({d},{d}) is absent in this region\n", .{ lx, lz });
        return;
    };
    std.debug.print(
        "chunk ({d},{d}): compression={s}, compressed={d} bytes\n",
        .{ lx, lz, @tagName(raw.compression), raw.data.len },
    );

    const chunk_nbt = try region.decompress(a, raw);
    std.debug.print("decompressed NBT: {d} bytes ({d:.1}x)\n", .{
        chunk_nbt.len,
        @as(f64, @floatFromInt(chunk_nbt.len)) / @as(f64, @floatFromInt(raw.data.len)),
    });

    var parser = nbt.Parser{ .buf = chunk_nbt, .arena = a };
    const root = try parser.parseRoot();

    printInt(root, "DataVersion");
    printInt(root, "xPos");
    printInt(root, "zPos");
    printInt(root, "yPos");
    if (nbt.get(root, "Status")) |s| {
        if (s.* == .string) std.debug.print("Status: {s}\n", .{s.string});
    }

    const sections = blk: {
        const t = nbt.get(root, "sections") orelse return error.NoSections;
        if (t.* != .list) return error.BadFormat;
        break :blk t.list.items;
    };

    var hist = std.StringHashMap(u64).init(a);
    var total_nonair: u64 = 0;
    var sections_with_blocks: usize = 0;

    for (sections) |sec| {
        if (sec != .compound) continue;
        const bs = nbt.get(sec.compound, "block_states") orelse continue;
        if (bs.* != .compound) continue;

        const palette = blk: {
            const t = nbt.get(bs.compound, "palette") orelse continue;
            if (t.* != .list) continue;
            break :blk t.list.items;
        };
        if (palette.len == 0) continue;

        // Resolve palette index -> block name once.
        const names = try a.alloc([]const u8, palette.len);
        for (palette, names) |p, *nm| {
            nm.* = "?";
            if (p == .compound) {
                if (nbt.get(p.compound, "Name")) |n| {
                    if (n.* == .string) nm.* = n.string;
                }
            }
        }

        const data_tag = nbt.get(bs.compound, "data");
        if (palette.len == 1 or data_tag == null) {
            // Uniform section: all 4096 blocks are palette[0].
            if (!isAir(names[0])) {
                total_nonair += SECTION_BLOCKS;
                try bump(&hist, names[0], SECTION_BLOCKS);
                sections_with_blocks += 1;
            }
            continue;
        }
        if (data_tag.?.* != .long_array) continue;
        const data = data_tag.?.long_array;

        const bits = bitsForPalette(palette.len);
        const per_long: usize = 64 / @as(usize, bits);
        const mask: u64 = (@as(u64, 1) << bits) - 1;

        var section_blocks: u64 = 0;
        var i: usize = 0;
        while (i < SECTION_BLOCKS) : (i += 1) {
            const long_idx = i / per_long;
            if (long_idx >= data.len) break;
            const shift: u6 = @intCast((i % per_long) * @as(usize, bits));
            const raw_long: u64 = @bitCast(data[long_idx]);
            const pidx: usize = @intCast((raw_long >> shift) & mask);
            if (pidx >= names.len) continue;
            const name = names[pidx];
            if (!isAir(name)) {
                total_nonair += 1;
                section_blocks += 1;
                try bump(&hist, name, 1);
            }
        }
        if (section_blocks > 0) sections_with_blocks += 1;
    }

    std.debug.print(
        "\nsections: {d} ({d} with non-air blocks)\nnon-air blocks: {d}\ndistinct block types: {d}\n\ntop blocks:\n",
        .{ sections.len, sections_with_blocks, total_nonair, hist.count() },
    );
    try printTop(a, &hist, 25);
}

fn printInt(entries: []const nbt.Entry, name: []const u8) void {
    if (nbt.get(entries, name)) |t| {
        switch (t.*) {
            .int => |v| std.debug.print("{s}: {d}\n", .{ name, v }),
            .byte => |v| std.debug.print("{s}: {d}\n", .{ name, v }),
            .long => |v| std.debug.print("{s}: {d}\n", .{ name, v }),
            else => {},
        }
    }
}

fn isAir(name: []const u8) bool {
    return std.mem.eql(u8, name, "minecraft:air") or
        std.mem.eql(u8, name, "minecraft:cave_air") or
        std.mem.eql(u8, name, "minecraft:void_air");
}

/// bits-per-index = max(4, ceil(log2(palette_len))).
fn bitsForPalette(n: usize) u6 {
    var b: u6 = 4;
    while ((@as(usize, 1) << b) < n) b += 1;
    return b;
}

fn bump(hist: *std.StringHashMap(u64), name: []const u8, n: u64) !void {
    const gop = try hist.getOrPut(name);
    if (!gop.found_existing) gop.value_ptr.* = 0;
    gop.value_ptr.* += n;
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

test "bitsForPalette" {
    try std.testing.expectEqual(@as(u6, 4), bitsForPalette(1));
    try std.testing.expectEqual(@as(u6, 4), bitsForPalette(16));
    try std.testing.expectEqual(@as(u6, 5), bitsForPalette(17));
    try std.testing.expectEqual(@as(u6, 5), bitsForPalette(32));
    try std.testing.expectEqual(@as(u6, 6), bitsForPalette(33));
    try std.testing.expectEqual(@as(u6, 12), bitsForPalette(4096));
}

test "palette unpack: non-spanning packed longs" {
    // 5 bits per index, 12 indices per long. Pack indices 0..11 into one long.
    const bits: u6 = 5;
    var word: u64 = 0;
    var i: u6 = 0;
    while (i < 12) : (i += 1) {
        word |= @as(u64, i) << @as(u6, @intCast(i * bits));
    }
    const mask: u64 = (@as(u64, 1) << bits) - 1;
    i = 0;
    while (i < 12) : (i += 1) {
        const shift: u6 = @intCast(i * bits);
        const got: u64 = (word >> shift) & mask;
        try std.testing.expectEqual(@as(u64, i), got);
    }
}
