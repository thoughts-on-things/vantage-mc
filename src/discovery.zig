//! Minecraft world discovery and library metadata.
//!
//! Discovery is deliberately bounded to known launcher roots (plus roots the
//! caller supplies). It never walks an entire drive, never follows symlinks,
//! and never writes to a save. A directory becomes a world only when it has a
//! readable `level.dat` and at least one overworld region file.

const std = @import("std");
const compress = @import("compress.zig");
const nbt = @import("nbt.zig");
const world = @import("world.zig");

pub const Source = enum {
    vanilla,
    prism,
    multimc,
    curseforge,
    modrinth,
    gdlauncher,
    custom,

    pub fn label(self: Source) []const u8 {
        return switch (self) {
            .vanilla => "Minecraft Launcher",
            .prism => "Prism Launcher",
            .multimc => "MultiMC",
            .curseforge => "CurseForge",
            .modrinth => "Modrinth",
            .gdlauncher => "GDLauncher",
            .custom => "Custom folder",
        };
    }
};

pub const WorldInfo = struct {
    /// Canonical absolute save-directory path when the platform supports it.
    path: []const u8,
    name: []const u8,
    last_played_ms: i64 = 0,
    data_version: i32 = 0,
    source: Source,
    icon_path: ?[]const u8 = null,
};

pub const Root = struct {
    path: []const u8,
    source: Source = .custom,
    /// Maximum directories below `path` to inspect. Known save roots use one;
    /// launcher instance roots need enough room for `<profile>/.minecraft/saves`.
    max_depth: u8 = 1,
};

pub const Environment = struct {
    appdata: ?[]const u8 = null,
    local_appdata: ?[]const u8 = null,
    userprofile: ?[]const u8 = null,
    home: ?[]const u8 = null,
};

/// Discover worlds from known launcher locations and optional caller-provided
/// roots. Returned strings live in `arena`. Duplicate paths are collapsed even
/// when two launchers point at the same save.
pub fn discover(
    arena: std.mem.Allocator,
    io: std.Io,
    env: Environment,
    extra_roots: []const Root,
) ![]WorldInfo {
    var roots: std.ArrayList(Root) = .empty;
    try appendKnownRoots(arena, &roots, env);
    try roots.appendSlice(arena, extra_roots);

    var out: std.ArrayList(WorldInfo) = .empty;
    var seen = std.StringHashMap(void).init(arena);
    for (roots.items) |root| {
        try scanRoot(arena, io, root, &out, &seen);
    }

    std.mem.sort(WorldInfo, out.items, {}, struct {
        fn less(_: void, a: WorldInfo, b: WorldInfo) bool {
            if (a.last_played_ms != b.last_played_ms) return a.last_played_ms > b.last_played_ms;
            const order = std.ascii.orderIgnoreCase(a.name, b.name);
            if (order != .eq) return order == .lt;
            return std.mem.lessThan(u8, a.path, b.path);
        }
    }.less);
    return out.toOwnedSlice(arena);
}

pub fn environmentFromProcess(environ: anytype) Environment {
    return .{
        .appdata = environ.get("APPDATA"),
        .local_appdata = environ.get("LOCALAPPDATA"),
        .userprofile = environ.get("USERPROFILE"),
        .home = environ.get("HOME"),
    };
}

fn appendKnownRoots(arena: std.mem.Allocator, roots: *std.ArrayList(Root), env: Environment) !void {
    if (env.appdata) |appdata| {
        try addRoot(arena, roots, appdata, ".minecraft/saves", .vanilla, 1);
        try addRoot(arena, roots, appdata, "PrismLauncher/instances", .prism, 4);
        try addRoot(arena, roots, appdata, "MultiMC/instances", .multimc, 4);
        try addRoot(arena, roots, appdata, "CurseForge/minecraft/Instances", .curseforge, 3);
        try addRoot(arena, roots, appdata, "com.modrinth.theseus/profiles", .modrinth, 3);
        try addRoot(arena, roots, appdata, "gdlauncher_next/instances", .gdlauncher, 4);
    }
    if (env.local_appdata) |local| {
        try addRoot(arena, roots, local, "Packages/Microsoft.MinecraftUWP_8wekyb3d8bbwe/LocalState/games/com.mojang/minecraftWorlds", .vanilla, 1);
        try addRoot(arena, roots, local, "ModrinthApp/profiles", .modrinth, 3);
    }
    if (env.userprofile) |profile| {
        try addRoot(arena, roots, profile, "curseforge/minecraft/Instances", .curseforge, 3);
    }
    // macOS and Linux defaults are harmless on Windows and make the discovery
    // API portable from day one.
    if (env.home) |home| {
        try addRoot(arena, roots, home, "Library/Application Support/minecraft/saves", .vanilla, 1);
        try addRoot(arena, roots, home, ".minecraft/saves", .vanilla, 1);
        try addRoot(arena, roots, home, ".local/share/PrismLauncher/instances", .prism, 4);
        try addRoot(arena, roots, home, ".local/share/multimc/instances", .multimc, 4);
    }
}

fn addRoot(
    arena: std.mem.Allocator,
    roots: *std.ArrayList(Root),
    base: []const u8,
    suffix: []const u8,
    source: Source,
    max_depth: u8,
) !void {
    try roots.append(arena, .{
        .path = try std.fs.path.join(arena, &.{ base, suffix }),
        .source = source,
        .max_depth = max_depth,
    });
}

fn scanRoot(
    arena: std.mem.Allocator,
    io: std.Io,
    root: Root,
    out: *std.ArrayList(WorldInfo),
    seen: *std.StringHashMap(void),
) !void {
    var dir = std.Io.Dir.cwd().openDir(io, root.path, .{ .iterate = true }) catch return;
    defer dir.close(io);
    try scanDir(arena, io, root.path, dir, root.source, 0, root.max_depth, out, seen);
}

fn scanDir(
    arena: std.mem.Allocator,
    io: std.Io,
    path: []const u8,
    dir: std.Io.Dir,
    source: Source,
    depth: u8,
    max_depth: u8,
    out: *std.ArrayList(WorldInfo),
    seen: *std.StringHashMap(void),
) !void {
    if (depth > 0 and fileExists(io, path, "level.dat")) {
        if (try world.findRegionDir(arena, io, path) != null) {
            try addWorld(arena, io, path, source, out, seen);
        }
        return; // never descend into a save (dimensions and data can be huge)
    }
    if (depth >= max_depth) return;

    var it = dir.iterate();
    while (try it.next(io)) |entry| {
        if (entry.kind != .directory) continue; // do not follow links/reparse points
        if (skipDirectory(entry.name)) continue;
        const child_path = try std.fs.path.join(arena, &.{ path, entry.name });
        var child = dir.openDir(io, entry.name, .{ .iterate = true }) catch continue;
        defer child.close(io);
        try scanDir(arena, io, child_path, child, source, depth + 1, max_depth, out, seen);
    }
}

fn addWorld(
    arena: std.mem.Allocator,
    io: std.Io,
    path: []const u8,
    source: Source,
    out: *std.ArrayList(WorldInfo),
    seen: *std.StringHashMap(void),
) !void {
    const canonical_z = std.Io.Dir.cwd().realPathFileAlloc(io, path, arena) catch try arena.dupeZ(u8, path);
    const canonical: []const u8 = canonical_z;
    const key = try normalizedPathKey(arena, canonical);
    const gop = try seen.getOrPut(key);
    if (gop.found_existing) return;

    const metadata = readMetadata(arena, io, canonical);
    const fallback = std.fs.path.basename(canonical);
    const icon = try std.fs.path.join(arena, &.{ canonical, "icon.png" });
    try out.append(arena, .{
        .path = canonical,
        .name = if (metadata.name.len > 0) metadata.name else try arena.dupe(u8, fallback),
        .last_played_ms = metadata.last_played_ms,
        .data_version = metadata.data_version,
        .source = source,
        .icon_path = if (absoluteFileExists(io, icon)) icon else null,
    });
}

const Metadata = struct {
    name: []const u8 = "",
    last_played_ms: i64 = 0,
    data_version: i32 = 0,
};

fn readMetadata(arena: std.mem.Allocator, io: std.Io, save_dir: []const u8) Metadata {
    const path = std.fs.path.join(arena, &.{ save_dir, "level.dat" }) catch return .{};
    const raw = std.Io.Dir.cwd().readFileAlloc(io, path, arena, .limited(64 * 1024 * 1024)) catch return .{};
    const bytes = compress.inflateGzip(arena, raw) catch return .{};
    var parser = nbt.Parser{ .buf = bytes, .arena = arena };
    const root = parser.parseRoot() catch return .{};
    const data_tag = nbt.get(root, "Data") orelse return .{};
    if (data_tag.* != .compound) return .{};
    const data = data_tag.compound;
    return .{
        .name = tagString(nbt.get(data, "LevelName")) orelse "",
        .last_played_ms = tagI64(nbt.get(data, "LastPlayed")) orelse 0,
        .data_version = tagI32(nbt.get(data, "DataVersion")) orelse 0,
    };
}

fn tagString(tag: ?*const nbt.Tag) ?[]const u8 {
    const t = tag orelse return null;
    return if (t.* == .string) t.string else null;
}

fn tagI64(tag: ?*const nbt.Tag) ?i64 {
    const t = tag orelse return null;
    return switch (t.*) {
        .long => |v| v,
        .int => |v| v,
        else => null,
    };
}

fn tagI32(tag: ?*const nbt.Tag) ?i32 {
    const t = tag orelse return null;
    return switch (t.*) {
        .int => |v| v,
        .short => |v| v,
        else => null,
    };
}

fn normalizedPathKey(arena: std.mem.Allocator, path: []const u8) ![]const u8 {
    const key = try arena.dupe(u8, path);
    for (key) |*c| {
        if (c.* == '\\') c.* = '/';
        if (@import("builtin").os.tag == .windows) c.* = std.ascii.toLower(c.*);
    }
    return key;
}

fn fileExists(io: std.Io, dir_path: []const u8, name: []const u8) bool {
    const path = std.fs.path.join(std.heap.page_allocator, &.{ dir_path, name }) catch return false;
    defer std.heap.page_allocator.free(path);
    return absoluteFileExists(io, path);
}

fn absoluteFileExists(io: std.Io, path: []const u8) bool {
    const stat = std.Io.Dir.cwd().statFile(io, path, .{}) catch return false;
    return stat.kind == .file;
}

fn skipDirectory(name: []const u8) bool {
    return std.mem.eql(u8, name, ".") or
        std.mem.eql(u8, name, "..") or
        std.mem.eql(u8, name, "backups") or
        std.mem.eql(u8, name, "resourcepacks") or
        std.mem.eql(u8, name, "screenshots") or
        std.mem.eql(u8, name, "shaderpacks");
}

test "readMetadata reads the committed demo world" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const io = std.testing.io;
    const source_dir = std.fs.path.dirname(@src().file) orelse ".";
    const repo_dir = std.fs.path.dirname(source_dir) orelse ".";
    const demo_world = try std.fs.path.join(a, &.{ repo_dir, "site", "demo-world" });
    const metadata = readMetadata(a, io, demo_world);
    try std.testing.expect(metadata.name.len > 0);
    try std.testing.expect(metadata.last_played_ms > 0);
}

test "normalizedPathKey is stable for separators" {
    const a = std.testing.allocator;
    const key = try normalizedPathKey(a, "C:\\Games\\World");
    defer a.free(key);
    if (@import("builtin").os.tag == .windows) {
        try std.testing.expectEqualStrings("c:/games/world", key);
    } else {
        try std.testing.expectEqualStrings("C:/Games/World", key);
    }
}
