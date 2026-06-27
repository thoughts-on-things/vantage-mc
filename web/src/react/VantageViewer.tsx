// <VantageViewer> — the drop-in React component. Owns a VantageViewer engine,
// mirrors its events into React state, and provides them to children (e.g.
// <BiomeLayer>) through context.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  VantageViewer as Engine,
  type BiomeEntry,
  type TextureSource,
  type TileInfo,
  type TileSource,
  type ViewMode,
} from '../three/index.js';
import { VantageContext, type VantageContextValue, type VantageStatus } from './context.js';
import { injectStyles } from './styles.js';

export interface VantageViewerProps {
  /** The `.vtile` to render: a URL, a raw buffer, or already-decoded data. */
  tile: TileSource;
  /** The `.vtexarr` texture array (required for textured tiles). */
  textures?: TextureSource;
  /** Initial camera framing. Default `'orbit'`. */
  view?: ViewMode;
  /** Antialias the WebGL context. Default `true`. Changing this remounts the canvas. */
  antialias?: boolean;
  /** Device pixel-ratio cap. Default `2`. Changing this remounts the canvas. */
  maxPixelRatio?: number;
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
    tile,
    textures,
    view = 'orbit',
    antialias = true,
    maxPixelRatio = 2,
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
    const v = new Engine(el, { antialias, maxPixelRatio, view });
    engineRef.current = v;
    setEngine(v);

    const offs = [
      v.on('load', (info) => {
        setS((p) => ({ ...p, status: 'ready', info, biomes: info.biomes, error: null }));
        onLoadRef.current?.(info);
      }),
      v.on('hover', (id) => setS((p) => (p.hoveredBiome === id ? p : { ...p, hoveredBiome: id }))),
      v.on('biomelayer', ({ enabled, highlight }) =>
        setS((p) => ({ ...p, biomeLayerEnabled: enabled, highlightedBiome: highlight })),
      ),
    ];

    return () => {
      offs.forEach((off) => off());
      v.dispose();
      engineRef.current = null;
      setEngine(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- view is an initial-only seed; reload handles changes
  }, [antialias, maxPixelRatio]);

  // (Re)load whenever the source changes.
  useEffect(() => {
    if (!engine) return;
    let cancelled = false;
    setS((p) => ({ ...p, status: 'loading', error: null }));
    engine
      .load({ tile, textures, view })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e instanceof Error ? e : new Error(String(e));
        setS((p) => ({ ...p, status: 'error', error: err }));
        onErrorRef.current?.(err);
      });
    return () => {
      cancelled = true;
    };
  }, [engine, tile, textures, view]);

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
