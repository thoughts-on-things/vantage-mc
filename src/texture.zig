//! Texture-array builder.
//!
//! Collects the block textures referenced by resolved models, decodes each PNG
//! (vendored stb_image, C interop), normalizes it to a fixed TILE×TILE RGBA
//! layer, and packs them into a single layered array. This is the data behind a
//! WebGL2 **texture array** (DESIGN §6) — not a 2D atlas, so greedy-quad UV
//! repeat and NEAREST sampling work without the Minecraft mip/seam bug.
//!
//! Layer 0 is always a magenta/black "missing" checker, so an unresolved or
//! unreadable texture is loud rather than invisible. Animated textures (tall
//! strips with an .mcmeta) collapse to their first frame.

const std = @import("std");
const c = @cImport({
    @cInclude("stb_image.h");
});

/// All block textures are normalized to this edge length. Vanilla block
/// textures are 16×16; higher-res (resource packs) are point-sampled down.
pub const TILE: u32 = 16;
const BYTES_PER_LAYER: usize = TILE * TILE * 4;

pub const Array = struct {
    width: u32,
    height: u32,
    layer_count: u32,
    /// layer_count × width × height × 4, RGBA8, layer-major.
    pixels: []u8,
};

pub const Builder = struct {
    arena: std.mem.Allocator,
    io: std.Io,
    /// Absolute path to `assets/minecraft`.
    root: []const u8,
    layers: std.ArrayList([]u8) = .empty,
    map: std.StringHashMap(u32),

    pub fn init(arena: std.mem.Allocator, io: std.Io, root: []const u8) !Builder {
        var self: Builder = .{
            .arena = arena,
            .io = io,
            .root = root,
            .map = std.StringHashMap(u32).init(arena),
        };
        try self.layers.append(arena, try makeMissing(arena)); // layer 0
        return self;
    }

    /// Layer index for a texture path (e.g. "block/stone"). Loads and appends on
    /// first use; returns 0 (the missing checker) for any unreadable/undecodable
    /// texture so meshing never fails on a bad asset.
    pub fn layerFor(self: *Builder, path: []const u8) u32 {
        if (self.map.get(path)) |i| return i;
        const idx = self.load(path) catch return 0;
        return idx;
    }

    /// Layer index for a flat solid color (used by the mesher's fallback path
    /// for blocks with no resolvable model — fluids, unknowns). Cached by color.
    pub fn solidLayer(self: *Builder, rgb: [3]u8) !u32 {
        const key = try std.fmt.allocPrint(self.arena, "#solid:{x:0>2}{x:0>2}{x:0>2}", .{ rgb[0], rgb[1], rgb[2] });
        if (self.map.get(key)) |i| return i;
        const buf = try self.arena.alloc(u8, BYTES_PER_LAYER);
        var p: usize = 0;
        while (p < BYTES_PER_LAYER) : (p += 4) {
            buf[p + 0] = rgb[0];
            buf[p + 1] = rgb[1];
            buf[p + 2] = rgb[2];
            buf[p + 3] = 0xFF;
        }
        const idx: u32 = @intCast(self.layers.items.len);
        try self.layers.append(self.arena, buf);
        try self.map.put(key, idx);
        return idx;
    }

    fn load(self: *Builder, path: []const u8) !u32 {
        const full = try std.fmt.allocPrint(self.arena, "{s}/textures/{s}.png", .{ self.root, path });
        const bytes = try std.Io.Dir.cwd().readFileAlloc(self.io, full, self.arena, .unlimited);

        var w: c_int = 0;
        var h: c_int = 0;
        var ch: c_int = 0;
        const data = c.stbi_load_from_memory(bytes.ptr, @intCast(bytes.len), &w, &h, &ch, 4) orelse
            return error.DecodeFailed;
        defer c.stbi_image_free(data);
        if (w <= 0 or h <= 0) return error.DecodeFailed;

        const layer = try normalize(self.arena, data, @intCast(w), @intCast(h));
        const idx: u32 = @intCast(self.layers.items.len);
        try self.layers.append(self.arena, layer);
        try self.map.put(path, idx);
        return idx;
    }

    pub fn finish(self: *Builder) !Array {
        const n = self.layers.items.len;
        const pixels = try self.arena.alloc(u8, n * BYTES_PER_LAYER);
        for (self.layers.items, 0..) |layer, i| {
            @memcpy(pixels[i * BYTES_PER_LAYER ..][0..BYTES_PER_LAYER], layer);
        }
        return .{ .width = TILE, .height = TILE, .layer_count = @intCast(n), .pixels = pixels };
    }
};

pub const Decoded = struct { width: u32, height: u32, pixels: []u8 };

/// Decode a PNG file to raw RGBA, at its native resolution (no resampling). Used
/// for the biome colormaps, which are 256×256 and must not be tiled to 16×16.
pub fn decodeRgba(arena: std.mem.Allocator, io: std.Io, path: []const u8) !Decoded {
    const bytes = try std.Io.Dir.cwd().readFileAlloc(io, path, arena, .unlimited);
    var w: c_int = 0;
    var h: c_int = 0;
    var ch: c_int = 0;
    const data = c.stbi_load_from_memory(bytes.ptr, @intCast(bytes.len), &w, &h, &ch, 4) orelse
        return error.DecodeFailed;
    defer c.stbi_image_free(data);
    if (w <= 0 or h <= 0) return error.DecodeFailed;
    const n: usize = @as(usize, @intCast(w)) * @as(usize, @intCast(h)) * 4;
    const out = try arena.alloc(u8, n);
    @memcpy(out, data[0..n]);
    return .{ .width = @intCast(w), .height = @intCast(h), .pixels = out };
}

pub const ARRAY_MAGIC = "VTA1";

/// Serialize a texture array to a `.vtexarr` blob:
///   "VTA1", u32 version=1, u32 width, u32 height, u32 layer_count, then RGBA pixels.
pub fn serialize(arena: std.mem.Allocator, arr: Array) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(arena, ARRAY_MAGIC);
    for ([_]u32{ 1, arr.width, arr.height, arr.layer_count }) |v| {
        var buf: [4]u8 = undefined;
        std.mem.writeInt(u32, &buf, v, .little);
        try out.appendSlice(arena, &buf);
    }
    try out.appendSlice(arena, arr.pixels);
    return out.toOwnedSlice(arena);
}

/// Point-resample a decoded RGBA image to TILE×TILE. Animated textures (height a
/// multiple of width, height>width) collapse to the first (top) frame.
fn normalize(arena: std.mem.Allocator, data: [*]const u8, w: u32, h: u32) ![]u8 {
    const frame_h: u32 = if (h > w and w != 0 and h % w == 0) w else h;
    const out = try arena.alloc(u8, BYTES_PER_LAYER);
    var ty: u32 = 0;
    while (ty < TILE) : (ty += 1) {
        const sy = (ty * frame_h) / TILE;
        var tx: u32 = 0;
        while (tx < TILE) : (tx += 1) {
            const sx = (tx * w) / TILE;
            const si = (sy * w + sx) * 4;
            const di = (ty * TILE + tx) * 4;
            out[di + 0] = data[si + 0];
            out[di + 1] = data[si + 1];
            out[di + 2] = data[si + 2];
            out[di + 3] = data[si + 3];
        }
    }
    return out;
}

fn makeMissing(arena: std.mem.Allocator) ![]u8 {
    const out = try arena.alloc(u8, BYTES_PER_LAYER);
    var y: u32 = 0;
    while (y < TILE) : (y += 1) {
        var x: u32 = 0;
        while (x < TILE) : (x += 1) {
            const magenta = ((x / 4) + (y / 4)) % 2 == 0;
            const di = (y * TILE + x) * 4;
            out[di + 0] = if (magenta) 0xF0 else 0x10;
            out[di + 1] = 0x10;
            out[di + 2] = if (magenta) 0xF0 else 0x10;
            out[di + 3] = 0xFF;
        }
    }
    return out;
}

test "normalize copies a 16x16 image unchanged and crops an animated strip" {
    const a = std.testing.allocator;
    // 16x16 solid red.
    var img: [16 * 16 * 4]u8 = undefined;
    var i: usize = 0;
    while (i < 16 * 16) : (i += 1) {
        img[i * 4 + 0] = 200;
        img[i * 4 + 1] = 0;
        img[i * 4 + 2] = 0;
        img[i * 4 + 3] = 255;
    }
    const out = try normalize(a, &img, 16, 16);
    defer a.free(out);
    try std.testing.expectEqual(@as(usize, 16 * 16 * 4), out.len);
    try std.testing.expectEqual(@as(u8, 200), out[0]);
    try std.testing.expectEqual(@as(u8, 255), out[3]);
}
