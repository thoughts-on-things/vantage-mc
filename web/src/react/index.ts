// @thoughts-on-things/vantage-mc/react — drop-in React components for JSX:
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
export { SettingsPanel, QUALITY_PRESETS, type SettingsPanelProps, type QualityPreset } from './SettingsPanel.js';
export { MapNav, type MapNavProps } from './MapNav.js';
export { DepthSlider, type DepthSliderProps } from './DepthSlider.js';
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
  StreamingSettings,
  BiomeEntry,
  DecodedTile,
} from '../three/index.js';

// Default display settings + the orbit framing angle — value exports.
export { VANILLA_DISPLAY, DEFAULT_ORBIT_ANGLE } from '../three/index.js';
