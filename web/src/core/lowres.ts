// Decode a `.vlr` lowres LOD tile — a colored heightfield the viewer keeps
// resident far beyond the hires ring. No three.js, no DOM.

import { ByteReader } from './format.js';

export const LOWRES_MAGIC = 'VLR1';

/** Height sentinel for samples with no terrain (unpopulated chunks). */
export const LOWRES_EMPTY = -32768;

/**
 * A decoded lowres tile: a `width`×`depth` grid of (height, color) samples.
 * Sample (i,j) sits at world (originX + (i+0.5)·span, originZ + (j+0.5)·span);
 * the last row/column duplicates the +x/+z neighbours' first samples so
 * adjacent tiles share edge vertices (seamless heightfields).
 */
export interface LowresTile {
  /** Samples per row. */
  width: number;
  /** Sample rows. */
  depth: number;
  /** World block coords of cell (0,0)'s corner. */
  originX: number;
  originZ: number;
  /** Blocks per cell (2^level). */
  span: number;
  /** `width·depth` world-Y heights of the top block ({@link LOWRES_EMPTY} = none). */
  heights: Int16Array;
  /** `3·width·depth` sRGB colors (lighting/tint baked by the generator). */
  rgb: Uint8Array;
}

/**
 * Decode a `.vlr` buffer (gunzip first via `maybeInflate` when fetched raw).
 *
 * @throws if the magic is not `VLR1`.
 */
export function parseLowresTile(buffer: ArrayBuffer): LowresTile {
  const r = new ByteReader(buffer);
  const magic = r.magic();
  if (magic !== LOWRES_MAGIC) throw new Error(`vantage: unrecognized lowres magic "${magic}" (expected VLR1)`);
  r.off = 4;
  const version = r.u32();
  if (version !== 1) throw new Error(`vantage: unsupported VLR version ${version}`);
  const width = r.u32();
  const depth = r.u32();
  const originX = r.i32();
  const originZ = r.i32();
  const span = r.u32();
  const n = width * depth;
  const heights = r.i16a(n);
  const rgb = r.u8a(3 * n);
  return { width, depth, originX, originZ, span, heights, rgb };
}
