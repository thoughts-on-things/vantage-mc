//! Small OS integrations: PNG payloads from the WebView, exported map images,
//! and revealing a folder in the platform file manager.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const PNG_PREFIX: &str = "data:image/png;base64,";
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
/// Thumbnails are 480×320; exported map images are the full canvas, which at
/// 4K with a high pixel ratio still lands far below this ceiling.
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES: usize = 4 * 1024 * 1024;
/// Minecraft writes a 64×64 `icon.png`; anything far past that is not one.
const MAX_ICON_BYTES: usize = 512 * 1024;
/// Enough to disambiguate exports taken in the same second.
const MAX_NAME_ATTEMPTS: u32 = 64;

pub fn decode_thumbnail_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    decode_png_data_url(data_url, MAX_THUMBNAIL_BYTES)
}

pub fn decode_image_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    decode_png_data_url(data_url, MAX_IMAGE_BYTES)
}

fn decode_png_data_url(data_url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let encoded = data_url
        .strip_prefix(PNG_PREFIX)
        .ok_or("Image must be a PNG data URL")?;
    let bytes = BASE64.decode(encoded).map_err(|error| error.to_string())?;
    if bytes.len() > limit {
        return Err("Image is too large".into());
    }
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err("Image data is not a PNG".into());
    }
    Ok(bytes)
}

/// Reads a world's `icon.png` back as a data URL. Icons are 64×64 and live in
/// the save folder rather than anywhere Vantage owns, so they are the one
/// image still inlined into the library payload — the cap keeps a
/// hand-edited icon from bloating it.
pub fn icon_data_url(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    if bytes.len() > MAX_ICON_BYTES {
        return None;
    }
    Some(format!("{PNG_PREFIX}{}", BASE64.encode(bytes)))
}

/// Writes `bytes` into `directory` as `<stem>.png`, never overwriting an
/// existing export. Returns the path actually written.
pub fn write_unique_png(directory: &Path, stem: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let stem = safe_file_stem(stem);
    for attempt in 0..MAX_NAME_ATTEMPTS {
        let name = if attempt == 0 {
            format!("{stem}.png")
        } else {
            format!("{stem}-{}.png", attempt + 1)
        };
        let candidate = directory.join(name);
        if candidate.exists() {
            continue;
        }
        fs::write(&candidate, bytes).map_err(|error| error.to_string())?;
        return Ok(candidate);
    }
    Err("Too many exports with that name already exist.".into())
}

/// Collapses anything a world name may contain into a portable file stem.
/// Minecraft allows spaces, emoji, and path separators in world names, and the
/// stem is joined onto a directory we own.
pub fn safe_file_stem(raw: &str) -> String {
    let mut stem = String::new();
    let mut pending_dash = false;
    for character in raw.chars() {
        if character.is_ascii_alphanumeric() {
            if pending_dash && !stem.is_empty() {
                stem.push('-');
            }
            pending_dash = false;
            stem.push(character.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
        if stem.len() >= 60 {
            break;
        }
    }
    if stem.is_empty() {
        "vantage-map".to_string()
    } else {
        stem
    }
}

/// Opens `path` in the platform file manager, selecting it when it is a file.
/// Only paths that already exist are ever handed to the OS.
pub fn reveal(path: &Path) -> Result<(), String> {
    let canonical = path
        .canonicalize()
        .map_err(|_| "That folder is no longer on disk.".to_string())?;
    let is_file = canonical.is_file();
    open_in_file_manager(&strip_verbatim(&canonical), is_file)
}

#[cfg(target_os = "windows")]
fn open_in_file_manager(target: &Path, is_file: bool) -> Result<(), String> {
    // `explorer` reports a non-zero exit code even when it opens the window,
    // so it is spawned and its status deliberately ignored.
    let mut command = Command::new("explorer");
    if is_file {
        command.arg(format!("/select,{}", target.display()));
    } else {
        command.arg(target);
    }
    spawn_silently(command)
}

#[cfg(target_os = "macos")]
fn open_in_file_manager(target: &Path, is_file: bool) -> Result<(), String> {
    let mut command = Command::new("open");
    if is_file {
        command.arg("-R");
    }
    command.arg(target);
    spawn_silently(command)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_in_file_manager(target: &Path, is_file: bool) -> Result<(), String> {
    let folder = match target.parent() {
        Some(parent) if is_file => parent,
        _ => target,
    };
    let mut command = Command::new("xdg-open");
    command.arg(folder);
    spawn_silently(command)
}

/// Starts a helper process without letting it borrow the studio's UI: no
/// inherited stdio, and on Windows no console window. Vantage ships as a GUI
/// binary, so a console-subsystem child would otherwise be able to flash a
/// terminal over the app.
fn spawn_silently(mut command: Command) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// `canonicalize` returns `\\?\C:\…` on Windows, which Explorer refuses to
/// open. Everything else passes through untouched.
fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(plain) if !plain.starts_with("UNC\\") => PathBuf::from(plain),
        _ => path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_data_urls_are_validated_before_they_reach_the_disk() {
        let png = b"\x89PNG\r\n\x1a\nthumbnail";
        let valid = format!("{PNG_PREFIX}{}", BASE64.encode(png));
        assert_eq!(decode_thumbnail_data_url(&valid).unwrap(), png);
        assert!(decode_thumbnail_data_url("data:image/jpeg;base64,AAAA").is_err());
        assert!(decode_thumbnail_data_url("data:image/png;base64,bm90IGEgcG5n").is_err());
        assert!(decode_image_data_url(&valid).is_ok());
    }

    #[test]
    fn oversized_payloads_are_rejected_per_kind() {
        let mut png = PNG_SIGNATURE.to_vec();
        png.resize(MAX_THUMBNAIL_BYTES + 1, 0);
        let data_url = format!("{PNG_PREFIX}{}", BASE64.encode(&png));
        assert!(decode_thumbnail_data_url(&data_url).is_err());
        assert!(
            decode_image_data_url(&data_url).is_ok(),
            "map exports are larger"
        );
    }

    #[test]
    fn world_names_become_portable_file_stems() {
        assert_eq!(safe_file_stem("Green Valley"), "green-valley");
        assert_eq!(safe_file_stem("../../etc/passwd"), "etc-passwd");
        assert_eq!(safe_file_stem("  ✨  "), "vantage-map");
        assert_eq!(
            safe_file_stem("New World 2026-07-25"),
            "new-world-2026-07-25"
        );
        assert!(safe_file_stem(&"long".repeat(40)).len() <= 60);
    }

    #[test]
    fn exports_never_overwrite_an_earlier_image() {
        let directory = std::env::temp_dir().join(format!(
            "vantage-export-{}-{}",
            std::process::id(),
            crate::renders::now_ms()
        ));
        let png = b"\x89PNG\r\n\x1a\nmap".to_vec();

        let first = write_unique_png(&directory, "Green Valley", &png).unwrap();
        let second = write_unique_png(&directory, "Green Valley", &png).unwrap();
        assert_eq!(first.file_name().unwrap(), "green-valley.png");
        assert_eq!(second.file_name().unwrap(), "green-valley-2.png");
        assert_eq!(fs::read(&first).unwrap(), png);
        fs::remove_dir_all(&directory).unwrap();
    }
}
