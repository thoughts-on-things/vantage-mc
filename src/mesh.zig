//! Naive culled cube mesher (P1).
//!
//! For every solid cell, emit each of its 6 faces only when the neighbor in that
//! direction is non-solid. This is the simplest mesh that already does the most
//! important thing BlueMap does — hide interior faces — without yet doing greedy
//! merging (P3). Output is indexed (4 verts + 6 indices per quad), the first
//! step away from BlueMap's vertex-duplicating non-indexed PRBM.
//!
//! Faces carry flat per-face normals (for lighting) and the cell's flat color.

const std = @import("std");
const grid = @import("grid.zig");

pub const Mesh = struct {
    positions: std.ArrayList(f32) = .empty, // 3 per vertex (world coords)
    colors: std.ArrayList(u8) = .empty, // 4 per vertex (RGBA)
    normals: std.ArrayList(i8) = .empty, // 4 per vertex (xyz + pad)
    indices: std.ArrayList(u32) = .empty,
    vertex_count: u32 = 0,

    pub fn quadCount(self: Mesh) u32 {
        return self.vertex_count / 4;
    }
    pub fn triangleCount(self: Mesh) usize {
        return self.indices.items.len / 3;
    }
};

const Face = struct {
    /// Neighbor offset to test for culling.
    d: [3]i8,
    /// Outward normal.
    n: [3]i8,
    /// Four CCW corners (offsets within the unit cube) viewed from outside.
    corners: [4][3]u8,
};

// Corner offsets chosen so triangles (0,1,2) and (0,2,3) wind CCW outward.
const faces = [6]Face{
    .{ .d = .{ 1, 0, 0 }, .n = .{ 1, 0, 0 }, .corners = .{ .{ 1, 0, 1 }, .{ 1, 0, 0 }, .{ 1, 1, 0 }, .{ 1, 1, 1 } } }, // +X
    .{ .d = .{ -1, 0, 0 }, .n = .{ -1, 0, 0 }, .corners = .{ .{ 0, 0, 0 }, .{ 0, 0, 1 }, .{ 0, 1, 1 }, .{ 0, 1, 0 } } }, // -X
    .{ .d = .{ 0, 1, 0 }, .n = .{ 0, 1, 0 }, .corners = .{ .{ 0, 1, 0 }, .{ 0, 1, 1 }, .{ 1, 1, 1 }, .{ 1, 1, 0 } } }, // +Y
    .{ .d = .{ 0, -1, 0 }, .n = .{ 0, -1, 0 }, .corners = .{ .{ 0, 0, 0 }, .{ 1, 0, 0 }, .{ 1, 0, 1 }, .{ 0, 0, 1 } } }, // -Y
    .{ .d = .{ 0, 0, 1 }, .n = .{ 0, 0, 1 }, .corners = .{ .{ 0, 0, 1 }, .{ 1, 0, 1 }, .{ 1, 1, 1 }, .{ 0, 1, 1 } } }, // +Z
    .{ .d = .{ 0, 0, -1 }, .n = .{ 0, 0, -1 }, .corners = .{ .{ 1, 0, 0 }, .{ 0, 0, 0 }, .{ 0, 1, 0 }, .{ 1, 1, 0 } } }, // -Z
};

pub fn build(arena: std.mem.Allocator, g: grid.Grid) !Mesh {
    var mesh: Mesh = .{};
    if (g.cells.len == 0) return mesh;

    var y: usize = 0;
    while (y < g.sy) : (y += 1) {
        var z: usize = 0;
        while (z < g.sz) : (z += 1) {
            var x: usize = 0;
            while (x < g.sx) : (x += 1) {
                const cell = g.cells[g.index(x, y, z)];
                if (!cell.solid) continue;
                const wx: f32 = @floatFromInt(@as(i64, g.min_x) + @as(i64, @intCast(x)));
                const wy: f32 = @floatFromInt(@as(i64, g.min_y) + @as(i64, @intCast(y)));
                const wz: f32 = @floatFromInt(@as(i64, g.min_z) + @as(i64, @intCast(z)));
                for (faces) |f| {
                    const nb = g.at(
                        @as(isize, @intCast(x)) + f.d[0],
                        @as(isize, @intCast(y)) + f.d[1],
                        @as(isize, @intCast(z)) + f.d[2],
                    );
                    if (nb.solid) continue; // interior face, cull
                    try emitQuad(arena, &mesh, wx, wy, wz, f, cell.color);
                }
            }
        }
    }
    return mesh;
}

fn emitQuad(
    arena: std.mem.Allocator,
    mesh: *Mesh,
    wx: f32,
    wy: f32,
    wz: f32,
    f: Face,
    color: [3]u8,
) !void {
    const base = mesh.vertex_count;
    for (f.corners) |c| {
        try mesh.positions.appendSlice(arena, &.{
            wx + @as(f32, @floatFromInt(c[0])),
            wy + @as(f32, @floatFromInt(c[1])),
            wz + @as(f32, @floatFromInt(c[2])),
        });
        try mesh.colors.appendSlice(arena, &.{ color[0], color[1], color[2], 255 });
        try mesh.normals.appendSlice(arena, &.{ f.n[0], f.n[1], f.n[2], 0 });
    }
    try mesh.indices.appendSlice(arena, &.{
        base + 0, base + 1, base + 2,
        base + 0, base + 2, base + 3,
    });
    mesh.vertex_count += 4;
}

test "single solid cell yields 6 culled-free faces" {
    const a = std.testing.allocator;
    var cells = [_]grid.Cell{.{ .color = .{ 1, 2, 3 }, .solid = true }};
    const g: grid.Grid = .{
        .sx = 1, .sy = 1, .sz = 1,
        .min_x = 0, .min_y = 0, .min_z = 0,
        .cells = &cells,
    };
    var mesh = try build(a, g);
    defer {
        mesh.positions.deinit(a);
        mesh.colors.deinit(a);
        mesh.normals.deinit(a);
        mesh.indices.deinit(a);
    }
    try std.testing.expectEqual(@as(u32, 24), mesh.vertex_count); // 6 faces * 4
    try std.testing.expectEqual(@as(usize, 36), mesh.indices.items.len); // 6 * 6
    try std.testing.expectEqual(@as(usize, 12), mesh.triangleCount());
}

test "two adjacent cells cull their shared faces" {
    const a = std.testing.allocator;
    var cells = [_]grid.Cell{
        .{ .color = .{ 9, 9, 9 }, .solid = true },
        .{ .color = .{ 9, 9, 9 }, .solid = true },
    };
    const g: grid.Grid = .{
        .sx = 2, .sy = 1, .sz = 1,
        .min_x = 0, .min_y = 0, .min_z = 0,
        .cells = &cells,
    };
    var mesh = try build(a, g);
    defer {
        mesh.positions.deinit(a);
        mesh.colors.deinit(a);
        mesh.normals.deinit(a);
        mesh.indices.deinit(a);
    }
    // 12 faces total minus the 2 shared interior faces = 10 quads.
    try std.testing.expectEqual(@as(u32, 10), mesh.quadCount());
}
