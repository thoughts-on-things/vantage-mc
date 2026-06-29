// The framework-agnostic Vantage viewer engine. It owns a three.js renderer,
// scene, camera, and orbit controls; loads and frames a tile; runs the biome
// layer (textured<->biome crossfade + highlight) and hover-to-identify picking;
// and emits events. The React components are thin wrappers over this.

import * as THREE from 'three';
import { MapControls, type HeightSampler } from './controls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  parseTextureArray,
  parseTile,
  summarizeBiomes,
  type BiomeEntry,
  type DecodedTextureArray,
  type DecodedTile,
  type SurfaceMap,
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
  /** Screen-space (GTAO) contact-shadow intensity, 0..1. 0 disables the pass.
   *  Adds the "raytraced" depth in crevices. Default `1`. */
  gtao?: number;
  /** GTAO sample radius in blocks (how far contact shadows reach). Default `2.5`. */
  aoRadius?: number;
  /** Bloom strength (glow on bright highlights/water). 0 disables. Default `0.3`. */
  bloom?: number;
  /** Bloom luminance threshold, 0..1 (higher = only the brightest bloom). Default `0.8`. */
  bloomThreshold?: number;
  /** ACES tone-mapping exposure (cinematic tone curve). 1 = neutral. Default `1`. */
  toneExposure?: number;
  /** Tone-mapping curve. `'agx'` = filmic (cinematic); `'none'` = flat linear→sRGB
   *  for vanilla/BlueMap-accurate colours. Default `'agx'`. */
  tonemap?: 'agx' | 'none';
}

/** A named look. `'cinematic'` = the filmic default (AgX + GTAO + bloom);
 *  `'vanilla'` = flat, colour-accurate, matching vanilla Minecraft / BlueMap. */
export type RenderMode = 'cinematic' | 'vanilla';

/** The cinematic preset (shipped default): AgX tone map, GTAO contact shadows,
 *  subtle bloom. AgX desaturates (esp. greens) so saturation + a touch of
 *  contrast are pushed up to compensate. */
export const CINEMATIC_DISPLAY: Required<DisplaySettings> = {
  sharpness: 0,
  ao: 1,
  saturation: 1.35,
  contrast: 1.06,
  fog: 1,
  // 1.5× supersampling (BlueMap's `superSampling` lever) — the real fix for the
  // high-frequency foliage shimmer in motion, at ~2.25× fragment cost. Vanilla
  // keeps 1× for speed; both are dial-adjustable.
  renderScale: 1.5,
  gtao: 1,
  aoRadius: 2.5,
  bloom: 0.35,
  bloomThreshold: 0.8,
  toneExposure: 1.05,
  tonemap: 'agx',
};

/** The vanilla/BlueMap preset: no tone curve, no GTAO, no bloom, neutral grade —
 *  clean flat-lit colours that read like the game / a BlueMap render. Turning off
 *  GTAO also removes its per-frame noise (the foliage shimmer while moving). */
export const VANILLA_DISPLAY: Required<DisplaySettings> = {
  sharpness: 0,
  ao: 1,
  saturation: 1,
  contrast: 1,
  fog: 1,
  renderScale: 1,
  gtao: 0,
  aoRadius: 2.5,
  bloom: 0,
  bloomThreshold: 0.8,
  toneExposure: 1,
  tonemap: 'none',
};

/** Presets keyed by mode, for the UI mode toggle. */
export const DISPLAY_PRESETS: Record<RenderMode, Required<DisplaySettings>> = {
  cinematic: CINEMATIC_DISPLAY,
  vanilla: VANILLA_DISPLAY,
};

// Ship the flat, colour-accurate vanilla/BlueMap look by default; the cinematic
// filmic grade is one toggle away in the fidelity panel.
const DEFAULT_DISPLAY: Required<DisplaySettings> = { ...VANILLA_DISPLAY };

/** Above this vertex count GTAO's per-frame geometry re-render is too costly, so
 *  it auto-disables (the user can still force it via the dial if they accept the
 *  cost — see `applyDisplay`). */
const GTAO_VERTEX_BUDGET = 3_500_000;

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

/** A *smoothed* terrain-height lookup over the tile's surface map, for the
 *  controls' terrain-riding pivot. Averages a small window so the pivot rides the
 *  mean surface instead of bobbing block-to-block over forest canopy (the surface
 *  map records treetop height) — the difference between a smooth pan and a jittery
 *  one. Returns `null` outside the map / on all-empty windows so the controls can
 *  relax toward the floor. */
function makeHeightSampler(surface: SurfaceMap | undefined): HeightSampler | null {
  if (!surface) return null;
  const { width, depth, originX, originZ, height } = surface;
  const R = 4; // window radius in blocks (low-passes canopy noise)
  return (x: number, z: number): number | null => {
    const cx = Math.floor(x - originX);
    const cz = Math.floor(z - originZ);
    let sum = 0;
    let n = 0;
    for (let dz = -R; dz <= R; dz += 2) {
      const zz = cz + dz;
      if (zz < 0 || zz >= depth) continue;
      const row = zz * width;
      for (let dx = -R; dx <= R; dx += 2) {
        const xx = cx + dx;
        if (xx < 0 || xx >= width) continue;
        const h = height[row + xx]!;
        if (h < 1) continue; // empty-column sentinel
        sum += h;
        n++;
      }
    }
    return n === 0 ? null : sum / n;
  };
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

  // Post-processing pipeline: RenderPass → GTAO → bloom → OutputPass (tonemap +
  // encode). `aoCamera` mirrors the main camera but renders only layer 0 (opaque
  // terrain) so the camera-locked sky dome and translucent water don't occlude
  // GTAO's depth/normal prepass.
  private composer!: EffectComposer;
  private renderPass!: RenderPass;
  private gtaoPass!: GTAOPass;
  private bloomPass!: UnrealBloomPass;
  private outputPass!: OutputPass;
  private readonly aoCamera = new THREE.PerspectiveCamera();
  private postEnabled = true;
  private gtaoHeavy = false; // current tile exceeds the GTAO vertex budget

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

  // Last-frame timestamp, for frame-rate-independent control inertia.
  private lastFrameMs = 0;
  // The framing the current tile loaded into, so the UI can re-home to it.
  private framedState: { position: THREE.Vector3; distance: number; rotation: number; angle: number; floorY: number } | null = null;

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

    // MSAA lives on the composer's render target now, not the default framebuffer.
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(this.targetPixelRatio());
    // Cinematic colour pipeline: shaders light in linear and output HDR; the
    // OutputPass applies AgX tone mapping (gentler than ACES, keeps the pixel-art
    // palette punchy) then sRGB-encodes. The terrain/sky shaders sRGB-decode their
    // textures/tints themselves (raw ShaderMaterial uniforms skip colour mgmt).
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = this.display.toneExposure;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(...SKY_HORIZON);
    this.sky = createSky();
    this.sky.layers.set(1); // layer 1 = excluded from GTAO's depth/normal prepass
    this.scene.add(this.sky);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.5, 8000);
    this.camera.layers.enable(1); // beauty camera sees terrain (0) + sky/water (1)
    // BlueMap-faithful map navigation: left-drag grabs and pans the ground,
    // right-drag (or alt+left) orbits — horizontal rotates, vertical tilts —
    // wheel zooms. Everything carries inertia; tilt auto-flattens to top-down as
    // you zoom out, and the pivot rides the terrain surface. See controls.ts.
    this.controls = new MapControls(this.camera, this.renderer.domElement, { minDistance: 3 });

    this.bindInput();
    this.buildComposer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();

    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Build the post-processing pipeline: a multisampled HDR target (so MSAA +
   *  alpha-to-coverage survive), then RenderPass → GTAO → bloom → OutputPass. */
  private buildComposer(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    // 8× MSAA (GPU-clamped): the high-frequency foliage silhouette is the worst
    // shimmer source when the camera moves, and more coverage samples smooth those
    // edges (and the alpha-to-coverage cutouts), cutting the frame-to-frame crawl.
    const samples = this.options.antialias ? 8 : 0;
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.gtaoPass = new GTAOPass(this.scene, this.aoCamera, size.x, size.y);
    this.gtaoPass.output = GTAOPass.OUTPUT.Default;
    this.gtaoPass.updateGtaoMaterial({ radius: this.display.aoRadius, distanceExponent: 1, thickness: 1, scale: 1, samples: 8 });
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), this.display.bloom, 0.5, this.display.bloomThreshold);
    this.outputPass = new OutputPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.gtaoPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.outputPass);
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
    if (built.water) {
      built.water.layers.set(1); // exclude translucent water from GTAO's prepass
      this.scene.add(built.water);
    }
    this.current = { terrain: built.terrain, water: built.water };
    // GTAO re-renders the whole geometry every frame; on very large tiles that's
    // too costly, so auto-disable it past a vertex budget (the dial still shows).
    this.gtaoHeavy = tile.vertexCount + (tile.fluid?.vertexCount ?? 0) > GTAO_VERTEX_BUDGET;

    if (built.requiresSceneLights) {
      this.scene.add(new THREE.HemisphereLight(0xbcd7ff, 0x4a4636, 1.0));
      const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
      sun.position.set(0.6, 1.0, 0.35);
      this.scene.add(sun);
    }

    // Let the controls' pivot ride the terrain surface (BlueMap's feel), from
    // the same top-down heightmap the biome picker uses.
    this.controls.heightAt = makeHeightSampler(tile.surface);
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

  /** Where the *land* is, from the surface heightmap: the elevation-weighted
   *  centroid (so flat ocean is ignored) and the span of the elevated region.
   *  Falls back to the geometric centre for tiles without a surface map. Keeps
   *  the demo's first frame on the interesting terrain, not out over the water. */
  private landTarget(center: THREE.Vector3, size: THREE.Vector3): { x: number; z: number; span: number } {
    const s = this.tile?.surface;
    const names = this.tile?.biomeNames;
    const fallback = { x: center.x, z: center.z, span: Math.max(size.x, size.z) };
    if (!s) return fallback;
    const { width, depth, originX, originZ, height, biome } = s;
    // Centre on the dry landmass: skip empty columns and water biomes (ocean/
    // river), then take the plain centroid + extent of what's left. Robust to
    // ocean-heavy worlds and not biased toward the tallest peaks.
    let n = 0;
    let sx = 0;
    let sz = 0;
    let minx = Infinity;
    let maxx = -Infinity;
    let minz = Infinity;
    let maxz = -Infinity;
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        const i = z * width + x;
        if (height[i]! < 1) continue; // empty-column sentinel
        const nm = names?.[biome[i]!] ?? '';
        if (nm.includes('ocean') || nm.includes('river')) continue; // water, not land
        const wx = originX + x;
        const wz = originZ + z;
        n++;
        sx += wx;
        sz += wz;
        if (wx < minx) minx = wx;
        if (wx > maxx) maxx = wx;
        if (wz < minz) minz = wz;
        if (wz > maxz) maxz = wz;
      }
    }
    if (n < 16) return fallback; // almost all water ⇒ just frame the whole thing
    return { x: sx / n, z: sz / n, span: Math.max(maxx - minx, maxz - minz, 48) * 1.15 };
  }

  private frameCamera(view: ViewMode): void {
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    this.bounds.getCenter(center);
    this.bounds.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    this.controls.maxDistance = maxDim * 4; // bound zoom-out to the world extent

    const pivot = new THREE.Vector3();
    let distance: number;
    let rotation: number;
    let angle: number;
    if (view === 'top') {
      const span = Math.max(size.x, size.z);
      pivot.set(center.x, this.bounds.max.y, center.z);
      distance = span * 0.9;
      rotation = 0;
      angle = 0; // straight top-down
    } else {
      // Aim at the land (not the volume's centre — that can sit out over ocean,
      // and the surface lives near the top of a tall box with caves far below).
      const land = this.landTarget(center, size);
      const surfaceY = this.bounds.max.y - size.y * 0.18;
      pivot.set(land.x, surfaceY, land.z);
      // A gentle aerial: mostly map-like, tilted just ~24° off top-down to read
      // relief without an awkward near-horizon lean, looking from the south-east.
      distance = land.span * 0.62;
      rotation = -Math.PI / 4;
      angle = 0.42;
    }
    // Start the pivot on the actual surface beneath it so there's no settle on
    // load; the controls keep it riding the terrain from here.
    const h = this.controls.heightAt?.(pivot.x, pivot.z);
    if (h != null) pivot.y = h + 3;
    this.controls.setView({ position: pivot, distance, rotation, angle, floorY: pivot.y });
    this.framedState = { position: pivot.clone(), distance, rotation, angle, floorY: pivot.y };

    this.camera.far = maxDim * 12;
    this.camera.updateProjectionMatrix();

    // Fog fades the far edge into the horizon for depth, but kept well back so the
    // map itself reads crisply at the default framing (the haze dial tightens it).
    if (this.shader) this.shader.uniforms['uFog']!.value.set(maxDim * 1.2, maxDim * 3.2);
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
    // Post-processing passes (exist regardless of whether a tile is loaded).
    const d = this.display;
    if (this.gtaoPass) {
      this.gtaoPass.enabled = d.gtao > 0 && !this.gtaoHeavy;
      this.gtaoPass.blendIntensity = d.gtao;
      this.gtaoPass.updateGtaoMaterial({ radius: d.aoRadius });
    }
    if (this.bloomPass) {
      this.bloomPass.enabled = d.bloom > 0;
      this.bloomPass.strength = d.bloom;
      this.bloomPass.threshold = d.bloomThreshold;
    }
    // Vanilla/BlueMap mode renders flat (linear→sRGB only); cinematic applies the
    // AgX filmic curve. OutputPass reads renderer.toneMapping each frame.
    this.renderer.toneMapping = d.tonemap === 'none' ? THREE.NoToneMapping : THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = d.toneExposure;

    if (!this.shader) return;
    this.shader.uniforms['uSharpness']!.value = d.sharpness;
    this.shader.uniforms['uAoStrength']!.value = d.ao;
    this.shader.uniforms['uSaturation']!.value = d.saturation;
    this.shader.uniforms['uContrast']!.value = d.contrast;
    this.shader.uniforms['uFogDensity']!.value = d.fog;
  }

  // --- camera / navigation ---------------------------------------------------

  /** Smoothly zoom by `steps` wheel-notches (positive = in). Drives the same
   *  inertial zoom as the wheel, so on-screen buttons feel identical. */
  zoomBy(steps: number): void {
    this.controls.zoom(steps);
  }

  /** Smoothly rotate the view back to north (and level any tilt-only request is
   *  left intact). For the compass click. */
  resetNorth(): void {
    this.controls.animateTo({ rotation: 0 });
  }

  /** Smoothly return to the framing the tile loaded into (the home button). */
  resetView(): void {
    if (this.framedState) this.controls.animateTo(this.framedState);
  }

  // --- events ---------------------------------------------------------------

  on<K extends keyof ViewerEvents>(event: K, listener: (payload: ViewerEvents[K]) => void): () => void {
    return this.emitter.on(event, listener);
  }

  // --- internals ------------------------------------------------------------

  private bindInput(): void {
    const dom = this.renderer.domElement;
    dom.style.cursor = 'grab'; // affordance: the map is draggable
    dom.style.touchAction = 'none';
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
    // Skip picking while orbiting/panning so interaction stays perfectly smooth,
    // and show a "grabbing" cursor for the duration of the drag.
    this.controls.addEventListener('start', () => {
      this.dragging = true;
      dom.style.cursor = 'grabbing';
      this.emitHover(-1);
    });
    this.controls.addEventListener('end', () => {
      this.dragging = false;
      dom.style.cursor = 'grab';
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
    const now = performance.now();
    const dtMs = this.lastFrameMs ? now - this.lastFrameMs : 16.7;
    this.lastFrameMs = now;
    this.controls.update(dtMs);
    this.sky.position.copy(this.camera.position); // keep the dome centred on the eye

    // Ease the textured<->biome crossfade, and advance the water-animation clock.
    if (this.shader) {
      this.mixCurrent += (this.mixTarget - this.mixCurrent) * 0.2;
      if (Math.abs(this.mixCurrent - this.mixTarget) < 0.0015) this.mixCurrent = this.mixTarget;
      this.shader.uniforms['uBiomeMix']!.value = this.mixCurrent;
    }

    this.pickHover();
    if (this.postEnabled) {
      // GTAO's depth/normal prepass uses aoCamera; restrict it to layer 0 (opaque
      // terrain) so the sky dome and translucent water don't occlude the AO.
      this.aoCamera.copy(this.camera);
      this.aoCamera.layers.set(0);
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  private resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
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
    this.composer.dispose();
    this.gtaoPass.dispose();
    this.bloomPass.dispose();
    this.emitter.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
