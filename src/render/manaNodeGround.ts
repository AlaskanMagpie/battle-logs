import * as THREE from "three";
import { HERO_CLAIM_RADIUS } from "../game/constants";
import type { TapBandMeshes } from "./tapRingVisual";

/** World width/depth of the square decal (matches prior outer ring footprint ~ claimR × 2). */
export const MANA_NODE_DECAL_WORLD_SIZE = HERO_CLAIM_RADIUS * 2.06;

export type ManaNodeTextureSet = {
  neutral: THREE.Texture;
  friendly: THREE.Texture;
  hostile: THREE.Texture;
};

export type ManaNodeGroundBand = TapBandMeshes & {
  spinLayer: THREE.Mesh;
};

const TEX_NEUTRAL = "/assets/nodes/mana_node_neutral.png";
const TEX_FRIENDLY = "/assets/nodes/mana_node_friendly.png";
const TEX_HOSTILE = "/assets/nodes/mana_node_hostile.png";
const TEX_SPIN = "/assets/nodes/mana_node_spin.svg";

function configureTex(t: THREE.Texture): THREE.Texture {
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export async function loadManaNodeTextures(loader: THREE.TextureLoader): Promise<ManaNodeTextureSet> {
  const [neutral, friendly, hostile] = await Promise.all([
    loader.loadAsync(TEX_NEUTRAL),
    loader.loadAsync(TEX_FRIENDLY),
    loader.loadAsync(TEX_HOSTILE),
  ]);
  configureTex(neutral);
  configureTex(friendly);
  configureTex(hostile);
  return { neutral, friendly, hostile };
}

export async function loadManaNodeSpinTexture(loader: THREE.TextureLoader): Promise<THREE.Texture> {
  const t = await loader.loadAsync(TEX_SPIN);
  configureTex(t);
  return t;
}

const SOLID_VS = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SOLID_FS = `
uniform sampler2D uMap;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec4 tex = texture2D(uMap, vUv);
  float lum = max(tex.r, max(tex.g, tex.b));
  if (lum < 0.06) discard;
  gl_FragColor = vec4(tex.rgb, tex.a * uOpacity);
}
`;

const HATCH_FS = `
uniform sampler2D uMap;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec4 tex = texture2D(uMap, vUv);
  float lum = max(tex.r, max(tex.g, tex.b));
  if (lum < 0.06) discard;
  float d = (vUv.x + vUv.y) * 46.0;
  float f = fract(d);
  float band = smoothstep(0.42, 0.48, f) * smoothstep(0.58, 0.52, f);
  float alt = smoothstep(0.08, 0.14, f) * smoothstep(0.22, 0.16, f);
  float strength = max(band, alt);
  float a = strength * uOpacity * tex.a;
  if (a < 0.035) discard;
  gl_FragColor = vec4(tex.rgb * strength, a);
}
`;

function createSolidManaMaterial(tex: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tex },
      uOpacity: { value: 1 },
    },
    vertexShader: SOLID_VS,
    fragmentShader: SOLID_FS,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    side: THREE.DoubleSide,
  });
}

function createHatchManaMaterial(tex: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tex },
      uOpacity: { value: 0.38 },
    },
    vertexShader: SOLID_VS,
    fragmentShader: HATCH_FS,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    depthFunc: THREE.GreaterDepth,
    blending: THREE.NormalBlending,
    polygonOffset: true,
    polygonOffsetFactor: -0.85,
    polygonOffsetUnits: -0.85,
    side: THREE.DoubleSide,
  });
}

/** Ground decal + occlusion hatch + slowly rotated SVG dash overlay. */
export function createManaNodeGroundBand(
  textures: ManaNodeTextureSet,
  spinTex: THREE.Texture,
  initialTex: THREE.Texture,
): ManaNodeGroundBand {
  const size = MANA_NODE_DECAL_WORLD_SIZE;
  const geo = new THREE.PlaneGeometry(size, size);
  const solid = new THREE.Mesh(geo, createSolidManaMaterial(initialTex));
  const hatch = new THREE.Mesh(geo, createHatchManaMaterial(initialTex));
  solid.rotation.x = -Math.PI / 2;
  hatch.rotation.x = -Math.PI / 2;
  solid.position.y = 0.052;
  hatch.position.y = 0.053;

  const spinMat = new THREE.MeshBasicMaterial({
    map: spinTex,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    color: 0xffffff,
    polygonOffset: true,
    polygonOffsetFactor: -1.2,
    polygonOffsetUnits: -1.2,
    side: THREE.DoubleSide,
  });
  const spinLayer = new THREE.Mesh(new THREE.PlaneGeometry(size * 1.02, size * 1.02), spinMat);
  spinLayer.rotation.x = -Math.PI / 2;
  spinLayer.position.y = 0.058;

  const group = new THREE.Group();
  group.userData["tapGfx"] = "mana";
  group.add(solid, hatch, spinLayer);

  return { group, solid, hatch, spinLayer };
}

export function syncManaNodeBandTexture(band: ManaNodeGroundBand, tex: THREE.Texture, opacity: number): void {
  const solid = band.solid.material as THREE.ShaderMaterial;
  const hatch = band.hatch.material as THREE.ShaderMaterial;
  solid.uniforms.uMap.value = tex;
  hatch.uniforms.uMap.value = tex;
  solid.uniforms.uOpacity.value = opacity;
  hatch.uniforms.uOpacity.value = Math.min(0.48, opacity * 0.42 + 0.1);
}

/** Tint SVG overlay (neutral=white, friendly=blue-ish, hostile=red-ish). */
export function syncManaNodeSpinTint(band: ManaNodeGroundBand, rgb: THREE.Color): void {
  const m = band.spinLayer.material as THREE.MeshBasicMaterial;
  m.color.copy(rgb);
  m.opacity = 0.42 + Math.min(0.35, (rgb.r + rgb.g + rgb.b) / 4.5);
}

export function disposeManaNodeBand(band: ManaNodeGroundBand): void {
  const g = band.solid.geometry;
  g.dispose();
  (band.solid.material as THREE.ShaderMaterial).dispose();
  (band.hatch.material as THREE.ShaderMaterial).dispose();
  band.spinLayer.geometry.dispose();
  (band.spinLayer.material as THREE.MeshBasicMaterial).dispose();
}
