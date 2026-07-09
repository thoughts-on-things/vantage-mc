// Build three.js scene objects from a decoded tile. This is the heart of using
// Vantage "as a backend": feed it a tile (+ texture array) and drop the returned
// meshes into your own scene, with your own lighting and post-processing.

import * as THREE from 'three';
import {
  biomePalette,
  type DecodedTextureArray,
  type DecodedTile,
  type MeshSection,
  type QuantizedSection,
  type QuantizedTile,
  type Rgb,
} from '../core/index.js';
import { createTerrainMaterial, createWaterMaterial } from './materials.js';

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
  water?: THREE.Mesh;
  bounds: THREE.Box3;
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

/** Build one mesh from a quantized section: every attribute is the on-disk
 *  typed-array view uploaded verbatim (u16 positions, i8 normals+light, u16
 *  layer/biome); the shared QUANTIZED shader dequantizes per vertex, fed the
 *  section's bbox transform via onBeforeRender. Bounds come from the header,
 *  so building a tile does zero passes over its vertex data. */
function quantizedMesh(sec: QuantizedSection, material: THREE.ShaderMaterial): THREE.Mesh {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(sec.positions, 3, false));
  geom.setAttribute('anrm', new THREE.BufferAttribute(sec.normals, 4, false));
  geom.setAttribute('uv', new THREE.BufferAttribute(sec.uv, 2));
  geom.setAttribute('atint', new THREE.BufferAttribute(sec.colors, 4, true));
  geom.setAttribute('alayer', new THREE.BufferAttribute(sec.layer, 1, false));
  geom.setAttribute('abiome', new THREE.BufferAttribute(sec.biome, 1, false));
  geom.setIndex(new THREE.BufferAttribute(sec.indices, 1));

  const box = quantizedBox(sec);
  geom.boundingBox = box;
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  geom.boundingSphere = sphere;

  const mesh = new THREE.Mesh(geom, material);
  const posMin = new THREE.Vector3(...sec.posMin);
  const posScale = new THREE.Vector3(...sec.posScale);
  mesh.onBeforeRender = (_r, _s, _c, _g, mat) => {
    const m = mat as THREE.ShaderMaterial;
    (m.uniforms['uPosMin']!.value as THREE.Vector3).copy(posMin);
    (m.uniforms['uPosScale']!.value as THREE.Vector3).copy(posScale);
    // The material is shared by every tile; three only refreshes ShaderMaterial
    // uniforms once per frame per material unless told otherwise. This flag
    // forces the upload for THIS draw (it's the documented per-object-uniform
    // pattern) — without it every tile renders at the first tile's transform.
    m.uniformsNeedUpdate = true;
  };
  return mesh;
}

/**
 * Build a VTL6 tile's meshes in the quantized fast path: shared QUANTIZED
 * materials (from `createTerrainMaterial(tex, { quantized: true, palette })`),
 * zero per-vertex CPU work. This is what the streaming TileManager uses.
 */
export function buildQuantizedTileMeshes(
  tile: QuantizedTile,
  material: THREE.ShaderMaterial,
  waterMaterial: THREE.ShaderMaterial,
): TileMeshes {
  const terrain = quantizedMesh(tile.solid, material);
  const bounds = terrain.geometry.boundingBox!.clone();
  let water: THREE.Mesh | undefined;
  if (tile.fluid.vertexCount > 0) {
    water = quantizedMesh(tile.fluid, waterMaterial);
    water.renderOrder = 1; // after opaque
    bounds.union(water.geometry.boundingBox!); // water can sit above the highest solid block
  }
  return { terrain, water, bounds };
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
