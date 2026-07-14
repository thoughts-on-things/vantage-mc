//! Texture-array builder.
//!
//! Collects the block textures referenced by resolved models, decodes each PNG
//! (vendored stb_image, C interop), normalizes it to a fixed TILE×TILE RGBA
//! layer, and packs them into a single layered array. This is the data behind a
//! WebGL2 **texture array** — not a 2D atlas, so greedy-quad UV
//! repeat and NEAREST sampling work without the Minecraft mip/seam bug.
//!
//! Layer 0 is always a magenta/black "missing" checker, so an unresolved or
//! unreadable texture is loud rather than invisible. Animated textures (tall
//! strips with an .mcmeta animation clause) bake their whole resolved frame
//! sequence as consecutive layers — meshes reference the base layer and the
//! viewer's shader steps through the frames (water, lava, magma, kelp, …).
//! A tall strip *without* an .mcmeta still collapses to its first frame.

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
    /// Animated textures: playback metadata per baked frame sequence.
    anims: []const AnimEntry = &.{},
};

/// One animated texture: its frames occupy the consecutive layers
/// `base .. base+count-1` (meshes reference `base`; the shader adds the
/// current frame). The mcmeta `frames` order — ping-pong, repeats — is
/// already unrolled into the layer sequence, so playback is a linear wrap.
pub const AnimEntry = struct {
    base: u32,
    /// Layers in the baked sequence (≤ 255 so a shader LUT byte holds it).
    count: u16,
    /// Ticks per frame (mcmeta `frametime`, default 1; 20 ticks/second).
    frametime: u16,
    /// Blend adjacent frames instead of stepping (mcmeta `interpolate`).
    interpolate: bool,
};

pub const Builder = struct {
    arena: std.mem.Allocator,
    io: std.Io,
    /// Absolute path to `assets/minecraft`.
    root: []const u8,
    layers: std.ArrayList([]u8) = .empty,
    anims: std.ArrayList(AnimEntry) = .empty,
    map: std.StringHashMap(u32),
    /// Guards `layers`/`map` — tiles mesh on multiple threads and each new
    /// texture appends a layer. `arena` must be thread-safe too (the render
    /// path hands in a locked allocator).
    mutex: std.Io.Mutex = .init,

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
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (self.map.get(path)) |i| return i;
        const idx = self.load(path) catch return 0;
        return idx;
    }

    /// A layer's RGBA pixels, fetched under the lock (a concurrent append can
    /// move the `layers` backing array; the pixel buffers themselves are stable).
    pub fn layerPixels(self: *Builder, idx: u32) []const u8 {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        return self.layers.items[idx];
    }

    /// Layer index for a flat solid color (used by the mesher's fallback path
    /// for blocks with no resolvable model — fluids, unknowns). Cached by color.
    pub fn solidLayer(self: *Builder, rgb: [3]u8) !u32 {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
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

        const uw: u32 = @intCast(w);
        const uh: u32 = @intCast(h);
        // A vertical strip of frames with an .mcmeta animation clause bakes
        // every frame of the resolved sequence; without the clause it stays a
        // static texture (frame 0), as vanilla treats it.
        const nframes: u32 = if (uh > uw and uw != 0 and uh % uw == 0) uh / uw else 1;
        if (nframes > 1) {
            if (try self.loadAnimated(path, full, data, uw, uh, nframes)) |idx| return idx;
        }

        const layer = try normalizeFrame(self.arena, data, uw, uh, 0);
        // Render leaves solid rather than as sparse alpha-cutout holes — the
        // cleaner "map" look, and they occlude anyway. (Cross plants keep their
        // cutout, which is why this is leaf-specific.)
        if (std.mem.indexOf(u8, path, "leaves") != null) forceOpaque(layer);
        const idx: u32 = @intCast(self.layers.items.len);
        try self.layers.append(self.arena, layer);
        try self.map.put(path, idx);
        return idx;
    }

    /// Bake an animated texture: one layer per entry of the resolved frame
    /// sequence, plus its `AnimEntry`. Returns the base layer (what meshes
    /// reference), or null when there is no usable .mcmeta animation — the
    /// caller then falls back to the static frame-0 path.
    fn loadAnimated(self: *Builder, path: []const u8, png_path: []const u8, data: [*]const u8, w: u32, h: u32, nframes: u32) !?u32 {
        const meta = readMcmeta(self.arena, self.io, png_path, nframes) orelse return null;
        const base: u32 = @intCast(self.layers.items.len);
        for (meta.sequence) |fi| {
            try self.layers.append(self.arena, try normalizeFrame(self.arena, data, w, h, fi));
        }
        try self.anims.append(self.arena, .{
            .base = base,
            .count = @intCast(meta.sequence.len),
            .frametime = meta.frametime,
            .interpolate = meta.interpolate,
        });
        try self.map.put(path, base);
        return base;
    }

    pub fn finish(self: *Builder) !Array {
        return self.finishAlloc(self.arena);
    }

    /// Snapshot the current atlas into `alloc` (a copy — the builder keeps
    /// appending). The progressive-render flusher passes a scratch allocator so
    /// its periodic atlas re-serialization doesn't pile up in the run arena; it
    /// must hold `self.mutex` across the call, since a concurrent append can
    /// realloc `layers`/`anims`.
    pub fn finishAlloc(self: *Builder, alloc: std.mem.Allocator) !Array {
        const n = self.layers.items.len;
        const pixels = try alloc.alloc(u8, n * BYTES_PER_LAYER);
        for (self.layers.items, 0..) |layer, i| {
            @memcpy(pixels[i * BYTES_PER_LAYER ..][0..BYTES_PER_LAYER], layer);
        }
        return .{
            .width = TILE,
            .height = TILE,
            .layer_count = @intCast(n),
            .pixels = pixels,
            .anims = try alloc.dupe(AnimEntry, self.anims.items),
        };
    }

    /// Current layer count (thread-safe view for the progressive flusher, which
    /// re-writes the atlas only when this grew since the last flush).
    pub fn layerCount(self: *Builder) u32 {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        return @intCast(self.layers.items.len);
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

/// The resolved animation clause of one texture's .mcmeta.
const AnimMeta = struct {
    /// Frame indices in playback order (`frames` list unrolled, or 0..n-1).
    sequence: []const u32,
    frametime: u16,
    interpolate: bool,
};

/// Read and parse `<png_path>.mcmeta`'s animation clause. Null (not an error)
/// when the file is missing or holds no usable animation — the texture then
/// stays static, matching vanilla (a strip without .mcmeta is just tall).
fn readMcmeta(arena: std.mem.Allocator, io: std.Io, png_path: []const u8, nframes: u32) ?AnimMeta {
    const meta_path = std.fmt.allocPrint(arena, "{s}.mcmeta", .{png_path}) catch return null;
    const bytes = std.Io.Dir.cwd().readFileAlloc(io, meta_path, arena, .limited(1 << 20)) catch return null;
    return parseMcmeta(arena, bytes, nframes);
}

/// Parse an .mcmeta JSON body. `frames` entries may be ints or
/// `{index, time}` objects (per-frame times collapse to the shared frametime —
/// close enough, and it keeps shader playback a simple linear wrap). Out-of-range
/// indices are dropped; sequences cap at 255 so a LUT byte holds the count.
fn parseMcmeta(arena: std.mem.Allocator, bytes: []const u8, nframes: u32) ?AnimMeta {
    const root = std.json.parseFromSliceLeaky(std.json.Value, arena, bytes, .{}) catch return null;
    if (root != .object) return null;
    const anim = root.object.get("animation") orelse return null;
    if (anim != .object) return null;

    var frametime: u16 = 1;
    if (anim.object.get("frametime")) |ft| {
        if (ft == .integer) frametime = @intCast(std.math.clamp(ft.integer, 1, 65535));
    }
    var interpolate = false;
    if (anim.object.get("interpolate")) |ip| {
        if (ip == .bool) interpolate = ip.bool;
    }

    var seq: std.ArrayList(u32) = .empty;
    if (anim.object.get("frames")) |fr| {
        if (fr == .array) {
            for (fr.array.items) |f| {
                const idx: i64 = switch (f) {
                    .integer => f.integer,
                    .object => blk: {
                        const ii = f.object.get("index") orelse break :blk -1;
                        break :blk if (ii == .integer) ii.integer else -1;
                    },
                    else => -1,
                };
                if (idx >= 0 and idx < nframes) seq.append(arena, @intCast(idx)) catch return null;
                if (seq.items.len >= 255) break;
            }
        }
    }
    if (seq.items.len == 0) {
        var i: u32 = 0;
        while (i < @min(nframes, 255)) : (i += 1) seq.append(arena, i) catch return null;
    }
    return .{ .sequence = seq.items, .frametime = frametime, .interpolate = interpolate };
}

pub const ARRAY_MAGIC = "VTA1";

/// Serialize a texture array to a `.vtexarr` blob (version 2):
///   "VTA1", u32 version=2, u32 width, u32 height, u32 layer_count, RGBA pixels,
///   then the animation table: u32 count, per entry
///   { u32 base, u16 sequence_count, u16 frametime, u8 interpolate, u8[3] pad }.
/// The magic stays "VTA1" (it identifies the file type; `version` carries the
/// layout), and the table trails the pixels, so a version-1 reader that stops
/// after the pixels still shows every animated texture's first frame.
pub fn serialize(arena: std.mem.Allocator, arr: Array) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(arena, ARRAY_MAGIC);
    for ([_]u32{ 2, arr.width, arr.height, arr.layer_count }) |v| {
        var buf: [4]u8 = undefined;
        std.mem.writeInt(u32, &buf, v, .little);
        try out.appendSlice(arena, &buf);
    }
    try out.appendSlice(arena, arr.pixels);
    var buf: [4]u8 = undefined;
    std.mem.writeInt(u32, &buf, @intCast(arr.anims.len), .little);
    try out.appendSlice(arena, &buf);
    for (arr.anims) |a| {
        std.mem.writeInt(u32, &buf, a.base, .little);
        try out.appendSlice(arena, &buf);
        std.mem.writeInt(u16, buf[0..2], a.count, .little);
        std.mem.writeInt(u16, buf[2..4], a.frametime, .little);
        try out.appendSlice(arena, &buf);
        try out.appendSlice(arena, &.{ @intFromBool(a.interpolate), 0, 0, 0 });
    }
    return out.toOwnedSlice(arena);
}

/// Point-resample frame `frame` of a decoded RGBA image to TILE×TILE. For an
/// animation strip (height a multiple of width, height>width) each frame is a
/// width×width band; a plain texture is one frame. The caller guarantees
/// `frame < h / frame_h`.
fn normalizeFrame(arena: std.mem.Allocator, data: [*]const u8, w: u32, h: u32, frame: u32) ![]u8 {
    const frame_h: u32 = if (h > w and w != 0 and h % w == 0) w else h;
    const y0 = frame * frame_h;
    const out = try arena.alloc(u8, BYTES_PER_LAYER);
    var ty: u32 = 0;
    while (ty < TILE) : (ty += 1) {
        const sy = y0 + (ty * frame_h) / TILE;
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

fn forceOpaque(layer: []u8) void {
    var i: usize = 3;
    while (i < layer.len) : (i += 4) layer[i] = 0xFF;
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

test "normalizeFrame copies a 16x16 image unchanged and extracts strip frames" {
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
    const out = try normalizeFrame(a, &img, 16, 16, 0);
    defer a.free(out);
    try std.testing.expectEqual(@as(usize, 16 * 16 * 4), out.len);
    try std.testing.expectEqual(@as(u8, 200), out[0]);
    try std.testing.expectEqual(@as(u8, 255), out[3]);

    // A 16x48 strip of 3 frames with red channel = frame index: frame k
    // normalizes to a solid layer of value k.
    var strip: [16 * 48 * 4]u8 = undefined;
    var p: usize = 0;
    while (p < 16 * 48) : (p += 1) {
        strip[p * 4 + 0] = @intCast(p / (16 * 16)); // frame index
        strip[p * 4 + 1] = 7;
        strip[p * 4 + 2] = 9;
        strip[p * 4 + 3] = 255;
    }
    for (0..3) |k| {
        const fr = try normalizeFrame(a, &strip, 16, 48, @intCast(k));
        defer a.free(fr);
        try std.testing.expectEqual(@as(u8, @intCast(k)), fr[0]);
        try std.testing.expectEqual(@as(u8, @intCast(k)), fr[BYTES_PER_LAYER - 4]);
    }
}

test "parseMcmeta: defaults, frames list with objects, out-of-range, garbage" {
    var arena_inst = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_inst.deinit();
    const a = arena_inst.allocator();

    // Bare clause (water_flow style): frametime defaults to 1, frames 0..n-1.
    const bare = parseMcmeta(a, "{\"animation\": {}}", 4).?;
    try std.testing.expectEqual(@as(u16, 1), bare.frametime);
    try std.testing.expectEqual(@as(usize, 4), bare.sequence.len);
    try std.testing.expectEqual(@as(u32, 3), bare.sequence[3]);
    try std.testing.expect(!bare.interpolate);

    // Explicit ping-pong list (lava_still style) + frametime.
    const pp = parseMcmeta(a, "{\"animation\": {\"frametime\": 2, \"frames\": [0, 1, 2, 1]}}", 3).?;
    try std.testing.expectEqual(@as(u16, 2), pp.frametime);
    try std.testing.expectEqualSlices(u32, &.{ 0, 1, 2, 1 }, pp.sequence);

    // {index, time} entries and out-of-range indices; interpolate flag.
    const obj = parseMcmeta(a, "{\"animation\": {\"interpolate\": true, \"frames\": [{\"index\": 1, \"time\": 5}, 9, 0]}}", 2).?;
    try std.testing.expect(obj.interpolate);
    try std.testing.expectEqualSlices(u32, &.{ 1, 0 }, obj.sequence); // 9 dropped

    // No animation clause / broken JSON -> null (texture stays static).
    try std.testing.expectEqual(@as(?AnimMeta, null), parseMcmeta(a, "{\"texture\": {}}", 4));
    try std.testing.expectEqual(@as(?AnimMeta, null), parseMcmeta(a, "not json", 4));
}

test "serialize writes the version-2 anim table after the pixels" {
    var arena_inst = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_inst.deinit();
    const a = arena_inst.allocator();

    const pixels = try a.alloc(u8, 2 * BYTES_PER_LAYER);
    @memset(pixels, 0xAB);
    const anims = [_]AnimEntry{.{ .base = 1, .count = 3, .frametime = 2, .interpolate = true }};
    const arr: Array = .{ .width = TILE, .height = TILE, .layer_count = 2, .pixels = pixels, .anims = &anims };
    const bytes = try serialize(a, arr);

    try std.testing.expectEqualSlices(u8, ARRAY_MAGIC, bytes[0..4]);
    try std.testing.expectEqual(@as(u32, 2), std.mem.readInt(u32, bytes[4..8], .little)); // version
    const table = 20 + pixels.len;
    try std.testing.expectEqual(table + 4 + 12, bytes.len);
    try std.testing.expectEqual(@as(u32, 1), std.mem.readInt(u32, bytes[table..][0..4], .little));
    try std.testing.expectEqual(@as(u32, 1), std.mem.readInt(u32, bytes[table + 4 ..][0..4], .little)); // base
    try std.testing.expectEqual(@as(u16, 3), std.mem.readInt(u16, bytes[table + 8 ..][0..2], .little)); // count
    try std.testing.expectEqual(@as(u16, 2), std.mem.readInt(u16, bytes[table + 10 ..][0..2], .little)); // frametime
    try std.testing.expectEqual(@as(u8, 1), bytes[table + 12]); // interpolate
}
