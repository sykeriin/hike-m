import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { U, patch } from './materials.js';
import { mulberry32 } from './noise.js';

// ------------------------------------------------------------------------------------------------
// Top-down capture of the terrain around the camera: relative height, grass density, trail distance,
// scree. Boulders and landmark stones are drawn on top as "no grass" occluders so nothing grows through them.
export class TerrainCapture {
  constructor(renderer, terrainMesh, occluders) {
    this.renderer = renderer;
    this.size = 170; this.res = 768;
    this.rt = new THREE.WebGLRenderTarget(this.res, this.res, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, depthBuffer: true, generateMipmaps: false,
    });
    this.uniforms = { uCapTex: { value: this.rt.texture }, uCapRect: { value: new THREE.Vector4(0, 0, this.size, 0) } };
    const baseU = { uBaseY: { value: 0 }, uTrailTex: U.uTrailTex, uTrailRect: U.uTrailRect };
    this.baseU = baseU;
    this.scene = new THREE.Scene();
    const terrMat = new THREE.ShaderMaterial({
      uniforms: baseU,
      vertexShader: `attribute vec4 aMask; attribute vec4 aExtra; varying vec4 vM; varying vec2 vXZ; varying float vY;
        void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vY = wp.y; vM = aMask; vXZ = wp.xz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `uniform float uBaseY; uniform sampler2D uTrailTex; uniform vec4 uTrailRect; varying vec4 vM; varying vec2 vXZ; varying float vY;
        float trailDist(vec2 xz){ vec2 uv = (xz - uTrailRect.xy) / uTrailRect.zw; if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 9.0; float v = texture2D(uTrailTex, uv).r * 255.0 / 60.0; return v > 4.2 ? 9.0 : v; }
        void main(){ gl_FragColor = vec4(vY - uBaseY, vM.r * (1.0 - vM.b), trailDist(vXZ), vM.g + vM.a); }`,
    });
    const occMat = new THREE.ShaderMaterial({
      uniforms: baseU,
      vertexShader: `varying float vY; void main(){ vec4 p = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
        #endif
        vec4 wp = modelMatrix * p; vY = wp.y; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `uniform float uBaseY; varying float vY; void main(){ gl_FragColor = vec4(vY - uBaseY, 0.0, 0.0, 1.0); }`,
    });
    const tp = new THREE.Mesh(terrainMesh.geometry, terrMat); tp.frustumCulled = false; this.scene.add(tp);
    for (const o of occluders) {
      let p;
      if (o.isInstancedMesh) { p = new THREE.InstancedMesh(o.geometry, occMat, o.count); p.instanceMatrix = o.instanceMatrix; }
      else { p = new THREE.Mesh(o.geometry, occMat); o.updateMatrixWorld(); p.matrixAutoUpdate = false; p.matrix.copy(o.matrixWorld); }
      p.frustumCulled = false;
      this.scene.add(p);
    }
    this.cam = new THREE.OrthographicCamera(-this.size / 2, this.size / 2, this.size / 2, -this.size / 2, 1, 6000);
    this.cam.up.set(0, 0, -1);
    this.last = new THREE.Vector2(1e9, 1e9);
  }
  update(center, heightAt, force = false) {
    const texel = this.size / this.res;
    const cx = Math.round(center.x / (texel * 4)) * texel * 4, cz = Math.round(center.z / (texel * 4)) * texel * 4;
    if (!force && Math.hypot(cx - this.last.x, cz - this.last.y) < this.size * 0.12) return false;
    this.last.set(cx, cz);
    const base = heightAt(cx, cz);
    this.baseU.uBaseY.value = base;
    this.cam.position.set(cx, base + 2500, cz); this.cam.lookAt(cx, base, cz); this.cam.updateMatrixWorld();
    const r = this.renderer; const prev = r.getRenderTarget(); const pc = r.getClearColor(new THREE.Color()); const pa = r.getClearAlpha();
    r.setRenderTarget(this.rt); r.setClearColor(0x000000, 0); r.clear(); r.render(this.scene, this.cam);
    r.setRenderTarget(prev); r.setClearColor(pc, pa);
    this.uniforms.uCapRect.value.set(cx, cz, this.size, base);
    return true;
  }
}

// ------------------------------------------------------------------------------------------------
function tuftGeometry(blades, seed, hMin, hMax, wBase) {
  const rng = mulberry32(seed);
  const geos = [];
  for (let b = 0; b < blades; b++) {
    const h = hMin + rng() * (hMax - hMin), w = wBase * (0.7 + rng() * 0.6);
    const ang = rng() * Math.PI * 2, lean = 0.12 + rng() * 0.5, rad = Math.sqrt(rng()) * 0.07;
    const segs = 3;
    const pos = [], uv = [], nrm = [], idx = [];
    const bx = Math.cos(ang) * rad, bz = Math.sin(ang) * rad;
    const dx = Math.cos(ang + (rng() - 0.5) * 1.2), dz = Math.sin(ang + (rng() - 0.5) * 1.2);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs, ww = w * (1 - t * 0.95), y = h * t, off = lean * h * t * t;
      const cx = bx + dx * off, cz = bz + dz * off, px = -dz * ww, pz = dx * ww;
      pos.push(cx - px, y, cz - pz, cx + px, y, cz + pz);
      uv.push(0, t, 1, t);
      nrm.push(0, 1, 0, 0, 1, 0);
      if (i < segs) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); geos.push(g);
  }
  return mergeGeometries(geos);
}

// Wildflower atlas, 4x3 cells of 128 px:
// 0 alpine aster, 1 edelweiss, 2 potentilla, 3 gentian, 4 dianthus, 5 arctic poppy, 6 anemone,
// 7 purple pea spike, 8 leaves, 9 stem green, 10 yellow spike, 11 allium globe.
function flowerAtlas() {
  const C = 128, c = document.createElement('canvas'); c.width = C * 4; c.height = C * 3; const g = c.getContext('2d');
  const r = mulberry32(99);
  const cell = (i, fn) => { g.save(); g.translate((i % 4) * C, Math.floor(i / 4) * C); g.beginPath(); g.rect(0, 0, C, C); g.clip(); fn(); g.restore(); };
  const petals = (n, len, wid, col, col2, round, jit = 0.1) => {
    for (let k = 0; k < n; k++) {
      const a = k / n * Math.PI * 2 + (r() - 0.5) * jit, l = len * (0.9 + r() * 0.12);
      g.save(); g.translate(64, 64); g.rotate(a);
      const gr = g.createLinearGradient(0, 0, l, 0); gr.addColorStop(0, col2); gr.addColorStop(1, col);
      g.fillStyle = gr; g.beginPath(); g.moveTo(3, 0);
      if (round) { g.bezierCurveTo(l * 0.3, -wid, l * 1.06, -wid * 1.05, l, 0); g.bezierCurveTo(l * 1.06, wid * 1.05, l * 0.3, wid, 3, 0); }
      else { g.quadraticCurveTo(l * 0.55, -wid, l, 0); g.quadraticCurveTo(l * 0.55, wid, 3, 0); }
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 1; g.beginPath(); g.moveTo(6, 0); g.lineTo(l * 0.8, 0); g.stroke();
      g.restore();
    }
  };
  const disc = (rad, col, col2) => {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, rad); gr.addColorStop(0, col2); gr.addColorStop(1, col);
    g.fillStyle = gr; g.beginPath(); g.arc(64, 64, rad, 0, Math.PI * 2); g.fill();
    for (let k = 0; k < rad * 4; k++) { const a = r() * 6.28, d = Math.sqrt(r()) * rad; g.fillStyle = `rgba(110,60,0,${0.3 * r()})`; g.fillRect(64 + Math.cos(a) * d - 1, 64 + Math.sin(a) * d - 1, 2, 2); }
  };
  const stemLine = (y0) => { g.strokeStyle = '#4d6b2b'; g.lineWidth = 5; g.beginPath(); g.moveTo(64, 128); g.lineTo(64, y0); g.stroke(); };
  const spike = (col, col2) => {
    stemLine(8);
    for (let k = 0; k < 30; k++) {
      const t = k / 29, y = 84 - t * 76, sz = 11 - t * 6, side = k % 2 ? 1 : -1;
      g.fillStyle = r() < 0.5 ? col : col2; g.beginPath(); g.ellipse(64 + side * sz * 0.75, y, sz, sz * 0.66, side * 0.6, 0, 6.28); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.25)'; g.beginPath(); g.ellipse(64 + side * sz * 0.9, y - 1, sz * 0.35, sz * 0.25, 0, 0, 6.28); g.fill();
    }
  };
  cell(0, () => { petals(24, 58, 5.5, '#b39af0', '#7c5ccc', false, 0.15); disc(15, '#e3a615', '#ffd84a'); });
  cell(1, () => { petals(9, 56, 12, '#f4f2e8', '#cfcdbd', false, 0.35); petals(8, 36, 9, '#fbfaf3', '#e1dfcf', false, 0.35); disc(13, '#cfc27a', '#ece2a8'); });
  cell(2, () => { petals(5, 57, 27, '#ffd81f', '#f2ae00', true, 0.05); disc(10, '#e08a00', '#f5c400'); });
  cell(3, () => { petals(5, 60, 21, '#3558e0', '#16288a', false, 0.05); disc(9, '#c9d4ff', '#ffffff'); });
  cell(4, () => {
    petals(5, 56, 25, '#f062b0', '#bd2c7c', true, 0.05);
    g.strokeStyle = '#fff0f6'; g.lineWidth = 1.5;
    for (let k = 0; k < 60; k++) { const a = r() * 6.28, d = 48 + r() * 8; g.beginPath(); g.moveTo(64 + Math.cos(a) * (d - 6), 64 + Math.sin(a) * (d - 6)); g.lineTo(64 + Math.cos(a) * d, 64 + Math.sin(a) * d); g.stroke(); }
    disc(7, '#7a1446', '#a8275f');
  });
  cell(5, () => { petals(4, 61, 38, '#ffa11f', '#ef6a00', true, 0.05); disc(10, '#6b8a2a', '#b9d05a'); });
  cell(6, () => { petals(6, 55, 25, '#fdfdf8', '#e3e6dc', true, 0.08); disc(12, '#eab818', '#ffe070'); });
  cell(7, () => spike('#9150d0', '#bb8cec'));
  cell(8, () => {
    for (let k = 0; k < 3; k++) {
      const a = -Math.PI / 2 + (k - 1) * 0.45; g.save(); g.translate(64, 128); g.rotate(a);
      const gr = g.createLinearGradient(0, 0, 120, 0); gr.addColorStop(0, '#3d5a22'); gr.addColorStop(1, '#6f8f3a');
      g.fillStyle = gr; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(60, -16, 122, 0); g.quadraticCurveTo(60, 16, 0, 0); g.fill();
      g.strokeStyle = 'rgba(220,240,180,0.35)'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(4, 0); g.lineTo(110, 0); g.stroke(); g.restore();
    }
  });
  cell(9, () => { g.fillStyle = '#4d6b2b'; g.fillRect(0, 0, C, C); });
  cell(10, () => spike('#f4cf2c', '#ffe985'));
  cell(11, () => {
    stemLine(50);
    for (let k = 0; k < 170; k++) {
      const a = r() * 6.28, d = Math.pow(r(), 0.6) * 31;
      g.fillStyle = r() < 0.5 ? '#b67ee0' : '#8646c4'; g.beginPath(); g.arc(64 + Math.cos(a) * d, 40 + Math.sin(a) * d, 3 + r() * 2.5, 0, 6.28); g.fill();
    }
  });
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// A clump of flowers. aAt = (atlas u, atlas v, cell) where cell -1 = head species, -2 = spike species (picked per instance).
// uv.y is the bend weight used by the field wind.
function flowerClumpGeometry(seed, spikes) {
  const rng = mulberry32(seed);
  const pos = [], uv = [], at = [], nrm = [], idx = [];
  const quad = (c, ax, ay, cellI, h0, h1) => {
    const b = pos.length / 3;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push(c[0] + ax[0] * sx + ay[0] * sy, c[1] + ax[1] * sx + ay[1] * sy, c[2] + ax[2] * sx + ay[2] * sy);
      uv.push(0, sy < 0 ? h0 : h1); at.push(0.02 + 0.96 * (sx + 1) / 2, 0.02 + 0.96 * (sy + 1) / 2, cellI); nrm.push(0, 1, 0);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  const maxH = spikes ? 0.42 : 0.3;
  const nH = spikes ? 3 : 4 + Math.floor(rng() * 2);
  for (let k = 0; k < nH; k++) {
    const a = rng() * 6.28, rr = Math.sqrt(rng()) * 0.13;
    const bx = Math.cos(a) * rr, bz = Math.sin(a) * rr;
    const h = spikes ? 0.24 + rng() * 0.18 : 0.1 + rng() * 0.2;
    const lx = bx + (rng() - 0.5) * 0.05, lz = bz + (rng() - 0.5) * 0.05;
    if (spikes) {
      const w = 0.045 + rng() * 0.02, ya = rng() * Math.PI;
      for (const d of [0, Math.PI / 2]) {
        const ax = [Math.cos(ya + d) * w, 0, Math.sin(ya + d) * w];
        quad([bx, h / 2, bz], ax, [0, h / 2, 0], -2, 0, h / maxH);
      }
    } else {
      // stem
      const sw = 0.0035, sa = rng() * Math.PI;
      quad([(bx + lx) / 2, h / 2, (bz + lz) / 2], [Math.cos(sa) * sw, 0, Math.sin(sa) * sw], [(lx - bx) / 2, h / 2, (lz - bz) / 2], 9, 0, h / maxH);
      // head: tilted disc
      const s = 0.026 + rng() * 0.014, tilt = 0.25 + rng() * 0.45, az = rng() * 6.28;
      const n = [Math.sin(tilt) * Math.cos(az), Math.cos(tilt), Math.sin(tilt) * Math.sin(az)];
      const u = [Math.cos(tilt) * Math.cos(az), -Math.sin(tilt), Math.cos(tilt) * Math.sin(az)];
      const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
      quad([lx, h + 0.004, lz], [u[0] * s, u[1] * s, u[2] * s], [v[0] * s, v[1] * s, v[2] * s], -1, h / maxH, h / maxH);
    }
  }
  // basal leaves
  for (let k = 0; k < 3; k++) {
    const a = k / 3 * 6.28 + rng(), L = 0.07 + rng() * 0.04, w = L * 0.5;
    const dir = [Math.cos(a), Math.sin(a)];
    const up = 0.55;
    quad([dir[0] * L * 0.5, L * up * 0.5, dir[1] * L * 0.5], [-dir[1] * w, 0, dir[0] * w], [dir[0] * L * 0.5, L * up * 0.5, dir[1] * L * 0.5], 8, 0, 0.12);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aAt', new THREE.Float32BufferAttribute(at, 3));
  g.setIndex(idx);
  return g;
}

const FLOWER_V = (seed) => /* glsl */`
  {
    vec2 fq = xz + (vec2(texture2D(uNoiseTex, xz * 0.011).r, texture2D(uNoiseTex, xz * 0.011 + 0.37).g) - 0.5) * 22.0;
    float sp = hash12(floor(fq / 7.0) + ${seed.toFixed(1)});
    if (r2 < 0.22) sp = fract(r1 * 7.13);
    float ci = aAt.z;
    if (ci < -1.5) ci = sp < 0.45 ? 7.0 : sp < 0.72 ? 10.0 : 11.0;
    else if (ci < -0.5) ci = floor(sp * 6.999);
    vec2 co = vec2(mod(ci, 4.0), floor(ci / 4.0 + 0.01));
    vMapUv = vec2((co.x + aAt.x) / 4.0, 1.0 - (co.y + 1.0 - aAt.y) / 3.0);
  }
`;

const FIELD_V = (o) => /* glsl */`
  {
    float id = float(gl_InstanceID);
    float gi = mod(id, uN), gj = floor(id / uN);
    vec2 cellIdx = floor(uCenter / uCell) + vec2(gi, gj) - floor(uN * 0.5);
    vec2 h2 = hash22(cellIdx * 1.13 + ${o.seed.toFixed(1)});
    vec2 xz = (cellIdx + h2) * uCell;
    vec2 cuv = vec2((xz.x - uCapRect.x) / uCapRect.z + 0.5, (uCapRect.y - xz.y) / uCapRect.z + 0.5);
    vec4 cap = texture2D(uCapTex, cuv);
    vec2 ce = min(cuv, 1.0 - cuv);
    float inCap = step(0.004, min(ce.x, ce.y));
    float d = length(xz - cameraPosition.xz);
    float patchN = texture2D(uNoiseTex, xz * ${o.patchFreq.toFixed(4)} + ${o.seed.toFixed(1)}).r;
    float dens = ${o.density};
    float lod = smoothstep(uLod.x, uLod.x + 4.0, d) * (1.0 - smoothstep(uLod.y - 8.0, uLod.y, d));
    float keep = inCap * step(hash12(cellIdx * 2.31 + ${(o.seed * 3.1).toFixed(1)}), dens) * step(0.001, lod);
    float r1 = hash12(cellIdx + 7.7), r2 = hash12(cellIdx + 19.3);
    float sc = keep * ${o.scale} * smoothstep(0.0, 1.0, lod);
    float ang = r1 * 6.2831;
    float ca = cos(ang), sa = sin(ang);
    vec3 p = position * sc;
    p = vec3(p.x * ca - p.z * sa, p.y, p.x * sa + p.z * ca);
    // wind
    float g = windGust(xz);
    float str = uWind * (0.35 + 1.1 * g);
    float hN = uv.y;
    float flut = sin(uTime * 6.1 + xz.x * 1.9 + xz.y * 1.3) * 0.22 + sin(uTime * 10.3 + r2 * 20.0) * 0.08;
    vec2 bend = uWindDir * (str + flut * (0.35 + str * 0.5)) * hN * hN * ${o.bend.toFixed(2)} * sc;
    p.xz += bend; p.y -= length(bend) * 0.4;
    // pushed aside by the hiker's legs
    {
      vec2 dp = xz - uPush.xy; float dl = length(dp);
      float pw = (1.0 - smoothstep(uPush.z * 0.3, uPush.z, dl)) * hN * uPush.w;
      p.xz += dp / max(dl, 1e-3) * pw * 0.26 * max(sc, 0.4); p.y -= pw * 0.12 * sc;
    }
    transformed = vec3(xz.x, cap.r + uCapRect.w - 0.04, xz.y) + p;
    vTSh = 1.0;
    if (keep < 0.5) transformed = vec3(0.0, -10000.0, 0.0);
    else { vec3 wq = vec3(xz.x, transformed.y, xz.y); vTSh = terrainShadowAt(wq, 1.5) * cloudShadowAt(wq); }
    vH = hN; vR = vec2(r1, r2); vPatch = patchN; vCapG = cap.g;
${o.vExtra || ''}
  }
`;

export function buildField(renderer, capture, scene) {
  const out = { meshes: [] };
  const uPush = { value: new THREE.Vector4(0, 0, 0.8, 0) };
  const common = (extra) => ({ ...capture.uniforms, uPush, uCenter: { value: new THREE.Vector2() }, uN: { value: 0 }, uCell: { value: 0 }, uLod: { value: new THREE.Vector2(0, 50) }, ...extra });
  const mk = (geo, N, cell, lod, o, colorCode, key, matOpts = {}) => {
    const g = new THREE.InstancedBufferGeometry();
    g.index = geo.index; for (const k in geo.attributes) g.setAttribute(k, geo.attributes[k]);
    g.instanceCount = N * N;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const uni = common();
    uni.uN.value = N; uni.uCell.value = cell; uni.uLod.value.set(lod[0], lod[1]);
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.78, side: THREE.DoubleSide, ...matOpts });
    patch(m, {
      key, vertexShadow: 'custom', uniforms: uni,
      vHead: 'uniform sampler2D uCapTex; uniform vec4 uCapRect; uniform vec4 uPush; uniform vec2 uCenter; uniform float uN; uniform float uCell; uniform vec2 uLod; varying float vH; varying vec2 vR; varying float vPatch; varying float vCapG;' + (o.vHead || ''),
      vBegin: FIELD_V(o),
      fHead: 'varying float vH; varying vec2 vR; varying float vPatch; varying float vCapG;',
      fNormal: 'normal = normalize(mix(normalize(vNormal), normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), 0.75));',
      fColor: colorCode,
      fLight: `{
        vec3 V = normalize(cameraPosition - vWPos);
        float bl = pow(max(dot(-V, uSunDir), 0.0), 3.0);
        reflectedLight.directDiffuse += diffuseColor.rgb * uKeyColor * bl * 0.45 * vTSh * vH * uKeyVis;
        reflectedLight.indirectDiffuse *= 0.5 + 0.5 * vH;
      }`,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false;
    mesh.layers.set(1);
    mesh.userData.uni = uni; mesh.userData.cell = cell; mesh.userData.N = N; mesh.userData.ahead = o.ahead;
    scene.add(mesh); out.meshes.push(mesh);
    return mesh;
  };
  const GRASS_COL = `{
    float h = vH;
    // late-summer steppe palette matched to the terrain meadow tint
    vec3 cA = pow(vec3(0.44, 0.47, 0.24), vec3(2.2));
    vec3 cB = pow(vec3(0.7, 0.62, 0.38), vec3(2.2));
    vec3 cC = pow(vec3(0.5, 0.54, 0.36), vec3(2.2));
    vec3 cD = pow(vec3(0.64, 0.46, 0.3), vec3(2.2));
    vec3 base = mix(cA, cB, smoothstep(0.35, 0.75, vPatch));
    base = mix(base, cC, step(0.72, vR.x) * 0.7);
    base = mix(base, cD, step(0.93, vR.y) * 0.8);
    base *= 0.85 + 0.3 * vR.y;
    vec3 root = base * 0.55;
    vec3 tip = mix(base * 1.1, pow(vec3(0.85, 0.77, 0.5), vec3(2.2)), 0.35 * smoothstep(0.5, 1.0, vPatch + vR.x * 0.3));
    diffuseColor.rgb = mix(root, tip, smoothstep(0.0, 1.0, h));
  }`;
  // dense near tufts, sparser far tufts
  const tuft = tuftGeometry(6, 11, 0.1, 0.3, 0.02);
  const tuftBig = tuftGeometry(5, 23, 0.14, 0.42, 0.034);
  mk(tuft, 220, 0.2, [-10, 26], { seed: 1, patchFreq: 0.013, density: 'cap.g * smoothstep(0.42, 0.75, cap.b) * (1.0 - cap.a * 0.8) * (0.55 + 0.6 * patchN)', scale: '(0.6 + 0.7 * r2) * (0.6 + 0.55 * cap.g)', bend: 0.9, ahead: 9 }, GRASS_COL, 'fgrass');
  mk(tuftBig, 196, 0.5, [18, 84], { seed: 2, patchFreq: 0.013, density: 'cap.g * smoothstep(0.42, 0.75, cap.b) * (1.0 - cap.a * 0.8) * (0.6 + 0.5 * patchN)', scale: '(0.85 + 0.85 * r2) * (0.7 + 0.5 * cap.g) * (1.0 + smoothstep(40.0, 84.0, d) * 0.6)', bend: 0.9, ahead: 38 }, GRASS_COL, 'fgrass2');
  // wildflower patches: edelweiss-white, gentian-blue, yellow potentilla, purple aster
  // wildflowers: clumps in drifts of one species, near ring + a coarser ring so meadows keep their colour further out
  const atlas = flowerAtlas();
  const FLOWER_COL = 'diffuseColor.rgb *= 0.86 + 0.28 * vR.y;';
  const fm = { map: atlas, alphaTest: 0.5, roughness: 0.62 };
  const heads = flowerClumpGeometry(31, false), spikes = flowerClumpGeometry(47, true);
  const fdens = (k) => 'cap.g * smoothstep(0.55, 1.1, cap.b) * (1.0 - cap.a) * (smoothstep(0.36, 0.6, patchN) * ' + k + ' + 0.05)';
  const fvx = (seed) => ({ vHead: ' attribute vec3 aAt;', vExtra: FLOWER_V(seed) });
  mk(heads, 104, 0.3, [-10, 30], { seed: 3, patchFreq: 0.017, density: fdens('0.95'), scale: '(0.85 + 0.45 * r2)', bend: 0.45, ahead: 11, ...fvx(3) }, FLOWER_COL, 'fflower', fm);
  mk(heads, 112, 0.62, [24, 70], { seed: 5, patchFreq: 0.017, density: fdens('0.9'), scale: '(1.3 + 0.6 * r2)', bend: 0.45, ahead: 30, ...fvx(5) }, FLOWER_COL, 'fflower2', fm);
  mk(spikes, 84, 0.46, [-10, 36], { seed: 7, patchFreq: 0.021, density: 'cap.g * smoothstep(0.7, 1.3, cap.b) * (1.0 - cap.a) * smoothstep(0.5, 0.68, patchN) * 0.8', scale: '(0.8 + 0.5 * r2)', bend: 0.6, ahead: 14, ...fvx(7) }, FLOWER_COL, 'fspike', fm);

  const fwd = new THREE.Vector3();
  out.update = (camera, hiker) => {
    if (hiker) uPush.value.set(hiker.pos.x, hiker.pos.z, 0.85, Math.min(1, 0.25 + (hiker.actualSpeed || 0)));
    camera.getWorldDirection(fwd); fwd.y = 0; if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); fwd.normalize();
    for (const m of out.meshes) {
      const c = m.userData.uni.uCenter.value;
      c.set(camera.position.x + fwd.x * m.userData.ahead, camera.position.z + fwd.z * m.userData.ahead);
    }
  };
  return out;
}
