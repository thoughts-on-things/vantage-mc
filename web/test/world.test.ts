// The world index (`world.json`): validation, dimension selection, and the
// sub-directory world source each dimension is loaded through.

import { describe, expect, it } from 'vitest';
import { isWorldIndex, parseWorldIndex, pickDimension, resolveManifestPath, worldFromIndexEntry } from '../src/core/index.js';
import type { WorldSource } from '../src/core/index.js';

const good = {
  format: 1,
  dimensions: [
    {
      id: 'minecraft:overworld',
      slug: 'overworld',
      label: 'Overworld',
      kind: 'overworld',
      manifest: 'manifest.json',
      tiles: 81,
      bytes: 26_000_000,
      spawn: { x: 16, y: 64, z: -32 },
    },
    {
      id: 'minecraft:the_nether',
      slug: 'the_nether',
      label: 'The Nether',
      kind: 'nether',
      manifest: 'the_nether/manifest.json',
      tiles: 12,
      bytes: 4_000_000,
    },
    {
      id: 'minecraft:the_end',
      slug: 'the_end',
      label: 'The End',
      kind: 'end',
      manifest: 'the_end/manifest.json',
      tiles: 0,
      bytes: 0,
    },
  ],
};

describe('parseWorldIndex', () => {
  it('accepts a well-formed index', () => {
    const w = parseWorldIndex(good);
    expect(w.dimensions).toHaveLength(3);
    expect(w.dimensions[1]?.manifest).toBe('the_nether/manifest.json');
    expect(w.dimensions[0]?.spawn).toEqual({ x: 16, y: 64, z: -32 });
    expect(w.dimensions[2]?.tiles).toBe(0);
  });

  it('rejects malformed shapes and unsafe manifest paths', () => {
    expect(() => parseWorldIndex(null)).toThrow(/not an object/);
    expect(() => parseWorldIndex({ format: 2, dimensions: [] })).toThrow(/format/);
    expect(() => parseWorldIndex({ format: 1, dimensions: [] })).toThrow(/no dimensions/);
    const bad = (manifest: unknown) => ({ format: 1, dimensions: [{ ...good.dimensions[0], manifest }] });
    // A manifest path is fetched with the source's credentials: keep it inside
    // the index's own directory, always ending at a manifest.
    expect(() => parseWorldIndex(bad('../secrets/manifest.json'))).toThrow(/manifest path/);
    expect(() => parseWorldIndex(bad('https://evil.example/manifest.json'))).toThrow(/manifest path/);
    expect(() => parseWorldIndex(bad('/etc/passwd'))).toThrow(/manifest path/);
    expect(() => parseWorldIndex(bad('the_nether/tiles/t.0.0.vtile'))).toThrow(/manifest path/);
    expect(() =>
      parseWorldIndex({ format: 1, dimensions: [{ ...good.dimensions[0], slug: 'Not A Slug' }] }),
    ).toThrow(/id\/slug/);
  });
});

describe('isWorldIndex', () => {
  it('tells an index apart from a manifest', () => {
    expect(isWorldIndex(good)).toBe(true);
    expect(isWorldIndex({ format: 6, tiles: [], biomes: [] })).toBe(false);
    expect(isWorldIndex(null)).toBe(false);
  });
});

describe('pickDimension', () => {
  const index = parseWorldIndex(good);

  it('honours a requested slug or resource id', () => {
    expect(pickDimension(index, 'the_nether').id).toBe('minecraft:the_nether');
    expect(pickDimension(index, 'minecraft:the_end').slug).toBe('the_end');
  });

  it('defaults to the overworld, and ignores a slug the world lacks', () => {
    expect(pickDimension(index).slug).toBe('overworld');
    expect(pickDimension(index, 'aether').slug).toBe('overworld');
  });

  it('falls back to the first dimension with tiles when there is no overworld', () => {
    const noOverworld = parseWorldIndex({ format: 1, dimensions: good.dimensions.slice(1) });
    expect(pickDimension(noOverworld).slug).toBe('the_nether');
  });
});

describe('resolveManifestPath', () => {
  it('resolves against the index location', () => {
    expect(resolveManifestPath('world.json', 'the_nether/manifest.json')).toBe('the_nether/manifest.json');
    expect(resolveManifestPath('maps/a/world.json', 'the_end/manifest.json')).toBe('maps/a/the_end/manifest.json');
  });
});

describe('worldFromIndexEntry', () => {
  it('re-roots every fetch at the dimension directory', async () => {
    const asked: string[] = [];
    const source: WorldSource = {
      manifest: good,
      label: 'https://maps.example/world.json',
      fetch: (path) => {
        asked.push(path);
        return Promise.resolve(new TextEncoder().encode(JSON.stringify({ format: 6 })).buffer as ArrayBuffer);
      },
    };
    const nether = await worldFromIndexEntry(source, 'the_nether/manifest.json');
    expect(asked).toEqual(['the_nether/manifest.json']);
    expect(nether.manifest).toEqual({ format: 6 });
    expect(nether.label).toBe('https://maps.example/world.json/the_nether');
    await nether.fetch('tiles/t.0.0.vtile');
    await nether.fetch('terrain.vtexarr');
    expect(asked).toEqual(['the_nether/manifest.json', 'the_nether/tiles/t.0.0.vtile', 'the_nether/terrain.vtexarr']);
  });

  it('leaves a root-level dimension untouched', async () => {
    const asked: string[] = [];
    const source: WorldSource = {
      manifest: good,
      label: 'render',
      fetch: (path) => {
        asked.push(path);
        return Promise.resolve(new TextEncoder().encode('{}').buffer as ArrayBuffer);
      },
    };
    const overworld = await worldFromIndexEntry(source, 'manifest.json');
    await overworld.fetch('tiles/t.0.0.vtile');
    expect(asked).toEqual(['manifest.json', 'tiles/t.0.0.vtile']);
    expect(overworld.label).toBe('render');
  });
});
