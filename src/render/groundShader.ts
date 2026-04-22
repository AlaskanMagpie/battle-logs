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
uniform vec3 uAccent;
uniform float uNoiseScale;

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

void main() {
  vec2 xz = vWorldPos.xz * uNoiseScale;
  float n = noise(xz);
  float n2 = noise(xz * 2.3);
  float veins = smoothstep(0.55, 0.92, abs(sin(xz.x * 0.12 + xz.y * 0.09 + n * 2.0)));
  float blend = 0.45 * n + 0.35 * n2 + 0.2 * veins;
  vec3 base = mix(uColorA, uColorB, blend);
  base += uAccent * pow(veins, 3.0) * 0.35;
  fragColor = vec4(base, 1.0);
}
`;

const PRESETS: Record<
  Exclude<MapGroundPreset, "solid">,
  { colorA: THREE.Vector3; colorB: THREE.Vector3; accent: THREE.Vector3; noiseScale: number }
> = {
  ember_wastes: {
    colorA: new THREE.Vector3(0.08, 0.04, 0.06),
    colorB: new THREE.Vector3(0.35, 0.12, 0.08),
    accent: new THREE.Vector3(1.0, 0.35, 0.08),
    noiseScale: 0.045,
  },
  glacier_grid: {
    colorA: new THREE.Vector3(0.06, 0.1, 0.14),
    colorB: new THREE.Vector3(0.22, 0.32, 0.42),
    accent: new THREE.Vector3(0.55, 0.85, 1.0),
    noiseScale: 0.038,
  },
  mesa_band: {
    colorA: new THREE.Vector3(0.18, 0.12, 0.08),
    colorB: new THREE.Vector3(0.42, 0.32, 0.22),
    accent: new THREE.Vector3(0.95, 0.72, 0.38),
    noiseScale: 0.032,
  },
};

export function createGroundShaderMaterial(preset: Exclude<MapGroundPreset, "solid">): THREE.ShaderMaterial {
  const p = PRESETS[preset];
  return new THREE.ShaderMaterial({
    uniforms: {
      uColorA: { value: p.colorA.clone() },
      uColorB: { value: p.colorB.clone() },
      uAccent: { value: p.accent.clone() },
      uNoiseScale: { value: p.noiseScale },
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
