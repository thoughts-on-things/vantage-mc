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
const PERFORMANCE_MODES: readonly PerformanceMode[] = ['efficient', 'balanced', 'maximum'];

export function loadSettings(): DesktopSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<DesktopSettings>;
    return {
      performanceMode: PERFORMANCE_MODES.includes(saved.performanceMode!) ? saved.performanceMode! : DEFAULT_SETTINGS.performanceMode,
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
