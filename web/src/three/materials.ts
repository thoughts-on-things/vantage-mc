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
  in float alight;                                 // packed (sky<<4)|block, 0..255
  out vec2 vUv;
  out vec4 vTint;
  out vec3 vBcol;
  flat out float vLayer;
  flat out float vBiome;
  out vec3 vN;
  out float vFog;
  out float vSky;                                  // saved sky light, 0..1
  out float vBlk;                                  // saved block light, 0..1
  void main() {
    vUv = uv;
    vTint = atint;
    vBcol = abcol;
    vLayer = alayer;
    vBiome = abiome;
    float sky = floor(alight / 16.0);
    vSky = sky / 15.0;
    vBlk = (alight - sky * 16.0) / 15.0;
    // Water surface waves come from real mesh geometry (Minecraft flowing-water
    // heights, baked in the mesher) — the normal here carries the slope, so the
    // waves catch light. No vertex animation (BlueMap renders water static too).
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
  uniform float uDay;        // daylight 0..1 (scales sky light; 1 = noon)
  uniform float uAmbient;    // brightness floor at zero light (map readability)
  uniform float uExposure;   // overall brightness/tone multiplier (1 = neutral)
  uniform float uSharpness;  // texture mip LOD bias (>0 = crisper distance, more shimmer)
  uniform float uAoStrength; // baked AO darkening scale (1 = as-baked, 0 = off)
  uniform float uSaturation; // colour saturation (1 = neutral)
  uniform float uContrast;   // colour contrast around mid grey (1 = neutral)
  uniform float uFogDensity; // atmospheric haze amount (1 = full, 0 = clear)
  in vec2 vUv;
  in vec4 vTint;
  in vec3 vBcol;
  flat in float vLayer;
  flat in float vBiome;
  in vec3 vN;
  in float vFog;
  in float vSky;
  in float vBlk;
  out vec4 frag;
  const vec3 SKY = vec3(0.62, 0.72, 0.88);        // hemispheric sky ambient
  const vec3 GND = vec3(0.34, 0.31, 0.27);        // hemispheric ground ambient
  const vec3 SUN = vec3(1.0, 0.95, 0.84);         // warm key light
  const vec3 TORCH = vec3(1.0, 0.80, 0.52);       // warm tint where block light leads

  // Baked sky+block light -> a (brightness, colour) pair. Effective level is the
  // brighter of (sky * daylight) and block light, eased and floored so caves read
  // on a map; block-lit areas pick up a warm cast that sunlit ones don't.
  void bakedLight(out float amt, out vec3 col) {
    float sky = vSky * uDay;
    float lvl = max(sky, vBlk);
    float curve = lvl * lvl * (3.0 - 2.0 * lvl);  // smoothstep ease
    amt = mix(uAmbient, 1.0, curve);
    col = mix(vec3(1.0), TORCH, 0.6 * clamp(vBlk - sky, 0.0, 1.0));
  }

  // Pixel-art textures + the colour uniforms are authored in sRGB; decode to
  // linear so lighting is correct, then re-encode at the end (raw ShaderMaterial
  // bypasses three's colour management, and we render straight to the canvas).
  vec3 toLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }
  // Linear -> display sRGB (the OETF). Done in-shader since there's no OutputPass.
  vec3 toSRGB(vec3 c) {
    c = max(c, vec3(0.0));
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }

  // Minecraft's fixed face-direction brightness — the signature relief cue the
  // game bakes into every block's vertex colour: top 1.0, bottom 0.5, north/south
  // (±Z) 0.8, east/west (±X) 0.6. Full-cube faces have axis-aligned normals so the
  // pick is exact; this reads as Minecraft far more than a soft sun dot-product.
  float faceShade(vec3 n) {
    vec3 a = abs(n);
    if (a.y >= a.x && a.y >= a.z) return n.y >= 0.0 ? 1.0 : 0.5; // top / bottom
    if (a.x >= a.z) return 0.6;                                  // east / west
    return 0.8;                                                  // north / south
  }

  // Final colour grade: saturation then contrast around mid grey. Cheap pop/clarity
  // controls so the look is tunable without re-baking. Neutral at (1, 1).
  vec3 grade(vec3 c) {
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, uSaturation);
    c = (c - 0.5) * uContrast + 0.5;
    return max(c, vec3(0.0));
  }

  void main() {
    float lightAmt; vec3 lightCol;
    bakedLight(lightAmt, lightCol);
    vec4 t = texture(map, vec3(vUv, vLayer), -uSharpness); // negative bias = sharper
    if (t.a < 0.05) discard;                       // drop only fully-empty texels; the
                                                   // fractional edge becomes MSAA coverage
    t.rgb = toLinear(t.rgb);                        // work in linear; encode at the end
    vec3 fogCol = toLinear(uFogColor);
    vec3 N = normalize(vN);

    // Water pass: a semi-transparent blue tint over the normally-lit seabed —
    // BlueMap-style. The depth read comes from the SEABED darkening (sky light is
    // attenuated through water in the light pass), seen through the clear surface,
    // NOT from fading the water to opaque. So keep the surface fairly transparent
    // so sand/gravel/seagrass show through; the wave look is the real flowing-water
    // mesh geometry, whose sloped normal (vN) catches light.
    if (uWater > 0.5) {
      float depth = vTint.a;
      vec3 wcol = toLinear(vTint.rgb);
      wcol = mix(wcol, wcol * vec3(0.55, 0.66, 0.85), depth * 0.7); // deep water cools + deepens
      vec3 Nw = normalize(vN);
      float ndl2 = max(dot(Nw, normalize(lightDir)), 0.0);
      // Flat-lit like BlueMap (mostly the water colour × baked light); only a small
      // directional term so the wave-slope normals read, no blown-out sun sheen.
      vec3 wlit = grade(wcol * (0.62 + 0.28 * SUN * ndl2) * lightAmt * lightCol * uExposure);
      float wf = smoothstep(uFog.x, uFog.y, vFog) * uFogDensity;
      float wa = mix(0.5, 0.74, depth);                         // blue tint, seabed still reads through
      frag = vec4(toSRGB(mix(wlit, fogCol, wf)), wa);
      return;
    }

    float ao = 1.0 - (1.0 - vTint.a) * uAoStrength; // baked AO (colour alpha), strength-scaled
    vec3 texcol = t.rgb * toLinear(vTint.rgb);
    float luma = dot(texcol, vec3(0.299, 0.587, 0.114));
    // Biome view keeps terrain relief by modulating the flat biome colour by luma.
    vec3 biomecol = toLinear(vBcol) * (0.45 + 0.65 * luma);
    vec3 base = mix(texcol, biomecol, uBiomeMix);
    if (uBiomeMix > 0.5 && uHi >= 0.0 && abs(vBiome - uHi) > 0.5) {
      float g = dot(base, vec3(0.299, 0.587, 0.114));
      base = mix(base, vec3(g) * 0.55, 0.82);      // fade biomes other than the selected one
    }
    // Relief from Minecraft's per-face brightness (not a soft sun dot), times the
    // baked sky/block light and AO — i.e. the game's own shading formula. A faint
    // hemispheric colour cast (sky above / earth below) keeps the atmosphere
    // without washing out the crisp face steps.
    float fshade = faceShade(N);
    vec3 hemi = mix(GND, SKY, 0.5 + 0.5 * N.y);
    vec3 shade = mix(vec3(1.0), hemi, 0.16) * fshade;
    vec3 lit = grade(base * shade * ao * lightAmt * lightCol * uExposure);
    float f = smoothstep(uFog.x, uFog.y, vFog) * uFogDensity; // aerial depth into the horizon
    frag = vec4(toSRGB(mix(lit, fogCol, f)), uAlpha * t.a);   // alpha → MSAA coverage (foliage AA)
  }
`;

/** Build the textured terrain material from a decoded texture array. */
export function createTerrainMaterial(texData: DecodedTextureArray): THREE.ShaderMaterial {
  const tex = new THREE.DataArrayTexture(texData.pixels, texData.width, texData.height, texData.layers);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  // NEAREST mag keeps the crisp pixel-art look up close; mipmaps + anisotropy on
  // the min filter kill the distant shimmer/sparkle (worst on high-frequency leaf
  // and water textures viewed at a grazing angle). A texture *array* mips each
  // layer independently, so there's none of the atlas mip-bleed seam problem.
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 16; // three clamps this to the hardware max
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
      uDay: { value: 1.0 },        // noon; a day/night control can drive this
      uAmbient: { value: 0.12 },   // caves stay readable rather than pure black
      uExposure: { value: 1.0 },   // overall brightness/tone (live-tunable)
      uSharpness: { value: 0.0 },  // texture mip LOD bias (0 = smooth, >0 = crisper)
      uAoStrength: { value: 1.0 }, // baked AO darkening scale (1 = as-baked)
      uSaturation: { value: 1.0 }, // colour saturation (1 = neutral)
      uContrast: { value: 1.0 },   // colour contrast (1 = neutral)
      uFogDensity: { value: 1.0 }, // atmospheric haze amount (1 = full)
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    // Alpha-to-coverage turns the (mip-averaged, fractional) cutout edge of leaves
    // and grass into MSAA sample coverage instead of a hard discard — the standard
    // fix for the foliage shimmer/"noise" you get when moving the camera. Needs the
    // renderer's MSAA (antialias:true), which is on. Opaque blocks (alpha 1) are
    // unaffected. The water material stays transparent and ignores this.
    alphaToCoverage: true,
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
        frag = vec4(mix(uHorizon, uTop, t), 1.0); // authored sRGB, straight to the canvas
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
