import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { U, GLSL_COMMON, patch } from './materials.js';
import { skyUniforms } from './sky.js';
import { mulberry32, clamp, smoothstep, lerp } from './noise.js';

const WATER_COMMON = /* glsl */`
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uAmbient; uniform vec3 uSunGlow;
vec3 skyRefl(vec3 R){
  float y = max(R.y, 0.0);
  vec3 c = mix(uHorizon, uZenith, pow(y, 0.45));
  c += uSunGlow * pow(max(dot(R, uRealSun), 0.0), 10.0) * 0.6;
  return c * (1.0 - 0.45 * smoothstep(0.0, -0.25, R.y));
}
vec3 wnoised(vec2 x){
  vec2 i = floor(x), f = fract(x);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0)), c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * (vec2(k1, k2) + k4 * u.yx));
}
// slope of a wind/flow-driven ripple field: long swells, cross ripples and a fine capillary layer
vec2 rippleSlope(vec2 p, vec2 flow, float amp){
  vec2 g = vec2(0.0);
  vec3 n1 = wnoised(p * 0.55 - flow * 0.55); g += n1.yz * 0.55 * 0.55;
  vec3 n2 = wnoised(mat2(0.8, -0.6, 0.6, 0.8) * p * 1.35 - flow * 1.1 + 3.7); g += n2.yz * 1.35 * 0.26;
  vec3 n3 = wnoised(mat2(0.6, 0.8, -0.8, 0.6) * p * 3.4 - flow * 1.9 + 9.1); g += n3.yz * 3.4 * 0.07;
  return g * amp * 2.2;
}
// running water: ripples elongated along the current, rougher in the rapids
vec2 flowSlope(vec2 p, vec2 fl, float t, float amp, float turb){
  vec2 sd = vec2(-fl.y, fl.x);
  vec2 q = vec2(dot(p, fl), dot(p, sd));
  vec2 g = vec2(0.0);
  vec3 n1 = wnoised(vec2(q.x * 0.7 - t * 0.9, q.y * 1.9)); g += n1.yz * vec2(0.7, 1.9) * 0.5;
  vec3 n2 = wnoised(vec2(q.x * 1.9 - t * 1.8, q.y * 3.6) + 7.3); g += n2.yz * vec2(1.9, 3.6) * 0.22;
  vec3 n3 = wnoised(vec2(q.x * 5.0 - t * 3.2, q.y * 6.5) + 3.1); g += n3.yz * vec2(5.0, 6.5) * (0.05 + 0.1 * turb);
  return (fl * g.x + sd * g.y) * amp;
}
`;


const RIPPLE_ONLY = /* glsl */`
vec3 wnoised(vec2 x){
  vec2 i = floor(x), f = fract(x);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0)), c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * (vec2(k1, k2) + k4 * u.yx));
}
// slope of a wind/flow-driven ripple field: long swells, cross ripples and a fine capillary layer
vec2 rippleSlope(vec2 p, vec2 flow, float amp){
  vec2 g = vec2(0.0);
  vec3 n1 = wnoised(p * 0.55 - flow * 0.55); g += n1.yz * 0.55 * 0.55;
  vec3 n2 = wnoised(mat2(0.8, -0.6, 0.6, 0.8) * p * 1.35 - flow * 1.1 + 3.7); g += n2.yz * 1.35 * 0.26;
  vec3 n3 = wnoised(mat2(0.6, 0.8, -0.8, 0.6) * p * 3.4 - flow * 1.9 + 9.1); g += n3.yz * 3.4 * 0.07;
  return g * amp * 2.2;
}
// running water: ripples elongated along the current, rougher in the rapids
vec2 flowSlope(vec2 p, vec2 fl, float t, float amp, float turb){
  vec2 sd = vec2(-fl.y, fl.x);
  vec2 q = vec2(dot(p, fl), dot(p, sd));
  vec2 g = vec2(0.0);
  vec3 n1 = wnoised(vec2(q.x * 0.7 - t * 0.9, q.y * 1.9)); g += n1.yz * vec2(0.7, 1.9) * 0.5;
  vec3 n2 = wnoised(vec2(q.x * 1.9 - t * 1.8, q.y * 3.6) + 7.3); g += n2.yz * vec2(1.9, 3.6) * 0.22;
  vec3 n3 = wnoised(vec2(q.x * 5.0 - t * 3.2, q.y * 6.5) + 3.1); g += n3.yz * vec2(5.0, 6.5) * (0.05 + 0.1 * turb);
  return (fl * g.x + sd * g.y) * amp;
}
`;

// Physically based water: environment (sky + clouds) reflections, sharp sun glints and terrain/cloud
// shadowing come from the standard lighting model; the fragment hook supplies ripple normals,
// body tint, foam and alpha. Used for the stream, the plunge pool and the valley river.
function pbrWater(key, fColor, extra = {}) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.07, metalness: 0.0, transparent: true, depthWrite: false });
  m.envMapIntensity = 1.0;
  // premultiplied: the shader writes body scatter * opacity, reflections add on top, the bed shows through (1 - a)
  m.blending = THREE.CustomBlending; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
  patch(m, {
    key, shadowBias: 0.4, uniforms: { uZenith: skyUniforms.uZenith, uHorizon: skyUniforms.uHorizon, uSunGlow: skyUniforms.uSunGlow, ...(extra.uniforms || {}) },
    vHead: 'attribute vec2 aFlow; attribute float aTurb; attribute float aDepth; varying vec2 vFlow; varying float vTurb; varying float vDepthW; varying vec2 vUv2;',
    vBegin: 'vFlow = aFlow; vTurb = aTurb; vDepthW = aDepth; vUv2 = uv;',
    fHead: 'uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uSunGlow; varying vec2 vFlow; varying float vTurb; varying float vDepthW; varying vec2 vUv2; vec3 gWaterN = vec3(0.0, 1.0, 0.0); float gFoam = 0.0;\n' + RIPPLE_ONLY + (extra.fHead || ''),
    fColor,
    fRough: 'roughnessFactor = mix(0.12, 0.8, gFoam);',
    fNormal: 'normal = normalize((viewMatrix * vec4(gWaterN, 0.0)).xyz);',
  });
  return m;
}

// ------------------------------------------------------------------------------------------------
export function buildWater(W, scene, camera, renderer) {
  const out = { updaters: [] };
  const rng = mulberry32(12);
  const hf = W.hf;
  const common = { ...U, uZenith: skyUniforms.uZenith, uHorizon: skyUniforms.uHorizon, uAmbient: U.uAmbient, uSunGlow: skyUniforms.uSunGlow };
  const Fl = W.falls;

  // ================================================================= tarn: planar reflection, clear shallows
  {
    const T = W.tarn;
    const size = Math.max(T.rx, T.rz) * 2.6;
    const N = 64;
    const g = new THREE.PlaneGeometry(size, size, N, N);
    const obj = new THREE.Object3D();
    obj.position.set(T.x, T.L, T.z);
    obj.rotation.set(-Math.PI / 2, 0, 0, 'YXZ');
    obj.rotation.y = -T.rot;
    obj.updateMatrixWorld();
    const pa = g.attributes.position;
    const depth = new Float32Array(pa.count);
    const v = new THREE.Vector3();
    for (let i = 0; i < pa.count; i++) { v.fromBufferAttribute(pa, i).applyMatrix4(obj.matrixWorld); depth[i] = T.L - hf.height(v.x, v.z); }
    g.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
    const idx = g.index.array; const keep = [];
    for (let t = 0; t < idx.length; t += 3) { const a = idx[t], b = idx[t + 1], c = idx[t + 2]; if (depth[a] > -0.05 || depth[b] > -0.05 || depth[c] > -0.05) keep.push(a, b, c); }
    g.setIndex(keep);
    const shader = {
      name: 'TarnShader',
      uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null }, ...common },
      vertexShader: `
        uniform mat4 textureMatrix; attribute float aDepth; varying vec4 vUv; varying vec3 vW; varying float vDepth;
        void main(){ vUv = textureMatrix * vec4(position, 1.0); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vDepth = aDepth; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: GLSL_COMMON + WATER_COMMON + `
        uniform sampler2D tDiffuse; varying vec4 vUv; varying vec3 vW; varying float vDepth;
        void main(){
          if (vDepth < -0.02) discard;
          vec2 p = vW.xz;
          float g = windGust(p);
          float amp = 0.006 + 0.024 * uWind * (0.35 + g);
          vec2 sl = rippleSlope(p, uWindDir * uTime * (0.6 + g), amp);
          // cat's-paw gust patches roughen the surface
          float paws = smoothstep(0.55, 0.85, texture2D(uNoiseTex, p * 0.02 - uWindDir * uTime * 0.03).a);
          sl *= 1.0 + paws * 1.5 * uWind;
          if (uRain > 0.01) {
            vec2 cell = floor(p * 2.0); vec2 f = fract(p * 2.0) - 0.5;
            float h = hash12(cell); float t = fract(uTime * 1.3 + h);
            vec2 o = hash22(cell) - 0.5; vec2 dd = f - o * 0.6; float r = length(dd);
            sl += dd / (r + 1e-3) * sin(r * 60.0 - t * 12.0) * exp(-r * 8.0) * (1.0 - t) * 0.3 * uRain;
          }
          vec3 N = normalize(vec3(-sl.x, 1.0, -sl.y));
          vec3 V = normalize(cameraPosition - vW);
          vec4 uv = vUv; uv.xy += sl * 0.18 * uv.w;
          vec3 refl = texture2DProj(tDiffuse, uv).rgb;
          refl = mix(refl, skyRefl(reflect(-V, N)), 0.06);
          float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
          fres = max(fres, 0.06);
          // absorption: clear in the shallows, glacial teal in depth
          float dA = 1.0 - exp(-max(vDepth, 0.0) * 0.55);
          vec3 shallow = vec3(0.10, 0.22, 0.2);
          vec3 deep = vec3(0.012, 0.07, 0.09);
          vec3 body = mix(shallow, deep, dA) * (uAmbient * 1.4 + 0.14 * uKeyColor);
          float sh = cloudShadowAt(vW);
          float spec = pow(max(dot(reflect(-V, N), uSunDir), 0.0), 420.0) * 10.0 * sh;
          vec3 col = mix(body, refl, fres) + uKeyColor * spec;
          float alpha = clamp(mix(0.12 + dA * 0.78, 1.0, fres) + spec, 0.0, 1.0);
          alpha *= smoothstep(-0.02, 0.1, vDepth);
          col = applyFog(col, vW);
          gl_FragColor = vec4(col, alpha);
        }`,
    };
    const tarn = new Reflector(g, { textureWidth: 512, textureHeight: 512, clipBias: 0.02, shader, multisample: 0 });
    tarn.position.copy(obj.position); tarn.rotation.copy(obj.rotation);
    for (const k in common) tarn.material.uniforms[k] = common[k];
    tarn.material.transparent = true; tarn.material.depthWrite = false;
    tarn.renderOrder = 2;
    scene.add(tarn);
    tarn.getReflectionCamera(camera).layers.set(2);
    out.tarn = tarn;
  }

  // ================================================================= stream: clear running water with rapids
  {
    const S = W.stream;
    let s0 = 0; while (s0 < S.len && W.tarnEllipse(S.at(s0).x, S.at(s0).z) < 0.92) s0 += 0.5;
    const sEnd = S.len;
    const ACROSS = 9;
    const pos = [], uv = [], flow = [], turbA = [], depthA = [], idx = [];
    const stones = W.streamStones || [];
    const sgrid = new Map(); const sk = (x, z) => (Math.floor(x / 3) * 7349) ^ Math.floor(z / 3);
    for (const st of stones) { const k = sk(st.x, st.z); let a = sgrid.get(k); if (!a) sgrid.set(k, a = []); a.push(st); }
    const lipS = S.s[Fl.iLip] - 0.3, baseS = S.s[Fl.iBase] + 0.5;
    const P = Fl.pool;
    let rowsInStrip = 0;
    const emitStrip = () => { rowsInStrip = 0; };
    const addRow = (s) => {
      const a = S.at(s);
      const bed = a.v2;
      const ahead = S.at(Math.min(sEnd, s + 2.5)).v2; const slope = Math.max(0, (bed - ahead) / 2.5);
      const hw = 1.15 + 0.3 * Math.sin(s * 0.11) + 0.15 * Math.sin(s * 0.37 + 1.7);
      for (let j = 0; j < ACROSS; j++) {
        const u = j / (ACROSS - 1); const o = (u - 0.5) * 2 * hw;
        const x = a.x - a.tz * o, z = a.z + a.tx * o;
        const y = bed + 0.26 - Math.pow(Math.abs(u - 0.5) * 2, 2) * 0.05;
        pos.push(x, y, z); uv.push(u, s); flow.push(a.tx, a.tz);
        let turb = clamp((slope - 0.05) * 3.0, 0, 1);
        for (let ix = -1; ix <= 1; ix++) for (let iz = -1; iz <= 1; iz++) {
          const arr = sgrid.get(sk(x + ix * 3, z + iz * 3)); if (!arr) continue;
          for (const st of arr) { const d = Math.hypot(x - st.x, z - st.z); turb = Math.max(turb, (1 - smoothstep(st.r * 0.8, st.r + 0.9, d)) * (st.top > y - 0.1 ? 0.85 : 0.35)); }
        }
        turbA.push(turb);
        depthA.push(Math.max(0, y - hf.height(x, z)));
      }
      const r = pos.length / 3 / ACROSS - 1;
      if (rowsInStrip > 0) for (let j = 0; j < ACROSS - 1; j++) {
        const a0 = (r - 1) * ACROSS + j, b0 = a0 + 1, c0 = a0 + ACROSS, d0 = c0 + 1;
        idx.push(a0, b0, c0, b0, d0, c0);
      }
      rowsInStrip++;
    };
    for (let s = s0; s <= sEnd; s += 0.5) {
      const a = S.at(s);
      const inCliff = s > lipS && s < baseS;
      const inPool = Math.hypot(a.x - P.x, a.z - P.z) < P.r * 0.92;
      if (inCliff || inPool) { emitStrip(); continue; }
      addRow(s);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 2));
    g.setAttribute('aTurb', new THREE.Float32BufferAttribute(turbA, 1));
    g.setAttribute('aDepth', new THREE.Float32BufferAttribute(depthA, 1));
    g.setIndex(idx); g.computeVertexNormals();
    const m = pbrWater('streamw', `{
      float turb = clamp(vTurb, 0.0, 1.0);
      vec2 fl = normalize(vFlow + vec2(1e-4));
      float speed = 1.0 + turb * 2.6;
      vec2 sl = flowSlope(vWPos.xz, fl, uTime * speed, 0.012 + 0.04 * turb, turb);
      gWaterN = normalize(vec3(-sl.x, 1.0, -sl.y));
      float across = dot(vWPos.xz, vec2(-fl.y, fl.x)), along = dot(vWPos.xz, fl);
      float turbF = smoothstep(0.6, 0.95, turb);
      vec2 fuv = vec2(across * 1.6, along * 0.9 - uTime * speed * 0.7);
      float f1 = texture2D(uNoiseTex, fuv * 0.3).r, f2 = texture2D(uNoiseTex, fuv * 0.8 + 0.3).g;
      float foam = smoothstep(0.6, 0.85, f1 * 0.6 + f2 * 0.4 + turbF * 0.18) * turbF * 0.8;
      // fine bubbles carried on fast water
      float bub = smoothstep(0.8, 0.9, texture2D(uNoiseTex, vWPos.xz * 1.9 - fl * uTime * speed * 0.9).b) * smoothstep(0.35, 0.85, turb) * 0.45;
      foam = max(foam, bub);
      foam *= 1.0 - smoothstep(60.0, 200.0, length(cameraPosition - vWPos)) * 0.5;
      gFoam = foam;
      vec3 V = normalize(cameraPosition - vWPos);
      float F = 0.02 + 0.98 * pow(1.0 - max(dot(gWaterN, V), 0.0), 5.0);
      // clear glacial water: the bed shows through, a teal-green body builds up with depth
      float en = (texture2D(uNoiseTex, vec2(vUv2.y * 0.15, 0.37)).r - 0.5) * 0.3;
      float edge = smoothstep(0.0, 0.2, vUv2.x + en) * smoothstep(1.0, 0.8, vUv2.x - en);
      float body = (1.0 - exp(-max(vDepthW, 0.0) * 2.2)) * 0.5 + 0.05 + turbF * 0.12;
      float aW = body + (1.0 - body) * F;
      float a = mix(aW, 0.9, foam) * edge;
      vec3 bodyC = pow(vec3(0.1, 0.24, 0.22), vec3(2.2));
      diffuseColor.rgb = mix(bodyC * body, vec3(0.9, 0.93, 0.94), foam) * edge;
      diffuseColor.a = a;
    }`);
    const mesh = new THREE.Mesh(g, m); mesh.renderOrder = 3; mesh.frustumCulled = false;
    scene.add(mesh);
  }

  // ================================================================= plunge pool
  {
    const P = Fl.pool;
    const g = new THREE.PlaneGeometry(P.r * 2.8, P.r * 2.8, 56, 56); g.rotateX(-Math.PI / 2);
    const pa = g.attributes.position; const depth = new Float32Array(pa.count);
    for (let i = 0; i < pa.count; i++) depth[i] = P.level - hf.height(pa.getX(i) + P.x, pa.getZ(i) + P.z);
    g.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
    g.translate(P.x, P.level, P.z);
    const aFlowP = new Float32Array(pa.count * 2), aTurbP = new Float32Array(pa.count);
    g.setAttribute('aFlow', new THREE.BufferAttribute(aFlowP, 2)); g.setAttribute('aTurb', new THREE.BufferAttribute(aTurbP, 1));
    const m = pbrWater('poolw', `{
      if (vDepthW < -0.02) discard;
      vec2 d = vWPos.xz - uImpact; float r = length(d);
      vec2 sl = rippleSlope(vWPos.xz, d / (r + 1e-3) * uTime * 0.6, 0.03 + 0.05 * exp(-r * 0.3));
      sl += d / (r + 1e-3) * sin(r * 4.5 - uTime * 8.0) * 0.1 * exp(-r * 0.3);
      gWaterN = normalize(vec3(-sl.x, 1.0, -sl.y));
      float n = texture2D(uNoiseTex, vWPos.xz * 0.3 + vec2(0.0, -uTime * 0.18)).r;
      float foam = smoothstep(4.0, 0.4, r + n * 2.2) * smoothstep(0.35, 0.7, n + 0.25);
      gFoam = foam;
      vec3 V = normalize(cameraPosition - vWPos);
      float F = 0.02 + 0.98 * pow(1.0 - max(dot(gWaterN, V), 0.0), 5.0);
      float dA = 1.0 - exp(-max(vDepthW, 0.0) * 0.7);
      float body = 0.05 + dA * 0.62;
      float aW = body + (1.0 - body) * F;
      float edgeP = smoothstep(-0.02, 0.1, vDepthW);
      vec3 bodyC = mix(pow(vec3(0.16, 0.34, 0.3), vec3(2.2)), pow(vec3(0.07, 0.3, 0.31), vec3(2.2)), dA) * 1.6;
      diffuseColor.rgb = mix(bodyC * body, vec3(0.9, 0.93, 0.94), foam) * edgeP;
      diffuseColor.a = mix(aW, 1.0, foam) * edgeP;
    }`, { uniforms: { uImpact: { value: new THREE.Vector2(Fl.base.x, Fl.base.z) } }, fHead: 'uniform vec2 uImpact;\n' });
    const pool = new THREE.Mesh(g, m); pool.renderOrder = 3; scene.add(pool);
  }

  // ================================================================= waterfalls (big plunge + small tarn feeder)
  // falling water: glassy tongue at the lip, then aerated white jets that stretch as they accelerate
  // (patterns advect in time-of-flight, not distance), ragged edges, breaking into spray near the pool
  const fallMat = (bright, fallH, veil = 0) => new THREE.ShaderMaterial({
    uniforms: { ...common, uFallH: { value: fallH }, uVeil: { value: veil } }, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: GLSL_COMMON + WATER_COMMON + `
      uniform float uFallH; uniform float uVeil;
      varying vec2 vUv; varying vec3 vW;
      void main(){
        float t = vUv.y;
        float d = t * uFallH;
        float tau = sqrt(2.0 * (d + 0.3) / 9.8);
        float x = vUv.x + (texture2D(uNoiseTex, vec2(tau * 0.3 - uTime * 0.2, 0.37)).r - 0.5) * 0.08 * t;
        float j1 = texture2D(uNoiseTex, vec2(x * 2.2, tau * 0.55 - uTime * 0.5)).r;
        float j2 = texture2D(uNoiseTex, vec2(x * 6.5 + 0.31, tau * 1.3 - uTime * 1.25)).g;
        float j3 = texture2D(uNoiseTex, vec2(x * 16.0 + 0.71, tau * 3.2 - uTime * 3.0)).b;
        float j4 = texture2D(uNoiseTex, vec2(x * 38.0 + 0.13, tau * 7.0 - uTime * 6.5)).a;
        float n = j1 * 0.42 + j2 * 0.3 + j3 * 0.2 + j4 * 0.12;
        float breakup = smoothstep(0.05, 0.75, t);
        float dens = smoothstep(0.3 + 0.2 * breakup, 0.7 + 0.12 * breakup, n);
        float tongue = 1.0 - smoothstep(0.015, 0.1, t);
        float edgeN = (texture2D(uNoiseTex, vec2(tau * 0.8 - uTime * 0.6, 0.63)).r - 0.5) * (0.12 + 0.3 * t);
        float edge = smoothstep(0.0, 0.16 + 0.12 * t, vUv.x + edgeN) * smoothstep(1.0, 0.84 - 0.12 * t, vUv.x - edgeN);
        float sh = terrainShadowAt(vW, 1.0) * cloudShadowAt(vW);
        vec3 V = normalize(cameraPosition - vW);
        float back = pow(max(dot(-V, uSunDir), 0.0), 3.0);
        vec3 lit = uKeyColor * (0.34 + back * 0.55) * sh + uAmbient * 1.15;
        vec3 white = vec3(0.93, 0.96, 0.98) * lit;
        vec3 glass = pow(vec3(0.28, 0.42, 0.44), vec3(2.2)) * (uAmbient * 1.6 + uKeyColor * 0.2 * sh) + uHorizon * 0.18;
        float whiteness = mix(dens, 0.18 + 0.2 * j3, tongue);
        vec3 col = mix(glass, white, whiteness);
        col += uKeyColor * pow(max(j4 * 1.2 - 0.25, 0.0), 3.0) * 0.6 * sh * (1.0 - tongue);
        float a = edge * mix(0.22 + 0.72 * dens, 0.9, tongue);
        a *= 1.0 - smoothstep(0.86, 1.0, t) * 0.75;
        a *= smoothstep(0.0, 0.02, t);
        a *= ${bright.toFixed(2)};
        if (uVeil > 0.5) {
          a = edge * smoothstep(0.38, 0.8, n) * 0.3 * smoothstep(0.12, 0.45, t) * (1.0 - smoothstep(0.82, 1.0, t));
          col = white * 1.04;
        }
        gl_FragColor = vec4(applyFog(col, vW), a);
      }`,
  });
  const nrm = [0, 1, 0];
  // big waterfall: free-falling curtain in front of the cliff, two layers for depth
  {
    const lip = Fl.lip, P = Fl.pool;
    const dir = [Fl.dx, Fl.dz], perp = [Fl.px, Fl.pz];
    const H = Fl.height;
    for (const layer of [0, 1, 2]) {
      const ROWS = 48, COLS = 12;
      const pos = [], uv = [], idx = [];
      for (let i = 0; i <= ROWS; i++) {
        const t = i / ROWS;
        const y = lip.y - H * t;
        // stay in front of the rock face: search along the fall direction for the face at this height
        let face = -3;
        for (let u = -3; u < 14; u += 0.25) { const gx = lip.x + dir[0] * u, gz = lip.z + dir[1] * u; if (hf.height(gx, gz) < y - 0.2) { face = u; break; } }
        const throwU = Math.sqrt(t) * 1.6 + 0.3;
        const u0 = Math.max(face + 0.9 + (layer === 1 ? 0.45 : layer === 2 ? -0.2 : 0), throwU + (layer === 2 ? 0.35 : 0));
        const w = (2.2 + t * 2.6) * (layer === 1 ? 0.85 : layer === 2 ? 1.5 : 1);
        for (let j = 0; j <= COLS; j++) {
          const c = j / COLS; const o = (c - 0.5) * w + Math.sin(t * 6 + c * 3) * 0.08;
          pos.push(lip.x + dir[0] * u0 + perp[0] * o, y, lip.z + dir[1] * u0 + perp[1] * o);
          uv.push(c, t);
        }
        if (i < ROWS) for (let j = 0; j < COLS; j++) { const a = i * (COLS + 1) + j; idx.push(a, a + COLS + 1, a + 1, a + 1, a + COLS + 1, a + COLS + 2); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      const mesh = new THREE.Mesh(g, fallMat(layer === 1 ? 0.75 : 1.0, H, layer === 2 ? 1 : 0)); mesh.renderOrder = 4 + layer; mesh.frustumCulled = false; scene.add(mesh);
    }
    // lip overflow: the stream thickens and curls over the edge
    out.bigFall = { x: Fl.base.x, z: Fl.base.z, y: P.level };
  }
  // small feeder waterfall off the snowfield into the tarn
  {
    const T = W.tarn; const top = T.wfTop, bot = T.wfBot;
    const N = 40; const pos = [], uv = [], idx = [];
    const lat = [T.fwd[0], T.fwd[1]];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const x = top[0] + (bot[0] - top[0]) * t, z = top[1] + (bot[1] - top[1]) * t;
      hf.normal(x, z, 1.0, nrm);
      const y = hf.height(x, z) + 0.28;
      const w = 0.55 + 0.6 * t;
      for (let j = 0; j < 2; j++) { const o = (j - 0.5) * 2 * w; pos.push(x + lat[0] * o + nrm[0] * 0.2, y + nrm[1] * 0.2 - 0.1, z + lat[1] * o + nrm[2] * 0.2); uv.push(j, t); }
      if (i < N) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    const wf = new THREE.Mesh(g, fallMat(0.85, 7)); wf.renderOrder = 4; scene.add(wf);
  }

  // ================================================================= mist, spray & rainbows (billboard sprites)
  const mistSystem = (base, count, spread, rise, size, alpha, key) => {
    const mg = new THREE.InstancedBufferGeometry();
    const pl = new THREE.PlaneGeometry(1, 1);
    mg.index = pl.index; mg.setAttribute('position', pl.attributes.position); mg.setAttribute('uv', pl.attributes.uv);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i++) seeds[i] = rng();
    mg.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    mg.instanceCount = count;
    const u = { ...common, uBase: { value: base }, uSpread: { value: spread }, uRise: { value: rise }, uSize: { value: size }, uAlpha: { value: alpha } };
    const mm = new THREE.ShaderMaterial({
      uniforms: u, transparent: true, depthWrite: false,
      vertexShader: GLSL_COMMON + `uniform vec3 uBase; uniform float uSpread; uniform float uRise; uniform float uSize; uniform float uAlpha; attribute vec4 aSeed; varying vec2 vUv; varying float vA; varying vec3 vW;
        void main(){
          float t = fract(uTime * (0.05 + aSeed.w * 0.05) + aSeed.x);
          vec3 c = uBase + vec3((aSeed.y - 0.5) * uSpread, t * uRise, (aSeed.z - 0.5) * uSpread) + vec3(uWindDir.x, 0.0, uWindDir.y) * t * uSpread * 0.4 * (0.4 + uWind);
          float size = uSize * (0.5 + t * 1.2);
          vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 w = c + (camR * position.x + camU * position.y) * size;
          vUv = uv; vA = sin(t * 3.14159) * uAlpha; vW = w;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        }`,
      fragmentShader: GLSL_COMMON + WATER_COMMON + `varying vec2 vUv; varying float vA; varying vec3 vW;
        void main(){ float d = length(vUv - 0.5) * 2.0; float n = texture2D(uNoiseTex, vUv * 0.5 + vW.xz * 0.02).r;
          float a = smoothstep(1.0, 0.0, d) * vA * (0.6 + 0.6 * n);
          vec3 col = uAmbient * 1.15 + uKeyColor * 0.3;
          gl_FragColor = vec4(applyFog(col, vW), a); }`,
    });
    const mesh = new THREE.Mesh(mg, mm); mesh.frustumCulled = false; mesh.renderOrder = 6; scene.add(mesh);
    return { mesh, u };
  };
  const bigBase = new THREE.Vector3(Fl.base.x + Fl.dx * 0.8, Fl.pool.level + 0.3, Fl.base.z + Fl.dz * 0.8);
  mistSystem(bigBase, 70, 6.5, 6.5, 3.0, 0.055, 'bigmist');
  const T = W.tarn;
  const smallBase = new THREE.Vector3(T.wfBot[0] + T.left[0] * 0.8, T.L + 0.2, T.wfBot[1] + T.left[1] * 0.8);
  mistSystem(smallBase, 40, 2.2, 3.2, 1.6, 0.12, 'smallmist');
  // steam fog drifting over the tarn at dawn and dusk
  const tarnMist = mistSystem(new THREE.Vector3(T.x, T.L + 0.25, T.z), 46, Math.max(T.rx, T.rz) * 1.7, 1.6, 7.0, 0.0, 'tarnmist');
  out.updaters.push((dt, time, env) => {
    const h = env.hour;
    const dawn = smoothstep(4.6, 5.6, h) * (1 - smoothstep(7.4, 8.8, h));
    const dusk = smoothstep(18.6, 19.6, h) * (1 - smoothstep(21.0, 22.5, h));
    tarnMist.u.uAlpha.value = (dawn + dusk * 0.6) * 0.2 * (1 - smoothstep(0.7, 1.3, env.wind));
  });
  // rainbows in the spray: placed around the antisolar point, visible only at the right sun angle
  const rainbow = (base, size) => {
    const rm = new THREE.ShaderMaterial({
      uniforms: { ...common, uBase: { value: base }, uSize: { value: size } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `uniform vec3 uBase; uniform float uSize; varying vec3 vW; varying vec2 vUv;
        void main(){ vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]); vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 w = uBase + vec3(0.0, uSize * 0.3, 0.0) + (camR * position.x + camU * position.y) * uSize; vW = w; vUv = uv; gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0); }`,
      fragmentShader: GLSL_COMMON + `varying vec3 vW; varying vec2 vUv;
        void main(){
          vec3 V = normalize(vW - cameraPosition);
          float ang = degrees(acos(clamp(dot(V, -uRealSun), -1.0, 1.0)));
          float r = smoothstep(40.2, 40.9, ang) * smoothstep(42.6, 41.9, ang);
          float hue = clamp((ang - 40.4) / 2.1, 0.0, 1.0);
          vec3 c = clamp(abs(mod(hue * 6.0 * 0.8 + vec3(4.0, 2.0, 0.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
          float mask = smoothstep(1.0, 0.2, length(vUv - 0.5) * 2.0);
          float sunUp = smoothstep(0.03, 0.12, uRealSun.y) * smoothstep(0.75, 0.4, uRealSun.y) * (1.0 - uCloudCover * 0.8);
          gl_FragColor = vec4(c * r * mask * sunUp * 0.4 * uKeyColor, 1.0);
        }`,
    });
    const g = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(g, rm); mesh.frustumCulled = false; mesh.renderOrder = 7; scene.add(mesh);
  };
  rainbow(bigBase, 18);
  rainbow(smallBase, 8);

  // ================================================================= fish in the tarn (grayling / char)
  {
    const fishGeo = (() => {
      // lofted fish body along +z with tail fin and dorsal fin
      const secs = [[-0.18, 0.004, 0.006], [-0.14, 0.012, 0.022], [-0.08, 0.022, 0.038], [0.0, 0.028, 0.046], [0.08, 0.026, 0.042], [0.13, 0.018, 0.03], [0.16, 0.008, 0.016], [0.172, 0.002, 0.004]];
      const M = 10; const pos = [], col = [], idx = [];
      secs.forEach(([z, rx, ry], i) => {
        for (let j = 0; j <= M; j++) {
          const a = j / M * Math.PI * 2;
          const y = Math.sin(a) * ry, x = Math.cos(a) * rx;
          pos.push(x, y, z);
          const top = Math.sin(a) > 0.25, belly = Math.sin(a) < -0.35;
          const c = top ? [0.16, 0.2, 0.16] : belly ? [0.85, 0.83, 0.76] : [0.55, 0.58, 0.54];
          col.push(...c);
        }
      });
      for (let i = 0; i < secs.length - 1; i++) for (let j = 0; j < M; j++) { const a = i * (M + 1) + j; idx.push(a, a + M + 1, a + 1, a + 1, a + M + 1, a + M + 2); }
      // tail fin
      const b = pos.length / 3;
      pos.push(0, 0, -0.17, 0, 0.05, -0.24, 0, -0.05, -0.24, 0, 0, -0.215);
      for (let k = 0; k < 4; k++) col.push(0.3, 0.32, 0.28);
      idx.push(b, b + 1, b + 3, b, b + 3, b + 2);
      // dorsal fin (grayling sail)
      const c0 = pos.length / 3;
      pos.push(0, 0.026, 0.06, 0, 0.07, -0.02, 0, 0.022, -0.07);
      for (let k = 0; k < 3; k++) col.push(0.35, 0.28, 0.4);
      idx.push(c0, c0 + 1, c0 + 2);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx); g.computeVertexNormals();
      return g;
    })();
    const fm = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.35, metalness: 0.25, side: THREE.DoubleSide });
    patch(fm, { key: 'fish', noTerrainShadow: true,
      vBegin: `{ float ph = float(gl_InstanceID) * 2.1; float sw = smoothstep(0.1, -0.2, position.z); transformed.x += sin(uTime * 9.0 + ph - position.z * 18.0) * 0.035 * sw; }` });
    const NF = 8;
    const fish = new THREE.InstancedMesh(fishGeo, fm, NF);
    fish.frustumCulled = false; fish.layers.set(1);
    scene.add(fish);
    const Tn = W.tarn;
    const pick = () => { const a = rng() * Math.PI * 2, e = Math.sqrt(rng()) * 0.72; return [Tn.x + Tn.fwd[0] * Math.cos(a) * Tn.rx * e + Tn.left[0] * Math.sin(a) * Tn.rz * e, Tn.z + Tn.fwd[1] * Math.cos(a) * Tn.rx * e + Tn.left[1] * Math.sin(a) * Tn.rz * e]; };
    const fd = [];
    for (let i = 0; i < NF; i++) { const [x, z] = pick(); const tg = pick(); fd.push({ p: new THREE.Vector3(x, 0, z), yaw: rng() * 6.28, sp: 0.4, tgt: tg, t: rng() * 4, sc: 0.8 + rng() * 0.6, dart: 0 }); }
    const dm = new THREE.Object3D();
    out.updaters.push((dt, time, env, hiker) => {
      for (let i = 0; i < NF; i++) {
        const f = fd[i];
        f.t -= dt;
        if (f.t < 0) { f.tgt = pick(); f.t = 3 + rng() * 6; }
        // scatter when the hiker walks the shore
        const dh = hiker ? Math.hypot(hiker.pos.x - f.p.x, hiker.pos.z - f.p.z) : 99;
        if (dh < 7 && f.dart <= 0) { f.dart = 1.2; const ax = f.p.x - hiker.pos.x, az = f.p.z - hiker.pos.z; const l = Math.hypot(ax, az) || 1; f.tgt = [f.p.x + ax / l * 6, f.p.z + az / l * 6]; }
        f.dart = Math.max(0, f.dart - dt);
        const dx = f.tgt[0] - f.p.x, dz = f.tgt[1] - f.p.z;
        const want = Math.atan2(dx, dz); const df = Math.atan2(Math.sin(want - f.yaw), Math.cos(want - f.yaw));
        f.yaw += clamp(df, -dt * 2.2, dt * 2.2);
        const spd = f.dart > 0 ? 2.8 : 0.35 + 0.25 * Math.sin(time * 0.7 + i);
        let nx = f.p.x + Math.sin(f.yaw) * spd * dt, nz = f.p.z + Math.cos(f.yaw) * spd * dt;
        if (W.tarnEllipse(nx, nz) > 0.82) { f.tgt = pick(); nx = f.p.x; nz = f.p.z; }
        f.p.x = nx; f.p.z = nz;
        const bottom = hf.height(f.p.x, f.p.z);
        const depth = Tn.L - bottom;
        f.p.y = Tn.L - clamp(0.25 + depth * 0.45, 0.25, Math.max(0.25, depth - 0.12));
        dm.position.copy(f.p); dm.rotation.set(0, f.yaw, 0); dm.scale.setScalar(f.sc); dm.updateMatrix();
        fish.setMatrixAt(i, dm.matrix);
      }
      fish.instanceMatrix.needsUpdate = true;
    });
  }

  // ================================================================= braided river on the valley floor
  {
    const R = W.river;
    const rm = new THREE.ShaderMaterial({
      uniforms: common, transparent: true, depthWrite: false,
      vertexShader: `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: GLSL_COMMON + WATER_COMMON + `varying vec2 vUv; varying vec3 vW;
        void main(){
          vec2 sl = rippleSlope(vW.xz, vec2(0.0, uTime * 0.6), 0.02);
          vec3 N = normalize(vec3(-sl.x, 1.0, -sl.y));
          vec3 V = normalize(cameraPosition - vW);
          float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
          vec3 refl = skyRefl(reflect(-V, N));
          float cs = cloudShadowAt(vW);
          vec3 col = mix(vec3(0.03, 0.07, 0.07) * (uAmbient + uKeyColor * 0.1), refl * (0.6 + 0.4 * cs), fres);
          col += uKeyColor * pow(max(dot(reflect(-V, N), uSunDir), 0.0), 200.0) * 3.0 * cs;
          float edge = smoothstep(0.0, 0.2, vUv.x) * smoothstep(1.0, 0.8, vUv.x);
          gl_FragColor = vec4(applyFog(col, vW), edge * 0.92);
        }`,
    });
    for (const br of R.braids) {
      const pos = [], uv = [], idx = [];
      let rows = 0;
      for (let ds = -900; ds <= 1500; ds += 8) {
        const f = W.spine.at(W.sStart + ds);
        const rx = -f.tz, rz = f.tx;
        const o = R.o(ds) + br.off(ds);
        const cx = f.x + rx * o, cz = f.z + rz * o;
        const w = br.width * (0.8 + 0.25 * Math.sin(ds * 0.02 + br.width));
        for (let j = 0; j < 2; j++) { const oo = (j - 0.5) * w; pos.push(cx + rx * oo, W.riverLevel(cx, cz), cz + rz * oo); uv.push(j, ds); }
        if (rows > 0) { const a = (rows - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
        rows++;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      const mesh = new THREE.Mesh(g, rm); mesh.renderOrder = 1; scene.add(mesh);
    }
  }

  out.update = (dt, time, env, hiker) => { for (const f of out.updaters) f(dt, time, env, hiker); };
  return out;
}

// ------------------------------------------------------------------------------------------------
// The sky mirror: a wide salt flat under a film of perfectly still water past the house.
export function buildMirrorPlain(W, scene, camera) {
  const P = W.plain;
  const hf = W.hf;
  const common = { ...U, uZenith: skyUniforms.uZenith, uHorizon: skyUniforms.uHorizon, uAmbient: U.uAmbient, uSunGlow: skyUniforms.uSunGlow };
  const R = P.r + 10;
  // one radial sheet from the plain out to the horizon: fine rings near the shore, huge ones far away
  const g = new THREE.BufferGeometry();
  {
    const RINGS = 260, SEG = 256, RMAX = 9000;
    const pos = [0, 0, 0], idx = [];
    for (let i = 1; i <= RINGS; i++) {
      const r = RMAX * Math.pow(i / RINGS, 3.0);
      for (let j = 0; j < SEG; j++) { const a = j / SEG * Math.PI * 2; pos.push(Math.cos(a) * r, Math.sin(a) * r, 0); }
    }
    for (let j = 0; j < SEG; j++) idx.push(0, 1 + j, 1 + (j + 1) % SEG);
    for (let i = 1; i < RINGS; i++) for (let j = 0; j < SEG; j++) {
      const a = 1 + (i - 1) * SEG + j, b = 1 + (i - 1) * SEG + (j + 1) % SEG, c = a + SEG, d = b + SEG;
      idx.push(a, c, b, b, c, d);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3 * 2), 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
    g.setIndex(idx);
  }
  // local XY plane, reflector normal +Z -> rotate to face up
  const obj = new THREE.Object3D(); obj.position.set(P.x, P.h + 0.02, P.z); obj.rotation.set(-Math.PI / 2, 0, 0); obj.updateMatrixWorld();
  const pa = g.attributes.position; const depth = new Float32Array(pa.count); const v = new THREE.Vector3();
  for (let i = 0; i < pa.count; i++) { v.fromBufferAttribute(pa, i).applyMatrix4(obj.matrixWorld); depth[i] = (P.h + 0.02) - hf.height(v.x, v.z); }
  g.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
  const rings = []; for (let i = 0; i < 10; i++) rings.push(new THREE.Vector4(0, 0, -100, 0));
  const shader = {
    name: 'SkyMirror',
    uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null }, uRings: { value: rings }, ...common },
    vertexShader: `uniform mat4 textureMatrix; attribute float aDepth; varying vec4 vUv; varying vec3 vW; varying float vDepth;
      void main(){ vUv = textureMatrix * vec4(position, 1.0); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vDepth = aDepth; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: GLSL_COMMON + WATER_COMMON + `
      uniform sampler2D tDiffuse; uniform vec4 uRings[10]; varying vec4 vUv; varying vec3 vW; varying float vDepth;
      void main(){
        if (vDepth < -0.01) discard;
        vec2 p = vW.xz;
        vec2 sl = rippleSlope(p, uWindDir * uTime * 0.25, 0.0012 + 0.0035 * uWind);
        for (int i = 0; i < 10; i++) {
          vec4 Rg = uRings[i]; float age = uTime - Rg.z;
          if (age > 0.0 && age < 4.5) {
            vec2 d = p - Rg.xy; float r = length(d); float front = age * 0.85;
            float w = sin((r - front) * 26.0) * exp(-abs(r - front) * 4.5) * exp(-age * 0.8) * Rg.w;
            sl += d / (r + 1e-3) * w * 0.07;
          }
        }
        if (uRain > 0.01) {
          vec2 cell = floor(p * 2.5); vec2 f = fract(p * 2.5) - 0.5;
          float h = hash12(cell); float t = fract(uTime * 1.1 + h); vec2 o = hash22(cell) - 0.5; vec2 dd = f - o * 0.6; float r = length(dd);
          sl += dd / (r + 1e-3) * sin(r * 60.0 - t * 12.0) * exp(-r * 8.0) * (1.0 - t) * 0.25 * uRain;
        }
        vec3 N = normalize(vec3(-sl.x, 1.0, -sl.y));
        vec3 V = normalize(cameraPosition - vW);
        vec4 uv = vUv; uv.xy += sl * 0.5 * uv.w;
        vec3 refl = texture2DProj(tDiffuse, uv).rgb;
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        // wet white salt under a film of water: the reflection dominates at every angle
        float sh = terrainShadowAt(vW, 0.5) * cloudShadowAt(vW);
        vec3 salt = vec3(0.86, 0.87, 0.86) * (uAmbient * 0.9 + uKeyColor * 0.22 * sh);
        float mirror = mix(0.9, 1.0, fres);
        vec3 col = mix(salt, refl, mirror);
        col += uKeyColor * pow(max(dot(reflect(-V, N), uSunDir), 0.0), 900.0) * 3.0 * sh * (1.0 - uNight);
        float edge = smoothstep(0.0, 0.03, vDepth);
        gl_FragColor = vec4(applyFog(col, vW), edge);
      }`,
  };
  const mirror = new Reflector(g, { textureWidth: 1024, textureHeight: 1024, clipBias: 0.01, shader, multisample: 0 });
  mirror.position.copy(obj.position); mirror.rotation.copy(obj.rotation);
  for (const k in common) mirror.material.uniforms[k] = common[k];
  mirror.material.transparent = true; mirror.material.depthWrite = false;
  mirror.renderOrder = 2;
  scene.add(mirror);
  mirror.getReflectionCamera(camera).layers.set(2);
  let ri = 0;
  return {
    mirror,
    step(p, strength = 1) {
      if (Math.hypot(p.x - P.x, p.z - P.z) > R) return;
      const r = rings[ri++ % rings.length]; r.set(p.x, p.z, U.uTime.value, strength);
    },
  };
}
