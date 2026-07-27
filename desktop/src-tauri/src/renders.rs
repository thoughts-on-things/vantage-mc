//! Bookkeeping for the generated render tree under `<local data>/Vantage/renders`.
//!
//! Every render carries a small JSON record next to its tiles. The record is
//! what lets the app reopen a cached map (the geometry settings it was baked
//! with), name it in the renders manager, and tell whether the source world has
//! been played since. Records written by older builds only contain the
//! settings, so every field added later stays optional.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const RECORD_FILE: &str = "desktop-render.json";
pub const MANIFEST_FILE: &str = "manifest.json";
pub const THUMBNAIL_FILE: &str = "thumbnail-v2.png";
/// Pre-versioned thumbnail name still cleaned up for existing caches.
pub const LEGACY_THUMBNAIL_FILE: &str = "thumbnail.png";

/// Depth cap for the recursive size walk. Render trees are two levels deep
/// (`tiles/<z>/<x>.vtl`); the cap only exists so a surprising directory can
/// never turn a listing into an unbounded traversal.
const MAX_SIZE_DEPTH: u32 = 6;

/// The geometry-affecting subset of settings baked into a render. A cached map
/// is only reopened when its signature matches the current settings.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheSignature {
    pub full_caves: bool,
    pub smooth_lighting: bool,
    pub biome_blend: bool,
    /// Whether the nether and the end were rendered alongside the overworld.
    /// Absent in records written before dimension support, which covered the
    /// overworld only — exactly what `false` means.
    #[serde(default)]
    pub all_dimensions: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRecord {
    #[serde(flatten)]
    pub signature: CacheSignature,
    /// Absent in records written before the renders manager existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub world_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub world_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rendered_at_ms: Option<i64>,
}

impl RenderRecord {
    pub fn new(signature: CacheSignature, world_path: &str, world_name: &str) -> Self {
        Self {
            signature,
            world_path: Some(world_path.to_string()),
            world_name: Some(world_name.to_string()),
            rendered_at_ms: Some(now_ms()),
        }
    }

    /// True for records written before renders carried their world identity.
    pub fn needs_naming(&self) -> bool {
        self.world_path.is_none()
    }

    /// Fills in the world identity of a legacy record, dating it from the
    /// render sitting next to it. Discovery knows which save a hashed
    /// directory belongs to, so old renders name themselves on first scan
    /// instead of staying anonymous forever.
    pub fn named(&self, world_path: &str, world_name: &str, rendered_at_ms: Option<i64>) -> Self {
        Self {
            signature: self.signature,
            world_path: Some(world_path.to_string()),
            world_name: Some(world_name.to_string()),
            rendered_at_ms: self.rendered_at_ms.or(rendered_at_ms),
        }
    }

    pub fn read(dir: &Path) -> Option<Self> {
        serde_json::from_slice(&fs::read(dir.join(RECORD_FILE)).ok()?).ok()
    }

    pub fn write(&self, dir: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| error.to_string())?;
        fs::write(dir.join(RECORD_FILE), bytes).map_err(|error| error.to_string())
    }
}

/// One cached render as the renders manager sees it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderEntry {
    /// Hashed directory name; the only handle the frontend may pass back.
    pub id: String,
    pub path: String,
    pub world_path: Option<String>,
    pub world_name: String,
    pub size_bytes: u64,
    pub file_count: u64,
    pub rendered_at_ms: i64,
    /// True when the record names a save that is no longer on disk.
    pub world_missing: bool,
    pub settings: Option<CacheSignature>,
    pub thumbnail_url: Option<String>,
}

/// Every render directory under `root`, newest first. Unreadable entries are
/// skipped rather than failing the whole listing — one corrupt directory should
/// never hide the rest of the library.
///
/// `thumbnail` receives each render's id and the path its preview image would
/// live at, and returns the URL the UI should load it from (or `None` when
/// there is no preview yet).
pub fn list(root: &Path, thumbnail: impl Fn(&str, &Path) -> Option<String>) -> Vec<RenderEntry> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut renders = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || !is_render_id(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let manifest = path.join(MANIFEST_FILE);
        if !manifest.is_file() {
            continue;
        }
        let record = RenderRecord::read(&path);
        let world_path = record.as_ref().and_then(|record| record.world_path.clone());
        let (size_bytes, file_count) = measure(&path);
        let id = entry.file_name().to_string_lossy().into_owned();
        renders.push(RenderEntry {
            world_name: record
                .as_ref()
                .and_then(|record| record.world_name.clone())
                .or_else(|| world_path.as_deref().and_then(save_name))
                .unwrap_or_else(|| "Unnamed render".to_string()),
            world_missing: world_path
                .as_deref()
                .is_some_and(|world| !Path::new(world).exists()),
            rendered_at_ms: record
                .as_ref()
                .and_then(|record| record.rendered_at_ms)
                .or_else(|| modified_ms(&manifest))
                .unwrap_or_default(),
            settings: record.as_ref().map(|record| record.signature),
            thumbnail_url: thumbnail(&id, &path.join(THUMBNAIL_FILE)),
            world_path,
            size_bytes,
            file_count,
            path: path.to_string_lossy().into_owned(),
            id,
        });
    }
    renders.sort_by_key(|entry| std::cmp::Reverse(entry.rendered_at_ms));
    renders
}

/// Resolves a frontend-supplied render id inside `root`. Ids are the hashed
/// directory names this app generates, so anything else is rejected before it
/// can reach the filesystem.
pub fn resolve(root: &Path, id: &str) -> Result<PathBuf, String> {
    let canonical = resolve_existing(root, id)?
        .ok_or_else(|| "That render is no longer on disk.".to_string())?;
    if !canonical.join(MANIFEST_FILE).is_file() {
        return Err("That render is no longer on disk.".into());
    }
    Ok(canonical)
}

/// Resolves an existing render directory without requiring a finished
/// manifest. Reset uses this form so deleting an interrupted render stays
/// idempotent while still refusing symlinks or junctions that leave `root`.
pub fn resolve_existing(root: &Path, id: &str) -> Result<Option<PathBuf>, String> {
    if !is_render_id(id) {
        return Err("Unknown render.".into());
    }
    canonical_existing_child(root, &root.join(id))
}

fn canonical_existing_child(root: &Path, candidate: &Path) -> Result<Option<PathBuf>, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "The renders directory is unavailable.".to_string())?;
    let canonical = match candidate.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    // A valid-looking id can still name a symlink or junction. Resolve it
    // before any caller opens or deletes the directory, then enforce the same
    // containment guarantee advertised by the UI.
    if canonical == canonical_root || !canonical.starts_with(&canonical_root) {
        return Err("That render is outside Vantage's renders directory.".into());
    }
    Ok(Some(canonical))
}

/// Total bytes and file count below `path`.
pub fn measure(path: &Path) -> (u64, u64) {
    fn walk(path: &Path, depth: u32, bytes: &mut u64, files: &mut u64) {
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if depth < MAX_SIZE_DEPTH {
                    walk(&entry.path(), depth + 1, bytes, files);
                }
            } else if kind.is_file() {
                if let Ok(meta) = entry.metadata() {
                    *bytes += meta.len();
                    *files += 1;
                }
            }
        }
    }
    let mut bytes = 0;
    let mut files = 0;
    walk(path, 0, &mut bytes, &mut files);
    (bytes, files)
}

pub fn modified_ms(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let millis = match modified.duration_since(UNIX_EPOCH) {
        Ok(since) => i64::try_from(since.as_millis()).ok()?,
        // Clocks before 1970 only show up on broken filesystems; treat the
        // render as ancient rather than dropping it from the listing.
        Err(_) => 0,
    };
    Some(millis)
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|since| i64::try_from(since.as_millis()).ok())
        .unwrap_or_default()
}

/// Stable per-world cache directory name: the FNV-1a hash of its path.
pub fn render_id(world_path: &str) -> String {
    format!("{:016x}", fnv1a(world_path.as_bytes()))
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}

/// Hashed directory names this app generates, and the only render handle any
/// other part of the app (or the frontend) is allowed to name.
pub fn is_render_id(name: &str) -> bool {
    name.len() == 16 && name.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn save_name(world_path: &str) -> Option<String> {
    Path::new(world_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "vantage-{label}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn records_written_before_the_renders_manager_still_parse() {
        let dir = scratch("legacy-record");
        fs::write(
            dir.join(RECORD_FILE),
            br#"{"fullCaves":true,"smoothLighting":false,"biomeBlend":true}"#,
        )
        .unwrap();

        let record = RenderRecord::read(&dir).expect("legacy record parses");
        assert_eq!(
            record.signature,
            CacheSignature {
                full_caves: true,
                smooth_lighting: false,
                biome_blend: true,
                all_dimensions: false,
            }
        );
        assert!(record.world_path.is_none());
        assert!(record.rendered_at_ms.is_none());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn legacy_records_take_their_world_identity_from_discovery() {
        let legacy = RenderRecord {
            signature: CacheSignature {
                full_caves: true,
                smooth_lighting: false,
                biome_blend: true,
                all_dimensions: false,
            },
            world_path: None,
            world_name: None,
            rendered_at_ms: None,
        };
        assert!(legacy.needs_naming());

        let named = legacy.named("C:\\saves\\Luna", "Luna", Some(1_700_000_000_000));
        assert!(!named.needs_naming());
        assert_eq!(named.signature, legacy.signature);
        assert_eq!(named.world_name.as_deref(), Some("Luna"));
        assert_eq!(named.rendered_at_ms, Some(1_700_000_000_000));

        // A record that already knows when it was baked keeps that date.
        let dated = RenderRecord::new(legacy.signature, "C:\\saves\\Luna", "Luna");
        let renamed = dated.named("C:\\saves\\Luna", "Luna", Some(1));
        assert_eq!(renamed.rendered_at_ms, dated.rendered_at_ms);
    }

    #[test]
    fn round_trip_keeps_the_signature_at_the_top_level() {
        let dir = scratch("record-round-trip");
        let signature = CacheSignature {
            full_caves: false,
            smooth_lighting: true,
            biome_blend: false,
            all_dimensions: true,
        };
        RenderRecord::new(signature, "C:\\saves\\World", "World")
            .write(&dir)
            .unwrap();

        let text = fs::read_to_string(dir.join(RECORD_FILE)).unwrap();
        assert!(text.contains("\"smoothLighting\": true"), "{text}");
        let record = RenderRecord::read(&dir).unwrap();
        assert_eq!(record.signature, signature);
        assert_eq!(record.world_name.as_deref(), Some("World"));
        assert!(record.rendered_at_ms.unwrap() > 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn listing_skips_directories_without_a_manifest() {
        let root = scratch("render-listing");
        let ready = root.join(render_id("C:\\saves\\Ready"));
        let partial = root.join(render_id("C:\\saves\\Partial"));
        fs::create_dir_all(ready.join("tiles")).unwrap();
        fs::create_dir_all(&partial).unwrap();
        fs::write(ready.join(MANIFEST_FILE), b"{}").unwrap();
        fs::write(ready.join("tiles").join("0.vtl"), vec![7_u8; 512]).unwrap();
        fs::write(partial.join("scratch.tmp"), b"partial").unwrap();
        RenderRecord::new(
            CacheSignature {
                full_caves: true,
                smooth_lighting: true,
                biome_blend: true,
                all_dimensions: true,
            },
            "C:\\saves\\Ready",
            "Ready",
        )
        .write(&ready)
        .unwrap();

        let record_bytes = fs::metadata(ready.join(RECORD_FILE)).unwrap().len();
        let listed = list(&root, |id, thumbnail| {
            thumbnail.is_file().then(|| format!("/library/{id}"))
        });
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].world_name, "Ready");
        // manifest + nested tile + the record itself, counted through one
        // subdirectory level.
        assert_eq!(listed[0].size_bytes, 2 + 512 + record_bytes);
        assert_eq!(listed[0].file_count, 3);
        assert!(listed[0].world_missing, "the save path does not exist");
        // No preview has been captured, so no URL is offered for one.
        assert_eq!(listed[0].thumbnail_url, None);

        fs::write(ready.join(THUMBNAIL_FILE), b"\x89PNG\r\n\x1a\n").unwrap();
        let listed = list(&root, |id, thumbnail| {
            thumbnail.is_file().then(|| format!("/library/{id}"))
        });
        assert_eq!(
            listed[0].thumbnail_url.as_deref(),
            Some(format!("/library/{}", render_id("C:\\saves\\Ready")).as_str())
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn only_generated_render_ids_resolve() {
        let root = scratch("render-resolve");
        let id = render_id("C:\\saves\\World");
        fs::create_dir_all(root.join(&id)).unwrap();
        fs::write(root.join(&id).join(MANIFEST_FILE), b"{}").unwrap();

        assert_eq!(
            resolve(&root, &id).unwrap(),
            root.join(&id).canonicalize().unwrap()
        );
        assert!(resolve(&root, "../secrets").is_err());
        assert!(resolve(&root, "not-hex-at-all!").is_err());
        assert!(resolve(&root, &render_id("C:\\saves\\Other")).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn unfinished_and_missing_render_paths_resolve_safely() {
        let parent = scratch("render-boundary");
        let root = parent.join("renders");
        let outside = parent.join("outside");
        let id = render_id("C:\\saves\\Partial");
        fs::create_dir_all(root.join(&id)).unwrap();
        fs::create_dir_all(&outside).unwrap();

        assert_eq!(
            resolve_existing(&root, &id).unwrap(),
            Some(root.join(&id).canonicalize().unwrap())
        );
        assert_eq!(
            resolve_existing(&root, &render_id("C:\\saves\\Absent")).unwrap(),
            None
        );
        assert!(canonical_existing_child(&root, &outside).is_err());

        fs::remove_dir_all(&parent).unwrap();
    }
}
