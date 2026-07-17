//! Loopback-only static file endpoint for the currently selected render.
//!
//! The GPU viewer streams tiles over plain HTTP. Binding an ephemeral port on
//! 127.0.0.1 keeps the WebView CSP simple while the server only ever exposes
//! one canonicalized render directory at a time.

use serde::Serialize;
use std::{
    fs::File,
    io::{self, BufWriter, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    sync::{Arc, RwLock},
    thread,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderReady {
    pub manifest_url: String,
    pub output_path: String,
}

#[derive(Clone)]
pub struct AssetServer {
    root: Arc<RwLock<Option<PathBuf>>>,
    port: u16,
}

impl AssetServer {
    pub fn start() -> Result<Self, String> {
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
                    let _ = thread::spawn(move || serve(stream, root));
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self { root, port })
    }

    /// Points the endpoint at a completed render and returns its manifest URL.
    pub fn open(&self, root: PathBuf) -> Result<RenderReady, String> {
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

fn serve(mut stream: TcpStream, root: Arc<RwLock<Option<PathBuf>>>) {
    let mut request = [0_u8; 8192];
    let Ok(read) = stream.read(&mut request) else {
        return;
    };
    let first = String::from_utf8_lossy(&request[..read]);
    let mut parts = first.lines().next().unwrap_or_default().split_whitespace();
    let method = parts.next().unwrap_or_default();
    let url = parts.next().unwrap_or("/").split('?').next().unwrap_or("/");
    let head = method == "HEAD";
    if method != "GET" && !head {
        return respond_text(&mut stream, 405, "method not allowed", head);
    }
    let decoded =
        percent_encoding::percent_decode_str(url.trim_start_matches('/')).decode_utf8_lossy();
    let relative = Path::new(decoded.as_ref());
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return respond_text(&mut stream, 400, "invalid path", head);
    }
    let Some(base) = root.read().ok().and_then(|guard| guard.clone()) else {
        return respond_text(&mut stream, 404, "no render selected", head);
    };
    let Ok(canonical) = base.join(relative).canonicalize() else {
        return respond_text(&mut stream, 404, "not found", head);
    };
    if !canonical.starts_with(&base) || !canonical.is_file() {
        return respond_text(&mut stream, 404, "not found", head);
    }
    // Stream straight from disk; tiles can be multiple MiB and buffering whole
    // files per request would churn memory while the viewer fans out fetches.
    let Ok(mut file) = File::open(&canonical) else {
        return respond_text(&mut stream, 500, "read failed", head);
    };
    let Ok(length) = file.metadata().map(|meta| meta.len()) else {
        return respond_text(&mut stream, 500, "read failed", head);
    };
    let mut writer = BufWriter::new(&mut stream);
    if write_header(&mut writer, 200, mime(&canonical), length).is_err() {
        return;
    }
    if !head {
        let _ = io::copy(&mut file, &mut writer);
    }
    let _ = writer.flush();
}

fn respond_text(stream: &mut TcpStream, status: u16, body: &str, head: bool) {
    let mut writer = BufWriter::new(&mut *stream);
    if write_header(&mut writer, status, "text/plain", body.len() as u64).is_err() {
        return;
    }
    if !head {
        let _ = writer.write_all(body.as_bytes());
    }
    let _ = writer.flush();
}

fn write_header(writer: &mut impl Write, status: u16, mime: &str, length: u64) -> io::Result<()> {
    let text = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Internal Server Error",
    };
    write!(
        writer,
        "HTTP/1.1 {status} {text}\r\nContent-Type: {mime}\r\nContent-Length: {length}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
    )
}

fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
    {
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}
