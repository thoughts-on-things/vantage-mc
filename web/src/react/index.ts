// vantage-mc/react — drop-in React components. Compose a full viewer in JSX:
//
//   <VantageViewer tile="/terrain.vtile" textures="/terrain.vtexarr">
//     <BiomeLayer legend hover />
//   </VantageViewer>
//
// Or reach the engine with `useVantage()` / the ref for custom UI.

export { VantageViewer, type VantageViewerProps } from './VantageViewer.js';
export { BiomeLayer, type BiomeLayerProps } from './BiomeLayer.js';
export { useVantage, type VantageContextValue, type VantageStatus } from './context.js';
export { injectStyles, CSS } from './styles.js';

// Re-export the engine + core types so React consumers have one import surface.
export type {
  VantageViewer as VantageEngine,
  TileInfo,
  TileSource,
  TextureSource,
  ViewMode,
  BiomeEntry,
  DecodedTile,
} from '../three/index.js';
