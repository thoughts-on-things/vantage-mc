//! `vantage extract` — pull the asset subset a render needs straight out of a
//! Minecraft client jar (blockstates, block models + textures, colormaps, the
//! language file, and worldgen biome data) into the vantage asset cache. This
//! is the built-in replacement for the old `unzip` incantation, so a release
//! binary is self-sufficient: no repo checkout, no external tools.

const std = @import("std");

/// Entry prefixes a render needs. Everything else in the jar (sounds, entity
/// textures, shaders, …) is skipped — the cache stays a few MB.
const wanted_prefixes = [_][]const u8{
    "assets/minecraft/blockstates/",
    "assets/minecraft/models/block/",
    "assets/minecraft/textures/block/",
    "assets/minecraft/textures/colormap/",
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

pub const Summary = struct { files: usize, bytes: u64 };

/// Extract the needed subset of `jar_path` into `dest_path` (created if
/// missing). Any partially-populated destination is wiped first so a re-run
/// always converges — `std.zip`'s extraction is exclusive-create.
pub fn extractJar(io: std.Io, jar_path: []const u8, dest_path: []const u8) !Summary {
    const cwd = std.Io.Dir.cwd();

    var jar = cwd.openFile(io, jar_path, .{}) catch |e| {
        std.debug.print("cannot open client jar: {s}\n", .{jar_path});
        return e;
    };
    defer jar.close(io);
    var read_buf: [8192]u8 = undefined;
    var fr = jar.reader(io, &read_buf);

    cwd.deleteTree(io, dest_path) catch {};
    try cwd.createDirPath(io, dest_path);
    var dest = try cwd.openDir(io, dest_path, .{});
    defer dest.close(io);

    var it = try std.zip.Iterator.init(&fr);
    var name_buf: [4096]u8 = undefined;
    var summary: Summary = .{ .files = 0, .bytes = 0 };
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
    return summary;
}
