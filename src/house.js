import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patch, woodTexture, fabricTexture, U, GLSL_COMMON } from './materials.js';
import { mulberry32, clamp, lerp, smoothstep } from './noise.js';

// Cozy log cabin at the end of the trail: fenced yard, swings, and a furnished interior.
// Everything is built in house-local space (floor at y = 0, front door facing +z).
export function buildHouse(W, scene, colliders, camColliders) {
  const Hs = W.house;
  const rng = mulberry32(4242);
  const root = new THREE.Group();
  root.position.set(Hs.x, Hs.floorH, Hs.z);
  root.rotation.y = Hs.rot;
  scene.add(root);
  root.updateMatrixWorld();
  const HX = Hs.hx, HZ = Hs.hz, WH = 2.5, T = 0.22;
  const out = { root, doors: [], dyn: [], occluders: [] };

  // interior lighting model: fragments inside the footprint get far less sky light
  const houseU = { uHouse: { value: new THREE.Vector4(Hs.x, Hs.z, Hs.xA[0], Hs.xA[1]) }, uHouseH: { value: new THREE.Vector4(HX, HZ, Hs.floorH, Hs.floorH + WH) }, uLamp: { value: 0 } };
  const INSIDE = `
    float houseInside(vec3 wp){
      vec2 d = wp.xz - uHouse.xy;
      float lx = d.x * uHouse.z + d.y * uHouse.w;
      float lz = d.x * -uHouse.w + d.y * uHouse.z;
      float inX = 1.0 - smoothstep(uHouseH.x - 0.16, uHouseH.x - 0.08, abs(lx));
      float inZ = 1.0 - smoothstep(uHouseH.y - 0.16, uHouseH.y - 0.08, abs(lz));
      float inY = step(uHouseH.z - 0.2, wp.y) * step(wp.y, uHouseH.w + 0.02);
      return inX * inZ * inY;
    }`;
  const mat = (o, extra = {}) => {
    const m = new THREE.MeshStandardMaterial(o);
    patch(m, {
      shadowBias: 0.2, key: (extra.fColor || extra.bump || extra.fLight) ? (extra.key || 'house') : 'housebasic', sharedKey: !(extra.fColor || extra.bump || extra.fLight), uniforms: houseU, noTerrainShadow: false,
      fHead: 'uniform vec4 uHouse; uniform vec4 uHouseH; uniform float uLamp;' + INSIDE + (extra.fHead || ''),
      fColor: extra.fColor || '',
      fLight: `{ float hin = houseInside(vWPos);
        reflectedLight.indirectDiffuse *= mix(1.0, 0.6, hin); reflectedLight.indirectSpecular *= mix(1.0, 0.35, hin);
        // warm lamplight bounce keeps the room readable and cosy
        reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(1.0, 0.86, 0.68) * uLamp * 0.34 * hin; }` + (extra.fLight || ''),
      bump: extra.bump,
    });
    return m;
  };
  // ---------------------------------------------------------------- materials
  const logs = mat({ color: 0xffffff, roughness: 0.85 }, { key: 'hlogs', bump: 1.0, fColor: `{
    vec2 d = vWPos.xz - uHouse.xy;
    float lx = d.x * uHouse.z + d.y * uHouse.w, lz = d.x * -uHouse.w + d.y * uHouse.z;
    float along = abs(vWNrm.x * uHouse.z + vWNrm.z * uHouse.w) > 0.7 ? lz : lx;
    float y = vWPos.y - uHouseH.z;
    float band = fract(y / 0.24);
    float round = sin(band * 3.14159);
    float gap = smoothstep(0.06, 0.0, band) + smoothstep(0.94, 1.0, band);
    float grain = texture2D(uNoiseTex, vec2(along * 0.35, y * 4.0 + floor(y / 0.24) * 0.37)).r;
    float knots = smoothstep(0.78, 0.84, texture2D(uNoiseTex, vec2(along * 0.9, floor(y / 0.24) * 0.31)).g);
    vec3 wood = pow(vec3(0.74, 0.55, 0.36), vec3(2.2)) * (0.72 + 0.4 * grain) * (0.72 + 0.28 * round);
    wood = mix(wood, wood * 0.55, knots);
    vec3 chink = pow(vec3(0.78, 0.74, 0.66), vec3(2.2));
    diffuseColor.rgb = mix(wood, chink, gap * 0.45);
    gBump = round * 0.8 + grain * 0.15 - gap * 0.6;
  }` });
  const planks = woodTexture(33, { base: [150, 108, 70], bleach: 0.05 }); planks.repeat.set(4, 1.5);
  const floorM = mat({ color: 0xc8a57e, map: planks, roughness: 0.6 }, { key: 'hfloor' });
  const trimM = mat({ color: 0x2f7f8f, roughness: 0.55 }, { key: 'htrim' });
  const doorM = mat({ color: 0xc8532a, roughness: 0.5 }, { key: 'hdoor', fColor: `{ float pn = texture2D(uNoiseTex, vWPos.xy * 3.0 + vWPos.zy * 3.0).r; diffuseColor.rgb *= 0.85 + 0.25 * pn; }` });
  const roofM = mat({ color: 0x3a7a55, roughness: 0.4, metalness: 0.35 }, { key: 'hroof', bump: 1.0, fColor: `{
    float c = sin((vWPos.x * uHouse.z + vWPos.z * uHouse.w) * 40.0); gBump = c * 0.5;
    float rust = smoothstep(0.62, 0.75, texture2D(uNoiseTex, vWPos.xz * 0.35).r);
    diffuseColor.rgb = mix(diffuseColor.rgb, pow(vec3(0.5, 0.3, 0.18), vec3(2.2)), rust * 0.5); }` });
  const stoneM = mat({ color: 0x8c8479, roughness: 0.9 }, { key: 'hstone', bump: 1.0, fColor: `{ vec2 pb = pebbles(vec2(vWPos.x + vWPos.z, vWPos.y) * 3.5); diffuseColor.rgb *= 0.65 + 0.4 * pb.y; diffuseColor.rgb *= 0.6 + 0.4 * smoothstep(0.0, 0.12, pb.x); gBump = smoothstep(0.0, 0.12, pb.x); }` });
  const glassM = new THREE.MeshStandardMaterial({ color: 0xbfd6dc, roughness: 0.03, metalness: 0.0, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide });
  glassM.envMapIntensity = 2.2;
  patch(glassM, { key: 'hglass', uniforms: houseU, fHead: 'uniform float uLamp;', fLight: 'reflectedLight.directDiffuse += vec3(1.0, 0.62, 0.3) * uLamp * 0.06 * (1.0 - uKeyVis * 0.0);', noTerrainShadow: true });
  const woodM = mat({ color: 0x9a6b43, map: planks, roughness: 0.55 }, { key: 'hwood' });
  const darkWoodM = mat({ color: 0x5a3a22, map: planks, roughness: 0.6 }, { key: 'hdwood' });
  const paleWoodM = mat({ color: 0xd8bb90, map: planks, roughness: 0.6 }, { key: 'hpwood' });
  const metalM = mat({ color: 0x2b2b2e, roughness: 0.45, metalness: 0.8 }, { key: 'hmetal' });
  const steelM = mat({ color: 0xb8bcc0, roughness: 0.25, metalness: 0.9 }, { key: 'hsteel' });
  const couchTex = fabricTexture({ seed: 41, step: 3 }); couchTex.repeat.set(3, 3);
  const couchM = mat({ color: 0xc08a3a, map: couchTex, roughness: 0.95 }, { key: 'hcouch' });
  const cushionM = mat({ color: 0x3f6f7a, map: couchTex, roughness: 0.95 }, { key: 'hcush' });
  const chairM = mat({ color: 0x7d3b2e, map: couchTex, roughness: 0.95 }, { key: 'hchair' });
  const whiteM = mat({ color: 0xece6da, roughness: 0.5 }, { key: 'hwhite' });
  const ceramicM = mat({ color: 0xe9e1d2, roughness: 0.25 }, { key: 'hceram' });
  const cocoaM = mat({ color: 0x4a2a18, roughness: 0.2 }, { key: 'hcocoa' });
  const soilM = mat({ color: 0x4a3525, roughness: 1.0 }, { key: 'hsoil' });
  const firewoodM = mat({ color: 0x9a7856, roughness: 0.9 });

  const static_ = new Map(); // material -> geometries (merged at the end)
  const put = (geo, m, x, y, z, ry = 0, rx = 0, rz = 0) => {
    geo = geo.index ? geo.toNonIndexed() : geo.clone();
    if (geo.attributes.uv === undefined) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    const o = new THREE.Object3D(); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); o.updateMatrix();
    geo.applyMatrix4(o.matrix);
    if (!static_.has(m)) static_.set(m, []);
    static_.get(m).push(geo);
  };
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const toWorld = (lx, lz) => Hs.toW(lx, lz);
  const segCollider = (ax, az, bx, bz, r = 0.14) => { const [x0, z0] = toWorld(ax, az), [x1, z1] = toWorld(bx, bz); colliders.push({ seg: [x0, z0, x1, z1], r }); };
  const circCollider = (lx, lz, r) => { const [x, z] = toWorld(lx, lz); colliders.push({ x, z, r }); };

  // ---------------------------------------------------------------- foundation, floor, porch
  put(box(HX * 2 + 0.4, 1.3, HZ * 2 + 0.4), stoneM, 0, -0.67, 0);
  put(box(HX * 2 - 0.1, 0.06, HZ * 2 - 0.1), floorM, 0, -0.03, 0);
  put(box(3.0, 0.1, 1.4), darkWoodM, -1.4, -0.07, HZ + 0.7);
  for (const px of [-2.8, 0.0]) put(box(0.12, 0.5, 0.12), darkWoodM, px, -0.35, HZ + 1.32);
  for (let k = 0; k < 2; k++) put(box(1.4, 0.08, 0.35), darkWoodM, -1.4, -0.16 - k * 0.19, HZ + 1.52 + k * 0.33);
  put(box(1.4, 0.08, 0.5), darkWoodM, 2.6, -0.2, -HZ - 0.35);
  // porch posts & little roof
  for (const px of [-2.8, 0.0]) put(box(0.12, 2.3, 0.12), darkWoodM, px, 1.1, HZ + 1.3);
  put(box(3.4, 0.08, 1.7), roofM, -1.4, 2.35, HZ + 0.85, 0, 0.18);

  // ---------------------------------------------------------------- walls with openings
  // wall(along 'x' or 'z', fixed coordinate, from, to, openings[[a0, a1, y0, y1]])
  const wall = (axis, c, a0, a1, openings, thick = T, m = logs) => {
    const cuts = [a0, ...openings.flatMap(o => [o[0], o[1]]), a1].sort((p, q) => p - q);
    const segs = []; let prev = a0;
    const ops = openings.slice().sort((p, q) => p[0] - q[0]);
    for (const o of ops) { if (o[0] > prev) segs.push([prev, o[0], 0, WH]); segs.push([o[0], o[1], 0, o[2]]); segs.push([o[0], o[1], o[3], WH]); prev = o[1]; }
    if (a1 > prev) segs.push([prev, a1, 0, WH]);
    for (const [s0, s1, y0, y1] of segs) {
      if (y1 - y0 < 0.01 || s1 - s0 < 0.01) continue;
      const len = s1 - s0, mid = (s0 + s1) / 2, hy = (y0 + y1) / 2;
      if (axis === 'x') put(box(len, y1 - y0, thick), m, mid, hy, c); else put(box(thick, y1 - y0, len), m, c, hy, mid);
    }
    // collider segments (skip door openings that reach the floor)
    let p0 = a0;
    for (const o of ops) { if (o[2] < 0.05) { if (o[0] > p0) (axis === 'x' ? segCollider(p0, c, o[0], c) : segCollider(c, p0, c, o[0])); p0 = o[1]; } }
    if (a1 > p0) (axis === 'x' ? segCollider(p0, c, a1, c) : segCollider(c, p0, c, a1));
  };
  const openings = {
    front: [[-1.9, -0.9, 0, 2.05], [-3.4, -2.5, 0.9, 1.75], [2.0, 3.4, 0.8, 1.95]],
    back: [[2.1, 3.1, 0, 2.05], [-0.4, 0.8, 1.2, 1.9], [-3.4, -2.2, 0.9, 1.8]],
    right: [[-1.9, 2.3, 0.5, 2.25]],
    left: [[-2.6, -1.4, 0.9, 1.8], [0.2, 1.4, 0.9, 1.8]],
  };
  wall('x', HZ, -HX - T / 2, HX + T / 2, openings.front);
  wall('x', -HZ, -HX - T / 2, HX + T / 2, openings.back);
  wall('z', HX, -HZ + T / 2, HZ - T / 2, openings.right);
  wall('z', -HX, -HZ + T / 2, HZ - T / 2, openings.left);
  // interior partitions around the locked bedroom
  wall('x', -0.6, -HX + T / 2, -1.0, [[-3.1, -2.2, 0, 2.05]], 0.14);
  wall('z', -1.0, -HZ + T / 2, -0.6, [], 0.14);
  // corner log ends (saddle notches sticking out)
  for (const cx of [-HX, HX]) for (const cz of [-HZ, HZ]) for (let k = 0; k < 10; k++) {
    const y = 0.12 + k * 0.24;
    put(new THREE.CylinderGeometry(0.12, 0.12, 0.8, 8).rotateZ(Math.PI / 2), logs, cx + Math.sign(cx) * 0.02, y, cz + Math.sign(cz) * 0.28);
    put(new THREE.CylinderGeometry(0.12, 0.12, 0.8, 8).rotateX(Math.PI / 2), logs, cx + Math.sign(cx) * 0.28, y + 0.12, cz + Math.sign(cz) * 0.02);
  }
  // ceiling + beams
  put(box(HX * 2, 0.05, HZ * 2), paleWoodM, 0, WH + 0.02, 0);
  for (let k = -3; k <= 3; k++) put(box(0.14, 0.18, HZ * 2), darkWoodM, k * 1.2, WH - 0.08, 0);
  // gable roof (ridge along x), gable ends in vertical boards
  const pitchH = 1.7, eave = 0.55, over = 0.45;
  const slopeLen = Math.hypot(HZ + eave, pitchH);
  const ang = Math.atan2(pitchH, HZ + eave);
  for (const s of [-1, 1]) {
    const g = box(HX * 2 + over * 2, 0.07, slopeLen);
    put(g, roofM, 0, WH + pitchH / 2 + 0.03, s * (HZ + eave) / 2, 0, s * ang);
  }
  put(new THREE.CylinderGeometry(0.07, 0.07, HX * 2 + over * 2, 8).rotateZ(Math.PI / 2), roofM, 0, WH + pitchH + 0.05, 0);
  for (const s of [-1, 1]) {
    const shp = new THREE.Shape(); shp.moveTo(-HZ, 0); shp.lineTo(HZ, 0); shp.lineTo(0, pitchH); shp.lineTo(-HZ, 0);
    const gg = new THREE.ExtrudeGeometry(shp, { depth: 0.12, bevelEnabled: false }); gg.rotateY(Math.PI / 2);
    put(gg, paleWoodM, s * HX - (s > 0 ? 0.12 : 0) + s * 0.05, WH, 0);
  }
  // window frames (painted trim), sills, glass
  const glassGeos = [];
  const addWindow = (axis, c, a0, a1, y0, y1, mullions = 1) => {
    const len = a1 - a0, mid = (a0 + a1) / 2, h = y1 - y0, ym = (y0 + y1) / 2;
    const fr = 0.07, dp = T + 0.04;
    const pieces = [[len + fr * 2, fr, dp, mid, y0 - fr / 2], [len + fr * 2, fr, dp, mid, y1 + fr / 2]];
    for (let k = 0; k <= mullions + 1; k++) pieces.push([fr * (k === 0 || k === mullions + 1 ? 1 : 0.6), h, dp, a0 + len * k / (mullions + 1), ym]);
    pieces.push([len * 0.98, fr * 0.5, dp, mid, ym + h * 0.12]);
    for (const [w, hh, d, a, y] of pieces) axis === 'x' ? put(box(w, hh, d), trimM, a, y, c) : put(box(d, hh, w), trimM, c, y, a);
    // outer sill
    axis === 'x' ? put(box(len + 0.3, 0.05, 0.2), trimM, mid, y0 - 0.1, c + Math.sign(c) * 0.16) : put(box(0.2, 0.05, len + 0.3), trimM, c + Math.sign(c) * 0.16, y0 - 0.1, mid);
    const gl = axis === 'x' ? box(len, h, 0.01) : box(0.01, h, len);
    gl.translate(axis === 'x' ? mid : c, ym, axis === 'x' ? c : mid);
    glassGeos.push(gl.index ? gl.toNonIndexed() : gl);
  };
  addWindow('x', HZ, -3.4, -2.5, 0.9, 1.75);
  addWindow('x', HZ, 2.0, 3.4, 0.8, 1.95, 1);
  addWindow('x', -HZ, -0.4, 0.8, 1.2, 1.9);
  addWindow('x', -HZ, -3.4, -2.2, 0.9, 1.8);
  addWindow('z', HX, -1.9, 2.3, 0.5, 2.25, 3);
  addWindow('z', -HX, -2.6, -1.4, 0.9, 1.8);
  addWindow('z', -HX, 0.2, 1.4, 0.9, 1.8);
  const glassMesh = new THREE.Mesh(mergeGeometries(glassGeos), glassM); glassMesh.renderOrder = 8; root.add(glassMesh);
  // door frames
  for (const [c, a0, a1] of [[HZ, -1.9, -0.9], [-HZ, 2.1, 3.1]]) {
    put(box(0.08, 2.1, T + 0.05), trimM, a0 - 0.04, 1.05, c); put(box(0.08, 2.1, T + 0.05), trimM, a1 + 0.04, 1.05, c); put(box(1.16, 0.08, T + 0.05), trimM, (a0 + a1) / 2, 2.09, c);
  }
  // ---------------------------------------------------------------- doors (animated)
  const makeDoor = (hingeX, z, width, openDir, color) => {
    const pivot = new THREE.Group(); pivot.position.set(hingeX, 0, z); root.add(pivot);
    const leaf = new THREE.Group(); pivot.add(leaf);
    const dm = new THREE.Mesh(new RoundedBoxGeometry(width, 2.02, 0.06, 2, 0.015), color); dm.position.set(width / 2, 1.01, 0); dm.castShadow = true; dm.receiveShadow = true; leaf.add(dm);
    // panels + knob
    for (const py of [0.5, 1.45]) { const p = new THREE.Mesh(box(width * 0.7, 0.6, 0.02), darkWoodM); p.position.set(width / 2, py, 0.035); leaf.add(p); const p2 = p.clone(); p2.position.z = -0.035; leaf.add(p2); }
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), steelM); knob.position.set(width - 0.1, 1.0, 0.06); leaf.add(knob);
    const k2 = knob.clone(); k2.position.z = -0.06; leaf.add(k2);
    leaf.traverse(o => o.layers.enable(2));
    return { pivot, openDir, angle: 0, width };
  };
  const frontDoor = makeDoor(-1.9, HZ - 0.02, 1.0, -1, doorM);
  const backDoor = makeDoor(2.1, -HZ + 0.02, 1.0, 1, doorM);
  out.doors.push({ d: frontDoor, lx: -1.4, lz: HZ }, { d: backDoor, lx: 2.6, lz: -HZ });
  // the locked bedroom door, with hasp and padlock
  {
    const pivot = new THREE.Group(); pivot.position.set(-3.1, 0, -0.6); root.add(pivot);
    const dm = new THREE.Mesh(new RoundedBoxGeometry(0.9, 2.02, 0.05, 2, 0.012), darkWoodM); dm.position.set(0.45, 1.01, 0); dm.castShadow = true; pivot.add(dm);
    for (const py of [0.55, 1.45]) { const p = new THREE.Mesh(box(0.62, 0.6, 0.015), woodM); p.position.set(0.45, py, 0.03); pivot.add(p); }
    const hasp = new THREE.Mesh(box(0.16, 0.04, 0.02), metalM); hasp.position.set(0.86, 1.05, 0.04); pivot.add(hasp);
    const lockBody = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.08, 0.03, 2, 0.01), mat({ color: 0xb58a2a, roughness: 0.3, metalness: 0.9 }, { key: 'hbrass' })); lockBody.position.set(0.93, 0.98, 0.07); pivot.add(lockBody);
    const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.006, 6, 12, Math.PI), steelM); shackle.position.set(0.93, 1.02, 0.07); pivot.add(shackle);
    segCollider(-3.1, -0.6, -2.2, -0.6, 0.12);
  }

  // ---------------------------------------------------------------- furniture
  // table with two chairs; the mug of hot chocolate
  const TX = -2.35, TZ = 1.25;
  put(new RoundedBoxGeometry(1.3, 0.05, 0.8, 2, 0.015), woodM, TX, 0.76, TZ);
  for (const [dx, dz] of [[-0.58, -0.33], [0.58, -0.33], [-0.58, 0.33], [0.58, 0.33]]) put(box(0.06, 0.74, 0.06), woodM, TX + dx, 0.37, TZ + dz);
  const chair = (x, z, ry) => {
    const g = []; const add = (geo, px, py, pz) => { geo.translate(px, py, pz); g.push(geo.index ? geo.toNonIndexed() : geo); };
    add(box(0.44, 0.04, 0.42), 0, 0.45, 0);
    for (const [dx, dz] of [[-0.19, -0.18], [0.19, -0.18], [-0.19, 0.18], [0.19, 0.18]]) add(box(0.04, 0.45, 0.04), dx, 0.225, dz);
    for (const dx of [-0.19, 0.19]) add(box(0.04, 0.5, 0.04), dx, 0.72, -0.19);
    for (const yy of [0.62, 0.78, 0.94]) add(box(0.42, 0.05, 0.02), 0, yy, -0.19);
    const m = mergeGeometries(g); m.rotateY(ry); m.translate(x, 0, z);
    put(m, woodM, 0, 0, 0);
  };
  chair(TX, TZ - 0.62, 0); chair(TX - 0.85, TZ + 0.05, Math.PI / 2 + 0.2);
  circCollider(TX, TZ, 0.62); circCollider(TX, TZ - 0.65, 0.3); circCollider(TX - 0.85, TZ + 0.05, 0.3);
  // mug
  const mugG = new THREE.Group(); mugG.position.set(TX + 0.28, 0.785, TZ + 0.12); root.add(mugG);
  const mugBody = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 20, 1, true), mat({ color: 0xd9653f, roughness: 0.3, side: THREE.DoubleSide }, { key: 'hmug' })); mugBody.position.y = 0.05; mugG.add(mugBody);
  const mugBot = new THREE.Mesh(new THREE.CircleGeometry(0.04, 20).rotateX(-Math.PI / 2), ceramicM); mugBot.position.y = 0.002; mugG.add(mugBot);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.008, 8, 16, Math.PI * 1.3), mugBody.material); handle.position.set(0.05, 0.05, 0); handle.rotation.z = -Math.PI * 0.65; mugG.add(handle);
  const cocoa = new THREE.Mesh(new THREE.CircleGeometry(0.043, 20).rotateX(-Math.PI / 2), cocoaM); cocoa.position.y = 0.088; mugG.add(cocoa);
  for (const [mx, mz] of [[0.012, 0.01], [-0.014, -0.006]]) { const mm = new THREE.Mesh(new RoundedBoxGeometry(0.018, 0.014, 0.018, 2, 0.004), whiteM); mm.position.set(mx, 0.094, mz); mm.rotation.y = rng(); mugG.add(mm); }
  // steam wisps over the mug
  {
    const N = 10; const g = new THREE.InstancedBufferGeometry(); const pl = new THREE.PlaneGeometry(1, 1);
    g.index = pl.index; g.setAttribute('position', pl.attributes.position); g.setAttribute('uv', pl.attributes.uv);
    const sd = new Float32Array(N * 2); for (let i = 0; i < N * 2; i++) sd[i] = rng();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(sd, 2)); g.instanceCount = N;
    const sm = new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uBase: { value: new THREE.Vector3() } }, transparent: true, depthWrite: false,
      vertexShader: `uniform float uTime; uniform vec3 uBase; attribute vec2 aSeed; varying vec2 vUv; varying float vA;
        void main(){ float t = fract(uTime * 0.22 + aSeed.x); vec3 c = uBase + vec3(sin(t * 6.0 + aSeed.y * 9.0) * 0.02 * t, t * 0.32, cos(t * 5.0 + aSeed.y * 7.0) * 0.02 * t);
          vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]); vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          float s = 0.03 + t * 0.07; vec3 w = c + (camR * position.x + camU * position.y) * s; vUv = uv; vA = sin(t * 3.14159) * 0.22;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0); }`,
      fragmentShader: `varying vec2 vUv; varying float vA; void main(){ float d = length(vUv - 0.5) * 2.0; gl_FragColor = vec4(vec3(0.9), smoothstep(1.0, 0.0, d) * vA); }`,
    });
    const steam = new THREE.Mesh(g, sm); steam.frustumCulled = false; steam.renderOrder = 9; scene.add(steam);
    mugG.updateMatrixWorld(); sm.uniforms.uBase.value.setFromMatrixPosition(mugG.matrixWorld).add(new THREE.Vector3(0, 0.1, 0));
  }
  // couch facing the big window, rug and the cat
  const CX = 2.05, CZ = 0.25;
  {
    const g = []; const add = (geo, px, py, pz) => { geo.translate(px, py, pz); g.push(geo.index ? geo.toNonIndexed() : geo); };
    add(new RoundedBoxGeometry(0.85, 0.42, 2.1, 3, 0.08), 0, 0.26, 0);
    add(new RoundedBoxGeometry(0.22, 0.52, 2.1, 3, 0.08), -0.36, 0.72, 0);
    for (const sz of [-1, 1]) add(new RoundedBoxGeometry(0.85, 0.3, 0.2, 3, 0.07), 0, 0.58, sz * 1.02);
    const m = mergeGeometries(g); m.translate(CX, 0, CZ);
    put(m, couchM, 0, 0, 0);
    for (const sz of [-0.5, 0.5]) put(new RoundedBoxGeometry(0.62, 0.14, 0.95, 3, 0.06), cushionM, CX + 0.06, 0.52, CZ + sz);
    for (const sz of [-0.55, 0.45]) put(new RoundedBoxGeometry(0.16, 0.42, 0.42, 3, 0.07), cushionM, CX - 0.2, 0.78, CZ + sz, 0, 0, 0.3);
    circCollider(CX, CZ - 0.6, 0.5); circCollider(CX, CZ + 0.6, 0.5);
  }
  // throw blanket over the arm
  put(new RoundedBoxGeometry(0.7, 0.03, 0.5, 2, 0.01), mat({ color: 0x8e2f3b, map: couchTex, roughness: 0.95 }, { key: 'hthrow' }), CX - 0.05, 0.75, CZ + 0.95, 0.1, 0, 0.2);
  // rug with ornamental border (no text)
  {
    const S = 256; const c = document.createElement('canvas'); c.width = S; c.height = S; const g = c.getContext('2d');
    g.fillStyle = '#8f2d2a'; g.fillRect(0, 0, S, S);
    g.strokeStyle = '#e8c07a'; g.lineWidth = 10; g.strokeRect(16, 16, S - 32, S - 32);
    g.strokeStyle = '#1f3f63'; g.lineWidth = 6; g.strokeRect(34, 34, S - 68, S - 68);
    g.fillStyle = '#e8c07a';
    for (let i = 0; i < 4; i++) { g.save(); g.translate(S / 2, S / 2); g.rotate(i * Math.PI / 2); g.beginPath(); g.moveTo(0, -60); g.lineTo(22, -30); g.lineTo(0, 0); g.lineTo(-22, -30); g.closePath(); g.fill(); g.restore(); }
    g.fillStyle = '#1f3f63'; g.beginPath(); g.arc(S / 2, S / 2, 14, 0, 7); g.fill();
    for (let i = 0; i < 1800; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.08})`; g.fillRect(Math.random() * S, Math.random() * S, 2, 2); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    const rugM = mat({ color: 0xffffff, map: t, roughness: 1.0 }, { key: 'hrug' });
    const rg = new THREE.PlaneGeometry(1.6, 2.2); rg.rotateX(-Math.PI / 2);
    const rug = new THREE.Mesh(rg, rugM); rug.position.set(CX + 1.15, 0.006, CZ); rug.receiveShadow = true; root.add(rug);
  }
  // the cat: a small orange tabby curled on the rug
  {
    const cat = new THREE.Group(); cat.position.set(CX + 1.25, 0.01, CZ + 0.15); cat.rotation.y = 0.8; root.add(cat);
    const catM = mat({ color: 0xffffff, roughness: 0.9 }, { key: 'hcat', fColor: `{ float st = sin((vWPos.x * uHouse.z + vWPos.z * uHouse.w) * 55.0 + texture2D(uNoiseTex, vWPos.xz * 6.0).r * 4.0); diffuseColor.rgb = mix(pow(vec3(0.85, 0.5, 0.2), vec3(2.2)), pow(vec3(0.6, 0.3, 0.1), vec3(2.2)), smoothstep(0.2, 0.8, st)); }` });
    const whiteCatM = mat({ color: 0xf2eee6, roughness: 0.9 }, { key: 'hcatw' });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 14).scale(1.25, 0.62, 0.95), catM); body.position.y = 0.075; body.castShadow = true; cat.add(body);
    const chest = new THREE.Mesh(new THREE.SphereGeometry(0.07, 14, 10).scale(1, 0.8, 1), whiteCatM); chest.position.set(0.1, 0.06, 0.05); cat.add(chest);
    const head = new THREE.Group(); head.position.set(0.15, 0.12, 0.06); cat.add(head);
    head.add(new THREE.Mesh(new THREE.SphereGeometry(0.065, 16, 12).scale(1, 0.9, 1), catM));
    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8).scale(1.1, 0.7, 1), whiteCatM); muzzle.position.set(0.05, -0.02, 0); head.add(muzzle);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.008, 6, 5), mat({ color: 0xd88a8a, roughness: 0.5 }, { key: 'hcatn' })); nose.position.set(0.078, -0.008, 0); head.add(nose);
    const earM = catM;
    for (const s of [-1, 1]) { const e = new THREE.Mesh(new THREE.ConeGeometry(0.024, 0.05, 4), earM); e.position.set(0.005, 0.06, s * 0.035); e.rotation.set(s * 0.25, 0, -0.1); head.add(e); }
    const eyeMat = mat({ color: 0x2e3a10, roughness: 0.15, emissive: 0x151a06 }, { key: 'hcate' });
    const eyes = [];
    for (const s of [-1, 1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.011, 8, 6).scale(0.6, 1, 1), eyeMat); e.position.set(0.058, 0.012, s * 0.024); head.add(e); eyes.push(e); }
    // tail curled around the body
    const tailPts = []; for (let i = 0; i <= 10; i++) { const a = -0.4 + i / 10 * 2.6; tailPts.push(new THREE.Vector3(Math.cos(a) * 0.17 - 0.02, 0.035, Math.sin(a) * 0.14)); }
    const tail = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(tailPts), 20, 0.022, 7), catM); tail.castShadow = true; cat.add(tail);
    cat.traverse(o => { if (o.isMesh) o.castShadow = true; });
    out.dyn.push((dt, time, hiker) => {
      body.scale.y = 1 + Math.sin(time * 2.2) * 0.035;
      const [lx, lz] = Hs.toL(hiker.pos.x, hiker.pos.z);
      const near = Math.hypot(lx - (CX + 1.25), lz - (CZ + 0.15)) < 3.2 && Math.abs(lx) < HX && Math.abs(lz) < HZ;
      const want = near ? Math.atan2(-(lz - CZ - 0.15), lx - CX - 1.25) - cat.rotation.y : Math.sin(time * 0.13) * 0.3;
      head.rotation.y = lerp(head.rotation.y, clamp(want, -1.1, 1.1), 1 - Math.exp(-dt * 2));
      const blink = (time % 5.3) < 0.14 ? 0.1 : 1; eyes.forEach(e => e.scale.y = blink);
      tail.rotation.y = Math.sin(time * 1.3) * 0.08;
    });
    circCollider(CX + 1.25, CZ + 0.15, 0.25);
  }
  // armchair angled toward the window
  {
    const g = []; const add = (geo, px, py, pz) => { geo.translate(px, py, pz); g.push(geo.index ? geo.toNonIndexed() : geo); };
    add(new RoundedBoxGeometry(0.75, 0.4, 0.75, 3, 0.07), 0, 0.25, 0);
    add(new RoundedBoxGeometry(0.75, 0.62, 0.18, 3, 0.07), 0, 0.72, -0.3);
    for (const sx of [-1, 1]) add(new RoundedBoxGeometry(0.16, 0.3, 0.7, 3, 0.06), sx * 0.34, 0.55, 0.02);
    const m = mergeGeometries(g); m.rotateY(-2.3); m.translate(3.35, 0, 2.55);
    put(m, chairM, 0, 0, 0);
    circCollider(3.35, 2.55, 0.5);
  }
  // wall shelf with books, jars, a plant and a candle (front wall inside, right of the door)
  {
    const sz = HZ - T / 2 - 0.13;
    for (const yy of [1.25, 1.62]) put(box(1.4, 0.035, 0.24), darkWoodM, 0.9, yy, sz);
    for (const xx of [0.24, 1.56]) put(box(0.03, 0.26, 0.2), metalM, xx, 1.42, sz + 0.02);
    const bookMats = [0x7a2e2a, 0x2d4c6a, 0xc9a24a, 0x3f6b3a, 0x6b4a8a, 0xb5562e].map(c => mat({ color: c, roughness: 0.7 }));
    let x = 0.28;
    while (x < 1.3) { const w = 0.03 + rng() * 0.035, h = 0.18 + rng() * 0.08; put(box(w, h, 0.16), bookMats[Math.floor(rng() * bookMats.length)], x + w / 2, 1.27 + h / 2, sz, 0, 0, (rng() - 0.5) * 0.06); x += w + 0.005; }
    const jarM = mat({ color: 0xd8e2d0, roughness: 0.12, transparent: true, opacity: 0.75 });
    for (const jx of [0.35, 0.55, 0.8]) put(new THREE.CylinderGeometry(0.045, 0.045, 0.14, 12), jarM, jx, 1.71, sz);
    put(new THREE.CylinderGeometry(0.05, 0.04, 0.09, 12), mat({ color: 0xb4602e, roughness: 0.8 }, { key: 'hpot' }), 1.25, 1.68, sz);
    put(new THREE.IcosahedronGeometry(0.09, 1), mat({ color: 0x3d7a34, roughness: 0.8 }, { key: 'hplant' }), 1.25, 1.8, sz);
    put(new THREE.CylinderGeometry(0.02, 0.02, 0.08, 10), whiteM, 1.45, 1.68, sz);
  }
  // tiny kitchen along the back wall: counter, sink, cooktop with kettle, cabinets, hanging pots
  {
    const kz = -HZ + T / 2 + 0.32;
    put(box(2.35, 0.86, 0.62), paleWoodM, 0.2, 0.43, kz);
    put(box(2.4, 0.04, 0.66), mat({ color: 0x6e6a64, roughness: 0.45 }, { key: 'hcounter' }), 0.2, 0.88, kz);
    for (let k = 0; k < 3; k++) put(box(0.02, 0.6, 0.02), darkWoodM, -0.55 + k * 0.78, 0.45, kz + 0.32);
    put(box(0.5, 0.02, 0.4), steelM, 0.2, 0.895, kz + 0.02);
    put(box(0.46, 0.14, 0.36), metalM, 0.2, 0.83, kz + 0.02);
    const tap = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.22, 0), new THREE.Vector3(0, 0.26, 0.08), new THREE.Vector3(0, 0.2, 0.14)]), 10, 0.012, 6);
    put(tap, steelM, 0.2, 0.9, kz - 0.22);
    put(box(0.6, 0.03, 0.5), metalM, -0.65, 0.915, kz);
    for (const [bx, bz] of [[-0.8, -0.1], [-0.5, 0.1]]) put(new THREE.CylinderGeometry(0.08, 0.08, 0.01, 16), metalM, bx, 0.935, kz + bz);
    // kettle
    const kg = new THREE.LatheGeometry([[0.001, 0], [0.09, 0.0], [0.1, 0.06], [0.085, 0.14], [0.03, 0.18], [0.001, 0.19]].map(([r, y]) => new THREE.Vector2(r, y)), 16);
    put(kg, mat({ color: 0x3b6e8f, roughness: 0.3, metalness: 0.4 }, { key: 'hkettle' }), -0.8, 0.94, kz - 0.1);
    put(new THREE.TorusGeometry(0.06, 0.01, 6, 12, Math.PI), metalM, -0.8, 1.13, kz - 0.1);
    // upper cabinets
    put(box(1.2, 0.6, 0.34), paleWoodM, -0.35, 1.95, -HZ + T / 2 + 0.17);
    put(box(0.02, 0.5, 0.01), darkWoodM, -0.35, 1.95, -HZ + T / 2 + 0.345);
    for (let k = 0; k < 3; k++) put(new THREE.CylinderGeometry(0.1 - k * 0.015, 0.09 - k * 0.015, 0.1, 14), steelM, 0.95 + k * 0.1, 1.55 - k * 0.04, -HZ + T / 2 + 0.08);
    segCollider(-1.0, kz + 0.1, 1.4, kz + 0.1, 0.3);
  }
  // wood stove in the front-left corner, glowing window, stove pipe through the roof
  const STX = -3.55, STZ = 2.55;
  const fireM = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.9, 0.25) });
  {
    put(new RoundedBoxGeometry(0.55, 0.62, 0.5, 2, 0.03), metalM, STX, 0.36, STZ);
    for (const [dx, dz] of [[-0.22, -0.2], [0.22, -0.2], [-0.22, 0.2], [0.22, 0.2]]) put(box(0.04, 0.08, 0.04), metalM, STX + dx, 0.04, STZ + dz);
    put(new THREE.CylinderGeometry(0.075, 0.075, WH + 1.7, 12), metalM, STX, 0.67 + (WH + 1.7) / 2, STZ);
    put(new THREE.CylinderGeometry(0.12, 0.09, 0.12, 12), metalM, STX, WH + 2.45, STZ);
    const fire = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.18), fireM); fire.position.set(STX + 0.28, 0.36, STZ); fire.rotation.y = Math.PI / 2; root.add(fire);
    out.dyn.push((dt, time) => { const f = 0.8 + 0.2 * Math.sin(time * 11) * Math.sin(time * 7.3 + 1) + 0.1 * Math.sin(time * 23); fireM.color.setRGB(2.4 * f, 0.9 * f, 0.25 * f); });
    circCollider(STX, STZ, 0.45);
    // firewood basket
    for (let k = 0; k < 6; k++) put(new THREE.CylinderGeometry(0.05, 0.05, 0.45, 8).rotateZ(Math.PI / 2), firewoodM, STX + 0.05, 0.07 + Math.floor(k / 3) * 0.09, STZ - 0.75 + (k % 3) * 0.1);
  }
  // hanging lamp over the table (warm point light)
  const lamp = new THREE.PointLight(0xffc98f, 0, 10, 1.6);
  lamp.position.set(TX + 0.1, 2.05, TZ);
  root.add(lamp);
  put(new THREE.CylinderGeometry(0.004, 0.004, 0.35, 4), metalM, TX + 0.1, WH - 0.2, TZ);
  const shadeGeo = new THREE.CylinderGeometry(0.08, 0.22, 0.2, 18, 1, true);
  const shade = new THREE.Mesh(shadeGeo, mat({ color: 0x2f5f4f, roughness: 0.5, side: THREE.DoubleSide }, { key: 'hshade' })); shade.position.set(TX + 0.1, 2.12, TZ); root.add(shade);
  const bulbM = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.0, 2.0, 1.1) });
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), bulbM); bulb.position.set(TX + 0.1, 2.04, TZ); root.add(bulb);
  // the painting on the partition wall, facing the table
  {
    const c = document.createElement('canvas'); c.width = 512; c.height = 400; const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 400); grd.addColorStop(0, '#f6d7c3'); grd.addColorStop(0.55, '#f4b6c2'); grd.addColorStop(1, '#c9b6f0');
    g.fillStyle = grd; g.fillRect(0, 0, 512, 400);
    for (let i = 0; i < 140; i++) { g.strokeStyle = `hsla(${300 + Math.random() * 80},70%,${75 + Math.random() * 15}%,0.35)`; g.lineWidth = 6 + Math.random() * 14; g.beginPath(); const x = Math.random() * 512, y = Math.random() * 400; g.moveTo(x, y); g.quadraticCurveTo(x + 30, y + (Math.random() - 0.5) * 30, x + 60 + Math.random() * 60, y + (Math.random() - 0.5) * 20); g.stroke(); }
    g.save(); g.translate(256, 208); g.rotate(-0.05);
    g.font = 'bold 74px "Segoe Print", "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 10; g.strokeStyle = 'rgba(255,255,255,0.85)'; g.strokeText('ur gay hehe', 0, 0);
    g.fillStyle = '#7b2d6b'; g.fillText('ur gay hehe', 0, 0);
    g.restore();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    const pm = mat({ color: 0xffffff, map: t, roughness: 1.0 }, { key: 'hpaint', fLight: 'reflectedLight.directDiffuse = min(reflectedLight.directDiffuse * 0.55, diffuseColor.rgb * 1.2); reflectedLight.directSpecular *= 0.05;' });
    const art = new THREE.Mesh(new THREE.PlaneGeometry(0.78, 0.61), pm); art.position.set(-1.62, 1.55, -0.6 + 0.093); root.add(art);
    put(box(0.9, 0.73, 0.03), mat({ color: 0xc49a45, roughness: 0.35, metalness: 0.6 }, { key: 'hframe' }), -1.62, 1.55, -0.6 + 0.07);
  }
  // bedroom glimpse props behind the locked door are unnecessary (it's locked) -- a bed silhouette through the back window
  put(new RoundedBoxGeometry(1.0, 0.45, 1.9, 2, 0.05), mat({ color: 0xe8e0d0, roughness: 0.9 }, { key: 'hbed' }), -3.4, 0.25, -2.2);

  // ---------------------------------------------------------------- outside: fence, gates, garden, swings, woodpile
  const F = Hs.fence;
  const pickets = [];
  const fenceSide = (ax, az, bx, bz, gateAt = null) => {
    const len = Math.hypot(bx - ax, bz - az); const n = Math.floor(len / 0.16);
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    for (let i = 0; i <= n; i++) {
      const t = i * 0.16;
      if (gateAt !== null && Math.abs(t - gateAt) < 0.62) continue;
      const x = ax + ux * t, z = az + uz * t;
      const [wx, wz] = toWorld(x, z); const gy = W.hf.height(wx, wz) - Hs.floorH;
      pickets.push([x, gy, z, Math.atan2(ux, uz)]);
    }
    // rails
    for (const ry of [0.35, 0.78]) {
      const segs = gateAt === null ? [[0, len]] : [[0, gateAt - 0.62], [gateAt + 0.62, len]];
      for (const [s0, s1] of segs) { if (s1 - s0 < 0.1) continue; const mx = ax + ux * (s0 + s1) / 2, mz = az + uz * (s0 + s1) / 2; const [wx, wz] = toWorld(mx, mz); const gy = W.hf.height(wx, wz) - Hs.floorH; put(box(0.04, 0.06, s1 - s0), paleWoodM, mx, gy + ry, mz, Math.atan2(ux, uz)); }
    }
    // colliders (with a gap for the gate)
    if (gateAt === null) segCollider(ax, az, bx, bz, 0.08);
    else { segCollider(ax, az, ax + ux * (gateAt - 0.62), az + uz * (gateAt - 0.62), 0.08); segCollider(ax + ux * (gateAt + 0.62), az + uz * (gateAt + 0.62), bx, bz, 0.08); }
  };
  fenceSide(F.x0, F.z1, F.x1, F.z1, -1.4 - F.x0);
  fenceSide(F.x1, F.z1, F.x1, F.z0);
  fenceSide(F.x1, F.z0, F.x0, F.z0, F.x1 - 0.4);
  fenceSide(F.x0, F.z0, F.x0, F.z1);
  {
    const pg = new THREE.BoxGeometry(0.07, 1.0, 0.03); pg.translate(0, 0.5, 0);
    const tip = new THREE.ConeGeometry(0.05, 0.08, 4); tip.rotateY(Math.PI / 4); tip.translate(0, 1.03, 0);
    const pgeo = mergeGeometries([pg.toNonIndexed(), tip.toNonIndexed()]);
    const im = new THREE.InstancedMesh(pgeo, paleWoodM, pickets.length);
    const d = new THREE.Object3D();
    pickets.forEach(([x, y, z, ry], i) => { d.position.set(x, y - 0.05, z); d.rotation.set(0, ry + (rng() - 0.5) * 0.05, (rng() - 0.5) * 0.04); d.scale.set(1, 0.9 + rng() * 0.2, 1); d.updateMatrix(); im.setMatrixAt(i, d.matrix); });
    im.castShadow = true; im.receiveShadow = true; root.add(im);
  }
  // open gates
  for (const [gx, gz, ry] of [[-1.4 - 0.6, F.z1, -1.2], [0.4 - 0.6, F.z0, 1.3]]) {
    const gg = new THREE.Group(); gg.position.set(gx, W.hf.height(...toWorld(gx, gz)) - Hs.floorH, gz); gg.rotation.y = ry; root.add(gg);
    for (let k = 0; k < 7; k++) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.95, 0.03), paleWoodM); p.position.set(0.1 + k * 0.16, 0.48, 0); p.castShadow = true; gg.add(p); }
    for (const ry2 of [0.3, 0.75]) { const r = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.06, 0.04), paleWoodM); r.position.set(0.58, ry2, 0.03); gg.add(r); }
  }
  // stepping stones from the gate to the porch
  for (let k = 0; k < 6; k++) {
    const lz = HZ + 2.4 + k * 0.62, lx = -1.4 + Math.sin(k * 1.7) * 0.12;
    const [wx, wz] = toWorld(lx, lz); const gy = W.hf.height(wx, wz) - Hs.floorH;
    put(new THREE.CylinderGeometry(0.28 + rng() * 0.06, 0.3, 0.06, 9), stoneM, lx, gy + 0.005, lz, rng() * 3);
  }
  // woodpile under the left eave
  for (let r = 0; r < 4; r++) for (let k = 0; k < 9 - r; k++) put(new THREE.CylinderGeometry(0.1, 0.1, 0.9, 8).rotateX(Math.PI / 2), firewoodM, -HX - 0.55, 0.0 + r * 0.18, -2.4 + k * 0.21 + r * 0.1);
  segCollider(-HX - 0.55, -2.5, -HX - 0.55, -0.5, 0.35);
  // swing set in the backyard (A-frame, two swings that sway)
  {
    const SX = -4.8, SZ = -9.2;
    const [wx, wz] = toWorld(SX, SZ); const gy = W.hf.height(wx, wz) - Hs.floorH;
    const beamY = gy + 2.35;
    for (const ex of [-1.6, 1.6]) for (const s of [-1, 1]) put(new THREE.CylinderGeometry(0.06, 0.07, 2.55, 8), paleWoodM, SX + ex, gy + 1.18, SZ + s * 0.45, 0, s * 0.37);
    put(new THREE.CylinderGeometry(0.075, 0.075, 3.5, 10).rotateZ(Math.PI / 2), paleWoodM, SX, beamY, SZ);
    const swings = [];
    const ropeM = mat({ color: 0xc8b48a, roughness: 1 });
    for (const sx of [-0.7, 0.75]) {
      const piv = new THREE.Group(); piv.position.set(SX + sx, beamY, SZ); root.add(piv);
      for (const rx of [-0.22, 0.22]) { const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.85, 5), ropeM); rope.position.set(rx, -0.925, 0); rope.castShadow = true; piv.add(rope); }
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.04, 0.22), doorM); seat.position.set(0, -1.86, 0); seat.castShadow = true; piv.add(seat);
      swings.push({ piv, ph: rng() * 6 });
    }
    out.dyn.push((dt, time) => { const w = U.uWind.value; for (const s of swings) s.piv.rotation.x = Math.sin(time * 1.9 + s.ph) * (0.05 + w * 0.12) + Math.sin(time * 0.7 + s.ph) * 0.03; });
    for (const ex of [-1.6, 1.6]) circCollider(SX + ex, SZ, 0.55);
  }

  // ---------------------------------------------------------------- merge static geometry per material
  for (const [m, geos] of static_) {
    const merged = mergeGeometries(geos.map(g => { const gg = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(gg.attributes)) if (!['position', 'normal', 'uv'].includes(k)) gg.deleteAttribute(k); return gg; }));
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, m); mesh.castShadow = true; mesh.receiveShadow = true;
    root.add(mesh);
    if (m === floorM || m === stoneM || m === darkWoodM || m === soilM) out.occluders.push(mesh);
  }
  root.traverse(o => { if (o.isMesh) { o.layers.enable(2); if (o.material === glassM) o.castShadow = false; } });

  // ---------------------------------------------------------------- chimney smoke
  {
    const N = 26; const g = new THREE.InstancedBufferGeometry(); const pl = new THREE.PlaneGeometry(1, 1);
    g.index = pl.index; g.setAttribute('position', pl.attributes.position); g.setAttribute('uv', pl.attributes.uv);
    const sd = new Float32Array(N * 2); for (let i = 0; i < N * 2; i++) sd[i] = rng();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(sd, 2)); g.instanceCount = N;
    const top = new THREE.Vector3(STX, WH + 2.5, STZ).applyMatrix4(root.matrixWorld);
    const sm = new THREE.ShaderMaterial({
      uniforms: { ...U, uBase: { value: top }, uSmoke: { value: 0.5 } }, transparent: true, depthWrite: false,
      vertexShader: GLSL_COMMON + `uniform vec3 uBase; uniform float uSmoke; attribute vec2 aSeed; varying vec2 vUv; varying float vA; varying vec3 vW;
        void main(){ float t = fract(uTime * 0.07 + aSeed.x);
          vec3 c = uBase + vec3(uWindDir.x, 0.0, uWindDir.y) * t * t * 9.0 * (0.4 + uWind) + vec3(sin(t * 7.0 + aSeed.y * 6.0) * 0.3 * t, t * 6.0, cos(t * 5.0 + aSeed.y * 5.0) * 0.3 * t);
          vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]); vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          float s = 0.25 + t * 1.8; vec3 w = c + (camR * position.x + camU * position.y) * s; vUv = uv; vA = sin(t * 3.14159) * (1.0 - t) * 0.35 * uSmoke; vW = w;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0); }`,
      fragmentShader: GLSL_COMMON + `uniform vec3 uAmbient; varying vec2 vUv; varying float vA; varying vec3 vW;
        void main(){ float d = length(vUv - 0.5) * 2.0; float n = texture2D(uNoiseTex, vUv * 0.5 + vW.xy * 0.05).r;
          gl_FragColor = vec4(applyFog(vec3(0.62, 0.62, 0.64) * (uAmbient + uKeyColor * 0.2), vW), smoothstep(1.0, 0.0, d) * vA * (0.5 + 0.7 * n)); }`,
    });
    sm.uniforms.uAmbient = U.uAmbient;
    const smoke = new THREE.Mesh(g, sm); smoke.frustumCulled = false; smoke.renderOrder = 9; scene.add(smoke);
    out.smoke = sm;
  }

  // ---------------------------------------------------------------- per-frame: doors, lamp, glow, small animations
  const tmp = new THREE.Vector3();
  out.update = (dt, time, env, hiker) => {
    const [hlx, hlz] = Hs.toL(hiker.pos.x, hiker.pos.z);
    for (const D of out.doors) {
      const near = Math.hypot(hlx - D.lx, hlz - D.lz) < 2.6;
      const target = near ? 1.65 : 0;
      D.d.angle = lerp(D.d.angle, target, 1 - Math.exp(-dt * (near ? 3.5 : 1.2)));
      D.d.pivot.rotation.y = -D.d.openDir * D.d.angle;
    }
    const dark = 1 - smoothstep(-0.05, 0.25, U.uRealSun.value.y);
    const inside = Math.abs(hlx) < HX && Math.abs(hlz) < HZ;
    const lampOn = clamp(0.35 + dark * 0.9 + (inside ? 0.35 : 0) + env.storm * 0.4, 0, 1.3);
    lamp.intensity = lampOn * 9.0;
    houseU.uLamp.value = lampOn;
    bulbM.color.setRGB(3.0 * lampOn + 0.2, 2.0 * lampOn + 0.15, 1.1 * lampOn + 0.1);
    out.smoke.uniforms.uSmoke.value = 0.35 + dark * 0.5 + (env.hour < 9 ? 0.3 : 0);
    for (const f of out.dyn) f(dt, time, hiker);
  };
  out.inside = (x, z) => { const [lx, lz] = Hs.toL(x, z); return Math.abs(lx) < HX - 0.05 && Math.abs(lz) < HZ - 0.05; };
  out.interiorBox = { hx: HX - 0.35, hz: HZ - 0.35, y0: Hs.floorH + 0.25, y1: Hs.floorH + WH - 0.2 };
  return out;
}
