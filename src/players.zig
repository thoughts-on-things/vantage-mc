//! Live player positions — the "who is standing where" layer of a Vantage map.
//!
//! Vantage renders terrain from persisted region files and never joins the game,
//! so it cannot observe a moving player by itself. Two sources fill that in, and
//! both end up as the same small `players.json` document beside the manifest:
//!
//!   * **A host feed** (`--players-file`). The privileged supervisor that owns
//!     the Minecraft process already knows where everyone is; it rewrites a tiny
//!     JSON file as often as it likes and Vantage serves whatever it last wrote.
//!     The accepted shape is a superset of BlueMap's `live/players.json`, so an
//!     existing BlueMap plugin's output can be pointed at this flag verbatim.
//!     This is the only source that is genuinely live.
//!
//!   * **The save itself** (`playerdata/*.dat` plus `level.dat`'s singleplayer
//!     player). Minecraft persists each player's position on autosave and on
//!     quit, so this is a *last known* position, not a live one — every player
//!     it produces is marked `stale` and carries the file's modification time.
//!     It needs no plugin, no configuration and no cooperation from the server,
//!     which is what makes a local `vantage live` show your character where you
//!     left them.
//!
//! Keeping the transport GET-only matters: the sidecar's data plane has no
//! remote mutation surface, and the supervisor that owns the save path already
//! owns a filesystem it can write to. See `docs/players.md`.

const std = @import("std");
const compress = @import("compress.zig");
const nbt = @import("nbt.zig");

/// A player list is a roster, not a data feed: a server with more players than
/// this has other problems, and the cap bounds every allocation below.
pub const MAX_PLAYERS: usize = 512;

/// A host feed is a few hundred bytes per player. Anything larger is a mistake
/// (or a wrong path), and reading it would be the mistake compounding.
pub const HOST_FILE_LIMIT: usize = 4 * 1024 * 1024;

/// One `playerdata/<uuid>.dat`. Inventories and advancement state make these
/// bigger than you would guess, but never megabytes.
pub const PLAYER_FILE_LIMIT: usize = 4 * 1024 * 1024;

/// Where a snapshot came from. The viewer shows last-known positions
/// differently from live ones, so this travels with the payload.
pub const Origin = enum {
    /// A supervisor-written feed: live, as fresh as the writer makes it.
    host,
    /// Read out of the save's own player files: last known positions.
    playerdata,

    pub fn label(self: Origin) []const u8 {
        return switch (self) {
            .host => "host",
            .playerdata => "playerdata",
        };
    }
};

pub const Player = struct {
    /// Canonical lowercase `8-4-4-4-12` where we know it, else whatever opaque
    /// id the host used. Only ever compared, never parsed, by the viewer.
    uuid: []const u8,
    name: []const u8,
    x: f64 = 0,
    y: f64 = 0,
    z: f64 = 0,
    /// Degrees, Minecraft's convention: 0 = facing +Z (south), increasing
    /// toward -X (west). Pitch is negative looking up.
    yaw: f32 = 0,
    pitch: f32 = 0,
    /// Resource id of the dimension the player is in, when known.
    dimension: ?[]const u8 = null,
    /// The player is not in the dimension this render covers. BlueMap's flag,
    /// with BlueMap's meaning: the viewer hides them from the map by default
    /// but still lists them as online.
    foreign: bool = false,
    health: ?f32 = null,
    gamemode: ?[]const u8 = null,
    /// Optional skin image, as a path relative to the manifest (the map's own
    /// origin). Absolute URLs are deliberately not accepted here — see
    /// `docs/players.md`.
    skin: ?[]const u8 = null,
    /// This position is the last one persisted, not a live report.
    stale: bool = false,
    /// Milliseconds since the epoch when the position was observed, or 0.
    seen_ms: i64 = 0,
};

pub const Snapshot = struct {
    players: []const Player,
    origin: Origin,
    /// Milliseconds since the epoch. Taken from the *source's* modification
    /// time rather than the clock, so an idle world re-serializes to identical
    /// bytes and its poll costs a `304` instead of a body.
    updated_ms: i64 = 0,
};

// --- serialization ----------------------------------------------------------

/// Serialize the canonical `players.json`. The result is also a valid BlueMap
/// live-players document (`players[].{uuid,name,foreign,position,rotation}`);
/// everything else is additive.
pub fn serialize(a: std.mem.Allocator, snap: Snapshot) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.print(a, "{{\n  \"format\": 1,\n  \"source\": \"{s}\",\n  \"updated\": {d},\n  \"players\": [\n", .{
        snap.origin.label(), snap.updated_ms,
    });
    for (snap.players, 0..) |p, i| {
        try out.appendSlice(a, "    { \"uuid\": ");
        try appendJsonString(a, &out, p.uuid);
        try out.appendSlice(a, ", \"name\": ");
        try appendJsonString(a, &out, p.name);
        // Coordinates are rounded rather than printed exactly: two decimals is
        // a centimetre, far below anything the map can show, and fixing the
        // precision keeps an unmoved player's bytes — and therefore the
        // response's validator — stable.
        try out.print(a, ", \"foreign\": {s}, \"position\": {{ \"x\": {d:.2}, \"y\": {d:.2}, \"z\": {d:.2} }}, \"rotation\": {{ \"yaw\": {d:.1}, \"pitch\": {d:.1} }}", .{
            if (p.foreign) "true" else "false", p.x, p.y, p.z, p.yaw, p.pitch,
        });
        if (p.dimension) |d| {
            try out.appendSlice(a, ", \"dimension\": ");
            try appendJsonString(a, &out, d);
        }
        if (p.health) |h| try out.print(a, ", \"health\": {d:.1}", .{h});
        if (p.gamemode) |g| {
            try out.appendSlice(a, ", \"gamemode\": ");
            try appendJsonString(a, &out, g);
        }
        if (p.skin) |s| {
            try out.appendSlice(a, ", \"skin\": ");
            try appendJsonString(a, &out, s);
        }
        if (p.stale) try out.appendSlice(a, ", \"stale\": true");
        if (p.seen_ms != 0) try out.print(a, ", \"seen\": {d}", .{p.seen_ms});
        try out.print(a, " }}{s}\n", .{if (i + 1 < snap.players.len) "," else ""});
    }
    try out.appendSlice(a, "  ]\n}\n");
    return out.toOwnedSlice(a);
}

fn appendJsonString(a: std.mem.Allocator, out: *std.ArrayList(u8), s: []const u8) !void {
    try out.append(a, '"');
    for (s) |ch| switch (ch) {
        '"' => try out.appendSlice(a, "\\\""),
        '\\' => try out.appendSlice(a, "\\\\"),
        '\n' => try out.appendSlice(a, "\\n"),
        '\r' => try out.appendSlice(a, "\\r"),
        '\t' => try out.appendSlice(a, "\\t"),
        else => if (ch < 0x20) {
            try out.print(a, "\\u{x:0>4}", .{ch});
        } else {
            try out.append(a, ch);
        },
    };
    try out.append(a, '"');
}

// --- host feed --------------------------------------------------------------

pub const ParseError = error{InvalidPlayerDocument} || std.mem.Allocator.Error;

/// Parse a host-written player document into a snapshot.
///
/// The accepted shape is BlueMap's, widened where a host might reasonably
/// disagree: coordinates may sit in `position` or flat on the entry, rotation
/// may be `rotation` or flat `yaw`/`pitch`, and the dimension may be called
/// `dimension` or `world`. Entries that carry no usable position are dropped
/// individually — one malformed player must not cost the map the rest of them.
///
/// `dimension_id` is the dimension this render covers; a player elsewhere is
/// marked `foreign` even when the host didn't say so.
pub fn parseHostDocument(
    arena: std.mem.Allocator,
    bytes: []const u8,
    dimension_id: []const u8,
    updated_ms: i64,
) ParseError!Snapshot {
    const root = std.json.parseFromSliceLeaky(std.json.Value, arena, bytes, .{}) catch
        return error.InvalidPlayerDocument;
    // A bare array is accepted too: it is the obvious thing for a host to write
    // and costs one branch to support.
    const list = switch (root) {
        .array => |items| items.items,
        .object => |obj| blk: {
            const players = obj.get("players") orelse return error.InvalidPlayerDocument;
            if (players != .array) return error.InvalidPlayerDocument;
            break :blk players.array.items;
        },
        else => return error.InvalidPlayerDocument,
    };

    var out: std.ArrayList(Player) = .empty;
    for (list) |entry| {
        if (out.items.len == MAX_PLAYERS) break;
        if (entry != .object) continue;
        const o = entry.object;
        const pos = o.get("position");
        const x = jsonNumber(if (pos) |p| objectField(p, "x") else o.get("x")) orelse continue;
        const y = jsonNumber(if (pos) |p| objectField(p, "y") else o.get("y")) orelse continue;
        const z = jsonNumber(if (pos) |p| objectField(p, "z") else o.get("z")) orelse continue;
        if (!inWorld(x) or !inWorld(z) or !std.math.isFinite(y)) continue;

        const rot = o.get("rotation");
        const yaw = jsonNumber(if (rot) |r| objectField(r, "yaw") else o.get("yaw")) orelse 0;
        const pitch = jsonNumber(if (rot) |r| objectField(r, "pitch") else o.get("pitch")) orelse 0;

        const uuid = try text(arena, o.get("uuid"), 64);
        const name = try text(arena, o.get("name"), 64);
        if (uuid == null and name == null) continue; // nothing to key them by
        const dimension = try text(arena, o.get("dimension") orelse o.get("world"), 128);
        const elsewhere = dimension != null and dimension_id.len > 0 and
            !std.mem.eql(u8, dimension.?, dimension_id);

        try out.append(arena, .{
            .uuid = uuid orelse name.?,
            .name = name orelse uuid.?,
            .x = x,
            .y = y,
            .z = z,
            .yaw = @floatCast(wrapDegrees(yaw)),
            .pitch = @floatCast(std.math.clamp(pitch, -90, 90)),
            .dimension = dimension,
            // The host's own `foreign` still counts: it may be running one
            // Vantage per dimension behind a proxy, or hiding players for
            // reasons of its own.
            .foreign = elsewhere or jsonBool(o.get("foreign")),
            .health = if (jsonNumber(o.get("health"))) |h| @floatCast(h) else null,
            .gamemode = try text(arena, o.get("gamemode"), 32),
            .skin = try relativeSkinPath(arena, o.get("skin")),
            .stale = jsonBool(o.get("stale")),
            .seen_ms = if (jsonNumber(o.get("seen"))) |s| @intFromFloat(std.math.clamp(s, 0, 1e15)) else 0,
        });
    }
    return .{ .players = try out.toOwnedSlice(arena), .origin = .host, .updated_ms = updated_ms };
}

fn objectField(value: std.json.Value, name: []const u8) ?std.json.Value {
    if (value != .object) return null;
    return value.object.get(name);
}

fn jsonBool(value: ?std.json.Value) bool {
    const v = value orelse return false;
    return v == .bool and v.bool;
}

fn jsonNumber(value: ?std.json.Value) ?f64 {
    const v = value orelse return null;
    const raw: f64 = switch (v) {
        .integer => |n| @floatFromInt(n),
        .float => |f| f,
        else => return null,
    };
    return if (std.math.isFinite(raw)) raw else null;
}

/// Minecraft's world border maxes out at ±29,999,984 blocks.
fn inWorld(v: f64) bool {
    return std.math.isFinite(v) and @abs(v) <= 30_000_000;
}

fn wrapDegrees(deg: f64) f64 {
    const wrapped = @mod(deg + 180, 360);
    return (if (wrapped < 0) wrapped + 360 else wrapped) - 180;
}

/// A bounded, copied string, or null when the field is absent or not a string.
/// Everything here is untrusted input that ends up in a browser: the length cap
/// keeps one entry from bloating the document, and the JSON writer escapes the
/// rest.
fn text(arena: std.mem.Allocator, value: ?std.json.Value, max: usize) !?[]const u8 {
    const v = value orelse return null;
    if (v != .string) return null;
    if (v.string.len == 0) return null;
    return try arena.dupe(u8, v.string[0..@min(v.string.len, max)]);
}

/// A skin reference is resolved against the map's own directory by the client,
/// so only a plain relative path is accepted. Anything that could leave that
/// origin — a scheme, a host, a traversal, a backslash — is dropped rather than
/// forwarded, because the client attaches the viewer's credentials to whatever
/// the manifest names.
fn relativeSkinPath(arena: std.mem.Allocator, value: ?std.json.Value) !?[]const u8 {
    const raw = (try text(arena, value, 256)) orelse return null;
    if (raw.len == 0 or raw[0] == '/') return null;
    if (std.mem.indexOfScalar(u8, raw, ':') != null) return null;
    if (std.mem.indexOfScalar(u8, raw, '\\') != null) return null;
    for (raw) |c| switch (c) {
        'a'...'z', 'A'...'Z', '0'...'9', '-', '_', '.', '/' => {},
        else => return null,
    };
    var it = std.mem.splitScalar(u8, raw, '/');
    while (it.next()) |part| {
        if (part.len == 0 or std.mem.eql(u8, part, ".") or std.mem.eql(u8, part, "..")) return null;
    }
    return raw;
}

// --- the save's own player files --------------------------------------------

/// Read every player the save knows about: one entry per `playerdata/*.dat`,
/// plus `level.dat`'s embedded singleplayer player when it isn't already one of
/// them. Names come from `usercache.json` when the server keeps one.
///
/// Failures are not errors here. A save mid-write, an unreadable file, a format
/// this parser doesn't recognise — each costs that one player, never the
/// snapshot, because a player list is decoration on a map that has to keep
/// working.
pub fn readSaveSnapshot(
    arena: std.mem.Allocator,
    io: std.Io,
    save_dir: []const u8,
    dimension_id: []const u8,
) !Snapshot {
    var names = try readUserCache(arena, io, save_dir);
    var out: std.ArrayList(Player) = .empty;
    var updated_ms: i64 = 0;

    const dir_path = try std.fmt.allocPrint(arena, "{s}/playerdata", .{save_dir});
    if (std.Io.Dir.cwd().openDir(io, dir_path, .{ .iterate = true })) |dir_const| {
        var dir = dir_const;
        defer dir.close(io);
        var it = dir.iterate();
        while (it.next(io) catch null) |entry| {
            if (out.items.len == MAX_PLAYERS) break;
            if (entry.kind != .file) continue;
            // `.dat_old` is the previous autosave; reading both would list every
            // player twice, with the stale copy winning half the time.
            if (!std.mem.endsWith(u8, entry.name, ".dat")) continue;
            const uuid = canonicalUuid(entry.name[0 .. entry.name.len - 4]) orelse continue;
            const path = try std.fmt.allocPrint(arena, "{s}/{s}", .{ dir_path, entry.name });
            const seen_ms = fileMillis(io, path);
            const raw = std.Io.Dir.cwd().readFileAlloc(io, path, arena, .limited(PLAYER_FILE_LIMIT)) catch continue;
            const player = playerFromNbt(arena, raw, try arena.dupe(u8, uuid), names.get(uuid), dimension_id, seen_ms) orelse continue;
            updated_ms = @max(updated_ms, seen_ms);
            try out.append(arena, player);
        }
    } else |_| {}

    // Singleplayer saves keep the player inside `level.dat` as well as (or
    // instead of) `playerdata`. Adding it unconditionally would show the local
    // player twice on their own map, so it only fills a gap.
    if (out.items.len < MAX_PLAYERS) {
        const level_path = try std.fmt.allocPrint(arena, "{s}/level.dat", .{save_dir});
        if (readLevelPlayer(arena, io, level_path, &names, dimension_id)) |player| {
            for (out.items) |existing| {
                if (std.mem.eql(u8, existing.uuid, player.uuid)) break;
            } else {
                updated_ms = @max(updated_ms, player.seen_ms);
                try out.append(arena, player);
            }
        }
    }

    return .{ .players = try out.toOwnedSlice(arena), .origin = .playerdata, .updated_ms = updated_ms };
}

/// The singleplayer player, from `level.dat`'s `Data.Player` compound.
fn readLevelPlayer(
    arena: std.mem.Allocator,
    io: std.Io,
    path: []const u8,
    names: *const std.StringHashMap([]const u8),
    dimension_id: []const u8,
) ?Player {
    const seen_ms = fileMillis(io, path);
    const raw = std.Io.Dir.cwd().readFileAlloc(io, path, arena, .limited(PLAYER_FILE_LIMIT)) catch return null;
    const bytes = compress.inflateGzip(arena, raw) catch return null;
    var parser = nbt.Parser{ .buf = bytes, .arena = arena };
    const root = parser.parseRoot() catch return null;
    const data = nbt.get(root, "Data") orelse return null;
    if (data.* != .compound) return null;
    const player = nbt.get(data.compound, "Player") orelse return null;
    if (player.* != .compound) return null;
    const uuid = uuidFromTag(arena, nbt.get(player.compound, "UUID")) orelse "singleplayer";
    return playerFromCompound(player.compound, uuid, names.get(uuid), dimension_id, seen_ms);
}

/// Decode one `playerdata/<uuid>.dat`. Player files are gzip-wrapped NBT, like
/// `level.dat`.
fn playerFromNbt(
    arena: std.mem.Allocator,
    raw: []const u8,
    uuid: []const u8,
    name: ?[]const u8,
    dimension_id: []const u8,
    seen_ms: i64,
) ?Player {
    const bytes = compress.inflateGzip(arena, raw) catch return null;
    var parser = nbt.Parser{ .buf = bytes, .arena = arena };
    const root = parser.parseRoot() catch return null;
    return playerFromCompound(root, uuid, name, dimension_id, seen_ms);
}

fn playerFromCompound(
    entries: []const nbt.Entry,
    uuid: []const u8,
    name: ?[]const u8,
    dimension_id: []const u8,
    seen_ms: i64,
) ?Player {
    const pos = nbt.get(entries, "Pos") orelse return null;
    if (pos.* != .list or pos.list.items.len < 3) return null;
    const x = tagDouble(pos.list.items[0]) orelse return null;
    const y = tagDouble(pos.list.items[1]) orelse return null;
    const z = tagDouble(pos.list.items[2]) orelse return null;
    if (!inWorld(x) or !inWorld(z) or !std.math.isFinite(y)) return null;

    var yaw: f64 = 0;
    var pitch: f64 = 0;
    if (nbt.get(entries, "Rotation")) |rot| {
        // Minecraft stores rotation as [yaw, pitch] — the opposite order to how
        // it names them in commands.
        if (rot.* == .list and rot.list.items.len >= 2) {
            yaw = tagDouble(rot.list.items[0]) orelse 0;
            pitch = tagDouble(rot.list.items[1]) orelse 0;
        }
    }

    // 1.16+ writes the dimension as a resource id; older saves used an int
    // (-1/0/1), which is not worth decoding — an unknown dimension simply
    // doesn't get filtered.
    var dimension: ?[]const u8 = null;
    if (nbt.get(entries, "Dimension")) |d| {
        if (d.* == .string and d.string.len > 0 and d.string.len <= 128) dimension = d.string;
    }

    return .{
        .uuid = uuid,
        .name = name orelse shortUuid(uuid),
        .x = x,
        .y = y,
        .z = z,
        .yaw = @floatCast(wrapDegrees(yaw)),
        .pitch = @floatCast(std.math.clamp(pitch, -90, 90)),
        .dimension = dimension,
        .foreign = dimension != null and dimension_id.len > 0 and !std.mem.eql(u8, dimension.?, dimension_id),
        .health = if (nbt.get(entries, "Health")) |h| tagFloat(h.*) else null,
        .gamemode = gameTypeName(nbt.get(entries, "playerGameType")),
        // Every position from disk is where the player *was* when the world was
        // last saved. Saying so is the difference between a map that is honest
        // and one that quietly lies about a player who logged off yesterday.
        .stale = true,
        .seen_ms = seen_ms,
    };
}

fn tagDouble(tag: nbt.Tag) ?f64 {
    return switch (tag) {
        .double => |v| v,
        .float => |v| v,
        .int => |v| @floatFromInt(v),
        else => null,
    };
}

fn tagFloat(tag: nbt.Tag) ?f32 {
    return switch (tag) {
        .float => |v| v,
        .double => |v| @floatCast(v),
        .int => |v| @floatFromInt(v),
        .short => |v| @floatFromInt(v),
        else => null,
    };
}

fn gameTypeName(tag: ?*const nbt.Tag) ?[]const u8 {
    const t = tag orelse return null;
    const value: i64 = switch (t.*) {
        .int => |v| v,
        .byte => |v| v,
        .short => |v| v,
        else => return null,
    };
    return switch (value) {
        0 => "survival",
        1 => "creative",
        2 => "adventure",
        3 => "spectator",
        else => null,
    };
}

/// `usercache.json` maps UUIDs to the names players last logged in with. It
/// belongs to the *server*, not the world, so it usually sits one directory up
/// from the save; both places are checked.
fn readUserCache(arena: std.mem.Allocator, io: std.Io, save_dir: []const u8) !std.StringHashMap([]const u8) {
    var names = std.StringHashMap([]const u8).init(arena);
    const candidates = [_][]const u8{
        try std.fmt.allocPrint(arena, "{s}/usercache.json", .{save_dir}),
        try std.fmt.allocPrint(arena, "{s}/../usercache.json", .{save_dir}),
    };
    for (candidates) |path| {
        const bytes = std.Io.Dir.cwd().readFileAlloc(io, path, arena, .limited(HOST_FILE_LIMIT)) catch continue;
        const root = std.json.parseFromSliceLeaky(std.json.Value, arena, bytes, .{}) catch continue;
        if (root != .array) continue;
        for (root.array.items) |entry| {
            if (entry != .object) continue;
            const uuid_value = entry.object.get("uuid") orelse continue;
            const name_value = entry.object.get("name") orelse continue;
            if (uuid_value != .string or name_value != .string) continue;
            const uuid = canonicalUuid(uuid_value.string) orelse continue;
            if (name_value.string.len == 0 or name_value.string.len > 64) continue;
            try names.put(try arena.dupe(u8, uuid), try arena.dupe(u8, name_value.string));
        }
        break; // the first cache that parses wins
    }
    return names;
}

/// A lowercase canonical UUID, or null if `text` isn't one. Returns a slice of
/// a static-lifetime buffer only when the input already was canonical, so
/// callers that keep it must dupe.
fn canonicalUuid(raw: []const u8) ?[]const u8 {
    if (raw.len != 36) return null;
    for (raw, 0..) |c, i| {
        if (i == 8 or i == 13 or i == 18 or i == 23) {
            if (c != '-') return null;
        } else switch (c) {
            '0'...'9', 'a'...'f' => {},
            'A'...'F' => return null, // canonical form is lowercase
            else => return null,
        }
    }
    return raw;
}

/// The 128-bit `UUID` int array modern saves carry, formatted canonically.
fn uuidFromTag(arena: std.mem.Allocator, tag: ?*const nbt.Tag) ?[]const u8 {
    const t = tag orelse return null;
    if (t.* != .int_array or t.int_array.len < 4) return null;
    const w: [4]u32 = .{
        @bitCast(t.int_array[0]),
        @bitCast(t.int_array[1]),
        @bitCast(t.int_array[2]),
        @bitCast(t.int_array[3]),
    };
    return std.fmt.allocPrint(arena, "{x:0>8}-{x:0>4}-{x:0>4}-{x:0>4}-{x:0>4}{x:0>8}", .{
        w[0],
        w[1] >> 16,
        w[1] & 0xffff,
        w[2] >> 16,
        w[2] & 0xffff,
        w[3],
    }) catch null;
}

/// A readable stand-in when no name is known: the UUID's first group. Better
/// than a 36-character label on a marker, and still distinguishes players.
fn shortUuid(uuid: []const u8) []const u8 {
    const dash = std.mem.indexOfScalar(u8, uuid, '-') orelse return uuid[0..@min(uuid.len, 8)];
    return uuid[0..dash];
}

/// A file's modification time in milliseconds since the epoch, or 0.
fn fileMillis(io: std.Io, path: []const u8) i64 {
    const stat = std.Io.Dir.cwd().statFile(io, path, .{}) catch return 0;
    const ms = @divTrunc(stat.mtime.nanoseconds, std.time.ns_per_ms);
    if (ms <= 0 or ms > std.math.maxInt(i64)) return 0;
    return @intCast(ms);
}

// --- the served feed --------------------------------------------------------

pub const Mode = enum { off, host_file, save };

/// How many player positions are handed to the prebake scheduler. Matches the
/// focus-point cap: several players in one base are one place to warm.
pub const MAX_FOCUS: usize = 16;

/// The serialized snapshot a request gets, plus its validator.
pub const Body = struct {
    bytes: []const u8,
    etag: []const u8,
};

/// A cached, stat-gated player feed shared by every request thread.
///
/// Rebuilds are driven by the source, not the clock: a host file is re-read
/// only when its size or mtime moved, and the save is re-scanned no more than
/// once per `min_interval_ns`. Because the serialized `updated` field comes
/// from the source's modification time, an idle world re-serializes to
/// identical bytes — so a polling map settles into `304`s instead of a body
/// per second.
pub const Feed = struct {
    /// Long-lived allocator for the cached body. Bodies are freed on replace,
    /// so this must be a real allocator, not a bump arena.
    gpa: std.mem.Allocator,
    mode: Mode,
    /// `--players-file`, for `.host_file`.
    path: ?[]const u8 = null,
    /// The save being rendered, for `.save`.
    save_dir: ?[]const u8 = null,
    /// The dimension this session serves; players elsewhere are `foreign`.
    dimension_id: []const u8 = "",
    /// Floor on rescans. A host file is additionally gated by its mtime, so it
    /// can be as live as its writer up to this cadence.
    min_interval_ns: i96 = 500 * std.time.ns_per_ms,

    mutex: std.Io.Mutex = .init,
    body: []u8 = &.{},
    etag_buf: [20]u8 = undefined,
    etag_len: usize = 0,
    /// Players in the rendered dimension, in block coordinates, for prebake.
    focus_buf: [MAX_FOCUS][2]i32 = undefined,
    focus_len: usize = 0,
    player_count: usize = 0,
    built: bool = false,
    last_build: std.Io.Timestamp = .zero,
    /// One rebuild at a time. Request threads race here on a busy server, and
    /// the fields below belong to whichever of them is currently rebuilding.
    refreshing: bool = false,
    /// `{size, mtime}` of the host file at the last read.
    stamp: ?[2]u64 = null,
    complained: bool = false,

    /// The current serialized snapshot, copied into `arena`. Null when players
    /// are switched off — the caller then has nothing to serve.
    pub fn snapshot(self: *Feed, io: std.Io, arena: std.mem.Allocator) !?Body {
        if (self.mode == .off) return null;
        self.refresh(io);
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        if (!self.built) return null;
        return .{
            .bytes = try arena.dupe(u8, self.body),
            .etag = try arena.dupe(u8, self.etag_buf[0..self.etag_len]),
        };
    }

    /// Rebuild the cached body if the source moved (and the rescan floor has
    /// passed). Safe to call from any thread and from the scan tick.
    pub fn refresh(self: *Feed, io: std.Io) void {
        if (self.mode == .off) return;
        const now = std.Io.Timestamp.now(io, .awake);
        self.mutex.lockUncancelable(io);
        const skip = self.refreshing or
            (self.built and self.last_build.durationTo(now).nanoseconds < self.min_interval_ns);
        if (!skip) self.refreshing = true;
        self.mutex.unlock(io);
        // Someone else is already reading the source, or it was read a moment
        // ago: a poll storm must not turn into a disk storm.
        if (skip) return;
        defer {
            self.mutex.lockUncancelable(io);
            self.refreshing = false;
            self.mutex.unlock(io);
        }

        var arena_inst = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer arena_inst.deinit();
        const a = arena_inst.allocator();

        const snap: ?Snapshot = switch (self.mode) {
            .off => null,
            .host_file => self.readHostFile(io, a),
            .save => readSaveSnapshot(a, io, self.save_dir.?, self.dimension_id) catch null,
        };
        // A source that hasn't moved (or failed) leaves the last good answer
        // standing: a half-written file must not blank the map's player list.
        const s = snap orelse {
            self.mutex.lockUncancelable(io);
            self.last_build = now;
            self.mutex.unlock(io);
            return;
        };
        const body = serialize(a, s) catch return;
        self.publish(io, now, body, s.players);
    }

    /// Read and parse the host feed, or null when nothing changed and null-ish
    /// when it can't be read. A file that is absent is a real answer — nobody
    /// is online, or the supervisor hasn't started writing yet — so it
    /// publishes an empty roster rather than holding stale players forever.
    fn readHostFile(self: *Feed, io: std.Io, a: std.mem.Allocator) ?Snapshot {
        const path = self.path orelse return null;
        const stat = std.Io.Dir.cwd().statFile(io, path, .{}) catch {
            if (self.stamp == null and self.built) return null; // already empty
            self.stamp = null;
            self.complained = false;
            return .{ .players = &.{}, .origin = .host, .updated_ms = 0 };
        };
        const mtime_bits: u96 = @bitCast(stat.mtime.nanoseconds);
        const stamp: [2]u64 = .{ stat.size, @truncate(mtime_bits) };
        if (self.stamp) |previous| {
            if (previous[0] == stamp[0] and previous[1] == stamp[1]) return null;
        }
        const bytes = std.Io.Dir.cwd().readFileAlloc(io, path, a, .limited(HOST_FILE_LIMIT)) catch |e| {
            self.complain(@errorName(e));
            return null;
        };
        const parsed = parseHostDocument(a, bytes, self.dimension_id, fileMillis(io, path)) catch |e| {
            // Very likely a torn read of a file being rewritten. Do not record
            // the stamp: the next tick reads it again.
            self.complain(@errorName(e));
            return null;
        };
        self.stamp = stamp;
        self.complained = false;
        return parsed;
    }

    fn complain(self: *Feed, reason: []const u8) void {
        if (self.complained) return;
        self.complained = true;
        std.debug.print("players: ignoring the feed for now ({s}); the previous roster stands\n", .{reason});
    }

    fn publish(self: *Feed, io: std.Io, now: std.Io.Timestamp, body: []const u8, list: []const Player) void {
        const copy = self.gpa.dupe(u8, body) catch return;
        var focus: [MAX_FOCUS][2]i32 = undefined;
        var focus_len: usize = 0;
        for (list) |p| {
            if (p.foreign or p.stale) continue; // only live, local players steer prebake
            if (focus_len == MAX_FOCUS) break;
            focus[focus_len] = .{ @intFromFloat(std.math.clamp(p.x, -30_000_000, 30_000_000)), @intFromFloat(std.math.clamp(p.z, -30_000_000, 30_000_000)) };
            focus_len += 1;
        }
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        const old = self.body;
        self.body = copy;
        const digest = std.hash.Wyhash.hash(0x504c_4159_4552_5300, copy);
        // 16 hex digits plus two quotes, into a 20-byte buffer.
        self.etag_len = (std.fmt.bufPrint(&self.etag_buf, "\"{x:0>16}\"", .{digest}) catch unreachable).len;
        @memcpy(self.focus_buf[0..focus_len], focus[0..focus_len]);
        self.focus_len = focus_len;
        self.player_count = list.len;
        self.built = true;
        self.last_build = now;
        if (old.len > 0) self.gpa.free(old);
    }

    /// Live player positions in block coordinates, for the prebake scheduler.
    pub fn focusPoints(self: *Feed, io: std.Io, out: *[MAX_FOCUS][2]i32) []const [2]i32 {
        if (self.mode == .off) return &.{};
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        @memcpy(out[0..self.focus_len], self.focus_buf[0..self.focus_len]);
        return out[0..self.focus_len];
    }

    /// How many players the last snapshot listed (for the startup log).
    pub fn count(self: *Feed, io: std.Io) usize {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        return self.player_count;
    }
};

// --- tests ------------------------------------------------------------------

const testing = std.testing;

test "a BlueMap live-players document parses verbatim" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const doc =
        \\{"players":[
        \\  {"uuid":"91c71e4a-146c-4788-bbb9-39002556a24e","name":"Notch","foreign":false,
        \\   "position":{"x":383.2,"y":70.0,"z":-206.1},
        \\   "rotation":{"pitch":13.9,"yaw":8.75,"roll":0.0}}
        \\]}
    ;
    const snap = try parseHostDocument(arena.allocator(), doc, "minecraft:overworld", 42);
    try testing.expectEqual(@as(usize, 1), snap.players.len);
    try testing.expectEqualStrings("Notch", snap.players[0].name);
    try testing.expectEqualStrings("91c71e4a-146c-4788-bbb9-39002556a24e", snap.players[0].uuid);
    try testing.expectApproxEqAbs(@as(f64, 383.2), snap.players[0].x, 0.001);
    try testing.expectApproxEqAbs(@as(f32, 8.75), snap.players[0].yaw, 0.001);
    try testing.expectApproxEqAbs(@as(f32, 13.9), snap.players[0].pitch, 0.001);
    try testing.expect(!snap.players[0].foreign);
    try testing.expect(!snap.players[0].stale);
    try testing.expectEqual(@as(i64, 42), snap.updated_ms);
}

test "a player in another dimension is foreign even when the host didn't say so" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const doc =
        \\{"players":[
        \\  {"uuid":"a","name":"Here","x":1,"y":2,"z":3,"dimension":"minecraft:overworld"},
        \\  {"uuid":"b","name":"Away","x":1,"y":2,"z":3,"dimension":"minecraft:the_nether"},
        \\  {"uuid":"c","name":"Unknown","x":1,"y":2,"z":3}
        \\]}
    ;
    const snap = try parseHostDocument(arena.allocator(), doc, "minecraft:overworld", 0);
    try testing.expectEqual(@as(usize, 3), snap.players.len);
    try testing.expect(!snap.players[0].foreign);
    try testing.expect(snap.players[1].foreign);
    // No dimension reported is not evidence of being elsewhere.
    try testing.expect(!snap.players[2].foreign);
}

test "malformed entries are dropped individually, not fatally" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const doc =
        \\{"players":[
        \\  {"uuid":"a","name":"Good","position":{"x":1,"y":2,"z":3}},
        \\  {"uuid":"b","name":"NoPosition"},
        \\  {"uuid":"c","name":"NotFinite","x":1e400,"y":2,"z":3},
        \\  {"uuid":"d","name":"OffWorld","x":50000000,"y":2,"z":3},
        \\  "not an object",
        \\  {"position":{"x":1,"y":2,"z":3}}
        \\]}
    ;
    const snap = try parseHostDocument(arena.allocator(), doc, "", 0);
    try testing.expectEqual(@as(usize, 1), snap.players.len);
    try testing.expectEqualStrings("Good", snap.players[0].name);
}

test "a document that isn't a player list is rejected" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    try testing.expectError(error.InvalidPlayerDocument, parseHostDocument(arena.allocator(), "not json", "", 0));
    try testing.expectError(error.InvalidPlayerDocument, parseHostDocument(arena.allocator(), "{\"points\":[]}", "", 0));
    // A bare array is a reasonable thing for a host to write.
    const snap = try parseHostDocument(arena.allocator(), "[{\"uuid\":\"a\",\"x\":0,\"y\":0,\"z\":0}]", "", 0);
    try testing.expectEqual(@as(usize, 1), snap.players.len);
}

test "skin references stay inside the map's own directory" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cases = [_]struct { doc: []const u8, want: ?[]const u8 }{
        .{ .doc = "{\"players\":[{\"uuid\":\"a\",\"x\":0,\"y\":0,\"z\":0,\"skin\":\"skins/a.png\"}]}", .want = "skins/a.png" },
        .{ .doc = "{\"players\":[{\"uuid\":\"a\",\"x\":0,\"y\":0,\"z\":0,\"skin\":\"https://evil.example/a.png\"}]}", .want = null },
        .{ .doc = "{\"players\":[{\"uuid\":\"a\",\"x\":0,\"y\":0,\"z\":0,\"skin\":\"/absolute.png\"}]}", .want = null },
        .{ .doc = "{\"players\":[{\"uuid\":\"a\",\"x\":0,\"y\":0,\"z\":0,\"skin\":\"../secret.png\"}]}", .want = null },
        .{ .doc = "{\"players\":[{\"uuid\":\"a\",\"x\":0,\"y\":0,\"z\":0,\"skin\":\"a\\\\b.png\"}]}", .want = null },
    };
    for (cases) |c| {
        const snap = try parseHostDocument(a, c.doc, "", 0);
        try testing.expectEqual(@as(usize, 1), snap.players.len);
        if (c.want) |want| {
            try testing.expectEqualStrings(want, snap.players[0].skin.?);
        } else {
            try testing.expect(snap.players[0].skin == null);
        }
    }
}

test "yaw wraps and pitch clamps to the ranges the renderer expects" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const doc =
        \\{"players":[{"uuid":"a","x":0,"y":0,"z":0,"yaw":540,"pitch":-400}]}
    ;
    const snap = try parseHostDocument(arena.allocator(), doc, "", 0);
    try testing.expectApproxEqAbs(@as(f32, 180), @abs(snap.players[0].yaw), 0.001);
    try testing.expectApproxEqAbs(@as(f32, -90), snap.players[0].pitch, 0.001);
}

test "serialize round-trips through the parser and stays BlueMap-shaped" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const snap: Snapshot = .{
        .origin = .playerdata,
        .updated_ms = 1730000000000,
        .players = &.{
            .{
                .uuid = "91c71e4a-146c-4788-bbb9-39002556a24e",
                .name = "Quote\"Name",
                .x = 383.215,
                .y = 70,
                .z = -206.147,
                .yaw = 8.75,
                .pitch = 13.95,
                .dimension = "minecraft:overworld",
                .health = 7.84,
                .gamemode = "survival",
                .stale = true,
                .seen_ms = 1730000000000,
            },
        },
    };
    const json = try serialize(a, snap);
    try testing.expect(std.mem.indexOf(u8, json, "\"source\": \"playerdata\"") != null);
    try testing.expect(std.mem.indexOf(u8, json, "\"foreign\": false") != null);
    try testing.expect(std.mem.indexOf(u8, json, "\"stale\": true") != null);
    try testing.expect(std.mem.indexOf(u8, json, "\\\"Name") != null);

    const back = try parseHostDocument(a, json, "minecraft:overworld", 0);
    try testing.expectEqual(@as(usize, 1), back.players.len);
    try testing.expectEqualStrings("Quote\"Name", back.players[0].name);
    try testing.expectApproxEqAbs(@as(f64, 383.22), back.players[0].x, 0.005);
    try testing.expect(back.players[0].stale);
    try testing.expect(!back.players[0].foreign);
}

test "an idle roster serializes to identical bytes" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const snap: Snapshot = .{
        .origin = .host,
        .updated_ms = 7,
        .players = &.{.{ .uuid = "a", .name = "A", .x = 1.0 / 3.0, .y = 2, .z = 3 }},
    };
    // Same inputs, same bytes: what makes the ETag stable across polls.
    try testing.expectEqualStrings(try serialize(a, snap), try serialize(a, snap));
}

test "uuid formatting matches the file name Minecraft chose" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    var ints = [_]i32{ -1849221558, 342640520, -1145489152, 626434638 };
    const tag: nbt.Tag = .{ .int_array = ints[0..] };
    const uuid = uuidFromTag(arena.allocator(), &tag).?;
    try testing.expectEqualStrings("91c71e4a-146c-4788-bbb9-39002556a24e", uuid);
}

test "only canonical uuid file names are accepted" {
    try testing.expect(canonicalUuid("91c71e4a-146c-4788-bbb9-39002556a24e") != null);
    try testing.expect(canonicalUuid("91C71E4A-146C-4788-BBB9-39002556A24E") == null);
    try testing.expect(canonicalUuid("91c71e4a146c4788bbb939002556a24e") == null);
    try testing.expect(canonicalUuid("../../etc/passwd") == null);
    try testing.expect(canonicalUuid("") == null);
}

test "a name-less player falls back to a readable short id" {
    try testing.expectEqualStrings("91c71e4a", shortUuid("91c71e4a-146c-4788-bbb9-39002556a24e"));
    try testing.expectEqualStrings("opaque", shortUuid("opaque"));
}
