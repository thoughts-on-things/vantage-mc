// @thoughts-on-things/vantage-mc/core — isomorphic binary-format decoder.
// Use this layer to read Vantage tiles anywhere (browser, worker, Node) without
// pulling in three.js or the DOM.

export { ByteReader, TILE_MAGIC, TEXTURE_MAGIC, UV_SCALE, type TileMagic } from './format.js';
export {
  canonicalQuadIndices,
  parseTile,
  parseTileQuantized,
  type DecodedTile,
  type Lightmap,
  type MeshSection,
  type QuantizedSection,
  type QuantizedTile,
  type SurfaceMap,
} from './tile.js';
export { parseTextureArray, type DecodedTextureArray, type TextureAnimation } from './texture.js';
export { parseManifest, tileKey, type WorldManifest, type ManifestTile, type LowresLevel } from './manifest.js';
export {
  worldFromUrl,
  worldFromHttp,
  worldFromVantageServer,
  worldFromDirectory,
  worldFromFiles,
  type WorldSource,
  type WorldFetch,
  type WorldConditionalFetch,
  type WorldHttpFetch,
  type HttpWorldOptions,
  type VantageServerOptions,
} from './source.js';
export { parseLowresTile, LOWRES_EMPTY, LOWRES_MAGIC, type LowresTile } from './lowres.js';
export { isGzip, maybeInflate } from './gzip.js';
export {
  biomePalette,
  stripNamespace,
  summarizeBiomes,
  summarizeSurfaceBiomes,
  type Rgb,
  type BiomeEntry,
} from './biome.js';
