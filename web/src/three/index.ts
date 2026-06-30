// vantage-mc/three — the three.js renderer and the framework-agnostic viewer
// engine. Use `buildTerrain` to drop Vantage meshes into your own scene, or
// `VantageViewer` for a batteries-included orbiting viewer.

export { buildTerrain, buildTileGeometry, type TerrainObjects, type TileGeometry } from './terrain.js';
export { VantageMap, type VantageMapOptions, type MapInfo } from './map.js';
export {
  createTerrainMaterial,
  createWaterMaterial,
  createSky,
  SKY_TOP,
  SKY_HORIZON,
} from './materials.js';
export { pickBiome } from './pick.js';
export { MapControls, type MapControlsOptions, type HeightSampler } from './controls.js';
export {
  VantageViewer,
  type VantageViewerOptions,
  type LoadOptions,
  type TileSource,
  type TextureSource,
  type TileInfo,
  type ViewMode,
  type LightSettings,
  type DisplaySettings,
  VANILLA_DISPLAY,
  DEFAULT_ORBIT_ANGLE,
} from './viewer.js';

// Re-export the core decoder so `vantage-mc/three` (and the main entry) are
// self-sufficient for the common case.
export * from '../core/index.js';
