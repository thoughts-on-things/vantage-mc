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
  /** Opaque source revision. Continuous servers change this only when the
   *  region files that feed this tile (including its seam apron) change. */
  revision?: string;
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
   *  3 = VTL7 compact tiles, 4 = lightmaps, 5 = packed RG8 lightmaps). */
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
  /** True when the render kept full cave geometry (`--caves full`) — the
   *  viewer's depth-slice cave view has real caves to reveal. */
  caves?: boolean;
  /** World-Y extent across all tiles (min inclusive, max exclusive) — the
   *  bounds for the cave view's depth slider. */
  yRange?: { min: number; max: number };
  /** Biome display names indexed by the per-vertex biome id (0 = no data).
   *  Globally consistent across every tile of the render. */
  biomes: string[];
  /** True while the viewer should poll this manifest. A progressive batch
   *  flips false when finished; a continuous server keeps it true so saved
   *  terrain can revise tiles in place. */
  rendering?: boolean;
  /** True for an on-demand live server (`vantage live`): every populated tile
   *  is listed up front but baked lazily on first fetch. Implies `rendering`;
   *  the viewer gates each tile's insertion on the atlas covering its layers. */
  dynamic?: boolean;
  /** Tiles finished / total, for a live progress readout (progressive only). */
  progress?: { done: number; total: number };
  /** Atlas layer count backing `textures`. When it grows between progressive
   *  polls, the viewer re-fetches the texture array (layers are append-only). */
  textureLayers?: number;
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
  if (format !== 1 && format !== 2 && format !== 3 && format !== 4 && format !== 5) {
    throw new Error(`vantage: unsupported manifest format ${String(format)} (expected 1..5)`);
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
      const revision = o['revision'];
      if (revision !== undefined && (typeof revision !== 'string' || revision.length === 0 || revision.length > 128)) {
        throw new Error(`vantage: manifest ${what} ${i} has an invalid revision`);
      }
      return {
        x: o['x'],
        z: o['z'],
        path: o['path'],
        bytes: o['bytes'],
        ...(typeof revision === 'string' ? { revision } : {}),
      };
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

  let yRange: WorldManifest['yRange'];
  const yr = m['yRange'] as Record<string, unknown> | undefined;
  if (typeof yr === 'object' && yr !== null && typeof yr['min'] === 'number' && typeof yr['max'] === 'number' && yr['min'] < yr['max']) {
    yRange = { min: yr['min'], max: yr['max'] };
  }

  const maxSectionVerts = m['maxSectionVerts'];
  const textureLayers = m['textureLayers'];
  const pr = m['progress'] as Record<string, unknown> | undefined;
  const progress =
    typeof pr === 'object' && pr !== null && typeof pr['done'] === 'number' && typeof pr['total'] === 'number'
      ? { done: pr['done'], total: pr['total'] }
      : undefined;
  return {
    format,
    tileChunks,
    tileBlocks,
    textures,
    ...(typeof maxSectionVerts === 'number' && maxSectionVerts > 0 ? { maxSectionVerts } : {}),
    ...(typeof textureLayers === 'number' && textureLayers > 0 ? { textureLayers } : {}),
    ...(m['rendering'] === true ? { rendering: true } : {}),
    ...(m['dynamic'] === true ? { dynamic: true } : {}),
    ...(progress ? { progress } : {}),
    ...(spawn ? { spawn } : {}),
    ...(m['caves'] === true ? { caves: true } : {}),
    ...(yRange ? { yRange } : {}),
    ...(lowres ? { lowres } : {}),
    biomes: biomes as string[],
    tiles: parsedTiles,
  };
}
