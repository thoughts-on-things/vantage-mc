import { Keyboard, Layers3, Map, Settings } from 'lucide-react';
import type { RefObject } from 'react';
import type { Screen } from '../hooks/useLibrary.js';

export function Sidebar({ worldCount, renderCount, screen, onNavigate, settingsButtonRef, shortcutsButtonRef, onOpenSettings, onOpenShortcuts }: {
  worldCount: number;
  renderCount: number;
  screen: Screen;
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
      <div className="sidebar-footer">
        <div className="engine-pill"><span /><b>Zig core</b><small>connected</small></div>
        <button ref={shortcutsButtonRef} className="icon-button" aria-label="Keyboard shortcuts" onClick={onOpenShortcuts}><Keyboard size={18} /></button>
        <button ref={settingsButtonRef} className="icon-button" aria-label="Settings" onClick={onOpenSettings}><Settings size={18} /></button>
      </div>
    </aside>
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
