// three.js materials for Vantage terrain: a textured `sampler2DArray` terrain
// shader with a biome-recolour mix, a transparent water variant that shares its
// uniforms, and a camera-locked gradient sky dome whose horizon matches the fog.

import * as THREE from 'three';
import type { DecodedTextureArray } from '../core/index.js';

/** Atmosphere palette — a calm Minecraft-ish daytime. Horizon doubles as fog. */
export const SKY_TOP: readonly [number, number, number] = [0.3, 0.52, 0.84];
export const SKY_HORIZON: readonly [number, number, number] = [0.72, 0.83, 0.95];

const VERT = /* glsl */ `
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

const FRAG = /* glsl */ `
  precision highp float;
  precision highp sampler2DArray;
  uniform sampler2DArray map;
  uniform vec3 lightDir;
  uniform float uBiomeMix;   // 0 = textured, 1 = biome layer
  uniform float uHi;         // highlighted biome id, or -1
  uniform vec3 uFogColor;
  uniform vec2 uFog;         // (near, far)
  uniform float uAlpha;      // terrain opacity (1)
  uniform float uWater;      // 1 = this is the water pass
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
    vec3 N = normalize(vN);
    vec3 ambient = mix(GND, SKY, 0.5 + 0.5 * N.y); // sky above, earth below
    float ndl = max(dot(N, normalize(lightDir)), 0.0);

    // Water pass: a mostly-flat biome-coloured surface (only a faint ripple from
    // the texture, so it doesn't read as noise). Depth (colour alpha, 0..1) drives
    // *opacity* — shallow water is clear so the seabed shows, deep water turns to
    // solid blue. That accumulation reads as real depth without per-block shading.
    if (uWater > 0.5) {
      float ripple = dot(t.rgb, vec3(0.299, 0.587, 0.114));
      vec3 wcol = vTint.rgb * (0.82 + 0.20 * ripple);
      float depth = vTint.a;
      wcol = mix(wcol, wcol * vec3(0.55, 0.66, 0.85), depth);   // deep water cools + deepens
      vec3 wlit = wcol * (0.55 + 0.40 * ambient + 0.45 * SUN * ndl);
      float wf = smoothstep(uFog.x, uFog.y, vFog);
      float wa = mix(0.35, 0.88, depth);                        // shallow clear -> deep opaque
      frag = vec4(mix(wlit, uFogColor, wf), wa);
      return;
    }

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
    vec3 lit = base * (0.25 + 0.45 * ambient + 0.55 * SUN * ndl) * ao;
    float f = smoothstep(uFog.x, uFog.y, vFog);    // aerial depth into the horizon
    frag = vec4(mix(lit, uFogColor, f), uAlpha);
  }
`;

/** Build the textured terrain material from a decoded texture array. */
export function createTerrainMaterial(texData: DecodedTextureArray): THREE.ShaderMaterial {
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
      uFog: { value: new THREE.Vector2(1e6, 2e6) }, // set from terrain extent
      uAlpha: { value: 1.0 },
      uWater: { value: 0.0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
}

/**
 * A transparent water material that shares the terrain material's uniforms (so
 * the biome toggle, fog, and light track together) but blends with no depth
 * write — the opaque seabed shows through, while terrain in front still occludes
 * it via the depth test.
 */
export function createWaterMaterial(terrain: THREE.ShaderMaterial): THREE.ShaderMaterial {
  const u: Record<string, THREE.IUniform> = {};
  for (const k in terrain.uniforms) u[k] = terrain.uniforms[k]!; // share refs
  u['uWater'] = { value: 1.0 }; // own water flag
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: u,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
  });
}

/**
 * A camera-locked gradient sky dome (depth-test off, drawn first) so the
 * background reads as sky from any zoom, with the horizon matching the fog.
 * Keep it centred on the camera each frame (`sky.position.copy(camera.position)`).
 */
export function createSky(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    vertexShader: /* glsl */ `
      out vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
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
