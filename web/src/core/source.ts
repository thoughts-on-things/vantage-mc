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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
}

/** Strip a leading `./` so manifest paths and stored keys always agree. */
function normalizePath(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}

/** A world served over HTTP: fetches `manifest.json` at `url` and resolves
 *  tile paths relative to it. This is what a plain string `world` option
 *  turns into. */
export async function worldFromUrl(url: string, base?: string): Promise<WorldSource> {
  const abs = new URL(url, base ?? (typeof document !== 'undefined' ? document.baseURI : undefined)).toString();
  const res = await fetch(abs);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${abs}`);
  const manifest: unknown = await res.json();
  return {
    manifest,
    label: abs,
    fetch: async (path, signal) => {
      const target = new URL(normalizePath(path), abs).toString();
      const r = await fetch(target, signal ? { signal } : undefined);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${target}`);
      return r.arrayBuffer();
    },
  };
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
