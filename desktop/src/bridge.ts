import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface WorldInfo {
  path: string;
  name: string;
  lastPlayedMs: number;
  dataVersion: number;
  source: string;
  iconPath: string | null;
  iconUrl: string | null;
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

const mockWorlds: WorldInfo[] = [
  {
    path: 'C:\\Users\\you\\AppData\\Roaming\\.minecraft\\saves\\Green Valley',
    name: 'Green Valley',
    lastPlayedMs: Date.now() - 1000 * 60 * 18,
    dataVersion: 4554,
    source: 'vanilla',
    iconPath: null,
    iconUrl: null,
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

export async function renderWorld(path: string): Promise<RenderReady> {
  if (!inTauri()) throw new Error('Rendering is available in the Tauri desktop window.');
  return invoke<RenderReady>('render_world', { path });
}

export async function openCachedWorld(path: string): Promise<RenderReady> {
  if (!inTauri()) throw new Error('Cached renders are available in the Tauri desktop window.');
  return invoke<RenderReady>('open_cached_world', { path });
}

export async function onRenderProgress(handler: (progress: RenderProgress) => void): Promise<UnlistenFn> {
  if (!inTauri()) return () => {};
  return listen<RenderProgress>('render-progress', (event) => handler(event.payload));
}
