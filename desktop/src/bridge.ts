import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { DesktopSettings } from './settings.js';

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

export interface SystemProfile {
  logicalCores: number;
  architecture: string;
  platform: string;
}

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
  },
  {
    path: 'C:\\Users\\you\\PrismLauncher\\instances\\Create\\minecraft\\saves\\Copper Hills',
    name: 'Copper Hills',
    lastPlayedMs: Date.now() - 1000 * 60 * 60 * 26,
    dataVersion: 4189,
    source: 'prism',
    iconPath: null,
    iconUrl: null,
    thumbnailUrl: null,
    cached: true,
  },
];

function inTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

export async function discoverWorlds(): Promise<WorldInfo[]> {
  if (!inTauri()) return mockWorlds;
  return invoke<WorldInfo[]>('discover_worlds');
}

export async function renderWorld(path: string, settings: DesktopSettings, threadCount: number | null): Promise<RenderReady> {
  if (!inTauri()) {
    // Leave the loading state visible long enough to exercise it in the fast
    // browser preview; native rendering is intentionally unavailable there.
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    throw new Error('Rendering is available in the native Vantage window.');
  }
  return invoke<RenderReady>('render_world', { path, settings: { ...settings, threadCount } });
}

export async function openCachedWorld(path: string, settings: DesktopSettings): Promise<RenderReady> {
  if (!inTauri()) throw new Error('Cached renders are available in the Tauri desktop window.');
  return invoke<RenderReady>('open_cached_world', { path, settings });
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
