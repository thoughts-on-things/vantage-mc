//! Saved connections to a `vantage server`, and the transport a remote world
//! streams through.
//!
//! Remote bytes are fetched by this process rather than by the WebView. The
//! window's CSP only admits IPC and loopback, so page script could not reach a
//! remote origin even if we wanted it to — and more importantly, the bearer
//! credential a server operator hands a player never has to cross into the
//! page. The frontend names a connection by id, and gets bytes back.
//!
//! Everything here is read-only: protocol v1 is a GET-only data plane, and this
//! client issues nothing else.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

/// Connections file, beside `renders/` under the app's local data directory.
pub const STORE_FILE: &str = "hosts.json";

/// Long enough for a sidecar that has to bake a cold tile before it can answer,
/// short enough that a black-holed connection does not park a request forever.
const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
/// Probes only ever read two tiny JSON documents.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A protocol artifact is a manifest, an atlas, or one tile. Nothing legitimate
/// is close to this, and the cap is what keeps a hostile endpoint from trading
/// one request for all of this process's memory.
const MAX_BODY_BYTES: u64 = 64 * 1024 * 1024;
/// Discovery and world-list documents are a few hundred bytes.
const MAX_PROBE_BYTES: u64 = 256 * 1024;
/// How much a body read will reserve up front on a server's say-so. Ordinary
/// tiles land inside this, so the common fetch still costs one allocation.
const READ_RESERVE: u64 = 8 * 1024 * 1024;

/// One saved connection, as it lives on disk. The token is the only field the
/// frontend never sees.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRecord {
    pub id: String,
    pub label: String,
    /// Normalized: scheme, authority, optional path prefix, always one
    /// trailing slash, never any userinfo, query, or fragment.
    pub endpoint: String,
    pub world_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub added_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_connected_ms: Option<i64>,
}

impl HostRecord {
    /// `<endpoint>v1/worlds/<id>/` — the only prefix this connection may read.
    fn world_prefix(&self) -> String {
        format!("{}v1/worlds/{}/", self.endpoint, self.world_id)
    }

    fn manifest_url(&self) -> String {
        format!("{}manifest.json", self.world_prefix())
    }
}

/// The connection as the frontend sees it: everything but the secret.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEntry {
    pub id: String,
    pub label: String,
    pub endpoint: String,
    pub world_id: String,
    /// Whether a token is remembered for this connection. The value never
    /// leaves this process.
    pub has_token: bool,
    pub added_at_ms: i64,
    pub last_connected_ms: Option<i64>,
}

impl From<&HostRecord> for HostEntry {
    fn from(record: &HostRecord) -> Self {
        Self {
            id: record.id.clone(),
            label: record.label.clone(),
            endpoint: record.endpoint.clone(),
            world_id: record.world_id.clone(),
            has_token: record.token.is_some(),
            added_at_ms: record.added_at_ms,
            last_connected_ms: record.last_connected_ms,
        }
    }
}

/// What the add/edit form sends. `id` names an existing connection to update.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub label: String,
    pub endpoint: String,
    #[serde(default)]
    pub world_id: Option<String>,
    /// A new token. `None` on an edit leaves the stored one alone, which is how
    /// the form can offer "keep the saved token" without ever displaying it.
    #[serde(default)]
    pub token: Option<String>,
    /// Drop the stored token instead of keeping it.
    #[serde(default)]
    pub forget_token: bool,
}

/// What a probe of an endpoint found. Every field is best-effort: a host proxy
/// may expose the world artifacts without the discovery document.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProbe {
    /// Normalized endpoint, so the form can show what will actually be saved.
    pub endpoint: String,
    /// Protocol version from `.well-known/vantage`, when it answered.
    pub protocol: Option<u32>,
    /// `bearer` or `proxy`, when discovery answered.
    pub auth: Option<String>,
    /// World ids the credential can read.
    pub worlds: Vec<String>,
    /// True when the endpoint answered but refused the credential offered.
    pub unauthorized: bool,
    /// A human-readable note when something answered oddly but not fatally.
    pub note: Option<String>,
}

/// A connection opened for the viewer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConnection {
    pub id: String,
    pub label: String,
    pub manifest_url: String,
    /// Shown in the viewer chrome; never includes a credential.
    pub origin: String,
}

pub struct HostStore {
    path: PathBuf,
    records: Mutex<Vec<HostRecord>>,
    /// The hardened client, or why there isn't one. A store that cannot build
    /// one still loads — the saved list is readable without a network — and
    /// every fetch reports the failure instead.
    client: Result<reqwest::Client, String>,
}

impl HostStore {
    /// `root` is `<local data>/Vantage`. A store that cannot read its file
    /// starts empty rather than failing the app launch.
    pub fn load(root: &Path) -> Self {
        let path = root.join(STORE_FILE);
        Self {
            records: Mutex::new(read_store(&path)),
            path,
            client: build_client(),
        }
    }

    pub fn list(&self) -> Result<Vec<HostEntry>, String> {
        Ok(self.read()?.iter().map(HostEntry::from).collect())
    }

    fn read(&self) -> Result<std::sync::MutexGuard<'_, Vec<HostRecord>>, String> {
        self.records
            .lock()
            .map_err(|_| "The saved connections are unavailable.".to_string())
    }

    /// Adds or updates a connection and persists the list.
    pub fn save(&self, input: HostInput) -> Result<HostEntry, String> {
        let endpoint = normalize_endpoint(&input.endpoint)?;
        let world_id = match input.world_id.as_deref() {
            None | Some("") => "default".to_string(),
            Some(id) if is_world_id(id) => id.to_string(),
            Some(_) => return Err("That world id is not a valid protocol world id.".into()),
        };
        let label = pick_label(&input.label, &endpoint);
        let token = input.token.filter(|token| !token.is_empty());

        let entry = {
            let mut records = self.read()?;
            match input.id {
                Some(id) => {
                    let record = records
                        .iter_mut()
                        .find(|record| record.id == id)
                        .ok_or("That connection is no longer saved.")?;
                    // An operator grants a bearer to *their* server. Carrying a
                    // remembered one across an address edit would hand it to
                    // whoever now answers — a typo, or a hostile address the
                    // player was talked into pasting — without anything on
                    // screen saying so. Same origin keeps it; anywhere else
                    // has to be given its own.
                    let moved = credential_scope(&record.endpoint) != credential_scope(&endpoint);
                    record.label = label;
                    record.endpoint = endpoint;
                    record.world_id = world_id;
                    // A blank token box means "leave it as it is"; forgetting
                    // is a separate, deliberate act.
                    if input.forget_token || (moved && token.is_none()) {
                        record.token = None;
                    } else if token.is_some() {
                        record.token = token;
                    }
                    HostEntry::from(&*record)
                }
                None => {
                    let record = HostRecord {
                        id: new_id(),
                        label,
                        endpoint,
                        world_id,
                        token: if input.forget_token { None } else { token },
                        added_at_ms: crate::renders::now_ms(),
                        last_connected_ms: None,
                    };
                    let entry = HostEntry::from(&record);
                    records.push(record);
                    entry
                }
            }
        };
        self.persist()?;
        Ok(entry)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.read()?.retain(|record| record.id != id);
        self.persist()
    }

    fn find(&self, id: &str) -> Result<HostRecord, String> {
        self.read()?
            .iter()
            .find(|record| record.id == id)
            .cloned()
            .ok_or_else(|| "That connection is no longer saved.".into())
    }

    /// Opens a saved connection for the viewer, after confirming the world is
    /// actually readable with the stored credential.
    pub async fn connect(&self, id: &str) -> Result<HostConnection, String> {
        let record = self.find(id)?;
        let manifest_url = record.manifest_url();
        let response = self
            .request(&manifest_url, record.token.as_deref(), None, PROBE_TIMEOUT)
            .await?;
        let status = response.status().as_u16();
        if status == 401 || status == 403 {
            return Err(match record.token {
                Some(_) => "This server refused the saved access token.".into(),
                None => "This server needs an access token.".into(),
            });
        }
        if !(200..300).contains(&status) {
            return Err(format!(
                "The server answered {status} for this world's manifest."
            ));
        }

        let now = crate::renders::now_ms();
        if let Ok(mut records) = self.records.lock() {
            if let Some(record) = records.iter_mut().find(|record| record.id == id) {
                record.last_connected_ms = Some(now);
            }
        }
        // A failure to record the visit is not a reason to refuse the map.
        let _ = self.persist();

        Ok(HostConnection {
            id: record.id,
            label: record.label,
            origin: origin_of(&record.endpoint).unwrap_or_else(|| record.endpoint.clone()),
            manifest_url,
        })
    }

    /// Reads one protocol artifact for a connection. `url` is the absolute URL
    /// the viewer resolved from the manifest; it is confined to the
    /// connection's own world prefix here, before any credential is attached.
    ///
    /// Returns the framed response for *any* HTTP status — including 304 and
    /// 404, which the viewer handles — and an error only when the request
    /// never completed.
    pub async fn fetch(
        &self,
        id: &str,
        url: &str,
        if_none_match: Option<&str>,
    ) -> Result<Vec<u8>, String> {
        let record = self.find(id)?;
        let target = confine(url, &record.world_prefix())?;
        let response = self
            .request(
                &target,
                record.token.as_deref(),
                if_none_match,
                FETCH_TIMEOUT,
            )
            .await?;

        let status = response.status().as_u16();
        let etag = header(&response, "etag");
        let content_type = header(&response, "content-type");
        // A 304 carries no body by definition; reading one would only wait on a
        // server that sent something it should not have.
        let body = if status == 304 {
            Vec::new()
        } else {
            read_capped(response, MAX_BODY_BYTES).await?
        };
        Ok(frame(
            status,
            etag.as_deref(),
            content_type.as_deref(),
            &body,
        ))
    }

    /// Asks an endpoint what it is, before it is saved. Used by the connect
    /// form, so it takes a raw address and an optional token rather than an id.
    /// `id` names a saved connection whose remembered token should stand in
    /// when the form offers none — otherwise testing an existing connection
    /// would report "needs a token" about a credential it already has, since
    /// the box is deliberately blank. The stored one is only lent to an address
    /// in its own scope: a probe is a request like any other, and re-pointing
    /// the form at another host must not be a way to make it carry the token
    /// there.
    pub async fn probe(
        &self,
        endpoint: &str,
        id: Option<&str>,
        token: Option<&str>,
    ) -> Result<HostProbe, String> {
        let endpoint = normalize_endpoint(endpoint)?;
        let remembered = match token {
            Some(_) => None,
            None => id
                .and_then(|id| self.find(id).ok())
                .filter(|record| credential_scope(&record.endpoint) == credential_scope(&endpoint))
                .and_then(|record| record.token),
        };
        let token = token.or(remembered.as_deref());
        let mut probe = HostProbe {
            endpoint: endpoint.clone(),
            protocol: None,
            auth: None,
            worlds: Vec::new(),
            unauthorized: false,
            note: None,
        };

        // Discovery is public and optional: a host that proxies the protocol
        // under its own routes may not carry it, and that is not a failure.
        let discovery = self
            .read_json(&format!("{endpoint}.well-known/vantage"), None)
            .await?;
        if let Some(value) = discovery {
            probe.protocol = value
                .get("protocol")
                .and_then(serde_json::Value::as_u64)
                .and_then(|protocol| u32::try_from(protocol).ok());
            probe.auth = value
                .get("auth")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            if probe.protocol.is_some_and(|protocol| protocol != 1) {
                probe.note = Some(format!(
                    "This server speaks protocol {}; this build understands 1.",
                    probe.protocol.unwrap_or_default()
                ));
            }
        }

        let worlds_url = format!("{endpoint}v1/worlds");
        let response = self
            .request(&worlds_url, token, None, PROBE_TIMEOUT)
            .await?;
        let status = response.status().as_u16();
        if status == 401 || status == 403 {
            probe.unauthorized = true;
            return Ok(probe);
        }
        if (200..300).contains(&status) {
            let body = read_capped(response, MAX_PROBE_BYTES).await?;
            let parsed: serde_json::Value = serde_json::from_slice(&body)
                .map_err(|_| "The server's world list was not valid JSON.".to_string())?;
            probe.worlds = parsed
                .get("worlds")
                .and_then(serde_json::Value::as_array)
                .map(|worlds| {
                    worlds
                        .iter()
                        .filter_map(|world| world.get("id").and_then(serde_json::Value::as_str))
                        .filter(|id| is_world_id(id))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            if probe.worlds.is_empty() {
                probe.note = Some("This server listed no worlds for this credential.".into());
            }
            return Ok(probe);
        }
        if probe.protocol.is_none() {
            return Err(format!(
                "Nothing at that address answered like a Vantage server (HTTP {status})."
            ));
        }
        probe.note = Some(format!("The world list answered {status}."));
        Ok(probe)
    }

    /// GETs a small public/authorized JSON document, tolerating a plain miss.
    async fn read_json(
        &self,
        url: &str,
        token: Option<&str>,
    ) -> Result<Option<serde_json::Value>, String> {
        let response = self.request(url, token, None, PROBE_TIMEOUT).await?;
        if !response.status().is_success() {
            return Ok(None);
        }
        let body = read_capped(response, MAX_PROBE_BYTES).await?;
        Ok(serde_json::from_slice(&body).ok())
    }

    async fn request(
        &self,
        url: &str,
        token: Option<&str>,
        if_none_match: Option<&str>,
        timeout: Duration,
    ) -> Result<reqwest::Response, String> {
        let client = self.client.as_ref().map_err(String::clone)?;
        let mut request = client.get(url).timeout(timeout);
        if let Some(token) = token {
            request = request.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
        }
        if let Some(etag) = if_none_match {
            request = request.header(reqwest::header::IF_NONE_MATCH, etag);
        }
        request
            .send()
            .await
            .map_err(|error| transport_error(&error))
    }

    fn persist(&self) -> Result<(), String> {
        let records = self.read()?;
        let body = serde_json::to_vec_pretty(&Store {
            version: 1,
            hosts: &records,
        })
        .map_err(|error| error.to_string())?;
        drop(records);
        write_private(&self.path, &body)
    }
}

#[derive(Serialize)]
struct Store<'a> {
    version: u32,
    hosts: &'a [HostRecord],
}

#[derive(Deserialize)]
struct StoreOwned {
    #[serde(default)]
    hosts: Vec<HostRecord>,
}

/// Never falls back to `reqwest`'s default client: that one follows redirects,
/// and refusing a redirect before an `Authorization` header can be replayed at
/// an origin the user never named is the whole point of the settings below.
/// A failure is carried to the fetch that needs it instead.
fn build_client() -> Result<reqwest::Client, String> {
    try_build_client()
        .map_err(|error| format!("Vantage could not open a secure connection: {error}"))
}

/// The one HTTP client this app talks to servers with.
///
/// The crypto provider is installed first because reqwest is asked for
/// `rustls-no-provider` on purpose: that reuses the `ring` build already in
/// this app's tree, where naming `rustls` instead would add a second provider
/// (`aws-lc-rs`, and with it a CMake build dependency) beside it. The cost of
/// that choice is this call — without it, building a client *panics* rather
/// than failing, which the test below is here to catch.
fn try_build_client() -> reqwest::Result<reqwest::Client> {
    // Errs only when something already installed one, which is just as good.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        // A redirect is the one way an `Authorization` header could be replayed
        // at an origin the user never named, so it is refused outright and
        // surfaces as an ordinary non-2xx status instead.
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .user_agent(concat!("Vantage/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn read_store(path: &Path) -> Vec<HostRecord> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<StoreOwned>(&bytes)
            .map(|store| store.hosts)
            .unwrap_or_default(),
        Err(error) if error.kind() == ErrorKind::NotFound => Vec::new(),
        Err(_) => Vec::new(),
    }
}

/// Writes the connections file, replacing it atomically so a crash mid-write
/// cannot truncate the list, and keeping it owner-only where the platform has
/// a notion of that: it holds access tokens.
fn write_private(path: &Path, body: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, body).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })
}

/// Accepts what a person actually types — `map.example.net`, `10.0.0.4:8268`,
/// `https://play.example.net/map/` — and returns the canonical base every URL
/// below it is built from.
///
/// A bare address gets `http` on a loopback or private-network host and `https`
/// everywhere else: the sidecar terminates no TLS of its own, so a LAN address
/// is plaintext by design while a public one should never be.
pub fn normalize_endpoint(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Enter the server's map address.".into());
    }
    // A URL needs an IPv6 literal bracketed, but nobody types `[::1]` when the
    // thing they are reading off the sidecar's own log is `::1`. Bracket it here
    // rather than rejecting a correct address on a technicality.
    let authority = if is_bare_ipv6(trimmed) {
        format!("[{trimmed}]")
    } else {
        trimmed.to_string()
    };
    let with_scheme = if authority.contains("://") {
        authority
    } else if is_private_authority(&authority) {
        format!("http://{authority}")
    } else {
        format!("https://{authority}")
    };

    let mut url = reqwest::Url::parse(&with_scheme)
        .map_err(|_| "That is not a valid server address.".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("A map address must be http or https.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Put the access token in the token field, not the address.".into());
    }
    if url.host_str().is_none() {
        return Err("That address has no host.".into());
    }
    url.set_query(None);
    url.set_fragment(None);
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url.to_string())
}

/// Scheme, host and port of a normalized endpoint — what a bearer credential is
/// actually scoped to. The path below it is the same operator's business; a
/// different authority is a different server, and `http` for `https` is the
/// same server over a wire that would carry the token in the clear.
fn credential_scope(endpoint: &str) -> Option<(String, String, Option<u16>)> {
    let url = reqwest::Url::parse(endpoint).ok()?;
    Some((
        url.scheme().to_string(),
        url.host_str()?.to_ascii_lowercase(),
        // The default port written out is the same server, so a token survives
        // `https://h/` being retyped as `https://h:443/`.
        url.port_or_known_default(),
    ))
}

/// An unbracketed IPv6 literal, with no scheme, path or port to disambiguate it
/// — `::1`, `fd00::4`. More than one colon rules out `host:port`.
fn is_bare_ipv6(raw: &str) -> bool {
    !raw.contains('[')
        && !raw.contains("://")
        && !raw.contains('/')
        && raw.matches(':').count() > 1
        && raw.parse::<std::net::Ipv6Addr>().is_ok()
}

/// True for addresses that are plainly not on the public internet, where a
/// plaintext default is the useful one.
fn is_private_authority(authority: &str) -> bool {
    let host_port = authority.split('/').next().unwrap_or(authority);
    let host = if let Some(rest) = host_port.strip_prefix('[') {
        // Bracketed IPv6: the colons inside are part of the address.
        rest.split(']').next().unwrap_or(rest)
    } else if host_port.matches(':').count() > 1 {
        // Bare IPv6. Not valid in a URL without brackets, but recognizing it
        // here beats mistaking its last group for a port.
        host_port
    } else {
        match host_port.rsplit_once(':') {
            Some((head, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
                head
            }
            _ => host_port,
        }
    };
    let lower = host.to_ascii_lowercase();
    // IPv6 has its own private ranges, and they are the ones a home server or a
    // container network actually hands out: unique-local (fc00::/7) and
    // link-local (fe80::/10), alongside loopback.
    if let Ok(v6) = lower.parse::<std::net::Ipv6Addr>() {
        let leading = v6.octets()[0];
        return v6.is_loopback()
            || leading & 0xfe == 0xfc
            || (leading == 0xfe && v6.octets()[1] & 0xc0 == 0x80);
    }
    lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.starts_with("127.")
        || lower.starts_with("10.")
        || lower.starts_with("192.168.")
        || lower.starts_with("169.254.")
        || lower
            .strip_prefix("172.")
            .and_then(|rest| rest.split('.').next())
            .and_then(|octet| octet.parse::<u8>().ok())
            .is_some_and(|octet| (16..=31).contains(&octet))
}

/// Confirms a viewer-resolved URL stays inside the connection's own world, then
/// returns it. The client library confines manifest-owned paths already; this
/// is the check that actually gates the credential, because it is the one on
/// the side of the boundary that holds it.
fn confine(url: &str, prefix: &str) -> Result<String, String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|_| "That artifact address is not valid.".to_string())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Refusing an artifact address carrying credentials.".into());
    }
    let base = reqwest::Url::parse(prefix)
        .map_err(|_| "This connection's address is no longer valid.".to_string())?;
    // Compare on the parsed URL rather than the raw string so percent-encoding,
    // a default port written out, or a `..` segment cannot spell its way past
    // a prefix match.
    let same_origin = parsed.scheme() == base.scheme()
        && parsed.host_str() == base.host_str()
        && parsed.port_or_known_default() == base.port_or_known_default();
    if !same_origin || !parsed.path().starts_with(base.path()) {
        return Err("Refusing to fetch outside the connected world.".into());
    }
    // `Url` resolves literal dot segments but leaves `%2e%2e` encoded, and a
    // host that decodes before it routes would walk right out of the prefix the
    // check above just proved. Every protocol artifact name is unreserved, so a
    // segment that means anything else once decoded is refused outright.
    for segment in parsed.path().split('/') {
        let decoded = percent_encoding::percent_decode_str(segment)
            .decode_utf8()
            .map_err(|_| "Refusing to fetch outside the connected world.".to_string())?;
        if decoded == ".." || decoded == "." || decoded.contains('/') || decoded.contains('\\') {
            return Err("Refusing to fetch outside the connected world.".into());
        }
    }
    Ok(parsed.to_string())
}

/// `[u32 LE header length][header JSON][body]`.
///
/// A Tauri command answers with one value, and a tile is megabytes of binary:
/// serializing it as JSON numbers would cost more than the fetch. The bytes go
/// back raw with the status and validator framed in front of them, so a tile
/// still costs exactly one round trip.
fn frame(status: u16, etag: Option<&str>, content_type: Option<&str>, body: &[u8]) -> Vec<u8> {
    let header = serde_json::json!({
        "status": status,
        "etag": etag,
        "contentType": content_type,
    })
    .to_string();
    let mut framed = Vec::with_capacity(4 + header.len() + body.len());
    framed.extend_from_slice(&(header.len() as u32).to_le_bytes());
    framed.extend_from_slice(header.as_bytes());
    framed.extend_from_slice(body);
    framed
}

/// Reads a response body, refusing to hold more than `cap` of it.
///
/// The cap is enforced *while* reading rather than after. A declared
/// `Content-Length` is only a claim, and a chunked reply makes no claim at all,
/// so buffering the whole body first would let a hostile or broken endpoint
/// trade one request for as much of this process's memory as it cared to send.
/// The reservation is deliberately smaller than the cap for the same reason: a
/// server that announces 64 MiB and sends nothing should not cost 64 MiB.
async fn read_capped(mut response: reqwest::Response, cap: u64) -> Result<Vec<u8>, String> {
    let declared = response.content_length();
    if declared.is_some_and(|length| length > cap) {
        return Err("The server offered an implausibly large artifact.".into());
    }
    let mut body = Vec::with_capacity(declared.unwrap_or(0).min(READ_RESERVE) as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| transport_error(&error))?
    {
        if body.len() as u64 + chunk.len() as u64 > cap {
            return Err("The server sent an implausibly large artifact.".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn header(response: &reqwest::Response, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// Transport failures are reported to a player who cannot read a Rust error
/// chain, and the chain can carry the full URL. Keep it short and true.
fn transport_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "The server did not answer in time.".into()
    } else if error.is_connect() {
        "Could not reach that server.".into()
    } else {
        "The connection to that server failed.".into()
    }
}

fn origin_of(endpoint: &str) -> Option<String> {
    let url = reqwest::Url::parse(endpoint).ok()?;
    Some(match url.port() {
        Some(port) => format!("{}://{}:{port}", url.scheme(), url.host_str()?),
        None => format!("{}://{}", url.scheme(), url.host_str()?),
    })
}

/// A readable default name for a connection nobody bothered to name.
fn pick_label(label: &str, endpoint: &str) -> String {
    let trimmed = label.trim();
    if !trimmed.is_empty() {
        return trimmed.chars().take(64).collect();
    }
    reqwest::Url::parse(endpoint)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| "Vantage server".into())
}

/// The protocol's world-id grammar, matching the client library's.
fn is_world_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// Connection handles only have to be unique and unguessable-enough to be a
/// poor thing to forge from page script; they name no resource by themselves.
fn new_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or_default();
    let mixed = (nanos as u64) ^ (std::process::id() as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    format!("{:016x}", mixed.wrapping_mul(0x2545_f491_4f6c_dd1d))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "vantage-hosts-{}-{}-{name}",
            std::process::id(),
            crate::renders::now_ms()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn addresses_normalize_the_way_people_type_them() {
        assert_eq!(
            normalize_endpoint("map.example.net").unwrap(),
            "https://map.example.net/"
        );
        assert_eq!(
            normalize_endpoint("  https://play.example.net/map  ").unwrap(),
            "https://play.example.net/map/"
        );
        // Loopback and private ranges default to plaintext: the sidecar
        // terminates no TLS and a LAN address would otherwise never connect.
        assert_eq!(
            normalize_endpoint("127.0.0.1:8268").unwrap(),
            "http://127.0.0.1:8268/"
        );
        assert_eq!(
            normalize_endpoint("localhost:8268").unwrap(),
            "http://localhost:8268/"
        );
        assert_eq!(
            normalize_endpoint("192.168.1.9:8268").unwrap(),
            "http://192.168.1.9:8268/"
        );
        assert_eq!(
            normalize_endpoint("172.20.0.5:8268").unwrap(),
            "http://172.20.0.5:8268/"
        );
        // ...but 172.15 and 172.32 are ordinary public space.
        assert!(normalize_endpoint("172.15.0.5:8268")
            .unwrap()
            .starts_with("https://"));
        assert!(normalize_endpoint("172.32.0.5:8268")
            .unwrap()
            .starts_with("https://"));
        // A query or fragment is not part of a base address.
        assert_eq!(
            normalize_endpoint("https://map.example.net/x?a=1#b").unwrap(),
            "https://map.example.net/x/"
        );
    }

    #[test]
    fn addresses_that_could_leak_a_credential_are_refused() {
        assert!(normalize_endpoint("https://user:pass@map.example.net").is_err());
        assert!(normalize_endpoint("ftp://map.example.net").is_err());
        assert!(normalize_endpoint("file:///etc/passwd").is_err());
        assert!(normalize_endpoint("   ").is_err());
    }

    #[test]
    fn artifact_urls_are_confined_to_the_connected_world() {
        let prefix = "https://map.example.net/v1/worlds/default/";
        assert!(confine(
            "https://map.example.net/v1/worlds/default/manifest.json",
            prefix
        )
        .is_ok());
        assert!(confine(
            "https://map.example.net/v1/worlds/default/tiles/t.0.0.vtile",
            prefix
        )
        .is_ok());
        // The default port spelled out is the same origin.
        assert!(confine(
            "https://map.example.net:443/v1/worlds/default/manifest.json",
            prefix
        )
        .is_ok());

        for refused in [
            // Another origin entirely — the case that would replay the bearer.
            "https://evil.example.net/v1/worlds/default/manifest.json",
            // Same host, plaintext.
            "http://map.example.net/v1/worlds/default/manifest.json",
            // Another port.
            "https://map.example.net:8443/v1/worlds/default/manifest.json",
            // Another world on the same server.
            "https://map.example.net/v1/worlds/other/manifest.json",
            // Outside the protocol prefix.
            "https://map.example.net/admin",
            // Prefix-of-a-prefix: `defaultish` must not pass for `default`.
            "https://map.example.net/v1/worlds/defaultish/manifest.json",
            // Credentials in the artifact address.
            "https://a:b@map.example.net/v1/worlds/default/manifest.json",
            "not a url",
        ] {
            assert!(
                confine(refused, prefix).is_err(),
                "{refused} should be refused"
            );
        }
    }

    #[test]
    fn traversal_cannot_climb_out_of_the_world_prefix() {
        let prefix = "https://map.example.net/v1/worlds/default/";
        // A URL parser normalizes `..` away, so the result is judged on where
        // it actually lands rather than on how it was spelled.
        assert!(confine(
            "https://map.example.net/v1/worlds/default/../other/manifest.json",
            prefix
        )
        .is_err());
        assert!(confine(
            "https://map.example.net/v1/worlds/default/tiles/../manifest.json",
            prefix
        )
        .is_ok());
    }

    /// `Url` normalizes the dot segments it can *see*. A host that decodes
    /// before it routes sees more of them than the parser did, so the encoded
    /// spellings have to be refused on their own account.
    #[test]
    fn percent_encoded_traversal_cannot_climb_out_either() {
        let prefix = "https://map.example.net/v1/worlds/default/";
        for refused in [
            "https://map.example.net/v1/worlds/default/%2e%2e/other/manifest.json",
            "https://map.example.net/v1/worlds/default/%2E%2E/%2E%2E/admin",
            "https://map.example.net/v1/worlds/default/tiles/%2e%2e/%2e%2e/other/x.vtile",
            // A segment that decodes to a separator would re-partition the path
            // downstream of every check above.
            "https://map.example.net/v1/worlds/default/%2ftiles/x.vtile",
            "https://map.example.net/v1/worlds/default/%5c..%5cadmin",
        ] {
            assert!(
                confine(refused, prefix).is_err(),
                "{refused} should be refused"
            );
        }
        // An ordinary encoded character is not traversal and still resolves.
        assert!(confine(
            "https://map.example.net/v1/worlds/default/tiles/t.0.0%2Evtile",
            prefix
        )
        .is_ok());
    }

    /// Nobody brackets a loopback IPv6 address they just read off a log line.
    #[test]
    fn a_bare_ipv6_address_is_bracketed_rather_than_rejected() {
        assert_eq!(normalize_endpoint("::1").unwrap(), "http://[::1]/");
        // Unique-local, like 10.0.0.0/8: private, so plaintext is the default.
        assert_eq!(normalize_endpoint("fd00::4").unwrap(), "http://[fd00::4]/");
        // A global IPv6 address is on the public internet and gets https.
        assert_eq!(
            normalize_endpoint("2606:4700::1111").unwrap(),
            "https://[2606:4700::1111]/"
        );
        // Already bracketed, with a port, keeps working.
        assert_eq!(
            normalize_endpoint("[::1]:8268").unwrap(),
            "http://[::1]:8268/"
        );
        // A host:port is still a host and a port, not an IPv6 literal.
        assert_eq!(
            normalize_endpoint("map.example.net:8268").unwrap(),
            "https://map.example.net:8268/"
        );
    }

    /// The connections file is rewritten on every edit, so atomic replacement
    /// has to work over a file that is already there — the case `rename` is
    /// documented to handle on Windows (`MOVEFILE_REPLACE_EXISTING`) and the
    /// one that would silently strand every edit if it ever stopped.
    #[test]
    fn saving_replaces_an_existing_connections_file() {
        let root = scratch("replace");
        let path = root.join(STORE_FILE);
        write_private(&path, b"{\"version\":1,\"hosts\":[]}").unwrap();
        write_private(&path, b"{\"version\":1,\"hosts\":[\"second\"]}").unwrap();
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"{\"version\":1,\"hosts\":[\"second\"]}"
        );
        // The scratch file must not survive as litter beside the real one.
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn framing_puts_the_status_in_front_of_the_bytes() {
        let body = vec![7_u8; 2048];
        let framed = frame(
            200,
            Some("\"abc\""),
            Some("application/octet-stream"),
            &body,
        );
        let header_len = u32::from_le_bytes(framed[0..4].try_into().unwrap()) as usize;
        let header: serde_json::Value = serde_json::from_slice(&framed[4..4 + header_len]).unwrap();
        assert_eq!(header["status"], 200);
        assert_eq!(header["etag"], "\"abc\"");
        assert_eq!(&framed[4 + header_len..], &body[..]);

        // A 304 frames a validator and no body at all.
        let empty = frame(304, Some("\"abc\""), None, &[]);
        let empty_len = u32::from_le_bytes(empty[0..4].try_into().unwrap()) as usize;
        assert_eq!(empty.len(), 4 + empty_len);
    }

    #[test]
    fn saving_round_trips_and_keeps_the_token_out_of_the_entry() {
        let root = scratch("save");
        let store = HostStore::load(&root);
        let entry = store
            .save(HostInput {
                id: None,
                label: "  Survival  ".into(),
                endpoint: "map.example.net".into(),
                world_id: None,
                token: Some("s3cret".into()),
                forget_token: false,
            })
            .unwrap();
        assert_eq!(entry.label, "Survival");
        assert_eq!(entry.endpoint, "https://map.example.net/");
        assert_eq!(entry.world_id, "default");
        assert!(entry.has_token);

        // Reloading from disk sees the same connection, token included.
        let reloaded = HostStore::load(&root);
        let listed = reloaded.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].has_token);
        assert_eq!(
            reloaded.find(&entry.id).unwrap().token.as_deref(),
            Some("s3cret")
        );

        // Editing without a token keeps the stored one...
        reloaded
            .save(HostInput {
                id: Some(entry.id.clone()),
                label: "Survival".into(),
                endpoint: "map.example.net".into(),
                world_id: Some("default".into()),
                token: None,
                forget_token: false,
            })
            .unwrap();
        assert_eq!(
            reloaded.find(&entry.id).unwrap().token.as_deref(),
            Some("s3cret")
        );

        // ...and forgetting drops it.
        let forgotten = reloaded
            .save(HostInput {
                id: Some(entry.id.clone()),
                label: "Survival".into(),
                endpoint: "map.example.net".into(),
                world_id: None,
                token: None,
                forget_token: true,
            })
            .unwrap();
        assert!(!forgotten.has_token);
        assert!(reloaded.find(&entry.id).unwrap().token.is_none());

        reloaded.delete(&entry.id).unwrap();
        assert!(reloaded.list().unwrap().is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A bearer is granted by one operator for one server. "Keep the saved
    /// token" must not mean "send it to whoever answers the address I just
    /// retyped" — a typo, or an address someone talked the player into pasting.
    #[test]
    fn editing_the_address_leaves_a_remembered_token_behind() {
        let root = scratch("rehome");
        let store = HostStore::load(&root);
        let add = |endpoint: &str, token: Option<&str>| HostInput {
            id: None,
            label: "Survival".into(),
            endpoint: endpoint.into(),
            world_id: None,
            token: token.map(str::to_string),
            forget_token: false,
        };
        let edit = |id: &str, endpoint: &str, token: Option<&str>| HostInput {
            id: Some(id.to_string()),
            ..add(endpoint, token)
        };

        let entry = store
            .save(add("https://map.example.net/", Some("s3cret")))
            .unwrap();

        // Same origin, different path below it: the same operator's server.
        store
            .save(edit(&entry.id, "https://map.example.net/map/", None))
            .unwrap();
        assert_eq!(
            store.find(&entry.id).unwrap().token.as_deref(),
            Some("s3cret"),
            "a path edit stays on the server the token was granted for"
        );

        // Another host entirely — the credential does not travel.
        let moved = store
            .save(edit(&entry.id, "https://map.evil.example/", None))
            .unwrap();
        assert!(!moved.has_token);
        assert!(store.find(&entry.id).unwrap().token.is_none());

        // Nor does it survive a downgrade to a wire that would carry it in
        // the clear, even on the very same host.
        let entry = store
            .save(add("https://map.example.net/", Some("s3cret")))
            .unwrap();
        store
            .save(edit(&entry.id, "http://map.example.net/", None))
            .unwrap();
        assert!(store.find(&entry.id).unwrap().token.is_none());

        // Moving *and* supplying a new token is an ordinary re-point.
        let entry = store
            .save(add("https://a.example.net/", Some("first")))
            .unwrap();
        store
            .save(edit(&entry.id, "https://b.example.net/", Some("second")))
            .unwrap();
        assert_eq!(
            store.find(&entry.id).unwrap().token.as_deref(),
            Some("second")
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_unnamed_connection_is_named_after_its_host() {
        let root = scratch("label");
        let store = HostStore::load(&root);
        let entry = store
            .save(HostInput {
                id: None,
                label: String::new(),
                endpoint: "https://play.example.net:8268/map".into(),
                world_id: None,
                token: None,
                forget_token: false,
            })
            .unwrap();
        assert_eq!(entry.label, "play.example.net");
        assert_eq!(entry.endpoint, "https://play.example.net:8268/map/");
        assert!(!entry.has_token);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_bad_world_id_is_refused_before_it_reaches_a_url() {
        let root = scratch("worldid");
        let store = HostStore::load(&root);
        for refused in ["../other", "a/b", "with space", &"x".repeat(65)] {
            assert!(store
                .save(HostInput {
                    id: None,
                    label: String::new(),
                    endpoint: "map.example.net".into(),
                    world_id: Some(refused.to_string()),
                    token: None,
                    forget_token: false,
                })
                .is_err());
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// Nothing about a plaintext LAN connection would notice a missing TLS
    /// backend, and a public map address is exactly where noticing it late is
    /// worst. Building a client is where rustls resolves its provider — and
    /// with `rustls-no-provider` it *panics* there rather than returning an
    /// error, so this test guards the app's first second of life, not a
    /// hypothetical.
    #[test]
    fn the_client_builds_with_a_working_tls_backend() {
        assert!(
            try_build_client().is_ok(),
            "no rustls crypto provider is installed — every https server address would fail"
        );
    }

    #[test]
    fn a_corrupt_store_starts_empty_rather_than_failing_to_launch() {
        let root = scratch("corrupt");
        std::fs::write(root.join(STORE_FILE), b"{ not json").unwrap();
        assert!(HostStore::load(&root).list().unwrap().is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A stand-in for `vantage server`: enough of protocol v1 to prove the
    /// transport attaches the credential, revalidates, and refuses to follow a
    /// redirect away from the origin the player named.
    ///
    /// Every request it saw is returned, so a test can assert on what actually
    /// went over the wire rather than on what this side meant to send.
    fn stub_server(token: &'static str) -> (u16, std::sync::Arc<Mutex<Vec<String>>>) {
        use std::io::{BufRead, BufReader, Write};

        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let log = std::sync::Arc::clone(&seen);

        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut start = String::new();
                if reader.read_line(&mut start).is_err() || start.is_empty() {
                    continue;
                }
                let target = start.split_whitespace().nth(1).unwrap_or("/").to_string();
                let mut authorization = None;
                let mut if_none_match = None;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                        break;
                    }
                    let (name, value) = line.split_once(':').unwrap_or(("", ""));
                    match name.trim().to_ascii_lowercase().as_str() {
                        "authorization" => authorization = Some(value.trim().to_string()),
                        "if-none-match" => if_none_match = Some(value.trim().to_string()),
                        _ => {}
                    }
                }
                log.lock().unwrap().push(format!(
                    "{target} auth={}",
                    authorization.as_deref().unwrap_or("-")
                ));

                let authorized = authorization.as_deref() == Some(&format!("Bearer {token}"));
                let mut writer = stream;
                let write = |writer: &mut std::net::TcpStream, head: &str, body: &[u8]| {
                    let _ = write!(writer, "{head}Content-Length: {}\r\n\r\n", body.len());
                    let _ = writer.write_all(body);
                    let _ = writer.flush();
                };

                match target.as_str() {
                    // Discovery is public: no credential, and none expected.
                    "/.well-known/vantage" => write(
                        &mut writer,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n",
                        br#"{"protocol":1,"api":"/v1","auth":"bearer"}"#,
                    ),
                    _ if !authorized => write(
                        &mut writer,
                        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n",
                        b"unauthorized",
                    ),
                    "/v1/worlds" => write(
                        &mut writer,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n",
                        br#"{"worlds":[{"id":"default","manifest":"/v1/worlds/default/manifest.json"}]}"#,
                    ),
                    "/v1/worlds/default/manifest.json" => write(
                        &mut writer,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n",
                        br#"{"version":6,"tiles":[]}"#,
                    ),
                    "/v1/worlds/default/tiles/t.0.0.vtile" => {
                        if if_none_match.as_deref() == Some("\"s-1\"") {
                            let _ = write!(
                                writer,
                                "HTTP/1.1 304 Not Modified\r\nETag: \"s-1\"\r\nConnection: close\r\n\r\n"
                            );
                            let _ = writer.flush();
                        } else {
                            write(
                                &mut writer,
                                "HTTP/1.1 200 OK\r\nETag: \"s-1\"\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n",
                                &vec![42_u8; 5000],
                            );
                        }
                    }
                    // The one route that tries to move the credential.
                    "/v1/worlds/default/terrain.vtexarr" => {
                        let _ = write!(
                            writer,
                            "HTTP/1.1 302 Found\r\nLocation: http://example.invalid/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        );
                        let _ = writer.flush();
                    }
                    _ => write(
                        &mut writer,
                        "HTTP/1.1 404 Not Found\r\nConnection: close\r\n",
                        b"not found",
                    ),
                }
            }
        });
        (port, seen)
    }

    fn unframe(framed: &[u8]) -> (serde_json::Value, Vec<u8>) {
        let length = u32::from_le_bytes(framed[0..4].try_into().unwrap()) as usize;
        (
            serde_json::from_slice(&framed[4..4 + length]).unwrap(),
            framed[4 + length..].to_vec(),
        )
    }

    #[test]
    fn a_connection_probes_streams_and_revalidates_over_real_http() {
        let root = scratch("wire");
        let (port, seen) = stub_server("s3cret");
        let store = HostStore::load(&root);
        let endpoint = format!("127.0.0.1:{port}");

        tauri::async_runtime::block_on(async {
            // A probe without the token still discovers the server, and says
            // plainly that the credential was refused.
            let anonymous = store.probe(&endpoint, None, None).await.unwrap();
            assert_eq!(anonymous.protocol, Some(1));
            assert_eq!(anonymous.auth.as_deref(), Some("bearer"));
            assert!(anonymous.unauthorized);
            assert!(anonymous.worlds.is_empty());

            let probe = store.probe(&endpoint, None, Some("s3cret")).await.unwrap();
            assert!(!probe.unauthorized);
            assert_eq!(probe.worlds, vec!["default".to_string()]);
            // A bare loopback address resolved to plaintext, as typed.
            assert_eq!(probe.endpoint, format!("http://127.0.0.1:{port}/"));

            let entry = store
                .save(HostInput {
                    id: None,
                    label: "Stub".into(),
                    endpoint: endpoint.clone(),
                    world_id: Some("default".into()),
                    token: Some("s3cret".into()),
                    forget_token: false,
                })
                .unwrap();

            // Testing a saved connection with a blank token box: the remembered
            // credential stands in, so the verdict describes the connection the
            // player would actually make.
            let remembered = store.probe(&endpoint, Some(&entry.id), None).await.unwrap();
            assert!(
                !remembered.unauthorized,
                "a saved token should answer for its own address"
            );
            assert_eq!(remembered.worlds, vec!["default".to_string()]);

            // ...but only for its own address. Re-pointing the form elsewhere
            // must not be a way to make the probe carry it there. The stub is
            // reachable both ways, so an unauthorized verdict here is proof the
            // token was withheld rather than proof the host was unreachable.
            let elsewhere = store
                .probe(&format!("localhost:{port}"), Some(&entry.id), None)
                .await
                .unwrap();
            assert_eq!(elsewhere.protocol, Some(1), "the stub answered");
            assert!(
                elsewhere.unauthorized,
                "a remembered token must not follow the form to another host"
            );

            let connection = store.connect(&entry.id).await.unwrap();
            assert_eq!(
                connection.manifest_url,
                format!("http://127.0.0.1:{port}/v1/worlds/default/manifest.json")
            );
            assert_eq!(connection.origin, format!("http://127.0.0.1:{port}"));
            // Connecting is what records the visit.
            assert!(store.find(&entry.id).unwrap().last_connected_ms.is_some());

            let tile_url = format!("http://127.0.0.1:{port}/v1/worlds/default/tiles/t.0.0.vtile");
            let (header, body) = unframe(&store.fetch(&entry.id, &tile_url, None).await.unwrap());
            assert_eq!(header["status"], 200);
            assert_eq!(header["etag"], "\"s-1\"");
            assert_eq!(body.len(), 5000);

            // Presenting the validator costs a status line and no body.
            let (revalidated, empty) = unframe(
                &store
                    .fetch(&entry.id, &tile_url, Some("\"s-1\""))
                    .await
                    .unwrap(),
            );
            assert_eq!(revalidated["status"], 304);
            assert!(empty.is_empty());

            // A redirect is surfaced, never followed: the credential must not
            // reach an origin the player never named.
            let (redirect, _) = unframe(
                &store
                    .fetch(
                        &entry.id,
                        &format!("http://127.0.0.1:{port}/v1/worlds/default/terrain.vtexarr"),
                        None,
                    )
                    .await
                    .unwrap(),
            );
            assert_eq!(redirect["status"], 302);

            // And an artifact outside this world never becomes a request at all.
            assert!(store
                .fetch(
                    &entry.id,
                    &format!("http://127.0.0.1:{port}/v1/worlds/other/manifest.json"),
                    None
                )
                .await
                .is_err());
        });

        let requests = seen.lock().unwrap().clone();
        assert!(
            requests
                .iter()
                .any(|line| line == "/.well-known/vantage auth=-"),
            "discovery must stay anonymous: {requests:?}"
        );
        assert!(
            requests
                .iter()
                .filter(|line| line.starts_with("/v1/"))
                .all(|line| line.ends_with("auth=Bearer s3cret") || line.ends_with("auth=-")),
            "no /v1 request may carry the wrong credential: {requests:?}"
        );
        assert!(
            !requests.iter().any(|line| line.contains("/steal")),
            "the redirect must not have been followed: {requests:?}"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_records_world_prefix_is_the_protocol_route() {
        let record = HostRecord {
            id: "abc".into(),
            label: "x".into(),
            endpoint: "https://map.example.net/map/".into(),
            world_id: "default".into(),
            token: None,
            added_at_ms: 0,
            last_connected_ms: None,
        };
        assert_eq!(
            record.world_prefix(),
            "https://map.example.net/map/v1/worlds/default/"
        );
        assert_eq!(
            record.manifest_url(),
            "https://map.example.net/map/v1/worlds/default/manifest.json"
        );
    }
}
