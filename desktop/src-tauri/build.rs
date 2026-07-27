use std::{env, fs, path::PathBuf, process::Command};

/// The Zig `-Dtarget` for a Cargo target triple. The sidecar always targets an
/// explicit triple so a cross-arch bundle (an x86_64 macOS build on an arm64
/// runner) ships the matching binary. The ABIs are explicit too: gnu on
/// Windows (self-contained, no MSVC needed — what CLI release binaries have
/// always shipped) and musl on Linux so one static sidecar runs on any
/// distro's libc.
fn zig_target(cargo_target: &str) -> String {
    let arch = cargo_target.split('-').next().expect("target architecture");
    let os = if cargo_target.contains("windows") {
        "windows-gnu"
    } else if cargo_target.contains("apple-darwin") {
        "macos"
    } else if cargo_target.contains("linux") {
        "linux-musl"
    } else {
        panic!("unsupported desktop target: {cargo_target}")
    };
    format!("{arch}-{os}")
}

fn main() {
    println!("cargo:rerun-if-changed=../../src");
    println!("cargo:rerun-if-changed=../../build.zig");
    println!("cargo:rerun-if-changed=../../build.zig.zon");

    let target = env::var("TARGET").expect("Cargo target triple");
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir")).join("../..");
    let status = Command::new("zig")
        .args([
            "build",
            "-Doptimize=ReleaseFast",
            &format!("-Dtarget={}", zig_target(&target)),
        ])
        .current_dir(&root)
        .status()
        .expect("Zig 0.16 must be installed to build the Vantage core sidecar");
    assert!(status.success(), "Zig core build failed");

    let extension = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let source = root.join("zig-out/bin").join(format!("vantage{extension}"));
    let binaries = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("binaries");
    fs::create_dir_all(&binaries).expect("create Tauri binaries directory");
    let destination = binaries.join(format!("vantage-core-{target}{extension}"));
    let changed = fs::read(&destination).ok().as_deref() != fs::read(&source).ok().as_deref();
    if changed {
        fs::copy(source, destination).expect("copy Zig core into the Tauri sidecar bundle");
    }

    tauri_build::build();
}
