#!/usr/bin/env node
// Generate a synthetic Minecraft save with all three vanilla dimensions.
//
// Vantage's dimension work needs nether/end terrain to develop against, and a
// real save only has those region files if a player actually went there — the
// checked-in demo world (and most test worlds) are overworld-only. This writes
// Anvil region files directly: structurally faithful (bedrock roof and floor,
// 3D-noise caverns, a lava sea, glowstone ceilings, a fortress, floating end
// islands over the void) without shipping any Mojang-generated world data.
//
//   node scripts/make-fixture-world.mjs --out .vantage-dev/fixture-world
//   node scripts/make-fixture-world.mjs --out /tmp/big --chunks 32   # perf runs
//
// It is deliberately dependency-free and deterministic: same flags, same bytes.

import { deflateSync, gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------- NBT writing

const TAG = {
  byte: 1,
  short: 2,
  int: 3,
  long: 4,
  string: 8,
  list: 9,
  compound: 10,
  intArray: 11,
  longArray: 12,
};

// Values are tagged so the encoder knows the wire type: {t:'int', v:3},
// {t:'compound', v:{...}}, {t:'list', of:'compound', v:[...]}, …
const int = (v) => ({ t: 'int', v });
const byte = (v) => ({ t: 'byte', v });
const str = (v) => ({ t: 'string', v });
const compound = (v) => ({ t: 'compound', v });
const list = (of, v) => ({ t: 'list', of, v });
const longArray = (v) => ({ t: 'longArray', v });
const intArray = (v) => ({ t: 'intArray', v });

function encodeString(s) {
  const bytes = Buffer.from(s, 'utf8');
  const out = Buffer.allocUnsafe(2 + bytes.length);
  out.writeUInt16BE(bytes.length, 0);
  bytes.copy(out, 2);
  return out;
}

function encodePayload(node) {
  switch (node.t) {
    case 'byte': {
      const b = Buffer.allocUnsafe(1);
      b.writeInt8(node.v, 0);
      return b;
    }
    case 'short': {
      const b = Buffer.allocUnsafe(2);
      b.writeInt16BE(node.v, 0);
      return b;
    }
    case 'int': {
      const b = Buffer.allocUnsafe(4);
      b.writeInt32BE(node.v, 0);
      return b;
    }
    case 'long': {
      const b = Buffer.allocUnsafe(8);
      b.writeBigInt64BE(BigInt(node.v), 0);
      return b;
    }
    case 'string':
      return encodeString(node.v);
    case 'list': {
      const head = Buffer.allocUnsafe(5);
      head.writeUInt8(TAG[node.of], 0);
      head.writeInt32BE(node.v.length, 1);
      return Buffer.concat([head, ...node.v.map((e) => encodePayload({ t: node.of, ...e }))]);
    }
    case 'compound': {
      const parts = [];
      for (const [name, child] of Object.entries(node.v)) {
        if (child === undefined) continue;
        const head = Buffer.allocUnsafe(1);
        head.writeUInt8(TAG[child.t], 0);
        parts.push(head, encodeString(name), encodePayload(child));
      }
      parts.push(Buffer.from([0])); // TAG_End
      return Buffer.concat(parts);
    }
    case 'intArray': {
      const b = Buffer.allocUnsafe(4 + node.v.length * 4);
      b.writeInt32BE(node.v.length, 0);
      node.v.forEach((n, i) => b.writeInt32BE(n, 4 + i * 4));
      return b;
    }
    case 'longArray': {
      const b = Buffer.allocUnsafe(4 + node.v.length * 8);
      b.writeInt32BE(node.v.length, 0);
      node.v.forEach((n, i) => b.writeBigInt64BE(BigInt.asIntN(64, n), 4 + i * 8));
      return b;
    }
    default:
      throw new Error(`unhandled NBT tag ${node.t}`);
  }
}

/** A complete NBT document: the unnamed root compound and its payload. */
function encodeRoot(root) {
  return Buffer.concat([Buffer.from([TAG.compound]), encodeString(''), encodePayload(root)]);
}

// -------------------------------------------------------- palette bit packing

/** Minecraft's post-1.16 non-spanning packing: `bits` per index, whole indices
 *  only, so an index never straddles a 64-bit word. */
function packIndices(indices, bits) {
  const perLong = Math.floor(64 / bits);
  const longs = new Array(Math.ceil(indices.length / perLong)).fill(0n);
  for (let i = 0; i < indices.length; i++) {
    const li = Math.floor(i / perLong);
    const shift = BigInt((i % perLong) * bits);
    longs[li] |= BigInt(indices[i]) << shift;
  }
  return longs;
}

const bitsFor = (n, min) => {
  let b = min;
  while (1 << b < n) b++;
  return b;
};

// ------------------------------------------------------------- region writing

const SECTOR = 4096;

/** Write an Anvil `.mca`: 4 KiB location table, 4 KiB timestamps, then
 *  sector-aligned zlib chunk payloads. */
function writeRegion(path, chunks) {
  const locations = Buffer.alloc(SECTOR);
  const timestamps = Buffer.alloc(SECTOR);
  const payloads = [];
  let sector = 2; // the two header sectors come first
  for (const { lx, lz, nbt } of chunks) {
    const body = deflateSync(encodeRoot(nbt), { level: 6 });
    const header = Buffer.allocUnsafe(5);
    header.writeUInt32BE(body.length + 1, 0); // length counts the scheme byte
    header.writeUInt8(2, 4); // 2 = zlib
    const raw = Buffer.concat([header, body]);
    const count = Math.ceil(raw.length / SECTOR);
    const padded = Buffer.alloc(count * SECTOR);
    raw.copy(padded, 0);
    payloads.push(padded);

    const entry = (lz * 32 + lx) * 4;
    locations.writeUInt8((sector >> 16) & 0xff, entry);
    locations.writeUInt8((sector >> 8) & 0xff, entry + 1);
    locations.writeUInt8(sector & 0xff, entry + 2);
    locations.writeUInt8(count, entry + 3);
    timestamps.writeUInt32BE(1, entry);
    sector += count;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([locations, timestamps, ...payloads]));
}

// ------------------------------------------------------------- chunk building

const DATA_VERSION = 4440; // 1.21.x-era chunk layout (what Vantage reads)

/** A 16×16×`height` column of blocks, built by a per-dimension `fill` callback
 *  and serialized into 16³ sections. Block ids are strings ("minecraft:lava")
 *  optionally with a state ("minecraft:lava|level=0"). */
class ChunkBuilder {
  constructor(cx, cz, minSectionY, sectionCount) {
    this.cx = cx;
    this.cz = cz;
    this.minSectionY = minSectionY;
    this.sectionCount = sectionCount;
    this.height = sectionCount * 16;
    this.blocks = new Array(16 * this.height * 16).fill(null);
    this.biomes = new Array(4 * (this.height / 4) * 4).fill('minecraft:the_void');
  }

  idx(x, y, z) {
    return (y * 16 + z) * 16 + x;
  }

  set(x, y, z, name) {
    const ly = y - this.minSectionY * 16;
    if (ly < 0 || ly >= this.height) return;
    this.blocks[this.idx(x, ly, z)] = name;
  }

  get(x, y, z) {
    const ly = y - this.minSectionY * 16;
    if (ly < 0 || ly >= this.height) return null;
    return this.blocks[this.idx(x, ly, z)];
  }

  setBiome(x, y, z, name) {
    const ly = y - this.minSectionY * 16;
    if (ly < 0 || ly >= this.height) return;
    this.biomes[((ly >> 2) * 4 + (z >> 2)) * 4 + (x >> 2)] = name;
  }

  /** One section's NBT: block + biome palettes with their packed index arrays.
   *  Single-entry palettes ship without a `data` array, exactly like vanilla. */
  section(si) {
    const base = si * 16;
    const palette = [];
    const paletteIndex = new Map();
    const indices = new Array(4096);
    for (let y = 0; y < 16; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const key = this.blocks[this.idx(x, base + y, z)] ?? 'minecraft:air';
          let pi = paletteIndex.get(key);
          if (pi === undefined) {
            pi = palette.length;
            paletteIndex.set(key, pi);
            palette.push(key);
          }
          indices[(y * 16 + z) * 16 + x] = pi;
        }
      }
    }
    const entries = palette.map((key) => {
      const [name, state] = key.split('|');
      const props = state
        ? compound(Object.fromEntries(state.split(',').map((kv) => {
            const [k, v] = kv.split('=');
            return [k, str(v)];
          })))
        : undefined;
      return { v: { Name: str(name), Properties: props } };
    });

    const bpal = [];
    const bindex = new Map();
    const bcells = new Array(64);
    for (let y = 0; y < 4; y++) {
      for (let z = 0; z < 4; z++) {
        for (let x = 0; x < 4; x++) {
          const key = this.biomes[(((base >> 2) + y) * 4 + z) * 4 + x];
          let pi = bindex.get(key);
          if (pi === undefined) {
            pi = bpal.length;
            bindex.set(key, pi);
            bpal.push(key);
          }
          bcells[(y * 4 + z) * 4 + x] = pi;
        }
      }
    }

    return {
      v: {
        Y: byte(this.minSectionY + si),
        block_states: compound({
          palette: list('compound', entries),
          data: palette.length > 1 ? longArray(packIndices(indices, bitsFor(palette.length, 4))) : undefined,
        }),
        biomes: compound({
          palette: list('string', bpal.map((b) => ({ v: b }))),
          data: bpal.length > 1 ? longArray(packIndices(bcells, bitsFor(bpal.length, 1))) : undefined,
        }),
      },
    };
  }

  nbt() {
    const sections = [];
    for (let si = 0; si < this.sectionCount; si++) sections.push(this.section(si));
    return compound({
      DataVersion: int(DATA_VERSION),
      xPos: int(this.cx),
      yPos: int(this.minSectionY),
      zPos: int(this.cz),
      Status: str('minecraft:full'),
      sections: list('compound', sections),
    });
  }
}

// -------------------------------------------------------------------- noise

/** Deterministic value noise: a hashed integer lattice with smoothstep
 *  interpolation. Not Minecraft's generator — just enough spatial structure
 *  that culling, meshing and LOD see realistic surface area. */
function makeNoise(seed) {
  const hash = (x, y, z) => {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483629) + Math.imul(seed, 1274126177);
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const fade = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  return (x, y, z) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const tx = fade(x - xi);
    const ty = fade(y - yi);
    const tz = fade(z - zi);
    const c = (dx, dy, dz) => hash(xi + dx, yi + dy, zi + dz);
    const x00 = lerp(c(0, 0, 0), c(1, 0, 0), tx);
    const x10 = lerp(c(0, 1, 0), c(1, 1, 0), tx);
    const x01 = lerp(c(0, 0, 1), c(1, 0, 1), tx);
    const x11 = lerp(c(0, 1, 1), c(1, 1, 1), tx);
    return lerp(lerp(x00, x10, ty), lerp(x01, x11, ty), tz);
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ------------------------------------------------------------ the dimensions

/** The Nether: bedrock floor and roof, 3D-noise netherrack caverns, a lava sea
 *  at y=31, glowstone on cavern ceilings, biome patches, and a nether-brick
 *  fortress bridge — the shapes that decide how a nether render culls, lights
 *  and meshes. */
function buildNether(cx, cz, noise, fine) {
  const c = new ChunkBuilder(cx, cz, 0, 8); // y 0..127
  const wx0 = cx * 16;
  const wz0 = cz * 16;
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const wx = wx0 + x;
      const wz = wz0 + z;
      // Biome patches, big enough that a tile usually spans two of them.
      const bsel = noise(wx / 90, 0.5, wz / 90);
      const biome =
        bsel < 0.34 ? 'minecraft:nether_wastes'
        : bsel < 0.5 ? 'minecraft:crimson_forest'
        : bsel < 0.62 ? 'minecraft:warped_forest'
        : bsel < 0.78 ? 'minecraft:soul_sand_valley'
        : 'minecraft:basalt_deltas';
      for (let y = 0; y < 128; y += 4) c.setBiome(x, y, z, biome);

      for (let y = 0; y < 128; y++) {
        // Bedrock shell: 0..4 and 123..127, jagged on the inner faces.
        if (y === 0 || y === 127) {
          c.set(x, y, z, 'minecraft:bedrock');
          continue;
        }
        if (y <= 4 && noise(wx * 0.7, y * 3.1, wz * 0.7) > (y - 1) / 4) {
          c.set(x, y, z, 'minecraft:bedrock');
          continue;
        }
        if (y >= 123 && noise(wx * 0.7, y * 3.1 + 40, wz * 0.7) > (126 - y) / 4) {
          c.set(x, y, z, 'minecraft:bedrock');
          continue;
        }
        // Cavern density: mostly open in the middle, crusted near roof/floor.
        const d = noise(wx / 26, y / 20, wz / 26) * 0.75 + noise(wx / 9, y / 7, wz / 9) * 0.25 + fine(wx / 3.5, y / 3.5, wz / 3.5) * 0.06;
        const t = 0.5 + 0.34 * clamp01((y - 100) / 22) + 0.3 * clamp01((22 - y) / 18);
        if (d > t) {
          let block = 'minecraft:netherrack';
          if (biome === 'minecraft:basalt_deltas' && d > t + 0.1) block = 'minecraft:basalt';
          if (biome === 'minecraft:soul_sand_valley' && y < 45 && d < t + 0.06) block = 'minecraft:soul_sand';
          const ore = fine(wx * 1.7, y * 1.7, wz * 1.7);
          if (ore > 0.93) block = 'minecraft:nether_quartz_ore';
          else if (ore < 0.05 && y < 40) block = 'minecraft:magma_block';
          c.set(x, y, z, block);
        } else if (y <= 31) {
          c.set(x, y, z, 'minecraft:lava|level=0'); // the lava sea fills the low caverns
        }
      }

      // Nylium + fungus crust on the first solid surface under open air, and
      // glowstone hanging where a ceiling has open air beneath it.
      for (let y = 120; y > 5; y--) {
        const here = c.get(x, y, z);
        const above = c.get(x, y + 1, z);
        if (here === 'minecraft:netherrack' && above === null) {
          if (biome === 'minecraft:crimson_forest') {
            c.set(x, y, z, 'minecraft:crimson_nylium');
            if (fine(wx * 2.3, y, wz * 2.3) > 0.86) {
              for (let h = 1; h <= 3 + Math.floor(fine(wx, y, wz) * 3); h++) c.set(x, y + h, z, 'minecraft:crimson_stem');
              c.set(x, y + 4, z, 'minecraft:nether_wart_block');
            }
          } else if (biome === 'minecraft:warped_forest') {
            c.set(x, y, z, 'minecraft:warped_nylium');
            if (fine(wx * 2.3, y + 7, wz * 2.3) > 0.88) {
              for (let h = 1; h <= 4; h++) c.set(x, y + h, z, 'minecraft:warped_stem');
              c.set(x, y + 5, z, 'minecraft:warped_wart_block');
            }
          }
          break;
        }
      }
      for (let y = 118; y > 40; y--) {
        if (c.get(x, y, z) !== null && c.get(x, y - 1, z) === null) {
          if (fine(wx * 1.1 + 5, y * 1.1, wz * 1.1) > 0.955) {
            c.set(x, y - 1, z, 'minecraft:glowstone');
            c.set(x, y - 2, z, 'minecraft:glowstone');
          }
          break;
        }
      }
    }
  }

  // A fortress bridge deck with towers, spanning the fixture's middle chunks —
  // a hand-built structure to check that builds read clearly in the render.
  if (cz >= -1 && cz <= 0) {
    for (let z = 0; z < 16; z++) {
      const wz = wz0 + z;
      if (wz < -4 || wz > 3) continue;
      for (let x = 0; x < 16; x++) {
        for (let y = 62; y <= 68; y++) c.set(x, y, z, null);
        c.set(x, 62, z, 'minecraft:nether_bricks');
        if (wz === -4 || wz === 3) {
          c.set(x, 63, z, 'minecraft:nether_brick_fence');
          if ((wx0 + x) % 8 === 0) {
            for (let y = 63; y <= 67; y++) c.set(x, y, z, 'minecraft:nether_bricks');
            c.set(x, 66, z, 'minecraft:lantern');
          }
        }
      }
    }
  }
  return c;
}

/** The End: a void with a lens-shaped central island, obsidian spires, and
 *  outer islands with chorus plants and a purpur tower. Mostly empty space —
 *  the case where every populated tile is a thin shell over nothing. */
function buildEnd(cx, cz, noise, fine) {
  const c = new ChunkBuilder(cx, cz, 0, 16); // y 0..255
  const wx0 = cx * 16;
  const wz0 = cz * 16;
  let any = false;
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const wx = wx0 + x;
      const wz = wz0 + z;
      const r = Math.hypot(wx, wz);
      const biome = r < 62 ? 'minecraft:the_end' : r < 130 ? 'minecraft:end_barrens' : 'minecraft:end_highlands';
      for (let y = 0; y < 256; y += 4) c.setBiome(x, y, z, biome);

      // Central island: a lens thinning toward its rim, with a noisy surface.
      if (r < 62) {
        const falloff = 1 - (r / 62) ** 2;
        const top = 66 + Math.round(noise(wx / 22, 3, wz / 22) * 7 * falloff);
        const thickness = Math.round(6 + 20 * falloff + noise(wx / 14, 9, wz / 14) * 6);
        for (let y = top - thickness; y <= top; y++) c.set(x, y, z, 'minecraft:end_stone');
        any = true;
        // Obsidian spires ring the island, as in the real End.
        const ring = Math.abs(r - 43);
        const ang = Math.atan2(wz, wx);
        const spoke = Math.abs(((ang / Math.PI) * 5) % 1 - 0.5);
        if (ring < 4 && spoke > 0.44) {
          for (let y = top; y <= top + 26 - Math.round(ring * 4); y++) c.set(x, y, z, 'minecraft:obsidian');
          c.set(x, top + 27 - Math.round(ring * 4), z, 'minecraft:bedrock');
        }
      } else if (r > 130) {
        // Outer islands: floating slabs with chorus plants and one purpur tower.
        const m = noise(wx / 40, 7, wz / 40);
        if (m > 0.62) {
          const bulk = (m - 0.62) / 0.38;
          const top = 70 + Math.round(noise(wx / 30, 13, wz / 30) * 20);
          const thickness = Math.round(3 + 12 * bulk);
          for (let y = top - thickness; y <= top; y++) c.set(x, y, z, 'minecraft:end_stone');
          any = true;
          if (fine(wx * 1.9, 2, wz * 1.9) > 0.94) {
            const h = 3 + Math.floor(fine(wx, 5, wz) * 4);
            for (let y = 1; y <= h; y++) c.set(x, top + y, z, 'minecraft:chorus_plant');
            c.set(x, top + h + 1, z, 'minecraft:chorus_flower');
          }
          if (Math.abs(wx - 200) < 6 && Math.abs(wz - 40) < 6) {
            for (let y = top + 1; y <= top + 18; y++) {
              const shell = Math.abs(wx - 200) === 5 || Math.abs(wz - 40) === 5;
              c.set(x, y, z, shell ? 'minecraft:purpur_block' : y % 6 === 0 ? 'minecraft:purpur_slab|type=bottom' : null);
            }
            c.set(x, top + 19, z, 'minecraft:purpur_block');
            if (Math.abs(wx - 200) < 2 && Math.abs(wz - 40) < 2) c.set(x, top + 20, z, 'minecraft:end_rod|facing=up');
          }
        }
      }
    }
  }
  // The arrival platform at (100, 49, 0), like vanilla.
  if (wx0 <= 102 && wx0 + 15 >= 98 && wz0 <= 2 && wz0 + 15 >= -2) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const wx = wx0 + x;
        const wz = wz0 + z;
        if (Math.abs(wx - 100) <= 2 && Math.abs(wz) <= 2) {
          c.set(x, 49, z, 'minecraft:obsidian');
          any = true;
        }
      }
    }
  }
  return any ? c : null; // ungenerated void chunks are simply absent
}

/** A small overworld so the fixture is a complete save: noise hills, a lake,
 *  sand shores, oak trees, and a stone/ore interior with a cave layer. */
function buildOverworld(cx, cz, noise, fine) {
  const c = new ChunkBuilder(cx, cz, -4, 20); // y -64..255
  const wx0 = cx * 16;
  const wz0 = cz * 16;
  const SEA = 62;
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const wx = wx0 + x;
      const wz = wz0 + z;
      const h = Math.round(58 + noise(wx / 60, 1, wz / 60) * 26 + noise(wx / 17, 4, wz / 17) * 6);
      const biome = h < SEA ? 'minecraft:ocean' : h > 78 ? 'minecraft:windswept_hills' : 'minecraft:plains';
      for (let y = -64; y < 256; y += 4) c.setBiome(x, y, z, biome);
      c.set(x, -64, z, 'minecraft:bedrock');
      for (let y = -63; y <= h; y++) {
        // A cave layer so the overworld fixture exercises cave culling too.
        const cave = noise(wx / 21, y / 13, wz / 21);
        if (y < h - 4 && y < 50 && cave > 0.66) continue;
        c.set(x, y, z, y > h - 4 ? (h < SEA + 2 ? 'minecraft:sand' : 'minecraft:dirt') : y < 8 ? 'minecraft:deepslate' : 'minecraft:stone');
      }
      if (h >= SEA) c.set(x, h, z, h < SEA + 2 ? 'minecraft:sand' : 'minecraft:grass_block|snowy=false');
      for (let y = h + 1; y <= SEA; y++) c.set(x, y, z, 'minecraft:water|level=0');
      if (h > SEA + 1 && fine(wx * 2.7, 1, wz * 2.7) > 0.965) {
        for (let y = 1; y <= 5; y++) c.set(x, h + y, z, 'minecraft:oak_log|axis=y');
        for (let dy = 4; dy <= 6; dy++) {
          const rad = dy === 6 ? 1 : 2;
          for (let dz = -rad; dz <= rad; dz++) {
            for (let dx = -rad; dx <= rad; dx++) {
              if (dx === 0 && dz === 0 && dy < 6) continue;
              if (x + dx < 0 || x + dx > 15 || z + dz < 0 || z + dz > 15) continue;
              if (c.get(x + dx, h + dy, z + dz) === null) {
                c.set(x + dx, h + dy, z + dz, 'minecraft:oak_leaves|distance=1,persistent=false,waterlogged=false');
              }
            }
          }
        }
      }
    }
  }
  return c;
}

// ------------------------------------------------------------------ the save

function parseArgs(argv) {
  const opts = { out: '.vantage-dev/fixture-world', chunks: 12, seed: 1337, dims: 'all' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--chunks') opts.chunks = Number(argv[++i]);
    else if (a === '--seed') opts.seed = Number(argv[++i]);
    else if (a === '--dimensions') opts.dims = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`usage: node scripts/make-fixture-world.mjs [--out DIR] [--chunks N] [--seed N] [--dimensions all|overworld,nether,end]

Writes a synthetic save with overworld + nether + end region files, so Vantage's
dimension rendering can be developed and measured without a real explored world.
--chunks N generates an N×N chunk square centred on the origin (default 12).`);
      process.exit(0);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const wanted = opts.dims === 'all' ? ['overworld', 'nether', 'end'] : opts.dims.split(',');
  const half = Math.floor(opts.chunks / 2);
  const range = [];
  for (let cz = -half; cz < opts.chunks - half; cz++) {
    for (let cx = -half; cx < opts.chunks - half; cx++) range.push([cx, cz]);
  }

  const plans = {
    overworld: { dir: 'region', build: buildOverworld, seed: opts.seed },
    nether: { dir: 'DIM-1/region', build: buildNether, seed: opts.seed + 17 },
    end: { dir: 'DIM1/region', build: buildEnd, seed: opts.seed + 43 },
  };

  for (const name of wanted) {
    const plan = plans[name];
    if (!plan) throw new Error(`unknown dimension ${name}`);
    const noise = makeNoise(plan.seed);
    const fine = makeNoise(plan.seed + 991);
    // Chunks are grouped by the region file they land in (32×32 chunks each).
    const byRegion = new Map();
    for (const [cx, cz] of range) {
      const built = plan.build(cx, cz, noise, fine);
      if (!built) continue;
      const rx = Math.floor(cx / 32);
      const rz = Math.floor(cz / 32);
      const key = `${rx}.${rz}`;
      if (!byRegion.has(key)) byRegion.set(key, { rx, rz, chunks: [] });
      byRegion.get(key).chunks.push({ lx: cx - rx * 32, lz: cz - rz * 32, nbt: built.nbt() });
    }
    let bytes = 0;
    let count = 0;
    for (const { rx, rz, chunks } of byRegion.values()) {
      const path = join(opts.out, plan.dir, `r.${rx}.${rz}.mca`);
      writeRegion(path, chunks);
      bytes += chunks.length;
      count++;
    }
    console.log(`${name.padEnd(9)} ${bytes} chunks in ${count} region file(s) -> ${join(opts.out, plan.dir)}`);
  }

  // level.dat: spawn only — that is all Vantage reads from it.
  mkdirSync(opts.out, { recursive: true });
  writeFileSync(
    join(opts.out, 'level.dat'),
    gzipSync(
      encodeRoot(
        compound({
          Data: compound({
            DataVersion: int(DATA_VERSION),
            LevelName: str('Vantage fixture world'),
            spawn: compound({ pos: intArray([0, 70, 0]), dimension: str('minecraft:overworld') }),
            SpawnX: int(0),
            SpawnY: int(70),
            SpawnZ: int(0),
          }),
        }),
      ),
    ),
  );
  console.log(`\nsave: ${opts.out}`);
}

main();
