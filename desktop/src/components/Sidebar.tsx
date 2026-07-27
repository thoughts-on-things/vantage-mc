import { ArrowDownToLine, Keyboard, Layers3, LoaderCircle, Map, Settings } from 'lucide-react';
import type { RefObject } from 'react';
import type { Screen } from '../hooks/useLibrary.js';
import type { UpdatesController } from '../hooks/useUpdates.js';

export function Sidebar({ worldCount, renderCount, screen, updates, onNavigate, settingsButtonRef, shortcutsButtonRef, onOpenSettings, onOpenShortcuts }: {
  worldCount: number;
  renderCount: number;
  screen: Screen;
  updates: UpdatesController;
  onNavigate: (screen: Screen) => void;
  settingsButtonRef: RefObject<HTMLButtonElement | null>;
  shortcutsButtonRef: RefObject<HTMLButtonElement | null>;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
}) {
  return (
    <aside className="sidebar">
      <Brand />
      <nav className="nav-list" aria-label="Primary">
        <button
          className={`nav-item${screen === 'library' ? ' active' : ''}`}
          aria-current={screen === 'library' ? 'page' : undefined}
          onClick={() => onNavigate('library')}
        >
          <Map size={17} /> Worlds <span>{worldCount}</span>
        </button>
        <button
          className={`nav-item${screen === 'renders' ? ' active' : ''}`}
          aria-current={screen === 'renders' ? 'page' : undefined}
          onClick={() => onNavigate('renders')}
        >
          <Layers3 size={17} /> Renders {renderCount > 0 && <span>{renderCount}</span>}
        </button>
      </nav>
      <UpdateNotice updates={updates} />
      <div className="sidebar-footer">
        <div className="engine-pill"><span /><b>Zig core</b><small>connected</small></div>
        <button ref={shortcutsButtonRef} className="icon-button" aria-label="Keyboard shortcuts" onClick={onOpenShortcuts}><Keyboard size={18} /></button>
        <button ref={settingsButtonRef} className="icon-button" aria-label="Settings" onClick={onOpenSettings}><Settings size={18} /></button>
      </div>
    </aside>
  );
}

/** The auto-update pill: hidden until a release is ready, then one click
 *  downloads it and restarts into the new build. */
function UpdateNotice({ updates }: { updates: UpdatesController }) {
  if (updates.phase === 'idle') return null;
  const percent = updates.progress === null ? null : Math.round(updates.progress * 100);
  // aria-disabled rather than disabled: a natively disabled button can drop
  // out of the accessibility tree, silencing the live region inside it.
  const busy = updates.phase !== 'available';
  return (
    <button
      className="update-pill"
      onClick={busy ? undefined : updates.install}
      aria-disabled={busy}
    >
      {updates.phase === 'downloading' && (
        <span className="update-progress" style={{ width: `${percent ?? 8}%` }} aria-hidden="true" />
      )}
      {updates.phase === 'available'
        ? <ArrowDownToLine size={15} />
        : <LoaderCircle size={15} className="spin" />}
      <span className="update-copy" role="status" aria-live="polite">
        {updates.phase === 'available' && <><b>Update to {updates.version}</b><small>Download &amp; restart</small></>}
        {updates.phase === 'downloading' && <><b>Downloading update</b><small>{percent === null ? 'Starting…' : `${percent}%`}</small></>}
        {updates.phase === 'restarting' && <><b>Restarting</b><small>Installing {updates.version}</small></>}
      </span>
    </button>
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
