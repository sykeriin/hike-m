import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { lerp, smoothstep } from './noise.js';

// ------------------------------------------------------------------------------------------------
// Skinned loft along +Y. Each ring: { y, x, z, rx, rzF, rzB, n, bones: [[boneIndex, weight], ...] }
// n = superellipse exponent (2 = ellipse, larger = boxier). Rings are listed bottom -> top.
export function loftSkinned(rings, seg = 24, opts = {}) {
  const pos = [], nrm = [], uv = [], si = [], sw = [], idx = [];
  const nr = rings.length;
  let vAcc = 0;
  for (let i = 0; i < nr; i++) {
    const R = rings[i];
    if (i > 0) { const P = rings[i - 1]; vAcc += Math.hypot(R.y - P.y, (R.rx - P.rx) * 0.5); }
    const n = R.n || 2;
    const bw = R.bones.slice().sort((a, b) => b[1] - a[1]).slice(0, 4);
    let wsum = 0; for (const b of bw) wsum += b[1];
    for (let j = 0; j <= seg; j++) {
      const a = j / seg * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const e = 2 / n;
      const cx = Math.sign(c) * Math.pow(Math.abs(c), e), sz = Math.sign(s) * Math.pow(Math.abs(s), e);
      let x = R.x + cx * R.rx;
      let z = R.z + sz * (s > 0 ? R.rzF : R.rzB);
      let y = R.y;
      if (R.shape) { const o = R.shape(a, x, y, z); x = o[0]; y = o[1]; z = o[2]; }
      pos.push(x, y, z); nrm.push(0, 1, 0); uv.push(j / seg, vAcc / (opts.vScale || 0.5));
      for (let k = 0; k < 4; k++) { si.push(bw[k] ? bw[k][0] : 0); sw.push(bw[k] ? bw[k][1] / wsum : 0); }
    }
  }
  const rowN = seg + 1;
  for (let i = 0; i < nr - 1; i++) for (let j = 0; j < seg; j++) {
    const a = i * rowN + j, b = a + 1, c = a + rowN, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  // end caps
  const cap = (ri, up) => {
    const R = rings[ri]; const base = pos.length / 3;
    let cx = 0, cz = 0; for (let j = 0; j < seg; j++) { cx += pos[(ri * rowN + j) * 3]; cz += pos[(ri * rowN + j) * 3 + 2]; }
    pos.push(cx / seg, R.y + (up ? 0.004 : -0.004), cz / seg); nrm.push(0, up ? 1 : -1, 0); uv.push(0.5, 0);
    const b0 = ri * rowN; for (let k = 0; k < 4; k++) { si.push(si[b0 * 4 + k]); sw.push(sw[b0 * 4 + k]); }
    for (let j = 0; j < seg; j++) { const a = ri * rowN + j; if (up) idx.push(a, base, a + 1); else idx.push(a, a + 1, base); }
  };
  if (opts.capBottom) cap(0, false);
  if (opts.capTop) cap(nr - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  // weld the seam normals
  const na = g.attributes.normal;
  for (let i = 0; i < nr; i++) {
    const a = i * rowN, b = a + seg;
    const nx = na.getX(a) + na.getX(b), ny = na.getY(a) + na.getY(b), nz = na.getZ(a) + na.getZ(b); const l = Math.hypot(nx, ny, nz) || 1;
    na.setXYZ(a, nx / l, ny / l, nz / l); na.setXYZ(b, nx / l, ny / l, nz / l);
  }
  return g;
}

// ------------------------------------------------------------------------------------------------
// Head in head-local space: chin ~ y 0.02, crown ~ y 0.224, face toward +Z.
// Young, androgynous proportions: rounder skull, soft jaw, full cheeks, small nose, big eyes.
const HC = new THREE.Vector3(0, 0.122, -0.004);
function shapeHead(v) {
  // v: unit sphere direction
  let x = v.x * 0.076, y = v.y * 0.102, z = v.z * 0.095;
  const lower = smoothstep(0.05, -0.85, v.y);          // jaw region
  const front = smoothstep(-0.1, 0.8, v.z);
  // gently narrowing jaw, small rounded chin
  x *= lerp(1, 0.74, lower * (0.55 + 0.45 * front));
  z *= lerp(1, 0.9, lower * (1 - front));
  if (v.y < -0.55) z += 0.006 * front * smoothstep(-0.55, -0.9, v.y);
  // fuller back of the skull
  if (v.z < 0) { z *= 1 + 0.08 * smoothstep(-0.2, 0.5, v.y); x *= 1 + 0.03 * smoothstep(0.0, 0.6, v.y); }
  // flatter face, soft cheeks, faint brow, eye sockets
  if (v.z > 0) z *= lerp(1, 0.94, smoothstep(0.5, 0.95, v.z) * smoothstep(-0.6, 0.2, v.y));
  const cheek = Math.exp(-(((Math.abs(v.x) - 0.5) / 0.22) ** 2 + ((v.y + 0.12) / 0.24) ** 2)) * smoothstep(0.2, 0.7, v.z);
  x *= 1 + 0.06 * cheek; z *= 1 + 0.05 * cheek;
  const brow = Math.exp(-(((v.y - 0.24) / 0.1) ** 2)) * smoothstep(0.55, 0.9, v.z) * (1 - smoothstep(0.55, 0.75, Math.abs(v.x)));
  z *= 1 + 0.015 * brow;
  const eye = Math.exp(-(((Math.abs(v.x) - 0.36) / 0.14) ** 2 + ((v.y - 0.03) / 0.11) ** 2)) * smoothstep(0.5, 0.85, v.z);
  z *= 1 - 0.045 * eye;
  // sculpted nose: a narrow bridge between the eyes growing into a small rounded tip with soft wings
  if (v.z > 0.5) {
    const ny = v.y;
    const bridge = smoothstep(0.1, -0.06, ny);
    const tipK = Math.exp(-(((ny + 0.29) / 0.085) ** 2));
    const under = smoothstep(-0.5, -0.33, ny);
    const prot = (0.005 * bridge + 0.0092 * tipK) * under;
    const wid = 0.05 + 0.07 * smoothstep(-0.05, -0.3, ny);
    const across = Math.exp(-((v.x / wid) ** 2));
    const wings = Math.exp(-(((Math.abs(v.x) - 0.11) / 0.045) ** 2 + ((ny + 0.32) / 0.05) ** 2)) * 0.0035;
    z += (prot * across + wings) * smoothstep(0.5, 0.8, v.z);
  }
  // temples in
  x *= 1 - 0.04 * Math.exp(-(((v.y - 0.3) / 0.2) ** 2)) * smoothstep(0.0, 0.5, v.z);
  return new THREE.Vector3(HC.x + x, HC.y + y, HC.z + z);
}

export function headGeometry() {
  const g = new THREE.SphereGeometry(1, 112, 84);
  const pa = g.attributes.position; const v = new THREE.Vector3();
  for (let i = 0; i < pa.count; i++) { v.fromBufferAttribute(pa, i).normalize(); const p = shapeHead(v); pa.setXYZ(i, p.x, p.y, p.z); }
  g.computeVertexNormals();
  return g;
}

// A point on the head surface along a direction (for placing features).
export function headPoint(dx, dy, dz, out = 0) {
  const v = new THREE.Vector3(dx, dy, dz).normalize();
  const p = shapeHead(v);
  if (out) p.add(v.multiplyScalar(out));
  return p;
}

const stripUV = (q) => { q = q.index ? q.toNonIndexed() : q; if (q.attributes.uv) q.deleteAttribute('uv'); return q; };

export function noseGeometry() {
  const parts = [];
  // short soft bridge and a small, slightly upturned tip
  const top = headPoint(0, 0.1, 1, -0.006);
  const tip = new THREE.Vector3(0, 0.086, 0.093);
  const mid = top.clone().lerp(tip, 0.5);
  const d = new THREE.Vector3().subVectors(tip, top); const L = d.length();
  const br = new THREE.SphereGeometry(1, 16, 12); br.scale(0.0048, L * 0.55, 0.006);
  br.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), d.clone().normalize()));
  br.translate(mid.x, mid.y, mid.z - 0.0028); parts.push(br);
  const tipS = new THREE.SphereGeometry(0.0064, 14, 10); tipS.scale(1.05, 0.88, 0.92); tipS.translate(tip.x, tip.y + 0.0015, tip.z - 0.0042); parts.push(tipS);
  for (const sx of [-1, 1]) { const w = new THREE.SphereGeometry(0.0048, 12, 8); w.scale(0.9, 0.72, 1.0); w.translate(sx * 0.0074, 0.0835, 0.0825); parts.push(w); }
  return mergeGeometries(parts.map(stripUV));
}

// Shaggy chin-length cut with bangs: a shell over the skull that falls straight past the ears.
export function hairGeometry() {
  const NU = 96, NV = 34;
  const pos = [], uv = [], idx = [];
  const TE = 1.42; // polar angle where the hair leaves the skull and starts to hang
  for (let j = 0; j <= NV; j++) {
    const v = j / NV;
    for (let i = 0; i <= NU; i++) {
      const phi = i / NU * Math.PI * 2;                  // 0 = back (-Z), PI = front (+Z)
      const front = 0.5 - 0.5 * Math.cos(phi);
      const faceW = smoothstep(0.6, 0.86, front);
      const jag = 0.07 * Math.sin(phi * 9.0 + 0.4) + 0.05 * Math.sin(phi * 23.0 + 1.3) + 0.03 * Math.sin(phi * 41.0);
      // bangs stop just above the brows, face-framing pieces at the cheeks, chin length at the sides and back
      const end = lerp(2.32 + jag, 1.25 + jag * 0.35, faceW) - 0.12 * smoothstep(0.45, 0.62, front) * (1 - faceW);
      const th = v * end;
      const dirAt = (t) => new THREE.Vector3(Math.sin(t) * Math.sin(phi), Math.cos(t), -Math.sin(t) * Math.cos(phi));
      const thick = 0.009 + 0.005 * smoothstep(0.3, 1.2, th) * (1 - faceW * 0.6);
      let p;
      if (th <= TE) {
        const d = dirAt(th);
        p = shapeHead(d).add(d.multiplyScalar(thick));
      } else {
        const d = dirAt(TE);
        const e = shapeHead(d).add(d.clone().multiplyScalar(thick));
        const k = (th - TE) / Math.max(0.01, end - TE);
        const drop = (th - TE) * 0.105;
        // falls nearly straight, the ends flick out a little
        const out = 1 + 0.06 * k * k - 0.05 * Math.sin(k * Math.PI);
        p = new THREE.Vector3(HC.x + (e.x - HC.x) * out, e.y - drop, HC.z + (e.z - HC.z) * out);
      }
      pos.push(p.x, p.y, p.z); uv.push(i / NU * 10, v);
    }
  }
  const row = NU + 1;
  for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) { const a = j * row + i, b = a + 1, c = a + row, d = c + 1; idx.push(a, b, c, b, d, c); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// Knit beanie with a folded cuff, slouching a little at the back.
export function beanieGeometry() {
  const axis = new THREE.Vector3(0, 1, -0.17).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  const TH = 1.28;
  const place = (v, off) => {
    const d = v.clone().normalize().applyQuaternion(q);
    const slouch = smoothstep(0.1, 0.9, d.y) * smoothstep(0.35, -0.8, d.z) * 0.018;
    return shapeHead(d).add(d.multiplyScalar(0.021 + off + slouch)).add(new THREE.Vector3(0, slouch * 0.4, -slouch * 0.3));
  };
  const cap = new THREE.SphereGeometry(1, 48, 20, 0, Math.PI * 2, 0, TH);
  const pa = cap.attributes.position; const v = new THREE.Vector3();
  for (let i = 0; i < pa.count; i++) { v.fromBufferAttribute(pa, i); const p = place(v, 0); pa.setXYZ(i, p.x, p.y, p.z); }
  cap.computeVertexNormals();
  const NU = 64, rows = [[TH + 0.03, 0.004], [TH - 0.02, 0.009], [TH - 0.2, 0.01], [TH - 0.36, 0.008], [TH - 0.4, 0.002]];
  const pos = [], uv = [], idx = [];
  rows.forEach(([t, off], j) => {
    for (let i = 0; i <= NU; i++) {
      const ph = i / NU * Math.PI * 2;
      const p = place(new THREE.Vector3(Math.sin(t) * Math.sin(ph), Math.cos(t), Math.sin(t) * Math.cos(ph)), off);
      pos.push(p.x, p.y, p.z); uv.push(i / NU * 8, j / (rows.length - 1));
    }
  });
  for (let j = 0; j < rows.length - 1; j++) for (let i = 0; i < NU; i++) { const a = j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1; idx.push(a, b, c, b, d, c); }
  const cuff = new THREE.BufferGeometry();
  cuff.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  cuff.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  cuff.setIndex(idx); cuff.computeVertexNormals();
  return { cap, cuff };
}

// Eyes: whites, irises, pupils, lids with a lash line, brows, lips.
export function eyeGeometries() {
  const whites = [], irises = [], pupils = [], lids = [], lashes = [], brows = [], lips = [];
  for (const sx of [-1, 1]) {
    const c = headPoint(sx * 0.36, 0.02, 0.93, -0.0072);
    const w = new THREE.SphereGeometry(0.0128, 16, 12); w.scale(1.05, 0.82, 0.9); w.translate(c.x, c.y, c.z); whites.push(w);
    const ir = new THREE.SphereGeometry(0.0074, 14, 10); ir.scale(1, 1, 0.42); ir.translate(c.x + sx * 0.0008, c.y + 0.0003, c.z + 0.0103); irises.push(ir);
    const pu = new THREE.SphereGeometry(0.0034, 10, 8); pu.scale(1, 1, 0.4); pu.translate(c.x + sx * 0.0008, c.y + 0.0003, c.z + 0.0122); pupils.push(pu);
    const lid = new THREE.SphereGeometry(0.0138, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.33); lid.scale(1.08, 0.86, 0.95); lid.rotateX(-0.2); lid.translate(c.x, c.y + 0.0012, c.z - 0.0008); lids.push(lid);
    const lash = new THREE.TorusGeometry(0.0128, 0.0011, 5, 18, Math.PI * 0.95); lash.rotateZ(0.08); lash.scale(1.08, 0.72, 1); lash.rotateX(-0.22); lash.translate(c.x, c.y + 0.0004, c.z + 0.0052); lashes.push(lash);
    const b = headPoint(sx * 0.37, 0.215, 0.92, 0.0006);
    const br = new THREE.TorusGeometry(0.034, 0.0017, 4, 14, 0.9); br.rotateZ(Math.PI / 2 - 0.45); br.scale(1, 0.55, 1); br.rotateY(sx * 0.32); br.translate(b.x, b.y - 0.0187, b.z); brows.push(br);
  }
  const lc = headPoint(0, -0.82, 1, -0.0008);
  const up = new THREE.SphereGeometry(0.0145, 14, 8); up.scale(1.15, 0.3, 0.42); up.translate(lc.x, lc.y + 0.0042, lc.z);
  const lo = new THREE.SphereGeometry(0.0138, 14, 8); lo.scale(1.02, 0.38, 0.48); lo.translate(lc.x, lc.y - 0.0042, lc.z - 0.0008);
  lips.push(up, lo);
  const m = (a) => mergeGeometries(a.map(stripUV));
  return { whites: m(whites), irises: m(irises), pupils: m(pupils), lids: m(lids), lashes: m(lashes), brows: m(brows), lips: m(lips) };
}

// Canvas textures for hair strands and ribbed knit.
export function hairTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256; const g = c.getContext('2d');
  g.fillStyle = 'rgb(128,128,128)'; g.fillRect(0, 0, 256, 256);
  let s = 7; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 900; i++) {
    const x = r() * 256, w = 0.6 + r() * 1.6, l = 0.4 + r() * 0.6; const b = 70 + r() * 120;
    g.strokeStyle = `rgba(${b | 0},${b | 0},${b | 0},0.55)`; g.lineWidth = w;
    g.beginPath(); g.moveTo(x, r() * 40); g.bezierCurveTo(x + (r() - 0.5) * 8, 90, x + (r() - 0.5) * 10, 170, x + (r() - 0.5) * 12, 40 + l * 216); g.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
export function knitTexture() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d');
  for (let x = 0; x < 64; x++) { const k = 0.72 + 0.28 * Math.pow(Math.abs(Math.sin((x + 0.5) / 64 * Math.PI * 4)), 0.6); const b = 255 * k | 0; g.fillStyle = `rgb(${b},${b},${b})`; g.fillRect(x, 0, 1, 64); }
  g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 1;
  for (let y = 0; y < 64; y += 4) for (let x = 0; x < 64; x += 16) { g.beginPath(); g.moveTo(x + 2, y); g.lineTo(x + 8, y + 3); g.lineTo(x + 14, y); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------------------------------------------
// Hands. Local frame (see Hiker.orientHand): origin at the wrist, -Y toward the knuckles,
// Z = grip axis across the palm (index finger at -side*Z), the staff passes through (0, -0.1, z).
function capsuleBetween(a, b, r0, r1) {
  const d = new THREE.Vector3().subVectors(b, a); const L = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, L, 8, 1, true); g.translate(0, L / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  g.applyQuaternion(q); g.translate(a.x, a.y, a.z);
  const s = new THREE.SphereGeometry(r1, 8, 6); s.translate(b.x, b.y, b.z);
  return [g.toNonIndexed(), s.toNonIndexed()];
}
export function handGeometry(side, grip) {
  const parts = [];
  // grip: the staff runs along local Z through (0, -0.1); the palm lies lateral (-X) of it
  const px = grip ? -0.03 : 0.0;
  const palm = new THREE.SphereGeometry(1, 14, 10); palm.scale(0.019, 0.048, 0.042); palm.translate(px + 0.003, -0.052, 0);
  parts.push(palm.toNonIndexed());
  const wrist = new THREE.CylinderGeometry(0.024, 0.026, 0.045, 10); wrist.scale(0.85, 1, 1.15); wrist.translate(px * 0.5, -0.012, 0); parts.push(wrist.toNonIndexed());
  const lens = [0.07, 0.078, 0.074, 0.06];
  for (let k = 0; k < 4; k++) {
    const z = (1.5 - k) * 0.0205;
    const r = 0.0092 - k * 0.0006;
    const L = lens[k] * 0.95;
    const seg = [L * 0.44, L * 0.32, L * 0.24];
    const kn = new THREE.Vector3(px + 0.002, -0.094 + (k === 0 || k === 3 ? 0.004 : 0), z);
    let p = kn.clone();
    if (grip) {
      // wrap around the staff: arc around C = (0, -0.1) from the knuckle side (-X) under and up the +X side
      const C = new THREE.Vector2(0, -0.1), rad = 0.029;
      let th = Math.atan2(p.y - C.y, p.x - C.x);
      const steps = [0.95, 0.85, 0.62];
      for (let j = 0; j < 3; j++) {
        th += steps[j];
        const q = new THREE.Vector3(C.x + Math.cos(th) * rad, C.y + Math.sin(th) * rad, z);
        parts.push(...capsuleBetween(p, q, r * (1 - j * 0.1), r * (0.92 - j * 0.1)));
        p = q;
      }
    } else {
      let ang = 0.08;
      const curls = [0.22, 0.36, 0.26];
      for (let j = 0; j < 3; j++) {
        ang += curls[j];
        const dir = new THREE.Vector3(Math.sin(ang), -Math.cos(ang), 0);
        const q = p.clone().addScaledVector(dir, seg[j]);
        parts.push(...capsuleBetween(p, q, r * (1 - j * 0.1), r * (0.92 - j * 0.1)));
        p = q;
      }
    }
    const ks = new THREE.SphereGeometry(r * 1.1, 8, 6); ks.translate(kn.x, kn.y, kn.z); parts.push(ks.toNonIndexed());
  }
  // thumb on the index side (+Z)
  {
    const p = new THREE.Vector3(px + 0.012, -0.03, 0.03);
    const q1 = grip ? new THREE.Vector3(0.006, -0.062, 0.03) : p.clone().add(new THREE.Vector3(0.016, -0.03, 0.012));
    const q2 = grip ? new THREE.Vector3(0.03, -0.086, 0.024) : q1.clone().add(new THREE.Vector3(0.014, -0.024, 0.004));
    parts.push(...capsuleBetween(p, q1, 0.0125, 0.0105));
    parts.push(...capsuleBetween(q1, q2, 0.0102, 0.0088));
  }
  const m = mergeGeometries(parts.map(q => { if (q.attributes.uv) q.deleteAttribute('uv'); return q; }));
  // the relaxed left hand is the mirror image, so its palm faces the thigh with the thumb forward
  if (!grip && side > 0) {
    m.scale(-1, 1, 1);
    for (const key of ['position', 'normal']) {
      const a = m.attributes[key].array;
      for (let t = 0; t < a.length; t += 9) for (let k = 0; k < 3; k++) { const tmp = a[t + 3 + k]; a[t + 3 + k] = a[t + 6 + k]; a[t + 6 + k] = tmp; }
    }
  }
  return m;
}
