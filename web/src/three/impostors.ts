// Map memory for streamed worlds without a baked lowres pyramid (live bakes,
// `vantage server`): when a rendered tile is about to be evicted, its meshes
// are snapshotted top-down into one shared atlas render-target and replaced by
// a small textured heightfield impostor (~16 KB of atlas at 64 px + ~600 B of
// heights). Impostors persist far beyond the streaming ring, so everywhere the
// camera has BEEN stays on the map — zooming out shows the world you explored
// instead of a void — while the client's memory stays bounded: one fixed
// atlas, farthest-first slot reuse.
//
// Seam discipline (fidelity boundaries are where coarse layers go to die):
// impostors sit at TRUE surface height and rely on a polygon depth offset —
// not a geometric dip — to lose the depth test against coexisting hires, so
// the live disc never reads as raised above its remembered surroundings.
// Shared edges are STITCHED: a landing snapshot averages its rim with any
// impostor neighbour (both sides rebuilt to the exact same values) and adopts
// a live hires neighbour's real surface heights, so tile boundaries meet
// instead of tearing. Skirts catch what stitching can't (world edges,
// missing neighbours).
//
// This is deliberately client-side. The server streams exactly what it does
// today; what to remember, at what resolution, and how much memory to spend is
// the viewer's quality setting.

import * as THREE from 'three';
import { tileKey, type SurfaceMap } from '../core/index.js';
import { isSharedQuadIndex } from './terrain.js';

/** Impostor heightfield resolution per tile edge (cells; +1 sample apron). */
const GRID = 16;
/** Atlas slots per edge — capacity is its square (1024 remembered tiles). */
const SLOTS = 32;
/** Pending captures beyond this are dropped oldest-first (pan storms). */
const MAX_QUEUE = 12;
/** Rim skirt drop, in blocks — the backstop for unstitched boundaries. */
const SKIRT = 12;

/** The tile meshes an eviction hands over for snapshotting. The layer renders
 *  them once, then disposes them exactly like TileManager would have. */
export interface CaptureMeshes {
  terrain?: THREE.Mesh;
  terrainLm?: THREE.Mesh;
  water?: THREE.Mesh;
  lightmapTex?: THREE.DataTexture;
}

interface Pending {
  key: string;
  tileX: number;
  tileZ: number;
  meshes: CaptureMeshes;
  surface: SurfaceMap;
  minY: number;
  maxY: number;
}

interface Impostor {
  key: string;
  tileX: number;
  tileZ: number;
  slot: number;
  mesh: THREE.Mesh;
  /** (GRID+1)² surface heights — mutable: edge stitching adjusts the rim as
   *  neighbours land. Also feeds the zoomed-out pivot fallback. */
  heights: Int16Array;
  originX: number;
  originZ: number;
  /** Tile centre, for farthest-first slot reuse. */
  cx: number;
  cz: number;
}

/** The four stitchable edges, as (dx,dz) toward the neighbour. */
const EDGES: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Dispose a captured tile's GPU resources the way TileManager does: detach
 *  the shared quad index first (dispose() would delete the shared buffer). */
function disposeCapture(meshes: CaptureMeshes): void {
  for (const mesh of [meshes.terrain, meshes.terrainLm, meshes.water]) {
    if (!mesh) continue;
    mesh.removeFromParent();
    if (isSharedQuadIndex(mesh.geometry.index)) mesh.geometry.setIndex(null);
    mesh.geometry.dispose();
  }
  meshes.lightmapTex?.dispose();
}

export class ImpostorLayer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly tileBlocks: number;
  private readonly resolution: number;
  private readonly rt: THREE.WebGLRenderTarget;
  private readonly material: THREE.ShaderMaterial;
  /** The shared terrain material — captures neutralize its grade/fog/clip
   *  uniforms for one render, and the impostor material re-applies the live
   *  values every frame, so display tuning keeps tracking remembered tiles. */
  private readonly terrain: THREE.ShaderMaterial;
  /** Surface map of a still-resident hires tile, when the manager has one —
   *  lets a landing snapshot stitch its rim to the LIVE terrain it borders. */
  private readonly liveSurface: (key: string) => SurfaceMap | undefined;
  private readonly captureScene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera();
  private readonly queue: Pending[] = [];
  private readonly byKey = new Map<string, Impostor>();
  private readonly freeSlots: number[] = [];
  private retired = false;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    terrainMaterial: THREE.ShaderMaterial,
    tileBlocks: number,
    resolution: number,
    liveSurface: (key: string) => SurfaceMap | undefined = () => undefined,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.terrain = terrainMaterial;
    this.tileBlocks = tileBlocks;
    this.resolution = resolution;
    this.liveSurface = liveSurface;
    for (let i = SLOTS * SLOTS - 1; i >= 0; i--) this.freeSlots.push(i);

    const size = SLOTS * resolution;
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RGBAFormat,
      // Mipmaps keep far-zoom minification calm; regenerated by three after
      // each capture render. The shader clamps its sampling LOD so slots
      // never blend into each other (see uMaxLod).
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });
    this.camera.up.set(0, 0, -1); // north up — matches the map's texture V

    const t = terrainMaterial.uniforms;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uMap: { value: this.rt.texture },
        uAtlasPx: { value: SLOTS * resolution },
        // Never sample past this mip: deeper levels average across atlas
        // slots, which smears grazing-angle views into one murky colour.
        uMaxLod: { value: Math.log2(resolution) - 2 },
        // The guaranteed-hires radius; aerial haze never intrudes inside it.
        uHazeMin: { value: 768 },
        uFogColor: t['uFogColor']!,
        uFog: t['uFog']!,
        uFogCenter: t['uFogCenter']!,
        uFogRadial: t['uFogRadial']!,
        uFogDensity: t['uFogDensity']!,
        uExposure: t['uExposure']!,
        uSaturation: t['uSaturation']!,
        uContrast: t['uContrast']!,
        uClipY: t['uClipY']!,
      },
      vertexShader: /* glsl */ `
        uniform vec2 uFogCenter;
        uniform float uFogRadial;
        out vec2 vUv;
        out float vFog;
        out vec3 vWorld;
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vec4 mv = viewMatrix * wp;
          vFog = mix(-mv.z, distance(wp.xz, uFogCenter), uFogRadial);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uMap;
        uniform float uAtlasPx;
        uniform float uMaxLod;
        uniform float uHazeMin;
        uniform vec3 uFogColor;
        uniform vec2 uFog;
        uniform float uFogDensity;
        uniform float uExposure;
        uniform float uSaturation;
        uniform float uContrast;
        uniform float uClipY;
        in vec2 vUv;
        in float vFog;
        in vec3 vWorld;
        out vec4 frag;
        vec3 toLinear(vec3 c) {
          return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
        }
        vec3 toSRGB(vec3 c) {
          c = max(c, vec3(0.0));
          return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
        }
        void main() {
          if (vWorld.y > uClipY) discard;
          // Explicit LOD, clamped: grazing views drive the derivative-based
          // mip selection deep enough to blend unrelated atlas slots (the
          // "distant blue wall" smear). Capped, a slot only ever mixes with
          // itself.
          vec2 px = vUv * uAtlasPx;
          vec2 ddx = dFdx(px);
          vec2 ddy = dFdy(px);
          float lod = 0.5 * log2(max(dot(ddx, ddx), max(dot(ddy, ddy), 1.0)));
          vec4 t = textureLod(uMap, vUv, min(lod, uMaxLod));
          if (t.a < 0.5) discard; // void columns captured as transparent
          // Snapshots are captured with a NEUTRAL grade, so the live display
          // settings apply here exactly like they do to hires terrain.
          vec3 c = toLinear(t.rgb) * uExposure;
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          c = mix(vec3(l), c, uSaturation);
          c = max((c - 0.5) * uContrast + 0.5, vec3(0.0));
          // Aerial perspective for remembered terrain: a top-down snapshot
          // can't hold up viewed edge-on, so haze it by HORIZONTAL distance
          // from the eye, scaled by how high the eye sits — top-down map
          // views stay crystal clear, while a ground-level camera sees
          // remembered mountains fade into the horizon like real draw
          // distance instead of standing raw against the sky.
          float camXZ = distance(vWorld.xz, cameraPosition.xz);
          float above = max(cameraPosition.y - vWorld.y, 0.0);
          float hazeNear = max(uHazeMin, above * 2.0);
          float haze = smoothstep(hazeNear, hazeNear * 2.2, camXZ);
          float f = clamp(max(smoothstep(uFog.x, uFog.y, vFog), haze) * uFogDensity, 0.0, 1.0);
          frag = vec4(toSRGB(mix(c, toLinear(uFogColor), f)), 1.0);
        }
      `,
      alphaToCoverage: true,
      // Skirt quads hang off each tile's rim; double-sided keeps them visible
      // from every orbit angle without winding gymnastics.
      side: THREE.DoubleSide,
      // Impostors sit at TRUE surface height. Where hires geometry coexists
      // (the stream-in fade, the ring boundary) the depth offset pushes the
      // impostor behind it — the decal trick — so there is no geometric dip
      // and therefore no sunken step around the live disc.
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 4,
    });
  }

  /** Remembered-tile count (for stats readouts). */
  get count(): number {
    return this.byKey.size;
  }

  /** Snapshot resolution in pixels per tile. */
  get resolutionPx(): number {
    return this.resolution;
  }

  /** The radius hires tiles are guaranteed resident to — the impostor shader
   *  keeps its grazing-angle aerial haze outside this ring. */
  setHazeFloor(radius: number): void {
    this.material.uniforms['uHazeMin']!.value = Math.max(radius, 1);
  }

  /** How far remembered terrain reaches from (x,z), in blocks — the radius the
   *  viewer's zoom range and fog frontier should keep visible. 0 = nothing
   *  remembered. */
  extentFrom(x: number, z: number): number {
    let extent = 0;
    for (const imp of this.byKey.values()) {
      const d = Math.hypot(imp.cx - x, imp.cz - z);
      if (d > extent) extent = d;
    }
    return extent === 0 ? 0 : extent + this.tileBlocks;
  }

  /** Fixed GPU cost of the atlas (RGBA + mip chain), plus the small meshes. */
  get gpuBytes(): number {
    const size = SLOTS * this.resolution;
    return Math.round(size * size * 4 * 1.34) + this.byKey.size * 8192;
  }

  /** Queue an evicted tile's meshes for snapshotting. Takes OWNERSHIP of the
   *  meshes — they are rendered once on a later update() tick, then disposed.
   *  A full queue drops its oldest entry (its meshes are simply disposed). */
  capture(tileX: number, tileZ: number, meshes: CaptureMeshes, surface: SurfaceMap, minY: number, maxY: number): void {
    if (this.retired) {
      disposeCapture(meshes);
      return;
    }
    const key = tileKey(tileX, tileZ);
    // A newer capture of the same tile supersedes a queued one.
    const queued = this.queue.findIndex((p) => p.key === key);
    if (queued >= 0) disposeCapture(this.queue.splice(queued, 1)[0]!.meshes);
    this.queue.push({ key, tileX, tileZ, meshes, surface, minY, maxY });
    if (this.queue.length > MAX_QUEUE) disposeCapture(this.queue.shift()!.meshes);
  }

  /** Forget a tile (it was removed from the manifest). */
  remove(key: string): void {
    const queued = this.queue.findIndex((p) => p.key === key);
    if (queued >= 0) disposeCapture(this.queue.splice(queued, 1)[0]!.meshes);
    const imp = this.byKey.get(key);
    if (imp) this.releaseImpostor(imp);
  }

  /** Drain one pending capture (bounded per frame so a ring of evictions
   *  never stacks its snapshot renders into one frame). Returns whether the
   *  scene changed (the caller redraws + re-runs coverage). */
  update(focusX: number, focusZ: number): boolean {
    const p = this.queue.shift();
    if (!p) return false;
    this.snapshot(p, focusX, focusZ);
    disposeCapture(p.meshes);
    return true;
  }

  /** Hide impostors whose hires tile is resident and fully faded in. */
  applyCoverage(shownHires: ReadonlySet<string>): void {
    for (const imp of this.byKey.values()) imp.mesh.visible = !shownHires.has(imp.key);
  }

  /** A hires tile just entered the scene: snap the facing rims of any
   *  impostor neighbours onto its REAL surface heights, so the boundary
   *  between the live disc and remembered terrain meets instead of stepping. */
  onHiresReady(tileX: number, tileZ: number, surface: SurfaceMap | undefined): void {
    if (!surface || this.byKey.size === 0) return;
    for (const [dx, dz] of EDGES) {
      const imp = this.byKey.get(tileKey(tileX + dx, tileZ + dz));
      if (!imp) continue;
      // The impostor's edge FACING the new tile is the opposite direction.
      if (this.stitchEdgeToSurface(imp, -dx, -dz, surface)) this.rebuild(imp);
    }
  }

  /** Remembered surface height under world (x,z), for the pivot fallback. */
  heightAt(x: number, z: number): number | null {
    const tb = this.tileBlocks;
    const imp = this.byKey.get(tileKey(Math.floor(x / tb), Math.floor(z / tb)));
    if (!imp) return null;
    const step = tb / GRID;
    const i = Math.min(Math.max(Math.round((x - imp.originX) / step), 0), GRID);
    const j = Math.min(Math.max(Math.round((z - imp.originZ) / step), 0), GRID);
    const h = imp.heights[j * (GRID + 1) + i]!;
    return h < 1 ? null : h;
  }

  /** Drop every impostor and stop accepting captures — called when a lowres
   *  pyramid arrives (a finished progressive bake): the baked rings cover the
   *  whole world and supersede anything remembered. */
  retire(): void {
    this.retired = true;
    for (const p of this.queue.splice(0)) disposeCapture(p.meshes);
    for (const imp of [...this.byKey.values()]) this.releaseImpostor(imp);
  }

  dispose(): void {
    this.retire();
    this.rt.dispose();
    this.material.dispose();
  }

  private releaseImpostor(imp: Impostor): void {
    this.scene.remove(imp.mesh);
    imp.mesh.geometry.dispose();
    this.byKey.delete(imp.key);
    this.freeSlots.push(imp.slot);
  }

  /** A free atlas slot, reusing the remembered tile farthest from the focus
   *  when the atlas is full — the same nearest-wins policy streaming uses. */
  private allocSlot(focusX: number, focusZ: number): number {
    const free = this.freeSlots.pop();
    if (free !== undefined) return free;
    let victim: Impostor | null = null;
    let worst = -1;
    for (const imp of this.byKey.values()) {
      const dx = imp.cx - focusX;
      const dz = imp.cz - focusZ;
      const d = dx * dx + dz * dz;
      if (d > worst) {
        worst = d;
        victim = imp;
      }
    }
    this.releaseImpostor(victim!); // capacity ≥ 1, so a victim always exists
    return this.freeSlots.pop()!;
  }

  /** Windowed mean of a surface map's heights around world (wx, wz), clamped
   *  into the map. Surface heights track the TOPMOST block (canopy, water
   *  surface), so point samples spike whole cells wherever a tree stands —
   *  the neighbourhood mean keeps impostors at believable height. Returns 0
   *  (the empty sentinel) when no populated column falls in the window. */
  private static meanAt(surf: SurfaceMap, wx: number, wz: number): number {
    const bx = Math.round(wx) - surf.originX;
    const bz = Math.round(wz) - surf.originZ;
    let sum = 0;
    let count = 0;
    for (let dz = -4; dz <= 4; dz += 2) {
      for (let dx = -4; dx <= 4; dx += 2) {
        const cx = Math.min(Math.max(bx + dx, 0), surf.width - 1);
        const cz = Math.min(Math.max(bz + dz, 0), surf.depth - 1);
        const h = surf.height[cz * surf.width + cx]!;
        if (h < 1) continue; // empty-column sentinel
        sum += h;
        count++;
      }
    }
    return count === 0 ? 0 : Math.round(sum / count);
  }

  /** Index of the k-th vertex (0..GRID) along an impostor's edge toward
   *  (dx,dz), into its (GRID+1)² height/vertex grid. */
  private static edgeIndex(dx: number, dz: number, k: number): number {
    const n = GRID + 1;
    if (dx === 1) return k * n + GRID; // east rim
    if (dx === -1) return k * n; // west rim
    if (dz === 1) return GRID * n + k; // south rim
    return k; // north rim
  }

  /** Stitch one edge of `imp` to a live hires neighbour's surface map: each
   *  rim vertex adopts the neighbour-side windowed mean at the shared world
   *  position (real terrain doesn't move to meet a snapshot). Returns whether
   *  anything changed. */
  private stitchEdgeToSurface(imp: Impostor, dx: number, dz: number, surface: SurfaceMap): boolean {
    const tb = this.tileBlocks;
    const step = tb / GRID;
    let changed = false;
    for (let k = 0; k <= GRID; k++) {
      const idx = ImpostorLayer.edgeIndex(dx, dz, k);
      if (imp.heights[idx]! < 1) continue;
      const wx = dx === 1 ? imp.originX + tb : dx === -1 ? imp.originX : imp.originX + k * step;
      const wz = dz === 1 ? imp.originZ + tb : dz === -1 ? imp.originZ : imp.originZ + k * step;
      const h = ImpostorLayer.meanAt(surface, wx, wz);
      if (h < 1 || h === imp.heights[idx]) continue;
      imp.heights[idx] = h;
      changed = true;
    }
    return changed;
  }

  /** Stitch every edge of a freshly-landed impostor: impostor neighbours meet
   *  in the middle (both rims set to the average — the exact same values, so
   *  the seam closes), live hires neighbours are adopted verbatim. Returns
   *  the neighbours whose geometry must be rebuilt. */
  private stitchAll(imp: Impostor): Impostor[] {
    const dirty: Impostor[] = [];
    for (const [dx, dz] of EDGES) {
      const nKey = tileKey(imp.tileX + dx, imp.tileZ + dz);
      const neighbour = this.byKey.get(nKey);
      if (neighbour) {
        let changed = false;
        for (let k = 0; k <= GRID; k++) {
          const a = ImpostorLayer.edgeIndex(dx, dz, k);
          const b = ImpostorLayer.edgeIndex(-dx, -dz, k);
          const ha = imp.heights[a]!;
          const hb = neighbour.heights[b]!;
          if (ha < 1 || hb < 1 || ha === hb) continue;
          const avg = Math.round((ha + hb) / 2);
          imp.heights[a] = avg;
          if (neighbour.heights[b] !== avg) {
            neighbour.heights[b] = avg;
            changed = true;
          }
        }
        if (changed) dirty.push(neighbour);
        continue;
      }
      const live = this.liveSurface(nKey);
      if (live) this.stitchEdgeToSurface(imp, dx, dz, live);
    }
    return dirty;
  }

  /** Build (or rebuild) an impostor's heightfield geometry from its stored
   *  heights + atlas slot: true-height grid, atlas UVs inset half a texel
   *  against slot bleed, rim skirts. Returns null for a mesh with no
   *  drawable cell. */
  private buildGeometry(imp: Impostor): THREE.BufferGeometry | null {
    const tb = this.tileBlocks;
    const res = this.resolution;
    const n = GRID + 1;
    const { heights, originX, originZ, slot } = imp;
    const sx = (slot % SLOTS) * res;
    const sy = Math.floor(slot / SLOTS) * res;

    const pos: number[] = [];
    const uv: number[] = [];
    const atlasPx = SLOTS * res;
    const u0 = (sx + 0.5) / atlasPx;
    const v0 = (sy + 0.5) / atlasPx;
    const span = (res - 1) / atlasPx;
    let minH = Infinity;
    let maxH = -Infinity;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const h = heights[j * n + i]!;
        pos.push(originX + (i * tb) / GRID, h < 1 ? 0 : h, originZ + (j * tb) / GRID);
        if (h >= 1) {
          if (h < minH) minH = h;
          if (h > maxH) maxH = h;
        }
        // The capture put -Z at the top of the slot; texture v runs bottom-up,
        // so v tracks z directly from the slot's far edge.
        uv.push(u0 + (i / GRID) * span, v0 + (1 - j / GRID) * span);
      }
    }
    if (!Number.isFinite(minH)) return null;

    const idx: number[] = [];
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        if (heights[a]! < 1 || heights[b]! < 1 || heights[c]! < 1 || heights[d]! < 1) continue;
        idx.push(a, c, d, a, d, b);
      }
    }
    if (idx.length === 0) return null;

    // Rim skirts: the backstop for boundaries stitching can't close (world
    // edges, not-yet-remembered neighbours) — cracks show a sliver of
    // stretched terrain instead of sky.
    const addSkirt = (a: number, b: number) => {
      if (heights[a]! < 1 || heights[b]! < 1) return;
      const base = pos.length / 3;
      for (const s of [a, b]) {
        pos.push(pos[s * 3]!, pos[s * 3 + 1]! - SKIRT, pos[s * 3 + 2]!);
        uv.push(uv[s * 2]!, uv[s * 2 + 1]!);
      }
      idx.push(a, b, base + 1, a, base + 1, base);
    };
    for (let k = 0; k < GRID; k++) {
      addSkirt(k, k + 1); // north rim (j = 0)
      addSkirt(GRID * n + k, GRID * n + k + 1); // south rim
      addSkirt(k * n, (k + 1) * n); // west rim
      addSkirt(k * n + GRID, (k + 1) * n + GRID); // east rim
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    geom.setIndex(idx);
    const box = new THREE.Box3(new THREE.Vector3(originX, minH - SKIRT, originZ), new THREE.Vector3(originX + tb, maxH, originZ + tb));
    geom.boundingBox = box;
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    geom.boundingSphere = sphere;
    return geom;
  }

  /** Swap in freshly-built geometry after a stitch adjusted stored heights. */
  private rebuild(imp: Impostor): void {
    const geom = this.buildGeometry(imp);
    if (!geom) return; // stitching never empties a drawable mesh; keep as-is
    imp.mesh.geometry.dispose();
    imp.mesh.geometry = geom;
  }

  /** Render the tile's meshes top-down into its atlas slot and swap in the
   *  stitched heightfield impostor. */
  private snapshot(p: Pending, focusX: number, focusZ: number): void {
    const meshes = [p.meshes.terrain, p.meshes.terrainLm, p.meshes.water].filter(Boolean) as THREE.Mesh[];
    if (meshes.length === 0) return;
    const tb = this.tileBlocks;
    const originX = p.tileX * tb;
    const originZ = p.tileZ * tb;

    // Heightfield samples first — an all-void tile bails before it costs an
    // atlas slot or a render.
    const n = GRID + 1;
    const heights = new Int16Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        heights[j * n + i] = ImpostorLayer.meanAt(p.surface, originX + (i * tb) / GRID, originZ + (j * tb) / GRID);
      }
    }
    let drawable = false;
    outer: for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = j * n + i;
        if (heights[a]! >= 1 && heights[a + 1]! >= 1 && heights[a + n]! >= 1 && heights[a + n + 1]! >= 1) {
          drawable = true;
          break outer;
        }
      }
    }
    if (!drawable) return;

    // Recaptures free their old slot first so the alloc below reuses it
    // instead of evicting an innocent neighbour from a full atlas.
    const existing = this.byKey.get(p.key);
    if (existing) this.releaseImpostor(existing);
    const slot = this.allocSlot(focusX, focusZ);
    const res = this.resolution;
    const sx = (slot % SLOTS) * res;
    const sy = Math.floor(slot / SLOTS) * res;

    // Neutralize the world-state uniforms for one clean textured capture; the
    // impostor shader re-applies the live grade/fog per frame. These uniform
    // OBJECTS are shared by the water/lightmap materials, so one save/restore
    // covers every mesh being rendered.
    const u = this.terrain.uniforms;
    const saved = new Map<string, unknown>();
    const neutral: [string, unknown][] = [
      ['uFogDensity', 0],
      ['uBiomeMix', 0],
      ['uHi', -1],
      ['uClipY', 1e9],
      ['uExposure', 1],
      ['uSaturation', 1],
      ['uContrast', 1],
    ];
    for (const [k, v] of neutral) {
      if (!u[k]) continue;
      saved.set(k, u[k]!.value);
      u[k]!.value = v;
    }

    for (const mesh of meshes) this.captureScene.add(mesh);
    // Camera at (0, top, 0) looking straight down with north (-Z) up. In that
    // camera space, x stays world X and "up" is -worldZ — so the frustum is
    // [originX, originX+tb] × [-(originZ+tb), -originZ].
    const cam = this.camera;
    cam.left = originX;
    cam.right = originX + tb;
    cam.top = -originZ;
    cam.bottom = -(originZ + tb);
    cam.near = 1;
    cam.far = p.maxY - p.minY + 32;
    cam.position.set(0, p.maxY + 16, 0);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    // Ortho frusta here span the whole tile; skip per-mesh culling checks.
    for (const mesh of meshes) mesh.frustumCulled = false;

    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    this.rt.viewport.set(sx, sy, res, res);
    this.rt.scissor.set(sx, sy, res, res);
    this.rt.scissorTest = true;
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = false;
    renderer.clear(true, true);
    renderer.render(this.captureScene, cam);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevColor, prevAlpha);
    renderer.autoClear = prevAutoClear;

    for (const [k, v] of saved) u[k]!.value = v;
    this.terrain.uniformsNeedUpdate = true;

    const imp: Impostor = {
      key: p.key,
      tileX: p.tileX,
      tileZ: p.tileZ,
      slot,
      mesh: new THREE.Mesh(undefined, this.material),
      heights,
      originX,
      originZ,
      cx: originX + tb / 2,
      cz: originZ + tb / 2,
    };
    // Close the seams BEFORE first build: impostor neighbours meet at the
    // average (their geometry rebuilds), live hires rims are adopted as-is.
    this.byKey.set(p.key, imp);
    const dirty = this.stitchAll(imp);
    const geom = this.buildGeometry(imp);
    if (!geom) {
      this.byKey.delete(p.key);
      this.freeSlots.push(slot);
      return;
    }
    imp.mesh.geometry.dispose(); // the constructor's empty placeholder
    imp.mesh.geometry = geom;
    imp.mesh.renderOrder = -1; // under hires like the lowres rings (less overdraw)
    this.scene.add(imp.mesh);
    for (const neighbour of dirty) this.rebuild(neighbour);
  }
}
