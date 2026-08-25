//! `vantage extract` — pull the asset subset a render needs straight out of a
//! Minecraft client jar (blockstates, block models + textures, colormaps, the
//! language file, and worldgen biome data) into the vantage asset cache. This
//! is the built-in replacement for the old `unzip` incantation, so a release
//! binary is self-sufficient: no repo checkout, no external tools.

const std = @import("std");

/// Entry prefixes a render needs. Everything else in the jar (sounds, unrelated
/// entity textures, shaders, …) is skipped — the cache stays compact.
const wanted_prefixes = [_][]const u8{
    "assets/minecraft/blockstates/",
    "assets/minecraft/models/block/",
    "assets/minecraft/textures/block/",
    "assets/minecraft/textures/colormap/",
    // Vanilla renders these blocks through special renderers rather than block
    // model elements. Vantage recreates their static geometry, so retain only
    // the entity-texture families that those block renderers reference.
    "assets/minecraft/textures/entity/chest/",
    "assets/minecraft/textures/entity/bed/",
    "assets/minecraft/textures/entity/signs/",
    "assets/minecraft/textures/entity/banner/",
    "assets/minecraft/textures/entity/shulker/",
    "assets/minecraft/textures/entity/decorated_pot/",
    "assets/minecraft/textures/entity/conduit/",
    "assets/minecraft/textures/entity/copper_golem/",
    "assets/minecraft/textures/entity/skeleton/",
    "assets/minecraft/textures/entity/zombie/",
    "assets/minecraft/textures/entity/creeper/",
    "assets/minecraft/textures/entity/piglin/",
    "assets/minecraft/textures/entity/enderdragon/",
    "assets/minecraft/textures/entity/player/",
    "data/minecraft/worldgen/biome/",
};

/// Exact entries a render needs (block display names for the biome legend/UI).
const wanted_files = [_][]const u8{
    "assets/minecraft/lang/en_us.json",
};

fn wanted(name: []const u8) bool {
    for (wanted_prefixes) |p| if (std.mem.startsWith(u8, name, p)) return true;
    for (wanted_files) |f| if (std.mem.eql(u8, name, f)) return true;
    return false;
}

pub const Summary = struct { files: usize, bytes: u64, reused: bool = false };

/// Versioned last-write marker for an extraction completed with the current
/// allowlist. Bump the name whenever required cache contents change.
pub const completion_marker = ".vantage-assets-v2.complete";

fn prepareExtractionDestination(parent: std.Io.Dir, io: std.Io, dest_path: []const u8) !void {
    // Invalidate the old publication first. If recursive cleanup later fails,
    // findAssets cannot mistake the partially removed directory for a complete
    // cache on the next run.
    var marker_buf: [std.fs.max_path_bytes]u8 = undefined;
    const marker_path = try std.fmt.bufPrint(&marker_buf, "{s}/{s}", .{ dest_path, completion_marker });
    parent.deleteFile(io, marker_path) catch |err| switch (err) {
        error.FileNotFound => {},
        else => return err,
    };
    try parent.deleteTree(io, dest_path);
}

fn cacheIsComplete(parent: std.Io.Dir, io: std.Io, dest_path: []const u8) bool {
    var marker_buf: [std.fs.max_path_bytes]u8 = undefined;
    const marker_path = std.fmt.bufPrint(&marker_buf, "{s}/{s}", .{ dest_path, completion_marker }) catch return false;
    var marker = parent.openFile(io, marker_path, .{}) catch return false;
    marker.close(io);

    var blockstates_buf: [std.fs.max_path_bytes]u8 = undefined;
    const blockstates_path = std.fmt.bufPrint(&blockstates_buf, "{s}/assets/minecraft/blockstates", .{dest_path}) catch return false;
    var blockstates = parent.openDir(io, blockstates_path, .{}) catch return false;
    blockstates.close(io);
    return true;
}

fn publishStaging(parent: std.Io.Dir, io: std.Io, staging_path: []const u8, dest_path: []const u8) !void {
    // Only incomplete destinations reach publication; current completed caches
    // are immutable and reused above. Remove any stale partial destination, then
    // publish the fully populated, marker-bearing sibling with one rename.
    try prepareExtractionDestination(parent, io, dest_path);
    try parent.rename(staging_path, parent, dest_path, io);
}

test "published cache requires marker and blockstates" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const io = std.testing.io;
    try tmp.dir.createDirPath(io, "dest/assets/minecraft/blockstates");
    try std.testing.expect(!cacheIsComplete(tmp.dir, io, "dest"));
    try tmp.dir.writeFile(io, .{ .sub_path = "dest/" ++ completion_marker, .data = "complete\n" });
    try std.testing.expect(cacheIsComplete(tmp.dir, io, "dest"));
}

test "staging publication replaces an incomplete destination" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const io = std.testing.io;
    try tmp.dir.createDirPath(io, "dest/partial");
    try tmp.dir.createDirPath(io, "dest.staging/assets/minecraft/blockstates");
    try tmp.dir.writeFile(io, .{ .sub_path = "dest.staging/" ++ completion_marker, .data = "complete\n" });

    // Production publishes through cwd using absolute cache paths. Exercise
    // that exact shape: on Windows, renaming a child through tmp.dir's open
    // directory handle is denied even though the cwd/absolute operation works.
    var root_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root_len = try tmp.dir.realPath(io, &root_buf);
    var staging_buf: [std.fs.max_path_bytes]u8 = undefined;
    const staging_path = try std.fmt.bufPrint(&staging_buf, "{s}/dest.staging", .{root_buf[0..root_len]});
    var dest_buf: [std.fs.max_path_bytes]u8 = undefined;
    const dest_path = try std.fmt.bufPrint(&dest_buf, "{s}/dest", .{root_buf[0..root_len]});
    try publishStaging(std.Io.Dir.cwd(), io, staging_path, dest_path);
    try std.testing.expect(cacheIsComplete(tmp.dir, io, "dest"));
    try std.testing.expectError(error.FileNotFound, tmp.dir.openDir(io, "dest.staging", .{}));
}

test "preparing extraction removes completion marker before reuse" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const io = std.testing.io;
    try tmp.dir.createDirPath(io, "dest/assets/minecraft/blockstates");
    try tmp.dir.writeFile(io, .{
        .sub_path = "dest/" ++ completion_marker,
        .data = "complete\n",
    });

    try prepareExtractionDestination(tmp.dir, io, "dest");
    try std.testing.expectError(error.FileNotFound, tmp.dir.openDir(io, "dest", .{}));
}

/// Extract the needed subset of `jar_path` into `dest_path` (created if
/// missing). Any partially-populated destination is wiped first so a re-run
/// always converges — `std.zip`'s extraction is exclusive-create.
pub fn extractJar(io: std.Io, jar_path: []const u8, dest_path: []const u8) !Summary {
    const cwd = std.Io.Dir.cwd();

    // Serialise extractors for this version. A completed cache is immutable for
    // the marker version, so an extractor never invalidates a directory that a
    // renderer could already have selected.
    const parent_path = std.fs.path.dirname(dest_path) orelse ".";
    try cwd.createDirPath(io, parent_path);
    var lock_buf: [std.fs.max_path_bytes]u8 = undefined;
    const lock_path = try std.fmt.bufPrint(&lock_buf, "{s}.lock", .{dest_path});
    var lock = try cwd.createFile(io, lock_path, .{ .truncate = false });
    defer lock.close(io);
    // Windows byte-range locks do not contend reliably beyond a zero-length
    // file. Materialize the one-byte range before taking the blocking lock.
    try lock.setLength(io, 1);
    try lock.lock(io, .exclusive);

    if (cacheIsComplete(cwd, io, dest_path))
        return .{ .files = 0, .bytes = 0, .reused = true };

    var staging_buf: [std.fs.max_path_bytes]u8 = undefined;
    const staging_path = try std.fmt.bufPrint(&staging_buf, "{s}.staging", .{dest_path});
    try prepareExtractionDestination(cwd, io, staging_path);
    errdefer prepareExtractionDestination(cwd, io, staging_path) catch {};

    var jar = cwd.openFile(io, jar_path, .{}) catch |e| {
        std.debug.print("cannot open client jar: {s}\n", .{jar_path});
        return e;
    };
    defer jar.close(io);
    var read_buf: [8192]u8 = undefined;
    var fr = jar.reader(io, &read_buf);

    try cwd.createDirPath(io, staging_path);
    var summary: Summary = .{ .files = 0, .bytes = 0 };
    {
        var dest = try cwd.openDir(io, staging_path, .{});
        defer dest.close(io);

        var it = try std.zip.Iterator.init(&fr);
        var name_buf: [4096]u8 = undefined;
        while (try it.next()) |entry| {
            if (entry.filename_len > name_buf.len) continue; // never true for vanilla jars
            try fr.seekTo(entry.header_zip_offset + @sizeOf(std.zip.CentralDirectoryFileHeader));
            const name = name_buf[0..entry.filename_len];
            try fr.interface.readSliceAll(name);
            if (name.len == 0 or name[name.len - 1] == '/') continue; // directory entry
            if (!wanted(name)) continue;
            try entry.extract(&fr, .{}, &name_buf, dest);
            summary.files += 1;
            summary.bytes += entry.uncompressed_size;
        }
        if (summary.files == 0) return error.NoAssetsInJar;
        // Written last: interrupted extraction leaves no marker and is never
        // mistaken for a complete cache by auto-discovery.
        try dest.writeFile(io, .{ .sub_path = completion_marker, .data = "complete\n" });
    }
    try publishStaging(cwd, io, staging_path, dest_path);
    return summary;
}

test "extract includes textures used by special block renderers" {
    try std.testing.expect(wanted("assets/minecraft/textures/entity/chest/normal.png"));
    try std.testing.expect(wanted("assets/minecraft/textures/entity/bed/red.png"));
    try std.testing.expect(wanted("assets/minecraft/textures/entity/signs/oak.png"));
    try std.testing.expect(wanted("assets/minecraft/textures/entity/banner/base.png"));
    try std.testing.expect(wanted("assets/minecraft/textures/entity/shulker/shulker_blue.png"));
    try std.testing.expect(wanted("assets/minecraft/textures/entity/decorated_pot/decorated_pot_side.png"));
    try std.testing.expect(!wanted("assets/minecraft/textures/entity/cow/cow.png"));
}
