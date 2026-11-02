import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patch, featherTexture, U } from './materials.js';
import { mulberry32, clamp, lerp, smoothstep } from './noise.js';

// loft along +Z through elliptical sections: [z, yCenter, rx, ry]; colorFn(t, angle) -> [r,g,b]
function loft(sections, M = 18, colorFn = null) {
  const pos = [], col = [], idx = [];
  const S = sections.length;
  for (let i = 0; i < S; i++) {
    const [z, yc, rx, ry] = sections[i];
    for (let j = 0; j <= M; j++) {
      const a = j / M * Math.PI * 2;
      const x = Math.cos(a) * rx, y = Math.sin(a) * ry + yc;
      pos.push(x, y, z);
      const c = colorFn ? colorFn(i / (S - 1), a) : [1, 1, 1];
      col.push(c[0], c[1], c[2]);
    }
  }
  for (let i = 0; i < S - 1; i++) for (let j = 0; j < M; j++) {
    const a = i * (M + 1) + j, b = a + 1, c = a + M + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  // caps
  const addCap = (i, flip) => {
    const [z, yc] = sections[i]; const ci = pos.length / 3; pos.push(0, yc, z);
    const c = colorFn ? colorFn(i / (S - 1), -Math.PI / 2) : [1, 1, 1]; col.push(c[0], c[1], c[2]);
    for (let j = 0; j < M; j++) { const a = i * (M + 1) + j; if (flip) idx.push(ci, a + 1, a); else idx.push(ci, a, a + 1); }
  };
  addCap(0, false); addCap(S - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// vertical loft for limbs: sections [y, rx, rz, zOffset], rings in the XZ plane (top -> bottom)
function vloft(sections, M = 10, colorFn = null) {
  const pos = [], col = [], idx = [];
  const S = sections.length;
  for (let i = 0; i < S; i++) {
    const [y, rx, rz, oz = 0] = sections[i];
    for (let j = 0; j <= M; j++) {
      const a = j / M * Math.PI * 2;
      pos.push(Math.cos(a) * rx, y, Math.sin(a) * rz + oz);
      const c = colorFn ? colorFn(i / (S - 1), a) : [1, 1, 1]; col.push(c[0], c[1], c[2]);
    }
  }
  for (let i = 0; i < S - 1; i++) for (let j = 0; j < M; j++) {
    const a = i * (M + 1) + j, b = a + 1, c = a + M + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
function taperTube(pts, r0, r1, seg = 24, rad = 8) {
  const curve = new THREE.CatmullRomCurve3(pts);
  const g = new THREE.TubeGeometry(curve, seg, 1, rad);
  const pa = g.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    const ring = Math.floor(i / (rad + 1)); const t = ring / seg;
    const p = curve.getPointAt(Math.min(1, t));
    const r = lerp(r0, r1, t);
    pa.setXYZ(i, p.x + (pa.getX(i) - p.x) * r, p.y + (pa.getY(i) - p.y) * r, p.z + (pa.getZ(i) - p.z) * r);
  }
  g.computeVertexNormals();
  return g;
}

function furMaterial(key, strength = 1, color = null) {
  const m = new THREE.MeshStandardMaterial({ color: color ?? 0xffffff, vertexColors: color === null, roughness: 0.95 });
  return patch(m, {
    key: 'fur' + key, shadowBias: 0.2, bump: 1.0,
    vHead: 'varying vec3 vLoc;', vBegin: 'vLoc = position;',
    fHead: 'varying vec3 vLoc;',
    fColor: `{
      float f1 = texture2D(uNoiseTex, vec2(vLoc.x * 9.0 + vLoc.y * 3.0, vLoc.z * 1.5)).r;
      float f2 = texture2D(uNoiseTex, vec2(vLoc.x * 23.0, vLoc.z * 5.0 + vLoc.y * 20.0)).g;
      diffuseColor.rgb *= 0.8 + 0.28 * f1 + 0.12 * f2;
      gBump = (f1 * 0.6 + f2 * 0.4) * ${strength.toFixed(2)};
    }`,
  });
}

// ------------------------------------------------------------------ quadruped
class Quad {
  constructor(spec, rng) {
    this.spec = spec; this.rng = rng;
    this.g = new THREE.Group();
    const s = spec.scale;
    const mat = spec.mat;
    const body = new THREE.Mesh(loft(spec.body, 20, spec.color), mat);
    body.castShadow = true; body.receiveShadow = true;
    this.bodyG = new THREE.Group(); this.g.add(this.bodyG); this.bodyG.add(body);
    this.neck = new THREE.Group(); this.neck.position.set(0, spec.neckBase[1], spec.neckBase[2]); this.bodyG.add(this.neck);
    const nk = new THREE.Mesh(loft(spec.neck, 14, spec.colorNeck || spec.color), mat); nk.castShadow = true; this.neck.add(nk);
    this.head = new THREE.Group(); this.head.position.set(0, spec.headBase[1], spec.headBase[2]); this.neck.add(this.head);
    const hd = new THREE.Mesh(loft(spec.head, 14, spec.colorHead || spec.color), mat); hd.castShadow = true; this.head.add(hd);
    // eyes, ears
    const eyeM = patch(new THREE.MeshStandardMaterial({ color: 0x0b0806, roughness: 0.2 }), { key: 'eye' });
    for (const sx of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(spec.eye, 8, 6), eyeM); e.position.set(sx * spec.eyePos[0], spec.eyePos[1], spec.eyePos[2]); this.head.add(e);
      const ear = new THREE.Mesh(new THREE.ConeGeometry(spec.ear[0], spec.ear[1], 6).rotateX(-0.3), mat);
      ear.position.set(sx * spec.earPos[0], spec.earPos[1], spec.earPos[2]); ear.rotation.z = -sx * 1.1; this.head.add(ear);
    }
    if (spec.horns) spec.horns(this.head);
    // legs: muscled upper limb blending into the body, slim cannon bone, fetlock and hoof
    this.legs = [];
    const [L0, L1] = spec.legL;
    for (const [lx, ly, lz, front] of spec.legs) {
      const hip = new THREE.Group(); hip.position.set(lx, ly, lz); this.bodyG.add(hip);
      const k = front ? 1.0 : 1.18;
      const upCol = spec.legColorUp || ((t, a) => spec.color(0.5, 1.2).map(v => v * (0.92 + 0.1 * t)));
      const up = new THREE.Mesh(vloft([[0.2 * k, spec.legR[0] * 1.35 * k, spec.legR[0] * 1.9 * k, front ? 0.02 : -0.03], [0.05, spec.legR[0] * 1.3 * k, spec.legR[0] * 1.8 * k, 0], [-L0 * 0.35, spec.legR[0] * 0.95 * k, spec.legR[0] * 1.25 * k, front ? 0 : 0.02], [-L0 * 0.75, spec.legR[1] * 1.15, spec.legR[1] * 1.3, 0], [-L0, spec.legR[1], spec.legR[1] * 1.15, 0]], 10, upCol), mat);
      up.castShadow = true; hip.add(up);
      const knee = new THREE.Group(); knee.position.set(0, -L0, 0); hip.add(knee);
      const loCol = spec.legColorLo || ((t, a) => (t > 0.25 ? [0.78, 0.75, 0.68] : [0.4, 0.3, 0.2]));
      const lo = new THREE.Mesh(vloft([[0.03, spec.legR[1] * 1.05, spec.legR[1] * 1.2, 0], [-0.04, spec.legR[2] * 1.1, spec.legR[2] * 1.3, 0], [-L1 * 0.55, spec.legR[2] * 0.95, spec.legR[2] * 1.05, 0], [-L1 + 0.035, spec.legR[2] * 1.15, spec.legR[2] * 1.3, 0.005], [-L1, spec.legR[2] * 1.05, spec.legR[2] * 1.2, 0.01]], 8, loCol), mat);
      lo.castShadow = true; knee.add(lo);
      const hoof = new THREE.Mesh(new THREE.CylinderGeometry(spec.legR[2] * 1.05, spec.legR[2] * 1.35, spec.hoof, 7).translate(0, -L1 - spec.hoof / 2, 0.012), spec.hoofMat);
      knee.add(hoof);
      this.legs.push({ hip, knee, front, phase: 0 });
    }
    if (spec.tail) { const t = new THREE.Mesh(spec.tail, mat); this.bodyG.add(t); }
    this.g.scale.setScalar(s);
    this.pos = new THREE.Vector3(); this.yaw = 0; this.speed = 0; this.phase = rng() * 10;
    this.headDown = 0; this.lookYaw = 0;
  }
  pose(dt, W, time) {
    const s = this.spec.scale;
    const sp = this.speed;
    const gallop = sp > 3.2;
    const freq = gallop ? 2.6 : 0.55 + sp * 0.9;
    this.phase += dt * freq * (sp > 0.05 ? 1 : 0);
    const ph = this.phase * Math.PI * 2;
    const offs = gallop ? [0, 0.1, 0.5, 0.6] : [0, 0.5, 0.25, 0.75];
    const amp = gallop ? 0.75 : Math.min(0.45, 0.15 + sp * 0.25);
    this.legs.forEach((L, i) => {
      const p = ph + offs[i] * Math.PI * 2;
      const sw = sp > 0.05 ? Math.sin(p) * amp : 0;
      L.hip.rotation.x = sw * (L.front ? 0.8 : 1.0);
      const lift = sp > 0.05 ? Math.max(0, Math.cos(p)) : 0;
      L.knee.rotation.x = L.front ? -lift * 0.9 * amp * 2 : lift * 0.9 * amp * 2;
    });
    // ground follow with body pitch
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const L2 = this.spec.len * 0.5 * s;
    const hf = W.ground(this.pos.x + fx * L2, this.pos.z + fz * L2), hb = W.ground(this.pos.x - fx * L2, this.pos.z - fz * L2);
    const y = Math.min(hf, hb) + (Math.abs(hf - hb) * 0.5);
    const bob = sp > 0.05 ? Math.abs(Math.sin(ph)) * (gallop ? 0.08 : 0.02) * s : 0;
    this.g.position.set(this.pos.x, y + bob - 0.02 * s, this.pos.z);
    this.g.rotation.set(0, this.yaw, 0);
    this.bodyG.rotation.x = -Math.atan2(hf - hb, L2 * 2) + (gallop ? Math.sin(ph) * 0.06 : 0);
    // neck / head: grazing vs alert
    this.neck.rotation.x = lerp(-0.35, 0.95, this.headDown);
    this.neck.rotation.y = this.lookYaw;
    this.head.rotation.x = lerp(0.2, 0.25, this.headDown) + (this.headDown > 0.5 ? Math.sin(time * 5 + this.phase) * 0.05 : 0);
  }
}

function argaliSpec(mat, legMat, hoofMat, hornMat, male) {
  const tan = [0.42, 0.31, 0.2], white = [0.84, 0.81, 0.74], dark = [0.2, 0.14, 0.09];
  const color = (t, a) => {
    const down = Math.sin(a) < -0.35; const rump = t < 0.12;
    if (down || rump) return white;
    if (Math.sin(a) < -0.05 && t > 0.2 && t < 0.8) return dark;
    return tan.map(v => v * (0.9 + 0.2 * Math.sin(t * 9)));
  };
  return {
    scale: 1, len: 1.35, mat, legMat, hoofMat,
    body: [[-0.8, 0.88, 0.015, 0.015], [-0.785, 0.875, 0.09, 0.1], [-0.75, 0.87, 0.16, 0.18], [-0.68, 0.86, 0.22, 0.25], [-0.55, 0.85, 0.26, 0.28], [-0.35, 0.84, 0.26, 0.28], [-0.1, 0.82, 0.27, 0.29], [0.12, 0.83, 0.29, 0.32], [0.32, 0.87, 0.28, 0.34], [0.48, 0.93, 0.23, 0.31], [0.6, 1.0, 0.17, 0.23], [0.68, 1.06, 0.1, 0.13]],
    color,
    neckBase: [0, 0.98, 0.55],
    neck: [[0, 0, 0.16, 0.19], [0.12, 0.12, 0.13, 0.16], [0.24, 0.26, 0.1, 0.12], [0.3, 0.33, 0.08, 0.1]],
    colorNeck: (t, a) => (Math.sin(a) < -0.3 ? white : tan),
    headBase: [0, 0.34, 0.3],
    head: [[-0.1, 0.01, 0.06, 0.07], [-0.02, 0.01, 0.085, 0.095], [0.08, -0.01, 0.08, 0.085], [0.18, -0.04, 0.06, 0.065], [0.26, -0.06, 0.045, 0.05], [0.3, -0.07, 0.03, 0.035]],
    colorHead: (t, a) => (t > 0.78 || (t > 0.55 && Math.sin(a) < -0.2) ? white : tan.map(v => v * 1.05)),
    eye: 0.013, eyePos: [0.062, 0.02, 0.06], ear: [0.025, 0.08], earPos: [0.06, 0.05, -0.04],
    legs: [[-0.14, 0.74, 0.42, true], [0.14, 0.74, 0.42, true], [-0.15, 0.75, -0.52, false], [0.15, 0.75, -0.52, false]],
    legR: [0.075, 0.042, 0.03], legL: [0.36, 0.35], hoof: 0.05,
    horns: (head) => {
      for (const sx of [-1, 1]) {
        const pts = [];
        const turns = male ? 1.05 : 0.45; const R = male ? 0.14 : 0.07;
        for (let i = 0; i <= 14; i++) {
          const t = i / 14; const a = t * turns * Math.PI * 2;
          pts.push(new THREE.Vector3(sx * (0.05 + t * (male ? 0.16 : 0.08)), 0.08 + Math.sin(a) * R * (0.6 + t), -0.02 - (1 - Math.cos(a)) * R * 0.1 + Math.cos(a) * 0.0 - Math.sin(a) * 0.0 + (Math.cos(a) - 1) * -R * 0.0 - t * 0.02 + Math.sin(a) * 0.0 + (1 - Math.cos(a)) * 0 - R * Math.sin(a * 0.5) * 0.0));
        }
        // proper curl: rotate the circle in the side plane (y-z)
        for (let i = 0; i <= 14; i++) {
          const t = i / 14; const a = t * turns * Math.PI * 2;
          pts[i].set(sx * (0.045 + t * (male ? 0.17 : 0.08)), 0.07 + Math.sin(a) * R * (0.7 + t * 0.6), -0.03 - (1 - Math.cos(a)) * R * (0.7 + t * 0.6) + t * 0.05);
        }
        const hg = taperTube(pts, male ? 0.045 : 0.022, 0.008, 28, 8);
        // ridges on horn
        const pa = hg.attributes.position;
        for (let i = 0; i < pa.count; i++) { const ring = Math.floor(i / 9); const k = 1 + Math.sin(ring * 2.2) * 0.05; const c = pts[Math.min(14, Math.round(ring / 28 * 14))]; pa.setXYZ(i, c.x + (pa.getX(i) - c.x) * k, c.y + (pa.getY(i) - c.y) * k, c.z + (pa.getZ(i) - c.z) * k); }
        hg.computeVertexNormals();
        const h = new THREE.Mesh(hg, hornMat); h.castShadow = true; head.add(h);
      }
    },
    tail: new THREE.ConeGeometry(0.035, 0.1, 6).rotateX(-2.5).translate(0, 0.9, -0.79),
  };
}
function gazelleSpec(mat, legMat, hoofMat, hornMat, male) {
  const tan = [0.62, 0.45, 0.25], white = [0.85, 0.82, 0.75];
  const color = (t, a) => (Math.sin(a) < -0.3 || t < 0.1 ? white : tan);
  return {
    scale: 1, len: 1.0, mat, legMat, hoofMat,
    body: [[-0.5, 0.66, 0.08, 0.1], [-0.44, 0.66, 0.15, 0.17], [-0.2, 0.68, 0.18, 0.2], [0.15, 0.7, 0.17, 0.21], [0.38, 0.72, 0.13, 0.17], [0.48, 0.75, 0.08, 0.11]],
    color, neckBase: [0, 0.8, 0.4],
    neck: [[0, 0, 0.08, 0.1], [0.08, 0.14, 0.06, 0.075], [0.14, 0.28, 0.05, 0.06]],
    colorNeck: (t, a) => (Math.sin(a) < -0.3 ? white : tan),
    headBase: [0, 0.3, 0.16],
    head: [[-0.05, 0, 0.045, 0.05], [0.05, 0, 0.05, 0.055], [0.14, -0.03, 0.035, 0.035], [0.19, -0.04, 0.02, 0.022]],
    colorHead: (t, a) => (t > 0.7 ? white : tan),
    eye: 0.01, eyePos: [0.04, 0.015, 0.04], ear: [0.02, 0.07], earPos: [0.04, 0.04, -0.02],
    legs: [[-0.1, 0.61, 0.33, true], [0.1, 0.61, 0.33, true], [-0.1, 0.62, -0.36, false], [0.1, 0.62, -0.36, false]],
    legR: [0.045, 0.024, 0.017], legL: [0.3, 0.31], hoof: 0.03,
    legColorLo: (t, a) => [0.72, 0.6, 0.42],
    horns: male ? (head) => { for (const sx of [-1, 1]) { const pts = [new THREE.Vector3(sx * 0.02, 0.04, -0.01), new THREE.Vector3(sx * 0.035, 0.12, -0.05), new THREE.Vector3(sx * 0.03, 0.2, -0.04), new THREE.Vector3(sx * 0.045, 0.24, 0.0)]; const h = new THREE.Mesh(taperTube(pts, 0.014, 0.004, 12, 6), hornMat); head.add(h); } } : null,
    tail: new THREE.ConeGeometry(0.025, 0.08, 5).rotateX(-2.6).translate(0, 0.7, -0.52),
  };
}

// ------------------------------------------------------------------ eagle
class Eagle {
  constructor(mat, darkMat, beakMat) {
    this.g = new THREE.Group();
    const body = new THREE.Mesh(loft([[-0.35, 0, 0.04, 0.04], [-0.25, 0, 0.09, 0.09], [0, 0, 0.12, 0.12], [0.2, 0.01, 0.1, 0.1], [0.3, 0.03, 0.07, 0.07]], 12,
      (t, a) => [0.3, 0.2, 0.12]), mat);
    this.g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10).scale(1, 1, 1.2), patch(new THREE.MeshStandardMaterial({ color: 0x9a7040, roughness: 0.9 }), { key: 'eaglehead' }));
    head.position.set(0, 0.05, 0.38); this.g.add(head);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.08, 8).rotateX(Math.PI / 2 + 0.5), beakMat); beak.position.set(0, 0.03, 0.46); this.g.add(beak);
    this.wings = [];
    for (const sx of [-1, 1]) {
      const sh = new THREE.Group(); sh.position.set(sx * 0.08, 0.03, 0.05); this.g.add(sh);
      // inner wing (arm)
      const inner = new THREE.Shape();
      inner.moveTo(0, 0.12); inner.lineTo(0.5, 0.14); inner.lineTo(0.52, -0.22); inner.lineTo(0.3, -0.26); inner.lineTo(0.0, -0.2); inner.lineTo(0, 0.12);
      const ig = new THREE.ShapeGeometry(inner); ig.rotateX(-Math.PI / 2); if (sx < 0) ig.scale(-1, 1, 1);
      const iw = new THREE.Mesh(ig, darkMat); iw.castShadow = true; sh.add(iw);
      const wrist = new THREE.Group(); wrist.position.set(sx * 0.5, 0, 0); sh.add(wrist);
      const outer = new THREE.Shape();
      outer.moveTo(0, 0.14); outer.lineTo(0.3, 0.08); outer.lineTo(0.32, -0.12); outer.lineTo(0.0, -0.22); outer.lineTo(0, 0.14);
      const og = new THREE.ShapeGeometry(outer); og.rotateX(-Math.PI / 2); if (sx < 0) og.scale(-1, 1, 1);
      const ow = new THREE.Mesh(og, darkMat); ow.castShadow = true; wrist.add(ow);
      // primary "fingers"
      for (let k = 0; k < 6; k++) {
        const f = new THREE.Shape(); const L = 0.2 + (k === 2 || k === 3 ? 0.06 : 0);
        f.moveTo(0, 0.025); f.quadraticCurveTo(L * 0.6, 0.03, L, 0); f.quadraticCurveTo(L * 0.6, -0.03, 0, -0.025);
        const fg = new THREE.ShapeGeometry(f, 3); fg.rotateX(-Math.PI / 2); fg.rotateY(-(k - 2.5) * 0.14); if (sx < 0) fg.scale(-1, 1, 1);
        const fm = new THREE.Mesh(fg, darkMat); fm.position.set(sx * 0.3, 0.004 * k, 0.1 - k * 0.045); fm.castShadow = true; wrist.add(fm);
      }
      this.wings.push({ sh, wrist, sx });
    }
    const tail = new THREE.Shape(); tail.moveTo(-0.05, 0); tail.lineTo(-0.13, -0.3); tail.quadraticCurveTo(0, -0.34, 0.13, -0.3); tail.lineTo(0.05, 0);
    const tg = new THREE.ShapeGeometry(tail, 4); tg.rotateX(-Math.PI / 2);
    this.tail = new THREE.Mesh(tg, darkMat); this.tail.position.set(0, 0, -0.3); this.g.add(this.tail);
    // talons tucked
    for (const sx of [-1, 1]) { const t = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 5), beakMat); t.position.set(sx * 0.04, -0.07, -0.12); this.g.add(t); }
    this.g.traverse(o => { if (o.isMesh) o.castShadow = true; });
    this.state = 'circle'; this.t = 0; this.angle = 0; this.flap = 0; this.diveT = 0;
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3();
  }
}

export function buildWildlife(W, scene, audio) {
  const rng = mulberry32(606);
  const out = { animals: [] };
  const fur = furMaterial('a', 1.0);
  const furG = furMaterial('g', 0.6);
  const legMat = furMaterial('l', 0.6, 0x6e5238);
  const legMatG = furMaterial('lg', 0.5, 0x9a7a50);
  const hoofMat = patch(new THREE.MeshStandardMaterial({ color: 0x1e1812, roughness: 0.5 }), { key: 'hoof' });
  const hornMat = patch(new THREE.MeshStandardMaterial({ color: 0x9a8a70, roughness: 0.6 }), { key: 'horn', fColor: `{ float r = texture2D(uNoiseTex, vec2(vWPos.x * 20.0 + vWPos.y * 30.0, vWPos.z * 20.0)).r; diffuseColor.rgb *= 0.75 + 0.35 * r; }` });

  // ---------------- argali herd: grazes on slopes beside the trail and leapfrogs ahead when disturbed
  const spotDefs = [[42, 22], [118, -24], [200, 30], [296, 26], [372, -26], [468, 24], [556, -24], [632, 22]];
  const spots = [];
  for (const [ds, o] of spotDefs) {
    let best = null;
    for (let k = 0; k < 14 && !best; k++) {
      const [x, z] = W.frame(ds + (k % 3) * 6, o * (1 + k * 0.08));
      const m = W.maskAt(x, z);
      if (W.tarnEllipse(x, z) < 1.6 || W.stream.near(x, z, 6) || m[2] > 0.1 || m[7] > 0.55) continue;
      best = new THREE.Vector3(x, 0, z);
    }
    if (best) { const q = W.trail.nearest(best.x, best.z); spots.push({ p: best, s: q.s }); }
  }
  const herd = { center: spots[0].p.clone(), target: spots[0].p.clone(), alert: 0, bolt: 0, spot: 0 };
  out.herd = herd;
  for (let i = 0; i < 8; i++) {
    const male = i < 2;
    const q = new Quad(argaliSpec(fur, legMat, hoofMat, hornMat, male), rng);
    const sc = male ? 1.08 : 0.84 + rng() * 0.12;
    q.spec.scale = sc; q.g.scale.setScalar(sc);
    q.offset = new THREE.Vector2((rng() - 0.5) * 16, (rng() - 0.5) * 16);
    q.pos.set(herd.center.x + q.offset.x, 0, herd.center.z + q.offset.y);
    q.yaw = rng() * 6.28; q.kind = 'argali';
    q.grazeT = rng() * 5; q.headDown = 1;
    scene.add(q.g); out.animals.push(q);
  }
  // ---------------- small herd of Mongolian gazelle crossing the valley floor
  for (let i = 0; i < 5; i++) {
    const q = new Quad(gazelleSpec(furG, legMatG, hoofMat, hornMat, i < 2), rng);
    q.kind = 'gazelle'; q.ds = 120 + i * 5 + rng() * 3; q.o = 300 + (rng() - 0.5) * 12; q.dir = 1; q.headDown = 0;
    q.g.scale.setScalar(1.15); q.spec.scale = 1.15;
    scene.add(q.g); out.animals.push(q);
  }
  // ---------------- marmots at burrows along grassy stretches of the trail
  const marmots = [];
  const marmotMat = furMaterial('m', 1.2);
  const moundMat = patch(new THREE.MeshStandardMaterial({ color: 0x7a634a, roughness: 1 }), { key: 'mound', fColor: `{ vec2 pb = pebbles(vWPos.xz * 12.0); diffuseColor.rgb *= 0.75 + 0.35 * pb.y; gBump = smoothstep(0.0, 0.2, pb.x) * 0.5; }`, bump: 1.0 });
  const holeMat = patch(new THREE.MeshStandardMaterial({ color: 0x2a2118, roughness: 1 }), { key: 'hole' });
  const mcol = (t, a) => (Math.sin(a) < -0.4 ? [0.62, 0.48, 0.32] : [0.56, 0.4, 0.22].map(v => v * (0.85 + 0.25 * Math.sin(a * 3 + t * 6))));
  const eyeM = patch(new THREE.MeshStandardMaterial({ color: 0x050403, roughness: 0.2 }), { key: 'meye' });
  const burrowDs = [14, 30, 52, 70, 96, 115, 290, 350, 400, 530, 552, 575, 598, 622];
  for (const ds of burrowDs) {
    const side = rng() < 0.5 ? -1 : 1;
    const [x, z] = W.frame(ds, side * (5.5 + rng() * 7));
    if (W.trail.near(x, z, 3.2)) continue;
    const mk = W.maskAt(x, z); if (mk[0] < 0.2 || W.stream.near(x, z, 3)) continue;
    if (Math.hypot(x - W.ovoo.x, z - W.ovoo.z) < 8 || Math.hypot(x - W.marker.x, z - W.marker.z) < 3) continue;
    const g = W.hf.height(x, z);
    const mound = new THREE.Mesh(new THREE.SphereGeometry(0.9, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.1, 0.22, 1.0), moundMat);
    mound.position.set(x, g - 0.05, z); mound.receiveShadow = true; scene.add(mound);
    const hole = new THREE.Mesh(new THREE.CircleGeometry(0.11, 14).rotateX(-Math.PI / 2 + 0.35), holeMat);
    hole.position.set(x, g + 0.15, z + 0.12); scene.add(hole);
    const m = new THREE.Group();
    const body = new THREE.Mesh(loft([[-0.25, 0.12, 0.05, 0.06], [-0.18, 0.13, 0.11, 0.11], [0.0, 0.14, 0.13, 0.12], [0.15, 0.15, 0.1, 0.1], [0.24, 0.17, 0.07, 0.07], [0.3, 0.17, 0.04, 0.045]], 14, mcol), marmotMat);
    body.castShadow = true;
    const bg = new THREE.Group(); bg.add(body); m.add(bg);
    for (const sx of [-1, 1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 5), eyeM); e.position.set(sx * 0.045, 0.2, 0.25); bg.add(e); const ear = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 5), marmotMat); ear.position.set(sx * 0.05, 0.23, 0.2); bg.add(ear); }
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.014, 6, 5), eyeM); nose.position.set(0, 0.175, 0.31); bg.add(nose);
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.012, 0.12, 5).rotateX(1.2), marmotMat); tail.position.set(0, 0.1, -0.29); bg.add(tail);
    for (const [lx, lz] of [[-0.07, 0.15], [0.07, 0.15], [-0.08, -0.14], [0.08, -0.14]]) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.018, 0.08, 5), marmotMat); l.position.set(lx, 0.04, lz); bg.add(l); }
    m.scale.setScalar(1.25);
    m.position.set(x, g, z); scene.add(m);
    marmots.push({ g: m, body: bg, x, z, gy: g + 0.12, state: 'rise', t: rng() * 2, up: 0, stand: 0, yaw: rng() * 6.28, wander: new THREE.Vector2(), called: false });
  }
  out.marmots = marmots;

  // ---------------- golden eagle: circles on thermals ahead of the hiker, in the upper part of the frame
  const ft = featherTexture(); ft.repeat.set(2, 2);
  const eMat = patch(new THREE.MeshStandardMaterial({ color: 0xffffff, map: ft, roughness: 0.85, side: THREE.DoubleSide }), { key: 'eagle', shadowBias: 0.1 });
  const eDark = patch(new THREE.MeshStandardMaterial({ color: 0x8a6a4a, map: ft, roughness: 0.85, side: THREE.DoubleSide }), { key: 'eagled', shadowBias: 0.1 });
  const beak = patch(new THREE.MeshStandardMaterial({ color: 0xd8a32c, roughness: 0.5 }), { key: 'beak' });
  const eagle = new Eagle(eMat, eDark, beak);
  eagle.g.scale.setScalar(1.35);
  const s0 = W.trail.at(60);
  eagle.center = new THREE.Vector3(s0.x, W.hf.height(s0.x, s0.z) + 40, s0.z);
  eagle.pos.copy(eagle.center).add(new THREE.Vector3(45, 0, 0));
  scene.add(eagle.g);
  out.eagle = eagle;

  // ---------------- alpine choughs: a loose flock wheeling along the ridge
  const chMat = patch(new THREE.MeshStandardMaterial({ color: 0x121214, roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide }), { key: 'chough', shadowBias: 0.1 });
  const chBeak = patch(new THREE.MeshStandardMaterial({ color: 0xd23a1f, roughness: 0.5 }), { key: 'chbeak' });
  const choughs = [];
  for (let i = 0; i < 11; i++) {
    const b = new THREE.Group();
    b.add(new THREE.Mesh(loft([[-0.17, 0, 0.012, 0.012], [-0.1, 0, 0.035, 0.035], [0.04, 0.005, 0.045, 0.042], [0.12, 0.012, 0.032, 0.03], [0.16, 0.014, 0.018, 0.018]], 8, () => [1, 1, 1]), chMat));
    const bk = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.045, 5).rotateX(Math.PI / 2 + 0.2), chBeak); bk.position.set(0, 0.008, 0.18); b.add(bk);
    const wings = [];
    for (const sx of [-1, 1]) {
      const sh = new THREE.Group(); sh.position.set(sx * 0.03, 0.01, 0.03); b.add(sh);
      const w = new THREE.Shape(); w.moveTo(0, 0.05); w.lineTo(0.2, 0.03); w.lineTo(0.3, -0.03); w.lineTo(0.22, -0.08); w.lineTo(0.0, -0.07);
      const wg = new THREE.ShapeGeometry(w); wg.rotateX(-Math.PI / 2); if (sx < 0) wg.scale(-1, 1, 1);
      sh.add(new THREE.Mesh(wg, chMat)); wings.push({ sh, sx });
    }
    const tl = new THREE.Shape(); tl.moveTo(-0.03, 0); tl.lineTo(-0.045, -0.12); tl.lineTo(0.045, -0.12); tl.lineTo(0.03, 0);
    const tg = new THREE.ShapeGeometry(tl); tg.rotateX(-Math.PI / 2); const tm = new THREE.Mesh(tg, chMat); tm.position.z = -0.15; b.add(tm);
    b.traverse(o => { if (o.isMesh) o.castShadow = true; });
    b.scale.setScalar(1.3);
    scene.add(b);
    choughs.push({ g: b, wings, off: new THREE.Vector3((rng() - 0.5) * 16, (rng() - 0.5) * 6, (rng() - 0.5) * 16), ph: rng() * 10, pos: new THREE.Vector3(), vel: new THREE.Vector3(), flap: rng() });
  }
  const flock = { c: new THREE.Vector3(s0.x, W.hf.height(s0.x, s0.z) + 18, s0.z), a: 0 };
  choughs.forEach(c => c.pos.copy(flock.c).add(c.off));

  // ---------------- butterflies (Apollo whites, fritillaries, blues, tortoiseshells) over the flowers near the camera
  const bfTex = (() => {
    const C = 128, c = document.createElement('canvas'); c.width = C * 4; c.height = C; const g = c.getContext('2d');
    const wing = (cx, cy, rx, ry, rot, fill, edge) => { g.save(); g.translate(cx, cy); g.rotate(rot); g.fillStyle = fill; g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, 6.283); g.fill(); if (edge) { g.strokeStyle = edge; g.lineWidth = 5; g.stroke(); } g.restore(); };
    const spot = (x, y, r, col) => { g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill(); };
    const species = [
      { fore: '#f4f1e6', hind: '#f1ede2', edge: 'rgba(90,90,90,0.55)', spots: (o, sx) => { spot(o + 64 + sx * 26, 40, 5, '#222'); spot(o + 64 + sx * 40, 34, 4, '#222'); spot(o + 64 + sx * 24, 86, 7, '#c8242a'); spot(o + 64 + sx * 24, 86, 3, '#fff'); } },
      { fore: '#e8781c', hind: '#df6c14', edge: '#3a2210', spots: (o, sx) => { for (let k = 0; k < 6; k++) spot(o + 64 + sx * (18 + (k % 3) * 11), 30 + Math.floor(k / 3) * 14 + (k % 2) * 4, 3.2, '#2a1a0c'); spot(o + 64 + sx * 26, 84, 3, '#2a1a0c'); } },
      { fore: '#5d86e6', hind: '#6a90ea', edge: '#1e2a4a', spots: (o, sx) => { spot(o + 64 + sx * 30, 88, 2.5, '#f08a24'); } },
      { fore: '#d9481f', hind: '#2a1e18', edge: '#1a120e', spots: (o, sx) => { spot(o + 64 + sx * 42, 30, 5, '#f1e6c4'); spot(o + 64 + sx * 22, 34, 6, '#1c140f'); for (let k = 0; k < 4; k++) spot(o + 64 + sx * (18 + k * 7), 100, 2.4, '#3d73d6'); } },
    ];
    species.forEach((sp, i) => {
      const o = i * C;
      for (const sx of [-1, 1]) {
        wing(o + 64 + sx * 30, 42, 34, 22, sx * -0.55, sp.fore, sp.edge);   // forewing
        wing(o + 64 + sx * 24, 84, 24, 26, sx * 0.35, sp.hind, sp.edge);    // hindwing
        sp.spots(o, sx);
      }
      g.fillStyle = '#1b1612'; g.beginPath(); g.ellipse(o + 64, 64, 4, 34, 0, 0, 6.283); g.fill();
    });
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  })();
  const bfGeo = new THREE.BufferGeometry();
  {
    // two halves hinged on the body (local z = forward); uv spans one species cell
    const W2 = 0.05, L2 = 0.05;
    const P = [], UV = [], S = [], idx = [];
    for (const sx of [-1, 1]) {
      const b = P.length / 3;
      const xs = sx < 0 ? [-W2, 0] : [0, W2];
      for (const [x, z] of [[xs[0], -L2], [xs[1], -L2], [xs[1], L2], [xs[0], L2]]) { P.push(x, 0, z); UV.push(0.5 + x / (2 * W2), 0.5 - z / (2 * L2)); S.push(sx); }
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    bfGeo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    bfGeo.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    bfGeo.setAttribute('aSide', new THREE.Float32BufferAttribute(S, 1));
    const nrm = new Float32Array(P.length); for (let i = 0; i < nrm.length; i += 3) nrm[i + 1] = 1;
    bfGeo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    bfGeo.setIndex(idx);
  }
  const NB = 16;
  const spA = new Float32Array(NB);
  for (let i = 0; i < NB; i++) { const t = rng(); spA[i] = t < 0.34 ? 0 : t < 0.6 ? 1 : t < 0.82 ? 2 : 3; }
  bfGeo.setAttribute('aSp', new THREE.InstancedBufferAttribute(spA, 1));
  const bfMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: bfTex, alphaTest: 0.5, roughness: 0.7, side: THREE.DoubleSide });
  patch(bfMat, { key: 'butterfly', vHead: 'attribute float aSide; attribute float aSp;',
    vBegin: `{
      float ph = float(gl_InstanceID) * 1.7;
      float beat = sin(uTime * 15.0 + ph);
      float glide = smoothstep(0.55, 0.9, sin(uTime * 0.9 + ph * 3.1));
      float fl = mix(beat * 0.95 + 0.25, 0.3, glide);
      float x0 = transformed.x; transformed.x = x0 * cos(fl); transformed.y += abs(x0) * sin(fl);
      vMapUv = vec2((aSp + uv.x) / 4.0, uv.y);
    }` });
  const bflies = new THREE.InstancedMesh(bfGeo, bfMat, NB);
  bflies.frustumCulled = false; bflies.castShadow = false; bflies.layers.set(1);
  const bfData = [];
  for (let i = 0; i < NB; i++) bfData.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), home: new THREE.Vector2(), t: rng() * 10, fade: 0, leaving: false, placed: false });
  scene.add(bflies);
  out.butterflies = bflies;

  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const dummy = new THREE.Object3D();
  let lastHikerS = 0;
  out.update = (dt, time, hiker, env, camera) => {
    const hp = hiker.pos;
    const hs = hiker.trailS;
    // ---- argali herd behaviour
    const dH = Math.hypot(hp.x - herd.center.x, hp.z - herd.center.z);
    herd.bolt = Math.max(0, herd.bolt - dt);
    const nextSpot = () => { for (let k = 0; k < spots.length; k++) if (spots[k].s > hs + 45) return k; return 0; };
    const placeHerd = (k) => { herd.spot = k; herd.center.copy(spots[k].p); herd.target.copy(spots[k].p); for (const a of out.animals) if (a.kind === 'argali') { a.pos.set(herd.center.x + a.offset.x, 0, herd.center.z + a.offset.y); a.speed = 0; } };
    if (hs < lastHikerS - 100) placeHerd(0);
    lastHikerS = hs;
    if (dH < 34 && herd.bolt <= 0 && herd.alert > 1.2) {
      herd.spot = nextSpot(); herd.target.copy(spots[herd.spot].p);
      herd.bolt = 14; herd.alert = 0;
      if (audio) audio.rockfall(herd.center, 0.45);
    } else if (dH < 70) herd.alert += dt; else herd.alert = Math.max(0, herd.alert - dt);
    // left far behind: quietly move up to the next grazing ground ahead (out of sight)
    if (herd.bolt <= 0 && dH > 170) { const ctp = W.trail.nearest(herd.center.x, herd.center.z).s; if (ctp < hs - 60) placeHerd(nextSpot()); }
    const hd = Math.hypot(herd.target.x - herd.center.x, herd.target.z - herd.center.z);
    if (hd > 0.5) { const sp = herd.bolt > 0 ? 7.5 : 0.6; const k = Math.min(1, sp * dt / hd); herd.center.x += (herd.target.x - herd.center.x) * k; herd.center.z += (herd.target.z - herd.center.z) * k; }
    else if (herd.bolt > 0) herd.bolt = Math.min(herd.bolt, 1.0);
    for (const a of out.animals) {
      if (a.kind === 'argali') {
        const tx = herd.center.x + a.offset.x, tz = herd.center.z + a.offset.y;
        const dx = tx - a.pos.x, dz = tz - a.pos.z; const d = Math.hypot(dx, dz);
        let want = 0;
        if (herd.bolt > 0 && d > 1.5) want = Math.min(8.5, 2 + d * 0.6);
        else { a.grazeT -= dt; if (d > 3) want = Math.min(2.5, 0.5 + d * 0.15); else if (a.grazeT < 0) { a.offset.x = clamp(a.offset.x + (rng() - 0.5) * 3, -10, 10); a.offset.y = clamp(a.offset.y + (rng() - 0.5) * 3, -10, 10); a.grazeT = 4 + rng() * 8; } }
        a.speed = lerp(a.speed, want, 1 - Math.exp(-dt * (want > a.speed ? 3 : 2)));
        if (d > 0.3 && a.speed > 0.05) { const dy = Math.atan2(dx, dz); const df = Math.atan2(Math.sin(dy - a.yaw), Math.cos(dy - a.yaw)); a.yaw += clamp(df, -dt * 3.5, dt * 3.5); }
        for (const b of (W.boulders || [])) { const bx = a.pos.x - b.x, bz = a.pos.z - b.z; if (Math.abs(bx) > b.r + 2 || Math.abs(bz) > b.r + 2) continue; const bd = Math.hypot(bx, bz); if (bd < b.r + 0.9 && bd > 0.01) { a.pos.x += bx / bd * (b.r + 0.9 - bd); a.pos.z += bz / bd * (b.r + 0.9 - bd); } }
        a.pos.x += Math.sin(a.yaw) * a.speed * dt; a.pos.z += Math.cos(a.yaw) * a.speed * dt;
        const alert = herd.alert > 0.5 || herd.bolt > 0;
        a.headDown = lerp(a.headDown, alert || a.speed > 1 ? 0 : 1, 1 - Math.exp(-dt * 2.5));
        const toH = Math.atan2(hp.x - a.pos.x, hp.z - a.pos.z) - a.yaw;
        a.lookYaw = lerp(a.lookYaw, alert && herd.bolt <= 0 ? clamp(Math.atan2(Math.sin(toH), Math.cos(toH)), -1, 1) : 0, 1 - Math.exp(-dt * 3));
        a.pose(dt, W, time);
      } else if (a.kind === 'gazelle') {
        // stay roughly abreast of the hiker so they cross the view below the ridge
        const tsd = hs * 0.82;
        a.runT = (a.runT ?? 8) - dt;
        if (a.runT < 0) { a.run = !a.run; a.runT = a.run ? 9 + rng() * 8 : 7 + rng() * 9; }
        if (a.ds < tsd - 60) a.dir = 1; else if (a.ds > tsd + 120) a.dir = -1;
        a.ds += a.dir * dt * (a.run ? 7 : 1.1);
        const [x, z] = W.frame(a.ds, a.o + Math.sin(a.ds * 0.012) * 35);
        if (Math.hypot(x - a.pos.x, z - a.pos.z) > 0.01) a.yaw = Math.atan2(x - a.pos.x, z - a.pos.z);
        a.speed = a.run ? 7 : 1.1;
        a.pos.set(x, 0, z);
        a.headDown = lerp(a.headDown, a.run ? 0 : 0.8, 1 - Math.exp(-dt));
        a.pose(dt, W, time);
      }
    }
    // ---- marmots
    for (const m of marmots) {
      const d = Math.hypot(hp.x - m.x, hp.z - m.z);
      m.t -= dt;
      if (m.state === 'hidden') { m.up = Math.max(0, m.up - dt * 3); if (d > 17 && m.t < 0) m.state = 'rise'; }
      else if (m.state === 'rise') { m.up = Math.min(1, m.up + dt * 1.2); if (m.up >= 1) { m.state = 'out'; m.t = 2 + rng() * 5; } if (d < 11) m.state = 'dive'; }
      else if (m.state === 'out') {
        if (d < 11) { m.state = 'dive'; if (audio && !m.called) { audio.marmot(new THREE.Vector3(m.x, m.gy, m.z)); m.called = true; } }
        m.stand = lerp(m.stand, d < 32 || (Math.sin(time * 0.3 + m.x) > 0.2) ? 1 : 0, 1 - Math.exp(-dt * 3));
        if (m.t < 0) { m.wander.set((rng() - 0.5) * 2.5, (rng() - 0.5) * 2.5); m.t = 3 + rng() * 5; }
      } else if (m.state === 'dive') { m.stand = 0; m.wander.multiplyScalar(Math.exp(-dt * 8)); m.up = Math.max(0, m.up - dt * 4); if (m.up <= 0) { m.state = 'hidden'; m.t = 3 + rng() * 5; m.called = false; } }
      const wx = m.x + m.wander.x * (m.state === 'out' ? 1 : 0), wz = m.z + m.wander.y * (m.state === 'out' ? 1 : 0);
      m.cur = m.cur || new THREE.Vector2(m.x, m.z);
      m.cur.x = lerp(m.cur.x, m.state === 'dive' ? m.x : wx, 1 - Math.exp(-dt * (m.state === 'dive' ? 8 : 1)));
      m.cur.y = lerp(m.cur.y, m.state === 'dive' ? m.z : wz, 1 - Math.exp(-dt * (m.state === 'dive' ? 8 : 1)));
      const onMound = Math.hypot(m.cur.x - m.x, m.cur.y - m.z) < 0.9 ? 0.12 : 0;
      const gy = W.hf.height(m.cur.x, m.cur.y) + onMound;
      m.g.position.set(m.cur.x, gy - 0.5 * (1 - m.up), m.cur.y);
      m.g.visible = m.up > 0.02;
      const toH = Math.atan2(hp.x - m.cur.x, hp.z - m.cur.y);
      m.yaw = lerp(m.yaw, m.stand > 0.5 ? toH : m.yaw + Math.sin(time * 0.5 + m.x) * 0.01, 1 - Math.exp(-dt * 2));
      m.g.rotation.y = m.yaw;
      m.body.rotation.x = -m.stand * 1.25;
      m.body.position.y = m.stand * 0.12;
    }
    // ---- eagle: thermal circles ahead of the hiker, occasional stoop
    const e = eagle;
    e.t += dt;
    const fwd = W.trail.at(Math.min(W.trail.len, hs + 58));
    tmp.set(fwd.x, W.hf.height(fwd.x, fwd.z) + 24 + Math.sin(time * 0.05) * 6, fwd.z);
    e.center.lerp(tmp, 1 - Math.exp(-dt * 0.08));
    if (e.state === 'circle') {
      e.angle += dt * 0.26;
      const R = 30 + Math.sin(time * 0.07) * 9;
      const target = tmp.set(e.center.x + Math.cos(e.angle) * R, e.center.y + Math.sin(time * 0.11) * 6, e.center.z + Math.sin(e.angle) * R);
      e.vel.lerp(target.sub(e.pos).multiplyScalar(0.35), 1 - Math.exp(-dt * 1.0));
      if (e.t > 35 + rng() * 20) { e.state = 'dive'; e.t = 0; const d = W.trail.at(Math.min(W.trail.len, hs + 50 + rng() * 40)); const side = rng() < 0.5 ? -1 : 1; const dx = d.x - d.tz * side * 25, dz = d.z + d.tx * side * 25; e.diveTarget = new THREE.Vector3(dx, W.hf.height(dx, dz) + 4, dz); }
    } else if (e.state === 'dive') {
      const to = tmp.copy(e.diveTarget).sub(e.pos); const l = to.length();
      e.vel.lerp(to.normalize().multiplyScalar(30), 1 - Math.exp(-dt * 1.6));
      if (l < 6 || e.t > 8) { e.state = 'climb'; e.t = 0; if (audio) audio.eagle(e.pos); }
    } else {
      tmp.set(e.center.x - e.pos.x, 0, e.center.z - e.pos.z).normalize().multiplyScalar(9); tmp.y = 6;
      e.vel.lerp(tmp, 1 - Math.exp(-dt * 0.9));
      if (e.pos.y > e.center.y - 6 || e.t > 20) { e.state = 'circle'; e.t = 0; }
    }
    e.pos.addScaledVector(e.vel, dt);
    const gmin = W.hf.height(e.pos.x, e.pos.z) + 3; if (e.pos.y < gmin) { e.pos.y = gmin; e.vel.y = Math.abs(e.vel.y) * 0.5; }
    e.g.position.copy(e.pos);
    const sp = e.vel.length();
    if (sp > 0.1) {
      const yaw = Math.atan2(e.vel.x, e.vel.z);
      const pitch = -Math.asin(clamp(e.vel.y / sp, -1, 1));
      const bank = e.state === 'circle' ? -0.5 : 0;
      e.g.rotation.set(pitch, yaw, bank, 'YXZ');
    }
    const flapping = e.state === 'climb';
    e.flap += dt * (flapping ? 3.2 : 0.5);
    const tuck = e.state === 'dive' ? 1 : 0;
    for (const w of e.wings) {
      const f = flapping ? Math.sin(e.flap * Math.PI * 2) * 0.7 : Math.sin(e.flap) * 0.04 + 0.12;
      w.sh.rotation.z = w.sx * (f) * (1 - tuck) + w.sx * tuck * -0.2;
      w.sh.rotation.y = -w.sx * tuck * 0.9;
      w.wrist.rotation.z = w.sx * (flapping ? Math.sin(e.flap * Math.PI * 2 - 0.6) * 0.3 : 0.05);
      w.wrist.rotation.y = w.sx * tuck * 1.2;
    }
    e.tail.rotation.y = Math.sin(time * 0.7) * 0.1;
    // ---- chough flock
    flock.a += dt * 0.22;
    const fc = W.trail.at(Math.min(W.trail.len, hs + 40));
    tmp.set(fc.x + Math.cos(flock.a) * 45, W.hf.height(fc.x, fc.z) + 14 + Math.sin(flock.a * 1.7) * 6, fc.z + Math.sin(flock.a * 0.8) * 45);
    flock.c.lerp(tmp, 1 - Math.exp(-dt * 0.35));
    const nightHide = env ? env.night > 0.6 || env.rain > 0.5 : false;
    for (const c of choughs) {
      c.g.visible = !nightHide;
      tmp2.set(Math.sin(time * 0.9 + c.ph) * 5, Math.sin(time * 1.3 + c.ph) * 2, Math.cos(time * 0.8 + c.ph) * 5);
      const tgt = tmp.copy(flock.c).add(c.off).add(tmp2);
      const ac = tgt.sub(c.pos).multiplyScalar(0.9);
      c.vel.addScaledVector(ac, dt); c.vel.multiplyScalar(Math.exp(-dt * 0.6));
      const spd = c.vel.length(); if (spd > 14) c.vel.multiplyScalar(14 / spd);
      c.pos.addScaledVector(c.vel, dt);
      const gm = W.hf.height(c.pos.x, c.pos.z) + 2.5; if (c.pos.y < gm) c.pos.y = gm;
      c.g.position.copy(c.pos);
      if (spd > 0.2) c.g.rotation.set(-Math.asin(clamp(c.vel.y / spd, -1, 1)), Math.atan2(c.vel.x, c.vel.z), clamp(-ac.x * 0.01, -0.6, 0.6), 'YXZ');
      c.flap += dt * (c.vel.y > 0.5 ? 7 : 3.5);
      const glide = Math.sin(time * 0.6 + c.ph) > 0.2;
      for (const w of c.wings) w.sh.rotation.z = w.sx * (glide ? 0.08 : Math.sin(c.flap * Math.PI * 2) * 0.8);
    }
    // ---- butterflies near the camera over grass & flowers (daytime, not in rain); they fade out and back in
    const bfOn = env ? (1 - env.night) * (1 - env.rain) * (1 - env.storm) : 1;
    bflies.visible = bfOn > 0.3;
    if (bflies.visible && camera) {
      const cx = camera.position.x, cz = camera.position.z;
      camera.getWorldDirection(tmp); let fx = tmp.x, fz = tmp.z; const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
      for (let i = 0; i < NB; i++) {
        const b = bfData[i];
        const place = () => {
          const ahead = 7 + rng() * 14, side = (rng() - 0.5) * 18;
          b.home.set(cx + fx * ahead - fz * side, cz + fz * ahead + fx * side);
          b.p.set(b.home.x, W.hf.height(b.home.x, b.home.y) + 0.5 + rng() * 0.6, b.home.y); b.v.set(0, 0, 0); b.placed = true; b.leaving = false;
        };
        if (!b.placed) { place(); b.fade = rng(); }
        const dist = Math.hypot(b.p.x - cx, b.p.z - cz);
        if (dist > 26 || Math.hypot(b.p.x - b.home.x, b.p.z - b.home.y) > 12) b.leaving = true;
        if (b.leaving) { b.fade -= dt * 1.5; if (b.fade <= 0) { b.fade = 0; place(); } }
        else b.fade = Math.min(1, b.fade + dt * 0.8);
        b.t -= dt;
        if (b.t < 0) { b.t = 0.5 + rng() * 1.4; b.v.set((rng() - 0.5) * 1.6, (rng() - 0.45) * 0.8, (rng() - 0.5) * 1.6); b.v.x += (b.home.x - b.p.x) * 0.1; b.v.z += (b.home.y - b.p.z) * 0.1; }
        b.p.addScaledVector(b.v, dt);
        b.p.x += U.uWindDir.value.x * U.uWind.value * 0.3 * dt; b.p.z += U.uWindDir.value.y * U.uWind.value * 0.3 * dt;
        const gy = W.hf.height(b.p.x, b.p.z);
        b.p.y = clamp(b.p.y, gy + 0.2, gy + 1.5);
        const k = smoothstep(0, 1, b.fade);
        dummy.position.copy(b.p); dummy.rotation.set(0, Math.atan2(b.v.x, b.v.z), 0); dummy.scale.setScalar(Math.max(0.0001, k));
        dummy.updateMatrix(); bflies.setMatrixAt(i, dummy.matrix);
      }
      bflies.instanceMatrix.needsUpdate = true;
    }
  };
  return out;
}
