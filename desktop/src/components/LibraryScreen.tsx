import type { RefObject } from 'react';
import { FolderSearch, RefreshCw, Search, X } from 'lucide-react';
import type { LibraryController } from '../hooks/useLibrary.js';
import { FILTER_LABELS, SORT_LABELS, type FilterMode, type SortMode } from '../lib/library.js';
import type { DesktopSettings } from '../settings.js';
import { WorldCard, WorldSkeleton } from './WorldCard.js';
import { WorldDetail } from './WorldDetail.js';

export function LibraryScreen({ library, settings, searchRef }: {
  library: LibraryController;
  settings: DesktopSettings;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  const {
    worlds, filtered, query, setQuery, view, setView, selected, selectedPath, selectPath,
    loading, refreshing, error, dismissError, progress, action, cancelling,
    refresh, openWorld, rerenderWorld, stopRender, regenerateThumbnail, resetRenderCache, reveal,
  } = library;

  const locked = Boolean(action);

  return (
    <main className="library">
      <header className="library-header">
        <div>
          <p className="eyebrow">Local library</p>
          <h1>Your worlds</h1>
          <p>Every Java world on this PC, ready to explore.</p>
        </div>
        <div className="header-actions">
          <label className={`search-box${locked ? ' disabled' : ''}`}>
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
              disabled={locked}
            />
            {query && <button onClick={() => setQuery('')} aria-label="Clear search" disabled={locked}><X size={14} /></button>}
            {!query && <kbd>Ctrl K</kbd>}
          </label>
          <button className="icon-button bordered" onClick={() => void refresh(true)} aria-label="Scan again" disabled={locked}>
            <RefreshCw size={17} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
      </header>

      {error && <ErrorBanner message={error} onClose={dismissError} />}

      <section className="library-content">
        <div className="world-grid-wrap">
          <div className="section-heading">
            <h2>Discovered</h2>
            <div className="library-controls">
              <div className="filter-chips" role="group" aria-label="Filter worlds">
                {(Object.keys(FILTER_LABELS) as FilterMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={view.filter === mode ? 'active' : ''}
                    aria-pressed={view.filter === mode}
                    disabled={locked}
                    onClick={() => setView({ ...view, filter: mode })}
                  >
                    {FILTER_LABELS[mode]}
                  </button>
                ))}
              </div>
              <label className="sort-picker">
                <span>Sort</span>
                <select
                  value={view.sort}
                  aria-label="Sort worlds"
                  disabled={locked}
                  onChange={(event) => setView({ ...view, sort: event.target.value as SortMode })}
                >
                  {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
                    <option key={mode} value={mode}>{SORT_LABELS[mode]}</option>
                  ))}
                </select>
              </label>
              <span className="result-count">{filtered.length} {filtered.length === 1 ? 'world' : 'worlds'}</span>
            </div>
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
                  settings={settings}
                  selected={selectedPath === world.path}
                  busy={action?.path === world.path ? action.kind : null}
                  locked={locked}
                  onSelect={selectPath}
                  onOpen={openWorld}
                />
              ))}
            </div>
          ) : (
            <EmptyLibrary searching={Boolean(query)} filtered={view.filter !== 'all'} hasWorlds={worlds.length > 0} />
          )}
        </div>

        <WorldDetail
          key={selected?.path ?? 'empty'}
          world={selected}
          settings={settings}
          progress={progress}
          action={action}
          cancelling={cancelling}
          onOpen={() => { if (selected) void openWorld(selected); }}
          onRerender={() => { if (selected) void rerenderWorld(selected); }}
          onCancel={() => void stopRender()}
          onRegenerateThumbnail={() => { if (selected) void regenerateThumbnail(selected); }}
          onResetRender={() => { if (selected) void resetRenderCache(selected); }}
          onReveal={() => { if (selected) void reveal(selected.path); }}
        />
      </section>
    </main>
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

function EmptyLibrary({ searching, filtered, hasWorlds }: { searching: boolean; filtered: boolean; hasWorlds: boolean }) {
  const [heading, copy] = searching
    ? ['No matching worlds', 'Try another name or launcher.']
    : filtered && hasWorlds
      ? ['Nothing in this filter', 'Every discovered world is on the other side of this filter.']
      : ['No Java worlds found', 'Install or launch a world once, then scan again.'];
  return (
    <div className="empty-library">
      <FolderSearch size={28} />
      <h3>{heading}</h3>
      <p>{copy}</p>
    </div>
  );
}
