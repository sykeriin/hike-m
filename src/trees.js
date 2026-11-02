import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patch, barkTexture } from './materials.js';
import { mulberry32, clamp, lerp, smoothstep } from './noise.js';

// ------------------------------------------------------------------------------------------------
// Foliage textures: needle sprays with alpha, drawn once on canvases.
function sprayTexture(kind, seed) {
  const S = 256; const c = document.createElement('canvas'); c.width = S; c.height = S; const g = c.getContext('2d');
  const r = mulberry32(seed);
  g.clearRect(0, 0, S, S);
  const twig = (x, y, ang, len, depth) => {
    g.strokeStyle = kind === 'larch' ? 'rgba(92,64,42,1)' : 'rgba(70,58,44,1)'; g.lineWidth = Math.max(1, 3 - depth);
    let px = x, py = y;
    for (let t = 0; t < len; t += 3) {
      ang += (r() - 0.5) * 0.1;
      const nx = px + Math.cos(ang) * 3, ny = py + Math.sin(ang) * 3;
      g.beginPath(); g.moveTo(px, py); g.lineTo(nx, ny); g.stroke();
      px = nx; py = ny;
      if (kind === 'larch') {
        // brachyblast rosettes: soft tufts of fine needles
        if (t % 9 < 3) {
          const n = 16 + Math.floor(r() * 8);
          for (let k = 0; k < n; k++) {
            const a = r() * Math.PI * 2, l = 7 + r() * 9;
            const hue = 92 + r() * 26, lit = 24 + r() * 16;
            g.strokeStyle = `hsl(${hue},${22 + r() * 14}%,${lit}%)`; g.lineWidth = 1.2 + r() * 0.8;
            g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l * 0.85); g.stroke();
          }
        }
      } else {
        // juniper: overlapping scale leaves forming dense flat sprays
        for (let k = 0; k < 4; k++) {
          const a2 = ang + (r() < 0.5 ? 1 : -1) * (0.5 + r() * 0.8), l = (1 - t / len) * 12 + 6;
          const sh = 50 + r() * 55;
          g.strokeStyle = `rgba(${sh * 0.5 | 0},${sh * 0.74 + 10 | 0},${sh * 0.56 | 0},1)`; g.lineWidth = 2.2 + r() * 2;
          g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(a2) * l, py + Math.sin(a2) * l); g.stroke();
        }
      }
      if (depth < 2 && r() < (kind === 'larch' ? 0.05 : 0.07)) twig(px, py, ang + (r() < 0.5 ? 0.6 : -0.6), len * 0.5, depth + 1);
    }
  };
  for (let k = 0; k < (kind === 'larch' ? 5 : 8); k++) twig(S * 0.5 + (r() - 0.5) * 60, S * 0.98, -Math.PI / 2 + (r() - 0.5) * 1.0, S * (0.55 + r() * 0.35), 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------------------------------------------
function taperedTube(curve, r0, r1, seg, rad) {
  const g = new THREE.TubeGeometry(curve, seg, 1, rad);
  const pa = g.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    const ring = Math.floor(i / (rad + 1)); const t = Math.min(1, ring / seg);
    const p = curve.getPointAt(t); const r = lerp(r0, r1, t);
    pa.setXYZ(i, p.x + (pa.getX(i) - p.x) * r, p.y + (pa.getY(i) - p.y) * r, p.z + (pa.getZ(i) - p.z) * r);
  }
  g.computeVertexNormals();
  return g;
}

// A foliage card: a quad with a spherical "crown" normal and an AO / tint vertex colour.
function addCard(cards, center, w, h, rot, crownC, crownUp, ao, tint) {
  const q = new THREE.PlaneGeometry(w, h);
  q.applyQuaternion(rot);
  q.translate(center.x, center.y, center.z);
  const n = new THREE.Vector3().subVectors(center, crownC); n.y *= 0.7; n.normalize().lerp(new THREE.Vector3(0, 1, 0), crownUp).normalize();
  const na = q.attributes.normal; for (let i = 0; i < na.count; i++) na.setXYZ(i, n.x, n.y, n.z);
  const col = new Float32Array(na.count * 3); for (let i = 0; i < na.count; i++) { col[i * 3] = ao * tint[0]; col[i * 3 + 1] = ao * tint[1]; col[i * 3 + 2] = ao * tint[2]; }
  q.setAttribute('color', new THREE.BufferAttribute(col, 3));
  cards.push(q.index ? q.toNonIndexed() : q);
}

// Siberian larch: straight trunk leaning downwind, whorls of drooping branches with upturned tips,
// twigs clothed in soft needle tufts. Local +x is downwind (branches flag that way).
export function larch(rng, H) {
  const wood = [], cards = [];
  const tp = [];
  const lean = 0.06 + rng() * 0.06;
  for (let i = 0; i <= 8; i++) { const t = i / 8; tp.push(new THREE.Vector3(Math.sin(t * 2.3 + rng()) * 0.04 * H * t + t * t * lean * H, t * H, Math.sin(t * 1.7 + rng()) * 0.03 * H * t)); }
  const trunk = new THREE.CatmullRomCurve3(tp);
  const r0 = 0.06 + H * 0.028;
  wood.push(taperedTube(trunk, r0, 0.012, 18, 8));
  // root flare
  const flare = new THREE.CylinderGeometry(r0 * 1.05, r0 * 1.7, 0.35, 8, 1, true); flare.translate(tp[0].x, 0.12, tp[0].z); wood.push(flare);
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  const tint = rng() < 0.25 ? [1.05, 1.0, 0.72] : [1, 1, 1]; // some trees starting to yellow in late summer
  let y = Math.max(0.55, H * 0.2) + rng() * 0.35;
  while (y < H * 0.97) {
    const t = y / H;
    const p0 = trunk.getPointAt(Math.min(1, t));
    const n = 3 + Math.floor(rng() * 3);
    const maxL = H * 0.34 * Math.pow(1 - t, 0.85) + 0.3;
    for (let k = 0; k < n; k++) {
      const az = k / n * Math.PI * 2 + rng() * 0.8;
      const dir = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
      const windward = Math.max(0, -dir.x);
      const L = maxL * (0.75 + rng() * 0.35) * (1 - 0.55 * windward);
      const droop = 0.18 + rng() * 0.12;
      const q1 = p0.clone().addScaledVector(dir, L * 0.33).add(new THREE.Vector3(0, -droop * L * 0.3, 0));
      const q2 = p0.clone().addScaledVector(dir, L * 0.68).add(new THREE.Vector3(0, -droop * L * 0.55, 0));
      const q3 = p0.clone().addScaledVector(dir, L).add(new THREE.Vector3(0, -droop * L * 0.35 + 0.12, 0));
      const bc = new THREE.CatmullRomCurve3([p0.clone(), q1, q2, q3]);
      wood.push(taperedTube(bc, 0.012 + 0.028 * L / maxL * (1 - t * 0.5), 0.004, 5, 4));
      const crownC = new THREE.Vector3(p0.x, H * 0.45, p0.z);
      // needle cards along the branch
      const nc = Math.floor(L / 0.19) + 2;
      for (let c = 0; c < nc; c++) {
        const s = Math.min(1, 0.2 + 0.8 * c / (nc - 1));
        const pc = bc.getPointAt(s).add(new THREE.Vector3((rng() - 0.5) * 0.1, (rng() - 0.5) * 0.08, (rng() - 0.5) * 0.1));
        const w = 0.3 + 0.22 * (1 - s) + rng() * 0.1;
        e.set((rng() - 0.5) * 2.2, rng() * Math.PI * 2, (rng() - 0.5) * 2.2); q.setFromEuler(e);
        const rr = Math.hypot(pc.x - p0.x, pc.z - p0.z) / (maxL + 0.2);
        const ao = (0.55 + 0.45 * smoothstep(0.05, 0.9, rr)) * (0.82 + 0.18 * t);
        addCard(cards, pc, w, w * 1.15, q.clone(), crownC, 0.35, ao, tint);
      }
      // side twigs
      for (const sgn of [-1, 1]) {
        if (L < 0.8) continue;
        const s0 = 0.35 + rng() * 0.35; const b0 = bc.getPointAt(s0);
        const td = dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), sgn * (0.6 + rng() * 0.4));
        const tl = L * (0.25 + rng() * 0.15);
        const tc = new THREE.CatmullRomCurve3([b0, b0.clone().addScaledVector(td, tl * 0.5).add(new THREE.Vector3(0, -0.04, 0)), b0.clone().addScaledVector(td, tl).add(new THREE.Vector3(0, 0.02, 0))]);
        wood.push(taperedTube(tc, 0.008, 0.003, 3, 3));
        for (let c = 0; c < 3; c++) {
          const pc = tc.getPointAt(0.3 + c * 0.33);
          e.set((rng() - 0.5) * 2.2, rng() * Math.PI * 2, (rng() - 0.5) * 2.2); q.setFromEuler(e);
          addCard(cards, pc, 0.24 + rng() * 0.08, 0.28, q.clone(), crownC, 0.35, 0.7 + 0.3 * rng(), tint);
        }
      }
    }
    y += 0.36 + rng() * 0.26;
  }
  // leader tuft at the top
  const top = trunk.getPointAt(1);
  for (let c = 0; c < 8; c++) {
    e.set((rng() - 0.5) * 2, rng() * Math.PI * 2, (rng() - 0.5) * 2); q.setFromEuler(e);
    addCard(cards, top.clone().add(new THREE.Vector3((rng() - 0.5) * 0.25, -rng() * 0.45, (rng() - 0.5) * 0.25)), 0.24, 0.3, q.clone(), new THREE.Vector3(top.x, H * 0.5, top.z), 0.4, 0.95, tint);
  }
  return { wood: mergeGeometries(wood.map(g => g.index ? g.toNonIndexed() : g)), foliage: mergeGeometries(cards), crownR: H * 0.34 + 0.3 };
}

// Creeping juniper: prostrate woody stems radiating downwind under a dense low mound of scale-leaf sprays.
export function juniper(rng) {
  const wood = [], cards = [];
  const RX = 0.9 + rng() * 0.6, RY = 0.32 + rng() * 0.18, RZ = 0.7 + rng() * 0.4;
  for (let k = 0; k < 4; k++) {
    const a = (rng() - 0.5) * 1.8;
    const pts = [new THREE.Vector3(0, 0.02, 0)];
    for (let i = 1; i <= 4; i++) pts.push(new THREE.Vector3(Math.cos(a) * RX * 0.28 * i, 0.04 + Math.sin(i) * 0.03, Math.sin(a) * RZ * 0.28 * i));
    wood.push(taperedTube(new THREE.CatmullRomCurve3(pts), 0.045, 0.01, 10, 6));
  }
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  const C = new THREE.Vector3(0.1, -0.15, 0);
  for (let i = 0; i < 230; i++) {
    const u = rng() * Math.PI * 2, v = Math.acos(rng() * 0.92);
    const sh = 0.72 + rng() * 0.32;
    const p = new THREE.Vector3(Math.sin(v) * Math.cos(u) * RX * sh + 0.1, Math.cos(v) * RY * sh + 0.03, Math.sin(v) * Math.sin(u) * RZ * sh);
    e.set(-Math.PI / 2 + (rng() - 0.5) * 1.4, rng() * Math.PI * 2, (rng() - 0.5) * 0.8); q.setFromEuler(e);
    const ao = 0.5 + 0.5 * sh * sh * (0.6 + 0.4 * (p.y / RY));
    addCard(cards, p, 0.34 + rng() * 0.16, 0.36 + rng() * 0.12, q.clone(), C, 0.45, ao, [0.95, 1.0, 1.02]);
  }
  return { wood: mergeGeometries(wood.map(g => g.index ? g.toNonIndexed() : g)), foliage: mergeGeometries(cards), r: Math.max(RX, RZ) };
}

const TREE_WIND = `
  {
    vec3 io = vec3(0.0);
    #ifdef USE_INSTANCING
      io = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    #endif
    float g = windGust(io.xz);
    float str = uWind * (0.3 + 1.0 * g);
    float hN = max(position.y, 0.0) / uTreeH;
    float sway = str * hN * hN * uSwayAmp;
    float ph = dot(position, vec3(3.1, 1.7, 2.3));
    float flutter = sin(uTime * (4.0 + str * 3.0) + ph) * 0.025 * str * uFlutter;
    vec2 wd = uWindDir * (sway + sin(uTime * 0.9 + io.x) * 0.1 * sway);
    #ifdef USE_INSTANCING
      mat3 im = mat3(instanceMatrix);
      vec3 lb = transpose(im) * vec3(wd.x, 0.0, wd.y) / max(dot(im[0], im[0]), 1e-4);
      transformed += lb + vec3(flutter, flutter * 0.6, -flutter);
    #endif
  }
`;

export function buildTrees(W, scene, colliders, camColliders) {
  const rng = mulberry32(8080);
  const hf = W.hf, tr = W.trail;
  const out = {};
  const bark = barkTexture(11); bark.repeat.set(2, 6);
  const barkM = new THREE.MeshStandardMaterial({ color: 0x9a8573, map: bark, roughness: 0.92 });
  patch(barkM, { key: 'treebark', shadowBias: 0.3, uniforms: { uTreeH: { value: 5 }, uSwayAmp: { value: 0.35 }, uFlutter: { value: 0 } }, vHead: 'uniform float uTreeH; uniform float uSwayAmp; uniform float uFlutter;', vBegin: TREE_WIND });
  const larchTex = sprayTexture('larch', 3), junTex = sprayTexture('juniper', 7);
  const folMat = (tex, key, H, amp, flut) => {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, alphaTest: 0.42, side: THREE.DoubleSide, vertexColors: true, roughness: 0.78 });
    patch(m, {
      key, shadowBias: 0.3, uniforms: { uTreeH: { value: H }, uSwayAmp: { value: amp }, uFlutter: { value: flut } },
      vHead: 'uniform float uTreeH; uniform float uSwayAmp; uniform float uFlutter;', vBegin: TREE_WIND,
      fNormal: 'normal = normalize(vNormal);',
      fLight: `{ vec3 V = normalize(cameraPosition - vWPos); float bl = pow(max(dot(-V, uSunDir), 0.0), 4.0);
        vec3 wn = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
        float wrap = pow(clamp(dot(wn, uSunDir) * 0.5 + 0.5, 0.0, 1.0), 2.0);
        reflectedLight.directDiffuse += diffuseColor.rgb * uKeyColor * (bl * 0.6 + wrap * 0.14) * gTSh;
        reflectedLight.indirectDiffuse *= 1.35; }`,
    });
    m.shadowSide = THREE.DoubleSide;
    return m;
  };
  const larchFol = folMat(larchTex, 'larchfol', 5, 0.35, 1);
  const junFol = folMat(junTex, 'junfol', 0.8, 0.05, 0.4);

  // placement helpers
  const trailClear = (x, z, r) => { const q = tr.near(x, z, r + 4); return !q || q.d > r + 1.6; };
  const blocked = (x, z, r) => {
    if (W.endlessK(x, z) > 0.02) return true;
    if (W.tarnEllipse(x, z) < 1.3) return true;
    if (W.stream.near(x, z, r + 2.5)) return true;
    if (Math.hypot(x - W.falls.pool.x, z - W.falls.pool.z) < W.falls.pool.r + r + 3) return true;
    if (Math.hypot(x - W.plain.x, z - W.plain.z) < W.plain.r + r + 10) return true;
    { const [lx, lz] = W.house.toL(x, z); if (Math.abs(lx) < 10.5 + r && lz > -15.5 - r && lz < 10.5 + r) return true; }
    for (const L of [W.ovoo, W.marker, W.bones, W.rest, W.bridge]) if (Math.hypot(x - L.x, z - L.z) < 6 + r) return true;
    for (const b of (W.boulders || [])) { if (Math.abs(b.x - x) > b.r + r + 1 || Math.abs(b.z - z) > b.r + r + 1) continue; if (Math.hypot(b.x - x, b.z - z) < b.r + r * 0.6) return true; }
    const m = W.maskAt(x, z); if (m[2] > 0.05 || m[7] > 0.55) return true;
    return false;
  };
  const placed = [];
  const spaced = (x, z, r) => placed.every(p => Math.hypot(p.x - x, p.z - z) > p.r * 0.6 + r * 0.6 + 1.2);

  // ---------------- larches: groves in sheltered leeward folds + a few lone trees near the path
  const NV = 4;
  const variants = []; for (let v = 0; v < NV; v++) { const H = 3.6 + v * 1.2 + rng(); variants.push({ H, ...larch(mulberry32(300 + v * 17), H) }); }
  const larchItems = variants.map(() => []);
  const tryLarch = (x, z, scale) => {
    const v = Math.floor(rng() * NV); const V = variants[v];
    const r = V.crownR * scale;
    if (!trailClear(x, z, r) || blocked(x, z, r) || !spaced(x, z, r)) return false;
    const nrm = [0, 1, 0]; hf.normal(x, z, 2, nrm); if (nrm[1] < 0.8) return false;
    larchItems[v].push({ x, z, s: scale, H: V.H * scale }); placed.push({ x, z, r });
    colliders.push({ x, z, r: 0.5 * scale + 0.15 });
    camColliders.push({ x, z, r: r * 0.55, y: hf.height(x, z) + V.H * scale * 0.55 });
    return true;
  };
  let groves = 0, gt = 0;
  while (groves < 11 && gt++ < 400) {
    const ds = 180 + rng() * 520, o = -(22 + rng() * 110) * (rng() < 0.82 ? 1 : -0.6);
    const [gx, gz] = W.frame(ds, o);
    const h0 = hf.height(gx, gz), hs = (hf.height(gx + 8, gz) + hf.height(gx - 8, gz) + hf.height(gx, gz + 8) + hf.height(gx, gz - 8)) / 4;
    if (hs - h0 < 0.2 && rng() > 0.35) continue;
    const n = 3 + Math.floor(rng() * 6); let got = 0;
    for (let k = 0; k < n * 4 && got < n; k++) { const a = rng() * 6.28, rr = Math.sqrt(rng()) * 16; if (tryLarch(gx + Math.cos(a) * rr, gz + Math.sin(a) * rr, 0.75 + rng() * 0.55)) got++; }
    if (got) groves++;
  }
  for (let k = 0, lone = 0; k < 400 && lone < 8; k++) {
    const s = 40 + rng() * (tr.len - 200), a = tr.at(s); const side = rng() < 0.5 ? -1 : 1; const off = side * (7 + rng() * 10);
    if (tryLarch(a.x - a.tz * off, a.z + a.tx * off, 0.6 + rng() * 0.4)) lone++;
  }
  // a larch in the cabin's backyard
  { const [bx, bz] = W.house.toW(6.2, -8.5); const V = variants[2]; larchItems[2].push({ x: bx, z: bz, s: 1.05, H: V.H }); colliders.push({ x: bx, z: bz, r: 0.4 }); }

  const wd = new THREE.Vector2(U_WIND_X, U_WIND_Z);
  larchItems.forEach((items, v) => {
    if (!items.length) return;
    const V = variants[v];
    const wIM = new THREE.InstancedMesh(V.wood, barkM, items.length);
    const fIM = new THREE.InstancedMesh(V.foliage, larchFol, items.length);
    const d = new THREE.Object3D();
    items.forEach((it, i) => {
      d.position.set(it.x, hf.height(it.x, it.z) - 0.05, it.z);
      d.rotation.set(0, -Math.atan2(wd.y, wd.x) + (rng() - 0.5) * 0.5, 0);
      d.scale.setScalar(it.s); d.updateMatrix();
      wIM.setMatrixAt(i, d.matrix); fIM.setMatrixAt(i, d.matrix);
    });
    for (const im of [wIM, fIM]) { im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere(); scene.add(im); im.layers.enable(2); }
  });

  // ---------------- creeping juniper mats on rocky slopes near the trail
  const jv = [0, 1, 2].map(i => juniper(mulberry32(700 + i * 13)));
  const junItems = jv.map(() => []);
  for (let k = 0, n = 0; k < 3000 && n < 70; k++) {
    const s = rng() * tr.len, a = tr.at(s); const side = rng() < 0.5 ? -1 : 1; const off = side * (3 + rng() * 45);
    const x = a.x - a.tz * off, z = a.z + a.tx * off;
    const v = Math.floor(rng() * 3); const sc = 0.8 + rng() * 0.8; const r = jv[v].r * sc;
    if (!trailClear(x, z, r) || blocked(x, z, r) || !spaced(x, z, r)) continue;
    const m = W.maskAt(x, z); if (m[7] < 0.12 && rng() > 0.35) continue;
    junItems[v].push({ x, z, s: sc }); placed.push({ x, z, r }); n++;
    colliders.push({ x, z, r: r * 0.75 });
  }
  junItems.forEach((items, v) => {
    if (!items.length) return;
    const wIM = new THREE.InstancedMesh(jv[v].wood, barkM, items.length);
    const fIM = new THREE.InstancedMesh(jv[v].foliage, junFol, items.length);
    const d = new THREE.Object3D();
    items.forEach((it, i) => {
      d.position.set(it.x, hf.height(it.x, it.z) - 0.04, it.z);
      d.rotation.set(0, -Math.atan2(wd.y, wd.x) + (rng() - 0.5) * 0.8, 0);
      d.scale.set(it.s, it.s * (0.8 + rng() * 0.4), it.s); d.updateMatrix();
      wIM.setMatrixAt(i, d.matrix); fIM.setMatrixAt(i, d.matrix);
    });
    for (const im of [wIM, fIM]) { im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere(); scene.add(im); }
  });
  out.count = larchItems.flat().length + junItems.flat().length;
  return out;
}
const U_WIND_X = 0.92, U_WIND_Z = 0.39;
