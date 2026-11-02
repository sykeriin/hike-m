import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patch, woodTexture, khadagTexture, barkTexture, U, GLSL_COMMON } from './materials.js';
import { rockGeometry, rockMaterial } from './rocks.js';
import { mulberry32, clamp, simplex2, smoothstep, lerp } from './noise.js';

const CLOTH_V = `float cl_w1; vec3 cl_dir, cl_up2, cl_acr; float cl_s, cl_t, cl_str, cl_ph;
      {
        float t = uv.y; float side = uv.x - 0.5;
        float L = aPrm.x, Wd = aPrm.y, ph = aPrm.z, stiff = aPrm.w;
        float g = windGust(aAnchor.xz);
        float str = clamp(uWind * (0.45 + 1.1 * g), 0.0, 2.2);
        float lift = clamp(0.55 + str * 1.5 * stiff, 0.0, 1.45);
        vec3 wd = normalize(vec3(uWindDir.x, 0.0, uWindDir.y));
        vec3 dir = normalize(vec3(0.0, -1.0, 0.0) * cos(lift) + wd * sin(lift));
        vec3 across = normalize(cross(wd, vec3(0.0, 1.0, 0.0)));
        vec3 up2 = normalize(cross(across, dir));
        float s = t * L;
        float w1 = sin(s * 7.0 - uTime * (9.0 + str * 6.0) + ph) * (0.05 + 0.18 * t) * (0.4 + str);
        float w2 = sin(s * 13.0 - uTime * 17.0 + ph * 1.7) * 0.04 * t * str;
        float twist = sin(s * 3.0 - uTime * 6.0 + ph) * 0.6 * t * min(str, 1.0);
        vec3 acr = normalize(across * cos(twist) + up2 * sin(twist));
        vec3 p = aAnchor + dir * s + up2 * (w1 + w2) + acr * side * Wd;
        // droop at low wind
        p.y -= (1.0 - lift / 1.45) * 0.0;
        transformed = p;
        cl_w1 = w1; cl_dir = dir; cl_up2 = up2; cl_acr = acr; cl_s = s; cl_t = t; cl_str = str; cl_ph = ph;
      }`;
const CLOTH_N = `
      {
        float s2 = cl_s + 0.05;
        float w1b = sin(s2 * 7.0 - uTime * (9.0 + cl_str * 6.0) + cl_ph) * (0.05 + 0.18 * cl_t) * (0.4 + cl_str);
        vec3 tng = normalize(cl_dir * 0.05 + cl_up2 * (w1b - cl_w1));
        objectNormal = normalize(cross(tng, cl_acr));
      }
`;

// ------------------------------------------------------------ fluttering cloth strips (khadag, prayer rags)
class ClothStrips {
  constructor() { this.strips = []; }
  add(anchor, len, width, color, opts = {}) { this.strips.push({ anchor, len, width, color, hang: opts.hang || null, phase: Math.random() * 10, stiff: opts.stiff ?? 1, tatter: opts.tatter ?? 0 }); }
  build(scene) {
    const SEG = 18;
    const pos = [], uv = [], anc = [], prm = [], cols = [], idx = [];
    let v0 = 0;
    for (const s of this.strips) {
      for (let i = 0; i <= SEG; i++) {
        const t = i / SEG;
        for (let j = 0; j < 2; j++) {
          pos.push(0, 0, 0);
          uv.push(j, t);
          anc.push(s.anchor.x, s.anchor.y, s.anchor.z);
          prm.push(s.len, s.width * (1 - s.tatter * t * 0.6), s.phase, s.stiff);
          cols.push(s.color[0], s.color[1], s.color[2]);
        }
        if (i < SEG) idx.push(v0 + i * 2, v0 + i * 2 + 1, v0 + i * 2 + 2, v0 + i * 2 + 1, v0 + i * 2 + 3, v0 + i * 2 + 2);
      }
      v0 += (SEG + 1) * 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => i % 3 === 1 ? 1 : 0), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aAnchor', new THREE.Float32BufferAttribute(anc, 3));
    g.setAttribute('aPrm', new THREE.Float32BufferAttribute(prm, 4));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    g.setIndex(idx);
    const tex = khadagTexture();
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, vertexColors: true, roughness: 0.42, side: THREE.DoubleSide, bumpMap: tex, bumpScale: 0.6 });
    patch(m, {
      key: 'cloth', shadowBias: 0.2,
      vHead: 'attribute vec3 aAnchor; attribute vec4 aPrm;',
      vBegin: CLOTH_V + CLOTH_N,
    });
    // ensure normal transform uses our objectNormal: begin_vertex runs after beginnormal; patch transformedNormal
    m.onBeforeCompile = ((orig) => (sh, r) => {
      orig(sh, r);
      sh.vertexShader = sh.vertexShader.replace('#include <defaultnormal_vertex>', '').replace('#include <normal_vertex>', '').replace('#include <project_vertex>', 'vec3 transformedNormal = normalMatrix * objectNormal;\n#ifdef FLIP_SIDED\n transformedNormal = -transformedNormal;\n#endif\n#ifndef FLAT_SHADED\n vNormal = normalize(transformedNormal);\n#endif\n#include <project_vertex>');
    })(m.onBeforeCompile);
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
    // shadow depth material must displace too
    mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    patchDepth(mesh.customDepthMaterial, m);
    scene.add(mesh);
    return mesh;
  }
}
function patchDepth(dm, src) {
  dm.onBeforeCompile = (sh) => {
    // reuse same vertex logic by borrowing from source via a simple recompile of the vertex prelude
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + GLSL_COMMON + '\nattribute vec3 aAnchor; attribute vec4 aPrm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + CLOTH_V);
  };
}

export function buildLandmarks(W, scene, colliders, camColliders) {
  const rng = mulberry32(31337);
  const hf = W.hf;
  const cloth = new ClothStrips();
  const dummy = new THREE.Object3D();
  const out = { cloth };
  const wood = woodTexture(12, { base: [120, 104, 86], bleach: 0.4 });
  const woodMat = patch(new THREE.MeshStandardMaterial({ color: 0xffffff, map: wood, roughness: 0.85, bumpMap: wood, bumpScale: 2.0 }), { wet: 0.8, shadowBias: 0.3, key: 'wood' });
  const barkT = barkTexture(7); barkT.repeat.set(2, 3);
  const logMat = patch(new THREE.MeshStandardMaterial({ color: 0xb8a58c, map: barkT, roughness: 0.9, bumpMap: barkT, bumpScale: 3 }), { wet: 0.8, shadowBias: 0.3, key: 'log' });
  const stoneMat = rockMaterial({ key: 'lm', bandScale: 4, localBands: 0.3, lichen: 1.0 });
  const sgeos = [0, 1, 2, 3, 4, 5].map(i => rockGeometry(7000 + i * 13, 2, { cuts: 5, sy: 0.5 + (i % 3) * 0.12 }));
  const stonesByGeo = sgeos.map(() => []);
  const addStone = (x, y, z, sx, sy, sz, ry = rng() * 6.28, rx = 0, rz = 0) => { stonesByGeo[Math.floor(rng() * sgeos.length)].push([x, y, z, sx, sy, sz, rx, ry, rz]); };

  // ---------------------------------------------------------------- ovoo at the pass
  {
    const O = W.ovoo; const g0 = hf.height(O.x, O.z);
    let gmin = g0; for (let a = 0; a < 12; a++) gmin = Math.min(gmin, hf.height(O.x + Math.cos(a) * 2.4, O.z + Math.sin(a) * 2.4));
    const H = 2.3, R0 = 2.3;
    for (let L = 0; L < 13; L++) {
      const t = L / 12;
      const r = R0 * Math.pow(1 - t, 0.85) + 0.15;
      const n = Math.max(3, Math.floor(2 * Math.PI * r / 0.42));
      const y = gmin + t * H - 0.1;
      for (let k = 0; k < n; k++) {
        const a = k / n * Math.PI * 2 + L * 0.37 + rng() * 0.2;
        const rr = r * (0.92 + rng() * 0.12);
        const sz = 0.2 + rng() * 0.16;
        addStone(O.x + Math.cos(a) * rr, y + sz * 0.3, O.z + Math.sin(a) * rr, sz * 1.2, sz * 0.8, sz, a, (rng() - 0.5) * 0.4, (rng() - 0.5) * 0.4);
      }
      // fill core
      for (let k = 0; k < n / 3; k++) { const a = rng() * 6.28, rr = r * rng() * 0.8; addStone(O.x + Math.cos(a) * rr, y + 0.1, O.z + Math.sin(a) * rr, 0.3, 0.22, 0.28); }
    }
    // scattered offering stones at base
    for (let k = 0; k < 26; k++) { const a = rng() * 6.28, rr = R0 + 0.3 + rng() * 1.2; const x = O.x + Math.cos(a) * rr, z = O.z + Math.sin(a) * rr; const s = 0.1 + rng() * 0.12; addStone(x, hf.height(x, z) + s * 0.2, z, s, s * 0.7, s); }
    // central pole + branch bundle
    const top = gmin + H;
    const poleG = new THREE.CylinderGeometry(0.05, 0.07, 3.6, 8); poleG.translate(0, 1.8, 0);
    const pole = new THREE.Mesh(poleG, logMat); pole.position.set(O.x, top - 1.2, O.z); pole.castShadow = true; pole.receiveShadow = true; scene.add(pole);
    const tipY = top - 1.2 + 3.6;
    const branches = [];
    for (let b = 0; b < 9; b++) {
      const a = b / 9 * Math.PI * 2 + rng() * 0.3; const tilt = 0.25 + rng() * 0.35; const len = 1.6 + rng() * 1.2;
      const bg = new THREE.CylinderGeometry(0.012, 0.03, len, 5); bg.translate(0, len / 2, 0);
      const bm = new THREE.Mesh(bg, logMat);
      bm.position.set(O.x + Math.cos(a) * 0.1, top - 0.2, O.z + Math.sin(a) * 0.1);
      bm.rotation.set(Math.sin(a) * tilt, 0, -Math.cos(a) * tilt);
      bm.castShadow = true; scene.add(bm);
      bm.updateMatrixWorld();
      branches.push(bm);
      // scarves tied along branch
      for (let k = 0; k < 3; k++) {
        const p = new THREE.Vector3(0, len * (0.45 + k * 0.2), 0).applyMatrix4(bm.matrixWorld);
        const blue = [0.08 + rng() * 0.06, 0.28 + rng() * 0.12, 0.75 + rng() * 0.2];
        const pick = rng();
        const c = pick < 0.72 ? blue : pick < 0.86 ? [0.9, 0.9, 0.86] : pick < 0.93 ? [0.9, 0.75, 0.2] : [0.25, 0.6, 0.3];
        cloth.add(p, 0.8 + rng() * 1.0, 0.11 + rng() * 0.06, c, { stiff: 0.9 + rng() * 0.3 });
      }
    }
    // khadags wrapped at pole top
    for (let k = 0; k < 4; k++) { const a = rng() * 6.28; cloth.add(new THREE.Vector3(O.x + Math.cos(a) * 0.08, tipY - 0.25 - k * 0.3, O.z + Math.sin(a) * 0.08), 1.1 + rng() * 0.7, 0.24, [0.1, 0.33 + rng() * 0.1, 0.85], { stiff: 1 }); }
    // prayer-flag lines to ground stakes with small rags
    for (let l = 0; l < 3; l++) {
      const a = l * 2.1 + 0.4; const end = new THREE.Vector3(O.x + Math.cos(a) * 6.5, 0, O.z + Math.sin(a) * 6.5); end.y = hf.height(end.x, end.z) + 0.5;
      const start = new THREE.Vector3(O.x, tipY - 0.5, O.z);
      const pts = [];
      for (let i = 0; i <= 16; i++) { const t = i / 16; const p = start.clone().lerp(end, t); p.y -= Math.sin(t * Math.PI) * 0.6; pts.push(p); }
      const rope = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.012, 5), logMat); rope.castShadow = true; scene.add(rope);
      const pal = [[0.1, 0.3, 0.8], [0.9, 0.9, 0.88], [0.8, 0.15, 0.1], [0.2, 0.55, 0.25], [0.9, 0.75, 0.15]];
      for (let i = 2; i < 15; i++) cloth.add(pts[i].clone(), 0.28, 0.2, pal[i % 5], { stiff: 1.2, tatter: 0.3 });
      // stake
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.9, 6), woodMat); st.position.set(end.x, end.y - 0.1, end.z); st.castShadow = true; scene.add(st);
      colliders.push({ x: end.x, z: end.z, r: 0.2 });
    }
    colliders.push({ x: O.x, z: O.z, r: R0 + 0.3 });
    camColliders.push({ x: O.x, z: O.z, r: R0 + 0.4, y: gmin + 1 });
    out.ovooTop = new THREE.Vector3(O.x, tipY, O.z);
  }

  // ---------------------------------------------------------------- trail marker post
  {
    const M = W.marker; const g = hf.height(M.x, M.z);
    const pg = new THREE.BoxGeometry(0.17, 1.75, 0.15, 2, 12, 2);
    const pa = pg.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      let x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
      const t = (y + 0.875) / 1.75;
      const taper = 1 - t * 0.12;
      x *= taper; z *= taper;
      // slanted, weathered top
      if (t > 0.97) y -= (x + 0.085) * 0.9;
      x += Math.sin(y * 3) * 0.006; z += Math.cos(y * 2.3) * 0.005;
      pa.setXYZ(i, x, y, z);
    }
    pg.computeVertexNormals();
    const post = new THREE.Mesh(pg, woodMat);
    post.position.set(M.x, g + 0.875 - 0.3, M.z); post.rotation.set(0.04, rng() * 6.28, -0.05);
    post.castShadow = true; post.receiveShadow = true; scene.add(post);
    // carved notches (tally rings)
    for (let k = 0; k < 3; k++) {
      const ng = new THREE.BoxGeometry(0.178, 0.018, 0.158); const nm = new THREE.Mesh(ng, logMat);
      nm.position.set(0, 0.35 + k * 0.07, 0); post.add(nm);
    }
    post.updateMatrixWorld();
    // wrapped rag band + tattered remnants
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.018, 6, 16).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x5f7fa6, roughness: 0.9 }));
    patch(band.material, { key: 'band' });
    band.position.set(0, 0.62, 0); post.add(band);
    for (let k = 0; k < 4; k++) {
      const p = new THREE.Vector3((rng() - 0.5) * 0.1, 0.55 + k * 0.05, 0.08).applyMatrix4(post.matrixWorld);
      const c = k % 2 ? [0.45, 0.58, 0.72] : [0.8, 0.78, 0.7];
      cloth.add(p, 0.32 + rng() * 0.3, 0.07 + rng() * 0.05, c, { stiff: 1.1, tatter: 0.8 });
    }
    // stones propping the base
    for (let k = 0; k < 14; k++) { const a = rng() * 6.28, rr = 0.18 + rng() * 0.25; const x = M.x + Math.cos(a) * rr, z = M.z + Math.sin(a) * rr; const s = 0.08 + rng() * 0.1; addStone(x, hf.height(x, z) + s * 0.25, z, s, s * 0.8, s); }
    colliders.push({ x: M.x, z: M.z, r: 0.35 });
  }

  // ---------------------------------------------------------------- footbridge
  {
    const B = W.bridge; const f = [B.tx, B.tz]; const r = [-B.tz, B.tx];
    const ang = Math.atan2(f[0], f[1]);
    const grp = new THREE.Group(); grp.position.set(B.x, B.deck, B.z); grp.rotation.y = ang; scene.add(grp);
    // two logs along local z
    for (const sx of [-0.42, 0.42]) {
      const lg = new THREE.CylinderGeometry(0.13, 0.15, 8.8, 12, 6);
      const pa = lg.attributes.position; for (let i = 0; i < pa.count; i++) { const y = pa.getY(i); pa.setX(i, pa.getX(i) + Math.sin(y * 0.8) * 0.02); } lg.computeVertexNormals();
      lg.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(lg, logMat); m.position.set(sx, -0.17, 0); m.castShadow = true; m.receiveShadow = true; grp.add(m);
      for (const ez of [-4.4, 4.4]) { const cap = new THREE.Mesh(new THREE.CircleGeometry(0.14, 12), woodMat); cap.position.set(sx, -0.17, ez); cap.rotation.y = ez > 0 ? 0 : Math.PI; grp.add(cap); }
    }
    // planks
    const plankG = new THREE.BoxGeometry(1.25, 0.05, 0.2);
    const planks = new THREE.InstancedMesh(plankG, woodMat, 34);
    for (let i = 0; i < 34; i++) {
      dummy.position.set((rng() - 0.5) * 0.06, -0.02 + (rng() - 0.5) * 0.01, -4.1 + i * 0.25);
      dummy.rotation.set((rng() - 0.5) * 0.03, (rng() - 0.5) * 0.08, (rng() - 0.5) * 0.04);
      dummy.scale.set(0.9 + rng() * 0.2, 1, 0.85 + rng() * 0.3); dummy.updateMatrix(); planks.setMatrixAt(i, dummy.matrix);
    }
    planks.castShadow = true; planks.receiveShadow = true; grp.add(planks);
    // lashing ropes
    for (let i = 0; i < 6; i++) for (const sx of [-0.42, 0.42]) { const t = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.012, 5, 12).rotateY(Math.PI / 2), logMat); t.position.set(sx, -0.14, -3.8 + i * 1.5); grp.add(t); }
    // stone abutments at each end
    grp.updateMatrixWorld();
    for (const ez of [-3.9, 3.9]) for (let k = 0; k < 16; k++) {
      const p = new THREE.Vector3((rng() - 0.5) * 1.8, 0, ez + (rng() - 0.5) * 1.0).applyMatrix4(grp.matrixWorld);
      const s = 0.18 + rng() * 0.18; addStone(p.x, hf.height(p.x, p.z) + s * 0.15, p.z, s * 1.2, s * 0.7, s);
    }
    camColliders.push({ x: B.x, z: B.z, r: 1.0, y: B.deck });
  }

  // ---------------------------------------------------------------- stone-walled livestock pen (valley floor)
  {
    const S = W.shelter; const g = hf.height(S.x, S.z);
    const ang = S.rot; const ca = Math.cos(ang), sa = Math.sin(ang);
    const hw = 7, hd = 5;
    const wallPts = [];
    const seg = (x0, z0, x1, z1) => { const L = Math.hypot(x1 - x0, z1 - z0); const n = Math.floor(L / 0.45); for (let i = 0; i <= n; i++) wallPts.push([x0 + (x1 - x0) * i / n, z0 + (z1 - z0) * i / n]); };
    seg(-hw, -hd, hw, -hd); seg(hw, -hd, hw, hd); seg(hw, hd, 1.2, hd); seg(-1.2, hd, -hw, hd); seg(-hw, hd, -hw, -hd);
    for (const [lx, lz] of wallPts) {
      const x = S.x + lx * ca - lz * sa, z = S.z + lx * sa + lz * ca;
      const gh = hf.height(x, z);
      const courses = 3 + (rng() < 0.3 ? -1 : 0);
      for (let c = 0; c < courses; c++) {
        const s = 0.24 + rng() * 0.12;
        addStone(x + (rng() - 0.5) * 0.15, gh + c * 0.3 + 0.08, z + (rng() - 0.5) * 0.15, s * 1.3, s * 0.75, s, -ang + (rng() - 0.5) * 0.4);
      }
    }
    // gate posts
    for (const gx of [-1.3, 1.3]) {
      const x = S.x + gx * ca - hd * sa, z = S.z + gx * sa + hd * ca;
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 1.5, 6), woodMat); p.position.set(x, hf.height(x, z) + 0.6, z); p.castShadow = true; scene.add(p);
    }
  }

  // ---------------------------------------------------------------- eagle cliff with nesting ledges
  {
    const C = W.cliff;
    const cg = rockGeometry(9191, 5, { sx: 1.0, sy: 1.0, sz: 0.7, cuts: 3, ledges: true });
    const cm = rockMaterial({ key: 'cliff', bandScale: 1.2, localBands: 0.25, lichen: 0.8, moss: 0.3 });
    const cliff = new THREE.Mesh(cg, cm);
    const g = hf.height(C.x, C.z);
    let gmin = g; for (let a = 0; a < 16; a++) gmin = Math.min(gmin, hf.height(C.x + Math.cos(a / 16 * 6.283) * 15, C.z + Math.sin(a / 16 * 6.283) * 11));
    cliff.scale.set(20, 26, 14);
    cliff.position.set(C.x, gmin - 1.5 + 0.25 * 26, C.z);
    cliff.rotation.y = Math.atan2(C.nx, C.nz);
    cliff.castShadow = true; cliff.receiveShadow = true;
    scene.add(cliff);
    cliff.updateMatrixWorld();
    const ray = new THREE.Raycaster();
    const nests = [];
    const nestMat = patch(new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 1 }), { key: 'nest' });
    for (const [hgt, lat, hasNest] of [[9, -3, true], [13.5, 4, false], [17, -1, true]]) {
      const n = new THREE.Vector3(C.nx, 0, C.nz);
      const side = new THREE.Vector3(-C.nz, 0, C.nx);
      const o = new THREE.Vector3(C.x, g + hgt, C.z).addScaledVector(n, 40).addScaledVector(side, lat);
      ray.set(o, n.clone().negate());
      const hit = ray.intersectObject(cliff)[0];
      if (!hit) continue;
      // ledge slab
      const lgeo = rockGeometry(500 + hgt, 2, { sy: 0.25, sx: 1.4, sz: 1.0, cuts: 2 });
      const ledge = new THREE.Mesh(lgeo, cm);
      ledge.scale.set(1.8, 1.4, 1.6);
      ledge.position.copy(hit.point).addScaledVector(n, 0.6);
      ledge.rotation.y = Math.atan2(C.nx, C.nz);
      ledge.castShadow = true; ledge.receiveShadow = true; scene.add(ledge);
      if (hasNest) {
        const twigs = [];
        for (let k = 0; k < 90; k++) {
          const a = rng() * 6.28, rr = 0.45 + rng() * 0.25;
          const tg = new THREE.CylinderGeometry(0.012, 0.012, 0.5 + rng() * 0.4, 3);
          tg.rotateZ(Math.PI / 2 + (rng() - 0.5) * 0.5); tg.rotateY(a + Math.PI / 2 + (rng() - 0.5) * 0.8);
          tg.translate(Math.cos(a) * rr, 0.08 + rng() * 0.22, Math.sin(a) * rr);
          twigs.push(tg);
        }
        const bowl = new THREE.CylinderGeometry(0.5, 0.4, 0.12, 12); bowl.translate(0, 0.06, 0); twigs.push(bowl);
        const nest = new THREE.Mesh(mergeGeometries(twigs.map(t => { t.deleteAttribute('uv'); return t; })), nestMat);
        const ly = ledge.position.y + 1.4 * 0.25 * 0.75 * 1.0;
        nest.position.set(ledge.position.x + n.x * 0.3, ly, ledge.position.z + n.z * 0.3);
        nest.castShadow = true; scene.add(nest);
        // two eggs
        for (let e = 0; e < 2; e++) { const egg = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8).scale(1, 1.3, 1), patch(new THREE.MeshStandardMaterial({ color: 0xd8cfc0, roughness: 0.6 }), { key: 'egg' })); egg.position.set(nest.position.x + (e - 0.5) * 0.14, nest.position.y + 0.15, nest.position.z); egg.rotation.z = 1.3; scene.add(egg); }
        nests.push(nest.position.clone());
      }
    }
    W.nests = nests;
    camColliders.push({ x: C.x, z: C.z, r: 16, y: g + 10 });
  }

  // ---------------------------------------------------------------- banded rock outcrops forming the tarn headwall
  {
    const T = W.tarn;
    const hm = rockMaterial({ key: 'head', bandScale: 1.0, localBands: 0.15, lichen: 0.9, moss: 0.5 });
    for (const [u, dv, w, hgt, seed] of [[-19, 10, 9, 14, 1], [-10, 11, 8, 17, 2], [-1.5, 12.5, 5, 15, 7], [11, 11, 8, 16, 3], [19, 9.5, 9, 13, 4], [26, 7, 7, 10, 5]]) {
      const x = T.x + T.fwd[0] * u + T.left[0] * (T.rz + dv), z = T.z + T.fwd[1] * u + T.left[1] * (T.rz + dv);
      let gmin = Infinity; for (let a = 0; a < 10; a++) gmin = Math.min(gmin, hf.height(x + Math.cos(a) * w * 0.45, z + Math.sin(a) * w * 0.45));
      const g = rockGeometry(8800 + seed * 7, 4, { sx: 1, sy: 1, sz: 0.6, cuts: 6 });
      const m = new THREE.Mesh(g, hm);
      m.scale.set(w, hgt, w * 0.8);
      m.position.set(x, gmin - 1.2 + 0.25 * hgt, z);
      m.rotation.y = Math.atan2(T.left[0], T.left[1]) + (rng() - 0.5) * 0.4;
      m.castShadow = true; m.receiveShadow = true; scene.add(m);
    }
  }

  // ---------------------------------------------------------------- banded cliff flanking the big waterfall
  {
    const F = W.falls; const hm = rockMaterial({ key: 'fallcliff', bandScale: 1.0, localBands: 0.12, lichen: 0.7, moss: 0.9 });
    const lipY = F.lip.y, baseY = F.pool.level - 1.2;
    const face = Math.atan2(F.dx, F.dz);
    const slots = [];
    for (const sgn of [-1, 1]) { let edge = 2.9; while (edge < 26) { const w = 6 + rng() * 3; slots.push([sgn * (edge + w * 0.45), w]); edge += w * 0.78; } }
    // one continuous rock face draped over the terraced cliff: horizontal beds of uneven thickness with
    // overhanging lips and undercuts, vertical joints, and a recessed channel where the water falls
    {
      const V0 = -24, V1 = 24, DV = 0.35;
      const topY = lipY + 1.2, botY = baseY - 0.6, DY = 0.22;
      const cols = Math.round((V1 - V0) / DV) + 1, rows = Math.round((topY - botY) / DY) + 1;
      // bed boundaries: random thicknesses, shared across the face (sedimentary layers)
      const beds = []; { let y = botY - 1; while (y < topY + 2) { beds.push(y); y += 0.55 + rng() * 1.6; } }
      const bedAt = (y) => { let i = 0; while (i < beds.length - 2 && beds[i + 1] <= y) i++; return [beds[i], beds[i + 1], i]; };
      const bedOut = beds.map(() => (rng() - 0.5) * 0.5);
      const pos = new Float32Array(cols * rows * 3);
      const keep = new Uint8Array(cols * rows);
      for (let c = 0; c < cols; c++) {
        const v = V0 + c * DV;
        const edgeK = smoothstep(Math.abs(V0), Math.abs(V0) - 6, Math.abs(v));        // fade into the slope at the ends
        const chan = 1 - smoothstep(1.6, 3.4, Math.abs(v));                             // channel behind the water
        const joint = Math.pow(Math.abs(Math.sin((v + 7.3) * 0.83 + Math.sin(v * 0.31) * 1.7)), 14); // vertical cracks
        for (let r = 0; r < rows; r++) {
          const y = botY + r * DY;
          const bx = F.lip.x + F.px * v, bz = F.lip.z + F.pz * v;
          let uf = null;
          for (let uu = -6; uu < 18; uu += 0.15) { if (hf.height(bx + F.dx * uu, bz + F.dz * uu) < y) { uf = uu; break; } }
          const k = c * rows + r;
          if (uf === null || uf < -5.9) { keep[k] = 0; pos.set([bx, y, bz], k * 3); continue; }
          keep[k] = 1;
          // within a bed: recessed at the bottom (undercut), bulging toward the lip at the top
          const yy = y + Math.sin(v * 0.21 + 1.3) * 0.25 + Math.sin(v * 0.67) * 0.08;
          const [b0, b1, bi] = bedAt(yy);
          const t = (yy - b0) / Math.max(0.01, b1 - b0);
          let out = 0.32 + 0.5 * smoothstep(0.0, 0.8, t) - 0.3 * smoothstep(0.92, 1.0, t) + bedOut[bi] * 0.6;
          out += (simplex2(v * 0.9, y * 0.6) * 0.5) * 0.3 - joint * 0.3;
          out = Math.max(out, 0.1);                                                          // always in front of the ground
          out = out * edgeK - (1 - edgeK) * 0.4;                                          // tuck under the ground at the ends
          out = lerp(out, 0.12 + (simplex2(v * 0.5, y * 0.35) * 0.5) * 0.12, chan);       // smooth worn channel under the fall
          const u = uf + out;
          pos.set([bx + F.dx * u, y, bz + F.dz * u], k * 3);
        }
      }
      for (let c = 0; c < cols; c++) {
        let rLo = -1, rHi = -1;
        for (let r = 0; r < rows; r++) if (keep[c * rows + r]) { if (rLo < 0) rLo = r; rHi = r; }
        if (rLo < 0) continue;
        for (let r = 0; r < rows; r++) {
          if (r >= rLo && r <= rHi) { keep[c * rows + r] = 1; continue; }
          const src = (r < rLo ? rLo : rHi), k = (c * rows + r) * 3, ks = (c * rows + src) * 3;
          pos[k] = pos[ks] - F.dx * 0.7; pos[k + 1] = pos[ks + 1] - 0.7; pos[k + 2] = pos[ks + 2] - F.dz * 0.7;
          keep[c * rows + r] = 1;
        }
      }
      const idx = [];
      for (let c = 0; c < cols - 1; c++) for (let r = 0; r < rows - 1; r++) {
        const a = c * rows + r, b = a + 1, cc = a + rows, d = cc + 1;
        if (!(keep[a] && keep[b] && keep[cc] && keep[d])) continue;
        idx.push(a, cc, b, b, cc, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      // the face points toward the pool: flip the winding if the normals came out facing into the rock
      { const n = g.attributes.normal; let s = 0; for (let i = 0; i < n.count; i += 37) s += n.getX(i) * F.dx + n.getZ(i) * F.dz; if (s < 0) { const ia = g.index.array; for (let i = 0; i < ia.length; i += 3) { const tmp = ia[i + 1]; ia[i + 1] = ia[i + 2]; ia[i + 2] = tmp; } g.computeVertexNormals(); } }
      const m = new THREE.Mesh(g, hm);
      m.castShadow = true; m.receiveShadow = true; scene.add(m);
      for (let v = -18; v <= 18; v += 6) if (Math.abs(v) > 3) camColliders.push({ x: F.lip.x + F.px * v + F.dx * 2, z: F.lip.z + F.pz * v + F.dz * 2, r: 3.2, y: (lipY + baseY) * 0.5 });
    }
    // dark wet boulders framing the lip and the plunge pool
    for (let k = 0; k < 10; k++) {
      const onLip = k < 4;
      const a = rng() * Math.PI * 2, rr = onLip ? 1.6 + rng() * 1.5 : F.pool.r * (0.95 + rng() * 0.35);
      const cx = onLip ? F.lip.x + F.px * (k % 2 ? 1 : -1) * (1.5 + rng() * 1.2) - F.dx * rng() : F.pool.x + Math.cos(a) * rr;
      const cz = onLip ? F.lip.z + F.pz * (k % 2 ? 1 : -1) * (1.5 + rng() * 1.2) - F.dz * rng() : F.pool.z + Math.sin(a) * rr;
      const s = 0.5 + rng() * 0.9;
      addStone(cx, hf.height(cx, cz) + s * 0.1, cz, s * 1.3, s * 0.8, s * 1.1);
    }
  }

  // ---------------------------------------------------------------- sun-bleached bones
  {
    const Bn = W.bones; const f = Bn.f; const r = [-f[1], f[0]];
    const boneMat = patch(new THREE.MeshStandardMaterial({ color: 0xd9cfbb, roughness: 0.75 }), { key: 'bone', shadowBias: 0.2,
      fColor: `{ float n = texture2D(uNoiseTex, vWPos.xz * 3.0 + vWPos.y).r; diffuseColor.rgb *= 0.78 + 0.3 * n; }` });
    const place = (m, x, z, sink, rotY = 0, rotX = 0, rotZ = 0) => { m.position.set(x, hf.height(x, z) - sink, z); m.rotation.set(rotX, rotY, rotZ); m.castShadow = true; m.receiveShadow = true; scene.add(m); };
    // horse skull: cranium + long muzzle
    const sk = lathe2([[0.001, -0.3], [0.05, -0.29], [0.07, -0.2], [0.085, -0.05], [0.11, 0.05], [0.12, 0.12], [0.1, 0.18], [0.001, 0.2]]);
    sk.rotateX(Math.PI / 2); sk.scale(1, 0.75, 1);
    const skull = new THREE.Mesh(sk, boneMat);
    // eye sockets and nasal cavity: dark insets
    const dark = patch(new THREE.MeshStandardMaterial({ color: 0x1d1810, roughness: 1 }), { key: 'dark' });
    for (const sx of [-1, 1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), dark); e.position.set(sx * 0.1, 0.03, 0.1); skull.add(e); }
    const nas = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6).scale(1, 0.6, 2), dark); nas.position.set(0, 0.035, -0.26); skull.add(nas);
    // teeth row
    for (let k = 0; k < 6; k++) { const t = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.025, 0.02), boneMat); t.position.set((k % 2 ? 1 : -1) * 0.045, -0.04, -0.15 - Math.floor(k / 2) * 0.035); skull.add(t); }
    place(skull, Bn.x + f[0] * 0.5, Bn.z + f[1] * 0.5, 0.05, Math.atan2(f[0], f[1]) + 0.9, 0.15, 0.4);
    // ribs arching out of the ground along a buried spine
    const ribs = [];
    for (let k = 0; k < 9; k++) {
      const pts = [];
      for (let i = 0; i <= 8; i++) { const a = i / 8 * Math.PI * 0.85; pts.push(new THREE.Vector3(Math.sin(a) * 0.32, Math.cos(a) * 0.36 - 0.2, 0)); }
      const tg = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.018 - k * 0.0008, 5);
      tg.translate(0, 0, k * 0.1);
      ribs.push(tg);
      const tg2 = tg.clone(); tg2.scale(-1, 1, 1); ribs.push(tg2);
    }
    for (let k = 0; k < 10; k++) { const v = new THREE.CylinderGeometry(0.03, 0.03, 0.07, 7); v.rotateX(Math.PI / 2); v.translate(0, 0.15, k * 0.1 - 0.03); ribs.push(v); }
    const rib = new THREE.Mesh(mergeGeometries(ribs.map(x => { x.deleteAttribute('uv'); return x.index ? x.toNonIndexed() : x; })), boneMat);
    place(rib, Bn.x - f[0] * 0.6 + r[0] * 0.4, Bn.z - f[1] * 0.6 + r[1] * 0.4, 0.12, Math.atan2(f[0], f[1]) - 0.6, 0.08, 0.35);
    // leg bones
    for (let k = 0; k < 2; k++) {
      const lb = new THREE.CylinderGeometry(0.022, 0.018, 0.5, 8); lb.rotateZ(Math.PI / 2);
      const kn1 = new THREE.SphereGeometry(0.04, 8, 6); kn1.translate(0.26, 0, 0);
      const kn2 = new THREE.SphereGeometry(0.035, 8, 6); kn2.translate(-0.26, 0, 0);
      const m = new THREE.Mesh(mergeGeometries([lb, kn1, kn2].map(x => { x.deleteAttribute('uv'); return x.index ? x.toNonIndexed() : x; })), boneMat);
      place(m, Bn.x + r[0] * (0.9 + k * 0.3) + f[0] * k * 0.4, Bn.z + r[1] * (0.9 + k * 0.3) + f[1] * k * 0.4, 0.025, rng() * 6.28, 0, 0.05);
    }
    colliders.push({ x: Bn.x, z: Bn.z, r: 0.8 });
  }

  // ---------------------------------------------------------------- build instanced stones
  const col = new THREE.Color();
  stonesByGeo.forEach((list, v) => {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(sgeos[v], stoneMat, list.length);
    list.forEach((s, i) => {
      dummy.position.set(s[0], s[1], s[2]); dummy.rotation.set(s[6], s[7], s[8]); dummy.scale.set(s[3], s[4], s[5]); dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix);
      col.setRGB(rng(), rng(), 0.8 + rng() * 0.3); im.setColorAt(i, col);
    });
    im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere(); scene.add(im);
  });
  out.clothMesh = cloth.build(scene);
  return out;
}

function lathe2(prof) {
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 16);
  g.computeVertexNormals();
  return g;
}
