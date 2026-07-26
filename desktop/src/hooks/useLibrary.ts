import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  cancelRender,
  deleteRender,
  discoverWorlds,
  getSystemProfile,
  listRenders,
  onRenderProgress,
  openCachedWorld,
  openRender,
  renderWorld,
  resetWorldRender,
  resetWorldThumbnail,
  revealPath,
  type RenderEntry,
  type RenderProgress,
  type SystemProfile,
  type WorldInfo,
} from '../bridge.js';
import { userFacingError, type WorldAction, type WorldActionKind } from '../lib/format.js';
import { arrangeWorlds, loadLibraryView, saveLibraryView, type LibraryView } from '../lib/library.js';
import { renderThreadCount } from '../lib/renderProfile.js';
import type { DesktopSettings } from '../settings.js';

export type Screen = 'library' | 'renders';

/** Preloading the viewer chunk while the native side works hides the lazy-load cost. */
export const loadViewer = () => import('../ViewerScreen.js');

/** What the viewer screen is currently showing. */
export interface ViewerTarget {
  world: WorldInfo;
  manifestUrl: string;
  /** False for renders opened without their save, which have no cache to write. */
  captureThumbnail: boolean;
}

export interface LibraryController {
  worlds: WorldInfo[];
  filtered: WorldInfo[];
  query: string;
  setQuery: (query: string) => void;
  view: LibraryView;
  setView: (view: LibraryView) => void;
  selected: WorldInfo | null;
  selectedPath: string | null;
  selectPath: (path: string) => void;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  dismissError: () => void;
  progress: RenderProgress | null;
  action: WorldAction | null;
  cancelling: boolean;
  system: SystemProfile;
  screen: Screen;
  goTo: (screen: Screen) => void;
  viewer: ViewerTarget | null;
  renders: RenderEntry[];
  rendersLoading: boolean;
  refresh: (quiet?: boolean) => Promise<void>;
  refreshRenders: () => Promise<void>;
  openWorld: (world: WorldInfo) => Promise<void>;
  rerenderWorld: (world: WorldInfo) => Promise<void>;
  stopRender: () => Promise<void>;
  regenerateThumbnail: (world: WorldInfo) => Promise<void>;
  resetRenderCache: (world: WorldInfo) => Promise<void>;
  openRenderEntry: (entry: RenderEntry) => Promise<void>;
  removeRender: (entry: RenderEntry) => Promise<void>;
  reveal: (path: string) => Promise<void>;
  updateWorldThumbnail: (path: string, thumbnailUrl: string) => void;
  closeViewer: () => void;
  /** Read-only live view of the action lock for event handlers. */
  actionRef: RefObject<WorldAction | null>;
}

/**
 * All library state and world actions. Every returned callback is referentially
 * stable (current settings are read through a ref), so memoized world cards
 * skip re-rendering while render-progress events stream in.
 */
export function useLibrary(settings: DesktopSettings): LibraryController {
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [renders, setRenders] = useState<RenderEntry[]>([]);
  const [rendersLoading, setRendersLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [view, setViewState] = useState<LibraryView>(loadLibraryView);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const [screen, setScreen] = useState<Screen>('library');
  const [cancelling, setCancelling] = useState(false);
  const [action, setAction] = useState<WorldAction | null>(null);
  const [system, setSystem] = useState<SystemProfile>({
    logicalCores: navigator.hardwareConcurrency || 4,
    architecture: 'native',
    platform: 'windows',
  });

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const systemRef = useRef(system);
  systemRef.current = system;

  // The action lock lives in a ref so two clicks in the same event cycle can
  // never claim it twice; the state mirror only drives the UI.
  const actionRef = useRef<WorldAction | null>(null);
  const cancelledRender = useRef(false);
  const cancelInFlight = useRef(false);

  const deferredQuery = useDeferredValue(query);
  const filtered = useMemo(() => arrangeWorlds(worlds, deferredQuery, view), [deferredQuery, view, worlds]);

  const selected = worlds.find((world) => world.path === selectedPath) ?? null;

  const claimAction = useCallback((path: string, kind: WorldActionKind): boolean => {
    if (actionRef.current) return false;
    actionRef.current = { path, kind };
    setAction(actionRef.current);
    return true;
  }, []);

  const updateAction = useCallback((path: string, kind: WorldActionKind) => {
    if (actionRef.current?.path !== path) return;
    actionRef.current = { path, kind };
    setAction(actionRef.current);
  }, []);

  const releaseAction = useCallback((path: string) => {
    if (actionRef.current?.path !== path) return;
    actionRef.current = null;
    setAction(null);
  }, []);

  const patchWorld = useCallback((path: string, patch: Partial<WorldInfo>) => {
    setWorlds((current) => current.map((world) => (world.path === path ? { ...world, ...patch } : world)));
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const next = await discoverWorlds();
      setWorlds(next);
      setSelectedPath((current) => (current && next.some((world) => world.path === current) ? current : next[0]?.path ?? null));
    } catch (reason) {
      setError(userFacingError(reason));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const refreshRenders = useCallback(async () => {
    setRendersLoading(true);
    setError(null);
    try {
      setRenders(await listRenders());
    } catch (reason) {
      setError(userFacingError(reason));
    } finally {
      setRendersLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void getSystemProfile().then(setSystem);
    let dispose: (() => void) | undefined;
    void onRenderProgress(setProgress).then((unlisten) => (dispose = unlisten));
    return () => dispose?.();
  }, [refresh]);

  const setView = useCallback((next: LibraryView) => {
    setViewState(next);
    saveLibraryView(next);
  }, []);

  const goTo = useCallback((next: Screen) => {
    setScreen(next);
    // The renders list ages the moment anything is rendered or reset, so it is
    // re-read on every visit rather than cached across screens.
    if (next === 'renders') void refreshRenders();
  }, [refreshRenders]);

  const renderClaimedWorld = useCallback(async (target: WorldInfo) => {
    updateAction(target.path, 'rendering');
    setSelectedPath(target.path);
    setError(null);
    cancelledRender.current = false;
    cancelInFlight.current = false;
    setCancelling(false);
    patchWorld(target.path, { thumbnailUrl: null });
    setProgress({ phase: 'scanning', completed: 0, total: 0, worldPath: target.path });
    try {
      const threads = renderThreadCount(settingsRef.current.performanceMode, systemRef.current.logicalCores);
      const [ready] = await Promise.all([renderWorld(target, settingsRef.current, threads), loadViewer()]);
      patchWorld(target.path, {
        cached: true,
        renderedAtMs: Date.now(),
        renderSettings: {
          fullCaves: settingsRef.current.fullCaves,
          smoothLighting: settingsRef.current.smoothLighting,
          biomeBlend: settingsRef.current.biomeBlend,
        },
      });
      // The render invalidated the old preview above. Pass the same state to
      // the viewer so ThumbnailCapture cannot mistake the stale URL on the
      // caller's snapshot for a preview of the newly rendered map.
      setViewer({ world: { ...target, thumbnailUrl: null }, manifestUrl: ready.manifestUrl, captureThumbnail: true });
    } catch (reason) {
      setProgress(null);
      if (!cancelledRender.current) setError(userFacingError(reason));
    } finally {
      cancelInFlight.current = false;
      setCancelling(false);
      releaseAction(target.path);
    }
  }, [patchWorld, releaseAction, updateAction]);

  const openWorld = useCallback(async (target: WorldInfo) => {
    if (!claimAction(target.path, target.cached ? 'opening' : 'rendering')) return;
    if (!target.cached) return renderClaimedWorld(target);
    setSelectedPath(target.path);
    setError(null);
    try {
      const [outcome] = await Promise.all([openCachedWorld(target.path, settingsRef.current), loadViewer()]);
      if (outcome.status === 'ready') {
        setViewer({ world: target, manifestUrl: outcome.manifestUrl, captureThumbnail: true });
        return;
      }
      // The cached map cannot answer for the current settings; rebuild it while
      // still holding the claimed action.
      await renderClaimedWorld(target);
    } catch (reason) {
      // A real failure (missing endpoint, unreadable cache) is worth showing
      // instead of silently spending minutes on a re-render.
      setError(userFacingError(reason));
    } finally {
      releaseAction(target.path);
    }
  }, [claimAction, releaseAction, renderClaimedWorld]);

  const rerenderWorld = useCallback(async (target: WorldInfo) => {
    if (!claimAction(target.path, 'rendering')) return;
    await renderClaimedWorld(target);
  }, [claimAction, renderClaimedWorld]);

  const stopRender = useCallback(async () => {
    if (actionRef.current?.kind !== 'rendering' || cancelInFlight.current) return;
    cancelInFlight.current = true;
    cancelledRender.current = true;
    setCancelling(true);
    try {
      await cancelRender();
    } finally {
      setProgress(null);
    }
  }, []);

  const regenerateThumbnail = useCallback(async (target: WorldInfo) => {
    if (!target.cached || !claimAction(target.path, 'thumbnail')) return;
    setSelectedPath(target.path);
    setError(null);
    try {
      await resetWorldThumbnail(target.path);
      patchWorld(target.path, { thumbnailUrl: null });
      updateAction(target.path, 'opening');
      const [outcome] = await Promise.all([openCachedWorld(target.path, settingsRef.current), loadViewer()]);
      if (outcome.status === 'ready') {
        setViewer({ world: { ...target, thumbnailUrl: null }, manifestUrl: outcome.manifestUrl, captureThumbnail: true });
        return;
      }
      await renderClaimedWorld(target);
    } catch (reason) {
      setError(userFacingError(reason));
    } finally {
      releaseAction(target.path);
    }
  }, [claimAction, patchWorld, releaseAction, renderClaimedWorld, updateAction]);

  const resetRenderCache = useCallback(async (target: WorldInfo) => {
    if (!target.cached || !claimAction(target.path, 'resetting')) return;
    setSelectedPath(target.path);
    setError(null);
    try {
      await resetWorldRender(target.path);
      setProgress(null);
      patchWorld(target.path, { cached: false, thumbnailUrl: null, renderedAtMs: null, renderSettings: null });
      setRenders((current) => current.filter((entry) => entry.worldPath !== target.path));
    } catch (reason) {
      setError(userFacingError(reason));
    } finally {
      releaseAction(target.path);
    }
  }, [claimAction, patchWorld, releaseAction]);

  const openRenderEntry = useCallback(async (entry: RenderEntry) => {
    // A render whose save is still installed opens as that world, so the
    // viewer can refresh its thumbnail and the library stays in sync.
    const world = entry.worldPath ? worlds.find((candidate) => candidate.path === entry.worldPath) : undefined;
    if (world) return openWorld(world);
    if (!claimAction(entry.id, 'opening')) return;
    setError(null);
    try {
      const [ready] = await Promise.all([openRender(entry.id), loadViewer()]);
      setViewer({ world: worldFromRender(entry), manifestUrl: ready.manifestUrl, captureThumbnail: false });
    } catch (reason) {
      setError(userFacingError(reason));
    } finally {
      releaseAction(entry.id);
    }
  }, [claimAction, openWorld, releaseAction, worlds]);

  const removeRender = useCallback(async (entry: RenderEntry) => {
    if (!claimAction(entry.id, 'resetting')) return;
    setError(null);
    try {
      await deleteRender(entry.id);
      setRenders((current) => current.filter((candidate) => candidate.id !== entry.id));
      if (entry.worldPath) {
        patchWorld(entry.worldPath, { cached: false, thumbnailUrl: null, renderedAtMs: null, renderSettings: null });
      }
    } catch (reason) {
      setError(userFacingError(reason));
    } finally {
      releaseAction(entry.id);
    }
  }, [claimAction, patchWorld, releaseAction]);

  const reveal = useCallback(async (path: string) => {
    setError(null);
    try {
      await revealPath(path);
    } catch (reason) {
      setError(userFacingError(reason));
    }
  }, []);

  const updateWorldThumbnail = useCallback((path: string, thumbnailUrl: string) => {
    patchWorld(path, { thumbnailUrl });
  }, [patchWorld]);

  const closeViewer = useCallback(() => {
    setViewer(null);
    setProgress(null);
  }, []);

  const selectPath = useCallback((path: string) => setSelectedPath(path), []);
  const dismissError = useCallback(() => setError(null), []);

  return {
    worlds,
    filtered,
    query,
    setQuery,
    view,
    setView,
    selected,
    selectedPath,
    selectPath,
    loading,
    refreshing,
    error,
    dismissError,
    progress,
    action,
    cancelling,
    system,
    screen,
    goTo,
    viewer,
    renders,
    rendersLoading,
    refresh,
    refreshRenders,
    openWorld,
    rerenderWorld,
    stopRender,
    regenerateThumbnail,
    resetRenderCache,
    openRenderEntry,
    removeRender,
    reveal,
    updateWorldThumbnail,
    closeViewer,
    actionRef,
  };
}

/** A viewer-shaped world for a render whose save is no longer installed. */
function worldFromRender(entry: RenderEntry): WorldInfo {
  return {
    path: entry.worldPath ?? entry.path,
    name: entry.worldName,
    lastPlayedMs: 0,
    dataVersion: 0,
    source: 'render',
    iconPath: null,
    iconUrl: null,
    thumbnailUrl: entry.thumbnailUrl,
    cached: true,
    renderedAtMs: entry.renderedAtMs,
    renderSettings: entry.settings,
  };
}
