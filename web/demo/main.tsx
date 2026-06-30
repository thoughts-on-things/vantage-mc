// Demo app — the reference consumer of vantage-mc. Two modes:
//   default      the single-tile React viewer (VantageViewer) over /terrain.vtile,
//                with the full UI (biome panel, light panel, nav) — regenerate with
//                `just render <save>`. This is the established viewer.
//   #map         the streamed tiled map (VantageMap) over web/public/map/map.json
//                — regenerate with `just map <save>`. The P4 streaming path.
// Deep-links carried through: #top frames top-down, #biome opens the biome layer.

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BiomeLayer, LightPanel, MapNav, Reticle, useVantage, VantageViewer } from '../src/react/index.js';
import type { ViewMode } from '../src/react/index.js';
import { VantageMap } from '../src/three/index.js';

const view: ViewMode = /top/i.test(location.hash) ? 'top' : 'orbit';
const biomeOpen = /biome/i.test(location.hash);
const mapMode = /\bmap\b/i.test(location.hash);

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

function App() {
  const ref = (e: import('../src/three/index.js').VantageViewer | null) => {
    (window as unknown as { __vantage?: unknown }).__vantage = e;
  };
  return (
    <VantageViewer ref={ref} tile="/terrain.vtile" textures="/terrain.vtexarr" view={view}>
      <Hud />
      <Reticle />
      <BiomeLayer legend hover defaultEnabled={biomeOpen} />
      <LightPanel />
      <MapNav />
    </VantageViewer>
  );
}

/** Mount the streamed tiled map (vanilla — exercises VantageMap directly), with a
 *  minimal DOM HUD wired to its stream/load events. `B` toggles the biome layer. */
function mountMap(root: HTMLElement) {
  const hud = document.createElement('div');
  hud.className = 'vtg-glass';
  hud.style.cssText =
    'position:absolute;top:16px;left:16px;padding:12px 15px;font:12px/1.5 system-ui,sans-serif;color:#e6eefb;max-width:340px;pointer-events:none';
  root.appendChild(hud);

  void VantageMap.mount(root, '/map/map.json', { view }).then((map) => {
    (window as unknown as { __vantage?: unknown }).__vantage = map;
    if (biomeOpen) map.setBiomeLayer(true);
    let world = '';
    map.on('load', (info) => {
      world = `X[${info.world.minX}..${info.world.maxX}] Z[${info.world.minZ}..${info.world.maxZ}] · ${info.legend.length - 1} biomes`;
    });
    const mono = 'ui-monospace,Menlo,monospace';
    const render = (loaded: number, visible: number, total: number) => {
      hud.innerHTML =
        `<div style="font-weight:700;letter-spacing:.04em;color:#eef4ff">vantage <b style="color:#5b9bff;font:600 11px ${mono};margin-left:2px">tiled map</b></div>` +
        `<div style="color:#93a9cc;margin-top:4px;font:11px ${mono};font-variant-numeric:tabular-nums">${visible} visible · ${loaded} resident · ${total} tiles</div>` +
        `<div style="color:#6f86ab;margin-top:4px;font:10px ${mono}">${world}</div>` +
        `<div style="color:#6f86ab;margin-top:8px;font-size:11px;line-height:1.6"><b style="color:#93a9cc">drag</b> pan · <b style="color:#93a9cc">right-drag</b> orbit · <b style="color:#93a9cc">scroll</b> zoom · <b style="color:#93a9cc">B</b> biomes</div>`;
    };
    map.on('tiles', ({ loaded, visible, total }) => render(loaded, visible, total));
    addEventListener('keydown', (e) => {
      if (e.key === 'b' || e.key === 'B') map.toggleBiomeLayer();
    });
  });
}

const root = document.getElementById('root')!;
if (mapMode) {
  mountMap(root);
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
