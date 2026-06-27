//! Chunk decompression. Minecraft Anvil chunks are usually zlib (RFC1950,
//! compression type 2). We use the system zlib through Zig's C interop rather
//! than std.compress — both for raw speed and to sidestep the volatility of
//! std.compress across pre-1.0 Zig releases. The real generator will later
//! vendor libdeflate / zlib-ng for a faster decode path.

const std = @import("std");
const c = @cImport({
    @cInclude("zlib.h");
});

/// Inflate a zlib-wrapped buffer into a freshly allocated slice.
pub fn inflateZlib(allocator: std.mem.Allocator, src: []const u8) ![]u8 {
    var cap: usize = @max(src.len *| 4, 128 * 1024);
    while (true) {
        const dst = try allocator.alloc(u8, cap);
        var dst_len: c.uLongf = @intCast(cap);
        const rc = c.uncompress(dst.ptr, &dst_len, src.ptr, @intCast(src.len));
        switch (rc) {
            c.Z_OK => return dst[0..@intCast(dst_len)],
            c.Z_BUF_ERROR => {
                // Output buffer too small; grow and retry.
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
