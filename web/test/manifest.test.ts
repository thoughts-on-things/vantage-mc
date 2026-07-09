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

  it('rejects wrong format versions and malformed shapes', () => {
    expect(() => parseManifest(null)).toThrow(/not an object/);
    expect(() => parseManifest({ ...good, format: 2 })).toThrow(/format/);
    expect(() => parseManifest({ ...good, tiles: [{ x: 0 }] })).toThrow(/tile 0/);
    expect(() => parseManifest({ ...good, biomes: [1] })).toThrow(/biomes/);
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
