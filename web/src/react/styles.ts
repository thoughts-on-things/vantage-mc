// Self-injecting styles for the drop-in components, so consumers don't have to
// import a CSS file. Classes are `vtg-` prefixed to avoid collisions; the block
// is injected once per document.
//
// The look is Vantage's own: dark translucent glass over the 3D map. Labels and
// chrome are set in a clean UI sans; data — counts, percentages, coordinates,
// slider values — stays monospace with tabular figures, so numbers stay aligned
// and the tool keeps its technical character without reading as a debug HUD.

const STYLE_ID = 'vantage-styles';

export const CSS = `
.vtg-root {
  position: relative; width: 100%; height: 100%; overflow: hidden;
  background: #0d1015; color-scheme: dark;
  --vtg-sans: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --vtg-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  --vtg-accent: #5b9bff;
  --vtg-text: #e6eefb;
  --vtg-muted: #93a9cc;
  --vtg-dim: #6f86ab;
  --vtg-line: rgba(132, 170, 230, 0.16);
}
.vtg-canvas { position: absolute; inset: 0; }
/* Constrain the GL canvas to its container. The renderer keeps a high-res
   drawing buffer (devicePixelRatio × renderScale) via setSize(…, false), which
   leaves the canvas's intrinsic attribute size large; without an explicit
   display size that size leaks into layout and overflows. width/height:100%
   pins the *displayed* size to the container while the buffer stays crisp. */
.vtg-canvas > canvas { display: block; width: 100%; height: 100%; }

.vtg-glass {
  background: linear-gradient(180deg, rgba(18, 24, 35, 0.72), rgba(11, 15, 22, 0.7));
  border: 1px solid rgba(140, 178, 238, 0.18);
  border-radius: 13px;
  backdrop-filter: blur(16px) saturate(1.3);
  -webkit-backdrop-filter: blur(16px) saturate(1.3);
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

.vtg-status {
  position: absolute; inset: 0; display: grid; place-content: center; text-align: center;
  font: 13px var(--vtg-sans); color: var(--vtg-muted); padding: 2rem;
}
.vtg-status.vtg-error { color: #ffb4b4; }

/* --- panels --------------------------------------------------------------- */
.vtg-panel {
  position: absolute; top: 16px; right: 16px; width: 240px; max-height: calc(100% - 32px);
  display: flex; flex-direction: column; overflow: hidden;
  font: 13px/1.45 var(--vtg-sans); color: var(--vtg-text);
  animation: vtg-rise 0.4s cubic-bezier(0.4, 0, 0.2, 1) both;
}
.vtg-panel header {
  padding: 11px 13px; display: flex; align-items: center; gap: 9px;
  user-select: none; flex: none;
}
.vtg-panel:not(.vtg-collapsed) header { border-bottom: 1px solid var(--vtg-line); }
.vtg-panel header.vtg-click { cursor: pointer; }
.vtg-panel header.vtg-click:hover .vtg-title { color: #fff; }
.vtg-chev {
  font-size: 9px; color: var(--vtg-dim); width: 10px; flex: none; text-align: center;
  transition: transform 0.18s ease, color 0.16s;
}
.vtg-panel header.vtg-click:hover .vtg-chev { color: var(--vtg-muted); }
.vtg-title {
  display: flex; align-items: center; gap: 7px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--vtg-text); transition: color 0.16s;
}
.vtg-title .vtg-ico { color: var(--vtg-accent); font-size: 12px; opacity: 0.9; }
.vtg-head-extra { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.vtg-body { overflow: hidden; display: flex; flex-direction: column; min-height: 0; }

.vtg-toggle {
  font: 600 11px var(--vtg-sans); padding: 3px 12px; border-radius: 999px;
  border: 1px solid rgba(132, 170, 230, 0.38); background: rgba(40, 60, 90, 0.4);
  color: var(--vtg-muted); cursor: pointer;
  transition: background 0.16s, color 0.16s, border-color 0.16s;
}
.vtg-toggle:hover { border-color: rgba(132, 170, 230, 0.7); color: var(--vtg-text); }
.vtg-toggle.vtg-on { background: var(--vtg-accent); border-color: var(--vtg-accent); color: #07101f; }

/* --- biome legend --------------------------------------------------------- */
.vtg-legend { overflow-y: auto; padding: 7px; scrollbar-width: thin; scrollbar-color: rgba(132,170,230,0.3) transparent; }
.vtg-row {
  display: flex; align-items: center; gap: 9px; padding: 5px 8px;
  border-radius: 7px; cursor: pointer; white-space: nowrap;
  transition: background 0.16s, opacity 0.16s, box-shadow 0.16s;
}
.vtg-row:hover { background: rgba(132, 170, 230, 0.12); }
.vtg-row.vtg-sel { background: rgba(91, 155, 255, 0.26); }
.vtg-row.vtg-hover { box-shadow: inset 0 0 0 1px rgba(143, 182, 232, 0.75); }
.vtg-row.vtg-dim { opacity: 0.34; }
.vtg-chip { width: 13px; height: 13px; border-radius: 4px; flex: none; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45); }
.vtg-name { overflow: hidden; text-overflow: ellipsis; }
.vtg-pct { margin-left: auto; color: var(--vtg-dim); font: 11px var(--vtg-mono); font-variant-numeric: tabular-nums; }

/* --- segmented toggle (render mode) --------------------------------------- */
.vtg-seg { display: flex; gap: 2px; padding: 2px; border-radius: 999px; background: rgba(40, 60, 90, 0.4); border: 1px solid rgba(132, 170, 230, 0.28); }
.vtg-seg button {
  font: 600 10px var(--vtg-sans); letter-spacing: 0.04em; text-transform: uppercase;
  padding: 3px 10px; border-radius: 999px; border: none; background: transparent; color: var(--vtg-muted);
  cursor: pointer; transition: background 0.16s, color 0.16s;
}
.vtg-seg button:hover { color: var(--vtg-text); }
.vtg-seg button.vtg-seg-on { background: var(--vtg-accent); color: #07101f; }
.vtg-seg-full { display: flex; }
.vtg-seg-full button { flex: 1; text-align: center; padding: 4px 0; }

/* --- sliders -------------------------------------------------------------- */
.vtg-sliders { padding: 13px; display: flex; flex-direction: column; gap: 13px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: rgba(132,170,230,0.3) transparent; }
.vtg-slider { display: flex; flex-direction: column; gap: 7px; cursor: pointer; }
.vtg-slider-row { display: flex; justify-content: space-between; align-items: baseline; color: var(--vtg-muted); font-size: 12px; }
.vtg-slider-row b { color: var(--vtg-text); font: 600 11px var(--vtg-mono); font-variant-numeric: tabular-nums; }
.vtg-slider input[type=range] {
  -webkit-appearance: none; appearance: none; width: 100%; height: 4px; border-radius: 2px;
  background: rgba(132, 170, 230, 0.25); outline: none; cursor: pointer;
}
.vtg-slider input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: 14px; height: 14px; border-radius: 50%;
  background: var(--vtg-accent); cursor: pointer; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
  transition: transform 0.12s;
}
.vtg-slider input[type=range]::-webkit-slider-thumb:hover { transform: scale(1.18); }
.vtg-slider input[type=range]::-moz-range-thumb {
  width: 14px; height: 14px; border: none; border-radius: 50%; background: var(--vtg-accent);
  cursor: pointer; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
}

/* --- hover-to-identify tooltip -------------------------------------------- */
.vtg-tip {
  position: fixed; display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; pointer-events: none; z-index: 10;
  font: 12px/1 var(--vtg-sans); color: var(--vtg-text);
  background: rgba(13, 17, 25, 0.88); border: 1px solid var(--vtg-line); border-radius: 8px;
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
.vtg-tip .vtg-chip { width: 12px; height: 12px; border-radius: 3px; }

/* --- navigation cluster (compass · zoom · home · coords) ------------------ */
.vtg-nav {
  position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 6px; padding: 6px;
  animation: vtg-rise 0.4s cubic-bezier(0.4, 0, 0.2, 1) both;
}
.vtg-navbtn {
  width: 30px; height: 30px; flex: none; display: grid; place-items: center;
  border-radius: 9px; border: 1px solid transparent; background: transparent;
  color: var(--vtg-muted); cursor: pointer; padding: 0;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.vtg-navbtn:hover { background: rgba(132, 170, 230, 0.14); color: var(--vtg-text); border-color: var(--vtg-line); }
.vtg-navbtn:active { background: rgba(91, 155, 255, 0.26); }
.vtg-navbtn svg { width: 16px; height: 16px; display: block; }
.vtg-navbtn-text { width: auto; min-width: 30px; padding: 0 8px; font: 700 11px var(--vtg-mono); letter-spacing: 0.03em; }
.vtg-navbtn.vtg-on { background: var(--vtg-accent); border-color: var(--vtg-accent); color: #07101f; }
.vtg-navbtn.vtg-on:hover { background: var(--vtg-accent); color: #07101f; }
.vtg-nav-sep { width: 1px; align-self: stretch; margin: 4px 2px; background: var(--vtg-line); }

.vtg-compass {
  position: relative; width: 34px; height: 34px; flex: none; border-radius: 50%;
  border: 1px solid var(--vtg-line); background: rgba(20, 28, 40, 0.5);
  cursor: pointer; display: grid; place-items: center;
  transition: border-color 0.16s, background 0.16s;
}
.vtg-compass:hover { border-color: rgba(132, 170, 230, 0.5); background: rgba(30, 42, 60, 0.6); }
.vtg-compass svg { width: 30px; height: 30px; }
.vtg-compass .vtg-n { fill: #ff6a6a; }
.vtg-compass .vtg-s { fill: #c2d2ee; }
.vtg-compass .vtg-cn { fill: var(--vtg-dim); font: 700 6px var(--vtg-sans); }

.vtg-coords {
  display: flex; align-items: center; gap: 8px; padding: 0 10px 0 6px;
  font: 11px var(--vtg-mono); color: var(--vtg-muted); font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.vtg-coords b { color: var(--vtg-dim); font-weight: 600; margin-right: 1px; }

/* --- centre reticle (navigation reference) -------------------------------- */
.vtg-reticle {
  position: absolute; left: 50%; top: 50%; width: 30px; height: 30px;
  transform: translate(-50%, -50%); pointer-events: none; z-index: 4;
}
.vtg-ret-ring {
  position: absolute; inset: 0; border-radius: 50%;
  border: 1.5px solid rgba(180, 205, 240, 0.28); transform: scale(0.62);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.28);
  transition: border-color 0.2s ease, transform 0.2s ease;
}
.vtg-ret-dot {
  position: absolute; left: 50%; top: 50%; width: 4px; height: 4px; margin: -2px 0 0 -2px;
  border-radius: 50%; background: rgba(238, 244, 255, 0.85);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5), 0 0 6px rgba(0, 0, 0, 0.55);
  transition: background 0.2s ease;
}
.vtg-reticle-on .vtg-ret-ring { border-color: rgba(143, 182, 232, 0.85); transform: scale(1); }
.vtg-reticle-on .vtg-ret-dot { background: #fff; }

@keyframes vtg-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.vtg-nav { animation-name: vtg-rise-x; }
@keyframes vtg-rise-x { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
`;

/** Inject the component stylesheet once. No-op on the server or after the first call. */
export function injectStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** Format an Rgb triple (0..1) as a CSS `rgb()` string. */
export function cssRgb(c: readonly [number, number, number]): string {
  return `rgb(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0})`;
}
