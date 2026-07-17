mod assets;
mod sidecar;

use assets::{AssetServer, RenderReady};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const THUMBNAIL_FILE: &str = "thumbnail-v2.png";
/// Pre-versioned thumbnail name still cleaned up for existing caches.
const LEGACY_THUMBNAIL_FILE: &str = "thumbnail.png";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorldInfo {
    path: String,
    name: String,
    last_played_ms: i64,
    data_version: i32,
    source: String,
    icon_path: Option<String>,
    #[serde(default)]
    icon_url: Option<String>,
    #[serde(default)]
    thumbnail_url: Option<String>,
    #[serde(default)]
    cached: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderProgress {
    phase: String,
    completed: usize,
    total: usize,
    world_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    full_caves: bool,
    smooth_lighting: bool,
    biome_blend: bool,
    #[serde(default)]
    thread_count: Option<usize>,
}

/// The geometry-affecting subset of settings baked into a render. A cached
/// map is only reopened when its signature matches the current settings.
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CacheSignature {
    full_caves: bool,
    smooth_lighting: bool,
    biome_blend: bool,
}

impl From<&DesktopSettings> for CacheSignature {
    fn from(settings: &DesktopSettings) -> Self {
        Self {
            full_caves: settings.full_caves,
            smooth_lighting: settings.smooth_lighting,
            biome_blend: settings.biome_blend,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemProfile {
    logical_cores: usize,
    architecture: &'static str,
    platform: &'static str,
}

struct AppState {
    assets: AssetServer,
    rendering: AtomicBool,
    cancel_requested: AtomicBool,
    render_child: Mutex<Option<CommandChild>>,
}

/// Clears the render-in-progress flag even on early returns and panics.
struct RenderGuard<'a>(&'a AtomicBool);
impl Drop for RenderGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[tauri::command]
async fn discover_worlds(app: tauri::AppHandle) -> Result<Vec<WorldInfo>, String> {
    let output = app
        .shell()
        .sidecar("vantage-core")
        .map_err(|error| error.to_string())?
        .args(["desktop-discover"])
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    let mut worlds = Vec::new();
    for line in String::from_utf8_lossy(&output.stderr).lines() {
        let Some(json) = line.strip_prefix(sidecar::WORLD_PREFIX) else {
            continue;
        };
        let mut world: WorldInfo = serde_json::from_str(json).map_err(|error| error.to_string())?;
        let cache = cache_path(&app, &world.path)?;
        world.cached = cache.join("manifest.json").is_file();
        world.icon_url = world
            .icon_path
            .as_deref()
            .and_then(|path| image_data_url(Path::new(path)));
        world.thumbnail_url = image_data_url(&cache.join(THUMBNAIL_FILE));
        worlds.push(world);
    }
    Ok(worlds)
}

#[tauri::command]
async fn open_cached_world(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
    settings: DesktopSettings,
) -> Result<RenderReady, String> {
    let output = cache_path(&app, &path)?;
    let signature_path = output.join("desktop-render.json");
    let signature: CacheSignature = serde_json::from_slice(
        &fs::read(&signature_path)
            .map_err(|_| "This render uses older settings and needs a one-time refresh.")?,
    )
    .map_err(|_| "This render uses older settings and needs a one-time refresh.")?;
    if signature != CacheSignature::from(&settings) {
        return Err("The render settings changed; refreshing this world.".into());
    }
    state.assets.open(output)
}

#[tauri::command]
async fn render_world(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
    settings: DesktopSettings,
) -> Result<RenderReady, String> {
    if state.rendering.swap(true, Ordering::AcqRel) {
        return Err("Another world is already rendering.".into());
    }
    let _guard = RenderGuard(&state.rendering);
    state.cancel_requested.store(false, Ordering::Release);
    let output = cache_path(&app, &path)?;
    fs::create_dir_all(&output).map_err(|error| error.to_string())?;
    let signature_path = output.join("desktop-render.json");
    // A partially overwritten progressive manifest must never look like a
    // completed cached render after a failure or cancellation.
    let _ = fs::remove_file(&signature_path);
    let _ = fs::remove_file(output.join(THUMBNAIL_FILE));
    let _ = fs::remove_file(output.join(LEGACY_THUMBNAIL_FILE));

    let (mut events, child) = app
        .shell()
        .sidecar("vantage-core")
        .map_err(|error| error.to_string())?
        .args(render_args(&path, &output, &settings))
        .spawn()
        .map_err(|error| error.to_string())?;
    *state
        .render_child
        .lock()
        .map_err(|_| "render process lock poisoned")? = Some(child);

    let emit_progress = |core: sidecar::CoreProgress| {
        let _ = app.emit(
            "render-progress",
            RenderProgress {
                phase: core.phase,
                completed: core.completed,
                total: core.total,
                world_path: path.clone(),
            },
        );
    };
    let mut stderr = Vec::new();
    let mut protocol_buffer = String::new();
    let mut exit_code = None;
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stderr(bytes) => {
                stderr.extend_from_slice(&bytes);
                protocol_buffer.push_str(&String::from_utf8_lossy(&bytes));
                sidecar::drain_progress(&mut protocol_buffer, emit_progress);
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            _ => {}
        }
    }
    let _ = state.render_child.lock().map(|mut child| child.take());
    sidecar::drain_progress(&mut protocol_buffer, emit_progress);

    if state.cancel_requested.swap(false, Ordering::AcqRel) {
        let _ = app.emit(
            "render-progress",
            RenderProgress {
                phase: "failed".into(),
                completed: 0,
                total: 0,
                world_path: path,
            },
        );
        return Err("Render cancelled.".into());
    }
    if exit_code != Some(0) {
        let message = String::from_utf8_lossy(&stderr);
        return Err(message
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("Zig render failed")
            .to_string());
    }
    let signature = serde_json::to_vec_pretty(&CacheSignature::from(&settings))
        .map_err(|error| error.to_string())?;
    fs::write(signature_path, signature).map_err(|error| error.to_string())?;
    state.assets.open(output)
}

fn render_args(world: &str, output: &Path, settings: &DesktopSettings) -> Vec<String> {
    let mut args = vec![
        "desktop-render".to_string(),
        world.to_string(),
        output.to_string_lossy().into_owned(),
        "--caves".to_string(),
        if settings.full_caves { "full" } else { "55" }.to_string(),
        "--light".to_string(),
        if settings.smooth_lighting {
            "smooth"
        } else {
            "flat"
        }
        .to_string(),
        "--biome-blend".to_string(),
        if settings.biome_blend { "on" } else { "off" }.to_string(),
    ];
    if let Some(threads) = settings.thread_count.filter(|threads| *threads > 0) {
        args.extend(["--threads".to_string(), threads.to_string()]);
    }
    args
}

#[tauri::command]
fn cancel_render(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.cancel_requested.store(true, Ordering::Release);
    let mut slot = state
        .render_child
        .lock()
        .map_err(|_| "render process lock poisoned")?;
    if let Some(child) = slot.take() {
        child.kill().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn system_profile() -> SystemProfile {
    SystemProfile {
        logical_cores: thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(4),
        architecture: std::env::consts::ARCH,
        platform: std::env::consts::OS,
    }
}

#[tauri::command]
fn save_world_thumbnail(
    app: tauri::AppHandle,
    path: String,
    data_url: String,
) -> Result<(), String> {
    let bytes = decode_thumbnail_data_url(&data_url)?;
    let output = cache_path(&app, &path)?;
    fs::create_dir_all(&output).map_err(|error| error.to_string())?;
    let thumbnail = output.join(THUMBNAIL_FILE);
    let temporary = output.join("thumbnail.tmp");
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&thumbnail);
    fs::rename(temporary, thumbnail).map_err(|error| error.to_string())
}

#[tauri::command]
fn reset_world_thumbnail(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let output = cache_path(&app, &path)?;
    remove_if_present(&output.join(THUMBNAIL_FILE))?;
    remove_if_present(&output.join(LEGACY_THUMBNAIL_FILE))
}

#[tauri::command]
fn reset_world_render(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    if state.rendering.load(Ordering::Acquire) {
        return Err("Wait for the active render to finish before resetting a cache.".into());
    }
    let output = cache_path(&app, &path)?;
    remove_render_dir(&output)
}

fn remove_render_dir(path: &Path) -> Result<(), String> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn decode_thumbnail_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    const PREFIX: &str = "data:image/png;base64,";
    const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    let encoded = data_url
        .strip_prefix(PREFIX)
        .ok_or("Thumbnail must be a PNG data URL")?;
    let bytes = BASE64.decode(encoded).map_err(|error| error.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("Thumbnail is too large".into());
    }
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err("Thumbnail data is not a PNG".into());
    }
    Ok(bytes)
}

/// Stable per-world cache directory: `<local data>/Vantage/renders/<fnv1a>`.
fn cache_path(app: &tauri::AppHandle, world_path: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .local_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(base
        .join("Vantage")
        .join("renders")
        .join(format!("{:016x}", fnv1a(world_path.as_bytes()))))
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}

fn image_data_url(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    if bytes.len() > 2 * 1024 * 1024 {
        return None;
    }
    Some(format!("data:image/png;base64,{}", BASE64.encode(bytes)))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            app.manage(AppState {
                assets: AssetServer::start().map_err(std::io::Error::other)?,
                rendering: AtomicBool::new(false),
                cancel_requested: AtomicBool::new(false),
                render_child: Mutex::new(None),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                if let Ok(mut slot) = window.state::<AppState>().render_child.lock() {
                    if let Some(child) = slot.take() {
                        let _ = child.kill();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            discover_worlds,
            open_cached_world,
            render_world,
            cancel_render,
            system_profile,
            save_world_thumbnail,
            reset_world_thumbnail,
            reset_world_render
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vantage");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumbnail_data_url_requires_a_real_png() {
        let png = b"\x89PNG\r\n\x1a\nthumbnail";
        let valid = format!("data:image/png;base64,{}", BASE64.encode(png));
        assert_eq!(decode_thumbnail_data_url(&valid).unwrap(), png);
        assert!(decode_thumbnail_data_url("data:image/jpeg;base64,AAAA").is_err());
        assert!(decode_thumbnail_data_url("data:image/png;base64,bm90IGEgcG5n").is_err());
    }

    #[test]
    fn render_cache_removal_is_idempotent() {
        let root = std::env::temp_dir().join(format!(
            "vantage-render-reset-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let thumbnail = root.join(THUMBNAIL_FILE);
        fs::create_dir_all(&root).unwrap();
        fs::write(&thumbnail, b"preview").unwrap();

        remove_if_present(&thumbnail).unwrap();
        remove_if_present(&thumbnail).unwrap();
        remove_render_dir(&root).unwrap();
        remove_render_dir(&root).unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn render_args_reflect_settings() {
        let settings = DesktopSettings {
            full_caves: false,
            smooth_lighting: true,
            biome_blend: false,
            thread_count: Some(6),
        };
        let args = render_args("C:\\saves\\World", Path::new("C:\\out"), &settings);
        assert_eq!(
            args,
            [
                "desktop-render",
                "C:\\saves\\World",
                "C:\\out",
                "--caves",
                "55",
                "--light",
                "smooth",
                "--biome-blend",
                "off",
                "--threads",
                "6"
            ]
        );
    }
}
