// The world manifest — the small JSON index a tiled render writes next to its
// tiles. The viewer streams tiles from it; anything else (a CLI, a bot, your
// own renderer) can read it to enumerate the world without fetching geometry.

/** One tile's manifest record. `x`/`z` are tile coords (world block = x · tileBlocks). */
export interface ManifestTile {
  x: number;
  z: number;
  /** Path relative to the manifest's directory. */
  path: string;
  /** File size in bytes (gzip-wrapped on disk), for progress UI / budgeting. */
  bytes: number;
}

/** A parsed `manifest.json` for a tiled world render. */
export interface WorldManifest {
  /** Manifest schema version (1). */
  format: number;
  /** Tile span in chunks per side. */
  tileChunks: number;
  /** Tile span in blocks per side (= tileChunks · 16). */
  tileBlocks: number;
  /** Path of the shared texture array, relative to the manifest. */
  textures: string;
  /** World spawn point, when the generator could read level.dat. */
  spawn?: { x: number; y: number; z: number };
  /** Biome display names indexed by the per-vertex biome id (0 = no data).
   *  Globally consistent across every tile of the render. */
  biomes: string[];
  /** Every rendered tile. */
  tiles: ManifestTile[];
}

/** Tile-coordinate key for maps/sets. */
export function tileKey(x: number, z: number): string {
  return `${x},${z}`;
}

/**
 * Validate and type a fetched `manifest.json` value.
 *
 * @throws if the shape is not a Vantage world manifest this decoder understands.
 */
export function parseManifest(data: unknown): WorldManifest {
  if (typeof data !== 'object' || data === null) throw new Error('vantage: manifest is not an object');
  const m = data as Record<string, unknown>;
  if (m['format'] !== 1) throw new Error(`vantage: unsupported manifest format ${String(m['format'])} (expected 1)`);
  const tileChunks = m['tileChunks'];
  const tileBlocks = m['tileBlocks'];
  const textures = m['textures'];
  const biomes = m['biomes'];
  const tiles = m['tiles'];
  if (typeof tileChunks !== 'number' || tileChunks < 1) throw new Error('vantage: manifest missing tileChunks');
  if (typeof tileBlocks !== 'number' || tileBlocks < 16) throw new Error('vantage: manifest missing tileBlocks');
  if (typeof textures !== 'string') throw new Error('vantage: manifest missing textures path');
  if (!Array.isArray(biomes) || biomes.some((b) => typeof b !== 'string')) {
    throw new Error('vantage: manifest biomes must be a string array');
  }
  if (!Array.isArray(tiles)) throw new Error('vantage: manifest missing tiles array');
  const parsedTiles: ManifestTile[] = tiles.map((t: unknown, i: number) => {
    const o = t as Record<string, unknown>;
    if (
      typeof o !== 'object' || o === null ||
      typeof o['x'] !== 'number' || typeof o['z'] !== 'number' ||
      typeof o['path'] !== 'string' || typeof o['bytes'] !== 'number'
    ) {
      throw new Error(`vantage: manifest tile ${i} is malformed`);
    }
    return { x: o['x'], z: o['z'], path: o['path'], bytes: o['bytes'] };
  });

  let spawn: WorldManifest['spawn'];
  const s = m['spawn'] as Record<string, unknown> | undefined;
  if (typeof s === 'object' && s !== null && typeof s['x'] === 'number' && typeof s['y'] === 'number' && typeof s['z'] === 'number') {
    spawn = { x: s['x'], y: s['y'], z: s['z'] };
  }

  return {
    format: 1,
    tileChunks,
    tileBlocks,
    textures,
    ...(spawn ? { spawn } : {}),
    biomes: biomes as string[],
    tiles: parsedTiles,
  };
}
