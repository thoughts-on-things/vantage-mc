// parseManifest validation + tile key helpers, and the gzip sniff/inflate pair.

import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { isGzip, maybeInflate, parseManifest, tileKey } from '../src/core/index.js';

const good = {
  format: 1,
  tileChunks: 8,
  tileBlocks: 128,
  textures: 'terrain.vtexarr',
  spawn: { x: 16, y: 64, z: -32 },
  biomes: ['', 'Plains', 'Deep Ocean'],
  tiles: [
    { x: -1, z: 0, path: 'tiles/t.-1.0.vtile', bytes: 1234 },
    { x: 0, z: 0, path: 'tiles/t.0.0.vtile', bytes: 5678 },
  ],
};

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    const m = parseManifest(good);
    expect(m.tileChunks).toBe(8);
    expect(m.tileBlocks).toBe(128);
    expect(m.spawn).toEqual({ x: 16, y: 64, z: -32 });
    expect(m.biomes).toHaveLength(3);
    expect(m.tiles).toHaveLength(2);
    expect(m.tiles[0]).toEqual({ x: -1, z: 0, path: 'tiles/t.-1.0.vtile', bytes: 1234 });
  });

  it('accepts a manifest without spawn', () => {
    const { spawn: _spawn, ...noSpawn } = good;
    expect(parseManifest(noSpawn).spawn).toBeUndefined();
  });

  it('accepts a format-2 manifest with a lowres pyramid', () => {
    const m = parseManifest({
      ...good,
      format: 2,
      lowres: {
        grid: 129,
        levels: [
          { level: 1, tileBlocks: 256, span: 2, tiles: [{ x: 0, z: 0, path: 'tiles/l1.0.0.vlr', bytes: 42 }] },
        ],
      },
    });
    expect(m.format).toBe(2);
    expect(m.lowres?.grid).toBe(129);
    expect(m.lowres?.levels[0]?.tiles[0]?.path).toBe('tiles/l1.0.0.vlr');
  });

  it('accepts a format-3 manifest and its maxSectionVerts hint', () => {
    const m = parseManifest({ ...good, format: 3, maxSectionVerts: 524288 });
    expect(m.format).toBe(3);
    expect(m.maxSectionVerts).toBe(524288);
    // The hint is optional (and absent on format ≤ 2 manifests).
    expect(parseManifest(good).maxSectionVerts).toBeUndefined();
  });

  it('accepts format 5 packed-lightmap manifests', () => {
    expect(parseManifest({ ...good, format: 5, maxSectionVerts: 524288 }).format).toBe(5);
  });

  it('carries the caves flag and yRange for the depth slice', () => {
    const m = parseManifest({ ...good, caves: true, yRange: { min: -64, max: 320 } });
    expect(m.caves).toBe(true);
    expect(m.yRange).toEqual({ min: -64, max: 320 });
    // Optional: absent on culled renders, and junk values are dropped.
    expect(parseManifest(good).caves).toBeUndefined();
    expect(parseManifest(good).yRange).toBeUndefined();
    expect(parseManifest({ ...good, caves: 'yes' }).caves).toBeUndefined();
    expect(parseManifest({ ...good, yRange: { min: 5, max: 5 } }).yRange).toBeUndefined();
  });

  it('carries the rendering/dynamic/progress/textureLayers live-server flags', () => {
    const m = parseManifest({
      ...good,
      format: 4,
      rendering: true,
      dynamic: true,
      progress: { done: 3, total: 132 },
      textureLayers: 565,
    });
    expect(m.rendering).toBe(true);
    expect(m.dynamic).toBe(true);
    expect(m.progress).toEqual({ done: 3, total: 132 });
    expect(m.textureLayers).toBe(565);
    // All optional: a finished static render carries none of them.
    expect(parseManifest(good).rendering).toBeUndefined();
    expect(parseManifest(good).dynamic).toBeUndefined();
    expect(parseManifest({ ...good, dynamic: 'yes' }).dynamic).toBeUndefined();
  });

  it('carries opaque continuous-server tile revisions', () => {
    const m = parseManifest({
      ...good,
      tiles: [{ ...good.tiles[0], revision: '7f00a1' }],
    });
    expect(m.tiles[0]?.revision).toBe('7f00a1');
    expect(() => parseManifest({ ...good, tiles: [{ ...good.tiles[0], revision: '' }] })).toThrow(/revision/);
    expect(() => parseManifest({ ...good, tiles: [{ ...good.tiles[0], revision: 12 }] })).toThrow(/revision/);
  });

  it('rejects wrong format versions and malformed shapes', () => {
    expect(() => parseManifest(null)).toThrow(/not an object/);
    expect(() => parseManifest({ ...good, format: 6 })).toThrow(/format/);
    expect(() => parseManifest({ ...good, tiles: [{ x: 0 }] })).toThrow(/tile 0/);
    expect(() => parseManifest({ ...good, biomes: [1] })).toThrow(/biomes/);
    expect(() => parseManifest({ ...good, format: 2, lowres: { grid: 0, levels: [] } })).toThrow(/lowres/);
    expect(() => parseManifest({ ...good, format: 2, lowres: { grid: 129, levels: [{ level: 1 }] } })).toThrow(/lowres level/);
  });
});

describe('tileKey', () => {
  it('is stable for negative coords', () => {
    expect(tileKey(-1, 3)).toBe('-1,3');
    expect(tileKey(0, 0)).toBe('0,0');
  });
});

describe('gzip helpers', () => {
  it('sniffs and inflates gzip buffers, passes raw buffers through', async () => {
    const raw = new TextEncoder().encode('VTL6 pretend tile payload');
    const rawBuf = raw.buffer.slice(0) as ArrayBuffer;
    expect(isGzip(rawBuf)).toBe(false);
    expect(await maybeInflate(rawBuf)).toBe(rawBuf); // untouched

    const zipped = gzipSync(raw);
    const zippedBuf = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
    expect(isGzip(zippedBuf)).toBe(true);
    const back = new Uint8Array(await maybeInflate(zippedBuf));
    expect(new TextDecoder().decode(back)).toBe('VTL6 pretend tile payload');
  });
});
