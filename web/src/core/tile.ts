// Decode a `.vtile` into typed, renderer-agnostic geometry. No three.js, no DOM.

import { ByteReader, TILE_MAGIC, UV_SCALE, type TileMagic } from './format.js';

/**
 * One indexed geometry section. The solid terrain is the top-level section;
 * VTL4+ tiles carry an additional transparent {@link DecodedTile.fluid} section
 * in the same shape.
 */
export interface MeshSection {
  /** Vertex count. */
  vertexCount: number;
  /** Index count (triangles = indexCount / 3). */
  indexCount: number;
  /** `3 * vertexCount` packed XYZ positions. */
  positions: Float32Array;
  /** `3 * vertexCount` normals, expanded from the packed int8 storage. */
  normals: Float32Array;
  /** `indexCount` triangle indices. */
  indices: Uint32Array;
  /** `2 * vertexCount` texture coordinates (textured tiles only). */
  uv?: Float32Array;
  /** `vertexCount` texture-array layer indices (textured tiles only). */
  layer?: Float32Array;
  /** `4 * vertexCount` RGBA: tint RGB + packed AO/alpha (textured tiles only). */
  colors?: Uint8Array;
  /** `vertexCount` per-vertex biome ids (biome tiles only). */
  biome?: Float32Array;
  /** `vertexCount` packed saved light `(sky << 4) | block` (each 0..15), carried
   *  in the normal's spare 4th byte. Textured tiles only. */
  light?: Uint8Array;
  /** VTL8+: the first vertex of the atlas-lit tail (== vertexCount when the
   *  whole section is vertex-lit). */
  lmStart?: number;
  /** VTL8+: the tail's lightmap UVs in half-texel units (delta coding undone). */
  lmuv?: Uint16Array;
}

/**
 * A top-down surface map (VTL5): one column per XZ cell over a world-space
 * footprint. Enables O(ray-length) biome picking independent of mesh size.
 */
export interface SurfaceMap {
  /** Columns in X. */
  width: number;
  /** Columns in Z. */
  depth: number;
  /** World X of column 0. */
  originX: number;
  /** World Z of column 0. */
  originZ: number;
  /** `width * depth` biome ids, row-major (z-major). */
  biome: Uint16Array;
  /** `width * depth` surface heights, row-major (z-major). */
  height: Int16Array;
}

/** A fully decoded tile. Optional fields are present per format capability. */
export interface DecodedTile extends MeshSection {
  /** The format magic this tile was decoded from. */
  magic: TileMagic;
  /** Format version field. */
  version: number;
  /** Whether the tile carries textures (VTL2+). */
  textured: boolean;
  /** Whether the tile carries biome data (VTL3+). */
  hasBiome: boolean;
  /** Biome legend, indexed by biome id (VTL3+). */
  biomeNames?: string[];
  /** Transparent fluid geometry, drawn after opaque terrain (VTL4+). */
  fluid?: MeshSection;
  /** Top-down surface map for picking (VTL5+). */
  surface?: SurfaceMap;
  /** The baked light+AO atlas (VTL8+ with atlas-lit geometry only). */
  lightmap?: Lightmap;
}

/**
 * A VTL6 mesh section kept in its on-disk quantized encoding: every array is a
 * zero-copy view into the tile buffer, ready to hand straight to the GPU. The
 * dequantization (`world = posMin + q * posScale`) happens in the vertex
 * shader, so decoding a tile costs no per-vertex CPU work at all and streaming
 * never stutters on decode.
 */
export interface QuantizedSection {
  vertexCount: number;
  indexCount: number;
  /** `3 * vertexCount` quantized u16 positions. */
  positions: Uint16Array;
  /** World-space position of quantized (0,0,0). */
  posMin: [number, number, number];
  /** World units per quantization step, per axis. */
  posScale: [number, number, number];
  /** `2 * vertexCount` texture coordinates — f32 (VTL6) or i16 fixed point
   *  (VTL7); multiply by {@link QuantizedSection.uvScale} for texture units. */
  uv: Float32Array | Int16Array;
  /** Texture units per stored uv step (1 for f32, 1/128 for VTL7's i16). */
  uvScale: number;
  /** `4 * vertexCount` RGBA: tint RGB + packed AO/alpha. */
  colors: Uint8Array;
  /** `4 * vertexCount` int8: xyz normal + the packed light byte as the 4th
   *  component (bit pattern; recover unsigned in-shader). */
  normals: Int8Array;
  /** `vertexCount` u16 texture-array layer indices. */
  layer: Uint16Array;
  /** `vertexCount` u16 biome ids. */
  biome: Uint16Array;
  /** `indexCount` triangle indices — `null` for VTL7+, whose canonical quad
   *  topology `[b,b+1,b+2, b,b+2,b+3]` the renderer derives (and shares one
   *  GPU index buffer across every tile). */
  indices: Uint32Array | null;
  /** VTL8+: the first vertex of the atlas-lit tail (== vertexCount when the
   *  whole section is vertex-lit). */
  lmStart?: number;
  /** VTL8+: the tail's lightmap UVs in half-texel units, `2 * (vertexCount -
   *  lmStart)` values (delta coding already undone). */
  lmuv?: Uint16Array;
  /** VTLA+: first cave-dark vertex of the vertex-lit head `[0, lmStart)`.
   *  Vertices from here to `lmStart` face only sky-light-0 (non-water) cells —
   *  a renderer may skip them while the camera is above ground. */
  caveStart?: number;
  /** VTLA+: first cave-dark vertex of the atlas-lit tail `[lmStart, V)`. */
  caveLmStart?: number;
}

/** A tile's baked light+AO atlas. VTL8 expands its planar payload to RGBA;
 *  VTL9 interleaves its packed-light/AO planes into a compact RG8 upload. */
export interface Lightmap {
  width: number;
  height: number;
  /** True for VTL9's two-byte RG8 representation. */
  packed: boolean;
  /** RGBA bytes when unpacked; interleaved packed-light/AO bytes otherwise. */
  pixels: Uint8Array<ArrayBuffer>;
}

/** A VTL6/7/8/9/A tile decoded without dequantization (see {@link QuantizedSection}). */
export interface QuantizedTile {
  magic: 'VTL6' | 'VTL7' | 'VTL8' | 'VTL9' | 'VTLA';
  version: number;
  solid: QuantizedSection;
  fluid: QuantizedSection;
  surface: SurfaceMap;
  biomeNames: string[];
  /** The baked light+AO atlas (VTL8+ with atlas-lit geometry only). */
  lightmap?: Lightmap;
}

/** The canonical quad index pattern for `vertexCount` vertices (4 verts / 6
 *  indices per face) — the topology every Vantage mesher emits. */
export function canonicalQuadIndices(vertexCount: number): Uint32Array {
  const out = new Uint32Array((vertexCount / 4) * 6);
  for (let b = 0, o = 0; b < vertexCount; b += 4) {
    out[o++] = b;
    out[o++] = b + 1;
    out[o++] = b + 2;
    out[o++] = b;
    out[o++] = b + 2;
    out[o++] = b + 3;
  }
  return out;
}

/** Undo VTL7's per-component zigzag delta coding: returns a fresh Uint16Array
 *  of absolute quantized positions (the source view stays untouched, so the
 *  same buffer can be parsed more than once). */
function decodeDeltaPositions(zz: Uint16Array, vertexCount: number): Uint16Array {
  const out = new Uint16Array(3 * vertexCount);
  let px = 0, py = 0, pz = 0;
  for (let i = 0; i < vertexCount; i++) {
    let z = zz[i * 3]!;
    px = (px + ((z >>> 1) ^ -(z & 1))) & 0xffff;
    out[i * 3] = px;
    z = zz[i * 3 + 1]!;
    py = (py + ((z >>> 1) ^ -(z & 1))) & 0xffff;
    out[i * 3 + 1] = py;
    z = zz[i * 3 + 2]!;
    pz = (pz + ((z >>> 1) ^ -(z & 1))) & 0xffff;
    out[i * 3 + 2] = pz;
  }
  return out;
}

/** Undo the zigzag delta coding of a 2-component u16 stream (VTL8 lmuv). */
function decodeDeltaPairs(zz: Uint16Array): Uint16Array {
  const out = new Uint16Array(zz.length);
  let pu = 0, pv = 0;
  for (let i = 0; i * 2 < zz.length; i++) {
    let z = zz[i * 2]!;
    pu = (pu + ((z >>> 1) ^ -(z & 1))) & 0xffff;
    out[i * 2] = pu;
    z = zz[i * 2 + 1]!;
    pv = (pv + ((z >>> 1) ^ -(z & 1))) & 0xffff;
    out[i * 2 + 1] = pv;
  }
  return out;
}

/** Expand packed int8 `xyzw` normals into float `xyz`. */
function expandNormals(packed: Int8Array, vertexCount: number): Float32Array {
  const out = new Float32Array(3 * vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    out[i * 3 + 0] = packed[i * 4 + 0]!;
    out[i * 3 + 1] = packed[i * 4 + 1]!;
    out[i * 3 + 2] = packed[i * 4 + 2]!;
  }
  return out;
}

/** Pull the packed light byte (the normal's 4th component) out as unsigned. */
function extractLight(packed: Int8Array, vertexCount: number): Uint8Array {
  const out = new Uint8Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) out[i] = packed[i * 4 + 3]! & 0xff;
  return out;
}

/** Read a textured+biome mesh section (VTL3 layout) at the reader's cursor. */
function readTexturedBiomeSection(r: ByteReader): MeshSection {
  const vertexCount = r.u32();
  const indexCount = r.u32();
  const positions = r.f32(3 * vertexCount);
  const uv = r.f32(2 * vertexCount);
  const layer = r.f32(vertexCount);
  const colors = r.u8a(4 * vertexCount);
  const normalsI8 = r.i8a(4 * vertexCount);
  const biome = r.f32(vertexCount);
  const indices = r.u32a(indexCount);
  return {
    vertexCount, indexCount, positions, uv, layer, colors, biome,
    normals: expandNormals(normalsI8, vertexCount),
    light: extractLight(normalsI8, vertexCount),
    indices,
  };
}

/**
 * Read a VTL6 quantized mesh section: uv/colour/normal/indices unchanged, then
 * a per-axis bounding box, u16 positions (world = min + q·scale), and u16
 * layer/biome ids. Positions/layer/biome are expanded back to Float32 so the
 * decoded section is shape-identical to the unquantized VTL3/4/5 readers.
 */
function readQuantizedSection(r: ByteReader): MeshSection {
  const vertexCount = r.u32();
  const indexCount = r.u32();
  const uv = r.f32(2 * vertexCount);
  const colors = r.u8a(4 * vertexCount);
  const normalsI8 = r.i8a(4 * vertexCount);
  const indices = r.u32a(indexCount);
  const bbox = r.f32(6); // min xyz, scale xyz
  const mnx = bbox[0]!, mny = bbox[1]!, mnz = bbox[2]!;
  const scx = bbox[3]!, scy = bbox[4]!, scz = bbox[5]!;
  const posQ = r.u16a(3 * vertexCount);
  const layerQ = r.u16a(vertexCount);
  const biomeQ = r.u16a(vertexCount);
  r.align4(); // skip the section's tail padding

  const positions = new Float32Array(3 * vertexCount);
  const layer = new Float32Array(vertexCount);
  const biome = new Float32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3 + 0] = mnx + posQ[i * 3 + 0]! * scx;
    positions[i * 3 + 1] = mny + posQ[i * 3 + 1]! * scy;
    positions[i * 3 + 2] = mnz + posQ[i * 3 + 2]! * scz;
    layer[i] = layerQ[i]!;
    biome[i] = biomeQ[i]!;
  }
  return {
    vertexCount, indexCount, positions, uv, layer, colors, biome,
    normals: expandNormals(normalsI8, vertexCount),
    light: extractLight(normalsI8, vertexCount),
    indices,
  };
}

/** Read a VTL6 section WITHOUT dequantizing — all fields stay zero-copy views. */
function readQuantizedSectionRaw(r: ByteReader): QuantizedSection {
  const vertexCount = r.u32();
  const indexCount = r.u32();
  const uv = r.f32(2 * vertexCount);
  const colors = r.u8a(4 * vertexCount);
  const normals = r.i8a(4 * vertexCount);
  const indices = r.u32a(indexCount);
  const bbox = r.f32(6); // min xyz, scale xyz
  const posMin: [number, number, number] = [bbox[0]!, bbox[1]!, bbox[2]!];
  const posScale: [number, number, number] = [bbox[3]!, bbox[4]!, bbox[5]!];
  const positions = r.u16a(3 * vertexCount);
  const layer = r.u16a(vertexCount);
  const biome = r.u16a(vertexCount);
  r.align4(); // skip the section's tail padding
  return { vertexCount, indexCount, positions, posMin, posScale, uv, uvScale: 1, colors, normals, layer, biome, indices };
}

/** Read a VTL7 compact section: no index array, i16 uv, delta-coded positions.
 *  Everything except positions stays a zero-copy view; positions decode into a
 *  fresh absolute-u16 array (one cheap linear pass). */
function readCompactSectionRaw(r: ByteReader): QuantizedSection {
  const vertexCount = r.u32();
  const uv = r.i16a(2 * vertexCount);
  const colors = r.u8a(4 * vertexCount);
  const normals = r.i8a(4 * vertexCount);
  const bbox = r.f32(6); // min xyz, scale xyz
  const posMin: [number, number, number] = [bbox[0]!, bbox[1]!, bbox[2]!];
  const posScale: [number, number, number] = [bbox[3]!, bbox[4]!, bbox[5]!];
  const positions = decodeDeltaPositions(r.u16a(3 * vertexCount), vertexCount);
  const layer = r.u16a(vertexCount);
  const biome = r.u16a(vertexCount);
  r.align4(); // skip the section's tail padding
  return {
    vertexCount,
    indexCount: (vertexCount / 4) * 6,
    positions, posMin, posScale,
    uv, uvScale: 1 / UV_SCALE,
    colors, normals, layer, biome,
    indices: null,
  };
}

/** Read a VTL8+ lit section: a VTL7 compact section with `lmStart` after the
 *  vertex count and the atlas tail's delta-coded lmuv after the biome ids.
 *  VTLA adds the two cave-partition boundaries after `lmStart`. */
function readLitSectionRaw(r: ByteReader, withCave: boolean): QuantizedSection {
  const vertexCount = r.u32();
  const lmStart = r.u32();
  const caveStart = withCave ? r.u32() : undefined;
  const caveLmStart = withCave ? r.u32() : undefined;
  // Validate the header before sizing any typed-array view off it — a
  // truncated or hostile buffer must fail HERE with a clear error, not as
  // negative view lengths or garbage draw ranges downstream. Every boundary
  // is a quad-aligned vertex index; the writer asserts the same ordering
  // (cave_start ≤ lm_start ≤ cave_lm_start ≤ V).
  if (vertexCount % 4 !== 0 || lmStart % 4 !== 0 || lmStart > vertexCount) {
    throw new Error(`vantage: corrupt lit section header (V=${vertexCount}, lmStart=${lmStart})`);
  }
  if (caveStart !== undefined && caveLmStart !== undefined) {
    if (caveStart % 4 !== 0 || caveLmStart % 4 !== 0 || caveStart > lmStart || caveLmStart < lmStart || caveLmStart > vertexCount) {
      throw new Error(
        `vantage: corrupt VTLA cave boundaries (V=${vertexCount}, lmStart=${lmStart}, caveStart=${caveStart}, caveLmStart=${caveLmStart})`,
      );
    }
  }
  const uv = r.i16a(2 * vertexCount);
  const colors = r.u8a(4 * vertexCount);
  const normals = r.i8a(4 * vertexCount);
  const bbox = r.f32(6); // min xyz, scale xyz
  const posMin: [number, number, number] = [bbox[0]!, bbox[1]!, bbox[2]!];
  const posScale: [number, number, number] = [bbox[3]!, bbox[4]!, bbox[5]!];
  const positions = decodeDeltaPositions(r.u16a(3 * vertexCount), vertexCount);
  const layer = r.u16a(vertexCount);
  const biome = r.u16a(vertexCount);
  const lmuv = decodeDeltaPairs(r.u16a(2 * (vertexCount - lmStart)));
  r.align4(); // skip the section's tail padding
  return {
    vertexCount,
    indexCount: (vertexCount / 4) * 6,
    positions, posMin, posScale,
    uv, uvScale: 1 / UV_SCALE,
    colors, normals, layer, biome,
    indices: null,
    lmStart, lmuv,
    ...(caveStart !== undefined ? { caveStart, caveLmStart } : {}),
  };
}

/** Read a VTL8 atlas: three planar channels expanded to interleaved RGBA. */
function readLightmap(r: ByteReader): Lightmap | undefined {
  const width = r.u32();
  const height = r.u32();
  const n = width * height;
  if (n === 0) return undefined;
  const sky = r.u8a(n);
  const blk = r.u8a(n);
  const ao = r.u8a(n);
  const pixels = new Uint8Array(4 * n);
  for (let i = 0; i < n; i++) {
    pixels[i * 4 + 0] = sky[i]!;
    pixels[i * 4 + 1] = blk[i]!;
    pixels[i * 4 + 2] = ao[i]!;
    pixels[i * 4 + 3] = 255;
  }
  return { width, height, packed: false, pixels };
}

/** Read VTL9's two gzip-friendly planes into compact upload-ready RG8. */
function readPackedLightmap(r: ByteReader): Lightmap | undefined {
  const width = r.u32();
  const height = r.u32();
  const n = width * height;
  if (n === 0) return undefined;
  const light = r.u8a(n);
  const ao = r.u8a(n);
  const pixels = new Uint8Array(2 * n);
  for (let i = 0; i < n; i++) {
    pixels[i * 2] = light[i]!;
    pixels[i * 2 + 1] = ao[i]!;
  }
  return { width, height, packed: true, pixels };
}

/** Expand a raw quantized section the classic on-CPU way (shape-identical to
 *  the VTL3..6 readers): f32 uv/positions, synthesized canonical indices. */
function expandSection(raw: QuantizedSection): MeshSection {
  const { vertexCount, indexCount } = raw;
  const positions = new Float32Array(3 * vertexCount);
  const uv = new Float32Array(2 * vertexCount);
  const layer = new Float32Array(vertexCount);
  const biome = new Float32Array(vertexCount);
  const [mnx, mny, mnz] = raw.posMin;
  const [scx, scy, scz] = raw.posScale;
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3 + 0] = mnx + raw.positions[i * 3 + 0]! * scx;
    positions[i * 3 + 1] = mny + raw.positions[i * 3 + 1]! * scy;
    positions[i * 3 + 2] = mnz + raw.positions[i * 3 + 2]! * scz;
    uv[i * 2 + 0] = raw.uv[i * 2 + 0]! * raw.uvScale;
    uv[i * 2 + 1] = raw.uv[i * 2 + 1]! * raw.uvScale;
    layer[i] = raw.layer[i]!;
    biome[i] = raw.biome[i]!;
  }
  return {
    vertexCount, indexCount, positions, uv, layer, biome,
    colors: raw.colors,
    normals: expandNormals(raw.normals, vertexCount),
    light: extractLight(raw.normals, vertexCount),
    indices: canonicalQuadIndices(vertexCount),
    ...(raw.lmStart !== undefined ? { lmStart: raw.lmStart, lmuv: raw.lmuv } : {}),
  };
}

function readCompactSection(r: ByteReader): MeshSection {
  return expandSection(readCompactSectionRaw(r));
}

/** Write the atlas' corner texels back into the tail's per-vertex light/AO.
 *  A vertex's lmuv points at a texel CENTRE (half-texel units, +1 bias), so
 *  `(v - 1) / 2` recovers the exact integer texel = that corner's sample. */
function bakeVertexLight(sec: MeshSection, lm: Lightmap): void {
  const { lmStart, lmuv } = sec;
  if (lmStart === undefined || !lmuv || lmStart >= sec.vertexCount) return;
  const colors = sec.colors!.slice(); // the zero-copy view must stay pristine
  const light = sec.light!;
  for (let i = lmStart; i < sec.vertexCount; i++) {
    const k = i - lmStart;
    const u = (lmuv[k * 2]! - 1) >> 1;
    const v = (lmuv[k * 2 + 1]! - 1) >> 1;
    const texel = v * lm.width + u;
    const o = texel * (lm.packed ? 2 : 4);
    const packed = lm.packed ? lm.pixels[o]! : 0;
    const sky = lm.packed ? packed >> 4 : Math.round(lm.pixels[o]! / 17);
    const blk = lm.packed ? packed & 15 : Math.round(lm.pixels[o + 1]! / 17);
    light[i] = (sky << 4) | blk;
    colors[i * 4 + 3] = lm.pixels[o + (lm.packed ? 1 : 2)]!; // AO
  }
  sec.colors = colors;
}

/**
 * Decode a VTL6+ `.vtile` in its quantized on-disk encoding: arrays are
 * zero-copy views (VTL7 positions take one linear delta-decode pass) and stay
 * u16/i16 for the vertex shader to dequantize (the streaming fast path — no
 * per-vertex float expansion). Returns `null` for any other tile version;
 * callers fall back to {@link parseTile}.
 */
export function parseTileQuantized(buffer: ArrayBuffer): QuantizedTile | null {
  const r = new ByteReader(buffer);
  const magic = r.magic();
  if (
    magic !== TILE_MAGIC.VTL6 && magic !== TILE_MAGIC.VTL7 && magic !== TILE_MAGIC.VTL8 &&
    magic !== TILE_MAGIC.VTL9 && magic !== TILE_MAGIC.VTLA
  ) return null;
  r.off = 4;
  const version = r.u32();
  const readSection =
    magic === TILE_MAGIC.VTL8 || magic === TILE_MAGIC.VTL9 || magic === TILE_MAGIC.VTLA
      ? (reader: ByteReader) => readLitSectionRaw(reader, magic === TILE_MAGIC.VTLA)
    : magic === TILE_MAGIC.VTL7 ? readCompactSectionRaw
    : readQuantizedSectionRaw;
  const solid = readSection(r);
  const fluid = readSection(r);
  const lightmap = magic === TILE_MAGIC.VTL9 || magic === TILE_MAGIC.VTLA ? readPackedLightmap(r)
    : magic === TILE_MAGIC.VTL8 ? readLightmap(r)
    : undefined;
  const surface = readSurface(r);
  const biomeNames = readLegend(r);
  return { magic, version, solid, fluid, surface, biomeNames, ...(lightmap ? { lightmap } : {}) };
}

/** Read the VTL5 surface map at the reader's cursor. */
function readSurface(r: ByteReader): SurfaceMap {
  const width = r.u32();
  const depth = r.u32();
  const originX = r.i32();
  const originZ = r.i32();
  const n = width * depth;
  const biome = r.u16a(n);
  const height = r.i16a(n);
  return { width, depth, originX, originZ, biome, height };
}

/** Read a biome legend (count-prefixed length-prefixed UTF-8 strings). */
function readLegend(r: ByteReader): string[] {
  const count = r.u32();
  const dec = new TextDecoder();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = r.u16();
    names.push(dec.decode(r.u8a(len)));
  }
  return names;
}

/**
 * Decode a `.vtile` buffer. Detects the format version from the magic and
 * returns a {@link DecodedTile} with exactly the fields that version carries.
 *
 * @throws if the magic is not a recognized `VTLn`.
 */
export function parseTile(buffer: ArrayBuffer): DecodedTile {
  const r = new ByteReader(buffer);
  const magic = r.magic();
  r.off = 4;
  const version = r.u32();

  // VTL8/9/A = VTL7 + a per-tile lightmap atlas for the greedy vertex tail;
  // VTL9+ keeps the upload losslessly packed in compact RG8, VTLA adds the
  // cave-partition boundaries (the classic expand path draws everything, so
  // it only needs to skip past them).
  if (magic === TILE_MAGIC.VTL8 || magic === TILE_MAGIC.VTL9 || magic === TILE_MAGIC.VTLA) {
    const withCave = magic === TILE_MAGIC.VTLA;
    const solid = expandSection(readLitSectionRaw(r, withCave));
    const fluid = expandSection(readLitSectionRaw(r, withCave));
    const lightmap = magic === TILE_MAGIC.VTL8 ? readLightmap(r) : readPackedLightmap(r);
    // The atlas-lit tail carries placeholder vertex light; bake the atlas'
    // CORNER texels back into per-vertex values so non-atlas renderers (the
    // classic buildTerrain path) still light this geometry. (The streaming
    // path samples the atlas per fragment instead — full gradients.)
    if (lightmap) bakeVertexLight(solid, lightmap);
    const surface = readSurface(r);
    const biomeNames = readLegend(r);
    return {
      magic, version, textured: true, hasBiome: true, ...solid, biomeNames, fluid, surface,
      ...(lightmap ? { lightmap } : {}),
    };
  }

  // VTL7 = VTL6 minus the (derivable) index array, with delta-coded positions
  // and i16 fixed-point uv. Same section count + surface + legend.
  if (magic === TILE_MAGIC.VTL7) {
    const solid = readCompactSection(r);
    const fluid = readCompactSection(r);
    const surface = readSurface(r);
    const biomeNames = readLegend(r);
    return { magic, version, textured: true, hasBiome: true, ...solid, biomeNames, fluid, surface };
  }

  // VTL6 = VTL5 with quantized vertices (u16 positions + layer/biome). Same
  // section count + surface + legend; only the per-vertex decode differs.
  if (magic === TILE_MAGIC.VTL6) {
    const solid = readQuantizedSection(r);
    const fluid = readQuantizedSection(r);
    const surface = readSurface(r);
    const biomeNames = readLegend(r);
    return { magic, version, textured: true, hasBiome: true, ...solid, biomeNames, fluid, surface };
  }

  // VTL3/4/5 share the same solid-section layout; 4 adds a fluid section, 5
  // adds a surface map. Read the common spine once, then the extensions.
  if (magic === TILE_MAGIC.VTL3 || magic === TILE_MAGIC.VTL4 || magic === TILE_MAGIC.VTL5) {
    const solid = readTexturedBiomeSection(r);
    let fluid: MeshSection | undefined;
    let surface: SurfaceMap | undefined;
    if (magic === TILE_MAGIC.VTL4 || magic === TILE_MAGIC.VTL5) fluid = readTexturedBiomeSection(r);
    if (magic === TILE_MAGIC.VTL5) surface = readSurface(r);
    const biomeNames = readLegend(r);
    return { magic, version, textured: true, hasBiome: true, ...solid, biomeNames, fluid, surface };
  }

  if (magic === TILE_MAGIC.VTL2) {
    const vertexCount = r.u32();
    const indexCount = r.u32();
    const positions = r.f32(3 * vertexCount);
    const uv = r.f32(2 * vertexCount);
    const layer = r.f32(vertexCount);
    const colors = r.u8a(4 * vertexCount);
    const normalsI8 = r.i8a(4 * vertexCount);
    const indices = r.u32a(indexCount);
    return {
      magic, version, textured: true, hasBiome: false,
      vertexCount, indexCount, positions, uv, layer, colors,
      normals: expandNormals(normalsI8, vertexCount),
      light: extractLight(normalsI8, vertexCount), indices,
    };
  }

  if (magic === TILE_MAGIC.VTL1) {
    const vertexCount = r.u32();
    const indexCount = r.u32();
    const positions = r.f32(3 * vertexCount);
    const colors = r.u8a(4 * vertexCount);
    const normalsI8 = r.i8a(4 * vertexCount);
    const indices = r.u32a(indexCount);
    return {
      magic, version, textured: false, hasBiome: false,
      vertexCount, indexCount, positions, colors,
      normals: expandNormals(normalsI8, vertexCount), indices,
    };
  }

  throw new Error(`vantage: unrecognized tile magic "${magic}" (expected VTL1–VTLA)`);
}
