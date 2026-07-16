import { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Check,
  ChevronRight,
  Compass,
  Cpu,
  FolderSearch,
  ImageIcon,
  Layers3,
  LoaderCircle,
  Map,
  Play,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  cancelRender,
  discoverWorlds,
  getSystemProfile,
  onRenderProgress,
  openCachedWorld,
  resetWorldRender,
  resetWorldThumbnail,
  renderWorld,
  type RenderProgress,
  type SystemProfile,
  type WorldInfo,
} from './bridge.js';
import { SettingsSheet } from './SettingsSheet.js';
import { loadSettings, renderThreadCount, saveSettings, type DesktopSettings } from './settings.js';

type Screen = 'library' | 'viewer';
type WorldActionKind = 'opening' | 'rendering' | 'resetting' | 'thumbnail';
interface WorldAction { path: string; kind: WorldActionKind }
const loadViewer = () => import('./ViewerScreen.js');
const ViewerScreen = lazy(loadViewer);

const phaseCopy: Record<RenderProgress['phase'], string> = {
  idle: 'Preparing',
  scanning: 'Scanning regions',
  tiles: 'Building terrain',
  lowres: 'Creating world overview',
  finalizing: 'Packing textures',
  done: 'Ready',
  failed: 'Render failed',
};

export function App() {
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [manifestUrl, setManifestUrl] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>('library');
  const [settings, setSettings] = useState<DesktopSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [system, setSystem] = useState<SystemProfile>({ logicalCores: navigator.hardwareConcurrency || 4, architecture: 'native', platform: 'windows' });
  const [cancelling, setCancelling] = useState(false);
  const [worldAction, setWorldAction] = useState<WorldAction | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const cancelledRender = useRef(false);
  const worldActionRef = useRef<WorldAction | null>(null);
  const cancelInFlightRef = useRef(false);
  const deferredQuery = useDeferredValue(query);

  const selected = worlds.find((world) => world.path === selectedPath) ?? null;
  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase();
    if (!needle) return worlds;
    return worlds.filter((world) => `${world.name} ${world.path} ${world.source}`.toLocaleLowerCase().includes(needle));
  }, [deferredQuery, worlds]);

  const refresh = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const next = await discoverWorlds();
      setWorlds(next);
      setSelectedPath((current) => (current && next.some((world) => world.path === current) ? current : next[0]?.path ?? null));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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

  useEffect(() => saveSettings(settings), [settings]);

  const closeSettings = useCallback(() => {
    settingsButtonRef.current?.focus({ preventScroll: true });
    setSettingsOpen(false);
  }, []);

  const claimWorldAction = useCallback((path: string, kind: WorldActionKind): boolean => {
    if (worldActionRef.current) return false;
    const action = { path, kind };
    worldActionRef.current = action;
    setWorldAction(action);
    return true;
  }, []);

  const updateWorldAction = useCallback((path: string, kind: WorldActionKind) => {
    if (worldActionRef.current?.path !== path) return;
    const action = { path, kind };
    worldActionRef.current = action;
    setWorldAction(action);
  }, []);

  const releaseWorldAction = useCallback((path: string) => {
    if (worldActionRef.current?.path !== path) return;
    worldActionRef.current = null;
    setWorldAction(null);
  }, []);

  const updateWorldThumbnail = useCallback((path: string, thumbnailUrl: string) => {
    setWorlds((current) => current.map((world) => (world.path === path ? { ...world, thumbnailUrl } : world)));
  }, []);

  const renderClaimedWorld = useCallback(async (target: WorldInfo) => {
    updateWorldAction(target.path, 'rendering');
    setSelectedPath(target.path);
    setError(null);
    cancelledRender.current = false;
    cancelInFlightRef.current = false;
    setCancelling(false);
    setWorlds((current) => current.map((world) => (world.path === target.path ? { ...world, thumbnailUrl: null } : world)));
    setProgress({ phase: 'scanning', completed: 0, total: 0, worldPath: target.path });
    try {
      const [ready] = await Promise.all([renderWorld(target.path, settings, renderThreadCount(settings.performanceMode, system.logicalCores)), loadViewer()]);
      setManifestUrl(ready.manifestUrl);
      setWorlds((current) => current.map((world) => (world.path === target.path ? { ...world, cached: true } : world)));
      setScreen('viewer');
    } catch (reason) {
      setProgress(null);
      if (!cancelledRender.current) setError(userFacingError(reason));
    } finally {
      cancelInFlightRef.current = false;
      setCancelling(false);
      releaseWorldAction(target.path);
    }
  }, [releaseWorldAction, settings, system.logicalCores, updateWorldAction]);

  const startRender = useCallback(async (target: WorldInfo | null = selected) => {
    if (!target || !claimWorldAction(target.path, 'rendering')) return;
    await renderClaimedWorld(target);
  }, [claimWorldAction, renderClaimedWorld, selected]);

  const openWorld = useCallback(async (target: WorldInfo | null = selected) => {
    if (!target) return;
    if (!target.cached) return startRender(target);
    if (!claimWorldAction(target.path, 'opening')) return;
    setSelectedPath(target.path);
    setError(null);
    try {
      const [ready] = await Promise.all([openCachedWorld(target.path, settings), loadViewer()]);
      setManifestUrl(ready.manifestUrl);
      setScreen('viewer');
    } catch {
      await renderClaimedWorld(target);
    } finally {
      releaseWorldAction(target.path);
    }
  }, [claimWorldAction, releaseWorldAction, renderClaimedWorld, selected, settings, startRender]);

  const stopRender = useCallback(async () => {
    if (worldActionRef.current?.kind !== 'rendering' || cancelInFlightRef.current) return;
    cancelInFlightRef.current = true;
    cancelledRender.current = true;
    setCancelling(true);
    try {
      await cancelRender();
    } finally {
      setProgress(null);
    }
  }, []);

  const regenerateThumbnail = useCallback(async (target: WorldInfo | null = selected) => {
    if (!target?.cached || !claimWorldAction(target.path, 'thumbnail')) return;
    setSelectedPath(target.path);
    setError(null);
    try {
      await resetWorldThumbnail(target.path);
      setWorlds((current) => current.map((world) => (world.path === target.path ? { ...world, thumbnailUrl: null } : world)));
      updateWorldAction(target.path, 'opening');
      const [ready] = await Promise.all([openCachedWorld(target.path, settings), loadViewer()]);
      setManifestUrl(ready.manifestUrl);
      setScreen('viewer');
    } catch (reason) {
      setError(userFacingError(reason));
    } finally {
      releaseWorldAction(target.path);
    }
  }, [claimWorldAction, releaseWorldAction, selected, settings, updateWorldAction]);

  const resetRenderCache = useCallback(async (target: WorldInfo | null = selected) => {
    if (!target?.cached || !claimWorldAction(target.path, 'resetting')) return;
    setSelectedPath(target.path);
    setError(null);
    try {
      await resetWorldRender(target.path);
      setManifestUrl(null);
      setProgress(null);
      setWorlds((current) => current.map((world) => (
        world.path === target.path ? { ...world, cached: false, thumbnailUrl: null } : world
      )));
    } catch (reason) {
      setError(userFacingError(reason));
    } finally {
      releaseWorldAction(target.path);
    }
  }, [claimWorldAction, releaseWorldAction, selected]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches('input, textarea, select, [contenteditable="true"]');
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k' || (event.key === '/' && !typing)) {
        if (worldActionRef.current) return;
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (event.key === 'Escape' && settingsOpen) {
        event.preventDefault();
        closeSettings();
        return;
      }
      if (typing || screen !== 'library' || !filtered.length) return;
      if (worldActionRef.current) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
        const current = Math.max(0, filtered.findIndex((world) => world.path === selectedPath));
        const next = (current + direction + filtered.length) % filtered.length;
        setSelectedPath(filtered[next].path);
        requestAnimationFrame(() => {
          const card = document.querySelector<HTMLElement>(`[data-world-index="${next}"]`);
          card?.focus({ preventScroll: true });
          card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
      } else if (event.key === 'Enter' && !target?.closest('button, [role="button"]')) {
        event.preventDefault();
        void openWorld();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeSettings, filtered, openWorld, screen, selectedPath, settingsOpen]);

  if (screen === 'viewer' && selected && manifestUrl) {
    return (
      <Suspense fallback={<div className="viewer-loading"><LoaderCircle className="spin" /><span>Starting GPU viewer</span></div>}>
        <ViewerScreen
          world={selected}
          manifestUrl={manifestUrl}
          settings={settings}
          system={system}
          hasThumbnail={Boolean(selected.thumbnailUrl)}
          onThumbnail={(thumbnailUrl) => updateWorldThumbnail(selected.path, thumbnailUrl)}
          onBack={() => {
            setScreen('library');
            setProgress(null);
          }}
        />
      </Suspense>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <nav className="nav-list" aria-label="Primary">
          <button className="nav-item active"><Map size={17} /> Worlds <span>{worlds.length}</span></button>
          <button className="nav-item" disabled><Layers3 size={17} /> Renders <em>soon</em></button>
        </nav>
        <div className="sidebar-footer">
          <div className="engine-pill"><span /><b>Zig core</b><small>connected</small></div>
          <button ref={settingsButtonRef} className="icon-button" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings size={18} /></button>
        </div>
      </aside>

      <main className="library">
        <header className="library-header">
          <div>
            <p className="eyebrow">Local library</p>
            <h1>Your worlds</h1>
            <p>Every Java world on this PC, ready to explore.</p>
          </div>
          <div className="header-actions">
            <label className={`search-box${worldAction ? ' disabled' : ''}`}>
              <Search size={17} />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setQuery('');
                    event.currentTarget.blur();
                  }
                }}
                placeholder="Search worlds"
                aria-label="Search worlds"
                disabled={Boolean(worldAction)}
              />
              {query && <button onClick={() => setQuery('')} aria-label="Clear search" disabled={Boolean(worldAction)}><X size={14} /></button>}
              {!query && <kbd>Ctrl K</kbd>}
            </label>
            <button className="icon-button bordered" onClick={() => void refresh(true)} aria-label="Scan again" disabled={Boolean(worldAction)}>
              <RefreshCw size={17} className={refreshing ? 'spin' : ''} />
            </button>
          </div>
        </header>

        {error && <ErrorBanner message={error} onClose={() => setError(null)} />}

        <section className="library-content">
          <div className="world-grid-wrap">
            <div className="section-heading">
              <h2>Discovered</h2>
              <span>{filtered.length} {filtered.length === 1 ? 'world' : 'worlds'}</span>
            </div>
            {loading ? (
              <div className="world-grid"><WorldSkeleton /><WorldSkeleton /><WorldSkeleton /></div>
            ) : filtered.length ? (
              <div className="world-grid">
                {filtered.map((world, index) => (
                  <WorldCard
                    key={world.path}
                    world={world}
                    index={index}
                    selected={selectedPath === world.path}
                    busy={worldAction?.path === world.path ? worldAction.kind : null}
                    locked={Boolean(worldAction)}
                    onSelect={() => setSelectedPath(world.path)}
                    onOpen={() => void openWorld(world)}
                  />
                ))}
              </div>
            ) : (
              <EmptyLibrary searching={Boolean(query)} />
            )}
          </div>

          <WorldDetail
            key={selected?.path ?? 'empty'}
            world={selected}
            progress={progress}
            action={worldAction}
            cancelling={cancelling}
            onOpen={() => void openWorld()}
            onCancel={() => void stopRender()}
            onRegenerateThumbnail={() => void regenerateThumbnail()}
            onResetRender={() => void resetRenderCache()}
          />
        </section>
      </main>
      {settingsOpen && <SettingsSheet settings={settings} system={system} onChange={setSettings} onClose={closeSettings} />}
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark"><span /><span /><span /></div>
      <div><strong>vantage</strong><small>world studio</small></div>
    </div>
  );
}

const WorldCard = memo(function WorldCard({ world, index, selected, busy, locked, onSelect, onOpen }: {
  world: WorldInfo; index: number; selected: boolean; busy: WorldActionKind | null; locked: boolean; onSelect: () => void; onOpen: () => void;
}) {
  return (
    <article
      className={`world-card world-tone-${index % 4}${selected ? ' selected' : ''}${busy ? ' busy' : ''}${locked ? ' locked' : ''}`}
      style={{ '--card-index': Math.min(index, 12) } as React.CSSProperties}
      role="button"
      tabIndex={locked ? -1 : 0}
      aria-pressed={selected}
      aria-disabled={locked}
      aria-label={`${world.name}, ${world.cached ? 'render ready' : 'not rendered'}`}
      data-world-index={index}
      onClick={() => { if (!locked) onSelect(); }}
      onDoubleClick={() => { if (!locked) onOpen(); }}
      onPointerEnter={() => { if (world.cached) void loadViewer(); }}
      onFocus={() => { if (!locked) onSelect(); if (world.cached) void loadViewer(); }}
      onKeyDown={(event) => {
        if (locked) return;
        if (event.key === 'Enter') onOpen();
        if (event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="world-art">
        {world.thumbnailUrl || world.iconUrl ? <img className={world.thumbnailUrl ? 'render-thumbnail' : 'world-icon'} src={world.thumbnailUrl ?? world.iconUrl ?? ''} alt="" /> : <GeneratedWorldArt seed={world.name} />}
        <div className="world-art-shade" />
        {world.cached && <span className="ready-badge"><Check size={12} /> rendered</span>}
        {!world.thumbnailUrl && !busy && <span className="thumbnail-state">{world.iconUrl ? 'Minecraft icon · open for preview' : world.cached ? 'Open for real preview' : 'Preview after render'}</span>}
        {busy && <div className="card-busy" role="status"><LoaderCircle className="spin" size={16} /><span>{worldActionLabel(busy)}</span></div>}
        <button className="card-open" disabled={locked} onClick={(event) => { event.stopPropagation(); if (!locked) onOpen(); }} aria-label={`${busy ? worldActionLabel(busy) : 'Open'} ${world.name}`}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Play size={16} fill="currentColor" />}
        </button>
      </div>
      <div className="world-card-copy">
        <div><h3>{world.name}</h3><p>{relativeTime(world.lastPlayedMs)}</p></div>
        <span className="source-chip">{sourceLabel(world.source)}</span>
      </div>
    </article>
  );
});

function GeneratedWorldArt({ seed }: { seed: string }) {
  const hue = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 80;
  return (
    <div className="generated-art" style={{ '--world-hue': `${hue}` } as React.CSSProperties}>
      <i className="sun" /><i className="mountain far" /><i className="mountain near" /><i className="ground" />
    </div>
  );
}

function WorldDetail({ world, progress, action, cancelling, onOpen, onCancel, onRegenerateThumbnail, onResetRender }: {
  world: WorldInfo | null;
  progress: RenderProgress | null;
  action: WorldAction | null;
  cancelling: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onRegenerateThumbnail: () => void;
  onResetRender: () => void;
}) {
  const activeProgress = world && progress?.worldPath === world.path && !['done', 'failed'].includes(progress.phase) ? progress : null;
  if (!world) return <aside className="world-detail empty"><Compass size={28} /><p>Select a world to see its details.</p></aside>;
  const actionKind = action?.path === world.path ? action.kind : null;
  const rendering = actionKind === 'rendering';
  const fraction = activeProgress?.phase === 'tiles' && activeProgress.total > 0
    ? activeProgress.completed / activeProgress.total
    : activeProgress || rendering ? 0.12 : 0;
  return (
    <aside className="world-detail">
      <div className="detail-top">
        <span className="detail-kicker">Selected world</span>
        <h2>{world.name}</h2>
        <p className="detail-path">{world.path}</p>
      </div>
      <div className="detail-stats">
        <div><Box size={16} /><span><small>Edition</small><b>Java</b></span></div>
        <div><Cpu size={16} /><span><small>Data version</small><b>{world.dataVersion || 'Unknown'}</b></span></div>
        <div><FolderSearch size={16} /><span><small>Found via</small><b>{sourceLabel(world.source)}</b></span></div>
      </div>
      <div className="detail-note">
        <Sparkles size={16} />
        <p><b>{world.cached ? 'Your render is ready.' : 'Built locally, stays local.'}</b> Vantage reads your save without modifying it.</p>
      </div>
      {actionKind === 'opening' ? (
        <div className="render-progress opening-progress" role="status" aria-live="polite">
          <div className="progress-heading"><span><LoaderCircle className="spin" size={17} /> Opening GPU viewer</span></div>
          <div className="progress-track indeterminate"><span /></div>
          <p>Loading the cached terrain and warming the renderer.</p>
        </div>
      ) : actionKind === 'thumbnail' || actionKind === 'resetting' ? (
        <div className="render-progress maintenance-progress" role="status" aria-live="polite">
          <div className="progress-heading"><span><LoaderCircle className="spin" size={17} /> {actionKind === 'thumbnail' ? 'Preparing a fresh preview' : 'Resetting render cache'}</span></div>
          <div className="progress-track indeterminate"><span /></div>
          <p>{actionKind === 'thumbnail' ? 'Opening the existing map; the new preview appears after terrain settles.' : 'Removing generated files. Your Minecraft save stays untouched.'}</p>
        </div>
      ) : activeProgress || rendering ? (
        <div className="render-progress" role="status" aria-live="polite">
          <div className="progress-heading"><span><LoaderCircle className="spin" size={17} /> {cancelling ? 'Stopping safely' : activeProgress ? phaseCopy[activeProgress.phase] : 'Finishing render'}</span>{!cancelling && <b>{Math.round(fraction * 100)}%</b>}</div>
          <div className="progress-track"><span style={{ width: `${Math.max(4, fraction * 100)}%` }} /></div>
          <p>{cancelling ? 'Closing workers and leaving the cache in a safe state.' : activeProgress?.phase === 'tiles' ? `${activeProgress.completed} of ${activeProgress.total} terrain tiles` : 'This usually takes only a moment.'}</p>
          <button className="cancel-button" onClick={onCancel} disabled={cancelling}>{cancelling ? 'Stopping…' : 'Cancel render'}</button>
        </div>
      ) : (
        <>
          <button className="primary-button" onClick={onOpen} disabled={Boolean(action)}>
            {world.cached ? <><Compass size={18} /> Explore world</> : <><Sparkles size={18} /> Render this world</>}
            <ChevronRight size={18} />
          </button>
          {world.cached && <RenderTools onRegenerateThumbnail={onRegenerateThumbnail} onResetRender={onResetRender} />}
        </>
      )}
      <p className="shortcut-hint">{actionKind ? actionHint(actionKind) : 'Double-click a rendered world to open it instantly.'}</p>
    </aside>
  );
}

function RenderTools({ onRegenerateThumbnail, onResetRender }: { onRegenerateThumbnail: () => void; onResetRender: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <div className="reset-confirm" role="group" aria-label="Confirm render reset">
        <div><Trash2 size={15} /><p><b>Reset this render?</b><span>The map and preview will be deleted. The original world is never changed.</span></p></div>
        <span><button onClick={() => setConfirming(false)}>Keep render</button><button className="danger" onClick={onResetRender}>Reset render</button></span>
      </div>
    );
  }
  return (
    <div className="render-tools" aria-label="Render maintenance">
      <button onClick={onRegenerateThumbnail}><ImageIcon size={14} /> Regenerate preview</button>
      <button onClick={() => setConfirming(true)}><Trash2 size={14} /> Reset render</button>
    </div>
  );
}

function ErrorBanner({ message, onClose }: { message: string; onClose: () => void }) {
  return <div className="error-banner" role="alert"><span>Couldn&apos;t complete that action</span><p>{message}</p><button onClick={onClose} aria-label="Dismiss error"><X size={15} /></button></div>;
}

function userFacingError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/another world is already rendering/i.test(message)) {
    return 'The current render is still finishing. Cancel it or wait for it to complete before opening another world.';
  }
  return message;
}

function worldActionLabel(action: WorldActionKind): string {
  return ({ opening: 'Opening', rendering: 'Rendering', resetting: 'Resetting', thumbnail: 'Refreshing preview' })[action];
}

function actionHint(action: WorldActionKind): string {
  if (action === 'opening') return 'Your world will open as soon as the GPU is ready.';
  if (action === 'thumbnail') return 'The existing render is kept; only its preview is replaced.';
  if (action === 'resetting') return 'Only Vantage-generated files are being removed.';
  return 'You can keep Vantage open while the native engine works.';
}

function EmptyLibrary({ searching }: { searching: boolean }) {
  return <div className="empty-library"><FolderSearch size={28} /><h3>{searching ? 'No matching worlds' : 'No Java worlds found'}</h3><p>{searching ? 'Try another name or launcher.' : 'Install or launch a world once, then scan again.'}</p></div>;
}

function WorldSkeleton() {
  return <div className="world-card skeleton"><div className="world-art" /><div className="world-card-copy"><div><i /><i /></div></div></div>;
}

function sourceLabel(source: string): string {
  return ({ vanilla: 'Minecraft', prism: 'Prism', multimc: 'MultiMC', curseforge: 'CurseForge', modrinth: 'Modrinth', gdlauncher: 'GDLauncher', beacon: 'Beacon' } as Record<string, string>)[source] ?? source;
}

function relativeTime(timestamp: number): string {
  if (!timestamp) return 'Last played unknown';
  const minutes = Math.max(1, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `Played ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Played ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Played ${days}d ago`;
  return `Played ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp)}`;
}
