import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

class RaysPass extends Pass {
  constructor() {
    super();
    this.needsSwap = false;
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
    this.mat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uSun: { value: new THREE.Vector2(0.5, 0.5) }, uThresh: { value: 2.0 }, uAspect: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform vec2 uSun; uniform float uThresh; uniform float uAspect; varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main(){
          vec2 d = (uSun - vUv);
          float len = length(d * vec2(uAspect, 1.0));
          vec2 stepv = d * (min(len, 0.75) / max(len, 1e-4)) / 32.0;
          vec2 uv = vUv + stepv * hash(vUv * 400.0);
          vec3 acc = vec3(0.0); float w = 1.0;
          for (int i = 0; i < 32; i++) {
            vec3 c = texture2D(tDiffuse, uv).rgb;
            float l = dot(c, vec3(0.3, 0.5, 0.2));
            acc += c * smoothstep(uThresh, uThresh * 2.2, l) * w;
            w *= 0.95; uv += stepv;
          }
          gl_FragColor = vec4(acc / 32.0, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.fsq = new FullScreenQuad(this.mat);
  }
  setSize(w, h) { this.rt.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2)); this.mat.uniforms.uAspect.value = w / h; }
  render(renderer, writeBuffer, readBuffer) {
    this.mat.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.rt);
    this.fsq.render(renderer);
  }
}

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null }, tRays: { value: null },
    uRayCol: { value: new THREE.Color(0, 0, 0) },
    uExposure: { value: 1 }, uLift: { value: new THREE.Vector3() }, uGain: { value: new THREE.Vector3(1, 1, 1) },
    uSat: { value: 1 }, uContrast: { value: 1 }, uTime: { value: 0 },
    uFade: { value: 0 }, uFadeCol: { value: new THREE.Color(0.8, 0.83, 0.86) }, uFlash: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) }, uLoad: { value: 0 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform sampler2D tRays; uniform vec3 uRayCol;
    uniform float uExposure; uniform vec3 uLift; uniform vec3 uGain; uniform float uSat; uniform float uContrast;
    uniform float uTime; uniform float uFade; uniform vec3 uFadeCol; uniform float uFlash; uniform vec2 uRes;
    varying vec2 vUv;
    vec3 aces(vec3 x){ const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14; return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0); }
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c += texture2D(tRays, vUv).rgb * uRayCol;
      c *= uExposure * (1.0 + uFlash);
      // subtle chromatic warmth in highlights
      c = aces(c * 0.95);
      c = pow(c, vec3(1.0 / 1.0));
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSat);
      c = c * uGain + uLift * (1.0 - c);
      // vignette
      vec2 q = vUv - 0.5; q.x *= uRes.x / uRes.y;
      c *= 1.0 - 0.32 * smoothstep(0.35, 1.05, length(q));
      // mist transition (loop) - drifting cloud
      if (uFade > 0.0) {
        float n = vnoise(vUv * 3.0 + vec2(uTime * 0.15, 0.0)) * 0.6 + vnoise(vUv * 9.0 - uTime * 0.2) * 0.4;
        float f = clamp(uFade * 1.5 - (1.0 - n) * 0.5, 0.0, 1.0);
        c = mix(c, uFadeCol, f);
      }
      c = clamp(c, 0.0, 1.0);
      // linear -> sRGB
      c = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
      // contrast in display space so shadows keep their colour instead of clipping to black
      c = clamp((c - 0.5) * (1.0 + (uContrast - 1.0) * 1.6) + 0.5, 0.0, 1.0);
      // film grain
      c += (hash(vUv * uRes + fract(uTime) * 100.0) - 0.5) * 0.018;
      gl_FragColor = vec4(c, 1.0);
    }`,
};

export function buildPost(renderer, scene, camera) {
  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const rays = new RaysPass();
  composer.addPass(rays);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.55, 1.35);
  composer.addPass(bloom);
  const fin = new ShaderPass(FinalShader);
  fin.uniforms.tRays.value = rays.rt.texture;
  composer.addPass(fin);
  return { composer, rays, bloom, fin };
}
