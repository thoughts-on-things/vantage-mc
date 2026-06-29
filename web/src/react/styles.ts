// Self-injecting styles for the drop-in components, so consumers don't have to
// import a CSS file. Classes are `vtg-` prefixed to avoid collisions; the block
// is injected once per document.

const STYLE_ID = 'vantage-styles';

export const CSS = `
.vtg-root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #0d1015; color-scheme: dark; }
.vtg-canvas { position: absolute; inset: 0; }
.vtg-canvas > canvas { display: block; }

.vtg-glass {
  background: rgba(13, 17, 25, 0.66);
  border: 1px solid rgba(132, 170, 230, 0.22);
  border-radius: 11px;
  backdrop-filter: blur(13px) saturate(1.25);
  -webkit-backdrop-filter: blur(13px) saturate(1.25);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.32);
}

.vtg-status {
  position: absolute; inset: 0; display: grid; place-content: center; text-align: center;
  font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; color: #8ba6cd; padding: 2rem;
}
.vtg-status.vtg-error { color: #ffb4b4; }

.vtg-panel {
  position: absolute; top: 14px; right: 14px; width: 232px; max-height: calc(100% - 28px);
  display: flex; flex-direction: column; overflow: hidden;
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #d8e6fc;
  animation: vtg-rise 0.4s cubic-bezier(0.4,0,0.2,1) both;
}
.vtg-panel header {
  padding: 11px 12px 10px; display: flex; align-items: center; gap: 8px;
  user-select: none; border-bottom: 1px solid rgba(132, 170, 230, 0.16);
}
.vtg-panel header .vtg-sw { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: #8ba6cd; }
.vtg-panel header .vtg-sw b { color: #eef4ff; font-weight: 600; }
.vtg-toggle {
  margin-left: auto; font: 11px ui-monospace, monospace; padding: 3px 11px; border-radius: 999px;
  border: 1px solid rgba(132, 170, 230, 0.38); background: rgba(40, 60, 90, 0.45);
  color: #8ba6cd; cursor: pointer;
  transition: background 0.16s, color 0.16s, border-color 0.16s;
}
.vtg-toggle:hover { border-color: rgba(132, 170, 230, 0.7); color: #d8e6fc; }
.vtg-toggle.vtg-on { background: #5b9bff; border-color: #5b9bff; color: #07101f; font-weight: 600; }

.vtg-legend { overflow-y: auto; padding: 7px; scrollbar-width: thin; scrollbar-color: rgba(132,170,230,0.3) transparent; }
.vtg-row {
  display: flex; align-items: center; gap: 9px; padding: 5px 7px;
  border-radius: 6px; cursor: pointer; white-space: nowrap;
  transition: background 0.16s, opacity 0.16s, box-shadow 0.16s;
}
.vtg-row:hover { background: rgba(132, 170, 230, 0.12); }
.vtg-row.vtg-sel { background: rgba(91, 155, 255, 0.26); }
.vtg-row.vtg-hover { box-shadow: inset 0 0 0 1px rgba(143, 182, 232, 0.75); }
.vtg-row.vtg-dim { opacity: 0.36; }
.vtg-chip { width: 13px; height: 13px; border-radius: 4px; flex: none; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45); }
.vtg-name { overflow: hidden; text-overflow: ellipsis; }
.vtg-pct { margin-left: auto; color: #6f86ab; font-size: 11px; font-variant-numeric: tabular-nums; }

.vtg-seg { margin-left: auto; display: flex; gap: 2px; padding: 2px; border-radius: 999px; background: rgba(40, 60, 90, 0.4); border: 1px solid rgba(132, 170, 230, 0.28); }
.vtg-seg button {
  font: 10px ui-monospace, monospace; letter-spacing: 0.04em; text-transform: uppercase;
  padding: 3px 9px; border-radius: 999px; border: none; background: transparent; color: #8ba6cd;
  cursor: pointer; transition: background 0.16s, color 0.16s;
}
.vtg-seg button:hover { color: #d8e6fc; }
.vtg-seg button.vtg-seg-on { background: #5b9bff; color: #07101f; font-weight: 600; }

.vtg-sliders { padding: 11px 13px 13px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: rgba(132,170,230,0.3) transparent; }
.vtg-slider { display: flex; flex-direction: column; gap: 6px; cursor: pointer; }
.vtg-slider-row { display: flex; justify-content: space-between; color: #8ba6cd; font-size: 11px; }
.vtg-slider-row b { color: #d8e6fc; font-weight: 600; font-variant-numeric: tabular-nums; }
.vtg-slider input[type=range] {
  -webkit-appearance: none; appearance: none; width: 100%; height: 4px; border-radius: 2px;
  background: rgba(132, 170, 230, 0.25); outline: none; cursor: pointer;
}
.vtg-slider input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: 14px; height: 14px; border-radius: 50%;
  background: #5b9bff; cursor: pointer; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
  transition: transform 0.12s;
}
.vtg-slider input[type=range]::-webkit-slider-thumb:hover { transform: scale(1.15); }
.vtg-slider input[type=range]::-moz-range-thumb {
  width: 14px; height: 14px; border: none; border-radius: 50%; background: #5b9bff;
  cursor: pointer; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
}

.vtg-tip {
  position: fixed; display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; pointer-events: none; z-index: 10;
  font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: #eef4ff;
  background: rgba(13, 17, 25, 0.86); border: 1px solid rgba(132, 170, 230, 0.22); border-radius: 7px;
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
.vtg-tip .vtg-chip { width: 12px; height: 12px; border-radius: 3px; }

@keyframes vtg-rise { from { opacity: 0; transform: translateY(-7px); } to { opacity: 1; transform: none; } }
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
