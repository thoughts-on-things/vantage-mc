// Demo app — the reference consumer of the React package entry. This is how a
// server-admin web app would drop Vantage in: one <VantageViewer> with a
// <BiomeLayer> child. Tiles are served from web/public/ (regenerate with
// `just render <save>`). Deep-links: #top frames top-down, #biome opens the
// biome layer.

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BiomeLayer, LightPanel, MapNav, Reticle, SettingsPanel, useVantage, VantageViewer } from '../src/react/index.js';
import type { ViewMode } from '../src/react/index.js';

const view: ViewMode = /top/i.test(location.hash) ? 'top' : 'orbit';
const biomeOpen = /biome/i.test(location.hash);

/** A small HUD overlay showing the loaded tile's stats + the control legend — a
 *  custom child that reads the shared engine state via useVantage(). */
function Hud() {
  const { viewer, info } = useVantage();
  const [flying, setFlying] = useState(false);
  useEffect(() => {
    if (!viewer) return;
    setFlying(viewer.isFlying);
    return viewer.on('mode', ({ fly }) => setFlying(fly));
  }, [viewer]);
  if (!info) return null;
  const tris = Math.round(info.triangleCount).toLocaleString();
  const verts = info.vertexCount.toLocaleString();
  const dims = `${Math.round(info.size.x)}×${Math.round(info.size.y)}×${Math.round(info.size.z)}`;
  const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  const k = (t: string) => <b style={{ color: '#93a9cc' }}>{t}</b>;
  return (
    <div
      style={{
        position: 'absolute',
        top: 16,
        left: 16,
        padding: '12px 15px',
        font: '12px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        color: '#e6eefb',
        pointerEvents: 'none',
        maxWidth: 320,
      }}
      className="vtg-glass"
    >
      <div style={{ fontWeight: 700, letterSpacing: '0.04em', color: '#eef4ff' }}>
        vantage <b style={{ color: '#5b9bff', font: `600 11px ${mono}`, marginLeft: 2 }}>{info.magic}</b>
      </div>
      <div style={{ color: '#93a9cc', marginTop: 4, font: `11px ${mono}`, fontVariantNumeric: 'tabular-nums' }}>
        {verts} verts · {tris} tris · {dims}
      </div>
      <div style={{ color: '#6f86ab', marginTop: 8, fontSize: 11, lineHeight: 1.6 }}>
        {flying ? (
          <>
            {k('WASD')} fly · {k('Space/Shift')} up·down
            <br />
            {k('mouse')} look (click to capture) · {k('scroll')} speed · {k('Esc')} exit
          </>
        ) : (
          <>
            {k('drag')} pan · {k('right-drag')} orbit · {k('scroll')} zoom
            <br />
            {k('WASD')} move · {k('Q/E')} turn · {k('R/F')} tilt · {k('B')} biomes
          </>
        )}
      </div>
    </div>
  );
}

function App({ streamed }: { streamed: boolean }) {
  // Dev-only: expose the engine for manual poking in the console.
  const ref = (e: import('../src/three/index.js').VantageViewer | null) => {
    (window as unknown as { __vantage?: unknown }).__vantage = e;
  };
  // Streamed world (manifest.json from `vantage render`) when present; else the
  // classic single tile (`vantage meshtex`).
  const source = streamed
    ? ({ world: '/manifest.json' } as const)
    : ({ tile: '/terrain.vtile', textures: '/terrain.vtexarr' } as const);
  return (
    <VantageViewer ref={ref} {...source} view={view}>
      <Hud />
      <Reticle />
      <BiomeLayer legend hover defaultEnabled={biomeOpen} />
      <LightPanel />
      <SettingsPanel />
      <MapNav />
    </VantageViewer>
  );
}

function mount(streamed: boolean): void {
  // Survive Vite HMR re-evaluation: reuse the root instead of re-creating it.
  const holder = window as unknown as { __vantageRoot?: ReturnType<typeof createRoot> };
  holder.__vantageRoot ??= createRoot(document.getElementById('root')!);
  holder.__vantageRoot.render(
    <StrictMode>
      <App streamed={streamed} />
    </StrictMode>,
  );
}

// Prefer the streamed world when a manifest exists next to the demo.
void fetch('/manifest.json', { method: 'HEAD' }).then(
  (r) => mount(r.ok && (r.headers.get('content-type') ?? '').includes('json')),
  () => mount(false),
);
