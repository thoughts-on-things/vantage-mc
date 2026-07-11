// Decode a `.vtexarr` texture array — a stack of equal-size RGBA layers sampled
// per face by the renderer's `sampler2DArray` shader.

import { ByteReader, TEXTURE_MAGIC } from './format.js';

/** One animated texture's playback metadata (version ≥ 2 files). */
export interface TextureAnimation {
  /** First layer of the baked frame sequence — the layer meshes reference. */
  base: number;
  /** Layers in the sequence (the mcmeta frame order is already unrolled). */
  count: number;
  /** Ticks per frame (20 ticks/second). */
  frametime: number;
  /** Blend adjacent frames instead of stepping. */
  interpolate: boolean;
}

/** A decoded texture array: `layers` images of `width`×`height` RGBA pixels. */
export interface DecodedTextureArray {
  width: number;
  height: number;
  layers: number;
  /** `width * height * layers * 4` tightly-packed RGBA bytes. */
  pixels: Uint8Array<ArrayBuffer>;
  /** Animated textures (empty for version-1 files, which bake only frame 0). */
  anims: TextureAnimation[];
}

/**
 * Decode a `.vtexarr` buffer. Version 2 appends an animation table after the
 * pixels; version 1 (no table) still decodes, with `anims` empty.
 *
 * @throws if the magic is not `VTA1`.
 */
export function parseTextureArray(buffer: ArrayBuffer): DecodedTextureArray {
  const r = new ByteReader(buffer);
  const magic = r.magic();
  if (magic !== TEXTURE_MAGIC) {
    throw new Error(`vantage: unrecognized texture magic "${magic}" (expected ${TEXTURE_MAGIC})`);
  }
  r.off = 4;
  const version = r.u32();
  const width = r.u32();
  const height = r.u32();
  const layers = r.u32();
  const pixels = r.u8a(width * height * layers * 4);
  const anims: TextureAnimation[] = [];
  if (version >= 2) {
    const n = r.u32();
    for (let i = 0; i < n; i++) {
      const base = r.u32();
      const count = r.u16();
      const frametime = r.u16();
      const interpolate = r.u8() !== 0;
      r.off += 3; // pad to 12-byte entries
      anims.push({ base, count, frametime, interpolate });
    }
  }
  return { width, height, layers, pixels, anims };
}
