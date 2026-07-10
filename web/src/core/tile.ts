// Decode a `.vtile` into typed, renderer-agnostic geometry. No three.js, no DOM.

import { ByteReader, TILE_MAGIC, type TileMagic } from './format.js';

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
  /** `2 * vertexCount` texture coordinates. */
  uv: Float32Array;
  /** `4 * vertexCount` RGBA: tint RGB + packed AO/alpha. */
  colors: Uint8Array;
  /** `4 * vertexCount` int8: xyz normal + the packed light byte as the 4th
   *  component (bit pattern; recover unsigned in-shader). */
  normals: Int8Array;
  /** `vertexCount` u16 texture-array layer indices. */
  layer: Uint16Array;
  /** `vertexCount` u16 biome ids. */
  biome: Uint16Array;
  /** `indexCount` triangle indices. */
  indices: Uint32Array;
}

/** A VTL6 tile decoded without dequantization (see {@link QuantizedSection}). */
export interface QuantizedTile {
  magic: 'VTL6';
  version: number;
  solid: QuantizedSection;
  fluid: QuantizedSection;
  surface: SurfaceMap;
  biomeNames: string[];
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
  return { vertexCount, indexCount, positions, posMin, posScale, uv, colors, normals, layer, biome, indices };
}

/**
 * Decode a VTL6 `.vtile` in its quantized on-disk encoding: every array is a
 * zero-copy view and positions/layer/biome stay u16 for the vertex shader to
 * dequantize (the streaming fast path — no per-vertex CPU work). Returns `null`
 * for any other tile version; callers fall back to {@link parseTile}.
 */
export function parseTileQuantized(buffer: ArrayBuffer): QuantizedTile | null {
  const r = new ByteReader(buffer);
  if (r.magic() !== TILE_MAGIC.VTL6) return null;
  r.off = 4;
  const version = r.u32();
  const solid = readQuantizedSectionRaw(r);
  const fluid = readQuantizedSectionRaw(r);
  const surface = readSurface(r);
  const biomeNames = readLegend(r);
  return { magic: TILE_MAGIC.VTL6, version, solid, fluid, surface, biomeNames };
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

  throw new Error(`vantage: unrecognized tile magic "${magic}" (expected VTL1–VTL6)`);
}
