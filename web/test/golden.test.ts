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
  it('decodes a generator-produced VTL8 tile', async () => {
    const buffer = await fixture('golden-v8.vtile');
    const tile = parseTile(buffer);
    expect(tile.magic).toBe('VTL8');
    expect(tile.vertexCount).toBeGreaterThan(0);
    expect(tile.vertexCount % 4).toBe(0); // strict quads
    expect(tile.lmStart).toBeLessThanOrEqual(tile.vertexCount);
    expect(tile.surface!.width).toBe(16);
    expect(summarizeBiomes(tile).length).toBeGreaterThan(0);

    const q = parseTileQuantized(buffer);
    expect(q).not.toBeNull();
    expect(q!.solid.vertexCount).toBe(tile.vertexCount);
    expect(q!.solid.lmStart).toBe(tile.lmStart);
    expect(q!.solid.indices).toBeNull();
    if (q!.lightmap) {
      // Every tail vertex's lmuv must land inside the atlas.
      const { width, height } = q!.lightmap;
      const lmuv = q!.solid.lmuv!;
      for (let i = 0; i < lmuv.length; i += 2) {
        expect(lmuv[i]! / 2).toBeLessThanOrEqual(width);
        expect(lmuv[i + 1]! / 2).toBeLessThanOrEqual(height);
      }
    }
  });

  it('decodes a generator-produced VTL7 tile', async () => {
    const buffer = await fixture('golden-v7.vtile');
    const tile = parseTile(buffer);
    expect(tile.magic).toBe('VTL7');
    expect(tile.textured).toBe(true);
    expect(tile.vertexCount).toBeGreaterThan(0);
    expect(tile.vertexCount % 4).toBe(0); // strict quads
    expect(tile.indexCount).toBe((tile.vertexCount / 4) * 6);
    expect(tile.positions.length).toBe(tile.vertexCount * 3);
    expect(tile.surface!.width).toBe(16);
    expect(summarizeBiomes(tile).length).toBeGreaterThan(0);

    // Quantized fast path agrees with the expanded decode.
    const q = parseTileQuantized(buffer);
    expect(q).not.toBeNull();
    expect(q!.solid.vertexCount).toBe(tile.vertexCount);
    expect(q!.solid.indices).toBeNull();
    // Spot-check: dequantized position 0 matches the CPU-expanded decode.
    const s = q!.solid;
    expect(s.posMin[0] + s.positions[0]! * s.posScale[0]!).toBeCloseTo(tile.positions[0]!, 3);
    expect(s.uv[0]! * s.uvScale).toBeCloseTo(tile.uv![0]!, 5);
  });

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
