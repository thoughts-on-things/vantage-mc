import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { worldFromHttp, type WorldSource } from 'vantage-mc/core';
import type { DesktopSettings } from './settings.js';

/** The geometry-affecting settings a render was baked with. */
export interface RenderSignature {
  fullCaves: boolean;
  smoothLighting: boolean;
  biomeBlend: boolean;
  /** Absent in records written before dimension support (overworld only). */
  allDimensions?: boolean;
}

export interface WorldInfo {
  path: string;
  name: string;
  lastPlayedMs: number;
  dataVersion: number;
  source: string;
  iconPath: string | null;
  iconUrl: string | null;
  thumbnailUrl: string | null;
  cached: boolean;
  /** When the cached render was baked; null when nothing is cached. */
  renderedAtMs: number | null;
  /** Null for renders made before the desktop app recorded its settings. */
  renderSettings: RenderSignature | null;
}

/** One generated render on this PC, as the renders manager sees it. */
export interface RenderEntry {
  id: string;
  path: string;
  worldPath: string | null;
  worldName: string;
  sizeBytes: number;
  fileCount: number;
  renderedAtMs: number;
  worldMissing: boolean;
  settings: RenderSignature | null;
  thumbnailUrl: string | null;
}

export interface RenderProgress {
  phase: 'idle' | 'scanning' | 'tiles' | 'lowres' | 'finalizing' | 'done' | 'failed';
  completed: number;
  total: number;
  worldPath: string;
}

export interface RenderReady {
  manifestUrl: string;
  /** The render's `world.json` when it has one — every dimension, for the
   *  viewer's switcher. Absent for renders made before dimension support. */
  worldUrl?: string;
  outputPath: string;
}

/** A cached render either opens, or explains why it has to be rebuilt. */
export type CacheOpen =
  | ({ status: 'ready' } & RenderReady)
  | { status: 'stale'; reason: string };

export interface SystemProfile {
  logicalCores: number;
  architecture: string;
  platform: string;
}

/** A saved connection to a `vantage server`. The access token never crosses
 *  into this process — only whether one is remembered. */
export interface HostEntry {
  id: string;
  label: string;
  endpoint: string;
  worldId: string;
  hasToken: boolean;
  addedAtMs: number;
  lastConnectedMs: number | null;
}

/** What an address turned out to be, before it is saved. */
export interface HostProbe {
  /** The address as it will actually be stored. */
  endpoint: string;
  protocol: number | null;
  auth: string | null;
  worlds: string[];
  unauthorized: boolean;
  note: string | null;
}

export interface HostConnection {
  id: string;
  label: string;
  manifestUrl: string;
  origin: string;
}

/** The add/edit form's payload. Omitting `token` on an edit keeps the saved
 *  one, which is how the form can offer it without ever displaying it. */
export interface HostInput {
  id?: string;
  label: string;
  endpoint: string;
  worldId?: string;
  token?: string;
  forgetToken?: boolean;
}

export interface SavedImage {
  path: string;
  name: string;
}

const HOUR = 1000 * 60 * 60;

const mockWorlds: WorldInfo[] = [
  {
    path: 'C:\\Users\\you\\AppData\\Roaming\\.minecraft\\saves\\Green Valley',
    name: 'Green Valley',
    lastPlayedMs: Date.now() - 1000 * 60 * 18,
    dataVersion: 4554,
    source: 'vanilla',
    iconPath: null,
    iconUrl: null,
    thumbnailUrl: null,
    cached: false,
    renderedAtMs: null,
    renderSettings: null,
  },
  {
    path: 'C:\\Users\\you\\PrismLauncher\\instances\\Create\\minecraft\\saves\\Copper Hills',
    name: 'Copper Hills',
    lastPlayedMs: Date.now() - 26 * HOUR,
    dataVersion: 4189,
    source: 'prism',
    iconPath: null,
    iconUrl: null,
    thumbnailUrl: null,
    cached: true,
    renderedAtMs: Date.now() - 30 * HOUR,
    renderSettings: { fullCaves: true, smoothLighting: true, biomeBlend: true, allDimensions: true },
  },
];

const mockRenders: RenderEntry[] = [
  {
    id: '2f6a1c93be0d7a41',
    path: 'C:\\Users\\you\\AppData\\Local\\Vantage\\renders\\2f6a1c93be0d7a41',
    worldPath: mockWorlds[1].path,
    worldName: mockWorlds[1].name,
    sizeBytes: 36_204_544,
    fileCount: 268,
    renderedAtMs: Date.now() - 30 * HOUR,
    worldMissing: false,
    settings: { fullCaves: true, smoothLighting: true, biomeBlend: true, allDimensions: true },
    thumbnailUrl: null,
  },
  {
    id: '9be4470f1ad3c250',
    path: 'C:\\Users\\you\\AppData\\Local\\Vantage\\renders\\9be4470f1ad3c250',
    worldPath: 'C:\\Users\\you\\AppData\\Roaming\\.minecraft\\saves\\Old Survival',
    worldName: 'Old Survival',
    sizeBytes: 12_803_072,
    fileCount: 94,
    renderedAtMs: Date.now() - 40 * 24 * HOUR,
    worldMissing: true,
    settings: { fullCaves: false, smoothLighting: true, biomeBlend: false },
    thumbnailUrl: null,
  },
];

const mockHosts: HostEntry[] = [
  {
    id: 'mock-survival',
    label: 'Survival SMP',
    endpoint: 'https://map.example.net/',
    worldId: 'default',
    hasToken: true,
    addedAtMs: Date.now() - 9 * 24 * HOUR,
    lastConnectedMs: Date.now() - 3 * HOUR,
  },
];

/** The browser preview's stand-in for the native address normalizer. */
function mockEndpoint(raw: string): string {
  const trimmed = raw.trim();
  const scheme = trimmed.includes('://') ? '' : /^(localhost|127\.|\[?::1)/.test(trimmed) ? 'http://' : 'https://';
  const url = new URL(`${scheme}${trimmed}`);
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

function inTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

/**
 * The browser preview has no native host, so the viewer screen is normally
 * unreachable there. Point this at any manifest — `vantage serve` over one of
 * your renders is the easy one — to work on the viewer chrome without
 * rebuilding the native app:
 *
 *   VITE_MOCK_MANIFEST=http://127.0.0.1:8268/manifest.json npm run dev
 */
const mockManifestUrl: string | undefined = import.meta.env.VITE_MOCK_MANIFEST;

export async function discoverWorlds(): Promise<WorldInfo[]> {
  if (!inTauri()) return mockWorlds;
  return invoke<WorldInfo[]>('discover_worlds');
}

export async function renderWorld(
  world: WorldInfo,
  settings: DesktopSettings,
  threadCount: number | null,
): Promise<RenderReady> {
  if (!inTauri()) {
    // Leave the loading state visible long enough to exercise it in the fast
    // browser preview; native rendering is intentionally unavailable there.
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    throw new Error('Rendering is available in the native Vantage window.');
  }
  return invoke<RenderReady>('render_world', {
    path: world.path,
    name: world.name,
    settings: { ...settings, threadCount },
  });
}

export async function openCachedWorld(path: string, settings: DesktopSettings): Promise<CacheOpen> {
  if (!inTauri()) {
    if (!mockManifestUrl) throw new Error('Cached renders are available in the Tauri desktop window.');
    return { status: 'ready', manifestUrl: mockManifestUrl, outputPath: 'preview' };
  }
  return invoke<CacheOpen>('open_cached_world', { path, settings });
}

export async function cancelRender(): Promise<void> {
  if (!inTauri()) return;
  return invoke<void>('cancel_render');
}

export async function saveWorldThumbnail(path: string, dataUrl: string): Promise<void> {
  if (!inTauri()) return;
  return invoke<void>('save_world_thumbnail', { path, dataUrl });
}

export async function resetWorldThumbnail(path: string): Promise<void> {
  if (!inTauri()) return;
  return invoke<void>('reset_world_thumbnail', { path });
}

export async function resetWorldRender(path: string): Promise<void> {
  if (!inTauri()) return;
  return invoke<void>('reset_world_render', { path });
}

export async function listRenders(): Promise<RenderEntry[]> {
  if (!inTauri()) return mockRenders;
  return invoke<RenderEntry[]>('list_renders');
}

export async function deleteRender(id: string): Promise<void> {
  if (!inTauri()) {
    const index = mockRenders.findIndex((render) => render.id === id);
    if (index >= 0) mockRenders.splice(index, 1);
    return;
  }
  return invoke<void>('delete_render', { id });
}

export async function openRender(id: string): Promise<RenderReady> {
  if (!inTauri()) throw new Error('Renders open in the native Vantage window.');
  return invoke<RenderReady>('open_render', { id });
}

/** Shows a world save or a generated render in the OS file manager. */
export async function revealPath(path: string): Promise<void> {
  if (!inTauri()) throw new Error('Opening folders needs the native Vantage window.');
  return invoke<void>('reveal_path', { path });
}

export async function saveMapImage(name: string, dataUrl: string): Promise<SavedImage> {
  if (!inTauri()) throw new Error('Saving images needs the native Vantage window.');
  return invoke<SavedImage>('save_map_image', { name, dataUrl });
}

export async function getSystemProfile(): Promise<SystemProfile> {
  if (!inTauri()) {
    return {
      logicalCores: navigator.hardwareConcurrency || 4,
      architecture: 'web preview',
      platform: navigator.platform || 'browser',
    };
  }
  return invoke<SystemProfile>('system_profile');
}

export async function listHosts(): Promise<HostEntry[]> {
  if (!inTauri()) return mockHosts;
  return invoke<HostEntry[]>('list_hosts');
}

export async function saveHost(input: HostInput): Promise<HostEntry> {
  if (!inTauri()) {
    const entry: HostEntry = {
      id: input.id ?? `mock-${mockHosts.length + 1}`,
      label: input.label || new URL(mockEndpoint(input.endpoint)).hostname,
      endpoint: mockEndpoint(input.endpoint),
      worldId: input.worldId || 'default',
      hasToken: Boolean(input.token) && !input.forgetToken,
      addedAtMs: Date.now(),
      lastConnectedMs: null,
    };
    const index = mockHosts.findIndex((host) => host.id === entry.id);
    index >= 0 ? (mockHosts[index] = entry) : mockHosts.push(entry);
    return entry;
  }
  return invoke<HostEntry>('save_host', { input });
}

export async function deleteHost(id: string): Promise<void> {
  if (!inTauri()) {
    const index = mockHosts.findIndex((host) => host.id === id);
    if (index >= 0) mockHosts.splice(index, 1);
    return;
  }
  return invoke<void>('delete_host', { id });
}

export async function probeHost(endpoint: string, token?: string): Promise<HostProbe> {
  if (!inTauri()) {
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    return {
      endpoint: mockEndpoint(endpoint),
      protocol: 1,
      auth: token ? 'bearer' : 'proxy',
      worlds: ['default'],
      unauthorized: false,
      note: null,
    };
  }
  return invoke<HostProbe>('probe_host', { endpoint, token: token || null });
}

export async function connectHost(id: string): Promise<HostConnection> {
  if (!inTauri()) throw new Error('Connecting to a server needs the native Vantage window.');
  return invoke<HostConnection>('connect_host', { id });
}

/**
 * A remote world, streamed through the native side.
 *
 * The viewer only ever asks for manifest-relative paths, and `worldFromHttp`
 * resolves and confines them before handing each one to this transport. The
 * native side confines them again — that is the check that actually gates the
 * credential, since it lives on the side of the boundary that holds it.
 */
export async function remoteWorldSource(connection: HostConnection): Promise<WorldSource> {
  return worldFromHttp(connection.manifestUrl, {
    label: connection.label,
    fetch: (input, init) => hostFetch(connection.id, input, init),
  });
}

/** Status line and validator the native side frames in front of the body. */
interface FramedHeader {
  status: number;
  etag: string | null;
  contentType: string | null;
}

/**
 * One protocol artifact, as a real `Response`.
 *
 * A command answers with a single value and a tile is megabytes of binary, so
 * the native side returns `[u32 length][header JSON][body]` rather than paying
 * to serialize the bytes as JSON numbers.
 */
async function hostFetch(id: string, input: string, init?: RequestInit): Promise<Response> {
  const signal = init?.signal ?? undefined;
  throwIfAborted(signal);
  const framed = await withAbort(
    invoke<ArrayBuffer>('host_fetch', {
      id,
      url: input,
      ifNoneMatch: headerValue(init?.headers, 'if-none-match'),
    }),
    signal,
  );

  const header = parseFrameHeader(framed);
  const body = framed.slice(4 + header.length);
  const headers = new Headers();
  if (header.etag) headers.set('etag', header.etag);
  if (header.contentType) headers.set('content-type', header.contentType);
  // 204/304 are null-body statuses: handing `Response` any body for one of
  // them throws, and the server sends none anyway.
  const nullBody = header.status === 204 || header.status === 304;
  return new Response(nullBody ? null : body, { status: header.status, headers });
}

/**
 * Reads the frame's header, or fails saying so.
 *
 * A truncated buffer or a length that overruns it would otherwise surface deep
 * in the viewer as a `RangeError` on a tile, which reads like a corrupt world
 * rather than a broken reply. Every artifact goes through here, so the check is
 * bounds-only — the header's own fields stay the native side's business.
 */
function parseFrameHeader(framed: ArrayBuffer): FramedHeader & { length: number } {
  const corrupt = () => new Error('Vantage received a malformed reply from the connection.');
  if (framed.byteLength < 4) throw corrupt();
  const length = new DataView(framed).getUint32(0, true);
  if (length > framed.byteLength - 4) throw corrupt();
  try {
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(framed, 4, length))) as FramedHeader;
    if (!Number.isInteger(header?.status)) throw corrupt();
    return { ...header, length };
  } catch {
    throw corrupt();
  }
}

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  return new Headers(headers).get(name);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Settles as soon as the caller gives up.
 *
 * A command in flight cannot be recalled, so the reply is discarded rather than
 * cancelled — but the viewer aborts a tile the moment it pans away from it, and
 * making it wait for a fetch nobody wants would stall the ones it does.
 */
function withAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export async function onRenderProgress(handler: (progress: RenderProgress) => void): Promise<UnlistenFn> {
  if (!inTauri()) return () => {};
  return listen<RenderProgress>('render-progress', (event) => handler(event.payload));
}

export interface UpdateProgress {
  downloaded: number;
  /** Null until the server reports a content length. */
  total: number | null;
}

/** A newer Vantage release, ready to download and install. */
export interface AppUpdate {
  version: string;
  install: (onProgress: (progress: UpdateProgress) => void) => Promise<void>;
}

/**
 * Asks the release feed for a newer build. Resolves null when this build is
 * current, and rejects when there is no feed to ask — no release published
 * yet, offline, or a Linux install that did not come from the AppImage.
 * Callers treat a rejection like "no update"; it must never reach the UI.
 *
 * The plugins are imported lazily so the browser preview (and its mock) never
 * pulls Tauri-only modules. Set VITE_MOCK_UPDATE=1 to exercise the update UI
 * in the preview.
 */
export async function checkForUpdate(): Promise<AppUpdate | null> {
  if (!inTauri()) {
    return import.meta.env.VITE_MOCK_UPDATE === '1' ? mockUpdate() : null;
  }
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    install: async (onProgress) => {
      let downloaded = 0;
      let total: number | null = null;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? null;
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          onProgress({ downloaded, total });
        } else if (event.event === 'Finished') {
          onProgress({ downloaded: total ?? downloaded, total });
        }
      });
    },
  };
}

/** Restarts into the newly installed build. On Windows the installer already
 *  closed the app, so this call only returns on macOS and Linux. */
export async function relaunchApp(): Promise<void> {
  if (!inTauri()) return;
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

function mockUpdate(): AppUpdate {
  return {
    version: '9.9.9',
    install: async (onProgress) => {
      const total = 48 * 1024 * 1024;
      for (let step = 0; step <= 24; step += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 90));
        onProgress({ downloaded: (total / 24) * step, total });
      }
    },
  };
}
