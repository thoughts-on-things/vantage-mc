//! Vantage binary tile format v1 (`.vtile`).
//!
//! A deliberately minimal, versioned, indexed geometry blob — the simplest
//! instance of the documented, versioned binary contract decoupling generator
//! from frontend. Later versions add textures (v3), fluids, and
//! quantized attributes (v6); v1 remains the asset-free flat-color format.
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
const grid = @import("grid.zig");

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

pub const MAGIC3 = "VTL3";
pub const VERSION3: u32 = 3;

/// Serialize a textured mesh with biome data into a `.vtile` (v3) buffer. Adds a
/// per-vertex biome id and a trailing biome legend (the name table) over v2:
///   "VTL3", u32 ver, u32 V, u32 I,
///   f32[3V] positions, f32[2V] uv, f32[V] layer, u8[4V] color, i8[4V] normal,
///   f32[V] biome, u32[I] indices,
///   u32 biome_count, then per biome: u16 name_len + name bytes.
/// `biome_names` is the grid's biome name table; index 0 is the "" no-data
/// sentinel (per-vertex biome ids index into it directly).
pub fn serializeTexturedBiome(arena: std.mem.Allocator, m: mesh.Mesh2, biome_names: []const []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    const v = m.vertex_count;
    const i: u32 = @intCast(m.indices.items.len);

    try out.appendSlice(arena, MAGIC3);
    try appendU32(arena, &out, VERSION3);
    try appendU32(arena, &out, v);
    try appendU32(arena, &out, i);
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.positions.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.uv.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.layer.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.color.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.normals.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.biome.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.indices.items));

    // Biome legend: count, then length-prefixed names (UTF-8, namespace kept).
    try appendU32(arena, &out, @intCast(biome_names.len));
    for (biome_names) |name| {
        var lb: [2]u8 = undefined;
        std.mem.writeInt(u16, &lb, @intCast(@min(name.len, std.math.maxInt(u16))), .little);
        try out.appendSlice(arena, &lb);
        try out.appendSlice(arena, name[0..@min(name.len, std.math.maxInt(u16))]);
    }

    return out.toOwnedSlice(arena);
}

pub const MAGIC4 = "VTL4";
pub const VERSION4: u32 = 4;

/// Serialize a textured + biome tile with a second geometry section for
/// transparent fluids (water), drawn in a separate alpha-blended pass:
///   "VTL4", u32 ver=4,
///   <solid section>, <fluid section>,
///   u32 biome_count, then per biome: u16 name_len + name bytes.
/// A section is: u32 V, u32 I, f32[3V] pos, f32[2V] uv, f32[V] layer,
///   u8[4V] color, i8[4V] normal, f32[V] biome, u32[I] indices.
/// The normal's 4th byte (historically pad) carries packed sky/block light,
/// `(sky << 4) | block` each 0..15 — free per-vertex light at no size cost.
/// The solid section's header (V,I) sits at offset 8 so a VTL4 reader can share
/// the VTL3 solid-mesh parse and just continue into the fluid section + legend.
pub fn serializeWithFluid(arena: std.mem.Allocator, solid: mesh.Mesh2, fluid: mesh.Mesh2, biome_names: []const []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(arena, MAGIC4);
    try appendU32(arena, &out, VERSION4);
    try appendMeshSection(arena, &out, solid);
    try appendMeshSection(arena, &out, fluid);

    // Shared biome legend: count, then length-prefixed names (UTF-8, ns kept).
    try appendU32(arena, &out, @intCast(biome_names.len));
    for (biome_names) |name| {
        var lb: [2]u8 = undefined;
        std.mem.writeInt(u16, &lb, @intCast(@min(name.len, std.math.maxInt(u16))), .little);
        try out.appendSlice(arena, &lb);
        try out.appendSlice(arena, name[0..@min(name.len, std.math.maxInt(u16))]);
    }

    return out.toOwnedSlice(arena);
}

pub const MAGIC5 = "VTL5";
pub const VERSION5: u32 = 5;

/// VTL5 = VTL4 plus a top-down surface map (for fast hover-picking without
/// raycasting geometry). Layout:
///   "VTL5", u32 ver=5,
///   <solid section>, <fluid section>,
///   u32 sx, u32 sz, i32 min_x, i32 min_z,
///   u16[sx*sz] biome, i16[sx*sz] height,
///   u32 biome_count, legend.
/// The u16/i16 arrays stay 2-byte aligned because every preceding field is
/// 4-byte sized, so the frontend can view them zero-copy.
pub fn serializeWithSurface(
    arena: std.mem.Allocator,
    solid: mesh.Mesh2,
    fluid: mesh.Mesh2,
    surface: grid.Surface,
    biome_names: []const []const u8,
) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(arena, MAGIC5);
    try appendU32(arena, &out, VERSION5);
    try appendMeshSection(arena, &out, solid);
    try appendMeshSection(arena, &out, fluid);

    // Surface map: dims + world origin, then the two parallel column arrays.
    try appendU32(arena, &out, @intCast(surface.sx));
    try appendU32(arena, &out, @intCast(surface.sz));
    try appendI32(arena, &out, surface.min_x);
    try appendI32(arena, &out, surface.min_z);
    try out.appendSlice(arena, std.mem.sliceAsBytes(surface.biome));
    try out.appendSlice(arena, std.mem.sliceAsBytes(surface.height));

    // Shared biome legend: count, then length-prefixed names (UTF-8, ns kept).
    try appendU32(arena, &out, @intCast(biome_names.len));
    for (biome_names) |name| {
        var lb: [2]u8 = undefined;
        std.mem.writeInt(u16, &lb, @intCast(@min(name.len, std.math.maxInt(u16))), .little);
        try out.appendSlice(arena, &lb);
        try out.appendSlice(arena, name[0..@min(name.len, std.math.maxInt(u16))]);
    }

    return out.toOwnedSlice(arena);
}

pub const MAGIC6 = "VTL6";
pub const VERSION6: u32 = 6;

/// VTL6 = VTL5 with quantized vertex attributes — smaller tiles, faster to
/// serialize and transfer, decoded back to the same geometry on the frontend.
/// Per section the heavy float arrays shrink:
///   positions f32[3V] -> u16[3V] via a per-axis bounding-box transform
///     (world = min + q*scale); layer/biome f32[V] -> u16[V] (integer ids,
///     lossless). uv / colour / normal / indices are unchanged (still zero-copy).
/// Layout:
///   "VTL6", u32 ver=6,
///   <solid q-section>, <fluid q-section>,
///   u32 sx, u32 sz, i32 min_x, i32 min_z,
///   u16[sx*sz] biome, i16[sx*sz] height,
///   u32 biome_count, legend.
/// A q-section is: u32 V, u32 I, f32[2V] uv, u8[4V] colour, i8[4V] normal,
///   u32[I] indices, f32[6] bbox (min xyz, scale xyz), u16[3V] pos, u16[V] layer,
///   u16[V] biome, then 0/2 pad bytes so the section ends 4-byte aligned (keeps
///   the following section / surface map zero-copy on the frontend).
pub fn serializeWithSurfaceQuantized(
    arena: std.mem.Allocator,
    solid: mesh.Mesh2,
    fluid: mesh.Mesh2,
    surface: grid.Surface,
    biome_names: []const []const u8,
) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(arena, MAGIC6);
    try appendU32(arena, &out, VERSION6);
    try appendMeshSectionQuantized(arena, &out, solid);
    try appendMeshSectionQuantized(arena, &out, fluid);

    // Surface map: dims + world origin, then the two parallel column arrays.
    try appendU32(arena, &out, @intCast(surface.sx));
    try appendU32(arena, &out, @intCast(surface.sz));
    try appendI32(arena, &out, surface.min_x);
    try appendI32(arena, &out, surface.min_z);
    try out.appendSlice(arena, std.mem.sliceAsBytes(surface.biome));
    try out.appendSlice(arena, std.mem.sliceAsBytes(surface.height));

    // Shared biome legend: count, then length-prefixed names (UTF-8, ns kept).
    try appendU32(arena, &out, @intCast(biome_names.len));
    for (biome_names) |name| {
        var lb: [2]u8 = undefined;
        std.mem.writeInt(u16, &lb, @intCast(@min(name.len, std.math.maxInt(u16))), .little);
        try out.appendSlice(arena, &lb);
        try out.appendSlice(arena, name[0..@min(name.len, std.math.maxInt(u16))]);
    }

    return out.toOwnedSlice(arena);
}

fn appendMeshSectionQuantized(arena: std.mem.Allocator, out: *std.ArrayList(u8), m: mesh.Mesh2) !void {
    const v = m.vertex_count;
    try appendU32(arena, out, v);
    try appendU32(arena, out, @intCast(m.indices.items.len));
    // Unchanged, zero-copy on read: uv, colour, normal, indices.
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.uv.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.color.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.normals.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.indices.items));

    // Per-axis bounding box for the u16 position transform.
    var mn = [3]f32{ 0, 0, 0 };
    var sc = [3]f32{ 0, 0, 0 };
    if (v > 0) {
        var lo = [3]f32{ std.math.inf(f32), std.math.inf(f32), std.math.inf(f32) };
        var hi = [3]f32{ -std.math.inf(f32), -std.math.inf(f32), -std.math.inf(f32) };
        for (0..v) |i| {
            inline for (0..3) |k| {
                const p = m.positions.items[i * 3 + k];
                lo[k] = @min(lo[k], p);
                hi[k] = @max(hi[k], p);
            }
        }
        inline for (0..3) |k| {
            mn[k] = lo[k];
            const span = hi[k] - lo[k];
            sc[k] = if (span > 0) span / 65535.0 else 0;
        }
    }
    inline for (mn) |x| try appendF32(arena, out, x);
    inline for (sc) |x| try appendF32(arena, out, x);

    // Quantized positions, then the lossless integer ids (layer, biome). The
    // temporaries are freed here; only the bytes copied into `out` are kept.
    const pq = try arena.alloc(u16, v * 3);
    defer arena.free(pq);
    for (0..v) |i| {
        inline for (0..3) |k| pq[i * 3 + k] = quantPos(m.positions.items[i * 3 + k], mn[k], sc[k]);
    }
    try out.appendSlice(arena, std.mem.sliceAsBytes(pq));

    const lq = try arena.alloc(u16, v);
    defer arena.free(lq);
    const bq = try arena.alloc(u16, v);
    defer arena.free(bq);
    for (0..v) |i| {
        lq[i] = idToU16(m.layer.items[i]);
        bq[i] = idToU16(m.biome.items[i]);
    }
    try out.appendSlice(arena, std.mem.sliceAsBytes(lq));
    try out.appendSlice(arena, std.mem.sliceAsBytes(bq));

    // Pad to a 4-byte boundary so the next section / surface stays aligned.
    while (out.items.len % 4 != 0) try out.append(arena, 0);
}

fn quantPos(p: f32, mn: f32, sc: f32) u16 {
    if (sc <= 0) return 0;
    return @intFromFloat(std.math.clamp(@round((p - mn) / sc), 0.0, 65535.0));
}

fn idToU16(x: f32) u16 {
    return @intFromFloat(std.math.clamp(@round(x), 0.0, 65535.0));
}

fn appendF32(arena: std.mem.Allocator, out: *std.ArrayList(u8), v: f32) !void {
    var buf: [4]u8 = undefined;
    std.mem.writeInt(u32, &buf, @bitCast(v), .little);
    try out.appendSlice(arena, &buf);
}

fn appendI32(arena: std.mem.Allocator, out: *std.ArrayList(u8), v: i32) !void {
    var buf: [4]u8 = undefined;
    std.mem.writeInt(i32, &buf, v, .little);
    try out.appendSlice(arena, &buf);
}

fn appendMeshSection(arena: std.mem.Allocator, out: *std.ArrayList(u8), m: mesh.Mesh2) !void {
    try appendU32(arena, out, m.vertex_count);
    try appendU32(arena, out, @intCast(m.indices.items.len));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.positions.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.uv.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.layer.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.color.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.normals.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.biome.items));
    try out.appendSlice(arena, std.mem.sliceAsBytes(m.indices.items));
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

test "VTL3 writes biome attribute and legend" {
    const a = std.testing.allocator;
    var m: mesh.Mesh2 = .{};
    defer {
        m.positions.deinit(a);
        m.uv.deinit(a);
        m.layer.deinit(a);
        m.color.deinit(a);
        m.normals.deinit(a);
        m.biome.deinit(a);
        m.indices.deinit(a);
    }
    // One quad, biome id 1 on all 4 verts.
    try m.positions.appendSlice(a, &.{ 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0 });
    try m.uv.appendSlice(a, &([_]f32{ 0, 0 } ** 4));
    try m.layer.appendSlice(a, &([_]f32{0} ** 4));
    try m.color.appendSlice(a, &([_]u8{ 255, 255, 255, 255 } ** 4));
    try m.normals.appendSlice(a, &([_]i8{ 0, 0, 1, 0 } ** 4));
    try m.biome.appendSlice(a, &([_]f32{1} ** 4));
    try m.indices.appendSlice(a, &.{ 0, 1, 2, 0, 2, 3 });
    m.vertex_count = 4;

    const names = [_][]const u8{ "", "minecraft:plains" };
    const bytes = try serializeTexturedBiome(a, m, &names);
    defer a.free(bytes);

    try std.testing.expectEqualSlices(u8, MAGIC3, bytes[0..4]);
    try std.testing.expectEqual(VERSION3, std.mem.readInt(u32, bytes[4..8], .little));
    try std.testing.expectEqual(@as(u32, 4), std.mem.readInt(u32, bytes[8..12], .little));

    // Legend sits after the fixed-size arrays: header(16) + pos(48) + uv(32) +
    // layer(16) + color(16) + normal(16) + biome(16) + indices(24).
    const legend_off = 16 + 48 + 32 + 16 + 16 + 16 + 16 + 24;
    try std.testing.expectEqual(@as(u32, 2), std.mem.readInt(u32, bytes[legend_off..][0..4], .little));
    // First name "" (len 0), then "minecraft:plains" (len 16).
    try std.testing.expectEqual(@as(u16, 0), std.mem.readInt(u16, bytes[legend_off + 4 ..][0..2], .little));
    const n1_len = std.mem.readInt(u16, bytes[legend_off + 6 ..][0..2], .little);
    try std.testing.expectEqual(@as(u16, 16), n1_len);
    try std.testing.expectEqualStrings("minecraft:plains", bytes[legend_off + 8 ..][0..16]);
}

test "VTL4 writes both geometry sections and the shared legend" {
    const a = std.testing.allocator;
    var solid: mesh.Mesh2 = .{};
    var fluid: mesh.Mesh2 = .{};
    defer for ([_]*mesh.Mesh2{ &solid, &fluid }) |m| {
        m.positions.deinit(a);
        m.uv.deinit(a);
        m.layer.deinit(a);
        m.color.deinit(a);
        m.normals.deinit(a);
        m.biome.deinit(a);
        m.indices.deinit(a);
    };
    // One quad in each section.
    for ([_]*mesh.Mesh2{ &solid, &fluid }) |m| {
        try m.positions.appendSlice(a, &.{ 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0 });
        try m.uv.appendSlice(a, &([_]f32{ 0, 0 } ** 4));
        try m.layer.appendSlice(a, &([_]f32{0} ** 4));
        try m.color.appendSlice(a, &([_]u8{ 255, 255, 255, 255 } ** 4));
        try m.normals.appendSlice(a, &([_]i8{ 0, 0, 1, 0 } ** 4));
        try m.biome.appendSlice(a, &([_]f32{1} ** 4));
        try m.indices.appendSlice(a, &.{ 0, 1, 2, 0, 2, 3 });
        m.vertex_count = 4;
    }

    const names = [_][]const u8{ "", "minecraft:plains" };
    const bytes = try serializeWithFluid(a, solid, fluid, &names);
    defer a.free(bytes);

    try std.testing.expectEqualSlices(u8, MAGIC4, bytes[0..4]);
    try std.testing.expectEqual(VERSION4, std.mem.readInt(u32, bytes[4..8], .little));
    // Solid section header at offset 8 (V, I).
    try std.testing.expectEqual(@as(u32, 4), std.mem.readInt(u32, bytes[8..12], .little));
    try std.testing.expectEqual(@as(u32, 6), std.mem.readInt(u32, bytes[12..16], .little));
    // Walk to the fluid section: solid arrays (36 bytes/vert) + indices (4/idx).
    const sec_bytes = 36 * 4 + 4 * 6; // V=4, I=6
    const fluid_off = 8 + 8 + sec_bytes;
    try std.testing.expectEqual(@as(u32, 4), std.mem.readInt(u32, bytes[fluid_off..][0..4], .little));
    try std.testing.expectEqual(@as(u32, 6), std.mem.readInt(u32, bytes[fluid_off + 4 ..][0..4], .little));
    // Legend follows the fluid section.
    const legend_off = fluid_off + 8 + sec_bytes;
    try std.testing.expectEqual(@as(u32, 2), std.mem.readInt(u32, bytes[legend_off..][0..4], .little));
}

test "VTL6 quantizes positions and round-trips within tolerance" {
    const a = std.testing.allocator;
    var solid: mesh.Mesh2 = .{};
    var fluid: mesh.Mesh2 = .{};
    defer for ([_]*mesh.Mesh2{ &solid, &fluid }) |m| {
        m.positions.deinit(a);
        m.uv.deinit(a);
        m.layer.deinit(a);
        m.color.deinit(a);
        m.normals.deinit(a);
        m.biome.deinit(a);
        m.indices.deinit(a);
    };
    // A quad with a wide, offset position span so the bbox transform is exercised.
    const px = [_]f32{ -100, 0, 0, 200, 0, 0, 200, 64, 0, -100, 64, 0 };
    try solid.positions.appendSlice(a, &px);
    try solid.uv.appendSlice(a, &([_]f32{ 0, 0 } ** 4));
    try solid.layer.appendSlice(a, &([_]f32{ 42, 42, 42, 42 }));
    try solid.color.appendSlice(a, &([_]u8{ 255, 255, 255, 255 } ** 4));
    try solid.normals.appendSlice(a, &([_]i8{ 0, 0, 1, 0 } ** 4));
    try solid.biome.appendSlice(a, &([_]f32{ 7, 7, 7, 7 }));
    try solid.indices.appendSlice(a, &.{ 0, 1, 2, 0, 2, 3 });
    solid.vertex_count = 4;

    const surface: grid.Surface = .{ .sx = 0, .sz = 0, .min_x = 0, .min_z = 0, .biome = &.{}, .height = &.{} };
    const names = [_][]const u8{ "", "minecraft:plains" };
    const bytes = try serializeWithSurfaceQuantized(a, solid, fluid, surface, &names);
    defer a.free(bytes);

    try std.testing.expectEqualSlices(u8, MAGIC6, bytes[0..4]);
    try std.testing.expectEqual(VERSION6, std.mem.readInt(u32, bytes[4..8], .little));
    try std.testing.expectEqual(@as(u32, 4), std.mem.readInt(u32, bytes[8..12], .little));

    // Walk the solid q-section to its bbox + quantized positions. From the file
    // start: magic+ver (8) + section header V,I (8) + uv 8V + colour 4V +
    // normal 4V + indices 4I = 16 + 16V + 4I bytes.
    const V = 4;
    const I = 6;
    const bbox_off = 16 + 16 * V + 4 * I;
    var mn: [3]f32 = undefined;
    var sc: [3]f32 = undefined;
    inline for (0..3) |k| mn[k] = @bitCast(std.mem.readInt(u32, bytes[bbox_off + k * 4 ..][0..4], .little));
    inline for (0..3) |k| sc[k] = @bitCast(std.mem.readInt(u32, bytes[bbox_off + 12 + k * 4 ..][0..4], .little));
    const pos_off = bbox_off + 24;
    // Reconstruct each vertex and compare to the original within one quant step.
    for (0..V) |i| {
        inline for (0..3) |k| {
            const q = std.mem.readInt(u16, bytes[pos_off + (i * 3 + k) * 2 ..][0..2], .little);
            const world = mn[k] + @as(f32, @floatFromInt(q)) * sc[k];
            const tol = @max(sc[k], 1e-4);
            try std.testing.expect(@abs(world - px[i * 3 + k]) <= tol);
        }
    }
    // Layer + biome ids follow the quantized positions (u16[3V] then u16[V]×2).
    const layer_off = pos_off + 3 * V * 2;
    try std.testing.expectEqual(@as(u16, 42), std.mem.readInt(u16, bytes[layer_off..][0..2], .little));
    const biome_off = layer_off + V * 2;
    try std.testing.expectEqual(@as(u16, 7), std.mem.readInt(u16, bytes[biome_off..][0..2], .little));
}
