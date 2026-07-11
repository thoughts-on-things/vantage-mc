// Golden decode: fixtures produced by the real Zig generator (`vantage
// meshtex` on a vanilla chunk, then gzip-wrapped like `render` output). The
// other tile tests round-trip TS-only encoders (test/encode.ts), which would
// hide a two-sided drift in the format contract — these catch it.

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { maybeInflate, parseTextureArray, parseTile, parseTileQuantized, summarizeBiomes } from '../src/core/index.js';

async function fixture(name: string): Promise<ArrayBuffer> {
  const buf = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
  const raw = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return maybeInflate(raw);
}

describe('golden fixtures from the Zig generator', () => {
  it('decodes a generator-produced VTL6 tile', async () => {
    const tile = parseTile(await fixture('golden.vtile'));
    expect(tile.magic).toBe('VTL6');
    expect(tile.textured).toBe(true);
    expect(tile.vertexCount).toBeGreaterThan(0);
    expect(tile.indexCount % 3).toBe(0);
    expect(tile.positions.length).toBe(tile.vertexCount * 3);
    // One chunk → a 16×16 surface map with real biome data.
    expect(tile.surface).toBeDefined();
    expect(tile.surface!.width).toBe(16);
    expect(tile.surface!.depth).toBe(16);
    const biomes = summarizeBiomes(tile);
    expect(biomes.length).toBeGreaterThan(0);
    expect(biomes[0]!.label.length).toBeGreaterThan(0);
  });

  it('takes the quantized fast path on the same tile', async () => {
    const buffer = await fixture('golden.vtile');
    const q = parseTileQuantized(buffer);
    expect(q).not.toBeNull();
    const tile = parseTile(buffer);
    expect(q!.solid.vertexCount).toBe(tile.vertexCount);
    expect(q!.solid.indexCount).toBe(tile.indexCount);
    expect(q!.surface.width).toBe(16);
  });

  it('decodes the generator-produced texture array', async () => {
    const tex = parseTextureArray(await fixture('golden.vtexarr'));
    expect(tex.width).toBeGreaterThan(0);
    expect(tex.height).toBeGreaterThan(0);
    expect(tex.layers).toBeGreaterThan(0);
    expect(tex.pixels.length).toBe(tex.width * tex.height * tex.layers * 4);
  });
});
