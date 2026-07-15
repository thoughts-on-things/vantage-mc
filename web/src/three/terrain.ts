// Build three.js scene objects from a decoded tile. This is the heart of using
// Vantage "as a backend": feed it a tile (+ texture array) and drop the returned
// meshes into your own scene, with your own lighting and post-processing.

import * as THREE from 'three';
import {
  biomePalette,
  LOWRES_EMPTY,
  type DecodedTextureArray,
  type DecodedTile,
  type Lightmap,
  type LowresTile,
  type MeshSection,
  type QuantizedSection,
  type QuantizedTile,
  type Rgb,
} from '../core/index.js';
import { createLightmappedMaterial, createTerrainMaterial, createWaterMaterial } from './materials.js';

/** The objects and metadata produced from a tile. */
export interface TerrainObjects {
  /** Opaque terrain mesh. */
  terrain: THREE.Mesh;
  /** Transparent water mesh, drawn after the terrain (VTL4+ tiles with fluids). */
  water?: THREE.Mesh;
  /** The terrain material. For textured tiles this is the Vantage shader that
   *  exposes the biome/fog/light uniforms; for flat tiles, a basic lit material. */
  material: THREE.Material;
  /** The Vantage shader material, present only for textured tiles. */
  shader?: THREE.ShaderMaterial;
  /** Axis-aligned bounds of the terrain geometry. */
  bounds: THREE.Box3;
  /** The biome colour palette used for per-vertex tints (indexed by biome id). */
  palette: Rgb[];
  /** True for flat (VTL1) tiles, which need scene lights to be shaded. */
  requiresSceneLights: boolean;
}

/** Fill a `3 * vertexCount` colour buffer from per-vertex biome ids. */
function biomeColors(biome: Float32Array, vertexCount: number, palette: Rgb[], fallback: Rgb): Float32Array {
  const out = new Float32Array(3 * vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const c = palette[biome[i]! | 0] ?? fallback;
    out[i * 3 + 0] = c[0];
    out[i * 3 + 1] = c[1];
    out[i * 3 + 2] = c[2];
  }
  return out;
}

/** Attach the shared textured-mesh attributes (uv/layer/tint/biome/biome-colour/light). */
function applyTexturedAttributes(geom: THREE.BufferGeometry, section: MeshSection, palette: Rgb[], waterFallback: Rgb): void {
  geom.setAttribute('uv', new THREE.BufferAttribute(section.uv!, 2));
  geom.setAttribute('alayer', new THREE.BufferAttribute(section.layer!, 1));
  geom.setAttribute('atint', new THREE.BufferAttribute(section.colors!, 4, true));

  // Packed sky/block light (0..255). Older tiles without it read as full sky.
  const light = section.light ?? new Uint8Array(section.vertexCount).fill(0xf0);
  const lightF = new Float32Array(light); // exact 0..255 → unpacked in the shader
  geom.setAttribute('alight', new THREE.BufferAttribute(lightF, 1));
  if (section.biome) {
    geom.setAttribute('abiome', new THREE.BufferAttribute(section.biome, 1));
    geom.setAttribute('abcol', new THREE.BufferAttribute(biomeColors(section.biome, section.vertexCount, palette, waterFallback), 3));
  } else {
    // No biome data: feed neutral defaults so the shared shader still links.
    geom.setAttribute('abiome', new THREE.BufferAttribute(new Float32Array(section.vertexCount), 1));
    geom.setAttribute('abcol', new THREE.BufferAttribute(new Float32Array(3 * section.vertexCount), 3));
  }
}

function baseGeometry(section: MeshSection): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(section.positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(section.normals, 3));
  geom.setIndex(new THREE.BufferAttribute(section.indices, 1));
  return geom;
}

const WATER_FALLBACK: Rgb = [0.3, 0.5, 0.85];

/** The meshes built from one tile with caller-provided (shared) materials. */
export interface TileMeshes {
  terrain: THREE.Mesh;
  /** The atlas-lit tail of the solid geometry (VTL8+), drawn with the
   *  lightmapped sibling material. */
  terrainLm?: THREE.Mesh;
  /** The tail's lightmap texture — dispose it with the tile. */
  lightmapTex?: THREE.DataTexture;
  water?: THREE.Mesh;
  bounds: THREE.Box3;
}

/** Upload-ready texture for a tile's baked light+AO atlas. Bilinear, no mips,
 *  clamped — texel centres are block corners, so LinearFilter interpolation
 *  reproduces per-vertex smooth lighting exactly per block. */
function lightmapTexture(lm: Lightmap): THREE.DataTexture {
  const format = lm.packed ? THREE.RGFormat : THREE.RGBAFormat;
  const tex = new THREE.DataTexture(lm.pixels, lm.width, lm.height, format, THREE.UnsignedByteType);
  // VTL9 does exact manual bilinear filtering after unpacking each texel; VTL8
  // retains hardware filtering over its independent RGBA channels.
  tex.magFilter = lm.packed ? THREE.NearestFilter : THREE.LinearFilter;
  tex.minFilter = lm.packed ? THREE.NearestFilter : THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  // Attribute arrays are released after upload for the same reason: keeping a
  // CPU lightmap after its RG8/RGBA8 upload doubles its steady-state residency.
  // Store the durable GPU size before dropping the source. (Context-loss
  // rebuild was already unavailable once geometry arrays were released.)
  tex.userData['vantageGpuBytes'] = lm.pixels.byteLength;
  tex.onUpdate = () => {
    (tex.image as { data: unknown }).data = null;
  };
  tex.needsUpdate = true;
  return tex;
}

/** A zero-copy sub-range view of a quantized section ([start, end) vertices).
 *  The bbox transform is section-wide, so slices dequantize identically. */
function sliceSection(sec: QuantizedSection, start: number, end: number): QuantizedSection {
  return {
    ...sec,
    vertexCount: end - start,
    indexCount: ((end - start) / 4) * 6,
    positions: sec.positions.subarray(start * 3, end * 3),
    uv: sec.uv.subarray(start * 2, end * 2),
    colors: sec.colors.subarray(start * 4, end * 4),
    normals: sec.normals.subarray(start * 4, end * 4),
    layer: sec.layer.subarray(start, end),
    biome: sec.biome.subarray(start, end),
    indices: null,
  };
}

/**
 * Build a tile's meshes against EXISTING materials — the streaming path, where
 * every tile shares one terrain shader + one water shader (one program, two
 * draw calls per tile, uniforms in lock-step). For a one-shot single tile with
 * its own materials, use {@link buildTerrain}.
 */
export function buildTileMeshes(
  tile: DecodedTile,
  palette: Rgb[],
  material: THREE.ShaderMaterial,
  waterMaterial: THREE.ShaderMaterial,
): TileMeshes {
  const geom = baseGeometry(tile);
  applyTexturedAttributes(geom, tile, palette, WATER_FALLBACK);
  geom.computeBoundingBox();
  const terrain = new THREE.Mesh(geom, material);
  const bounds = geom.boundingBox!.clone();

  let water: THREE.Mesh | undefined;
  if (tile.fluid && tile.fluid.vertexCount > 0) {
    const wg = baseGeometry(tile.fluid);
    applyTexturedAttributes(wg, tile.fluid, palette, WATER_FALLBACK);
    wg.computeBoundingBox();
    bounds.union(wg.boundingBox!); // water can sit above the highest solid block
    water = new THREE.Mesh(wg, waterMaterial);
    water.renderOrder = 1; // after opaque
  }

  return { terrain, water, bounds };
}

/** The world-space box a quantized section's u16 range maps onto (from its
 *  header — no pass over the vertices). */
function quantizedBox(sec: QuantizedSection): THREE.Box3 {
  const [mx, my, mz] = sec.posMin;
  const [sx, sy, sz] = sec.posScale;
  return new THREE.Box3(new THREE.Vector3(mx, my, mz), new THREE.Vector3(mx + 65535 * sx, my + 65535 * sy, mz + 65535 * sz));
}

// One canonical quad index buffer shared by every VTL7 section: the topology is
// identical for all tiles (only the length differs), so a single GPU buffer
// sized to the largest section serves everyone via per-geometry draw ranges.
// Tiles must detach it before geometry.dispose() (see isSharedQuadIndex) or
// three would delete the shared GPU buffer with the first unloaded tile.
let sharedQuadIndexAttr: THREE.BufferAttribute | null = null;

/** The shared canonical quad index attribute, grown (with headroom) to cover at
 *  least `vertexCount` vertices. Pre-size it from the manifest's
 *  `maxSectionVerts` so streaming never re-uploads a grown buffer mid-pan. */
export function sharedQuadIndex(vertexCount: number): THREE.BufferAttribute {
  const needed = (vertexCount / 4) * 6;
  if (!sharedQuadIndexAttr || sharedQuadIndexAttr.count < needed) {
    // 1.5× headroom so a slightly-larger tile doesn't rebuild again; the
    // manifest hint makes growth a can't-happen path in practice.
    const verts = Math.ceil((vertexCount * (sharedQuadIndexAttr ? 1.5 : 1)) / 4) * 4;
    const out = new Uint32Array((verts / 4) * 6);
    for (let b = 0, o = 0; b < verts; b += 4) {
      out[o++] = b;
      out[o++] = b + 1;
      out[o++] = b + 2;
      out[o++] = b;
      out[o++] = b + 2;
      out[o++] = b + 3;
    }
    sharedQuadIndexAttr = new THREE.BufferAttribute(out, 1);
  }
  return sharedQuadIndexAttr;
}

/** Whether `attr` is the live shared quad index (never dispose its buffer). */
export function isSharedQuadIndex(attr: THREE.BufferAttribute | null): boolean {
  return attr !== null && attr === sharedQuadIndexAttr;
}

/** Build one mesh from a quantized section: every attribute is the on-disk
 *  typed-array view uploaded verbatim (u16 positions, i8 normals+light, u16
 *  layer/biome); the shared QUANTIZED shader dequantizes per vertex, fed the
 *  section's bbox transform via onBeforeRender. Bounds come from the header,
 *  so building a tile does zero passes over its vertex data. */
function quantizedMesh(
  sec: QuantizedSection,
  material: THREE.ShaderMaterial,
  lm?: { tex: THREE.DataTexture; size: THREE.Vector2; packed: boolean },
): THREE.Mesh {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(sec.positions, 3, false));
  geom.setAttribute('anrm', new THREE.BufferAttribute(sec.normals, 4, false));
  geom.setAttribute('uv', new THREE.BufferAttribute(sec.uv, 2, false));
  geom.setAttribute('atint', new THREE.BufferAttribute(sec.colors, 4, true));
  geom.setAttribute('alayer', new THREE.BufferAttribute(sec.layer, 1, false));
  geom.setAttribute('abiome', new THREE.BufferAttribute(sec.biome, 1, false));
  if (sec.indices) {
    geom.setIndex(new THREE.BufferAttribute(sec.indices, 1));
  } else {
    // VTL7+: canonical quad topology — one shared GPU index buffer for every
    // tile, this section drawing only its own range of it.
    geom.setIndex(sharedQuadIndex(sec.vertexCount));
    geom.setDrawRange(0, sec.indexCount);
  }

  const box = quantizedBox(sec);
  geom.boundingBox = box;
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  geom.boundingSphere = sphere;

  const mesh = new THREE.Mesh(geom, material);
  const posMin = new THREE.Vector3(...sec.posMin);
  const posScale = new THREE.Vector3(...sec.posScale);
  const uvScale = sec.uvScale;
  mesh.onBeforeRender = (_r, _s, _c, _g, mat) => {
    const m = mat as THREE.ShaderMaterial;
    (m.uniforms['uPosMin']!.value as THREE.Vector3).copy(posMin);
    (m.uniforms['uPosScale']!.value as THREE.Vector3).copy(posScale);
    m.uniforms['uUvScale']!.value = uvScale;
    if (lm) {
      m.uniforms['uLightmap']!.value = lm.tex;
      (m.uniforms['uLmSize']!.value as THREE.Vector2).copy(lm.size);
      m.uniforms['uLmPacked']!.value = lm.packed ? 1.0 : 0.0;
    }
    // The material is shared by every tile; three only refreshes ShaderMaterial
    // uniforms once per frame per material unless told otherwise. This flag
    // forces the upload for THIS draw (it's the documented per-object-uniform
    // pattern) — without it every tile renders at the first tile's transform.
    m.uniformsNeedUpdate = true;
  };
  return mesh;
}

/**
 * Build a VTL6+ tile's meshes in the quantized fast path: shared QUANTIZED
 * materials (from `createTerrainMaterial(tex, { quantized: true, palette })`),
 * zero per-vertex CPU work. This is what the streaming TileManager uses.
 *
 * A VTL8+ tile's atlas-lit vertex tail becomes its own mesh (`terrainLm`) drawn
 * with `lmMaterial` (from {@link createLightmappedMaterial}) — pass it whenever
 * the world is format 4+, or the tail would render full-bright.
 */
export function buildQuantizedTileMeshes(
  tile: QuantizedTile,
  material: THREE.ShaderMaterial,
  waterMaterial: THREE.ShaderMaterial,
  lmMaterial?: THREE.ShaderMaterial,
): TileMeshes {
  const solid = tile.solid;
  const lmStart = solid.lmStart ?? solid.vertexCount;
  const hasLm = tile.lightmap !== undefined && lmMaterial !== undefined && lmStart < solid.vertexCount;

  // The vertex-lit head (everything, when there's no atlas tail to split off).
  const head = hasLm ? sliceSection(solid, 0, lmStart) : solid;
  const terrain = quantizedMesh(head, material);
  const bounds = terrain.geometry.boundingBox!.clone();

  let terrainLm: THREE.Mesh | undefined;
  let lightmapTex: THREE.DataTexture | undefined;
  if (hasLm) {
    const lm = tile.lightmap!;
    lightmapTex = lightmapTexture(lm);
    const tail = sliceSection(solid, lmStart, solid.vertexCount);
    terrainLm = quantizedMesh(tail, lmMaterial!, {
      tex: lightmapTex,
      size: new THREE.Vector2(lm.width, lm.height),
      packed: lm.packed,
    });
    terrainLm.geometry.setAttribute('almuv', new THREE.BufferAttribute(solid.lmuv!, 2, false));
  }

  let water: THREE.Mesh | undefined;
  if (tile.fluid.vertexCount > 0) {
    water = quantizedMesh(tile.fluid, waterMaterial);
    water.renderOrder = 1; // after opaque
    bounds.union(water.geometry.boundingBox!); // water can sit above the highest solid block
  }
  return { terrain, terrainLm, lightmapTex, water, bounds };
}

/**
 * Build renderable three.js objects from a decoded tile.
 *
 * @param tile     A tile decoded with {@link parseTile}.
 * @param texData  The texture array decoded with {@link parseTextureArray};
 *                 required for textured tiles (VTL2+), ignored for flat tiles.
 */
export function buildTerrain(tile: DecodedTile, texData?: DecodedTextureArray): TerrainObjects {
  const palette = biomePalette(tile.biomeNames?.length ?? 1);

  if (tile.textured) {
    if (!texData) throw new Error('vantage: textured tile requires a texture array');
    const shader = createTerrainMaterial(texData);
    const { terrain, water, bounds } = buildTileMeshes(tile, palette, shader, createWaterMaterial(shader));
    return { terrain, water, material: shader, shader, bounds, palette, requiresSceneLights: false };
  }

  // Flat (VTL1): per-vertex colour, lit by scene lights the caller adds.
  const geom = baseGeometry(tile);
  geom.setAttribute('color', new THREE.BufferAttribute(tile.colors!, 4, true));
  geom.computeBoundingBox();
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const terrain = new THREE.Mesh(geom, material);
  return { terrain, material, bounds: geom.boundingBox!.clone(), palette, requiresSceneLights: true };
}

/**
 * Build a lowres LOD tile's heightfield mesh: one vertex per sample (heights
 * from the generator, colors with lighting/tint baked in), two triangles per
 * cell whose four corners all have terrain. Adjacent tiles share edge samples
 * (the +1 apron in the format), so the field is seamless across tiles.
 *
 * The surface is dipped slightly below the real terrain height — deeper for
 * coarser levels — so wherever hires tiles (or finer lowres rings) are
 * resident they win the depth test cleanly instead of z-fighting.
 *
 * Returns `null` for an all-empty tile.
 */
export function buildLowresMesh(tile: LowresTile, material: THREE.ShaderMaterial): THREE.Mesh | null {
  const { width, depth, heights, rgb, originX, originZ, span } = tile;
  const n = width * depth;
  const dipBase = Math.min(0.5 + 0.25 * span, 4);

  const pos = new Float32Array(3 * n);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let j = 0; j < depth; j++) {
    for (let i = 0; i < width; i++) {
      const s = j * width + i;
      const h = heights[s]!;
      let y = 0;
      if (h !== LOWRES_EMPTY) {
        // The dip grows with the local slope: a smooth interpolated surface
        // cuts through hires voxel stair-steps on hillsides, so sloped
        // vertices sink below the steps. Flat ground keeps the minimal dip
        // and hires terrain covers the underlay exactly.
        let slope = 0;
        if (i > 0 && heights[s - 1]! !== LOWRES_EMPTY) slope = Math.max(slope, Math.abs(h - heights[s - 1]!));
        if (i + 1 < width && heights[s + 1]! !== LOWRES_EMPTY) slope = Math.max(slope, Math.abs(h - heights[s + 1]!));
        if (j > 0 && heights[s - width]! !== LOWRES_EMPTY) slope = Math.max(slope, Math.abs(h - heights[s - width]!));
        if (j + 1 < depth && heights[s + width]! !== LOWRES_EMPTY) slope = Math.max(slope, Math.abs(h - heights[s + width]!));
        y = h + 1 - dipBase - Math.min(slope, 12);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      pos[3 * s + 0] = originX + (i + 0.5) * span;
      pos[3 * s + 1] = y;
      pos[3 * s + 2] = originZ + (j + 0.5) * span;
    }
  }
  if (!Number.isFinite(minY)) return null;

  // Two CCW-from-above triangles per fully-populated cell.
  const idx: number[] = [];
  for (let j = 0; j + 1 < depth; j++) {
    for (let i = 0; i + 1 < width; i++) {
      const a = j * width + i;
      const b = a + 1;
      const c = a + width;
      const d = c + 1;
      if (
        heights[a] === LOWRES_EMPTY || heights[b] === LOWRES_EMPTY ||
        heights[c] === LOWRES_EMPTY || heights[d] === LOWRES_EMPTY
      ) continue;
      idx.push(a, c, d, a, d, b);
    }
  }
  if (idx.length === 0) return null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('acol', new THREE.BufferAttribute(rgb, 3, true));
  const IndexArray = n > 65535 ? Uint32Array : Uint16Array;
  geom.setIndex(new THREE.BufferAttribute(new IndexArray(idx), 1));

  // Bounds from the loop above — no extra pass over the vertices.
  const box = new THREE.Box3(
    new THREE.Vector3(originX, minY, originZ),
    new THREE.Vector3(originX + width * span, maxY, originZ + depth * span),
  );
  geom.boundingBox = box;
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  geom.boundingSphere = sphere;

  return new THREE.Mesh(geom, material);
}
