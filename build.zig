const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "vantage",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            // We link the system zlib via C interop for chunk decompression.
            // This validates an architectural pillar early: vendor the fastest
            // C decompressors rather than depend on the churning std.compress.
            .link_libc = true,
        }),
    });
    exe.root_module.linkSystemLibrary("z", .{});
    // Vendored stb_image (PNG decode) — C interop, the path DESIGN endorses over
    // a churning std image decoder. PNG-only, decode-from-memory (see the impl TU).
    exe.root_module.addIncludePath(b.path("vendor/stb"));
    exe.root_module.addCSourceFile(.{
        .file = b.path("vendor/stb/stb_image_impl.c"),
        .flags = &.{"-std=c99"},
    });
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_cmd.addArgs(args);
    const run_step = b.step("run", "Run the world-parsing spike");
    run_step.dependOn(&run_cmd.step);

    const exe_tests = b.addTest(.{ .root_module = exe.root_module });
    const run_exe_tests = b.addRunArtifact(exe_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_exe_tests.step);
}
