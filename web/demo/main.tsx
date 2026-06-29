// Demo app — the reference consumer of vantage-mc/react. This is exactly how a
// server-admin web app would drop Vantage in: one <VantageViewer> with a
// <BiomeLayer> child. Tiles are served from web/public/ (regenerate with
// `just render <save>`). Deep-links: #top frames top-down, #biome opens the
// biome layer.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BiomeLayer, FidelityPanel, LightPanel, MapNav, useVantage, VantageViewer } from '../src/react/index.js';
import type { ViewMode } from '../src/react/index.js';

const view: ViewMode = /top/i.test(location.hash) ? 'top' : 'orbit';
const biomeOpen = /biome/i.test(location.hash);

/** A small HUD overlay showing the loaded tile's stats + the control legend — a
 *  custom child that reads the shared engine state via useVantage(). */
function Hud() {
  const { info } = useVantage();
  if (!info) return null;
  const tris = Math.round(info.triangleCount).toLocaleString();
  const verts = info.vertexCount.toLocaleString();
  const dims = `${Math.round(info.size.x)}×${Math.round(info.size.y)}×${Math.round(info.size.z)}`;
  const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
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
        <b style={{ color: '#93a9cc' }}>drag</b> pan · <b style={{ color: '#93a9cc' }}>right-drag</b> orbit ·{' '}
        <b style={{ color: '#93a9cc' }}>scroll</b> zoom
        <br />
        <b style={{ color: '#93a9cc' }}>WASD</b> move · <b style={{ color: '#93a9cc' }}>Q/E</b> turn ·{' '}
        <b style={{ color: '#93a9cc' }}>R/F</b> tilt · <b style={{ color: '#93a9cc' }}>B</b> biomes
      </div>
    </div>
  );
}

function App() {
  // Dev-only: expose the engine for manual poking in the console.
  const ref = (e: import('../src/three/index.js').VantageViewer | null) => {
    (window as unknown as { __vantage?: unknown }).__vantage = e;
  };
  return (
    <VantageViewer ref={ref} tile="/terrain.vtile" textures="/terrain.vtexarr" view={view}>
      <Hud />
      <BiomeLayer legend hover defaultEnabled={biomeOpen} />
      <LightPanel />
      <FidelityPanel />
      <MapNav />
    </VantageViewer>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
