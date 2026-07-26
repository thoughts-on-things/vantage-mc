//! Loopback-only static file endpoint for the currently selected render.
//!
//! The GPU viewer streams tiles over plain HTTP. Binding an ephemeral port on
//! 127.0.0.1 keeps the WebView CSP simple while the server only ever exposes
//! one canonicalized render directory at a time.
//!
//! Panning a large world asks for hundreds of tiles, so the connection is kept
//! alive across requests and every response carries a validator. The WebView
//! cache can then revalidate with `If-None-Match` and get an empty 304 instead
//! of another full read off disk.

use serde::Serialize;
use std::{
    fs::{File, Metadata},
    io::{self, BufReader, BufWriter, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    sync::{Arc, RwLock},
    thread,
    time::{Duration, UNIX_EPOCH},
};

/// Request headers larger than this are a client bug, not a tile fetch.
const MAX_HEADER_BYTES: usize = 16 * 1024;
/// How long an idle keep-alive connection is held open. The viewer fetches in
/// bursts while the camera moves; anything longer just parks threads.
const KEEP_ALIVE: Duration = Duration::from_secs(30);
/// Cap on requests served by one connection before it is recycled.
const MAX_KEEP_ALIVE_REQUESTS: u32 = 512;

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

struct Request {
    method: String,
    target: String,
    if_none_match: Option<String>,
    keep_alive: bool,
}

fn serve(stream: TcpStream, root: Arc<RwLock<Option<PathBuf>>>) {
    let _ = stream.set_read_timeout(Some(KEEP_ALIVE));
    let _ = stream.set_nodelay(true);
    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut writer = BufWriter::new(write_half);

    for _ in 0..MAX_KEEP_ALIVE_REQUESTS {
        let Some(request) = read_request(&mut reader) else {
            return;
        };
        let head = request.method == "HEAD";
        let response = if request.method != "GET" && !head {
            respond_text(&mut writer, 405, "method not allowed", head, &request)
        } else {
            respond_file(&mut writer, &request, &root, head)
        };
        if response.is_err() || writer.flush().is_err() || !request.keep_alive {
            return;
        }
    }
}

/// Reads one complete request head. Returns `None` when the peer closed the
/// connection, timed out, or sent something that is not a request.
fn read_request(reader: &mut BufReader<TcpStream>) -> Option<Request> {
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        // A bare LF-terminated blank line ends the head too; browsers never
        // send one, but a stray probe should not hang the thread.
        if head.len() >= 4 && head.ends_with(b"\n\n") {
            break;
        }
        if head.len() >= MAX_HEADER_BYTES {
            return None;
        }
        match reader.read(&mut byte) {
            Ok(0) | Err(_) => return None,
            Ok(_) => head.push(byte[0]),
        }
    }
    let text = String::from_utf8_lossy(&head);
    let mut lines = text.lines();
    let mut start = lines.next()?.split_whitespace();
    let method = start.next()?.to_string();
    let target = start.next().unwrap_or("/").to_string();
    let version = start.next().unwrap_or("HTTP/1.1").to_string();

    let mut if_none_match = None;
    let mut keep_alive = version != "HTTP/1.0";
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "if-none-match" => if_none_match = Some(value.to_string()),
            "connection" => {
                let value = value.to_ascii_lowercase();
                keep_alive = value.contains("keep-alive") || !value.contains("close");
            }
            _ => {}
        }
    }
    Some(Request {
        method,
        target,
        if_none_match,
        keep_alive,
    })
}

fn respond_file(
    writer: &mut impl Write,
    request: &Request,
    root: &Arc<RwLock<Option<PathBuf>>>,
    head: bool,
) -> io::Result<()> {
    let Some(relative) = safe_relative_path(&request.target) else {
        return respond_text(writer, 400, "invalid path", head, request);
    };
    let Some(base) = root.read().ok().and_then(|guard| guard.clone()) else {
        return respond_text(writer, 404, "no render selected", head, request);
    };
    let Ok(canonical) = base.join(relative).canonicalize() else {
        return respond_text(writer, 404, "not found", head, request);
    };
    if !canonical.starts_with(&base) || !canonical.is_file() {
        return respond_text(writer, 404, "not found", head, request);
    }
    let Ok(mut file) = File::open(&canonical) else {
        return respond_text(writer, 500, "read failed", head, request);
    };
    let Ok(meta) = file.metadata() else {
        return respond_text(writer, 500, "read failed", head, request);
    };

    let etag = entity_tag(&meta);
    if request
        .if_none_match
        .as_deref()
        .is_some_and(|candidate| etag_matches(candidate, &etag))
    {
        write_header(writer, 304, mime(&canonical), 0, Some(&etag), request)?;
        return Ok(());
    }
    // Stream straight from disk; tiles can be multiple MiB and buffering whole
    // files per request would churn memory while the viewer fans out fetches.
    write_header(
        writer,
        200,
        mime(&canonical),
        meta.len(),
        Some(&etag),
        request,
    )?;
    if !head {
        io::copy(&mut file, writer)?;
    }
    Ok(())
}

fn respond_text(
    writer: &mut impl Write,
    status: u16,
    body: &str,
    head: bool,
    request: &Request,
) -> io::Result<()> {
    write_header(
        writer,
        status,
        "text/plain",
        body.len() as u64,
        None,
        request,
    )?;
    if !head {
        writer.write_all(body.as_bytes())?;
    }
    Ok(())
}

fn write_header(
    writer: &mut impl Write,
    status: u16,
    mime: &str,
    length: u64,
    etag: Option<&str>,
    request: &Request,
) -> io::Result<()> {
    let text = match status {
        200 => "OK",
        304 => "Not Modified",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Internal Server Error",
    };
    let connection = if request.keep_alive {
        "keep-alive"
    } else {
        "close"
    };
    write!(writer, "HTTP/1.1 {status} {text}\r\n")?;
    write!(writer, "Content-Type: {mime}\r\n")?;
    // 304 carries no body, and `Content-Length: 0` on it would be a lie about
    // the selected representation.
    if status != 304 {
        write!(writer, "Content-Length: {length}\r\n")?;
    }
    if let Some(etag) = etag {
        // Renders are rewritten in place, so freshness is always revalidated;
        // the validator is what makes that revalidation free.
        write!(writer, "ETag: {etag}\r\nCache-Control: no-cache\r\n")?;
    } else {
        write!(writer, "Cache-Control: no-store\r\n")?;
    }
    write!(writer, "Access-Control-Allow-Origin: *\r\n")?;
    write!(writer, "Connection: {connection}\r\n\r\n")
}

/// Percent-decodes a request target and rejects anything that could escape the
/// selected render directory.
fn safe_relative_path(target: &str) -> Option<PathBuf> {
    let path = target.split(['?', '#']).next().unwrap_or("/");
    let decoded = percent_encoding::percent_decode_str(path.trim_start_matches('/'))
        .decode_utf8()
        .ok()?;
    // Backslashes and drive letters only mean something on Windows, but they
    // are rejected everywhere so the endpoint behaves identically per platform.
    if decoded.contains('\\') || decoded.contains(':') {
        return None;
    }
    let relative = PathBuf::from(decoded.as_ref());
    if relative.as_os_str().is_empty() {
        return None;
    }
    relative
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
        .then_some(relative)
}

/// A weak-free validator built from the file's size and modification time —
/// enough to notice a re-render, cheap enough to compute per request.
fn entity_tag(meta: &Metadata) -> String {
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|since| since.as_nanos())
        .unwrap_or_default();
    format!("\"{:x}-{:x}\"", meta.len(), modified)
}

/// `If-None-Match` may carry a list, and caches are allowed to weaken a tag.
fn etag_matches(header: &str, etag: &str) -> bool {
    header.split(',').any(|candidate| {
        let candidate = candidate.trim();
        candidate == "*"
            || candidate == etag
            || candidate
                .strip_prefix("W/")
                .is_some_and(|weak| weak == etag)
    })
}

fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
    {
        "json" => "application/json",
        "png" => "image/png",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;

    struct Response {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Response {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        }
    }

    /// Reads exactly one response, honouring Content-Length so the connection
    /// stays usable for the next request.
    fn read_response(reader: &mut BufReader<TcpStream>) -> Response {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let status = line.split_whitespace().nth(1).unwrap().parse().unwrap();
        let mut headers = Vec::new();
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).unwrap();
            let header = header.trim_end().to_string();
            if header.is_empty() {
                break;
            }
            let (name, value) = header.split_once(':').unwrap();
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
        let length: usize = headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map(|(_, value)| value.parse().unwrap())
            .unwrap_or(0);
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        Response {
            status,
            headers,
            body,
        }
    }

    fn request(stream: &mut TcpStream, target: &str, if_none_match: Option<&str>) {
        write!(stream, "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n").unwrap();
        if let Some(etag) = if_none_match {
            write!(stream, "If-None-Match: {etag}\r\n").unwrap();
        }
        write!(stream, "\r\n").unwrap();
        stream.flush().unwrap();
    }

    /// The whole request path: one connection, several tiles, and a
    /// conditional refetch that costs nothing but a header.
    #[test]
    fn one_connection_serves_many_files_and_revalidates() {
        let root = std::env::temp_dir().join(format!(
            "vantage-endpoint-{}-{}",
            std::process::id(),
            crate::renders::now_ms()
        ));
        std::fs::create_dir_all(root.join("tiles")).unwrap();
        std::fs::write(root.join("manifest.json"), br#"{"version":6}"#).unwrap();
        std::fs::write(root.join("tiles").join("0.vtl"), vec![9_u8; 4096]).unwrap();

        let server = AssetServer::start().unwrap();
        let ready = server.open(root.clone()).unwrap();
        let port: u16 = ready
            .manifest_url
            .rsplit_once(':')
            .and_then(|(_, tail)| tail.split('/').next())
            .unwrap()
            .parse()
            .unwrap();

        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());

        request(&mut stream, "/manifest.json", None);
        let manifest = read_response(&mut reader);
        assert_eq!(manifest.status, 200);
        assert_eq!(manifest.body, br#"{"version":6}"#);
        assert_eq!(manifest.header("Connection"), Some("keep-alive"));
        let etag = manifest.header("ETag").unwrap().to_string();

        request(&mut stream, "/manifest.json", Some(&etag));
        let revalidated = read_response(&mut reader);
        assert_eq!(revalidated.status, 304);
        assert!(revalidated.body.is_empty());

        // Same socket, third request: a real tile body.
        request(&mut stream, "/tiles/0.vtl", None);
        let tile = read_response(&mut reader);
        assert_eq!(tile.status, 200);
        assert_eq!(tile.body.len(), 4096);
        assert_eq!(
            tile.header("Content-Type"),
            Some("application/octet-stream")
        );

        request(&mut stream, "/tiles/../../escape", None);
        assert_eq!(read_response(&mut reader).status, 400);

        request(&mut stream, "/tiles/missing.vtl", None);
        assert_eq!(read_response(&mut reader).status, 404);

        std::fs::remove_dir_all(&root).unwrap();
    }

    fn get(target: &str) -> Request {
        Request {
            method: "GET".into(),
            target: target.into(),
            if_none_match: None,
            keep_alive: true,
        }
    }

    #[test]
    fn traversal_and_absolute_targets_are_refused() {
        assert!(safe_relative_path("/../../secrets").is_none());
        assert!(safe_relative_path("/tiles/../../secrets").is_none());
        assert!(safe_relative_path("/%2e%2e/secrets").is_none());
        assert!(safe_relative_path("/C:/Windows/win.ini").is_none());
        assert!(safe_relative_path("/").is_none());
    }

    #[test]
    fn ordinary_tile_targets_decode() {
        assert_eq!(
            safe_relative_path("/tiles/0/3.vtl?rev=7").unwrap(),
            PathBuf::from("tiles/0/3.vtl")
        );
        assert_eq!(
            safe_relative_path("/my%20render/manifest.json").unwrap(),
            PathBuf::from("my render/manifest.json")
        );
    }

    #[test]
    fn entity_tags_change_when_a_tile_is_rebaked() {
        let path = std::env::temp_dir().join(format!("vantage-etag-{}", std::process::id()));
        std::fs::write(&path, b"first").unwrap();
        let first = entity_tag(&std::fs::metadata(&path).unwrap());
        // A rewrite with different content must produce a different validator
        // even when the clock has not visibly advanced.
        std::fs::write(&path, b"second tile payload").unwrap();
        let second = entity_tag(&std::fs::metadata(&path).unwrap());
        assert_ne!(first, second);
        assert!(first.starts_with('"') && first.ends_with('"'));
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn conditional_requests_accept_list_and_weak_forms() {
        assert!(etag_matches("\"5-a\"", "\"5-a\""));
        assert!(etag_matches("W/\"5-a\"", "\"5-a\""));
        assert!(etag_matches("\"other\", \"5-a\"", "\"5-a\""));
        assert!(etag_matches("*", "\"5-a\""));
        assert!(!etag_matches("\"5-b\"", "\"5-a\""));
    }

    #[test]
    fn responses_advertise_the_connection_they_will_keep() {
        let mut buffer = Vec::new();
        write_header(
            &mut buffer,
            200,
            "application/json",
            12,
            Some("\"a-b\""),
            &get("/x"),
        )
        .unwrap();
        let text = String::from_utf8(buffer).unwrap();
        assert!(text.contains("Connection: keep-alive"), "{text}");
        assert!(text.contains("ETag: \"a-b\""), "{text}");
        assert!(text.contains("Cache-Control: no-cache"), "{text}");
        assert!(text.contains("Content-Length: 12"), "{text}");

        let mut closing = Vec::new();
        let mut request = get("/x");
        request.keep_alive = false;
        write_header(
            &mut closing,
            304,
            "application/json",
            0,
            Some("\"a-b\""),
            &request,
        )
        .unwrap();
        let text = String::from_utf8(closing).unwrap();
        assert!(text.contains("Connection: close"), "{text}");
        assert!(
            !text.contains("Content-Length"),
            "304 carries no body: {text}"
        );
    }
}
