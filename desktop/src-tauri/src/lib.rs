mod assets;
mod hosts;
mod native;
mod renders;
mod sidecar;
mod window_state;

use assets::{AssetServer, RenderReady};
use hosts::{HostConnection, HostEntry, HostInput, HostProbe, HostStore};
use renders::{CacheSignature, RenderEntry, RenderRecord};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    thread,
};
use tauri::{
    window::{ProgressBarState, ProgressBarStatus},
    Emitter, Manager, WebviewWindow,
};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const MAIN_WINDOW: &str = "main";

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
    /// When the cached render was baked, so the library can flag worlds that
    /// have been played since.
    #[serde(default)]
    rendered_at_ms: Option<i64>,
    /// The geometry settings that render was baked with; `None` for renders
    /// from builds that predate the record.
    #[serde(default)]
    render_settings: Option<CacheSignature>,
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
    /// Render the nether and the end too. Default on: a save is all three
    /// dimensions, and skipping them is the exception.
    #[serde(default = "default_true")]
    all_dimensions: bool,
    #[serde(default)]
    thread_count: Option<usize>,
}

fn default_true() -> bool {
    true
}

impl From<&DesktopSettings> for CacheSignature {
    fn from(settings: &DesktopSettings) -> Self {
        Self {
            full_caves: settings.full_caves,
            smooth_lighting: settings.smooth_lighting,
            biome_blend: settings.biome_blend,
            all_dimensions: settings.all_dimensions,
        }
    }
}

/// Opening a cached render either succeeds or reports *why* it cannot be
/// reused. A stale cache is an ordinary outcome the library handles by
/// re-rendering; anything else is a real error worth showing.
///
/// `rename_all` on an enum renames the *variants*; the fields inside them need
/// `rename_all_fields`, without which the frontend reads `manifestUrl` off a
/// payload that spelled it `manifest_url`.
#[derive(Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "status"
)]
enum CacheOpen {
    Ready {
        manifest_url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        world_url: Option<String>,
        output_path: String,
    },
    Stale {
        reason: String,
    },
}

impl From<RenderReady> for CacheOpen {
    fn from(ready: RenderReady) -> Self {
        Self::Ready {
            manifest_url: ready.manifest_url,
            world_url: ready.world_url,
            output_path: ready.output_path,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedImage {
    path: String,
    name: String,
}

struct AppState {
    assets: AssetServer,
    hosts: HostStore,
    rendering: AtomicBool,
    cancel_requested: AtomicBool,
    render_child: Mutex<Option<CommandChild>>,
    window: window_state::Tracker,
}

/// Clears the render-in-progress flag and the taskbar progress bar even on
/// early returns and panics.
struct RenderGuard<'a> {
    rendering: &'a AtomicBool,
    window: Option<WebviewWindow>,
}

impl Drop for RenderGuard<'_> {
    fn drop(&mut self) {
        self.rendering.store(false, Ordering::Release);
        if let Some(window) = &self.window {
            set_taskbar_progress(window, ProgressBarStatus::None, None);
        }
    }
}

#[tauri::command]
async fn discover_worlds(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<WorldInfo>, String> {
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
        let render_id = renders::render_id(&world.path);
        let cache = renders_root(&app)?.join(&render_id);
        let manifest = cache.join(renders::MANIFEST_FILE);
        world.cached = manifest.is_file();
        world.icon_url = world
            .icon_path
            .as_deref()
            .and_then(|path| native::icon_data_url(Path::new(path)));
        let record = RenderRecord::read(&cache).map(|record| {
            if !world.cached || !record.needs_naming() {
                return record;
            }
            // Discovery is the only place that knows which save a hashed
            // render directory came from; teach the old record its name once.
            let named = record.named(
                &world.path,
                &world_label(&world.name, &world.path),
                renders::modified_ms(&manifest),
            );
            let _ = named.write(&cache);
            named
        });
        world.rendered_at_ms = record
            .as_ref()
            .and_then(|record| record.rendered_at_ms)
            .or_else(|| renders::modified_ms(&manifest));
        world.render_settings = record.map(|record| record.signature);
        // Previews are streamed from the loopback endpoint rather than
        // base64'd into this response: a library of rendered worlds would
        // otherwise push megabytes across the IPC bridge on every scan. The
        // preview's own timestamp versions the URL, so regenerating one
        // (which leaves the render untouched) still changes what loads.
        world.thumbnail_url =
            renders::modified_ms(&cache.join(renders::THUMBNAIL_FILE)).map(|version| {
                state
                    .assets
                    .library_image_url(&render_id, renders::THUMBNAIL_FILE, version)
            });
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
) -> Result<CacheOpen, String> {
    let output = cache_path(&app, &path)?;
    let Some(record) = RenderRecord::read(&output) else {
        return Ok(CacheOpen::Stale {
            reason: "This render was made by an older version of Vantage.".into(),
        });
    };
    if record.signature != CacheSignature::from(&settings) {
        return Ok(CacheOpen::Stale {
            reason: "The render settings changed since this map was built.".into(),
        });
    }
    state.assets.open(output).map(CacheOpen::from)
}

#[tauri::command]
async fn render_world(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
    name: String,
    settings: DesktopSettings,
) -> Result<RenderReady, String> {
    if state.rendering.swap(true, Ordering::AcqRel) {
        return Err("Another world is already rendering.".into());
    }
    let window = app.get_webview_window(MAIN_WINDOW);
    let _guard = RenderGuard {
        rendering: &state.rendering,
        window: window.clone(),
    };
    if let Some(window) = &window {
        set_taskbar_progress(window, ProgressBarStatus::Indeterminate, None);
    }
    state.cancel_requested.store(false, Ordering::Release);
    let output = cache_path(&app, &path)?;
    fs::create_dir_all(&output).map_err(|error| error.to_string())?;
    // A partially overwritten progressive manifest must never look like a
    // completed cached render after a failure or cancellation.
    let _ = fs::remove_file(output.join(renders::RECORD_FILE));
    let _ = fs::remove_file(output.join(renders::THUMBNAIL_FILE));
    let _ = fs::remove_file(output.join(renders::LEGACY_THUMBNAIL_FILE));

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

    // The taskbar bar is redrawn by the shell on every change; only whole
    // percent steps are worth the round trip.
    let taskbar_percent = AtomicU64::new(u64::MAX);
    let emit_progress = |core: sidecar::CoreProgress| {
        if let Some(window) = &window {
            let percent = tile_percent(&core);
            if taskbar_percent.swap(percent, Ordering::Relaxed) != percent {
                set_taskbar_progress(window, ProgressBarStatus::Normal, Some(percent));
            }
        }
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
    RenderRecord::new(
        CacheSignature::from(&settings),
        &path,
        &world_label(&name, &path),
    )
    .write(&output)?;
    state.assets.open(output)
}

/// Taskbar percentage for a progress record. Only the tile phase has a real
/// denominator; the short phases around it hold the bar at its edges.
fn tile_percent(core: &sidecar::CoreProgress) -> u64 {
    match core.phase.as_str() {
        "tiles" if core.total > 0 => {
            ((core.completed.min(core.total) as f64 / core.total as f64) * 100.0).round() as u64
        }
        "lowres" | "finalizing" | "done" => 100,
        _ => 0,
    }
}

fn set_taskbar_progress(window: &WebviewWindow, status: ProgressBarStatus, progress: Option<u64>) {
    let _ = window.set_progress_bar(ProgressBarState {
        status: Some(status),
        progress,
    });
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
    // Every dimension the save has is the default; the setting narrows it.
    if !settings.all_dimensions {
        args.extend(["--dimension".to_string(), "overworld".to_string()]);
    }
    if let Some(threads) = settings.thread_count.filter(|threads| *threads > 0) {
        args.extend(["--threads".to_string(), threads.to_string()]);
    }
    args
}

/// Worlds are named in `level.dat`, which may disagree with the folder — and
/// may be blank. The folder name is the readable fallback.
fn world_label(name: &str, world_path: &str) -> String {
    let trimmed = name.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    Path::new(world_path)
        .file_name()
        .map(|folder| folder.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Unnamed world".to_string())
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
    let bytes = native::decode_thumbnail_data_url(&data_url)?;
    let output = cache_path(&app, &path)?;
    fs::create_dir_all(&output).map_err(|error| error.to_string())?;
    let thumbnail = output.join(renders::THUMBNAIL_FILE);
    let temporary = output.join("thumbnail.tmp");
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(&thumbnail);
    fs::rename(temporary, thumbnail).map_err(|error| error.to_string())
}

#[tauri::command]
fn reset_world_thumbnail(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let output = cache_path(&app, &path)?;
    remove_if_present(&output.join(renders::THUMBNAIL_FILE))?;
    remove_if_present(&output.join(renders::LEGACY_THUMBNAIL_FILE))
}

#[tauri::command]
fn reset_world_render(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let root = renders_root(&app)?;
    let id = renders::render_id(&path);
    let Some(output) = renders::resolve_existing(&root, &id)? else {
        return Ok(());
    };
    remove_render(&state, &output)
}

/// Every cached render on this PC, newest first.
#[tauri::command]
fn list_renders(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RenderEntry>, String> {
    Ok(renders::list(&renders_root(&app)?, |id, thumbnail| {
        let version = renders::modified_ms(thumbnail)?;
        Some(
            state
                .assets
                .library_image_url(id, renders::THUMBNAIL_FILE, version),
        )
    }))
}

#[tauri::command]
fn delete_render(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let target = renders::resolve(&renders_root(&app)?, &id)?;
    remove_render(&state, &target)
}

/// Opens a render straight from the renders manager. Renders whose save has
/// been deleted are still viewable this way.
#[tauri::command]
fn open_render(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<RenderReady, String> {
    let target = renders::resolve(&renders_root(&app)?, &id)?;
    state.assets.open(target)
}

/// The saved `vantage server` connections. Access tokens stay in this process:
/// an entry only reports *whether* one is remembered.
#[tauri::command]
fn list_hosts(state: tauri::State<'_, AppState>) -> Result<Vec<HostEntry>, String> {
    state.hosts.list()
}

#[tauri::command]
fn save_host(state: tauri::State<'_, AppState>, input: HostInput) -> Result<HostEntry, String> {
    state.hosts.save(input)
}

#[tauri::command]
fn delete_host(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    state.hosts.delete(&id)
}

/// Asks an address what it is, before it is saved — the connect form's "test"
/// button. The token is offered for this one exchange and not retained.
#[tauri::command]
async fn probe_host(
    state: tauri::State<'_, AppState>,
    endpoint: String,
    token: Option<String>,
) -> Result<HostProbe, String> {
    state.hosts.probe(&endpoint, token.as_deref()).await
}

/// Confirms a saved connection can still read its world, and returns the
/// manifest URL the viewer streams from.
#[tauri::command]
async fn connect_host(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<HostConnection, String> {
    state.hosts.connect(&id).await
}

/// One protocol artifact for an open connection. The viewer calls this for the
/// manifest, the texture array, and every tile; the reply is the framed
/// `[length][header][body]` document `hosts::frame` writes.
#[tauri::command]
async fn host_fetch(
    state: tauri::State<'_, AppState>,
    id: String,
    url: String,
    if_none_match: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let framed = state
        .hosts
        .fetch(&id, &url, if_none_match.as_deref())
        .await?;
    Ok(tauri::ipc::Response::new(framed))
}

/// Shows a world save, a generated render, or an exported image in the OS file
/// manager. Anything else is refused: this is the one command that hands a
/// frontend-supplied path to the shell.
#[tauri::command]
fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err("That folder is no longer on disk.".into());
    }
    let owned = [renders_root(&app), exports_dir(&app)];
    let inside_owned = target.canonicalize().is_ok_and(|target| {
        owned.iter().flatten().any(|root| {
            root.canonicalize()
                .is_ok_and(|root| target.starts_with(root))
        })
    });
    if !inside_owned && !target.join("level.dat").is_file() {
        return Err("Vantage only opens world saves and its own renders.".into());
    }
    native::reveal(&target)
}

/// Writes a full-resolution viewer capture into the pictures library.
#[tauri::command]
fn save_map_image(
    app: tauri::AppHandle,
    name: String,
    data_url: String,
) -> Result<SavedImage, String> {
    let bytes = native::decode_image_data_url(&data_url)?;
    let written = native::write_unique_png(&exports_dir(&app)?, &name, &bytes)?;
    Ok(SavedImage {
        name: written
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: written.to_string_lossy().into_owned(),
    })
}

fn remove_render(state: &tauri::State<'_, AppState>, path: &Path) -> Result<(), String> {
    if state.rendering.load(Ordering::Acquire) {
        return Err("Wait for the active render to finish before deleting a render.".into());
    }
    remove_render_dir(path)
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

/// Where exported map images land: `<pictures>/Vantage`, falling back through
/// the documents and local-data folders on systems without a pictures library.
fn exports_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .picture_dir()
        .or_else(|_| app.path().document_dir())
        .or_else(|_| app.path().local_data_dir())
        .map_err(|error| error.to_string())?
        .join("Vantage"))
}

/// `<local data>/Vantage`, everything this app keeps on disk.
fn vantage_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .local_data_dir()
        .map_err(|error| error.to_string())?
        .join("Vantage"))
}

/// `<local data>/Vantage/renders`, the only directory this app generates into.
fn renders_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(vantage_root(app)?.join("renders"))
}

/// Stable per-world cache directory: `<local data>/Vantage/renders/<fnv1a>`.
fn cache_path(app: &tauri::AppHandle, world_path: &str) -> Result<PathBuf, String> {
    Ok(renders_root(app)?.join(renders::render_id(world_path)))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // The renders directory backs the library's preview images, so it
            // is created up front: the endpoint canonicalizes that root once
            // and a path that does not exist yet could never be resolved.
            let library = renders_root(app.handle()).ok().inspect(|root| {
                let _ = fs::create_dir_all(root);
            });
            app.manage(AppState {
                assets: AssetServer::start(library).map_err(std::io::Error::other)?,
                hosts: HostStore::load(&vantage_root(app.handle()).map_err(std::io::Error::other)?),
                rendering: AtomicBool::new(false),
                cancel_requested: AtomicBool::new(false),
                render_child: Mutex::new(None),
                window: window_state::Tracker::default(),
            });
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                app.state::<AppState>().window.restore(&window);
            }
            // Windows start hidden so a remembered box is applied before the
            // first frame; showing every window (not just the main one) keeps
            // the app visible even if that label ever changes.
            for (_, window) in app.webview_windows() {
                let _ = window.show();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let state = window.state::<AppState>();
            match event {
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    if let Some(webview) = window.get_webview_window(MAIN_WINDOW) {
                        state.window.observe(&webview);
                    }
                }
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                    if let Some(webview) = window.get_webview_window(MAIN_WINDOW) {
                        state.window.persist(&webview);
                    }
                    if let Ok(mut slot) = state.render_child.lock() {
                        if let Some(child) = slot.take() {
                            let _ = child.kill();
                        }
                    }
                }
                _ => {}
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
            reset_world_render,
            list_renders,
            delete_render,
            open_render,
            list_hosts,
            save_host,
            delete_host,
            probe_host,
            connect_host,
            host_fetch,
            reveal_path,
            save_map_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vantage");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_cache_removal_is_idempotent() {
        let root = std::env::temp_dir().join(format!(
            "vantage-render-reset-{}-{}",
            std::process::id(),
            renders::now_ms()
        ));
        let thumbnail = root.join(renders::THUMBNAIL_FILE);
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
            all_dimensions: true,
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

    /// The frontend reads these keys by name; a rename that silently stops
    /// applying leaves the viewer with an undefined manifest URL and no way to
    /// notice until a cached world is opened.
    #[test]
    fn cache_open_serializes_the_keys_the_frontend_reads() {
        let ready = serde_json::to_value(CacheOpen::from(RenderReady {
            manifest_url: "http://127.0.0.1:8000/manifest.json".into(),
            world_url: Some("http://127.0.0.1:8000/world.json".into()),
            output_path: "C:\\renders\\abc".into(),
        }))
        .unwrap();
        assert_eq!(ready["status"], "ready");
        assert_eq!(ready["manifestUrl"], "http://127.0.0.1:8000/manifest.json");
        assert_eq!(ready["worldUrl"], "http://127.0.0.1:8000/world.json");
        assert_eq!(ready["outputPath"], "C:\\renders\\abc");
        assert!(ready.get("manifest_url").is_none(), "{ready}");

        // A render without dimensions omits the key entirely, so the frontend's
        // `worldUrl ?? manifestUrl` falls back instead of fetching "undefined".
        let single = serde_json::to_value(CacheOpen::from(RenderReady {
            manifest_url: "http://127.0.0.1:8000/manifest.json".into(),
            world_url: None,
            output_path: "C:\\renders\\abc".into(),
        }))
        .unwrap();
        assert!(single.get("worldUrl").is_none(), "{single}");

        let stale = serde_json::to_value(CacheOpen::Stale {
            reason: "settings changed".into(),
        })
        .unwrap();
        assert_eq!(stale["status"], "stale");
        assert_eq!(stale["reason"], "settings changed");
    }

    #[test]
    fn world_labels_fall_back_to_the_save_folder() {
        // Forward slashes separate on every OS; the backslash form only
        // parses as a path on Windows, so it is asserted there alone.
        assert_eq!(world_label("Green Valley", "/saves/green"), "Green Valley");
        assert_eq!(world_label("   ", "/saves/Copper Hills"), "Copper Hills");
        assert_eq!(world_label("", "/saves/Copper Hills"), "Copper Hills");
        #[cfg(windows)]
        assert_eq!(world_label("", "C:\\saves\\Copper Hills"), "Copper Hills");
    }

    #[test]
    fn taskbar_percent_tracks_the_tile_phase() {
        let progress = |phase: &str, completed: usize, total: usize| sidecar::CoreProgress {
            phase: phase.to_string(),
            completed,
            total,
        };
        assert_eq!(tile_percent(&progress("scanning", 0, 0)), 0);
        assert_eq!(tile_percent(&progress("tiles", 0, 0)), 0);
        assert_eq!(tile_percent(&progress("tiles", 33, 132)), 25);
        // A sidecar that overshoots its own estimate must not exceed the bar.
        assert_eq!(tile_percent(&progress("tiles", 140, 132)), 100);
        assert_eq!(tile_percent(&progress("finalizing", 0, 0)), 100);
    }
}
