import * as THREE from 'three';
import { U } from './materials.js';
import { skyUniforms } from './sky.js';
import { clamp, smoothstep, lerp, mulberry32 } from './noise.js';

const LAT = 46 * Math.PI / 180, DEC = 12 * Math.PI / 180;
const NORTH = new THREE.Vector3(0, 0, -1), UP = new THREE.Vector3(0, 1, 0), WEST = new THREE.Vector3(-1, 0, 0);
const POLE = NORTH.clone().multiplyScalar(Math.cos(LAT)).addScaledVector(UP, Math.sin(LAT));
const MERID = UP.clone().multiplyScalar(Math.cos(LAT)).addScaledVector(NORTH, -Math.sin(LAT));

function celestial(hourAngle, dec, out) {
  out.copy(POLE).multiplyScalar(Math.sin(dec));
  out.addScaledVector(MERID, Math.cos(dec) * Math.cos(hourAngle));
  out.addScaledVector(WEST, Math.cos(dec) * Math.sin(hourAngle));
  return out.normalize();
}

// keyframe helper: array of [x, value(array)]
function keyed(keys, x) {
  if (x <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [x0, a] = keys[i], [x1, b] = keys[i + 1];
    if (x <= x1) { let t = (x - x0) / (x1 - x0); t = t * t * (3 - 2 * t); return a.map((v, k) => v + (b[k] - v) * t); }
  }
  return keys[keys.length - 1][1];
}

// sky colours keyed on sin(sun elevation)
const ZENITH = [[-0.35, [0.0025, 0.0045, 0.012]], [-0.14, [0.006, 0.012, 0.035]], [-0.06, [0.03, 0.06, 0.17]], [0.0, [0.1, 0.17, 0.38]], [0.08, [0.16, 0.3, 0.62]], [0.3, [0.16, 0.36, 0.82]], [0.9, [0.11, 0.3, 0.78]]];
const HORIZ_AM = [[-0.35, [0.006, 0.009, 0.02]], [-0.14, [0.02, 0.03, 0.06]], [-0.06, [0.2, 0.16, 0.27]], [0.0, [0.8, 0.44, 0.36]], [0.08, [0.78, 0.6, 0.5]], [0.3, [0.5, 0.6, 0.74]], [0.9, [0.48, 0.6, 0.78]]];
const HORIZ_PM = [[-0.35, [0.006, 0.009, 0.02]], [-0.14, [0.025, 0.03, 0.065]], [-0.06, [0.24, 0.18, 0.27]], [0.0, [0.95, 0.4, 0.17]], [0.08, [0.9, 0.58, 0.34]], [0.3, [0.55, 0.6, 0.68]], [0.9, [0.48, 0.6, 0.78]]];
const SUNCOL = [[-0.05, [1.0, 0.3, 0.1]], [0.0, [1.0, 0.42, 0.18]], [0.05, [1.0, 0.62, 0.34]], [0.14, [1.0, 0.82, 0.62]], [0.35, [1.0, 0.94, 0.86]], [0.9, [1.0, 0.98, 0.95]]];

// grade keyed on hour: [liftR,G,B, gainR,G,B, sat, contrast, exposure]
const GRADE = [
  [0.0, [0.002, 0.004, 0.011, 0.82, 0.92, 1.15, 0.8, 1.08, 3.6]],
  [4.3, [0.003, 0.005, 0.012, 0.85, 0.92, 1.12, 0.8, 1.08, 3.3]],
  [5.2, [0.012, 0.01, 0.025, 1.05, 0.92, 1.0, 0.95, 1.05, 1.08]],
  [6.3, [0.006, 0.005, 0.008, 1.06, 0.98, 0.94, 1.06, 1.08, 0.55]],
  [8.5, [0.004, 0.005, 0.008, 1.0, 1.0, 0.99, 1.1, 1.1, 0.45]],
  [12.5, [0.006, 0.006, 0.008, 1.02, 1.0, 0.97, 1.04, 1.1, 0.41]],
  [16.8, [0.005, 0.004, 0.004, 1.04, 0.99, 0.94, 1.1, 1.1, 0.45]],
  [18.1, [0.012, 0.008, 0.006, 1.08, 0.98, 0.86, 1.12, 1.08, 0.72]],
  [18.9, [0.012, 0.008, 0.012, 1.06, 0.9, 0.86, 1.12, 1.08, 0.98]],
  [19.6, [0.008, 0.012, 0.03, 0.88, 0.92, 1.12, 0.92, 1.06, 1.66]],
  [21.0, [0.002, 0.004, 0.011, 0.82, 0.92, 1.15, 0.8, 1.08, 3.6]],
  [24.0, [0.002, 0.004, 0.011, 0.82, 0.92, 1.15, 0.8, 1.08, 3.6]],
];

export const SQUALL = { start: 14.1, peak0: 14.7, peak1: 15.5, end: 16.3 };

export class Environment {
  constructor(scene, renderer) {
    this.hour = 6.1;
    this.fast = false;
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    const sm = 2048;
    this.sun.shadow.mapSize.set(sm, sm);
    const c = this.sun.shadow.camera; c.left = -27; c.right = 27; c.top = 27; c.bottom = -27; c.near = 1; c.far = 600;
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.035; this.sun.shadow.radius = 2.5;
    this.sun.shadow.camera.layers.enable(1);
    scene.add(this.sun); scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0x9fb8d8, 0x6b5a48, 0.8);
    scene.add(this.hemi);
    this.sunDir = new THREE.Vector3(); this.moonDir = new THREE.Vector3(); this.keyDir = new THREE.Vector3();
    this.grade = { lift: new THREE.Vector3(), gain: new THREE.Vector3(1, 1, 1), sat: 1, contrast: 1, exposure: 1 };
    this.wind = 0.6; this.gust = 0; this.rain = 0; this.wet = 0; this.storm = 0;
    this.lightning = 0; this.lightningDir = new THREE.Vector3(1, 0.2, 0); this.lightningT = 0; this.nextBolt = 3;
    this.rng = mulberry32(77);
    this.events = [];
    this.cloudOff = new THREE.Vector2(0.3, 0.1);
    this.keyIsMoon = false;
    this.envDirty = true;
  }
  rate(h) { // game-hours per real second
    let r = 1 / 15;
    if (h > 21.5 || h < 3.4) r *= 2.3;
    if (h > 17.2 && h < 19.3) r *= 0.72;
    if (h > 5.0 && h < 6.3) r *= 0.9;
    return r;
  }
  update(dt, t, focus) {
    const h0 = this.hour;
    this.hour = (this.hour + dt * this.rate(this.hour) * (this.fast ? 22 : 1)) % 24;
    const h = this.hour;
    const H = (h - 12) / 24 * Math.PI * 2;
    celestial(H, DEC, this.sunDir);
    celestial(H + Math.PI * 0.93, -0.12, this.moonDir);
    const se = this.sunDir.y, me = this.moonDir.y;

    // ---- weather
    const sq = SQUALL;
    let storm = 0;
    if (h > sq.start && h < sq.end) storm = smoothstep(sq.start, sq.peak0, h) * (1 - smoothstep(sq.peak1, sq.end, h));
    this.storm = storm;
    const rain = smoothstep(sq.peak0 - 0.1, sq.peak0 + 0.2, h) * (1 - smoothstep(sq.peak1 - 0.2, sq.peak1 + 0.25, h));
    this.rain = rain;
    const dh = dt * this.rate(h) * (this.fast ? 22 : 1);
    this.wet = clamp(this.wet + rain * dh * 3.0 - (1 - rain) * dh * 0.42, 0, 1);
    if (h < 6 && h0 > 20) this.wet = 0;
    const night = 1 - smoothstep(-0.2, -0.04, se);
    const cloudBase = 0.34 + 0.08 * Math.sin(t * 0.03) + 0.1 * smoothstep(9, 13, h) - 0.1 * smoothstep(19, 21, h) * 1 + 0.1 * (1 - smoothstep(4, 6, h)) * 0;
    const cover = lerp(lerp(cloudBase, 0.05, night), 0.95, storm);
    U.uCloudCover.value = cover;
    const windBase = 0.55 + 0.15 * Math.sin(t * 0.05) + 0.9 * storm;
    this.wind = windBase;
    U.uWind.value = windBase;
    const wd = U.uWindDir.value;
    this.cloudOff.x += dt * (0.0035 + storm * 0.012) * (this.fast ? 8 : 1) * wd.x;
    this.cloudOff.y += dt * (0.0035 + storm * 0.012) * (this.fast ? 8 : 1) * wd.y;
    U.uCloudOffset.value.copy(this.cloudOff);
    U.uRain.value = rain; U.uWet.value = this.wet;

    // ---- key light: sun or moon
    const sunVis = smoothstep(-0.06, 0.02, se);
    const moonK = (1 - smoothstep(-0.14, -0.05, se)) * smoothstep(-0.02, 0.1, me);
    let keyInt, keyCol;
    const sc = keyed(SUNCOL, se);
    if (se > -0.07 || moonK <= 0.001) {
      this.keyDir.copy(this.sunDir); if (this.keyDir.y < 0.02) this.keyDir.y = 0.02;
      keyInt = 4.1 * smoothstep(-0.06, 0.1, se) * (1 - 0.72 * storm);
      keyCol = sc; this.keyIsMoon = false;
    } else {
      this.keyDir.copy(this.moonDir);
      keyInt = 0.42 * moonK * (1 - 0.8 * storm);
      keyCol = [0.62, 0.72, 1.0]; this.keyIsMoon = true;
    }
    this.keyDir.normalize();
    U.uSunDir.value.copy(this.keyDir);
    U.uRealSun.value.copy(this.sunDir);
    U.uKeyVis.value = 1;
    this.sun.color.setRGB(keyCol[0], keyCol[1], keyCol[2]);
    this.sun.intensity = keyInt;
    U.uKeyColor.value.setRGB(keyCol[0] * keyInt, keyCol[1] * keyInt, keyCol[2] * keyInt);
    this.sun.position.copy(focus).addScaledVector(this.keyDir, 300);
    this.sun.target.position.copy(focus);

    // ---- sky palette
    const z = keyed(ZENITH, se), hzA = keyed(HORIZ_AM, se), hzP = keyed(HORIZ_PM, se);
    const pm = h > 12 ? 1 : 0;
    let hz = pm ? hzP : hzA;
    const grey = [0.3, 0.32, 0.36].map(v => v * (0.25 + 0.75 * smoothstep(-0.1, 0.3, se)));
    const zc = z.map((v, i) => lerp(v, grey[i] * 0.8, storm * 0.85));
    hz = hz.map((v, i) => lerp(v, grey[i] * 1.3, storm * 0.85));
    const su = skyUniforms;
    su.uZenith.value.setRGB(zc[0], zc[1], zc[2]);
    su.uHorizon.value.setRGB(hz[0], hz[1], hz[2]);
    const glowK = smoothstep(-0.12, 0.05, se) * (1 - storm * 0.85);
    su.uSunGlow.value.setRGB(sc[0] * glowK * 1.4, sc[1] * glowK * 1.2, sc[2] * glowK);
    su.uSunDisk.value.setRGB(sc[0], sc[1] * 0.95, sc[2] * 0.85).multiplyScalar(1 - storm * 0.97);
    su.uMoonDir.value.copy(this.moonDir);
    su.uStarVis.value = smoothstep(-0.02, -0.16, se) * (1 - storm);
    su.uMoonVis.value = smoothstep(-0.02, 0.06, me) * (1 - storm * 0.9) * (0.35 + 0.65 * smoothstep(0.05, -0.1, se));
    // celestial rotation
    const m4 = new THREE.Matrix4().makeRotationAxis(POLE, -H);
    su.uStarRot.value.setFromMatrix4(m4);
    const dayL = smoothstep(-0.1, 0.25, se);
    su.uCloudLit.value.setRGB(sc[0] * 1.5 * sunVis, sc[1] * 1.45 * sunVis, sc[2] * 1.4 * sunVis).multiplyScalar(1 - storm * 0.6);
    const amb = [lerp(0.02, 0.5, dayL) + hz[0] * 0.25, lerp(0.025, 0.56, dayL) + hz[1] * 0.25, lerp(0.045, 0.66, dayL) + hz[2] * 0.25];
    su.uCloudAmb.value.setRGB(amb[0], amb[1], amb[2]).multiplyScalar(1 - storm * 0.45);
    if (moonK > 0 && se < -0.05) su.uCloudAmb.value.add(new THREE.Color(0.02, 0.025, 0.04).multiplyScalar(moonK));
    su.uCloudDark.value = storm * 0.8;

    // ---- fog / haze
    const fogC = [hz[0] * 0.64 + zc[0] * 0.36, hz[1] * 0.64 + zc[1] * 0.36, hz[2] * 0.64 + zc[2] * 0.36];
    U.uFogColor.value.setRGB(fogC[0], fogC[1], fogC[2]);
    const golden = smoothstep(0.25, 0.05, se) * smoothstep(-0.05, 0.02, se);
    U.uFogGlow.value.setRGB(sc[0] * 1.1, sc[1] * 0.85, sc[2] * 0.6).multiplyScalar(glowK * (0.8 + golden * 0.6));
    U.uFogDensity.value = 0.00027 * (1 + golden * 0.8 + storm * 3.0 + rain * 2.6) + 0.00012 * (1 - smoothstep(5.5, 8.5, h)) * (h < 12 ? 1 : 0);

    // ---- ambient
    const dA = Math.sqrt(dayL); const skyAmb = [lerp(0.03, 0.62, dA), lerp(0.045, 0.72, dA), lerp(0.09, 0.9, dA)];
    this.hemi.color.setRGB(skyAmb[0] * 0.8 + zc[0] * 0.8, skyAmb[1] * 0.8 + zc[1] * 0.8, skyAmb[2] * 0.8 + zc[2] * 0.8);
    this.hemi.groundColor.setRGB(0.36 * dayL + 0.02, 0.28 * dayL + 0.02, 0.2 * dayL + 0.03);
    this.hemi.intensity = lerp(0.55, 1.0, storm) * (1 + 1.4 * night);
    this.envIntensity = lerp(0.95, 0.72, smoothstep(0.05, 0.35, se)) * lerp(0.6, 1, dayL) * (1 + storm * 0.6);
    U.uAmbient.value.copy(this.hemi.color).multiplyScalar(this.hemi.intensity * 0.9).add(new THREE.Color(zc[0], zc[1], zc[2]).multiplyScalar(0.4));

    // ---- lightning
    this.lightning = Math.max(0, this.lightning - dt * 6);
    if (storm > 0.55 && !this.fast) {
      this.nextBolt -= dt;
      if (this.nextBolt <= 0) {
        this.nextBolt = 3 + this.rng() * 7;
        const a = this.rng() * Math.PI * 2;
        const dist = 2600 + this.rng() * 3500;
        this.events.push({ type: 'bolt', angle: a, dist, t: 0 });
      }
    }
    su.uLightning.value.set(this.lightningDir.x, this.lightningDir.y, this.lightningDir.z, this.lightning);
    this.hemi.intensity *= 1 + this.lightning * 2.5;
    // ---- grade
    const gr = keyed(GRADE, h);
    const gd = this.grade;
    gd.lift.set(gr[0], gr[1], gr[2]);
    gd.gain.set(gr[3], gr[4], gr[5]);
    gd.sat = lerp(gr[6], 0.62, storm * 0.8);
    gd.contrast = gr[7];
    gd.exposure = gr[8] * (1 + storm * 0.35);
    if (storm > 0) gd.gain.lerp(new THREE.Vector3(0.94, 0.98, 1.05), storm * 0.8);
    U.uNight.value = night;
    // valley mist: thick at dawn, lingering after the squall, burning off by mid-morning
    const dawnFog = smoothstep(3.5, 5.5, h) * (1 - smoothstep(7.8, 10.0, h));
    const nightFog = (1 - smoothstep(0.5, 3.5, h)) * 0.3 + smoothstep(21.5, 23.5, h) * 0.3;
    const rainFog = smoothstep(15.2, 15.8, h) * (1 - smoothstep(16.6, 18.2, h)) * 0.7;
    U.uValleyFog.value = Math.max(dawnFog, nightFog, rainFog) * (1 - storm * 0.3);
    this.golden = golden;
    this.night = night;
  }
}
