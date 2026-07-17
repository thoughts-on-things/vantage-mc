import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  cancelRender,
  discoverWorlds,
  getSystemProfile,
  onRenderProgress,
  openCachedWorld,
  renderWorld,
  resetWorldRender,
  resetWorldThumbnail,
  type RenderProgress,
  type SystemProfile,
  type WorldInfo,
} from '../bridge.js';
import { userFacingError, type WorldAction, type WorldActionKind } from '../lib/format.js';
import { renderThreadCount } from '../lib/renderProfile.js';
import type { DesktopSettings } from '../settings.js';

export type Screen = 'library' | 'viewer';

/** Preloading the viewer chunk while the native side works hides the lazy-load cost. */
export const loadViewer = () => import('../ViewerScreen.js');

export interface LibraryController {
  worlds: WorldInfo[];
  filtered: WorldInfo[];
  query: string;
  setQuery: (query: string) => void;
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
  manifestUrl: string | null;
  refresh: (quiet?: boolean) => Promise<void>;
  openWorld: (world: WorldInfo) => Promise<void>;
  stopRender: () => Promise<void>;
  regenerateThumbnail: (world: WorldInfo) => Promise<void>;
  resetRenderCache: (world: WorldInfo) => Promise<void>;
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
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [manifestUrl, setManifestUrl] = useState<string | null>(null);
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
  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase();
    if (!needle) return worlds;
    return worlds.filter((world) => `${world.name} ${world.path} ${world.source}`.toLocaleLowerCase().includes(needle));
  }, [deferredQuery, worlds]);

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

  useEffect(() => {
    void refresh();
    void getSystemProfile().then(setSystem);
    let dispose: (() => void) | undefined;
    void onRenderProgress(setProgress).then((unlisten) => (dispose = unlisten));
    return () => dispose?.();
  }, [refresh]);

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
      const [ready] = await Promise.all([renderWorld(target.path, settingsRef.current, threads), loadViewer()]);
      setManifestUrl(ready.manifestUrl);
      patchWorld(target.path, { cached: true });
      setScreen('viewer');
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
      const [ready] = await Promise.all([openCachedWorld(target.path, settingsRef.current), loadViewer()]);
      setManifestUrl(ready.manifestUrl);
      setScreen('viewer');
    } catch {
      // The cache is stale or unreadable (e.g. render settings changed); fall
      // back to a fresh render while still holding the claimed action.
      await renderClaimedWorld(target);
    } finally {
      releaseAction(target.path);
    }
  }, [claimAction, releaseAction, renderClaimedWorld]);

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
      const [ready] = await Promise.all([openCachedWorld(target.path, settingsRef.current), loadViewer()]);
      setManifestUrl(ready.manifestUrl);
      setScreen('viewer');
    } catch (reason) {
      setError(userFacingError(reason));
    } finally {
      releaseAction(target.path);
    }
  }, [claimAction, patchWorld, releaseAction, updateAction]);

  const resetRenderCache = useCallback(async (target: WorldInfo) => {
    if (!target.cached || !claimAction(target.path, 'resetting')) return;
    setSelectedPath(target.path);
    setError(null);
    try {
      await resetWorldRender(target.path);
      setManifestUrl(null);
      setProgress(null);
      patchWorld(target.path, { cached: false, thumbnailUrl: null });
    } catch (reason) {
      setError(userFacingError(reason));
    } finally {
      releaseAction(target.path);
    }
  }, [claimAction, patchWorld, releaseAction]);

  const updateWorldThumbnail = useCallback((path: string, thumbnailUrl: string) => {
    patchWorld(path, { thumbnailUrl });
  }, [patchWorld]);

  const closeViewer = useCallback(() => {
    setScreen('library');
    setProgress(null);
  }, []);

  const selectPath = useCallback((path: string) => setSelectedPath(path), []);
  const dismissError = useCallback(() => setError(null), []);

  return {
    worlds,
    filtered,
    query,
    setQuery,
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
    manifestUrl,
    refresh,
    openWorld,
    stopRender,
    regenerateThumbnail,
    resetRenderCache,
    updateWorldThumbnail,
    closeViewer,
    actionRef,
  };
}
