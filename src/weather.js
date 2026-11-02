import * as THREE from 'three';
import { U, GLSL_COMMON } from './materials.js';
import { skyUniforms } from './sky.js';
import { mulberry32, clamp } from './noise.js';

function quadInstanced(count, attrs) {
  const base = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index; g.setAttribute('position', base.attributes.position); g.setAttribute('uv', base.attributes.uv);
  for (const [name, size, fill] of attrs) { const arr = new Float32Array(count * size); for (let i = 0; i < arr.length; i++) arr[i] = fill(i); g.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size)); }
  g.instanceCount = count;
  return g;
}

export function buildWeather(W, scene, env, camera, audio) {
  const rng = mulberry32(99);
  const out = {};
  const common = { ...U };

  // ---------------------------------------------------------------- rain
  {
    const N = 14000;
    const g = quadInstanced(N, [['aSeed', 4, () => rng()]]);
    const m = new THREE.ShaderMaterial({
      uniforms: { ...common, uCam: { value: new THREE.Vector3() } }, transparent: true, depthWrite: false,
      vertexShader: GLSL_COMMON + `uniform vec3 uCam; attribute vec4 aSeed; varying vec2 vUv; varying float vA; varying vec3 vW;
        void main(){
          vec3 box = vec3(26.0, 18.0, 26.0);
          vec3 vel = vec3(uWindDir.x * uWind * 6.0, -12.0, uWindDir.y * uWind * 6.0);
          vec3 p = aSeed.xyz * box + vel * uTime * (0.9 + aSeed.w * 0.2);
          p = mod(p - uCam + box * 0.5, box) - box * 0.5 + uCam;
          vec3 dir = normalize(vel);
          vec3 toCam = normalize(cameraPosition - p);
          vec3 side = normalize(cross(dir, toCam));
          float len = 0.28 + aSeed.w * 0.25;
          vec3 w = p + side * position.x * 0.0045 + dir * position.y * len;
          vUv = uv; vW = w;
          vA = uRain * (0.1 + 0.2 * aSeed.w) * smoothstep(0.8, 3.0, length(p - cameraPosition));
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        }`,
      fragmentShader: GLSL_COMMON + `uniform vec3 uAmbient; varying vec2 vUv; varying float vA; varying vec3 vW;
        void main(){ float a = vA * smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.6, vUv.y) * smoothstep(0.0, 0.5, 1.0 - abs(vUv.x - 0.5) * 2.0);
          vec3 c = uAmbient * 1.2 + vec3(0.06);
          gl_FragColor = vec4(c, a); }`,
    });
    m.uniforms.uAmbient = U.uAmbient;
    const rain = new THREE.Mesh(g, m); rain.frustumCulled = false; rain.renderOrder = 20; scene.add(rain);
    out.rain = rain;
  }

  // ---------------------------------------------------------------- virga curtains over far ranges
  {
    const curtains = [];
    const g = new THREE.PlaneGeometry(1, 1, 1, 1);
    const m = new THREE.ShaderMaterial({
      uniforms: { ...common, uVirga: { value: 0 }, uHorizon: skyUniforms.uHorizon, uCloudAmb: skyUniforms.uCloudAmb },
      transparent: true, depthWrite: false,
      vertexShader: `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: GLSL_COMMON + `uniform float uVirga; uniform vec3 uHorizon; uniform vec3 uCloudAmb; varying vec2 vUv; varying vec3 vW;
        void main(){
          float n = texture2D(uNoiseTex, vec2(vUv.x * 3.0 + vUv.y * 0.4, vUv.y * 0.6 + uTime * 0.01)).r;
          float s = texture2D(uNoiseTex, vec2(vUv.x * 9.0 + vUv.y * 1.2, 0.3)).g;
          float streak = smoothstep(0.3, 0.8, s * 0.7 + n * 0.5);
          float fadeB = smoothstep(0.05 + n * 0.35, 0.75, vUv.y);
          float fadeT = smoothstep(1.0, 0.9, vUv.y);
          float fadeX = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x);
          float a = streak * fadeB * fadeT * fadeX * uVirga * 0.55;
          vec3 c = mix(uCloudAmb * 0.7, uHorizon * 0.8, 0.5);
          gl_FragColor = vec4(applyFog(c, vW), a);
        }`,
    });
    for (let i = 0; i < 6; i++) {
      const ang = 0.4 + i * 0.95 + rng() * 0.4, dist = 3500 + rng() * 3000;
      const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
      const mesh = new THREE.Mesh(g, m);
      const w = 700 + rng() * 800, h = 1300;
      mesh.scale.set(w, h, 1);
      mesh.position.set(x, 2600 - h / 2 - 60, z);
      mesh.renderOrder = 1; mesh.frustumCulled = false;
      scene.add(mesh); curtains.push(mesh);
    }
    out.virga = { curtains, m };
  }

  // ---------------------------------------------------------------- lightning bolts
  const boltMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 6.5, 9), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const bolts = [];
  function makeBolt(ev) {
    const cx = camera.position.x + Math.cos(ev.angle) * ev.dist, cz = camera.position.z + Math.sin(ev.angle) * ev.dist;
    const gy = W.hf.height(cx, cz);
    const pts = []; let x = cx, y = 2300, z = cz;
    while (y > gy) { pts.push(new THREE.Vector3(x, y, z)); x += (rng() - 0.5) * 70; z += (rng() - 0.5) * 70; y -= 40 + rng() * 80; }
    pts.push(new THREE.Vector3(x, gy, z));
    const geos = [];
    const addSeg = (pp, width) => {
      const pos = [], idx = [];
      for (let i = 0; i < pp.length; i++) { pos.push(pp[i].x - width, pp[i].y, pp[i].z, pp[i].x + width, pp[i].y, pp[i].z, pp[i].x, pp[i].y, pp[i].z - width, pp[i].x, pp[i].y, pp[i].z + width); if (i < pp.length - 1) { const a = i * 4; idx.push(a, a + 1, a + 4, a + 1, a + 5, a + 4, a + 2, a + 3, a + 6, a + 3, a + 7, a + 6); } }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); geos.push(g);
    };
    addSeg(pts, 4);
    // branches
    for (let b = 0; b < 4; b++) {
      const s = Math.floor(rng() * (pts.length - 2)); const bp = [pts[s].clone()]; let p = pts[s].clone();
      for (let k = 0; k < 5; k++) { p = p.clone().add(new THREE.Vector3((rng() - 0.5) * 80, -40 - rng() * 60, (rng() - 0.5) * 80)); bp.push(p); }
      addSeg(bp, 2);
    }
    const grp = new THREE.Group();
    for (const g of geos) { const m = new THREE.Mesh(g, boltMat); m.frustumCulled = false; grp.add(m); }
    scene.add(grp);
    bolts.push({ grp, t: 0, life: 0.45 + rng() * 0.3 });
    env.lightning = 1.0;
    env.lightningDir.set(cx - camera.position.x, 1500 - camera.position.y, cz - camera.position.z).normalize();
    const dist = Math.hypot(cx - camera.position.x, cz - camera.position.z);
    if (audio) audio.thunder(dist / 343, dist);
  }

  // ---------------------------------------------------------------- dust puffs (footsteps on scree / dry trail)
  const DN = 160;
  const dust = quadInstanced(DN, [['aP', 4, () => 0], ['aV', 4, () => 0]]);
  const dustMat = new THREE.ShaderMaterial({
    uniforms: { ...common, uNow: { value: 0 } }, transparent: true, depthWrite: false,
    vertexShader: GLSL_COMMON + `uniform float uNow; attribute vec4 aP; attribute vec4 aV; varying vec2 vUv; varying float vA; varying vec3 vW; varying float vSh;
      void main(){
        float age = uNow - aP.w; float life = aV.w;
        float t = clamp(age / life, 0.0, 1.0);
        vec3 p = aP.xyz + aV.xyz * age + vec3(uWindDir.x, 0.0, uWindDir.y) * uWind * age * 0.8 + vec3(0.0, age * 0.15, 0.0);
        float size = 0.12 + t * 0.7;
        vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]); vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 w = p + (camR * position.x + camU * position.y) * size;
        vUv = uv; vW = w; vA = (age < 0.0 || age > life) ? 0.0 : sin(t * 3.14159) * 0.12 * (1.0 - t * 0.5);
        vSh = terrainShadowAt(p, 1.0) * cloudShadowAt(p);
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: GLSL_COMMON + `uniform vec3 uAmbient; varying vec2 vUv; varying float vA; varying vec3 vW; varying float vSh;
      void main(){ float d = length(vUv - 0.5) * 2.0; float n = texture2D(uNoiseTex, vUv * 0.4 + vW.xz * 0.05).r;
        float a = smoothstep(1.0, 0.1, d) * vA * (0.6 + 0.6 * n) * (1.0 - uWet);
        vec3 c = vec3(0.45, 0.37, 0.29) * (uAmbient * 0.7 + uKeyColor * 0.12 * vSh);
        gl_FragColor = vec4(applyFog(c, vW), a); }`,
  });
  dustMat.uniforms.uAmbient = U.uAmbient;
  const dustMesh = new THREE.Mesh(dust, dustMat); dustMesh.frustumCulled = false; dustMesh.renderOrder = 10; scene.add(dustMesh);
  let dustI = 0; let now = 0;
  out.puff = (p, strength = 1) => {
    const aP = dust.attributes.aP, aV = dust.attributes.aV;
    const n = Math.ceil(2 + strength * 3);
    for (let k = 0; k < n; k++) {
      const i = dustI++ % DN;
      aP.setXYZW(i, p.x + (rng() - 0.5) * 0.2, p.y + 0.02, p.z + (rng() - 0.5) * 0.2, now);
      aV.setXYZW(i, (rng() - 0.5) * 0.5, 0.15 + rng() * 0.3, (rng() - 0.5) * 0.5, 0.8 + rng() * 0.9 * strength);
    }
    aP.needsUpdate = true; aV.needsUpdate = true;
  };

  // ---------------------------------------------------------------- wind-blown seeds / pollen catching backlight
  {
    const N = 1600;
    const g = quadInstanced(N, [['aSeed', 4, () => rng()]]);
    const m = new THREE.ShaderMaterial({
      uniforms: { ...common, uCam: { value: new THREE.Vector3() }, uDensity: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: GLSL_COMMON + `uniform vec3 uCam; uniform float uDensity; attribute vec4 aSeed; varying vec2 vUv; varying float vA;
        void main(){
          vec3 box = vec3(40.0, 14.0, 40.0);
          vec3 vel = vec3(uWindDir.x, 0.0, uWindDir.y) * (0.8 + uWind * 3.0) + vec3(0.0, 0.1, 0.0);
          vec3 p = aSeed.xyz * box + vel * uTime * (0.6 + aSeed.w * 0.8);
          p += vec3(sin(uTime * 1.3 + aSeed.x * 20.0), sin(uTime * 0.9 + aSeed.y * 30.0) * 0.6, cos(uTime * 1.1 + aSeed.z * 25.0)) * 0.6;
          p = mod(p - uCam + box * 0.5, box) - box * 0.5 + uCam;
          vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]); vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          float size = 0.018 + aSeed.w * 0.02;
          vec3 w = p + (camR * position.x + camU * position.y) * size;
          vec3 V = normalize(p - cameraPosition);
          float back = pow(max(dot(V, uRealSun), 0.0), 6.0);
          float dist = length(p - cameraPosition);
          vA = (0.06 + back * 1.6) * uDensity * (1.0 - uRain) * smoothstep(0.5, 2.0, dist) * smoothstep(20.0, 12.0, dist) * step(aSeed.w, uDensity);
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        }`,
      fragmentShader: GLSL_COMMON + `varying vec2 vUv; varying float vA;
        void main(){ float d = length(vUv - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d) * vA; gl_FragColor = vec4(uKeyColor * 0.35 + vec3(0.05), a); }`,
    });
    const pollen = new THREE.Mesh(g, m); pollen.frustumCulled = false; pollen.renderOrder = 11; scene.add(pollen);
    out.pollen = pollen;
  }

  out.update = (dt, time, hiker) => {
    now = time;
    dustMat.uniforms.uNow.value = time;
    out.rain.material.uniforms.uCam.value.copy(camera.position);
    out.rain.visible = env.rain > 0.01;
    out.pollen.material.uniforms.uCam.value.copy(camera.position);
    // pollen density: daytime, grassy surroundings
    const m = W.maskAt(hiker.pos.x, hiker.pos.z);
    out.pollen.material.uniforms.uDensity.value = clamp((1 - env.night) * (0.35 + m[0] * 0.8) * (1 - env.storm), 0, 1);
    // virga: afternoon convective showers + squall
    const h = env.hour;
    const vk = clamp((h - 11.5) / 2, 0, 1) * clamp((19.5 - h) / 2, 0, 1) * 0.7 + env.storm * 0.6;
    out.virga.m.uniforms.uVirga.value = vk * (1 - env.night);
    for (const c of out.virga.curtains) c.lookAt(camera.position.x, c.position.y, camera.position.z);
    // lightning events
    while (env.events.length) { const ev = env.events.shift(); if (ev.type === 'bolt') makeBolt(ev); }
    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i]; b.t += dt;
      const f = b.t < b.life ? (Math.sin(b.t * 60) > -0.3 ? 1 : 0.2) * (1 - b.t / b.life) : 0;
      b.grp.children.forEach(ch => ch.material.opacity = f);
      boltMat.opacity = f;
      if (b.t < b.life * 0.6) env.lightning = Math.max(env.lightning, f);
      if (b.t > b.life) { scene.remove(b.grp); b.grp.children.forEach(c => c.geometry.dispose()); bolts.splice(i, 1); }
    }
  };
  return out;
}
