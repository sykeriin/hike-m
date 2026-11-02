import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { U } from './materials.js';

// Terrain-cast soft shadows baked into two 2D textures (near: follows the camera, far: whole region),
// re-rendered only when the sun or the near window moves. Every material samples these instead of ray marching.
export class TerrainShadows {
  constructor(renderer) {
    this.renderer = renderer;
    const opts = { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false };
    this.near = new THREE.WebGLRenderTarget(1024, 1024, opts);
    this.far = new THREE.WebGLRenderTarget(1024, 1024, opts);
    this.near.texture.wrapS = this.near.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.far.texture.wrapS = this.far.texture.wrapT = THREE.ClampToEdgeWrapping;
    U.uTSNear.value = this.near.texture; U.uTSFar.value = this.far.texture;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uHeightTex: U.uHeightTex, uHeightInfo: U.uHeightInfo, uSun: { value: new THREE.Vector3(0, 1, 0) }, uRect: { value: new THREE.Vector4() }, uSteps: { value: 48 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D uHeightTex; uniform vec4 uHeightInfo; uniform vec3 uSun; uniform vec4 uRect; varying vec2 vUv;
        float H(vec2 xz){ vec2 uv = (xz - uHeightInfo.xy) / uHeightInfo.z + 0.5; return texture2D(uHeightTex, uv).r; }
        void main(){
          vec2 xz = uRect.xy + (vUv - 0.5) * uRect.z;
          vec3 L = normalize(uSun);
          if (L.y < -0.1) { gl_FragColor = vec4(0.0); return; }
          vec3 p0 = vec3(xz.x, H(xz) + 0.6, xz.y);
          float res = 1.0; float t = 1.5;
          for (int i = 0; i < 56; i++) {
            vec3 p = p0 + L * t;
            float dh = p.y - H(p.xz);
            res = min(res, dh / (t * 0.045 + 0.5));
            t = t * 1.14 + 1.0;
            if (res < -0.2 || p.y > 1700.0) break;
          }
          float s = smoothstep(-0.1, 1.0, res);
          gl_FragColor = vec4(s, s, s, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.fsq = new FullScreenQuad(this.mat);
    this.lastSun = new THREE.Vector3(0, -1, 0); this.lastCenter = new THREE.Vector2(1e9, 1e9); this.farSun = new THREE.Vector3(0, -1, 0);
    this.NEAR_SIZE = 320; this.FAR_SIZE = 5200;
    U.uTSRect.value.set(0, 0, this.NEAR_SIZE, this.FAR_SIZE);
  }
  render(target, cx, cz, size, sun) {
    this.mat.uniforms.uSun.value.copy(sun);
    this.mat.uniforms.uRect.value.set(cx, cz, size, 0);
    const r = this.renderer; const prev = r.getRenderTarget();
    r.setRenderTarget(target); this.fsq.render(r); r.setRenderTarget(prev);
  }
  update(focus, sun, force = false) {
    const texel = this.NEAR_SIZE / 1024;
    const cx = Math.round(focus.x / (texel * 16)) * texel * 16, cz = Math.round(focus.z / (texel * 16)) * texel * 16;
    const moved = Math.hypot(cx - this.lastCenter.x, cz - this.lastCenter.y) > 20;
    const sunMoved = sun.angleTo(this.lastSun) > 0.0025;
    if (force || moved || sunMoved) {
      // keep the window centred ahead of the camera; snap so texels stay put
      this.render(this.near, cx, cz, this.NEAR_SIZE, sun);
      this.lastCenter.set(cx, cz); this.lastSun.copy(sun);
      U.uTSRect.value.set(cx, cz, this.NEAR_SIZE, this.FAR_SIZE);
    }
    if (force || sun.angleTo(this.farSun) > 0.006) {
      this.render(this.far, 0, 0, this.FAR_SIZE, sun);
      this.farSun.copy(sun);
    }
  }
}
