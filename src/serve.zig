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
const openapi_spec = @import("server_openapi").json;

/// A dynamic response a {@link Producer} synthesized for a request path.
pub const Produced = struct {
    body: []const u8,
    content_type: []const u8,
};

/// An on-demand content source (the `vantage live` server): given a
/// manifest-relative path, synthesize its bytes — bake a tile, build the live
/// manifest or texture atlas — or return null to fall through to static file
/// serving. `arena` is a per-request arena, freed after the response is sent.
pub const Producer = struct {
    ctx: *anyopaque,
    func: *const fn (ctx: *anyopaque, io: std.Io, arena: std.mem.Allocator, path: []const u8) anyerror!?Produced,

    fn produce(self: Producer, io: std.Io, arena: std.mem.Allocator, path: []const u8) !?Produced {
        return self.func(self.ctx, io, arena, path);
    }
};

/// Public-server HTTP policy. `vantage live` leaves this null and keeps its
/// embedded local viewer; `vantage server` enables it and exposes only the
/// versioned data plane below `world_prefix`.
pub const ApiOptions = struct {
    /// URL prefix whose suffix is resolved relative to the render directory
    /// and handed to the on-demand producer. Must start and end with `/`.
    world_prefix: []const u8 = "/v1/worlds/default/",
    /// SHA-256 of the configured bearer token. The raw secret never enters the
    /// request policy or logs and comparisons are constant-time.
    bearer_sha256: ?[32]u8 = null,
    /// Exact browser origins allowed to read the API. Requests without an
    /// Origin header (native launchers and same-host reverse proxies) are not
    /// CORS requests and remain valid.
    allowed_origins: []const []const u8 = &.{},
    /// Bound detached connection threads. A reverse proxy should still enforce
    /// idle timeouts; this cap prevents unbounded process memory on its own.
    max_connections: usize = 64,
    /// Recycle keep-alive connections periodically so one peer cannot retain a
    /// worker forever by continuously issuing requests.
    max_requests_per_connection: usize = 128,
};

pub const Options = struct {
    /// The render output directory to serve (holds manifest.json). With a live
    /// `producer` it doubles as the on-demand tile cache.
    dir: []const u8,
    /// "VANT" on a phone keypad. High enough to be free, stable enough to bookmark.
    port: u16 = 8268,
    /// Bind address; pass 0.0.0.0 to share the map on the local network.
    host: []const u8 = "127.0.0.1",
    /// Launch the default browser at the served URL once listening.
    open: bool = false,
    /// On-demand content source. When set, requests it owns (the live manifest,
    /// atlas, and un-cached tiles) are synthesized instead of read from disk.
    producer: ?Producer = null,
    /// Hardened, launcher-facing data plane. Null preserves the local `serve`
    /// and `live` behaviour for backwards compatibility.
    api: ?ApiOptions = null,
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
    // The live server synthesizes manifest.json on demand, so a missing on-disk
    // copy is expected — only nudge for the static case.
    if (!has_manifest and opts.producer == null) std.debug.print(
        "note: no manifest.json in {s} — render first:  vantage render <world-save> --out {s}\n",
        .{ opts.dir, opts.dir },
    );
    // A protocol server intentionally has no viewer at its API origin: its
    // launcher or reverse proxy owns that UI. Only local serve/live users need
    // an actionable embedded-viewer hint.
    if (viewer.files.len == 0 and opts.api == null) std.debug.print(
        "note: this build has no embedded viewer (only world files are served).\n" ++
            "      build it once with `cd web && npm install && npm run build:viewer`, then `zig build`.\n",
        .{},
    );
    if (opts.open) openBrowser(io, arena, url);

    // Detached workers must not retain a pointer into this function's stack if
    // the listener is cancelled during graceful shutdown. The process arena
    // outlives `run` and is reclaimed with the CLI process.
    const connection_slots = try arena.create(std.Io.Semaphore);
    connection_slots.* = .{
        .permits = if (opts.api) |api| @max(api.max_connections, 1) else std.math.maxInt(usize),
    };

    while (true) {
        connection_slots.waitUncancelable(io);
        const stream = server.accept(io) catch |e| switch (e) {
            error.Canceled => {
                connection_slots.post(io);
                return;
            },
            else => {
                connection_slots.post(io);
                std.debug.print("accept failed: {s}\n", .{@errorName(e)});
                continue;
            },
        };
        // One detached thread per connection: browsers hold a handful of
        // keep-alive connections open, so serving them sequentially would
        // stall tile streaming. If spawning fails, serve inline.
        if (std.Thread.spawn(.{}, connection, .{ io, stream, opts.dir, opts.producer, opts.api, connection_slots })) |t| t.detach() else |_| connection(io, stream, opts.dir, opts.producer, opts.api, connection_slots);
    }
}

/// Serve one keep-alive connection until the peer closes it (or errors).
fn connection(
    io: std.Io,
    stream_in: std.Io.net.Stream,
    dir: []const u8,
    producer: ?Producer,
    api: ?ApiOptions,
    slots: *std.Io.Semaphore,
) void {
    defer slots.post(io);
    var stream = stream_in;
    defer stream.close(io);
    var rbuf: [16 * 1024]u8 = undefined;
    var wbuf: [16 * 1024]u8 = undefined;
    var sr = stream.reader(io, &rbuf);
    var sw = stream.writer(io, &wbuf);
    var http = std.http.Server.init(&sr.interface, &sw.interface);
    const request_limit = if (api) |policy| @max(policy.max_requests_per_connection, 1) else std.math.maxInt(usize);
    var requests: usize = 0;
    while (requests < request_limit) : (requests += 1) {
        var req = http.receiveHead() catch return; // peer closed / bad head
        serveRequest(io, &req, dir, producer, api) catch return; // write failed: drop the connection
    }
}

fn serveRequest(
    io: std.Io,
    req: *std.http.Server.Request,
    dir: []const u8,
    producer: ?Producer,
    api: ?ApiOptions,
) !void {
    if (api) |policy| return serveApiRequest(io, req, dir, producer, policy);

    if (req.head.method != .GET and req.head.method != .HEAD)
        return req.respond("method not allowed\n", .{ .status = .method_not_allowed, .extra_headers = security_headers[0..] });

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
            security_headers[0],
            security_headers[1],
        } });
    }

    // On-demand content (the live server) comes next: after the embedded viewer
    // (its hashed asset names can't collide) but before static disk, so the live
    // manifest/atlas always win over any stale copy a prior render left in `dir`.
    // Anything the producer doesn't own (returns null) falls through to disk.
    // A HEAD probe must never allocate an atlas or trigger a tile bake. Cached
    // files can still answer below; dynamic-only resources return 404.
    if (req.head.method != .HEAD) if (producer) |p| {
        var arena_inst = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer arena_inst.deinit();
        if (try p.produce(io, arena_inst.allocator(), target[1..])) |resp| {
            return req.respond(resp.body, .{ .extra_headers = &.{
                .{ .name = "content-type", .value = resp.content_type },
                .{ .name = "cache-control", .value = "no-cache" },
                security_headers[0],
                security_headers[1],
            } });
        }
    };

    const rel = target[1..];
    if (!safePath(rel)) return req.respond("bad path\n", .{ .status = .bad_request });

    var arena_inst = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena_inst.deinit();
    const a = arena_inst.allocator();
    const full = std.fs.path.join(a, &.{ dir, rel }) catch return error.WriteFailed;
    if (req.head.method == .HEAD) {
        const stat = std.Io.Dir.cwd().statFile(io, full, .{}) catch {
            if (viewer.files.len == 0 and std.mem.eql(u8, rel, "index.html"))
                return headFileResponse(req, .ok, "text/html; charset=utf-8", "no-cache", null, fallback_html.len);
            return req.respond("not found\n", .{ .status = .not_found });
        };
        return headFileResponse(req, .ok, mimeType(rel), "no-cache", null, stat.size);
    }
    const bytes = std.Io.Dir.cwd().readFileAlloc(io, full, a, .unlimited) catch {
        // Without an embedded viewer the root gets a pointer, not a 404.
        if (viewer.files.len == 0 and std.mem.eql(u8, rel, "index.html"))
            return req.respond(fallback_html, .{ .extra_headers = &.{
                .{ .name = "content-type", .value = "text/html; charset=utf-8" },
                .{ .name = "cache-control", .value = "no-cache" },
                security_headers[0],
                security_headers[1],
            } });
        return req.respond("not found\n", .{ .status = .not_found });
    };
    try req.respond(bytes, .{ .extra_headers = &.{
        .{ .name = "content-type", .value = mimeType(rel) },
        .{ .name = "cache-control", .value = "no-cache" },
        security_headers[0],
        security_headers[1],
    } });
}

const security_headers = [_]std.http.Header{
    .{ .name = "x-content-type-options", .value = "nosniff" },
    .{ .name = "referrer-policy", .value = "no-referrer" },
};

const HeaderBuffer = struct {
    items: [12]std.http.Header = undefined,
    len: usize = 0,

    fn add(self: *HeaderBuffer, name: []const u8, value: []const u8) void {
        self.items[self.len] = .{ .name = name, .value = value };
        self.len += 1;
    }

    fn slice(self: *const HeaderBuffer) []const std.http.Header {
        return self.items[0..self.len];
    }
};

/// Launcher-facing API: public capability/health probes, exact-origin CORS,
/// bearer auth, then a single safe world namespace. Authentication happens
/// before the producer or filesystem is touched.
fn serveApiRequest(
    io: std.Io,
    req: *std.http.Server.Request,
    dir: []const u8,
    producer: ?Producer,
    policy: ApiOptions,
) !void {
    var target = req.head.target;
    if (target.len == 0 or target.len > 1024) return apiRespond(req, .uri_too_long, "text/plain; charset=utf-8", "bad target\n", "no-store", null);
    if (std.mem.indexOfScalar(u8, target, '?')) |q| target = target[0..q];

    const origin_header = requestHeader(req, "origin");
    if (origin_header.duplicate)
        return apiRespond(req, .bad_request, "text/plain; charset=utf-8", "duplicate origin\n", "no-store", null);
    const origin = origin_header.value;
    if (origin) |value| {
        if (!originAllowed(policy.allowed_origins, value))
            return apiRespond(req, .forbidden, "text/plain; charset=utf-8", "origin not allowed\n", "no-store", null);
    }

    if (req.head.method == .OPTIONS)
        return servePreflight(req, origin);
    if (req.head.method != .GET and req.head.method != .HEAD)
        return apiRespond(req, .method_not_allowed, "text/plain; charset=utf-8", "method not allowed\n", "no-store", origin);

    if (std.mem.eql(u8, target, "/v1/health"))
        return apiRespond(req, .ok, "application/json", "{\"status\":\"ok\",\"protocol\":1}\n", "no-store", origin);
    if (std.mem.eql(u8, target, "/.well-known/vantage")) {
        const body = if (policy.bearer_sha256 == null)
            "{\"protocol\":1,\"api\":\"/v1\",\"openapi\":\"/v1/openapi.json\",\"auth\":\"proxy\"}\n"
        else
            "{\"protocol\":1,\"api\":\"/v1\",\"openapi\":\"/v1/openapi.json\",\"auth\":\"bearer\"}\n";
        return apiRespond(req, .ok, "application/json", body, "public, max-age=300", origin);
    }
    if (std.mem.eql(u8, target, "/v1/openapi.json"))
        return apiRespond(req, .ok, "application/json", openapi_spec, "public, max-age=3600", origin);

    if (!authorized(req, policy.bearer_sha256))
        return apiUnauthorized(req, origin);

    if (std.mem.eql(u8, target, "/v1/worlds"))
        return apiRespond(req, .ok, "application/json", "{\"worlds\":[{\"id\":\"default\",\"manifest\":\"/v1/worlds/default/manifest.json\"}]}\n", "private, no-store", origin);

    if (!std.mem.startsWith(u8, target, policy.world_prefix))
        return apiRespond(req, .not_found, "text/plain; charset=utf-8", "not found\n", "no-store", origin);
    const rel = target[policy.world_prefix.len..];
    if (!safeArtifactPath(rel))
        return apiRespond(req, .bad_request, "text/plain; charset=utf-8", "bad path\n", "no-store", origin);

    // Avoid expensive or attacker-amplified work for metadata probes. A cached
    // file may answer HEAD, but a miss never reaches the dynamic producer.
    if (req.head.method != .HEAD) if (producer) |p| {
        var arena_inst = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer arena_inst.deinit();
        if (try p.produce(io, arena_inst.allocator(), rel)) |resp|
            return apiRespond(req, .ok, resp.content_type, resp.body, "private, no-store", origin);
    };

    var arena_inst = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena_inst.deinit();
    const a = arena_inst.allocator();
    const full = std.fs.path.join(a, &.{ dir, rel }) catch return error.WriteFailed;
    if (req.head.method == .HEAD) {
        const stat = std.Io.Dir.cwd().statFile(io, full, .{}) catch
            return apiRespond(req, .not_found, "text/plain; charset=utf-8", "not found\n", "no-store", origin);
        return headFileResponse(req, .ok, mimeType(rel), "private, no-store", origin, stat.size);
    }
    const bytes = std.Io.Dir.cwd().readFileAlloc(io, full, a, .unlimited) catch
        return apiRespond(req, .not_found, "text/plain; charset=utf-8", "not found\n", "no-store", origin);
    return apiRespond(req, .ok, mimeType(rel), bytes, "private, no-store", origin);
}

fn servePreflight(req: *std.http.Server.Request, origin: ?[]const u8) !void {
    const allowed = origin orelse
        return apiRespond(req, .bad_request, "text/plain; charset=utf-8", "missing origin\n", "no-store", null);
    const requested_header = requestHeader(req, "access-control-request-method");
    if (requested_header.duplicate)
        return apiRespond(req, .bad_request, "text/plain; charset=utf-8", "duplicate requested method\n", "no-store", allowed);
    const requested = requested_header.value orelse "";
    if (!std.ascii.eqlIgnoreCase(requested, "GET") and !std.ascii.eqlIgnoreCase(requested, "HEAD"))
        return apiRespond(req, .forbidden, "text/plain; charset=utf-8", "method not allowed\n", "no-store", allowed);

    var headers: HeaderBuffer = .{};
    addCorsHeaders(&headers, allowed);
    headers.add("access-control-allow-methods", "GET, HEAD, OPTIONS");
    headers.add("access-control-allow-headers", "authorization");
    headers.add("access-control-max-age", "600");
    headers.add(security_headers[0].name, security_headers[0].value);
    headers.add(security_headers[1].name, security_headers[1].value);
    return req.respond("", .{ .status = .no_content, .extra_headers = headers.slice() });
}

fn apiRespond(
    req: *std.http.Server.Request,
    status: std.http.Status,
    content_type: []const u8,
    body: []const u8,
    cache_control: []const u8,
    origin: ?[]const u8,
) !void {
    var headers: HeaderBuffer = .{};
    headers.add("content-type", content_type);
    headers.add("cache-control", cache_control);
    headers.add(security_headers[0].name, security_headers[0].value);
    headers.add(security_headers[1].name, security_headers[1].value);
    if (origin) |value| addCorsHeaders(&headers, value);
    return req.respond(body, .{ .status = status, .extra_headers = headers.slice() });
}

fn apiUnauthorized(req: *std.http.Server.Request, origin: ?[]const u8) !void {
    var headers: HeaderBuffer = .{};
    headers.add("content-type", "text/plain; charset=utf-8");
    headers.add("cache-control", "no-store");
    headers.add("www-authenticate", "Bearer realm=\"vantage\"");
    headers.add(security_headers[0].name, security_headers[0].value);
    headers.add(security_headers[1].name, security_headers[1].value);
    if (origin) |value| addCorsHeaders(&headers, value);
    return req.respond("unauthorized\n", .{ .status = .unauthorized, .extra_headers = headers.slice() });
}

fn addCorsHeaders(headers: *HeaderBuffer, origin: []const u8) void {
    headers.add("access-control-allow-origin", origin);
    headers.add("vary", "Origin");
}

/// Answer a static HEAD from metadata only. `respond` already elides bodies,
/// but passing it file bytes would still allocate/read the whole artifact just
/// to discover Content-Length. Streaming writes the real length header while
/// the HEAD body writer discards no data.
fn headFileResponse(
    req: *std.http.Server.Request,
    status: std.http.Status,
    content_type: []const u8,
    cache_control: []const u8,
    origin: ?[]const u8,
    content_length: u64,
) !void {
    var headers: HeaderBuffer = .{};
    headers.add("content-type", content_type);
    headers.add("cache-control", cache_control);
    headers.add(security_headers[0].name, security_headers[0].value);
    headers.add(security_headers[1].name, security_headers[1].value);
    if (origin) |value| addCorsHeaders(&headers, value);
    var buffer: [1]u8 = undefined;
    var response = try req.respondStreaming(&buffer, .{
        .content_length = content_length,
        .respond_options = .{ .status = status, .extra_headers = headers.slice() },
    });
    // HEAD has no representation body to write; flush the headers directly.
    try response.flush();
}

const HeaderLookup = struct {
    value: ?[]const u8 = null,
    duplicate: bool = false,
};

fn requestHeader(req: *const std.http.Server.Request, name: []const u8) HeaderLookup {
    var found: ?[]const u8 = null;
    var it = req.iterateHeaders();
    while (it.next()) |header| {
        if (!std.ascii.eqlIgnoreCase(header.name, name)) continue;
        // Duplicate security-sensitive headers are ambiguous; fail closed.
        if (found != null) return .{ .duplicate = true };
        found = header.value;
    }
    return .{ .value = found };
}

fn originAllowed(allowed: []const []const u8, origin: []const u8) bool {
    for (allowed) |candidate| if (std.mem.eql(u8, candidate, origin)) return true;
    return false;
}

fn authorized(req: *const std.http.Server.Request, expected: ?[32]u8) bool {
    const digest = expected orelse return true;
    const header = requestHeader(req, "authorization");
    if (header.duplicate) return false;
    const value = header.value orelse return false;
    return bearerValueMatches(value, digest);
}

fn bearerValueMatches(value: []const u8, digest: [32]u8) bool {
    const space = std.mem.indexOfScalar(u8, value, ' ') orelse return false;
    if (!std.ascii.eqlIgnoreCase(value[0..space], "Bearer")) return false;
    const token = std.mem.trim(u8, value[space + 1 ..], " \t");
    if (token.len == 0) return false;
    var actual: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(token, &actual, .{});
    return std.crypto.timing_safe.eql([32]u8, digest, actual);
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

/// The public data plane is narrower than the cache directory. Even a file
/// with a traversal-safe name is private unless it is part of protocol v1;
/// operators can therefore keep bookkeeping beside the cache without making
/// it remotely readable. Tile coordinates must be in canonical decimal form —
/// one URL per tile, so aliases ("+1", "007") can't dodge caches or logs.
fn safeArtifactPath(rel: []const u8) bool {
    if (!safePath(rel)) return false;
    if (std.mem.eql(u8, rel, "manifest.json") or std.mem.eql(u8, rel, "terrain.vtexarr")) return true;
    if (!std.mem.startsWith(u8, rel, "tiles/t.") or !std.mem.endsWith(u8, rel, ".vtile")) return false;
    const mid = rel["tiles/t.".len .. rel.len - ".vtile".len];
    const dot = std.mem.indexOfScalar(u8, mid, '.') orelse return false;
    return canonicalTileCoord(mid[0..dot]) and canonicalTileCoord(mid[dot + 1 ..]);
}

/// Exactly what `{d}` formats for an i32: an optional '-', no leading zeros.
fn canonicalTileCoord(text: []const u8) bool {
    const value = std.fmt.parseInt(i32, text, 10) catch return false;
    var canonical: [12]u8 = undefined;
    const formatted = std.fmt.bufPrint(&canonical, "{d}", .{value}) catch unreachable;
    return std.mem.eql(u8, formatted, text);
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

test "server artifacts expose only protocol files" {
    try std.testing.expect(safeArtifactPath("manifest.json"));
    try std.testing.expect(safeArtifactPath("terrain.vtexarr"));
    try std.testing.expect(safeArtifactPath("tiles/t.-3.12.vtile"));
    try std.testing.expect(!safeArtifactPath("operator-notes.txt"));
    try std.testing.expect(!safeArtifactPath("tiles/not-a-tile.vtile"));
    try std.testing.expect(!safeArtifactPath("tiles/t.1.2.vtile.tmp"));
    // One canonical URL per tile: alias spellings of the same coordinate 400.
    try std.testing.expect(!safeArtifactPath("tiles/t.+1.2.vtile"));
    try std.testing.expect(!safeArtifactPath("tiles/t.01.2.vtile"));
    try std.testing.expect(!safeArtifactPath("tiles/t.1.-0.vtile"));
    try std.testing.expect(safeArtifactPath("tiles/t.0.0.vtile"));
}

test "mimeType maps the served extensions" {
    try std.testing.expectEqualStrings("text/html; charset=utf-8", mimeType("/index.html"));
    try std.testing.expectEqualStrings("text/javascript", mimeType("/assets/index-abc.js"));
    try std.testing.expectEqualStrings("application/json", mimeType("manifest.json"));
    try std.testing.expectEqualStrings("application/octet-stream", mimeType("tiles/t.0.0.vtile"));
}

test "origin allowlist is exact" {
    const allowed = [_][]const u8{ "https://maps.example", "http://127.0.0.1:3000" };
    try std.testing.expect(originAllowed(&allowed, "https://maps.example"));
    try std.testing.expect(!originAllowed(&allowed, "https://maps.example.evil"));
    try std.testing.expect(!originAllowed(&allowed, "https://maps.example/"));
}

test "bearer values are parsed and verified without prefix ambiguity" {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash("this-is-a-long-random-test-token", &digest, .{});
    try std.testing.expect(bearerValueMatches("Bearer this-is-a-long-random-test-token", digest));
    try std.testing.expect(bearerValueMatches("bearer this-is-a-long-random-test-token", digest));
    try std.testing.expect(!bearerValueMatches("bearer\tthis-is-a-long-random-test-token", digest));
    try std.testing.expect(!bearerValueMatches("Bearer this-is-a-long-random-test-token-extra", digest));
    try std.testing.expect(!bearerValueMatches("Basic this-is-a-long-random-test-token", digest));
    try std.testing.expect(!bearerValueMatches("Bearer", digest));
}

test "embedded server OpenAPI document is valid JSON" {
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, openapi_spec, .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings("3.1.0", parsed.value.object.get("openapi").?.string);
    try std.testing.expect(parsed.value.object.get("paths").?.object.contains("/v1/worlds"));
}
