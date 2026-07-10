//! Minimal NBT (Named Binary Tag) reader.
//!
//! NBT is big-endian. We parse a decompressed chunk into an arena-backed tree
//! and provide small typed accessors — intentionally simple; a streaming/visitor
//! parser that avoids the intermediate tree is a possible future optimization.
//! All allocations come from a caller-provided arena, so there is no per-tag
//! free.

const std = @import("std");

pub const TagType = enum(u8) {
    end = 0,
    byte = 1,
    short = 2,
    int = 3,
    long = 4,
    float = 5,
    double = 6,
    byte_array = 7,
    string = 8,
    list = 9,
    compound = 10,
    int_array = 11,
    long_array = 12,
};

pub const List = struct {
    elem: TagType,
    items: []Tag,
};

pub const Tag = union(TagType) {
    end: void,
    byte: i8,
    short: i16,
    int: i32,
    long: i64,
    float: f32,
    double: f64,
    byte_array: []const u8,
    string: []const u8,
    list: List,
    compound: []Entry,
    int_array: []i32,
    long_array: []i64,
};

pub const Entry = struct {
    name: []const u8,
    tag: Tag,
};

/// Find a child of a compound by name.
pub fn get(entries: []const Entry, name: []const u8) ?*const Tag {
    for (entries) |*e| {
        if (std.mem.eql(u8, e.name, name)) return &e.tag;
    }
    return null;
}

pub const Parser = struct {
    buf: []const u8,
    pos: usize = 0,
    arena: std.mem.Allocator,

    pub const Error = error{ Truncated, BadTag } || std.mem.Allocator.Error;

    fn ensure(self: *Parser, n: usize) Error!void {
        if (self.pos + n > self.buf.len) return error.Truncated;
    }

    fn readU8(self: *Parser) Error!u8 {
        try self.ensure(1);
        const v = self.buf[self.pos];
        self.pos += 1;
        return v;
    }

    fn readInt(self: *Parser, comptime T: type) Error!T {
        const n = @divExact(@bitSizeOf(T), 8);
        try self.ensure(n);
        const v = std.mem.readInt(T, self.buf[self.pos..][0..n], .big);
        self.pos += n;
        return v;
    }

    fn readString(self: *Parser) Error![]const u8 {
        const len = try self.readInt(u16);
        try self.ensure(len);
        const s = self.buf[self.pos .. self.pos + len];
        self.pos += len;
        return s;
    }

    fn count(self: *Parser) Error!usize {
        const n = try self.readInt(i32);
        return if (n < 0) 0 else @intCast(n);
    }

    /// Parse the unnamed root compound (modern chunk format, 1.18+).
    pub fn parseRoot(self: *Parser) Error![]Entry {
        const t: TagType = @enumFromInt(try self.readU8());
        if (t != .compound) return error.BadTag;
        _ = try self.readString(); // root name, usually empty
        return self.parseCompound();
    }

    fn parseCompound(self: *Parser) Error![]Entry {
        var list: std.ArrayList(Entry) = .empty;
        while (true) {
            const tag_byte = try self.readU8();
            if (tag_byte == 0) break; // TAG_End
            if (tag_byte > 12) return error.BadTag;
            const t: TagType = @enumFromInt(tag_byte);
            const name = try self.readString();
            const tag = try self.parsePayload(t);
            try list.append(self.arena, .{ .name = name, .tag = tag });
        }
        return list.toOwnedSlice(self.arena);
    }

    fn parseList(self: *Parser) Error!List {
        const elem_byte = try self.readU8();
        if (elem_byte > 12) return error.BadTag;
        const elem: TagType = @enumFromInt(elem_byte);
        const n = try self.count();
        const items = try self.arena.alloc(Tag, n);
        for (items) |*it| it.* = try self.parsePayload(elem);
        return .{ .elem = elem, .items = items };
    }

    fn parsePayload(self: *Parser, t: TagType) Error!Tag {
        return switch (t) {
            .end => .{ .end = {} },
            .byte => .{ .byte = @bitCast(try self.readU8()) },
            .short => .{ .short = try self.readInt(i16) },
            .int => .{ .int = try self.readInt(i32) },
            .long => .{ .long = try self.readInt(i64) },
            .float => .{ .float = @bitCast(try self.readInt(u32)) },
            .double => .{ .double = @bitCast(try self.readInt(u64)) },
            .byte_array => blk: {
                const n = try self.count();
                try self.ensure(n);
                const bytes = self.buf[self.pos .. self.pos + n];
                self.pos += n;
                break :blk .{ .byte_array = bytes };
            },
            .string => .{ .string = try self.readString() },
            .list => .{ .list = try self.parseList() },
            .compound => .{ .compound = try self.parseCompound() },
            .int_array => blk: {
                const n = try self.count();
                const arr = try self.arena.alloc(i32, n);
                for (arr) |*v| v.* = try self.readInt(i32);
                break :blk .{ .int_array = arr };
            },
            .long_array => blk: {
                const n = try self.count();
                const arr = try self.arena.alloc(i64, n);
                for (arr) |*v| v.* = try self.readInt(i64);
                break :blk .{ .long_array = arr };
            },
        };
    }
};
