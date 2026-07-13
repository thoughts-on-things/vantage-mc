//! `vantage serve` — a tiny local HTTP server with the web viewer embedded in
//! the binary, so a rendered world is one command from a browser: no npm, no
//! separate web server, one static executable that renders AND views.
//!
//! GET/HEAD-only static serving on a keep-alive connection per thread: the
//! embedded viewer bundle is matched first (its asset names are content-hashed
//! so they can't collide with world files), then files from the served render
//! directory (manifest.json, tiles/, lowres/, terrain.vtexarr). World files go
//! out `no-cache` so a re-render shows on plain reload — tiles change in place
//! — while the hashed viewer assets are immutable.

const std = @import("std");
const builtin = @import("builtin");
const viewer = @import("viewer_assets");

pub const Options = struct {
    /// The render output directory to serve (holds manifest.json).
    dir: []const u8,
    /// "VANT" on a phone keypad. High enough to be free, stable enough to bookmark.
    port: u16 = 8268,
    /// Bind address; pass 0.0.0.0 to share the map on the local network.
    host: []const u8 = "127.0.0.1",
    /// Launch the default browser at the served URL once listening.
    open: bool = false,
};

pub fn run(io: std.Io, arena: std.mem.Allocator, opts: Options) !void {
    const addr = std.Io.net.IpAddress.parse(opts.host, opts.port) catch {
        std.debug.print("invalid --host address: '{s}' (expected e.g. 127.0.0.1 or 0.0.0.0)\n", .{opts.host});
        return error.InvalidAddress;
    };
    var server = addr.listen(io, .{ .reuse_address = true }) catch |e| switch (e) {
        error.AddressInUse => {
            std.debug.print("port {d} is already in use — pass --port <n> to pick another\n", .{opts.port});
            return e;
        },
        else => return e,
    };
    defer server.deinit(io);

    const manifest_path = try std.fs.path.join(arena, &.{ opts.dir, "manifest.json" });
    const has_manifest = if (std.Io.Dir.cwd().statFile(io, manifest_path, .{})) |_| true else |_| false;

    // The printed host prefers something clickable: binding 0.0.0.0 listens
    // everywhere but isn't itself a destination.
    const url_host = if (std.mem.eql(u8, opts.host, "0.0.0.0")) "127.0.0.1" else opts.host;
    const url = try std.fmt.allocPrint(arena, "http://{s}:{d}/", .{ url_host, opts.port });
    std.debug.print("serving {s} at {s}  (Ctrl-C to stop)\n", .{ opts.dir, url });
    if (!has_manifest) std.debug.print(
        "note: no manifest.json in {s} — render first:  vantage render <world-save> --out {s}\n",
        .{ opts.dir, opts.dir },
    );
    if (viewer.files.len == 0) std.debug.print(
        "note: this build has no embedded viewer (only world files are served).\n" ++
            "      build it once with `cd web && npm install && npm run build:viewer`, then `zig build`.\n",
        .{},
    );
    if (opts.open) openBrowser(io, arena, url);

    while (true) {
        const stream = server.accept(io) catch |e| switch (e) {
            error.Canceled => return,
            else => {
                std.debug.print("accept failed: {s}\n", .{@errorName(e)});
                continue;
            },
        };
        // One detached thread per connection: browsers hold a handful of
        // keep-alive connections open, so serving them sequentially would
        // stall tile streaming. If spawning fails, serve inline.
        if (std.Thread.spawn(.{}, connection, .{ io, stream, opts.dir })) |t| t.detach() else |_| connection(io, stream, opts.dir);
    }
}

/// Serve one keep-alive connection until the peer closes it (or errors).
fn connection(io: std.Io, stream_in: std.Io.net.Stream, dir: []const u8) void {
    var stream = stream_in;
    defer stream.close(io);
    var rbuf: [16 * 1024]u8 = undefined;
    var wbuf: [16 * 1024]u8 = undefined;
    var sr = stream.reader(io, &rbuf);
    var sw = stream.writer(io, &wbuf);
    var http = std.http.Server.init(&sr.interface, &sw.interface);
    while (true) {
        var req = http.receiveHead() catch return; // peer closed / bad head
        serveRequest(io, &req, dir) catch return; // write failed: drop the connection
    }
}

fn serveRequest(io: std.Io, req: *std.http.Server.Request, dir: []const u8) !void {
    if (req.head.method != .GET and req.head.method != .HEAD)
        return req.respond("method not allowed\n", .{ .status = .method_not_allowed });

    var target = req.head.target;
    if (std.mem.indexOfScalar(u8, target, '?')) |q| target = target[0..q];
    if (std.mem.eql(u8, target, "/")) target = "/index.html";

    // Embedded viewer files first. index.html revalidates (a new binary may
    // carry a new bundle); the content-hashed assets never change.
    for (viewer.files) |f| {
        if (!std.mem.eql(u8, f.path, target)) continue;
        const immutable = std.mem.startsWith(u8, target, "/assets/");
        return req.respond(f.bytes, .{ .extra_headers = &.{
            .{ .name = "content-type", .value = mimeType(f.path) },
            .{ .name = "cache-control", .value = if (immutable) "public, max-age=31536000, immutable" else "no-cache" },
        } });
    }

    const rel = target[1..];
    if (!safePath(rel)) return req.respond("bad path\n", .{ .status = .bad_request });

    var arena_inst = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena_inst.deinit();
    const a = arena_inst.allocator();
    const full = std.fs.path.join(a, &.{ dir, rel }) catch return error.WriteFailed;
    const bytes = std.Io.Dir.cwd().readFileAlloc(io, full, a, .unlimited) catch {
        // Without an embedded viewer the root gets a pointer, not a 404.
        if (viewer.files.len == 0 and std.mem.eql(u8, rel, "index.html"))
            return req.respond(fallback_html, .{ .extra_headers = &.{
                .{ .name = "content-type", .value = "text/html; charset=utf-8" },
                .{ .name = "cache-control", .value = "no-cache" },
            } });
        return req.respond("not found\n", .{ .status = .not_found });
    };
    try req.respond(bytes, .{ .extra_headers = &.{
        .{ .name = "content-type", .value = mimeType(rel) },
        .{ .name = "cache-control", .value = "no-cache" },
    } });
}

/// A conservative relative-path gate: plain `a/b/c.ext` names only — no
/// escapes ("..", absolute, drive letters), no percent-encoding (nothing we
/// serve needs it), no backslashes.
fn safePath(rel: []const u8) bool {
    if (rel.len == 0 or rel.len > 512) return false;
    for (rel) |c| switch (c) {
        'a'...'z', 'A'...'Z', '0'...'9', '-', '_', '.', '/' => {},
        else => return false,
    };
    if (rel[0] == '/' or rel[rel.len - 1] == '/') return false;
    var it = std.mem.splitScalar(u8, rel, '/');
    while (it.next()) |part| {
        if (part.len == 0) return false;
        if (std.mem.eql(u8, part, ".") or std.mem.eql(u8, part, "..")) return false;
    }
    return true;
}

fn mimeType(path: []const u8) []const u8 {
    const ext = std.fs.path.extension(path);
    const map = .{
        .{ ".html", "text/html; charset=utf-8" },
        .{ ".js", "text/javascript" },
        .{ ".css", "text/css" },
        .{ ".json", "application/json" },
        .{ ".png", "image/png" },
        .{ ".jpg", "image/jpeg" },
        .{ ".svg", "image/svg+xml" },
        .{ ".ico", "image/x-icon" },
        .{ ".wasm", "application/wasm" },
        .{ ".map", "application/json" },
        .{ ".txt", "text/plain; charset=utf-8" },
    };
    inline for (map) |entry| {
        if (std.mem.eql(u8, ext, entry[0])) return entry[1];
    }
    return "application/octet-stream"; // .vtile, .vtexarr, …
}

const fallback_html =
    \\<!doctype html><meta charset="utf-8"><title>vantage serve</title>
    \\<body style="font: 15px/1.6 system-ui; max-width: 42rem; margin: 4rem auto; padding: 0 1rem; background:#0d1015; color:#dfe6f0">
    \\<h1 style="font-size:1.3rem">vantage serve</h1>
    \\<p>The world render is being served (<a style="color:#5b9bff" href="/manifest.json">manifest.json</a>, tiles, textures) —
    \\but this build of the binary has no viewer app embedded.</p>
    \\<p>Either grab an official release binary (viewer included), or build it once:</p>
    \\<pre style="background:#161b24; padding:.8rem; border-radius:6px">cd web &amp;&amp; npm install &amp;&amp; npm run build:viewer
    \\zig build -Doptimize=ReleaseFast</pre>
    \\<p>Any web app using the <code>vantage-mc</code> npm package can also point at this server.</p>
;

/// Best-effort browser launch; failures are silent (the URL is printed anyway).
fn openBrowser(io: std.Io, a: std.mem.Allocator, url: []const u8) void {
    const argv: []const []const u8 = switch (builtin.os.tag) {
        .windows => &.{ "cmd", "/c", "start", "", url },
        .macos => &.{ "open", url },
        else => &.{ "xdg-open", url },
    };
    _ = std.process.run(a, io, .{ .argv = argv }) catch return;
}

test "safePath rejects escapes and accepts render files" {
    try std.testing.expect(safePath("manifest.json"));
    try std.testing.expect(safePath("tiles/t.-3.12.vtile"));
    try std.testing.expect(safePath("lowres/2/t.0.0.vlr"));
    try std.testing.expect(safePath("terrain.vtexarr"));
    try std.testing.expect(!safePath(""));
    try std.testing.expect(!safePath("../secret"));
    try std.testing.expect(!safePath("tiles/../../x"));
    try std.testing.expect(!safePath("/etc/passwd"));
    try std.testing.expect(!safePath("C:/windows/win.ini"));
    try std.testing.expect(!safePath("a\\b"));
    try std.testing.expect(!safePath("a%2e%2e/b"));
    try std.testing.expect(!safePath("tiles//t.vtile"));
}

test "mimeType maps the served extensions" {
    try std.testing.expectEqualStrings("text/html; charset=utf-8", mimeType("/index.html"));
    try std.testing.expectEqualStrings("text/javascript", mimeType("/assets/index-abc.js"));
    try std.testing.expectEqualStrings("application/json", mimeType("manifest.json"));
    try std.testing.expectEqualStrings("application/octet-stream", mimeType("tiles/t.0.0.vtile"));
}
