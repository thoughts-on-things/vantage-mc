//! Chunk decompression via vendored libdeflate (see vendor/libdeflate, MIT).
//!
//! We vendor the fastest C decompressor rather than depend on the system zlib
//! (not present on Windows) or the churning std.compress. Anvil chunk payloads
//! are whole-buffer decompressions with a known-ish growth factor — exactly
//! libdeflate's fast path (~2-3× system zlib). Zlib covers
//! chunks (compression type 2); gzip covers type 1 and `level.dat`.

const std = @import("std");
const c = @cImport({
    @cInclude("libdeflate.h");
});

/// Inflate a zlib-wrapped (RFC 1950) buffer into a freshly allocated slice.
pub fn inflateZlib(allocator: std.mem.Allocator, src: []const u8) ![]u8 {
    return inflate(allocator, src, .zlib);
}

/// Inflate a gzip-wrapped (RFC 1952) buffer into a freshly allocated slice.
pub fn inflateGzip(allocator: std.mem.Allocator, src: []const u8) ![]u8 {
    return inflate(allocator, src, .gzip);
}

/// Gzip-wrap `src` (RFC 1952) into a freshly allocated slice. `level` is
/// libdeflate's 1 (fastest) .. 12 (best); 6 is the balanced default. Tiles are
/// written gzip-wrapped: the quantized geometry compresses ~8×, and the viewer
/// (or the serving layer) inflates transparently.
pub fn gzipCompress(allocator: std.mem.Allocator, src: []const u8, level: i32) ![]u8 {
    const comp = c.libdeflate_alloc_compressor(level) orelse return error.OutOfMemory;
    defer c.libdeflate_free_compressor(comp);
    const bound = c.libdeflate_gzip_compress_bound(comp, src.len);
    const dst = try allocator.alloc(u8, bound);
    const actual = c.libdeflate_gzip_compress(comp, src.ptr, src.len, dst.ptr, bound);
    if (actual == 0) {
        allocator.free(dst);
        return error.DeflateFailed;
    }
    return try allocator.realloc(dst, actual);
}

const Wrapper = enum { zlib, gzip };

fn inflate(allocator: std.mem.Allocator, src: []const u8, wrapper: Wrapper) ![]u8 {
    const d = c.libdeflate_alloc_decompressor() orelse return error.OutOfMemory;
    defer c.libdeflate_free_decompressor(d);

    var cap: usize = @max(src.len *| 4, 128 * 1024);
    while (true) {
        const dst = try allocator.alloc(u8, cap);
        var actual: usize = 0;
        const rc = switch (wrapper) {
            .zlib => c.libdeflate_zlib_decompress(d, src.ptr, src.len, dst.ptr, cap, &actual),
            .gzip => c.libdeflate_gzip_decompress(d, src.ptr, src.len, dst.ptr, cap, &actual),
        };
        switch (rc) {
            c.LIBDEFLATE_SUCCESS => return try allocator.realloc(dst, actual),
            c.LIBDEFLATE_INSUFFICIENT_SPACE => {
                allocator.free(dst);
                cap *|= 2;
            },
            else => {
                allocator.free(dst);
                return error.InflateFailed;
            },
        }
    }
}

test "inflateZlib round-trips a known blob" {
    // "hello vantage" (node: zlib.deflateSync).
    const compressed = [_]u8{
        0x78, 0x9c, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0x28, 0x4b,
        0xcc, 0x2b, 0x49, 0x4c, 0x4f, 0x05, 0x00, 0x23, 0xa0, 0x05,
        0x1b,
    };
    const out = try inflateZlib(std.testing.allocator, &compressed);
    defer std.testing.allocator.free(out);
    try std.testing.expectEqualStrings("hello vantage", out);
}

test "inflateGzip round-trips a known blob" {
    // "hello vantage" (node: zlib.gzipSync).
    const compressed = [_]u8{
        0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a,
        0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0x28, 0x4b, 0xcc, 0x2b,
        0x49, 0x4c, 0x4f, 0x05, 0x00, 0x22, 0x96, 0xf2, 0xd0, 0x0d,
        0x00, 0x00, 0x00,
    };
    const out = try inflateGzip(std.testing.allocator, &compressed);
    defer std.testing.allocator.free(out);
    try std.testing.expectEqualStrings("hello vantage", out);
}

test "gzipCompress round-trips through inflateGzip" {
    const a = std.testing.allocator;
    const payload = "vantage tiles compress well because quantized data repeats " ** 20;
    const packed_ = try gzipCompress(a, payload, 6);
    defer a.free(packed_);
    try std.testing.expect(packed_.len < payload.len / 2);
    const back = try inflateGzip(a, packed_);
    defer a.free(back);
    try std.testing.expectEqualStrings(payload, back);
}

test "inflateZlib rejects garbage" {
    const garbage = [_]u8{ 0xde, 0xad, 0xbe, 0xef };
    try std.testing.expectError(error.InflateFailed, inflateZlib(std.testing.allocator, &garbage));
}
