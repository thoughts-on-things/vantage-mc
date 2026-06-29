// vantage-mc/react — drop-in React components. Compose a full viewer in JSX:
//
//   <VantageViewer tile="/terrain.vtile" textures="/terrain.vtexarr">
//     <BiomeLayer legend hover />
//   </VantageViewer>
//
// Or reach the engine with `useVantage()` / the ref for custom UI.

export { VantageViewer, type VantageViewerProps } from './VantageViewer.js';
export { Panel, type PanelProps } from './Panel.js';
export { BiomeLayer, type BiomeLayerProps } from './BiomeLayer.js';
export { LightPanel, type LightPanelProps } from './LightPanel.js';
export { FidelityPanel, type FidelityPanelProps } from './FidelityPanel.js';
export { MapNav, type MapNavProps } from './MapNav.js';
export { Reticle, type ReticleProps } from './Reticle.js';
export { useVantage, type VantageContextValue, type VantageStatus } from './context.js';
export { injectStyles, CSS } from './styles.js';

// Re-export the engine + core types so React consumers have one import surface.
export type {
  VantageViewer as VantageEngine,
  TileInfo,
  TileSource,
  TextureSource,
  ViewMode,
  LightSettings,
  DisplaySettings,
  RenderMode,
  BiomeEntry,
  DecodedTile,
} from '../three/index.js';

// Display presets (mode toggle) — value exports, separate from the type block.
export { CINEMATIC_DISPLAY, VANILLA_DISPLAY, DISPLAY_PRESETS, DEFAULT_ORBIT_ANGLE } from '../three/index.js';
