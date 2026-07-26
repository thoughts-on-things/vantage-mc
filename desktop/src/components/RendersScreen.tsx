import { useState } from 'react';
import { Compass, FolderOpen, HardDrive, Layers3, LoaderCircle, RefreshCw, Trash2, TriangleAlert, X } from 'lucide-react';
import type { RenderEntry } from '../bridge.js';
import type { LibraryController } from '../hooks/useLibrary.js';
import { compactNumber, formatBytes, renderAge } from '../lib/format.js';
import { sameSignature } from '../lib/library.js';
import type { DesktopSettings } from '../settings.js';

/**
 * Everything Vantage has generated on this PC. The library screen answers
 * "which worlds can I open"; this one answers "what is on my disk, and can I
 * have the space back".
 */
export function RendersScreen({ library, settings }: { library: LibraryController; settings: DesktopSettings }) {
  const { renders, rendersLoading, error, dismissError, action, refreshRenders, openRenderEntry, removeRender, reveal } = library;
  const totalBytes = renders.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const orphans = renders.filter((entry) => entry.worldMissing).length;
  const locked = Boolean(action);

  return (
    <main className="library renders">
      <header className="library-header">
        <div>
          <p className="eyebrow">Generated data</p>
          <h1>Your renders</h1>
          <p>Maps Vantage built on this PC. Deleting one never touches the Minecraft save.</p>
        </div>
        <div className="header-actions">
          <button className="icon-button bordered" onClick={() => void refreshRenders()} aria-label="Rescan renders" disabled={locked}>
            <RefreshCw size={17} className={rendersLoading ? 'spin' : ''} />
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>Couldn&apos;t complete that action</span>
          <p>{error}</p>
          <button onClick={dismissError} aria-label="Dismiss error"><X size={15} /></button>
        </div>
      )}

      <section className="renders-summary">
        <div><HardDrive size={17} /><span><small>Disk used</small><b>{formatBytes(totalBytes)}</b></span></div>
        <div><Layers3 size={17} /><span><small>Renders</small><b>{renders.length}</b></span></div>
        <div className={orphans ? 'warn' : ''}><TriangleAlert size={17} /><span><small>Missing worlds</small><b>{orphans}</b></span></div>
      </section>

      {rendersLoading && !renders.length ? (
        <p className="renders-loading" role="status"><LoaderCircle className="spin" size={16} /> Measuring renders…</p>
      ) : renders.length ? (
        <ul className="render-list">
          {renders.map((entry) => (
            <RenderRow
              key={entry.id}
              entry={entry}
              settings={settings}
              busy={action && (action.path === entry.id || action.path === entry.worldPath) ? action.kind : null}
              locked={locked}
              onOpen={() => void openRenderEntry(entry)}
              onReveal={() => void reveal(entry.path)}
              onDelete={() => void removeRender(entry)}
            />
          ))}
        </ul>
      ) : (
        <div className="empty-library">
          <Layers3 size={28} />
          <h3>Nothing rendered yet</h3>
          <p>Render a world from the library and it will show up here with its size on disk.</p>
        </div>
      )}
    </main>
  );
}

function RenderRow({ entry, settings, busy, locked, onOpen, onReveal, onDelete }: {
  entry: RenderEntry;
  settings: DesktopSettings;
  busy: string | null;
  locked: boolean;
  onOpen: () => void;
  onReveal: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const matchesSettings = entry.settings ? sameSignature(entry.settings, settings) : false;

  return (
    <li className={`render-row${busy ? ' busy' : ''}`}>
      <div className="render-thumb">
        {entry.thumbnailUrl ? <img src={entry.thumbnailUrl} alt="" /> : <Layers3 size={20} />}
      </div>
      <div className="render-copy">
        <h3>{entry.worldName}</h3>
        <p className="render-meta">
          {formatBytes(entry.sizeBytes)} · {compactNumber(entry.fileCount)} files · rendered {renderAge(entry.renderedAtMs)}
        </p>
        <p className="render-path" title={entry.worldPath ?? entry.path}>{entry.worldPath ?? entry.path}</p>
        <div className="render-tags">
          {entry.worldMissing && <span className="tag warn"><TriangleAlert size={12} /> world not installed</span>}
          {entry.settings && (
            <>
              <span className="tag">{entry.settings.fullCaves ? 'full caves' : 'surface only'}</span>
              <span className="tag">{entry.settings.smoothLighting ? 'smooth light' : 'flat light'}</span>
              {!matchesSettings && <span className="tag">rebuilds on open</span>}
            </>
          )}
        </div>
      </div>
      {confirming ? (
        <div className="render-confirm" role="group" aria-label={`Confirm deleting ${entry.worldName}`}>
          <p>Delete {formatBytes(entry.sizeBytes)} of generated map data?</p>
          <span>
            <button onClick={() => setConfirming(false)}>Keep</button>
            <button className="danger" onClick={onDelete}>Delete render</button>
          </span>
        </div>
      ) : (
        <div className="render-actions">
          <button className="ghost-button" onClick={onOpen} disabled={locked} aria-label={`Open ${entry.worldName}`}>
            {busy === 'opening' ? <LoaderCircle className="spin" size={15} /> : <Compass size={15} />} Open
          </button>
          <button className="ghost-button" onClick={onReveal} disabled={locked} aria-label={`Show files for ${entry.worldName}`}>
            <FolderOpen size={15} /> Show files
          </button>
          <button className="ghost-button danger" onClick={() => setConfirming(true)} disabled={locked} aria-label={`Delete render of ${entry.worldName}`}>
            {busy === 'resetting' ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />} Delete
          </button>
        </div>
      )}
    </li>
  );
}
