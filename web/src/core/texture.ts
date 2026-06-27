// Decode a `.vtexarr` texture array — a stack of equal-size RGBA layers sampled
// per face by the renderer's `sampler2DArray` shader.

import { ByteReader, TEXTURE_MAGIC } from './format.js';

/** A decoded texture array: `layers` images of `width`×`height` RGBA pixels. */
export interface DecodedTextureArray {
  width: number;
  height: number;
  layers: number;
  /** `width * height * layers * 4` tightly-packed RGBA bytes. */
  pixels: Uint8Array<ArrayBuffer>;
}

/**
 * Decode a `.vtexarr` buffer.
 *
 * @throws if the magic is not `VTA1`.
 */
export function parseTextureArray(buffer: ArrayBuffer): DecodedTextureArray {
  const r = new ByteReader(buffer);
  const magic = r.magic();
  if (magic !== TEXTURE_MAGIC) {
    throw new Error(`vantage: unrecognized texture magic "${magic}" (expected ${TEXTURE_MAGIC})`);
  }
  r.off = 8; // skip magic + version
  const width = r.u32();
  const height = r.u32();
  const layers = r.u32();
  const pixels = r.u8a(width * height * layers * 4);
  return { width, height, layers, pixels };
}
