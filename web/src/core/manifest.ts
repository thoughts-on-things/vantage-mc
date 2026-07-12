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

/** One lowres LOD level: the whole world at 1/2^level detail, in tiles of
 *  `tileBlocks` blocks (each a fixed cell grid — see {@link WorldManifest.lowres}). */
export interface LowresLevel {
  /** Pyramid level (1 = half detail, 2 = quarter, …). */
  level: number;
  /** Tile span in blocks per side at this level (hires tileBlocks · 2^level). */
  tileBlocks: number;
  /** Blocks per heightfield cell (2^level). */
  span: number;
  tiles: ManifestTile[];
}

/** A parsed `manifest.json` for a tiled world render. */
export interface WorldManifest {
  /** Manifest schema version (1 = hires tiles only, 2 adds `lowres`,
   *  3 = VTL7 compact tiles + `maxSectionVerts`). */
  format: number;
  /** Largest per-section vertex count across every tile (format 3+) — sizes
   *  the renderer's one shared quad index buffer before the first tile lands. */
  maxSectionVerts?: number;
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
  /** The lowres LOD pyramid (format 2+): coarse whole-world tiles the viewer
   *  keeps resident far beyond the hires ring, so zoom-out shows the world. */
  lowres?: {
    /** Heightfield samples per lowres tile edge (cells + 1 shared-edge apron). */
    grid: number;
    levels: LowresLevel[];
  };
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
  const format = m['format'];
  if (format !== 1 && format !== 2 && format !== 3) {
    throw new Error(`vantage: unsupported manifest format ${String(format)} (expected 1..3)`);
  }
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
  const parseTiles = (list: unknown[], what: string): ManifestTile[] =>
    list.map((t: unknown, i: number) => {
      const o = t as Record<string, unknown>;
      if (
        typeof o !== 'object' || o === null ||
        typeof o['x'] !== 'number' || typeof o['z'] !== 'number' ||
        typeof o['path'] !== 'string' || typeof o['bytes'] !== 'number'
      ) {
        throw new Error(`vantage: manifest ${what} ${i} is malformed`);
      }
      return { x: o['x'], z: o['z'], path: o['path'], bytes: o['bytes'] };
    });
  const parsedTiles = parseTiles(tiles, 'tile');

  let lowres: WorldManifest['lowres'];
  const lr = m['lowres'] as Record<string, unknown> | undefined;
  if (typeof lr === 'object' && lr !== null) {
    const grid = lr['grid'];
    const levels = lr['levels'];
    if (typeof grid !== 'number' || grid < 2 || !Array.isArray(levels)) {
      throw new Error('vantage: manifest lowres section is malformed');
    }
    lowres = {
      grid,
      levels: levels.map((lv: unknown, i: number) => {
        const o = lv as Record<string, unknown>;
        if (
          typeof o !== 'object' || o === null ||
          typeof o['level'] !== 'number' || typeof o['tileBlocks'] !== 'number' ||
          typeof o['span'] !== 'number' || !Array.isArray(o['tiles'])
        ) {
          throw new Error(`vantage: manifest lowres level ${i} is malformed`);
        }
        return {
          level: o['level'],
          tileBlocks: o['tileBlocks'],
          span: o['span'],
          tiles: parseTiles(o['tiles'], `lowres level ${o['level']} tile`),
        };
      }),
    };
  }

  let spawn: WorldManifest['spawn'];
  const s = m['spawn'] as Record<string, unknown> | undefined;
  if (typeof s === 'object' && s !== null && typeof s['x'] === 'number' && typeof s['y'] === 'number' && typeof s['z'] === 'number') {
    spawn = { x: s['x'], y: s['y'], z: s['z'] };
  }

  const maxSectionVerts = m['maxSectionVerts'];
  return {
    format,
    tileChunks,
    tileBlocks,
    textures,
    ...(typeof maxSectionVerts === 'number' && maxSectionVerts > 0 ? { maxSectionVerts } : {}),
    ...(spawn ? { spawn } : {}),
    ...(lowres ? { lowres } : {}),
    biomes: biomes as string[],
    tiles: parsedTiles,
  };
}
