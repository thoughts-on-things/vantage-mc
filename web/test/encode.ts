// Minimal encoders that mirror the native generator's byte layout, so the core
// decoder can be tested by round-tripping each tile version without shipping
// multi-MB binary fixtures. The field order here is the format contract.

class Writer {
  private readonly buf: ArrayBuffer;
  private readonly view: DataView;
  off = 0;

  constructor(capacity = 1 << 16) {
    this.buf = new ArrayBuffer(capacity);
    this.view = new DataView(this.buf);
  }

  magic(s: string): this {
    for (let i = 0; i < 4; i++) this.view.setUint8(this.off++, s.charCodeAt(i));
    return this;
  }
  u32(v: number): this {
    this.view.setUint32(this.off, v, true);
    this.off += 4;
    return this;
  }
  i32(v: number): this {
    this.view.setInt32(this.off, v, true);
    this.off += 4;
    return this;
  }
  u16(v: number): this {
    this.view.setUint16(this.off, v, true);
    this.off += 2;
    return this;
  }
  f32a(a: number[]): this {
    for (const v of a) {
      this.view.setFloat32(this.off, v, true);
      this.off += 4;
    }
    return this;
  }
  u32a(a: number[]): this {
    for (const v of a) this.u32(v);
    return this;
  }
  u16a(a: number[]): this {
    for (const v of a) this.u16(v);
    return this;
  }
  i16a(a: number[]): this {
    for (const v of a) {
      this.view.setInt16(this.off, v, true);
      this.off += 2;
    }
    return this;
  }
  u8a(a: number[]): this {
    for (const v of a) this.view.setUint8(this.off++, v);
    return this;
  }
  i8a(a: number[]): this {
    for (const v of a) this.view.setInt8(this.off++, v);
    return this;
  }
  buffer(): ArrayBuffer {
    return this.buf.slice(0, this.off);
  }
}

/** One textured+biome section's worth of raw arrays. */
export interface SectionInput {
  positions: number[]; // 3 * V
  uv: number[]; // 2 * V
  layer: number[]; // V
  colors: number[]; // 4 * V
  normals: number[]; // 4 * V (xyzw int8)
  biome: number[]; // V
  indices: number[]; // I
}

function writeSection(w: Writer, s: SectionInput): void {
  w.u32(s.layer.length).u32(s.indices.length);
  w.f32a(s.positions).f32a(s.uv).f32a(s.layer).u8a(s.colors).i8a(s.normals).f32a(s.biome).u32a(s.indices);
}

function writeLegend(w: Writer, names: string[]): void {
  w.u32(names.length);
  const enc = new TextEncoder();
  for (const name of names) {
    const b = enc.encode(name);
    w.u16(b.length).u8a(Array.from(b));
  }
}

/** A tiny one-triangle section with the given per-vertex biome ids. */
export function sampleSection(biome: number[]): SectionInput {
  const V = biome.length;
  return {
    positions: Array.from({ length: 3 * V }, (_, i) => i * 0.5),
    uv: Array.from({ length: 2 * V }, (_, i) => (i % 2) * 1.0),
    layer: Array.from({ length: V }, (_, i) => i),
    colors: Array.from({ length: 4 * V }, (_, i) => (i * 7) % 256),
    normals: Array.from({ length: 4 * V }, (_, i) => (i % 3) - 1),
    biome,
    indices: Array.from({ length: V }, (_, i) => i),
  };
}

export const LEGEND = ['', 'minecraft:plains', 'minecraft:savanna'];

export function encodeVTL1(): ArrayBuffer {
  const w = new Writer();
  w.magic('VTL1').u32(1);
  const V = 3;
  w.u32(V).u32(V);
  w.f32a([0, 0, 0, 1, 0, 0, 0, 1, 0]); // positions
  w.u8a(Array.from({ length: 4 * V }, (_, i) => i * 10)); // colors
  w.i8a([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]); // normals xyzw
  w.u32a([0, 1, 2]); // indices
  return w.buffer();
}

export function encodeVTL2(): ArrayBuffer {
  const w = new Writer();
  w.magic('VTL2').u32(2);
  const s = sampleSection([0, 0, 0]);
  w.u32(3).u32(3);
  w.f32a(s.positions).f32a(s.uv).f32a(s.layer).u8a(s.colors).i8a(s.normals).u32a(s.indices);
  return w.buffer();
}

export function encodeVTL3(): ArrayBuffer {
  const w = new Writer();
  w.magic('VTL3').u32(3);
  writeSection(w, sampleSection([1, 2, 1]));
  writeLegend(w, LEGEND);
  return w.buffer();
}

/** A VTL3 tile from explicit positions + per-vertex biome ids (real faces are
 *  biome-uniform), for exercising the area-weighted biome summary. */
export function encodeVTL3Geo(positions: number[], biome: number[], indices: number[]): ArrayBuffer {
  const V = biome.length;
  const s: SectionInput = {
    positions,
    uv: Array.from({ length: 2 * V }, () => 0),
    layer: Array.from({ length: V }, () => 0),
    colors: Array.from({ length: 4 * V }, () => 255),
    normals: Array.from({ length: 4 * V }, () => 0),
    biome,
    indices,
  };
  const w = new Writer();
  w.magic('VTL3').u32(3);
  writeSection(w, s);
  writeLegend(w, LEGEND);
  return w.buffer();
}

export function encodeVTL4(): ArrayBuffer {
  const w = new Writer();
  w.magic('VTL4').u32(4);
  writeSection(w, sampleSection([1, 2, 1]));
  writeSection(w, sampleSection([1, 1, 1])); // fluid
  writeLegend(w, LEGEND);
  return w.buffer();
}

export function encodeVTL5(): ArrayBuffer {
  const w = new Writer();
  w.magic('VTL5').u32(5);
  writeSection(w, sampleSection([1, 2, 1]));
  writeSection(w, sampleSection([1, 1, 1])); // fluid
  // surface map: 2x2 columns at origin (0,0)
  w.u32(2).u32(2).i32(0).i32(0);
  w.u16a([1, 2, 1, 2]); // biome ids
  w.i16a([64, 65, 66, 67]); // heights
  writeLegend(w, LEGEND);
  return w.buffer();
}

export function encodeTextureArray(width = 2, height = 2, layers = 3): ArrayBuffer {
  const w = new Writer();
  w.magic('VTA1').u32(1).u32(width).u32(height).u32(layers);
  const n = width * height * layers * 4;
  w.u8a(Array.from({ length: n }, (_, i) => i % 256));
  return w.buffer();
}
