// Map navigation controls, reimplemented faithfully from BlueMap's map controls
// (BlueMap-Minecraft/BlueMap, `common/webapp/src/js/controls/map`). Unlike
// three.js Orbit/MapControls, the camera is never driven directly: the controls
// own a small state model — a look-at `position` (pivot), a `distance` (the
// zoom), an azimuth `rotation`, and a top-down-relative `angle` (pitch) — and
// derive the camera transform from it every frame.
//
// Every motion runs through the same inertia model: pointer/key input is summed
// into a per-motion buffer; each frame a fraction `smoothing` of the buffer is
// applied to the state and the remainder decays. With no fresh input the leftover
// buffer keeps applying and decaying, so releases glide to a stop — the momentum
// that makes BlueMap feel good. Tilt is clamped to a zoom-dependent maximum, so
// the view auto-flattens to top-down as you zoom out, and tilting in pulls the
// camera closer (a coupled dolly). An optional terrain-height sampler lets the
// pivot ride the surface so panning a tilted view stays "on" the ground.

import * as THREE from 'three';

const HALF_PI = Math.PI * 0.5;
const HALF_PI_DIV = 1 / HALF_PI;
const VEC2_ZERO = new THREE.Vector2(0, 0);

/** A terrain-height lookup: world surface Y at (x, z), or `null` off the map. */
export type HeightSampler = (x: number, z: number) => number | null;

export interface MapControlsOptions {
  /** Closest the camera may dolly to the pivot. Default `4`. */
  minDistance?: number;
  /** Farthest the camera may dolly out. Default `100000`. */
  maxDistance?: number;
}

type Listener = () => void;

/** clamp helper (avoids importing three's MathUtils for one call). */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// BlueMap's springy bounds: instead of a hard clamp, pull a fraction `k` toward
// the bound each frame so corrections ease in rather than snap.
function softMin(v: number, min: number, k: number): number {
  return v >= min ? v : v + (min - v) * k;
}
function softMax(v: number, max: number, k: number): number {
  return v <= max ? v : v - (v - max) * k;
}
function softClamp(v: number, min: number, max: number, k: number): number {
  return softMax(softMin(v, min, k), max, k);
}
function softSet(v: number, target: number, k: number): number {
  return softClamp(v, target, target, k);
}

export class MapControls {
  readonly camera: THREE.PerspectiveCamera;
  readonly domElement: HTMLElement;

  // --- the state model -------------------------------------------------------
  /** The look-at pivot in world space (camera orbits and zooms about this). */
  readonly position = new THREE.Vector3();
  /** Camera-to-pivot distance: this IS the zoom level. */
  distance = 300;
  /** Azimuth in radians; 0 looks toward −Z (north). Wrapped to [−π, π]. */
  rotation = 0;
  /** Pitch in radians; 0 = straight top-down, π/2 = horizon. */
  angle = 0;

  // --- bounds & wiring -------------------------------------------------------
  minDistance: number;
  maxDistance: number;
  /** Optional terrain sampler; when set the pivot rides the surface. */
  heightAt: HeightSampler | null = null;
  /** Pivot Y the view relaxes toward when zoomed far out (set by the framer). */
  floorY = 0;
  /** Master enable. */
  enabled = true;

  // --- input buffers (summed by events, drained by `update`) -----------------
  private readonly panBuf = new THREE.Vector2();
  private rotBuf = 0;
  private angleBuf = 0;
  private zoomBuf = 0;

  // Pointer-drag bookkeeping.
  private readonly pointers = new Map<number, THREE.Vector2>();
  private lastPan = new THREE.Vector2();
  private lastOrbit = new THREE.Vector2();
  private orbiting = false; // right-drag / alt-left-drag is rotating+tilting
  private panning = false; // left-drag is moving the pivot
  private startDistance = 0; // dolly at orbit start, for the coupled tilt↔zoom
  private dynamicDistance = false; // tilt pulls the camera in (only when close)
  private moved = false; // any drag actually moved (vs. a click) — for tap detect
  private downPos = new THREE.Vector2();

  // Two-finger touch pinch/rotate bookkeeping.
  private touchDist = 0;
  private touchAngle = 0;

  private readonly keys = new Set<string>();

  // dt smoothing (BlueMap clamps spikes and EMAs the frame time).
  private avgDt = 16;

  // Terrain-follow state (BlueMap's MapHeightControls), temporally smoothed: the
  // surface height under the pivot, and the surface height under the camera (for
  // the min-camera-height clearance term).
  private targetHeight = 0;
  private cameraHeight = 0;

  // An optional eased target (compass "reset north", zoom buttons, home), drained
  // each frame and cleared on any fresh user input.
  private goal: { position?: THREE.Vector3; distance?: number; rotation?: number; angle?: number } | null = null;

  private readonly listeners: Record<string, Set<Listener>> = {
    start: new Set(),
    end: new Set(),
    change: new Set(),
  };

  // Bound handlers, kept for removal in dispose().
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onWheel: (e: WheelEvent) => void;
  private readonly onContextMenu: (e: Event) => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;
  private readonly onBlur: () => void;

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement, options: MapControlsOptions = {}) {
    this.camera = camera;
    this.domElement = domElement;
    this.minDistance = options.minDistance ?? 4;
    this.maxDistance = options.maxDistance ?? 100000;

    this.onPointerDown = (e) => this.pointerDown(e);
    this.onPointerMove = (e) => this.pointerMove(e);
    this.onPointerUp = (e) => this.pointerUp(e);
    this.onWheel = (e) => this.wheel(e);
    this.onContextMenu = (e) => e.preventDefault();
    this.onKeyDown = (e) => this.keyDown(e);
    this.onKeyUp = (e) => this.keyUp(e);
    this.onBlur = () => {
      this.keys.clear();
      this.pointers.clear();
      this.endDrag();
    };

    const dom = domElement;
    dom.style.touchAction = 'none';
    dom.addEventListener('pointerdown', this.onPointerDown);
    // move/up on window so a drag that leaves the canvas still tracks.
    window.addEventListener('pointermove', this.onPointerMove, { passive: false });
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);

    this.updateCamera();
  }

  // --- public API ------------------------------------------------------------

  addEventListener(type: 'start' | 'end' | 'change', fn: Listener): void {
    this.listeners[type]?.add(fn);
  }
  removeEventListener(type: 'start' | 'end' | 'change', fn: Listener): void {
    this.listeners[type]?.delete(fn);
  }
  private emit(type: 'start' | 'end' | 'change'): void {
    for (const fn of this.listeners[type]!) fn();
  }

  /** Compatibility alias: the look-at pivot (some callers still read `.target`). */
  get target(): THREE.Vector3 {
    return this.position;
  }

  /** True while a drag (pan or orbit) is in progress. */
  get isInteracting(): boolean {
    return this.panning || this.orbiting;
  }

  /** Smoothly zoom by `steps` notches (positive = in, negative = out) — the same
   *  unit as a wheel notch, so the zoom buttons match scrolling. */
  zoom(steps: number): void {
    this.zoomBuf -= steps; // +zoomBuf = zoom out, so invert for an "in is positive" API
    this.dynamicDistance = false;
    this.goal = null;
  }

  /** Ease the view toward a partial target state (rotation/angle/distance/pivot),
   *  e.g. compass→north or a home re-frame. Cancelled by any drag, key, or wheel. */
  animateTo(goal: { position?: THREE.Vector3; distance?: number; rotation?: number; angle?: number }): void {
    this.goal = {
      ...goal,
      position: goal.position ? goal.position.clone() : undefined,
    };
  }

  /** Jump the view to an explicit state and stop all motion (used for framing).
   *  `angle`/`distance` are clamped to the legal tilt envelope. */
  setView(state: { position: THREE.Vector3; distance: number; rotation: number; angle: number; floorY?: number }): void {
    this.position.copy(state.position);
    this.distance = clamp(state.distance, this.minDistance, this.maxDistance);
    this.rotation = state.rotation;
    this.angle = clamp(state.angle, 0, this.maxAngleForDistance(this.distance));
    if (state.floorY !== undefined) this.floorY = state.floorY;
    // Seed the terrain-follow so the framing doesn't settle on the first frames.
    this.targetHeight = this.position.y;
    this.cameraHeight = this.position.y;
    this.panBuf.set(0, 0);
    this.rotBuf = this.angleBuf = this.zoomBuf = 0;
    this.updateCamera();
  }

  /** Advance the simulation by `deltaMs` and update the camera. Returns whether
   *  anything moved this frame. */
  update(deltaMs: number): boolean {
    // Clamp lag spikes (min 20 UPS) and EMA the frame time, exactly as BlueMap,
    // so smoothing stays stable through jank.
    const dt = deltaMs > 50 ? 50 : deltaMs <= 0 ? 16 : deltaMs;
    this.avgDt = this.avgDt * 0.9 + dt * 0.1;
    const d = this.avgDt;

    const before = this.changeKey();

    this.feedKeys(d);
    this.applyPan(d);
    this.applyRotate(d);
    this.applyAngle(d);
    this.applyZoom(d);
    this.applyDynamicDistance();
    this.applyGoal(d);
    this.applyBounds();
    this.applyHeight(d);

    this.updateCamera();
    const changed = this.changeKey() !== before;
    if (changed) this.emit('change');
    return changed;
  }

  dispose(): void {
    const dom = this.domElement;
    dom.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    dom.removeEventListener('wheel', this.onWheel);
    dom.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    for (const set of Object.values(this.listeners)) set.clear();
  }

  // --- per-frame smoothing factor --------------------------------------------

  /** BlueMap's smoothing: `stiffness` is the per-frame lerp at 60fps, scaled by
   *  the (averaged) frame time so feel is frame-rate independent. */
  private smoothing(stiffness: number, dt: number): number {
    return clamp(stiffness / (16.666 / dt), 0, 1);
  }

  /** Max tilt (radians from top-down) allowed at a dolly distance — BlueMap's
   *  curve, but scaled to *this* world's zoom range: full tilt up close, eased to
   *  a flat top-down exactly at `maxDistance`. (BlueMap hardcodes the flatten
   *  point at ~2005 blocks, which our smaller windows never reach, so zooming out
   *  could never level the view — the scaling fixes that.) */
  private maxAngleForDistance(distance: number): number {
    const span = Math.max(this.maxDistance - this.minDistance, 1);
    const t = clamp((distance - this.minDistance) / span, 0, 1);
    return clamp((1 - Math.sqrt(t)) * HALF_PI, 0, HALF_PI);
  }

  /** Inverse: the farthest distance at which `angle` is still a legal tilt. */
  private maxDistanceForAngle(angle: number): number {
    const t = Math.pow(clamp(1 - angle * HALF_PI_DIV, 0, 1), 2);
    return this.minDistance + t * (this.maxDistance - this.minDistance);
  }

  // --- motion application (drains the buffers) -------------------------------

  private applyPan(dt: number): void {
    if (this.panBuf.lengthSq() < 1e-8) {
      this.panBuf.set(0, 0);
      return;
    }
    const s = this.smoothing(0.3, dt);
    const h = this.domElement.clientHeight || 1;
    const dir = this.panBuf.clone().rotateAround(VEC2_ZERO, this.rotation);
    // speed 1.5; both pixel multipliers reduce to 1/height (aspect cancels), so
    // motion is normalized to a fraction of screen height and scaled by zoom.
    const f = (s * this.distance * 1.5) / h;
    this.position.x += dir.x * f;
    this.position.z += dir.y * f;
    this.panBuf.multiplyScalar(1 - s);
  }

  private applyRotate(dt: number): void {
    if (this.rotBuf === 0) return;
    const s = this.smoothing(0.3, dt);
    const w = this.domElement.clientWidth || 1;
    this.rotation += (this.rotBuf * s * 6) / w; // speed 6
    this.rotBuf *= 1 - s;
    if (Math.abs(this.rotBuf) < 1e-4) this.rotBuf = 0;
  }

  private applyAngle(dt: number): void {
    if (this.angleBuf === 0) return;
    const s = this.smoothing(0.3, dt);
    const h = this.domElement.clientHeight || 1;
    this.angle += (this.angleBuf * s * 3) / h; // speed 3
    this.angleBuf *= 1 - s;
    if (Math.abs(this.angleBuf) < 1e-4) this.angleBuf = 0;
  }

  private applyZoom(dt: number): void {
    if (this.zoomBuf === 0) return;
    const s = this.smoothing(0.2, dt);
    this.distance *= Math.pow(1.5, this.zoomBuf * s); // speed 1, multiplicative
    this.angle = Math.min(this.angle, this.maxAngleForDistance(this.distance));
    this.zoomBuf *= 1 - s;
    if (Math.abs(this.zoomBuf) < 1e-4) this.zoomBuf = 0;
  }

  /** While orbiting from a close-in view, tilting toward the horizon also dollies
   *  the camera in so the requested tilt becomes legal — BlueMap's coupled
   *  dolly+pitch. A wheel event cancels it (you asked for a specific distance). */
  private applyDynamicDistance(): void {
    if (!this.orbiting || !this.dynamicDistance) return;
    let target = Math.min(this.startDistance, this.maxDistanceForAngle(this.angle));
    target = Math.max(target, this.minDistance);
    this.distance = softSet(this.distance, target, 0.4);
    this.angle = softMax(this.angle, this.maxAngleForDistance(target), 0.8);
  }

  /** Ease toward an animation goal (frame-rate-normalized), clearing it once the
   *  view has settled close enough. */
  private applyGoal(dt: number): void {
    if (!this.goal) return;
    const k = clamp(0.12 * (dt / 16.666), 0, 1);
    const g = this.goal;
    let done = true;
    if (g.rotation !== undefined) {
      let dr = g.rotation - this.rotation;
      if (dr > Math.PI) dr -= 2 * Math.PI;
      else if (dr < -Math.PI) dr += 2 * Math.PI;
      this.rotation += dr * k;
      if (Math.abs(dr) > 0.003) done = false;
    }
    if (g.angle !== undefined) {
      this.angle += (g.angle - this.angle) * k;
      if (Math.abs(g.angle - this.angle) > 0.003) done = false;
    }
    if (g.distance !== undefined) {
      this.distance += (g.distance - this.distance) * k;
      if (Math.abs(g.distance - this.distance) > this.distance * 0.004) done = false;
    }
    if (g.position) {
      this.position.lerp(g.position, k);
      if (this.position.distanceToSquared(g.position) > 0.04) done = false;
    }
    if (done) this.goal = null;
  }

  private applyBounds(): void {
    this.distance = softClamp(this.distance, this.minDistance, this.maxDistance, 0.8);
    this.angle = softClamp(this.angle, 0, HALF_PI, 0.8);
    this.angle = softMax(this.angle, this.maxAngleForDistance(this.distance), 0.8);
    // wrap azimuth to [-π, π]
    if (this.rotation > Math.PI) this.rotation -= 2 * Math.PI;
    else if (this.rotation < -Math.PI) this.rotation += 2 * Math.PI;
  }

  /** Keep the orbit pivot on the terrain surface so the view rotates and tilts
   *  about the ground under the screen centre — modelled on BlueMap's
   *  MapHeightControls, adapted to our (small, finite) world.
   *
   *  The pivot Y rides the single-column surface height + 3, temporally smoothed
   *  (so panning over uneven ground glides, doesn't bob). A `minCameraHeight`
   *  term lifts the pivot just enough that the orbiting camera clears the terrain
   *  it hovers over at steep tilt (no dipping below ground / staring into the
   *  void). BlueMap also relaxes the pivot toward y=0 by `distance/500`; we drop
   *  that — calibrated for 1500-block default zoom on huge worlds, at our zoom
   *  range it sank the pivot well below the surface right where you tilt. Riding
   *  the surface is harmless zoomed out, where the view is forced near top-down
   *  (insensitive to pivot Y). */
  private applyHeight(dt: number): void {
    if (!this.heightAt) return;

    // Pivot's terrain target: single surface column + 3, eased (stiffness 0.15).
    const ts = clamp(0.15 * (dt / 16.666), 0, 1);
    const hp = this.heightAt(this.position.x, this.position.z);
    const targetTerrain = (hp === null ? this.floorY : hp) + 3;
    this.targetHeight += (targetTerrain - this.targetHeight) * ts;
    if (Math.abs(targetTerrain - this.targetHeight) < 0.01) this.targetHeight = targetTerrain;

    let suggested = this.targetHeight;

    // Camera clearance: only meaningful where a real tilt is allowed. Keep the
    // camera ~1 above the terrain under it by raising the pivot if needed.
    const maxAngle = this.maxAngleForDistance(this.distance);
    if (maxAngle >= 0.1) {
      const cs = clamp(0.2 * (dt / 16.666), 0, 1);
      const hc = this.heightAt(this.camera.position.x, this.camera.position.z);
      const cameraTerrain = hc === null ? this.floorY : hc;
      this.cameraHeight += (cameraTerrain - this.cameraHeight) * cs;
      const maxAngleHeight = Math.cos(maxAngle) * this.distance; // pivot→camera rise at max tilt
      const minCameraHeight = this.cameraHeight - maxAngleHeight + 1;
      suggested = Math.max(suggested, minCameraHeight);
    }

    this.position.y = suggested;
  }

  // --- keyboard integration --------------------------------------------------

  /** Translate held keys into the same input buffers the mouse fills, in
   *  pixel-equivalent units scaled by frame time. Holding a key tops the buffer
   *  up to a steady velocity; releasing lets it decay, so key moves glide and
   *  feel identical to a drag — no separate code path. */
  private feedKeys(dt: number): void {
    if (this.keys.size === 0) return;
    this.goal = null; // user is driving
    const k = this.keys;
    const fr = dt / 16.666; // frame-rate normalizer
    const boost = k.has('shift') ? 2.4 : 1;

    const fwd = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
    const strafe = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    if (fwd || strafe) {
      const px = 9 * fr * boost; // px-equivalent per frame
      this.panBuf.x += strafe * px;
      this.panBuf.y += -fwd * px; // forward = up the screen
    }
    const rot = (k.has('e') ? 1 : 0) - (k.has('q') ? 1 : 0);
    if (rot) this.rotBuf += rot * 7 * fr;
    const tilt = (k.has('r') ? 1 : 0) - (k.has('f') ? 1 : 0);
    if (tilt) this.angleBuf += tilt * 6 * fr;
    const zoom = (k.has('-') || k.has('_') ? 1 : 0) - (k.has('=') || k.has('+') ? 1 : 0);
    if (zoom) this.zoomBuf += zoom * 0.08 * fr;
  }

  // --- camera derivation -----------------------------------------------------

  private updateCamera(): void {
    // Place the camera on the orbit: a horizontal bearing from `rotation`, lifted
    // toward vertical by (π/2 − angle), at `distance` from the pivot.
    const rv = new THREE.Vector3(Math.sin(this.rotation), 0, -Math.cos(this.rotation));
    const axis = new THREE.Vector3(0, 1, 0).cross(rv).normalize();
    rv.applyAxisAngle(axis, HALF_PI - this.angle);
    rv.multiplyScalar(this.distance);
    this.camera.position.copy(this.position).sub(rv);
    // Orient by explicit yaw (azimuth) + pitch rather than lookAt(up=+Y). Roll is
    // always 0 so the horizon stays level, and — unlike lookAt — this stays
    // well-defined looking straight down (angle 0), where up would be parallel to
    // the view direction. So a clean top-down works and azimuth still spins the
    // map when flat. yaw = −rotation puts bearing 0 at −Z; pitch = angle − π/2
    // tips from horizon (0) to straight down (−π/2).
    this.camera.rotation.set(this.angle - HALF_PI, -this.rotation, 0, 'YXZ');
  }

  /** A cheap scalar that changes iff the view changed (skips redundant emits). */
  private changeKey(): number {
    return this.position.x + this.position.y * 1.1 + this.position.z * 1.3 + this.distance * 2.7 + this.rotation * 5.1 + this.angle * 7.3;
  }

  // --- pointer input ---------------------------------------------------------

  private localXY(e: PointerEvent): THREE.Vector2 {
    const rect = this.domElement.getBoundingClientRect();
    return new THREE.Vector2(e.clientX - rect.left, e.clientY - rect.top);
  }

  private pointerDown(e: PointerEvent): void {
    if (!this.enabled) return;
    this.goal = null; // user took over
    const p = this.localXY(e);
    this.pointers.set(e.pointerId, p);
    this.downPos.copy(p);
    this.moved = false;

    if (this.pointers.size === 1) {
      // Left = pan; right or alt/ctrl+left = orbit (rotate + tilt).
      const orbit = e.button === 2 || e.altKey || e.ctrlKey || e.metaKey;
      if (orbit) {
        this.beginOrbit(p);
      } else if (e.button === 0 || e.pointerType !== 'mouse') {
        this.panning = true;
        this.lastPan.copy(p);
      }
      this.emit('start');
    } else if (this.pointers.size === 2) {
      // Second finger: switch to pinch-zoom + twist-rotate.
      this.panning = false;
      this.orbiting = false;
      const [a, b] = [...this.pointers.values()];
      this.touchDist = a!.distanceTo(b!);
      this.touchAngle = Math.atan2(b!.y - a!.y, b!.x - a!.x);
    }
    try {
      this.domElement.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
  }

  private beginOrbit(p: THREE.Vector2): void {
    this.orbiting = true;
    this.lastOrbit.copy(p);
    this.startDistance = this.distance;
    this.dynamicDistance = this.distance < 1000;
  }

  private pointerMove(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.localXY(e);
    const prev = this.pointers.get(e.pointerId)!;

    if (this.pointers.size >= 2) {
      this.pointers.set(e.pointerId, p);
      this.pinch();
      return;
    }

    if (p.distanceToSquared(this.downPos) > 9) this.moved = true;

    if (this.panning) {
      // Sum the negated pixel delta — grabbing the world under the cursor.
      this.panBuf.x += this.lastPan.x - p.x;
      this.panBuf.y += this.lastPan.y - p.y;
      this.lastPan.copy(p);
    } else if (this.orbiting) {
      this.rotBuf += p.x - this.lastOrbit.x; // horizontal → azimuth
      this.angleBuf -= p.y - this.lastOrbit.y; // vertical (up) → more tilt
      this.lastOrbit.copy(p);
    }
    this.pointers.set(e.pointerId, p);
    e.preventDefault();
  }

  /** Two-finger pinch (zoom) + twist (rotate). */
  private pinch(): void {
    const [a, b] = [...this.pointers.values()];
    const dist = a!.distanceTo(b!);
    const ang = Math.atan2(b!.y - a!.y, b!.x - a!.x);
    if (this.touchDist > 0) {
      this.zoomBuf += (this.touchDist - dist) * 0.01; // spread fingers → zoom in
      let dA = ang - this.touchAngle;
      if (dA > Math.PI) dA -= 2 * Math.PI;
      else if (dA < -Math.PI) dA += 2 * Math.PI;
      this.rotation -= dA;
    }
    this.touchDist = dist;
    this.touchAngle = ang;
  }

  private pointerUp(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    try {
      this.domElement.releasePointerCapture?.(e.pointerId);
    } catch {
      /* best-effort */
    }
    if (this.pointers.size === 0) this.endDrag();
    else if (this.pointers.size === 1) {
      // Dropped from pinch to one finger: resume panning with it.
      const [only] = [...this.pointers.values()];
      this.panning = true;
      this.lastPan.copy(only!);
    }
  }

  private endDrag(): void {
    const was = this.panning || this.orbiting;
    this.panning = false;
    this.orbiting = false;
    this.dynamicDistance = false;
    if (was) this.emit('end');
  }

  private wheel(e: WheelEvent): void {
    if (!this.enabled) return;
    e.preventDefault();
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16; // lines → ~pixels
    else if (e.deltaMode === 2) delta *= 100; // pages
    this.zoomBuf += delta * 0.01; // +deltaY (scroll down) → zoom out
    this.dynamicDistance = false; // explicit distance request
    this.goal = null;
  }

  // --- keyboard input --------------------------------------------------------

  private static readonly MOVE_KEYS = new Set([
    'w', 'a', 's', 'd', 'q', 'e', 'r', 'f', 'shift',
    'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
    '-', '_', '=', '+',
  ]);

  private isTyping(): boolean {
    const el = document.activeElement as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  private keyDown(e: KeyboardEvent): void {
    if (!this.enabled || e.metaKey || e.ctrlKey || e.altKey || this.isTyping()) return;
    const k = e.key.toLowerCase();
    if (MapControls.MOVE_KEYS.has(k)) {
      this.keys.add(k);
      if (k !== 'shift') e.preventDefault(); // don't scroll the page on arrows/space
    }
  }

  private keyUp(e: KeyboardEvent): void {
    this.keys.delete(e.key.toLowerCase());
  }
}
