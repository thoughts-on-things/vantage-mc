import type { RenderProgress } from '../bridge.js';

/** One in-flight operation per world; the kind drives copy and progress UI. */
export type WorldActionKind = 'opening' | 'rendering' | 'resetting' | 'thumbnail';

export interface WorldAction {
  path: string;
  kind: WorldActionKind;
}

const SOURCE_LABELS: Record<string, string> = {
  vanilla: 'Minecraft',
  prism: 'Prism',
  multimc: 'MultiMC',
  curseforge: 'CurseForge',
  modrinth: 'Modrinth',
  gdlauncher: 'GDLauncher',
  beacon: 'Beacon',
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export const phaseCopy: Record<RenderProgress['phase'], string> = {
  idle: 'Preparing',
  scanning: 'Scanning regions',
  tiles: 'Building terrain',
  lowres: 'Creating world overview',
  finalizing: 'Packing textures',
  done: 'Ready',
  failed: 'Render failed',
};

export function worldActionLabel(action: WorldActionKind): string {
  return ({ opening: 'Opening', rendering: 'Rendering', resetting: 'Resetting', thumbnail: 'Refreshing preview' })[action];
}

export function actionHint(action: WorldActionKind): string {
  if (action === 'opening') return 'Your world will open as soon as the GPU is ready.';
  if (action === 'thumbnail') return 'The existing render is kept; only its preview is replaced.';
  if (action === 'resetting') return 'Only Vantage-generated files are being removed.';
  return 'You can keep Vantage open while the native engine works.';
}

export function userFacingError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/another world is already rendering/i.test(message)) {
    return 'The current render is still finishing. Cancel it or wait for it to complete before opening another world.';
  }
  return message;
}

export function relativeTime(timestamp: number): string {
  if (!timestamp) return 'Last played unknown';
  const minutes = Math.max(1, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `Played ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Played ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Played ${days}d ago`;
  return `Played ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp)}`;
}

/** "3 days ago" style age for a render, in the past tense the UI reads in. */
export function renderAge(timestamp: number | null): string {
  if (!timestamp) return 'Unknown date';
  const minutes = Math.max(1, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(timestamp);
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Sizes are scanned, not audited: one decimal below 10 units, none above.
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** File-name stem for an exported map image, in the user's local time. */
export function imageFileStem(worldName: string, date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${worldName} ${stamp}`;
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export function compactNumber(value: number): string {
  return compact.format(value);
}
