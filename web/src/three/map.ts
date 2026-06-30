// The streamed tiled-map engine. Where VantageViewer renders one monolithic tile,
// VantageMap streams a quadtree of tiles from a manifest: it loads only the tiles
// the camera can see (frustum-culled), shares one material across them so they
// batch, and evicts distant tiles so memory stays bounded. This is the P4 path —
// cost scales with the screen, not the world.
//
// NOTE: the renderer / 8× MSAA-offscreen / present / sky / controls scaffold mirrors
// VantageViewer. Both should later share a small engine base; kept separate for now
// to land tiling without churning the working single-tile viewer.

import * as THREE from 'three';
import { MapControls } from './controls.js';
import {
  biomePalette,
  loadManifest,
  parseTextureArray,
  parseTile,
  type LoadedManifest,
  type MapManifest,
  type MapTile,
  type Rgb,
} from '../core/index.js';
import { Emitter } from './emitter.js';
import { createSky, createTerrainMaterial, createWaterMaterial, SKY_HORIZON } from './materials.js';
import { buildTileGeometry } from './terrain.js';
import {
  DEFAULT_ORBIT_ANGLE,
  type DisplaySettings,
  type LightSettings,
  type ViewMode,
  VANILLA_DISPLAY,
} from './viewer.js';

const DEFAULT_LIGHT: Required<LightSettings> = { ambient: 0.12, daylight: 1, exposure: 1 };
const DEFAULT_DISPLAY: Required<DisplaySettings> = { ...VANILLA_DISPLAY };

export interface VantageMapOptions {
  view?: ViewMode;
  antialias?: boolean;
  maxPixelRatio?: number;
  light?: LightSettings;
  display?: DisplaySettings;
  /** Multiplier on the view distance for how far out of frustum to keep tiles
   *  loaded before evicting them. Default `1.5` (a ring of slack around the view). */
  keepFactor?: number;
}

/** Summary of a loaded map, emitted on `load`. */
export interface MapInfo {
  tileCount: number;
  legend: string[];
  world: MapManifest['world'];
}

interface MapEvents extends Record<string, unknown> {
  load: MapInfo;
  /** Tiles currently resident / visible changed (for a HUD). */
  tiles: { loaded: number; visible: number; total: number };
  biomelayer: { enabled: boolean; highlight: number | null };
  mode: { fly: boolean };
}

/** One tile's resident GPU state. */
interface ResidentTile {
  meshes: THREE.Mesh[]; // terrain (+ water)
  center: THREE.Vector3;
  box: THREE.Box3;
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`vantage: ${r.status} ${r.statusText} for ${url}`);
  return r.arrayBuffer();
}

function tileKey(t: MapTile): string {
  return `${t.l}/${t.x}/${t.z}`;
}

export class VantageMap {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;

  private readonly container: HTMLElement;
  private readonly options: Required<Omit<VantageMapOptions, 'light' | 'display'>>;
  private readonly emitter = new Emitter<MapEvents>();
  private readonly sky: THREE.Mesh;
  private readonly resizeObserver: ResizeObserver;

  // 8× MSAA offscreen + fullscreen present (matches the single-tile viewer's AA).
  private msaa!: THREE.WebGLRenderTarget;
  private readonly present = new THREE.Scene();
  private readonly presentCamera = new THREE.Camera();
  private presentMaterial!: THREE.RawShaderMaterial;

  // Map + streaming state.
  private loaded: LoadedManifest | null = null;
  private terrainMaterial: THREE.ShaderMaterial | null = null;
  private waterMaterial: THREE.ShaderMaterial | null = null;
  private palette: Rgb[] = [];
  private worldBounds = new THREE.Box3();
  /** Mean of the tile tops — the surface level to frame the camera vertically on,
   *  so deep caves don't drag the pivot far above the ground. */
  private landTop = 0;
  /** Vertex-weighted XZ centroid of the populated tiles, so framing centres on the
   *  dense terrain rather than the bounding-box midpoint (which a lone edge tile skews). */
  private readonly landCenter = new THREE.Vector2();
  private readonly resident = new Map<string, ResidentTile>();
  private readonly loading = new Set<string>();
  private static readonly MAX_CONCURRENT = 6;

  // Biome layer + appearance (shared uniforms across every tile).
  private biomeEnabled = false;
  private highlight: number | null = null;
  private mixTarget = 0;
  private mixCurrent = 0;
  private light: Required<LightSettings> = { ...DEFAULT_LIGHT };
  private display: Required<DisplaySettings> = { ...DEFAULT_DISPLAY };

  // Frustum scratch.
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private lastFrameMs = 0;
  private framedState: { position: THREE.Vector3; distance: number; rotation: number; angle: number; floorY: number } | null = null;

  constructor(container: HTMLElement | string, options: VantageMapOptions = {}) {
    const el = typeof container === 'string' ? document.querySelector<HTMLElement>(container) : container;
    if (!el) throw new Error(`vantage: container not found: ${String(container)}`);
    this.container = el;
    this.options = {
      view: options.view ?? 'orbit',
      antialias: options.antialias ?? true,
      maxPixelRatio: options.maxPixelRatio ?? 2,
      keepFactor: options.keepFactor ?? 1.5,
    };
    if (options.light) this.light = { ...this.light, ...options.light };
    if (options.display) this.display = { ...this.display, ...options.display };

    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(this.targetPixelRatio());
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false;
    this.container.appendChild(this.renderer.domElement);
    this.buildAA();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(...SKY_HORIZON);
    this.sky = createSky();
    this.scene.add(this.sky);

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.5, 8000);
    this.controls = new MapControls(this.camera, this.renderer.domElement, { minDistance: 3 });

    this.bindInput();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();

    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Build a VantageMap and load a manifest in one call. */
  static async mount(container: HTMLElement | string, manifestUrl: string, options: VantageMapOptions = {}): Promise<VantageMap> {
    const map = new VantageMap(container, options);
    await map.load(manifestUrl);
    return map;
  }

  // --- loading --------------------------------------------------------------

  /** Fetch the manifest + shared texture array, build the shared material, and
   *  frame the camera over the world. Tiles then stream in as the camera moves. */
  async load(manifestUrl: string): Promise<void> {
    const loaded = await loadManifest(manifestUrl);
    const { manifest, baseUrl } = loaded;
    this.disposeMap();
    this.loaded = loaded;

    const texData = parseTextureArray(await fetchBuffer(baseUrl + manifest.textures));
    this.terrainMaterial = createTerrainMaterial(texData);
    this.waterMaterial = createWaterMaterial(this.terrainMaterial);
    this.palette = biomePalette(manifest.legend.length);

    // Frame to the union of populated tile boxes — the actual geometry extent —
    // not the (sparse) world rectangle, whose centre can sit in empty space.
    const land = new THREE.Box3();
    let topSum = 0;
    let cx = 0;
    let cz = 0;
    let wsum = 0;
    for (const t of manifest.tiles) {
      land.expandByPoint(new THREE.Vector3(t.box[0], t.box[1], t.box[2]));
      land.expandByPoint(new THREE.Vector3(t.box[3], t.box[4], t.box[5]));
      topSum += t.box[4]; // tile top
      const wt = Math.max(1, t.v); // weight by vertex count (density)
      cx += ((t.box[0] + t.box[3]) / 2) * wt;
      cz += ((t.box[2] + t.box[5]) / 2) * wt;
      wsum += wt;
    }
    if (land.isEmpty()) {
      const w = manifest.world;
      land.set(new THREE.Vector3(w.minX, w.minY, w.minZ), new THREE.Vector3(w.maxX + 1, w.maxY + 1, w.maxZ + 1));
    }
    this.worldBounds = land;
    this.landTop = manifest.tiles.length ? topSum / manifest.tiles.length : land.max.y;
    const center = new THREE.Vector3();
    land.getCenter(center);
    this.landCenter.set(wsum > 0 ? cx / wsum : center.x, wsum > 0 ? cz / wsum : center.z);
    this.frameCamera(this.options.view);
    this.applyBiomeUniforms();
    this.applyLight();
    this.applyDisplay();

    // Prime: stream whatever the initial framing sees, so first paint isn't empty.
    this.updateFrustum();
    this.streamTiles();
    this.emitter.emit('load', { tileCount: manifest.tiles.length, legend: manifest.legend, world: manifest.world });
  }

  // --- camera framing -------------------------------------------------------

  private fitDistance(s: number): number {
    return (s * 0.5) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
  }

  private frameCamera(view: ViewMode): void {
    const size = new THREE.Vector3();
    this.worldBounds.getSize(size);
    const span = Math.max(size.x, size.z);
    this.controls.maxDistance = Math.max(size.x, size.y, size.z) * 4;

    const pivot = new THREE.Vector3(this.landCenter.x, this.landTop, this.landCenter.y);
    const distance = view === 'top' ? this.fitDistance(span) * 1.04 : this.fitDistance(span) * 0.72;
    const angle = view === 'top' ? 0 : DEFAULT_ORBIT_ANGLE;
    this.controls.setView({ position: pivot, distance, rotation: 0, angle, floorY: pivot.y });
    this.framedState = { position: pivot.clone(), distance, rotation: 0, angle, floorY: pivot.y };

    const maxDim = Math.max(size.x, size.y, size.z);
    this.camera.far = maxDim * 12;
    this.camera.updateProjectionMatrix();
    if (this.terrainMaterial) this.terrainMaterial.uniforms['uFog']!.value.set(maxDim * 1.2, maxDim * 3.2);
  }

  /** Smoothly return to the framing the map loaded into. */
  resetView(): void {
    if (this.framedState) this.controls.animateTo(this.framedState);
  }

  // --- streaming ------------------------------------------------------------

  private updateFrustum(): void {
    this.projScreen.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
  }

  /** Per-frame streaming: load tiles the camera can see, toggle visibility by the
   *  frustum, and evict tiles that have drifted well outside the view. */
  private streamTiles(): void {
    const manifest = this.loaded?.manifest;
    if (!manifest) return;
    const eye = this.camera.position;
    // Eviction radius scales with how far out we're looking, so panning keeps a
    // ring of slack loaded but a big zoom-out doesn't hoard the whole world.
    const keep = this.controls.distance * this.options.keepFactor + manifest.tileSize * 4;
    const keepSq = keep * keep;

    let pending = this.loading.size;
    let visible = 0;
    for (const t of manifest.tiles) {
      const key = tileKey(t);
      const box = new THREE.Box3(new THREE.Vector3(t.box[0], t.box[1], t.box[2]), new THREE.Vector3(t.box[3], t.box[4], t.box[5]));
      const center = new THREE.Vector3();
      box.getCenter(center);
      const inView = this.frustum.intersectsBox(box);
      const distSq = center.distanceToSquared(eye);

      const res = this.resident.get(key);
      if (res) {
        const show = inView;
        for (const m of res.meshes) m.visible = show;
        if (show) visible++;
        if (distSq > keepSq && !inView) this.evict(key);
        continue;
      }
      // Not resident: fetch if it's in view (or just outside) and we have capacity.
      if (inView && pending < VantageMap.MAX_CONCURRENT && !this.loading.has(key)) {
        pending++;
        void this.loadTile(t, box, center);
      }
    }
    this.emitter.emit('tiles', { loaded: this.resident.size, visible, total: manifest.tiles.length });
  }

  private async loadTile(t: MapTile, box: THREE.Box3, center: THREE.Vector3): Promise<void> {
    const key = tileKey(t);
    this.loading.add(key);
    try {
      const url = `${this.loaded!.baseUrl}${t.file}?v=${t.h}`;
      const tile = parseTile(await fetchBuffer(url));
      if (!this.loaded || !this.terrainMaterial || !this.waterMaterial) return; // map changed mid-flight
      const { geometry, water } = buildTileGeometry(tile, this.palette);
      const meshes: THREE.Mesh[] = [];
      const terrain = new THREE.Mesh(geometry, this.terrainMaterial);
      terrain.frustumCulled = false; // we cull whole tiles ourselves, by box
      this.scene.add(terrain);
      meshes.push(terrain);
      if (water) {
        const wm = new THREE.Mesh(water, this.waterMaterial);
        wm.renderOrder = 1;
        wm.frustumCulled = false;
        this.scene.add(wm);
        meshes.push(wm);
      }
      this.resident.set(key, { meshes, center, box });
    } catch {
      // Leave it unresident; the next frame retries if still in view.
    } finally {
      this.loading.delete(key);
    }
  }

  private evict(key: string): void {
    const res = this.resident.get(key);
    if (!res) return;
    for (const m of res.meshes) {
      this.scene.remove(m);
      m.geometry.dispose();
    }
    this.resident.delete(key);
  }

  // --- biome layer / appearance (shared uniforms) ---------------------------

  get biomeLayerEnabled(): boolean {
    return this.biomeEnabled;
  }
  get highlightedBiome(): number | null {
    return this.highlight;
  }

  setBiomeLayer(enabled: boolean): void {
    if (this.biomeEnabled === enabled) return;
    this.biomeEnabled = enabled;
    if (!enabled) this.highlight = null;
    this.mixTarget = enabled ? 1 : 0;
    this.applyBiomeUniforms();
    this.emitter.emit('biomelayer', { enabled, highlight: this.highlight });
  }
  toggleBiomeLayer(): void {
    this.setBiomeLayer(!this.biomeEnabled);
  }
  setHighlightedBiome(id: number | null): void {
    if (id !== null && !this.biomeEnabled) this.setBiomeLayer(true);
    this.highlight = id;
    this.applyBiomeUniforms();
    this.emitter.emit('biomelayer', { enabled: this.biomeEnabled, highlight: id });
  }
  private applyBiomeUniforms(): void {
    if (!this.terrainMaterial) return;
    this.terrainMaterial.uniforms['uHi']!.value = this.biomeEnabled && this.highlight !== null ? this.highlight : -1;
  }

  setLight(settings: LightSettings): void {
    this.light = { ...this.light, ...settings };
    this.applyLight();
  }
  private applyLight(): void {
    if (!this.terrainMaterial) return;
    const u = this.terrainMaterial.uniforms;
    u['uAmbient']!.value = this.light.ambient;
    u['uDay']!.value = this.light.daylight;
    u['uExposure']!.value = this.light.exposure;
  }

  setDisplay(settings: DisplaySettings): void {
    const scaleChanged = settings.renderScale !== undefined && settings.renderScale !== this.display.renderScale;
    this.display = { ...this.display, ...settings };
    this.applyDisplay();
    if (scaleChanged) {
      this.renderer.setPixelRatio(this.targetPixelRatio());
      this.resize();
    }
  }
  private applyDisplay(): void {
    if (!this.terrainMaterial) return;
    const u = this.terrainMaterial.uniforms;
    u['uSharpness']!.value = this.display.sharpness;
    u['uAoStrength']!.value = this.display.ao;
    u['uSaturation']!.value = this.display.saturation;
    u['uContrast']!.value = this.display.contrast;
    u['uFogDensity']!.value = this.display.fog;
  }

  // --- navigation passthroughs ---------------------------------------------

  zoomBy(steps: number): void {
    this.controls.zoom(steps);
  }
  resetNorth(): void {
    this.controls.animateTo({ rotation: 0 });
  }
  setTilt(angle: number): void {
    this.controls.animateTo({ angle });
  }
  flatten(): void {
    this.controls.animateTo({ angle: 0, rotation: 0 });
  }
  get tilt(): number {
    return this.controls.angle;
  }
  get isFlying(): boolean {
    return this.controls.flyMode;
  }
  setFlyMode(on: boolean): void {
    if (this.controls.flyMode === on) return;
    this.controls.setMode(on ? 'fly' : 'map');
    this.emitter.emit('mode', { fly: on });
  }
  toggleFly(): void {
    this.setFlyMode(!this.controls.flyMode);
  }

  on<K extends keyof MapEvents>(event: K, listener: (payload: MapEvents[K]) => void): () => void {
    return this.emitter.on(event, listener);
  }

  // --- scaffold (renderer / AA / frame) -------------------------------------

  private buildAA(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.msaa = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      samples: this.options.antialias ? 8 : 0,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
    });
    this.msaa.texture.colorSpace = THREE.NoColorSpace;
    this.msaa.texture.minFilter = THREE.LinearFilter;
    this.msaa.texture.magFilter = THREE.LinearFilter;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.presentMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { tSrc: { value: this.msaa.texture } },
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `
        in vec3 position; out vec2 vUv;
        void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float; uniform sampler2D tSrc; in vec2 vUv; out vec4 frag;
        void main() { frag = texture(tSrc, vUv); }
      `,
    });
    this.present.add(new THREE.Mesh(geo, this.presentMaterial));
  }

  private targetPixelRatio(): number {
    const want = window.devicePixelRatio * this.display.renderScale;
    return Math.min(want, this.options.maxPixelRatio * Math.max(1, this.display.renderScale), 4);
  }

  private bindInput(): void {
    const dom = this.renderer.domElement;
    dom.style.cursor = 'grab';
    dom.style.touchAction = 'none';
    this.controls.addEventListener('start', () => {
      dom.style.cursor = 'grabbing';
    });
    this.controls.addEventListener('end', () => {
      dom.style.cursor = 'grab';
    });
  }

  private frame(): void {
    const now = performance.now();
    const dtMs = this.lastFrameMs ? now - this.lastFrameMs : 16.7;
    this.lastFrameMs = now;
    this.controls.update(dtMs);
    this.sky.position.copy(this.camera.position);

    if (this.terrainMaterial) {
      this.mixCurrent += (this.mixTarget - this.mixCurrent) * 0.2;
      if (Math.abs(this.mixCurrent - this.mixTarget) < 0.0015) this.mixCurrent = this.mixTarget;
      this.terrainMaterial.uniforms['uBiomeMix']!.value = this.mixCurrent;
    }

    this.updateFrustum();
    this.streamTiles();

    this.renderer.setRenderTarget(this.msaa);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.present, this.presentCamera);
  }

  private resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.msaa.setSize(Math.max(1, size.x), Math.max(1, size.y));
  }

  private disposeMap(): void {
    for (const key of [...this.resident.keys()]) this.evict(key);
    this.loading.clear();
    this.terrainMaterial?.dispose();
    this.waterMaterial?.dispose();
    this.terrainMaterial = null;
    this.waterMaterial = null;
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.disposeMap();
    this.present.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.presentMaterial.dispose();
    this.msaa.dispose();
    this.emitter.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
