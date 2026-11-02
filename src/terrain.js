import * as THREE from 'three';
import { U, patch } from './materials.js';

export function buildHeightTexture(W) {
  const S = 2048, size = 5200;
  const data = new Uint16Array(S * S);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const x = (i + 0.5) / S * size - size / 2, z = (j + 0.5) / S * size - size / 2;
    data[j * S + i] = THREE.DataUtils.toHalfFloat(W.hf.height(x, z));
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RedFormat, THREE.HalfFloatType);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
  U.uHeightTex.value = t;
  U.uHeightInfo.value.set(0, 0, size, 0);
  return t;
}

export function buildTrailTexture(W) {
  const f = W.trailField;
  const t = new THREE.DataTexture(f.data, f.w, f.h, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
  U.uTrailTex.value = t;
  U.uTrailRect.value.set(f.x0, f.z0, f.w * f.texel, f.h * f.texel);
  return t;
}

// (GLSL helper injected into the terrain shader below)
export function buildStreamTexture(W) {
  const f = W.streamField;
  const t = new THREE.DataTexture(f.data, f.w, f.h, THREE.RGFormat, THREE.FloatType);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
  U.uStreamTex.value = t;
  U.uStreamRect.value.set(f.x0, f.z0, f.w * f.texel, f.h * f.texel);
  return t;
}

const ROUND_STONES = `
vec3 roundStones(vec2 p){
  vec2 ip = floor(p), fp = fract(p);
  float best = 9.0, id = 0.0, rad = 0.4;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 c = ip + g;
    vec2 o = hash22(c) * 0.6 + 0.2;
    float h = hash12(c + 3.7);
    float ang = h * 6.283;
    vec2 r = g + o - fp;
    r = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * r;
    r.x *= 1.0 + 0.45 * fract(h * 7.1);
    float rr = 0.26 + 0.2 * fract(h * 3.3);
    float d = length(r) / rr;
    if (d < best) { best = d; id = hash12(c); rad = rr; }
  }
  float dome = sqrt(max(0.0, 1.0 - best * best));
  return vec3(best, id, dome);
}
`;

export function buildTerrain(W) {
  const hf = W.hf, N = hf.N, ax = hf.ax;
  const pos = new Float32Array(N * N * 3);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    pos[k * 3] = ax[i]; pos[k * 3 + 1] = hf.H[k]; pos[k * 3 + 2] = ax[j];
  }
  const idx = new Uint32Array((N - 1) * (N - 1) * 6);
  let p = 0;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    idx[p++] = a; idx[p++] = c; idx[p++] = b;
    idx[p++] = b; idx[p++] = c; idx[p++] = d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(W.normals, 3));
  g.setAttribute('aMask', new THREE.BufferAttribute(W.mask, 4));
  g.setAttribute('aExtra', new THREE.BufferAttribute(W.extra, 4));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 300, 0), 16000);

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  patch(mat, {
    key: 'terrain',
    wet: 1.0,
    bump: 1.0,
    shadowBias: 1.6,
    vHead: 'attribute vec4 aMask; attribute vec4 aExtra; varying vec4 vMask; varying vec4 vExtra;',
    vBegin: 'vMask = aMask; vExtra = aExtra;',
    fHead: 'varying vec4 vMask; varying vec4 vExtra; float gCaustic = 0.0; vec3 SRGB(float r, float g, float b){ return pow(vec3(r, g, b), vec3(2.2)); }' + ROUND_STONES,
    fColor: TERRAIN_COLOR,
    fRough: 'roughnessFactor = mix(roughnessFactor, 0.55, vMask.b);',
    fLight: 'reflectedLight.indirectDiffuse *= vExtra.y; reflectedLight.directDiffuse *= mix(1.0, vExtra.y, 0.35); reflectedLight.directDiffuse += diffuseColor.rgb * uKeyColor * gCaustic * 0.55 * gTSh;',
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

const TERRAIN_COLOR = /* glsl */`
{
  vec3 wp = vWPos;
  vec3 n = normalize(vWNrm);
  float slope = 1.0 - n.y;
  float dist = length(wp - cameraPosition);
  float detail = 1.0 - smoothstep(60.0, 260.0, dist);
  float grass = vMask.r, scree = vMask.g, snow = vMask.b, gravel = vMask.a;
  float moist = vExtra.z;
  // planar coords that don't stretch on steep faces
  vec2 perp = normalize(vec2(-n.z, n.x) + vec2(1e-4, 0.0));
  vec2 nA = slope > 0.42 ? vec2(dot(wp.xz, perp), wp.y) : wp.xz;
  float n1 = texture2D(uNoiseTex, nA * 0.013).r;
  float n2 = texture2D(uNoiseTex, nA * 0.061).g;
  float n3 = texture2D(uNoiseTex, nA * 0.27).b;
  float n4 = texture2D(uNoiseTex, nA * 1.3).a;
  float tdist = trailDist(wp.xz);
  float trail = 1.0 - smoothstep(0.38, 0.62, tdist + (texture2D(uNoiseTex, wp.xz * 0.35).g - 0.5) * 0.16);
  float nearTrail = 1.0 - smoothstep(0.6, 1.8, tdist);

  // ----- banded rock
  vec3 rock = strataColor(wp);
  // erosion runnels on steep faces: vertical streaks
  vec2 sp = vec2(dot(wp.xz, vec2(0.7, 0.7)) * 0.9, wp.y * 0.05);
  float streak = texture2D(uNoiseTex, sp * vec2(0.35, 0.1)).r;
  float face = smoothstep(0.25, 0.6, slope);
  rock *= mix(1.0, 0.78 + 0.34 * streak, face);
  rock *= 0.86 + 0.28 * n2;
  // fine laminations & fractures
  float lam = texture2D(uNoiseTex, vec2(wp.y * 0.9 + n1 * 3.0, dot(wp.xz, vec2(0.02)))).b;
  rock *= mix(1.0, 0.88 + 0.22 * lam, detail * face);
  // lichen blotches on rock tops
  float lich = smoothstep(0.68, 0.74, texture2D(uNoiseTex, nA * 0.21 + 3.1).r + n4 * 0.08) * (1.0 - face * 0.6);
  rock = mix(rock, mix(SRGB(0.78, 0.52, 0.16), SRGB(0.62, 0.68, 0.44), step(0.5, n3)), lich * 0.55 * detail);
  float bump = (streak - 0.5) * 0.6 * face + (lam - 0.5) * 0.25 * face + n4 * 0.08;

  // ----- soil tint: weathered strata colour
  vec3 soil = mix(rock, SRGB(0.46, 0.4, 0.3), 0.45) * 0.88;

  // soil grit: small embedded stones and dry stubble tones
  // (computed below after pebbles)
  // ----- scree: pebbles over light strata debris
  vec2 pb = pebbles(nA * 9.0);
  vec2 pb2 = pebbles(nA * 23.0 + 7.0);
  float aa1 = 1.0 - smoothstep(0.25, 0.6, length(fwidth(nA)) * 9.0);
  float aa2 = 1.0 - smoothstep(0.25, 0.6, length(fwidth(nA)) * 23.0);
  pb.x = mix(0.5, pb.x, aa1); pb.y = mix(0.5, pb.y, aa1); pb2.x = mix(0.5, pb2.x, aa2); pb2.y = mix(0.5, pb2.y, aa2);
  vec3 stoneCol = strataColor(wp + vec3(0.0, (n2 - 0.5) * 4.0, 0.0));
  stoneCol = mix(stoneCol, vec3(dot(stoneCol, vec3(0.33))), 0.25);
  float edge = smoothstep(0.0, 0.12, pb.x);
  vec3 screeC = stoneCol * (0.86 + 0.16 * pb.y) * mix(1.0, 0.95 + 0.05 * edge, 1.0 - smoothstep(3.0, 12.0, dist));
  screeC *= 0.88 + 0.22 * pb2.y * smoothstep(0.0, 0.1, pb2.x);
  float pfar = smoothstep(8.0, 40.0, dist);
  screeC = mix(screeC, stoneCol * 0.8, pfar * 0.8);
  float screeBump = edge * 0.12 + pb.y * 0.22 + smoothstep(0.0, 0.1, pb2.x) * 0.06;
  float grit = smoothstep(0.1, 0.2, pb2.x) * step(0.84, pb2.y) * aa2;
  soil = mix(soil, stoneCol * 0.9, grit * 0.5 * detail);
  soil *= 0.9 + 0.2 * n3;
  bump += grit * 0.1;

  // ----- alpine grass (late summer: olive, straw-gold, sage)
  vec3 gA = SRGB(0.36, 0.38, 0.2), gB = SRGB(0.6, 0.53, 0.33), gC = SRGB(0.42, 0.45, 0.3);
  vec3 grassC = mix(gA, gB, smoothstep(0.35, 0.75, n1));
  grassC = mix(grassC, gC, smoothstep(0.4, 0.8, n2) * 0.5);
  grassC *= 0.82 + 0.3 * n3 * detail + 0.1 * n4;
  grassC = mix(grassC, soil, smoothstep(0.55, 0.2, grass) * 0.5);
  // under the 3D grass carpet the ground reads darker (self-shadowed stems)
  grassC *= mix(1.0, 0.72, grass * (1.0 - smoothstep(20.0, 70.0, dist)));
  grassC = mix(grassC, SRGB(0.22, 0.34, 0.12), moist * 0.6);
  float gstr = texture2D(uNoiseTex, vec2(wp.x * 2.3 + wp.z * 0.7, wp.z * 2.3 - wp.x * 0.7)).a;
  grassC *= 0.82 + 0.3 * gstr;

  // ----- trail: compacted dusty path with embedded stones
  vec2 tp = pebbles(wp.xz * 11.0);
  float aat = 1.0 - smoothstep(0.25, 0.6, length(fwidth(wp.xz)) * 11.0);
  tp = mix(vec2(0.5), tp, aat);
  vec3 trailC = SRGB(0.47, 0.38, 0.28) * (0.84 + 0.2 * n3 + 0.08 * n4);
  trailC = mix(trailC, trailC * 1.12, smoothstep(0.05, 0.25, tp.x) * step(0.93, tp.y) * detail);
  trailC *= 0.92 + 0.08 * smoothstep(0.0, 0.15, tp.x);

  // ----- gravel flats
  vec3 grav = mix(SRGB(0.58, 0.57, 0.53), SRGB(0.72, 0.70, 0.66), n3) * (0.8 + 0.3 * smoothstep(0.0, 0.2, pb2.x));

  // ----- snow
  vec3 snowC = SRGB(0.93, 0.95, 1.0) * (0.92 + 0.08 * n2);

  // compose
  vec3 col = mix(soil, rock, smoothstep(0.18, 0.42, slope + (n1 - 0.5) * 0.15));
  col = mix(col, screeC, scree);
  col = mix(col, grassC, grass * (1.0 - face * 0.7));
  col = mix(col, grav, gravel);
  col = mix(col, mix(grassC * 0.85, trailC, 0.35), nearTrail * (1.0 - trail) * 0.8);
  col = mix(col, trailC, trail);
  col = mix(col, snowC, smoothstep(0.1, 0.5, snow + (n3 - 0.5) * 0.3));
  // underwater beds: tarn, plunge pool, stream channel -> pebbly, wet, tinted, with caustics
  float wlev = -1e5;
  if (moist > 0.05 && abs(wp.y - uTarnL) < 6.0 && length(wp.xz - uTarnP.xy) < uTarnP.z) wlev = uTarnL;
  float poolD = length(wp.xz - uPool.xy);
  if (poolD < uPool.z * 1.2) wlev = uPool.w;
  // running stream: water level of the nearest centreline point
  float streamK = 0.0;
  {
    vec2 suv = (wp.xz - uStreamRect.xy) / uStreamRect.zw;
    if (suv.x > 0.0 && suv.y > 0.0 && suv.x < 1.0 && suv.y < 1.0) {
      vec2 sf = texture2D(uStreamTex, suv).rg;
      if (sf.x < 3.0 && sf.y > wlev) { wlev = sf.y; streamK = 1.0; }
    }
  }
  float under = wlev - wp.y;
  gCaustic = 0.0;
  if (under > -0.35) {
    // rounded stones of mixed rock (greys, ochre, rust, the odd quartz) resting in gravel
    vec3 sA = roundStones(wp.xz * 3.4 + 3.0);
    vec3 sB = roundStones(wp.xz * 8.5 + 11.0);
    vec2 bpB = pebbles(wp.xz * 16.0 + 7.0);
    vec3 grav2 = mix(SRGB(0.36, 0.33, 0.28), SRGB(0.5, 0.46, 0.39), bpB.y) * (0.72 + 0.28 * smoothstep(0.0, 0.15, bpB.x));
    float hA = sA.y, hB = sB.y;
    vec3 stA = hA < 0.32 ? SRGB(0.47, 0.46, 0.43) : hA < 0.55 ? SRGB(0.52, 0.44, 0.33) : hA < 0.72 ? SRGB(0.45, 0.34, 0.28) : hA < 0.93 ? SRGB(0.37, 0.37, 0.38) : SRGB(0.7, 0.68, 0.63);
    vec3 stB = mix(SRGB(0.42, 0.4, 0.37), SRGB(0.55, 0.49, 0.4), fract(hB * 3.7));
    stA *= 0.86 + 0.24 * fract(hA * 13.7);
    vec3 bed = grav2;
    bed = mix(bed, stB * (0.6 + 0.45 * sB.z), smoothstep(0.0, 0.08, sB.z));
    bed = mix(bed, stA * (0.55 + 0.5 * sA.z), smoothstep(0.0, 0.06, sA.z));
    vec2 bpA = vec2(sA.z, hA);
    vec3 silt = SRGB(0.34, 0.35, 0.29);
    vec3 bottom = mix(bed, silt, 0.15 + 0.6 * smoothstep(0.6, 2.8, under)) * 0.82;
    vec2 bp = vec2(max(sA.z, sB.z) * 0.2, hA);
    float wetK = smoothstep(-0.1, 0.03, under);
    col = mix(col, bottom, wetK * max(max(moist, streamK), step(poolD, uPool.z * 1.2)));
    col *= mix(vec3(1.0), vec3(0.62, 0.8, 0.82), smoothstep(0.1, 2.5, under));
    bump += smoothstep(0.0, 0.2, bp.x) * 0.15 * wetK;
    if (under > 0.0 && detail > 0.01) {
      vec2 cp = wp.xz * 2.4;
      vec2 c1 = pebbles(cp + vec2(uTime * 0.21, uTime * 0.13));
      vec2 c2 = pebbles(cp * 1.43 - vec2(uTime * 0.17, -uTime * 0.19) + 5.0);
      float ca = pow(1.0 - smoothstep(0.0, 0.14, c1.x), 3.0) * pow(1.0 - smoothstep(0.0, 0.2, c2.x), 1.5);
      gCaustic = ca * exp(-under * 0.9) * smoothstep(0.05, 0.3, under) * detail * 0.55;
    }
  }
  // salt flat under the sky mirror (and its damp rim)
  float plD = length(wp.xz - uPlain.xy);
  if (plD < uPlain.z + 16.0) {
    vec2 hx = pebbles(wp.xz * 0.9 + 11.0);
    float aaH = 1.0 - smoothstep(0.2, 0.5, length(fwidth(wp.xz)) * 0.9);
    hx = mix(vec2(0.5), hx, aaH);
    vec3 saltC = SRGB(0.9, 0.9, 0.88) * (0.88 + 0.12 * smoothstep(0.0, 0.06, hx.x)) * (0.94 + 0.06 * hx.y);
    vec3 mud = SRGB(0.46, 0.42, 0.36);
    float kS = smoothstep(uPlain.z + 14.0, uPlain.z + 1.0, plD) * (1.0 - smoothstep(uPlain.w + 0.05, uPlain.w + 0.35, wp.y));
    col = mix(col, mix(mud, saltC, smoothstep(uPlain.z + 9.0, uPlain.z - 4.0, plD)), kS);
    bump = mix(bump, smoothstep(0.0, 0.05, hx.x) * 0.3, kS);
  }
  // spray-soaked rock around the big fall
  { float fw = fallWet(wp); col = mix(col, col * vec3(0.48, 0.54, 0.5), fw * 0.85); }
  // moist darkening near stream
  col *= 1.0 - 0.18 * moist;
  gBump = mix(bump, screeBump, scree) * (1.0 - trail * 0.6) * (1.0 - snow) * detail;
  diffuseColor.rgb = col;
}
`;

// low-resolution terrain used only by the tarn's reflection camera (layer 2)
export function buildReflectionTerrain(W, mainMesh) {
  const hf = W.hf; const R = 1600, N = 160;
  const g = new THREE.PlaneGeometry(R * 2, R * 2, N, N); g.rotateX(-Math.PI / 2);
  const pa = g.attributes.position;
  for (let i = 0; i < pa.count; i++) pa.setY(i, hf.height(pa.getX(i) + W.tarn.x, pa.getZ(i) + W.tarn.z) - 0.3);
  g.translate(W.tarn.x, 0, W.tarn.z);
  g.computeVertexNormals();
  const n = pa.count;
  const mask = new Float32Array(n * 4), extra = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const m = W.maskAt(pa.getX(i), pa.getZ(i));
    mask.set([m[0], m[1], m[2], m[3]], i * 4); extra.set([9, 1, m[6], m[7]], i * 4);
  }
  g.setAttribute('aMask', new THREE.BufferAttribute(mask, 4));
  g.setAttribute('aExtra', new THREE.BufferAttribute(extra, 4));
  const mesh = new THREE.Mesh(g, mainMesh.material);
  mesh.layers.set(2);
  return mesh;
}
