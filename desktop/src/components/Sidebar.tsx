import { Layers3, Map, Settings } from 'lucide-react';
import type { RefObject } from 'react';

export function Sidebar({ worldCount, settingsButtonRef, onOpenSettings }: {
  worldCount: number;
  settingsButtonRef: RefObject<HTMLButtonElement | null>;
  onOpenSettings: () => void;
}) {
  return (
    <aside className="sidebar">
      <Brand />
      <nav className="nav-list" aria-label="Primary">
        <button className="nav-item active"><Map size={17} /> Worlds <span>{worldCount}</span></button>
        <button className="nav-item" disabled><Layers3 size={17} /> Renders <em>soon</em></button>
      </nav>
      <div className="sidebar-footer">
        <div className="engine-pill"><span /><b>Zig core</b><small>connected</small></div>
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
