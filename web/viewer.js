// Vantage P1 viewer — loads one `.vtile` and renders it with three.js.
//
// This is the thin end of the "versioned binary tile contract": it knows only
// how to parse VTL1 and draw it. No streaming, no LOD, no atlas yet — that is
// P4/P5. The point is to prove the generator's output renders as real terrain.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const TILE_URL = './terrain.vtile';
const hud = document.getElementById('hud');

function fail(msg) {
  const el = document.getElementById('err');
  el.style.display = 'grid';
  el.textContent = 'Error: ' + msg;
  hud.style.display = 'none';
  console.error(msg);
}

// Parse a VTL1 blob into typed-array views (zero-copy where alignment allows).
function parseTile(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'VTL1') throw new Error('bad magic: ' + magic);
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error('unsupported version ' + version);
  const V = dv.getUint32(8, true);
  const I = dv.getUint32(12, true);

  let off = 16;
  const positions = new Float32Array(buf, off, 3 * V); off += 12 * V;
  const colors = new Uint8Array(buf, off, 4 * V); off += 4 * V;
  const normalsI8 = new Int8Array(buf, off, 4 * V); off += 4 * V;
  const indices = new Uint32Array(buf, off, I); off += 4 * I;

  // Expand packed (xyz+pad) i8 normals to float xyz.
  const normals = new Float32Array(3 * V);
  for (let i = 0; i < V; i++) {
    normals[i * 3 + 0] = normalsI8[i * 4 + 0];
    normals[i * 3 + 1] = normalsI8[i * 4 + 1];
    normals[i * 3 + 2] = normalsI8[i * 4 + 2];
  }
  return { V, I, positions, colors, normals, indices };
}

function buildGeometry(tile) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(tile.positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(tile.normals, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(tile.colors, 4, true));
  geom.setIndex(new THREE.BufferAttribute(tile.indices, 1));
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

async function main() {
  const app = document.getElementById('app');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fb6e8);
  scene.fog = new THREE.Fog(0x8fb6e8, 200, 900);

  // Lighting: sky/ground hemisphere fill + an angled sun for relief.
  scene.add(new THREE.HemisphereLight(0xbcd7ff, 0x4a4636, 1.0));
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
  sun.position.set(0.6, 1.0, 0.35);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0xffffff, 0.18));

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 5000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  let resp;
  try {
    resp = await fetch(TILE_URL);
    if (!resp.ok) throw new Error(resp.status + ' ' + resp.statusText);
  } catch (e) {
    return fail('fetch ' + TILE_URL + ': ' + e.message);
  }
  const buf = await resp.arrayBuffer();

  let tile, geom;
  try {
    tile = parseTile(buf);
    geom = buildGeometry(tile);
  } catch (e) {
    return fail('parse: ' + e.message);
  }

  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geom, material);
  scene.add(mesh);

  // Frame the geometry.
  const bb = geom.boundingBox;
  const center = new THREE.Vector3(); bb.getCenter(center);
  const size = new THREE.Vector3(); bb.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  controls.target.copy(center);
  camera.position.set(center.x + maxDim * 0.7, center.y + maxDim * 0.6, center.z + maxDim * 0.7);
  camera.far = maxDim * 8;
  camera.updateProjectionMatrix();
  scene.fog.near = maxDim * 0.6;
  scene.fog.far = maxDim * 3.5;

  hud.textContent =
    `vantage P1 · VTL1\n` +
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
