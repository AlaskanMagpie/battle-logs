import * as THREE from "three";

/** Ground-plane mana rings: solid where visible, sparse hatch only where occluded by geometry (see syncTaps). */

const HATCH_VS = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const HATCH_FS = `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  float d = (vUv.x + vUv.y) * 48.0;
  float f = fract(d);
  float band = smoothstep(0.42, 0.48, f) * smoothstep(0.58, 0.52, f);
  float alt = smoothstep(0.08, 0.14, f) * smoothstep(0.22, 0.16, f);
  float strength = max(band, alt);
  float a = strength * uOpacity;
  if (a < 0.04) discard;
  gl_FragColor = vec4(uColor * sqrt(strength + 0.15), a);
}
`;

export type TapBandMeshes = {
  group: THREE.Group;
  solid: THREE.Mesh;
  hatch: THREE.Mesh;
};

export function createSolidBandMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

function createHatchBandMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xffffff) },
      uOpacity: { value: 0.38 },
    },
    vertexShader: HATCH_VS,
    fragmentShader: HATCH_FS,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    depthFunc: THREE.GreaterDepth,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -0.8,
    polygonOffsetUnits: -0.8,
  });
}

/** Two meshes sharing `geometry` — solid obeys depth; hatch only where something occludes the ring. */
export function createTapBandMeshes(geometry: THREE.BufferGeometry): TapBandMeshes {
  const solid = new THREE.Mesh(geometry, createSolidBandMaterial());
  const hatch = new THREE.Mesh(geometry, createHatchBandMaterial());
  solid.rotation.x = -Math.PI / 2;
  hatch.rotation.x = -Math.PI / 2;
  const group = new THREE.Group();
  group.add(solid, hatch);
  return { group, solid, hatch };
}

/** Sync fragment colors for additive solid + hatch (hatch slightly softer). */
export function syncTapBandColors(
  band: TapBandMeshes,
  color: THREE.ColorRepresentation,
  opacity: number,
): void {
  const solid = band.solid.material as THREE.MeshBasicMaterial;
  solid.color.set(color);
  solid.opacity = opacity;
  const hatch = band.hatch.material as THREE.ShaderMaterial;
  const c = solid.color;
  (hatch.uniforms.uColor.value as THREE.Color).copy(c);
  hatch.uniforms.uOpacity.value = Math.min(0.52, opacity * 0.48 + 0.12);
}

/** Replace geometry on both meshes (dispose previous once — shared buffer). */
export function setSharedBandGeometry(band: TapBandMeshes, geo: THREE.BufferGeometry): void {
  const prev = band.solid.geometry;
  if (prev === band.hatch.geometry) {
    prev.dispose();
  } else {
    band.solid.geometry.dispose();
    band.hatch.geometry.dispose();
  }
  band.solid.geometry = geo;
  band.hatch.geometry = geo;
}

/** Dispose ring/plane tap band (shared or split geometry). */
export function disposeTapBandMeshes(band: TapBandMeshes): void {
  const g0 = band.solid.geometry;
  const g1 = band.hatch.geometry;
  if (g0 === g1) g0.dispose();
  else {
    g0.dispose();
    g1.dispose();
  }
  band.solid.material.dispose();
  band.hatch.material.dispose();
}
