//! Anvil region (.mca) reader.
//!
//! Layout (see minecraft.wiki "Region file format"):
//!   0x0000..0x0FFF  location table: 1024 x 4-byte BE entries
//!                   [3-byte sector offset][1-byte sector count]
//!   0x1000..0x1FFF  timestamp table (ignored here)
//!   0x2000+         sector-aligned chunk payloads:
//!                   [4-byte BE length N][1-byte compression type][N-1 bytes data]
//!
//! A region holds 32x32 chunks; the location-table index is z*32 + x.

const std = @import("std");
const compress = @import("compress.zig");

pub const SECTOR = 4096;

pub const Compression = enum(u8) {
    gzip = 1,
    zlib = 2,
    none = 3,
    lz4 = 4,
    custom = 127,
    _,
};

pub const RawChunk = struct {
    compression: Compression,
    /// Still-compressed chunk payload (a slice into the region buffer).
    data: []const u8,
};

pub const Loc = struct { offset_sectors: u32, sector_count: u8 };

/// Look up a chunk's location-table entry. `table` is the start of a region
/// file — the full buffer, or just its first 4 KiB (the location table) when
/// the payloads are read from disk on demand.
pub fn locate(table: []const u8, lx: u5, lz: u5) ?Loc {
    const idx: usize = (@as(usize, lz) * 32 + lx) * 4;
    if (idx + 4 > table.len) return null;
    const off: u32 = (@as(u32, table[idx]) << 16) | (@as(u32, table[idx + 1]) << 8) | table[idx + 2];
    const cnt: u8 = table[idx + 3];
    if (off == 0 and cnt == 0) return null; // chunk absent
    return .{ .offset_sectors = off, .sector_count = cnt };
}

/// Parse a raw chunk out of its sector-aligned payload — `buf` starts at the
/// chunk's first sector (offset `Loc.offset_sectors * SECTOR` in the file) and
/// spans at most `Loc.sector_count` sectors.
pub fn rawChunkFromSectors(buf: []const u8) !?RawChunk {
    if (buf.len < 5) return error.Truncated;
    const len = std.mem.readInt(u32, buf[0..4], .big);
    if (len == 0) return null;
    // High bit of the compression byte marks an external .mcc chunk,
    // which is not supported.
    const comp_byte = buf[4];
    if (comp_byte & 0x80 != 0) return error.ExternalChunk;
    const comp: Compression = @enumFromInt(comp_byte);
    const data_len: usize = len - 1; // length counts the compression byte
    if (5 + data_len > buf.len) return error.Truncated;
    return RawChunk{ .compression = comp, .data = buf[5 .. 5 + data_len] };
}

pub const Region = struct {
    bytes: []const u8,

    pub fn fromBytes(bytes: []const u8) Region {
        return .{ .bytes = bytes };
    }

    /// Return the raw (still-compressed) chunk at local coords, or null if absent.
    pub fn rawChunk(self: Region, lx: u5, lz: u5) !?RawChunk {
        const loc = locate(self.bytes, lx, lz) orelse return null;
        const start: usize = @as(usize, loc.offset_sectors) * SECTOR;
        if (start >= self.bytes.len) return error.Truncated;
        const end = @min(self.bytes.len, start + @as(usize, loc.sector_count) * SECTOR);
        return rawChunkFromSectors(self.bytes[start..end]);
    }
};

/// Decompress a raw chunk into NBT bytes.
pub fn decompress(allocator: std.mem.Allocator, raw: RawChunk) ![]u8 {
    return switch (raw.compression) {
        .zlib => compress.inflateZlib(allocator, raw.data),
        .gzip => compress.inflateGzip(allocator, raw.data),
        .none => allocator.dupe(u8, raw.data),
        else => error.UnsupportedCompression,
    };
}
