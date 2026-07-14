import { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Check,
  ChevronRight,
  Compass,
  Cpu,
  FolderSearch,
  Layers3,
  LoaderCircle,
  Map,
  Play,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';
import {
  discoverWorlds,
  onRenderProgress,
  openCachedWorld,
  renderWorld,
  type RenderProgress,
  type WorldInfo,
} from './bridge.js';

type Screen = 'library' | 'viewer';
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
  const searchRef = useRef<HTMLInputElement>(null);
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
    let dispose: (() => void) | undefined;
    void onRenderProgress(setProgress).then((unlisten) => (dispose = unlisten));
    return () => dispose?.();
  }, [refresh]);

  const startRender = useCallback(async (target: WorldInfo | null = selected) => {
    if (!target) return;
    setSelectedPath(target.path);
    setError(null);
    setProgress({ phase: 'scanning', completed: 0, total: 0, worldPath: target.path });
    try {
      const [ready] = await Promise.all([renderWorld(target.path), loadViewer()]);
      setManifestUrl(ready.manifestUrl);
      setWorlds((current) => current.map((world) => (world.path === target.path ? { ...world, cached: true } : world)));
      setScreen('viewer');
    } catch (reason) {
      setProgress(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [selected]);

  const openWorld = useCallback(async (target: WorldInfo | null = selected) => {
    if (!target) return;
    if (!target.cached) return startRender(target);
    setSelectedPath(target.path);
    setError(null);
    try {
      const [ready] = await Promise.all([openCachedWorld(target.path), loadViewer()]);
      setManifestUrl(ready.manifestUrl);
      setScreen('viewer');
    } catch {
      await startRender(target);
    }
  }, [selected, startRender]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches('input, textarea, select, [contenteditable="true"]');
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k' || (event.key === '/' && !typing)) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (typing || screen !== 'library' || !filtered.length) return;
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
  }, [filtered, openWorld, screen, selectedPath]);

  if (screen === 'viewer' && selected && manifestUrl) {
    return (
      <Suspense fallback={<div className="viewer-loading"><LoaderCircle className="spin" /><span>Starting GPU viewer</span></div>}>
        <ViewerScreen
          world={selected}
          manifestUrl={manifestUrl}
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
          <button className="icon-button" aria-label="Settings"><Settings size={18} /></button>
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
            <label className="search-box">
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
              />
              {query && <button onClick={() => setQuery('')} aria-label="Clear search"><X size={14} /></button>}
              {!query && <kbd>Ctrl K</kbd>}
            </label>
            <button className="icon-button bordered" onClick={() => void refresh(true)} aria-label="Scan again">
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
                    onSelect={() => setSelectedPath(world.path)}
                    onOpen={() => void openWorld(world)}
                  />
                ))}
              </div>
            ) : (
              <EmptyLibrary searching={Boolean(query)} />
            )}
          </div>

          <WorldDetail key={selected?.path ?? 'empty'} world={selected} progress={progress} onOpen={() => void openWorld()} />
        </section>
      </main>
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

const WorldCard = memo(function WorldCard({ world, index, selected, onSelect, onOpen }: {
  world: WorldInfo; index: number; selected: boolean; onSelect: () => void; onOpen: () => void;
}) {
  return (
    <article
      className={`world-card world-tone-${index % 4}${selected ? ' selected' : ''}`}
      style={{ '--card-index': Math.min(index, 12) } as React.CSSProperties}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${world.name}, ${world.cached ? 'render ready' : 'not rendered'}`}
      data-world-index={index}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onPointerEnter={() => { if (world.cached) void loadViewer(); }}
      onFocus={() => { onSelect(); if (world.cached) void loadViewer(); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen();
        if (event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="world-art">
        {world.iconUrl ? <img src={world.iconUrl} alt="" /> : <GeneratedWorldArt seed={world.name} />}
        <div className="world-art-shade" />
        {world.cached && <span className="ready-badge"><Check size={12} /> rendered</span>}
        <button className="card-open" onClick={(event) => { event.stopPropagation(); onOpen(); }} aria-label={`Open ${world.name}`}>
          <Play size={16} fill="currentColor" />
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

function WorldDetail({ world, progress, onOpen }: { world: WorldInfo | null; progress: RenderProgress | null; onOpen: () => void }) {
  const activeProgress = world && progress?.worldPath === world.path && !['done', 'failed'].includes(progress.phase) ? progress : null;
  if (!world) return <aside className="world-detail empty"><Compass size={28} /><p>Select a world to see its details.</p></aside>;
  const fraction = activeProgress?.phase === 'tiles' && activeProgress.total > 0
    ? activeProgress.completed / activeProgress.total
    : activeProgress ? 0.12 : 0;
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
      {activeProgress ? (
        <div className="render-progress">
          <div className="progress-heading"><span><LoaderCircle className="spin" size={17} /> {phaseCopy[activeProgress.phase]}</span><b>{Math.round(fraction * 100)}%</b></div>
          <div className="progress-track"><span style={{ width: `${Math.max(4, fraction * 100)}%` }} /></div>
          <p>{activeProgress.phase === 'tiles' ? `${activeProgress.completed} of ${activeProgress.total} terrain tiles` : 'This usually takes only a moment.'}</p>
        </div>
      ) : (
        <button className="primary-button" onClick={onOpen}>
          {world.cached ? <><Compass size={18} /> Explore world</> : <><Sparkles size={18} /> Render this world</>}
          <ChevronRight size={18} />
        </button>
      )}
      <p className="shortcut-hint">Double-click a rendered world to open it instantly.</p>
    </aside>
  );
}

function ErrorBanner({ message, onClose }: { message: string; onClose: () => void }) {
  return <div className="error-banner"><span>Something went wrong</span><p>{message}</p><button onClick={onClose}><X size={15} /></button></div>;
}

function EmptyLibrary({ searching }: { searching: boolean }) {
  return <div className="empty-library"><FolderSearch size={28} /><h3>{searching ? 'No matching worlds' : 'No Java worlds found'}</h3><p>{searching ? 'Try another name or launcher.' : 'Install or launch a world once, then scan again.'}</p></div>;
}

function WorldSkeleton() {
  return <div className="world-card skeleton"><div className="world-art" /><div className="world-card-copy"><div><i /><i /></div></div></div>;
}

function sourceLabel(source: string): string {
  return ({ vanilla: 'Minecraft', prism: 'Prism', multimc: 'MultiMC', curseforge: 'CurseForge', modrinth: 'Modrinth', gdlauncher: 'GDLauncher' } as Record<string, string>)[source] ?? source;
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
