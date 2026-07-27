//! Dimensions: identity, per-dimension render rules, and save discovery.
//!
//! A Java save keeps each dimension in its own region tree — the overworld at
//! `<save>/region`, the nether at `<save>/DIM-1/region`, the end at
//! `<save>/DIM1/region`, and data-pack dimensions under
//! `<save>/dimensions/<namespace>/<path>/region`. Multi-world servers (Paper,
//! Spigot) split the same three into sibling folders (`world`, `world_nether`,
//! `world_the_end`), each still using the DIM layout inside.
//!
//! Beyond where the files live, a dimension changes how it must be rendered:
//!
//!  - **The nether has a lid.** Bedrock at y=123..127 plus the dense netherrack
//!    crust under it seals the whole dimension; rendered as-is, a nether map is
//!    a flat grey plane. `ceiling_cut` drops everything above a Y before the
//!    tile is lit or meshed, so the map opens into the caverns — and the bake
//!    never pays for the geometry it would have thrown away.
//!
//!  - **Nothing there has sky light.** The overworld finds invisible cave
//!    geometry by asking "does sky light reach this cell?", which in the nether
//!    and the end answers "no" for every cell — culling either everything or
//!    nothing. Those dimensions use `open_volume` instead: a face is invisible
//!    when the cell it looks into cannot be reached from outside the tile
//!    window at all (see `light.computeOpen`).
//!
//!  - **They look nothing alike.** Fog, sky, and the light floor are what make
//!    a nether render read as the nether rather than a dark overworld. Those
//!    live here as viewer defaults and ship in the manifest's `atmosphere`.

const std = @import("std");

pub const Kind = enum { overworld, nether, end, custom };

pub const Rgb = [3]u8;

/// How a bake decides that geometry can never be seen.
pub const Visibility = enum {
    /// Faces looking into unlit cells below the `--caves` horizon are dropped
    /// (the overworld: sky light is a good proxy for "outdoors").
    sky_light,
    /// Faces looking into cells unreachable from outside the tile window are
    /// dropped. The only rule that works where no cell has sky light.
    open_volume,
};

pub const Profile = struct {
    /// Resource id, as the game names it.
    id: []const u8,
    /// Render sub-directory and manifest key. Empty for the overworld, which
    /// stays at the render root so existing deployments keep working.
    slug: []const u8,
    label: []const u8,
    kind: Kind,
    /// World Y above which blocks are dropped before lighting and meshing;
    /// null keeps the full column. See the module docs.
    ceiling_cut: ?i32 = null,
    visibility: Visibility = .sky_light,
    /// The `--caves` horizon this dimension defaults to when the flag is
    /// absent. Null keeps every face (what `--caves full` asks for).
    default_cave_y: ?i32 = 55,
    /// Blocks per overworld block — the nether's famous 8:1.
    coordinate_scale: f64 = 1.0,
    /// Viewer atmosphere: the sky dome gradient and the fog it fades into.
    sky_top: Rgb,
    sky_horizon: Rgb,
    fog: Rgb,
    /// Viewer light defaults: brightness floor at zero light, and how much the
    /// baked sky light counts (the nether's "sky" is the ceiling cut, so it is
    /// a faint openness cue rather than daylight).
    ambient: f32,
    daylight: f32,
};

pub const overworld: Profile = .{
    .id = "minecraft:overworld",
    .slug = "",
    .label = "Overworld",
    .kind = .overworld,
    .sky_top = .{ 77, 133, 214 },
    .sky_horizon = .{ 184, 212, 242 },
    .fog = .{ 184, 212, 242 },
    .ambient = 0.12,
    .daylight = 1.0,
};

pub const nether: Profile = .{
    .id = "minecraft:the_nether",
    .slug = "the_nether",
    .label = "The Nether",
    .kind = .nether,
    // Vanilla's nether noise densifies over the top ~24 blocks, so 104 is where
    // the sealed crust begins: cutting there opens the caverns while leaving
    // fortresses (bridges top out near y=90) and everything built below intact.
    .ceiling_cut = 104,
    // Measured on a 12×12-chunk nether: reachability culling drops 36% of the
    // vertices (910k → 578k) and 37% of the bytes versus keeping everything,
    // without losing a face any camera could reach.
    .visibility = .open_volume,
    .default_cave_y = null,
    .coordinate_scale = 8.0,
    .sky_top = .{ 40, 12, 10 },
    .sky_horizon = .{ 104, 40, 26 },
    .fog = .{ 104, 40, 26 },
    // The nether's own ambient_light is 0.1, which renders an honest but
    // unreadable black plate. The floor here keeps unlit rock reading as rock,
    // while `daylight` lets the light that enters through the roof cut model
    // depth: cavern mouths and the open surface stay bright, pits fall away,
    // and lava and glowstone still tower over both.
    .ambient = 0.26,
    .daylight = 0.9,
};

pub const end: Profile = .{
    .id = "minecraft:the_end",
    .slug = "the_end",
    .label = "The End",
    .kind = .end,
    // The end needs no visibility rule at all: its islands are shells over the
    // void with nothing sealed inside, so a reachability flood measured
    // byte-identical output for twice the light time. What it does need is for
    // the overworld's cave horizon to stay away — an island's underside is
    // unlit and permanently in view from below.
    .visibility = .sky_light,
    .default_cave_y = null,
    // The end's own fog is a pale mauve over a black sky (biome fog_color
    // 0xA080A0, sky_color 0) — the void reads as depth rather than emptiness.
    .sky_top = .{ 10, 8, 18 },
    .sky_horizon = .{ 34, 24, 45 },
    .fog = .{ 74, 58, 88 },
    // Sky light here is real openness — the islands are lit from above and
    // their undersides are not — so a low floor keeps that relief instead of
    // flattening the endstone into one pale slab.
    .ambient = 0.20,
    .daylight = 0.9,
};

/// A data-pack dimension: rendered like the overworld (nothing in the region
/// files says whether it has a ceiling), but kept under its own slug.
pub fn customProfile(arena: std.mem.Allocator, namespace: []const u8, path: []const u8) !Profile {
    var p = overworld;
    p.id = try std.fmt.allocPrint(arena, "{s}:{s}", .{ namespace, path });
    p.slug = try slugify(arena, namespace, path);
    p.label = try labelize(arena, path);
    p.kind = .custom;
    return p;
}

/// `namespace:some/path` -> `namespace.some.path`, restricted to the characters
/// a URL path segment and a directory name can both carry.
fn slugify(arena: std.mem.Allocator, namespace: []const u8, path: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    if (!std.mem.eql(u8, namespace, "minecraft")) {
        try appendSanitized(arena, &out, namespace);
        try out.append(arena, '.');
    }
    try appendSanitized(arena, &out, path);
    return out.toOwnedSlice(arena);
}

fn appendSanitized(arena: std.mem.Allocator, out: *std.ArrayList(u8), s: []const u8) !void {
    for (s) |ch| try out.append(arena, switch (ch) {
        'a'...'z', '0'...'9', '_', '-' => ch,
        'A'...'Z' => ch + 32,
        else => '.',
    });
}

/// `custom_void` -> `Custom Void`.
fn labelize(arena: std.mem.Allocator, path: []const u8) ![]const u8 {
    const buf = try arena.dupe(u8, path);
    var upper = true;
    for (buf) |*ch| {
        if (ch.* == '_' or ch.* == '/') {
            ch.* = ' ';
            upper = true;
        } else if (upper) {
            ch.* = std.ascii.toUpper(ch.*);
            upper = false;
        }
    }
    return buf;
}

/// Match a `--dimension` value against the built-in dimensions. Accepts the
/// friendly name, the resource id, and the on-disk folder ("nether", "DIM-1",
/// "minecraft:the_nether"). Null for anything else — the caller then looks for
/// a data-pack dimension with that id.
pub fn builtinFor(name: []const u8) ?Profile {
    const n = stripNamespace(name);
    if (eqIgnoreCase(n, "overworld") or eqIgnoreCase(name, "DIM0")) return overworld;
    if (eqIgnoreCase(n, "nether") or eqIgnoreCase(n, "the_nether") or eqIgnoreCase(name, "DIM-1")) return nether;
    if (eqIgnoreCase(n, "end") or eqIgnoreCase(n, "the_end") or eqIgnoreCase(name, "DIM1")) return end;
    return null;
}

fn stripNamespace(name: []const u8) []const u8 {
    const colon = std.mem.indexOfScalar(u8, name, ':') orelse return name;
    return name[colon + 1 ..];
}

fn eqIgnoreCase(a: []const u8, b: []const u8) bool {
    return std.ascii.eqlIgnoreCase(a, b);
}

/// One dimension of a save that actually has region files on disk.
pub const Found = struct {
    profile: Profile,
    /// Directory holding the `r.X.Z.mca` files.
    region_dir: []const u8,
};

const Candidate = struct { profile: Profile, subs: []const []const u8 };

/// Where each built-in dimension can live, in priority order. Vanilla writes
/// `DIM-1`/`DIM1`; the `dimensions/minecraft/...` form appears in some
/// converted and server-side saves.
fn builtinCandidates() [3]Candidate {
    return .{
        .{ .profile = overworld, .subs = &.{ "region", "dimensions/minecraft/overworld/region" } },
        .{ .profile = nether, .subs = &.{ "DIM-1/region", "dimensions/minecraft/the_nether/region" } },
        .{ .profile = end, .subs = &.{ "DIM1/region", "dimensions/minecraft/the_end/region" } },
    };
}

/// Every dimension present under `save_dir`, overworld first.
///
/// Also picks up the split-world server layout: pointed at `.../world`, it
/// finds `.../world_nether` and `.../world_the_end` beside it, which is how
/// Paper and Spigot store the same three dimensions.
pub fn discover(arena: std.mem.Allocator, io: std.Io, save_dir: []const u8) ![]Found {
    var out: std.ArrayList(Found) = .empty;
    const trimmed = trimTrailingSeparators(save_dir);

    for (builtinCandidates()) |candidate| {
        for (candidate.subs) |sub| {
            const path = try std.fmt.allocPrint(arena, "{s}/{s}", .{ trimmed, sub });
            if (try dirHasRegions(io, path)) {
                try out.append(arena, .{ .profile = candidate.profile, .region_dir = path });
                break;
            }
        }
    }

    // The save dir itself may BE a region directory (`vantage render .../DIM-1/region`).
    if (out.items.len == 0 and try dirHasRegions(io, trimmed)) {
        try out.append(arena, .{ .profile = inferFromPath(trimmed), .region_dir = trimmed });
        return out.toOwnedSlice(arena);
    }

    try discoverSiblings(arena, io, trimmed, &out);
    try discoverDatapack(arena, io, trimmed, &out);
    return out.toOwnedSlice(arena);
}

/// Paper/Spigot split worlds: `<world>_nether` and `<world>_the_end` sit beside
/// the overworld folder, each with the vanilla DIM layout inside.
fn discoverSiblings(arena: std.mem.Allocator, io: std.Io, save_dir: []const u8, out: *std.ArrayList(Found)) !void {
    const suffixes = [_]struct { suffix: []const u8, profile: Profile, sub: []const u8 }{
        .{ .suffix = "_nether", .profile = nether, .sub = "DIM-1/region" },
        .{ .suffix = "_the_end", .profile = end, .sub = "DIM1/region" },
    };
    for (suffixes) |entry| {
        if (hasProfile(out.items, entry.profile.id)) continue;
        // Don't chain `world_nether_nether` when already pointed at a split folder.
        if (std.mem.endsWith(u8, save_dir, entry.suffix)) continue;
        const path = try std.fmt.allocPrint(arena, "{s}{s}/{s}", .{ save_dir, entry.suffix, entry.sub });
        if (try dirHasRegions(io, path)) try out.append(arena, .{ .profile = entry.profile, .region_dir = path });
    }
}

/// Data-pack dimensions: `<save>/dimensions/<namespace>/<path>/region`. Nested
/// paths are walked one level deep, which covers everything vanilla allows in
/// practice (`namespace:name`) without unbounded recursion into a save.
fn discoverDatapack(arena: std.mem.Allocator, io: std.Io, save_dir: []const u8, out: *std.ArrayList(Found)) !void {
    const root = try std.fmt.allocPrint(arena, "{s}/dimensions", .{save_dir});
    var dir = std.Io.Dir.cwd().openDir(io, root, .{ .iterate = true }) catch return;
    defer dir.close(io);
    var it = dir.iterate();
    while (try it.next(io)) |entry| {
        if (entry.kind != .directory) continue;
        const namespace = try arena.dupe(u8, entry.name);
        const ns_path = try std.fmt.allocPrint(arena, "{s}/{s}", .{ root, namespace });
        var ns_dir = std.Io.Dir.cwd().openDir(io, ns_path, .{ .iterate = true }) catch continue;
        defer ns_dir.close(io);
        var ns_it = ns_dir.iterate();
        while (try ns_it.next(io)) |sub| {
            if (sub.kind != .directory) continue;
            const name = try arena.dupe(u8, sub.name);
            const region_dir = try std.fmt.allocPrint(arena, "{s}/{s}/region", .{ ns_path, name });
            if (!try dirHasRegions(io, region_dir)) continue;
            const id = try std.fmt.allocPrint(arena, "{s}:{s}", .{ namespace, name });
            if (hasProfile(out.items, id)) continue; // already found via DIM-1/DIM1
            const profile = if (std.mem.eql(u8, namespace, "minecraft"))
                builtinFor(name) orelse try customProfile(arena, namespace, name)
            else
                try customProfile(arena, namespace, name);
            if (hasProfile(out.items, profile.id)) continue;
            try out.append(arena, .{ .profile = profile, .region_dir = region_dir });
        }
    }
}

fn hasProfile(found: []const Found, id: []const u8) bool {
    for (found) |f| {
        if (std.mem.eql(u8, f.profile.id, id)) return true;
    }
    return false;
}

/// Guess a dimension from a region directory handed in directly, so
/// `vantage render <save>/DIM-1` still renders as the nether.
pub fn inferFromPath(path: []const u8) Profile {
    var norm_buf: [512]u8 = undefined;
    const n = @min(path.len, norm_buf.len);
    for (path[path.len - n ..], norm_buf[0..n]) |ch, *dst| dst.* = if (ch == '\\') '/' else std.ascii.toLower(ch);
    const p = norm_buf[0..n];
    if (std.mem.indexOf(u8, p, "dim-1") != null or std.mem.indexOf(u8, p, "the_nether") != null) return nether;
    if (std.mem.indexOf(u8, p, "dim1") != null or std.mem.indexOf(u8, p, "the_end") != null) return end;
    return overworld;
}

fn trimTrailingSeparators(path: []const u8) []const u8 {
    var p = path;
    while (p.len > 1 and (p[p.len - 1] == '/' or p[p.len - 1] == '\\')) p = p[0 .. p.len - 1];
    return p;
}

fn dirHasRegions(io: std.Io, path: []const u8) !bool {
    var dir = std.Io.Dir.cwd().openDir(io, path, .{ .iterate = true }) catch return false;
    defer dir.close(io);
    var it = dir.iterate();
    while (try it.next(io)) |e| {
        if (e.kind == .file and std.mem.startsWith(u8, e.name, "r.") and std.mem.endsWith(u8, e.name, ".mca")) return true;
    }
    return false;
}

/// The render output directory for a dimension: the root for the overworld
/// (so existing renders, deploys and viewer URLs are unchanged), a slug
/// sub-directory for everything else.
pub fn outputDir(arena: std.mem.Allocator, out_dir: []const u8, profile: Profile) ![]const u8 {
    if (profile.slug.len == 0) return out_dir;
    return std.fmt.allocPrint(arena, "{s}/{s}", .{ out_dir, profile.slug });
}

/// Where a dimension's spawn is, given the overworld spawn from level.dat. The
/// nether's portal-linked coordinates are the overworld's divided by 8; the end
/// has a fixed arrival platform. Everything else centres on its own terrain.
///
/// The Y matters as much as the XZ: the viewer frames its first shot on this
/// point before any terrain has streamed in, so a nether spawn at the player's
/// y=64 would open the map buried inside rock. Sitting just under the roof cut
/// starts the camera above everything; it settles onto the surface as tiles
/// arrive.
pub fn spawnFor(profile: Profile, overworld_spawn: ?[3]i32) ?[3]i32 {
    return switch (profile.kind) {
        .overworld, .custom => overworld_spawn,
        .nether => if (overworld_spawn) |s| .{
            @intFromFloat(@as(f64, @floatFromInt(s[0])) / profile.coordinate_scale),
            if (profile.ceiling_cut) |cut| cut - 4 else 64,
            @intFromFloat(@as(f64, @floatFromInt(s[2])) / profile.coordinate_scale),
        } else null,
        .end => .{ 100, 70, 0 }, // above the arrival platform, clear of the island
    };
}

test "builtinFor accepts friendly names, ids and folder names" {
    try std.testing.expectEqualStrings("minecraft:the_nether", builtinFor("nether").?.id);
    try std.testing.expectEqualStrings("minecraft:the_nether", builtinFor("minecraft:the_nether").?.id);
    try std.testing.expectEqualStrings("minecraft:the_nether", builtinFor("DIM-1").?.id);
    try std.testing.expectEqualStrings("minecraft:the_end", builtinFor("End").?.id);
    try std.testing.expectEqualStrings("minecraft:overworld", builtinFor("overworld").?.id);
    try std.testing.expect(builtinFor("aether") == null);
}

test "inferFromPath reads the dimension out of a region path" {
    try std.testing.expectEqual(Kind.nether, inferFromPath("saves/My World/DIM-1/region").kind);
    try std.testing.expectEqual(Kind.nether, inferFromPath("C:\\saves\\W\\dimensions\\minecraft\\the_nether\\region").kind);
    try std.testing.expectEqual(Kind.end, inferFromPath("saves/My World/DIM1/region").kind);
    try std.testing.expectEqual(Kind.overworld, inferFromPath("saves/My World/region").kind);
}

test "outputDir keeps the overworld at the render root" {
    const a = std.testing.allocator;
    const root = try outputDir(a, "out", overworld);
    try std.testing.expectEqualStrings("out", root);
    const sub = try outputDir(a, "out", nether);
    defer a.free(sub);
    try std.testing.expectEqualStrings("out/the_nether", sub);
}

test "custom dimensions get a filesystem- and URL-safe slug" {
    var arena_inst = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_inst.deinit();
    const a = arena_inst.allocator();
    const p = try customProfile(a, "aether", "the_aether");
    try std.testing.expectEqualStrings("aether:the_aether", p.id);
    try std.testing.expectEqualStrings("aether.the_aether", p.slug);
    try std.testing.expectEqualStrings("The Aether", p.label);
    const q = try customProfile(a, "minecraft", "custom/void");
    try std.testing.expectEqualStrings("custom.void", q.slug);
}

test "nether spawn scales the overworld spawn by the coordinate ratio" {
    const s = spawnFor(nether, .{ 800, 70, -400 }).?;
    try std.testing.expectEqual(@as(i32, 100), s[0]);
    try std.testing.expectEqual(@as(i32, -50), s[2]);
    // Under the roof cut, not at the player's overworld Y (which is solid rock).
    try std.testing.expectEqual(nether.ceiling_cut.? - 4, s[1]);
    try std.testing.expectEqual(@as(i32, 100), spawnFor(end, .{ 800, 70, -400 }).?[0]);
    try std.testing.expectEqual(@as(?[3]i32, null), spawnFor(overworld, null));
}
