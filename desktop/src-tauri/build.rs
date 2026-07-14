use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=../../src");
    println!("cargo:rerun-if-changed=../../build.zig");
    println!("cargo:rerun-if-changed=../../build.zig.zon");

    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir")).join("../..");
    let status = Command::new("zig")
        .args(["build", "-Doptimize=ReleaseFast"])
        .current_dir(&root)
        .status()
        .expect("Zig 0.16 must be installed to build the Vantage core sidecar");
    assert!(status.success(), "Zig core build failed");

    let target = env::var("TARGET").expect("Cargo target triple");
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
