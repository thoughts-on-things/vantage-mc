import { describe, expect, it } from 'vitest';
import { tileKey, type ManifestTile } from '../src/core/index.js';
import { admitTiles, nearbyTiles } from '../src/three/streaming.js';

class CountingIndex extends Map<string, ManifestTile> {
  reads = 0;
  override get(key: string): ManifestTile | undefined {
    this.reads++;
    return super.get(key);
  }
}

function tile(x: number, z: number, bytes = 1): ManifestTile {
  return { x, z, path: `tiles/t.${x}.${z}.vtile`, bytes };
}

describe('streaming planner', () => {
  it('queries only the visible sparse grid rather than scanning the manifest', () => {
    const index = new CountingIndex();
    for (let z = -150; z < 150; z++) {
      for (let x = -150; x < 150; x++) index.set(tileKey(x, z), tile(x, z));
    }

    const candidates = nearbyTiles(index, 128, 0, 0, 384);
    expect(candidates.length).toBeGreaterThan(20);
    expect(index.reads).toBeLessThan(100);
    expect(candidates[0]!.distanceSq).toBeLessThanOrEqual(candidates.at(-1)!.distanceSq);
  });

  it('cuts a contiguous nearest-first prefix when the byte budget runs out', () => {
    const refs = [tile(0, 0), tile(1, 0), tile(2, 0), tile(3, 0)];
    const candidates = refs.map((ref, i) => ({ ref, distanceSq: i, priority: i }));
    const weights = new Map(refs.map((ref, i) => [tileKey(ref.x, ref.z), [6, 6, 3, 1][i]!]));

    // Skipping tile 1 could fit tiles 2+3, but a hole mid-disc is the
    // patchwork artifact — admission must stop at the frontier instead.
    const plan = admitTiles(candidates, 4, 10, (ref) => weights.get(tileKey(ref.x, ref.z))!);
    expect(plan.admitted.map(({ ref }) => ref.x)).toEqual([0]);
    expect(plan.cutoffSq).toBe(1);
  });

  it('reports no cutoff when every candidate fits', () => {
    const candidates = [tile(0, 0), tile(1, 0)].map((ref, i) => ({ ref, distanceSq: i, priority: i }));
    const plan = admitTiles(candidates, 4, 100, () => 1);
    expect(plan.admitted).toHaveLength(2);
    expect(plan.cutoffSq).toBeNull();
  });

  it('reports the tile-count cutoff distance', () => {
    const candidates = [tile(0, 0), tile(1, 0), tile(2, 0)].map((ref, i) => ({ ref, distanceSq: i * 4, priority: i }));
    const plan = admitTiles(candidates, 2, 100, () => 1);
    expect(plan.admitted).toHaveLength(2);
    expect(plan.cutoffSq).toBe(8);
  });

  it('admits one oversized nearest tile instead of retrying forever', () => {
    const ref = tile(0, 0);
    const plan = admitTiles([{ ref, distanceSq: 0, priority: 0 }], 10, 1, () => 100);
    expect(plan.admitted).toHaveLength(1);
    expect(plan.cutoffSq).toBeNull();
  });
});
