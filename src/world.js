// World layout + heightfield generation. Everything that must "rest on the ground" queries this.
import { simplex2, fbm2, ridged2, clamp, lerp, smoothstep, mulberry32 } from './noise.js';

export const NEAR = 520;      // half extent of fine grid region
export const WORLD = 11000;   // half extent of the whole terrain
const NC = 600;               // cells across the fine region
const NF = 150;               // cells on each outer side

// ---------------------------------------------------------------- spine
const SPINE_PTS = [
  [4200, 3100, 780], [2200, 1650, 420], [1300, 980, 230], [900, 700, 150], [600, 480, 138], [380, 330, 150],
  [300, 265, 157], [220, 215, 172], [140, 165, 206], [70, 110, 224], [5, 55, 240], [-60, 0, 262],
  [-130, -60, 252], [-210, -120, 244], [-300, -190, 250], [-400, -270, 266], [-600, -420, 300],
  [-900, -650, 290], [-1500, -1100, 300], [-2600, -1900, 520], [-5200, -3800, 900],
];

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function sampleCurve(pts, perSeg, dims) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const n = typeof perSeg === 'function' ? perSeg(p1, p2) : perSeg;
    for (let k = 0; k < n; k++) {
      const t = k / n; const v = [];
      for (let d = 0; d < dims; d++) v.push(catmull(p0[d], p1[d], p2[d], p3[d], t));
      out.push(v);
    }
  }
  out.push(pts[pts.length - 1].slice());
  return out;
}

class Polyline {
  constructor(pts, cell = 12) { // pts: [[x,z,...extra]]
    this.p = pts; this.n = pts.length;
    this.s = new Float64Array(this.n);
    for (let i = 1; i < this.n; i++) this.s[i] = this.s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    this.len = this.s[this.n - 1];
    // spatial hash for fast local queries
    this.cell = cell; this.hash = new Map();
    for (let i = 0; i < this.n - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const x0 = Math.floor(Math.min(a[0], b[0]) / this.cell), x1 = Math.floor(Math.max(a[0], b[0]) / this.cell);
      const z0 = Math.floor(Math.min(a[1], b[1]) / this.cell), z1 = Math.floor(Math.max(a[1], b[1]) / this.cell);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const k = x * 73856093 ^ z * 19349663; let arr = this.hash.get(k); if (!arr) this.hash.set(k, arr = []); arr.push(i);
      }
    }
  }
  segNearest(i, x, z, res) {
    const a = this.p[i], b = this.p[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz || 1e-9;
    let t = ((x - a[0]) * dx + (z - a[1]) * dz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a[0] + dx * t, pz = a[1] + dz * t;
    const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (d2 < res.d2) { res.d2 = d2; res.i = i; res.t = t; res.side = dx * (z - a[1]) - dz * (x - a[0]); }
  }
  // brute-force nearest (for small polylines or global queries)
  nearest(x, z, res = {}) {
    res.d2 = Infinity; res.i = 0; res.t = 0; res.side = 0;
    for (let i = 0; i < this.n - 1; i++) this.segNearest(i, x, z, res);
    return this.finish(res);
  }
  // hashed nearest within radius; returns null if nothing near
  near(x, z, radius, res = {}) {
    res.d2 = Infinity; res.i = -1; res.t = 0; res.side = 0;
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    for (let ix = cx - r; ix <= cx + r; ix++) for (let iz = cz - r; iz <= cz + r; iz++) {
      const arr = this.hash.get(ix * 73856093 ^ iz * 19349663); if (!arr) continue;
      for (const i of arr) this.segNearest(i, x, z, res);
    }
    if (res.i < 0 || res.d2 > radius * radius) return null;
    return this.finish(res);
  }
  finish(res) {
    res.d = Math.sqrt(res.d2);
    const a = this.s[res.i], b = this.s[res.i + 1];
    res.s = a + (b - a) * res.t;
    // side > 0 means point is on the left in xz with z-down... normalise to +right
    res.sd = res.side >= 0 ? res.d : -res.d;
    return res;
  }
  at(s, out = {}) { // position/tangent at arc length
    s = clamp(s, 0, this.len);
    let lo = 0, hi = this.n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.s[m] <= s) lo = m; else hi = m; }
    const a = this.p[lo], b = this.p[hi];
    const seg = this.s[hi] - this.s[lo] || 1;
    const t = (s - this.s[lo]) / seg;
    out.x = a[0] + (b[0] - a[0]) * t; out.z = a[1] + (b[1] - a[1]) * t;
    out.tx = (b[0] - a[0]) / seg; out.tz = (b[1] - a[1]) / seg;
    out.i = lo; out.t = t;
    for (let k = 2; k < a.length; k++) out['v' + k] = a[k] + (b[k] - a[k]) * t;
    return out;
  }
}

// right-hand side vector for heading (tx,tz) with y up is (-tz, tx)
export const rightOf = (tx, tz) => [-tz, tx];

// ---------------------------------------------------------------- grid axis
function buildAxis() {
  const dx = (2 * NEAR) / NC;
  // solve geometric ratio so outer cells reach WORLD
  let lo = 1.0001, hi = 1.3;
  for (let it = 0; it < 60; it++) {
    const r = (lo + hi) / 2;
    const sum = dx * r * (Math.pow(r, NF) - 1) / (r - 1);
    if (sum > WORLD - NEAR) hi = r; else lo = r;
  }
  const r = (lo + hi) / 2;
  const ax = [];
  const outer = []; let acc = 0, step = dx;
  for (let k = 0; k < NF; k++) { step *= r; acc += step; outer.push(NEAR + acc); }
  for (let k = NF - 1; k >= 0; k--) ax.push(-outer[k]);
  for (let k = 0; k <= NC; k++) ax.push(-NEAR + k * dx);
  for (let k = 0; k < NF; k++) ax.push(outer[k]);
  return new Float64Array(ax);
}

// ---------------------------------------------------------------- heightfield
export class Heightfield {
  constructor() {
    this.ax = buildAxis();
    this.N = this.ax.length; // verts per side
    this.H = new Float32Array(this.N * this.N);
    this.dx = (2 * NEAR) / NC;
    this.i0 = NF; // index of -NEAR
  }
  idx(v) { // cell index for coordinate
    const ax = this.ax;
    if (v >= -NEAR && v < NEAR) return Math.min(this.i0 + Math.floor((v + NEAR) / this.dx), this.N - 2);
    let lo = 0, hi = this.N - 1;
    if (v <= ax[0]) return 0; if (v >= ax[hi]) return hi - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ax[m] <= v) lo = m; else hi = m; }
    return lo;
  }
  // exact triangle interpolation matching the render mesh (diagonal b-c)
  height(x, z) {
    const i = this.idx(x), j = this.idx(z);
    const ax = this.ax, N = this.N, H = this.H;
    const u = clamp((x - ax[i]) / (ax[i + 1] - ax[i]), 0, 1), v = clamp((z - ax[j]) / (ax[j + 1] - ax[j]), 0, 1);
    const ha = H[j * N + i], hb = H[j * N + i + 1], hc = H[(j + 1) * N + i], hd = H[(j + 1) * N + i + 1];
    if (u + v <= 1) return ha + (hb - ha) * u + (hc - ha) * v;
    return hd + (hc - hd) * (1 - u) + (hb - hd) * (1 - v);
  }
  normal(x, z, e = 1.0, out = [0, 1, 0]) {
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    let nx = -hx, ny = 2 * e, nz = -hz; const l = Math.hypot(nx, ny, nz);
    out[0] = nx / l; out[1] = ny / l; out[2] = nz / l; return out;
  }
}

// ---------------------------------------------------------------- world build
export async function buildWorld(progress) {
  const yieldUI = () => new Promise(r => setTimeout(r, 0));
  const W = {};
  // --- spine
  const spineDense = sampleCurve(SPINE_PTS, (a, b) => Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (Math.abs(a[0]) < 900 && Math.abs(b[0]) < 900 ? 30 : 260))), 3);
  const spine = new Polyline(spineDense);
  W.spine = spine;
  const sStart = spine.nearest(345, 300).s;
  W.sStart = sStart;
  const frame = (ds, o) => { // spine-relative -> world xz
    const f = spine.at(sStart + ds);
    const [rx, rz] = rightOf(f.tx, f.tz);
    return [f.x + rx * o, f.z + rz * o, f];
  };
  W.frame = frame;

  // landmark anchors in spine space
  const summits = [];
  const addSummit = (ds, o, amp, R) => { const [x, z] = frame(ds, o); summits.push({ x, z, amp, R }); return [x, z]; };
  const TARN_DS = 318, TARN_O = -44;
  const [tX, tZ, tF] = frame(TARN_DS, TARN_O);
  const tRight = rightOf(tF.tx, tF.tz);
  W.summitA = addSummit(TARN_DS + 5, TARN_O - 88, 78, 62);
  W.summitB = addSummit(505, 100, 70, 58);
  W.summitC = addSummit(520, -118, 72, 70);
  addSummit(640, 70, 40, 60);
  addSummit(260, 120, 26, 70);
  addSummit(140, -150, 30, 80);
  addSummit(760, -60, 55, 70);
  addSummit(-60, -110, 30, 70);

  const hf = new Heightfield();
  W.hf = hf;
  const N = hf.N, ax = hf.ax, H = hf.H;
  const res = {};

  function crestAt(s) { return spine.at(s).v2; }

  const SD = new Float32Array(N * N), SS = new Float32Array(N * N);
  W.SD = SD; W.SS = SS;
  let curK = 0;
  function baseHeight(x, z) {
    const sp = spine.nearest(x, z, res);
    SD[curK] = sp.sd; SS[curK] = sp.s;
    const s = sp.s;
    const warp = fbm2(x * 0.0035, z * 0.0035, 3) * 45 + fbm2(x * 0.012 + 5, z * 0.012, 2) * 10;
    let d = sp.sd + warp;
    const c = crestAt(s);
    const ad = Math.abs(d);
    let h, zone;
    if (d >= 0) {
      const t = clamp(d / 410, 0, 1); const p = t * t * (3 - 2 * t);
      h = lerp(c, 18, p);
      zone = Math.sin(Math.PI * Math.min(1, d / 410));
    } else {
      const t = clamp(-d / 340, 0, 1); const p = t * t * (3 - 2 * t);
      h = lerp(c, 58, p);
      zone = Math.sin(Math.PI * Math.min(1, -d / 340));
    }
    // spurs and gullies running downslope (anisotropic ridged noise in spine space)
    const g = ridged2(s * 0.011 + fbm2(x * 0.006, z * 0.006, 2) * 0.9, d * 0.0035, 4);
    h += zone * (g - 0.45) * 38;
    // rounded folds / soft badland lumps
    h += zone * fbm2(x * 0.02, z * 0.02, 4) * 7;
    // valley floors undulation
    const floorZone = 1 - zone;
    h += floorZone * fbm2(x * 0.006, z * 0.006, 3) * 6;
    // distant ranges rising on both sides + along the ridge
    const rOut = d >= 0 ? smoothstep(820, 2600, ad) : smoothstep(900, 4200, ad);
    if (rOut > 0) {
      const m = ridged2(x * 0.00042 + 3.1, z * 0.00042 - 1.7, 6);
      const m2 = ridged2(x * 0.0011 - 7, z * 0.0011 + 2, 5);
      const big = (d >= 0 ? 1150 : 520) * Math.pow(m, 1.6) + (d >= 0 ? 240 : 160) * m2;
      h += rOut * big;
    }
    // far away: long gradual rise so horizon is layered ranges
    const r = Math.hypot(x, z);
    const westK = clamp((-x - z * 0.3) / 6000, 0, 1);
    h += smoothstep(3000, 9000, r) * 450 * (1 - westK * 0.55) * (0.6 + 0.4 * fbm2(x * 0.0002, z * 0.0002, 2));
    // summits
    for (const S of summits) {
      const dx = x - S.x, dz = z - S.z; const q = (dx * dx + dz * dz) / (S.R * S.R);
      if (q < 9) h += S.amp * Math.exp(-q * 1.2) * (1 + 0.15 * simplex2(x * 0.03, z * 0.03));
    }
    // fine roughness
    h += fbm2(x * 0.07, z * 0.07, 3) * 1.1 * zone;
    return h;
  }

  // --- pass 1: base heights
  for (let j = 0; j < N; j++) {
    const z = ax[j];
    for (let i = 0; i < N; i++) { curK = j * N + i; H[curK] = baseHeight(ax[i], z); }
    if ((j & 31) === 0) { progress(0.05 + 0.35 * j / N); await yieldUI(); }
  }

  const inNear = (x, z, m = 0) => Math.abs(x) < NEAR - m && Math.abs(z) < NEAR - m;
  // iterate grid verts within radius of point (fine region)
  function forVerts(x, z, R, fn) {
    const i0 = hf.idx(x - R), i1 = hf.idx(x + R) + 1, j0 = hf.idx(z - R), j1 = hf.idx(z + R) + 1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(i, j, ax[i], ax[j], j * N + i);
  }

  // --- tarn bench + basin + headwall
  const tarn = { x: tX, z: tZ, rx: 19, rz: 14 };
  const fwd = [tF.tx, tF.tz];
  const left = [-tRight[0], -tRight[1]];
  tarn.fwd = fwd; tarn.left = left; tarn.right = tRight;
  tarn.rot = Math.atan2(fwd[1], fwd[0]);
  W.tarn = tarn;

  // --- trail keys (ds, offset)
  const keys = [[-8, 0], [0, 0], [35, 2], [75, -3], [110, 1], [138, 3], [150, -14], [165, 14], [180, -15], [195, 14], [210, -14], [225, 13], [240, -9], [256, 2],
    [278, -2], [300, -5], [318, -6], [336, -3], [358, 3], [380, 1], [410, -3], [440, 0], [470, -2], [505, -1], [530, 2], [560, -3], [590, 0], [615, 3], [635, 2], [650, 0]];
  const tk = keys.map(([ds, o]) => { const [x, z] = frame(ds, o); return [x, z]; });
  // --- cozy house at the end of the trail, then a path on to the mirror plain
  {
    const [hx, hz, hfr] = frame(690, 5);
    const fx = hfr.tx, fz = hfr.tz;
    const zA = [-fx, -fz];            // house front faces back down the trail
    const xA = [zA[1], -zA[0]];       // the cabin root's local +x (right-handed, same frame the geometry is built in)
    const toW = (lx, lz) => [hx + xA[0] * lx + zA[0] * lz, hz + xA[1] * lx + zA[1] * lz];
    const toL = (x, z) => { const dx = x - hx, dz = z - hz; return [dx * xA[0] + dz * xA[1], dx * zA[0] + dz * zA[1]]; };
    W.house = { x: hx, z: hz, xA, zA, toW, toL, rot: Math.atan2(zA[0], zA[1]), hx: 4.2, hz: 3.4, fence: { x0: -9.5, x1: 9.5, z0: -14.5, z1: 9.5 } };
    const [px, pz] = frame(780, -2);
    W.plain = { x: px, z: pz, r: 60, blend: 50 };
    const houseLocal = [[-1.4, 13], [-1.4, 9.4], [-1.4, 6.2], [-1.4, 5.0], [-1.4, 4.0], [-1.4, 3.1], [-1.5, 2.1], [-1.25, 1.2], [0.2, 0.0], [1.3, -1.2], [2.55, -2.6], [2.6, -3.9], [2.3, -5.4], [1.2, -8.2], [0.4, -12.4], [0.4, -14.9], [0.3, -18]];
    tk.push(frame(662, 2).slice(0, 2), frame(672, 3).slice(0, 2));
    for (const [lx, lz] of houseLocal) tk.push(toW(lx, lz));
    for (const [ds, o] of [[722, 2], [738, 0], [756, -1], [774, -2], [790, -2], [800, -3]]) tk.push(frame(ds, o).slice(0, 2));
    W.houseStopLocal = [-1.25, 1.2];
  }
  const trailDense = sampleCurve(tk, (a, b) => Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1.0)), 2);
  const trail0 = new Polyline(trailDense);
  const f00 = frame(0, 0); const startS = trail0.nearest(f00[0], f00[1]).s;
  W.trailStartS = startS;
  progress(0.42); await yieldUI();

  // tarn level from trail height near the crossing
  const trH0 = [];
  for (let i = 0; i < trail0.n; i++) trH0.push(hf.height(trail0.p[i][0], trail0.p[i][1]));
  const smoothArr = (arr, rad) => {
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let s = 0, w = 0;
      for (let k = -rad; k <= rad; k++) { const j = clamp(i + k, 0, arr.length - 1); const ww = Math.exp(-(k * k) / (rad * rad * 0.35)); s += arr[j] * ww; w += ww; }
      out[i] = s / w;
    }
    return out;
  };
  let trH = smoothArr(trH0, 14);
  // stream crossing: nearest trail point to tarn outlet line
  const crossPt = trail0.nearest(tX + tRight[0] * 44, tZ + tRight[1] * 44);
  const crossH = trH[crossPt.i];
  tarn.L = crossH - 1.7;
  const L = tarn.L;
  const benchH = L + 0.75;

  forVerts(tX, tZ, 110, (i, j, x, z, k) => {
    const dx = x - tX, dz = z - tZ;
    const u = dx * fwd[0] + dz * fwd[1], v = dx * left[0] + dz * left[1];
    const e = Math.sqrt((u / tarn.rx) ** 2 + (v / tarn.rz) ** 2) + 0.06 * simplex2(x * 0.15, z * 0.15);
    let hb;
    if (e < 1) hb = L - 0.25 - 3.4 * Math.pow(1 - e, 0.75);
    else hb = L - 0.25 + Math.min(1, (e - 1) / 0.35) * 1.0 + Math.max(0, e - 1.35) * 0.9;
    const w = 1 - smoothstep(1.35, 2.6, e);
    let h = H[k];
    h = lerp(h, Math.min(h, Math.max(hb, h - 30)), w); // cut
    if (e < 1.35) h = lerp(h, hb, smoothstep(1.35, 0.95, e) * 0.97 + 0.03);
    else h = lerp(h, Math.max(h, hb), w * 0.6);
    // headwall cliff beyond the far (left) shore
    const lat = Math.exp(-(((u / 32) ** 2)));
    const wall = 19 * smoothstep(tarn.rz + 4, tarn.rz + 16, v) * lat;
    h += wall + smoothstep(tarn.rz + 16, tarn.rz + 44, v) * lat * 10;
    H[k] = h;
  });
  // waterfall line on the headwall
  const wfTop = [tX + left[0] * (tarn.rz + 17) + fwd[0] * 4, tZ + left[1] * (tarn.rz + 17) + fwd[1] * 4];
  const wfBot = [tX + left[0] * (tarn.rz - 1.2) + fwd[0] * 4, tZ + left[1] * (tarn.rz - 1.2) + fwd[1] * 4];
  // notch the waterfall gully
  forVerts((wfTop[0] + wfBot[0]) / 2, (wfTop[1] + wfBot[1]) / 2, 14, (i, j, x, z, k) => {
    const dx = x - wfBot[0], dz = z - wfBot[1];
    const lat = dx * fwd[0] + dz * fwd[1] - 0; const along = dx * left[0] + dz * left[1];
    if (along < 1 || along > 24) return;
    H[k] -= 1.1 * Math.exp(-(((lat / 1.8) ** 2))) * smoothstep(1, 4, along);
  });
  tarn.wfTop = wfTop; tarn.wfBot = wfBot;
  progress(0.46); await yieldUI();

  // --- house pad (with garden) and the mirror plain plateau
  {
    const Hs = W.house;
    const padH = hf.height(Hs.x, Hs.z);
    Hs.padH = padH; Hs.floorH = padH + 0.42;
    forVerts(Hs.x, Hs.z, 30, (i, j, x, z, k) => {
      const [lx, lz] = Hs.toL(x, z);
      const ex = Math.max(0, Math.abs(lx) - 11), ez = Math.max(0, lz - 11, -16.5 - lz);
      const d = Math.hypot(ex, ez);
      H[k] = lerp(padH, H[k], smoothstep(0, 9, d));
    });
    const Pl = W.plain;
    const cH = spine.at(spine.nearest(Pl.x, Pl.z).s).v2;
    Pl.h = Math.min(cH - 5, padH - 3);
    forVerts(Pl.x, Pl.z, Pl.r + Pl.blend + 4, (i, j, x, z, k) => {
      const r = Math.hypot(x - Pl.x, z - Pl.z) + simplex2(x * 0.03, z * 0.03) * 4;
      const t = smoothstep(Pl.r - 2, Pl.r + Pl.blend, r);
      const bowl = Pl.h - 0.18 + Math.min(0, r - Pl.r) * 0.0005;
      const tt = t * t * (3 - 2 * t);
      H[k] = lerp(bowl, H[k], tt) + (simplex2(x * 0.045, z * 0.045) * 1.7 + simplex2(x * 0.12, z * 0.12) * 0.6) * Math.sin(Math.PI * tt) * 0.8;
    });
  }

  // --- recompute trail heights on modified field, then carve trail
  for (let i = 0; i < trail0.n; i++) trH0[i] = hf.height(trail0.p[i][0], trail0.p[i][1]);
  trH = smoothArr(trH0, 12);
  // keep the crossing high enough above the tarn outlet
  for (let i = 0; i < trail0.n; i++) {
    const dd = Math.abs(i - crossPt.i);
    if (dd < 14) trH[i] = Math.max(trH[i], lerp(L + 1.75, trH[i], dd / 14));
  }
  const trailPts = trailDense.map((p, i) => [p[0], p[1], trH[i]]);
  const trail = new Polyline(trailPts);
  W.trail = trail;
  W.trailH = trH;

  // high-resolution trail distance field (the path is narrower than the terrain grid)
  {
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (const p of trail.p) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); minz = Math.min(minz, p[1]); maxz = Math.max(maxz, p[1]); }
    const texel = 0.33, pad = 8;
    minx -= pad; minz -= pad; maxx += pad; maxz += pad;
    const tw = Math.ceil((maxx - minx) / texel), th = Math.ceil((maxz - minz) / texel);
    const data = new Uint8Array(tw * th).fill(255);
    const R = 4.2, rt = Math.ceil(R / texel);
    for (let s = 0; s <= trail.len; s += 0.2) {
      const a = trail.at(s);
      const ci = Math.floor((a.x - minx) / texel), cj = Math.floor((a.z - minz) / texel);
      for (let j = cj - rt; j <= cj + rt; j++) {
        if (j < 0 || j >= th) continue;
        for (let i = ci - rt; i <= ci + rt; i++) {
          if (i < 0 || i >= tw) continue;
          const x = minx + (i + 0.5) * texel, z = minz + (j + 0.5) * texel;
          const d = Math.hypot(x - a.x, z - a.z);
          if (d < R) { const v = Math.round(d * 60); const k = j * tw + i; if (v < data[k]) data[k] = v; }
        }
      }
    }
    W.trailField = { data, w: tw, h: th, x0: minx, z0: minz, texel };
  }

  // ovoo pass flattening & rest spot flattening (small pads)
  const pads = [];
  const ovooP = frame(505, 7.5); pads.push({ x: ovooP[0], z: ovooP[1], r: 4.5 });
  W.ovoo = { x: ovooP[0], z: ovooP[1] };
  const restP = frame(362, 12.5); W.rest = { x: restP[0], z: restP[1], f: [restP[2].tx, restP[2].tz] };
  pads.push({ x: restP[0], z: restP[1], r: 5.0 });
  for (const p of pads) {
    const h0 = hf.height(p.x, p.z);
    forVerts(p.x, p.z, p.r + 6, (i, j, x, z, k) => {
      const r = Math.hypot(x - p.x, z - p.z); const w = 1 - smoothstep(p.r, p.r + 5, r);
      H[k] = lerp(H[k], h0, w * 0.85);
    });
  }

  const tRes = {};
  for (let j = hf.idx(-NEAR); j <= hf.idx(NEAR); j++) {
    for (let i = hf.idx(-NEAR); i <= hf.idx(NEAR); i++) {
      const x = ax[i], z = ax[j];
      const q = trail.near(x, z, 9, tRes);
      if (!q) continue;
      const a = trail.p[q.i], b = trail.p[q.i + 1];
      const ht = a[2] + (b[2] - a[2]) * q.t;
      const w = 1 - smoothstep(0.9, 3.4, q.d);
      const k = j * N + i;
      const berm = Math.exp(-(((q.d - 0.95) / 0.3) ** 2)) * 0.05;
      H[k] = lerp(H[k], ht - 0.06 + berm, w);
    }
    if ((j & 63) === 0) { progress(0.46 + 0.1 * (j - hf.idx(-NEAR)) / NC); await yieldUI(); }
  }

  // keep the path under the film of water on the sky mirror
  {
    const Pl = W.plain;
    forVerts(Pl.x, Pl.z, Pl.r + 2, (i, j, x, z, k) => {
      const r = Math.hypot(x - Pl.x, z - Pl.z);
      if (r < Pl.r - 1) H[k] = Math.min(H[k], Pl.h - 0.1);
    });
  }
  // re-level the cabin pad after the trail carve so the house sits flush
  {
    const Hs = W.house;
    forVerts(Hs.x, Hs.z, 30, (i, j, x, z, k) => {
      const [lx, lz] = Hs.toL(x, z);
      const ex = Math.max(0, Math.abs(lx) - 11), ez = Math.max(0, lz - 11, -16.5 - lz);
      const d = Math.hypot(ex, ez);
      if (d < 0.01) H[k] = Hs.padH - 0.03; else H[k] = lerp(Hs.padH - 0.03, H[k], smoothstep(0, 6, d));
    });
  }

  // --- stream: from tarn outlet across the trail, then downhill
  const streamPts = [];
  {
    let x = tX + tRight[0] * (tarn.rz * 0.3) + fwd[0] * 0, z = tZ + tRight[1] * (tarn.rz * 0.3);
    // straight run to beyond trail crossing
    const cp = [crossPt.i];
    const target = trail.p[crossPt.i];
    let dx = target[0] - x, dz = target[1] - z; const dl = Math.hypot(dx, dz); dx /= dl; dz /= dl;
    for (let t = 0; t < dl + 12; t += 1.5) { const w = Math.sin(t * 0.21) * 1.6 * Math.min(1, t / 6) + Math.sin(t * 0.53 + 1.3) * 0.5; streamPts.push([x + dx * t - dz * w, z + dz * t + dx * w]); }
    streamPts.nRun = streamPts.length;
    let px = streamPts[streamPts.length - 1][0], pz = streamPts[streamPts.length - 1][1];
    let dirx = dx, dirz = dz; const nrm = [0, 1, 0];
    for (let n = 0; n < 700; n++) {
      hf.normal(px, pz, 3, nrm);
      let gx = nrm[0], gz = nrm[2]; const gl = Math.hypot(gx, gz) || 1;
      gx /= gl; gz /= gl;
      dirx = dirx * 0.82 + gx * 0.18 + simplex2(px * 0.05, pz * 0.05) * 0.06;
      dirz = dirz * 0.82 + gz * 0.18 + simplex2(px * 0.05 + 9, pz * 0.05) * 0.06;
      // never run down the trail bench: steer away from the path after the crossing
      const tq = trail.near(px, pz, 14);
      if (tq) {
        const ta = trail.at(tq.s);
        let ax = px - ta.x, az = pz - ta.z; const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
        const k = (1 - tq.d / 14) * 0.9;
        dirx += ax * k; dirz += az * k;
      }
      const l = Math.hypot(dirx, dirz); dirx /= l; dirz /= l;
      px += dirx * 1.8; pz += dirz * 1.8;
      streamPts.push([px, pz]);
      if (!inNear(px, pz, 8) || hf.height(px, pz) < 24) break;
    }
  }
  // smooth the descending course so it meanders instead of zig-zagging
  {
    const n0 = streamPts.nRun || 0;
    for (let it = 0; it < 4; it++) {
      const cp = streamPts.map(p => p.slice());
      for (let i = n0 + 2; i < streamPts.length - 2; i++) {
        streamPts[i][0] = (cp[i - 2][0] + cp[i - 1][0] * 2 + cp[i][0] * 3 + cp[i + 1][0] * 2 + cp[i + 2][0]) / 9;
        streamPts[i][1] = (cp[i - 2][1] + cp[i - 1][1] * 2 + cp[i][1] * 3 + cp[i + 1][1] * 2 + cp[i + 2][1]) / 9;
      }
    }
  }
  const streamPoly0 = new Polyline(streamPts);
  // resample and compute monotone bed
  const sp2 = [];
  for (let s = 0; s <= streamPoly0.len; s += 1.0) { const a = streamPoly0.at(s); sp2.push([a.x, a.z]); }
  // --- a big waterfall: terrace the valley flank so the stream plunges over a banded cliff into a pool
  {
    let iC = 0, bd = Infinity;
    const cpx = trail.p[crossPt.i][0], cpz = trail.p[crossPt.i][1];
    for (let i = 0; i < sp2.length; i++) { const d = Math.hypot(sp2[i][0] - cpx, sp2[i][1] - cpz); if (d < bd) { bd = d; iC = i; } }
    const iF = Math.min(sp2.length - 90, iC + 62);
    const F = sp2[iF];
    let dx = sp2[iF + 4][0] - sp2[iF - 4][0], dz = sp2[iF + 4][1] - sp2[iF - 4][1]; const dl = Math.hypot(dx, dz); dx /= dl; dz /= dl;
    const px = -dz, pz = dx;
    const drop = 24;
    const fU = (u) => drop / 2 * smoothstep(-70, -2, u) * (1 - smoothstep(-2, 3, u)) - drop / 2 * smoothstep(-2, 3, u) * (1 - smoothstep(3, 75, u));
    forVerts(F[0], F[1], 110, (i, j, x, z, k) => {
      const u = (x - F[0]) * dx + (z - F[1]) * dz, v = (x - F[0]) * px + (z - F[1]) * pz;
      const lat = Math.exp(-((v / 30) ** 2));
      const tq = trail.near(x, z, 22);
      const keepTrail = tq ? smoothstep(7, 22, tq.d) : 1;
      H[k] += fU(u) * lat * keepTrail;
    });
    W.falls = { iF, x: F[0], z: F[1], dx, dz, px, pz, drop };
  }
  const bed = new Float32Array(sp2.length);
  let prev = L - 0.28;
  for (let i = 0; i < sp2.length; i++) {
    const g = hf.height(sp2[i][0], sp2[i][1]);
    const tarnInside = i < tarn.rz * 0.7;
    let b = tarnInside ? L - 0.28 : Math.min(prev - 0.004, g - 0.95);
    prev = b; bed[i] = b;
  }
  const bedS = smoothArr(Array.from(bed), 3);
  for (let i = 1; i < bedS.length; i++) bedS[i] = Math.min(bedS[i], bedS[i - 1] - 0.002);
  const stream = new Polyline(sp2.map((p, i) => [p[0], p[1], bedS[i]]));
  W.stream = stream;
  {
    const Fl = W.falls; const iF = Fl.iF;
    // lip: last point before the drop; base: where the bed flattens again
    let iLip = iF - 6;
    for (let i = iF - 12; i < iF + 10; i++) if (bedS[i] - bedS[i + 1] > 0.8) { iLip = i; break; }
    let iBase = iLip + 1;
    while (iBase < bedS.length - 2 && bedS[iBase] - bedS[iBase + 1] > 0.5) iBase++;
    Fl.iLip = iLip; Fl.iBase = iBase;
    Fl.lip = { x: sp2[iLip][0], z: sp2[iLip][1], y: bedS[iLip] + 0.3 };
    const iPool = Math.min(bedS.length - 2, iBase + 6);
    Fl.pool = { x: sp2[iPool][0], z: sp2[iPool][1], r: 7.5, level: bedS[iPool] + 1.0 };
    Fl.base = { x: sp2[iBase][0], z: sp2[iBase][1], y: Fl.pool.level };
    Fl.height = Fl.lip.y - Fl.pool.level;
    // stream bed inside the pool sits at the pool floor
    for (let i = iBase; i < bedS.length; i++) {
      const d = Math.hypot(sp2[i][0] - Fl.pool.x, sp2[i][1] - Fl.pool.z);
      if (d < Fl.pool.r) stream.p[i][2] = Math.min(stream.p[i][2], Fl.pool.level - 0.35);
    }
  }
  W.bridge = (() => {
    const q = stream.nearest(trail.p[crossPt.i][0], trail.p[crossPt.i][1]);
    const sp = stream.at(q.s);
    const tp = trail.nearest(sp.x, sp.z);
    const ta = trail.at(tp.s);
    return { x: sp.x, z: sp.z, s: q.s, trailS: tp.s, deck: ta.v2 + 0.2, tx: ta.tx, tz: ta.tz, sx: sp.tx, sz: sp.tz };
  })();
  // carve stream channel
  const sRes = {};
  for (let j = hf.idx(-NEAR); j <= hf.idx(NEAR); j++) {
    for (let i = hf.idx(-NEAR); i <= hf.idx(NEAR); i++) {
      const x = ax[i], z = ax[j];
      const q = stream.near(x, z, 8, sRes);
      if (!q) continue;
      const a = stream.p[q.i], b = stream.p[q.i + 1];
      const hb = a[2] + (b[2] - a[2]) * q.t;
      const wdt = 1.35 + 0.35 * simplex2(q.s * 0.05, 0);
      const prof = hb + Math.max(0, q.d - wdt * 0.45) ** 1.35 * 0.85;
      const k = j * N + i;
      if (tarnEllipse(x, z) < 1.0) continue;
      H[k] = Math.min(H[k], prof);
    }
  }
  {
    const P = W.falls.pool;
    forVerts(P.x, P.z, P.r + 6, (i, j, x, z, k) => {
      const r = Math.hypot(x - P.x, z - P.z) / P.r + 0.08 * simplex2(x * 0.2, z * 0.2);
      if (r < 1) H[k] = Math.min(H[k], P.level - 0.25 - 1.9 * (1 - r * r));
      else if (r < 1.5) H[k] = Math.min(H[k], lerp(P.level - 0.2, H[k], smoothstep(1.0, 1.5, r)));
    });
  }
  // stream distance / water-level field, so the terrain can shade a real streambed under the clear water
  {
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (const p of stream.p) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); minz = Math.min(minz, p[1]); maxz = Math.max(maxz, p[1]); }
    const texel = 0.3, pad = 5; minx -= pad; minz -= pad; maxx += pad; maxz += pad;
    const tw = Math.ceil((maxx - minx) / texel), th = Math.ceil((maxz - minz) / texel);
    const data = new Float32Array(tw * th * 2);
    for (let k = 0; k < tw * th; k++) { data[k * 2] = 9; data[k * 2 + 1] = -1000; }
    const R = 3.2, rt = Math.ceil(R / texel);
    const Fl = W.falls; const sLip = stream.s[Fl.iLip] - 0.5, sBase = stream.s[Fl.iBase] + 0.5;
    for (let s = 0; s <= stream.len; s += 0.25) {
      if (s > sLip && s < sBase) continue;
      const a = stream.at(s);
      if (tarnEllipse(a.x, a.z) < 0.92) continue;
      if (Math.hypot(a.x - Fl.pool.x, a.z - Fl.pool.z) < Fl.pool.r * 0.92) continue;
      const level = a.v2 + 0.25;
      const ci = Math.floor((a.x - minx) / texel), cj = Math.floor((a.z - minz) / texel);
      for (let j = cj - rt; j <= cj + rt; j++) {
        if (j < 0 || j >= th) continue;
        for (let i = ci - rt; i <= ci + rt; i++) {
          if (i < 0 || i >= tw) continue;
          const x = minx + (i + 0.5) * texel, z = minz + (j + 0.5) * texel;
          const d = Math.hypot(x - a.x, z - a.z); const k = (j * tw + i) * 2;
          if (d < R && d < data[k]) { data[k] = d; data[k + 1] = level; }
        }
      }
    }
    W.streamField = { data, w: tw, h: th, x0: minx, z0: minz, texel };
  }
  function tarnEllipse(x, z) {
    const dx = x - tX, dz = z - tZ;
    const u = dx * fwd[0] + dz * fwd[1], v = dx * left[0] + dz * left[1];
    return Math.sqrt((u / tarn.rx) ** 2 + (v / tarn.rz) ** 2);
  }
  W.tarnEllipse = tarnEllipse;
  progress(0.6); await yieldUI();

  // --- braided river in the valley (right side), defined in spine space
  const riverO = (ds) => 505 + 60 * simplex2(ds * 0.002, 3.3) + 25 * simplex2(ds * 0.006, 1.1);
  const braids = [];
  for (let b = 0; b < 5; b++) braids.push({
    off: b === 0 ? () => 0 : (ds) => 38 * simplex2(ds * 0.009 + b * 13.7, b * 3.1) + (b - 2.5) * 9,
    width: b === 0 ? 11 : 3.5 + (b % 3) * 1.8,
  });
  W.river = { o: riverO, braids };
  const floorH = (x, z) => 16 + fbm2(x * 0.004, z * 0.004, 2) * 1.5;
  W.floorH = floorH;
  for (let k = 0; k < N * N; k++) {
    const ds = SS[k] - sStart, d = SD[k];
    const ro = riverO(ds);
    const dr = Math.abs(d - ro);
    if (dr > 260) continue;
    const x = ax[k % N], z = ax[(k / N) | 0];
    const fh = floorH(x, z);
    const w = 1 - smoothstep(90, 240, dr);
    if (H[k] > fh) H[k] = lerp(H[k], fh + (H[k] - fh) * 0.25, w);
    if (dr > 90) continue;
    let cut = 0;
    for (const br of braids) {
      const dd = Math.abs(d - ro - br.off(ds));
      cut = Math.max(cut, (1 - smoothstep(br.width * 0.35, br.width * 0.9, dd)) * (0.7 + br.width * 0.03));
    }
    H[k] -= cut;
  }
  W.riverLevel = (x, z) => floorH(x, z) - 0.28;
  progress(0.66); await yieldUI();

  // --- herd shelter pad
  {
    const [x, z] = frame(430, 330);
    const h0 = hf.height(x, z);
    forVerts(x, z, 20, (i, j, xx, zz, k) => { const r = Math.hypot(xx - x, zz - z); H[k] = lerp(H[k], h0, 1 - smoothstep(9, 18, r)); });
    W.shelter = { x, z, rot: Math.atan2(frame(430, 330)[2].tz, frame(430, 330)[2].tx) };
  }

  // --- snowfield region (above headwall)
  W.snow = { x: tX + left[0] * (tarn.rz + 24) + fwd[0] * 4, z: tZ + left[1] * (tarn.rz + 24) + fwd[1] * 4, rx: 26, rz: 12 };

  // --- landmarks
  const mk = frame(75, 2.3); W.marker = { x: mk[0], z: mk[1] };
  const bn = frame(30, -3.4); W.bones = { x: bn[0], z: bn[1], f: [bn[2].tx, bn[2].tz] };
  {
    const B = W.summitB; const tp = frame(430, 0);
    let dx = tp[0] - B[0], dz = tp[1] - B[1]; const l = Math.hypot(dx, dz); dx /= l; dz /= l;
    W.cliff = { x: B[0] + dx * 44, z: B[1] + dz * 44, nx: dx, nz: dz };
  }

  // --- a gentle grassy hill falls from the cabin's yard to the water (no sheer embankment)
  {
    const Hs = W.house;
    forVerts(Hs.x, Hs.z, 70, (i, j, x, z, k) => {
      const [lx, lz] = Hs.toL(x, z);
      const ex = Math.max(0, Math.abs(lx) - 11), ez = Math.max(0, lz - 11, -16.5 - lz);
      const d = Math.hypot(ex, ez);
      if (d <= 0.01) return;
      const bump = (simplex2(x * 0.06, z * 0.06) * 1.1 + simplex2(x * 0.15, z * 0.15) * 0.35) * smoothstep(3, 14, d);
      const cone = Hs.padH - 0.03 - (0.2 * d + 0.0035 * d * d) + bump;
      if (cone > H[k]) H[k] = lerp(H[k], cone, 1 - smoothstep(40, 70, d));
    });
  }
  // --- the endless mirror: past the plain, everything ahead and to the sides sinks to a film of water all the way
  //     to the horizon; only the mountains behind (where the trail comes from) remain. The ramp widens away from the
  //     ridge so the valleys ease up to the waterline instead of ending in a wall.
  {
    const Pl = W.plain;
    Pl.sP = spine.nearest(Pl.x, Pl.z).s;
    const lvl = Pl.h - 0.18;
    const sH = spine.nearest(W.house.x, W.house.z).s;
    // a meandering shoreline (bays and low points) that never reaches the cabin's garden
    const endlessW = (ss, sd) => {
      const bw = 60 + 0.7 * Math.abs(sd);
      const wob = 26 * simplex2(sd * 0.011, 7.7) + 9 * simplex2(sd * 0.047, 3.1);
      const s0 = Math.max(sH + 26, Pl.sP - 25 - bw + wob), s1 = Math.max(s0 + 24, Pl.sP - 25 + wob * 0.5);
      return smoothstep(s0, s1, ss + 6 * simplex2(sd * 0.09, ss * 0.09));
    };
    W.endlessW = endlessW;
    const ew = new Float32Array(N * N);
    for (let k = 0; k < N * N; k++) {
      const w = endlessW(SS[k], SD[k]); ew[k] = w;
      if (w > 0) {
        const x = ax[k % N], z = ax[(k / N) | 0];
        const ws = w * w * (3 - 2 * w);
        H[k] = lerp(H[k], lvl, ws) + (simplex2(x * 0.04, z * 0.04) * 1.8 + simplex2(x * 0.11, z * 0.11) * 0.6) * Math.sin(Math.PI * ws) * 0.8;
      }
    }
    W.endlessK = (x, z) => ew[hf.idx(z) * N + hf.idx(x)];
  }

  // --- vertex attributes / masks
  progress(0.7); await yieldUI();
  const normals = new Float32Array(N * N * 3);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const il = Math.max(0, i - 1), ir = Math.min(N - 1, i + 1), jl = Math.max(0, j - 1), jr = Math.min(N - 1, j + 1);
    const hx = (H[j * N + ir] - H[j * N + il]) / (ax[ir] - ax[il]);
    const hz = (H[jr * N + i] - H[jl * N + i]) / (ax[jr] - ax[jl]);
    let nx = -hx, ny = 1, nz = -hz; const l = Math.hypot(nx, ny, nz);
    const k = (j * N + i) * 3; normals[k] = nx / l; normals[k + 1] = ny / l; normals[k + 2] = nz / l;
  }
  W.normals = normals;
  const mask = new Float32Array(N * N * 4);   // grass, scree, snow, gravel
  const extra = new Float32Array(N * N * 4);  // trail, ao, moist, rockiness
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = ax[i], z = ax[j], k = j * N + i;
      const ny = normals[k * 3 + 1];
      const slope = 1 - ny;
      const h = H[k];
      // curvature-based AO (cavities darker)
      const il = Math.max(0, i - 2), ir = Math.min(N - 1, i + 2), jl = Math.max(0, j - 2), jr = Math.min(N - 1, j + 2);
      const avg = (H[j * N + il] + H[j * N + ir] + H[jl * N + i] + H[jr * N + i]) * 0.25;
      const spacing = (ax[ir] - ax[il]) * 0.5;
      const cav = (avg - h) / Math.max(spacing, 1);
      const ao = clamp(1 - cav * 1.6, 0.35, 1);
      const nz1 = fbm2(x * 0.03, z * 0.03, 3), nz2 = simplex2(x * 0.12, z * 0.12);
      let grass = smoothstep(0.55, 0.22, slope + nz1 * 0.1) * (0.72 + 0.28 * smoothstep(-0.5, 0.3, nz1));
      grass *= 1 - smoothstep(330, 420, h + nz1 * 40);
      let scree = smoothstep(0.3, 0.46, slope + nz2 * 0.05) * (1 - smoothstep(0.7, 0.85, slope)) * smoothstep(-0.2, 0.25, fbm2(x * 0.018 + 4, z * 0.018, 3) + 0.05);
      // explicit scree field on the switchback nose
      let snow = 0, gravel = 0, trailM = 0, moist = 0, trailD = 9;
      if (inNear(x, z)) {
        const dsl = SS[k] - sStart;
        const nose = smoothstep(150, 172, dsl) * (1 - smoothstep(222, 245, dsl)) * (1 - smoothstep(40, 80, Math.abs(SD[k] + 20))) * smoothstep(-0.25, 0.25, nz1 + 0.1);
        scree = Math.max(scree, nose * smoothstep(0.05, 0.16, slope + nz2 * 0.06));
        grass *= 1 - nose * 0.45;
        const tq = trail.near(x, z, 6, tRes);
        if (tq) { trailM = 1 - smoothstep(0.45, 1.05 + nz2 * 0.25, tq.d); trailD = tq.d; }
        const e = tarnEllipse(x, z);
        const sq2 = stream.near(x, z, 10, sRes);
        moist = Math.max(1 - smoothstep(1.0, 1.9, e), sq2 ? 1 - smoothstep(1.5, 7, sq2.d) : 0);
        if (e < 1.05) { grass = 0; scree = 0; }
        const plD = Math.hypot(x - W.plain.x, z - W.plain.z);
        if (plD < W.plain.r + 70) { const kpl = 1 - smoothstep(0.25, 1.4, h - W.plain.h); grass *= 1 - kpl; scree *= 1 - kpl; moist = Math.max(moist, kpl); }
        { const [hlx, hlz] = W.house.toL(x, z); if (Math.abs(hlx) < 11 && hlz > -16.5 && hlz < 11) scree = 0; }
        const poolD = Math.hypot(x - W.falls.pool.x, z - W.falls.pool.z) / W.falls.pool.r;
        if (poolD < 1.4) { grass *= smoothstep(1.05, 1.4, poolD); scree *= smoothstep(1.05, 1.4, poolD); moist = Math.max(moist, 1 - smoothstep(1.0, 1.6, poolD)); }
        if (sq2 && sq2.d < 2.2) grass *= smoothstep(1.3, 2.2, sq2.d);
        // snowfield
        const sx = x - W.snow.x, sz = z - W.snow.z;
        const su = sx * fwd[0] + sz * fwd[1], sv = sx * left[0] + sz * left[1];
        const se = Math.sqrt((su / W.snow.rx) ** 2 + (sv / W.snow.rz) ** 2) + fbm2(x * 0.08, z * 0.08, 3) * 0.45;
        snow = 1 - smoothstep(0.8, 1.0, se);
        if (snow > 0) grass *= 1 - snow;
      }
      // far snow on high peaks
      snow = Math.max(snow, smoothstep(1180, 1320, h + nz1 * 120) * smoothstep(0.75, 0.45, slope));
      // valley gravel
      const rqd = Math.abs(SD[k] - riverO(SS[k] - sStart));
      if (rqd < 150) { gravel = (1 - smoothstep(30, 120, rqd + nz1 * 40)) * smoothstep(0.2, 0.05, slope); grass *= 1 - gravel * 0.8; }
      { const ek = W.endlessW(SS[k], SD[k]); if (ek > 0) { const kw = 1 - smoothstep(0.25, 1.4, h - W.plain.h); grass *= 1 - kw; scree *= 1 - kw; snow *= 1 - Math.max(kw, ek); gravel = Math.max(gravel, kw * 0.5); } }
      mask[k * 4] = clamp(grass * smoothstep(0.35, 1.0, trailD), 0, 1);
      mask[k * 4 + 1] = clamp(scree * (1 - snow), 0, 1);
      mask[k * 4 + 2] = snow;
      mask[k * 4 + 3] = gravel;
      extra[k * 4] = Math.min(trailD, 9); extra[k * 4 + 1] = ao; extra[k * 4 + 2] = moist; extra[k * 4 + 3] = slope;
    }
    if ((j & 63) === 0) { progress(0.7 + 0.18 * j / N); await yieldUI(); }
  }
  W.mask = mask; W.extra = extra;
  W.maskAt = (x, z) => {
    const i = hf.idx(x), j = hf.idx(z);
    const u = (x - ax[i]) / (ax[i + 1] - ax[i]) > 0.5 ? 1 : 0, v = (z - ax[j]) / (ax[j + 1] - ax[j]) > 0.5 ? 1 : 0;
    const k = ((j + v) * N + i + u) * 4;
    return [mask[k], mask[k + 1], mask[k + 2], mask[k + 3], 1 - smoothstep(0.38, 0.62, W.trailDistAt(x, z)), extra[k + 1], extra[k + 2], extra[k + 3]];
  };
  W.trailDistAt = (x, z) => {
    const f = W.trailField; const i = Math.floor((x - f.x0) / f.texel), j = Math.floor((z - f.z0) / f.texel);
    if (i < 0 || j < 0 || i >= f.w || j >= f.h) return 9; const v = f.data[j * f.w + i] / 60; return v > 4.2 ? 9 : v;
  };
  W.rng = mulberry32(2024);
  // bridge override for ground queries
  const br = W.bridge;
  W.bridgeHalfLen = 4.2; W.bridgeHalfW = 0.75;
  const Hs = W.house;
  W.houseFloorAt = (x, z) => {
    const [lx, lz] = Hs.toL(x, z);
    if (Math.abs(lx) <= Hs.hx + 0.05 && Math.abs(lz) <= Hs.hz + 0.05) return Hs.floorH;
    if (lx > -2.9 && lx < 0.1 && lz > Hs.hz && lz < Hs.hz + 1.35) return Hs.floorH - 0.04;               // porch deck
    if (lx > -2.1 && lx < -0.7 && lz >= Hs.hz + 1.35 && lz < Hs.hz + 2.05) return Hs.floorH - 0.04 - (lz - Hs.hz - 1.35) / 0.7 * 0.38; // steps
    if (lx > 1.9 && lx < 3.3 && lz < -Hs.hz && lz > -Hs.hz - 0.8) return Hs.floorH - 0.02 - (-Hs.hz - lz) / 0.8 * 0.38;      // back step
    return null;
  };
  W.ground = (x, z) => {
    const fl = W.houseFloorAt(x, z);
    if (fl !== null) return Math.max(fl, hf.height(x, z));
    const h = hf.height(x, z);
    const dx = x - br.x, dz = z - br.z;
    const a = dx * br.tx + dz * br.tz, b = -dx * br.tz + dz * br.tx;
    if (Math.abs(a) < W.bridgeHalfLen && Math.abs(b) < W.bridgeHalfW + 0.2) return Math.max(h, br.deck);
    return h;
  };
  progress(0.9);
  return W;
}
