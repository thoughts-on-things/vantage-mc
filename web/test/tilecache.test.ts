import { describe, expect, it } from 'vitest';
import { TileByteCache } from '../src/three/tilecache.js';

const payload = (bytes: number): ArrayBuffer => new ArrayBuffer(bytes);

describe('tile byte cache', () => {
  it('serves a payload back only for the revision it was stored at', () => {
    const cache = new TileByteCache(1024);
    cache.put('0,0', payload(100), 'r1');
    expect(cache.get('0,0', 'r1')).toBeDefined();
    // A revised tile is different terrain, not a stale copy of the same one.
    expect(cache.get('0,0', 'r2')).toBeUndefined();
    expect(cache.get('1,1', 'r1')).toBeUndefined();
  });

  it('evicts least-recently-used entries to stay inside the byte budget', () => {
    const cache = new TileByteCache(300);
    cache.put('a', payload(100), undefined);
    cache.put('b', payload(100), undefined);
    cache.put('c', payload(100), undefined);
    // Touch 'a' so 'b' becomes the least recently used.
    expect(cache.get('a', undefined)).toBeDefined();
    cache.put('d', payload(100), undefined);
    expect(cache.size).toBe(300);
    expect(cache.get('b', undefined)).toBeUndefined();
    expect(cache.get('a', undefined)).toBeDefined();
    expect(cache.get('d', undefined)).toBeDefined();
  });

  it('trims immediately when the budget is lowered, not at the next insertion', () => {
    const cache = new TileByteCache(1000);
    for (let i = 0; i < 8; i++) cache.put(`t${i}`, payload(100), undefined);
    expect(cache.size).toBe(800);
    cache.setBudget(250);
    expect(cache.size).toBeLessThanOrEqual(250);
    // The survivors are the most recently used ones.
    expect(cache.get('t7', undefined)).toBeDefined();
    expect(cache.get('t0', undefined)).toBeUndefined();
  });

  it('drops everything when disabled, and stops accepting entries', () => {
    const cache = new TileByteCache(1000);
    cache.put('a', payload(100), undefined);
    cache.setBudget(0);
    expect(cache.size).toBe(0);
    expect(cache.count).toBe(0);
    cache.put('b', payload(100), undefined);
    expect(cache.get('b', undefined)).toBeUndefined();
  });

  it('never caches empty payloads, which the byte budget could not evict', () => {
    const cache = new TileByteCache(1000);
    // Tiles that mesh to nothing come back as 0-byte bodies; caching them
    // would accumulate entries no byte ceiling can ever reclaim.
    for (let i = 0; i < 5000; i++) cache.put(`empty${i}`, payload(0), undefined);
    expect(cache.count).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('bounds the entry count even when payloads are nearly free', () => {
    const cache = new TileByteCache(64 * 1024 * 1024);
    for (let i = 0; i < TileByteCache.MAX_ENTRIES + 500; i++) {
      cache.put(`t${i}`, payload(1), undefined);
    }
    expect(cache.count).toBe(TileByteCache.MAX_ENTRIES);
  });

  it('ignores a payload larger than the whole budget', () => {
    const cache = new TileByteCache(500);
    cache.put('huge', payload(900), undefined);
    expect(cache.count).toBe(0);
    // ...and an existing entry survives the attempt.
    cache.put('small', payload(100), undefined);
    cache.put('huge', payload(900), undefined);
    expect(cache.get('small', undefined)).toBeDefined();
  });

  it('forgets a dropped tile and its bytes', () => {
    const cache = new TileByteCache(1000);
    cache.put('a', payload(100), 'r1');
    cache.drop('a');
    expect(cache.size).toBe(0);
    expect(cache.get('a', 'r1')).toBeUndefined();
    cache.drop('missing'); // no-op, no negative accounting
    expect(cache.size).toBe(0);
  });
});
