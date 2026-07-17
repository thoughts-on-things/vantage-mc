import { useCallback, useRef, useState } from 'react';
import { FolderSearch, RefreshCw, Search, X } from 'lucide-react';
import type { LibraryController } from '../hooks/useLibrary.js';
import { useLibraryHotkeys } from '../hooks/useLibraryHotkeys.js';
import type { DesktopSettings } from '../settings.js';
import { SettingsSheet } from './SettingsSheet.js';
import { Sidebar } from './Sidebar.js';
import { WorldCard, WorldSkeleton } from './WorldCard.js';
import { WorldDetail } from './WorldDetail.js';

export function LibraryScreen({ library, settings, onSettingsChange }: {
  library: LibraryController;
  settings: DesktopSettings;
  onSettingsChange: (next: DesktopSettings) => void;
}) {
  const {
    worlds, filtered, query, setQuery, selected, selectedPath, selectPath,
    loading, refreshing, error, dismissError, progress, action, cancelling,
    system, refresh, openWorld, stopRender, regenerateThumbnail, resetRenderCache, actionRef,
  } = library;

  const [settingsOpen, setSettingsOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  const closeSettings = useCallback(() => {
    settingsButtonRef.current?.focus({ preventScroll: true });
    setSettingsOpen(false);
  }, []);

  useLibraryHotkeys({
    enabled: !settingsOpen,
    filtered,
    selectedPath,
    selectPath,
    openWorld,
    actionRef,
    searchRef,
    settingsOpen,
    closeSettings,
  });

  return (
    <div className="app-shell">
      <Sidebar worldCount={worlds.length} settingsButtonRef={settingsButtonRef} onOpenSettings={() => setSettingsOpen(true)} />

      <main className="library">
        <header className="library-header">
          <div>
            <p className="eyebrow">Local library</p>
            <h1>Your worlds</h1>
            <p>Every Java world on this PC, ready to explore.</p>
          </div>
          <div className="header-actions">
            <label className={`search-box${action ? ' disabled' : ''}`}>
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
                disabled={Boolean(action)}
              />
              {query && <button onClick={() => setQuery('')} aria-label="Clear search" disabled={Boolean(action)}><X size={14} /></button>}
              {!query && <kbd>Ctrl K</kbd>}
            </label>
            <button className="icon-button bordered" onClick={() => void refresh(true)} aria-label="Scan again" disabled={Boolean(action)}>
              <RefreshCw size={17} className={refreshing ? 'spin' : ''} />
            </button>
          </div>
        </header>

        {error && <ErrorBanner message={error} onClose={dismissError} />}

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
                    busy={action?.path === world.path ? action.kind : null}
                    locked={Boolean(action)}
                    onSelect={selectPath}
                    onOpen={openWorld}
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
            action={action}
            cancelling={cancelling}
            onOpen={() => { if (selected) void openWorld(selected); }}
            onCancel={() => void stopRender()}
            onRegenerateThumbnail={() => { if (selected) void regenerateThumbnail(selected); }}
            onResetRender={() => { if (selected) void resetRenderCache(selected); }}
          />
        </section>
      </main>

      {settingsOpen && <SettingsSheet settings={settings} system={system} onChange={onSettingsChange} onClose={closeSettings} />}
    </div>
  );
}

function ErrorBanner({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <span>Couldn&apos;t complete that action</span>
      <p>{message}</p>
      <button onClick={onClose} aria-label="Dismiss error"><X size={15} /></button>
    </div>
  );
}

function EmptyLibrary({ searching }: { searching: boolean }) {
  return (
    <div className="empty-library">
      <FolderSearch size={28} />
      <h3>{searching ? 'No matching worlds' : 'No Java worlds found'}</h3>
      <p>{searching ? 'Try another name or launcher.' : 'Install or launch a world once, then scan again.'}</p>
    </div>
  );
}
