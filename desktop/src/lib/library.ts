import type { RenderSignature, WorldInfo } from '../bridge.js';
import type { DesktopSettings } from '../settings.js';

/**
 * How a world's cached render relates to the world right now.
 *
 * - `none` — nothing cached.
 * - `ready` — the render matches both the save and the current settings.
 * - `outdated` — the save has been played since the render was baked.
 * - `settings` — the render was baked with different geometry settings, so
 *   opening it triggers a rebuild.
 */
export type RenderState = 'none' | 'ready' | 'outdated' | 'settings';

/**
 * `LastPlayed` is written when Minecraft saves, which can land a moment after
 * a render of that same session finishes. Anything inside this window is the
 * same play session, not a change worth flagging.
 */
const PLAYED_SINCE_GRACE_MS = 5 * 60 * 1000;

export function renderState(world: WorldInfo, settings: DesktopSettings): RenderState {
  if (!world.cached) return 'none';
  if (world.renderSettings && !sameSignature(world.renderSettings, settings)) return 'settings';
  if (world.renderedAtMs && world.lastPlayedMs > world.renderedAtMs + PLAYED_SINCE_GRACE_MS) return 'outdated';
  return 'ready';
}

export function sameSignature(signature: RenderSignature, settings: DesktopSettings): boolean {
  return (
    signature.fullCaves === settings.fullCaves &&
    signature.smoothLighting === settings.smoothLighting &&
    signature.biomeBlend === settings.biomeBlend
  );
}

export const RENDER_STATE_COPY: Record<RenderState, { badge: string; detail: string }> = {
  none: { badge: '', detail: 'This world has not been rendered yet.' },
  ready: { badge: 'rendered', detail: 'Your render matches this save.' },
  outdated: { badge: 'played since', detail: 'This world was played after its render — re-render to see the new chunks.' },
  settings: { badge: 'settings changed', detail: 'This render used different detail settings; opening it rebuilds the map.' },
};

export type SortMode = 'recent' | 'name' | 'rendered';
export type FilterMode = 'all' | 'rendered' | 'unrendered';

export interface LibraryView {
  sort: SortMode;
  filter: FilterMode;
}

export const DEFAULT_VIEW: LibraryView = { sort: 'recent', filter: 'all' };

export const SORT_LABELS: Record<SortMode, string> = {
  recent: 'Recently played',
  name: 'Name',
  rendered: 'Recently rendered',
};

export const FILTER_LABELS: Record<FilterMode, string> = {
  all: 'All',
  rendered: 'Rendered',
  unrendered: 'Not rendered',
};

const VIEW_KEY = 'vantage.desktop.library-view.v1';

export function loadLibraryView(): LibraryView {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Partial<LibraryView>;
    return {
      sort: saved.sort && saved.sort in SORT_LABELS ? saved.sort : DEFAULT_VIEW.sort,
      filter: saved.filter && saved.filter in FILTER_LABELS ? saved.filter : DEFAULT_VIEW.filter,
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function saveLibraryView(view: LibraryView): void {
  localStorage.setItem(VIEW_KEY, JSON.stringify(view));
}

/** Search, filter, and sort in one pass so the grid order is stable. */
export function arrangeWorlds(worlds: WorldInfo[], query: string, view: LibraryView): WorldInfo[] {
  const needle = query.trim().toLocaleLowerCase();
  const matched = worlds.filter((world) => {
    if (view.filter === 'rendered' && !world.cached) return false;
    if (view.filter === 'unrendered' && world.cached) return false;
    if (!needle) return true;
    return `${world.name} ${world.path} ${world.source}`.toLocaleLowerCase().includes(needle);
  });
  return matched.sort(comparator(view.sort));
}

function comparator(sort: SortMode): (left: WorldInfo, right: WorldInfo) => number {
  if (sort === 'name') return (left, right) => left.name.localeCompare(right.name, undefined, { numeric: true });
  if (sort === 'rendered') {
    // Rendered worlds first, newest render first; unrendered worlds keep their
    // recently-played order at the bottom rather than being shuffled.
    return (left, right) =>
      (right.renderedAtMs ?? 0) - (left.renderedAtMs ?? 0) || right.lastPlayedMs - left.lastPlayedMs;
  }
  return (left, right) => right.lastPlayedMs - left.lastPlayedMs;
}
