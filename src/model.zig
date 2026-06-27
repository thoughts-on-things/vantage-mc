//! Block model resolver — the heart of P2.
//!
//! Turns a block name into renderable geometry by walking the vanilla resource
//! pipeline exactly as the game does:
//!
//!   blockstates/<block>.json   -> pick a variant (or multipart parts)
//!     -> models/<model>.json    -> resolve `parent` chain (textures merge,
//!                                  child elements override)
//!     -> resolve `#texture` variable references to real texture paths
//!     -> per-element, per-face: texture, uv, cullface, rotation, tintindex
//!
//! P2.1 scope: full variant + parent + texture + element/face resolution,
//! ignoring block-state property matching (picks the default/first variant) and
//! treating multipart as "apply all parts" (ignoring `when`). State-accurate
//! variant selection, real multipart `when` matching, and uv defaults per face
//! orientation are P2.4 hardening. All allocations come from `arena`.

const std = @import("std");
const json = std.json;

pub const Dir = enum {
    down,
    up,
    north,
    south,
    east,
    west,

    pub fn parse(s: []const u8) ?Dir {
        const map = .{
            .{ "down", Dir.down },   .{ "up", Dir.up },
            .{ "north", Dir.north }, .{ "south", Dir.south },
            .{ "east", Dir.east },   .{ "west", Dir.west },
            // tolerate legacy spellings
            .{ "bottom", Dir.down }, .{ "top", Dir.up },
        };
        inline for (map) |kv| {
            if (std.mem.eql(u8, s, kv[0])) return kv[1];
        }
        return null;
    }
};

pub const Face = struct {
    dir: Dir,
    /// Final texture path, namespace-stripped, e.g. "block/stone".
    texture: []const u8,
    /// [x1, y1, x2, y2] in 0..16 texel space.
    uv: [4]f64,
    cullface: ?Dir,
    /// Texture rotation in degrees (0/90/180/270).
    rotation: u16,
    /// Biome tint index, or -1 for none.
    tintindex: i32,
};

pub const Element = struct {
    from: [3]f64,
    to: [3]f64,
    faces: []Face,
};

pub const ResolvedModel = struct {
    elements: []Element,
    /// Whole-model rotation from the blockstate variant (degrees).
    x: u16 = 0,
    y: u16 = 0,
    uvlock: bool = false,
};

pub const Error = error{
    NotAnObject,
    NoModel,
    ParentLoop,
    BadElement,
} || std.mem.Allocator.Error || std.Io.Dir.ReadFileAllocError || json.ParseError(json.Scanner);

pub const Resolver = struct {
    arena: std.mem.Allocator,
    io: std.Io,
    /// Absolute path to the `assets/minecraft` directory.
    root: []const u8,

    /// Resolve every part of a block into a flat list of ResolvedModels (one per
    /// chosen variant / multipart part). Most blocks yield exactly one.
    pub fn resolveBlock(self: Resolver, block_name: []const u8) ![]ResolvedModel {
        const name = stripNs(block_name);
        const path = try std.fmt.allocPrint(self.arena, "{s}/blockstates/{s}.json", .{ self.root, name });
        const v = try self.loadJson(path);
        if (v != .object) return error.NotAnObject;
        const obj = v.object;

        var out: std.ArrayList(ResolvedModel) = .empty;

        if (obj.get("variants")) |variants| {
            const chosen = pickVariant(variants) orelse return error.NoModel;
            try out.append(self.arena, try self.resolveApply(chosen));
        } else if (obj.get("multipart")) |mp| {
            if (mp == .array) {
                for (mp.array.items) |part| {
                    if (part != .object) continue;
                    const apply = part.object.get("apply") orelse continue;
                    out.append(self.arena, try self.resolveApply(apply)) catch {};
                }
            }
        } else return error.NoModel;

        return out.toOwnedSlice(self.arena);
    }

    /// An "apply"/variant value: an object {model,x,y,uvlock} or an array of them
    /// (we take the first). Resolves the referenced model.
    fn resolveApply(self: Resolver, value: json.Value) !ResolvedModel {
        const o = switch (value) {
            .object => value.object,
            .array => if (value.array.items.len > 0 and value.array.items[0] == .object)
                value.array.items[0].object
            else
                return error.NoModel,
            else => return error.NoModel,
        };
        const model_ref = blk: {
            const m = o.get("model") orelse return error.NoModel;
            if (m != .string) return error.NoModel;
            break :blk m.string;
        };

        var g: Gathered = .{ .textures = std.StringHashMap([]const u8).init(self.arena) };
        try self.gather(model_ref, &g, 0);

        const elements = try self.buildElements(g);
        return .{
            .elements = elements,
            .x = @intCast(asInt(o.get("x"), 0)),
            .y = @intCast(asInt(o.get("y"), 0)),
            .uvlock = asBool(o.get("uvlock"), false),
        };
    }

    const Gathered = struct {
        textures: std.StringHashMap([]const u8),
        elements: ?json.Array = null,
    };

    /// Walk the parent chain. Parent is gathered first so the child overrides it
    /// (textures merge, elements replace).
    fn gather(self: Resolver, ref: []const u8, g: *Gathered, depth: u8) Error!void {
        if (depth > 32) return error.ParentLoop;
        const path = try std.fmt.allocPrint(self.arena, "{s}/models/{s}.json", .{ self.root, stripNs(ref) });
        const v = try self.loadJson(path);
        if (v != .object) return error.NotAnObject;
        const obj = v.object;

        if (obj.get("parent")) |p| {
            if (p == .string) try self.gather(p.string, g, depth + 1);
        }
        if (obj.get("textures")) |t| {
            if (t == .object) {
                var it = t.object.iterator();
                while (it.next()) |e| {
                    if (e.value_ptr.* == .string) {
                        try g.textures.put(e.key_ptr.*, e.value_ptr.*.string);
                    }
                }
            }
        }
        if (obj.get("elements")) |e| {
            if (e == .array) g.elements = e.array;
        }
    }

    fn buildElements(self: Resolver, g: Gathered) ![]Element {
        const raw = g.elements orelse return &.{};
        var elements: std.ArrayList(Element) = .empty;
        for (raw.items) |el| {
            if (el != .object) continue;
            const eo = el.object;
            const from = readVec3(eo.get("from")) orelse continue;
            const to = readVec3(eo.get("to")) orelse continue;

            var faces: std.ArrayList(Face) = .empty;
            if (eo.get("faces")) |f| {
                if (f == .object) {
                    var it = f.object.iterator();
                    while (it.next()) |entry| {
                        const dir = Dir.parse(entry.key_ptr.*) orelse continue;
                        if (entry.value_ptr.* != .object) continue;
                        const fo = entry.value_ptr.*.object;

                        const tex_ref = blk: {
                            const t = fo.get("texture") orelse break :blk "";
                            break :blk if (t == .string) t.string else "";
                        };
                        const texture = self.resolveTexture(g.textures, tex_ref, 0) orelse "block/missing";

                        const uv = readVec4(fo.get("uv")) orelse defaultUv(dir, from, to);
                        const cull = blk: {
                            const c = fo.get("cullface") orelse break :blk null;
                            break :blk if (c == .string) Dir.parse(c.string) else null;
                        };
                        try faces.append(self.arena, .{
                            .dir = dir,
                            .texture = texture,
                            .uv = uv,
                            .cullface = cull,
                            .rotation = @intCast(asInt(fo.get("rotation"), 0)),
                            .tintindex = @intCast(asInt(fo.get("tintindex"), -1)),
                        });
                    }
                }
            }
            try elements.append(self.arena, .{
                .from = from,
                .to = to,
                .faces = try faces.toOwnedSlice(self.arena),
            });
        }
        return elements.toOwnedSlice(self.arena);
    }

    /// Resolve a face's texture reference (e.g. "#all") through the textures map
    /// to a final path. Non-`#` values are treated as direct paths.
    fn resolveTexture(self: Resolver, textures: std.StringHashMap([]const u8), ref: []const u8, depth: u8) ?[]const u8 {
        if (depth > 16 or ref.len == 0) return null;
        if (ref[0] == '#') {
            const key = ref[1..];
            const next = textures.get(key) orelse return null;
            return self.resolveTexture(textures, next, depth + 1);
        }
        return stripNs(ref);
    }

    fn loadJson(self: Resolver, path: []const u8) !json.Value {
        const bytes = try std.Io.Dir.cwd().readFileAlloc(self.io, path, self.arena, .unlimited);
        return json.parseFromSliceLeaky(json.Value, self.arena, bytes, .{});
    }
};

fn pickVariant(variants: json.Value) ?json.Value {
    if (variants != .object) return null;
    // Prefer the empty key (no state), else the first entry.
    if (variants.object.get("")) |v| return v;
    var it = variants.object.iterator();
    if (it.next()) |e| return e.value_ptr.*;
    return null;
}

/// Strip a leading `namespace:` (e.g. "minecraft:block/stone" -> "block/stone").
pub fn stripNs(ref: []const u8) []const u8 {
    if (std.mem.indexOfScalar(u8, ref, ':')) |i| return ref[i + 1 ..];
    return ref;
}

fn asF64(v: ?json.Value, default: f64) f64 {
    const val = v orelse return default;
    return switch (val) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        else => default,
    };
}

fn asInt(v: ?json.Value, default: i64) i64 {
    const val = v orelse return default;
    return switch (val) {
        .integer => |i| i,
        .float => |f| @intFromFloat(f),
        else => default,
    };
}

fn asBool(v: ?json.Value, default: bool) bool {
    const val = v orelse return default;
    return switch (val) {
        .bool => |b| b,
        else => default,
    };
}

fn readVec3(v: ?json.Value) ?[3]f64 {
    const val = v orelse return null;
    if (val != .array or val.array.items.len < 3) return null;
    const a = val.array.items;
    return .{ asF64(a[0], 0), asF64(a[1], 0), asF64(a[2], 0) };
}

fn readVec4(v: ?json.Value) ?[4]f64 {
    const val = v orelse return null;
    if (val != .array or val.array.items.len < 4) return null;
    const a = val.array.items;
    return .{ asF64(a[0], 0), asF64(a[1], 0), asF64(a[2], 0), asF64(a[3], 0) };
}

/// Default face UV derived from the element box, per Minecraft's mapping.
fn defaultUv(dir: Dir, from: [3]f64, to: [3]f64) [4]f64 {
    return switch (dir) {
        .down => .{ from[0], from[2], to[0], to[2] },
        .up => .{ from[0], from[2], to[0], to[2] },
        .north => .{ 16 - to[0], 16 - to[1], 16 - from[0], 16 - from[1] },
        .south => .{ from[0], 16 - to[1], to[0], 16 - from[1] },
        .west => .{ from[2], 16 - to[1], to[2], 16 - from[1] },
        .east => .{ 16 - to[2], 16 - to[1], 16 - from[2], 16 - from[1] },
    };
}

test "stripNs" {
    try std.testing.expectEqualStrings("block/stone", stripNs("minecraft:block/stone"));
    try std.testing.expectEqualStrings("block/stone", stripNs("block/stone"));
}

test "Dir.parse" {
    try std.testing.expectEqual(Dir.down, Dir.parse("down").?);
    try std.testing.expectEqual(Dir.down, Dir.parse("bottom").?);
    try std.testing.expectEqual(Dir.up, Dir.parse("up").?);
    try std.testing.expect(Dir.parse("sideways") == null);
}

test "texture variable resolution chains through the map" {
    const a = std.testing.allocator;
    var m = std.StringHashMap([]const u8).init(a);
    defer m.deinit();
    try m.put("all", "#base");
    try m.put("base", "minecraft:block/stone");
    const r: Resolver = .{ .arena = a, .io = undefined, .root = "" };
    try std.testing.expectEqualStrings("block/stone", r.resolveTexture(m, "#all", 0).?);
    try std.testing.expectEqualStrings("block/dirt", r.resolveTexture(m, "block/dirt", 0).?);
    try std.testing.expect(r.resolveTexture(m, "#missing", 0) == null);
}
