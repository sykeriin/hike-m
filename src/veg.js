import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patch, barkTexture } from './materials.js';
import { chunked } from './rocks.js';
import { mulberry32, clamp, lerp, smoothstep } from './noise.js';

// shared wind bend for instanced foliage (vertex, world space)
const WIND_V = (amp, stiff) => `
  {
    vec3 io = vec3(0.0);
    #ifdef USE_INSTANCING
      io = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    #endif
    float hgt = max(position.y, 0.0);
    float hw = pow(hgt * ${stiff.toFixed(2)}, 1.6);
    float g = windGust(io.xz);
    float str = uWind * (0.35 + 1.1 * g);
    float flut = sin(uTime * 5.3 + io.x * 1.7 + io.z * 1.3 + position.x * 9.0) * 0.25 + sin(uTime * 9.1 + io.z * 3.1) * 0.1;
    vec2 bend = uWindDir * (str + flut * (0.3 + str * 0.5)) * hw * ${amp.toFixed(3)};
    // move in world space: convert to object space ignoring instance rotation approx
    #ifdef USE_INSTANCING
      mat3 im = mat3(instanceMatrix);
      vec3 wb = vec3(bend.x, -length(bend) * 0.35, bend.y);
      vec3 lb = transpose(im) * wb / max(dot(im[0], im[0]), 1e-4);
      transformed += lb;
    #else
      transformed += vec3(bend.x, -length(bend) * 0.35, bend.y);
    #endif
  }
`;

function grassClump(rng, blades = 7) {
  const geos = [];
  for (let b = 0; b < blades; b++) {
    const h = 0.1 + rng() * 0.26 + (rng() < 0.12 ? 0.18 : 0), w = 0.008 + rng() * 0.01;
    const ang = rng() * Math.PI * 2, lean = 0.1 + rng() * 0.5, rad = Math.sqrt(rng()) * 0.16;
    const segs = 4;
    const pos = [], uv = [], nrm = [], idx = [];
    const bx = Math.cos(ang) * rad, bz = Math.sin(ang) * rad;
    const dx = Math.cos(ang + (rng() - 0.5)), dz = Math.sin(ang + (rng() - 0.5));
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const ww = w * (1 - t * 0.92);
      const y = h * t;
      const off = lean * h * t * t;
      const cx = bx + dx * off, cz = bz + dz * off;
      const px = -dz * ww, pz = dx * ww;
      pos.push(cx - px, y, cz - pz, cx + px, y, cz + pz);
      uv.push(0, t, 1, t);
      // normals biased upward to avoid dark backfaces
      const nx = dx * 0.4, nz = dz * 0.4;
      nrm.push(nx, 1, nz, nx, 1, nz);
      if (i < segs) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    geos.push(g);
  }
  // seed heads on a couple of stems
  const m = mergeGeometries(geos);
  m.normalizeNormals();
  return m;
}

function flowerGeo(kind) {
  const geos = [];
  const stemH = kind === 0 ? 0.09 : 0.14;
  const stem = new THREE.CylinderGeometry(0.0025, 0.003, stemH, 4, 1);
  stem.translate(0, stemH / 2, 0);
  geos.push(stem);
  const petals = kind === 0 ? 9 : 5;
  for (let i = 0; i < petals; i++) {
    const a = i / petals * Math.PI * 2;
    const pl = kind === 0 ? 0.028 : 0.014, pw = kind === 0 ? 0.008 : 0.009;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0); shape.quadraticCurveTo(pw, pl * 0.4, 0, pl); shape.quadraticCurveTo(-pw, pl * 0.4, 0, 0);
    const pg = new THREE.ShapeGeometry(shape, 2);
    pg.rotateX(-Math.PI / 2 + (kind === 0 ? 0.25 : 0.5));
    pg.rotateY(a);
    pg.translate(0, stemH, 0);
    geos.push(pg);
  }
  const c = new THREE.SphereGeometry(kind === 0 ? 0.008 : 0.005, 5, 3);
  c.translate(0, stemH + 0.003, 0);
  geos.push(c);
  // woolly grey leaves at base (edelweiss)
  if (kind === 0) for (let i = 0; i < 4; i++) {
    const lg = new THREE.PlaneGeometry(0.012, 0.05); lg.translate(0, 0.025, 0); lg.rotateX(-1.1); lg.rotateY(i * 1.6); geos.push(lg);
  }
  const m = mergeGeometries(geos.map(g => { g.deleteAttribute('uv'); return g.index ? g.toNonIndexed() : g; }));
  // colour attribute: centre/petals/stem via height
  const pa = m.attributes.position; const col = new Float32Array(pa.count * 3);
  for (let i = 0; i < pa.count; i++) {
    const y = pa.getY(i), r = Math.hypot(pa.getX(i), pa.getZ(i));
    let c;
    if (y < stemH * 0.85 && r < 0.004) c = [0.25, 0.35, 0.15];
    else if (y < 0.05 && kind === 0) c = [0.55, 0.6, 0.5];
    else if (r < (kind === 0 ? 0.01 : 0.006)) c = kind === 0 ? [0.85, 0.8, 0.45] : [0.95, 0.8, 0.2];
    else c = [1, 1, 1];
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  m.setAttribute('color', new THREE.BufferAttribute(col, 3));
  m.computeVertexNormals();
  return m;
}

function shrubGeo(rng) {
  // dwarf rhododendron: dome of leathery leaves + pale flower trusses
  const geos = [];
  const leaf = new THREE.Shape();
  leaf.moveTo(0, 0); leaf.quadraticCurveTo(0.018, 0.02, 0, 0.055); leaf.quadraticCurveTo(-0.018, 0.02, 0, 0);
  const lgBase = new THREE.ShapeGeometry(leaf, 2);
  const colArr = [];
  const pushCol = (g, c) => { const n = g.attributes.position.count; for (let i = 0; i < n; i++) colArr.push(...c); };
  for (let i = 0; i < 95; i++) {
    const u = rng() * Math.PI * 2, v = Math.acos(rng() * 0.95);
    const R = 0.28 + rng() * 0.08;
    const x = Math.sin(v) * Math.cos(u) * R * 1.25, y = Math.cos(v) * R * 0.75, z = Math.sin(v) * Math.sin(u) * R * 1.25;
    const lg0 = lgBase.clone();
    lg0.rotateX(-0.6 - rng() * 0.8); lg0.rotateY(u + Math.PI / 2 + (rng() - 0.5)); lg0.translate(x, y + 0.03, z);
    const lg = lg0.toNonIndexed();
    geos.push(lg);
    const shade = 0.7 + rng() * 0.3;
    pushCol(lg, [0.24 * shade, 0.34 * shade, 0.14 * shade]);
  }
  // twigs
  for (let i = 0; i < 8; i++) {
    const t0 = new THREE.CylinderGeometry(0.006, 0.01, 0.3, 4); t0.translate(0, 0.15, 0); t0.rotateZ((rng() - 0.5) * 1.4); t0.rotateY(rng() * 6.28);
    const t = t0.toNonIndexed(); geos.push(t); pushCol(t, [0.25, 0.17, 0.1]);
  }
  // flower trusses
  for (let i = 0; i < 9; i++) {
    const u = rng() * Math.PI * 2, v = Math.acos(0.3 + rng() * 0.7) * 0.9;
    const R = 0.33;
    const x = Math.sin(v) * Math.cos(u) * R * 1.2, y = Math.cos(v) * R * 0.78 + 0.05, z = Math.sin(v) * Math.sin(u) * R * 1.2;
    const fl = new THREE.IcosahedronGeometry(0.035 + rng() * 0.015, 0); fl.scale(1, 0.7, 1); fl.translate(x, y, z);
    const f2 = fl; geos.push(f2);
    pushCol(f2, rng() < 0.5 ? [0.95, 0.82, 0.78] : [0.98, 0.93, 0.8]);
  }
  const g = mergeGeometries(geos.map(x => { if (x.attributes.uv) x.deleteAttribute('uv'); return x.index ? x.toNonIndexed() : x; }));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colArr.slice(0, g.attributes.position.count * 3), 3));
  g.computeVertexNormals();
  return g;
}

function juniperGeo(rng, bark) {
  // krummholz: low twisted trunk leaning downwind, flagged foliage mats
  const trunkPts = [];
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < 6; i++) { trunkPts.push(new THREE.Vector3(x, y, z)); x += 0.22 + rng() * 0.1; y += 0.12 - i * 0.02 + rng() * 0.05; z += (rng() - 0.5) * 0.2; }
  const curve = new THREE.CatmullRomCurve3(trunkPts);
  const tg = new THREE.TubeGeometry(curve, 16, 0.07, 7);
  const pa = tg.attributes.position;
  // taper
  const nrmS = [];
  for (let i = 0; i < pa.count; i++) {
    const seg = Math.floor(i / 8) / 16;
    const p = curve.getPointAt(Math.min(1, seg));
    const vx = pa.getX(i) - p.x, vy = pa.getY(i) - p.y, vz = pa.getZ(i) - p.z;
    const k = 1 - seg * 0.7;
    pa.setXYZ(i, p.x + vx * k, p.y + vy * k, p.z + vz * k);
  }
  tg.computeVertexNormals();
  const geos = [tg.toNonIndexed()];
  const colArr = [];
  const pushCol = (g, c, j = 0) => { const n = g.attributes.position.count; for (let i = 0; i < n; i++) colArr.push(c[0] * (1 - j + j * rng()), c[1] * (1 - j + j * rng()), c[2] * (1 - j + j * rng())); };
  pushCol(geos[0], [0.36, 0.27, 0.2]);
  // branches + needle clumps (mostly leeward, +x)
  for (let i = 0; i < 70; i++) {
    const t = 0.15 + rng() * 0.85;
    const p = curve.getPointAt(t);
    const cl = new THREE.IcosahedronGeometry(0.07 + rng() * 0.09, 1);
    const cp = cl.attributes.position;
    for (let k = 0; k < cp.count; k++) { const s = 1 + (rng() - 0.5) * 0.9; cp.setXYZ(k, cp.getX(k) * s * 1.3, cp.getY(k) * s * 0.6, cp.getZ(k) * s); }
    cl.translate(p.x + 0.05 + rng() * 0.45, p.y + 0.02 + rng() * 0.2, p.z + (rng() - 0.5) * 0.55);
    const c2 = cl; geos.push(c2);
    pushCol(c2, rng() < 0.2 ? [0.28, 0.3, 0.16] : [0.16, 0.27, 0.16], 0.4);
  }
  const g = mergeGeometries(geos.map(x => { if (x.attributes.uv) x.deleteAttribute('uv'); return x; }));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
  g.computeVertexNormals();
  return g;
}

function needleTexture() {
  const S = 256; const c = document.createElement('canvas'); c.width = S; c.height = S; const g = c.getContext('2d');
  const rng = mulberry32(55);
  g.clearRect(0, 0, S, S);
  // dense juniper sprays: branching twigs covered in overlapping scale-needles
  const spray = (x, y, ang, len, depth) => {
    for (let t = 0; t < len; t += 2.5) {
      ang += (rng() - 0.5) * 0.1;
      x += Math.cos(ang) * 2.5; y += Math.sin(ang) * 2.5;
      const w = (1 - t / len) * 14 + 5;
      for (let n = 0; n < 4; n++) {
        const a2 = ang + (rng() < 0.5 ? 1 : -1) * (0.4 + rng() * 0.9);
        const l = w * (0.5 + rng() * 0.7);
        const sh = 70 + rng() * 80;
        g.strokeStyle = `rgba(${sh * 0.55 | 0},${sh + 20 | 0},${sh * 0.75 + 15 | 0},1)`;
        g.lineWidth = 2 + rng() * 2.5;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a2) * l, y + Math.sin(a2) * l); g.stroke();
      }
      if (depth < 2 && rng() < 0.06) spray(x, y, ang + (rng() < 0.5 ? 0.7 : -0.7), len * 0.45, depth + 1);
    }
  };
  for (let k = 0; k < 9; k++) spray(S * 0.5 + (rng() - 0.5) * 70, S * 0.97, -Math.PI / 2 + (rng() - 0.5) * 1.3, S * (0.5 + rng() * 0.4), 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

function juniperParts(rng) {
  const trunkPts = [];
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < 7; i++) { trunkPts.push(new THREE.Vector3(x, y, z)); x += 0.25 + rng() * 0.12; y += Math.max(0.02, 0.14 - i * 0.025) + rng() * 0.04; z += (rng() - 0.5) * 0.22; }
  const curve = new THREE.CatmullRomCurve3(trunkPts);
  const tg = new THREE.TubeGeometry(curve, 20, 0.075, 7);
  const pa = tg.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    const seg = Math.floor(i / 8) / 20; const p = curve.getPointAt(Math.min(1, seg));
    const k = 1 - seg * 0.75;
    pa.setXYZ(i, p.x + (pa.getX(i) - p.x) * k, p.y + (pa.getY(i) - p.y) * k, p.z + (pa.getZ(i) - p.z) * k);
  }
  tg.computeVertexNormals();
  // side branches
  const geos = [tg];
  for (let b = 0; b < 5; b++) {
    const t0 = 0.2 + rng() * 0.7; const p0 = curve.getPointAt(t0);
    const dir = new THREE.Vector3(0.4 + rng() * 0.6, 0.15 + rng() * 0.2, (rng() - 0.5) * 1.6).normalize();
    const bc = new THREE.CatmullRomCurve3([p0, p0.clone().addScaledVector(dir, 0.3), p0.clone().addScaledVector(dir, 0.6).add(new THREE.Vector3(0, 0.05, 0))]);
    geos.push(new THREE.TubeGeometry(bc, 6, 0.025, 5));
  }
  const trunk = mergeGeometries(geos);
  // foliage cards: prostrate sprays spreading downwind (+x)
  const cards = [];
  for (let i = 0; i < 110; i++) {
    const t = 0.1 + rng() * 0.9; const p = curve.getPointAt(t);
    const w = 0.4 + rng() * 0.35;
    const q = new THREE.PlaneGeometry(w, w * 1.1);
    const lat = (rng() - 0.5) * 0.8, fwd = rng() * 0.5;
    const dome = 1 - Math.min(1, Math.hypot(lat / 0.45, (fwd - 0.2) / 0.4));
    q.rotateX(-Math.PI / 2 + (rng() - 0.5) * 1.6);
    q.rotateY(rng() * Math.PI * 2);
    q.translate(p.x + fwd, p.y + 0.05 + dome * 0.28 + rng() * 0.12, p.z + lat);
    const n = q.attributes.normal; for (let k = 0; k < n.count; k++) n.setXYZ(k, 0, 1, 0);
    cards.push(q);
  }
  const foliage = mergeGeometries(cards);
  return { trunk, foliage };
}

export function buildVegetation(W, scene, colliders) {
  const rng = mulberry32(777);
  const hf = W.hf, tr = W.trail;
  const out = { chunks: [] };
  const occupied = (x, z, pad = 0) => {
    for (const b of W.boulders || []) { const dx = x - b.x, dz = z - b.z; if (dx * dx + dz * dz < (b.r * 0.9 + pad) ** 2) return true; }
    return false;
  };
  // boulder spatial lookup for speed
  const bgrid = new Map(); const bk = (x, z) => (Math.floor(x / 8) * 92821) ^ Math.floor(z / 8);
  for (const b of W.boulders || []) { const k = bk(b.x, b.z); let a = bgrid.get(k); if (!a) bgrid.set(k, a = []); a.push(b); }
  const nearBoulder = (x, z, pad = 0) => {
    for (let ix = -1; ix <= 1; ix++) for (let iz = -1; iz <= 1; iz++) {
      const a = bgrid.get(bk(x + ix * 8, z + iz * 8)); if (!a) continue;
      for (const b of a) { const dx = x - b.x, dz = z - b.z; if (dx * dx + dz * dz < (b.r * 0.95 + pad) ** 2) return true; }
    }
    return false;
  };
  const landmarkClear = (x, z) => {
    if (W.endlessK(x, z) > 0.02) return false;
    if (W.tarnEllipse(x, z) < 1.1) return false;
    if (Math.hypot(x - W.ovoo.x, z - W.ovoo.z) < 3.2) return false;
    if (Math.hypot(x - W.marker.x, z - W.marker.z) < 0.5) return false;
    if (Math.hypot(x - W.bridge.x, z - W.bridge.z) < 5) return false;
    if (W.stream.near(x, z, 1.6)) return false;
    if (Math.hypot(x - W.plain.x, z - W.plain.z) < W.plain.r + 8) return false;
    { const [lx, lz] = W.house.toL(x, z); if (Math.abs(lx) < 11 && lz > -16 && lz < 11) return false; }
    return true;
  };

  // ---------------- grass
  const clumpGeos = [0, 1, 2].map(i => grassClump(mulberry32(50 + i), 10 + i * 2));
  const grassMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, side: THREE.DoubleSide });
  patch(grassMat, {
    key: 'grass', vertexShadow: true,
    vHead: 'uniform float uFadeDist; varying float vH;',
    uniforms: { uFadeDist: { value: 75 } },
    vBegin: WIND_V(0.55, 2.2) + `
      vH = uv.y;
      {
        vec3 io2 = vec3(0.0);
        #ifdef USE_INSTANCING
          io2 = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        #endif
        float dd = length(io2 - cameraPosition);
        float fade = 1.0 - smoothstep(uFadeDist * 0.7, uFadeDist, dd);
        transformed *= fade;
      }`,
    fHead: 'varying float vH;',
    fNormal: 'normal = normalize(mix(normalize(vNormal), (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz, 0.55));',
    fColor: `{
      float h = vH;
      vec3 base = diffuseColor.rgb;
      vec3 root = base * 0.45;
      vec3 tip = mix(base, pow(vec3(0.82, 0.72, 0.42), vec3(2.2)), 0.45);
      diffuseColor.rgb = mix(root, tip, smoothstep(0.0, 1.0, h));
    }`,
    fLight: `{
      // translucency / backlight through blades
      vec3 V = normalize(cameraPosition - vWPos);
      float bl = pow(max(dot(-V, uSunDir), 0.0), 3.0);
      reflectedLight.directDiffuse += diffuseColor.rgb * uKeyColor * bl * 0.35 * vTSh * vH * uKeyVis;
      reflectedLight.indirectDiffuse *= 0.55 + 0.45 * vH;
    }`,
  });
  const dummy = new THREE.Object3D(); const col = new THREE.Color();
  const CH = 30;
  const chunkMap = new Map();
  const getChunk = (x, z) => { const cx = Math.floor(x / CH), cz = Math.floor(z / CH); const k = cx + ',' + cz; let c = chunkMap.get(k); if (!c) chunkMap.set(k, c = { cx, cz, items: [] }); return c; };
  // sample along the trail band
  const nrm = [0, 1, 0];
  for (let s = 0; s < tr.len && false; s += 1.0) {
    const a = tr.at(s);
    for (let k = 0; k < 260; k++) {
      const off = (rng() < 0.5 ? -1 : 1) * 70 * Math.pow(rng(), 1.9);
      const along = (rng() - 0.5) * 1.0;
      const x = a.x - a.tz * off + a.tx * along, z = a.z + a.tx * off + a.tz * along;
      const m = W.maskAt(x, z);
      const dens = m[0] * (1 - m[4]) * (Math.abs(off) < 25 ? 1 : 0.55);
      if (rng() > dens * 0.9) continue;
      if (m[4] > 0.15) continue;
      if (nearBoulder(x, z, 0.1) || !landmarkClear(x, z)) continue;
      getChunk(x, z).items.push([x, z, m[0], m[6]]);
    }
  }
  // extra dense grass around tarn outlet & saddles (lush)
  for (const [cxz, rad, n] of []) {
    for (let k = 0; k < n; k++) {
      const x = cxz[0] + (rng() * 2 - 1) * rad, z = cxz[1] + (rng() * 2 - 1) * rad;
      const m = W.maskAt(x, z); if (rng() > m[0] || m[4] > 0.15) continue;
      if (nearBoulder(x, z) || !landmarkClear(x, z)) continue;
      getChunk(x, z).items.push([x, z, m[0], m[6]]);
    }
  }
  for (const c of chunkMap.values()) {
    if (c.items.length < 4) continue;
    // shuffle so LOD can take a prefix
    for (let i = c.items.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [c.items[i], c.items[j]] = [c.items[j], c.items[i]]; }
    const geo = clumpGeos[(c.cx * 7 + c.cz * 3) & 1 ? 1 : ((c.cx + c.cz) % 3 + 3) % 3];
    const im = new THREE.InstancedMesh(geo, grassMat, c.items.length);
    c.items.forEach((it, i) => {
      const [x, z, g, moist] = it;
      hf.normal(x, z, 0.8, nrm);
      dummy.position.set(x, hf.height(x, z) - 0.03, z);
      dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(nrm[0] * 0.6, 1, nrm[2] * 0.6).normalize());
      dummy.rotateY(rng() * 6.28);
      const sc = (0.55 + rng() * 0.5) * (0.75 + g * 0.35);
      dummy.scale.set(sc, sc * (0.8 + rng() * 0.5), sc);
      dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix);
      const t = rng();
      // late-summer palette: olive, straw, sage, rusty tips
      if (t < 0.35) col.setRGB(0.26, 0.3, 0.09); else if (t < 0.65) col.setRGB(0.52, 0.42, 0.16); else if (t < 0.85) col.setRGB(0.33, 0.36, 0.19); else col.setRGB(0.5, 0.3, 0.13);
      if (moist > 0.3) col.setRGB(0.12, 0.22, 0.05);
      im.setColorAt(i, col);
    });
    im.receiveShadow = true; im.castShadow = false;
    im.computeBoundingSphere();
    im.userData.total = c.items.length;
    im.userData.center = new THREE.Vector3((c.cx + 0.5) * CH, hf.height((c.cx + 0.5) * CH, (c.cz + 0.5) * CH), (c.cz + 0.5) * CH);
    scene.add(im);
    out.chunks.push(im);
  }

  // ---------------- flowers
  const fgeos = [flowerGeo(0), flowerGeo(1)];
  const fmat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.7, side: THREE.DoubleSide });
  patch(fmat, { key: 'flower', vertexShadow: true, vBegin: WIND_V(0.4, 5.0), fNormal: 'normal = normalize(mix(normalize(vNormal), (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz, 0.4));' });
  fgeos.forEach((g, kind) => {
    const items = [];
    for (let k = 0; k < (kind === 0 ? 3200 : 4200); k++) {
      const s = rng() * tr.len, a = tr.at(s);
      const off = (rng() * 2 - 1) * 35;
      const x = a.x - a.tz * off, z = a.z + a.tx * off;
      const m = W.maskAt(x, z); if (m[0] < 0.35 || m[4] > 0.1 || rng() > m[0]) continue;
      if (nearBoulder(x, z) || !landmarkClear(x, z)) continue;
      items.push([x, z]);
      // small clusters
      for (let j = 0; j < 3; j++) items.push([x + (rng() - 0.5) * 0.5, z + (rng() - 0.5) * 0.5]);
    }
    const ms = chunked(scene, g, fmat, items.map(([x, z]) => ({ x, z })), 60, (it, d, c) => {
      d.position.set(it.x, hf.height(it.x, it.z) - 0.01, it.z); d.rotation.set((rng() - 0.5) * 0.3, rng() * 6.28, (rng() - 0.5) * 0.3);
      const sc = 0.8 + rng() * 0.6; d.scale.set(sc, sc, sc);
      if (kind === 0) c.setRGB(0.85, 0.86, 0.8);
      else { const t = rng(); if (t < 0.4) c.setRGB(0.18, 0.3, 0.9); else if (t < 0.7) c.setRGB(0.95, 0.75, 0.1); else c.setRGB(0.55, 0.25, 0.7); }
      return true;
    }, { cast: false, layer: 1 });
    const im = ms;
    out.flowers = (out.flowers || []).concat(im);
  });

  // ---------------- shrubs (dwarf rhododendron)
  const sgeos = [shrubGeo(mulberry32(8)), shrubGeo(mulberry32(9)), shrubGeo(mulberry32(10))];
  const smat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.55, side: THREE.DoubleSide });
  patch(smat, { key: 'shrub', shadowBias: 0.3, vBegin: WIND_V(0.12, 2.0), fNormal: 'normal = normalize(mix(normalize(vNormal), (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz, 0.3));' });
  const sItems = [[], [], []];
  for (let k = 0; k < 2500 && sItems.flat().length < 420; k++) {
    const s = rng() * tr.len, a = tr.at(s);
    const off = (rng() < 0.5 ? -1 : 1) * (2.5 + rng() * 55);
    const x = a.x - a.tz * off, z = a.z + a.tx * off;
    const m = W.maskAt(x, z);
    if (m[4] > 0.05 || m[2] > 0.1 || m[3] > 0.2) continue;
    if (rng() > m[0] * 0.8 + m[1] * 0.25) continue;
    if (nearBoulder(x, z, 0.5) || !landmarkClear(x, z)) continue;
    if (tr.near(x, z, 2.6)) continue;
    const sc = 0.55 + rng() * 0.8;
    sItems[k % 3].push([x, z, sc]);
    colliders.push({ x, z, r: 0.36 * sc });
  }
  sItems.forEach((items, v) => {
    chunked(scene, sgeos[v], smat, items.map(([x, z, sc]) => ({ x, z, sc })), 70, (it, d) => {
      d.position.set(it.x, hf.height(it.x, it.z) - 0.06, it.z); d.rotation.set(0, rng() * 6.28, 0);
      const sc = it.sc; d.scale.set(sc, sc * (0.7 + rng() * 0.4), sc);
      return false;
    }, { cast: true, layer: 1 });
  });

  const l1 = [];
  scene.traverse(o => { if (o.isInstancedMesh && o.layers.mask === 2 && !out.chunks.includes(o)) { o.userData.cullDist = o.material === fmat ? 80 : o.material === smat ? 230 : 150; l1.push(o); } });
  out.update = (camera) => {
    const cp = camera.position;
    for (const im of l1) {
      const bs = im.boundingSphere; if (!bs) continue;
      im.visible = bs.center.distanceTo(cp) - bs.radius < im.userData.cullDist;
    }
    for (const im of out.chunks) {
      const d = im.userData.center.distanceTo(cp);
      const lod = d < 35 ? 1 : d < 60 ? 0.55 : d < 90 ? 0.25 : 0;
      im.count = Math.floor(im.userData.total * lod);
      im.visible = im.count > 0;
    }
  };
  return out;
}
