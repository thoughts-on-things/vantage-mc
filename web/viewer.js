// Vantage viewer — loads a `.vtile` (v1 flat-color or v2 textured) and renders
// it with three.js. v2 also loads a `.vtexarr` texture array and samples it per
// face with a small WebGL2 sampler2DArray shader (the thin end of the versioned
// tile contract: the frontend only needs to know the format, not the world).

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

  if (magic === 'VTL2') {
    const positions = new Float32Array(buf, off, 3 * V); off += 12 * V;
    const uv = new Float32Array(buf, off, 2 * V); off += 8 * V;
    const layer = new Float32Array(buf, off, V); off += 4 * V;
    const colors = new Uint8Array(buf, off, 4 * V); off += 4 * V;
    const normalsI8 = new Int8Array(buf, off, 4 * V); off += 4 * V;
    const indices = new Uint32Array(buf, off, I);
    return { textured: true, V, I, positions, uv, layer, colors, normals: expandNormals(normalsI8, V), indices };
  }
  if (magic === 'VTL1') {
    const positions = new Float32Array(buf, off, 3 * V); off += 12 * V;
    const colors = new Uint8Array(buf, off, 4 * V); off += 4 * V;
    const normalsI8 = new Int8Array(buf, off, 4 * V); off += 4 * V;
    const indices = new Uint32Array(buf, off, I);
    return { textured: false, V, I, positions, colors, normals: expandNormals(normalsI8, V), indices };
  }
  throw new Error('bad magic: ' + magic);
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

const VERT = /* glsl */`
  in float alayer;
  in vec4 atint;
  out vec2 vUv;
  out vec4 vTint;
  flat out float vLayer;
  out vec3 vN;
  void main() {
    vUv = uv;
    vTint = atint;
    vLayer = alayer;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  precision highp sampler2DArray;
  uniform sampler2DArray map;
  uniform vec3 lightDir;
  in vec2 vUv;
  in vec4 vTint;
  flat in float vLayer;
  in vec3 vN;
  out vec4 frag;
  void main() {
    vec4 t = texture(map, vec3(vUv, vLayer));
    if (t.a < 0.5) discard;                       // alpha cutout (grass overlay etc.)
    float ndl = max(dot(normalize(vN), normalize(lightDir)), 0.0);
    float light = 0.45 + 0.55 * ndl;              // ambient + diffuse
    frag = vec4(t.rgb * vTint.rgb * light, 1.0);
  }
`;

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
      lightDir: { value: new THREE.Vector3(0.6, 1.0, 0.35).normalize() },
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

async function main() {
  const app = document.getElementById('app');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Output shader colors directly (the textures are already sRGB pixel art).
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fb6e8);

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
  camera.far = maxDim * 10;
  camera.updateProjectionMatrix();

  hud.textContent =
    `vantage · ${tile.textured ? 'VTL2 textured' : 'VTL1 flat'}\n` +
    `${tile.V.toLocaleString()} verts · ${(tile.I / 3).toLocaleString()} tris\n` +
    `extent ${Math.round(size.x)}×${Math.round(size.y)}×${Math.round(size.z)} blocks\n` +
    `drag: orbit · scroll: zoom`;

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}

main();
