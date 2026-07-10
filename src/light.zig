//! Computed sky + block light (flood fill).
//!
//! Minecraft region files frequently omit saved `SkyLight`/`BlockLight` —
//! common for tool-generated or externally-processed worlds. So we compute
//! light ourselves rather than read it.
//!
//! Two breadth-first passes over the dense block grid:
//!  - **Sky**: every cell with an open vertical path to the top starts at 15;
//!    light floods to non-occluding neighbours losing one level per step. Caves
//!    and the undersides of overhangs darken; ground beneath a leaf canopy dims
//!    because the canopy blocks its column.
//!  - **Block**: every light-emitting block seeds its emission level and floods
//!    the same way. Torches, lava, glowstone, lanterns glow outward.
//!
//! Both pack into the grid's per-voxel light as `(sky << 4) | block`.

const std = @import("std");
const grid = @import("grid.zig");
const model = @import("model.zig");

pub const MAX: u8 = 15;

/// Flood-fill sky + block light into `g.light` (preallocated to sx*sy*sz).
/// `occluder[id]` marks blocks that stop light (opaque full cubes); `emission[id]`
/// is each block id's emitted level (0 = none). Both are indexed by grid block id
/// (id 0 = air: not an occluder, no emission). All scratch comes from `arena`.
/// `attenuate[id]` (optional, parallel to `occluder`) marks blocks that dim sky
/// light as it passes down through them — water — so the seabed darkens with
/// depth instead of staying full-bright. With the surface drawn semi-transparent,
/// that depth gradient is what reads as deep vs. shallow water, rather than
/// fading the water itself to opaque.
pub fn compute(arena: std.mem.Allocator, g: grid.Grid, occluder: []const bool, emission: []const u8, attenuate: ?[]const bool) !void {
    const n = g.sx * g.sy * g.sz;
    if (n == 0 or g.light.len != n) return;

    const sky = try arena.alloc(u8, n);
    const blk = try arena.alloc(u8, n);
    @memset(sky, 0);
    @memset(blk, 0);

    var queue: std.ArrayList(u32) = .empty;

    // --- Sky pass. Pass 1: mark every cell open to the top (column walk). ---
    var z: usize = 0;
    while (z < g.sz) : (z += 1) {
        var x: usize = 0;
        while (x < g.sx) : (x += 1) {
            var y: usize = g.sy;
            var level: u8 = MAX;
            while (y > 0) {
                y -= 1;
                const idx = g.index(x, y, z);
                const id = g.ids[idx];
                if (occluder[id]) break; // first opaque from the top closes the column
                sky[idx] = level;
                // Water dims the column going down, so deep seabed is dark.
                if (attenuate) |att| {
                    if (att[id] and level > 0) level -= 1;
                }
            }
        }
    }
    // Pass 2: seed only the *frontier* — open cells bordering a non-open cell (the
    // lit shoreline). Interior open cells are already MAX with all-MAX neighbours,
    // so seeding them only adds redundant pops; skipping them keeps the BFS queue
    // tiny. Identical result to seeding every open cell, far less work.
    try seedFrontier(arena, g, sky, &queue);
    try flood(arena, g, occluder, sky, &queue);

    // --- Block pass: seed every emitter, then flood. Skipped wholesale when no
    // block in the grid emits light (common for natural terrain) — that avoids a
    // full O(cells) seed scan + BFS, leaving block light at 0 everywhere. ---
    var any_emitter = false;
    for (emission) |e| if (e > 0) {
        any_emitter = true;
        break;
    };
    if (any_emitter) {
        queue.clearRetainingCapacity();
        for (g.ids, 0..) |id, idx| {
            const e = emission[id];
            if (e > 0) {
                blk[idx] = e;
                try queue.append(arena, @intCast(idx));
            }
        }
        try flood(arena, g, occluder, blk, &queue);
    }

    for (g.light, sky, blk) |*out, s, b| out.* = (s << 4) | b;
}

/// Enqueue the sky frontier: every open-to-sky cell (`sky == MAX`) that has at
/// least one in-bounds neighbour which is *not* open (an occluder or a shaded
/// cell below a roof). Those are the only cells that need to propagate light
/// inward; interior open cells are surrounded by MAX and would just pop no-ops.
fn seedFrontier(arena: std.mem.Allocator, g: grid.Grid, sky: []const u8, queue: *std.ArrayList(u32)) !void {
    const n = g.sx * g.sy * g.sz;
    var i: usize = 0;
    while (i < n) : (i += 1) {
        if (sky[i] != MAX) continue;
        const x = i % g.sx;
        const rem = i / g.sx;
        const zc = rem % g.sz;
        const yc = rem / g.sz;
        var frontier = false;
        inline for (.{
            .{ -1, 0, 0 }, .{ 1, 0, 0 },
            .{ 0, -1, 0 }, .{ 0, 1, 0 },
            .{ 0, 0, -1 }, .{ 0, 0, 1 },
        }) |d| {
            if (!frontier) {
                const nx = @as(isize, @intCast(x)) + d[0];
                const ny = @as(isize, @intCast(yc)) + d[1];
                const nz = @as(isize, @intCast(zc)) + d[2];
                if (nx >= 0 and ny >= 0 and nz >= 0 and
                    nx < g.sx and ny < g.sy and nz < g.sz)
                {
                    if (sky[g.index(@intCast(nx), @intCast(ny), @intCast(nz))] != MAX) frontier = true;
                }
            }
        }
        if (frontier) try queue.append(arena, @intCast(i));
    }
}

/// Breadth-first light spread from a seeded frontier. Each popped cell pushes its
/// level minus one into any non-occluding neighbour that is currently darker. A
/// head index turns the array into a FIFO without front-pops; the "only when
/// brighter" guard bounds total work (levels are monotonic and ≤ 15).
fn flood(arena: std.mem.Allocator, g: grid.Grid, occluder: []const bool, level: []u8, queue: *std.ArrayList(u32)) !void {
    var head: usize = 0;
    while (head < queue.items.len) : (head += 1) {
        const idx = queue.items[head];
        const cur = level[idx];
        if (cur <= 1) continue;
        const nl = cur - 1;

        // Recover (x,y,z) from the flat index: idx = (y*sz + z)*sx + x.
        const x = idx % g.sx;
        const rem = idx / g.sx;
        const zc = rem % g.sz;
        const yc = rem / g.sz;

        inline for (.{
            .{ -1, 0, 0 }, .{ 1, 0, 0 },
            .{ 0, -1, 0 }, .{ 0, 1, 0 },
            .{ 0, 0, -1 }, .{ 0, 0, 1 },
        }) |d| {
            const nx = @as(isize, @intCast(x)) + d[0];
            const ny = @as(isize, @intCast(yc)) + d[1];
            const nz = @as(isize, @intCast(zc)) + d[2];
            if (nx >= 0 and ny >= 0 and nz >= 0 and
                nx < g.sx and ny < g.sy and nz < g.sz)
            {
                const nidx = g.index(@intCast(nx), @intCast(ny), @intCast(nz));
                if (!occluder[g.ids[nidx]] and level[nidx] < nl) {
                    level[nidx] = nl;
                    try queue.append(arena, @intCast(nidx));
                }
            }
        }
    }
}

/// Block light emission level for a block, 0 when it emits none. This is
/// sourceless game logic (no data file describes it — it lives in Java's
/// `Block` definitions), so a curated table is unavoidable; kept to the common,
/// always-on emitters. State-dependent emitters (lit furnaces, redstone lamps,
/// candles, berried cave vines) are deferred — better dark than wrongly lit.
pub fn emissionOf(name: []const u8) u8 {
    return emission_table.get(model.stripNs(name)) orelse 0;
}

const emission_table = std.StaticStringMap(u8).initComptime(.{
    .{ "beacon", 15 },                .{ "conduit", 15 },
    .{ "end_portal", 15 },            .{ "end_gateway", 15 },
    .{ "fire", 15 },                  .{ "glowstone", 15 },
    .{ "jack_o_lantern", 15 },        .{ "lava", 15 },
    .{ "lantern", 15 },               .{ "sea_lantern", 15 },
    .{ "shroomlight", 15 },           .{ "campfire", 15 },
    .{ "ochre_froglight", 15 },       .{ "verdant_froglight", 15 },
    .{ "pearlescent_froglight", 15 }, .{ "torch", 14 },
    .{ "wall_torch", 14 },            .{ "end_rod", 14 },
    .{ "soul_torch", 10 },            .{ "soul_wall_torch", 10 },
    .{ "soul_lantern", 10 },          .{ "soul_campfire", 10 },
    .{ "soul_fire", 10 },             .{ "crying_obsidian", 10 },
    .{ "glow_lichen", 7 },            .{ "ender_chest", 7 },
    .{ "redstone_torch", 7 },         .{ "redstone_wall_torch", 7 },
    .{ "magma_block", 3 },            .{ "brewing_stand", 1 },
    .{ "brown_mushroom", 1 },         .{ "dragon_egg", 1 },
});

test "emissionOf reads the table and strips the namespace" {
    try std.testing.expectEqual(@as(u8, 14), emissionOf("minecraft:torch"));
    try std.testing.expectEqual(@as(u8, 15), emissionOf("lava"));
    try std.testing.expectEqual(@as(u8, 0), emissionOf("minecraft:stone"));
}

test "sky light floods down and sideways into an opening, losing 1 per step" {
    var arena_inst = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_inst.deinit();
    const a = arena_inst.allocator();

    // 5-wide, 3-tall, 1-deep. A solid roof (id 1) covers x=0..3 at the top row,
    // leaving x=4 open to the sky; everything else is air. Light enters at the
    // open column and floods left under the roof, dropping a level per block.
    const sx: usize = 5;
    const sy: usize = 3;
    const sz: usize = 1;
    var ids = [_]u16{0} ** (sx * sy * sz);
    var lightbuf = [_]u8{0} ** (sx * sy * sz);
    const names = [_][]const u8{ "", "minecraft:stone" };
    var g: grid.Grid = .{
        .sx = sx,
        .sy = sy,
        .sz = sz,
        .min_x = 0,
        .min_y = 0,
        .min_z = 0,
        .ids = &ids,
        .light = &lightbuf,
        .names = @constCast(&names),
    };
    const top = sy - 1;
    for (0..4) |x| ids[g.index(x, top, 0)] = 1; // roof over x=0..3

    const occluder = [_]bool{ false, true };
    const emission = [_]u8{ 0, 0 };
    try compute(a, g, &occluder, &emission, null);

    const skyOf = struct {
        fn f(gg: grid.Grid, x: usize, y: usize, z: usize) u8 {
            return gg.light[gg.index(x, y, z)] >> 4;
        }
    }.f;
    // Open column (x=4) is full sky top to bottom.
    try std.testing.expectEqual(@as(u8, 15), skyOf(g, 4, 0, 0));
    try std.testing.expectEqual(@as(u8, 15), skyOf(g, 4, top, 0));
    // Under the roof at the bottom row, light falls off one level per step left
    // from the open column: x=3 -> 14, x=2 -> 13, x=1 -> 12, x=0 -> 11.
    try std.testing.expectEqual(@as(u8, 14), skyOf(g, 3, 0, 0));
    try std.testing.expectEqual(@as(u8, 13), skyOf(g, 2, 0, 0));
    try std.testing.expectEqual(@as(u8, 11), skyOf(g, 0, 0, 0));
}

test "block light radiates from an emitter and is blocked by walls" {
    var arena_inst = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_inst.deinit();
    const a = arena_inst.allocator();

    // A torch (id 2, emission 14) sits in a 5x1x1 air row; light falls 1/step.
    const sx: usize = 5;
    var ids = [_]u16{0} ** sx;
    var lightbuf = [_]u8{0} ** sx;
    const names = [_][]const u8{ "", "minecraft:stone", "minecraft:torch" };
    var g: grid.Grid = .{
        .sx = sx,
        .sy = 1,
        .sz = 1,
        .min_x = 0,
        .min_y = 0,
        .min_z = 0,
        .ids = &ids,
        .light = &lightbuf,
        .names = @constCast(&names),
    };
    ids[g.index(0, 0, 0)] = 2; // torch at x=0

    const occluder = [_]bool{ false, true, false };
    const emission = [_]u8{ 0, 0, 14 };
    try compute(a, g, &occluder, &emission, null);
    const blkOf = struct {
        fn f(gg: grid.Grid, x: usize) u8 {
            return gg.light[gg.index(x, 0, 0)] & 0x0F;
        }
    }.f;
    try std.testing.expectEqual(@as(u8, 14), blkOf(g, 0));
    try std.testing.expectEqual(@as(u8, 13), blkOf(g, 1));
    try std.testing.expectEqual(@as(u8, 10), blkOf(g, 4));
}

test "water attenuates the sky-light column so the seabed darkens with depth" {
    var arena_inst = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_inst.deinit();
    const a = arena_inst.allocator();

    // 1-wide column: air, then 4 water cells, then a stone floor. Water dims the
    // column one level per block, so each cell below the surface is darker.
    const sx: usize = 1;
    const sy: usize = 7;
    const sz: usize = 1;
    var ids = [_]u16{0} ** (sx * sy * sz); // id 0 = air, 1 = water, 2 = stone
    var lightbuf = [_]u8{0} ** (sx * sy * sz);
    const names = [_][]const u8{ "", "minecraft:water", "minecraft:stone" };
    var g: grid.Grid = .{
        .sx = sx,
        .sy = sy,
        .sz = sz,
        .min_x = 0,
        .min_y = 0,
        .min_z = 0,
        .ids = &ids,
        .light = &lightbuf,
        .names = @constCast(&names),
    };
    // y: 6,5 air; 4,3,2,1 water; 0 stone.
    for (1..5) |y| ids[g.index(0, y, 0)] = 1;
    ids[g.index(0, 0, 0)] = 2;

    const occluder = [_]bool{ false, false, true }; // only stone occludes
    const attenuate = [_]bool{ false, true, false }; // water dims the column
    const emission = [_]u8{ 0, 0, 0 };
    try compute(a, g, &occluder, &emission, &attenuate);

    const skyOf = struct {
        fn f(gg: grid.Grid, y: usize) u8 {
            return gg.light[gg.index(0, y, 0)] >> 4;
        }
    }.f;
    try std.testing.expectEqual(@as(u8, 15), skyOf(g, 5)); // air, full sky
    try std.testing.expectEqual(@as(u8, 15), skyOf(g, 4)); // first (surface) water cell
    try std.testing.expectEqual(@as(u8, 14), skyOf(g, 3)); // one block down
    try std.testing.expectEqual(@as(u8, 13), skyOf(g, 2));
    try std.testing.expectEqual(@as(u8, 12), skyOf(g, 1)); // the seabed-facing cell is dimmer
}
