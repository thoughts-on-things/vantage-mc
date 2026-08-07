// `players.json` parsing: the Vantage document, BlueMap's live/players.json
// verbatim, and the ways a host can get it wrong without breaking the map.

import { describe, expect, it } from 'vitest';
import { angleDelta, parsePlayers, samePlayers, wrapDegrees } from '../src/core/players.js';

const vantageDoc = {
  format: 1,
  source: 'playerdata',
  updated: 1_759_449_060_212,
  players: [
    {
      uuid: '91c71e4a-146c-4788-bbb9-39002556a24e',
      name: '91c71e4a',
      foreign: false,
      position: { x: 144.5, y: 67, z: 54.5 },
      rotation: { yaw: 0, pitch: 0 },
      dimension: 'minecraft:overworld',
      health: 20,
      gamemode: 'survival',
      stale: true,
      seen: 1_759_449_060_212,
    },
  ],
};

// Exactly what BlueMap's LivePlayersDataSupplier writes — no Vantage fields.
const blueMapDoc = {
  players: [
    {
      uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
      name: 'Notch',
      foreign: false,
      position: { x: 383.2, y: 70, z: -206.1 },
      rotation: { pitch: 13.9, yaw: 8.75, roll: 0 },
    },
  ],
};

describe('parsePlayers', () => {
  it('reads a Vantage document', () => {
    const snap = parsePlayers(vantageDoc, 'minecraft:overworld');
    expect(snap.source).toBe('playerdata');
    expect(snap.updated).toBe(1_759_449_060_212);
    expect(snap.players).toHaveLength(1);
    const p = snap.players[0]!;
    expect(p.name).toBe('91c71e4a');
    expect([p.x, p.y, p.z]).toEqual([144.5, 67, 54.5]);
    expect(p.stale).toBe(true);
    expect(p.foreign).toBe(false);
    expect(p.health).toBe(20);
  });

  it("reads BlueMap's live/players.json as-is", () => {
    const snap = parsePlayers(blueMapDoc, 'minecraft:overworld');
    expect(snap.source).toBe('unknown');
    expect(snap.players).toHaveLength(1);
    const p = snap.players[0]!;
    expect(p.name).toBe('Notch');
    expect(p.x).toBeCloseTo(383.2);
    expect(p.yaw).toBeCloseTo(8.75);
    expect(p.pitch).toBeCloseTo(13.9);
    // No `stale` field means live: BlueMap only ever reports online players.
    expect(p.stale).toBe(false);
  });

  it('accepts flat coordinates and a bare array', () => {
    const snap = parsePlayers([{ uuid: 'a', name: 'A', x: 1, y: 2, z: 3, yaw: 90 }]);
    expect(snap.players).toHaveLength(1);
    expect(snap.players[0]!.z).toBe(3);
    expect(snap.players[0]!.yaw).toBe(90);
  });

  it('flags players in another dimension as foreign', () => {
    const snap = parsePlayers(
      {
        players: [
          { uuid: 'a', name: 'Here', x: 0, y: 0, z: 0, dimension: 'minecraft:overworld' },
          { uuid: 'b', name: 'Away', x: 0, y: 0, z: 0, dimension: 'minecraft:the_nether' },
          { uuid: 'c', name: 'Silent', x: 0, y: 0, z: 0 },
        ],
      },
      'minecraft:overworld',
    );
    expect(snap.players.map((p) => p.foreign)).toEqual([false, true, false]);
  });

  it('drops malformed players individually', () => {
    const snap = parsePlayers({
      players: [
        { uuid: 'good', name: 'Good', position: { x: 1, y: 2, z: 3 } },
        { uuid: 'nopos', name: 'NoPosition' },
        { uuid: 'nan', name: 'NaN', x: Number.NaN, y: 2, z: 3 },
        { uuid: 'far', name: 'OffWorld', x: 5e8, y: 2, z: 3 },
        { name: 'Unnamed only', x: 1, y: 2, z: 3 },
        'not an object',
        null,
      ],
    });
    expect(snap.players.map((p) => p.name)).toEqual(['Good', 'Unnamed only']);
  });

  it('de-duplicates repeated uuids', () => {
    const snap = parsePlayers({
      players: [
        { uuid: 'a', name: 'First', x: 1, y: 2, z: 3 },
        { uuid: 'a', name: 'Duplicate', x: 9, y: 9, z: 9 },
      ],
    });
    expect(snap.players).toHaveLength(1);
    expect(snap.players[0]!.name).toBe('First');
  });

  it('keeps skin references inside the map directory', () => {
    const skins = (skin: unknown) => parsePlayers({ players: [{ uuid: 'a', x: 0, y: 0, z: 0, skin }] }).players[0]!.skin;
    expect(skins('skins/a.png')).toBe('skins/a.png');
    expect(skins('https://evil.example/a.png')).toBeUndefined();
    expect(skins('/absolute.png')).toBeUndefined();
    expect(skins('../secret.png')).toBeUndefined();
    expect(skins('a/../b.png')).toBeUndefined();
    expect(skins('a\\b.png')).toBeUndefined();
    expect(skins(42)).toBeUndefined();
  });

  it('rejects a document that is not a player list', () => {
    expect(() => parsePlayers({ tiles: [] })).toThrow(/players array/);
    expect(() => parsePlayers('nope')).toThrow(/players array/);
    expect(() => parsePlayers(null)).toThrow(/players array/);
  });

  it('normalizes rotation into the range the renderer expects', () => {
    const snap = parsePlayers({ players: [{ uuid: 'a', x: 0, y: 0, z: 0, yaw: 540, pitch: -400 }] });
    expect(Math.abs(snap.players[0]!.yaw)).toBeCloseTo(180);
    expect(snap.players[0]!.pitch).toBe(-90);
  });
});

describe('angles', () => {
  it('wraps to [-180, 180)', () => {
    expect(wrapDegrees(0)).toBe(0);
    expect(wrapDegrees(190)).toBeCloseTo(-170);
    expect(wrapDegrees(-190)).toBeCloseTo(170);
    expect(wrapDegrees(720)).toBeCloseTo(0);
    // The seam: half a turn lands on the negative end, which is the same
    // direction and the same distance from anywhere.
    expect(wrapDegrees(180)).toBe(-180);
    expect(wrapDegrees(-180)).toBe(-180);
  });

  it('takes the short way around when interpolating', () => {
    // 170° → -170° is a 20° step across the seam, not 340° the other way.
    expect(angleDelta(170, -170)).toBeCloseTo(20);
    expect(angleDelta(-170, 170)).toBeCloseTo(-20);
    expect(angleDelta(0, 90)).toBeCloseTo(90);
  });
});

describe('samePlayers', () => {
  const snap = (x: number) => parsePlayers({ players: [{ uuid: 'a', name: 'A', x, y: 0, z: 0 }] });

  it('is true for an unchanged roster', () => {
    expect(samePlayers(snap(1), snap(1))).toBe(true);
  });

  it('is false once anyone moves or joins', () => {
    expect(samePlayers(snap(1), snap(2))).toBe(false);
    expect(samePlayers(snap(1), parsePlayers({ players: [] }))).toBe(false);
  });

  it('ignores the order the source listed them in', () => {
    // A directory listing, a map iteration, or a host that sorts by rank can
    // reorder freely. Nothing about the world changed, so nothing should redraw.
    const one = { uuid: 'a', name: 'A', x: 1, y: 0, z: 0 };
    const two = { uuid: 'b', name: 'B', x: 2, y: 0, z: 0 };
    expect(samePlayers(parsePlayers({ players: [one, two] }), parsePlayers({ players: [two, one] }))).toBe(true);
  });

  it('notices a change to anything a consumer renders', () => {
    const base = { uuid: 'a', name: 'A', x: 1, y: 0, z: 0, health: 20, gamemode: 'survival', dimension: 'minecraft:overworld' };
    const changed = (patch: Record<string, unknown>) =>
      samePlayers(parsePlayers({ players: [base] }), parsePlayers({ players: [{ ...base, ...patch }] }));
    // A stationary player who is renamed, hurt, teleported to the nether, or
    // handed a skin must still repaint their tag and their roster row.
    expect(changed({ name: 'Renamed' })).toBe(false);
    expect(changed({ health: 6 })).toBe(false);
    expect(changed({ gamemode: 'spectator' })).toBe(false);
    expect(changed({ dimension: 'minecraft:the_nether' })).toBe(false);
    expect(changed({ skin: 'skins/a.png' })).toBe(false);
    expect(changed({ stale: true })).toBe(false);
    expect(changed({ yaw: 90 })).toBe(false);
    expect(changed({})).toBe(true);
  });

  it('is false when the same count describes different people', () => {
    const a = parsePlayers({ players: [{ uuid: 'a', name: 'A', x: 0, y: 0, z: 0 }] });
    const b = parsePlayers({ players: [{ uuid: 'b', name: 'B', x: 0, y: 0, z: 0 }] });
    expect(samePlayers(a, b)).toBe(false);
  });
});
