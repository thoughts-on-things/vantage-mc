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

  it('uses learned byte weights as an admission budget', () => {
    const refs = [tile(0, 0), tile(1, 0), tile(2, 0), tile(3, 0)];
    const candidates = refs.map((ref, i) => ({ ref, distanceSq: i, priority: i }));
    const weights = new Map(refs.map((ref, i) => [tileKey(ref.x, ref.z), [6, 6, 3, 1][i]!]));

    const admitted = admitTiles(candidates, 4, 10, (ref) => weights.get(tileKey(ref.x, ref.z))!);
    expect(admitted.map(({ ref }) => ref.x)).toEqual([0, 2, 3]);
  });

  it('admits one oversized nearest tile instead of retrying forever', () => {
    const ref = tile(0, 0);
    expect(admitTiles([{ ref, distanceSq: 0, priority: 0 }], 10, 1, () => 100)).toHaveLength(1);
  });
});
