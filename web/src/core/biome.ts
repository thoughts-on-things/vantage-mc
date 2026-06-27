// Pure biome helpers shared by the renderer and UI: a categorical colour palette
// and name formatting. No three.js, no DOM.

import type { DecodedTile } from './tile.js';

/** An RGB triple in 0..1. */
export type Rgb = readonly [number, number, number];

function hsv2rgb(h: number, s: number, v: number): Rgb {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const table: Rgb[] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ];
  return table[i % 6]!;
}

/**
 * A categorical palette of `n` well-separated hues (golden-angle spacing) so
 * adjacent biomes never collide and borders read at a glance. Index 0 is the
 * "no data" sentinel and maps to a neutral gray.
 */
export function biomePalette(n: number): Rgb[] {
  const out: Rgb[] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      out[i] = [0.55, 0.55, 0.6];
      continue;
    }
    const h = ((i - 1) * 0.61803398875) % 1;
    const sat = 0.55 + (0.12 * ((i * 7) % 3)) / 2; // slight jitter for separation
    out[i] = hsv2rgb(h, sat, 0.96);
  }
  return out;
}

/** Strip a `minecraft:` namespace prefix for display. */
export function stripNamespace(name: string): string {
  const c = name.indexOf(':');
  return c >= 0 ? name.slice(c + 1) : name;
}

/** A biome present in a tile, with its colour and share of the surface. */
export interface BiomeEntry {
  id: number;
  name: string;
  /** Display name with the namespace stripped. */
  label: string;
  color: Rgb;
  /** Vertex count carrying this biome. */
  count: number;
  /** Share of named, present vertices (0..1). */
  fraction: number;
}

/**
 * Summarize the biomes actually present in a tile, most common first. Returns an
 * empty list for tiles without biome data. Pass a `palette` to reuse one already
 * built for rendering; otherwise one is derived from the legend length.
 */
export function summarizeBiomes(tile: DecodedTile, palette?: Rgb[]): BiomeEntry[] {
  const names = tile.biomeNames;
  const biome = tile.biome;
  if (!names || !biome) return [];
  const pal = palette ?? biomePalette(names.length);

  const counts = new Array<number>(names.length).fill(0);
  for (let i = 0; i < tile.vertexCount; i++) {
    counts[biome[i]! | 0]!++;
  }

  const present: BiomeEntry[] = [];
  let total = 0;
  for (let id = 0; id < names.length; id++) {
    const count = counts[id]!;
    if (count > 0 && names[id]!.length > 0) {
      present.push({ id, name: names[id]!, label: stripNamespace(names[id]!), color: pal[id] ?? pal[0]!, count, fraction: 0 });
      total += count;
    }
  }
  present.sort((a, b) => b.count - a.count);
  const denom = total || 1;
  for (const e of present) e.fraction = e.count / denom;
  return present;
}
