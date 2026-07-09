import { describe, expect, it } from 'vitest';
import { parseTextureArray, parseTile, parseTileQuantized, summarizeBiomes, summarizeSurfaceBiomes } from '../src/core/index.js';
import {
  encodeTextureArray,
  encodeVTL1,
  encodeVTL2,
  encodeVTL3,
  encodeVTL3Geo,
  encodeVTL4,
  encodeVTL5,
  encodeVTL6,
  LEGEND,
} from './encode.js';

describe('parseTile', () => {
  it('decodes VTL1 (flat colour, no textures)', () => {
    const t = parseTile(encodeVTL1());
    expect(t.magic).toBe('VTL1');
    expect(t.version).toBe(1);
    expect(t.textured).toBe(false);
    expect(t.hasBiome).toBe(false);
    expect(t.vertexCount).toBe(3);
    expect(t.indexCount).toBe(3);
    expect(Array.from(t.indices)).toEqual([0, 1, 2]);
    expect(Array.from(t.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    // normals expand from int8 xyzw, dropping w.
    expect(t.normals.length).toBe(9);
    expect([t.normals[0], t.normals[4], t.normals[8]]).toEqual([1, 1, 1]);
    expect(t.uv).toBeUndefined();
    expect(t.biome).toBeUndefined();
    expect(t.fluid).toBeUndefined();
  });

  it('decodes VTL2 (textured, no biome)', () => {
    const t = parseTile(encodeVTL2());
    expect(t.magic).toBe('VTL2');
    expect(t.textured).toBe(true);
    expect(t.hasBiome).toBe(false);
    expect(t.uv?.length).toBe(6);
    expect(t.layer?.length).toBe(3);
    expect(t.colors?.length).toBe(12);
    expect(t.biome).toBeUndefined();
    expect(t.biomeNames).toBeUndefined();
    expect(Array.from(t.indices)).toEqual([0, 1, 2]);
  });

  it('decodes VTL3 (textured + biome legend)', () => {
    const t = parseTile(encodeVTL3());
    expect(t.magic).toBe('VTL3');
    expect(t.textured).toBe(true);
    expect(t.hasBiome).toBe(true);
    expect(Array.from(t.biome!)).toEqual([1, 2, 1]);
    expect(t.biomeNames).toEqual(LEGEND);
    expect(t.fluid).toBeUndefined();
    expect(t.surface).toBeUndefined();
  });

  it('decodes VTL4 (+ transparent fluid section)', () => {
    const t = parseTile(encodeVTL4());
    expect(t.magic).toBe('VTL4');
    expect(t.fluid).toBeDefined();
    expect(t.fluid!.vertexCount).toBe(3);
    expect(Array.from(t.fluid!.biome!)).toEqual([1, 1, 1]);
    expect(t.surface).toBeUndefined();
    expect(t.biomeNames).toEqual(LEGEND);
  });

  it('decodes VTL5 (+ top-down surface map)', () => {
    const t = parseTile(encodeVTL5());
    expect(t.magic).toBe('VTL5');
    expect(t.fluid).toBeDefined();
    expect(t.surface).toBeDefined();
    const s = t.surface!;
    expect([s.width, s.depth, s.originX, s.originZ]).toEqual([2, 2, 0, 0]);
    expect(Array.from(s.biome)).toEqual([1, 2, 1, 2]);
    expect(Array.from(s.height)).toEqual([64, 65, 66, 67]);
    expect(t.biomeNames).toEqual(LEGEND);
  });

  it('decodes VTL6 (quantized vertices, round-trips positions)', () => {
    const t = parseTile(encodeVTL6());
    expect(t.magic).toBe('VTL6');
    expect(t.version).toBe(6);
    expect(t.textured).toBe(true);
    expect(t.hasBiome).toBe(true);
    expect(t.vertexCount).toBe(3);
    // u16 positions reconstruct as min + q·scale.
    expect(t.positions[0]).toBeCloseTo(-100, 3); // v0 x: q=0 → min
    expect(t.positions[3]).toBeCloseTo(200, 2); // v1 x: q=65535 → min+span
    expect(t.positions[7]).toBeCloseTo(64, 2); // v2 y: q=65535 → 0+64
    expect(Array.from(t.layer!)).toEqual([3, 3, 3]); // u16 ids expand to float
    expect(Array.from(t.biome!)).toEqual([1, 2, 1]);
    expect(t.fluid).toBeDefined();
    expect(t.surface).toBeDefined();
    expect(Array.from(t.surface!.height)).toEqual([64, 65, 66, 67]);
    expect(t.biomeNames).toEqual(LEGEND);
  });

  it('throws on an unrecognized magic', () => {
    const buf = new ArrayBuffer(16);
    new Uint8Array(buf).set([88, 88, 88, 88]); // "XXXX"
    expect(() => parseTile(buf)).toThrow(/unrecognized tile magic/);
  });
});

describe('parseTileQuantized', () => {
  it('keeps VTL6 sections in their on-disk encoding (GPU dequantizes)', () => {
    const q = parseTileQuantized(encodeVTL6());
    expect(q).not.toBeNull();
    const s = q!.solid;
    expect(s.vertexCount).toBe(3);
    // Positions stay u16; the transform reconstructs what parseTile expands to.
    expect(s.positions).toBeInstanceOf(Uint16Array);
    expect(s.posMin[0] + s.positions[0]! * s.posScale[0]!).toBeCloseTo(-100, 3);
    expect(s.posMin[0] + s.positions[3]! * s.posScale[0]!).toBeCloseTo(200, 2);
    // Layer/biome stay u16 ids; normals keep the packed light byte in .w.
    expect(Array.from(s.layer)).toEqual([3, 3, 3]);
    expect(Array.from(s.biome)).toEqual([1, 2, 1]);
    expect(s.normals.length).toBe(4 * 3);
    expect(q!.biomeNames).toEqual(LEGEND);
    expect(Array.from(q!.surface.height)).toEqual([64, 65, 66, 67]);
    // The summary path streamed tiles use: counts surface columns.
    const entries = summarizeSurfaceBiomes(q!.surface, q!.biomeNames);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.id !== 0)).toBe(true);
  });

  it('returns null for non-VTL6 tiles (caller falls back to parseTile)', () => {
    expect(parseTileQuantized(encodeVTL5())).toBeNull();
  });
});

describe('summarizeBiomes', () => {
  it('summarizes present biomes by area, most common first', () => {
    // A plains triangle of area 2 and a savanna triangle of area 1 → 2/3, 1/3.
    // (Weighting by area, not vertex count, so greedy-merged quads count fairly.)
    const tile = parseTile(
      encodeVTL3Geo(
        [0, 0, 0, 2, 0, 0, 0, 2, 0, /* savanna */ 0, 0, 0, 2, 0, 0, 0, 1, 0],
        [1, 1, 1, 2, 2, 2],
        [0, 1, 2, 3, 4, 5],
      ),
    );
    const entries = summarizeBiomes(tile);
    expect(entries.map((e) => e.label)).toEqual(['plains', 'savanna']);
    expect(entries[0]!.fraction).toBeCloseTo(2 / 3, 5);
    expect(entries[1]!.fraction).toBeCloseTo(1 / 3, 5);
    // the empty sentinel (id 0) is excluded.
    expect(entries.some((e) => e.id === 0)).toBe(false);
  });

  it('returns nothing for a tile without biome data', () => {
    expect(summarizeBiomes(parseTile(encodeVTL2()))).toEqual([]);
  });
});

describe('parseTextureArray', () => {
  it('decodes a VTA1 texture array', () => {
    const tex = parseTextureArray(encodeTextureArray(2, 2, 3));
    expect(tex.width).toBe(2);
    expect(tex.height).toBe(2);
    expect(tex.layers).toBe(3);
    expect(tex.pixels.length).toBe(2 * 2 * 3 * 4);
    expect(tex.pixels[5]).toBe(5);
  });

  it('throws on an unrecognized magic', () => {
    const buf = new ArrayBuffer(20);
    new Uint8Array(buf).set([88, 88, 88, 88]);
    expect(() => parseTextureArray(buf)).toThrow(/unrecognized texture magic/);
  });
});
