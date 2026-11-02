import * as THREE from 'three';
import { makeNoiseData, mulberry32, clamp } from './noise.js';

// ------------------------------------------------------------------ shared uniforms
export const U = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },     // key light (sun or moon)
  uRealSun: { value: new THREE.Vector3(0, 1, 0) },    // actual sun
  uKeyColor: { value: new THREE.Color(1, 1, 1) },
  uFogColor: { value: new THREE.Color(0.6, 0.7, 0.8) },
  uFogGlow: { value: new THREE.Color(1, 0.8, 0.6) },
  uFogDensity: { value: 0.00026 },
  uCloudCover: { value: 0.4 },
  uCloudOffset: { value: new THREE.Vector2(0, 0) },
  uCloudShadow: { value: 0.65 },
  uWindDir: { value: new THREE.Vector2(0.92, 0.39) },
  uWind: { value: 0.6 },
  uWet: { value: 0 },
  uRain: { value: 0 },
  uNight: { value: 0 },
  uNoiseTex: { value: null },
  uHeightTex: { value: null },
  uHeightInfo: { value: new THREE.Vector4(0, 0, 6000, 0) },
  uStrataTex: { value: null },
  uTarnL: { value: 0 },
  uTarnP: { value: new THREE.Vector4(0, 0, 0, 0) },
  uStreamTex: { value: null },
  uFallSeg: { value: new THREE.Vector4(0, 0, 0, 0) },
  uFallY: { value: new THREE.Vector2(-1000, -1000) },
  uStreamRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  uKeyVis: { value: 1 },
  uAmbient: { value: new THREE.Color(0.3, 0.35, 0.4) },
  uTSNear: { value: null },
  uTSFar: { value: null },
  uTSRect: { value: new THREE.Vector4(0, 0, 320, 5200) },
  uTrailTex: { value: null },
  uTrailRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  uPool: { value: new THREE.Vector4(0, 0, 0, -1000) },
  uPlain: { value: new THREE.Vector4(0, 0, 0, -1000) },
  uValleyFog: { value: 0 },
};

// ------------------------------------------------------------------ noise texture (+ JS sampler)
export const NOISE_SIZE = 256;
export let noiseData = null;
export function initNoise() {
  noiseData = makeNoiseData(NOISE_SIZE, 11);
  const t = new THREE.DataTexture(noiseData, NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.needsUpdate = true;
  U.uNoiseTex.value = t;
  return t;
}
// bilinear sample channel c at uv (repeat)
export function noiseAt(u, v, c) {
  const S = NOISE_SIZE;
  let x = u * S - 0.5, y = v * S - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y); const tx = x - x0, ty = y - y0;
  const g = (a, b) => noiseData[((((b % S) + S) % S) * S + (((a % S) + S) % S)) * 4 + c] / 255;
  const a = g(x0, y0), b = g(x0 + 1, y0), cc = g(x0, y0 + 1), d = g(x0 + 1, y0 + 1);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty;
}
// JS mirror of GLSL windGust()
export function windGust(x, z, t) {
  const wd = U.uWindDir.value;
  const qx = (x - wd.x * t * 7.0) * 0.0045, qz = (z - wd.y * t * 7.0) * 0.0045;
  const n = noiseAt(qx, qz, 1);
  const w = Math.sin((x * wd.x + z * wd.y) * 0.21 - t * 3.1 + n * 6.0) * 0.5 + 0.5;
  return clamp(n * 1.6 - 0.35, 0, 1) * 0.7 + w * 0.3;
}

// ------------------------------------------------------------------ strata palette
export function makeStrataTexture() {
  const W = 1024;
  const data = new Uint8Array(W * 4);
  const r = mulberry32(99);
  const pal = [
    [0.82, 0.55, 0.22], // ochre
    [0.68, 0.24, 0.13], // rust red
    [0.50, 0.58, 0.40], // sage green
    [0.66, 0.63, 0.58], // pale grey
    [0.80, 0.70, 0.52], // cream
    [0.50, 0.22, 0.18], // maroon
    [0.78, 0.63, 0.34], // mustard
    [0.60, 0.64, 0.56], // grey-green
    [0.82, 0.45, 0.25], // orange rust
    [0.62, 0.52, 0.44], // ash-mauve
  ];
  const seq = [0, 1, 8, 2, 6, 5, 3, 0, 1, 7, 4, 8, 5, 2, 6, 1, 9, 0, 8, 7, 1, 5, 6, 2, 3, 1];
  let x = 0, si = 0;
  const cols = [];
  while (x < W) {
    const c = pal[seq[si % seq.length]]; si++;
    const w = Math.floor(12 + r() * 58);
    const jitter = 0.9 + r() * 0.18;
    for (let k = 0; k < w && x < W; k++, x++) {
      // thin internal laminations
      const lam = 1 + 0.06 * Math.sin(k * 1.7 + r() * 0.4) - (k < 2 ? 0.08 : 0);
      cols.push([c[0] * jitter * lam, c[1] * jitter * lam, c[2] * jitter * lam]);
    }
  }
  // soften band edges slightly (painterly)
  for (let i = 0; i < W; i++) {
    let s = [0, 0, 0], n = 0;
    for (let k = -2; k <= 2; k++) { const c = cols[(i + k + W) % W]; s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; n++; }
    // store in sRGB-ish 8 bit, decoded as sRGB
    for (let ch = 0; ch < 3; ch++) data[i * 4 + ch] = Math.floor(clamp(Math.pow(s[ch] / n, 1 / 2.2), 0, 1) * 255);
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, W, 1, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  U.uStrataTex.value = t;
  return t;
}

// ------------------------------------------------------------------ GLSL chunks
export const GLSL_COMMON = /* glsl */`
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uRealSun;
uniform vec3 uKeyColor;
uniform vec3 uFogColor;
uniform vec3 uFogGlow;
uniform float uFogDensity;
uniform float uCloudCover;
uniform vec2 uCloudOffset;
uniform float uCloudShadow;
uniform vec2 uWindDir;
uniform float uWind;
uniform float uWet;
uniform float uRain;
uniform float uNight;
uniform float uKeyVis;
uniform sampler2D uNoiseTex;
uniform sampler2D uHeightTex;
uniform vec4 uHeightInfo;
uniform sampler2D uStrataTex;
uniform float uTarnL;
uniform vec4 uTarnP;
uniform sampler2D uStreamTex;
uniform vec4 uFallSeg;
uniform vec2 uFallY;
float fallWet(vec3 wp){
  vec2 a = uFallSeg.xy, b = uFallSeg.zw, ab = b - a;
  float tt = clamp(dot(wp.xz - a, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
  float dF = length(wp.xz - (a + ab * tt));
  return (1.0 - smoothstep(3.0, 10.0, dF)) * smoothstep(uFallY.x - 2.0, uFallY.x + 1.0, wp.y) * (1.0 - smoothstep(uFallY.y, uFallY.y + 3.0, wp.y));
}
uniform vec4 uStreamRect;
uniform sampler2D uTSNear;
uniform sampler2D uTSFar;
uniform vec4 uTSRect;
uniform sampler2D uTrailTex;
uniform vec4 uTrailRect;
uniform vec4 uPool;
uniform vec4 uPlain;
uniform float uValleyFog;
float trailDist(vec2 xz){ vec2 uv = (xz - uTrailRect.xy) / uTrailRect.zw; if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 9.0; float v = texture2D(uTrailTex, uv).r * 255.0 / 60.0; return v > 4.2 ? 9.0 : v; }

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float nz(vec2 p){ return texture2D(uNoiseTex, p).r; }

float cloudDensity(vec2 p){
  vec2 q = p * 0.000062 + uCloudOffset;
  float n = texture2D(uNoiseTex, q).a * 0.55 + texture2D(uNoiseTex, q * 2.31 + vec2(0.31, 0.17)).b * 0.3 + texture2D(uNoiseTex, q * 5.3 + vec2(0.7)).g * 0.15;
  float c = uCloudCover;
  return smoothstep(1.0 - c, 1.0 - c + 0.34, n + 0.12 * c);
}
float cloudShadowAt(vec3 wp){
  vec3 L = uRealSun;
  if (L.y < 0.03) return 1.0;
  vec3 p = wp + L * ((2600.0 - wp.y) / L.y);
  return 1.0 - cloudDensity(p.xz) * uCloudShadow;
}
float terrainH(vec2 xz){
  vec2 uv = (xz - uHeightInfo.xy) / uHeightInfo.z + 0.5;
  return texture2D(uHeightTex, uv).r;
}
float terrainShadowAt(vec3 wp, float bias){
  if (uSunDir.y < -0.08) return 0.0;
  vec2 uf = wp.xz / uTSRect.w + 0.5;
  vec2 un = (wp.xz - uTSRect.xy) / uTSRect.z + 0.5;
  float sf = texture2D(uTSFar, uf).r;
  float sn = texture2D(uTSNear, clamp(un, 0.0, 1.0)).r;
  vec2 en = min(un, 1.0 - un);
  float s = mix(sf, sn, smoothstep(0.0, 0.08, min(en.x, en.y)));
  vec2 ef = min(uf, 1.0 - uf);
  return mix(1.0, s, smoothstep(0.0, 0.03, min(ef.x, ef.y)));
}
float windGust(vec2 p){
  vec2 q = (p - uWindDir * uTime * 7.0) * 0.0045;
  float n = texture2D(uNoiseTex, q).g;
  float w = sin(dot(p, uWindDir) * 0.21 - uTime * 3.1 + n * 6.0) * 0.5 + 0.5;
  return clamp(n * 1.6 - 0.35, 0.0, 1.0) * 0.7 + w * 0.3;
}
vec3 applyFog(vec3 col, vec3 wp){
  vec3 d = wp - cameraPosition;
  float dist = length(d);
  vec3 v = d / max(dist, 1e-3);
  float b = 0.0014;
  float a = uFogDensity * exp(-max(cameraPosition.y, 0.0) * b);
  float vy = v.y * dist * b;
  float amt = a * dist * (abs(vy) > 1e-3 ? (1.0 - exp(-vy)) / vy : 1.0);
  amt = 1.0 - exp(-amt);
  float g = max(dot(v, uRealSun), 0.0);
  vec3 fc = mix(uFogColor, uFogGlow, pow(g, 5.0) * 0.85 + pow(g, 40.0) * 0.4);
  col = mix(col, fc, clamp(amt, 0.0, 1.0));
  // low mist pooling in the valley at dawn and after rain
  if (uValleyFog > 0.001) {
    float lowF = smoothstep(80.0, 22.0, wp.y) * (1.0 - exp(-dist * 0.0032));
    float nz = texture2D(uNoiseTex, wp.xz * 0.0016 + uTime * 0.002).r;
    col = mix(col, fc * 1.08 + 0.02, clamp(lowF * uValleyFog * (0.55 + 0.6 * nz), 0.0, 0.92));
  }
  return col;
}
// cellular pebbles: returns (edge distance, cell id)
vec2 pebbles(vec2 p){
  vec2 ip = floor(p), fp = fract(p);
  float d1 = 8.0, d2 = 8.0; float id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = hash22(ip + g) * 0.8 + 0.1;
    vec2 r = g + o - fp;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = hash12(ip + g); } else if (d < d2) d2 = d;
  }
  return vec2(sqrt(d2) - sqrt(d1), id);
}
vec3 strataColor(vec3 wp){
  float warp = (texture2D(uNoiseTex, wp.xz * 0.0011).r - 0.5) * 46.0 + (texture2D(uNoiseTex, wp.xz * 0.006).g - 0.5) * 9.0;
  float y = wp.y + warp + dot(wp.xz, vec2(0.045, 0.028));
  float fine = (texture2D(uNoiseTex, wp.xz * 0.03).b - 0.5) * 0.004;
  return texture2D(uStrataTex, vec2(y / 330.0 + fine, 0.5)).rgb;
}
`;

// Vertex common: world position varying
export const GLSL_FRAG = /* glsl */`
vec3 perturbNormalArb2(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection) {
  vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
  vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
  vec3 vN = surf_norm;
  vec3 R1 = cross(vSigmaY, vN);
  vec3 R2 = cross(vN, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDirection;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
`;

export const V_WPOS = /* glsl */`
varying vec3 vWPos;
varying vec3 vWNrm;
`;
export const V_WPOS_CALC = /* glsl */`
{
  vec4 _wp = vec4(transformed, 1.0);
  vec3 _wn = objectNormal;
  #ifdef USE_INSTANCING
    _wp = instanceMatrix * _wp;
    _wn = mat3(instanceMatrix) * _wn;
  #endif
  _wp = modelMatrix * _wp;
  vWPos = _wp.xyz;
  vWNrm = normalize(mat3(modelMatrix) * _wn);
}
`;

let patchId = 0;
/**
 * Patch a built-in lit material with the scene-wide lighting model:
 * terrain-cast soft shadows, cloud shadows, aerial perspective fog, wetness, custom hooks.
 */
export function patch(mat, o = {}) {
  const key = o.sharedKey ? ('s_' + o.key) : ('p' + (patchId++) + (o.key || ''));
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    if (o.uniforms) Object.assign(sh.uniforms, o.uniforms);
    let vs = sh.vertexShader, fs = sh.fragmentShader;
    vs = vs.replace('#include <common>', '#include <common>\n' + GLSL_COMMON + V_WPOS + (o.vHead || '') + (o.vertexShadow ? 'varying float vTSh;\n' : ''));
    if (o.vBegin) vs = vs.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + o.vBegin);
    vs = vs.replace('#include <project_vertex>', V_WPOS_CALC + (o.vertexShadow && o.vertexShadow !== 'custom' ? 'vTSh = terrainShadowAt(vWPos, 1.5) * cloudShadowAt(vWPos);\n' : '') + (o.vEnd || '') + '#include <project_vertex>');
    fs = fs.replace('#include <common>', '#include <common>\n' + GLSL_COMMON + GLSL_FRAG + V_WPOS + (o.fHead || '') + (o.vertexShadow ? 'varying float vTSh;\n' : '') + 'float gBump = 0.0; float gWetAmt = 0.0;\n');
    let colorBlock = '#include <color_fragment>\n' + (o.fColor || '');
    if (o.wet) colorBlock += `
        gWetAmt = uWet * smoothstep(0.2, 0.9, vWNrm.y * 0.5 + 0.5) * ${o.wet.toFixed(2)};
        diffuseColor.rgb *= 1.0 - 0.42 * gWetAmt;`;
    fs = fs.replace('#include <color_fragment>', colorBlock);
    if (o.wet) fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.38, gWetAmt);');
    if (o.fRough) fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + o.fRough);
    if (o.bump) fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      normal = perturbNormalArb2(-vViewPosition, normal, vec2(dFdx(gBump), dFdy(gBump)) * ${o.bump.toFixed(3)} * (1.0 - 0.6 * gWetAmt), faceDirection);`);
    if (o.fNormal) fs = fs.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + o.fNormal);
    const shadowExpr = o.noTerrainShadow ? '1.0' : (o.vertexShadow ? 'vTSh' : `terrainShadowAt(vWPos, ${(o.shadowBias ?? 1.2).toFixed(2)}) * cloudShadowAt(vWPos)`);
    fs = fs.replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
      { float _sh = ${shadowExpr} * uKeyVis; reflectedLight.directDiffuse *= _sh; reflectedLight.directSpecular *= _sh; gTSh = _sh; }`);
    fs = fs.replace('#include <lights_fragment_begin>', 'float gTSh = 1.0;\n#include <lights_fragment_begin>');
    if (o.fLight) fs = fs.replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + o.fLight);
    fs = fs.replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyFog(gl_FragColor.rgb, vWPos);');
    sh.vertexShader = vs; sh.fragmentShader = fs;
    if (o.onShader) o.onShader(sh);
  };
  return mat;
}

// ------------------------------------------------------------------ canvas textures
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }

export function fabricTexture(opts = {}) {
  const S = opts.size || 256;
  const [c, g] = canvas(S, S);
  const r = mulberry32(opts.seed || 3);
  g.fillStyle = '#d2d2d2'; g.fillRect(0, 0, S, S);
  const step = opts.step || 4;
  // plain weave: alternating over/under threads
  for (let y = 0; y < S; y += step) for (let x = 0; x < S; x += step) {
    const over = ((x / step + y / step) & 1) === 0;
    const v = over ? 225 + r() * 30 : 180 + r() * 25;
    g.fillStyle = `rgb(${v},${v},${v})`;
    if (over) g.fillRect(x, y + 0.5, step, step - 1); else g.fillRect(x + 0.5, y, step - 1, step);
  }
  if (opts.ripstop) {
    g.strokeStyle = 'rgba(210,210,210,0.8)'; g.lineWidth = 1.2;
    for (let k = 0; k < S; k += opts.ripstop) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k, S); g.stroke(); g.beginPath(); g.moveTo(0, k); g.lineTo(S, k); g.stroke(); }
  }
  // stitches (dashed seams) in given rows/cols (normalized)
  const dash = (x0, y0, x1, y1) => {
    g.strokeStyle = 'rgba(235,225,200,0.95)'; g.lineWidth = 1.6; g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); g.setLineDash([]);
    g.strokeStyle = 'rgba(40,40,40,0.5)'; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(x0 - 3, y0 - 3 * (x1 === x0 ? 0 : 1)); g.lineTo(x1 - 3 * (y1 === y0 ? 0 : 1), y1); g.stroke();
  };
  (opts.seamsU || []).forEach(u => dash(u * S, 0, u * S, S));
  (opts.seamsV || []).forEach(v => dash(0, v * S, S, v * S));
  // fading / grime
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(${r() < 0.5 ? 90 : 240},${r() < 0.5 ? 90 : 235},${r() < 0.5 ? 80 : 220},${0.04 + r() * 0.05})`;
    g.beginPath(); g.arc(r() * S, r() * S, 8 + r() * 40, 0, 7); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function woodTexture(seed = 5, opts = {}) {
  const W = 256, Hh = 512;
  const [c, g] = canvas(W, Hh);
  const r = mulberry32(seed);
  const base = opts.base || [118, 96, 72];
  g.fillStyle = `rgb(${base})`; g.fillRect(0, 0, W, Hh);
  // grain lines along v
  for (let i = 0; i < 160; i++) {
    const x0 = r() * W; const wv = 0.5 + r() * 2.2;
    const dark = r() < 0.6;
    g.strokeStyle = dark ? `rgba(55,40,28,${0.15 + r() * 0.35})` : `rgba(210,190,160,${0.08 + r() * 0.18})`;
    g.lineWidth = wv; g.beginPath();
    let x = x0; g.moveTo(x, 0);
    for (let y = 0; y <= Hh; y += 8) { x += (r() - 0.5) * 1.4 + Math.sin(y * 0.02 + i) * 0.4; g.lineTo(x, y); }
    g.stroke();
  }
  // knots
  for (let k = 0; k < 4; k++) {
    const kx = r() * W, ky = r() * Hh;
    for (let q = 10; q > 0; q--) { g.strokeStyle = `rgba(60,40,25,${0.08 + q * 0.02})`; g.lineWidth = 1.2; g.beginPath(); g.ellipse(kx, ky, q * 1.4, q * 2.8, 0, 0, 7); g.stroke(); }
    g.fillStyle = 'rgba(40,26,16,0.8)'; g.beginPath(); g.ellipse(kx, ky, 3, 5, 0, 0, 7); g.fill();
  }
  // weathering cracks
  for (let k = 0; k < 18; k++) {
    g.strokeStyle = `rgba(30,22,16,${0.3 + r() * 0.4})`; g.lineWidth = 0.8 + r() * 1.2;
    let x = r() * W, y = r() * Hh; g.beginPath(); g.moveTo(x, y);
    const L = 20 + r() * 110; for (let s = 0; s < L; s += 6) { x += (r() - 0.5) * 2; y += 6; g.lineTo(x, y); }
    g.stroke();
  }
  // silver-grey sun bleaching
  g.fillStyle = `rgba(190,185,175,${opts.bleach ?? 0.28})`; g.fillRect(0, 0, W, Hh);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// silk khadag: fine weave + woven border motifs (geometric, no glyphs) + fringe alpha
export function khadagTexture() {
  const W = 128, Hh = 512;
  const [c, g] = canvas(W, Hh);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, Hh);
  for (let y = 0; y < Hh; y += 2) { g.fillStyle = `rgba(0,0,0,${y % 4 ? 0.07 : 0.0})`; g.fillRect(0, y, W, 1); }
  for (let x = 0; x < W; x += 2) { g.fillStyle = `rgba(0,0,0,${x % 4 ? 0.05 : 0.0})`; g.fillRect(x, 0, 1, Hh); }
  // woven diamond band motifs (tonal)
  g.strokeStyle = 'rgba(0,0,0,0.13)'; g.lineWidth = 1.5;
  for (let y = 60; y < Hh - 60; y += 64) {
    for (let x = 16; x < W; x += 32) { g.beginPath(); g.moveTo(x, y - 12); g.lineTo(x + 10, y); g.lineTo(x, y + 12); g.lineTo(x - 10, y); g.closePath(); g.stroke(); }
    g.beginPath(); g.moveTo(0, y - 20); g.lineTo(W, y - 20); g.moveTo(0, y + 20); g.lineTo(W, y + 20); g.stroke();
  }
  // fringe at the free end (alpha later via threshold in shader)
  for (let x = 0; x < W; x += 3) { g.fillStyle = 'rgba(0,0,0,1)'; g.fillRect(x + 2, Hh - 22, 1, 22); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 4;
  return t;
}

export function leatherTexture() {
  const S = 256; const [c, g] = canvas(S, S); const r = mulberry32(8);
  g.fillStyle = '#6b4a33'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 1800; i++) { g.fillStyle = `rgba(${r() < 0.5 ? 30 : 150},${r() < 0.5 ? 20 : 110},${r() < 0.5 ? 12 : 80},0.12)`; g.fillRect(r() * S, r() * S, 1 + r() * 3, 1 + r() * 2); }
  for (let i = 0; i < 30; i++) { g.strokeStyle = `rgba(200,180,150,${0.1 + r() * 0.15})`; g.lineWidth = 0.6; g.beginPath(); const x = r() * S, y = r() * S; g.moveTo(x, y); g.lineTo(x + (r() - .5) * 40, y + (r() - .5) * 10); g.stroke(); }
  // stitching rows
  g.setLineDash([5, 3]); g.strokeStyle = 'rgba(225,205,160,0.95)'; g.lineWidth = 1.6;
  [0.18, 0.22, 0.62].forEach(v => { g.beginPath(); g.moveTo(0, v * S); g.lineTo(S, v * S); g.stroke(); });
  [0.3, 0.7].forEach(u => { g.beginPath(); g.moveTo(u * S, 0); g.lineTo(u * S, 0.6 * S); g.stroke(); });
  g.setLineDash([]);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export function barkTexture(seed = 3) {
  const W = 128, Hh = 256; const [c, g] = canvas(W, Hh); const r = mulberry32(seed);
  g.fillStyle = '#5a4636'; g.fillRect(0, 0, W, Hh);
  for (let i = 0; i < 90; i++) {
    const x = r() * W; g.strokeStyle = `rgba(${r() < .5 ? 25 : 140},${r() < .5 ? 18 : 120},${r() < .5 ? 12 : 100},${0.3 + r() * 0.4})`;
    g.lineWidth = 1 + r() * 4; g.beginPath(); let xx = x; g.moveTo(xx, 0);
    for (let y = 0; y < Hh; y += 10) { xx += (r() - 0.5) * 5; g.lineTo(xx, y); } g.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function featherTexture() {
  const W = 256, Hh = 128; const [c, g] = canvas(W, Hh); const r = mulberry32(21);
  g.fillStyle = '#6a4a2e'; g.fillRect(0, 0, W, Hh);
  // rows of overlapping feathers with rachis lines
  for (let row = 0; row < 8; row++) for (let k = 0; k < 18; k++) {
    const x = k * 15 + (row % 2) * 7, y = row * 16;
    const shade = 70 + r() * 60;
    g.fillStyle = `rgb(${shade + 30},${shade},${shade * 0.6})`;
    g.beginPath(); g.ellipse(x, y + 8, 7, 12, 0, 0, 7); g.fill();
    g.strokeStyle = 'rgba(30,20,10,0.5)'; g.lineWidth = 0.8; g.beginPath(); g.moveTo(x, y - 2); g.lineTo(x, y + 18); g.stroke();
    for (let b = 0; b < 6; b++) { g.strokeStyle = 'rgba(20,12,6,0.25)'; g.beginPath(); g.moveTo(x, y + b * 3); g.lineTo(x + 6, y + b * 3 + 3); g.moveTo(x, y + b * 3); g.lineTo(x - 6, y + b * 3 + 3); g.stroke(); }
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
