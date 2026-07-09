// vantage-mc/core — the zero-dependency, isomorphic binary-format decoder.
// Use this layer to read Vantage tiles anywhere (browser, worker, Node) without
// pulling in three.js or the DOM.

export { ByteReader, TILE_MAGIC, TEXTURE_MAGIC, type TileMagic } from './format.js';
export { parseTile, type DecodedTile, type MeshSection, type SurfaceMap } from './tile.js';
export { parseTextureArray, type DecodedTextureArray } from './texture.js';
export { parseManifest, tileKey, type WorldManifest, type ManifestTile } from './manifest.js';
export { isGzip, maybeInflate } from './gzip.js';
export {
  biomePalette,
  stripNamespace,
  summarizeBiomes,
  type Rgb,
  type BiomeEntry,
} from './biome.js';
