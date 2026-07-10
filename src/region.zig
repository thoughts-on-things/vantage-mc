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

pub const Region = struct {
    bytes: []const u8,

    pub fn fromBytes(bytes: []const u8) Region {
        return .{ .bytes = bytes };
    }

    const Loc = struct { offset_sectors: u32, sector_count: u8 };

    fn locate(self: Region, lx: u5, lz: u5) ?Loc {
        const idx: usize = (@as(usize, lz) * 32 + lx) * 4;
        if (idx + 4 > self.bytes.len) return null;
        const b = self.bytes;
        const off: u32 = (@as(u32, b[idx]) << 16) | (@as(u32, b[idx + 1]) << 8) | b[idx + 2];
        const cnt: u8 = b[idx + 3];
        if (off == 0 and cnt == 0) return null; // chunk absent
        return .{ .offset_sectors = off, .sector_count = cnt };
    }

    /// Return the raw (still-compressed) chunk at local coords, or null if absent.
    pub fn rawChunk(self: Region, lx: u5, lz: u5) !?RawChunk {
        const loc = self.locate(lx, lz) orelse return null;
        const start: usize = @as(usize, loc.offset_sectors) * SECTOR;
        if (start + 5 > self.bytes.len) return error.Truncated;
        const len = std.mem.readInt(u32, self.bytes[start..][0..4], .big);
        if (len == 0) return null;
        // High bit of the compression byte marks an external .mcc chunk,
        // which is not supported.
        const comp_byte = self.bytes[start + 4];
        if (comp_byte & 0x80 != 0) return error.ExternalChunk;
        const comp: Compression = @enumFromInt(comp_byte);
        const data_start = start + 5;
        const data_len: usize = len - 1; // length counts the compression byte
        if (data_start + data_len > self.bytes.len) return error.Truncated;
        return RawChunk{ .compression = comp, .data = self.bytes[data_start .. data_start + data_len] };
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
