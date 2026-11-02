import * as THREE from 'three';
import { clamp, lerp } from './noise.js';

export class CameraRig {
  constructor(camera, dom, W, hiker) {
    this.cam = camera; this.W = W; this.hiker = hiker;
    this.yaw = hiker.yaw; this.pitch = 0.2; this.dist = 6.2;
    this.userYaw = 0; this.userPitch = 0; this.userIdle = 99;
    this.targetDist = 6.2;
    this.target = new THREE.Vector3();
    this.colliders = [];
    let drag = false, lx = 0, ly = 0;
    dom.addEventListener('pointerdown', e => { drag = true; lx = e.clientX; ly = e.clientY; dom.setPointerCapture(e.pointerId); });
    dom.addEventListener('pointerup', e => { drag = false; });
    dom.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
      this.userYaw -= dx * 0.005; this.userPitch = clamp(this.userPitch + dy * 0.004, -0.35, 1.1);
      this.userIdle = 0;
    });
    dom.addEventListener('wheel', e => { e.preventDefault(); this.targetDist = clamp(this.targetDist * Math.exp(e.deltaY * 0.001), 2.6, 38); this.userIdle = 0; }, { passive: false });
    this.snap();
  }
  snap() {
    this.yaw = this.hiker.yaw; this.userYaw = 0; this.userPitch = 0;
    this.target.copy(this.hiker.pos).y += 1.45;
    this.update(1, 0, true);
  }
  update(dt, time, snap = false) {
    const h = this.hiker, W = this.W;
    this.userIdle += dt;
    // follow behind hiker heading, with slow cinematic drift
    let dy = h.yaw - this.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * (1 - Math.exp(-dt * 0.9));
    if (this.userIdle > 6) {
      this.userYaw *= Math.exp(-dt * 0.25);
      this.userPitch *= Math.exp(-dt * 0.25);
    }
    const drift = Math.sin(time * 0.045) * 0.55 + Math.sin(time * 0.017 + 1.3) * 0.35;
    const driftK = clamp((this.userIdle - 4) / 6, 0, 1);
    const yaw = this.yaw + Math.PI + this.userYaw + drift * driftK;
    const wantDist = this.indoors ? Math.min(this.targetDist, 2.9) : this.targetDist;
    this.dist = lerp(this.dist, wantDist, 1 - Math.exp(-dt * 4));
    const pitch = clamp(0.16 + this.userPitch + Math.sin(time * 0.03) * 0.04 * driftK, -0.3, 1.25);
    const tgt = new THREE.Vector3(h.pos.x, h.root.position.y + h.pelvis.position.y + 0.55, h.pos.z);
    if (snap) this.target.copy(tgt); else this.target.lerp(tgt, 1 - Math.exp(-dt * 6));
    // cam position candidates, pull in when terrain blocks
    let d = this.dist;
    const cp = new THREE.Vector3();
    const place = (dd, pp) => {
      cp.set(this.target.x + Math.sin(yaw) * Math.cos(pp) * dd, this.target.y + Math.sin(pp) * dd, this.target.z + Math.cos(yaw) * Math.cos(pp) * dd);
    };
    let p = pitch;
    place(d, p);
    // raise pitch if the line of sight dips into terrain
    for (let it = 0; it < 16; it++) {
      let blocked = false;
      for (let k = 1; k <= 10; k++) {
        const t = k / 10;
        const x = lerp(this.target.x, cp.x, t), z = lerp(this.target.z, cp.z, t), y = lerp(this.target.y, cp.y, t);
        if (y < W.ground(x, z) + 0.45) { blocked = true; break; }
      }
      if (!blocked) break;
      if (d > this.dist * 0.55) d = Math.max(2.4, d * 0.86); else if (p < pitch + 0.45) p += 0.06; else d = Math.max(2.2, d * 0.9);
      place(d, p);
    }
    // raise/pull-in immediately, relax back slowly
    this.pitchOut = snap ? p : Math.max(p, lerp(this.pitchOut ?? p, p, 1 - Math.exp(-dt * 1.5)));
    this.distOut = snap ? d : Math.min(d, lerp(this.distOut ?? d, d, 1 - Math.exp(-dt * 1.5)));
    place(this.distOut, this.pitchOut);
    // rock/landmark colliders
    for (const c of this.colliders) {
      const dx = cp.x - c.x, dz = cp.z - c.z, dyy = cp.y - c.y; const dd = Math.hypot(dx, dyy, dz);
      if (dd < c.r + 0.6) { const k = (c.r + 0.6) / (dd || 1); cp.set(c.x + dx * k, c.y + dyy * k, c.z + dz * k); }
    }
    // the cabin: stay inside the room when the hiker is indoors, never slip through its walls from outside
    const Hh = this.house;
    let indoors = false;
    if (Hh) {
      indoors = Hh.inside(this.target.x, this.target.z);
      const Hs = W.house;
      if (indoors) {
        const b = Hh.interiorBox;
        const [lx, lz] = Hs.toL(cp.x, cp.z);
        const [wx, wz] = Hs.toW(clamp(lx, -b.hx, b.hx), clamp(lz, -b.hz, b.hz));
        cp.x = wx; cp.z = wz; cp.y = clamp(cp.y, b.y0 + 0.9, b.y1);
      } else {
        for (let k = 0; k < 14; k++) {
          const [lx, lz] = Hs.toL(cp.x, cp.z);
          if (Math.abs(lx) < Hs.hx + 0.7 && Math.abs(lz) < Hs.hz + 0.7 && cp.y < Hs.floorH + 4.8) cp.lerp(this.target, 0.2); else break;
        }
      }
    }
    this.indoors = indoors;
    const gmin = W.ground(cp.x, cp.z) + (indoors ? 0.9 : 0.6);
    if (cp.y < gmin) cp.y = gmin;
    if (snap) this.cam.position.copy(cp); else this.cam.position.lerp(cp, 1 - Math.exp(-dt * 10));
    const gm2 = W.ground(this.cam.position.x, this.cam.position.z) + 0.5;
    if (this.cam.position.y < gm2) this.cam.position.y = gm2;
    this.cam.lookAt(this.target.x, this.target.y + 0.1, this.target.z);
    this.yawOut = yaw;
  }
  get camYaw() { return this.yawOut; }
}
