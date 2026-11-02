import * as THREE from 'three';
import { patch } from './materials.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { simplex2, mulberry32, clamp, smoothstep } from './noise.js';

function n3(x, y, z) { return (simplex2(x + z * 1.37, y - z * 0.71) + simplex2(y * 1.13 - x * 0.3, z + x * 0.57)) * 0.5; }

export function rockGeometry(seed, detail = 3, o = {}) {
  let g0 = new THREE.IcosahedronGeometry(1, detail);
  g0.deleteAttribute('normal'); g0.deleteAttribute('uv');
  const g = mergeVertices(g0);
  const r = mulberry32(seed);
  const sx = o.sx ?? (0.8 + r() * 0.5), sy = o.sy ?? (0.55 + r() * 0.35), sz = o.sz ?? (0.8 + r() * 0.5);
  const off = r() * 100;
  const pa = g.attributes.position;
  const v = new THREE.Vector3();
  // flattened facets (planar cuts) for a fractured look
  const cuts = [];
  for (let k = 0; k < (o.cuts ?? 5) + 2; k++) {
    const nrm = new THREE.Vector3(r() - 0.5, r() - 0.3, r() - 0.5).normalize();
    cuts.push([nrm, 0.5 + r() * 0.3]);
  }
  for (let i = 0; i < pa.count; i++) {
    v.fromBufferAttribute(pa, i);
    const n = n3(v.x * 1.3 + off, v.y * 1.3, v.z * 1.3) * 0.3 + n3(v.x * 3.1, v.y * 3.1 + off, v.z * 3.1) * 0.14 + n3(v.x * 6.5, v.y * 6.5, v.z * 6.5 + off) * 0.07 + n3(v.x * 13, v.y * 13 + off, v.z * 13) * 0.025;
    v.multiplyScalar(1 + n);
    for (const [nrm, d] of cuts) { const t = v.dot(nrm); if (t > d) v.addScaledVector(nrm, (d - t) * 0.55); }
    if (o.flatTop && v.y > o.flatTop) v.y = o.flatTop + (v.y - o.flatTop) * 0.12;
    // strata ledges: slight horizontal stepping
    if (o.ledges) v.y = Math.round(v.y * 7) / 7 * 0.4 + v.y * 0.6;
    v.x *= sx; v.y *= sy; v.z *= sz;
    if (v.y < -0.25 * sy) v.y = -0.25 * sy + (v.y + 0.25 * sy) * 0.3; // flatter base
    pa.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g.userData.base = -0.25 * sy; // local y of the flattened base
  return g;
}

export function rockMaterial(opts = {}) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0 });
  patch(m, {
    key: 'rock' + (opts.key || ''),
    wet: 1.0, bump: 1.0, shadowBias: 0.4,
    vHead: 'varying vec3 vLocal; varying vec3 vSeed;',
    vBegin: `vLocal = position;
      #ifdef USE_INSTANCING_COLOR
        vSeed = instanceColor;
      #else
        vSeed = vec3(0.5);
      #endif`,
    fHead: 'varying vec3 vLocal; varying vec3 vSeed;',
    fColor: `{
      vec3 lp = vLocal;
      float seedv = vSeed.r * 97.0 + vSeed.g * 13.0;
      // sedimentary banding across the boulder (tilted)
      float by = lp.y * ${(opts.bandScale || 9).toFixed(1)} + dot(lp.xz, vec2(0.35, 0.2)) * 2.0 + seedv;
      vec3 band = texture2D(uStrataTex, vec2(by / 60.0 + (texture2D(uNoiseTex, lp.xz * 0.6 + vSeed.rg).r - 0.5) * 0.03, 0.5)).rgb;
      vec3 worldBand = strataColor(vWPos);
      vec3 col = mix(worldBand, band, ${(opts.localBands ?? 0.7).toFixed(2)});
      // world-space biplanar detail so large and small rocks share the same texel scale
      vec3 an = abs(normalize(vWNrm));
      vec2 pA = vWPos.xz, pB = vec2(dot(vWPos.xz, normalize(vec2(-vWNrm.z, vWNrm.x) + 1e-4)), vWPos.y);
      float wB = smoothstep(0.45, 0.75, 1.0 - an.y);
      #define TX(uvx, s) mix(texture2D(uNoiseTex, (pA * s) + uvx), texture2D(uNoiseTex, (pB * s) + uvx), wB)
      float n1 = TX(vSeed.rg, 0.9).r;
      float n2 = TX(vSeed.gb, 2.6).g;
      float n3v = TX(vec2(0.3), 7.0).b;
      float grain = TX(vSeed.br, 21.0).a;
      col *= 0.86 + 0.2 * n1;
      col *= 0.84 + 0.3 * n3v;
      col *= 0.9 + 0.2 * grain;
      float crev = smoothstep(0.3, 0.6, n2);
      col *= mix(0.82, 1.02, crev);
      float up = clamp(vWNrm.y, 0.0, 1.0);
      float l1 = smoothstep(0.66, 0.7, TX(vSeed.rb, 4.5).a + n3v * 0.08) * (0.25 + up * 0.75);
      float l2 = smoothstep(0.7, 0.73, TX(vSeed.bg + 0.5, 6.0).r) * (0.3 + up * 0.7);
      col = mix(col, pow(vec3(0.85, 0.55, 0.14), vec3(2.2)), l1 * 0.75 * ${(opts.lichen ?? 1).toFixed(2)});
      col = mix(col, pow(vec3(0.62, 0.66, 0.5), vec3(2.2)), l2 * 0.45 * ${(opts.lichen ?? 1).toFixed(2)});
      float moss = smoothstep(0.55, 0.75, n2) * smoothstep(0.2, -0.3, lp.y) * ${(opts.moss ?? 0.6).toFixed(2)};
      col = mix(col, pow(vec3(0.32, 0.4, 0.16), vec3(2.2)), moss * 0.7);
      gBump = n2 * 0.35 + n3v * 0.35 + grain * 0.25 + (l1 + l2) * 0.12;
      float spk = TX(vSeed.gr * 3.0, 17.0).r;
      col *= 0.8 + 0.35 * spk;
      col = mix(col, vec3(dot(col, vec3(0.33))) * vec3(1.04, 1.0, 0.92), 0.62);
      diffuseColor.rgb = col * (0.5 + vSeed.b * 0.2);
      gBump += spk * 0.2;
      { float fw = fallWet(vWPos); diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.3, 0.35, 0.33), fw); }
    }`,
  });
  return m;
}

// spatially chunked instanced meshes so frustum culling (main + shadow cameras) actually works
export function chunked(scene, geo, mat, items, size, fill, opts = {}) {
  const map = new Map();
  for (const it of items) { const k = Math.floor(it.x / size) + ',' + Math.floor(it.z / size); let a = map.get(k); if (!a) map.set(k, a = []); a.push(it); }
  const dummy = new THREE.Object3D(); const col = new THREE.Color(); const meshes = [];
  for (const list of map.values()) {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => { const c = fill(it, dummy, col); dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix); if (c) im.setColorAt(i, col); });
    im.castShadow = opts.cast ?? true; im.receiveShadow = true;
    im.computeBoundingSphere();
    if (opts.layer !== undefined) im.layers.set(opts.layer);
    scene.add(im); meshes.push(im);
  }
  return meshes;
}

// place instanced rocks; returns {meshes, list}
export function scatterRocks(W, scene, extras) {
  const rng = mulberry32(404);
  const hf = W.hf;
  const tr = W.trail;
  const boulders = [];
  const grid = new Map();
  const key = (x, z) => (Math.floor(x / 6) * 7919) ^ Math.floor(z / 6);
  const fits = (x, z, r) => {
    for (let ix = -1; ix <= 1; ix++) for (let iz = -1; iz <= 1; iz++) {
      const arr = grid.get(key(x + ix * 6, z + iz * 6)); if (!arr) continue;
      for (const b of arr) if (Math.hypot(b.x - x, b.z - z) < b.r + r + 0.3) return false;
    }
    return true;
  };
  const add = (b) => { boulders.push(b); const k = key(b.x, b.z); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(b); };
  const avoid = (x, z) => {
    if (W.endlessK(x, z) > 0.02) return true;
    if (W.tarnEllipse(x, z) < 1.4) return true;
    const sq = W.stream.near(x, z, 4); if (sq) return true;
    const dB = Math.hypot(x - W.bridge.x, z - W.bridge.z); if (dB < 9) return true;
    if (Math.hypot(x - W.falls.pool.x, z - W.falls.pool.z) < W.falls.pool.r + 3) return true;
    if (Math.hypot(x - W.plain.x, z - W.plain.z) < W.plain.r + 8) return true;
    { const [lx, lz] = W.house.toL(x, z); if (Math.abs(lx) < 12 && lz > -17.5 && lz < 12.5) return true; }
    if (Math.hypot(x - W.falls.lip.x, z - W.falls.lip.z) < 6) return true;
    for (const L of [W.ovoo, W.marker, W.bones, W.rest, W.shelter]) if (Math.hypot(x - L.x, z - L.z) < (L === W.shelter ? 16 : 6)) return true;
    return false;
  };
  // rest-spot windbreak: U of large lichen boulders open toward the trail
  {
    const R = W.rest; const f = R.f; const rt = [-f[1], f[0]]; // right of trail direction
    const specs = [[-2.6, 1.2, 1.35], [-1.4, 2.5, 1.2], [0.4, 3.0, 1.45], [2.1, 2.4, 1.15], [3.0, 0.9, 0.95], [0.6, 0.2, 0.55]];
    for (const [a, b, r] of specs) {
      const x = R.x + f[0] * a + rt[0] * b, z = R.z + f[1] * a + rt[1] * b;
      add({ x, z, r, h: r * (0.8 + rng() * 0.2), rest: true, seed: Math.floor(rng() * 1e6) });
    }
  }
  // boulders near the trail
  let tries = 0;
  while (boulders.length < 260 && tries++ < 8000) {
    const s = rng() * tr.len; const a = tr.at(s);
    const side = rng() < 0.5 ? -1 : 1;
    const off = 3 + Math.pow(rng(), 1.6) * 70;
    const x = a.x - a.tz * off * side, z = a.z + a.tx * off * side;
    const r = 0.45 + Math.pow(rng(), 2.2) * 2.4;
    const q = tr.near(x, z, r + 2.5); if (q) continue;
    if (avoid(x, z)) continue;
    const m = W.maskAt(x, z);
    if (m[2] > 0.3) continue;
    if (rng() > 0.35 + m[1] * 0.9 + m[7] * 0.5) continue;
    if (!fits(x, z, r)) continue;
    add({ x, z, r, h: r, seed: Math.floor(rng() * 1e6) });
  }
  // sparse big boulders farther out
  tries = 0;
  while (boulders.length < 420 && tries++ < 6000) {
    const x = (rng() * 2 - 1) * 480, z = (rng() * 2 - 1) * 480;
    const q = tr.near(x, z, 8); if (q) continue;
    if (avoid(x, z)) continue;
    const m = W.maskAt(x, z); if (m[2] > 0.2 || m[3] > 0.4) continue;
    const r = 1 + Math.pow(rng(), 2) * 3;
    if (!fits(x, z, r)) continue;
    add({ x, z, r, h: r, seed: Math.floor(rng() * 1e6) });
  }
  // build instanced meshes per variant
  const NV = 5;
  const geos = []; for (let v = 0; v < NV; v++) geos.push(rockGeometry(1000 + v * 17, 3, { cuts: 2 + (v % 2) }));
  const mat = rockMaterial({ key: 'b', localBands: 0.35, bandScale: 5 });
  const buckets = geos.map(() => []);
  boulders.forEach((b, i) => buckets[i % NV].push(b));
  const dummy = new THREE.Object3D(); const col = new THREE.Color();
  const nrm = [0, 1, 0];
  const colliders = [];
  buckets.forEach((list, v) => {
    const base = geos[v].userData.base;
    chunked(scene, geos[v], mat, list, 90, (b, d, c) => {
      const rr = mulberry32(b.seed);
      let gmin = Infinity;
      for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; gmin = Math.min(gmin, hf.height(b.x + Math.cos(a) * b.r * 0.8, b.z + Math.sin(a) * b.r * 0.8)); }
      gmin = Math.min(gmin, hf.height(b.x, b.z));
      hf.normal(b.x, b.z, b.r, nrm);
      d.position.set(b.x, gmin - base * b.h - b.h * 0.2, b.z);
      d.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(nrm[0] * 0.5, 1, nrm[2] * 0.5).normalize());
      d.rotateY(rr() * Math.PI * 2);
      d.scale.set(b.r, b.h, b.r);
      c.setRGB(rr(), rr(), 0.8 + rr() * 0.4);
      b.y = gmin; b.top = gmin + b.h * 0.8;
      colliders.push({ x: b.x, z: b.z, r: b.r * 0.95, y: gmin + b.h * 0.3 });
      return true;
    });
  });

  // ---- scree: many small stones on scree masks near the trail + tarn shore stones
  const sgeos = []; for (let v = 0; v < 3; v++) sgeos.push(rockGeometry(3000 + v * 31, 1, { cuts: 3, sy: 0.45 + v * 0.08 }));
  const smat = rockMaterial({ key: 's', bandScale: 3, localBands: 0.5, lichen: 0.35, moss: 0.2 });
  const stones = sgeos.map(() => []);
  let count = 0; tries = 0;
  while (count < 9000 && tries++ < 90000) {
    const s = rng() * tr.len; const a = tr.at(s);
    const off = (rng() * 2 - 1) * 70;
    const x = a.x - a.tz * off, z = a.z + a.tx * off;
    const m = W.maskAt(x, z);
    const q = tr.near(x, z, 1.1);
    const pScree = m[1] * 0.95 + (m[7] > 0.3 ? 0.15 : 0) + (q ? 0.02 : 0);
    if (rng() > pScree) continue;
    if (W.tarnEllipse(x, z) < 1.0 && rng() < 0.7) continue;
    const r = 0.06 + Math.pow(rng(), 3) * 0.38;
    if (q && q.d < 0.7) continue;
    stones[count % 3].push({ x, z, r }); count++;
  }
  // tarn bottom & shore stones (visible through shallow water)
  for (let k = 0; k < 900; k++) {
    const ang = rng() * Math.PI * 2, e = 0.75 + rng() * 0.45;
    const u = Math.cos(ang) * W.tarn.rx * e, vv = Math.sin(ang) * W.tarn.rz * e;
    const x = W.tarn.x + W.tarn.fwd[0] * u + W.tarn.left[0] * vv, z = W.tarn.z + W.tarn.fwd[1] * u + W.tarn.left[1] * vv;
    stones[k % 3].push({ x, z, r: 0.08 + Math.pow(rng(), 2) * 0.35 });
  }
  // stream bed stones
  for (let s = 2; s < W.stream.len; s += 0.9) {
    const a = W.stream.at(s);
    for (let k = 0; k < 2; k++) {
      const o = (rng() * 2 - 1) * 1.3;
      stones[(k + Math.floor(s)) % 3].push({ x: a.x - a.tz * o, z: a.z + a.tx * o, r: 0.1 + Math.pow(rng(), 2) * 0.35, stream: true });
    }
  }
  W.streamStones = [];
  stones.forEach((list, v) => {
    const base = sgeos[v].userData.base;
    chunked(scene, sgeos[v], smat, list, 70, (st, d, c) => {
      const g = Math.min(hf.height(st.x, st.z), hf.height(st.x + st.r * 0.7, st.z), hf.height(st.x - st.r * 0.7, st.z), hf.height(st.x, st.z + st.r * 0.7), hf.height(st.x, st.z - st.r * 0.7));
      const hy = st.r * (0.6 + rng() * 0.5);
      d.position.set(st.x, g - base * hy - hy * 0.18, st.z);
      d.rotation.set((rng() - 0.5) * 0.4, rng() * 6.28, (rng() - 0.5) * 0.4);
      d.scale.set(st.r, hy, st.r * (0.7 + rng() * 0.6));
      c.setRGB(rng(), rng(), 0.75 + rng() * 0.4);
      if (st.stream) W.streamStones.push({ x: st.x, z: st.z, r: st.r, top: g + hy * 0.6 });
      return true;
    }, { cast: true, layer: 1 });
  });
  W.boulders = boulders;
  return { colliders, boulders, rockGeometry, rockMaterial };
}
