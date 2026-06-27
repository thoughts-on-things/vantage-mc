// Vantage viewer — loads a `.vtile` (v1 flat-color, v2 textured, or v3 textured
// + biome) and renders it with three.js. v2/v3 also load a `.vtexarr` texture
// array sampled per face by a WebGL2 sampler2DArray shader. v3 carries a
// per-vertex biome id and a biome legend, driving an interactive "biome layer"
// that recolours the terrain by biome (so borders read at a glance) with a
// clickable legend — the thin end of the versioned tile contract: the frontend
// only needs the format, not the world.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const TILE_URL = './terrain.vtile';
const TEX_URL = './terrain.vtexarr';
const hud = document.getElementById('hud');

function fail(msg) {
  const el = document.getElementById('err');
  el.style.display = 'grid';
  el.textContent = 'Error: ' + msg;
  hud.style.display = 'none';
  console.error(msg);
}

function parseTile(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  const version = dv.getUint32(4, true);
  const V = dv.getUint32(8, true);
  const I = dv.getUint32(12, true);
  let off = 16;

  if (magic === 'VTL3') {
    const positions = new Float32Array(buf, off, 3 * V); off += 12 * V;
    const uv = new Float32Array(buf, off, 2 * V); off += 8 * V;
    const layer = new Float32Array(buf, off, V); off += 4 * V;
    const colors = new Uint8Array(buf, off, 4 * V); off += 4 * V;
    const normalsI8 = new Int8Array(buf, off, 4 * V); off += 4 * V;
    const biome = new Float32Array(buf, off, V); off += 4 * V;
    const indices = new Uint32Array(buf, off, I); off += 4 * I;
    const biomeNames = parseLegend(dv, buf, off);
    return { textured: true, hasBiome: true, V, I, positions, uv, layer, colors, biome,
      normals: expandNormals(normalsI8, V), indices, biomeNames };
  }
  if (magic === 'VTL2') {
    const positions = new Float32Array(buf, off, 3 * V); off += 12 * V;
    const uv = new Float32Array(buf, off, 2 * V); off += 8 * V;
    const layer = new Float32Array(buf, off, V); off += 4 * V;
    const colors = new Uint8Array(buf, off, 4 * V); off += 4 * V;
    const normalsI8 = new Int8Array(buf, off, 4 * V); off += 4 * V;
    const indices = new Uint32Array(buf, off, I);
    return { textured: true, hasBiome: false, V, I, positions, uv, layer, colors, normals: expandNormals(normalsI8, V), indices };
  }
  if (magic === 'VTL1') {
    const positions = new Float32Array(buf, off, 3 * V); off += 12 * V;
    const colors = new Uint8Array(buf, off, 4 * V); off += 4 * V;
    const normalsI8 = new Int8Array(buf, off, 4 * V); off += 4 * V;
    const indices = new Uint32Array(buf, off, I);
    return { textured: false, hasBiome: false, V, I, positions, colors, normals: expandNormals(normalsI8, V), indices };
  }
  throw new Error('bad magic: ' + magic);
}

function parseLegend(dv, buf, off) {
  const count = dv.getUint32(off, true); off += 4;
  const dec = new TextDecoder();
  const names = [];
  for (let i = 0; i < count; i++) {
    const len = dv.getUint16(off, true); off += 2;
    names.push(dec.decode(new Uint8Array(buf, off, len))); off += len;
  }
  return names;
}

function expandNormals(n8, V) {
  const out = new Float32Array(3 * V);
  for (let i = 0; i < V; i++) {
    out[i * 3 + 0] = n8[i * 4 + 0];
    out[i * 3 + 1] = n8[i * 4 + 1];
    out[i * 3 + 2] = n8[i * 4 + 2];
  }
  return out;
}

function parseTexArray(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'VTA1') throw new Error('bad tex magic: ' + magic);
  const width = dv.getUint32(8, true);
  const height = dv.getUint32(12, true);
  const layers = dv.getUint32(16, true);
  const pixels = new Uint8Array(buf, 20, width * height * layers * 4);
  return { width, height, layers, pixels };
}

// --- biome categorical palette ------------------------------------------------
// Distinct, well-separated hues (golden-angle) so adjacent biomes never collide
// and borders are obvious. Index 0 is the "no data" sentinel -> neutral gray.
function hsv2rgb(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const m = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return m;
}
function biomePalette(n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i === 0) { out[i] = [0.55, 0.55, 0.6]; continue; }
    const h = ((i - 1) * 0.61803398875) % 1;
    const sat = 0.55 + 0.12 * ((i * 7) % 3) / 2;   // slight sat/val jitter for separation
    out[i] = hsv2rgb(h, sat, 0.96);
  }
  return out;
}
function stripNs(name) {
  const c = name.indexOf(':');
  return c >= 0 ? name.slice(c + 1) : name;
}

// Atmosphere palette — a calm Minecraft-ish daytime. Horizon doubles as fog.
const SKY_TOP = [0.30, 0.52, 0.84];
const SKY_HORIZON = [0.72, 0.83, 0.95];

const VERT = /* glsl */`
  in float alayer;
  in vec4 atint;
  in vec3 abcol;
  in float abiome;
  out vec2 vUv;
  out vec4 vTint;
  out vec3 vBcol;
  flat out float vLayer;
  flat out float vBiome;
  out vec3 vN;
  out float vFog;
  void main() {
    vUv = uv;
    vTint = atint;
    vBcol = abcol;
    vLayer = alayer;
    vBiome = abiome;
    vN = normalize(mat3(modelMatrix) * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFog = -mv.z;                                  // view-space depth for fog
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  precision highp sampler2DArray;
  uniform sampler2DArray map;
  uniform vec3 lightDir;
  uniform float uBiomeMix;   // 0 = textured, 1 = biome layer
  uniform float uHi;         // highlighted biome id, or -1
  uniform vec3 uFogColor;
  uniform vec2 uFog;         // (near, far)
  in vec2 vUv;
  in vec4 vTint;
  in vec3 vBcol;
  flat in float vLayer;
  flat in float vBiome;
  in vec3 vN;
  in float vFog;
  out vec4 frag;
  const vec3 SKY = vec3(0.62, 0.72, 0.88);        // hemispheric sky ambient
  const vec3 GND = vec3(0.34, 0.31, 0.27);        // hemispheric ground ambient
  const vec3 SUN = vec3(1.0, 0.95, 0.84);         // warm key light
  void main() {
    vec4 t = texture(map, vec3(vUv, vLayer));
    if (t.a < 0.5) discard;                        // alpha cutout (grass overlay etc.)
    float ao = vTint.a;                            // baked ambient occlusion (colour alpha)
    vec3 texcol = t.rgb * vTint.rgb;
    float luma = dot(texcol, vec3(0.299, 0.587, 0.114));
    // Biome view keeps terrain relief by modulating the flat biome colour by luma.
    vec3 biomecol = vBcol * (0.45 + 0.65 * luma);
    vec3 base = mix(texcol, biomecol, uBiomeMix);
    if (uBiomeMix > 0.5 && uHi >= 0.0 && abs(vBiome - uHi) > 0.5) {
      float g = dot(base, vec3(0.299, 0.587, 0.114));
      base = mix(base, vec3(g) * 0.55, 0.82);      // fade biomes other than the selected one
    }
    vec3 N = normalize(vN);
    vec3 ambient = mix(GND, SKY, 0.5 + 0.5 * N.y); // sky above, earth below
    float ndl = max(dot(N, normalize(lightDir)), 0.0);
    vec3 lit = base * (0.25 + 0.45 * ambient + 0.55 * SUN * ndl) * ao;
    float f = smoothstep(uFog.x, uFog.y, vFog);    // aerial depth into the horizon
    frag = vec4(mix(lit, uFogColor, f), 1.0);
  }
`;

// A camera-locked gradient sky dome (depth-test off, drawn first) so the
// background reads as sky from any zoom, with the horizon matching the fog.
function buildSky() {
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    vertexShader: /* glsl */`
      out vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 uTop; uniform vec3 uHorizon;
      in vec3 vDir; out vec4 frag;
      void main() {
        float t = smoothstep(-0.08, 0.5, vDir.y);
        frag = vec4(mix(uHorizon, uTop, t), 1.0);
      }
    `,
    uniforms: {
      uTop: { value: new THREE.Vector3(...SKY_TOP) },
      uHorizon: { value: new THREE.Vector3(...SKY_HORIZON) },
    },
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 16), mat);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  return sky;
}

function buildTexturedMaterial(texData) {
  const tex = new THREE.DataArrayTexture(texData.pixels, texData.width, texData.height, texData.layers);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      map: { value: tex },
      lightDir: { value: new THREE.Vector3(0.55, 1.0, 0.4).normalize() },
      uBiomeMix: { value: 0 },
      uHi: { value: -1 },
      uFogColor: { value: new THREE.Vector3(...SKY_HORIZON) },
      uFog: { value: new THREE.Vector2(1e6, 2e6) },  // set from terrain extent
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
}

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText + ' for ' + url);
  return r.arrayBuffer();
}

// Build the interactive biome legend and wire the view toggle + highlight.
function setupBiomeUI(tile, material) {
  const panel = document.getElementById('panel');
  const legend = document.getElementById('legend');
  const toggle = document.getElementById('toggle');
  panel.style.display = 'flex';

  const palette = biomePalette(tile.biomeNames.length);

  // Per-vertex biome colour attribute from the palette.
  const bcol = new Float32Array(3 * tile.V);
  const counts = new Array(tile.biomeNames.length).fill(0);
  for (let i = 0; i < tile.V; i++) {
    const id = tile.biome[i] | 0;
    const c = palette[id] || palette[0];
    bcol[i * 3 + 0] = c[0]; bcol[i * 3 + 1] = c[1]; bcol[i * 3 + 2] = c[2];
    counts[id]++;
  }

  // Biomes actually present (by vertex count), most common first; skip the empty sentinel.
  const present = [];
  for (let id = 0; id < tile.biomeNames.length; id++) {
    if (counts[id] > 0 && tile.biomeNames[id].length > 0) present.push(id);
  }
  present.sort((a, b) => counts[b] - counts[a]);
  const total = present.reduce((s, id) => s + counts[id], 0) || 1;

  // Deep-link: #biome opens straight into the biome layer.
  let on = /biome/i.test(location.hash);
  let hi = -1;

  function setMix() {
    material.uniforms.uBiomeMix.value = on ? 1 : 0;
    material.uniforms.uHi.value = on ? hi : -1;
    toggle.textContent = on ? 'on' : 'off';
    toggle.classList.toggle('on', on);
    for (const r of legend.children) {
      const id = +r.dataset.id;
      r.classList.toggle('sel', on && id === hi);
      r.classList.toggle('dim', on && hi >= 0 && id !== hi);
    }
  }
  function setOn(v) { on = v; if (!on) hi = -1; setMix(); }

  toggle.addEventListener('click', () => setOn(!on));
  window.addEventListener('keydown', (e) => { if (e.key === 'b' || e.key === 'B') setOn(!on); });

  for (const id of present) {
    const c = palette[id];
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.id = id;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = `rgb(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0})`;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = stripNs(tile.biomeNames[id]);
    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = Math.round((counts[id] / total) * 100) + '%';
    row.append(chip, name, pct);
    row.addEventListener('click', () => {
      if (!on) setOn(true);
      hi = (hi === id) ? -1 : id;     // click selected biome again to clear
      setMix();
    });
    legend.appendChild(row);
  }

  setMix();
  return bcol;
}

async function main() {
  const app = document.getElementById('app');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Output shader colors directly (the textures are already sRGB pixel art).
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY_HORIZON[0], SKY_HORIZON[1], SKY_HORIZON[2]);
  const sky = buildSky();
  scene.add(sky);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 8000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  let tile;
  try {
    tile = parseTile(await fetchBuf(TILE_URL));
  } catch (e) {
    return fail('tile: ' + e.message);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(tile.positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(tile.normals, 3));
  geom.setIndex(new THREE.BufferAttribute(tile.indices, 1));

  let material;
  if (tile.textured) {
    let texData;
    try {
      texData = parseTexArray(await fetchBuf(TEX_URL));
    } catch (e) {
      return fail('texarray: ' + e.message);
    }
    geom.setAttribute('uv', new THREE.BufferAttribute(tile.uv, 2));
    geom.setAttribute('alayer', new THREE.BufferAttribute(tile.layer, 1));
    geom.setAttribute('atint', new THREE.BufferAttribute(tile.colors, 4, true));
    material = buildTexturedMaterial(texData);

    if (tile.hasBiome) {
      geom.setAttribute('abiome', new THREE.BufferAttribute(tile.biome, 1));
      const bcol = setupBiomeUI(tile, material);
      geom.setAttribute('abcol', new THREE.BufferAttribute(bcol, 3));
    } else {
      // No biome data: feed neutral defaults so the shared shader still links.
      geom.setAttribute('abiome', new THREE.BufferAttribute(new Float32Array(tile.V), 1));
      geom.setAttribute('abcol', new THREE.BufferAttribute(new Float32Array(3 * tile.V), 3));
    }
  } else {
    geom.setAttribute('color', new THREE.BufferAttribute(tile.colors, 4, true));
    scene.add(new THREE.HemisphereLight(0xbcd7ff, 0x4a4636, 1.0));
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
    sun.position.set(0.6, 1.0, 0.35);
    scene.add(sun);
    material = new THREE.MeshLambertMaterial({ vertexColors: true });
  }

  geom.computeBoundingBox();
  const mesh = new THREE.Mesh(geom, material);
  scene.add(mesh);

  const bb = geom.boundingBox;
  const center = new THREE.Vector3(); bb.getCenter(center);
  const size = new THREE.Vector3(); bb.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  controls.target.copy(center);
  camera.position.set(center.x + maxDim * 0.7, center.y + maxDim * 0.6, center.z + maxDim * 0.7);
  camera.far = maxDim * 12;
  camera.updateProjectionMatrix();

  // Fog fades terrain into the horizon over the back half of the extent.
  if (material.uniforms && material.uniforms.uFog) {
    material.uniforms.uFog.value.set(maxDim * 0.85, maxDim * 2.4);
  }

  const fmt = tile.hasBiome ? 'VTL3 textured + biomes' : (tile.textured ? 'VTL2 textured' : 'VTL1 flat');
  hud.textContent =
    `vantage · ${fmt}\n` +
    `${tile.V.toLocaleString()} verts · ${(tile.I / 3).toLocaleString()} tris\n` +
    `extent ${Math.round(size.x)}×${Math.round(size.y)}×${Math.round(size.z)} blocks\n` +
    `drag: orbit · scroll: zoom${tile.hasBiome ? ' · B: biome view' : ''}`;

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(() => {
    controls.update();
    sky.position.copy(camera.position);            // keep the dome centred on the eye
    renderer.render(scene, camera);
  });
}

main();
