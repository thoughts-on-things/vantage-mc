import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { DesktopSettings } from './settings.js';

/** The geometry-affecting settings a render was baked with. */
export interface RenderSignature {
  fullCaves: boolean;
  smoothLighting: boolean;
  biomeBlend: boolean;
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
    renderSettings: { fullCaves: true, smoothLighting: true, biomeBlend: true },
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
    settings: { fullCaves: true, smoothLighting: true, biomeBlend: true },
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

function inTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

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
  if (!inTauri()) throw new Error('Cached renders are available in the Tauri desktop window.');
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

export async function onRenderProgress(handler: (progress: RenderProgress) => void): Promise<UnlistenFn> {
  if (!inTauri()) return () => {};
  return listen<RenderProgress>('render-progress', (event) => handler(event.payload));
}
