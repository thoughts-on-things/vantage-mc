// Demo app — the reference consumer of vantage-mc/react. This is exactly how a
// server-admin web app would drop Vantage in: one <VantageViewer> with a
// <BiomeLayer> child. Tiles are served from web/public/ (regenerate with
// `just render <save>`). Deep-links: #top frames top-down, #biome opens the
// biome layer.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BiomeLayer, LightPanel, useVantage, VantageViewer } from '../src/react/index.js';
import type { ViewMode } from '../src/react/index.js';

const view: ViewMode = /top/i.test(location.hash) ? 'top' : 'orbit';
const biomeOpen = /biome/i.test(location.hash);

/** A small HUD overlay showing the loaded tile's stats — a custom child that
 *  reads the shared engine state via useVantage(). */
function Hud() {
  const { info } = useVantage();
  if (!info) return null;
  const tris = Math.round(info.triangleCount).toLocaleString();
  const verts = info.vertexCount.toLocaleString();
  const dims = `${Math.round(info.size.x)}×${Math.round(info.size.y)}×${Math.round(info.size.z)}`;
  return (
    <div
      style={{
        position: 'absolute',
        top: 14,
        left: 14,
        padding: '11px 14px',
        font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
        color: '#d8e6fc',
        pointerEvents: 'none',
        textShadow: '0 1px 2px rgba(0,0,0,0.5)',
      }}
      className="vtg-glass"
    >
      <div style={{ fontWeight: 600, color: '#eef4ff' }}>
        vantage · <b style={{ color: '#5b9bff' }}>{info.magic}</b>
      </div>
      <div style={{ color: '#8ba6cd', marginTop: 4 }}>
        {verts} verts · {tris} tris · {dims} blocks
      </div>
      <div style={{ color: '#6f86ab', marginTop: 7, fontSize: 11 }}>
        drag pan · right-drag rotate · scroll zoom · <b>B</b> biomes · hover to identify
      </div>
    </div>
  );
}

function App() {
  return (
    <VantageViewer tile="/terrain.vtile" textures="/terrain.vtexarr" view={view}>
      <Hud />
      <BiomeLayer legend hover defaultEnabled={biomeOpen} />
      <LightPanel />
    </VantageViewer>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
