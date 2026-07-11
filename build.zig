const std = @import("std");
const manifest = @import("build.zig.zon");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Single source of truth for `vantage --version`.
    const options = b.addOptions();
    options.addOption([]const u8, "version", manifest.version);

    const exe = b.addExecutable(.{
        .name = "vantage",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            // C interop for the vendored decompressor + image decoder: vendor
            // the fastest C libraries rather than depend on system libs (absent
            // on Windows) or the churning std.compress. No system dependencies
            // ⇒ one static binary per OS.
            .link_libc = true,
        }),
    });
    exe.root_module.addOptions("build_options", options);
    // Vendored libdeflate (chunk/level.dat decompression): whole-buffer zlib +
    // gzip decode, ~2-3× faster than system zlib. Decompression-only subset.
    exe.root_module.addIncludePath(b.path("vendor/libdeflate"));
    exe.root_module.addCSourceFiles(.{
        .files = &.{
            "vendor/libdeflate/lib/adler32.c",
            "vendor/libdeflate/lib/crc32.c",
            "vendor/libdeflate/lib/deflate_compress.c",
            "vendor/libdeflate/lib/deflate_decompress.c",
            "vendor/libdeflate/lib/gzip_compress.c",
            "vendor/libdeflate/lib/gzip_decompress.c",
            "vendor/libdeflate/lib/utils.c",
            "vendor/libdeflate/lib/zlib_decompress.c",
            "vendor/libdeflate/lib/arm/cpu_features.c",
            "vendor/libdeflate/lib/x86/cpu_features.c",
        },
        // Zig 0.16's Clang can expose AVX-512 intrinsics without carrying the
        // new evex512 feature through libdeflate's per-function target
        // attributes. Disable only those optional dispatch variants; the
        // portable, SSE2, PCLMUL, and AVX2 paths remain available.
        .flags = &.{
            "-std=c99",
            "-DLIBDEFLATE_ASSEMBLER_DOES_NOT_SUPPORT_AVX512VNNI",
            "-DLIBDEFLATE_ASSEMBLER_DOES_NOT_SUPPORT_VPCLMULQDQ",
        },
    });
    // Vendored stb_image (PNG decode) — C interop. PNG-only, decode-from-memory
    // (see the impl TU).
    exe.root_module.addIncludePath(b.path("vendor/stb"));
    exe.root_module.addCSourceFile(.{
        .file = b.path("vendor/stb/stb_image_impl.c"),
        .flags = &.{"-std=c99"},
    });
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_cmd.addArgs(args);
    const run_step = b.step("run", "Run the vantage CLI");
    run_step.dependOn(&run_cmd.step);

    const exe_tests = b.addTest(.{ .root_module = exe.root_module });
    const run_exe_tests = b.addRunArtifact(exe_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_exe_tests.step);
}
