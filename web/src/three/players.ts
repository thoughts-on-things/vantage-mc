// Live players on the map: a real Minecraft player model per player, moving
// between position samples, plus a constant-size name tag so a player is
// findable from any zoom.
//
// Everything here is driven by snapshots (see `core/players.ts`) that arrive
// about once a second. Between them the layer interpolates — position linearly,
// so a walking player moves at a steady speed, and rotation with an ease so a
// turn reads as a turn. Limb swing is derived from the measured speed, which is
// why a running player runs and a standing one stands still.
//
// The layer is self-contained: give it a scene and a camera, feed it snapshots,
// call `update` each frame, and ask it whether anything moved (that answer is
// what keeps the viewer's render-on-demand loop honest).

import * as THREE from 'three';
import { angleDelta, type PlayerSnapshot, type PlayerState } from '../core/players.js';
import {
  boxFaces,
  defaultSkinCanvas,
  defaultSlim,
  FACE_SHADE,
  headIconCanvas,
  modelParts,
  NODE_PIVOTS,
  normalizeSkin,
  PIXEL,
  SKIN_SIZE,
  type BoxFaces,
  type ModelPart,
} from './skin.js';

/** How players are drawn. Every field is live-tunable. */
export interface PlayerSettings {
  /** Draw players at all. Default `true`. */
  enabled?: boolean;
  /** Name tags above each player. Default `true`. */
  names?: boolean;
  /** Show players whose position is a last-known one from disk rather than a
   *  live report. Default `true` — for a singleplayer map they are the only
   *  players there are. */
  offline?: boolean;
  /** Show players the source reports as being in another dimension. They are
   *  always listed; this is about placing them on *this* map, where their
   *  coordinates mean something else. Default `false`. */
  foreign?: boolean;
  /** Model size multiplier. `1` is life-size (2 blocks tall); a whole-world
   *  view can afford to exaggerate. Default `1`. */
  scale?: number;
  /** Name-tag height as a fraction of the viewport. Default `0.03`. */
  tagSize?: number;
}

const DEFAULTS: Required<PlayerSettings> = {
  enabled: true,
  names: true,
  offline: true,
  foreign: false,
  scale: 1,
  tagSize: 0.03,
};

export interface PlayerLayerOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Read a skin image named by `players.json`, through the world source — so
   *  it is fetched from the map's own origin with the map's own credentials. */
  fetchSkin?: (path: string) => Promise<ArrayBuffer>;
  /** Resolve a player's skin to a URL the browser may load directly. The
   *  escape hatch for hosts with their own skin service; Vantage never calls
   *  one on its own, because doing so would tell a third party who is looking
   *  at the map and who is on the server. */
  resolveSkin?: (player: PlayerState) => string | null | undefined;
  settings?: PlayerSettings;
}

/** What the viewer needs to know about one player it is drawing. */
export interface PlayerView extends PlayerState {
  /** Live interpolated position — where the model actually is this frame. */
  drawX: number;
  drawY: number;
  drawZ: number;
  /** The player is placed on this map (not foreign, not filtered out). */
  visible: boolean;
}

/** Blocks per second at which limb swing reaches full amplitude (vanilla walk). */
const WALK_SPEED = 4.3;
/** How long a position sample is interpolated over, clamped around the
 *  measured feed cadence: fast enough that a 4 Hz feed isn't smeared, slow
 *  enough that one late poll doesn't teleport anybody. */
const MIN_LERP_MS = 120;
const MAX_LERP_MS = 2000;
/** Head yaw is clamped relative to the body, like vanilla — past this the body
 *  turns instead of the neck. */
const MAX_HEAD_TURN = 55;
/** Model height in blocks (32 skin pixels). */
const MODEL_HEIGHT = 32 * PIXEL;
/** Below this share of the viewport height a model is a few pixels of noise:
 *  stop drawing it and let the name tag, which never shrinks, carry the player. */
const MIN_MODEL_FRACTION = 0.004;

interface Sample {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** One player's scene presence: the model nodes, its skin, its tag, and the
 *  interpolation state that carries it between snapshots. */
class PlayerModel {
  readonly group = new THREE.Group();
  readonly body = new THREE.Group();
  readonly nodes = new Map<ModelPart['node'], THREE.Object3D>();
  readonly material: THREE.MeshBasicMaterial;
  private geometries: THREE.BufferGeometry[] = [];
  private texture: THREE.Texture;
  private ownedTextures: THREE.Texture[] = [];
  private tag: THREE.Sprite | null = null;
  private tagTexture: THREE.Texture | null = null;
  private tagAspect = 1;
  private tagLabel = '';
  private skinCanvas: HTMLCanvasElement;
  private icon: string | null = null;

  readonly from: Sample;
  readonly to: Sample;
  startMs: number;
  durationMs = MIN_LERP_MS;
  /** Where the model is drawn right now, after interpolation. */
  readonly draw: Sample;
  /** The direction the torso faces, which lags the look direction while
   *  walking — that lag is what makes a player look like they are walking
   *  somewhere rather than sliding. */
  bodyYaw: number;
  /** Accumulated walk cycle, in radians, advanced by distance travelled. */
  limbPhase = 0;
  limbAmount = 0;
  state: PlayerState;
  /** 0..1 fade-in, so a player who joins appears rather than pops. */
  opacity = 0;
  removing = false;

  constructor(player: PlayerState, slim: boolean, doc: Document) {
    this.state = player;
    this.from = sampleOf(player);
    this.to = sampleOf(player);
    this.draw = sampleOf(player);
    this.bodyYaw = player.yaw;
    this.startMs = 0;

    this.skinCanvas = defaultSkinCanvas(player.uuid, doc);
    this.texture = skinTexture(this.skinCanvas);
    this.ownedTextures.push(this.texture);
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      // One material for the base and the outer layer: the outer layer's empty
      // texels are cut away by the alpha test, which is what lets all six nodes
      // share a single material. The threshold is deliberately *low*: the
      // fragment's alpha is the texel's times `material.opacity`, so a 0.5 cut
      // would erase a whole player until they had faded past half — turning
      // every join and every last-known position into a pop.
      alphaTest: 0.04,
      transparent: true,
      // The winding is built face by face (see FACE_CORNERS), so back faces are
      // genuinely inside the model and never need rasterizing.
      side: THREE.FrontSide,
      vertexColors: true,
      depthWrite: true,
    });
    this.material.opacity = 0;

    for (const [node, pivot] of Object.entries(NODE_PIVOTS) as [ModelPart['node'], [number, number, number]][]) {
      const object = new THREE.Group();
      object.position.set(pivot[0] * PIXEL, pivot[1] * PIXEL, pivot[2] * PIXEL);
      this.nodes.set(node, object);
      this.body.add(object);
    }
    for (const part of modelParts(slim)) {
      const geometry = partGeometry(part);
      this.geometries.push(geometry);
      this.nodes.get(part.node)!.add(new THREE.Mesh(geometry, this.material));
    }
    this.group.add(this.body);
  }

  /** The name tag, once one has been built. */
  get tagSprite(): THREE.Sprite | null {
    return this.tag;
  }

  /** This player's face as a data URL, for HTML UI outside the canvas. Built
   *  once per skin — a roster that repeats every second must not re-encode a
   *  PNG per player per second. */
  headIcon(doc: Document): string {
    return (this.icon ??= headIconCanvas(this.skinCanvas, 32, doc).toDataURL('image/png'));
  }

  /** Swap in a real skin once one has loaded. */
  setSkin(canvas: HTMLCanvasElement): void {
    this.skinCanvas = canvas;
    this.icon = null;
    const next = skinTexture(canvas);
    this.ownedTextures.push(next);
    this.material.map = next;
    this.material.needsUpdate = true;
    this.texture = next;
    this.tagLabel = ''; // force the tag to redraw with the real face
  }

  /** Redraw the name tag when the label, the skin, the settings or the
   *  followed state change. */
  syncTag(names: boolean, followed: boolean, doc: Document): void {
    const label = names ? this.state.name : '';
    const key = `${label}|${this.state.stale ? 's' : ''}${this.state.foreign ? 'f' : ''}${followed ? '*' : ''}`;
    if (this.tag && this.tagLabel === key) return;
    this.tagLabel = key;
    const canvas = tagCanvas(this.skinCanvas, label, this.state, followed, doc);
    this.tagAspect = canvas.width / canvas.height;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    if (!this.tag) {
      const material = new THREE.SpriteMaterial({
        map: texture,
        // A tag is a locator, not scenery: it stays legible through terrain,
        // which is the entire point of having one on a 3D map.
        depthTest: false,
        depthWrite: false,
        transparent: true,
        sizeAttenuation: false,
      });
      this.tag = new THREE.Sprite(material);
      this.tag.center.set(0.5, 0);
      this.tag.renderOrder = 1000;
      this.group.add(this.tag);
    } else {
      this.tagTexture?.dispose();
      (this.tag.material as THREE.SpriteMaterial).map = texture;
      (this.tag.material as THREE.SpriteMaterial).needsUpdate = true;
    }
    this.tagTexture = texture;
  }

  /** Size the tag so it covers a fixed fraction of the viewport whatever the
   *  distance — `sizeAttenuation: false` sprites are scaled in units at unit
   *  depth, so the viewport's angular height is the conversion factor. */
  layoutTag(fraction: number, fovHeight: number, scale: number): void {
    if (!this.tag) return;
    const height = fraction * fovHeight;
    this.tag.scale.set(height * this.tagAspect, height, 1);
    this.tag.position.set(0, MODEL_HEIGHT * scale + 0.12, 0);
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries = [];
    for (const texture of this.ownedTextures) texture.dispose();
    this.ownedTextures = [];
    this.material.dispose();
    this.tagTexture?.dispose();
    if (this.tag) (this.tag.material as THREE.SpriteMaterial).dispose();
    this.group.removeFromParent();
  }
}

function sampleOf(p: PlayerState): Sample {
  return { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch };
}

function copySample(into: Sample, from: Sample): void {
  into.x = from.x;
  into.y = from.y;
  into.z = from.z;
  into.yaw = from.yaw;
  into.pitch = from.pitch;
}

function copyPlayerSample(into: Sample, from: PlayerState): void {
  into.x = from.x;
  into.y = from.y;
  into.z = from.z;
  into.yaw = from.yaw;
  into.pitch = from.pitch;
}

function skinTexture(source: TexImageSource): THREE.Texture {
  const texture = new THREE.Texture(source as HTMLCanvasElement);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Nearest magnification keeps the pixel art crisp up close; mipmapped
  // minification stops a 64-pixel skin from crawling when the player is a
  // speck on a zoomed-out map.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Build one cube of the model — base layer plus inflated outer layer — as a
 *  single indexed geometry, so a player costs six draw calls rather than
 *  twelve. */
function partGeometry(part: ModelPart): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  pushBox(positions, uvs, colors, indices, part, 0, part.base);
  pushBox(positions, uvs, colors, indices, part, part.inflate, part.overlay);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  return geometry;
}

/** The four corners of each box face, as seen from outside: top-left,
 *  top-right, bottom-left, bottom-right. Signs multiply the half extents.
 *  Order matches {@link BoxFaces} (`+X, -X, +Y, -Y, +Z, -Z`). */
const FACE_CORNERS: readonly (readonly [number, number, number][])[] = [
  [[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1]], // +X
  [[-1, 1, -1], [-1, 1, 1], [-1, -1, -1], [-1, -1, 1]], // -X
  [[-1, 1, -1], [1, 1, -1], [-1, 1, 1], [1, 1, 1]], // +Y
  [[-1, -1, 1], [1, -1, 1], [-1, -1, -1], [1, -1, -1]], // -Y
  [[-1, 1, 1], [1, 1, 1], [-1, -1, 1], [1, -1, 1]], // +Z
  [[1, 1, -1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1]], // -Z
];

function pushBox(
  positions: number[],
  uvs: number[],
  colors: number[],
  indices: number[],
  part: ModelPart,
  inflate: number,
  origin: readonly [number, number],
): void {
  const [w, h, d] = part.size;
  const faces: BoxFaces = boxFaces(origin[0], origin[1], w, h, d);
  const hx = (w / 2 + inflate) * PIXEL;
  const hy = (h / 2 + inflate) * PIXEL;
  const hz = (d / 2 + inflate) * PIXEL;
  const cx = part.offset[0] * PIXEL;
  const cy = part.offset[1] * PIXEL;
  const cz = part.offset[2] * PIXEL;

  for (let f = 0; f < 6; f++) {
    const base = positions.length / 3;
    const rect = faces[f]!;
    const shade = FACE_SHADE[f]!;
    // Texture v runs bottom-up, skin rows run top-down: hence `1 - y/SIZE`.
    const u0 = rect.x / SKIN_SIZE;
    const u1 = (rect.x + rect.w) / SKIN_SIZE;
    const v0 = 1 - rect.y / SKIN_SIZE;
    const v1 = 1 - (rect.y + rect.h) / SKIN_SIZE;
    const corners = FACE_CORNERS[f]!;
    const cornerUv: readonly [number, number][] = [[u0, v0], [u1, v0], [u0, v1], [u1, v1]];
    for (let c = 0; c < 4; c++) {
      const [sx, sy, sz] = corners[c]!;
      positions.push(cx + sx * hx, cy + sy * hy, cz + sz * hz);
      uvs.push(cornerUv[c]![0], cornerUv[c]![1]);
      colors.push(shade, shade, shade);
    }
    indices.push(base, base + 2, base + 3, base, base + 3, base + 1);
  }
}

/** Draw a player tag: their face, and their name if names are on. Rendered
 *  once per player and re-used until something about them changes. */
function tagCanvas(
  skin: CanvasImageSource,
  label: string,
  player: PlayerState,
  followed: boolean,
  doc: Document,
): HTMLCanvasElement {
  const scale = 2; // drawn at 2× so the sprite stays sharp on hidpi displays
  const height = 26 * scale;
  const pad = 5 * scale;
  const icon = height - pad * 2;
  const font = `${13 * scale}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

  const measure = doc.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const textWidth = label ? Math.ceil(measure.measureText(label).width) : 0;
  const width = pad + icon + (label ? pad * 0.8 + textWidth + pad : pad);

  const canvas = doc.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  g.fillStyle = followed ? 'rgba(16,38,72,0.86)' : player.stale ? 'rgba(10,13,18,0.55)' : 'rgba(10,13,18,0.74)';
  roundRect(g, 0, 0, canvas.width, canvas.height, height / 2);
  g.fill();
  // A ring says something about this player: who the camera is following,
  // who is somewhere else, and whose position is only a memory.
  const ring = followed ? 'rgba(91,155,255,0.95)' : player.foreign ? 'rgba(160,140,255,0.55)' : player.stale ? 'rgba(255,255,255,0.16)' : null;
  if (ring) {
    g.strokeStyle = ring;
    g.lineWidth = (followed ? 1.6 : 1) * scale;
    roundRect(g, 0.8 * scale, 0.8 * scale, canvas.width - 1.6 * scale, canvas.height - 1.6 * scale, height / 2);
    g.stroke();
  }

  g.imageSmoothingEnabled = false;
  const face = boxFaces(0, 0, 8, 8, 8)[4]!;
  const hat = boxFaces(32, 0, 8, 8, 8)[4]!;
  g.save();
  roundRect(g, pad, pad, icon, icon, 3 * scale);
  g.clip();
  g.drawImage(skin, face.x, face.y, face.w, face.h, pad, pad, icon, icon);
  g.drawImage(skin, hat.x, hat.y, hat.w, hat.h, pad, pad, icon, icon);
  g.restore();
  g.imageSmoothingEnabled = true;

  if (label) {
    g.font = font;
    g.textBaseline = 'middle';
    g.fillStyle = player.stale ? 'rgba(230,238,251,0.72)' : '#eef4ff';
    g.fillText(label, pad + icon + pad * 0.8, canvas.height / 2 + 0.5 * scale);
  }
  return canvas;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + radius, y);
  g.arcTo(x + w, y, x + w, y + h, radius);
  g.arcTo(x + w, y + h, x, y + h, radius);
  g.arcTo(x, y + h, x, y, radius);
  g.arcTo(x, y, x + w, y, radius);
  g.closePath();
}

/**
 * The live-players layer.
 *
 * Owns a group in the viewer's scene, one model per player, and the
 * interpolation that carries them between snapshots.
 */
export class PlayerLayer {
  readonly root = new THREE.Group();
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly fetchSkin: ((path: string) => Promise<ArrayBuffer>) | undefined;
  private readonly resolveSkin: ((player: PlayerState) => string | null | undefined) | undefined;
  private readonly models = new Map<string, PlayerModel>();
  /** Skin loads in flight or done, so a roster that repeats every second
   *  doesn't re-fetch a skin every second. */
  private readonly skinRequests = new Set<string>();
  private settings: Required<PlayerSettings>;
  /** Who the camera is following, so their tag can say so. */
  private followed: string | null = null;
  private snapshot: PlayerSnapshot | null = null;
  private lastSnapshotMs = 0;
  private lastFrameMs = 0;
  private tone = 1;
  private disposed = false;

  constructor(options: PlayerLayerOptions) {
    this.scene = options.scene;
    this.camera = options.camera;
    this.fetchSkin = options.fetchSkin;
    this.resolveSkin = options.resolveSkin;
    this.settings = { ...DEFAULTS, ...options.settings };
    this.root.name = 'vantage-players';
    this.root.renderOrder = 5;
    this.scene.add(this.root);
  }

  /** The players the layer is tracking, with their live drawn positions. */
  get players(): PlayerView[] {
    const out: PlayerView[] = [];
    for (const player of this.snapshot?.players ?? []) {
      const model = this.models.get(player.uuid);
      out.push({
        ...player,
        drawX: model?.draw.x ?? player.x,
        drawY: model?.draw.y ?? player.y,
        drawZ: model?.draw.z ?? player.z,
        visible: model !== undefined,
      });
    }
    return out;
  }

  /** A player's face as a data URL, for a list or a tooltip in the DOM. */
  headIcon(uuid: string): string | null {
    return this.models.get(uuid)?.headIcon(document) ?? null;
  }

  /** Where a player is being drawn right now, for the camera to fly to. */
  positionOf(uuid: string): THREE.Vector3 | null {
    const model = this.models.get(uuid);
    return model ? new THREE.Vector3(model.draw.x, model.draw.y, model.draw.z) : null;
  }

  setSettings(settings: PlayerSettings): void {
    this.settings = { ...this.settings, ...settings };
    this.root.visible = this.settings.enabled;
    // Re-apply membership only. Re-running the whole snapshot would restart
    // everyone's interpolation and reset the cadence the next poll is measured
    // against, so toggling a checkbox would visibly stutter the map.
    if (this.snapshot) this.resync();
  }

  /** Mark a player as the one the camera is following (`null` clears it). */
  setFollowed(uuid: string | null): void {
    if (this.followed === uuid) return;
    this.followed = uuid;
    for (const [id, model] of this.models) model.syncTag(this.settings.names, id === uuid, document);
  }

  /** Add or drop models so the scene matches the current roster and settings,
   *  without touching anybody's interpolation. */
  private resync(): void {
    const live = new Set<string>();
    for (const player of this.snapshot?.players ?? []) {
      if (!this.shouldPlace(player)) continue;
      live.add(player.uuid);
      const model = this.models.get(player.uuid) ?? this.spawn(player);
      model.removing = false;
      model.syncTag(this.settings.names, player.uuid === this.followed, document);
    }
    for (const [uuid, model] of this.models) model.removing = !live.has(uuid);
  }

  private spawn(player: PlayerState): PlayerModel {
    const model = new PlayerModel(player, defaultSlim(player.uuid), document);
    model.material.color.setScalar(this.tone);
    this.models.set(player.uuid, model);
    this.root.add(model.group);
    this.loadSkin(player, model);
    return model;
  }

  /** Follow the viewer's exposure so players sit in the same light as the
   *  terrain instead of glowing against a dimmed world. */
  setTone(exposure: number): void {
    this.tone = Math.max(0.15, Math.min(2, exposure));
    for (const model of this.models.values()) model.material.color.setScalar(this.tone);
  }

  /** Take a new roster. Players that are new appear, players that left fade
   *  out, and everyone else gets a fresh interpolation target. */
  setSnapshot(snapshot: PlayerSnapshot, now: number): void {
    if (this.disposed) return;
    const previous = this.snapshot;
    this.snapshot = snapshot;
    // The measured feed cadence is how long the next move should take. A first
    // snapshot has nothing to measure, so it places everyone immediately.
    const cadence = previous && this.lastSnapshotMs ? now - this.lastSnapshotMs : 0;
    this.lastSnapshotMs = now;

    const live = new Set<string>();
    for (const player of snapshot.players) {
      if (!this.shouldPlace(player)) continue;
      live.add(player.uuid);
      const model = this.models.get(player.uuid) ?? this.spawn(player);
      model.state = player;
      model.removing = false;
      // Interpolate from wherever the model actually is, not from the last
      // sample: a snapshot that lands mid-move must not rewind it. Written in
      // place — a roster arrives every second, and allocating two objects per
      // player per second is garbage the collector has to chase for nothing.
      copySample(model.from, model.draw);
      copyPlayerSample(model.to, player);
      model.startMs = now;
      model.durationMs = Math.max(MIN_LERP_MS, Math.min(MAX_LERP_MS, cadence || MIN_LERP_MS));
      model.syncTag(this.settings.names, player.uuid === this.followed, document);
    }
    for (const [uuid, model] of this.models) {
      if (!live.has(uuid)) model.removing = true;
    }
  }

  /** Whether a player belongs on the map itself (as opposed to merely in the
   *  list): foreign coordinates mean something else, and last-known positions
   *  are opt-out. */
  private shouldPlace(player: PlayerState): boolean {
    if (player.foreign && !this.settings.foreign) return false;
    if (player.stale && !this.settings.offline) return false;
    return true;
  }

  /**
   * Advance every model to `now`.
   *
   * Returns whether anything moved, which the viewer's render-on-demand loop
   * uses to decide whether this frame is worth drawing — a map of standing
   * players costs nothing, and one walking player wakes the loop.
   */
  update(now: number): boolean {
    if (this.disposed || !this.settings.enabled || this.models.size === 0) return false;
    const dt = this.lastFrameMs ? Math.min(0.25, (now - this.lastFrameMs) / 1000) : 0;
    this.lastFrameMs = now;
    let moved = false;

    // Vertical angular size of the viewport at unit depth: the conversion
    // between "fraction of the screen" and sprite scale.
    const fovHeight = 2 * Math.tan((this.camera.fov * Math.PI) / 360);
    const scale = this.settings.scale;

    for (const [uuid, model] of this.models) {
      const alpha = model.durationMs > 0 ? Math.min(1, (now - model.startMs) / model.durationMs) : 1;
      const previousX = model.draw.x;
      const previousZ = model.draw.z;
      // Position is linear: a player walking a straight line should cross it at
      // a steady speed, not ease in and out of every sample.
      model.draw.x = model.from.x + (model.to.x - model.from.x) * alpha;
      model.draw.y = model.from.y + (model.to.y - model.from.y) * alpha;
      model.draw.z = model.from.z + (model.to.z - model.from.z) * alpha;
      // Angles ease, and take the short way around the seam.
      const turn = 1 - Math.exp(-dt * 9);
      model.draw.yaw += angleDelta(model.draw.yaw, model.to.yaw) * turn;
      model.draw.pitch += (model.to.pitch - model.draw.pitch) * turn;

      const stepX = model.draw.x - previousX;
      const stepZ = model.draw.z - previousZ;
      const speed = dt > 0 ? Math.hypot(stepX, stepZ) / dt : 0;
      if (speed > 0.05) {
        // Walking: the torso turns toward the direction of travel while the
        // head keeps looking where the player is looking.
        const heading = -(Math.atan2(stepX, stepZ) * 180) / Math.PI;
        model.bodyYaw += angleDelta(model.bodyYaw, heading) * (1 - Math.exp(-dt * 6));
      } else {
        model.bodyYaw += angleDelta(model.bodyYaw, model.draw.yaw) * (1 - Math.exp(-dt * 5));
      }
      const targetSwing = model.state.stale ? 0 : Math.min(1, speed / WALK_SPEED);
      model.limbAmount += (targetSwing - model.limbAmount) * (1 - Math.exp(-dt * 8));
      model.limbPhase += speed * dt * 2.2;

      model.group.position.set(model.draw.x, model.draw.y, model.draw.z);
      model.group.scale.setScalar(scale);
      model.body.rotation.y = (-model.bodyYaw * Math.PI) / 180;

      const head = model.nodes.get('head')!;
      head.rotation.x = (model.draw.pitch * Math.PI) / 180;
      head.rotation.y = (-clamp(angleDelta(model.bodyYaw, model.draw.yaw), -MAX_HEAD_TURN, MAX_HEAD_TURN) * Math.PI) / 180;

      const swing = Math.sin(model.limbPhase) * model.limbAmount * 0.85;
      model.nodes.get('rightLeg')!.rotation.x = swing;
      model.nodes.get('leftLeg')!.rotation.x = -swing;
      model.nodes.get('rightArm')!.rotation.x = -swing * 0.8;
      model.nodes.get('leftArm')!.rotation.x = swing * 0.8;

      model.layoutTag(this.settings.tagSize, fovHeight, scale);

      // Six draw calls per player buy nothing once a player is smaller than a
      // few pixels — from a whole-world view the tag is the only thing anyone
      // can actually see. Screen height falls straight out of the same
      // projection the tag is sized with, so this needs no viewport size.
      const eye = this.camera.position;
      const distance = Math.hypot(eye.x - model.draw.x, eye.y - model.draw.y, eye.z - model.draw.z);
      const screenFraction = distance > 0 ? (MODEL_HEIGHT * scale) / (fovHeight * distance) : 1;
      model.body.visible = screenFraction > MIN_MODEL_FRACTION;

      // Fade: joining players appear, leaving players dissolve, and a
      // last-known position is drawn faint because that is what it is.
      const target = model.removing ? 0 : model.state.stale ? 0.55 : 1;
      if (Math.abs(model.opacity - target) > 0.002) {
        model.opacity += (target - model.opacity) * (1 - Math.exp(-dt * 7));
        moved = true;
      } else {
        model.opacity = target;
      }
      model.material.opacity = model.opacity;
      if (model.tagSprite) model.tagSprite.material.opacity = model.opacity;

      if (model.removing && model.opacity <= 0.01) {
        model.dispose();
        this.models.delete(uuid);
        moved = true;
        continue;
      }
      if (alpha < 1 || speed > 0.001 || model.limbAmount > 0.01) moved = true;
    }
    return moved;
  }

  dispose(): void {
    this.disposed = true;
    for (const model of this.models.values()) model.dispose();
    this.models.clear();
    this.skinRequests.clear();
    this.root.removeFromParent();
  }

  /** Load a player's real skin, if there is one to load. Failures are silent:
   *  the procedural skin the model already has is a perfectly good fallback. */
  private loadSkin(player: PlayerState, model: PlayerModel): void {
    const key = player.uuid;
    if (this.skinRequests.has(key)) return;
    const url = this.resolveSkin?.(player);
    const path = player.skin;
    if (!url && !(path && this.fetchSkin)) return;
    this.skinRequests.add(key);
    void (async () => {
      try {
        const blob = url
          ? await (await fetch(url, { credentials: 'omit', mode: 'cors' })).blob()
          : new Blob([await this.fetchSkin!(path!)], { type: 'image/png' });
        const bitmap = await createImageBitmap(blob);
        if (this.disposed || !this.models.has(key)) return;
        model.setSkin(normalizeSkin(bitmap, bitmap.width, bitmap.height, document));
        model.syncTag(this.settings.names, key === this.followed, document);
      } catch {
        /* the default skin stands */
      }
    })();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
