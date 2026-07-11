// @thoughts-on-things/vantage-mc/three — three.js renderer and viewer
// engine. Use `buildTerrain` to drop Vantage meshes into your own scene, or
// `VantageViewer` for a batteries-included orbiting viewer.

export {
  buildTerrain,
  buildTileMeshes,
  buildQuantizedTileMeshes,
  buildLowresMesh,
  type TerrainObjects,
  type TileMeshes,
} from './terrain.js';
export { TileManager, type TileManagerOptions, type TileStats } from './tiles.js';
export {
  createTerrainMaterial,
  createWaterMaterial,
  createSky,
  createLowresMaterial,
  SKY_TOP,
  SKY_HORIZON,
  type TerrainMaterialOptions,
} from './materials.js';
export { pickBiome } from './pick.js';
export { MapControls, type MapControlsOptions, type HeightSampler } from './controls.js';
export {
  VantageViewer,
  type VantageViewerOptions,
  type LoadOptions,
  type StreamingSettings,
  type TileSource,
  type TextureSource,
  type TileInfo,
  type ViewMode,
  type LightSettings,
  type DisplaySettings,
  VANILLA_DISPLAY,
  DEFAULT_ORBIT_ANGLE,
} from './viewer.js';

// Re-export the core decoder so the three.js and main package entries are
// self-sufficient for the common case.
export * from '../core/index.js';
