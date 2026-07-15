// <VantageViewer> — the drop-in React component. Owns a VantageViewer engine,
// mirrors its events into React state, and provides them to children (e.g.
// <BiomeLayer>) through context.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  VantageViewer as Engine,
  type BiomeEntry,
  type DisplaySettings,
  type LightSettings,
  type StreamingSettings,
  type TextureSource,
  type TileInfo,
  type TileSource,
  type TileStats,
  type ViewMode,
  type WorldSource,
} from '../three/index.js';
import { VantageContext, type VantageContextValue, type VantageStatus } from './context.js';
import { injectStyles } from './styles.js';

export interface VantageViewerProps {
  /** A tiled world to stream: the `manifest.json` URL (from `vantage render`),
   *  or a `WorldSource` for renders that don't live on a server — e.g.
   *  `worldFromDirectory(handle)` for a folder the user picked. Keep the object
   *  referentially stable (state/memo): a new identity reloads the world.
   *  Takes precedence over `tile`. */
  world?: string | WorldSource;
  /** A single `.vtile` to render: a URL, a raw buffer, or already-decoded data. */
  tile?: TileSource;
  /** The `.vtexarr` texture array (required for textured tiles). */
  textures?: TextureSource;
  /** Streaming behaviour for `world` sources (view distance, tile/byte budgets).
   *  Live: changes re-plan in place, like the other setting props. */
  streaming?: StreamingSettings;
  /** Initial camera framing. Default `'orbit'`. */
  view?: ViewMode;
  /** Antialias the WebGL context. Default `true`. Changing this remounts the canvas. */
  antialias?: boolean;
  /** Device pixel-ratio cap. Default `2`. Changing this remounts the canvas. */
  maxPixelRatio?: number;
  /** Render only when the view changes, with a low-frequency tick for animated
   *  textures. Default `true`; idle maps then use effectively no GPU time. */
  renderOnDemand?: boolean;
  /** Live lighting appearance (ambient floor, daylight, exposure). Applied on
   *  change without re-baking — drive it from a slider for a day/night control. */
  light?: LightSettings;
  /** Live display fidelity (sharpness, AO, saturation, contrast, fog, render
   *  scale). Applied on change without re-baking — drive it from sliders. */
  display?: DisplaySettings;
  /** Keep the camera in the URL hash so any view is a shareable deep link.
   *  Default `true` — pass `false` if the page owns its hash (e.g. a router). */
  urlState?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Called once a tile has loaded and been framed. */
  onLoad?: (info: TileInfo) => void;
  /** Called if loading or decoding fails. */
  onError?: (error: Error) => void;
  /** Custom node shown while loading. */
  loading?: ReactNode;
  /** Render prop / node shown on error. Receives the error. */
  errorFallback?: (error: Error) => ReactNode;
  /** Overlay components (panels, layers) and any custom UI. */
  children?: ReactNode;
}

interface LiveState {
  status: VantageStatus;
  error: Error | null;
  info: TileInfo | null;
  biomes: BiomeEntry[];
  biomeLayerEnabled: boolean;
  highlightedBiome: number | null;
  hoveredBiome: number | null;
}

const INITIAL: LiveState = {
  status: 'idle',
  error: null,
  info: null,
  biomes: [],
  biomeLayerEnabled: false,
  highlightedBiome: null,
  hoveredBiome: null,
};

export const VantageViewer = forwardRef<Engine | null, VantageViewerProps>(function VantageViewer(props, ref) {
  const {
    world,
    tile,
    textures,
    streaming,
    view = 'orbit',
    antialias = true,
    maxPixelRatio = 2,
    renderOnDemand = true,
    light,
    display,
    urlState = true,
    className,
    style,
    onLoad,
    onError,
    loading,
    errorFallback,
    children,
  } = props;

  const canvasRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [s, setS] = useState<LiveState>(INITIAL);

  // Keep callbacks current without re-running the create/load effects.
  const onLoadRef = useRef(onLoad);
  const onErrorRef = useRef(onError);
  onLoadRef.current = onLoad;
  onErrorRef.current = onError;

  useImperativeHandle<Engine | null, Engine | null>(ref, () => engine, [engine]);

  // Create the engine once (remount only when the GL options change).
  useEffect(() => {
    injectStyles();
    const el = canvasRef.current;
    if (!el) return;
    const v = new Engine(el, { antialias, maxPixelRatio, renderOnDemand, view, light, display, streaming, urlState });
    engineRef.current = v;
    setEngine(v);

    let pendingStats: TileStats | null = null;
    let statsRaf: number | null = null;

    const offs = [
      v.on('load', (info) => {
        setS((p) => ({ ...p, status: 'ready', info, biomes: info.biomes, error: null }));
        onLoadRef.current?.(info);
      }),
      // Streamed worlds: keep the HUD's totals and the biome legend live as
      // tiles come and go. Stats can fire several times per frame during a big
      // load and every setS re-renders all context consumers, so coalesce
      // bursts into one commit per animation frame.
      v.on('stats', (stats) => {
        pendingStats = stats;
        statsRaf ??= requestAnimationFrame(() => {
          statsRaf = null;
          const latest = pendingStats!;
          setS((p) =>
            p.info
              ? { ...p, info: { ...p.info, vertexCount: latest.vertexCount, triangleCount: latest.triangleCount } }
              : p,
          );
        });
      }),
      v.on('biomes', (biomes) => setS((p) => ({ ...p, biomes }))),
      v.on('hover', (id) => setS((p) => (p.hoveredBiome === id ? p : { ...p, hoveredBiome: id }))),
      v.on('biomelayer', ({ enabled, highlight }) =>
        setS((p) => ({ ...p, biomeLayerEnabled: enabled, highlightedBiome: highlight })),
      ),
    ];

    return () => {
      offs.forEach((off) => off());
      if (statsRaf !== null) cancelAnimationFrame(statsRaf);
      v.dispose();
      engineRef.current = null;
      setEngine(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- view/light are initial-only seeds; reload + setLight handle changes
  }, [antialias, maxPixelRatio, renderOnDemand]);

  // (Re)load whenever the source changes.
  useEffect(() => {
    if (!engine) return;
    let cancelled = false;
    setS((p) => ({ ...p, status: 'loading', error: null }));
    engine
      .load({ world, tile, textures, view })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e instanceof Error ? e : new Error(String(e));
        setS((p) => ({ ...p, status: 'error', error: err }));
        onErrorRef.current?.(err);
      });
    return () => {
      cancelled = true;
    };
  }, [engine, world, tile, textures, view]);

  // Apply live lighting changes (no remount, no re-load).
  useEffect(() => {
    if (engine && light) engine.setLight(light);
  }, [engine, light?.ambient, light?.daylight, light?.exposure]);

  // Apply live display-fidelity changes (no remount, no re-load).
  useEffect(() => {
    if (engine && display) engine.setDisplay(display);
  }, [engine, display?.sharpness, display?.ao, display?.saturation, display?.contrast, display?.fog, display?.renderScale]);

  // Apply live streaming changes (no remount, no re-load).
  useEffect(() => {
    if (engine && streaming) engine.setStreaming(streaming);
  }, [engine, streaming?.viewDistance, streaming?.maxTiles, streaming?.concurrency, streaming?.maxBytes]);

  const ctx = useMemo<VantageContextValue>(
    () => ({
      viewer: engine,
      status: s.status,
      error: s.error,
      info: s.info,
      biomes: s.biomes,
      biomeLayerEnabled: s.biomeLayerEnabled,
      highlightedBiome: s.highlightedBiome,
      hoveredBiome: s.hoveredBiome,
    }),
    [engine, s],
  );

  return (
    <VantageContext.Provider value={ctx}>
      <div className={className ? `vtg-root ${className}` : 'vtg-root'} style={style}>
        <div className="vtg-canvas" ref={canvasRef} />
        {s.status === 'loading' && (loading ?? <div className="vtg-status">loading…</div>)}
        {s.status === 'error' && s.error && (
          <div className="vtg-status vtg-error">{errorFallback ? errorFallback(s.error) : `Error: ${s.error.message}`}</div>
        )}
        {children}
      </div>
    </VantageContext.Provider>
  );
});
