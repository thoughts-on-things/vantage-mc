// A bounded LRU of tiles' compressed payloads, keyed by tile and source
// revision. Streaming a tile out and back in is the single most common thing
// a panning camera does; keeping the bytes it already downloaded turns that
// round trip into a decode — and against an on-demand server, saves a bake.
//
// Two budgets, because one does not bound the other: payload sizes vary by
// orders of magnitude (an all-ocean tile is a few hundred bytes, a jungle
// tile megabytes), so a pure byte ceiling would happily admit hundreds of
// thousands of near-free entries whose per-entry overhead it never sees.

interface Entry {
  buffer: ArrayBuffer;
  revision: string | undefined;
}

export class TileByteCache {
  /** Cap on retained entries, independent of their bytes. */
  static readonly MAX_ENTRIES = 4096;

  /** Insertion-ordered, and every hit re-inserts — so the front of the map is
   *  always the least recently used entry. */
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private budget: number;

  constructor(budget: number) {
    this.budget = budget;
  }

  /** Retained payload bytes. */
  get size(): number {
    return this.bytes;
  }

  /** Retained entry count. */
  get count(): number {
    return this.entries.size;
  }

  /** Resize the byte budget, evicting immediately to fit it. `0` (or less)
   *  disables the cache and drops everything: the setting is a memory
   *  ceiling, so lowering it must take effect now rather than whenever the
   *  next insertion happens to evict. */
  setBudget(budget: number): void {
    this.budget = budget;
    if (budget <= 0) {
      this.clear();
      return;
    }
    this.trim();
  }

  /** The payload for `key` if it was cached at exactly `revision` (a revised
   *  tile is different terrain, not a stale copy of the same). A hit counts
   *  as a use and moves to the back of the LRU. */
  get(key: string, revision: string | undefined): ArrayBuffer | undefined {
    const hit = this.entries.get(key);
    if (!hit || hit.revision !== revision) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.buffer;
  }

  /** Retain a payload, evicting least-recently-used entries to fit. Ignores
   *  payloads larger than the whole budget, and empty ones: a tile that
   *  meshes to nothing re-fetches as a 0-byte body without ever reaching a
   *  bake, so caching it would only accumulate entries the byte budget can
   *  never evict. */
  put(key: string, buffer: ArrayBuffer, revision: string | undefined): void {
    if (this.budget <= 0 || buffer.byteLength === 0 || buffer.byteLength > this.budget) return;
    this.drop(key);
    this.entries.set(key, { buffer, revision });
    this.bytes += buffer.byteLength;
    this.trim();
  }

  /** Forget one tile (its revision changed, it left the manifest, or its
   *  bytes failed to parse and must not be served from here again). */
  drop(key: string): void {
    const prev = this.entries.get(key);
    if (!prev) return;
    this.entries.delete(key);
    this.bytes -= prev.buffer.byteLength;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  private trim(): void {
    for (const [key, entry] of this.entries) {
      if (this.bytes <= this.budget && this.entries.size <= TileByteCache.MAX_ENTRIES) break;
      this.entries.delete(key);
      this.bytes -= entry.buffer.byteLength;
    }
  }
}
