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
uniform vec2 uFlow;
uniform float uNoiseScale;
uniform float uStrataScale;
uniform float uCrackScale;
uniform float uBandStrength;
uniform float uSeamStrength;
uniform float uSeamGlow;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
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
  vec2 xz = vWorldPos.xz;
  // Two noise samples and one hash, rather than four five-octave FBM passes.
  // World-space flow keeps the texture stable as the camera moves and maps resize.
  vec2 flow = vec2(dot(xz, uFlow), dot(xz, vec2(-uFlow.y, uFlow.x)));
  float macro = noise(flow * uNoiseScale);
  float detail = noise(flow * uNoiseScale * 3.7 + vec2(19.0, 7.0));
  float band = 0.5 + 0.5 * sin(flow.y * uStrataScale + macro * 3.1 + detail * 1.3);
  float mixValue = clamp(macro * 0.58 + detail * 0.42, 0.0, 1.0);
  vec3 base = mix(uColorA, uColorB, mixValue);
  base = mix(base, uColorC, smoothstep(0.66, 0.92, band) * uBandStrength);

  float grainScale = uNoiseScale * 18.0;
  float grainFootprint = max(fwidth(flow.x * grainScale), fwidth(flow.y * grainScale));
  float grainFade = 1.0 - smoothstep(0.55, 1.4, grainFootprint);
  float grain = hash(floor(flow * grainScale));
  base *= 1.0 + (grain - 0.5) * 0.13 * grainFade;

  // Soft warped fault seams; their accent is capped so units and placement cues stay brighter.
  float fault = flow.x * uCrackScale + macro * 3.2 + sin(flow.y * uCrackScale * 0.47) * 0.9;
  float seam = 1.0 - smoothstep(0.03, 0.13, abs(sin(fault)));
  seam *= uSeamStrength * (1.0 - smoothstep(0.55, 1.4, fwidth(fault)));
  base *= 1.0 - 0.24 * seam;
  base += uAccent * seam * uSeamGlow;
  base = clamp(base, vec3(0.0), vec3(0.62));
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
    flow: THREE.Vector2;
    noiseScale: number;
    strataScale: number;
    crackScale: number;
    bandStrength: number;
    seamStrength: number;
    seamGlow: number;
  }
> = {
  ember_wastes: {
    colorA: new THREE.Vector3(0.10, 0.075, 0.068),
    colorB: new THREE.Vector3(0.27, 0.16, 0.115),
    colorC: new THREE.Vector3(0.38, 0.23, 0.15),
    accent: new THREE.Vector3(0.65, 0.29, 0.12),
    flow: new THREE.Vector2(0.96, 0.28),
    noiseScale: 0.032,
    strataScale: 0.055,
    crackScale: 0.087,
    bandStrength: 0.2,
    seamStrength: 0.23,
    seamGlow: 0.055,
  },
  forge_slag: {
    colorA: new THREE.Vector3(0.075, 0.071, 0.071),
    colorB: new THREE.Vector3(0.23, 0.135, 0.095),
    colorC: new THREE.Vector3(0.35, 0.2, 0.11),
    accent: new THREE.Vector3(0.95, 0.32, 0.08),
    flow: new THREE.Vector2(0.86, 0.51),
    noiseScale: 0.045,
    strataScale: 0.09,
    crackScale: 0.15,
    bandStrength: 0.18,
    seamStrength: 0.65,
    seamGlow: 0.2,
  },
  cinder_field: {
    colorA: new THREE.Vector3(0.058, 0.057, 0.07),
    colorB: new THREE.Vector3(0.18, 0.09, 0.09),
    colorC: new THREE.Vector3(0.25, 0.125, 0.105),
    accent: new THREE.Vector3(0.75, 0.18, 0.085),
    flow: new THREE.Vector2(0.8, -0.6),
    noiseScale: 0.028,
    strataScale: 0.046,
    crackScale: 0.075,
    bandStrength: 0.12,
    seamStrength: 0.16,
    seamGlow: 0.05,
  },
  glacier_grid: {
    colorA: new THREE.Vector3(0.075, 0.145, 0.195),
    colorB: new THREE.Vector3(0.2, 0.34, 0.42),
    colorC: new THREE.Vector3(0.36, 0.5, 0.56),
    accent: new THREE.Vector3(0.62, 0.83, 0.92),
    flow: new THREE.Vector2(0.68, 0.73),
    noiseScale: 0.037,
    strataScale: 0.052,
    crackScale: 0.11,
    bandStrength: 0.27,
    seamStrength: 0.45,
    seamGlow: 0.04,
  },
  mesa_band: {
    colorA: new THREE.Vector3(0.18, 0.12, 0.08),
    colorB: new THREE.Vector3(0.4, 0.27, 0.16),
    colorC: new THREE.Vector3(0.55, 0.37, 0.21),
    accent: new THREE.Vector3(0.7, 0.48, 0.24),
    flow: new THREE.Vector2(0.98, -0.2),
    noiseScale: 0.034,
    strataScale: 0.07,
    crackScale: 0.065,
    bandStrength: 0.8,
    seamStrength: 0.15,
    seamGlow: 0.025,
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
      uFlow: { value: p.flow.clone().normalize() },
      uNoiseScale: { value: p.noiseScale },
      uStrataScale: { value: p.strataScale },
      uCrackScale: { value: p.crackScale },
      uBandStrength: { value: p.bandStrength },
      uSeamStrength: { value: p.seamStrength },
      uSeamGlow: { value: p.seamGlow },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
  });
}

export function isShaderGroundPreset(p: MapGroundPreset | undefined): p is Exclude<MapGroundPreset, "solid"> {
  return p === "ember_wastes" || p === "forge_slag" || p === "cinder_field" || p === "glacier_grid" || p === "mesa_band";
}
