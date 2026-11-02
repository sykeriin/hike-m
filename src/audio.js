// Synthesized soundscape: wind over the ridge, birds, rockfall, thunder, rain, footsteps, water, marmot whistles.
export class Soundscape {
  constructor() { this.ctx = null; this.muted = false; this.started = false; }
  resume() {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
  init() {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = 0; this.master.connect(ctx.destination);
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, ctx.currentTime, 1.5);
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 3;
    comp.connect(this.master); this.bus = comp;
    // noise buffers
    const len = ctx.sampleRate * 4;
    const white = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = white.getChannelData(c); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; }
    const brown = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = brown.getChannelData(c); let last = 0; for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; } }
    this.white = white; this.brown = brown;
    const loop = (buf, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.start(); return s; };
    // wind: two band-passed layers + low rumble + whistle
    this.windA = ctx.createBiquadFilter(); this.windA.type = 'bandpass'; this.windA.frequency.value = 500; this.windA.Q.value = 0.7;
    this.windB = ctx.createBiquadFilter(); this.windB.type = 'bandpass'; this.windB.frequency.value = 1300; this.windB.Q.value = 3.5;
    this.windLow = ctx.createBiquadFilter(); this.windLow.type = 'lowpass'; this.windLow.frequency.value = 160;
    this.gA = ctx.createGain(); this.gB = ctx.createGain(); this.gLow = ctx.createGain();
    this.gA.gain.value = 0.2; this.gB.gain.value = 0.03; this.gLow.gain.value = 0.3;
    loop(white).connect(this.windA); this.windA.connect(this.gA); this.gA.connect(this.bus);
    loop(white, 0.9).connect(this.windB); this.windB.connect(this.gB); this.gB.connect(this.bus);
    loop(brown).connect(this.windLow); this.windLow.connect(this.gLow); this.gLow.connect(this.bus);
    // rain
    this.rainF = ctx.createBiquadFilter(); this.rainF.type = 'highpass'; this.rainF.frequency.value = 1800;
    this.gRain = ctx.createGain(); this.gRain.gain.value = 0;
    loop(white, 1.1).connect(this.rainF); this.rainF.connect(this.gRain); this.gRain.connect(this.bus);
    // water (stream / waterfall proximity)
    this.waterF = ctx.createBiquadFilter(); this.waterF.type = 'bandpass'; this.waterF.frequency.value = 900; this.waterF.Q.value = 0.5;
    this.gWater = ctx.createGain(); this.gWater.gain.value = 0;
    loop(white, 0.7).connect(this.waterF); this.waterF.connect(this.gWater); this.gWater.connect(this.bus);
    this.birdT = 3; this.rockT = 25;
    this.started = true;
  }
  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.3);
  }
  pan(p) {
    const ctx = this.ctx; const pn = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    if (pn.pan) pn.pan.value = Math.max(-1, Math.min(1, p));
    pn.connect(this.bus); return pn;
  }
  relPan(pos) {
    if (!this.listener || !pos) return (Math.random() - 0.5) * 1.4;
    const L = this.listener; const dx = pos.x - L.x, dz = pos.z - L.z;
    return Math.max(-1, Math.min(1, (dx * L.rx + dz * L.rz) / (Math.hypot(dx, dz) + 1e-3)));
  }
  update(dt, env, hiker, camera, W) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const w = env.wind * (0.5 + (hiker.gust || 0.5));
    this.windA.frequency.setTargetAtTime(300 + w * 420, t, 0.3);
    this.gA.gain.setTargetAtTime(0.08 + w * 0.2, t, 0.4);
    this.windB.frequency.setTargetAtTime(900 + w * 700, t, 0.5);
    this.gB.gain.setTargetAtTime(0.004 + Math.max(0, w - 0.6) * 0.05, t, 0.5);
    this.gLow.gain.setTargetAtTime(0.18 + w * 0.3, t, 0.5);
    this.gRain.gain.setTargetAtTime(env.rain * 0.22, t, 0.5);
    // listener frame for panning
    const yaw = Math.atan2(camera.matrixWorld.elements[8], camera.matrixWorld.elements[10]);
    this.listener = { x: camera.position.x, z: camera.position.z, rx: Math.cos(yaw), rz: -Math.sin(yaw) };
    // water proximity
    let wd = 999;
    const q = W.stream.near(hiker.pos.x, hiker.pos.z, 60); if (q) wd = q.d;
    wd = Math.min(wd, Math.hypot(hiker.pos.x - W.tarn.wfBot[0], hiker.pos.z - W.tarn.wfBot[1]) * 0.8);
    const fd = Math.hypot(camera.position.x - W.falls.pool.x, camera.position.z - W.falls.pool.z);
    const roar = Math.max(0, 1 - fd / 160);
    this.gWater.gain.setTargetAtTime(Math.max(0, 1 - wd / 45) * 0.16 + roar * roar * 0.3, t, 0.5);
    this.waterF.frequency.setTargetAtTime(900 - roar * 450, t, 0.5);
    // birds by day (larks, choughs), occasional night owl
    this.birdT -= dt;
    if (this.birdT < 0) {
      const day = 1 - env.night;
      if (env.storm < 0.4) { if (day > 0.5) this.bird(); else if (Math.random() < 0.3) this.owl(); }
      this.birdT = 4 + Math.random() * 10;
    }
    this.rockT -= dt;
    if (this.rockT < 0) { this.rockfall(null, 0.35 + Math.random() * 0.4); this.rockT = 35 + Math.random() * 60; }
  }
  bird() {
    const ctx = this.ctx, t0 = ctx.currentTime + 0.05;
    const out = this.pan((Math.random() - 0.5) * 1.6);
    const g = ctx.createGain(); g.gain.value = 0; g.connect(out);
    const o = ctx.createOscillator(); o.type = 'sine'; o.connect(g);
    const kind = Math.random();
    const vol = 0.025 + Math.random() * 0.03;
    if (kind < 0.55) { // lark trill
      const n = 6 + Math.floor(Math.random() * 10); let t = t0;
      for (let i = 0; i < n; i++) { const f = 2800 + Math.random() * 1800; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * (0.8 + Math.random() * 0.5), t + 0.06); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.linearRampToValueAtTime(0, t + 0.07); t += 0.08 + Math.random() * 0.04; }
      o.start(t0); o.stop(t + 0.1);
    } else { // chough call: descending chirps
      let t = t0;
      for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) { o.frequency.setValueAtTime(1900, t); o.frequency.exponentialRampToValueAtTime(1100, t + 0.18); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol * 1.2, t + 0.02); g.gain.linearRampToValueAtTime(0, t + 0.2); t += 0.35; }
      o.start(t0); o.stop(t + 0.2);
    }
  }
  owl() {
    const ctx = this.ctx, t0 = ctx.currentTime + 0.05;
    const out = this.pan((Math.random() - 0.5)); const g = ctx.createGain(); g.gain.value = 0; g.connect(out);
    const o = ctx.createOscillator(); o.type = 'sine'; o.connect(g);
    let t = t0; for (let i = 0; i < 2; i++) { o.frequency.setValueAtTime(420, t); o.frequency.linearRampToValueAtTime(380, t + 0.35); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.03, t + 0.05); g.gain.linearRampToValueAtTime(0, t + 0.4); t += 0.6; }
    o.start(t0); o.stop(t + 0.2);
  }
  eagle(pos) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx, t0 = ctx.currentTime + 0.05;
    const out = this.pan(this.relPan(pos)); const g = ctx.createGain(); g.gain.value = 0; g.connect(out);
    const o = ctx.createOscillator(); o.type = 'triangle'; o.connect(g);
    let t = t0; for (let i = 0; i < 3; i++) { o.frequency.setValueAtTime(2300, t); o.frequency.exponentialRampToValueAtTime(1500, t + 0.25); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.03, t + 0.03); g.gain.linearRampToValueAtTime(0, t + 0.28); t += 0.34; }
    o.start(t0); o.stop(t + 0.1);
  }
  marmot(pos) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx, t0 = ctx.currentTime + 0.02;
    const out = this.pan(this.relPan(pos)); const g = ctx.createGain(); g.gain.value = 0; g.connect(out);
    const o = ctx.createOscillator(); o.type = 'sine'; o.connect(g);
    o.frequency.setValueAtTime(3000, t0); o.frequency.linearRampToValueAtTime(2600, t0 + 0.25);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.05, t0 + 0.02); g.gain.linearRampToValueAtTime(0, t0 + 0.28);
    o.start(t0); o.stop(t0 + 0.3);
  }
  rockfall(pos, strength = 0.5) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx; const out = this.pan(this.relPan(pos));
    const n = 8 + Math.floor(strength * 20); let t = ctx.currentTime + 0.05;
    for (let i = 0; i < n; i++) {
      const s = ctx.createBufferSource(); s.buffer = this.white;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 600 + Math.random() * 2500; f.Q.value = 4;
      const g = ctx.createGain(); const v = 0.08 * strength * (1 - i / n) * (0.4 + Math.random());
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06 + Math.random() * 0.08);
      s.connect(f); f.connect(g); g.connect(out); s.start(t, Math.random() * 3, 0.2);
      t += 0.03 + Math.random() * 0.12 * (1 + i / n);
    }
  }
  thunder(delay, dist) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx; const t0 = ctx.currentTime + Math.min(delay, 14);
    const out = this.pan((Math.random() - 0.5) * 1.2);
    const s = ctx.createBufferSource(); s.buffer = this.brown;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = Math.max(90, 420 - dist * 0.05);
    const g = ctx.createGain(); g.gain.value = 0;
    const vol = Math.max(0.25, 1.1 - dist / 8000);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.25);
    // rolling rumbles
    let t = t0 + 0.3;
    for (let i = 0; i < 6; i++) { g.gain.linearRampToValueAtTime(vol * (0.35 + Math.random() * 0.6) * (1 - i / 7), t + 0.4 + Math.random() * 0.6); t += 0.5 + Math.random() * 0.8; }
    g.gain.linearRampToValueAtTime(0, t + 2.5);
    s.connect(f); f.connect(g); g.connect(out);
    s.start(t0, Math.random() * 2); s.stop(t + 3);
  }
  step(surf, speed) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = this.white;
    const f = ctx.createBiquadFilter();
    const scree = surf.scree > 0.4;
    f.type = scree ? 'bandpass' : 'lowpass'; f.frequency.value = scree ? 2200 + Math.random() * 800 : 700; f.Q.value = scree ? 1.2 : 0.7;
    const g = ctx.createGain(); const v = (scree ? 0.05 : 0.03) * Math.min(1, speed);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + (scree ? 0.16 : 0.1));
    s.connect(f); f.connect(g); g.connect(this.bus); s.start(t, Math.random() * 3, 0.2);
  }
}
