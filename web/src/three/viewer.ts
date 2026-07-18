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
  type WorldSource,
  worldFromUrl,
} from '../core/index.js';
import { Emitter } from './emitter.js';
import { createLightmappedMaterial, createLowresMaterial, createSky, createTerrainMaterial, createWaterMaterial, updateTerrainTextures, SKY_HORIZON } from './materials.js';
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
  /** Estimated CPU/GPU tile residency budget, in bytes. Default `512 MiB`. */
  maxBytes?: number;
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
  /** Render only when something changed (camera, streaming tiles, settings) —
   *  plus a steady ~10 fps tick while animated textures (water, lava) are
   *  loaded, matching their baked 2-tick frametime. An idle view costs ~0
   *  GPU/CPU instead of a full render loop; input still renders the same
   *  frame it arrives. Default `true`; set `false` to render every frame
   *  (e.g. when driving external per-frame effects off the viewer's scene). */
  renderOnDemand?: boolean;
  /** Cave-geometry draw policy for VTLA tiles (whose cave-dark quads sit in a
   *  toggleable tail per mesh). `'auto'` skips them whenever the camera is
   *  above ground with the depth slice closed — from up there they are hidden
   *  behind terrain and cost pure vertex work — and brings them back the
   *  moment the slice opens or the camera dips underground. `'always'` keeps
   *  every quad drawn. Default `'auto'`. */
  caveGeometry?: 'auto' | 'always';
}

/** A tile source: a URL to fetch, a raw buffer, or already-decoded data. */
export type TileSource = string | ArrayBuffer | DecodedTile;
export type TextureSource = string | ArrayBuffer | DecodedTextureArray;

export interface LoadOptions {
  /** A tiled world to stream: the `manifest.json` URL, or a {@link WorldSource}
   *  for worlds that don't live on an HTTP server (a local folder, a zip — see
   *  `worldFromDirectory` / `worldFromFiles`). Takes precedence over `tile`. */
  world?: string | WorldSource;
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
  /** The depth slice (cave view) moved or toggled. `null` = off. */
  slice: { y: number | null };
  /** Progressive/live render progress. Finished batch renders flip false;
   *  continuous multiplayer sources keep rendering true for change polling. */
  progress: { done: number; total: number; rendering: boolean };
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

  // Progressive render (manifest.rendering): the manager whose live bake we're
  // polling for, and the atlas layer count last uploaded — a growing count
  // triggers a texture-array re-fetch. Cleared when the render finishes or the
  // world reloads (the poll checks its manager is still current).
  private progressiveManager: TileManager | null = null;
  private lastTextureLayers = 0;
  /** Last progress payload emitted, for deduplication across identical polls. */
  private lastProgress: { done: number; total: number; rendering: boolean } | null = null;
  /** An in-flight atlas re-fetch, so the tile-insert gate and the progressive
   *  poll coalesce onto one request instead of racing separate fetches. */
  private atlasRefresh: Promise<void> | null = null;

  // Biome layer state machine.
  private biomeEnabled = false;
  private highlight: number | null = null;
  private mixTarget = 0;
  private mixCurrent = 0;

  // Depth slice (cave view): everything above the clip plane is cut away,
  // revealing cave floors below. `sliceTarget` is where the user set it (null =
  // off); `sliceCurrent` eases toward it each frame, so toggling peels the
  // world open instead of popping. `sliceActive` stays true through the
  // toggle-off ease until the plane has lifted clear.
  private sliceTarget: number | null = null;
  private sliceCurrent = 0;
  private sliceActive = false;
  /** The last depth used, so re-opening the cave view returns there. */
  private lastSliceY: number | null = null;
  /** The dark "unexplored rock" floor under a sliced world. */
  private slicePlane: THREE.Mesh | null = null;

  // Cave-geometry draw policy (VTLA tiles): whether cave-dark tails are in the
  // draw ranges right now, re-evaluated each frame under 'auto'.
  private caveMode: 'auto' | 'always' = 'auto';
  private cavesShown = true;

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
  // Render-on-demand: a frame draws only when this is set (camera moved, tiles
  // changed, a setting changed, …) or the idle animation tick fires. See
  // `invalidate()`.
  private needsRender = true;
  // Whether the loaded texture array animates (water/lava frames) — drives the
  // idle tick. Set on load from the decoded anim table.
  private hasAnims = false;
  // When the last frame actually rendered, for the idle animation cadence.
  private lastRenderMs = 0;
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
      renderOnDemand: options.renderOnDemand ?? true,
      caveGeometry: options.caveGeometry ?? 'auto',
    };
    this.caveMode = this.options.caveGeometry;
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
  private async loadWorld(world: string | WorldSource, view: ViewMode): Promise<void> {
    const source = typeof world === 'string' ? await worldFromUrl(world) : world;
    const manifest = parseManifest(source.manifest);
    const texData = parseTextureArray(await maybeInflate(await source.fetch(manifest.textures)));

    this.disposeCurrent();
    const palette = biomePalette(manifest.biomes.length);
    // Quantized mode: tiles upload their on-disk u16/i8 encoding verbatim and
    // the shader dequantizes, so decode costs no main-thread time (see terrain.ts).
    const shader = createTerrainMaterial(texData, { quantized: true, palette });
    const waterShader = createWaterMaterial(shader);
    shader.uniforms['uFogRadial']!.value = 1.0; // fog radially from the focus, not by view depth
    // Format 4+ (VTL8/9): the atlas-lit sibling material for lightmapped tails.
    const lmShader = manifest.format >= 4 ? createLightmappedMaterial(shader) : undefined;
    // Lowres pyramid (format 2): coarse whole-world rings under the hires disc.
    // A progressive render has none yet but will grow one — build the material
    // upfront so the pyramid can stream in when the bake finishes.
    const lowresShader = manifest.lowres || manifest.rendering ? createLowresMaterial(shader) : undefined;
    this.shader = shader;
    this.waterShader = waterShader;
    this.lowresShader = lowresShader ?? null;
    this.manifest = manifest;
    this.hasAnims = texData.anims.length > 0;
    this.lastTextureLayers = manifest.textureLayers ?? texData.layers;
    this.tile = null;
    this.cavesShown = true; // a fresh manager starts with full draw ranges
    this.tiles = new TileManager({
      manifest,
      fetch: source.fetch,
      scene: this.scene,
      material: shader,
      waterMaterial: waterShader,
      ...(lmShader ? { lmMaterial: lmShader } : {}),
      ...(lowresShader ? { lowresMaterial: lowresShader } : {}),
      palette,
      // A live/progressive render grows its atlas as tiles bake; gate each
      // tile's insertion on the atlas covering its layers (a no-op once the
      // atlas is complete). Returns the layer count now loaded.
      ...(manifest.rendering ? { ensureAtlas: (n: number) => this.ensureAtlasLayers(source, n).then(() => this.lastTextureLayers) } : {}),
      ...this.options.streaming,
    });

    // The pivot rides the streamed terrain; picking and the legend aggregate
    // across whatever is resident.
    this.setHeightSampler(this.tiles.heightAt);
    this.tilesUnsub = this.tiles.on('change', (stats) => {
      this.needsRender = true; // tiles entered/left the scene (or coverage flipped)
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
    this.applySlice(); // seed the fresh shader's clip plane (deep link / re-load)

    // Seed streaming at the framed pivot so the first tiles arrive immediately.
    this.tiles.update(this.controls.position.x, this.controls.position.z);

    const size = new THREE.Vector3();
    this.bounds.getSize(size);
    this._biomes = [];
    this.emitter.emit('load', {
      // Streamed worlds: the tile format follows the manifest schema version.
      magic: manifest.format >= 6 ? 'VTLA' : manifest.format >= 5 ? 'VTL9' : manifest.format >= 4 ? 'VTL8' : manifest.format >= 3 ? 'VTL7' : 'VTL6',
      vertexCount: 0,
      triangleCount: 0,
      size,
      biomes: this._biomes,
    });

    // Progressive render: poll the manifest and stream tiles in as they bake.
    if (manifest.rendering) {
      this.progressiveManager = this.tiles;
      this.lastProgress = null; // a fresh world always reports its first state
      this.emitProgress(manifest);
      void this.pollProgressive(source, this.tiles);
    }
  }

  /** Emit a `progress` event from a manifest (falling back to the tile count
   *  when the generator didn't include a `progress` block). Deduplicated: a
   *  continuous server reports the same numbers poll after poll, and repeating
   *  them would tick every listener (React state, HUDs) for nothing. Returns
   *  whether anything actually changed (and was emitted). */
  private emitProgress(m: WorldManifest): boolean {
    const progress = {
      done: m.progress?.done ?? m.tiles.length,
      total: m.progress?.total ?? m.tiles.length,
      rendering: m.rendering ?? false,
    };
    const last = this.lastProgress;
    if (last && last.done === progress.done && last.total === progress.total && last.rendering === progress.rendering) return false;
    this.lastProgress = progress;
    this.emitter.emit('progress', progress);
    return true;
  }

  /** Follow a live (`rendering: true`) render: re-fetch the manifest on an
   *  interval, stream new/revised tiles in, widen the texture array when the
   *  atlas grows, and install the lowres pyramid once a batch bake completes.
   *  Continuous sources run until the world is replaced. */
  private async pollProgressive(source: WorldSource, manager: TileManager): Promise<void> {
    const dec = new TextDecoder();
    // A batch bake publishes new tiles continuously, so it polls briskly. A
    // warm continuous server mostly answers "nothing changed" — quiet polls
    // stretch the cadence toward POLL_MAX_MS, and any observed change (tiles,
    // atlas) snaps it back, so an idle multiplayer map costs a fraction of
    // the bandwidth while world edits still appear within a poll or two.
    let delay = VantageViewer.POLL_MS;
    // Validator from the last manifest this loop successfully applied. With a
    // conditional source, an unchanged catalog costs a 304 instead of a body.
    let manifestEtag: string | undefined;
    for (;;) {
      await new Promise((r) => setTimeout(r, delay));
      // Bail if the world was replaced/disposed while we waited.
      if (this.tiles !== manager || this.progressiveManager !== manager) return;

      let m: WorldManifest;
      try {
        if (source.fetchConditional) {
          const res = await source.fetchConditional('manifest.json', manifestEtag);
          if (res === 'unchanged') {
            delay = Math.min(delay * 2, VantageViewer.POLL_MAX_MS);
            continue;
          }
          m = parseManifest(JSON.parse(dec.decode(res.buffer)));
          // Only after a successful parse: a stored validator for a manifest
          // we failed to apply would 304 us out of ever seeing it again.
          manifestEtag = res.etag;
        } else {
          m = parseManifest(JSON.parse(dec.decode(await source.fetch('manifest.json'))));
        }
      } catch {
        // A torn read mid-rewrite or a transient fetch error — retry, easing
        // off so an unreachable server isn't hammered at full cadence.
        delay = Math.min(delay * 2, VantageViewer.POLL_MAX_MS);
        continue;
      }

      // Atlas grew (new block textures discovered): re-fetch and widen the
      // array. Layers are append-only, so resident tiles stay valid. Shares the
      // coalesced refetch with the on-demand tile-insert gate.
      const atlasGrew = (m.textureLayers ?? 0) > this.lastTextureLayers;
      if (atlasGrew) {
        await this.ensureAtlasLayers(source, m.textureLayers ?? 0);
        if (this.tiles !== manager) return;
      }

      // Stream in new tiles. Continuous on-demand servers also revise and
      // remove existing coordinates as the multiplayer world is saved.
      const changed = m.dynamic ? manager.syncTiles(m.tiles) : manager.addTiles(m.tiles);
      const progressed = this.emitProgress(m);
      delay = !m.dynamic || changed || atlasGrew || progressed ? VantageViewer.POLL_MS : Math.min(delay * 2, VantageViewer.POLL_MAX_MS);

      if (!m.rendering) {
        // Final manifest: install the lowres pyramid and open the zoom range to
        // the full world extent now that every tile is known.
        this.manifest = m;
        if (m.lowres) manager.ingestLowres(m.lowres);
        this.updateWorldBounds(m);
        this.applyViewLimits();
        this.progressiveManager = null;
        this.needsRender = true;
        return;
      }
    }
  }

  /** Ensure the terrain atlas covers at least `layers` texture-array layers,
   *  re-fetching `terrain.vtexarr` if it's behind. Coalesces concurrent callers
   *  — the on-demand tile-insert gate and the progressive poll — onto one
   *  request. Resolves once the atlas is current (or the fetch failed and the
   *  old atlas stands, to be retried by a later gate/poll). */
  private async ensureAtlasLayers(source: WorldSource, layers: number): Promise<void> {
    if (this.lastTextureLayers >= layers) return;
    await (this.atlasRefresh ??= this.refetchAtlas(source));
    // The atlas can grow again while a refetch is in flight; one more (bounded)
    // fetch covers a tile that needs layers newer than what we just loaded.
    if (this.lastTextureLayers < layers && !this.atlasRefresh) {
      await (this.atlasRefresh ??= this.refetchAtlas(source));
    }
  }

  /** Re-fetch `terrain.vtexarr` and widen every shared material's atlas (they
   *  share the sampler uniform objects, so one update reaches all). */
  private async refetchAtlas(source: WorldSource): Promise<void> {
    try {
      const td = parseTextureArray(await maybeInflate(await source.fetch(this.manifest!.textures)));
      if (!this.shader) return;
      updateTerrainTextures(this.shader, td);
      this.hasAnims = td.anims.length > 0;
      this.lastTextureLayers = Math.max(this.lastTextureLayers, td.layers);
      this.needsRender = true;
    } catch {
      /* keep the old atlas; a later gate or poll retries */
    } finally {
      this.atlasRefresh = null;
    }
  }

  /** Set the world bounds + span from a manifest's tile extents, without moving
   *  the camera. Used to frame a world on load and to widen the extent when a
   *  progressive render finishes and the full size is finally known. */
  private updateWorldBounds(manifest: WorldManifest): void {
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
  }

  /** Frame a streamed world: pivot on the spawn point when the manifest has
   *  one (that's where the builds are), else the centre of the tile extents.
   *  Distances are tied to the streaming view distance, not the world size —
   *  a 100k×100k world frames the same as a village. */
  private frameWorld(manifest: WorldManifest, view: ViewMode): void {
    this.updateWorldBounds(manifest);
    const minX = this.bounds.min.x;
    const minZ = this.bounds.min.z;
    const maxX = this.bounds.max.x;
    const maxZ = this.bounds.max.z;

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
    this.hasAnims = (textures?.anims.length ?? 0) > 0;
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
    this.setHeightSampler(makeHeightSampler(tile.surface));
    this._biomes = summarizeBiomes(tile, built.palette);
    this.frameCamera(view);
    if (this.options.urlState) this.applyViewHash(window.location.hash);
    this.applyBiomeUniforms();
    this.applyLight();
    this.applyDisplay();
    this.applySlice();

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
    // Seed the crossfade level too — a reload builds a fresh shader whose
    // uniform would otherwise stay 0 while the eased state says "on".
    this.shader.uniforms['uBiomeMix']!.value = this.mixCurrent;
    this.shader.uniforms['uHi']!.value = this.biomeEnabled && this.highlight !== null ? this.highlight : -1;
    this.needsRender = true;
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
    // The cave view floors ambient so unlit passages read as terrain instead
    // of a black void; torch-lit builds still glow warm well above the floor.
    const ambient = this.sliceActive ? Math.max(this.light.ambient, 0.32) : this.light.ambient;
    this.shader.uniforms['uAmbient']!.value = ambient;
    this.shader.uniforms['uDay']!.value = this.light.daylight;
    this.shader.uniforms['uExposure']!.value = this.light.exposure;
    this.needsRender = true;
  }

  // --- depth slice (cave view) -------------------------------------------------

  /** Whether the loaded world was baked with full cave geometry
   *  (`vantage render --caves full`) — i.e. the depth slice has real caves to
   *  reveal. The slice API works regardless; this is the "show the UI?" bit. */
  get hasCaves(): boolean {
    return this.manifest?.caves ?? false;
  }

  /** The world-Y bounds for the depth slice, from the manifest's baked extent
   *  (falling back to the loaded bounds / vanilla build limits). */
  get sliceRange(): { min: number; max: number } {
    const yr = this.manifest?.yRange;
    if (yr) return { min: yr.min, max: yr.max };
    if (Number.isFinite(this.bounds.min.y) && this.bounds.min.y < this.bounds.max.y) {
      return { min: this.bounds.min.y, max: this.bounds.max.y };
    }
    return { min: -64, max: 320 };
  }

  /** The current depth-slice Y, or `null` when the cave view is off. */
  get slice(): number | null {
    return this.sliceTarget;
  }

  /** Slice the world at world-Y `y` (everything above is cut away, exposing
   *  the caves below — the cave / X-ray view); `null` turns it off. The plane
   *  eases to its target, so toggling peels the world open. Emits `'slice'`. */
  setSlice(y: number | null): void {
    const r = this.sliceRange;
    const target = y === null ? null : Math.min(Math.max(y, r.min + 2), r.max);
    if (target === this.sliceTarget) return;
    if (target !== null) {
      // Fresh activation peels down from above the world top; a move while
      // active eases from wherever the plane is now.
      if (!this.sliceActive) this.sliceCurrent = r.max + 24;
      this.sliceActive = true;
      this.lastSliceY = target;
    }
    this.sliceTarget = target;
    this.applySlice();
    this.queueHashWrite();
    this.emitter.emit('slice', { y: target });
  }

  /** Toggle the cave view: off → the last used depth (or a sensible cave
   *  depth on first open), on → off. */
  toggleSlice(): void {
    if (this.sliceTarget !== null) {
      this.setSlice(null);
      return;
    }
    const r = this.sliceRange;
    this.setSlice(this.lastSliceY ?? Math.round(r.min + (r.max - r.min) * 0.25));
  }

  /** Push slice state to the shader + scene: clip uniform, ambient floor, and
   *  the void floor's presence. Also called on (re)load to seed a fresh shader. */
  private applySlice(): void {
    if (!this.shader) return;
    this.shader.uniforms['uClipY']!.value = this.sliceActive ? this.sliceCurrent : 1e9;
    if (this.sliceActive && !this.slicePlane) {
      this.slicePlane = this.buildSlicePlane();
      this.scene.add(this.slicePlane);
    } else if (!this.sliceActive && this.slicePlane) {
      this.scene.remove(this.slicePlane);
      this.slicePlane.geometry.dispose();
      (this.slicePlane.material as THREE.Material).dispose();
      this.slicePlane = null;
    }
    this.applyLight();
  }

  /** The "unexplored rock" floor under a sliced world: a huge dark plane at
   *  the world's bottom, so solid ground reads as solid where no cave is
   *  exposed (instead of sky bleeding through the planet). Carries a faint
   *  16-block chunk grid for scale and shares the terrain's fog uniforms so
   *  its distance haze matches. Follows the camera focus each frame. */
  private buildSlicePlane(): THREE.Mesh {
    const t = this.shader!.uniforms;
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uFogColor: t['uFogColor']!,
        uFog: t['uFog']!,
        uFogCenter: t['uFogCenter']!,
        uFogRadial: t['uFogRadial']!,
        uFogDensity: t['uFogDensity']!,
      },
      vertexShader: /* glsl */ `
        out vec2 vXZ;
        out float vViewZ;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vXZ = wp.xz;
          vec4 mv = viewMatrix * wp;
          vViewZ = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uFogColor;
        uniform vec2 uFog;
        uniform vec2 uFogCenter;
        uniform float uFogRadial;
        uniform float uFogDensity;
        in vec2 vXZ;
        in float vViewZ;
        out vec4 frag;
        void main() {
          // A faint 16-block chunk grid, antialiased via screen-space
          // derivatives and faded with the fog so it never shimmers.
          vec2 cell = vXZ / 16.0;
          vec2 q = abs(fract(cell) - 0.5);
          vec2 w = max(fwidth(cell), vec2(1e-5));
          vec2 d = (0.5 - q) / w;
          float g = 1.0 - smoothstep(0.8, 2.2, min(d.x, d.y));
          // Radial fog must be computed HERE, not in the vertex shader: this
          // plane is two screen-covering triangles, and distance() is not
          // affine — interpolating it from far-away corners fogs the whole
          // interior solid. The view-depth term IS affine, so it interpolates
          // exactly as a varying.
          float fogd = mix(vViewZ, distance(vXZ, uFogCenter), uFogRadial);
          float f = smoothstep(uFog.x, uFog.y, fogd) * uFogDensity;
          // Authored sRGB, straight to the canvas (like the sky dome).
          vec3 c = mix(vec3(0.055, 0.06, 0.075), vec3(0.115, 0.125, 0.155), g * (1.0 - f));
          frag = vec4(mix(c, uFogColor, f), 1.0);
        }
      `,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.setScalar(400000); // far beyond any far plane — fog owns the edge
    mesh.frustumCulled = false;
    return mesh;
  }

  /** Install the terrain-follow height source, wrapped so the controls' pivot
   *  never rides the (now invisible) surface above an open depth slice —
   *  zooming in descends to the exposed cave level instead of stopping at the
   *  clipped-away hilltops. */
  private setHeightSampler(base: HeightSampler | null): void {
    this.controls.heightAt = base
      ? (x, z) => {
          const h = base(x, z);
          if (h == null || this.sliceTarget == null) return h;
          return Math.min(h, this.sliceTarget);
        }
      : null;
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
   *  fat-fingered scale can't allocate a giant framebuffer). Floored at 0.25:
   *  a hidden/headless window can report devicePixelRatio 0, which would
   *  otherwise zero the framebuffer and break screenshot() and the first
   *  visible frame. */
  private targetPixelRatio(): number {
    const dpr = window.devicePixelRatio || 1;
    const want = dpr * this.display.renderScale;
    return Math.max(0.25, Math.min(want, this.options.maxPixelRatio * Math.max(1, this.display.renderScale), 4));
  }

  private applyDisplay(): void {
    if (!this.shader) return;
    const d = this.display;
    this.shader.uniforms['uSharpness']!.value = d.sharpness;
    this.shader.uniforms['uAoStrength']!.value = d.ao;
    this.shader.uniforms['uSaturation']!.value = d.saturation;
    this.shader.uniforms['uContrast']!.value = d.contrast;
    this.shader.uniforms['uFogDensity']!.value = d.fog;
    this.needsRender = true;
  }

  // --- streaming -------------------------------------------------------------

  /** The current streaming settings (view distance, tile/byte budgets, concurrency). */
  get streamingSettings(): Required<StreamingSettings> {
    return {
      viewDistance: this.tiles?.viewDistance ?? this.options.streaming.viewDistance ?? 768,
      maxTiles: this.tiles?.maxTiles ?? this.options.streaming.maxTiles ?? 120,
      concurrency: this.options.streaming.concurrency ?? 4,
      maxBytes: this.tiles?.maxBytes ?? this.options.streaming.maxBytes ?? 512 * 1024 * 1024,
    };
  }

  /** Live-tune streaming: view distance, resident tile/byte budgets, concurrency.
   *  Applies immediately to a streamed world (tiles re-plan, fog and camera
   *  range follow) and persists for future loads. The fidelity dial: raise
   *  viewDistance/maxTiles/maxBytes to see farther, lower them on weak hardware. */
  setStreaming(settings: StreamingSettings): void {
    this.options.streaming = { ...this.options.streaming, ...settings };
    if (!this.tiles) return;
    this.tiles.configure(settings);
    this.applyViewLimits();
    this.needsRender = true;
  }

  // --- URL-hash deep links ----------------------------------------------------

  /** The current view serialized as a `#@x,y,z,dist,rot,tilt[,sliceY]` hash
   *  fragment — paste-able into any URL serving the same world. The trailing
   *  component appears only while the cave view is open, so those deep links
   *  reopen sliced at the same depth. */
  getViewHash(): string {
    const p = this.controls.position;
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const slice = this.sliceTarget !== null ? `,${r1(this.sliceTarget)}` : '';
    return `#@${r1(p.x)},${r1(p.y)},${r1(p.z)},${r1(this.controls.distance)},${r3(this.controls.rotation)},${r3(this.controls.angle)}${slice}`;
  }

  /** Apply a `#@x,y,z,dist,rot,tilt[,sliceY]` hash to the camera (leading `#`
   *  optional). Returns whether the hash parsed. */
  applyViewHash(hash: string): boolean {
    const m = /^#?@(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),([\d.]+),(-?[\d.]+),(-?[\d.]+)(?:,(-?[\d.]+))?$/.exec(hash);
    if (!m) return false;
    const [x, y, z, distance, rotation, angle] = m.slice(1, 7).map(Number);
    if (![x, y, z, distance, rotation, angle].every(Number.isFinite)) return false;
    this.controls.setView({
      position: new THREE.Vector3(x, y, z),
      distance: distance!,
      rotation: rotation!,
      angle: angle!,
      floorY: y!,
    });
    const slice = m[7] !== undefined ? Number(m[7]) : null;
    this.setSlice(Number.isFinite(slice as number) ? slice : null);
    // setView jumps the camera outside update()'s motion detection.
    this.needsRender = true;
    return true;
  }

  /** Debounced camera→hash sync plus hashchange→camera (pasted links apply
   *  live). `history.replaceState` avoids history spam and hashchange echo. */
  private bindUrlState(): void {
    const onChange = () => this.queueHashWrite();
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

  /** Debounce a hash write — camera motion and slice changes funnel here. */
  private queueHashWrite(): void {
    if (!this.options.urlState) return;
    if (this.hashTimer !== null) clearTimeout(this.hashTimer);
    this.hashTimer = setTimeout(() => this.writeHash(), 250);
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
    this.needsRender = true;
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

  /** Request a redraw on the next animation frame. The viewer invalidates
   *  itself for everything it owns (camera motion, tile streaming, settings,
   *  the biome layer); call this only if you mutate the scene from outside. */
  invalidate(): void {
    this.needsRender = true;
  }

  /** Set the cave-geometry draw policy (see the option of the same name).
   *  Takes effect on the next frame. */
  setCaveGeometry(mode: 'auto' | 'always'): void {
    this.caveMode = mode;
    this.invalidate();
  }

  /** The current cave-geometry draw policy. */
  get caveGeometry(): 'auto' | 'always' {
    return this.caveMode;
  }

  /** Re-evaluate whether cave-dark tails belong in the draw ranges. Above
   *  ground with the depth slice closed they are provably behind terrain from
   *  the camera's side of the surface, so 'auto' trims every tile's draw range
   *  to its surface prefix; opening the slice or descending underground brings
   *  them straight back. The underground test rides the streamed surface maps
   *  (the same data the terrain-following pivot uses) with a couple of blocks
   *  of hysteresis so skimming the terrain doesn't flicker the ranges. */
  private applyCavePolicy(): void {
    if (!this.tiles) return;
    let show = true;
    if (this.caveMode === 'always' || this.sliceActive) {
      show = true;
    } else {
      const cam = this.camera.position;
      const ground = this.tiles.heightAt(cam.x, cam.z);
      // Below the local surface = inside terrain (a cave, a ravine overhang).
      // Unknown ground (nothing resident yet) counts as above ground.
      const margin = this.cavesShown ? 2.5 : 0.5;
      show = ground !== null && cam.y < ground + margin;
    }
    if (show !== this.cavesShown) {
      this.cavesShown = show;
      if (this.tiles.setCaveGeometry(show)) this.needsRender = true;
    }
  }

  /** Idle animation cadence (ms). Water/lava bake at a 2-tick frametime
   *  (100 ms), so a 10 fps tick steps them at exactly their authored rate. */
  private static readonly ANIM_TICK_MS = 100;

  /** Manifest poll cadence (ms) while a render is streaming in. */
  private static readonly POLL_MS = 1200;

  /** Ceiling the poll cadence relaxes to while a continuous server reports no
   *  changes — a saved world edit still shows up within ~one ceiling. */
  private static readonly POLL_MAX_MS = 5000;

  private frame(): void {
    const now = performance.now();
    const dtMs = this.lastFrameMs ? now - this.lastFrameMs : 16.7;
    this.lastFrameMs = now;
    if (this.controls.update(dtMs)) this.needsRender = true;

    // Streamed worlds: re-plan tile residency around wherever the user is
    // looking (the map pivot, or the eye itself in free-flight). Tile
    // insertions/unloads invalidate via the manager's change event.
    if (this.tiles) {
      const focus = this.controls.flyMode ? this.camera.position : this.controls.position;
      this.tiles.update(focus.x, focus.z);
      // Keep drawing while tiles dissolve in — the stream-in fade is the one
      // scene animation that lives in the manager, not the viewer.
      if (this.tiles.fading) this.needsRender = true;
      // Radial fog tracks the same focus streaming plans around, so the clear
      // disc and the resident disc stay concentric.
      if (this.shader) (this.shader.uniforms['uFogCenter']!.value as THREE.Vector2).set(focus.x, focus.z);
    }

    // Ease the textured<->biome crossfade while it is in motion.
    if (this.shader && this.mixCurrent !== this.mixTarget) {
      this.mixCurrent += (this.mixTarget - this.mixCurrent) * 0.2;
      if (Math.abs(this.mixCurrent - this.mixTarget) < 0.0015) this.mixCurrent = this.mixTarget;
      this.shader.uniforms['uBiomeMix']!.value = this.mixCurrent;
      this.needsRender = true;
    }

    // Ease the depth slice: opening peels the plane down from above the world,
    // closing lifts it clear and only then switches the clip off. The void
    // floor tracks the camera focus so it never runs out underneath the view.
    if (this.sliceActive && this.shader) {
      const goal = this.sliceTarget ?? this.sliceRange.max + 24;
      if (this.sliceCurrent !== goal) {
        this.sliceCurrent += (goal - this.sliceCurrent) * (1 - Math.exp(-dtMs / 110));
        if (Math.abs(this.sliceCurrent - goal) < 0.05) this.sliceCurrent = goal;
        this.needsRender = true;
      }
      if (this.sliceTarget === null && this.sliceCurrent === goal) {
        this.sliceActive = false;
        this.applySlice(); // clip off, void floor removed, ambient restored
      } else {
        this.shader.uniforms['uClipY']!.value = this.sliceCurrent;
        if (this.slicePlane) {
          const focus = this.controls.flyMode ? this.camera.position : this.controls.position;
          this.slicePlane.position.set(focus.x, this.sliceRange.min - 0.4, focus.z);
        }
      }
    }

    this.applyCavePolicy();
    this.pickHover();

    // Render on demand: skip the draw entirely when nothing changed. Animated
    // textures (water, lava) keep stepping at their authored 10 fps cadence;
    // a still view without them costs nothing until the next interaction.
    if (this.hasAnims && now - this.lastRenderMs >= VantageViewer.ANIM_TICK_MS) this.needsRender = true;
    if (!this.options.renderOnDemand) this.needsRender = true;
    if (!this.needsRender) return;
    this.needsRender = false;
    this.lastRenderMs = now;
    this.draw(now);
  }

  private draw(now: number): void {
    this.sky.position.copy(this.camera.position); // keep the dome centred on the eye
    // Advance the texture-animation clock (water, lava, magma, … step through
    // their baked frames). Wall-clock, wrapped hourly so the f32 uniform keeps
    // sub-frame precision on long sessions — skipped frames don't slow it.
    if (this.shader) this.shader.uniforms['uTime']!.value = (now / 1000) % 3600;

    // Render the scene into the 8× MSAA target, then resolve+copy it to the
    // canvas. autoClear is off, so clear the target explicitly each frame.
    this.renderer.setRenderTarget(this.msaa);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.present, this.presentCamera);
  }

  /** Draw a fresh frame and return the canvas as a PNG data URL, for a
   *  screenshot button / download link. Draws synchronously first because the
   *  default framebuffer is not preserved between the on-demand renders. */
  screenshot(): string {
    this.draw(performance.now());
    return this.renderer.domElement.toDataURL('image/png');
  }

  private resize(): void {
    this.needsRender = true;
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
    // The slice plane's material shares the outgoing shader's uniform objects —
    // drop it (and the slice state) with the world it was cut into. A slice in
    // the URL hash re-applies to the next load.
    if (this.slicePlane) {
      this.scene.remove(this.slicePlane);
      this.slicePlane.geometry.dispose();
      (this.slicePlane.material as THREE.Material).dispose();
      this.slicePlane = null;
    }
    this.sliceTarget = null;
    this.sliceActive = false;
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
      this.progressiveManager = null; // stops any in-flight progressive poll
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
