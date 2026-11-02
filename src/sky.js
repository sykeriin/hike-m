import * as THREE from 'three';
import { U, GLSL_COMMON } from './materials.js';

export const skyUniforms = {
  uZenith: { value: new THREE.Color() },
  uHorizon: { value: new THREE.Color() },
  uSunGlow: { value: new THREE.Color() },
  uSunDisk: { value: new THREE.Color() },
  uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
  uStarRot: { value: new THREE.Matrix3() },
  uCloudLit: { value: new THREE.Color() },
  uCloudAmb: { value: new THREE.Color() },
  uCloudDark: { value: 0 },
  uLightning: { value: new THREE.Vector4(0, 0, 1, 0) },
  uStarVis: { value: 0 },
  uMoonVis: { value: 0 },
};

const SKY_FS = /* glsl */`
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uSunGlow; uniform vec3 uSunDisk;
uniform vec3 uMoonDir; uniform mat3 uStarRot; uniform vec3 uCloudLit; uniform vec3 uCloudAmb;
uniform float uCloudDark; uniform vec4 uLightning; uniform float uStarVis; uniform float uMoonVis;
varying vec3 vDir;

float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec3 starLayer(vec3 d, float scale, float thresh, float rad, float bright){
  vec3 p = d * scale; vec3 ip = floor(p); vec3 fp = fract(p);
  float h = hash13(ip);
  if (h < thresh) return vec3(0.0);
  vec3 sp = vec3(hash13(ip + 1.3), hash13(ip + 2.7), hash13(ip + 5.1)) * 0.6 + 0.2;
  float dist = length(fp - sp);
  float px = fwidth(p.x) + fwidth(p.y);
  float r = max(rad, px * 0.6);
  float s = smoothstep(r, 0.0, dist) * (rad / r) * (rad / r);
  float tw = 0.75 + 0.25 * sin(uTime * (2.0 + h * 5.0) + h * 40.0);
  float t = hash13(ip + 9.1);
  vec3 col = mix(vec3(0.65, 0.78, 1.0), vec3(1.0, 0.82, 0.62), t);
  col = mix(col, vec3(1.0), 0.5);
  return col * s * bright * tw * ((h - thresh) / (1.0 - thresh) * 0.8 + 0.2);
}
vec3 milkyWay(vec3 c){
  vec3 N = normalize(vec3(0.26, 0.48, -0.84));
  vec3 C = normalize(cross(N, vec3(0.0, 1.0, 0.0)));
  vec3 E = cross(N, C);
  float b = dot(c, N);
  float l = atan(dot(c, E), dot(c, C));
  vec2 uv = vec2(l / 6.2831853 * 4.0, b * 1.6);
  float n = texture2D(uNoiseTex, uv * 1.0).r * 0.5 + texture2D(uNoiseTex, uv * 3.1 + 0.3).g * 0.3 + texture2D(uNoiseTex, uv * 9.0).b * 0.2;
  float band = exp(-pow(b / (0.09 + 0.05 * n), 2.0));
  float core = pow(max(dot(c, C), 0.0), 3.0);
  float dust = smoothstep(0.35, 0.75, texture2D(uNoiseTex, uv * vec2(2.0, 5.0) + 0.7).a) * exp(-pow(b / 0.05, 2.0));
  float grain = texture2D(uNoiseTex, uv * 14.0).r * 0.6 + texture2D(uNoiseTex, uv * 31.0 + 0.2).g * 0.4;
  float m = band * pow(0.25 + 0.9 * n, 1.6) * (0.6 + 0.8 * grain) * (0.45 + 1.1 * core) * (1.0 - 0.85 * dust);
  vec3 col = mix(vec3(0.55, 0.62, 0.85), vec3(1.0, 0.85, 0.66), core * 0.8 + n * 0.2);
  return col * m * 0.07;
}
vec3 moonDisk(vec3 v, out float mask){
  vec3 M = normalize(uMoonDir);
  float r = 0.0115;
  float cd = dot(v, M);
  mask = 0.0;
  vec3 glow = vec3(0.5, 0.6, 0.8) * (pow(max(cd, 0.0), 800.0) * 0.5 + pow(max(cd, 0.0), 60.0) * 0.04);
  if (cd < cos(r)) return glow;
  vec3 T = normalize(cross(M, vec3(0.0, 1.0, 0.0)));
  vec3 B = cross(T, M);
  vec2 q = vec2(dot(v - M, T), dot(v - M, B)) / r;
  float rr = dot(q, q);
  if (rr > 1.0) return glow;
  // maria & craters
  float mar = texture2D(uNoiseTex, q * 0.16 + 0.4).r;
  float alb = 0.75 - smoothstep(0.45, 0.62, mar) * 0.32;
  vec2 cp = q * 5.0;
  vec2 ip = floor(cp), fp = fract(cp);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = hash22(ip + g);
    float cr = 0.12 + 0.3 * hash12(ip + g + 3.0);
    float dd = length(g + o - fp);
    alb -= 0.12 * smoothstep(cr, cr * 0.6, dd);
    alb += 0.1 * smoothstep(cr * 0.8, cr, dd) * smoothstep(cr * 1.25, cr, dd);
  }
  alb += (texture2D(uNoiseTex, q * 0.9).b - 0.5) * 0.15;
  vec3 sunL = normalize(uRealSun);
  // light from sun onto moon sphere (world-space normal)
  vec3 nW = normalize(q.x * T + q.y * B - sqrt(1.0 - rr) * M);
  float lit = smoothstep(-0.05, 0.25, dot(nW, sunL));
  mask = smoothstep(1.0, 0.92, rr);
  return mix(glow, vec3(1.0, 0.97, 0.9) * alb * (0.03 + 2.6 * lit), mask);
}
void main(){
  vec3 v = normalize(vDir);
  float y = v.y;
  float yh = max(y, 0.0);
  vec3 sky = mix(uHorizon, uZenith, pow(yh, 0.42));
  if (y < 0.0) sky = mix(uHorizon, uHorizon * 0.55, smoothstep(0.0, 0.3, -y));
  float sd = dot(v, uRealSun);
  float sdp = max(sd, 0.0);
#ifdef ENV_PASS
  sky += uSunGlow * (pow(sdp, 5.0) * 0.28) * (1.0 - uCloudDark * 0.8);
#else
  sky += uSunGlow * (pow(sdp, 5.0) * 0.28 + pow(sdp, 48.0) * 0.9 + pow(sdp, 900.0) * 3.0) * (1.0 - uCloudDark * 0.8);
#endif
  // horizon brightening band
  sky += uHorizon * 0.15 * exp(-abs(y) * 18.0);

  vec3 cel = uStarRot * v;
  float above = smoothstep(-0.02, 0.12, y);
  float extinction = mix(0.25, 1.0, smoothstep(0.0, 0.35, y));
  vec3 night = vec3(0.0);
  if (uStarVis > 0.001) {
    vec3 mw = milkyWay(cel);
    float mwb = length(mw) * 8.0;
    night += mw;
    night += starLayer(cel, 70.0, 0.96, 0.045, 9.0);
    night += starLayer(cel, 160.0, 0.9, 0.05, 3.2);
    night += starLayer(cel, 340.0, 0.84 - mwb * 0.25, 0.06, 1.6);
    night += starLayer(cel, 640.0, 0.8 - mwb * 0.3, 0.07, 0.55) * clamp(mwb * 2.0, 0.0, 1.0);
    // airglow
    night += vec3(0.02, 0.05, 0.03) * exp(-yh * 9.0) * 0.4;
    sky += night * uStarVis * above * extinction;
  }
  float mMask = 0.0;
  if (uMoonVis > 0.001) sky += moonDisk(v, mMask) * uMoonVis * above;
  // sun disk
#ifndef ENV_PASS
  float disk = smoothstep(0.99991, 0.99996, sd);
  sky += uSunDisk * disk * 60.0 * smoothstep(-0.02, 0.01, y);
#endif

  // ---- clouds on a curved-ish plane
  if (y > 0.0) {
    float H = 2600.0 - cameraPosition.y;
    float t = H / max(y, 0.015);
    vec3 p = cameraPosition + v * t;
    float d = cloudDensity(p.xz);
    // wispy high cirrus
    vec2 cq = p.xz * 0.000025 + uCloudOffset * 0.4;
    float ci = smoothstep(0.6, 0.95, texture2D(uNoiseTex, cq * vec2(1.0, 3.0)).b) * 0.35 * (1.0 - uCloudDark) * (1.0 - uStarVis * 0.75);
    if (d > 0.001 || ci > 0.001) {
      float d2 = cloudDensity(p.xz + uRealSun.xz * 380.0);
      float lightT = 1.0 - d2 * 0.75;
      float thick = smoothstep(0.0, 1.0, d);
      vec3 lit = uCloudLit * lightT * (1.0 + pow(sdp, 8.0) * 2.5 * (1.0 - thick));
      vec3 cc = uCloudAmb * (1.0 - 0.45 * thick) + lit * (1.0 - uCloudDark * 0.85);
      // silver lining on thin edges toward sun
      cc += uSunGlow * pow(sdp, 12.0) * (1.0 - thick) * 1.2;
      float fade = exp(-t * 0.000035);
      vec3 hz = uHorizon;
      cc = mix(hz, cc, fade);
      float a = clamp(d * 1.2, 0.0, 1.0) * (0.25 + 0.75 * smoothstep(0.0, 0.12, y));
      sky = mix(sky, cc, a);
      sky = mix(sky, uCloudLit * 0.9 + uCloudAmb, ci * (1.0 - a) * fade);
      // lightning inside clouds
      if (uLightning.w > 0.0) {
        float ld = max(dot(v, normalize(uLightning.xyz)), 0.0);
        sky += vec3(0.75, 0.8, 1.0) * uLightning.w * pow(ld, 30.0) * (0.4 + a) * 4.0;
      }
    }
  }
  if (uLightning.w > 0.0) sky += vec3(0.55, 0.6, 0.8) * uLightning.w * 0.35 * pow(max(dot(v, normalize(uLightning.xyz)), 0.0), 4.0);
  // aerial haze toward horizon matches fog
  sky = mix(sky, uFogColor, exp(-yh * 22.0) * 0.55 * (1.0 - smoothstep(-0.01, -0.2, y)) );
  gl_FragColor = vec4(sky, 1.0);
}
`;

export function buildSky(envPass = false) {
  const g = new THREE.SphereGeometry(20000, 64, 32);
  const m = new THREE.ShaderMaterial({
    uniforms: { ...U, ...skyUniforms },
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: GLSL_COMMON + SKY_FS,
    side: THREE.BackSide, depthWrite: false, depthTest: true,
    defines: envPass ? { ENV_PASS: 1 } : {},
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}
