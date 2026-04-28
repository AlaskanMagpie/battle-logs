import * as THREE from "three";
import type { MapGroundPreset } from "../game/types";

const VERT = /* glsl */ `
out vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
in vec3 vWorldPos;
out vec4 fragColor;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform vec3 uAccent;
uniform float uNoiseScale;
uniform float uStrataScale;
uniform float uCrackScale;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  vec2 shift = vec2(57.0, 113.0);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.0 + shift;
    a *= 0.5;
  }
  return v;
}

float ridge(float v) {
  return 1.0 - abs(v * 2.0 - 1.0);
}

void main() {
  vec2 xz = vWorldPos.xz;
  float macro = fbm(xz * uNoiseScale * 0.55);
  float detail = fbm(xz * uNoiseScale * 3.6 + vec2(19.0, 7.0));
  float grain = fbm(xz * uNoiseScale * 10.5 + vec2(3.0, 31.0));
  float strata = 0.5 + 0.5 * sin(xz.y * uStrataScale + macro * 5.0 + detail * 2.0);
  float crackA = pow(ridge(fbm(xz * uCrackScale * 5.8 + vec2(21.0, 4.0))), 5.0);
  float crackB = pow(ridge(fbm((xz.yx + vec2(11.0, 37.0)) * uCrackScale * 4.7)), 6.0);
  float cracks = smoothstep(0.34, 0.72, max(crackA, crackB)) * (0.55 + 0.45 * grain);
  float pits = smoothstep(0.62, 0.92, fbm(xz * uNoiseScale * 18.0 + vec2(61.0, 17.0)));
  float colorMix = clamp(0.42 * macro + 0.28 * detail + 0.2 * strata + 0.1 * grain, 0.0, 1.0);
  vec3 base = mix(uColorA, uColorB, colorMix);
  base = mix(base, uColorC, smoothstep(0.52, 0.92, strata));
  base *= 0.86 + 0.28 * grain;
  base = mix(base, base * 0.5, pits * 0.3);
  base += uAccent * cracks * (0.22 + 0.38 * detail);
  base = mix(base, vec3(0.02, 0.018, 0.016), cracks * 0.18);
  fragColor = vec4(base, 1.0);
}
`;

const PRESETS: Record<
  Exclude<MapGroundPreset, "solid">,
  {
    colorA: THREE.Vector3;
    colorB: THREE.Vector3;
    colorC: THREE.Vector3;
    accent: THREE.Vector3;
    noiseScale: number;
    strataScale: number;
    crackScale: number;
  }
> = {
  ember_wastes: {
    colorA: new THREE.Vector3(0.16, 0.065, 0.035),
    colorB: new THREE.Vector3(0.48, 0.18, 0.09),
    colorC: new THREE.Vector3(0.68, 0.33, 0.18),
    accent: new THREE.Vector3(1.0, 0.46, 0.16),
    noiseScale: 0.041,
    strataScale: 0.064,
    crackScale: 0.062,
  },
  glacier_grid: {
    colorA: new THREE.Vector3(0.045, 0.13, 0.21),
    colorB: new THREE.Vector3(0.18, 0.4, 0.56),
    colorC: new THREE.Vector3(0.44, 0.66, 0.78),
    accent: new THREE.Vector3(0.74, 0.94, 1.0),
    noiseScale: 0.037,
    strataScale: 0.052,
    crackScale: 0.078,
  },
  mesa_band: {
    colorA: new THREE.Vector3(0.23, 0.135, 0.075),
    colorB: new THREE.Vector3(0.55, 0.36, 0.2),
    colorC: new THREE.Vector3(0.72, 0.49, 0.28),
    accent: new THREE.Vector3(1.0, 0.72, 0.34),
    noiseScale: 0.034,
    strataScale: 0.068,
    crackScale: 0.054,
  },
};

export function createGroundShaderMaterial(preset: Exclude<MapGroundPreset, "solid">): THREE.ShaderMaterial {
  const p = PRESETS[preset];
  return new THREE.ShaderMaterial({
    uniforms: {
      uColorA: { value: p.colorA.clone() },
      uColorB: { value: p.colorB.clone() },
      uColorC: { value: p.colorC.clone() },
      uAccent: { value: p.accent.clone() },
      uNoiseScale: { value: p.noiseScale },
      uStrataScale: { value: p.strataScale },
      uCrackScale: { value: p.crackScale },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
  });
}

export function isShaderGroundPreset(p: MapGroundPreset | undefined): p is Exclude<MapGroundPreset, "solid"> {
  return p === "ember_wastes" || p === "glacier_grid" || p === "mesa_band";
}
