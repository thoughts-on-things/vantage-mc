export type PerformanceMode = 'efficient' | 'balanced' | 'maximum';

export interface DesktopSettings {
  performanceMode: PerformanceMode;
  fullCaves: boolean;
  smoothLighting: boolean;
  biomeBlend: boolean;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  performanceMode: 'balanced',
  fullCaves: true,
  smoothLighting: true,
  biomeBlend: true,
};

const STORAGE_KEY = 'vantage.desktop.settings.v1';

export function loadSettings(): DesktopSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<DesktopSettings>;
    return {
      performanceMode: ['efficient', 'balanced', 'maximum'].includes(saved.performanceMode ?? '')
        ? saved.performanceMode!
        : DEFAULT_SETTINGS.performanceMode,
      fullCaves: typeof saved.fullCaves === 'boolean' ? saved.fullCaves : DEFAULT_SETTINGS.fullCaves,
      smoothLighting: typeof saved.smoothLighting === 'boolean' ? saved.smoothLighting : DEFAULT_SETTINGS.smoothLighting,
      biomeBlend: typeof saved.biomeBlend === 'boolean' ? saved.biomeBlend : DEFAULT_SETTINGS.biomeBlend,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: DesktopSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function renderThreadCount(mode: PerformanceMode, logicalCores: number): number | null {
  const cores = Math.max(1, logicalCores);
  if (mode === 'efficient') return Math.max(1, Math.ceil(cores / 2));
  if (mode === 'maximum') return cores;
  // Let the native planner balance the CPU count against its measured per-tile
  // memory budget. This is usually all cores, but safely backs off on small PCs.
  return null;
}
