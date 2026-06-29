// The framework-agnostic Vantage viewer engine. It owns a three.js renderer,
// scene, camera, and orbit controls; loads and frames a tile; runs the biome
// layer (textured<->biome crossfade + highlight) and hover-to-identify picking;
// and emits events. The React components are thin wrappers over this.

import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import {
  parseTextureArray,
  parseTile,
  summarizeBiomes,
  type BiomeEntry,
  type DecodedTextureArray,
  type DecodedTile,
} from '../core/index.js';
import { Emitter } from './emitter.js';
import { createSky, SKY_HORIZON } from './materials.js';
import { pickBiome } from './pick.js';
import { buildTerrain } from './terrain.js';

/** How the camera frames the world on load. */
export type ViewMode = 'orbit' | 'top';

/** Live, render-time lighting appearance — tunable without re-baking the tile. */
export interface LightSettings {
  /** Brightness floor at zero baked light, 0..1. Higher = more readable caves.
   *  Default `0.12`. */
  ambient?: number;
  /** Daylight factor scaling sky light, 0..1 (0 = night, 1 = noon). Default `1`. */
  daylight?: number;
  /** Overall brightness/tone multiplier (1 = neutral). Default `1`. */
  exposure?: number;
}

const DEFAULT_LIGHT: Required<LightSettings> = { ambient: 0.12, daylight: 1, exposure: 1 };

/** Live, render-time display fidelity — sharpness, colour grade, haze, and render
 *  scale. All neutral by default (the shipped look); tune without re-baking. */
export interface DisplaySettings {
  /** Texture mip LOD bias. 0 = smooth (anti-shimmer), higher = crisper distant
   *  texels at the cost of some shimmer. Default `0`. */
  sharpness?: number;
  /** Baked ambient-occlusion darkening scale. 1 = as-baked, 0 = off, >1 = deeper
   *  contact shadows / more block definition. Default `1`. */
  ao?: number;
  /** Colour saturation (1 = neutral, 0 = greyscale, >1 = punchier). Default `1`. */
  saturation?: number;
  /** Colour contrast around mid grey (1 = neutral). Default `1`. */
  contrast?: number;
  /** Atmospheric haze amount (1 = full, 0 = clear distance). Default `1`. */
  fog?: number;
  /** Super-/sub-sampling factor on devicePixelRatio (1 = native; 2 = 2× SSAA for
   *  extra crispness; <1 = faster/softer). Capped by `maxPixelRatio`. Default `1`. */
  renderScale?: number;
}

const DEFAULT_DISPLAY: Required<DisplaySettings> = {
  sharpness: 0,
  ao: 1,
  saturation: 1,
  contrast: 1,
  fog: 1,
  renderScale: 1,
};

export interface VantageViewerOptions {
  /** Initial camera framing. Default `'orbit'`. */
  view?: ViewMode;
  /** Antialias the WebGL context. Default `true`. */
  antialias?: boolean;
  /** Device pixel-ratio cap. Default `2`. */
  maxPixelRatio?: number;
  /** Initial lighting appearance (live-tunable later via {@link VantageViewer.setLight}). */
  light?: LightSettings;
  /** Initial display fidelity (live-tunable later via {@link VantageViewer.setDisplay}). */
  display?: DisplaySettings;
}

/** A tile source: a URL to fetch, a raw buffer, or already-decoded data. */
export type TileSource = string | ArrayBuffer | DecodedTile;
export type TextureSource = string | ArrayBuffer | DecodedTextureArray;

export interface LoadOptions {
  /** The `.vtile` to render. */
  tile: TileSource;
  /** The `.vtexarr` texture array (required for textured tiles). */
  textures?: TextureSource;
  /** Override the initial framing for this load. */
  view?: ViewMode;
}

/** Metadata describing a loaded tile. */
export interface TileInfo {
  magic: string;
  vertexCount: number;
  triangleCount: number;
  size: THREE.Vector3;
  biomes: BiomeEntry[];
}

interface ViewerEvents extends Record<string, unknown> {
  /** Fired after a tile is loaded and framed. */
  load: TileInfo;
  /** The biome id under the cursor, or `null` when off-terrain. */
  hover: number | null;
  /** Biome layer state changed. */
  biomelayer: { enabled: boolean; highlight: number | null };
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.arrayBuffer();
}

async function resolveTile(src: TileSource): Promise<DecodedTile> {
  if (typeof src === 'string') return parseTile(await fetchBuffer(src));
  if (src instanceof ArrayBuffer) return parseTile(src);
  return src;
}

async function resolveTextures(src: TextureSource): Promise<DecodedTextureArray> {
  if (typeof src === 'string') return parseTextureArray(await fetchBuffer(src));
  if (src instanceof ArrayBuffer) return parseTextureArray(src);
  return src;
}

function resolveContainer(container: HTMLElement | string): HTMLElement {
  const el = typeof container === 'string' ? document.querySelector<HTMLElement>(container) : container;
  if (!el) throw new Error(`vantage: container not found: ${String(container)}`);
  return el;
}

export class VantageViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;

  private readonly container: HTMLElement;
  private readonly options: Required<VantageViewerOptions>;
  private readonly emitter = new Emitter<ViewerEvents>();
  private readonly sky: THREE.Mesh;
  private readonly resizeObserver: ResizeObserver;

  // Current tile state.
  private tile: DecodedTile | null = null;
  private shader: THREE.ShaderMaterial | null = null;
  private bounds = new THREE.Box3();
  private current: { terrain: THREE.Mesh; water?: THREE.Mesh } | null = null;
  private _biomes: BiomeEntry[] = [];

  // Biome layer state machine.
  private biomeEnabled = false;
  private highlight: number | null = null;
  private mixTarget = 0;
  private mixCurrent = 0;

  // Live lighting appearance (applied to the shader on load and on change).
  private light: Required<LightSettings> = { ...DEFAULT_LIGHT };
  // Live display fidelity (shader uniforms + render scale).
  private display: Required<DisplaySettings> = { ...DEFAULT_DISPLAY };

  // Hover picking.
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private pointerInside = false;
  private pointerDirty = false;
  private dragging = false;
  private lastHover = -2; // sentinel distinct from -1 (off-terrain)

  constructor(container: HTMLElement | string, options: VantageViewerOptions = {}) {
    this.container = resolveContainer(container);
    this.options = {
      view: options.view ?? 'orbit',
      antialias: options.antialias ?? true,
      maxPixelRatio: options.maxPixelRatio ?? 2,
      light: options.light ?? {},
      display: options.display ?? {},
    };
    if (options.light) this.light = { ...this.light, ...options.light };
    if (options.display) this.display = { ...this.display, ...options.display };

    this.renderer = new THREE.WebGLRenderer({ antialias: this.options.antialias });
    this.renderer.setPixelRatio(this.targetPixelRatio());
    // Output shader colours directly (textures are already sRGB pixel art).
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(...SKY_HORIZON);
    this.sky = createSky();
    this.scene.add(this.sky);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.5, 8000);
    // Map-style navigation (à la BlueMap): left-drag pans across the ground,
    // right-drag rotates/tilts, wheel zooms toward the cursor. Damping gives it
    // weight; the polar clamp keeps the camera above the horizon.
    this.controls = new MapControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = false; // pan parallel to the ground plane
    this.controls.maxPolarAngle = Math.PI * 0.495; // don't dip below the horizon
    this.controls.minDistance = 2;

    this.bindInput();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();

    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Construct a viewer and load a tile in one call. */
  static async mount(container: HTMLElement | string, options: VantageViewerOptions & LoadOptions): Promise<VantageViewer> {
    const { tile, textures, view, ...rest } = options;
    const viewer = new VantageViewer(container, { ...rest, ...(view ? { view } : {}) });
    await viewer.load({ tile, textures, view });
    return viewer;
  }

  /** Load (fetch/decode as needed), build, and frame a tile. */
  async load(opts: LoadOptions): Promise<void> {
    const tile = await resolveTile(opts.tile);
    const textures = opts.textures ? await resolveTextures(opts.textures) : undefined;
    this.setTile(tile, textures, opts.view ?? this.options.view);
  }

  private setTile(tile: DecodedTile, textures: DecodedTextureArray | undefined, view: ViewMode): void {
    this.disposeCurrent();

    const built = buildTerrain(tile, textures);
    this.tile = tile;
    this.shader = built.shader ?? null;
    this.bounds = built.bounds;
    this.scene.add(built.terrain);
    if (built.water) this.scene.add(built.water);
    this.current = { terrain: built.terrain, water: built.water };

    if (built.requiresSceneLights) {
      this.scene.add(new THREE.HemisphereLight(0xbcd7ff, 0x4a4636, 1.0));
      const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
      sun.position.set(0.6, 1.0, 0.35);
      this.scene.add(sun);
    }

    this._biomes = summarizeBiomes(tile, built.palette);
    this.frameCamera(view);
    this.applyBiomeUniforms();
    this.applyLight();
    this.applyDisplay();

    const size = new THREE.Vector3();
    this.bounds.getSize(size);
    this.emitter.emit('load', {
      magic: tile.magic,
      vertexCount: tile.vertexCount + (tile.fluid?.vertexCount ?? 0),
      triangleCount: (tile.indexCount + (tile.fluid?.indexCount ?? 0)) / 3,
      size,
      biomes: this._biomes,
    });
  }

  private frameCamera(view: ViewMode): void {
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    this.bounds.getCenter(center);
    this.bounds.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    this.controls.maxDistance = maxDim * 4; // bound zoom-out to the world extent

    if (view === 'top') {
      const span = Math.max(size.x, size.z);
      this.controls.target.set(center.x, this.bounds.max.y, center.z);
      this.camera.position.set(center.x, this.bounds.max.y + span * 0.9, center.z + 0.001);
    } else {
      this.controls.target.copy(center);
      this.camera.position.set(center.x + maxDim * 0.7, center.y + maxDim * 0.6, center.z + maxDim * 0.7);
    }
    this.camera.far = maxDim * 12;
    this.camera.updateProjectionMatrix();

    // Fog fades terrain into the horizon over the back half of the extent.
    if (this.shader) this.shader.uniforms['uFog']!.value.set(maxDim * 0.85, maxDim * 2.4);
  }

  // --- biome layer ----------------------------------------------------------

  /** Biomes present in the current tile, most common first. */
  get biomes(): BiomeEntry[] {
    return this._biomes;
  }

  /** Whether the biome recolour layer is active. */
  get biomeLayerEnabled(): boolean {
    return this.biomeEnabled;
  }

  /** The currently isolated biome id, or `null`. */
  get highlightedBiome(): number | null {
    return this.highlight;
  }

  /** Turn the biome recolour layer on or off (crossfades). */
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

  /** Isolate a biome by id (fades the rest); `null` clears. Enables the layer. */
  setHighlightedBiome(id: number | null): void {
    if (id !== null && !this.biomeEnabled) this.setBiomeLayer(true);
    this.highlight = id;
    this.applyBiomeUniforms();
    this.emitter.emit('biomelayer', { enabled: this.biomeEnabled, highlight: id });
  }

  private applyBiomeUniforms(): void {
    if (!this.shader) return;
    this.shader.uniforms['uHi']!.value = this.biomeEnabled && this.highlight !== null ? this.highlight : -1;
  }

  // --- lighting appearance ---------------------------------------------------

  /** The current live lighting appearance. */
  get lightSettings(): Required<LightSettings> {
    return { ...this.light };
  }

  /** Update the live lighting appearance (merges with current; takes effect
   *  immediately, no re-bake). */
  setLight(settings: LightSettings): void {
    this.light = { ...this.light, ...settings };
    this.applyLight();
  }

  private applyLight(): void {
    if (!this.shader) return;
    this.shader.uniforms['uAmbient']!.value = this.light.ambient;
    this.shader.uniforms['uDay']!.value = this.light.daylight;
    this.shader.uniforms['uExposure']!.value = this.light.exposure;
  }

  // --- display fidelity ------------------------------------------------------

  /** The current live display fidelity (sharpness, colour grade, fog, scale). */
  get displaySettings(): Required<DisplaySettings> {
    return { ...this.display };
  }

  /** Update the live display fidelity (merges with current; immediate, no
   *  re-bake). `renderScale` resizes the framebuffer; the rest are shader uniforms. */
  setDisplay(settings: DisplaySettings): void {
    const scaleChanged = settings.renderScale !== undefined && settings.renderScale !== this.display.renderScale;
    this.display = { ...this.display, ...settings };
    this.applyDisplay();
    if (scaleChanged) {
      this.renderer.setPixelRatio(this.targetPixelRatio());
      this.resize();
    }
  }

  /** devicePixelRatio × renderScale, capped by maxPixelRatio (and a hard 4 so a
   *  fat-fingered scale can't allocate a giant framebuffer). */
  private targetPixelRatio(): number {
    const want = window.devicePixelRatio * this.display.renderScale;
    return Math.min(want, this.options.maxPixelRatio * Math.max(1, this.display.renderScale), 4);
  }

  private applyDisplay(): void {
    if (!this.shader) return;
    this.shader.uniforms['uSharpness']!.value = this.display.sharpness;
    this.shader.uniforms['uAoStrength']!.value = this.display.ao;
    this.shader.uniforms['uSaturation']!.value = this.display.saturation;
    this.shader.uniforms['uContrast']!.value = this.display.contrast;
    this.shader.uniforms['uFogDensity']!.value = this.display.fog;
  }

  // --- events ---------------------------------------------------------------

  on<K extends keyof ViewerEvents>(event: K, listener: (payload: ViewerEvents[K]) => void): () => void {
    return this.emitter.on(event, listener);
  }

  // --- internals ------------------------------------------------------------

  private bindInput(): void {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointermove', (e) => {
      const rect = dom.getBoundingClientRect();
      this.ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.pointerInside = true;
      this.pointerDirty = true;
    });
    dom.addEventListener('pointerleave', () => {
      this.pointerInside = false;
      this.pointerDirty = true;
    });
    // Skip picking while orbiting/panning so interaction stays perfectly smooth.
    this.controls.addEventListener('start', () => {
      this.dragging = true;
      this.emitHover(-1);
    });
    this.controls.addEventListener('end', () => {
      this.dragging = false;
    });
  }

  private emitHover(id: number): void {
    if (id === this.lastHover) return;
    this.lastHover = id;
    this.emitter.emit('hover', id < 0 ? null : id);
  }

  private pickHover(): void {
    if (this.dragging || !this.pointerDirty) return; // at most once per frame, never mid-drag
    this.pointerDirty = false;
    const surface = this.tile?.surface;
    if (!surface || !this.pointerInside) {
      this.emitHover(-1);
      return;
    }
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.emitHover(pickBiome(this.raycaster.ray, surface, this.bounds));
  }

  private frame(): void {
    this.controls.update();
    this.sky.position.copy(this.camera.position); // keep the dome centred on the eye

    // Ease the textured<->biome crossfade.
    if (this.shader) {
      this.mixCurrent += (this.mixTarget - this.mixCurrent) * 0.2;
      if (Math.abs(this.mixCurrent - this.mixTarget) < 0.0015) this.mixCurrent = this.mixTarget;
      this.shader.uniforms['uBiomeMix']!.value = this.mixCurrent;
    }

    this.pickHover();
    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  private disposeCurrent(): void {
    if (!this.current) return;
    for (const mesh of [this.current.terrain, this.current.water]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.current = null;
  }

  /** Tear down the renderer, controls, observers, and remove the canvas. */
  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.disposeCurrent();
    this.emitter.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
