use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
    thread,
};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoreProgress {
    phase: String,
    completed: usize,
    total: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderReady {
    manifest_url: String,
    output_path: String,
}

struct AppState {
    assets: AssetServer,
    rendering: AtomicBool,
    render_child: Mutex<Option<CommandChild>>,
}

struct RenderGuard<'a>(&'a AtomicBool);
impl Drop for RenderGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Clone)]
struct AssetServer {
    root: Arc<RwLock<Option<PathBuf>>>,
    port: u16,
}

impl AssetServer {
    fn start() -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let root = Arc::new(RwLock::new(None));
        let server_root = Arc::clone(&root);
        thread::Builder::new()
            .name("vantage-assets".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let root = Arc::clone(&server_root);
                    let _ = thread::spawn(move || serve_asset(stream, root));
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self { root, port })
    }

    fn open(&self, root: PathBuf) -> Result<RenderReady, String> {
        let canonical = root.canonicalize().map_err(|error| error.to_string())?;
        if !canonical.join("manifest.json").is_file() {
            return Err("The render has no manifest.json".into());
        }
        *self
            .root
            .write()
            .map_err(|_| "asset server lock poisoned")? = Some(canonical.clone());
        Ok(RenderReady {
            manifest_url: format!("http://127.0.0.1:{}/manifest.json", self.port),
            output_path: canonical.to_string_lossy().into_owned(),
        })
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
        let Some(json) = line.strip_prefix("VANTAGE_WORLD ") else {
            continue;
        };
        let mut world: WorldInfo = serde_json::from_str(json).map_err(|error| error.to_string())?;
        let cache = cache_path(&app, &world.path)?;
        world.cached = cache.join("manifest.json").is_file();
        world.icon_url = world.icon_path.as_deref().and_then(icon_data_url);
        worlds.push(world);
    }
    Ok(worlds)
}

#[tauri::command]
async fn open_cached_world(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<RenderReady, String> {
    state.assets.open(cache_path(&app, &path)?)
}

#[tauri::command]
async fn render_world(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<RenderReady, String> {
    if state.rendering.swap(true, Ordering::AcqRel) {
        return Err("Another world is already rendering.".into());
    }
    let _guard = RenderGuard(&state.rendering);
    let output = cache_path(&app, &path)?;
    fs::create_dir_all(&output).map_err(|error| error.to_string())?;

    let (mut events, child) = app
        .shell()
        .sidecar("vantage-core")
        .map_err(|error| error.to_string())?
        .args(["desktop-render", &path, &output.to_string_lossy()])
        .spawn()
        .map_err(|error| error.to_string())?;
    *state
        .render_child
        .lock()
        .map_err(|_| "render process lock poisoned")? = Some(child);

    let mut stderr = Vec::new();
    let mut protocol_buffer = String::new();
    let mut exit_code = None;
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stderr(bytes) => {
                stderr.extend_from_slice(&bytes);
                protocol_buffer.push_str(&String::from_utf8_lossy(&bytes));
                drain_progress(&app, &path, &mut protocol_buffer);
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            _ => {}
        }
    }
    let _ = state.render_child.lock().map(|mut child| child.take());
    drain_progress(&app, &path, &mut protocol_buffer);
    if exit_code != Some(0) {
        let message = String::from_utf8_lossy(&stderr);
        return Err(message
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("Zig render failed")
            .to_string());
    }
    state.assets.open(output)
}

fn drain_progress(app: &tauri::AppHandle, world_path: &str, buffer: &mut String) {
    while let Some(newline) = buffer.find('\n') {
        let line = buffer[..newline].trim_end_matches('\r').to_string();
        buffer.drain(..=newline);
        let Some(json) = line.strip_prefix("VANTAGE_PROGRESS ") else {
            continue;
        };
        if let Ok(core) = serde_json::from_str::<CoreProgress>(json) {
            let _ = app.emit(
                "render-progress",
                RenderProgress {
                    phase: core.phase,
                    completed: core.completed,
                    total: core.total,
                    world_path: world_path.to_string(),
                },
            );
        }
    }
}

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

fn icon_data_url(path: &str) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    if bytes.len() > 2 * 1024 * 1024 {
        return None;
    }
    Some(format!("data:image/png;base64,{}", BASE64.encode(bytes)))
}

fn serve_asset(mut stream: TcpStream, root: Arc<RwLock<Option<PathBuf>>>) {
    let mut request = [0_u8; 8192];
    let Ok(read) = stream.read(&mut request) else {
        return;
    };
    let first = String::from_utf8_lossy(&request[..read]);
    let mut parts = first.lines().next().unwrap_or_default().split_whitespace();
    let method = parts.next().unwrap_or_default();
    let url = parts.next().unwrap_or("/").split('?').next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        return respond(
            &mut stream,
            405,
            "text/plain",
            b"method not allowed",
            method == "HEAD",
        );
    }
    let decoded = percent_decode_str(url.trim_start_matches('/')).decode_utf8_lossy();
    let relative = Path::new(decoded.as_ref());
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return respond(
            &mut stream,
            400,
            "text/plain",
            b"invalid path",
            method == "HEAD",
        );
    }
    let Some(base) = root.read().ok().and_then(|guard| guard.clone()) else {
        return respond(
            &mut stream,
            404,
            "text/plain",
            b"no render selected",
            method == "HEAD",
        );
    };
    let path = base.join(relative);
    let Ok(canonical) = path.canonicalize() else {
        return respond(
            &mut stream,
            404,
            "text/plain",
            b"not found",
            method == "HEAD",
        );
    };
    if !canonical.starts_with(&base) || !canonical.is_file() {
        return respond(
            &mut stream,
            404,
            "text/plain",
            b"not found",
            method == "HEAD",
        );
    }
    let Ok(bytes) = fs::read(&canonical) else {
        return respond(
            &mut stream,
            500,
            "text/plain",
            b"read failed",
            method == "HEAD",
        );
    };
    respond(&mut stream, 200, mime(&canonical), &bytes, method == "HEAD");
}

fn respond(stream: &mut TcpStream, status: u16, mime: &str, body: &[u8], head: bool) {
    let text = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Internal Server Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {text}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    if !head {
        let _ = stream.write_all(body);
    }
}

fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
    {
        "json" => "application/json",
        "vtile" | "vtexarr" | "vlr" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            app.manage(AppState {
                assets: AssetServer::start().map_err(std::io::Error::other)?,
                rendering: AtomicBool::new(false),
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
            render_world
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vantage");
}
