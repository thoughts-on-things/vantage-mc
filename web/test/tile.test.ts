import { describe, expect, it } from 'vitest';
import { canonicalQuadIndices, parseTextureArray, parseTile, parseTileQuantized, summarizeBiomes, summarizeSurfaceBiomes } from '../src/core/index.js';
import {
  encodeTextureArray,
  encodeTextureArrayV1,
  encodeVTL1,
  encodeVTL2,
  encodeVTL3,
  encodeVTL3Geo,
  encodeVTL4,
  encodeVTL5,
  encodeVTL6,
  encodeVTL7,
  encodeVTL8,
  encodeVTL9,
  encodeVTLA,
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

  it('decodes VTL7 (compact quads: no indices, delta positions, i16 uv)', () => {
    const t = parseTile(encodeVTL7());
    expect(t.magic).toBe('VTL7');
    expect(t.version).toBe(7);
    expect(t.textured).toBe(true);
    expect(t.hasBiome).toBe(true);
    expect(t.vertexCount).toBe(4);
    // Indices are synthesized from the canonical quad topology.
    expect(t.indexCount).toBe(6);
    expect(Array.from(t.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    // Delta-coded u16 positions reconstruct as min + q·scale.
    expect(t.positions[0]).toBeCloseTo(-100, 3); // v0 x: q=0 → min
    expect(t.positions[3]).toBeCloseTo(200, 2); // v1 x: q=65535 → min+span
    expect(t.positions[7]).toBeCloseTo(64, 2); // v2 y: q=65535 → 0+64
    // i16 fixed-point uv dequantizes at 1/128 per step (incl. negatives).
    expect(t.uv![0]).toBeCloseTo(0, 5);
    expect(t.uv![2]).toBeCloseTo(17, 5);
    expect(t.uv![5]).toBeCloseTo(1, 5);
    expect(t.uv![6]).toBeCloseTo(-0.25, 5);
    expect(Array.from(t.layer!)).toEqual([3, 3, 3, 3]);
    expect(Array.from(t.biome!)).toEqual([1, 2, 1, 2]);
    expect(t.fluid).toBeDefined();
    expect(t.fluid!.vertexCount).toBe(4);
    expect(t.surface).toBeDefined();
    expect(Array.from(t.surface!.height)).toEqual([64, 65, 66, 67]);
    expect(t.biomeNames).toEqual(LEGEND);
  });

  it('decodes VTL8 (lightmap atlas) and bakes corner light into the tail vertices', () => {
    const t = parseTile(encodeVTL8());
    expect(t.magic).toBe('VTL8');
    expect(t.vertexCount).toBe(8);
    expect(t.lmStart).toBe(4);
    expect(t.lightmap).toBeDefined();
    expect(t.lightmap!.width).toBe(4);
    expect(t.lightmap!.height).toBe(2);
    // Planar channels re-interleave to RGBA: texel (1,0) = sky 17, blk 34, ao 255.
    expect(Array.from(t.lightmap!.pixels.slice(4, 8))).toEqual([17, 34, 255, 255]);
    // Head vertices keep their shipped light; tail vertices get the atlas'
    // corner texels baked back in: lmuv (3,1) → texel (1,0) → sky 1, blk 2.
    expect(t.light![4]).toBe((1 << 4) | 2);
    // lmuv (5,3) → texel (2,1) → sky ramp value 102/17 = 6.
    expect(t.light![6]).toBe((6 << 4) | 2);
    expect(t.colors![4 * 4 + 3]).toBe(255); // AO from the atlas
  });

  it('decodes VTL9 packed lightmaps without changing corner light or AO', () => {
    const t = parseTile(encodeVTL9());
    expect(t.magic).toBe('VTL9');
    expect(t.lightmap?.packed).toBe(true);
    expect(Array.from(t.lightmap!.pixels.slice(2, 4))).toEqual([0x12, 255]);
    // Same logical samples as VTL8: sky=1/block=2 at texel (1,0), then
    // sky=6/block=2 at texel (2,1).
    expect(t.light![4]).toBe((1 << 4) | 2);
    expect(t.light![6]).toBe((6 << 4) | 2);
    expect(t.colors![4 * 4 + 3]).toBe(255);
  });

  it('decodes VTLA the classic way, skipping the cave boundaries', () => {
    const t = parseTile(encodeVTLA());
    expect(t.magic).toBe('VTLA');
    expect(t.lightmap?.packed).toBe(true);
    // The expand path draws everything; the extra header fields must not
    // shift the streams — same corner-light bakes as VTL9.
    expect(t.light![4]).toBe((1 << 4) | 2);
    expect(t.light![6]).toBe((6 << 4) | 2);
    expect(t.colors![4 * 4 + 3]).toBe(255);
  });

  it('throws on an unrecognized magic', () => {
    const buf = new ArrayBuffer(16);
    new Uint8Array(buf).set([88, 88, 88, 88]); // "XXXX"
    expect(() => parseTile(buf)).toThrow(/unrecognized tile magic/);
  });
});

describe('canonicalQuadIndices', () => {
  it('emits two CCW triangles per 4 vertices', () => {
    expect(Array.from(canonicalQuadIndices(8))).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    expect(canonicalQuadIndices(0).length).toBe(0);
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

  it('keeps VTL7 sections quantized: i16 uv views, decoded u16 positions, no indices', () => {
    const q = parseTileQuantized(encodeVTL7());
    expect(q).not.toBeNull();
    expect(q!.magic).toBe('VTL7');
    const s = q!.solid;
    expect(s.vertexCount).toBe(4);
    expect(s.indexCount).toBe(6);
    expect(s.indices).toBeNull(); // derived — the renderer shares one buffer
    // Positions decode from deltas to absolute u16.
    expect(s.positions).toBeInstanceOf(Uint16Array);
    expect(Array.from(s.positions.slice(0, 6))).toEqual([0, 0, 0, 65535, 0, 0]);
    expect(s.posMin[0] + s.positions[3]! * s.posScale[0]!).toBeCloseTo(200, 2);
    // UV stays an i16 view with its dequant scale.
    expect(s.uv).toBeInstanceOf(Int16Array);
    expect(s.uvScale).toBeCloseTo(1 / 128, 8);
    expect(s.uv[2]! * s.uvScale).toBeCloseTo(17, 5);
    expect(Array.from(s.layer)).toEqual([3, 3, 3, 3]);
    expect(q!.biomeNames).toEqual(LEGEND);
  });

  it('keeps VTL8 sections quantized with the lm split and the interleaved atlas', () => {
    const q = parseTileQuantized(encodeVTL8());
    expect(q).not.toBeNull();
    expect(q!.magic).toBe('VTL8');
    const s = q!.solid;
    expect(s.vertexCount).toBe(8);
    expect(s.lmStart).toBe(4);
    expect(s.indices).toBeNull();
    // The lmuv tail un-deltas back to the absolute half-texel values.
    expect(Array.from(s.lmuv!)).toEqual([3, 1, 3, 3, 5, 3, 5, 1]);
    expect(q!.lightmap).toBeDefined();
    expect(q!.lightmap!.width).toBe(4);
    expect(Array.from(q!.lightmap!.pixels.slice(0, 4))).toEqual([0, 34, 255, 255]);
    // Surface + legend still parse after the atlas block.
    expect(Array.from(q!.surface.height)).toEqual([64, 65, 66, 67]);
    expect(q!.biomeNames).toEqual(LEGEND);
  });

  it('keeps VTL9 lightmaps as a compact packed RG8 upload', () => {
    const q = parseTileQuantized(encodeVTL9());
    expect(q?.magic).toBe('VTL9');
    expect(q?.lightmap?.packed).toBe(true);
    expect(q?.lightmap?.pixels).toHaveLength(4 * 2 * 2);
    expect(Array.from(q!.lightmap!.pixels.slice(0, 6))).toEqual([0x02, 255, 0x12, 255, 0x22, 255]);
    expect(Array.from(q!.solid.lmuv!)).toEqual([3, 1, 3, 3, 5, 3, 5, 1]);
    expect(Array.from(q!.surface.height)).toEqual([64, 65, 66, 67]);
    // Pre-VTLA tiles carry no cave boundaries.
    expect(q!.solid.caveStart).toBeUndefined();
    expect(q!.fluid.caveStart).toBeUndefined();
  });

  it('reads VTLA cave-partition boundaries and everything after them', () => {
    const q = parseTileQuantized(encodeVTLA());
    expect(q?.magic).toBe('VTLA');
    const s = q!.solid;
    // The encoder marks the vertex-lit quad cave-dark and the atlas quad
    // surface: head boundary 0, tail boundary 8 (= vertexCount).
    expect(s.caveStart).toBe(0);
    expect(s.caveLmStart).toBe(8);
    expect(q!.fluid.caveStart).toBe(0);
    // The streams after the new header fields still line up exactly.
    expect(s.lmStart).toBe(4);
    expect(Array.from(s.lmuv!)).toEqual([3, 1, 3, 3, 5, 3, 5, 1]);
    expect(Array.from(s.positions.slice(0, 6))).toEqual([0, 0, 0, 65535, 0, 0]);
    expect(q!.lightmap?.packed).toBe(true);
    expect(Array.from(q!.lightmap!.pixels.slice(0, 4))).toEqual([0x02, 255, 0x12, 255]);
    expect(Array.from(q!.surface.height)).toEqual([64, 65, 66, 67]);
    expect(q!.biomeNames).toEqual(LEGEND);
  });

  it('rejects lit sections whose header boundaries are out of range or unaligned', () => {
    // Patch a valid VTLA buffer's header in place: V@8, lmStart@12,
    // caveStart@16, caveLmStart@20 (little-endian u32s after magic+version).
    const corrupt = (offset: number, value: number) => {
      const buf = encodeVTLA();
      new DataView(buf).setUint32(offset, value, true);
      return buf;
    };
    // lmStart past the vertex count would size a negative lmuv view.
    expect(() => parseTileQuantized(corrupt(12, 12))).toThrow(/corrupt lit section/);
    // Cave boundaries must be quad-aligned and ordered within their segments.
    expect(() => parseTileQuantized(corrupt(16, 8))).toThrow(/corrupt VTLA cave/); // caveStart > lmStart
    expect(() => parseTileQuantized(corrupt(20, 7))).toThrow(/corrupt VTLA cave/); // unaligned
    expect(() => parseTileQuantized(corrupt(20, 12))).toThrow(/corrupt VTLA cave/); // caveLmStart > V
    // The classic expand path shares the reader, so it rejects them too.
    expect(() => parseTile(corrupt(12, 12))).toThrow(/corrupt lit section/);
  });

  it('parses the same VTL7 buffer twice without corruption (delta decode copies)', () => {
    const buf = encodeVTL7();
    const a = parseTileQuantized(buf)!;
    const b = parseTileQuantized(buf)!;
    expect(Array.from(b.solid.positions)).toEqual(Array.from(a.solid.positions));
  });

  it('returns null for non-quantized tiles (caller falls back to parseTile)', () => {
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
  it('decodes a texture array with an empty animation table', () => {
    const tex = parseTextureArray(encodeTextureArray(2, 2, 3));
    expect(tex.width).toBe(2);
    expect(tex.height).toBe(2);
    expect(tex.layers).toBe(3);
    expect(tex.pixels.length).toBe(2 * 2 * 3 * 4);
    expect(tex.pixels[5]).toBe(5);
    expect(tex.anims).toEqual([]);
  });

  it('decodes the version-2 animation table', () => {
    const tex = parseTextureArray(
      encodeTextureArray(2, 2, 40, [
        { base: 3, count: 32, frametime: 2, interpolate: false },
        { base: 35, count: 3, frametime: 300, interpolate: true },
      ]),
    );
    expect(tex.anims).toEqual([
      { base: 3, count: 32, frametime: 2, interpolate: false },
      { base: 35, count: 3, frametime: 300, interpolate: true },
    ]);
  });

  it('still decodes legacy version-1 files (no animation table)', () => {
    const tex = parseTextureArray(encodeTextureArrayV1(2, 2, 3));
    expect(tex.layers).toBe(3);
    expect(tex.pixels.length).toBe(2 * 2 * 3 * 4);
    expect(tex.anims).toEqual([]);
  });

  it('throws on an unrecognized magic', () => {
    const buf = new ArrayBuffer(20);
    new Uint8Array(buf).set([88, 88, 88, 88]);
    expect(() => parseTextureArray(buf)).toThrow(/unrecognized texture magic/);
  });
});
