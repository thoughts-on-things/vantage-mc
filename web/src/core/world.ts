// The world index — `world.json`, the small file a render writes next to its
// dimensions. Each entry points at a self-contained manifest, so the index is
// pure convenience: it tells a viewer which dimensions exist and what to call
// them, and nothing breaks if a page loads a manifest directly instead.

import type { ManifestDimension } from './manifest.js';

/** One dimension of a rendered world. */
export interface WorldDimension extends ManifestDimension {
  /** This dimension's `manifest.json`, relative to `world.json`. */
  manifest: string;
  /** Hires tiles written for it (0 for a dimension that rendered empty). */
  tiles: number;
  /** Bytes on disk across its tiles and LOD pyramid. */
  bytes: number;
  /** Where the map opens: the world spawn mapped into this dimension. */
  spawn?: { x: number; y: number; z: number };
}

/** A parsed `world.json`. */
export interface WorldIndex {
  /** Index schema version (1 = the first). */
  format: number;
  dimensions: WorldDimension[];
}

const KINDS = new Set(['overworld', 'nether', 'end', 'custom']);
const SLUG_RE = /^[a-z0-9._-]{1,64}$/;
/** A manifest path stays inside the index's own directory — it is fetched with
 *  whatever credentials the world source carries. */
const MANIFEST_RE = /^(?:[A-Za-z0-9._-]+\/)*manifest\.json$/;

/**
 * Validate and type a fetched `world.json` value.
 *
 * @throws if the shape is not a Vantage world index this decoder understands.
 */
export function parseWorldIndex(data: unknown): WorldIndex {
  if (typeof data !== 'object' || data === null) throw new Error('vantage: world index is not an object');
  const m = data as Record<string, unknown>;
  const format = m['format'];
  if (format !== 1) throw new Error(`vantage: unsupported world index format ${String(format)} (expected 1)`);
  const list = m['dimensions'];
  if (!Array.isArray(list) || list.length === 0) throw new Error('vantage: world index has no dimensions');

  const dimensions = list.map((entry: unknown, i: number): WorldDimension => {
    const o = entry as Record<string, unknown>;
    if (typeof o !== 'object' || o === null) throw new Error(`vantage: world index dimension ${i} is malformed`);
    const { id, slug, label, kind, manifest, tiles, bytes } = o;
    if (typeof id !== 'string' || typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      throw new Error(`vantage: world index dimension ${i} has an invalid id/slug`);
    }
    if (typeof manifest !== 'string' || manifest.includes('..') || !MANIFEST_RE.test(manifest)) {
      throw new Error(`vantage: world index dimension ${i} has an invalid manifest path`);
    }
    // Untrusted input that ends up framing the camera: NaN or Infinity here
    // would poison every view derived from it, so only finite numbers count.
    const s = o['spawn'] as Record<string, unknown> | undefined;
    const coord = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    const spawn =
      typeof s === 'object' && s !== null && coord(s['x']) && coord(s['y']) && coord(s['z'])
        ? { x: s['x'], y: s['y'], z: s['z'] }
        : undefined;
    return {
      id,
      slug,
      label: typeof label === 'string' && label.length > 0 ? label : id,
      kind: typeof kind === 'string' && KINDS.has(kind) ? (kind as WorldDimension['kind']) : 'custom',
      manifest,
      tiles: typeof tiles === 'number' && Number.isFinite(tiles) && tiles >= 0 ? tiles : 0,
      bytes: typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? bytes : 0,
      ...(spawn ? { spawn } : {}),
    };
  });
  return { format, dimensions };
}

/** Whether a fetched JSON value looks like a world index rather than a
 *  manifest — how the viewer accepts either URL in its `world` option. */
export function isWorldIndex(data: unknown): boolean {
  return typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>)['dimensions']);
}

/** Resolve a dimension's manifest path against the index's own path, so
 *  `worlds/a/world.json` + `the_nether/manifest.json` reads as
 *  `worlds/a/the_nether/manifest.json`. */
export function resolveManifestPath(indexPath: string, manifest: string): string {
  const slash = indexPath.lastIndexOf('/');
  return slash < 0 ? manifest : `${indexPath.slice(0, slash + 1)}${manifest}`;
}

/** Pick the dimension a viewer should open: the requested slug when it exists,
 *  else the overworld, else the first with any tiles, else the first listed. */
export function pickDimension(index: WorldIndex, slug?: string | null): WorldDimension {
  const dims = index.dimensions;
  if (slug) {
    const wanted = dims.find((d) => d.slug === slug || d.id === slug);
    if (wanted) return wanted;
  }
  return dims.find((d) => d.kind === 'overworld') ?? dims.find((d) => d.tiles > 0) ?? dims[0]!;
}

/** Protocol world ids address a directory under `/v1/worlds/`, so they stay to
 *  the character set a path segment accepts. Matches the server's own grammar. */
export function isServerWorldId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/**
 * The `/v1/worlds` document as a world index.
 *
 * A protocol connection can carry more than one world — a host that fronts a
 * sidecar per dimension lists all three — and a client that already switches
 * between a render's dimensions should switch between those the same way. Each
 * descriptor may carry the same `dimension` block its manifest does; without
 * one, the world id is all there is to show.
 *
 * Manifest paths are derived from the id rather than read from the descriptor's
 * own `manifest` field, so every path this index yields is provably inside the
 * connection's `/v1/worlds/` prefix — a hostile world list cannot walk a
 * credentialed fetch somewhere else.
 *
 * @throws if the shape is not a world list this decoder understands.
 */
export function parseServerWorlds(data: unknown): WorldIndex {
  if (typeof data !== 'object' || data === null) throw new Error('vantage: server world list is not an object');
  const list = (data as Record<string, unknown>)['worlds'];
  if (!Array.isArray(list) || list.length === 0) throw new Error('vantage: server listed no worlds');

  const worldIds = new Set<string>();
  const slugs = new Set<string>();
  const dimensions = list.map((entry: unknown, i: number) => {
    const o = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const worldId = o['id'];
    if (typeof worldId !== 'string' || !isServerWorldId(worldId)) {
      throw new Error(`vantage: server world ${i} has an invalid id`);
    }
    const dim = (typeof o['dimension'] === 'object' && o['dimension'] !== null ? o['dimension'] : {}) as Record<string, unknown>;
    const advertisedSlug = dim['slug'];
    // World ids admit upper case and slugs do not, so the fallback is the id
    // folded rather than the id itself.
    const slug = typeof advertisedSlug === 'string' && SLUG_RE.test(advertisedSlug)
      ? advertisedSlug
      : worldId.toLowerCase();
    if (worldIds.has(worldId) || slugs.has(slug)) {
      throw new Error(`vantage: server world ${i} has a duplicate id or slug`);
    }
    worldIds.add(worldId);
    slugs.add(slug);
    return {
      id: typeof dim['id'] === 'string' ? dim['id'] : worldId,
      slug,
      label: typeof dim['label'] === 'string' ? dim['label'] : worldId,
      kind: dim['kind'],
      manifest: `${worldId}/manifest.json`,
      tiles: 0,
      bytes: 0,
    };
  });

  return parseWorldIndex({ format: 1, dimensions });
}
