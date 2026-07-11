// The framework-agnostic Vantage viewer engine. It owns a three.js renderer,
// scene, camera, and orbit controls; loads and frames a tile; runs the biome
// layer (textured<->biome crossfade + highlight) and hover-to-identify picking;
// and emits events. The React components are thin wrappers over this.

import * as THREE from 'three';
import { MapControls, type HeightSampler } from './controls.js';
import {
  biomePalette,
  maybeInflate,
  parseManifest,
  parseTextureArray,
  parseTile,
  summarizeBiomes,
  type BiomeEntry,
  type DecodedTextureArray,
  type DecodedTile,
  type SurfaceMap,
  type WorldManifest,
} from '../core/index.js';
import { Emitter } from './emitter.js';
import { createLowresMaterial, createSky, createTerrainMaterial, createWaterMaterial, SKY_HORIZON } from './materials.js';
import { pickBiome } from './pick.js';
import { buildTerrain } from './terrain.js';
import { TileManager, type TileStats } from './tiles.js';

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

/** Live, render-time display tuning — texture crispness, baked-AO strength,
 *  colour grade, haze, and render scale. All neutral by default (the shipped
 *  vanilla look); every knob takes effect immediately, no re-bake. */
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

/** The single, vanilla-faithful display look: neutral grade, full haze, native
 *  scale — clean flat-lit colours that read like the game. */
export const VANILLA_DISPLAY: Required<DisplaySettings> = {
  sharpness: 0,
  ao: 1,
  saturation: 1,
  contrast: 1,
  fog: 1,
  renderScale: 1,
};

const DEFAULT_DISPLAY: Required<DisplaySettings> = { ...VANILLA_DISPLAY };

/** The pitch (radians off top-down) the orbit view loads at and the "3D" tilt
 *  toggle returns to — a gentle aerial that reads relief without leaning toward
 *  the horizon. `0` = straight top-down (the "2D" toggle). */
export const DEFAULT_ORBIT_ANGLE = 0.42;

/** Streaming knobs for tiled worlds (the `world` load source). */
export interface StreamingSettings {
  /** Stream-in radius around the camera focus, in blocks. Default `768`. */
  viewDistance?: number;
  /** Hard cap on resident tiles (nearest win). Default `120`. */
  maxTiles?: number;
  /** Concurrent tile fetches. Default `4`. */
  concurrency?: number;
}

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
  /** Tile-streaming behaviour for `world` sources. */
  streaming?: StreamingSettings;
  /** Keep the camera state in the URL hash (`#@x,y,z,dist,rot,tilt`) so any
   *  view is a shareable deep link: the hash updates (debounced, via
   *  `history.replaceState`) as the camera moves, and a hash present at load —
   *  or pasted into the address bar — is applied to the camera. Default `false`
   *  (the React `<VantageViewer>` turns it on). */
  urlState?: boolean;
}

/** A tile source: a URL to fetch, a raw buffer, or already-decoded data. */
export type TileSource = string | ArrayBuffer | DecodedTile;
export type TextureSource = string | ArrayBuffer | DecodedTextureArray;

export interface LoadOptions {
  /** A tiled world to stream: the `manifest.json` URL. Takes precedence over `tile`. */
  world?: string;
  /** A single `.vtile` to render (the non-streaming path). */
  tile?: TileSource;
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
  /** Fired after a tile/world is loaded and framed. */
  load: TileInfo;
  /** Streaming totals changed (tiles loaded/unloaded). Streamed worlds only. */
  stats: TileStats;
  /** The aggregated biome legend changed as tiles streamed in/out. */
  biomes: BiomeEntry[];
  /** The biome id under the cursor, or `null` when off-terrain. */
  hover: number | null;
  /** Biome layer state changed. */
  biomelayer: { enabled: boolean; highlight: number | null };
  /** Camera control scheme changed (map ⇄ free-flight). */
  mode: { fly: boolean };
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.arrayBuffer();
}

// `maybeInflate` so single-tile mode accepts both meshtex output (raw) and
// render output (gzip-wrapped), matching the streaming path.
async function resolveTile(src: TileSource): Promise<DecodedTile> {
  if (typeof src === 'string') return parseTile(await maybeInflate(await fetchBuffer(src)));
  if (src instanceof ArrayBuffer) return parseTile(await maybeInflate(src));
  return src;
}

async function resolveTextures(src: TextureSource): Promise<DecodedTextureArray> {
  if (typeof src === 'string') return parseTextureArray(await maybeInflate(await fetchBuffer(src)));
  if (src instanceof ArrayBuffer) return parseTextureArray(await maybeInflate(src));
  return src;
}

function resolveContainer(container: HTMLElement | string): HTMLElement {
  const el = typeof container === 'string' ? document.querySelector<HTMLElement>(container) : container;
  if (!el) throw new Error(`vantage: container not found: ${String(container)}`);
  return el;
}

/** A lightly-smoothed terrain-height lookup over the tile's surface map, for the
 *  controls' terrain-riding pivot. A small 5×5 box (radius 2) takes the edge off
 *  block-to-block canopy noise without lifting the pivot off the surface at
 *  forest/water borders; the controls' temporal follow does the rest. Returns
 *  `null` outside the map / on all-empty windows. */
function makeHeightSampler(surface: SurfaceMap | undefined): HeightSampler | null {
  if (!surface) return null;
  const { width, depth, originX, originZ, height } = surface;
  const R = 2; // window radius in blocks
  return (x: number, z: number): number | null => {
    const cx = Math.floor(x - originX);
    const cz = Math.floor(z - originZ);
    let sum = 0;
    let n = 0;
    for (let dz = -R; dz <= R; dz++) {
      const zz = cz + dz;
      if (zz < 0 || zz >= depth) continue;
      const row = zz * width;
      for (let dx = -R; dx <= R; dx++) {
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

  // Anti-aliasing: the scene renders into an 8× multisampled offscreen target,
  // then a fullscreen pass copies the resolved result to the canvas. 8× (vs the
  // default framebuffer's driver-chosen ~4×) is what keeps high-frequency foliage
  // silhouettes and the alpha-to-coverage cutouts from crawling as the camera
  // moves. No GTAO/bloom/tonemap — purely AA + present.
  private msaa!: THREE.WebGLRenderTarget;
  private readonly present = new THREE.Scene();
  private readonly presentCamera = new THREE.Camera();
  private presentMaterial!: THREE.RawShaderMaterial;

  // Current tile state (single-tile mode).
  private tile: DecodedTile | null = null;
  private shader: THREE.ShaderMaterial | null = null;
  private bounds = new THREE.Box3();
  private current: { terrain: THREE.Mesh; water?: THREE.Mesh; lights?: THREE.Light[] } | null = null;
  private _biomes: BiomeEntry[] = [];

  // Streamed-world state (world/manifest mode). `tiles` doubles as the mode flag.
  private tiles: TileManager | null = null;
  private manifest: WorldManifest | null = null;
  private waterShader: THREE.ShaderMaterial | null = null;
  private lowresShader: THREE.ShaderMaterial | null = null;
  /** Populated world extent (max of X/Z spans), for whole-world zoom limits. */
  private worldSpan = 0;
  private tilesUnsub: (() => void) | null = null;
  private lastBiomesEmit = 0;

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

  // URL-hash deep links (urlState option): debounce handle for hash writes and
  // the last hash we wrote (so a hashchange we caused isn't re-applied).
  private hashTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWrittenHash = '';
  private urlUnsub: (() => void) | null = null;

  constructor(container: HTMLElement | string, options: VantageViewerOptions = {}) {
    this.container = resolveContainer(container);
    this.options = {
      view: options.view ?? 'orbit',
      antialias: options.antialias ?? true,
      maxPixelRatio: options.maxPixelRatio ?? 2,
      light: options.light ?? {},
      display: options.display ?? {},
      streaming: options.streaming ?? {},
      urlState: options.urlState ?? false,
    };
    if (options.light) this.light = { ...this.light, ...options.light };
    if (options.display) this.display = { ...this.display, ...options.display };

    // MSAA lives on an offscreen target (see buildAA / frame), so the canvas
    // context itself doesn't need antialiasing. The terrain/sky shaders light in
    // linear and sRGB-encode their own output (raw ShaderMaterial uniforms skip
    // three's colour management), writing display-ready sRGB into the target.
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

    // FOV 75 — a wider lens than a "photographic" 60° gives the
    // perspective convergence that reads as a real 3D view over the world rather
    // than a flat isometric map. Framing compensates (see fitDistance).
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.5, 8000);
    // Map navigation: left-drag grabs and pans the ground,
    // right-drag (or alt+left) orbits — horizontal rotates, vertical tilts —
    // wheel zooms. Everything carries inertia; tilt auto-flattens to top-down as
    // you zoom out, and the pivot rides the terrain surface. See controls.ts.
    this.controls = new MapControls(this.camera, this.renderer.domElement, { minDistance: 3 });

    this.bindInput();
    if (this.options.urlState) this.bindUrlState();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();

    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Build the offscreen multisampled target and the fullscreen present pass.
   *  The scene already writes display-ready sRGB, so present is a raw passthrough
   *  drawn over one oversized clip-space triangle. */
  private buildAA(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.msaa = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      samples: this.options.antialias ? 8 : 0,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
    });
    this.msaa.texture.colorSpace = THREE.NoColorSpace; // already sRGB bytes — don't reinterpret
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

  /** Construct a viewer and load a tile in one call. */
  static async mount(container: HTMLElement | string, options: VantageViewerOptions & LoadOptions): Promise<VantageViewer> {
    const { tile, textures, view, ...rest } = options;
    const viewer = new VantageViewer(container, { ...rest, ...(view ? { view } : {}) });
    await viewer.load({ tile, textures, view });
    return viewer;
  }

  /** Load (fetch/decode as needed), build, and frame a tile or a streamed world. */
  async load(opts: LoadOptions): Promise<void> {
    if (opts.world) return this.loadWorld(opts.world, opts.view ?? this.options.view);
    if (!opts.tile) throw new Error('vantage: load needs a `world` manifest URL or a `tile` source');
    const tile = await resolveTile(opts.tile);
    const textures = opts.textures ? await resolveTextures(opts.textures) : undefined;
    this.setTile(tile, textures, opts.view ?? this.options.view);
  }

  /** Stream a tiled world render from its `manifest.json`. Tiles load around
   *  the camera as it moves and unload behind it; the whole world is reachable
   *  without ever holding more than the streaming budget in memory. */
  private async loadWorld(url: string, view: ViewMode): Promise<void> {
    const abs = new URL(url, typeof document !== 'undefined' ? document.baseURI : undefined).toString();
    const res = await fetch(abs);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${abs}`);
    const manifest = parseManifest(await res.json());
    const texData = parseTextureArray(await maybeInflate(await fetchBuffer(new URL(manifest.textures, abs).toString())));

    this.disposeCurrent();
    const palette = biomePalette(manifest.biomes.length);
    // Quantized mode: tiles upload their on-disk u16/i8 encoding verbatim and
    // the shader dequantizes, so decode costs no main-thread time (see terrain.ts).
    const shader = createTerrainMaterial(texData, { quantized: true, palette });
    const waterShader = createWaterMaterial(shader);
    shader.uniforms['uFogRadial']!.value = 1.0; // fog radially from the focus, not by view depth
    // Lowres pyramid (format 2): coarse whole-world rings under the hires disc.
    const lowresShader = manifest.lowres ? createLowresMaterial(shader) : undefined;
    this.shader = shader;
    this.waterShader = waterShader;
    this.lowresShader = lowresShader ?? null;
    this.manifest = manifest;
    this.tile = null;
    this.tiles = new TileManager({
      manifest,
      baseUrl: abs,
      scene: this.scene,
      material: shader,
      waterMaterial: waterShader,
      ...(lowresShader ? { lowresMaterial: lowresShader } : {}),
      palette,
      ...this.options.streaming,
    });

    // The pivot rides the streamed terrain; picking and the legend aggregate
    // across whatever is resident.
    this.controls.heightAt = this.tiles.heightAt;
    this.tilesUnsub = this.tiles.on('change', (stats) => {
      this.emitter.emit('stats', stats);
      // The legend settles as tiles stream; throttle the churn, then always
      // emit the final state once the queue drains.
      const now = performance.now();
      if (stats.loading === 0 || now - this.lastBiomesEmit > 500) {
        this.lastBiomesEmit = now;
        this._biomes = this.tiles!.biomes;
        this.emitter.emit('biomes', this._biomes);
      }
    });

    this.frameWorld(manifest, view);
    // A deep link overrides the default framing (the home button still returns
    // to the framed view). Applied before seeding so tiles stream in there.
    if (this.options.urlState) this.applyViewHash(window.location.hash);
    this.applyBiomeUniforms();
    this.applyLight();
    this.applyDisplay();

    // Seed streaming at the framed pivot so the first tiles arrive immediately.
    this.tiles.update(this.controls.position.x, this.controls.position.z);

    const size = new THREE.Vector3();
    this.bounds.getSize(size);
    this._biomes = [];
    this.emitter.emit('load', {
      magic: 'VTL6',
      vertexCount: 0,
      triangleCount: 0,
      size,
      biomes: this._biomes,
    });
  }

  /** Frame a streamed world: pivot on the spawn point when the manifest has
   *  one (that's where the builds are), else the centre of the tile extents.
   *  Distances are tied to the streaming view distance, not the world size —
   *  a 100k×100k world frames the same as a village. */
  private frameWorld(manifest: WorldManifest, view: ViewMode): void {
    const tb = manifest.tileBlocks;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const t of manifest.tiles) {
      minX = Math.min(minX, t.x * tb);
      minZ = Math.min(minZ, t.z * tb);
      maxX = Math.max(maxX, (t.x + 1) * tb);
      maxZ = Math.max(maxZ, (t.z + 1) * tb);
    }
    if (!Number.isFinite(minX)) {
      minX = minZ = 0;
      maxX = maxZ = tb;
    }
    this.bounds.set(new THREE.Vector3(minX, -64, minZ), new THREE.Vector3(maxX, 320, maxZ));
    this.worldSpan = Math.max(maxX - minX, maxZ - minZ);

    const viewDistance = this.tiles?.viewDistance ?? this.options.streaming.viewDistance ?? 768;
    const spawn = manifest.spawn;
    const pivot = spawn
      ? new THREE.Vector3(spawn.x, spawn.y, spawn.z)
      : new THREE.Vector3((minX + maxX) / 2, 80, (minZ + maxZ) / 2);

    const span = Math.min(Math.max(maxX - minX, maxZ - minZ), viewDistance * 1.1);
    let distance: number;
    let angle: number;
    if (view === 'top') {
      distance = this.fitDistance(span) * 1.04;
      angle = 0;
    } else {
      distance = this.fitDistance(Math.min(span, 560)) * 0.72;
      angle = DEFAULT_ORBIT_ANGLE;
    }
    const h = this.controls.heightAt?.(pivot.x, pivot.z);
    if (h != null) pivot.y = h + 3;
    this.controls.setView({ position: pivot, distance, rotation: 0, angle, floorY: pivot.y });
    this.framedState = { position: pivot.clone(), distance, rotation: 0, angle, floorY: pivot.y };

    this.applyViewLimits();
  }

  /** The radius hires tiles are actually guaranteed resident to: the view
   *  distance, unless the tile budget runs out first (nearest-first fill ⇒ a
   *  disc of maxTiles tiles ⇒ radius tb·√(maxTiles/π)). */
  private streamRadius(): number {
    const vd = this.tiles?.viewDistance ?? this.options.streaming.viewDistance ?? 768;
    const mt = this.tiles?.maxTiles ?? this.options.streaming.maxTiles ?? 120;
    const tb = this.manifest?.tileBlocks ?? 128;
    return Math.min(vd, tb * Math.sqrt(mt / Math.PI));
  }

  /** Zoom range, far plane, and fog for a streamed world.
   *
   *  With a lowres pyramid (format 2) the whole world is drawable, so zoom-out
   *  is bounded by the world extent, the far plane covers it, and the radial
   *  fog retreats to the world edge — a faint horizon haze, never a wall. The
   *  hires→lowres seam needs no hiding: finer data simply overlays coarser.
   *
   *  Without one (format 1), zoom and fog hug the hires ring so the map never
   *  becomes a field of holes: solid haze right where tiles stop. */
  private applyViewLimits(): void {
    if (!this.tiles || !this.shader) return;
    const viewDistance = this.tiles.viewDistance;
    const fog = this.shader.uniforms['uFog']!.value as THREE.Vector2;
    if (this.manifest?.lowres) {
      const span = Math.max(this.worldSpan, viewDistance * 2);
      this.controls.maxDistance = Math.min(Math.max(span * 0.9, viewDistance * 2.2), 60000);
      this.camera.far = Math.min(Math.max(8000, span * 2.5), 250000);
      fog.set(span * 0.9, span * 1.8);
    } else {
      const r = this.streamRadius();
      this.controls.maxDistance = viewDistance * 2.2;
      this.camera.far = Math.max(8000, viewDistance * 6);
      fog.set(r * 0.72, r * 1.05);
    }
    this.camera.updateProjectionMatrix();
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
      const hemi = new THREE.HemisphereLight(0xbcd7ff, 0x4a4636, 1.0);
      const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
      sun.position.set(0.6, 1.0, 0.35);
      this.scene.add(hemi, sun);
      // Tracked so a reload removes them — re-adding on every setTile would
      // stack suns and overbrighten.
      this.current.lights = [hemi, sun];
    }

    // Let the controls' pivot ride the terrain surface, from
    // the same top-down heightmap the biome picker uses.
    this.controls.heightAt = makeHeightSampler(tile.surface);
    this._biomes = summarizeBiomes(tile, built.palette);
    this.frameCamera(view);
    if (this.options.urlState) this.applyViewHash(window.location.hash);
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

  /** Camera-to-pivot distance that vertically fits a world span of `s` blocks at
   *  the current FOV, so framing is FOV-independent: widening the lens (60→75)
   *  doesn't silently zoom the load view out. The callers' multipliers preserve
   *  the previously-tuned on-screen framing. */
  private fitDistance(s: number): number {
    return (s * 0.5) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
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
      distance = this.fitDistance(span) * 1.04;
      rotation = 0;
      angle = 0; // straight top-down
    } else {
      // Aim at the land (not the volume's centre — that can sit out over ocean,
      // and the surface lives near the top of a tall box with caves far below).
      const land = this.landTarget(center, size);
      const surfaceY = this.bounds.max.y - size.y * 0.18;
      pivot.set(land.x, surfaceY, land.z);
      // A gentle aerial: tilted ~24° off top-down to read relief, but kept
      // NORTH-UP (looking from due south) so the square world reads edge-on and
      // straight, not as a corner-on diamond — a 45° heading makes every shore
      // and tile edge run diagonally and the whole view feel crooked.
      distance = this.fitDistance(land.span) * 0.72;
      rotation = 0;
      angle = DEFAULT_ORBIT_ANGLE;
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
    if (!this.shader) return;
    const d = this.display;
    this.shader.uniforms['uSharpness']!.value = d.sharpness;
    this.shader.uniforms['uAoStrength']!.value = d.ao;
    this.shader.uniforms['uSaturation']!.value = d.saturation;
    this.shader.uniforms['uContrast']!.value = d.contrast;
    this.shader.uniforms['uFogDensity']!.value = d.fog;
  }

  // --- streaming -------------------------------------------------------------

  /** The current streaming settings (view distance, tile budget, concurrency). */
  get streamingSettings(): Required<StreamingSettings> {
    return {
      viewDistance: this.tiles?.viewDistance ?? this.options.streaming.viewDistance ?? 768,
      maxTiles: this.tiles?.maxTiles ?? this.options.streaming.maxTiles ?? 120,
      concurrency: this.options.streaming.concurrency ?? 4,
    };
  }

  /** Live-tune streaming: view distance, resident-tile budget, concurrency.
   *  Applies immediately to a streamed world (tiles re-plan, fog and camera
   *  range follow) and persists for future loads. The fidelity dial: raise
   *  viewDistance/maxTiles to see farther, lower them on weak hardware. */
  setStreaming(settings: StreamingSettings): void {
    this.options.streaming = { ...this.options.streaming, ...settings };
    if (!this.tiles) return;
    this.tiles.configure(settings);
    this.applyViewLimits();
  }

  // --- URL-hash deep links ----------------------------------------------------

  /** The current view serialized as a `#@x,y,z,dist,rot,tilt` hash fragment —
   *  paste-able into any URL serving the same world. */
  getViewHash(): string {
    const p = this.controls.position;
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    return `#@${r1(p.x)},${r1(p.y)},${r1(p.z)},${r1(this.controls.distance)},${r3(this.controls.rotation)},${r3(this.controls.angle)}`;
  }

  /** Apply a `#@x,y,z,dist,rot,tilt` hash to the camera (leading `#` optional).
   *  Returns whether the hash parsed. */
  applyViewHash(hash: string): boolean {
    const m = /^#?@(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),([\d.]+),(-?[\d.]+),(-?[\d.]+)$/.exec(hash);
    if (!m) return false;
    const [x, y, z, distance, rotation, angle] = m.slice(1).map(Number);
    if (![x, y, z, distance, rotation, angle].every(Number.isFinite)) return false;
    this.controls.setView({
      position: new THREE.Vector3(x, y, z),
      distance: distance!,
      rotation: rotation!,
      angle: angle!,
      floorY: y!,
    });
    return true;
  }

  /** Debounced camera→hash sync plus hashchange→camera (pasted links apply
   *  live). `history.replaceState` avoids history spam and hashchange echo. */
  private bindUrlState(): void {
    const onChange = () => {
      if (this.hashTimer !== null) clearTimeout(this.hashTimer);
      this.hashTimer = setTimeout(() => this.writeHash(), 250);
    };
    this.controls.addEventListener('change', onChange);
    const onHash = () => {
      if (window.location.hash === this.lastWrittenHash) return;
      this.applyViewHash(window.location.hash);
    };
    window.addEventListener('hashchange', onHash);
    this.urlUnsub = () => {
      this.controls.removeEventListener('change', onChange);
      window.removeEventListener('hashchange', onHash);
      if (this.hashTimer !== null) clearTimeout(this.hashTimer);
      this.hashTimer = null;
    };
  }

  private writeHash(): void {
    const hash = this.getViewHash();
    if (hash === this.lastWrittenHash) return;
    this.lastWrittenHash = hash;
    history.replaceState(null, '', hash);
  }

  // --- camera / navigation ---------------------------------------------------

  /** Smoothly zoom by `steps` wheel-notches (positive = in). Drives the same
   *  inertial zoom as the wheel, so on-screen buttons feel identical. */
  zoomBy(steps: number): void {
    this.controls.zoom(steps);
  }

  /** Smoothly rotate the view back to north, keeping the current tilt and
   *  position. For the compass click. */
  resetNorth(): void {
    this.controls.animateTo({ rotation: 0 });
  }

  /** Smoothly set the pitch (radians off top-down): `0` = top-down map ("2D"),
   *  {@link DEFAULT_ORBIT_ANGLE} = the gentle aerial ("3D"). The tilt control. */
  setTilt(angle: number): void {
    this.controls.animateTo({ angle });
  }

  /** Smoothly drop to a clean, north-up top-down map (the "2D" toggle): levels
   *  the tilt and straightens the heading so the world is axis-aligned. */
  flatten(): void {
    this.controls.animateTo({ angle: 0, rotation: 0 });
  }

  /** The current pitch in radians (0 = top-down), for a tilt toggle's state. */
  get tilt(): number {
    return this.controls.angle;
  }

  /** Smoothly return to the framing the tile loaded into (the home button). */
  resetView(): void {
    if (this.framedState) this.controls.animateTo(this.framedState);
  }

  /** Whether the free-flight (spectator) camera is active. */
  get isFlying(): boolean {
    return this.controls.flyMode;
  }

  /** Enter or leave free-flight. In fly mode the camera becomes a first-person
   *  spectator: WASD to move, space/shift up-down, mouse (click to capture) to
   *  look, wheel to trim speed. Emits `'mode'`. */
  setFlyMode(on: boolean): void {
    if (this.controls.flyMode === on) return;
    this.controls.setMode(on ? 'fly' : 'map');
    if (on) this.emitHover(-1);
    this.emitter.emit('mode', { fly: on });
  }

  /** Toggle free-flight on/off. */
  toggleFly(): void {
    this.setFlyMode(!this.controls.flyMode);
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
    if (this.controls.flyMode) {
      this.emitHover(-1); // no biome hover while flying (pointer is captured/centred)
      return;
    }
    if (this.dragging || !this.pointerDirty) return; // at most once per frame, never mid-drag
    this.pointerDirty = false;
    if (!this.pointerInside) {
      this.emitHover(-1);
      return;
    }
    if (this.tiles) {
      this.raycaster.setFromCamera(this.ndc, this.camera);
      this.emitHover(this.tiles.pickBiome(this.raycaster.ray));
      return;
    }
    const surface = this.tile?.surface;
    if (!surface) {
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

    // Streamed worlds: re-plan tile residency around wherever the user is
    // looking (the map pivot, or the eye itself in free-flight).
    if (this.tiles) {
      const focus = this.controls.flyMode ? this.camera.position : this.controls.position;
      this.tiles.update(focus.x, focus.z);
      // Radial fog tracks the same focus streaming plans around, so the clear
      // disc and the resident disc stay concentric.
      if (this.shader) (this.shader.uniforms['uFogCenter']!.value as THREE.Vector2).set(focus.x, focus.z);
    }

    // Ease the textured<->biome crossfade, and advance the water-animation clock.
    if (this.shader) {
      this.mixCurrent += (this.mixTarget - this.mixCurrent) * 0.2;
      if (Math.abs(this.mixCurrent - this.mixTarget) < 0.0015) this.mixCurrent = this.mixTarget;
      this.shader.uniforms['uBiomeMix']!.value = this.mixCurrent;
    }

    this.pickHover();
    // Render the scene into the 8× MSAA target, then resolve+copy it to the
    // canvas. autoClear is off, so clear the target explicitly each frame.
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
    // devicePixelRatio changes with monitor moves and browser zoom without a
    // container resize necessarily following — re-apply it on every resize so
    // the framebuffer tracks the display.
    this.renderer.setPixelRatio(this.targetPixelRatio());
    this.renderer.setSize(w, h, false);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.msaa.setSize(Math.max(1, size.x), Math.max(1, size.y));
  }

  private disposeCurrent(): void {
    // The viewer created every material and texture it holds — single-tile ones
    // inside buildTerrain (setTile), streaming ones in loadWorld — so it owns
    // their GPU memory in both modes and must release it on reload/dispose.
    if (this.current) {
      for (const mesh of [this.current.terrain, this.current.water]) {
        if (!mesh) continue;
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
      }
      for (const light of this.current.lights ?? []) this.scene.remove(light);
      this.current = null;
    }
    if (this.tiles) {
      this.tilesUnsub?.();
      this.tilesUnsub = null;
      this.tiles.dispose();
      this.tiles = null;
      this.manifest = null;
    }
    if (this.shader) {
      (this.shader.uniforms['map']?.value as THREE.Texture | null)?.dispose();
      (this.shader.uniforms['uPalette']?.value as THREE.Texture | null)?.dispose();
      this.shader.dispose();
      this.shader = null;
    }
    if (this.waterShader) {
      this.waterShader.dispose();
      this.waterShader = null;
    }
    if (this.lowresShader) {
      this.lowresShader.dispose();
      this.lowresShader = null;
    }
    this.controls.heightAt = null;
  }

  /** Tear down the renderer, controls, observers, and remove the canvas. */
  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.urlUnsub?.();
    this.urlUnsub = null;
    this.controls.dispose();
    this.disposeCurrent();
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
