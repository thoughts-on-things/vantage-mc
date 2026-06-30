// The Vantage binary tile contract — magic numbers and a small zero-copy reader.
//
// The native generator and this web frontend are decoupled by a documented,
// versioned binary format so each can evolve independently. Every tile starts
// with a 4-byte ASCII magic (`VTLn`) and a u32 version; typed-array fields are
// read as views directly into the source buffer (no copy), which the generator
// keeps naturally aligned.

/** Tile format magics, in order of capability. */
export const TILE_MAGIC = {
  /** Flat per-vertex colour, no textures. */
  VTL1: 'VTL1',
  /** Textured: UV + texture-array layer + tint. */
  VTL2: 'VTL2',
  /** + per-vertex biome id and a named legend. */
  VTL3: 'VTL3',
  /** + a transparent fluid (water) sub-section. */
  VTL4: 'VTL4',
  /** + a top-down surface map for O(ray) biome picking. */
  VTL5: 'VTL5',
  /** Quantized vertices: u16 positions (bbox transform) + u16 layer/biome. */
  VTL6: 'VTL6',
} as const;

export type TileMagic = (typeof TILE_MAGIC)[keyof typeof TILE_MAGIC];

/** Texture-array magic. */
export const TEXTURE_MAGIC = 'VTA1' as const;

/**
 * A forward-only cursor over an `ArrayBuffer`. Scalar reads advance the offset;
 * typed-array reads return zero-copy views into the buffer and advance past them.
 */
export class ByteReader {
  readonly view: DataView;
  off: number;

  constructor(
    readonly buffer: ArrayBuffer,
    off = 0,
  ) {
    this.view = new DataView(buffer);
    this.off = off;
  }

  /** Read a 4-byte ASCII magic without advancing past version fields. */
  magic(): string {
    const { view, off } = this;
    return String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
  }

  u8(): number {
    return this.view.getUint8(this.off++);
  }

  u16(): number {
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.off, true);
    this.off += 4;
    return v;
  }

  f32(n: number): Float32Array<ArrayBuffer> {
    const a = new Float32Array(this.buffer, this.off, n);
    this.off += 4 * n;
    return a;
  }

  u8a(n: number): Uint8Array<ArrayBuffer> {
    const a = new Uint8Array(this.buffer, this.off, n);
    this.off += n;
    return a;
  }

  i8a(n: number): Int8Array<ArrayBuffer> {
    const a = new Int8Array(this.buffer, this.off, n);
    this.off += n;
    return a;
  }

  u16a(n: number): Uint16Array<ArrayBuffer> {
    const a = new Uint16Array(this.buffer, this.off, n);
    this.off += 2 * n;
    return a;
  }

  i16a(n: number): Int16Array<ArrayBuffer> {
    const a = new Int16Array(this.buffer, this.off, n);
    this.off += 2 * n;
    return a;
  }

  u32a(n: number): Uint32Array<ArrayBuffer> {
    const a = new Uint32Array(this.buffer, this.off, n);
    this.off += 4 * n;
    return a;
  }

  /** Advance the cursor to the next 4-byte boundary (skips section padding). */
  align4(): void {
    this.off = (this.off + 3) & ~3;
  }
}
