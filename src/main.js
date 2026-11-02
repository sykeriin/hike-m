import * as THREE from 'three';
import { buildWorld } from './world.js';
import { U, initNoise, makeStrataTexture } from './materials.js';
import { buildTerrain, buildHeightTexture, buildReflectionTerrain, buildTrailTexture, buildStreamTexture } from './terrain.js';
import { buildSky } from './sky.js';
import { Environment } from './env.js';
import { buildPost } from './post.js';
import { Hiker } from './hiker.js';
import { CameraRig } from './camera.js';
import { clamp, lerp } from './noise.js';
import { scatterRocks } from './rocks.js';
import { buildVegetation } from './veg.js';
import { buildLandmarks } from './landmarks.js';
import { buildWater } from './water.js';
import { buildWildlife } from './wildlife.js';
import { buildWeather } from './weather.js';
import { Soundscape } from './audio.js';
import { TerrainShadows } from './tshadow.js';
import { TerrainCapture, buildField } from './field.js';
import { buildHouse } from './house.js';
import { buildTrees } from './trees.js';
import { buildMirrorPlain } from './water.js';

const loaderBar = document.getElementById('lbar');
const loaderEl = document.getElementById('loader');
let shownP = 0;
function progress(p) { shownP = Math.max(shownP, p); if (loaderBar) loaderBar.style.transform = `scaleX(${shownP})`; }
const tick = () => new Promise(r => setTimeout(r, 0));

async function start() {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  const T0 = performance.now(); const TM = {}; const mark = (k) => { TM[k] = Math.round(performance.now() - T0); };
  initNoise(); makeStrataTexture(); mark('tex');
  progress(0.03); await tick();
  const W = await buildWorld(progress); mark('world');
  window.__W = W;
  buildHeightTexture(W); mark('htex');
  buildTrailTexture(W); buildStreamTexture(W); mark('trailtex');
  U.uTarnL.value = W.tarn.L;
  U.uTarnP.value.set(W.tarn.x, W.tarn.z, Math.max(W.tarn.rx, W.tarn.rz) + 3, 0);
  U.uPool.value.set(W.falls.pool.x, W.falls.pool.z, W.falls.pool.r, W.falls.pool.level);
  U.uFallSeg.value.set(W.falls.lip.x, W.falls.lip.z, W.falls.base.x, W.falls.base.z); U.uFallY.value.set(W.falls.base.y, W.falls.lip.y);
  progress(0.92); await tick();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.25, 30000);
  camera.layers.enable(1);
  const sky = buildSky(); scene.add(sky);
  const terrain = buildTerrain(W); scene.add(terrain);
  terrain.layers.enable(2);
  sky.layers.enable(2);
  const env = new Environment(scene, renderer);
  const hiker = new Hiker(W);
  scene.add(hiker.root); scene.add(hiker.staff); scene.add(hiker.ribbonGroup); scene.add(hiker.contact);
  const tr = W.trail;
  const sAt = (x, z) => tr.nearest(x, z).s;
  const tStop = W.house.toW(...W.houseStopLocal);
  hiker.stops = [['rest', sAt(W.rest.x, W.rest.z) - 3, 6.5], ['ovoo', sAt(W.ovoo.x, W.ovoo.z) - 2, 5], ['house', sAt(tStop[0], tStop[1]) - 0.6, 9], ['plain', W.trail.len - 10, 12]];

  const extras = [];
  const ctx = { THREE, scene, camera, renderer, W, env, hiker, U, extras, progress, tick };
  const audio = new Soundscape(); ctx.audio = audio;
  const colliders = [], camColliders = [];
  mark('terrain'); const rocks = scatterRocks(W, scene); mark('rocks'); await tick();
  for (const c of rocks.colliders) { colliders.push(c); camColliders.push(c); }
  const veg = buildVegetation(W, scene, colliders); mark('veg'); await tick();
  for (const im of veg.chunks) im.layers.set(1);
  const lm = buildLandmarks(W, scene, colliders, camColliders); mark('landmarks'); await tick();
  const house = buildHouse(W, scene, colliders, camColliders); mark('house'); await tick();
  const trees = buildTrees(W, scene, colliders, camColliders); mark('trees'); await tick();
  const water = buildWater(W, scene, camera, renderer); await tick();
  // what the tarn reflects: sky, low-res terrain, big rock forms, the hiker
  scene.traverse(o => { if (o.isMesh && !o.isInstancedMesh && o.material && o.material.customProgramCacheKey) { const k = o.material.customProgramCacheKey(); if (k.includes('rockhead') || k.includes('rockcliff')) o.layers.enable(2); } });
  hiker.root.traverse(o => o.layers.enable(2)); hiker.staff.traverse(o => o.layers.enable(2));
  const wild = buildWildlife(W, scene, audio); mark('wild'); await tick();
  const weather = buildWeather(W, scene, env, camera, audio);
  hiker.colliders = colliders.filter(c => c.seg || W.trail.near(c.x, c.z, 60));
  const skyMirror = buildMirrorPlain(W, scene, camera);
  U.uPlain.value.set(W.plain.x, W.plain.z, W.plain.r, W.plain.h);
  hiker.onStep = (p, surf, sp) => {
    skyMirror.step(p, 0.6 + sp * 0.4);
    if (surf.scree > 0.35 || surf.trail > 0.5) weather.puff(p, surf.scree > 0.35 ? 1.2 : 0.6);
    audio.step(surf, sp);
  };

  const rig = new CameraRig(camera, renderer.domElement, W, hiker);
  rig.colliders = camColliders;
  rig.house = house;
  const tshadow = new TerrainShadows(renderer);
  const occluders = [];
  scene.traverse(o => { if (o.isMesh && o.material && o.material.customProgramCacheKey) { const k = o.material.customProgramCacheKey(); if (/rock(b|lm|head|cliff)/.test(k)) occluders.push(o); } });
  occluders.push(...house.occluders);
  const capture = new TerrainCapture(renderer, terrain, occluders);
  const field = buildField(renderer, capture, scene);
  const capCenter = new THREE.Vector3();
  const post = buildPost(renderer, scene, camera);

  // PMREM environment from sky only
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = buildSky(true); envScene.add(envSky);
  let envRT = null, envTimer = 0;
  function refreshEnv() {
    const cam = camera.position.clone();
    envSky.position.set(0, 0, 0);
    const old = envRT;
    envSky.position.copy(cam);
    envRT = pmrem.fromScene(envScene, 0.02, 1, 40000, { size: 64, position: new THREE.Vector3(cam.x, cam.y, cam.z) });
    scene.environment = envRT.texture;
    if (old) old.dispose();
  }

  // input
  const keys = new Set();
  const input = { move: new THREE.Vector2() };
  window.addEventListener('keydown', e => {
    keys.add(e.code);
    if (e.code === 'KeyM' && ctx.audio) ctx.audio.toggleMute();
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    if (ctx.audio) ctx.audio.resume();
  });
  window.addEventListener('keyup', e => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  window.addEventListener('pointerdown', () => { if (ctx.audio) ctx.audio.resume(); });

  // resolution management (Retina aware, adaptive)
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let scale = Math.min(dpr, 1.5);
  const minScale = 0.7;
  const viewW = () => (window.innerWidth >= 2 ? window.innerWidth : (api && api.testSize ? api.testSize[0] : 0));
  const viewH = () => (window.innerHeight >= 2 ? window.innerHeight : (api && api.testSize ? api.testSize[1] : 0));
  function resize() {
    const w = Math.max(1, viewW()), h = Math.max(1, viewH());
    renderer.setPixelRatio(scale);
    renderer.setSize(w, h);
    post.composer.setPixelRatio(scale);
    post.composer.setSize(w, h);
    post.fin.uniforms.uRes.value.set(w * scale, h * scale);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  let api = null;
  resize();
  window.addEventListener('resize', resize);
  let frameAcc = 0, frameN = 0, adaptT = 0;
  const gl = renderer.getContext(); const tqExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  let pendingQ = null, gpuMs = 0, frameCount = 0;

  // loop fade state
  let fade = 1, fadeDir = -1, fadeHold = 0;
  let lastT = performance.now();
  let time = 0;
  const sunScreen = new THREE.Vector3();
  api = window.__h = {
    env, hiker, rig, W, camera, scene, renderer, post, U, wild, weather, veg, audio, get tshadow() { return tshadow; },
    setHour: (h) => { env.hour = h; envTimer = 99; },
    get fps() { return frameN ? 0 : 0; },
    freeze: false,
  };
  progress(1);
  loaderEl.style.opacity = '0';
  setTimeout(() => loaderEl.remove(), 1600);

  function frame() {
    requestAnimationFrame(frame);
    const nowT = performance.now(); let dt = Math.min((nowT - lastT) / 1000, 0.066); lastT = nowT;
    if (api.freeze) dt = 0;
    step(dt);
  }
  api.step = (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) step(dt, i < n - 1); };
  function step(dt, skipRender = false) {
    time += dt;
    U.uTime.value = time;
    // input
    input.move.set(0, 0);
    if (keys.has('KeyW') || keys.has('ArrowUp')) input.move.y += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) input.move.y -= 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) input.move.x -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) input.move.x += 1;
    env.fast = keys.has('KeyT') || keys.has('KeyF') || keys.has('Space');

    hiker.update(dt, input, (rig.yawOut ?? rig.yaw + Math.PI) - Math.PI, time);
    // loop: reach end -> fade into mist -> restart
    if (hiker.atEnd && fadeDir === 0) { fadeDir = 1; }
    if (fadeDir === 1) { fade = Math.min(1, fade + dt / 2.5); if (fade >= 1) { fadeHold += dt; if (fadeHold > 0.8) { hiker.reset(); rig.snap(); fadeDir = -1; fadeHold = 0; } } }
    else if (fadeDir === -1) { fade = Math.max(0, fade - dt / 2.5); if (fade <= 0) fadeDir = 0; }

    env.update(dt, time, hiker.pos);
    tshadow.update(hiker.pos, env.keyDir);
    rig.update(dt, time);
    if (api.camOverride) { camera.position.fromArray(api.camOverride[0]); camera.lookAt(new THREE.Vector3().fromArray(api.camOverride[1])); }
    veg.update(camera);
    { const fw = new THREE.Vector3(); camera.getWorldDirection(fw); fw.y = 0; fw.normalize();
      capCenter.set(camera.position.x + fw.x * 30, 0, camera.position.z + fw.z * 30);
      capture.update(capCenter, (x, z) => W.hf.height(x, z)); }
    field.update(camera, hiker);
    wild.update(dt, time, hiker, env, camera);
    water.update(dt, time, env, hiker);
    house.update(dt, time, env, hiker);
    weather.update(dt, time, hiker);
    audio.update(dt, env, hiker, camera, W);
    envTimer += dt * (env.fast ? 6 : 1);
    if (envTimer > 2.5) { envTimer = 0; refreshEnv(); }
    scene.environmentIntensity = env.envIntensity;
    sky.position.copy(camera.position);

    // post uniforms
    const f = post.fin.uniforms;
    f.uTime.value = time;
    f.uExposure.value = env.grade.exposure;
    f.uLift.value.copy(env.grade.lift); f.uGain.value.copy(env.grade.gain);
    f.uSat.value = env.grade.sat; f.uContrast.value = env.grade.contrast;
    f.uFade.value = fade;
    const fc = U.uFogColor.value;
    f.uFadeCol.value.setRGB(0.75, 0.77, 0.8).lerp(new THREE.Color(Math.min(1, Math.sqrt(fc.r) * 0.9), Math.min(1, Math.sqrt(fc.g) * 0.9), Math.min(1, Math.sqrt(fc.b) * 0.9)), 0.6);
    f.uFlash.value = env.lightning * 0.35;
    // god rays toward the key light
    sunScreen.copy(camera.position).addScaledVector(env.keyIsMoon ? env.moonDir : env.sunDir, 10000).project(camera);
    const onScreen = sunScreen.z < 1 && Math.abs(sunScreen.x) < 1.6 && Math.abs(sunScreen.y) < 1.6;
    post.rays.mat.uniforms.uSun.value.set(sunScreen.x * 0.5 + 0.5, sunScreen.y * 0.5 + 0.5);
    const rayK = onScreen ? (1 - clamp(Math.hypot(sunScreen.x, sunScreen.y) - 0.8, 0, 1)) : 0;
    const kc = U.uKeyColor.value;
    const rayStrength = rayK * (env.keyIsMoon ? 0.25 : 0.55 + env.golden * 0.6) * (1 - env.storm * 0.5);
    f.uRayCol.value.setRGB(0.4 + 0.6 * Math.min(1, kc.r / 3), 0.4 + 0.6 * Math.min(1, kc.g / 3), 0.4 + 0.6 * Math.min(1, kc.b / 3)).multiplyScalar(rayStrength);
    post.rays.enabled = rayStrength > 0.01;
    if (!post.rays.enabled) f.uRayCol.value.setRGB(0, 0, 0);
    post.rays.mat.uniforms.uThresh.value = env.keyIsMoon ? 0.4 : 2.2;
    post.bloom.strength = 0.28 + env.night * 0.2 + env.golden * 0.1;

    // never draw into a zero-sized drawing buffer (hidden / minimised at load)
    if (viewW() < 2 || viewH() < 2) return;
    if (Math.abs(renderer.domElement.width - viewW() * scale) > 2) resize();
    if (!skipRender) {
      let q = null;
      if (tqExt && !pendingQ && (frameCount++ % 8 === 0)) { q = gl.createQuery(); gl.beginQuery(tqExt.TIME_ELAPSED_EXT, q); }
      post.composer.render(dt);
      if (q) { gl.endQuery(tqExt.TIME_ELAPSED_EXT); pendingQ = q; }
      if (pendingQ && gl.getQueryParameter(pendingQ, gl.QUERY_RESULT_AVAILABLE)) {
        if (!gl.getParameter(tqExt.GPU_DISJOINT_EXT)) gpuMs = gpuMs * 0.7 + gl.getQueryParameter(pendingQ, gl.QUERY_RESULT) / 1e6 * 0.3;
        gl.deleteQuery(pendingQ); pendingQ = null;
      }
    }

    // adaptive resolution
    frameAcc += dt; frameN++; adaptT += dt;
    if (api.lockScale) { if (Math.abs(scale - api.lockScale) > 1e-3) { scale = api.lockScale; resize(); } adaptT = 0; frameAcc = 0; frameN = 0; }
    if (adaptT > 2.0) {
      const avg = frameAcc / frameN;
      const maxScale = Math.min(dpr, 1.75);
      if (tqExt) {
        if (gpuMs <= 0) { /* waiting for the first GPU timing */ }
        // GPU-time driven: keep the frame comfortably inside a 60 Hz budget
        else if (gpuMs > 13 && scale > minScale) { scale = Math.max(minScale, scale - 0.1); resize(); }
        else if (gpuMs < 7.5 && scale < maxScale) { scale = Math.min(maxScale, scale + 0.1); resize(); }
      } else {
        if (avg > 1 / 42 && scale > minScale) { scale = Math.max(minScale, scale - 0.15); resize(); }
        else if (avg < 1 / 58 && scale < maxScale) { scale = Math.min(maxScale, scale + 0.1); resize(); }
      }
      api.avgFrame = avg; api.scale = scale; api.gpuMs = gpuMs;
      frameAcc = 0; frameN = 0; adaptT = 0;
    }
  }
  env.update(0, 0, hiker.pos); tshadow.update(hiker.pos, env.keyDir, true); mark('ready'); api.timings = TM;
  refreshEnv();
  frame();
}

start().catch(e => { console.error(e); });
