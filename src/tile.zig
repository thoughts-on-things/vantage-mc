//! Vantage binary tile format v1 (`.vtile`).
//!
//! A deliberately minimal, versioned, indexed geometry blob — the first concrete
//! instance of the "documented, versioned binary contract" decoupling generator
//! from frontend (DESIGN.md §6). It is NOT the final format: quantized positions,
//! packed normal/light, and a texture-array layer index all land in P2–P4. v1
//! exists to get pixels into a browser and to pin the encode/decode handshake.
//!
//! All little-endian (matches x86/arm64 and the browser). Arrays are laid out so
//! every f32/u32 block stays 4-byte aligned for zero-copy typed-array views.
//!
//!   offset  type            field
//!   0       u8[4]           magic "VTL1"
//!   4       u32             version (= 1)
//!   8       u32             vertex_count (V)
//!   12      u32             index_count  (I)
//!   16      f32[3*V]        positions (world coords)
//!   ...     u8[4*V]         colors (RGBA)
//!   ...     i8[4*V]         normals (xyz + 1 pad byte)
//!   ...     u32[I]          indices

const std = @import("std");
const mesh = @import("mesh.zig");

pub const MAGIC = "VTL1";
pub const VERSION: u32 = 1;

/// Serialize a mesh into a freshly allocated `.vtile` byte buffer.
pub fn serialize(arena: std.mem.Allocator, m: mesh.Mesh) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    const v = m.vertex_count;
    const i: u32 = @intCast(m.indices.items.len);

    try out.appendSlice(arena, MAGIC);
    try appendU32(arena, &out, VERSION);
    try appendU32(arena, &out, v);
    try appendU32(arena, &out, i);
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.positions.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.colors.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.normals.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.indices.items));

    return out.toOwnedSlice(arena);
}

fn appendU32(arena: std.mem.Allocator, out: *std.ArrayList(u8), v: u32) !void {
    var buf: [4]u8 = undefined;
    std.mem.writeInt(u32, &buf, v, .little);
    try out.appendSlice(arena, &buf);
}

pub const MAGIC2 = "VTL2";
pub const VERSION2: u32 = 2;

/// Serialize a textured mesh into a `.vtile` (v2) buffer. Adds per-vertex UV,
/// a texture-array layer index, and a tint-multiply color over the v1 layout:
///   "VTL2", u32 ver, u32 V, u32 I,
///   f32[3V] positions, f32[2V] uv, f32[V] layer, u8[4V] color, i8[4V] normal,
///   u32[I] indices.   (all little-endian, 4-byte aligned for zero-copy views)
pub fn serializeTextured(arena: std.mem.Allocator, m: mesh.Mesh2) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    const v = m.vertex_count;
    const i: u32 = @intCast(m.indices.items.len);

    try out.appendSlice(arena, MAGIC2);
    try appendU32(arena, &out, VERSION2);
    try appendU32(arena, &out, v);
    try appendU32(arena, &out, i);
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.positions.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.uv.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.layer.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.color.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.normals.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.indices.items));

    return out.toOwnedSlice(arena);
}

test "serialized header is well-formed and sizes match" {
    const a = std.testing.allocator;
    var m: mesh.Mesh = .{};
    defer {
        m.positions.deinit(a);
        m.colors.deinit(a);
        m.normals.deinit(a);
        m.indices.deinit(a);
    }
    // One quad: 4 verts, 6 indices.
    try m.positions.appendSlice(a, &.{ 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0 });
    try m.colors.appendSlice(a, &([_]u8{ 10, 20, 30, 255 } ** 4));
    try m.normals.appendSlice(a, &([_]i8{ 0, 0, 1, 0 } ** 4));
    try m.indices.appendSlice(a, &.{ 0, 1, 2, 0, 2, 3 });
    m.vertex_count = 4;

    const bytes = try serialize(a, m);
    defer a.free(bytes);

    try std.testing.expectEqualSlices(u8, MAGIC, bytes[0..4]);
    try std.testing.expectEqual(VERSION, std.mem.readInt(u32, bytes[4..8], .little));
    try std.testing.expectEqual(@as(u32, 4), std.mem.readInt(u32, bytes[8..12], .little));
    try std.testing.expectEqual(@as(u32, 6), std.mem.readInt(u32, bytes[12..16], .little));

    const expected = 16 + (4 * 3 * 4) + (4 * 4) + (4 * 4) + (6 * 4);
    try std.testing.expectEqual(@as(usize, expected), bytes.len);
}
