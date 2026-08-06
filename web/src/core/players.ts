// Live player positions — `players.json`, the small document a Vantage server
// (or any host that writes one) publishes beside the manifest.
//
// The shape is a superset of BlueMap's `live/players.json`, so a server already
// running a BlueMap plugin can point Vantage straight at the file it is already
// writing. Everything Vantage adds is optional: a document with nothing but
// `players[].{uuid,name,position}` parses fine.
//
// This module is pure parsing — no three.js, no DOM. The renderer is in
// `three/players.ts` and the polling loop lives in the viewer.

/** One player, as the map knows them. */
export interface PlayerState {
  /** Stable identity across polls. Compared, never parsed. */
  uuid: string;
  /** Display name. Falls back to the uuid when the source has no name. */
  name: string;
  x: number;
  y: number;
  z: number;
  /** Degrees, Minecraft's convention: 0 faces +Z (south), increasing toward -X. */
  yaw: number;
  /** Degrees, negative looking up. */
  pitch: number;
  /** Resource id of the dimension they are in, when the source reports one. */
  dimension?: string;
  /** They are not in the dimension this map covers. Listed, but not placed. */
  foreign: boolean;
  /** A last-known position from disk rather than a live report. */
  stale: boolean;
  health?: number;
  gamemode?: string;
  /** Skin image path, relative to the manifest's own directory. */
  skin?: string;
  /** Epoch milliseconds when the position was observed, when known. */
  seen?: number;
}

/** A parsed `players.json`. */
export interface PlayerSnapshot {
  /** Where the positions came from: a live host feed, or the save's own files. */
  source: 'host' | 'playerdata' | 'unknown';
  /** Epoch milliseconds the source was last updated (0 when unknown). */
  updated: number;
  players: PlayerState[];
}

/** Nothing at all — what a viewer shows before the first poll answers. */
export const NO_PLAYERS: PlayerSnapshot = { source: 'unknown', updated: 0, players: [] };

/** Matches the sidecar's own cap: a roster this long is a misconfiguration,
 *  and every list the renderer builds is bounded by it. */
const MAX_PLAYERS = 512;

/** Minecraft's world border. Coordinates beyond it would push the camera and
 *  the marker layer into places no world occupies. */
const WORLD_LIMIT = 30_000_000;

/** Skins are fetched through the world source, which attaches the viewer's
 *  credentials — so a skin path must stay a plain relative path inside the
 *  map's own directory. Anything else is dropped rather than requested. */
const SKIN_PATH_RE = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

/** Wrap to (-180, 180] so interpolating between two samples takes the short way
 *  around instead of spinning a player through a full turn. */
export function wrapDegrees(deg: number): number {
  const wrapped = ((deg + 180) % 360 + 360) % 360;
  return wrapped - 180;
}

/** The signed shortest angular distance from `from` to `to`, in degrees. */
export function angleDelta(from: number, to: number): number {
  return wrapDegrees(to - from);
}

function parsePlayer(entry: unknown, mapDimension: string | undefined): PlayerState | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const o = entry as Record<string, unknown>;
  const pos = (typeof o['position'] === 'object' && o['position'] !== null ? o['position'] : o) as Record<string, unknown>;
  const x = num(pos['x']);
  const y = num(pos['y']);
  const z = num(pos['z']);
  // A player with no usable position is dropped on their own — a single bad
  // entry must never cost the map everyone else.
  if (x === undefined || y === undefined || z === undefined) return null;
  if (Math.abs(x) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) return null;

  const rot = (typeof o['rotation'] === 'object' && o['rotation'] !== null ? o['rotation'] : o) as Record<string, unknown>;
  const uuid = str(o['uuid'], 64);
  const name = str(o['name'], 64);
  if (!uuid && !name) return null;

  const dimension = str(o['dimension'], 128) ?? str(o['world'], 128);
  const skin = str(o['skin'], 256);
  return {
    uuid: uuid ?? name!,
    name: name ?? uuid!,
    x,
    y,
    z,
    yaw: wrapDegrees(num(rot['yaw']) ?? 0),
    pitch: Math.max(-90, Math.min(90, num(rot['pitch']) ?? 0)),
    ...(dimension ? { dimension } : {}),
    // A dimension the map doesn't cover makes a player foreign whatever the
    // source claimed; the source's own flag still counts on top of that.
    foreign: o['foreign'] === true || (dimension !== undefined && mapDimension !== undefined && dimension !== mapDimension),
    stale: o['stale'] === true,
    ...(num(o['health']) !== undefined ? { health: num(o['health'])! } : {}),
    ...(str(o['gamemode'], 32) ? { gamemode: str(o['gamemode'], 32)! } : {}),
    ...(skin && SKIN_PATH_RE.test(skin) ? { skin } : {}),
    ...(num(o['seen']) !== undefined ? { seen: num(o['seen'])! } : {}),
  };
}

/**
 * Validate and type a fetched `players.json` value.
 *
 * Unlike the manifest parser this never throws on a bad entry: a player list is
 * decoration on a map that has to keep working, and a host mid-rewrite is an
 * expected state, not an error. A document that isn't a player list at all
 * does throw, so the viewer can tell "no players here" from "this isn't the
 * file I asked for".
 *
 * @param mapDimension resource id of the dimension the map covers; players
 *   elsewhere come back flagged `foreign`.
 */
export function parsePlayers(data: unknown, mapDimension?: string): PlayerSnapshot {
  const list = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>)['players'])
    ? ((data as Record<string, unknown>)['players'] as unknown[])
    : null;
  if (!list) throw new Error('vantage: players.json has no players array');

  const players: PlayerState[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (players.length >= MAX_PLAYERS) break;
    const player = parsePlayer(entry, mapDimension);
    if (!player || seen.has(player.uuid)) continue;
    seen.add(player.uuid);
    players.push(player);
  }

  const root = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const source = root['source'];
  return {
    source: source === 'host' || source === 'playerdata' ? source : 'unknown',
    updated: num(root['updated']) ?? 0,
    players,
  };
}

/** Whether two snapshots describe the same players in the same places — the
 *  test the viewer uses to skip re-rendering and re-notifying on a poll that
 *  brought nothing new. */
export function samePlayers(a: PlayerSnapshot, b: PlayerSnapshot): boolean {
  if (a.players.length !== b.players.length) return false;
  for (let i = 0; i < a.players.length; i++) {
    const p = a.players[i]!;
    const q = b.players[i]!;
    if (p.uuid !== q.uuid || p.x !== q.x || p.y !== q.y || p.z !== q.z) return false;
    if (p.yaw !== q.yaw || p.pitch !== q.pitch || p.foreign !== q.foreign || p.stale !== q.stale) return false;
  }
  return true;
}
