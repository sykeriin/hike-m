import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patch, fabricTexture, leatherTexture, woodTexture, windGust, U } from './materials.js';
import { clamp, lerp, smoothstep, mulberry32 } from './noise.js';
import { loftSkinned, headGeometry, noseGeometry, hairGeometry, beanieGeometry, eyeGeometries, handGeometry, hairTexture, knitTexture } from './human.js';

const V = () => new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _a = V(), _b = V(), _c = V(), _d = V(), _e = V();

// lathe profile given as [[r, y], ...] bottom -> top
function lathe(prof, segs = 20, sx = 1, sz = 1) {
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0005), y)), segs);
  if (sx !== 1 || sz !== 1) g.scale(sx, 1, sz);
  g.computeVertexNormals();
  return g;
}
// tapered limb hanging along -Y from origin
function limb(r0, r1, len, segs = 14, sx = 1, sz = 1) {
  const p = [];
  const n = 10;
  p.push([0.0005, -len - r1 * 0.9]);
  p.push([r1 * 0.55, -len - r1 * 0.75]);
  p.push([r1 * 0.9, -len - r1 * 0.3]);
  for (let i = n; i >= 0; i--) {
    const t = i / n; const r = lerp(r0, r1, t) * (1 + 0.06 * Math.sin(t * Math.PI));
    p.push([r, -len * t]);
  }
  p.push([r0 * 0.9, r0 * 0.35]);
  p.push([r0 * 0.55, r0 * 0.75]);
  p.push([0.0005, r0 * 0.9]);
  return lathe(p, segs, sx, sz);
}

function stdMat(o, patchOpts = {}) {
  const m = new THREE.MeshStandardMaterial(o);
  return patch(m, { wet: 0.6, shadowBias: 1.4, ...patchOpts });
}

export class Hiker {
  constructor(W) {
    this.W = W;
    this.root = new THREE.Group();
    this.rng = mulberry32(5);
    this.buildMaterials();
    this.buildBody();
    this.initState();
  }

  buildMaterials() {
    const jacketTex = fabricTexture({ seed: 4, step: 3, ripstop: 24, seamsU: [0.25, 0.75], seamsV: [0.72, 0.08] });
    jacketTex.repeat.set(3, 2);
    const pantsTex = fabricTexture({ seed: 9, step: 3, seamsU: [0.5], seamsV: [0.05] });
    pantsTex.repeat.set(2, 2);
    const packTex = fabricTexture({ seed: 12, step: 4, ripstop: 16, seamsU: [0.1, 0.9], seamsV: [0.1, 0.9] });
    const wool = fabricTexture({ seed: 31, step: 6, seamsV: [0.1, 0.9] });
    wool.repeat.set(4, 1);
    const hatTex = fabricTexture({ seed: 17, step: 2, seamsV: [0.2, 0.35, 0.5, 0.65] });
    hatTex.repeat.set(4, 1);
    const flutter = { uFlutter: { value: 0 }, uFlutterPhase: { value: 0 } };
    this.flutter = flutter;
    const hemFlutter = `
      float hw = smoothstep(0.99, 0.9, position.y) * step(0.5, position.y);
      #ifdef USE_SKINNING
        hw *= step(skinIndex.x, 0.5);
      #else
        hw = 0.0;
      #endif
      transformed.x += sin(uTime * 13.0 + position.z * 30.0 + position.x * 20.0) * 0.012 * uFlutter * hw;
      transformed.z += (sin(uTime * 11.0 + position.x * 25.0) * 0.5 - 0.6) * 0.02 * uFlutter * hw;`;
    this.mJacket = stdMat({ color: 0x3c7583, map: jacketTex, roughness: 0.78, bumpMap: jacketTex, bumpScale: 1.2 },
      { uniforms: flutter, vHead: 'uniform float uFlutter;', vBegin: hemFlutter, key: 'jacket' });
    this.mSleeve = stdMat({ color: 0x3c7583, map: jacketTex, roughness: 0.78, bumpMap: jacketTex, bumpScale: 1.2 });
    this.mJacketDark = stdMat({ color: 0x264d57, map: jacketTex, roughness: 0.8, bumpMap: jacketTex, bumpScale: 1.2 });
    this.mPants = stdMat({ color: 0x5c5853, map: pantsTex, roughness: 0.9, bumpMap: pantsTex, bumpScale: 1.0 });
    this.mSkin = stdMat({ color: 0xa97d66, roughness: 0.58 }, { fLight: 'reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.06, 0.015, 0.0);' });
    this.mLips = stdMat({ color: 0xa0685c, roughness: 0.45 });
    this.mEyeWhite = stdMat({ color: 0xd8d2c8, roughness: 0.25 });
    this.mIris = stdMat({ color: 0x5a3a20, roughness: 0.12 });
    this.mPupil = stdMat({ color: 0x0a0706, roughness: 0.1 });
    this.mBrow = stdMat({ color: 0x33211a, roughness: 0.8 });
    const knit = knitTexture();
    this.mBeanie = stdMat({ color: 0xa9532f, map: knit, roughness: 0.95, bumpMap: knit, bumpScale: 2.0 });
    const hairTex = hairTexture();
    this.mHair = stdMat({ color: 0x6e4a32, map: hairTex, roughness: 0.55, side: THREE.DoubleSide }, { key: 'hair', vBegin: "\n      float hang = smoothstep(0.13, 0.04, position.y);\n      transformed.x += sin(uTime * 3.3 + position.z * 30.0) * 0.003 * hang * (0.4 + uWind);\n      transformed.z -= (0.002 + 0.004 * uWind) * hang * (1.0 + 0.5 * sin(uTime * 2.1 + position.x * 40.0));" });
    const lt = leatherTexture();
    this.mBoot = stdMat({ color: 0xffffff, map: lt, roughness: 0.72, bumpMap: lt, bumpScale: 1.4 });
    this.mSole = stdMat({ color: 0x2a2522, roughness: 0.95 });
    this.mLace = stdMat({ color: 0x9a3b24, roughness: 0.8 });
    this.mPack = stdMat({ color: 0x4d5140, map: packTex, roughness: 0.85, bumpMap: packTex, bumpScale: 1.2 });
    this.mPackDark = stdMat({ color: 0x2b2d25, map: packTex, roughness: 0.85, bumpMap: packTex, bumpScale: 1.0 });
    this.mStrap = stdMat({ color: 0x23241f, map: packTex, roughness: 0.8 });
    this.mBedroll = stdMat({ color: 0x8e3b2c, map: wool, roughness: 0.95, bumpMap: wool, bumpScale: 2.0 });
    this.mLeather = stdMat({ color: 0x5b3a22, map: lt, roughness: 0.7 });
    this.mHat = stdMat({ color: 0xb9a57e, map: hatTex, roughness: 0.9, bumpMap: hatTex, bumpScale: 1.0, side: THREE.DoubleSide },
      { uniforms: flutter, vHead: 'uniform float uFlutter;', key: 'hat',
        vBegin: `float br = smoothstep(0.1, 0.19, length(position.xz));
          transformed.y += (sin(uTime * 9.0 + atan(position.z, position.x) * 3.0) * 0.012 + 0.006) * uFlutter * br;` });
    this.mBand = stdMat({ color: 0x3a2a1c, roughness: 0.7 });
    this.mScarf = stdMat({ color: 0xc08a2c, map: wool, roughness: 0.9, side: THREE.DoubleSide });
    this.mMetal = stdMat({ color: 0x9aa0a4, roughness: 0.35, metalness: 0.9 });
    this.mGlass = stdMat({ color: 0x101418, roughness: 0.08, metalness: 0.4 });
    const wt = woodTexture(8, { base: [128, 98, 66], bleach: 0.15 });
    wt.repeat.set(1, 3);
    this.mStaff = stdMat({ color: 0xffffff, map: wt, roughness: 0.65, bumpMap: wt, bumpScale: 1.5 });
  }

  mesh(geo, mat, parent, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    parent.add(m); return m;
  }

  buildBody() {
    const R = this.root;
    // bones (plain groups driven by the IK below; the skinned clothes follow them)
    const pelvis = this.pelvis = new THREE.Group(); pelvis.position.set(0, 0.95, 0); R.add(pelvis);
    const spine = this.spine = new THREE.Group(); spine.position.set(0, 0.06, 0); pelvis.add(spine);
    const chest = this.chest = new THREE.Group(); chest.position.set(0, 0.2, 0); spine.add(chest);
    const neck = this.neck = new THREE.Group(); neck.position.set(0, 0.49, -0.004); spine.add(neck);
    const head = this.head = new THREE.Group(); head.position.set(0, 0.072, 0.014); neck.add(head);
    this.arms = [];
    for (const side of [-1, 1]) {
      const sh = new THREE.Group(); sh.position.set(side * 0.18, 0.44, -0.015); spine.add(sh);
      const up = new THREE.Group(); sh.add(up);
      const el = new THREE.Group(); el.position.set(0, -0.28, 0); up.add(el);
      const wr = new THREE.Group(); wr.position.set(0, -0.255, 0); el.add(wr);
      const hand = new THREE.Group(); wr.add(hand);
      this.buildHand(hand, side);
      this.arms.push({ side, sh, up, el, wr, hand, L1: 0.28, L2: 0.255 });
    }
    this.legs = [];
    for (const side of [-1, 1]) {
      const hip = new THREE.Group(); hip.position.set(side * 0.092, -0.05, 0); pelvis.add(hip);
      const th = new THREE.Group(); hip.add(th);
      const kn = new THREE.Group(); kn.position.set(0, -0.43, 0); th.add(kn);
      const an = new THREE.Group(); an.position.set(0, -0.415, 0); kn.add(an);
      const foot = new THREE.Group(); an.add(foot);
      this.buildBoot(foot);
      // cargo pocket on the thigh
      const cp = this.mesh(new RoundedBoxGeometry(0.03, 0.14, 0.11, 2, 0.012), this.mPants, th, side * 0.074, -0.24, 0.004);
      cp.rotation.z = side * 0.05;
      this.legs.push({ side, hip, th, kn, an, foot, L1: 0.43, L2: 0.415 });
    }
    R.updateMatrixWorld(true);

    // ---- skinned clothing and skin, authored in the rest pose (arms hanging, legs straight)
    const bones = [pelvis, spine, neck, head];
    const bi = (o) => { let i = bones.indexOf(o); if (i < 0) { bones.push(o); i = bones.length - 1; } return i; };
    const wp = (o) => o.getWorldPosition(new THREE.Vector3());
    const B_P = 0, B_S = 1, B_N = 2, B_H = 3;
    // trousers: one tube per leg, the two tops overlap to form the seat
    const legGeos = [];
    for (const L of this.legs) {
      const s = L.side, iTh = bi(L.th), iKn = bi(L.kn);
      const h = wp(L.hip); const hx = h.x;
      const Rg = (y, dx, rx, rzF, rzB, bones) => ({ y, x: hx + dx * s, z: 0, rx, rzF, rzB, bones });
      legGeos.push(loftSkinned([
        Rg(0.112, 0, 0.062, 0.064, 0.064, [[iKn, 1]]),
        Rg(0.14, 0, 0.057, 0.056, 0.06, [[iKn, 1]]),
        Rg(0.2, 0, 0.051, 0.05, 0.056, [[iKn, 1]]),
        Rg(0.28, 0, 0.054, 0.05, 0.064, [[iKn, 1]]),
        Rg(0.36, 0, 0.057, 0.053, 0.066, [[iKn, 1]]),
        Rg(0.43, 0, 0.058, 0.058, 0.059, [[iKn, 1]]),
        Rg(0.47, 0, 0.061, 0.064, 0.057, [[iKn, 0.5], [iTh, 0.5]]),
        Rg(0.51, 0, 0.063, 0.063, 0.061, [[iTh, 0.85], [iKn, 0.15]]),
        Rg(0.58, 0, 0.069, 0.067, 0.068, [[iTh, 1]]),
        Rg(0.67, -0.002, 0.077, 0.075, 0.078, [[iTh, 1]]),
        Rg(0.76, -0.006, 0.086, 0.084, 0.088, [[iTh, 0.9], [B_P, 0.1]]),
        Rg(0.83, -0.013, 0.096, 0.09, 0.1, [[iTh, 0.6], [B_P, 0.4]]),
        Rg(0.89, -0.022, 0.107, 0.096, 0.114, [[iTh, 0.3], [B_P, 0.7]]),
        Rg(0.95, -0.03, 0.115, 0.1, 0.12, [[B_P, 1]]),
        Rg(1.0, -0.036, 0.112, 0.096, 0.11, [[B_P, 1]]),
        Rg(1.05, -0.04, 0.105, 0.091, 0.1, [[B_P, 1]]),
      ], 22, { vScale: 0.45, capBottom: false }));
    }
    // jacket body + sleeves
    const J = (y, rx, rzF, rzB, bones, n = 2.2) => ({ y, x: 0, z: -0.006, rx, rzF, rzB, bones, n });
    const JR = [
      J(0.9, 0.172, 0.126, 0.14, [[B_P, 1]]),
      J(0.95, 0.166, 0.12, 0.132, [[B_P, 1]]),
      J(1.0, 0.156, 0.112, 0.12, [[B_P, 0.8], [B_S, 0.2]]),
      J(1.05, 0.152, 0.108, 0.112, [[B_P, 0.4], [B_S, 0.6]]),
      J(1.12, 0.158, 0.114, 0.112, [[B_S, 1]]),
      J(1.2, 0.168, 0.124, 0.116, [[B_S, 1]]),
      J(1.28, 0.18, 0.132, 0.12, [[B_S, 1]]),
      J(1.35, 0.19, 0.132, 0.12, [[B_S, 1]], 2.4),
      J(1.41, 0.197, 0.122, 0.116, [[B_S, 1]], 2.6),
      J(1.45, 0.194, 0.108, 0.106, [[B_S, 1]], 2.6),
      J(1.48, 0.156, 0.092, 0.095, [[B_S, 1]], 2.3),
      J(1.505, 0.102, 0.077, 0.081, [[B_S, 1]], 2.2),
      J(1.52, 0.068, 0.064, 0.068, [[B_S, 1]], 2),
    ];
    this.torsoRings = JR;
    const jacketGeos = [loftSkinned(JR, 30, { vScale: 0.5, capBottom: false })];
    for (const A of this.arms) {
      const s = A.side, iUp = bi(A.up), iEl = bi(A.el);
      const S = wp(A.sh);
      const Ar = (dy, r, bones, dx = 0) => ({ y: S.y + dy, x: S.x - dx * s, z: S.z, rx: r * 0.93, rzF: r * 0.9, rzB: r * 0.93, bones });
      jacketGeos.push(loftSkinned([
        Ar(-0.528, 0.046, [[iEl, 1]]),
        Ar(-0.5, 0.046, [[iEl, 1]]),
        Ar(-0.46, 0.041, [[iEl, 1]]),
        Ar(-0.4, 0.043, [[iEl, 1]]),
        Ar(-0.34, 0.047, [[iEl, 1]]),
        Ar(-0.3, 0.049, [[iEl, 0.7], [iUp, 0.3]]),
        Ar(-0.275, 0.05, [[iEl, 0.45], [iUp, 0.55]]),
        Ar(-0.25, 0.051, [[iUp, 0.8], [iEl, 0.2]]),
        Ar(-0.18, 0.053, [[iUp, 1]]),
        Ar(-0.1, 0.057, [[iUp, 1]]),
        Ar(-0.03, 0.061, [[iUp, 0.9], [B_S, 0.1]]),
        Ar(0.02, 0.058, [[iUp, 0.6], [B_S, 0.4]], 0.006),
        Ar(0.045, 0.045, [[iUp, 0.35], [B_S, 0.65]], 0.014),
        Ar(0.058, 0.022, [[B_S, 1]], 0.022),
      ], 18, { vScale: 0.4, capBottom: true, capTop: true }));
    }
    // neck
    const nk = wp(neck);
    const Nr = (y, r, rzF, rzB, bones) => ({ y, x: 0, z: nk.z - 0.004, rx: r, rzF, rzB, bones });
    const neckGeo = loftSkinned([
      Nr(1.49, 0.047, 0.046, 0.049, [[B_S, 1]]),
      Nr(1.54, 0.044, 0.043, 0.047, [[B_N, 1]]),
      Nr(1.59, 0.042, 0.04, 0.046, [[B_N, 0.6], [B_H, 0.4]]),
      Nr(1.625, 0.04, 0.036, 0.046, [[B_H, 1]]),
    ], 16, { vScale: 0.3 });
    const skeleton = new THREE.Skeleton(bones);
    const mkSkinned = (geo, mat) => {
      const m = new THREE.SkinnedMesh(geo, mat);
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
      R.add(m); m.bind(skeleton, new THREE.Matrix4());
      return m;
    };
    mkSkinned(mergeGeometries(legGeos), this.mPants);
    mkSkinned(mergeGeometries(jacketGeos), this.mJacket);
    mkSkinned(neckGeo, this.mSkin);
    this.skeleton = skeleton;

    // ---- rigid details riding on the bones
    // zipper following the jacket front, placket, chest pockets, collar
    {
      const pts = [[0.9, 0.126], [1.0, 0.112], [1.05, 0.108], [1.12, 0.114], [1.2, 0.124], [1.28, 0.132], [1.35, 0.132], [1.41, 0.122], [1.45, 0.108], [1.49, 0.088], [1.52, 0.068]]
        .map(([y, z]) => new THREE.Vector3(0, y - 1.01, z - 0.006 + 0.003));
      const zc = new THREE.CatmullRomCurve3(pts);
      this.mesh(new THREE.TubeGeometry(zc, 30, 0.0045, 5), this.mMetal, spine);
      this.mesh(new THREE.TubeGeometry(zc, 30, 0.009, 5).scale(1.6, 1, 0.6), this.mJacketDark, spine, 0, 0, -0.002);
    }
    // stand-up collar, open at the throat
    this.mesh(lathe([[0.07, 0.0], [0.074, 0.035], [0.073, 0.062], [0.068, 0.07]], 24, 1.1, 1.05), this.mJacket, spine, 0, 0.495, -0.008);
    // scarf wrap
    this.mesh(new THREE.TorusGeometry(0.06, 0.026, 10, 24).rotateX(Math.PI / 2), this.mScarf, neck, 0, 0.02, 0);
    this.mesh(new THREE.TorusGeometry(0.052, 0.02, 10, 24).rotateX(Math.PI / 2 + 0.2), this.mScarf, neck, 0, 0.048, 0.004);

    // ---- head: sculpted face, eyes, brows, lips, ears, hair
    this.mesh(headGeometry(), this.mSkin, head);
    const eg = eyeGeometries();
    this.mesh(eg.whites, this.mEyeWhite, head);
    this.mesh(eg.irises, this.mIris, head);
    this.mesh(eg.pupils, this.mPupil, head);
    this.mesh(eg.lids, this.mSkin, head);
    this.mesh(eg.lashes, this.mPupil, head);
    this.mesh(eg.brows, this.mBrow, head);
    this.mesh(eg.lips, this.mLips, head);
    this.mesh(hairGeometry(), this.mHair, head);

    // knit beanie with a folded cuff
    { const bg = beanieGeometry(); this.hat = this.mesh(bg.cap, this.mBeanie, head); this.mesh(bg.cuff, this.mBeanie, head); }

    // backpack on spine
    this.buildPack(spine);
    this.buildHarness(spine, pelvis);
    // staff (world-space, not parented)
    this.contact = new THREE.Group();
    {
      const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      const t = new THREE.CanvasTexture(c);
      const geo = new THREE.PlaneGeometry(0.2, 0.38); geo.rotateX(-Math.PI / 2);
      this.blobs = [0, 1].map(() => {
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: t, color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
        m.renderOrder = 1; this.contact.add(m); return m;
      });
    }
    this.staff = new THREE.Group();
    const sg = new THREE.CylinderGeometry(0.016, 0.019, 1.52, 10, 6);
    sg.translate(0, 0.76, 0);
    const pa = sg.attributes.position;
    for (let i = 0; i < pa.count; i++) { const y = pa.getY(i); pa.setX(i, pa.getX(i) + Math.sin(y * 2.3) * 0.006); pa.setZ(i, pa.getZ(i) + Math.sin(y * 1.7 + 1) * 0.005); }
    sg.computeVertexNormals();
    this.mesh(sg, this.mStaff, this.staff);
    for (const y of [0.35, 0.8, 1.42]) this.mesh(new THREE.SphereGeometry(0.02, 8, 6).scale(1, 1.6, 0.8), this.mStaff, this.staff, 0.012, y, 0);
    this.mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.2, 10), this.mLeather, this.staff, 0, 1.28, 0);
    this.mesh(new THREE.CylinderGeometry(0.018, 0.012, 0.05, 10), this.mMetal, this.staff, 0, 0.02, 0);
    this.mesh(new THREE.TorusGeometry(0.04, 0.004, 5, 16).scale(1, 1.6, 1), this.mLeather, this.staff, 0.03, 1.33, 0);
    this.STAFF_LEN = 1.52;

    // scarf tails + ponytail + dangling straps: verlet ribbons
    this.ribbons = [];
    this.addRibbon(this.neck, new THREE.Vector3(0.03, 0.03, -0.06), 8, 0.05, 0.075, this.mScarf, 0.9);
    this.addRibbon(this.neck, new THREE.Vector3(-0.02, 0.035, -0.065), 6, 0.05, 0.06, this.mScarf, 0.8);
    this.addRibbon(this.packRef, new THREE.Vector3(0.14, -0.2, 0.02), 5, 0.04, 0.022, this.mStrap, 0.5);
    this.addRibbon(this.packRef, new THREE.Vector3(-0.14, -0.2, 0.02), 5, 0.04, 0.022, this.mStrap, 0.5);
    this.addRibbon(this.packRef, new THREE.Vector3(0.16, 0.3, -0.12), 6, 0.045, 0.03, this.mScarf, 0.9);
  }

  buildHand(hand, side) {
    // the right hand (side -1) grips the staff, the left hangs relaxed
    this.mesh(handGeometry(side, side === -1), this.mSkin, hand);
    this.handFingers = this.handFingers || [];
  }

  buildBoot(foot) {
    // foot group origin at ankle; boot points +Z
    const upper = new RoundedBoxGeometry(0.105, 0.1, 0.24, 3, 0.04);
    upper.translate(0, -0.035, 0.045);
    const pa = upper.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      const z = pa.getZ(i), y = pa.getY(i);
      // taper toe, raise toe cap
      const t = smoothstep(0.05, 0.16, z);
      pa.setY(i, y - t * 0.02 * (y > -0.035 ? 1 : 0));
      pa.setX(i, pa.getX(i) * (1 - t * 0.12));
    }
    upper.computeVertexNormals();
    this.mesh(upper, this.mBoot, foot);
    // ankle cuff
    this.mesh(lathe([[0.056, -0.03], [0.058, 0.04], [0.06, 0.06]], 16, 1, 1.1), this.mBoot, foot, 0, 0, -0.01);
    // sole with lugs
    const sole = new RoundedBoxGeometry(0.104, 0.024, 0.25, 3, 0.011);
    this.mesh(sole, this.mSole, foot, 0, -0.09, 0.046);
    for (let k = 0; k < 6; k++) this.mesh(new THREE.BoxGeometry(0.086, 0.006, 0.012), this.mSole, foot, 0, -0.103, -0.058 + k * 0.04);
    // laces
    for (let k = 0; k < 5; k++) {
      const l = this.mesh(new THREE.BoxGeometry(0.06, 0.006, 0.008), this.mLace, foot, 0, 0.03 - k * 0.012, 0.05 + k * 0.018);
      l.rotation.x = -0.9; l.rotation.z = (k % 2 ? 0.25 : -0.25);
    }
    // eyelet hooks
    for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) this.mesh(new THREE.SphereGeometry(0.005, 6, 4), this.mMetal, foot, sx * 0.03, 0.035 - k * 0.022, 0.04 + k * 0.018);
  }

  buildPack(spine) {
    const pk = new THREE.Group(); pk.position.set(0, 0.25, -0.2); spine.add(pk);
    this.packRef = pk;
    this.mesh(new RoundedBoxGeometry(0.34, 0.52, 0.2, 4, 0.06), this.mPack, pk);
    // lid
    const lid = this.mesh(new RoundedBoxGeometry(0.33, 0.1, 0.22, 3, 0.04), this.mPackDark, pk, 0, 0.28, 0.005);
    lid.rotation.x = 0.08;
    // front pocket
    this.mesh(new RoundedBoxGeometry(0.26, 0.26, 0.06, 3, 0.025), this.mPackDark, pk, 0, -0.08, -0.115);
    // side pockets + bottle
    for (const sx of [-1, 1]) {
      this.mesh(new RoundedBoxGeometry(0.06, 0.18, 0.12, 2, 0.02), this.mPackDark, pk, sx * 0.18, -0.14, 0.0);
    }
    this.mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.22, 14), this.mMetal, pk, 0.2, -0.04, 0.0);
    this.mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.03, 10), this.mPackDark, pk, 0.2, 0.085, 0.0);
    // compression straps
    for (const y of [-0.05, 0.12]) this.mesh(new THREE.BoxGeometry(0.352, 0.022, 0.21), this.mStrap, pk, 0, y, 0);
    // bedroll lashed on top
    const br = new THREE.Group(); br.position.set(0, 0.4, 0.0); pk.add(br);
    const roll = new THREE.CylinderGeometry(0.085, 0.085, 0.46, 20, 1);
    roll.rotateZ(Math.PI / 2);
    this.mesh(roll, this.mBedroll, br);
    for (const sx of [-1, 1]) {
      this.mesh(new THREE.TorusGeometry(0.086, 0.004, 6, 24).rotateY(Math.PI / 2), this.mBedroll, br, sx * 0.233, 0, 0); // spiral end hint
      this.mesh(new THREE.CircleGeometry(0.083, 20).rotateY(sx * Math.PI / 2), this.mBedroll, br, sx * 0.231, 0, 0);
      this.mesh(new THREE.TorusGeometry(0.089, 0.009, 6, 24).rotateY(Math.PI / 2), this.mLeather, br, sx * 0.14, 0, 0);
      // buckle
      this.mesh(new THREE.BoxGeometry(0.02, 0.025, 0.006), this.mMetal, br, sx * 0.14, 0.02, 0.089);
    }
    // carabiner mug
    this.mug = new THREE.Group(); this.mug.position.set(-0.19, -0.26, 0.0); pk.add(this.mug);
    this.mesh(new THREE.TorusGeometry(0.014, 0.003, 5, 10), this.mMetal, this.mug, 0, 0, 0);
    this.mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.06, 12, 1, true), this.mMetal, this.mug, 0, -0.045, 0);
  }

  // Shoulder straps, sternum strap and hip belt traced over the jacket surface (rest pose) so they hug the body.
  buildHarness(spine, pelvis) {
    const TR = this.torsoRings;
    const SPY = 1.01, PLY = 0.95; // rest heights of the spine and pelvis groups
    const ringAt = (y) => {
      if (y < TR[0].y || y > TR[TR.length - 1].y) return null;
      for (let i = 0; i < TR.length - 1; i++) {
        const a = TR[i], b = TR[i + 1];
        if (y <= b.y) { const t = (y - a.y) / (b.y - a.y); return { z: lerp(a.z, b.z, t), rx: lerp(a.rx, b.rx, t), rzF: lerp(a.rzF, b.rzF, t), rzB: lerp(a.rzB, b.rzB, t), n: lerp(a.n || 2, b.n || 2, t) }; }
      }
      return null;
    };
    const inside = (p) => {
      const R = ringAt(p.y); if (!R) return false;
      const dz = p.z - R.z; const rz = dz > 0 ? R.rzF : R.rzB;
      return Math.pow(Math.abs(p.x) / R.rx, R.n) + Math.pow(Math.abs(dz) / rz, R.n) < 1;
    };
    const tmp = new THREE.Vector3();
    const onSurface = (p0, d, off) => {
      if (!inside(p0)) return p0.clone().addScaledVector(d, off);
      let a = 0, b = 0.35;
      for (let k = 0; k < 26; k++) { const m = (a + b) / 2; if (inside(tmp.copy(p0).addScaledVector(d, m))) a = m; else b = m; }
      return p0.clone().addScaledVector(d, b + off);
    };
    // flat webbing swept along a path; D = outward direction at each sample
    const sweep = (P, D, wF, thF) => {
      const n = P.length, A = [], Dn = [];
      for (let i = 0; i < n; i++) {
        const T = new THREE.Vector3().subVectors(P[Math.min(n - 1, i + 1)], P[Math.max(0, i - 1)]).normalize();
        const d = D[i].clone().addScaledVector(T, -D[i].dot(T)).normalize();
        A.push(new THREE.Vector3().crossVectors(T, d).normalize()); Dn.push(d);
      }
      const pos = [], nrm = [], idx = [];
      const corner = (i, sa, sd) => P[i].clone().addScaledVector(A[i], sa * wF(i / (n - 1)) * 0.5).addScaledVector(Dn[i], sd * thF(i / (n - 1)) * 0.5);
      const face = (sa0, sd0, sa1, sd1, nf) => {
        const base = pos.length / 3;
        for (let i = 0; i < n; i++) {
          const c0 = corner(i, sa0, sd0), c1 = corner(i, sa1, sd1), nn = nf(i);
          pos.push(c0.x, c0.y, c0.z, c1.x, c1.y, c1.z); nrm.push(nn.x, nn.y, nn.z, nn.x, nn.y, nn.z);
        }
        for (let i = 0; i < n - 1; i++) { const a = base + i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      };
      face(1, 1, -1, 1, (i) => Dn[i]);
      face(-1, -1, 1, -1, (i) => Dn[i].clone().negate());
      face(1, -1, 1, 1, (i) => A[i]);
      face(-1, 1, -1, -1, (i) => A[i].clone().negate());
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3 * 2), 2));
      g.setIndex(idx);
      return g;
    };
    const G = (x, y, z, dx, dy, dz) => ({ p: new THREE.Vector3(x, y, z), d: new THREE.Vector3(dx, dy, dz).normalize() });
    const trace = (guide, steps, off) => {
      const curve = new THREE.CatmullRomCurve3(guide.map((g) => g.p));
      const P = [], D = [];
      const N = (guide.length - 1) * steps;
      for (let k = 0; k <= N; k++) {
        const u = k / N, f = u * (guide.length - 1), i = Math.min(guide.length - 2, Math.floor(f)), t = f - i;
        const d = guide[i].d.clone().lerp(guide[i + 1].d, t).normalize();
        P.push(onSurface(curve.getPoint(u), d, off(u))); D.push(d);
      }
      return { P, D };
    };
    const toSpine = (g) => g.translate(0, -SPY, 0);
    // shoulder straps: from inside the pack, over the trapezius, down the chest, under the arm to the pack's lower corner
    const strapFront = [];
    for (const sx of [-1, 1]) {
      const guide = [
        G(sx * 0.082, 1.36, -0.05, 0, 0.0, -1),
        G(sx * 0.086, 1.43, -0.05, 0, 0.15, -1),
        G(sx * 0.09, 1.472, -0.03, 0, 0.75, -0.65),
        G(sx * 0.094, 1.488, 0.0, 0, 1, -0.05),
        G(sx * 0.097, 1.478, 0.03, 0, 0.7, 0.7),
        G(sx * 0.1, 1.44, 0.05, 0, 0.2, 1),
        G(sx * 0.1, 1.37, 0.05, 0, 0, 1),
        G(sx * 0.104, 1.3, 0.05, sx * 0.15, 0, 1),
        G(sx * 0.118, 1.23, 0.04, sx * 0.45, 0, 0.9),
        G(sx * 0.13, 1.17, 0.01, sx * 0.85, 0, 0.5),
        G(sx * 0.13, 1.12, -0.04, sx * 1, 0, -0.1),
        G(sx * 0.115, 1.085, -0.08, sx * 0.6, 0, -0.8),
      ];
      const pad = (u) => smoothstep(0.08, 0.2, u) * (1 - smoothstep(0.55, 0.72, u));
      const th = (u) => 0.006 + 0.008 * pad(u);
      const { P, D } = trace(guide, 5, (u) => 0.003 + th(u) * 0.5);
      this.mesh(toSpine(sweep(P, D, (u) => 0.03 + 0.022 * pad(u), th)), this.mStrap, spine);
      strapFront.push(P);
    }
    // sternum strap with a buckle, riding on top of the shoulder straps
    {
      const guide = [];
      for (let k = 0; k <= 6; k++) { const x = -0.1 + k / 6 * 0.2; guide.push(G(x, 1.335, 0.05, 0, 0, 1)); }
      const { P, D } = trace(guide, 3, () => 0.019);
      this.mesh(toSpine(sweep(P, D, () => 0.018, () => 0.004)), this.mStrap, spine);
      const c = P[Math.floor(P.length / 2)];
      const b = this.mesh(new RoundedBoxGeometry(0.034, 0.024, 0.01, 2, 0.004), this.mPackDark, spine, c.x, c.y - SPY, c.z + 0.004);
      b.castShadow = false;
    }
    // padded hip belt around the jacket hem (rides on the pelvis), thin webbing and a buckle at the front
    {
      const P = [], D = [];
      const N = 72; const yb = 0.957;
      const R = ringAt(yb);
      for (let k = 0; k <= N; k++) {
        const a = k / N * Math.PI * 2;
        const c = Math.cos(a), s = Math.sin(a), e = 2 / R.n;
        const x = Math.sign(c) * Math.pow(Math.abs(c), e) * R.rx, dz = Math.sign(s) * Math.pow(Math.abs(s), e) * (s > 0 ? R.rzF : R.rzB);
        const d = new THREE.Vector3(x / (R.rx * R.rx), 0, dz / Math.pow(s > 0 ? R.rzF : R.rzB, 2)).normalize();
        const front = smoothstep(0.55, 0.9, s);
        P.push(new THREE.Vector3(x, yb, R.z + dz).addScaledVector(d, 0.004 + lerp(0.008, 0.003, front))); D.push(d);
      }
      const frontU = (u) => smoothstep(0.55, 0.9, Math.sin(u * Math.PI * 2));
      const g = sweep(P, D, (u) => lerp(0.07, 0.028, frontU(u)), (u) => lerp(0.016, 0.005, frontU(u)));
      g.translate(0, -PLY, 0);
      this.mesh(g, this.mStrap, pelvis);
      const fz = R.z + R.rzF + 0.012;
      this.mesh(new RoundedBoxGeometry(0.05, 0.032, 0.012, 2, 0.005), this.mPackDark, pelvis, 0, yb - PLY, fz);
    }
  }

  addRibbon(parent, anchor, n, seg, width, mat, stiff, behindHead = false) {
    const pts = []; for (let i = 0; i < n; i++) pts.push({ p: V(), o: V() });
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2), idx = [];
    for (let i = 0; i < n; i++) { uv[i * 4] = 0; uv[i * 4 + 1] = i / (n - 1); uv[i * 4 + 2] = 1; uv[i * 4 + 3] = i / (n - 1); if (i < n - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.frustumCulled = false;
    this.ribbonGroup = this.ribbonGroup || new THREE.Group();
    this.ribbonGroup.add(m);
    this.ribbons.push({ parent, anchor, pts, seg, width, mesh: m, init: false, stiff, behindHead });
  }

  initState() {
    const W = this.W;
    this.pos = V(); this.yaw = 0; this.speed = 0; this.vel = new THREE.Vector2();
    this.trailS = 2; this.mode = 'auto'; this.idle = 0; this.grade = 0; this.cadence = 1.6; this.gust = 0.5;
    this.phase = 0; this.lean = 0; this.leanSide = 0;
    this.feet = [0, 1].map(i => ({ p: V(), from: V(), to: V(), swing: false, surf: 0, slip: 0 }));
    this.staffTip = V(); this.staffFrom = V(); this.staffTo = V(); this.staffPlanted = true;
    this.slip = 0; this.stumble = 0; this.restT = 0; this.restDone = {};
    this.look = new THREE.Vector2();
    this.onStep = null;
    this.colliders = [];
    this.reset();
  }

  reset() {
    const W = this.W;
    this.trailS = 1.5;
    const a = W.trail.at(this.trailS);
    this.pos.set(a.x, W.ground(a.x, a.z), a.z);
    this.yaw = Math.atan2(a.tx, a.tz);
    this.speed = 0.6; this.phase = 0;
    this.restDone = {};
    this.updateMatrices(0, true);
  }

  groundN(x, z, out) { return this.W.hf.normal(x, z, 0.35, out); }

  surfaceAt(x, z) {
    const m = this.W.maskAt(x, z);
    return { scree: m[1], trail: m[4], grass: m[0] };
  }

  // ------------------------------------------------------------------ control / locomotion
  update(dt, input, camYaw, time, focusCb) {
    const W = this.W;
    dt = Math.min(dt, 0.05);
    const mv = input.move;
    let manual = mv.lengthSq() > 0.01;
    if (manual) { this.mode = 'manual'; this.idle = 0; } else { this.idle += dt; if (this.mode === 'manual' && this.idle > 5) this.mode = 'auto'; }
    let desDir = null, desSpeed = 0;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    if (this.mode === 'manual') {
      if (manual) {
        const cs = Math.cos(camYaw), sn = Math.sin(camYaw);
        // camera forward = (sin(camYaw), cos(camYaw)) in xz
        const dx = mv.y * sn + mv.x * -cs, dz = mv.y * cs + mv.x * sn;
        const l = Math.hypot(dx, dz); desDir = [dx / l, dz / l]; desSpeed = 1.95 * Math.min(1, mv.length());
      }
      // keep trail param in sync for when autopilot resumes
      const q = W.trail.near(this.pos.x, this.pos.z, 30);
      if (q) this.trailS = Math.max(0, Math.min(W.trail.len, q.s));
    } else {
      // autopilot follows the trail
      const q = W.trail.near(this.pos.x, this.pos.z, 40);
      if (q && Math.abs(q.s - this.trailS) < 25) this.trailS = Math.max(this.trailS, q.s);
      else if (q) this.trailS = q.s;
      const look = W.trail.at(Math.min(W.trail.len, this.trailS + 2.2));
      let dx = look.x - this.pos.x, dz = look.z - this.pos.z; const l = Math.hypot(dx, dz) || 1;
      desDir = [dx / l, dz / l]; desSpeed = 1.78;
      // rest stops
      for (const [name, s0, dur] of this.stops || []) {
        if (!this.restDone[name] && this.trailS > s0 && this.trailS < s0 + 4) { this.restT = dur; this.restDone[name] = true; this.restName = name; }
      }
    }
    if (this.restT > 0) { this.restT -= dt; desSpeed = 0; if (manual) this.restT = 0; }
    // slope-aware pacing
    let grade = 0;
    if (desDir) {
      const h0 = W.ground(this.pos.x, this.pos.z), h1 = W.ground(this.pos.x + desDir[0] * 1.2, this.pos.z + desDir[1] * 1.2);
      grade = (h1 - h0) / 1.2;
      if (grade > 0) desSpeed *= clamp(1 - grade * 1.55, 0.38, 1);
      else desSpeed *= clamp(1 + Math.min(-grade, 0.22) * 0.9 - Math.max(0, -grade - 0.3) * 1.5, 0.5, 1.2);
      const surf = this.surfaceAt(this.pos.x, this.pos.z);
      desSpeed *= 1 - surf.scree * 0.16;
      // headwind
      const wd = U.uWindDir.value;
      const head = -(desDir[0] * wd.x + desDir[1] * wd.y);
      desSpeed *= 1 - Math.max(0, head) * 0.12 * U.uWind.value;
      // steep terrain barrier for manual
      if (this.mode === 'manual' && Math.abs(grade) > 0.9) desSpeed *= 0.2;
    }
    this.grade = lerp(this.grade || 0, grade, 1 - Math.exp(-dt * 4));
    if (this.slip > 0) desSpeed *= 0.35;
    if (this.stumble > 0) desSpeed *= 0.6;
    // momentum
    const acc = desSpeed > this.speed ? 1.6 : 2.6;
    this.speed += clamp(desSpeed - this.speed, -acc * dt, acc * dt);
    if (desDir) {
      const dy = Math.atan2(desDir[0], desDir[1]);
      let d = dy - this.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      const maxTurn = (this.mode === 'auto' ? 1.6 : 2.6) * dt;
      this.yaw += clamp(d, -maxTurn, maxTurn);
      if (Math.abs(d) > 1.2) this.speed *= 1 - dt * 2;
    }
    const nfx = Math.sin(this.yaw), nfz = Math.cos(this.yaw);
    let nx = this.pos.x + nfx * this.speed * dt, nz = this.pos.z + nfz * this.speed * dt;
    // collisions (rocks, landmarks, water)
    for (const c of this.colliders) {
      let cx = c.x, cz = c.z;
      if (c.seg) {
        const [ax, az, bx, bz] = c.seg; const ux = bx - ax, uz = bz - az; const l2 = ux * ux + uz * uz || 1e-6;
        const t = clamp(((nx - ax) * ux + (nz - az) * uz) / l2, 0, 1); cx = ax + ux * t; cz = az + uz * t;
      }
      const dx = nx - cx, dz = nz - cz; const d = Math.hypot(dx, dz);
      const R = c.r + (c.seg ? 0.26 : 0.35);
      if (d < R && d > 1e-4) { const push = R - d; nx += dx / d * push; nz += dz / d * push; }
    }
    const e = W.tarnEllipse(nx, nz);
    if (e < 1.15) { const e0 = W.tarnEllipse(this.pos.x, this.pos.z); if (e0 > e) { nx = this.pos.x; nz = this.pos.z; } }
    const lim = 500;
    nx = clamp(nx, -lim, lim); nz = clamp(nz, -lim, lim);
    const moved = Math.hypot(nx - this.pos.x, nz - this.pos.z);
    this.pos.x = nx; this.pos.z = nz;
    this.pos.y = W.ground(nx, nz);
    this.actualSpeed = moved / Math.max(dt, 1e-4);
    // loop end
    this.atEnd = this.mode === 'auto' && this.trailS > W.trail.len - 6;
    this.updateGait(dt, time);
    this.updateMatrices(dt, false, time);
  }

  updateGait(dt, time) {
    const sp = this.speed;
    const moving = sp > 0.06;
    const cadence = 1.3 + 0.48 * sp; // steps per sec (shorter, quicker steps as the pace rises)
    const anySwing = this.feet[0].swing || this.feet[1].swing;
    if (moving || anySwing || !this.settled) this.phase = (this.phase + dt * cadence * 0.5) % 1;
    if (!moving && !anySwing) {
      // settle when a foot is about to lift
      const pL = this.phase, pR = (this.phase + 0.5) % 1;
      const near = (p) => p > 0.55 && p < 0.62;
      this.settled = !(near(pL) || near(pR)) ? this.settled : true;
      if (this.settled) { this.phase = this.phase % 0.5 < 0.25 ? this.phase : this.phase; }
    } else this.settled = false;
    this.cadence = cadence;
    this.stumble = Math.max(0, this.stumble - dt);
    this.slip = Math.max(0, this.slip - dt);
  }

  // ------------------------------------------------------------------ pose
  updateMatrices(dt, snap, time = 0) {
    const W = this.W;
    const fwd = _a.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    // model local: +Z forward; local +X (the hiker's left) maps to (cos yaw, 0, -sin yaw)
    const lx = Math.cos(this.yaw), lz = -Math.sin(this.yaw);
    const sp = this.speed;
    const moving = sp > 0.06;
    const walkK = smoothstep(0.05, 0.6, sp);
    const stanceFrac = 0.62;
    const cadence = this.cadence || 1.6;
    const cyc = cadence * 0.5;
    const stanceTime = stanceFrac / cyc;
    const swingTime = (1 - stanceFrac) / cyc;
    // the heel lands a little ahead of the hip and leaves further behind (the heel-off lets the leg reach back)
    const stepAhead = sp * stanceTime * 0.38;
    const surfHere = this.surfaceAt(this.pos.x, this.pos.z);
    // ---- feet: base (flat-foot) ankle position f.p, display ankle f.d after heel/ball roll
    const n = [0, 1, 0];
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const side = i === 0 ? -1 : 1; // -1 = model local -X = the hiker's right
      const p = (this.phase + i * 0.5) % 1;
      const lat = 0.078 * side;
      const bx = this.pos.x + lx * lat, bz = this.pos.z + lz * lat;
      if (!f.d) { f.d = V(); f.pitch = 0; f.pitch0 = 0; }
      if (snap) {
        const off = (i === 0 ? 0.1 : -0.1);
        f.p.set(bx + fwd.x * off, 0, bz + fwd.z * off); f.p.y = W.ground(f.p.x, f.p.z) + 0.105; f.swing = false; f.pitch = 0;
        f.d.copy(f.p); continue;
      }
      const inSwing = p >= stanceFrac;
      if (inSwing && !f.swing && (moving || !this.settled)) { f.swing = true; f.from.copy(f.p); f.pitch0 = f.pitch; }
      if (f.swing) {
        const t = inSwing ? clamp((p - stanceFrac) / (1 - stanceFrac), 0, 1) : 1;
        const remain = (1 - t) * swingTime;
        const tx = bx + fwd.x * (sp * remain + stepAhead), tz = bz + fwd.z * (sp * remain + stepAhead);
        f.to.set(tx, W.ground(tx, tz) + 0.105, tz);
        // the foot accelerates through the middle of the swing
        const s = t * t * t * (t * (t * 6 - 15) + 10);
        f.p.lerpVectors(f.from, f.to, s);
        const lift = (0.055 + 0.035 * Math.min(sp, 1.4) + surfHere.scree * 0.04) * Math.sin(Math.PI * Math.pow(t, 0.7));
        f.p.y = lerp(f.from.y, f.to.y, s) + lift;
        const gmin = W.ground(f.p.x, f.p.z) + 0.105;
        if (f.p.y < gmin) f.p.y = gmin;
        f.t = t;
        // toes stay pointed down after push-off, level out mid-swing, lift for the heel strike
        f.pitch = t < 0.45 ? lerp(f.pitch0, 0.04, smoothstep(0.0, 0.45, t)) : lerp(0.04, 0.24 * walkK, smoothstep(0.55, 1.0, t));
        if (!inSwing || (!moving && t > 0.98)) {
          f.swing = false; f.p.copy(f.to);
          // footfall
          const surf = this.surfaceAt(f.p.x, f.p.z);
          f.surf = surf.scree;
          if (this.onStep) this.onStep(f.p, surf, sp);
          // scree slip / stumble
          if (surf.scree > 0.45 && this.rng() < 0.09 && sp > 0.3) { this.slip = 0.7; f.slipV = V().set(-fwd.x * 0.11, 0, -fwd.z * 0.11); f.slipT = 0.25; }
          else if ((surf.scree > 0.3 || surf.trail < 0.3) && this.rng() < 0.018 && sp > 0.5) { this.stumble = 0.9; }
        }
      } else {
        // planted: apply slip slide
        if (f.slipT > 0) {
          const k = Math.min(dt, f.slipT) / 0.25; f.slipT -= dt;
          f.p.x += f.slipV.x * k; f.p.z += f.slipV.z * k; f.p.y = W.ground(f.p.x, f.p.z) + 0.105;
        }
        // heel strike rolls flat, then the heel peels off before push-off
        const u = clamp(p / stanceFrac, 0, 1);
        const target = moving ? (u < 0.15 ? lerp(0.24 * walkK, 0, smoothstep(0.0, 0.15, u)) : -0.6 * walkK * smoothstep(0.58, 1.0, u)) : 0;
        f.pitch = lerp(f.pitch, target, 1 - Math.exp(-dt * 40));
      }
      // roll about the heel (toe up) or the ball of the foot (heel up): move the ankle accordingly
      const a = f.pitch; f.d.copy(f.p);
      if (a < 0) { const b = -a; const dz = 0.13 * (1 - Math.cos(b)) + 0.105 * Math.sin(b), dy = 0.13 * Math.sin(b) + 0.105 * (Math.cos(b) - 1); f.d.x += fwd.x * dz; f.d.z += fwd.z * dz; f.d.y += dy; }
      else if (a > 0) { const dz = 0.075 * (Math.cos(a) - 1) - 0.105 * Math.sin(a), dy = 0.075 * Math.sin(a) + 0.105 * (Math.cos(a) - 1); f.d.x += fwd.x * dz; f.d.z += fwd.z * dz; f.d.y += dy; }
    }
    // ---- pelvis: highest over mid-stance, dips at double support; shifts over the stance foot
    const ph = this.phase * Math.PI * 2;
    const TAU = Math.PI * 2;
    const bob = 0.011 * Math.cos(2 * (ph - 0.31 * TAU)) * walkK;
    const gAvg = (this.feet[0].p.y + this.feet[1].p.y) * 0.5 - 0.105;
    const gBody = W.ground(this.pos.x, this.pos.z);
    let py = Math.min(gBody, gAvg + 0.06) + 0.99 + bob - this.slip * 0.07 - Math.min(0.05, Math.abs(this.grade) * 0.08);
    // never further than the legs can reach (smooth min so the dip at double support has no kink)
    const smin = (a, b, k) => { const hh = clamp(0.5 + 0.5 * (b - a) / k, 0, 1); return lerp(b, a, hh) - k * hh * (1 - hh); };
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i]; const side = i === 0 ? -1 : 1;
      const hx = this.pos.x + lx * 0.092 * side, hz = this.pos.z + lz * 0.092 * side;
      const hd = Math.hypot(f.d.x - hx, f.d.z - hz);
      const maxL = 0.43 + 0.415 - 0.012;
      const maxY = f.d.y + Math.sqrt(Math.max(0.01, maxL * maxL - hd * hd)) + 0.05;
      py = smin(py, maxY, 0.035);
    }
    const sway = -0.022 * Math.sin(ph - 0.06 * TAU) * walkK;
    this.root.position.set(this.pos.x, 0, this.pos.z);
    this.root.rotation.set(0, this.yaw, 0);
    this.pelvis.position.set(sway, py, 0);
    const targetLean = 0.03 + clamp(this.grade, -0.3, 0.5) * 0.32 + sp * 0.022 + U.uWind.value * 0.02 + (this.stumble > 0 ? Math.sin((0.9 - this.stumble) / 0.9 * Math.PI) * 0.3 : 0);
    this.lean = snap ? targetLean : lerp(this.lean, targetLean, 1 - Math.exp(-dt * 5));
    const tilt = 0.025 + this.grade * 0.05;
    // hips turn with the swinging leg, shoulders counter-rotate
    this.pelvis.rotation.set(tilt, 0.075 * Math.cos(ph) * walkK, sway * 1.3 + this.slip * 0.1 * Math.sin(time * 20));
    this.spine.rotation.set(this.lean, -0.12 * Math.cos(ph) * walkK, -sway * 1.6);
    // head: level gaze toward the trail, looking around now and then
    const lookYaw = Math.sin(time * 0.23) * 0.35 + Math.sin(time * 0.071) * 0.3 + this.look.x;
    this.neck.rotation.set(-this.lean * 0.85 - tilt * 0.5 + 0.07 + Math.sin(ph * 2) * 0.01 * walkK + this.look.y, lookYaw * (this.restT > 0 ? 1.4 : 0.5), 0);
    this.root.updateMatrixWorld(true);

    // ---- leg IK
    for (let i = 0; i < 2; i++) {
      const L = this.legs[i], f = this.feet[i];
      L.hip.getWorldPosition(_c);
      this.solve2(L.hip, L.th, L.kn, _c, f.d, L.L1, L.L2, fwd, 0.06 * L.side, lx, lz);
      // foot: follows the ground, slight toe-out, pitched by the heel/ball roll
      this.groundN(f.d.x, f.d.z, n);
      const toeOut = _e.copy(fwd).applyAxisAngle(_d.set(0, 1, 0), L.side * 0.07);
      this.orientFoot(L.foot, n, toeOut.clone(), f.pitch);
    }
    // ---- staff: planted with left foot strike, in right hand (model local -X side is left)
    const right0 = V().set(-lx, 0, -lz);
    const phS = (this.phase + 0.5) % 1; // planted with the left foot strike (diagonal gait)
    const plant = phS < 0.5 || sp < 0.06;
    const tipAhead = sp * stanceTime * 0.45 + 0.28;
    if (snap) {
      this.staffTip.set(this.pos.x + fwd.x * 0.3 + right0.x * 0.27, 0, this.pos.z + fwd.z * 0.3 + right0.z * 0.27);
      this.staffTip.y = W.ground(this.staffTip.x, this.staffTip.z);
      this.staffPlanted = true;
    } else if (plant) {
      if (!this.staffPlanted) { this.staffPlanted = true; }
      // keep planted but release if too far from hand (standing still: reposition slowly)
      if (sp < 0.06) {
        const tx = this.pos.x + fwd.x * 0.28 + right0.x * 0.27, tz = this.pos.z + fwd.z * 0.28 + right0.z * 0.27;
        this.staffTip.x = lerp(this.staffTip.x, tx, 1 - Math.exp(-dt * 2)); this.staffTip.z = lerp(this.staffTip.z, tz, 1 - Math.exp(-dt * 2));
        this.staffTip.y = W.ground(this.staffTip.x, this.staffTip.z);
      }
    } else {
      if (this.staffPlanted) { this.staffPlanted = false; this.staffFrom.copy(this.staffTip); }
      const t = clamp((phS - 0.5) / 0.5, 0, 1);
      const remain = (1 - t) * (0.5 / (cadence * 0.5));
      const tx = this.pos.x + fwd.x * (sp * remain + tipAhead) + right0.x * 0.27;
      const tz = this.pos.z + fwd.z * (sp * remain + tipAhead) + right0.z * 0.27;
      this.staffTo.set(tx, W.ground(tx, tz), tz);
      const s = t * t * (3 - 2 * t);
      this.staffTip.lerpVectors(this.staffFrom, this.staffTo, s);
      this.staffTip.y = Math.max(lerp(this.staffFrom.y, this.staffTo.y, s) + Math.sin(Math.PI * t) * 0.14, W.ground(this.staffTip.x, this.staffTip.z) + 0.02);
    }
    // right hand grip position (shoulder-relative), follow the staff
    const armR = this.arms[0].side === -1 ? this.arms[0] : this.arms[1];
    const armL = armR === this.arms[0] ? this.arms[1] : this.arms[0];
    armR.sh.getWorldPosition(_c);
    const grip = V().copy(_c).addScaledVector(fwd, 0.2 + (this.staffPlanted ? 0.0 : 0.06)).addScaledVector(right0, 0.13);
    grip.y -= 0.36 - this.grade * 0.08;
    // keep grip on the staff line with at least 1.0m of staff below hand
    const sdir = V().subVectors(grip, this.staffTip);
    let glen = sdir.length(); sdir.divideScalar(glen);
    if (glen > this.STAFF_LEN - 0.12) { glen = this.STAFF_LEN - 0.12; grip.copy(this.staffTip).addScaledVector(sdir, glen); }
    if (glen < 0.95) { glen = 0.95; grip.copy(this.staffTip).addScaledVector(sdir, glen); }
    this.staff.position.copy(this.staffTip);
    _q.setFromUnitVectors(_e.set(0, 1, 0), sdir);
    this.staff.quaternion.copy(_q);
    // right arm IK to the wrist so the fist (0.1m beyond the wrist) wraps the staff at the grip point
    const yv = fwd.clone().negate(); yv.addScaledVector(sdir, -yv.dot(sdir)).normalize();
    const wristT = grip.clone().addScaledVector(yv, 0.1);
    this.solve2(armR.sh, armR.up, armR.el, _c, wristT, armR.L1, armR.L2, V().set(-fwd.x * 0.6 + right0.x * 0.6, -0.4, -fwd.z * 0.6 + right0.z * 0.6).normalize(), 0, lx, lz, true);
    // hand orientation: grip axis (local Z) along staff
    this.orientHand(armR.hand, sdir, fwd);
    // left arm: natural swing (+ balance when slipping)
    // forward with the opposite leg, a touch after its heel strike; swings further forward than back
    let swingA = Math.cos(ph - 0.25) * 0.3 * walkK * Math.min(1, sp + 0.25);
    if (swingA < 0) swingA *= 0.7;
    armL.sh.getWorldPosition(_c);
    const bal = this.slip > 0 ? 0.35 : 0;
    const lh = V().copy(_c).addScaledVector(fwd, 0.04 + swingA * 0.4).addScaledVector(right0, -0.075 - bal * 0.4);
    lh.y -= 0.49 - Math.abs(swingA) * 0.08 - bal * 0.35;
    this.solve2(armL.sh, armL.up, armL.el, _c, lh, armL.L1, armL.L2, V().set(-fwd.x * 0.6 - right0.x * 0.5, -0.3, -fwd.z * 0.6 - right0.z * 0.5).normalize(), 0, lx, lz, true);
    // relaxed hand: knuckles down (a little forward on the forward swing), thumb leading
    this.orientHand(armL.hand, fwd, V().set(fwd.x * (0.2 + swingA * 0.6), -1, fwd.z * (0.2 + swingA * 0.6)).normalize());
    this.root.updateMatrixWorld(true);
    // cloth flutter
    const g = windGust(this.pos.x, this.pos.z, U.uTime.value);
    this.gust = g;
    this.flutter.uFlutter.value = U.uWind.value * (0.4 + g);
    this.updateRibbons(dt, snap);
    // contact shadows follow the feet and fade as they lift
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i], b = this.blobs[i];
      const cx = f.d.x + fwd.x * 0.04, cz = f.d.z + fwd.z * 0.04;
      const gy = W.ground(cx, cz);
      const lift = Math.max(0, f.d.y - 0.105 - gy);
      b.position.set(cx, gy + 0.01, cz);
      this.groundN(cx, cz, n);
      _q.setFromUnitVectors(_e.set(0, 1, 0), _d.set(n[0], n[1], n[2]));
      _q2.setFromAxisAngle(_e.set(0, 1, 0), this.yaw);
      b.quaternion.copy(_q).multiply(_q2);
      b.material.opacity = 0.55 * (1 - smoothstep(0.0, 0.14, lift));
      b.scale.setScalar(1 + lift * 2.5);
    }
    // mug dangle
    this.mug.rotation.z = Math.sin(time * 7) * 0.15 * sp + Math.sin(time * 3.3) * 0.05;
    this.mug.rotation.x = Math.sin(time * 5.1 + 1) * 0.1 * sp;
  }

  // two-bone IK: upper/lower groups; parent = joint group whose world pos is root position
  solve2(joint, upper, lowerJoint, rootW, target, L1, L2, poleDir, outward, lx, lz, isArm = false) {
    const d = _d.subVectors(target, rootW);
    let dist = d.length();
    const maxD = L1 + L2 - 0.002;
    if (dist > maxD) { d.multiplyScalar(maxD / dist); dist = maxD; }
    if (dist < 0.05) dist = 0.05;
    const dir = d.clone().normalize();
    const a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist);
    const hgt = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    let pole = poleDir.clone();
    if (!isArm) pole.set(poleDir.x + lx * outward, poleDir.y, poleDir.z + lz * outward);
    pole.addScaledVector(dir, -pole.dot(dir));
    if (pole.lengthSq() < 1e-6) pole.set(0, 0, 1);
    pole.normalize();
    const knee = rootW.clone().addScaledVector(dir, a).addScaledVector(pole, hgt);
    const endW = rootW.clone().add(d);
    this.aim(upper, V().subVectors(knee, rootW).normalize(), pole);
    upper.updateMatrixWorld(true);
    this.aim(lowerJoint, V().subVectors(endW, knee).normalize(), pole);
    lowerJoint.updateMatrixWorld(true);
  }
  // rotate bone so its local -Y points along dirW and local +Z toward hint
  aim(bone, dirW, hint) {
    const y = _e.copy(dirW).negate();
    const z = hint.clone().addScaledVector(y, -hint.dot(y));
    if (z.lengthSq() < 1e-6) z.set(0, 0, 1);
    z.normalize();
    const x = new THREE.Vector3().crossVectors(y, z);
    _m.makeBasis(x, y, z);
    _q.setFromRotationMatrix(_m);
    bone.parent.getWorldQuaternion(_q2);
    bone.quaternion.copy(_q2.invert().multiply(_q));
  }
  orientFoot(foot, n, fwd, pitch) {
    const up = new THREE.Vector3(n[0], n[1], n[2]);
    const f = fwd.clone().addScaledVector(up, -fwd.dot(up)).normalize();
    f.applyAxisAngle(new THREE.Vector3().crossVectors(up, f).normalize(), -pitch);
    const x = new THREE.Vector3().crossVectors(up, f).normalize();
    const y = new THREE.Vector3().crossVectors(f, x);
    _m.makeBasis(x, y, f);
    _q.setFromRotationMatrix(_m);
    foot.parent.getWorldQuaternion(_q2);
    foot.quaternion.copy(_q2.invert().multiply(_q));
  }
  orientHand(hand, axis, fwd) {
    // local Z = grip axis, local -Y = away from wrist toward knuckles (roughly fwd)
    const z = axis.clone().normalize();
    let yv = fwd.clone().negate();
    yv.addScaledVector(z, -yv.dot(z));
    if (yv.lengthSq() < 1e-5) yv.set(0, 1, 0);
    yv.normalize();
    const x = new THREE.Vector3().crossVectors(yv, z);
    _m.makeBasis(x, yv, z);
    _q.setFromRotationMatrix(_m);
    hand.parent.getWorldQuaternion(_q2);
    const target = _q2.clone().invert().multiply(_q);
    hand.quaternion.copy(target);
  }

  updateRibbons(dt, snap) {
    const wd = U.uWindDir.value, wind = U.uWind.value * (0.5 + (this.gust || 0.5));
    const time = U.uTime.value;
    const grav = -9.8;
    for (const r of this.ribbons) {
      const a = r.anchor.clone(); r.parent.localToWorld(a);
      const pts = r.pts;
      if (!r.init || snap) { for (let i = 0; i < pts.length; i++) { pts[i].p.copy(a).y -= i * r.seg; pts[i].o.copy(pts[i].p); } r.init = true; }
      const sdt = Math.min(dt, 1 / 30);
      for (let i = 1; i < pts.length; i++) {
        const P = pts[i];
        const vx = (P.p.x - P.o.x) * 0.96, vy = (P.p.y - P.o.y) * 0.96, vz = (P.p.z - P.o.z) * 0.96;
        P.o.copy(P.p);
        const flap = Math.sin(time * 14 + i * 1.3) * 0.6 + Math.sin(time * 23 + i) * 0.3;
        const ax = wd.x * wind * 7 * r.stiff + flap * 2.0 * wind;
        const az = wd.y * wind * 7 * r.stiff + flap * 1.5 * wind;
        P.p.x += vx + ax * sdt * sdt; P.p.y += vy + (grav * (1.2 - r.stiff * 0.4) + flap * 3 * wind) * sdt * sdt; P.p.z += vz + az * sdt * sdt;
      }
      for (let it = 0; it < 3; it++) {
        pts[0].p.copy(a);
        for (let i = 1; i < pts.length; i++) {
          const A = pts[i - 1].p, B = pts[i].p;
          const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z; const d = Math.hypot(dx, dy, dz) || 1e-5;
          const k = (d - r.seg) / d;
          if (i === 1) { B.x -= dx * k; B.y -= dy * k; B.z -= dz * k; }
          else { A.x += dx * k * 0.5; A.y += dy * k * 0.5; A.z += dz * k * 0.5; B.x -= dx * k * 0.5; B.y -= dy * k * 0.5; B.z -= dz * k * 0.5; }
        }
        // keep head/neck ribbons behind the face plane and outside the head
        if (r.behindHead) {
          const hc = new THREE.Vector3(0, 0.12, 0); this.head.localToWorld(hc);
          const hf = new THREE.Vector3(0, 0, 1).applyQuaternion(this.head.getWorldQuaternion(new THREE.Quaternion()));
          for (let i = 1; i < pts.length; i++) {
            const P = pts[i].p;
            const fd = (P.x - hc.x) * hf.x + (P.y - hc.y) * hf.y + (P.z - hc.z) * hf.z;
            if (fd > -0.06) P.addScaledVector(hf, -0.06 - fd);
            const dx = P.x - hc.x, dy = P.y - hc.y, dz = P.z - hc.z; const dd = Math.hypot(dx, dy, dz);
            if (dd < 0.13) { const k = 0.13 / (dd || 1); P.set(hc.x + dx * k, hc.y + dy * k, hc.z + dz * k); }
          }
        }
        // keep off the body: push out of torso capsule
        this.spine.getWorldPosition(_c);
        for (let i = 1; i < pts.length; i++) {
          const P = pts[i].p;
          const dx = P.x - _c.x, dz = P.z - _c.z; const d = Math.hypot(dx, dz);
          const rr = 0.2;
          if (P.y > _c.y - 0.2 && P.y < _c.y + 0.75 && d < rr) { P.x = _c.x + dx / (d || 1) * rr; P.z = _c.z + dz / (d || 1) * rr; }
          const gy = this.W.ground(P.x, P.z) + 0.02; if (P.y < gy) P.y = gy;
        }
      }
      // build ribbon geometry
      const pos = r.mesh.geometry.attributes.position;
      for (let i = 0; i < pts.length; i++) {
        const P = pts[i].p;
        const nxt = pts[Math.min(pts.length - 1, i + 1)].p, prv = pts[Math.max(0, i - 1)].p;
        const tx = nxt.x - prv.x, ty = nxt.y - prv.y, tz = nxt.z - prv.z;
        // width across: perpendicular to tangent and wind-ish up
        let sx = ty * 0 - tz * 1, sy = tz * 0 - tx * 0, sz = tx * 1 - ty * 0;
        sx = -tz; sy = 0; sz = tx;
        const l = Math.hypot(sx, sy, sz) || 1; const w = r.width * 0.5 * (1 - i / pts.length * 0.3);
        sx = sx / l * w; sz = sz / l * w;
        pos.setXYZ(i * 2, P.x - sx, P.y, P.z - sz);
        pos.setXYZ(i * 2 + 1, P.x + sx, P.y, P.z + sz);
      }
      pos.needsUpdate = true;
      r.mesh.geometry.computeVertexNormals();
      r.mesh.geometry.computeBoundingSphere();
    }
  }
}
