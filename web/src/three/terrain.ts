// Build three.js scene objects from a decoded tile. This is the heart of using
// Vantage "as a backend": feed it a tile (+ texture array) and drop the returned
// meshes into your own scene, with your own lighting and post-processing.

import * as THREE from 'three';
import { biomePalette, type DecodedTextureArray, type DecodedTile, type MeshSection, type Rgb } from '../core/index.js';
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

    const geom = baseGeometry(tile);
    applyTexturedAttributes(geom, tile, palette, WATER_FALLBACK);
    geom.computeBoundingBox();
    const terrain = new THREE.Mesh(geom, shader);
    const bounds = geom.boundingBox!.clone();

    let water: THREE.Mesh | undefined;
    if (tile.fluid && tile.fluid.vertexCount > 0) {
      const wg = baseGeometry(tile.fluid);
      applyTexturedAttributes(wg, tile.fluid, palette, WATER_FALLBACK);
      water = new THREE.Mesh(wg, createWaterMaterial(shader));
      water.renderOrder = 1; // after opaque
    }

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
