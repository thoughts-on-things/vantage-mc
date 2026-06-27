// React context bridging the imperative VantageViewer engine to declarative
// components. The <VantageViewer> provider owns the engine and mirrors its
// events into React state; children read it via useVantage().

import { createContext, useContext } from 'react';
import type { BiomeEntry, TileInfo, VantageViewer } from '../three/index.js';

export type VantageStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface VantageContextValue {
  /** The underlying engine, or `null` until mounted. Escape hatch for custom work. */
  viewer: VantageViewer | null;
  status: VantageStatus;
  error: Error | null;
  /** Metadata for the loaded tile. */
  info: TileInfo | null;
  /** Biomes present in the current tile, most common first. */
  biomes: BiomeEntry[];
  biomeLayerEnabled: boolean;
  highlightedBiome: number | null;
  /** Biome id under the cursor, or `null`. */
  hoveredBiome: number | null;
}

export const VantageContext = createContext<VantageContextValue | null>(null);

/** Access the viewer engine and live state. Must be used under `<VantageViewer>`. */
export function useVantage(): VantageContextValue {
  const ctx = useContext(VantageContext);
  if (!ctx) throw new Error('vantage: useVantage() must be used inside <VantageViewer>');
  return ctx;
}
