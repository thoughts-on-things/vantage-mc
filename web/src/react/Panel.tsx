// <Panel> — the shared collapsible glass panel the biome/lighting/fidelity
// controls are built on. A header (icon + title + optional right-aligned extra)
// toggles a collapsible body, so a consumer can keep several panels on screen
// without them crowding the map: open the one you're using, collapse the rest.

import { useState, type CSSProperties, type ReactNode } from 'react';

export interface PanelProps {
  /** Leading glyph (kept small + accent-coloured). */
  icon?: ReactNode;
  /** Uppercase title text. */
  title: string;
  /** Right-aligned header content (a toggle, a segmented control). Clicks here
   *  don't collapse the panel. */
  headerExtra?: ReactNode;
  /** Start collapsed (header only). Default `false`. */
  defaultCollapsed?: boolean;
  /** Allow collapsing via the header. Default `true`. */
  collapsible?: boolean;
  style?: CSSProperties;
  className?: string;
  children?: ReactNode;
}

export function Panel({ icon, title, headerExtra, defaultCollapsed = false, collapsible = true, style, className, children }: PanelProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const classes = ['vtg-panel', 'vtg-glass', collapsed && 'vtg-collapsed', className].filter(Boolean).join(' ');
  return (
    <div className={classes} style={style}>
      <header
        className={collapsible ? 'vtg-click' : undefined}
        onClick={collapsible ? () => setCollapsed((c) => !c) : undefined}
      >
        {collapsible && <span className="vtg-chev">{collapsed ? '▶' : '▼'}</span>}
        <span className="vtg-title">
          {icon != null && <span className="vtg-ico">{icon}</span>}
          {title}
        </span>
        {headerExtra != null && (
          <div className="vtg-head-extra" onClick={(e) => e.stopPropagation()}>
            {headerExtra}
          </div>
        )}
      </header>
      {!collapsed && <div className="vtg-body">{children}</div>}
    </div>
  );
}
