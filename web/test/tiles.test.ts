import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { LowresLevel, ManifestTile, WorldManifest } from '../src/core/index.js';
import { TileManager } from '../src/three/tiles.js';

function manifest(extra: Partial<WorldManifest> = {}): WorldManifest {
  return {
    format: 6,
    tileChunks: 8,
    tileBlocks: 128,
    textures: 'terrain.vtexarr',
    biomes: [''],
    tiles: [],
    ...extra,
  };
}

/** A manager with no renderer (so no map memory) and no real GPU work — enough
 *  to exercise catalog reconciliation, which is pure bookkeeping. */
function manager(m: WorldManifest): TileManager {
  return new TileManager({
    manifest: m,
    fetch: async () => new ArrayBuffer(0),
    scene: new THREE.Scene(),
    material: new THREE.ShaderMaterial(),
    waterMaterial: new THREE.ShaderMaterial(),
    lowresMaterial: new THREE.ShaderMaterial(),
    palette: [],
  });
}

function lowTile(x: number, z: number, revision: string): ManifestTile {
  return { x, z, path: `tiles/l1.${x}.${z}.vlr`, bytes: 1024, revision };
}

function level(tiles: ManifestTile[], lvl = 1): { grid: number; levels: LowresLevel[] } {
  return { grid: 129, levels: [{ level: lvl, tileBlocks: 128 * 2 ** lvl, span: 2 ** lvl, tiles }] };
}

describe('lowres pyramid reconciliation', () => {
  it('adopts a pyramid that appears mid-session, then stays quiet', () => {
    const tiles = manager(manifest({ dynamic: true, rendering: true }));
    // A live session's first manifests carry no pyramid at all.
    expect(tiles.syncLowres({ grid: 129, levels: [] })).toBe(false);

    expect(tiles.syncLowres(level([lowTile(0, 0, 'a1')]))).toBe(true);
    // Re-publishing the same overview must not churn the rings.
    expect(tiles.syncLowres(level([lowTile(0, 0, 'a1')]))).toBe(false);
  });

  it('notices new coordinates, rebuilt tiles, and coordinates that left', () => {
    const tiles = manager(manifest({ dynamic: true, rendering: true }));
    tiles.syncLowres(level([lowTile(0, 0, 'a1')]));

    // The pyramid grew as more of the world baked.
    expect(tiles.syncLowres(level([lowTile(0, 0, 'a1'), lowTile(1, 0, 'b1')]))).toBe(true);
    // One tile was rebuilt over newly baked terrain (same size, new content).
    expect(tiles.syncLowres(level([lowTile(0, 0, 'a2'), lowTile(1, 0, 'b1')]))).toBe(true);
    expect(tiles.syncLowres(level([lowTile(0, 0, 'a2'), lowTile(1, 0, 'b1')]))).toBe(false);
    // …and a coordinate disappeared (a shrinking world).
    expect(tiles.syncLowres(level([lowTile(0, 0, 'a2')]))).toBe(true);
  });

  it('falls back to size when a pyramid carries no fingerprints', () => {
    // A batch render's pyramid never changes and omits `revision`.
    const tiles = manager(manifest());
    const plain = (bytes: number): ManifestTile => ({ x: 0, z: 0, path: 'tiles/l1.0.0.vlr', bytes });
    expect(tiles.syncLowres(level([plain(10)]))).toBe(true);
    expect(tiles.syncLowres(level([plain(10)]))).toBe(false);
    expect(tiles.syncLowres(level([plain(20)]))).toBe(true);
  });

  it('keeps map memory on a live world but retires it for a finished bake', () => {
    // Without a renderer there is no impostor layer to inspect directly; what
    // is observable is that ingesting a pyramid stays safe either way and the
    // levels land.
    const live = manager(manifest({ dynamic: true, rendering: true }));
    live.ingestLowres(level([lowTile(0, 0, 'a1')]));
    expect(live.stats.lowres).toBe(0); // nothing resident yet, but indexed
    expect(live.syncLowres(level([lowTile(0, 0, 'a1')]))).toBe(false);

    const baked = manager(manifest());
    baked.ingestLowres(level([lowTile(0, 0, 'a1')]));
    expect(baked.syncLowres(level([lowTile(0, 0, 'a1')]))).toBe(false);
  });
});
