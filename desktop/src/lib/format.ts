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

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export function compactNumber(value: number): string {
  return compact.format(value);
}
