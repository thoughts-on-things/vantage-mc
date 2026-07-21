import type { DisplaySettings, StreamingSettings } from 'vantage-mc/react';
import type { PerformanceMode } from '../settings.js';

/**
 * Everything the performance mode controls, for both halves of the app:
 * the Zig bake thread count and the GPU viewer's streaming/display budgets.
 */
export interface RenderProfile {
  name: 'efficient' | 'balanced' | 'high';
  maxPixelRatio: number;
  streaming: Required<StreamingSettings>;
  display: DisplaySettings;
}

/** Thread count passed to the Zig sidecar; null lets the native planner decide. */
export function renderThreadCount(mode: PerformanceMode, logicalCores: number): number | null {
  const cores = Math.max(1, logicalCores);
  if (mode === 'efficient') return Math.max(1, Math.ceil(cores / 2));
  if (mode === 'maximum') return cores;
  // Let the native planner balance the CPU count against its measured per-tile
  // memory budget. This is usually all cores, but safely backs off on small PCs.
  return null;
}

const MiB = 1024 * 1024;
const BASE_DISPLAY: DisplaySettings = { sharpness: 0.08, ao: 1.05, saturation: 1.03, contrast: 1.02, fog: 0.92, renderScale: 1 };

export function selectRenderProfile(mode: PerformanceMode, nativeCores: number): RenderProfile {
  const cores = Math.max(nativeCores, navigator.hardwareConcurrency || 4);
  const dpr = window.devicePixelRatio || 1;

  if (mode === 'efficient') {
    return {
      name: 'efficient',
      maxPixelRatio: Math.min(1.35, dpr),
      streaming: { viewDistance: 640, maxTiles: 84, concurrency: Math.max(2, Math.min(4, cores - 1)), maxBytes: 320 * MiB, tileCacheBytes: 96 * MiB, mapMemory: 32 },
      display: BASE_DISPLAY,
    };
  }
  if (mode === 'maximum') {
    return {
      name: 'high',
      maxPixelRatio: Math.min(2.5, dpr),
      streaming: { viewDistance: 1408, maxTiles: 400, concurrency: Math.min(12, Math.max(6, Math.floor(cores * 0.75))), maxBytes: 1024 * MiB, tileCacheBytes: 384 * MiB, mapMemory: 128 },
      display: { ...BASE_DISPLAY, renderScale: dpr < 1.5 ? 1.15 : 1 },
    };
  }
  return {
    name: 'balanced',
    maxPixelRatio: Math.min(1.75, dpr),
    streaming: { viewDistance: 768, maxTiles: 120, concurrency: Math.min(6, Math.max(3, Math.floor(cores / 2))), maxBytes: 512 * MiB, tileCacheBytes: 192 * MiB, mapMemory: 64 },
    display: BASE_DISPLAY,
  };
}
