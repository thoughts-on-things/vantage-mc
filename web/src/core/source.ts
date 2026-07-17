// World sources — where a tiled render's bytes come from. The viewer streams a
// world through this tiny interface, so a render can live anywhere: an HTTP
// server (the classic deploy), a local folder the user picked in the browser
// (File System Access API / <input webkitdirectory>), an Electron app's disk,
// a zip — anything that can answer "give me the bytes at this relative path".

/** Fetch one file of a world render by its manifest-relative path (e.g.
 *  `tiles/t.0.0.vtile`). Reject with an `AbortError`-named error if `signal`
 *  fires mid-read. */
export type WorldFetch = (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>;

/** A tiled world render, wherever it lives. Pass one to the viewer's `world`
 *  option (or build one with {@link worldFromUrl}, {@link worldFromDirectory},
 *  or {@link worldFromFiles}). */
export interface WorldSource {
  /** The `manifest.json` value, still unvalidated — the viewer parses it. */
  manifest: unknown;
  /** Where the world came from, for error messages (a URL, a folder name). */
  label: string;
  /** Fetch a file by manifest-relative path. */
  fetch: WorldFetch;
}

/** Fetch implementation used by authenticated/native HTTP sources. Tauri and
 *  Electron hosts can pass their CORS-exempt fetch without coupling Vantage to
 *  a particular desktop runtime. */
export type WorldHttpFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpWorldOptions {
  /** Resolve a relative manifest URL outside a browser document. */
  base?: string;
  /** Bearer credential sent in the Authorization header, never in the URL. */
  accessToken?: string;
  /** Additional headers applied to the manifest and every artifact request. */
  headers?: Readonly<Record<string, string>>;
  /** Alternate fetch implementation (for example `@tauri-apps/plugin-http`). */
  fetch?: WorldHttpFetch;
  /** Safe human-facing source name. Defaults to the manifest URL. */
  label?: string;
}

export interface VantageServerOptions extends Omit<HttpWorldOptions, 'base'> {
  /** Opaque server world id. The v1 sidecar exposes `default`. */
  worldId?: string;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
}

/** Strip a leading `./` so manifest paths and stored keys always agree. */
function normalizePath(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}

/** Server manifests are authenticated input: never let an artifact path move
 *  a bearer credential to another origin or outside the manifest directory. */
function safeRemotePath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized.length === 0 || normalized.length > 512 || !/^[A-Za-z0-9._/-]+$/.test(normalized)) {
    throw new Error(`vantage: unsafe remote artifact path ${path}`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`vantage: unsafe remote artifact path ${path}`);
  }
  return normalized;
}

/** A world served over HTTP: fetches `manifest.json` at `url` and resolves
 *  tile paths relative to it. This is what a plain string `world` option
 *  turns into. */
export async function worldFromUrl(url: string, base?: string): Promise<WorldSource> {
  return worldFromHttp(url, { base });
}

/** An HTTP world with optional bearer auth and a pluggable fetch transport.
 *  Manifest-owned paths are confined to the manifest directory before any
 *  credential is attached. */
export async function worldFromHttp(url: string, options: HttpWorldOptions = {}): Promise<WorldSource> {
  const abs = new URL(
    url,
    options.base ?? (typeof document !== 'undefined' ? document.baseURI : undefined),
  ).toString();
  const manifestUrl = new URL(abs);
  if (manifestUrl.protocol !== 'http:' && manifestUrl.protocol !== 'https:') {
    throw new Error(`vantage: HTTP world requires an http(s) manifest URL`);
  }
  if (manifestUrl.username || manifestUrl.password) {
    throw new Error(`vantage: HTTP world credentials belong in headers, not the manifest URL`);
  }
  const root = new URL('.', manifestUrl);
  const http = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const headers: Record<string, string> = { ...options.headers };
  if (options.accessToken) headers['Authorization'] = `Bearer ${options.accessToken}`;
  const request = (target: string, signal?: AbortSignal) =>
    http(target, {
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(signal ? { signal } : {}),
    });

  const res = await request(abs);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${abs}`);
  const manifest: unknown = await res.json();
  return {
    manifest,
    label: options.label ?? abs,
    fetch: async (path, signal) => {
      const targetUrl = new URL(safeRemotePath(path), root);
      if (targetUrl.origin !== root.origin || !targetUrl.pathname.startsWith(root.pathname)) {
        throw new Error(`vantage: unsafe remote artifact path ${path}`);
      }
      const target = targetUrl.toString();
      const r = await request(target, signal);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${target}`);
      return r.arrayBuffer();
    },
  };
}

/** Connect to the Vantage server protocol v1. This is the direct-server path
 *  for launchers; a host with its own player sessions can use
 *  {@link worldFromHttp} with a session-gated manifest URL instead. */
export function worldFromVantageServer(endpoint: string, options: VantageServerOptions = {}): Promise<WorldSource> {
  const worldId = options.worldId ?? 'default';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(worldId)) throw new Error(`vantage: invalid server world id`);
  const base = new URL(endpoint);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error(`vantage: server endpoint must use http(s)`);
  }
  if (base.username || base.password) {
    throw new Error(`vantage: server credentials belong in headers, not the endpoint URL`);
  }
  base.pathname = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  base.search = '';
  base.hash = '';
  const manifest = new URL(`v1/worlds/${encodeURIComponent(worldId)}/manifest.json`, base).toString();
  return worldFromHttp(manifest, options);
}

/** A world in a local directory picked with the File System Access API
 *  (`window.showDirectoryPicker()`, Chromium) — reads `manifest.json` from the
 *  directory root and resolves tile paths through subdirectory handles on
 *  demand, so nothing is read until it streams in. */
export async function worldFromDirectory(dir: FileSystemDirectoryHandle): Promise<WorldSource> {
  const readFile = async (path: string, signal?: AbortSignal): Promise<File> => {
    throwIfAborted(signal);
    const segments = normalizePath(path).split('/').filter((s) => s.length > 0 && s !== '.');
    if (segments.length === 0 || segments.includes('..')) throw new Error(`vantage: bad tile path ${path}`);
    let node = dir;
    for (const segment of segments.slice(0, -1)) node = await node.getDirectoryHandle(segment);
    const handle = await node.getFileHandle(segments[segments.length - 1]!);
    return handle.getFile();
  };
  let manifestFile: File;
  try {
    manifestFile = await readFile('manifest.json');
  } catch {
    throw new Error(
      `vantage: no manifest.json in "${dir.name}" — pick the folder a \`vantage render\` wrote (it holds manifest.json, terrain.vtexarr, and tiles/)`,
    );
  }
  return {
    manifest: JSON.parse(await manifestFile.text()) as unknown,
    label: dir.name,
    fetch: async (path, signal) => {
      const file = await readFile(path, signal);
      throwIfAborted(signal);
      return file.arrayBuffer();
    },
  };
}

/** A world from a flat file list — `<input webkitdirectory>` or a drag-and-drop
 *  walk (the fallback for browsers without `showDirectoryPicker`). Finds the
 *  shallowest `manifest.json` and keys every file relative to its folder, so
 *  picking a parent folder of the render also works. `pathOf` overrides how a
 *  file's relative path is derived (default: `webkitRelativePath`, falling
 *  back to `name`). */
export async function worldFromFiles(
  files: Iterable<File>,
  pathOf: (file: File) => string = (f) => f.webkitRelativePath || f.name,
): Promise<WorldSource> {
  const byPath = new Map<string, File>();
  for (const file of files) byPath.set(normalizePath(pathOf(file)).replace(/\\/g, '/'), file);

  let manifestPath: string | null = null;
  for (const path of byPath.keys()) {
    if (path !== 'manifest.json' && !path.endsWith('/manifest.json')) continue;
    if (manifestPath === null || path.split('/').length < manifestPath.split('/').length) manifestPath = path;
  }
  if (manifestPath === null) {
    throw new Error(
      'vantage: no manifest.json among the selected files — pick the folder a `vantage render` wrote (it holds manifest.json, terrain.vtexarr, and tiles/)',
    );
  }
  const prefix = manifestPath.slice(0, manifestPath.length - 'manifest.json'.length);
  const root = prefix === '' ? 'world' : prefix.slice(0, -1);

  return {
    manifest: JSON.parse(await byPath.get(manifestPath)!.text()) as unknown,
    label: root,
    fetch: (path, signal) => {
      throwIfAborted(signal);
      const file = byPath.get(prefix + normalizePath(path));
      if (!file) return Promise.reject(new Error(`vantage: ${path} is not in the selected folder`));
      return file.arrayBuffer();
    },
  };
}
