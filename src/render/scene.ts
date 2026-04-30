import * as THREE from "three";
import { MOUSE } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { getControlProfile, type ControlProfile } from "../controlProfile";
import { getCatalogEntry } from "../game/catalog";
import {
  HERO_CLAIM_RADIUS,
  PRODUCED_UNIT_AMBER_GEODE_MONKS,
  PRODUCED_UNIT_CHRONO_SENTINELS,
  PRODUCED_UNIT_LAVA_WIZARD_MONKS,
  STRUCTURE_MESH_VISUAL_SCALE,
  TAP_YIELD_MAX,
  TERRITORY_RADIUS,
  TICK_HZ,
} from "../game/constants";
import { claimChannelSecForTap } from "../game/sim/systems/homeDistance";
import { dist2, unitMeshLinearSize, unitStatsForCatalog } from "../game/sim/systems/helpers";
import {
  dominantSignal,
  enemyTerritorySources,
  findKeep,
  HERO_SELECTION_ID,
  inEnemyTerritory,
  inPlayerTerritory,
  signalColorHex,
  structureFacingYawRad,
  territorySources,
  liveSquadCount,
  type GameState,
} from "../game/state";
import type {
  CommandEffect,
  MapGroundPreset,
  SignalType,
  StructureCatalogEntry,
  UnitSizeClass,
  Vec2,
} from "../game/types";
import { isStructureEntry } from "../game/types";
import {
  clearFx,
  createFxHost,
  spawnCastFx,
  spawnCombatHitMark,
  spawnSiegeTell,
  stepFx,
  type FxHost,
} from "./fx";
import {
  glbBoxExtentRef,
  requestGlbForHero,
  requestGlbForTower,
  requestGlbForUnit,
  type GlbExtentBasis,
} from "./glbPool";
import {
  createManaNodeGroundBand,
  disposeManaNodeBand,
  loadManaNodeSpinTexture,
  loadManaNodeTextures,
  syncManaNodeBandTexture,
  syncManaNodeSpinTint,
  type ManaNodeGroundBand,
  type ManaNodeTextureSet,
} from "./manaNodeGround";
import {
  createTapBandMeshes,
  disposeTapBandMeshes,
  setSharedBandGeometry,
  syncTapBandColors,
  type TapBandMeshes,
} from "./tapRingVisual";
import { createGroundShaderMaterial, isShaderGroundPreset } from "./groundShader";
/** Exponential follow (1/s); orbit pivot eases toward the wizard without changing zoom. */
const CAMERA_HERO_FOLLOW_LAMBDA = 7.2;
/** Orbit pivot height at the wizard (Y only — XZ track hero feet). */
const CAMERA_HERO_PIVOT_Y = 1.38;
/** Match start: high orbit flyover before sim time begins. */
const MATCH_INTRO_CAMERA_SEC = 5.4;
/** If a unit's visual moves more than this, it must be in run/move animation. */
const UNIT_VISUAL_RUN_EPS = 0.035;
/** Start/stop hysteresis so formation slot settling and separation nudges do not flicker run/idle. */
const UNIT_VISUAL_RUN_START_EPS = 0.055;
const UNIT_VISUAL_RUN_STOP_EPS = 0.018;
/** Hero GLB run vs idle: same idea as squads — use sim travel per frame, not only click-target flags (Captain / gaps). */
const HERO_LOCOMOTION_EPS = 0.055;
/** Time-normalized visual catch-up while running; keeps fixed sim ticks from reading as frame teleports. */
const UNIT_VISUAL_RUN_CATCHUP_LAMBDA = 14;
/** Hero uses a slightly tighter catch-up than squads so close camera follow feels smooth but responsive. */
const HERO_VISUAL_RUN_CATCHUP_LAMBDA = 16;
/** Exponential smoothing for visual velocity used by procedural lean/bob. */
const UNIT_VISUAL_SPEED_LAMBDA = 9.5;
/** Visual systems should advance in normalized frame-sized chunks; avoids pose jumps after stalls/throttling. */
const RENDER_VISUAL_DT_CAP_SEC = 1 / 30;

/** Same equirect asset / path as the doctrine prematch room (`CardBinderEngine` nebula sky). */
const MATCH_SKYBOX_URL = "/assets/binder/doctrine-skybox.png";
/** Doctrine nebula equirect as `Scene.background` during matches (fog stays off in `applyMapVisual`). */
const MATCH_SKYBOX_ENABLED = true;
/** Ground tint when match uses the doctrine equirect as `Scene.background` (fog stays off — see `applyMapVisual`). */
const MATCH_SKYBOX_GROUND_HEX = 0xc8b6a0;

type UnitMotionVisual = {
  speed: number;
  targetSpeed: number;
  velX: number;
  velZ: number;
  bobPhase: number;
  movingBlend: number;
  leanPitch: number;
  leanRoll: number;
  attackKick: number;
  attackActive: boolean;
  moving: boolean;
  sizeClass: UnitSizeClass;
};

/**
 * Spell command effect kinds that *could* use a texture on the ground ghost.
 * We intentionally load **no** card PNGs here — full card art is heavy and reads poorly stretched on terrain;
 * drag ghosts stay procedural (boxes / tinted quads) to keep match startup lite.
 */
type SpellReticleEffectType = Extract<
  CommandEffect["type"],
  "aoe_line_damage" | "aoe_tactics_field" | "aoe_damage" | "aoe_shatter_chain"
>;

const SPELL_RETICLE_EFFECT_TYPES: readonly SpellReticleEffectType[] = [
  "aoe_line_damage",
  "aoe_tactics_field",
  "aoe_damage",
  "aoe_shatter_chain",
] as const;

function isSpellReticleEffectType(t: CommandEffect["type"] | null | undefined): t is SpellReticleEffectType {
  return (
    t === "aoe_line_damage" ||
    t === "aoe_tactics_field" ||
    t === "aoe_damage" ||
    t === "aoe_shatter_chain"
  );
}
const MATCH_SKYBOX_PLACEMENT_STORAGE_KEY = "signalWarsMatchSkyboxPlacement.v1";
export type MatchSkyboxPlacement = { x: number; y: number; z: number };
const DEFAULT_MATCH_SKYBOX_PLACEMENT: MatchSkyboxPlacement = { x: 0, y: -120, z: 0 };
function readMatchSkyboxPlacement(): MatchSkyboxPlacement {
  try {
    const raw = window.localStorage.getItem(MATCH_SKYBOX_PLACEMENT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MATCH_SKYBOX_PLACEMENT };
    const parsed = JSON.parse(raw) as Partial<MatchSkyboxPlacement>;
    return {
      x: Number.isFinite(parsed.x) ? parsed.x! : DEFAULT_MATCH_SKYBOX_PLACEMENT.x,
      y: Number.isFinite(parsed.y) ? parsed.y! : DEFAULT_MATCH_SKYBOX_PLACEMENT.y,
      z: Number.isFinite(parsed.z) ? parsed.z! : DEFAULT_MATCH_SKYBOX_PLACEMENT.z,
    };
  } catch {
    return { ...DEFAULT_MATCH_SKYBOX_PLACEMENT };
  }
}

function writeMatchSkyboxPlacement(p: MatchSkyboxPlacement): void {
  try {
    window.localStorage.setItem(MATCH_SKYBOX_PLACEMENT_STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

function makeGroundOverlayTexture(preset: MapGroundPreset): THREE.CanvasTexture {
  const size = 512;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);

  let seed = hashTag(`ground-overlay:${preset}`) || 1;
  const rnd = (): number => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const tint =
    preset === "ember_wastes"
      ? { blob: "rgba(255,150,82,0.18)", crack: "rgba(255,220,160,0.22)" }
      : preset === "glacier_grid"
        ? { blob: "rgba(155,220,255,0.16)", crack: "rgba(235,252,255,0.2)" }
        : preset === "mesa_band"
          ? { blob: "rgba(255,190,116,0.17)", crack: "rgba(255,225,170,0.18)" }
          : { blob: "rgba(155,205,255,0.12)", crack: "rgba(210,235,255,0.16)" };

  // Soft blotches only; repeated lines shimmer badly at shallow camera angles.
  for (let i = 0; i < 52; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 18 + rnd() * 72;
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, tint.blob);
    gr.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = tint.crack;
  ctx.lineWidth = 1.75;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 0; i < 17; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const ang = rnd() * Math.PI * 2;
    const len = 30 + rnd() * 72;
    const bend = (rnd() - 0.5) * 42;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(
      x + Math.cos(ang + 0.65) * len * 0.45,
      y + Math.sin(ang + 0.65) * len * 0.45 + bend,
      x + Math.cos(ang) * len,
      y + Math.sin(ang) * len,
    );
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.repeat.set(2.15, 2.15);
  tex.anisotropy = 4;
  return tex;
}

function hashTag(tag: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeDecorWrapTexture(preset: MapGroundPreset, tag: string): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;

  const pal =
    preset === "ember_wastes"
      ? { a: "#a58272", b: "#6f4635", light: "rgba(255,235,205,0.28)", dark: "rgba(24,10,7,0.42)" }
      : preset === "glacier_grid"
        ? { a: "#b5d0da", b: "#638596", light: "rgba(255,255,255,0.28)", dark: "rgba(12,24,34,0.4)" }
        : preset === "mesa_band"
          ? { a: "#b89670", b: "#735339", light: "rgba(255,230,190,0.26)", dark: "rgba(35,18,9,0.38)" }
          : { a: "#9ba9b8", b: "#5a6674", light: "rgba(235,245,255,0.22)", dark: "rgba(12,16,20,0.36)" };

  const grad = ctx.createRadialGradient(size * 0.38, size * 0.32, 12, size * 0.5, size * 0.5, size * 0.72);
  grad.addColorStop(0, pal.a);
  grad.addColorStop(1, pal.b);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  let s = hashTag(`${preset}:${tag}`) || 1;
  const rnd = (): number => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };

  for (let i = 0; i < 18; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 14 + rnd() * 46;
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, pal.light);
    rg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = pal.dark;
  for (let i = 0; i < 850; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const d = 0.4 + rnd() * 1.4;
    ctx.fillRect(x, y, d, d);
  }
  ctx.strokeStyle = pal.dark;
  ctx.lineWidth = 1.1;
  ctx.lineCap = "round";
  for (let i = 0; i < 26; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const a = rnd() * Math.PI * 2;
    const len = 10 + rnd() * 34;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(
      x + Math.cos(a + 0.7) * len * 0.45,
      y + Math.sin(a + 0.7) * len * 0.45,
      x + Math.cos(a) * len,
      y + Math.sin(a) * len,
    );
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

const DECOR_ROCK_VERT = /* glsl */ `
out vec3 vWorldPos;
out vec3 vNormal;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DECOR_ROCK_FRAG = /* glsl */ `
in vec3 vWorldPos;
in vec3 vNormal;
out vec4 fragColor;
uniform vec3 uDark;
uniform vec3 uBase;
uniform vec3 uLight;
uniform vec3 uAccent;
uniform float uScale;
uniform float uSeed;
uniform float uBlockiness;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i + uSeed);
  float b = hash(i + vec2(1.0, 0.0) + uSeed);
  float c = hash(i + vec2(0.0, 1.0) + uSeed);
  float d = hash(i + vec2(1.0, 1.0) + uSeed);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.02 + vec2(37.0, 19.0);
    a *= 0.5;
  }
  return v;
}

float ridge(float v) {
  return 1.0 - abs(v * 2.0 - 1.0);
}

void main() {
  vec3 n = normalize(vNormal);
  vec2 sideUv = vec2(vWorldPos.x + vWorldPos.z * 0.37, vWorldPos.y * 1.28) * uScale;
  vec2 topUv = vWorldPos.xz * uScale;
  float top = smoothstep(0.42, 0.88, abs(n.y));
  vec2 uv = mix(sideUv, topUv, top);

  float macro = fbm(uv * 0.72 + vec2(uSeed, 0.0));
  float grain = fbm(uv * 4.8 + vec2(11.0, 23.0));
  float strata = 0.5 + 0.5 * sin(vWorldPos.y * (1.55 + uBlockiness) + macro * 5.2 + uSeed);
  float crackA = pow(ridge(fbm(uv * 5.2 + vec2(17.0, 41.0))), 5.0);
  float crackB = pow(ridge(fbm(uv.yx * 4.4 + vec2(53.0, 7.0))), 6.0);
  float cracks = smoothstep(0.48, 0.82, max(crackA, crackB)) * (0.5 + 0.5 * grain);

  vec2 blockCell = abs(fract(vec2(vWorldPos.x * 0.17 + vWorldPos.z * 0.11, vWorldPos.y * 0.62) + uSeed) - 0.5);
  float mortar = smoothstep(0.455, 0.49, max(blockCell.x, blockCell.y)) * uBlockiness * (1.0 - top * 0.65);

  vec3 color = mix(uDark, uBase, 0.38 + 0.44 * macro);
  color = mix(color, uLight, smoothstep(0.52, 0.9, strata) * 0.38);
  color *= 0.78 + 0.34 * grain;
  color = mix(color, uAccent, cracks * 0.28);
  color = mix(color, uDark * 0.52, max(cracks * 0.58, mortar * 0.72));

  float lit = clamp(dot(n, normalize(vec3(-0.38, 0.82, 0.46))) * 0.5 + 0.56, 0.32, 1.18);
  color *= lit + top * 0.08;
  fragColor = vec4(color, 1.0);
}
`;

function decorRockPalette(preset: MapGroundPreset): {
  dark: number;
  base: number;
  light: number;
  accent: number;
  scale: number;
  blockiness: number;
} {
  switch (preset) {
    case "ember_wastes":
      return { dark: 0x221715, base: 0x5e4036, light: 0xa98268, accent: 0xd06a34, scale: 0.13, blockiness: 0.72 };
    case "glacier_grid":
      return { dark: 0x152331, base: 0x4f6d7a, light: 0xb2cbd2, accent: 0x8ed8ff, scale: 0.12, blockiness: 0.56 };
    case "mesa_band":
      return { dark: 0x2d2019, base: 0x75543c, light: 0xb78b5d, accent: 0xd89a50, scale: 0.115, blockiness: 0.82 };
    default:
      return { dark: 0x1d2228, base: 0x555e67, light: 0x9fa9ad, accent: 0x7a8790, scale: 0.12, blockiness: 0.7 };
  }
}

function makeDecorRockMaterial(preset: MapGroundPreset, tag: string, shade = 1): THREE.ShaderMaterial {
  const p = decorRockPalette(preset);
  const seed = (hashTag(`${preset}:rock:${tag}`) % 997) / 997;
  const tint = (hex: number): THREE.Vector3 => {
    const c = new THREE.Color(hex).multiplyScalar(shade);
    return new THREE.Vector3(c.r, c.g, c.b);
  };
  return new THREE.ShaderMaterial({
    uniforms: {
      uDark: { value: tint(p.dark) },
      uBase: { value: tint(p.base) },
      uLight: { value: tint(p.light) },
      uAccent: { value: tint(p.accent) },
      uScale: { value: p.scale },
      uSeed: { value: seed },
      uBlockiness: { value: p.blockiness },
    },
    vertexShader: DECOR_ROCK_VERT,
    fragmentShader: DECOR_ROCK_FRAG,
    glslVersion: THREE.GLSL3,
  });
}

function structureDims(entry: StructureCatalogEntry | null): { w: number; h: number; d: number } {
  const H = unitMeshLinearSize("Titan");
  const S = STRUCTURE_MESH_VISUAL_SCALE;
  let w: number;
  let d: number;
  if (!entry) {
    w = 4.8;
    d = 4.8;
  } else {
    const signals = entry.signalTypes;
    const isBastion = signals.filter((s) => s === "Bastion").length >= 2;
    const isVanguard = signals.filter((s) => s === "Vanguard").length >= 1;
    const isReclaim = signals.filter((s) => s === "Reclaim").length >= 1;
    if (entry.producedSizeClass === "Titan") {
      w = 6.2;
      d = 6.2;
    } else if (entry.producedSizeClass === "Heavy" && isBastion) {
      w = 6.4;
      d = 6.4;
    } else if (entry.producedSizeClass === "Heavy") {
      w = 5.6;
      d = 5.6;
    } else if (isBastion) {
      w = 6.2;
      d = 6.2;
    } else if (isVanguard && isReclaim) {
      w = 5.1;
      d = 5.1;
    } else if (isVanguard) {
      w = 4.5;
      d = 4.5;
    } else if (isReclaim) {
      w = 5.2;
      d = 5.2;
    } else {
      w = 4.8;
      d = 4.8;
    }
  }
  return { w: w * S, h: H * S, d: d * S };
}

function hsl(hex: number, dl: number): THREE.Color {
  const c = new THREE.Color(hex);
  const h = { h: 0, s: 0, l: 0 };
  c.getHSL(h);
  c.setHSL(h.h, h.s, Math.max(0.05, Math.min(0.95, h.l + dl)));
  return c;
}

function matFor(color: number, roughness = 0.82, metalness = 0.08): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

/** Token chunkiness on top of `unitMeshLinearSize` so classes read distinct at a glance. */
function bipedBulkScale(size: UnitSizeClass): number {
  switch (size) {
    case "Swarm":
      return 0.82;
    case "Line":
      return 0.95;
    case "Heavy":
      return 1.12;
    case "Titan":
      return 1.38;
  }
}

/**
 * Strong per–size-class palette (user request), still nudged by signal + team so factions stay readable.
 */
function bipedUnitColor(size: UnitSizeClass, signal: SignalType | undefined, team: "player" | "enemy"): number {
  const basis = new THREE.Color(
    size === "Swarm"
      ? 0x3fd4c8
      : size === "Line"
        ? 0x9fe04a
        : size === "Heavy"
          ? 0xff8f2e
          : 0xad7dff,
  );
  basis.lerp(new THREE.Color(signalColorHex(signal)), 0.18);
  /** Strong team anchor so LOD / far-zoom placeholders never read as “all green”. */
  if (team === "player") basis.lerp(new THREE.Color(0x3a9dff), 0.55);
  else basis.lerp(new THREE.Color(0xff3358), 0.62);
  return basis.getHex();
}

/** Single merged fallback/LOD token: abstract game piece, not a mannequin. */
function buildBipedMergedGeometry(size: UnitSizeClass, L: number): THREE.BufferGeometry {
  const b = bipedBulkScale(size);
  const parts: THREE.BufferGeometry[] = [];

  const baseR = 0.18 * L * b;
  const baseH = 0.08 * L;
  const base = new THREE.CylinderGeometry(baseR * 1.2, baseR * 1.38, baseH, 12);
  base.translate(0, baseH * 0.5, 0);
  parts.push(base);

  const stemH = L * (size === "Swarm" ? 0.34 : size === "Line" ? 0.48 : size === "Heavy" ? 0.52 : 0.62);
  const stemR = baseR * (size === "Swarm" ? 0.52 : size === "Line" ? 0.66 : size === "Heavy" ? 0.86 : 1.02);
  const stem = new THREE.CylinderGeometry(stemR * 0.7, stemR, stemH, size === "Swarm" ? 5 : 6);
  stem.translate(0, baseH + stemH * 0.5, 0);
  parts.push(stem);

  const capH = L * (size === "Titan" ? 0.28 : 0.2);
  const cap = new THREE.ConeGeometry(stemR * (size === "Swarm" ? 1.0 : 1.16), capH, size === "Swarm" ? 5 : 6);
  cap.translate(0, baseH + stemH + capH * 0.5, 0);
  parts.push(cap);

  if (size === "Heavy" || size === "Titan") {
    const shoulder = new THREE.BoxGeometry(stemR * 2.15, baseH * 1.35, stemR * 1.15);
    shoulder.translate(0, baseH + stemH * 0.68, 0);
    parts.push(shoulder);
  }

  return mergeGeometries(parts, false);
}

/** Builds a reusable CanvasTexture-backed Sprite for floating world-space labels.
 *  Canvas is 256x72 at 2x DPR so text stays crisp when scaled to ~6 world units wide. */
interface LabelSprite {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  lastText: string;
  lastAccent: string;
}

function makeLabelSprite(initialText: string, accent = "#6ae1ff"): LabelSprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 144;
  const ctx = canvas.getContext("2d")!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 999;
  // 8 world units wide, ~2.25 tall keeps legibility without dwarfing pillars.
  sprite.scale.set(8, 2.25, 1);
  const ls: LabelSprite = { sprite, canvas, ctx, texture, lastText: "", lastAccent: "" };
  drawLabel(ls, initialText, accent);
  return ls;
}

function makeEnemyCoreTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(104, 88, 8, 128, 128, 132);
  grad.addColorStop(0, "#ff9a84");
  grad.addColorStop(0.18, "#8f1f20");
  grad.addColorStop(0.58, "#260b18");
  grad.addColorStop(1, "#060812");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const r0 = 18 + ((i * 37) % 31);
    const r1 = 95 + ((i * 19) % 42);
    ctx.strokeStyle = i % 3 === 0 ? "rgba(255,190,150,0.48)" : "rgba(255,74,72,0.28)";
    ctx.lineWidth = i % 3 === 0 ? 2.4 : 1.2;
    ctx.beginPath();
    ctx.moveTo(128 + Math.cos(a) * r0, 128 + Math.sin(a) * r0);
    ctx.bezierCurveTo(
      128 + Math.cos(a + 0.45) * 58,
      128 + Math.sin(a + 0.45) * 58,
      128 + Math.cos(a - 0.3) * 78,
      128 + Math.sin(a - 0.3) * 78,
      128 + Math.cos(a + 0.12) * r1,
      128 + Math.sin(a + 0.12) * r1,
    );
    ctx.stroke();
  }

  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = "rgba(0,0,0,0.42)";
  ctx.fillRect(0, 160, 256, 96);
  ctx.globalCompositeOperation = "source-over";

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 2;
  return tex;
}

function drawLabel(label: LabelSprite, text: string, accent: string): void {
  if (label.lastText === text && label.lastAccent === accent) return;
  label.lastText = text;
  label.lastAccent = accent;
  const { ctx, canvas } = label;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const r = 28;
  ctx.beginPath();
  ctx.moveTo(r, 8);
  ctx.lineTo(W - r, 8);
  ctx.quadraticCurveTo(W - 8, 8, W - 8, r + 8);
  ctx.lineTo(W - 8, H - r - 8);
  ctx.quadraticCurveTo(W - 8, H - 8, W - r, H - 8);
  ctx.lineTo(r, H - 8);
  ctx.quadraticCurveTo(8, H - 8, 8, H - r - 8);
  ctx.lineTo(8, r + 8);
  ctx.quadraticCurveTo(8, 8, r, 8);
  ctx.closePath();
  ctx.fillStyle = "rgba(6, 10, 18, 0.82)";
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = accent;
  ctx.stroke();
  ctx.font = "bold 54px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f4fbff";
  ctx.shadowColor = "rgba(0,0,0,0.9)";
  ctx.shadowBlur = 6;
  ctx.fillText(text, W / 2, H / 2 + 2);
  ctx.shadowBlur = 0;
  label.texture.needsUpdate = true;
}

function addVanguardSilhouette(
  root: THREE.Group,
  { w, h, d }: { w: number; h: number; d: number },
  color: number,
  accent: number,
): void {
  const baseH = h * 0.2;
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.95, baseH, d * 0.95),
    matFor(hsl(color, -0.12).getHex()),
  );
  base.position.y = baseH / 2;
  root.add(base);

  const towerH = h * 0.55;
  const tower = new THREE.Mesh(
    new THREE.CylinderGeometry(w * 0.22, w * 0.3, towerH, 8),
    matFor(color),
  );
  tower.position.y = baseH + towerH / 2;
  root.add(tower);

  const coneH = h * 0.3;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(w * 0.22, coneH, 8), matFor(accent, 0.55, 0.35));
  cone.position.y = baseH + towerH + coneH / 2;
  root.add(cone);

  for (const dir of [1, -1]) {
    const fin = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.08, towerH * 0.7, d * 0.45),
      matFor(hsl(color, -0.08).getHex()),
    );
    fin.position.set(dir * w * 0.32, baseH + towerH * 0.55, 0);
    root.add(fin);
  }
}

function addBastionSilhouette(
  root: THREE.Group,
  { w, h, d }: { w: number; h: number; d: number },
  color: number,
): void {
  const baseH = h * 0.55;
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, baseH, d), matFor(color));
  base.position.y = baseH / 2;
  root.add(base);

  const topH = h * 0.35;
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.7, topH, d * 0.7),
    matFor(hsl(color, 0.06).getHex()),
  );
  top.position.y = baseH + topH / 2;
  root.add(top);

  const crenel = w / 5;
  for (let i = 0; i < 4; i++) {
    const c = new THREE.Mesh(
      new THREE.BoxGeometry(crenel * 0.7, h * 0.12, d * 0.15),
      matFor(hsl(color, -0.1).getHex()),
    );
    c.position.set(-w / 2 + crenel * (i + 0.5), baseH - 0.02, d * 0.42);
    root.add(c);
    const c2 = c.clone();
    c2.position.z = -d * 0.42;
    root.add(c2);
  }
}

function addReclaimSilhouette(
  root: THREE.Group,
  { w, h }: { w: number; h: number; d: number },
  color: number,
  accent: number,
): void {
  const baseH = h * 0.35;
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(w * 0.48, w * 0.52, baseH, 10),
    matFor(hsl(color, -0.1).getHex()),
  );
  base.position.y = baseH / 2;
  root.add(base);

  const bulbH = h * 0.4;
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(w * 0.38, 16, 12), matFor(color, 0.7, 0.02));
  bulb.position.y = baseH + bulbH / 2;
  bulb.scale.set(1, 0.9, 1);
  root.add(bulb);

  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2;
    const stalk = new THREE.Mesh(
      new THREE.CylinderGeometry(w * 0.05, w * 0.08, h * 0.5, 6),
      matFor(hsl(color, 0.02).getHex()),
    );
    stalk.position.set(Math.cos(ang) * w * 0.32, baseH + h * 0.25, Math.sin(ang) * w * 0.32);
    stalk.rotation.z = Math.cos(ang) * 0.25;
    stalk.rotation.x = Math.sin(ang) * 0.25;
    root.add(stalk);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(w * 0.08, 8, 6), matFor(accent, 0.5, 0.3));
    tip.position.copy(stalk.position).setY(baseH + h * 0.5);
    root.add(tip);
  }
}

function buildStructureSilhouette(entry: StructureCatalogEntry, team: "player" | "enemy"): THREE.Group {
  const g = new THREE.Group();
  const silo = new THREE.Group();
  silo.name = "structure-silhouette";
  const dims = structureDims(entry);
  const signals = entry.signalTypes;
  const dom = dominantSignal(entry) ?? "Vanguard";
  const color = signalColorHex(dom);
  const accent = team === "enemy" ? 0xff6b6b : hsl(color, 0.2).getHex();

  const sCount = {
    Vanguard: signals.filter((s) => s === "Vanguard").length,
    Bastion: signals.filter((s) => s === "Bastion").length,
    Reclaim: signals.filter((s) => s === "Reclaim").length,
  };

  if (sCount.Bastion >= 2 || (sCount.Bastion >= 1 && sCount.Vanguard === 0 && sCount.Reclaim === 0)) {
    addBastionSilhouette(silo, dims, color);
  } else if (sCount.Vanguard >= 2 || (sCount.Vanguard >= 1 && sCount.Bastion === 0 && sCount.Reclaim === 0)) {
    addVanguardSilhouette(silo, dims, color, accent);
  } else if (sCount.Reclaim >= 2 || (sCount.Reclaim >= 1 && sCount.Vanguard === 0 && sCount.Bastion === 0)) {
    addReclaimSilhouette(silo, dims, color, accent);
  } else if (sCount.Vanguard && sCount.Bastion) {
    addBastionSilhouette(silo, { w: dims.w, h: dims.h * 0.6, d: dims.d }, color);
    const spire = new THREE.Mesh(
      new THREE.ConeGeometry(dims.w * 0.18, dims.h * 0.45, 8),
      matFor(accent, 0.55, 0.3),
    );
    spire.position.y = dims.h * 0.78;
    silo.add(spire);
  } else if (sCount.Reclaim && sCount.Bastion) {
    addBastionSilhouette(silo, { w: dims.w, h: dims.h * 0.6, d: dims.d }, color);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(dims.w * 0.3, 12, 8),
      matFor(accent, 0.6, 0.2),
    );
    bulb.position.y = dims.h * 0.82;
    silo.add(bulb);
  } else if (sCount.Vanguard && sCount.Reclaim) {
    addReclaimSilhouette(silo, { w: dims.w * 0.8, h: dims.h * 0.55, d: dims.d * 0.8 }, color, accent);
    const spike = new THREE.Mesh(
      new THREE.ConeGeometry(dims.w * 0.14, dims.h * 0.5, 8),
      matFor(signalColorHex("Vanguard"), 0.55, 0.25),
    );
    spike.position.y = dims.h * 0.72;
    silo.add(spike);
  } else {
    addVanguardSilhouette(silo, dims, color, accent);
  }

  g.add(silo);
  (g.userData as Record<string, unknown>)["structureSilhouette"] = silo;

  // GLB swap anchor (hidden once a tower model loads).
  const phMat = matFor(hsl(color, -0.35).getHex(), 0.92, 0.04);
  phMat.transparent = true;
  phMat.opacity = 0.04;
  const placeholder = new THREE.Mesh(
    new THREE.BoxGeometry(dims.w * 0.55, dims.h * 0.52, dims.d * 0.55),
    phMat,
  );
  placeholder.position.y = dims.h * 0.32;
  placeholder.castShadow = false;
  placeholder.userData["isPlaceholder"] = true;
  g.add(placeholder);
  (g.userData as Record<string, unknown>)["bodyMesh"] = placeholder;

  // Team plinth underneath for clarity.
  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(Math.max(dims.w, dims.d) * 0.65, Math.max(dims.w, dims.d) * 0.7, 0.18, 20),
    new THREE.MeshStandardMaterial({
      color: team === "player" ? 0x2a5c8a : 0x8a2a2a,
      roughness: 0.9,
      transparent: true,
      opacity: 0.9,
    }),
  );
  plinth.position.y = 0.09;
  plinth.receiveShadow = true;
  g.add(plinth);
  (g.userData as Record<string, unknown>)["plinthMesh"] = plinth;

  g.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });

  (g.userData as Record<string, unknown>)["dims"] = dims;
  return g;
}

function setStructureFallbackVisible(g: THREE.Group, visible: boolean): void {
  const ud = g.userData as Record<string, unknown>;
  const silhouette = ud["structureSilhouette"] as THREE.Object3D | undefined;
  const body = ud["bodyMesh"] as THREE.Object3D | undefined;
  const plinth = ud["plinthMesh"] as THREE.Object3D | undefined;
  if (silhouette) silhouette.visible = visible;
  if (body) body.visible = visible;
  if (plinth) plinth.visible = visible;
}

function buildUnitMesh(signal: SignalType | undefined, team: "player" | "enemy", size: UnitSizeClass): THREE.Group {
  const g = new THREE.Group();
  const L = unitMeshLinearSize(size);

  const color = bipedUnitColor(size, signal, team);
  const geom = buildBipedMergedGeometry(size, L);

  const rough =
    size === "Swarm" ? 0.58 : size === "Line" ? 0.66 : size === "Heavy" ? 0.72 : 0.68;
  const body = new THREE.Mesh(geom, matFor(color, rough, 0.08));
  body.castShadow = true;
  body.receiveShadow = true;
  body.userData["isPlaceholder"] = true;
  g.add(body);
  (g.userData as Record<string, unknown>)["bodyMesh"] = body;

  return g;
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private readonly ground: THREE.Mesh;
  private readonly groundOverlay: THREE.Mesh;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly sunLight: THREE.DirectionalLight;
  private groundVisualKey = "";
  private readonly root = new THREE.Group();
  private readonly markers = new THREE.Group();
  private readonly entities = new THREE.Group();
  private readonly decor = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private unitMeshes = new Map<number, THREE.Object3D>();
  private unitCountLabels = new Map<number, LabelSprite>();
  private structureMeshes = new Map<number, THREE.Object3D>();
  private tapMeshes = new Map<string, TapBandMeshes | ManaNodeGroundBand>();
  private tapYieldArcs = new Map<string, TapBandMeshes>();
  private tapClaimArcs = new Map<string, TapBandMeshes>();
  /** Destructible claim pillar on owned Mana nodes. */
  private tapAnchorRoots = new Map<string, THREE.Group>();
  private tapAnchorPrevHp = new Map<string, number>();
  /** Floating "Stand to claim" / "Depleted" label sprites keyed by tap defId. */
  private tapLabels = new Map<string, LabelSprite>();
  private manaNodeTextures: ManaNodeTextureSet | null = null;
  private manaSpinTexture: THREE.Texture | null = null;
  /** "Next node" highlight ring on the nearest unclaimed tap to the hero. */
  private nearestTapRing: TapBandMeshes | null = null;
  private territoryGroup = new THREE.Group();
  private territoryField: THREE.Mesh | null = null;
  private enemyTerritoryField: THREE.Mesh | null = null;
  private territoryTexture: THREE.CanvasTexture | null = null;
  private enemyTerritoryTexture: THREE.CanvasTexture | null = null;
  private territoryOutline: THREE.LineSegments | null = null;
  private enemyTerritoryOutline: THREE.LineSegments | null = null;
  /** Bumps when only territory *visual* style changes (fill texture, opacities); not derived from sim sources. */
  private static readonly TERRITORY_OVERLAY_STYLE = "v4";
  private territoryKey = `${GameRenderer.TERRITORY_OVERLAY_STYLE}|`;
  private enemyTerritoryKey = `${GameRenderer.TERRITORY_OVERLAY_STYLE}|`;
  private heroGroup: THREE.Group | null = null;
  private heroHpBarBg: THREE.Mesh | null = null;
  private heroHpBarFg: THREE.Mesh | null = null;
  private enemyHeroGroup: THREE.Group | null = null;
  private enemyHeroHpBarBg: THREE.Mesh | null = null;
  private enemyHeroHpBarFg: THREE.Mesh | null = null;
  private heroLocomotionPrev: { x: number; z: number; valid: boolean } = { x: 0, z: 0, valid: false };
  private enemyHeroLocomotionPrev: { x: number; z: number; valid: boolean } = { x: 0, z: 0, valid: false };
  private heroVisualPos: THREE.Vector2 | null = null;
  private enemyHeroVisualPos: THREE.Vector2 | null = null;
  /** Per enemy-relay (Dark Fortress) id → marker cylinder. */
  private relayMeshes = new Map<string, THREE.Mesh>();
  /** Wizard-Keep marker (violet ring + HP arc on the ground). */
  private keepRing: THREE.Mesh | null = null;
  private keepHpArc: THREE.Mesh | null = null;
  /** Per structure: hold-orders floating red cube. */
  private holdCubes = new Map<number, THREE.Mesh>();
  /** Per enemy camp id: HP orb. */
  private coreOrbs = new Map<string, THREE.Mesh>();
  /** Selected structure's blue halo + rally line + flag. */
  private selectHalo: THREE.Mesh | null = null;
  private attackRangeRing: THREE.Mesh | null = null;
  private auraRangeRing: THREE.Mesh | null = null;
  private rallyLine: THREE.Line | null = null;
  private rallyFlag: THREE.Mesh | null = null;
  /** Selected friendly troop — small halo + weapon range ring. */
  private unitSelHalo: THREE.Mesh | null = null;
  private unitMeleeRing: THREE.Mesh | null = null;
  private campAggroRings = new Map<string, THREE.Mesh>();
  private campWakeRings = new Map<string, THREE.Mesh>();
  private tacticsFieldRings = new Map<string, THREE.Mesh>();
  private portalRoots = new Map<"exit" | "return", { root: THREE.Group; label: LabelSprite }>();
  private decorBuilt = false;
  private readonly decorTextureCache = new Map<string, THREE.CanvasTexture>();

  private ghost: THREE.Mesh | null = null;
  private cmdGhost: THREE.Mesh | null = null;
  private cmdGhostCore: THREE.Mesh | null = null;
  /** Line-strip preview for aimed cleave spells (Cut Back). */
  private cmdGhostLine: THREE.Mesh | null = null;
  /** `"rings"` = procedural ring geometry; `"tex"` = textured ground plane for spell reticle PNGs. */
  private cmdGhostDiscKind: "rings" | "tex" = "rings";
  /** `"box"` = procedural corridor; `"tex"` = textured plane along the cleave corridor. */
  private cmdGhostLineKind: "box" | "tex" = "box";
  private cmdGhostRingMaterial: THREE.MeshBasicMaterial | null = null;
  private cmdGhostDiscTexMaterial: THREE.MeshBasicMaterial | null = null;
  private cmdGhostLineTexMaterial: THREE.MeshBasicMaterial | null = null;
  private cmdGhostLineBoxMaterial: THREE.MeshBasicMaterial | null = null;
  private readonly spellReticleTextures: Partial<Record<SpellReticleEffectType, THREE.Texture>> = {};
  private formationGhostLine: THREE.Mesh | null = null;
  private formationGhostSlots: THREE.InstancedMesh | null = null;
  private readonly controls: OrbitControls;
  private readonly clock = new THREE.Clock();
  /** Animation/render delta must not use `clock.getDelta()` because sync code calls `getElapsedTime()` for pulses. */
  private lastRenderFrameMs = performance.now();
  /** Visual interpolation delta for sync-time smoothing. */
  private lastSyncFrameMs = performance.now();
  private visualSyncDt = 1 / 60;
  /** Scratch: camera-relative WASD on the XZ plane (world up). */
  private readonly camGroundFwd = new THREE.Vector3();
  private readonly camGroundRight = new THREE.Vector3();
  private readonly fx: FxHost;
  private lastSiegeTick = -1;
  private currentState: GameState | null = null;
  /** Loaded match equirect; disposed in `dispose()`. */
  private matchSkyboxTexture: THREE.Texture | null = null;
  private matchSkyboxPlacement = readMatchSkyboxPlacement();
  private rendererDisposed = false;
  private worldPlaneHalf = 0;
  private terrainSlab: THREE.Group | null = null;
  /** Imported terrain (GLB); raycast targets for `pickGround` when present. */
  private terrainRoot: THREE.Group | null = null;
  private terrainHits: THREE.Object3D[] = [];
  private terrainSource: string | null = null;
  private readonly unitPrevHp = new Map<number, number>();
  private readonly unitPrevAttackTick = new Map<number, number>();
  private readonly unitPrevPos = new Map<number, THREE.Vector2>();
  private readonly unitVisualPos = new Map<number, THREE.Vector2>();
  private readonly unitMotionVisuals = new Map<number, UnitMotionVisual>();
  /** Target chosen on the committed attack tick; cleared when recovery ends so units do not chase stale targets. */
  private readonly unitFaceTargets = new Map<number, Vec2>();
  private readonly unitLodState = new Map<number, { placeholder: boolean; farCullUi: boolean; nextAllowedMs: number }>();
  private readonly dyingUnits: { obj: THREE.Object3D; timer: number; life: number; particles: THREE.Mesh[] }[] = [];
  private readonly structurePrevHp = new Map<number, number>();
  private readonly relayPrevHp = new Map<string, number>();
  /** Seconds of forward lunge after a wizard strike FX. */
  private heroLungeTimer = 0;
  /** When true, orbit pivot eases toward the player wizard each frame; when false, MMB orbit stays put. */
  private cameraFollowHero = true;
  private cameraFollowUnitId: number | null = null;
  private cameraFramedState: GameState | null = null;
  private cameraFollowReleaseArmed = false;
  private readonly cameraFollowReleaseTarget = new THREE.Vector3();
  private lastCameraLimitsHalf = 0;

  /** `performance.now()` when intro began; null = idle. */
  private introCinematicStartMs: number | null = null;
  private readonly introStartPos = new THREE.Vector3();
  private readonly introStartTgt = new THREE.Vector3();
  private readonly introEndPos = new THREE.Vector3();
  private readonly introEndTgt = new THREE.Vector3();
  private introOrbitStartAngle = 0;
  /** Orbit / pan allowed (e.g. false while dragging a doctrine card). */
  private controlsUserDesiredEnabled = true;

  /** Rigid translate: preserves camera↔target offset (OrbitControls distance = zoom). */
  private nudgeCameraRigTowardFollowPivot(dt: number): void {
    if (this.introCinematicStartMs !== null) return;
    const state = this.currentState;
    if (!state || state.phase !== "playing") return;
    const unit =
      this.cameraFollowUnitId !== null ? state.units.find((u) => u.id === this.cameraFollowUnitId && u.hp > 0) : null;
    if (this.cameraFollowUnitId !== null && !unit) this.cameraFollowUnitId = null;
    const followed = unit ?? (this.cameraFollowHero ? state.hero : null);
    if (!followed) return;
    const t = this.controls.target;
    const visualUnit = unit ? this.unitVisualPos.get(unit.id) : null;
    const visualHero = !unit && this.cameraFollowHero ? this.heroVisualPos : null;
    const desiredX = visualUnit?.x ?? visualHero?.x ?? followed.x;
    const desiredY = unit ? Math.max(1.0, unitMeshLinearSize(unit.sizeClass) * 0.8) : CAMERA_HERO_PIVOT_Y;
    const desiredZ = visualUnit?.y ?? visualHero?.y ?? followed.z;
    const alpha = 1 - Math.exp(-CAMERA_HERO_FOLLOW_LAMBDA * dt);
    const dx = (desiredX - t.x) * alpha;
    const dy = (desiredY - t.y) * alpha;
    const dz = (desiredZ - t.z) * alpha;
    if (dx * dx + dy * dy + dz * dz < 1e-14) return;
    t.x += dx;
    t.y += dy;
    t.z += dz;
    this.camera.position.x += dx;
    this.camera.position.y += dy;
    this.camera.position.z += dz;
  }

  constructor(canvas: HTMLCanvasElement, controlProfile: ControlProfile = getControlProfile()) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
    });
    /** Cap DPR for 120Hz and mobile fill-rate budgets. */
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, controlProfile.maxPixelRatio));
    this.renderer.shadowMap.enabled = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x10131a);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 2600);
    this.camera.position.set(82, 96, 82);
    this.camera.lookAt(0, 4, 0);

    this.scene.add(new THREE.AmbientLight(0xcfd9ff, 0.38));
    this.hemiLight = new THREE.HemisphereLight(0x9eb7ff, 0x1a1e28, 0.35);
    this.scene.add(this.hemiLight);
    this.sunLight = new THREE.DirectionalLight(0xfff4e6, 1.05);
    this.sunLight.position.set(-55, 110, 40);
    this.sunLight.castShadow = false;
    this.scene.add(this.sunLight);

    const groundMat = new THREE.MeshBasicMaterial({ color: 0x343941 });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = false;
    this.scene.add(this.ground);
    this.groundOverlay = new THREE.Mesh(
      new THREE.PlaneGeometry(240, 240),
      new THREE.MeshBasicMaterial({
        map: makeGroundOverlayTexture("solid"),
        transparent: true,
        opacity: 0.07,
        depthWrite: false,
        blending: THREE.NormalBlending,
      }),
    );
    this.groundOverlay.rotation.x = -Math.PI / 2;
    this.groundOverlay.position.y = 0.018;
    this.groundOverlay.visible = false;

    this.territoryGroup.name = "territory";
    /** Floor decal only: lives on `scene` (not `root`) so opaque decor/units fill the depth buffer first; tint uses polygon offset so vertical meshes win Z-tests. */
    this.scene.add(this.territoryGroup);
    this.root.add(this.decor, this.markers, this.entities);
    this.scene.add(this.root);

    if (MATCH_SKYBOX_ENABLED) void this._loadMatchSkybox();

    this.fx = createFxHost(this.scene);

    const manaLoader = new THREE.TextureLoader();
    void Promise.all([loadManaNodeTextures(manaLoader), loadManaNodeSpinTexture(manaLoader)])
      .then(([nodeSet, spin]) => {
        this.manaNodeTextures = nodeSet;
        this.manaSpinTexture = spin;
      })
      .catch((e) => {
        console.warn("[mana nodes] decal texture load failed — fallback rings", e);
      });

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 34;
    this.controls.maxDistance = 280;
    /** Keep the lens low — more horizon, less RTS “map cam”. */
    this.controls.maxPolarAngle = Math.PI / 2 - 0.06;
    this.controls.minPolarAngle = 0.82;
    this.controls.zoomSpeed = 0.82;
    this.controls.rotateSpeed = 0.36;
    this.controls.panSpeed = 0.92;
    this.controls.enableRotate = true;
    this.controls.enablePan = true;
    // LMB/RMB stay with the game; middle = pan the rig. Shift+MMB = orbit (OrbitControls default for PAN+modifier).
    (this.controls as unknown as { mouseButtons: { LEFT: number; MIDDLE: number; RIGHT: number } }).mouseButtons = {
      LEFT: -1,
      MIDDLE: MOUSE.PAN,
      RIGHT: -1,
    };
    this.controls.addEventListener("change", () => this.releaseCameraFollowIfUserPanned());
  }

  /** Drop all cast FX (lightning, rings, etc.) — call on rematch so bolts never linger. */
  clearCastFx(): void {
    clearFx(this.fx);
  }

  getMatchSkyboxPlacement(): MatchSkyboxPlacement {
    return { ...this.matchSkyboxPlacement };
  }

  setMatchSkyboxPlacement(next: Partial<MatchSkyboxPlacement>, persist = true): MatchSkyboxPlacement {
    this.matchSkyboxPlacement = {
      x: Number.isFinite(next.x) ? next.x! : this.matchSkyboxPlacement.x,
      y: Number.isFinite(next.y) ? next.y! : this.matchSkyboxPlacement.y,
      z: Number.isFinite(next.z) ? next.z! : this.matchSkyboxPlacement.z,
    };
    if (persist) writeMatchSkyboxPlacement(this.matchSkyboxPlacement);
    return this.getMatchSkyboxPlacement();
  }

  resetMatchSkyboxPlacement(): MatchSkyboxPlacement {
    this.matchSkyboxPlacement = { ...DEFAULT_MATCH_SKYBOX_PLACEMENT };
    writeMatchSkyboxPlacement(this.matchSkyboxPlacement);
    return this.getMatchSkyboxPlacement();
  }

  dispose(): void {
    this.rendererDisposed = true;
    this.heroLocomotionPrev = { x: 0, z: 0, valid: false };
    this.enemyHeroLocomotionPrev = { x: 0, z: 0, valid: false };
    this.heroVisualPos = null;
    this.enemyHeroVisualPos = null;
    if (this.matchSkyboxTexture) {
      this.matchSkyboxTexture.dispose();
      this.matchSkyboxTexture = null;
    }
    this.scene.background = new THREE.Color(0x10131a);
    this.scene.backgroundRotation.set(0, 0, 0);
    this.scene.backgroundBlurriness = 0;
    this.scene.backgroundIntensity = 1;
    clearFx(this.fx);
    this.controls.dispose();
    this.disposeTerritoryTeam("player");
    this.disposeTerritoryTeam("enemy");
    this.scene.remove(this.territoryGroup);
    this.disposeObject(this.root);
    if (this.terrainRoot) this.disposeObject(this.terrainRoot);
    if (this.terrainSlab) {
      this.scene.remove(this.terrainSlab);
      this.disposeObject(this.terrainSlab);
      this.terrainSlab = null;
    }
    this.ground.geometry.dispose();
    const groundMat = this.ground.material;
    if (Array.isArray(groundMat)) groundMat.forEach((m) => m.dispose());
    else groundMat.dispose();
    this.groundOverlay.geometry.dispose();
    const overlayMat = this.groundOverlay.material;
    if (Array.isArray(overlayMat)) overlayMat.forEach((m) => m.dispose());
    else overlayMat.dispose();
    for (const tex of this.decorTextureCache.values()) tex.dispose();
    this.decorTextureCache.clear();
    this.disposeSpellReticleResources();
    if (this.cmdGhostRingMaterial) {
      this.cmdGhostRingMaterial.dispose();
      this.cmdGhostRingMaterial = null;
    }
    if (this.cmdGhostLineBoxMaterial) {
      this.cmdGhostLineBoxMaterial.dispose();
      this.cmdGhostLineBoxMaterial = null;
    }
    this.renderer.dispose();
  }

  private disposeSpellReticleResources(): void {
    if (this.cmdGhostDiscTexMaterial) {
      this.cmdGhostDiscTexMaterial.map = null;
      this.cmdGhostDiscTexMaterial.dispose();
      this.cmdGhostDiscTexMaterial = null;
    }
    if (this.cmdGhostLineTexMaterial) {
      this.cmdGhostLineTexMaterial.map = null;
      this.cmdGhostLineTexMaterial.dispose();
      this.cmdGhostLineTexMaterial = null;
    }
    for (const key of SPELL_RETICLE_EFFECT_TYPES) {
      const tex = this.spellReticleTextures[key];
      if (tex) {
        tex.dispose();
        delete this.spellReticleTextures[key];
      }
    }
  }

  setSize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    const aspect = w / Math.max(1, h);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  setControlsEnabled(enabled: boolean): void {
    this.controlsUserDesiredEnabled = enabled;
    this.refreshControlsEnabledFromIntro();
  }

  private refreshControlsEnabledFromIntro(): void {
    this.controls.enabled = this.controlsUserDesiredEnabled && this.introCinematicStartMs === null;
  }

  rotateCameraByPixels(dx: number, dy: number): void {
    const target = this.controls.target;
    const off = this.camera.position.clone().sub(target);
    const sph = new THREE.Spherical().setFromVector3(off);
    sph.theta -= dx * 0.006;
    sph.phi = Math.max(this.controls.minPolarAngle, Math.min(this.controls.maxPolarAngle, sph.phi - dy * 0.004));
    off.setFromSpherical(sph);
    this.camera.position.copy(target).add(off);
    this.camera.lookAt(target);
    this.controls.update();
  }

  /**
   * Normalized XZ basis for camera-relative WASD: **W/S** = along the camera view direction flattened
   * onto the ground; **A/D** = strafe (right-hand rule with world +Y). Matches typical third-person controls.
   */
  getCameraGroundMoveBasis(): { fx: number; fz: number; rx: number; rz: number } {
    this.camera.updateMatrixWorld(true);
    this.camera.getWorldDirection(this.camGroundFwd);
    this.camGroundFwd.y = 0;
    let len = this.camGroundFwd.length();
    if (len < 1e-5) {
      const st = this.currentState;
      if (st?.phase === "playing") {
        const face = st.hero.facing;
        this.camGroundFwd.set(Math.sin(face), 0, Math.cos(face));
      } else {
        this.camGroundFwd.set(0, 0, 1);
      }
      len = 1;
    } else {
      this.camGroundFwd.multiplyScalar(1 / len);
    }
    const fx = this.camGroundFwd.x;
    const fz = this.camGroundFwd.z;
    this.camGroundRight.crossVectors(this.camGroundFwd, this.camera.up).normalize();
    this.camGroundRight.y = 0;
    if (this.camGroundRight.lengthSq() < 1e-8) {
      this.camGroundRight.set(fz, 0, -fx);
    } else {
      this.camGroundRight.normalize();
    }
    return { fx, fz, rx: this.camGroundRight.x, rz: this.camGroundRight.z };
  }

  panCameraOnGround(strafe: number, forward: number, dt: number): void {
    const sx = Math.max(-1, Math.min(1, strafe));
    const fwd = Math.max(-1, Math.min(1, forward));
    if (sx === 0 && fwd === 0) return;
    const { fx, fz, rx, rz } = this.getCameraGroundMoveBasis();
    let dx = fwd * fx + sx * rx;
    let dz = fwd * fz + sx * rz;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    dx /= len;
    dz /= len;
    const distance = this.camera.position.distanceTo(this.controls.target);
    const speed = Math.max(24, Math.min(180, distance * 1.18));
    const rawX = dx * speed * Math.max(0, dt);
    const rawZ = dz * speed * Math.max(0, dt);
    const half = this.currentState?.map.world.halfExtents ?? this.worldPlaneHalf;
    const target = this.controls.target;
    const nextX = Math.max(-half, Math.min(half, target.x + rawX));
    const nextZ = Math.max(-half, Math.min(half, target.z + rawZ));
    const moveX = nextX - target.x;
    const moveZ = nextZ - target.z;
    if (Math.abs(moveX) + Math.abs(moveZ) < 1e-6) return;
    this.cameraFollowHero = false;
    this.cameraFollowUnitId = null;
    target.x += moveX;
    target.z += moveZ;
    this.camera.position.x += moveX;
    this.camera.position.z += moveZ;
    this.controls.update();
  }

  getCameraFollowHero(): boolean {
    return this.cameraFollowHero;
  }

  releaseCameraFollowLock(): boolean {
    return false;
  }

  releaseCameraFollowLockNow(): boolean {
    const wasLocked = this.cameraFollowHero || this.cameraFollowUnitId !== null;
    this.cameraFollowReleaseArmed = false;
    this.cameraFollowHero = false;
    this.cameraFollowUnitId = null;
    return wasLocked;
  }

  private releaseCameraFollowIfUserPanned(): void {
    if (!this.cameraFollowReleaseArmed) return;
    if (!this.cameraFollowHero && this.cameraFollowUnitId === null) {
      this.cameraFollowReleaseArmed = false;
      return;
    }
    if (this.controls.target.distanceToSquared(this.cameraFollowReleaseTarget) < 0.01) return;
    this.cameraFollowReleaseArmed = false;
    this.cameraFollowHero = false;
    this.cameraFollowUnitId = null;
  }

  isMatchIntroActive(): boolean {
    return this.introCinematicStartMs !== null;
  }

  /** Snap orbit pivot to the player wizard (used when re-enabling follow mode). */
  setCameraFollowHero(follow: boolean): void {
    this.cameraFollowHero = follow;
    if (follow) this.cameraFollowUnitId = null;
    if (follow && this.introCinematicStartMs === null) this.snapCameraPivotToPlayerHero();
  }

  /** @returns new follow state */
  toggleCameraFollowHero(): boolean {
    this.cameraFollowHero = !this.cameraFollowHero;
    if (this.cameraFollowHero) {
      this.cameraFollowUnitId = null;
      this.snapCameraPivotToPlayerHero();
    }
    return this.cameraFollowHero;
  }

  zoomCameraToSelectedUnit(): boolean {
    const st = this.currentState;
    if (!st || st.phase !== "playing") return false;
    const selectedUnitId = st.selectedUnitIds.find((id) => id !== HERO_SELECTION_ID) ?? st.selectedUnitId;
    const u = selectedUnitId != null ? st.units.find((x) => x.id === selectedUnitId && x.team === "player" && x.hp > 0) : null;
    if (!u) {
      if (!st.selectedUnitIds.includes(HERO_SELECTION_ID) || st.hero.hp <= 0) return false;
      this.cameraFollowHero = true;
      this.cameraFollowUnitId = null;
      this.controls.minDistance = Math.min(this.controls.minDistance, 8);
      this.controls.target.set(st.hero.x, CAMERA_HERO_PIVOT_Y, st.hero.z);
      this.camera.position.set(st.hero.x - 10, CAMERA_HERO_PIVOT_Y + 7, st.hero.z - 10);
      this.controls.update();
      return true;
    }
    const enemy = st.map.enemyStart ?? st.enemyHero;
    let dx = enemy.x - u.x;
    let dz = enemy.z - u.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const size = unitMeshLinearSize(u.sizeClass);
    const targetY = Math.max(1.0, size * 0.8);
    const back = Math.max(9, size * 4.2);
    const height = Math.max(5.5, size * 2.4);
    this.cameraFollowHero = false;
    this.cameraFollowUnitId = u.id;
    this.controls.minDistance = Math.min(this.controls.minDistance, 8);
    this.controls.target.set(u.x + dx * size * 0.8, targetY, u.z + dz * size * 0.8);
    this.camera.position.set(u.x - dx * back, targetY + height, u.z - dz * back);
    this.controls.update();
    return true;
  }

  /** Snap pivot to hero in one frame without changing camera–target distance (zoom unchanged). */
  private snapCameraPivotToPlayerHero(): void {
    const st = this.currentState;
    if (!st || st.phase !== "playing") return;
    const h = st.hero;
    const t = this.controls.target;
    const nx = h.x;
    const ny = CAMERA_HERO_PIVOT_Y;
    const nz = h.z;
    const dx = nx - t.x;
    const dy = ny - t.y;
    const dz = nz - t.z;
    t.set(nx, ny, nz);
    this.camera.position.x += dx;
    this.camera.position.y += dy;
    this.camera.position.z += dz;
    this.controls.update();
  }

  private syncCameraLimits(half: number): void {
    if (half === this.lastCameraLimitsHalf) return;
    this.lastCameraLimitsHalf = half;
    this.controls.minDistance = Math.max(28, half * 0.055);
    this.controls.maxDistance = Math.min(1500, Math.max(260, half * 2.35));
    this.camera.far = Math.max(2200, half * 6.2);
    this.camera.updateProjectionMatrix();
  }

  private getHeroIntroEndCameraRig(state: GameState): { pos: THREE.Vector3; tgt: THREE.Vector3 } {
    const h = state.hero;
    const enemy = state.map.enemyStart ?? state.enemyHero;
    let dx = enemy.x - h.x;
    let dz = enemy.z - h.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const half = state.map.world.halfExtents;
    const targetY = CAMERA_HERO_PIVOT_Y;
    const back = Math.max(18, Math.min(34, half * 0.09));
    const height = Math.max(26, Math.min(46, half * 0.13));
    const tgt = new THREE.Vector3(h.x, targetY, h.z);
    const pos = new THREE.Vector3(h.x - dx * back, targetY + height, h.z - dz * back);
    return { pos, tgt };
  }

  /** High map orbit, then continuous landing over the player hero. */
  private startMatchIntroCinematic(state: GameState): void {
    const { pos: endPos, tgt: endTgt } = this.getHeroIntroEndCameraRig(state);
    this.introEndPos.copy(endPos);
    this.introEndTgt.copy(endTgt);
    const half = state.map.world.halfExtents;
    const H = Math.max(half * 2.1, 210);
    this.introStartTgt.set(0, 0, 0);
    this.introStartPos.set(0, H, 0);
    this.introOrbitStartAngle = Math.atan2(endPos.z - endTgt.z, endPos.x - endTgt.x) - Math.PI * 2.15;
    this.controls.target.copy(this.introStartTgt);
    this.camera.position.copy(this.introStartPos);
    this.camera.lookAt(this.introStartTgt);
    this.controls.update();
    this.introCinematicStartMs = performance.now();
    this.refreshControlsEnabledFromIntro();
    this.cameraFollowHero = false;
    this.cameraFollowUnitId = null;
    this.cameraFramedState = state;
  }

  private frameCameraImmediatelyOnHero(state: GameState): void {
    const { pos, tgt } = this.getHeroIntroEndCameraRig(state);
    this.controls.target.copy(tgt);
    this.camera.position.copy(pos);
    this.camera.lookAt(tgt);
    this.controls.update();
    this.introCinematicStartMs = null;
    this.cameraFollowHero = true;
    this.cameraFollowUnitId = null;
    this.cameraFramedState = state;
    this.refreshControlsEnabledFromIntro();
  }

  private tickMatchIntroCinematic(): void {
    if (this.introCinematicStartMs === null) return;
    const state = this.cameraFramedState;
    if (!state) return;
    const elapsed = (performance.now() - this.introCinematicStartMs) / 1000;
    const u = Math.max(0, Math.min(1, elapsed / MATCH_INTRO_CAMERA_SEC));
    const half = state.map.world.halfExtents;
    const endRadius = Math.hypot(this.introEndPos.x - this.introEndTgt.x, this.introEndPos.z - this.introEndTgt.z);
    const mapRadius = Math.max(half * 0.95, 110);
    const settle = Math.max(0, Math.min(1, (u - 0.64) / 0.36));
    const settleEase = 1 - Math.pow(1 - settle, 3);
    const heroPull = Math.max(0, Math.min(1, (u - 0.42) / 0.58));
    const heroEase = heroPull * heroPull;
    this.controls.target.copy(this.introStartTgt).lerp(this.introEndTgt, heroEase);

    const angle = this.introOrbitStartAngle + u * Math.PI * 2.15;
    const radius = mapRadius + (endRadius - mapRadius) * settleEase;
    const highY = Math.max(half * 1.15, 125);
    const midY = Math.max(half * 0.62, 72);
    const flyY = highY + (midY - highY) * Math.min(1, u * 1.35);
    const y = flyY + (this.introEndPos.y - flyY) * settleEase;
    this.camera.position.set(
      this.controls.target.x + Math.cos(angle) * radius,
      y,
      this.controls.target.z + Math.sin(angle) * radius,
    );
    if (settleEase > 0) this.camera.position.lerp(this.introEndPos, settleEase * settleEase);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    if (u >= 1) {
      this.controls.target.copy(this.introEndTgt);
      this.camera.position.copy(this.introEndPos);
      this.controls.update();
      this.introCinematicStartMs = null;
      this.cameraFollowHero = true;
      this.cameraFollowUnitId = null;
      this.refreshControlsEnabledFromIntro();
    }
  }

  pickGround(clientX: number, clientY: number, rect: DOMRect): { x: number; z: number } | null {
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
    this.ndc.set(x, y);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    if (this.terrainHits.length > 0) {
      const hits = this.raycaster.intersectObjects(this.terrainHits, false);
      const p = hits[0]?.point;
      if (p) return { x: p.x, z: p.z };
    }
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.plane, hit)) return null;
    return { x: hit.x, z: hit.z };
  }

  /** First unit mesh hit by screen ray (for selection); null if none. */
  pickUnitId(clientX: number, clientY: number, rect: DOMRect): number | null {
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
    this.ndc.set(x, y);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    if (this.unitMeshes.size === 0) return null;
    const hits = this.raycaster.intersectObjects([...this.unitMeshes.values()], true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o) {
        const uid = o.userData["unitId"] as number | undefined;
        if (uid !== undefined) return uid;
        o = o.parent;
      }
    }
    return null;
  }

  pickUnitIdsInScreenRect(a: { x: number; y: number }, b: { x: number; y: number }, rect: DOMRect): number[] {
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    const ids: number[] = [];
    const st = this.currentState;
    if (!st) return ids;
    if (st.hero.hp > 0) {
      const hp = new THREE.Vector3(st.hero.x, 1.6, st.hero.z).project(this.camera);
      const hsx = rect.left + ((hp.x + 1) / 2) * rect.width;
      const hsy = rect.top + ((1 - hp.y) / 2) * rect.height;
      if (hsx >= minX && hsx <= maxX && hsy >= minY && hsy <= maxY) ids.push(HERO_SELECTION_ID);
    }
    for (const u of st.units) {
      if (u.team !== "player" || u.hp <= 0) continue;
      const p = new THREE.Vector3(u.x, 1.2, u.z).project(this.camera);
      const sx = rect.left + ((p.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - p.y) / 2) * rect.height;
      if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) ids.push(u.id);
    }
    return ids;
  }

  /** Remove custom terrain and show the default ground plane again. */
  clearTerrain(): void {
    if (this.terrainRoot) {
      this.terrainRoot.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry?.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
        else (mat as THREE.Material | undefined)?.dispose?.();
      });
      this.scene.remove(this.terrainRoot);
      this.terrainRoot = null;
    }
    this.terrainHits = [];
    this.terrainSource = null;
    this.ground.visible = true;
  }

  /** Load GLB/GLTF terrain from `map.terrainGlbUrl` (site-root path). */
  async loadTerrainFromMap(map: { terrainGlbUrl?: string }): Promise<void> {
    const url = map.terrainGlbUrl?.trim();
    if (!url) {
      this.clearTerrain();
      return;
    }
    if (url === this.terrainSource && this.terrainRoot) return;

    this.clearTerrain();
    this.terrainSource = url;
    const loader = new GLTFLoader();
    try {
      const gltf = await loader.loadAsync(url);
      const root = new THREE.Group();
      root.name = "terrain_import";
      root.add(gltf.scene);
      root.updateMatrixWorld(true);
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
          this.terrainHits.push(m);
        }
      });
      this.terrainRoot = root;
      this.scene.add(root);
      this.ground.visible = false;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Failed to load terrain GLB:", url, e);
      this.clearTerrain();
    }
  }

  sync(state: GameState, useGlb: boolean): void {
    const syncNow = performance.now();
    this.visualSyncDt = Math.min(RENDER_VISUAL_DT_CAP_SEC, Math.max(0, (syncNow - this.lastSyncFrameMs) / 1000));
    this.lastSyncFrameMs = syncNow;
    this.currentState = state;
    this.useGlb = useGlb;
    this.syncWorldPlane(state);
    this.syncTerrainSlab(state);
    this.syncCameraLimits(state.map.world.halfExtents);
    if (this.cameraFramedState !== state) {
      if (state.portal.enteredViaPortal) this.frameCameraImmediatelyOnHero(state);
      else this.startMatchIntroCinematic(state);
    }
    this.applyMapVisual(state);
    this.syncMapDecor(state);
    this.syncTerritory(state);
    this.syncMarkers(state);
    this.syncKeepMarker(state);
    this.syncStructures(state);
    this.syncUnits(state);
    this.syncHero(state);
    this.syncEnemyHero(state);
    this.syncHoldCubes(state);
    this.syncSelectionAndRally(state);
    this.syncCoreOrbs(state);
    this.syncPortals(state);
    this.consumeCastEvents(state);
  }

  private useGlb = false;

  private consumeCastEvents(state: GameState): void {
    const q = state.fxQueue;
    if (q.length > 0) {
      for (const fxEvt of q) {
        const boltFrom =
          fxEvt.fromX !== undefined && fxEvt.fromZ !== undefined
            ? { from: { x: fxEvt.fromX, z: fxEvt.fromZ } }
            : undefined;
        spawnCastFx(this.fx, fxEvt.kind, { x: fxEvt.x, z: fxEvt.z }, {
          ...boltFrom,
          strikeVariant: fxEvt.strikeVariant,
          impactRadius: fxEvt.impactRadius,
          rangeBand: fxEvt.rangeBand,
          element: fxEvt.element,
          secondaryElement: fxEvt.secondaryElement,
          shape: fxEvt.shape,
          reach: fxEvt.reach,
          width: fxEvt.width,
          visualSeed: fxEvt.visualSeed,
        });
        if (fxEvt.kind === "hero_strike") {
          this.heroLungeTimer = 0.32;
          if (fxEvt.strikeVariant?.startsWith("player_") && this.heroGroup) this.playGlbAttackAnimation(this.heroGroup);
          else if (fxEvt.strikeVariant?.startsWith("rival_") && this.enemyHeroGroup) {
            this.playGlbAttackAnimation(this.enemyHeroGroup);
          }
        }
      }
      q.length = 0;
    }
    const siege = state.lastSiegeHit;
    if (siege && siege.tick !== this.lastSiegeTick) {
      spawnSiegeTell(this.fx, { x: siege.x, z: siege.z });
      this.lastSiegeTick = siege.tick;
    }
    const marks = state.combatHitMarks;
    if (marks.length > 0) {
      for (const m of marks) {
        spawnCombatHitMark(this.fx, m);
      }
      marks.length = 0;
    }
  }

  setPlacementGhost(pos: { x: number; z: number } | null, valid: boolean): void {
    if (!pos) {
      if (this.ghost) this.ghost.visible = false;
      return;
    }
    if (!this.ghost) {
      const r = 2.6 * STRUCTURE_MESH_VISUAL_SCALE;
      const geo = new THREE.CylinderGeometry(r, r, 0.3, 24);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x57a8ff,
        roughness: 0.8,
        metalness: 0.05,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.ghost = new THREE.Mesh(geo, mat);
      this.ghost.position.y = 0.2;
      this.scene.add(this.ghost);
    }
    this.ghost.visible = true;
    this.ghost.position.set(pos.x, 0.2, pos.z);
    const mat = this.ghost.material as THREE.MeshStandardMaterial;
    mat.color.set(valid ? 0x57a8ff : 0xf26464);
  }

  private ensureCmdGhostRingMaterial(): THREE.MeshBasicMaterial {
    if (!this.cmdGhostRingMaterial) {
      this.cmdGhostRingMaterial = new THREE.MeshBasicMaterial({
        color: 0xd87bff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
    }
    return this.cmdGhostRingMaterial;
  }

  private ensureCmdGhostLineBoxMaterial(): THREE.MeshBasicMaterial {
    if (!this.cmdGhostLineBoxMaterial) {
      this.cmdGhostLineBoxMaterial = new THREE.MeshBasicMaterial({
        color: 0xc8ffe8,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
    }
    return this.cmdGhostLineBoxMaterial;
  }

  private ensureCmdGhostDiscTexMaterial(tex: THREE.Texture): THREE.MeshBasicMaterial {
    if (!this.cmdGhostDiscTexMaterial) {
      this.cmdGhostDiscTexMaterial = new THREE.MeshBasicMaterial({
        map: tex,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
    } else {
      this.cmdGhostDiscTexMaterial.map = tex;
      this.cmdGhostDiscTexMaterial.needsUpdate = true;
    }
    return this.cmdGhostDiscTexMaterial;
  }

  private ensureCmdGhostLineTexMaterial(tex: THREE.Texture): THREE.MeshBasicMaterial {
    if (!this.cmdGhostLineTexMaterial) {
      this.cmdGhostLineTexMaterial = new THREE.MeshBasicMaterial({
        map: tex,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
    } else {
      this.cmdGhostLineTexMaterial.map = tex;
      this.cmdGhostLineTexMaterial.needsUpdate = true;
    }
    return this.cmdGhostLineTexMaterial;
  }

  /**
   * Ground ring + inner dot shown while dragging a command card so the player
   * can see where the spell will land (and, when relevant, the effect radius).
   * Pass `radius = null` for point-target commands; a small marker is drawn.
   * When `line` is set, `pos` is the aim point and a corridor from `line.from*` toward `pos` is shown.
   * When `spellEffectType` matches a shipped spell reticle and its PNG has loaded, a textured decal is used instead of procedural rings/box.
   */
  setCommandGhost(
    pos: { x: number; z: number } | null,
    radius: number | null,
    valid: boolean,
    line?: { fromX: number; fromZ: number; length: number; halfWidth: number } | null,
    spellEffectType?: CommandEffect["type"] | null,
  ): void {
    if (!pos) {
      if (this.cmdGhost) this.cmdGhost.visible = false;
      if (this.cmdGhostCore) this.cmdGhostCore.visible = false;
      if (this.cmdGhostLine) this.cmdGhostLine.visible = false;
      return;
    }

    if (line) {
      if (this.cmdGhost) this.cmdGhost.visible = false;
      if (this.cmdGhostCore) this.cmdGhostCore.visible = false;

      let dx = pos.x - line.fromX;
      let dz = pos.z - line.fromZ;
      const d0 = Math.hypot(dx, dz);
      if (d0 < 1e-3) {
        dx = 1;
        dz = 0;
      } else {
        dx /= d0;
        dz /= d0;
      }
      const L = line.length;
      const ex = line.fromX + dx * L;
      const ez = line.fromZ + dz * L;
      const cx = (line.fromX + ex) * 0.5;
      const cz = (line.fromZ + ez) * 0.5;
      const hw = line.halfWidth;

      const texLine = this.spellReticleTextures.aoe_line_damage;
      const useTexLine = spellEffectType === "aoe_line_damage" && texLine;

      if (useTexLine) {
        if (!this.cmdGhostLine) {
          this.cmdGhostLine = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1),
            this.ensureCmdGhostLineTexMaterial(texLine),
          );
          this.cmdGhostLine.position.y = 0.11;
          this.scene.add(this.cmdGhostLine);
          this.cmdGhostLineKind = "tex";
        } else if (this.cmdGhostLineKind !== "tex") {
          this.cmdGhostLine.geometry.dispose();
          this.cmdGhostLine.geometry = new THREE.PlaneGeometry(1, 1);
          this.cmdGhostLine.material = this.ensureCmdGhostLineTexMaterial(texLine);
          this.cmdGhostLine.position.y = 0.11;
          this.cmdGhostLineKind = "tex";
        } else {
          this.cmdGhostLine.material = this.ensureCmdGhostLineTexMaterial(texLine);
        }
        const mesh = this.cmdGhostLine;
        mesh.visible = true;
        mesh.position.set(cx, 0.11, cz);
        mesh.rotation.x = -Math.PI / 2;
        mesh.rotation.y = Math.atan2(ex - line.fromX, ez - line.fromZ);
        mesh.rotation.z = 0;
        mesh.scale.set(hw * 2, L, 1);
        const m = mesh.material as THREE.MeshBasicMaterial;
        m.color.set(valid ? 0xffffff : 0xffc0c8);
        m.opacity = valid ? 0.9 : 0.58;
        return;
      }

      if (this.cmdGhostLine && this.cmdGhostLineKind === "tex") {
        this.cmdGhostLine.geometry.dispose();
        this.cmdGhostLine.geometry = new THREE.BoxGeometry(1, 0.14, 1);
        this.cmdGhostLine.material = this.ensureCmdGhostLineBoxMaterial();
        this.cmdGhostLine.rotation.set(0, 0, 0);
        this.cmdGhostLine.position.y = 0.1;
        this.cmdGhostLineKind = "box";
      }

      if (!this.cmdGhostLine) {
        this.cmdGhostLine = new THREE.Mesh(
          new THREE.BoxGeometry(1, 0.14, 1),
          this.ensureCmdGhostLineBoxMaterial(),
        );
        this.cmdGhostLine.position.y = 0.1;
        this.scene.add(this.cmdGhostLine);
        this.cmdGhostLineKind = "box";
      }
      const mesh = this.cmdGhostLine;
      mesh.visible = true;
      mesh.position.set(cx, 0.1, cz);
      mesh.rotation.y = Math.atan2(ex - line.fromX, ez - line.fromZ);
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.color.set(valid ? 0xc8ffe8 : 0xffb0b8);
      mat.opacity = valid ? 0.42 : 0.36;
      mesh.geometry.dispose();
      mesh.geometry = new THREE.BoxGeometry(hw * 2, 0.14, L);
      return;
    }

    if (this.cmdGhostLine) this.cmdGhostLine.visible = false;

    const reticleKey =
      spellEffectType && isSpellReticleEffectType(spellEffectType) ? spellEffectType : null;
    const texDisc = reticleKey ? this.spellReticleTextures[reticleKey] : undefined;
    const useTexDisc = radius != null && texDisc != null && reticleKey != null;

    if (useTexDisc) {
      if (!this.cmdGhost) {
        this.cmdGhost = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          this.ensureCmdGhostDiscTexMaterial(texDisc),
        );
        this.cmdGhost.position.y = 0.1;
        this.scene.add(this.cmdGhost);
        this.cmdGhostDiscKind = "tex";
      } else if (this.cmdGhostDiscKind !== "tex") {
        this.cmdGhost.geometry.dispose();
        this.cmdGhost.geometry = new THREE.PlaneGeometry(1, 1);
        this.cmdGhost.material = this.ensureCmdGhostDiscTexMaterial(texDisc);
        this.cmdGhost.scale.setScalar(1);
        this.cmdGhost.position.y = 0.1;
        this.cmdGhostDiscKind = "tex";
      } else {
        this.cmdGhost.material = this.ensureCmdGhostDiscTexMaterial(texDisc);
      }
      if (this.cmdGhostCore) this.cmdGhostCore.visible = false;

      const r = Math.max(1, radius ?? 1.5);
      this.cmdGhost.rotation.x = -Math.PI / 2;
      this.cmdGhost.rotation.y = 0;
      this.cmdGhost.rotation.z = 0;
      this.cmdGhost.scale.set(r * 2, r * 2, 1);
      this.cmdGhost.position.set(pos.x, 0.1, pos.z);
      this.cmdGhost.visible = true;
      const mat = this.cmdGhost.material as THREE.MeshBasicMaterial;
      mat.color.set(valid ? 0xffffff : 0xffc0c8);
      mat.opacity = valid ? 0.9 : 0.58;
      return;
    }

    if (this.cmdGhost && this.cmdGhostDiscKind === "tex") {
      this.cmdGhost.geometry.dispose();
      this.cmdGhost.geometry = new THREE.RingGeometry(0.1, 0.2, 48);
      this.cmdGhost.material = this.ensureCmdGhostRingMaterial();
      this.cmdGhost.rotation.set(-Math.PI / 2, 0, 0);
      this.cmdGhost.scale.setScalar(1);
      this.cmdGhost.position.y = 0.08;
      this.cmdGhostDiscKind = "rings";
    }

    if (!this.cmdGhost) {
      this.cmdGhost = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.2, 48), this.ensureCmdGhostRingMaterial());
      this.cmdGhost.rotation.x = -Math.PI / 2;
      this.cmdGhost.position.y = 0.08;
      this.scene.add(this.cmdGhost);
      this.cmdGhostDiscKind = "rings";
    }
    if (!this.cmdGhostCore) {
      const coreMat = new THREE.MeshBasicMaterial({
        color: 0xf0c8ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
      this.cmdGhostCore = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.65, 32), coreMat);
      this.cmdGhostCore.rotation.x = -Math.PI / 2;
      this.cmdGhostCore.position.y = 0.09;
      this.scene.add(this.cmdGhostCore);
    }

    const r = Math.max(1, radius ?? 1.5);
    this.cmdGhost.geometry.dispose();
    this.cmdGhost.geometry = new THREE.RingGeometry(Math.max(0.1, r - 0.35), r, 64);
    this.cmdGhost.position.set(pos.x, 0.08, pos.z);
    this.cmdGhost.visible = true;
    (this.cmdGhost.material as THREE.MeshBasicMaterial).color.set(valid ? 0xd87bff : 0xff6a6a);

    const inner = Math.max(0.2, Math.min(1.2, (radius ?? 1.5) * 0.14));
    this.cmdGhostCore.geometry.dispose();
    this.cmdGhostCore.geometry = new THREE.RingGeometry(inner * 0.55, inner, 40);
    this.cmdGhostCore.position.set(pos.x, 0.09, pos.z);
    this.cmdGhostCore.visible = true;
    (this.cmdGhostCore.material as THREE.MeshBasicMaterial).color.set(
      valid ? 0xf0c8ff : 0xffb3b3,
    );
  }

  setFormationGhost(
    from: { x: number; z: number } | null,
    to: { x: number; z: number } | null,
    slots: { x: number; z: number }[] = [],
    valid = true,
  ): void {
    if (!from || !to) {
      if (this.formationGhostLine) this.formationGhostLine.visible = false;
      if (this.formationGhostSlots) this.formationGhostSlots.visible = false;
      return;
    }

    let dx = to.x - from.x;
    let dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.1) {
      dx = 1;
      dz = 0;
    } else {
      dx /= len;
      dz /= len;
    }

    if (!this.formationGhostLine) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x7ec8ff,
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
      this.formationGhostLine = new THREE.Mesh(new THREE.BoxGeometry(1, 0.12, 1), mat);
      this.formationGhostLine.position.y = 0.115;
      this.scene.add(this.formationGhostLine);
    }
    const line = this.formationGhostLine;
    line.visible = true;
    line.position.set((from.x + to.x) * 0.5, 0.115, (from.z + to.z) * 0.5);
    line.rotation.y = Math.atan2(dx, dz);
    line.geometry.dispose();
    line.geometry = new THREE.BoxGeometry(0.28, 0.12, Math.max(0.5, len));
    const lineMat = line.material as THREE.MeshBasicMaterial;
    lineMat.color.set(valid ? 0x7ec8ff : 0xff7070);
    lineMat.opacity = valid ? 0.48 : 0.34;

    if (!this.formationGhostSlots) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xbceeff,
        transparent: true,
        opacity: 0.68,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
      const geom = new THREE.RingGeometry(0.28, 0.48, 18);
      geom.rotateX(-Math.PI / 2);
      this.formationGhostSlots = new THREE.InstancedMesh(geom, mat, 256);
      this.formationGhostSlots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(this.formationGhostSlots);
    }
    const inst = this.formationGhostSlots;
    inst.visible = slots.length > 0;
    inst.count = Math.min(slots.length, 256);
    const mat = inst.material as THREE.MeshBasicMaterial;
    mat.color.set(valid ? 0xbceeff : 0xffa0a0);
    const m = new THREE.Matrix4();
    for (let i = 0; i < inst.count; i++) {
      const slot = slots[i]!;
      m.makeTranslation(slot.x, 0.13, slot.z);
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
  }

  private syncTaps(state: GameState): void {
    const hero = state.hero;
    const claimR = HERO_CLAIM_RADIUS;
    const ringIn = claimR * 0.58;
    const ringOut = claimR * 0.92;
    const chIn = claimR * 0.76;
    const chOut = claimR * 0.98;
    const yIn = claimR * 0.22;
    const yOut = claimR * 0.36;
    const nhIn = claimR * 0.88;
    const nhOut = claimR * 1.08;

    // Find the nearest neutral tap to the hero — we highlight it with an
    // extra pulsing ring so the player always has an obvious "go here next".
    let nearestId: string | null = null;
    {
      let bestD = Infinity;
      for (const t of state.taps) {
        if (t.active) continue;
        const dx = t.x - hero.x;
        const dz = t.z - hero.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD) {
          bestD = d2;
          nearestId = t.defId;
        }
      }
    }

    for (let idx = 0; idx < state.taps.length; idx++) {
      const t = state.taps[idx]!;
      let band = this.tapMeshes.get(t.defId);
      const nodeR2 = HERO_CLAIM_RADIUS * HERO_CLAIM_RADIUS;
      const playerNear = state.units.some((u) => u.team === "player" && u.hp > 0 && dist2(u, t) <= nodeR2);
      const enemyNear = state.units.some((u) => u.team === "enemy" && u.hp > 0 && dist2(u, t) <= nodeR2);
      const contested = playerNear && enemyNear;
      const playerTerritory = inPlayerTerritory(state, t);
      const enemyTerritory = inEnemyTerritory(state, t);
      const enemyChanneling = state.enemyHero.claimChannelTarget === idx;
      const playerChanneling = hero.claimChannelTarget === idx;

      const manaReady = this.manaNodeTextures !== null && this.manaSpinTexture !== null;

      if (manaReady) {
        if (band && band.group.userData["tapGfx"] !== "mana") {
          this.markers.remove(band.group);
          disposeTapBandMeshes(band as TapBandMeshes);
          this.tapMeshes.delete(t.defId);
          band = undefined;
        }
        if (!band) {
          const mb = createManaNodeGroundBand(
            this.manaNodeTextures!,
            this.manaSpinTexture!,
            this.manaNodeTextures!.neutral,
          );
          this.markers.add(mb.group);
          this.tapMeshes.set(t.defId, mb);
          band = mb;
        }
        const mb = band as ManaNodeGroundBand;

        let manaTex = this.manaNodeTextures!.neutral;
        let decalOpacity = 0.74;
        const spinRgb = new THREE.Color(0xffffff);

        if (contested) {
          manaTex = this.manaNodeTextures!.neutral;
          decalOpacity = 0.92;
          spinRgb.setHex(0xffc878);
        } else if (t.active && t.ownerTeam === "player") {
          if (t.yieldRemaining <= 0) {
            manaTex = this.manaNodeTextures!.neutral;
            decalOpacity = 0.52;
            spinRgb.setHex(0x8a99aa);
          } else {
            manaTex = this.manaNodeTextures!.friendly;
            decalOpacity = 0.94;
            spinRgb.setHex(0x6ae1ff);
          }
        } else if (t.active && t.ownerTeam === "enemy") {
          if (t.yieldRemaining <= 0 || (t.anchorHp ?? 0) <= 0) {
            manaTex = this.manaNodeTextures!.neutral;
            decalOpacity = 0.52;
            spinRgb.setHex(0xaa7777);
          } else {
            manaTex = this.manaNodeTextures!.hostile;
            decalOpacity = 0.94;
            spinRgb.setHex(0xff7766);
          }
        } else if (enemyChanneling) {
          manaTex = this.manaNodeTextures!.neutral;
          decalOpacity = 0.88;
          spinRgb.setHex(0xff9a9a);
        } else if (playerChanneling) {
          manaTex = this.manaNodeTextures!.neutral;
          decalOpacity = 0.88;
          spinRgb.setHex(0x88ddff);
        } else if (playerTerritory && !enemyTerritory) {
          manaTex = this.manaNodeTextures!.neutral;
          decalOpacity = 0.78;
          spinRgb.setHex(0x88ccff);
        } else if (enemyTerritory && !playerTerritory) {
          manaTex = this.manaNodeTextures!.neutral;
          decalOpacity = 0.78;
          spinRgb.setHex(0xff8888);
        } else if (t.active) {
          manaTex = this.manaNodeTextures!.friendly;
          decalOpacity = 0.85;
          spinRgb.setHex(0x66c8ff);
        } else {
          manaTex = this.manaNodeTextures!.neutral;
          decalOpacity = 0.72;
          spinRgb.setHex(0xffffff);
        }

        syncManaNodeBandTexture(mb, manaTex, decalOpacity);
        syncManaNodeSpinTint(mb, spinRgb);
        mb.group.position.set(t.x, 0, t.z);
        mb.spinLayer.rotation.z = this.clock.getElapsedTime() * 0.18 + idx * 0.91;
      } else {
        if (band && band.group.userData["tapGfx"] === "mana") {
          this.markers.remove(band.group);
          disposeManaNodeBand(band as ManaNodeGroundBand);
          this.tapMeshes.delete(t.defId);
          band = undefined;
        }
        let ringBand = this.tapMeshes.get(t.defId);
        if (!ringBand) {
          const geo = new THREE.RingGeometry(ringIn, ringOut, 32);
          ringBand = createTapBandMeshes(geo);
          this.markers.add(ringBand.group);
          this.tapMeshes.set(t.defId, ringBand);
        }
        ringBand.group.position.set(t.x, 0.05, t.z);

        let ringColor = 0xc1ccd8;
        if (contested) ringColor = 0xffd36a;
        else if (t.active && t.ownerTeam === "player") ringColor = 0x54c7ff;
        else if (t.active && t.ownerTeam === "enemy") ringColor = 0xff6b6b;
        else if (t.active && t.yieldRemaining <= 0) ringColor = 0x7d8895;
        else if (enemyChanneling) ringColor = 0xff8a8a;
        else if (playerChanneling) ringColor = 0x6ae1ff;
        else if (playerTerritory && !enemyTerritory) ringColor = 0x54c7ff;
        else if (enemyTerritory && !playerTerritory) ringColor = 0xff6b6b;
        else if (t.active) ringColor = 0x52b0ff;

        const ringOpacity = contested ? 1 : t.active ? 0.92 : 0.72;
        syncTapBandColors(ringBand, ringColor, ringOpacity);
      }

      // Claim channel arc (cyan), visible while hero is channeling this tap.
      let claimBand = this.tapClaimArcs.get(t.defId);
      const channeling = playerChanneling || enemyChanneling;
      if (channeling) {
        const isEnemyChannel = enemyChanneling;
        const total = Math.max(
          1,
          Math.round(claimChannelSecForTap(state, isEnemyChannel ? "enemy" : "player", t) * TICK_HZ),
        );
        const frac = isEnemyChannel
          ? Math.max(0, Math.min(1, 1 - state.enemyHero.claimChannelTicksRemaining / total))
          : Math.max(0, Math.min(1, 1 - hero.claimChannelTicksRemaining / total));
        if (!claimBand) {
          const geo = new THREE.RingGeometry(chIn, chOut, 48, 1, 0, 0.0001);
          claimBand = createTapBandMeshes(geo);
          this.markers.add(claimBand.group);
          this.tapClaimArcs.set(t.defId, claimBand);
        }
        claimBand.group.position.set(t.x, 0.07, t.z);
        const channelKey = isEnemyChannel
          ? `e:${state.enemyHero.claimChannelTicksRemaining}`
          : `p:${hero.claimChannelTicksRemaining}`;
        const ud = claimBand.group.userData as Record<string, unknown>;
        if (ud["channelGeomKey"] !== channelKey) {
          ud["channelGeomKey"] = channelKey;
          const newGeo = new THREE.RingGeometry(
            chIn,
            chOut,
            48,
            1,
            -Math.PI / 2,
            Math.max(0.0001, frac * Math.PI * 2),
          );
          setSharedBandGeometry(claimBand, newGeo);
        }
        claimBand.group.visible = true;
        syncTapBandColors(claimBand, isEnemyChannel ? 0xff8a8a : 0x6ae1ff, 0.95);
      } else if (claimBand) {
        claimBand.group.visible = false;
        (claimBand.group.userData as Record<string, unknown>)["channelGeomKey"] = undefined;
      }

      // Floating label: "Stand to claim — 20 Mana" on unclaimed taps, "Depleted"
      // on dried-up ones. Hidden once the player owns the tap.
      let label = this.tapLabels.get(t.defId);
      const claimedByPlayer = t.active && t.ownerTeam === "player";
      const claimedByEnemy = t.active && t.ownerTeam === "enemy";
      const depleted = t.active && t.yieldRemaining <= 0;
      const anchorUp = (t.anchorHp ?? 0) > 0;
      if (!claimedByPlayer && !claimedByEnemy) {
        if (!label) {
          label = makeLabelSprite("Stand to claim", "#6ae1ff");
          this.markers.add(label.sprite);
          this.tapLabels.set(t.defId, label);
        }
        const text = depleted ? "Node depleted" : contested ? "Contested Mana" : "Claim Mana node";
        const accent = depleted ? "#8a96a6" : contested ? "#ffd36a" : "#6ae1ff";
        drawLabel(label, text, accent);
        label.sprite.position.set(t.x, Math.max(5.2, claimR * 0.45 + 3.8), t.z);
        label.sprite.visible = true;
        (label.sprite.material as THREE.SpriteMaterial).opacity = depleted ? 0.55 : 1;
      } else if (claimedByEnemy && anchorUp) {
        if (!label) {
          label = makeLabelSprite("Destroy anchor", "#ff9a7a");
          this.markers.add(label.sprite);
          this.tapLabels.set(t.defId, label);
        }
        drawLabel(label, "Destroy red anchor", "#ff9a7a");
        label.sprite.position.set(t.x, Math.max(6, claimR * 0.48 + 4.2), t.z);
        label.sprite.visible = true;
        (label.sprite.material as THREE.SpriteMaterial).opacity = 0.95;
      } else if (label) {
        label.sprite.visible = false;
      }

      let arcBand = this.tapYieldArcs.get(t.defId);
      const active = t.active && t.yieldRemaining > 0 && (t.anchorHp ?? 0) > 0;
      if (active) {
        const frac = Math.max(0, Math.min(1, t.yieldRemaining / TAP_YIELD_MAX));
        if (!arcBand) {
          const geo = new THREE.RingGeometry(yIn, yOut, 48, 1, 0, Math.PI * 2);
          arcBand = createTapBandMeshes(geo);
          this.markers.add(arcBand.group);
          this.tapYieldArcs.set(t.defId, arcBand);
        }
        arcBand.group.position.set(t.x, 0.07, t.z);
        const yieldKey = `${t.ownerTeam}:${t.yieldRemaining}`;
        const arcUd = arcBand.group.userData as Record<string, unknown>;
        if (arcUd["yieldGeomKey"] !== yieldKey) {
          arcUd["yieldGeomKey"] = yieldKey;
          const newGeo = new THREE.RingGeometry(
            yIn,
            yOut,
            48,
            1,
            Math.PI / 2 - frac * Math.PI,
            Math.max(0.0001, frac * Math.PI * 2),
          );
          setSharedBandGeometry(arcBand, newGeo);
        }
        syncTapBandColors(arcBand, t.ownerTeam === "enemy" ? 0xff7070 : 0x6ab8ff, 0.9);
        arcBand.group.visible = true;
      } else if (arcBand) {
        arcBand.group.visible = false;
        (arcBand.group.userData as Record<string, unknown>)["yieldGeomKey"] = undefined;
      }
    }

    const aliveAnchors = new Set<string>();
    for (const t of state.taps) {
      if (!t.active || !t.ownerTeam) continue;
      if ((t.anchorHp ?? 0) <= 0) continue;
      aliveAnchors.add(t.defId);
      let g = this.tapAnchorRoots.get(t.defId);
      if (!g) {
        g = new THREE.Group();
        const body = new THREE.Mesh(
          new THREE.CylinderGeometry(0.42, 0.52, 1.12, 12),
          new THREE.MeshStandardMaterial({
            color: 0x9eb6d4,
            roughness: 0.52,
            metalness: 0.12,
            emissive: 0x0a1420,
          }),
        );
        body.position.y = 0.56;
        body.castShadow = true;
        body.receiveShadow = true;
        body.userData["bodyMesh"] = body;
        g.userData["bodyMesh"] = body;
        g.add(body);
        this.markers.add(g);
        this.tapAnchorRoots.set(t.defId, g);
      }
      g.position.set(t.x, 0, t.z);
      const body = g.userData["bodyMesh"] as THREE.Mesh;
      const mat = body.material as THREE.MeshStandardMaterial;
      mat.color.setHex(t.ownerTeam === "player" ? 0x5ba8e8 : 0xd86060);
      const fg = t.ownerTeam === "player" ? 0x7ec8ff : 0xff8888;
      const pair = this.ensureHpBarPair(g, "tapA", 1.32, fg);
      const maxA = Math.max(1, t.anchorMaxHp ?? 1);
      const hpA = t.anchorHp ?? 0;
      this.setHpBarFrac(pair, hpA / maxA);
      const prev = this.tapAnchorPrevHp.get(t.defId);
      if (prev !== undefined && hpA < prev - 0.5) {
        (g.userData as Record<string, unknown>)["hitPulse"] = 0.22;
      }
      this.tapAnchorPrevHp.set(t.defId, hpA);
    }
    for (const [defId, g] of this.tapAnchorRoots) {
      if (!aliveAnchors.has(defId)) {
        this.markers.remove(g);
        this.disposeObject(g);
        this.tapAnchorRoots.delete(defId);
        this.tapAnchorPrevHp.delete(defId);
      }
    }

    // Pulsing "next target" ring sitting just outside the tap ring.
    if (nearestId !== null) {
      const t = state.taps.find((x) => x.defId === nearestId)!;
      if (!this.nearestTapRing) {
        const geo = new THREE.RingGeometry(nhIn, nhOut, 48);
        this.nearestTapRing = createTapBandMeshes(geo);
        this.markers.add(this.nearestTapRing.group);
      }
      const elapsed = this.clock.getElapsedTime();
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 3.2);
      this.nearestTapRing.group.position.set(t.x, 0.06, t.z);
      const s = 1 + pulse * 0.18;
      this.nearestTapRing.group.scale.set(s, s, s);
      const pulseOp = 0.55 + 0.4 * pulse;
      syncTapBandColors(this.nearestTapRing, 0x6ae1ff, pulseOp);
      this.nearestTapRing.group.visible = true;
    } else if (this.nearestTapRing) {
      this.nearestTapRing.group.visible = false;
    }
  }

  private syncMarkers(state: GameState): void {
    this.syncTaps(state);
    this.syncCampZones(state);
    this.syncTacticsFields(state);

    // Only enemy relays (Dark Fortresses) render as markers now — the player's
    // Keep is just a structure and renders through syncStructures().
    const aliveRelayIds = new Set(state.enemyRelays.map((er) => `e:${er.defId}`));
    for (const [id, m] of this.relayMeshes) {
      if (!aliveRelayIds.has(id)) {
        this.markers.remove(m);
        this.disposeObject(m);
        this.relayMeshes.delete(id);
        this.relayPrevHp.delete(id);
      }
    }
    for (const er of state.enemyRelays) {
      const id = `e:${er.defId}`;
      let m = this.relayMeshes.get(id);
      if (!m) {
        const S = STRUCTURE_MESH_VISUAL_SCALE;
        const geo = new THREE.CylinderGeometry(1.2 * S, 1.4 * S, 2.4 * S, 16);
        const mat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8 });
        m = new THREE.Mesh(geo, mat);
        m.position.y = 1.2 * S;
        m.castShadow = true;
        m.receiveShadow = true;
        m.userData["bodyMesh"] = m;
        this.markers.add(m);
        this.relayMeshes.set(id, m);
      }
      m.position.set(er.x, 1.2 * STRUCTURE_MESH_VISUAL_SCALE, er.z);
      const mat = m.material as THREE.MeshStandardMaterial;
      const built = er.hp > 0;
      if (built) {
        const silenced = er.silencedUntilTick > state.tick;
        const base = new THREE.Color(0xff5c5c);
        if (silenced) base.multiplyScalar(0.45);
        mat.color.copy(base);
      } else {
        mat.color.set(0x444444);
      }
      const s = built ? 1 : 0.55;
      m.scale.set(s, s, s);
      const pair = this.ensureHpBarPair(m, "relay", 1.95 * STRUCTURE_MESH_VISUAL_SCALE, 0xff7a6a);
      this.setHpBarFrac(pair, er.maxHp > 0 ? Math.max(0, er.hp / er.maxHp) : 0);
      const prevHp = this.relayPrevHp.get(id);
      if (prevHp !== undefined && er.hp < prevHp - 0.5) {
        (m.userData as Record<string, unknown>)["hitPulse"] = 0.22;
      }
      this.relayPrevHp.set(id, er.hp);
    }
  }

  private syncTacticsFields(state: GameState): void {
    const alive = new Set<string>();
    for (let i = 0; i < state.tacticsFieldZones.length; i++) {
      const zf = state.tacticsFieldZones[i]!;
      const key = `${i}:${Math.round(zf.x * 10)}:${Math.round(zf.z * 10)}:${zf.untilTick}`;
      alive.add(key);
      let ring = this.tacticsFieldRings.get(key);
      if (!ring) {
        ring = new THREE.Mesh(
          new THREE.RingGeometry(0.92, 1, 96),
          new THREE.MeshBasicMaterial({
            color: 0x7fe7ff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.36,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.072;
        this.markers.add(ring);
        this.tacticsFieldRings.set(key, ring);
      }
      const lifeFrac = Math.max(0, Math.min(1, (zf.untilTick - state.tick) / Math.max(1, 14 * TICK_HZ)));
      ring.position.set(zf.x, 0.072, zf.z);
      ring.scale.setScalar(Math.max(1, zf.radius));
      const mat = ring.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.16 + lifeFrac * 0.24;
      mat.color.set(lifeFrac < 0.25 ? 0xffd86a : 0x7fe7ff);
    }
    for (const [key, ring] of this.tacticsFieldRings) {
      if (alive.has(key)) continue;
      this.markers.remove(ring);
      this.disposeObject(ring);
      this.tacticsFieldRings.delete(key);
    }
  }

  private syncCampZones(state: GameState): void {
    const alive = new Set(state.map.enemyCamps.map((c) => c.id));
    for (const [id, ring] of this.campAggroRings) {
      if (!alive.has(id)) {
        this.markers.remove(ring);
        this.disposeObject(ring);
        this.campAggroRings.delete(id);
      }
    }
    for (const [id, ring] of this.campWakeRings) {
      if (!alive.has(id)) {
        this.markers.remove(ring);
        this.disposeObject(ring);
        this.campWakeRings.delete(id);
      }
    }
    for (const camp of state.map.enemyCamps) {
      let aggro = this.campAggroRings.get(camp.id);
      if (!aggro) {
        aggro = new THREE.Mesh(
          new THREE.RingGeometry(Math.max(0.1, camp.aggroRadius - 0.3), camp.aggroRadius, 64),
          new THREE.MeshBasicMaterial({
            color: 0xff6a6a,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
            depthTest: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        aggro.rotation.x = -Math.PI / 2;
        this.markers.add(aggro);
        this.campAggroRings.set(camp.id, aggro);
      }
      aggro.position.set(camp.origin.x, 0.045, camp.origin.z);
      aggro.visible = true;

      let wake = this.campWakeRings.get(camp.id);
      if (!wake) {
        wake = new THREE.Mesh(
          new THREE.RingGeometry(Math.max(0.1, camp.wakeRadius - 0.2), camp.wakeRadius, 80),
          new THREE.MeshBasicMaterial({
            color: 0xffb3a3,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.1,
            depthWrite: false,
            depthTest: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        wake.rotation.x = -Math.PI / 2;
        this.markers.add(wake);
        this.campWakeRings.set(camp.id, wake);
      }
      wake.position.set(camp.origin.x, 0.04, camp.origin.z);
      wake.visible = true;
    }
  }

  private disposeObject(obj: THREE.Object3D): void {
    obj.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        c.geometry.dispose();
        if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
        else c.material.dispose();
      } else if (c instanceof THREE.Sprite) {
        const mat = c.material;
        if (Array.isArray(mat)) {
          mat.forEach((m) => {
            m.map?.dispose();
            m.dispose();
          });
        } else {
          mat.map?.dispose();
          mat.dispose();
        }
      }
    });
  }

  private getDecorWrapTexture(preset: MapGroundPreset, tag: string): THREE.CanvasTexture {
    const key = `${preset}:${tag}`;
    const ex = this.decorTextureCache.get(key);
    if (ex) return ex;
    const tex = makeDecorWrapTexture(preset, tag);
    this.decorTextureCache.set(key, tex);
    return tex;
  }

  private syncKeepMarker(state: GameState): void {
    const keep = findKeep(state);
    const S = STRUCTURE_MESH_VISUAL_SCALE;
    if (!keep) {
      if (this.keepRing) this.keepRing.visible = false;
      if (this.keepHpArc) this.keepHpArc.visible = false;
      return;
    }
    if (!this.keepRing) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(3.6 * S, 4.4 * S, 56),
        new THREE.MeshBasicMaterial({
          color: 0xb58bff,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.6,
          depthWrite: false,
          /** Ground decal: respect depth so the ring does not paint through the Keep mesh / nearby walls. */
          depthTest: true,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
          blending: THREE.AdditiveBlending,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      this.markers.add(ring);
      this.keepRing = ring;
    }
    const frac = Math.max(0, Math.min(1, keep.maxHp > 0 ? keep.hp / keep.maxHp : 0));
    if (!this.keepHpArc) {
      const arc = new THREE.Mesh(
        new THREE.RingGeometry(4.5 * S, 4.9 * S, 64, 1, 0, Math.PI * 2),
        new THREE.MeshBasicMaterial({
          color: 0xd9b7ff,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
          depthTest: true,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
          blending: THREE.AdditiveBlending,
        }),
      );
      arc.rotation.x = -Math.PI / 2;
      this.markers.add(arc);
      this.keepHpArc = arc;
    }
    const pulse = 0.5 + 0.5 * Math.sin(this.clock.getElapsedTime() * 1.6);
    this.keepRing.position.set(keep.x, 0.06, keep.z);
    (this.keepRing.material as THREE.MeshBasicMaterial).opacity = 0.38 + 0.35 * pulse;
    this.keepRing.visible = true;

    this.keepHpArc.position.set(keep.x, 0.065, keep.z);
    const fracKey = Math.round(frac * 200);
    const arcUd = this.keepHpArc.userData as Record<string, unknown>;
    if (arcUd["keepArcFracKey"] !== fracKey) {
      arcUd["keepArcFracKey"] = fracKey;
      this.keepHpArc.geometry.dispose();
      this.keepHpArc.geometry = new THREE.RingGeometry(
        4.5 * S,
        4.9 * S,
        64,
        1,
        Math.PI / 2 - frac * Math.PI,
        Math.max(0.0001, frac * Math.PI * 2),
      );
      const arcMat = this.keepHpArc.material as THREE.MeshBasicMaterial;
      if (frac < 0.35) arcMat.color.set(0xff7474);
      else if (frac < 0.7) arcMat.color.set(0xffd08a);
      else arcMat.color.set(0xd9b7ff);
    }
    this.keepHpArc.visible = true;
  }

  private syncStructures(state: GameState): void {
    const alive = new Set(state.structures.map((s) => s.id));
    for (const [id, obj] of this.structureMeshes) {
      if (!alive.has(id)) {
        this.entities.remove(obj);
        this.disposeObject(obj);
        this.structureMeshes.delete(id);
      }
    }

    for (const st of state.structures) {
      let obj = this.structureMeshes.get(st.id);
      const entry = getCatalogEntry(st.catalogId);
      const structEntry = entry && isStructureEntry(entry) ? entry : null;
      if (!obj) {
        if (!structEntry) continue;
        const g = buildStructureSilhouette(structEntry, st.team);
        obj = g;
        this.entities.add(g);
        this.structureMeshes.set(st.id, g);
        if (this.useGlb) {
          setStructureFallbackVisible(g, false);
          const ph = g.userData["bodyMesh"] as THREE.Mesh | undefined;
          if (ph) void requestGlbForTower(st.catalogId, ph);
        }
      }
      const g = obj as THREE.Group;
      if (this.useGlb) setStructureFallbackVisible(g, false);
      g.position.set(st.x, 0, st.z);
      g.rotation.y = structureFacingYawRad(state, st);
      const buildT = st.complete ? 1 : 0.35 + 0.65 * (1 - st.buildTicksRemaining / Math.max(1, st.buildTotalTicks));
      g.scale.set(1, buildT, 1);

      g.traverse((c) => {
        if (c instanceof THREE.Mesh) {
          if (c.userData["skipBuildOpacity"] || c.userData["isPlaceholder"]) return;
          const mat = c.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial | undefined;
          if (!mat || !("opacity" in mat)) return;
          if (mat.userData["baseOpacity"] === undefined) mat.userData["baseOpacity"] = mat.opacity;
          mat.transparent = true;
          mat.opacity = st.complete ? (mat.userData["baseOpacity"] as number | undefined) ?? 1 : 0.55;
        }
      });

      const dims = structureDims(structEntry);
      const fg = st.team === "player" ? 0x7ec8ff : 0xff8a7a;
      const pair = this.ensureHpBarPair(g, "st", dims.h * buildT + 0.9 * STRUCTURE_MESH_VISUAL_SCALE, fg);
      this.setHpBarFrac(pair, st.maxHp > 0 ? st.hp / st.maxHp : 0);
      const prevHp = this.structurePrevHp.get(st.id);
      if (prevHp !== undefined && st.hp < prevHp - 0.25) {
        (g.userData as Record<string, unknown>)["hitPulse"] = 0.22;
      }
      this.structurePrevHp.set(st.id, st.hp);

      const plinthMesh = g.userData["plinthMesh"] as THREE.Mesh | undefined;
      if (plinthMesh) {
        const cam = this.camera.position;
        const dx = st.x - cam.x;
        const dz = st.z - cam.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const t = Math.min(1, Math.max(0, (dist - 38) / 220));
        const mat = plinthMesh.material as THREE.MeshStandardMaterial;
        const base = st.team === "player" ? new THREE.Color(0x0a2844) : new THREE.Color(0x440808);
        const peak = st.team === "player" ? new THREE.Color(0x55aaff) : new THREE.Color(0xff5555);
        mat.emissive.copy(base).lerp(peak, t);
        mat.emissiveIntensity = 0.35 + t * 0.95;
      }
    }
  }

  private syncHoldCubes(state: GameState): void {
    const alive = new Set(state.structures.map((s) => s.id));
    for (const [id, cube] of this.holdCubes) {
      if (!alive.has(id)) {
        this.markers.remove(cube);
        this.disposeObject(cube);
        this.holdCubes.delete(id);
      }
    }
    const elapsed = this.clock.getElapsedTime();
    for (const st of state.structures) {
      let cube = this.holdCubes.get(st.id);
      const show = st.team === "player" && st.holdOrders && st.complete;
      if (show) {
        if (!cube) {
          cube = new THREE.Mesh(
            new THREE.BoxGeometry(0.7, 0.7, 0.7),
            new THREE.MeshStandardMaterial({
              color: 0xff5050,
              emissive: 0x441010,
              roughness: 0.4,
            }),
          );
          this.markers.add(cube);
          this.holdCubes.set(st.id, cube);
        }
        const entry = getCatalogEntry(st.catalogId);
        const dims = structureDims(entry && isStructureEntry(entry) ? entry : null);
        const hover = 0.2 * Math.sin(elapsed * 3);
        cube.position.set(st.x, dims.h + 1.4 * STRUCTURE_MESH_VISUAL_SCALE + hover, st.z);
        cube.rotation.y = elapsed * 0.9;
        cube.visible = true;
      } else if (cube) {
        cube.visible = false;
      }
    }
  }

  private hideStructureSelectionVisuals(): void {
    if (this.selectHalo) this.selectHalo.visible = false;
    if (this.attackRangeRing) this.attackRangeRing.visible = false;
    if (this.auraRangeRing) this.auraRangeRing.visible = false;
    if (this.rallyLine) this.rallyLine.visible = false;
    if (this.rallyFlag) this.rallyFlag.visible = false;
  }

  private hideUnitSelectionVisuals(): void {
    if (this.unitSelHalo) this.unitSelHalo.visible = false;
    if (this.unitMeleeRing) this.unitMeleeRing.visible = false;
  }

  private syncSelectionAndRally(state: GameState): void {
    const uSel = state.selectedUnitId ?? state.selectedUnitIds[0] ?? null;
    const selU = uSel !== null ? state.units.find((x) => x.id === uSel) : null;
    const plrUnit = selU && selU.team === "player" && selU.hp > 0 ? selU : null;

    if (plrUnit) {
      this.hideStructureSelectionVisuals();
      const ux = plrUnit.x;
      const uz = plrUnit.z;
      const atkR = plrUnit.range;
      if (!this.unitSelHalo) {
        this.unitSelHalo = new THREE.Mesh(
          new THREE.RingGeometry(0.52, 0.92, 36),
          new THREE.MeshBasicMaterial({
            color: 0x9ed8ff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.72,
            depthWrite: false,
            depthTest: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        this.unitSelHalo.rotation.x = -Math.PI / 2;
        this.markers.add(this.unitSelHalo);
      }
      this.unitSelHalo.position.set(ux, 0.045, uz);
      this.unitSelHalo.visible = true;
      if (!this.unitMeleeRing) {
        this.unitMeleeRing = new THREE.Mesh(
          new THREE.RingGeometry(Math.max(0.15, atkR - 0.12), atkR, 56),
          new THREE.MeshBasicMaterial({
            color: 0x7ec8ff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.26,
            depthWrite: false,
            depthTest: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        this.unitMeleeRing.rotation.x = -Math.PI / 2;
        this.markers.add(this.unitMeleeRing);
      }
      this.unitMeleeRing.geometry.dispose();
      this.unitMeleeRing.geometry = new THREE.RingGeometry(
        Math.max(0.15, atkR - 0.12),
        atkR,
        56,
      );
      this.unitMeleeRing.position.set(ux, 0.052, uz);
      this.unitMeleeRing.visible = true;
      return;
    }

    this.hideUnitSelectionVisuals();

    const selId = state.selectedStructureId;
    const st = selId !== null ? state.structures.find((x) => x.id === selId) : null;

    if (st && st.team === "player") {
      if (!this.selectHalo) {
        const S = STRUCTURE_MESH_VISUAL_SCALE;
        this.selectHalo = new THREE.Mesh(
          new THREE.RingGeometry(2.8 * S, 3.4 * S, 48),
          new THREE.MeshBasicMaterial({
            color: 0x62b6ff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.75,
            depthWrite: false,
            depthTest: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        this.selectHalo.rotation.x = -Math.PI / 2;
        this.markers.add(this.selectHalo);
      }
      this.selectHalo.position.set(st.x, 0.04, st.z);
      this.selectHalo.visible = true;
      const entry = getCatalogEntry(st.catalogId);
      const structEntry = entry && isStructureEntry(entry) ? entry : null;
      if (structEntry) {
        const attackRange = unitStatsForCatalog(structEntry.producedSizeClass).range;
        if (!this.attackRangeRing) {
          this.attackRangeRing = new THREE.Mesh(
            new THREE.RingGeometry(Math.max(0.2, attackRange - 0.15), attackRange, 56),
            new THREE.MeshBasicMaterial({
              color: 0x7ec8ff,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: 0.28,
              depthWrite: false,
              depthTest: false,
              blending: THREE.AdditiveBlending,
            }),
          );
          this.attackRangeRing.rotation.x = -Math.PI / 2;
          this.markers.add(this.attackRangeRing);
        }
        this.attackRangeRing.geometry.dispose();
        this.attackRangeRing.geometry = new THREE.RingGeometry(
          Math.max(0.2, attackRange - 0.15),
          attackRange,
          56,
        );
        this.attackRangeRing.position.set(st.x, 0.05, st.z);
        this.attackRangeRing.visible = true;

        if (structEntry.aura && structEntry.aura.radius > 0) {
          if (!this.auraRangeRing) {
            this.auraRangeRing = new THREE.Mesh(
              new THREE.RingGeometry(1.5, 1.8, 56),
              new THREE.MeshBasicMaterial({
                color: 0x6ab8ff,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.24,
                depthWrite: false,
                depthTest: false,
                blending: THREE.AdditiveBlending,
              }),
            );
            this.auraRangeRing.rotation.x = -Math.PI / 2;
            this.markers.add(this.auraRangeRing);
          }
          this.auraRangeRing.geometry.dispose();
          this.auraRangeRing.geometry = new THREE.RingGeometry(
            Math.max(0.2, structEntry.aura.radius - 0.2),
            structEntry.aura.radius,
            64,
          );
          this.auraRangeRing.position.set(st.x, 0.055, st.z);
          this.auraRangeRing.visible = true;
        } else if (this.auraRangeRing) {
          this.auraRangeRing.visible = false;
        }
      } else {
        if (this.attackRangeRing) this.attackRangeRing.visible = false;
        if (this.auraRangeRing) this.auraRangeRing.visible = false;
      }

      if (!st.holdOrders && (st.rallyX !== st.x || st.rallyZ !== st.z)) {
        if (!this.rallyLine) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute(
            "position",
            new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3),
          );
          this.rallyLine = new THREE.Line(
            geo,
            new THREE.LineBasicMaterial({
              color: 0x6ae1ff,
              transparent: true,
              opacity: 0.85,
              depthWrite: false,
              depthTest: false,
              blending: THREE.AdditiveBlending,
            }),
          );
          this.markers.add(this.rallyLine);
        }
        const pos = this.rallyLine.geometry.getAttribute("position") as THREE.BufferAttribute;
        pos.setXYZ(0, st.x, 0.12, st.z);
        pos.setXYZ(1, st.rallyX, 0.12, st.rallyZ);
        pos.needsUpdate = true;
        this.rallyLine.visible = true;

        if (!this.rallyFlag) {
          this.rallyFlag = new THREE.Mesh(
            new THREE.ConeGeometry(0.35, 1.1, 10),
            new THREE.MeshStandardMaterial({
              color: 0x6ae1ff,
              emissive: 0x234a66,
              roughness: 0.45,
            }),
          );
          this.markers.add(this.rallyFlag);
        }
        this.rallyFlag.position.set(st.rallyX, 0.55, st.rallyZ);
        this.rallyFlag.rotation.y = Math.atan2(st.rallyX - st.x, st.rallyZ - st.z);
        this.rallyFlag.visible = true;
      } else {
        if (this.rallyLine) this.rallyLine.visible = false;
        if (this.rallyFlag) this.rallyFlag.visible = false;
      }
    } else {
      this.hideStructureSelectionVisuals();
    }
  }

  private syncWorldPlane(state: GameState): void {
    const half = state.map.world.halfExtents + 28;
    if (this.worldPlaneHalf === half) return;
    this.worldPlaneHalf = half;
    const size = half * 2;
    this.ground.geometry.dispose();
    this.ground.geometry = new THREE.PlaneGeometry(size, size);
    this.groundOverlay.geometry.dispose();
    this.groundOverlay.geometry = new THREE.PlaneGeometry(size, size);
    this.groundVisualKey = "";
  }

  /** Keep any old terrain slab cleared; world bounds clamp play without a duplicate visual wall. */
  private syncTerrainSlab(_state: GameState): void {
    if (this.terrainSlab) {
      this.scene.remove(this.terrainSlab);
      this.disposeObject(this.terrainSlab);
      this.terrainSlab = null;
    }
  }

  /**
   * Match sky: same as doctrine prematch — `Scene.background` equirect (no sky sphere; avoids custom UV).
   * `matchSkyboxPlacement` is still persisted for `?skyboxAdjust` but does not affect `Scene.background`.
   */
  private async _loadMatchSkybox(): Promise<void> {
    const loader = new THREE.TextureLoader();
    try {
      const tex = await loader.loadAsync(MATCH_SKYBOX_URL);
      if (this.rendererDisposed) {
        tex.dispose();
        return;
      }
      this.matchSkyboxTexture?.dispose();
      this.matchSkyboxTexture = tex;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = Math.min(16, this.renderer.capabilities.getMaxAnisotropy());
      this.scene.background = tex;
      this.scene.backgroundBlurriness = 0;
      this.scene.backgroundIntensity = 1;
      this.scene.backgroundRotation.set(0, 0, 0);
      this.groundVisualKey = "";
      if (this.currentState) this.applyMapVisual(this.currentState);
    } catch {
      /* Missing asset or decode error — keep solid fill. */
    }
  }

  /** Match readability pass: ignore authored color grading so maps cannot wash the scene green. */
  private applyMapVisual(state: GameState): void {
    const v = state.map.visual;
    const preset = v?.groundPreset ?? "solid";
    const skyH = v?.skyHex;
    const sunH = v?.sunHex;
    const key = `${preset}|${skyH ?? ""}|${sunH ?? ""}|${this.matchSkyboxTexture ? "sky" : "nosky"}`;
    if (key !== this.groundVisualKey) {
      this.groundVisualKey = key;
      // Map JSON still carries `fogHex` for tooling / legacy — we do not apply linear fog: it homogenizes
      // distant GLBs into one murky color at orbit zoom and reads like broken lighting.
      this.scene.fog = null;
      if (skyH != null) this.hemiLight.color.setHex(skyH);
      if (sunH != null) this.sunLight.color.setHex(sunH);

      const disposeGroundMat = (): void => {
        const m = this.ground.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else (m as THREE.Material).dispose?.();
      };

      if (preset === "solid" || !isShaderGroundPreset(preset)) {
        disposeGroundMat();
        const deck = !!this.matchSkyboxTexture;
        this.ground.material = new THREE.MeshStandardMaterial({
          color: deck ? MATCH_SKYBOX_GROUND_HEX : 0x1b2430,
          roughness: deck ? 0.9 : 0.92,
          metalness: deck ? 0.06 : 0.04,
        });
      } else {
        disposeGroundMat();
        this.ground.material = createGroundShaderMaterial(preset);
      }

      const overlayMat = this.groundOverlay.material as THREE.MeshBasicMaterial;
      const oldOverlay = overlayMat.map;
      overlayMat.map = makeGroundOverlayTexture(preset);
      oldOverlay?.dispose();
      if (preset === "ember_wastes") {
        overlayMat.color.setHex(0xffb07a);
        overlayMat.opacity = 0.16;
      } else if (preset === "glacier_grid") {
        overlayMat.color.setHex(0xb6eaff);
        overlayMat.opacity = 0.135;
      } else if (preset === "mesa_band") {
        overlayMat.color.setHex(0xffd4a4);
        overlayMat.opacity = 0.15;
      } else {
        overlayMat.color.setHex(0xb9d8ff);
        overlayMat.opacity = 0.1;
      }
      overlayMat.blending = THREE.NormalBlending;
      overlayMat.needsUpdate = true;
    }
    this.groundOverlay.visible = true;
  }

  private ensureHpBarPair(
    parent: THREE.Object3D,
    key: string,
    yLocal: number,
    fgColor: number,
  ): { bg: THREE.Mesh; fg: THREE.Mesh } {
    const ud = parent.userData as Record<string, unknown>;
    let bg = ud[`${key}_hpBg`] as THREE.Mesh | undefined;
    let fg = ud[`${key}_hpFg`] as THREE.Mesh | undefined;
    if (!bg) {
      bg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.35, 0.12),
        new THREE.MeshBasicMaterial({
          color: 0x1a1f28,
          transparent: true,
          opacity: 0.88,
          depthWrite: false,
        }),
      );
      bg.position.y = yLocal;
      parent.add(bg);
      ud[`${key}_hpBg`] = bg;
    }
    if (!fg) {
      fg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.32, 0.09),
        new THREE.MeshBasicMaterial({
          color: fgColor,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
        }),
      );
      fg.position.y = yLocal;
      fg.position.z = 0.003;
      parent.add(fg);
      ud[`${key}_hpFg`] = fg;
    }
    return { bg: bg!, fg: fg! };
  }

  private setHpBarFrac(pair: { bg: THREE.Mesh; fg: THREE.Mesh }, frac01: number): void {
    const frac = Math.max(0, Math.min(1, frac01));
    pair.fg.scale.x = Math.max(0.02, frac);
    pair.fg.position.x = -0.66 * (1 - frac);
  }

  private setHpBarPairVisible(parent: THREE.Object3D, key: string, visible: boolean): void {
    const ud = parent.userData as Record<string, unknown>;
    const bg = ud[`${key}_hpBg`] as THREE.Mesh | undefined;
    const fg = ud[`${key}_hpFg`] as THREE.Mesh | undefined;
    if (bg) bg.visible = visible;
    if (fg) fg.visible = visible;
  }

  private syncMapDecor(state: GameState): void {
    if (this.decorBuilt) return;
    this.decorBuilt = true;
    const preset = state.map.visual?.groundPreset ?? "solid";
    for (const d of state.map.decor ?? []) {
      let mesh: THREE.Object3D | null = null;
      const color = d.color;
      const baseColor = color ?? 0x3a4657;
      const decorate = (mat: THREE.MeshStandardMaterial, tag: string): THREE.MeshStandardMaterial => {
        mat.map = this.getDecorWrapTexture(preset, tag);
        // Keep the authored biome tint, but lift it enough that the texture map is actually visible.
        mat.color.lerp(new THREE.Color(0xffffff), 0.32);
        mat.needsUpdate = true;
        return mat;
      };
      const blockMat = (tag: string, shade = 1): THREE.ShaderMaterial => makeDecorRockMaterial(preset, tag, shade);
      const accentMat: THREE.Material = d.blocksMovement
        ? blockMat("block_accent", 1.08)
        : decorate(
            new THREE.MeshStandardMaterial({
              color: hsl(baseColor, 0.08),
              roughness: 0.7,
              metalness: 0.08,
            }),
            "detail_accent",
          );
      const shadowMat: THREE.Material = d.blocksMovement
        ? blockMat("block_shadow", 0.72)
        : decorate(
            new THREE.MeshStandardMaterial({
              color: hsl(baseColor, -0.16),
              roughness: 0.95,
              metalness: 0.02,
            }),
            "detail_shadow",
          );
      const crystalMat = new THREE.MeshStandardMaterial({
        color: 0x8fe7ff,
        emissive: 0x164e80,
        emissiveIntensity: 0.55,
        roughness: 0.28,
        metalness: 0.18,
        transparent: true,
        opacity: 0.92,
      });
      const crystalCoreMat = new THREE.MeshStandardMaterial({
        color: 0xd9f7ff,
        emissive: 0x4aa6ff,
        emissiveIntensity: 0.85,
        roughness: 0.18,
        metalness: 0.08,
        transparent: true,
        opacity: 0.78,
      });
      const crystalBaseMat = new THREE.MeshStandardMaterial({
        color: 0x172a3c,
        emissive: 0x08213a,
        emissiveIntensity: 0.32,
        roughness: 0.75,
        metalness: 0.12,
        transparent: true,
        opacity: 0.68,
      });
      if (d.kind === "box") {
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(d.w * 0.96, d.h, d.d * 0.96),
          d.blocksMovement
            ? blockMat("box_block")
            : decorate(
                new THREE.MeshStandardMaterial({
                  color: baseColor,
                  roughness: 0.9,
                  metalness: 0.04,
                }),
                "box_detail",
              ),
        );
        mesh.position.set(d.x, d.h / 2, d.z);
        mesh.rotation.y = ((d.rotYDeg ?? 0) * Math.PI) / 180;
        const cap = new THREE.Mesh(new THREE.BoxGeometry(d.w * 0.82, Math.min(0.34, d.h * 0.08), d.d * 0.82), accentMat);
        cap.position.y = d.h * 0.5 + Math.min(0.18, d.h * 0.04);
        const base = new THREE.Mesh(new THREE.BoxGeometry(d.w * 1.06, Math.min(0.28, d.h * 0.08), d.d * 1.06), shadowMat);
        base.position.y = -d.h * 0.5 + Math.min(0.14, d.h * 0.04);
        mesh.add(cap, base);
        if (d.blocksMovement) {
          const railW = Math.min(0.26, Math.max(0.08, Math.min(d.w, d.d) * 0.08));
          const railA = new THREE.Mesh(new THREE.BoxGeometry(d.w * 0.9, railW, railW), accentMat);
          const railB = railA.clone();
          railA.position.set(0, d.h * 0.18, d.d * 0.5);
          railB.position.set(0, d.h * 0.18, -d.d * 0.5);
          mesh.add(railA, railB);
        }
      } else if (d.kind === "cylinder") {
        const r = d.radius;
        const h = d.h;
        const group = new THREE.Group();
        group.position.set(d.x, 0, d.z);
        group.rotation.y = ((d.rotYDeg ?? 0) * Math.PI) / 180;

        const hoverY = Math.max(0.72, h * 0.55);
        const main = new THREE.Mesh(new THREE.OctahedronGeometry(Math.max(0.36, r * 0.92), 0), crystalMat);
        main.position.y = hoverY;
        main.scale.set(0.92, Math.max(1.25, h / Math.max(0.6, r) * 0.34), 0.92);
        main.rotation.set(0.18, Math.PI / 4, -0.1);

        const core = new THREE.Mesh(new THREE.OctahedronGeometry(Math.max(0.18, r * 0.38), 0), crystalCoreMat);
        core.position.y = hoverY + Math.max(0.04, h * 0.03);
        core.rotation.set(-0.08, Math.PI / 5, 0.16);

        const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.18, Math.max(0.025, r * 0.045), 6, 34), crystalBaseMat);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = Math.max(0.16, h * 0.16);

        const shardCount = 4;
        for (let i = 0; i < shardCount; i++) {
          const a = (i / shardCount) * Math.PI * 2 + Math.PI / 4;
          const shard = new THREE.Mesh(new THREE.OctahedronGeometry(Math.max(0.13, r * 0.24), 0), i % 2 === 0 ? crystalMat : crystalCoreMat);
          shard.position.set(Math.cos(a) * r * 0.82, hoverY * 0.82 + (i % 2) * 0.12, Math.sin(a) * r * 0.82);
          shard.scale.set(0.55, 1.05, 0.55);
          shard.rotation.set(0.2, -a, 0.35);
          group.add(shard);
        }

        group.add(ring, main, core);
        mesh = group;
      } else if (d.kind === "sphere") {
        const r = d.radius;
        const cy = d.y ?? r;
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(r, 20, 16),
          d.blocksMovement
            ? blockMat("sphere_block")
            : decorate(
                new THREE.MeshStandardMaterial({
                  color: color ?? 0x5a6270,
                  roughness: 0.78,
                  metalness: 0.12,
                }),
                "sphere_detail",
              ),
        );
        mesh.position.set(d.x, cy, d.z);
        const chip = new THREE.Mesh(new THREE.IcosahedronGeometry(r * 0.28, 0), accentMat);
        chip.position.set(r * 0.18, r * 0.4, -r * 0.24);
        mesh.add(chip);
      } else if (d.kind === "cone") {
        const r = d.radius;
        const h = d.h;
        const group = new THREE.Group();
        group.position.set(d.x, 0, d.z);
        group.rotation.y = ((d.rotYDeg ?? 0) * Math.PI) / 180;

        const hoverY = Math.max(0.65, h * 0.5);
        const main = new THREE.Mesh(new THREE.OctahedronGeometry(Math.max(0.34, r * 0.88), 0), crystalMat);
        main.position.y = hoverY;
        main.scale.set(0.78, Math.max(1.2, h / Math.max(0.6, r) * 0.3), 0.78);
        main.rotation.set(-0.12, Math.PI / 4, 0.22);

        const lower = new THREE.Mesh(new THREE.OctahedronGeometry(Math.max(0.2, r * 0.45), 0), crystalCoreMat);
        lower.position.y = Math.max(0.28, h * 0.26);
        lower.scale.set(0.65, 0.95, 0.65);
        lower.rotation.set(0.2, -Math.PI / 6, -0.2);

        const halo = new THREE.Mesh(new THREE.TorusGeometry(r * 0.95, Math.max(0.024, r * 0.04), 6, 32), crystalBaseMat);
        halo.rotation.x = Math.PI / 2;
        halo.position.y = Math.max(0.18, h * 0.18);

        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          const chip = new THREE.Mesh(new THREE.OctahedronGeometry(Math.max(0.12, r * 0.22), 0), crystalMat);
          chip.position.set(Math.cos(a) * r * 0.7, hoverY * 0.76, Math.sin(a) * r * 0.7);
          chip.scale.set(0.48, 0.9, 0.48);
          chip.rotation.set(0.3, -a, -0.18);
          group.add(chip);
        }

        group.add(halo, lower, main);
        mesh = group;
      } else if (d.kind === "torus") {
        mesh = new THREE.Mesh(
          new THREE.TorusGeometry(d.radius, d.tube, 14, 40),
          d.blocksMovement
            ? blockMat("torus_block")
            : decorate(
                new THREE.MeshStandardMaterial({
                  color: color ?? 0x3d4555,
                  roughness: 0.8,
                  metalness: 0.18,
                }),
                "torus_detail",
              ),
        );
        mesh.rotation.x = -Math.PI / 2;
        mesh.rotation.y = ((d.rotYDeg ?? 0) * Math.PI) / 180;
        mesh.position.set(d.x, d.tube * 0.5 + 0.02, d.z);
        const core = new THREE.Mesh(new THREE.CylinderGeometry(d.radius * 0.36, d.radius * 0.42, d.tube * 0.75, 18), shadowMat);
        core.position.y = -d.tube * 0.12;
        mesh.add(core);
      }
      if (!mesh) continue;
      mesh.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        obj.castShadow = true;
        obj.receiveShadow = true;
      });
      this.decor.add(mesh);
    }
  }

  private syncCoreOrbs(state: GameState): void {
    const alive = new Set<string>();
    for (const campId of Object.keys(state.enemyCampCoreHp)) alive.add(campId);
    for (const [id, orb] of this.coreOrbs) {
      if (!alive.has(id)) {
        const tex = orb.userData["coreTexture"] as THREE.Texture | undefined;
        tex?.dispose();
        this.markers.remove(orb);
        this.disposeObject(orb);
        this.coreOrbs.delete(id);
      }
    }
    const elapsed = this.clock.getElapsedTime();
    for (const campId of alive) {
      const camp = state.map.enemyCamps.find((c) => c.id === campId);
      if (!camp) continue;
      const hp = state.enemyCampCoreHp[campId] ?? 0;
      const maxHp = camp.coreMaxHp ?? 0;
      if (maxHp <= 0) continue;
      const frac = Math.max(0, Math.min(1, hp / maxHp));
      let orb = this.coreOrbs.get(campId);
      if (!orb) {
        const tex = makeEnemyCoreTexture();
        orb = new THREE.Mesh(
          new THREE.IcosahedronGeometry(1, 3),
          new THREE.MeshStandardMaterial({
            color: 0xb83a32,
            map: tex,
            emissive: 0x2a0610,
            emissiveMap: tex,
            emissiveIntensity: 0.45,
            roughness: 0.82,
            metalness: 0.02,
            transparent: true,
            opacity: 0.82,
          }),
        );
        orb.userData["coreTexture"] = tex;
        this.markers.add(orb);
        this.coreOrbs.set(campId, orb);
      }
      const breathe = 0.08 * Math.sin(elapsed * 2.4);
      const r = 0.58 + frac * 1.02 + breathe;
      orb.scale.setScalar(r);
      orb.position.set(camp.origin.x, 1.55 + breathe * 0.45, camp.origin.z);
      orb.rotation.y = elapsed * 0.35;
      orb.rotation.x = Math.sin(elapsed * 0.5) * 0.08;
      const mat = orb.material as THREE.MeshStandardMaterial;
      mat.opacity = 0.5 + 0.34 * frac;
      mat.emissiveIntensity = 0.18 + 0.45 * frac;
    }
  }

  private ensurePortalRoot(kind: "exit" | "return"): { root: THREE.Group; label: LabelSprite } {
    const existing = this.portalRoots.get(kind);
    if (existing) return existing;
    const root = new THREE.Group();
    root.name = `portal-${kind}`;

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(3.25, 64),
      new THREE.MeshBasicMaterial({
        color: kind === "exit" ? 0x26a7ff : 0x62d8ff,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.09;
    root.add(disc);

    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(2.1 + i * 0.55, 2.22 + i * 0.55, 80),
        new THREE.MeshBasicMaterial({
          color: i === 0 ? 0xbef2ff : i === 1 ? 0x4bbcff : 0x176dff,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.52 - i * 0.1,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.12 + i * 0.025;
      ring.userData["portalRingIndex"] = i;
      root.add(ring);
    }

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 1.35, 1.8, 24, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x62d8ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.17,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    beam.position.y = 0.9;
    root.add(beam);

    const label = makeLabelSprite(kind === "exit" ? "Vibe Jam Portal" : "Return Portal", "#6ae1ff");
    label.sprite.scale.set(9.2, 2.5, 1);
    label.sprite.position.set(0, 4.25, 0);
    root.add(label.sprite);

    this.markers.add(root);
    const pair = { root, label };
    this.portalRoots.set(kind, pair);
    return pair;
  }

  private syncPortals(state: GameState): void {
    const elapsed = this.clock.getElapsedTime();
    const syncOne = (kind: "exit" | "return", pos: { x: number; z: number } | null, active: boolean): void => {
      if (!active || !pos) {
        const existing = this.portalRoots.get(kind);
        if (existing) existing.root.visible = false;
        return;
      }
      const pair = this.ensurePortalRoot(kind);
      pair.root.visible = true;
      pair.root.position.set(pos.x, 0, pos.z);
      const pulse = 1 + Math.sin(elapsed * 3.2 + (kind === "return" ? 1.5 : 0)) * 0.035;
      pair.root.scale.setScalar(pulse);
      drawLabel(pair.label, kind === "exit" ? "Vibe Jam Portal" : "Return Portal", "#6ae1ff");
      for (const child of pair.root.children) {
        const idx = child.userData["portalRingIndex"] as number | undefined;
        if (idx === undefined) continue;
        child.rotation.z = elapsed * (0.35 + idx * 0.18) * (idx % 2 === 0 ? 1 : -1);
        const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        if (mat) mat.opacity = 0.42 - idx * 0.07 + Math.sin(elapsed * 4 + idx) * 0.05;
      }
    };
    syncOne("exit", state.portal.exitPortal, !!state.portal.exitUrl);
    syncOne("return", state.portal.returnPortal, !!state.portal.returnUrl);
  }

  private syncTerritory(state: GameState): void {
    /** Higher fill + rim stroke + outline: territory must read on all maps without guessing. */
    this.syncTerritoryTeam("player", territorySources(state), 0x5fd8ff, 0.46);
    this.syncTerritoryTeam("enemy", enemyTerritorySources(state), 0xff665d, 0.3);
  }

  private territorySourceKey(sources: { x: number; z: number }[]): string {
    return `${GameRenderer.TERRITORY_OVERLAY_STYLE}|${this.worldPlaneHalf.toFixed(1)}|${sources
      .map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)}`)
      .join("|")}`;
  }

  private syncTerritoryTeam(
    team: "player" | "enemy",
    sources: { x: number; z: number }[],
    color: number,
    opacity: number,
  ): void {
    const key = this.territorySourceKey(sources);
    const oldKey = team === "player" ? this.territoryKey : this.enemyTerritoryKey;
    if (key === oldKey) return;
    if (team === "player") this.territoryKey = key;
    else this.enemyTerritoryKey = key;

    this.disposeTerritoryTeam(team);
    if (sources.length === 0) return;

    const half = Math.max(this.worldPlaneHalf, TERRITORY_RADIUS * 2);
    const texture = this.createTerritoryTexture(sources, half);
    /** Hug the floor so grazing angles don't clip before vertical obstacle geometry in the depth buffer. */
    const fieldY = team === "player" ? 0.038 : 0.036;
    const field = new THREE.Mesh(
      new THREE.PlaneGeometry(half * 2, half * 2),
      new THREE.MeshBasicMaterial({
        color,
        map: texture,
        transparent: true,
        opacity,
        depthWrite: false,
        depthTest: true,
        /** Keep it a decal-like floor read: visible over ground, never competing with units or props. */
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        /** Drop bilinear fringe; rim in mask is mostly handled by clipped stroke. */
        alphaTest: 0.022,
        side: THREE.DoubleSide,
      }),
    );
    field.rotation.x = -Math.PI / 2;
    field.position.y = fieldY;
    field.renderOrder = -6;

    this.territoryGroup.add(field);
    const outline = this.createTerritoryOutline(
      sources,
      color,
      team === "player" ? 0.95 : 0.8,
      fieldY + 0.002,
    );
    if (outline) this.territoryGroup.add(outline);

    if (team === "player") {
      this.territoryField = field;
      this.territoryTexture = texture;
      this.territoryOutline = outline;
    } else {
      this.enemyTerritoryField = field;
      this.enemyTerritoryTexture = texture;
      this.enemyTerritoryOutline = outline;
    }
  }

  private disposeTerritoryTeam(team: "player" | "enemy"): void {
    const field = team === "player" ? this.territoryField : this.enemyTerritoryField;
    const texture = team === "player" ? this.territoryTexture : this.enemyTerritoryTexture;
    const outline = team === "player" ? this.territoryOutline : this.enemyTerritoryOutline;
    if (field) {
      this.territoryGroup.remove(field);
      field.geometry.dispose();
      (field.material as THREE.Material).dispose();
    }
    if (texture) texture.dispose();
    if (outline) {
      this.territoryGroup.remove(outline);
      outline.geometry.dispose();
      (outline.material as THREE.Material).dispose();
    }
    if (team === "player") {
      this.territoryField = null;
      this.territoryTexture = null;
      this.territoryOutline = null;
    } else {
      this.enemyTerritoryField = null;
      this.enemyTerritoryTexture = null;
      this.enemyTerritoryOutline = null;
    }
  }

  private createTerritoryTexture(sources: { x: number; z: number }[], half: number): THREE.CanvasTexture {
    /** Higher res so the union edge stays tight to `TERRITORY_RADIUS` in world space (512 was visibly soft vs outline). */
    const size = 1024;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, size, size);
    const scale = size / (half * 2);
    const r2 = TERRITORY_RADIUS * TERRITORY_RADIUS;
    const centroid = sources.reduce(
      (acc, p) => {
        acc.x += p.x;
        acc.z += p.z;
        return acc;
      },
      { x: 0, z: 0 },
    );
    centroid.x /= sources.length;
    centroid.z /= sources.length;
    const maxCentroidD = Math.max(
      TERRITORY_RADIUS,
      ...sources.map((p) => Math.hypot(p.x - centroid.x, p.z - centroid.z) + TERRITORY_RADIUS),
    );
    const smoothstep = (edge0: number, edge1: number, x: number): number => {
      const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(0.0001, edge1 - edge0)));
      return t * t * (3 - 2 * t);
    };

    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      const wz = half - y / scale;
      for (let x = 0; x < size; x++) {
        const wx = x / scale - half;
        let nearestD2 = Infinity;
        for (const p of sources) {
          const dx = wx - p.x;
          const dz = wz - p.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < nearestD2) nearestD2 = d2;
        }
        if (nearestD2 > r2) continue;

        const nearestD = Math.sqrt(nearestD2);
        const edgeT = smoothstep(TERRITORY_RADIUS * 0.54, TERRITORY_RADIUS, nearestD);
        const centroidT = smoothstep(0, maxCentroidD, Math.hypot(wx - centroid.x, wz - centroid.z));
        const ripple = 0.5 + 0.5 * Math.sin(wx * 0.34 + wz * 0.22) * Math.sin(wx * 0.11 - wz * 0.28);
        const alpha = Math.round(255 * Math.min(1, 0.16 + centroidT * 0.3 + edgeT * 0.58 + ripple * 0.08));
        const i = (y * size + x) * 4;
        img.data[i] = 255;
        img.data[i + 1] = 255;
        img.data[i + 2] = 255;
        img.data[i + 3] = alpha;
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  private createTerritoryOutline(
    sources: { x: number; z: number }[],
    color: number,
    opacity: number,
    /** Match the fill plane height (outline was at y=0.16, which parallax-skewed vs the disk on the floor). */
    lineY: number,
  ): THREE.LineSegments | null {
    const positions: number[] = [];
    const segs = 96;
    const r = TERRITORY_RADIUS;
    const coverR2 = (r - 1.2) * (r - 1.2);
    for (let si = 0; si < sources.length; si++) {
      const p = sources[si]!;
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        const am = (a0 + a1) * 0.5;
        const mx = p.x + Math.cos(am) * r;
        const mz = p.z + Math.sin(am) * r;
        let covered = false;
        for (let sj = 0; sj < sources.length; sj++) {
          if (sj === si) continue;
          const o = sources[sj]!;
          const dx = mx - o.x;
          const dz = mz - o.z;
          if (dx * dx + dz * dz < coverR2) {
            covered = true;
            break;
          }
        }
        if (covered) continue;
        positions.push(p.x + Math.cos(a0) * r, lineY, p.z + Math.sin(a0) * r);
        positions.push(p.x + Math.cos(a1) * r, lineY, p.z + Math.sin(a1) * r);
      }
    }
    if (positions.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      depthTest: true,
    });
    const line = new THREE.LineSegments(geo, mat);
    line.renderOrder = -5;
    return line;
  }

  private buildHeroMesh(): THREE.Group {
    const g = new THREE.Group();
    g.scale.setScalar(1.2);
    // Team plinth (blue).
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(1.2, 1.3, 0.22, 28),
      new THREE.MeshStandardMaterial({
        color: 0x2a5c8a,
        roughness: 0.85,
        transparent: true,
        opacity: 0.95,
      }),
    );
    plinth.position.y = 0.11;
    plinth.receiveShadow = true;
    g.add(plinth);
    (g.userData as Record<string, unknown>)["heroPlinthMesh"] = plinth;

    // Placeholder body (will be hidden when GLB loads).
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.75, 1.7, 14),
      new THREE.MeshStandardMaterial({ color: 0x4da3ff, roughness: 0.55, metalness: 0.2, emissive: 0x0a2030 }),
    );
    body.position.y = 0.95;
    body.castShadow = true;
    body.userData["isPlaceholder"] = true;
    g.add(body);
    (g.userData as Record<string, unknown>)["bodyMesh"] = body;

    // Bright cyan rim ring so hero is always visually findable.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.15, 32),
      new THREE.MeshBasicMaterial({
        color: 0x6ae1ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    g.add(ring);
    (g.userData as Record<string, unknown>)["heroFootRingMesh"] = ring;

    const arrow = new THREE.Group();
    arrow.name = "hero-down-arrow";
    const arrowMat = new THREE.MeshBasicMaterial({
      color: 0x8eeaff,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.18, 3), arrowMat);
    cone.rotation.x = Math.PI;
    cone.rotation.z = Math.PI / 3;
    cone.position.y = -0.1;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.72, 10), arrowMat);
    stem.position.y = 0.64;
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(0.44, 0.6, 32),
      new THREE.MeshBasicMaterial({
        color: 0x6ae1ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.68,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 1.12;
    const outerHalo = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 0.84, 36),
      new THREE.MeshBasicMaterial({
        color: 0xbaf7ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    outerHalo.rotation.x = -Math.PI / 2;
    outerHalo.position.y = 1.13;
    arrow.position.y = 4.15;
    arrow.add(cone, stem, halo, outerHalo);
    g.add(arrow);
    (g.userData as Record<string, unknown>)["heroDownArrow"] = arrow;

    return g;
  }

  private buildRivalHeroMesh(): THREE.Group {
    const g = new THREE.Group();
    g.scale.setScalar(1.2);
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(1.2, 1.3, 0.22, 28),
      new THREE.MeshStandardMaterial({
        color: 0x6a2a2a,
        roughness: 0.85,
        transparent: true,
        opacity: 0.95,
      }),
    );
    plinth.position.y = 0.11;
    plinth.receiveShadow = true;
    g.add(plinth);
    (g.userData as Record<string, unknown>)["heroPlinthMesh"] = plinth;

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.75, 1.7, 14),
      new THREE.MeshStandardMaterial({
        color: 0xc44a4a,
        roughness: 0.55,
        metalness: 0.2,
        emissive: 0x300808,
      }),
    );
    body.position.y = 0.95;
    body.castShadow = true;
    body.userData["isPlaceholder"] = true;
    g.add(body);
    (g.userData as Record<string, unknown>)["bodyMesh"] = body;

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.15, 32),
      new THREE.MeshBasicMaterial({
        color: 0xff6a6a,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    g.add(ring);
    (g.userData as Record<string, unknown>)["heroFootRingMesh"] = ring;

    return g;
  }

  /** Wizard-only rim cylinder + floor ring — hide once Meshy GLB is attached like other units (no plinth). */
  private hideHeroPlinthUnderGlb(root: THREE.Object3D): void {
    if (!root.userData["glbRoot"]) return;
    const plinth = root.userData["heroPlinthMesh"] as THREE.Object3D | undefined;
    const ring = root.userData["heroFootRingMesh"] as THREE.Object3D | undefined;
    if (plinth) plinth.visible = false;
    if (ring) ring.visible = false;
  }

  private syncHeroVisualPosition(h: GameState["hero"], current: THREE.Vector2 | null): THREE.Vector2 {
    const visual = current ?? new THREE.Vector2(h.x, h.z);
    const dx = h.x - visual.x;
    const dz = h.z - visual.y;
    const dist = Math.hypot(dx, dz);
    if (dist > 10) {
      // Teleports/respawns should be instant; only smooth normal locomotion ticks.
      visual.set(h.x, h.z);
    } else if (dist > 1e-4) {
      const catchup = 1 - Math.exp(-HERO_VISUAL_RUN_CATCHUP_LAMBDA * this.visualSyncDt);
      visual.x += dx * catchup;
      visual.y += dz * catchup;
    }
    return visual;
  }

  private syncHero(state: GameState): void {
    const h = state.hero;
    if (!this.heroGroup) {
      const g = this.buildHeroMesh();
      this.entities.add(g);
      this.heroGroup = g;
      if (this.useGlb) {
        const placeholder = (g.userData["bodyMesh"] as THREE.Mesh | undefined) ?? null;
        if (placeholder) void requestGlbForHero(placeholder, "player");
      }
    }
    const visual = this.syncHeroVisualPosition(h, this.heroVisualPos);
    this.heroVisualPos = visual;
    this.heroGroup.position.set(visual.x, 0, visual.y);
    this.heroGroup.rotation.y = h.facing;
    this.hideHeroPlinthUnderGlb(this.heroGroup);
    const clickMove = (h.targetX !== null && h.targetZ !== null) || h.moveWaypoints.length > 0;
    let frameTravel = false;
    if (this.heroLocomotionPrev.valid) {
      frameTravel =
        Math.hypot(h.x - this.heroLocomotionPrev.x, h.z - this.heroLocomotionPrev.z) > HERO_LOCOMOTION_EPS;
    }
    this.heroLocomotionPrev = { x: h.x, z: h.z, valid: true };
    const visualLag = Math.hypot(h.x - visual.x, h.z - visual.y);
    const moving = clickMove || frameTravel || visualLag > HERO_LOCOMOTION_EPS;
    if (moving) this.interruptHeroStrikeForRun(this.heroGroup);
    this.setGlbMoveAnimation(this.heroGroup, moving);
    if (this.heroLungeTimer > 0) {
      const p = this.heroLungeTimer / 0.32;
      const amt = 0.38 * Math.sin(p * Math.PI);
      this.heroGroup.position.x += Math.sin(h.facing) * amt;
      this.heroGroup.position.z += Math.cos(h.facing) * amt;
    }

    // HP bar (two thin planes floating above).
    if (!this.heroHpBarBg) {
      const bg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.8, 0.16),
        new THREE.MeshBasicMaterial({ color: 0x202632, transparent: true, opacity: 0.85, depthWrite: false }),
      );
      bg.position.y = 2.85;
      this.heroGroup.add(bg);
      this.heroHpBarBg = bg;
    }
    if (!this.heroHpBarFg) {
      const fg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.76, 0.12),
        new THREE.MeshBasicMaterial({ color: 0x6ae1ff, transparent: true, opacity: 0.95, depthWrite: false }),
      );
      fg.position.y = 2.85;
      fg.position.z = 0.002;
      this.heroGroup.add(fg);
      this.heroHpBarFg = fg;
    }
    const frac = Math.max(0, Math.min(1, h.maxHp > 0 ? h.hp / h.maxHp : 0));
    this.heroHpBarFg.scale.x = Math.max(0.0001, frac);
    this.heroHpBarFg.position.x = -0.88 * (1 - frac);

    const arrow = this.heroGroup.userData["heroDownArrow"] as THREE.Group | undefined;
    if (arrow) {
      const t = this.clock.getElapsedTime();
      arrow.position.y = 4.12 + Math.sin(t * 3.2) * 0.18;
      arrow.rotation.y = -h.facing + Math.sin(t * 1.2) * 0.06;
      const cone = arrow.children[0] as THREE.Mesh | undefined;
      const mat = cone?.material as THREE.MeshBasicMaterial | undefined;
      if (mat) mat.opacity = 0.82 + Math.sin(t * 3.2) * 0.14;
      const outerHalo = arrow.children[3] as THREE.Mesh | undefined;
      if (outerHalo) {
        const pulse = 1 + (0.12 + Math.sin(t * 2.4) * 0.08);
        outerHalo.scale.setScalar(pulse);
      }
    }
  }

  private syncEnemyHero(state: GameState): void {
    const h = state.enemyHero;
    if (!this.enemyHeroGroup) {
      const g = this.buildRivalHeroMesh();
      this.entities.add(g);
      this.enemyHeroGroup = g;
      if (this.useGlb) {
        const placeholder = (g.userData["bodyMesh"] as THREE.Mesh | undefined) ?? null;
        if (placeholder) void requestGlbForHero(placeholder, "enemy");
      }
    }
    this.enemyHeroGroup.visible = h.hp > 0;
    if (h.hp <= 0) {
      this.enemyHeroVisualPos = null;
      return;
    }
    const visual = this.syncHeroVisualPosition(h, this.enemyHeroVisualPos);
    this.enemyHeroVisualPos = visual;
    this.enemyHeroGroup.position.set(visual.x, 0, visual.y);
    this.enemyHeroGroup.rotation.y = h.facing;
    this.hideHeroPlinthUnderGlb(this.enemyHeroGroup);
    const clickMoveE = (h.targetX !== null && h.targetZ !== null) || h.moveWaypoints.length > 0;
    let frameTravelE = false;
    if (this.enemyHeroLocomotionPrev.valid) {
      frameTravelE =
        Math.hypot(h.x - this.enemyHeroLocomotionPrev.x, h.z - this.enemyHeroLocomotionPrev.z) > HERO_LOCOMOTION_EPS;
    }
    this.enemyHeroLocomotionPrev = { x: h.x, z: h.z, valid: true };
    const visualLag = Math.hypot(h.x - visual.x, h.z - visual.y);
    const moving = clickMoveE || frameTravelE || visualLag > HERO_LOCOMOTION_EPS;
    if (moving) this.interruptHeroStrikeForRun(this.enemyHeroGroup);
    this.setGlbMoveAnimation(this.enemyHeroGroup, moving);

    if (!this.enemyHeroHpBarBg) {
      const bg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.8, 0.16),
        new THREE.MeshBasicMaterial({ color: 0x202632, transparent: true, opacity: 0.85, depthWrite: false }),
      );
      bg.position.y = 2.85;
      this.enemyHeroGroup.add(bg);
      this.enemyHeroHpBarBg = bg;
    }
    if (!this.enemyHeroHpBarFg) {
      const fg = new THREE.Mesh(
        new THREE.PlaneGeometry(1.76, 0.12),
        new THREE.MeshBasicMaterial({ color: 0xff7a7a, transparent: true, opacity: 0.95, depthWrite: false }),
      );
      fg.position.y = 2.85;
      fg.position.z = 0.002;
      this.enemyHeroGroup.add(fg);
      this.enemyHeroHpBarFg = fg;
    }
    const frac = Math.max(0, Math.min(1, h.maxHp > 0 ? h.hp / h.maxHp : 0));
    this.enemyHeroHpBarFg.scale.x = Math.max(0.0001, frac);
    this.enemyHeroHpBarFg.position.x = -0.88 * (1 - frac);
  }

  private syncUnits(state: GameState): void {
    const alive = new Set(state.units.map((u) => u.id));
    const attackTargets = new Map<number, Vec2>();
    for (const mark of state.combatHitMarks) {
      if (mark.attackerId === undefined) continue;
      const target = { x: mark.tx, z: mark.tz };
      attackTargets.set(mark.attackerId, target);
    }
    for (const [id, obj] of this.unitMeshes) {
      if (!alive.has(id)) {
        this.startUnitDeathVisual(obj);
        this.unitMeshes.delete(id);
        this.unitCountLabels.delete(id);
        this.unitPrevAttackTick.delete(id);
        this.unitPrevPos.delete(id);
        this.unitVisualPos.delete(id);
        this.unitMotionVisuals.delete(id);
        this.unitFaceTargets.delete(id);
        this.unitLodState.delete(id);
      }
    }

    for (const u of state.units) {
      let obj = this.unitMeshes.get(u.id);
      if (!obj) {
        const g = buildUnitMesh(u.signal, u.team, u.sizeClass);
        this.entities.add(g);
        this.unitMeshes.set(u.id, g);
        obj = g;
        if (this.useGlb) {
          const placeholder = (g.userData["bodyMesh"] as THREE.Mesh | undefined) ?? null;
          if (placeholder) {
            placeholder.visible = false;
            void requestGlbForUnit(u.sizeClass, placeholder, u.team, u.producedUnitId);
          }
        }
      }
      const g = obj as THREE.Group;
      g.userData["unitId"] = u.id;
      g.userData["team"] = u.team;
      g.userData["sizeClass"] = u.sizeClass;
      g.userData["producedUnitId"] = u.producedUnitId;
      const visual = this.unitVisualPos.get(u.id) ?? new THREE.Vector2(u.x, u.z);
      this.unitVisualPos.set(u.id, visual);
      const attackTick = u.lastAttackTick;
      const prevAttackTick = this.unitPrevAttackTick.get(u.id);
      const isNewAttack = attackTick !== undefined && attackTick !== prevAttackTick;
      const committedAttackTarget = attackTargets.get(u.id);
      if (isNewAttack) {
        if (committedAttackTarget) this.unitFaceTargets.set(u.id, committedAttackTarget);
        else this.unitFaceTargets.delete(u.id);
      }
      if (isNewAttack) this.playGlbAttackAnimation(g);
      if (attackTick !== undefined) this.unitPrevAttackTick.set(u.id, attackTick);
      const prevSim = this.unitPrevPos.get(u.id);
      const simFrameDist = prevSim ? Math.hypot(u.x - prevSim.x, u.z - prevSim.y) : 0;
      const prevMotion = this.unitMotionVisuals.get(u.id);
      const wasMoving = prevMotion?.moving ?? false;
      const simDx = u.x - visual.x;
      const simDz = u.z - visual.y;
      const simMoveDist = Math.hypot(simDx, simDz);
      const attackActive = isNewAttack || g.userData["glbAttackTimer"] !== undefined;
      const forceRunCatchup = simMoveDist > (attackActive ? 9.5 : 0.65);
      const orderTargetDist =
        u.order && u.order.mode !== "stay" ? Math.hypot(u.order.x - u.x, u.order.z - u.z) : 0;
      const orderedToMove = orderTargetDist > (wasMoving ? 0.35 : 0.75);
      const travelSignal = Math.max(simFrameDist, simMoveDist);
      const runThreshold = wasMoving ? UNIT_VISUAL_RUN_STOP_EPS : UNIT_VISUAL_RUN_START_EPS;
      const shouldRun =
        (travelSignal > runThreshold || (orderedToMove && simMoveDist > UNIT_VISUAL_RUN_STOP_EPS)) &&
        (!attackActive || forceRunCatchup);
      if (shouldRun && attackActive) {
        const ud = g.userData as Record<string, unknown>;
        const strike = (ud["glbStrikeActive"] ?? ud["glbAttackAction"]) as THREE.AnimationAction | undefined;
        const fade = this.glbAttackOutFadeSec(ud);
        delete g.userData["glbAttackTimer"];
        delete g.userData["glbStrikeActive"];
        if (!this.tryCrossfadeStrikeIntoRun(ud, strike, fade, { forceRun: true })) {
          strike?.fadeOut(fade);
          this.setGlbBaseActionWeight(g, "run", 1);
        }
      }
      // Always ease the mesh toward sim when it has drifted. Previously we froze `visual` for the
      // whole attack clip while `u.x/u.z` kept stepping — Line (long attacks, slower cadence) read
      // as in-place swings then huge teleports when the timer cleared or catch-up fired.
      const visualBeforeX = visual.x;
      const visualBeforeZ = visual.y;
      if (forceRunCatchup) visual.set(u.x, u.z);
      else if (simMoveDist > UNIT_VISUAL_RUN_EPS) {
        const catchup = 1 - Math.exp(-UNIT_VISUAL_RUN_CATCHUP_LAMBDA * this.visualSyncDt);
        visual.x += simDx * catchup;
        visual.y += simDz * catchup;
      } else {
        visual.set(u.x, u.z);
      }
      obj.position.set(visual.x, 0, visual.y);
      if (!attackActive) this.unitFaceTargets.delete(u.id);
      const faceTarget = attackActive && !shouldRun ? this.unitFaceTargets.get(u.id) : undefined;
      this.faceUnitForState(g, faceTarget, shouldRun ? { x: simDx, z: simDz } : null);
      this.updateUnitMotionVisual(
        u.id,
        u.sizeClass,
        shouldRun,
        attackActive,
        isNewAttack,
        visual.x - visualBeforeX,
        visual.y - visualBeforeZ,
      );
      const hpFrac = u.maxHp > 0 ? u.hp / u.maxHp : 0;
      const selected = state.selectedUnitIds.includes(u.id);
      const h = unitMeshLinearSize(u.sizeClass) * 1.22;
      g.userData["unitHeight"] = h;
      const fg = u.team === "player" ? 0x7ec8ff : 0xff8888;
      const pair = this.ensureHpBarPair(g, "u", h, fg);
      this.setHpBarFrac(pair, hpFrac);
      const fgMat = pair.fg.material as THREE.MeshBasicMaterial;
      if (hpFrac < 0.25) fgMat.color.set(0xff4040);
      else if (hpFrac < 0.55) fgMat.color.set(0xffc247);
      else fgMat.color.set(fg);
      fgMat.opacity = selected || hpFrac < 0.995 ? 0.98 : 0.56;
      (pair.bg.material as THREE.MeshBasicMaterial).opacity = selected || hpFrac < 0.995 ? 0.82 : 0.42;
      this.setHpBarPairVisible(g, "u", true);
      this.syncUnitSpellStatusVisuals(g, u);
      let label = this.unitCountLabels.get(u.id);
      if (!label) {
        label = makeLabelSprite("x1", u.team === "player" ? "#7ec8ff" : "#ff8888");
        label.sprite.scale.set(3.2, 0.9, 1);
        g.add(label.sprite);
        this.unitCountLabels.set(u.id, label);
      }
      label.sprite.position.set(0, h + 0.72, 0);
      const liveCount = liveSquadCount(u);
      const maxCount = Math.max(1, u.squadMaxCount ?? u.squadCount ?? 1);
      const countText = maxCount > 1 ? `x${liveCount}` : "";
      drawLabel(label, countText, u.team === "player" ? "#7ec8ff" : "#ff8888");
      label.sprite.visible = maxCount > 1;
      const prevHp = this.unitPrevHp.get(u.id);
      if (prevHp !== undefined && u.hp < prevHp - 0.25) {
        (g.userData as Record<string, unknown>)["unitHitFlash"] = 0.22;
      }
      this.unitPrevHp.set(u.id, u.hp);
      this.setGlbMoveAnimation(g, shouldRun);
      this.unitPrevPos.set(u.id, new THREE.Vector2(u.x, u.z));
    }
    this.applyUnitRenderBudgets(state);
  }

  private applyUnitRenderBudgets(state: GameState): void {
    const unitCount = state.units.length;
    const now = performance.now();
    const candidates: Array<{
      id: number;
      root: THREE.Group;
      tri: number;
      distSq: number;
      keepBoost: number;
      farCullUi: boolean;
    }> = [];

    for (const u of state.units) {
      const root = this.unitMeshes.get(u.id) as THREE.Group | undefined;
      if (!root) continue;
      const glb = root.userData["glbRoot"] as THREE.Object3D | undefined;
      if (!glb) continue;
      const tri = (root.userData["glbTriangleCount"] as number | undefined) ?? 1200;
      const dx = root.position.x - this.camera.position.x;
      const dy = root.position.y - this.camera.position.y;
      const dz = root.position.z - this.camera.position.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const selected = state.selectedUnitIds.includes(u.id);
      const attacking = root.userData["glbAttackTimer"] !== undefined || u.lastAttackTick === state.tick;
      const keepBoost = (selected ? 100000 : 0) + (attacking ? 24000 : 0) + (u.team === "player" ? 6000 : 0);
      candidates.push({
        id: u.id,
        root,
        tri,
        distSq,
        keepBoost,
        farCullUi: unitCount > 340 && distSq > 160 * 160,
      });
    }

    if (candidates.length === 0) return;
    candidates.sort((a, b) => a.distSq - a.keepBoost - (b.distSq - b.keepBoost) || a.tri - b.tri);
    const triBudget =
      unitCount < 120 ? Infinity : unitCount < 240 ? 210_000 : unitCount < 420 ? 165_000 : 125_000;
    let spent = 0;
    for (const c of candidates) {
      spent += c.tri;
      const distancePop = unitCount > 260 && c.distSq > 145 * 145 && c.keepBoost < 50000;
      const budgetPop = spent > triBudget && c.keepBoost < 50000;
      const shouldPlaceholder = distancePop || budgetPop;
      this.setUnitLod(c.root, c.id, shouldPlaceholder, c.farCullUi, now);
    }
  }

  private setUnitLod(root: THREE.Group, id: number, placeholder: boolean, farCullUi: boolean, nowMs: number): void {
    const current = this.unitLodState.get(id);
    if (current && current.placeholder !== placeholder && nowMs < current.nextAllowedMs) {
      placeholder = current.placeholder;
    }

    const glb = root.userData["glbRoot"] as THREE.Object3D | undefined;
    const body = root.userData["bodyMesh"] as THREE.Mesh | undefined;
    // Never pop a loaded GLB back to procedural fallback: even a close match reads
    // as unit size-changing. Placeholder is only for not-yet-loaded/missing art.
    if (glb) {
      glb.visible = true;
      if (body) body.visible = false;
      placeholder = false;
    } else if (body) {
      body.visible = placeholder;
    }

    const stateChanged =
      !current || current.placeholder !== placeholder || current.farCullUi !== farCullUi;
    if (stateChanged) {
      this.unitLodState.set(id, { placeholder, farCullUi, nextAllowedMs: nowMs + 320 });
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.castShadow = !placeholder;
      });
    }
    this.setHpBarPairVisible(root, "u", !farCullUi);
    const label = this.unitCountLabels.get((root.userData["unitId"] as number | undefined) ?? id);
    if (label && farCullUi) label.sprite.visible = false;
  }

  private faceUnitForState(root: THREE.Object3D, attackTarget: Vec2 | undefined, moveDelta: Vec2 | null): void {
    const px = root.position.x;
    const pz = root.position.z;
    let dx = 0;
    let dz = 0;
    if (attackTarget) {
      dx = attackTarget.x - px;
      dz = attackTarget.z - pz;
    }
    if (Math.hypot(dx, dz) <= 0.001 && moveDelta) {
      dx = moveDelta.x;
      dz = moveDelta.z;
    }
    if (Math.hypot(dx, dz) <= 0.001) return;
    const target = Math.atan2(dx, dz);
    const delta = Math.atan2(Math.sin(target - root.rotation.y), Math.cos(target - root.rotation.y));
    root.rotation.y += delta * 0.22;
  }

  private updateUnitMotionVisual(
    id: number,
    sizeClass: UnitSizeClass,
    moving: boolean,
    attackActive: boolean,
    newAttack: boolean,
    visualDx: number,
    visualDz: number,
  ): void {
    const dt = Math.max(1 / 120, this.visualSyncDt);
    let m = this.unitMotionVisuals.get(id);
    if (!m) {
      m = {
        speed: 0,
        targetSpeed: 0,
        velX: 0,
        velZ: 0,
        bobPhase: Math.random() * Math.PI * 2,
        movingBlend: 0,
        leanPitch: 0,
        leanRoll: 0,
        attackKick: 0,
        attackActive: false,
        moving: false,
        sizeClass,
      };
      this.unitMotionVisuals.set(id, m);
    }
    const rawVx = visualDx / dt;
    const rawVz = visualDz / dt;
    const k = 1 - Math.exp(-UNIT_VISUAL_SPEED_LAMBDA * dt);
    m.velX += (rawVx - m.velX) * k;
    m.velZ += (rawVz - m.velZ) * k;
    m.targetSpeed = moving ? Math.hypot(m.velX, m.velZ) : 0;
    m.moving = moving;
    m.attackActive = attackActive;
    m.sizeClass = sizeClass;
    if (newAttack) m.attackKick = Math.max(m.attackKick, 1);
  }

  private syncUnitSpellStatusVisuals(root: THREE.Group, u: GameState["units"][number]): void {
    const ud = root.userData as Record<string, unknown>;
    const statuses = u.spellStatuses ?? [];
    const signature = statuses
      .map((st) => `${st.kind}:${Math.round(st.strength * 100)}`)
      .sort()
      .join("|");
    if (signature && ud["unitSpellStatusFxSig"] === signature && ud["unitSpellStatusFx"]) return;
    const old = ud["unitSpellStatusFx"] as THREE.Group | undefined;
    if (old) {
      root.remove(old);
      this.disposeObject(old);
      delete ud["unitSpellStatusFx"];
      delete ud["unitSpellStatusFxSig"];
    }
    if (statuses.length === 0) return;
    const height = (ud["unitHeight"] as number | undefined) ?? unitMeshLinearSize(u.sizeClass);
    const radius = Math.max(0.42, unitMeshLinearSize(u.sizeClass) * 0.28);
    const group = new THREE.Group();
    group.name = "unit-spell-status-fx";
    const addRing = (color: number, y: number, opacity: number, scale = 1): void => {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius * scale, Math.max(0.025, radius * 0.035), 5, 32),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      group.add(ring);
    };
    for (const st of statuses) {
      const strength = Math.max(0.05, Math.min(1, st.strength));
      if (st.kind === "frozen") {
        const cage = new THREE.Mesh(
          new THREE.IcosahedronGeometry(radius * 1.15, 1),
          new THREE.MeshBasicMaterial({
            color: 0xbff4ff,
            wireframe: true,
            transparent: true,
            opacity: 0.24 + strength * 0.22,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        cage.scale.y = Math.max(1.2, height / Math.max(0.1, radius * 1.8));
        cage.position.y = height * 0.48;
        group.add(cage);
        addRing(0xe8fbff, 0.08, 0.42 * strength, 1.1);
      } else if (st.kind === "rooted") {
        for (let i = 0; i < 5; i++) {
          const a = i * 2.399;
          const vine = new THREE.Mesh(
            new THREE.TorusGeometry(radius * (0.68 + i * 0.055), 0.025, 4, 18, Math.PI * 1.15),
            new THREE.MeshBasicMaterial({
              color: i % 2 ? 0x8affc8 : 0xff66dd,
              transparent: true,
              opacity: 0.28 * strength,
              depthWrite: false,
              blending: THREE.AdditiveBlending,
            }),
          );
          vine.rotation.set(Math.PI / 2, 0, a);
          vine.position.y = 0.12 + i * 0.025;
          group.add(vine);
        }
      } else if (st.kind === "chilled") {
        addRing(0x9ee8ff, 0.1, 0.3 * strength, 0.95);
        addRing(0xffffff, height * 0.55, 0.16 * strength, 0.55);
      } else if (st.kind === "burning") {
        addRing(0xff7a16, 0.12, 0.36 * strength, 0.9);
        addRing(0xfff0a8, height * 0.32, 0.18 * strength, 0.52);
      } else if (st.kind === "winded") {
        addRing(0xd7fff2, height * 0.28, 0.18 * strength, 1.05);
        addRing(0x8df5d3, height * 0.62, 0.14 * strength, 0.82);
      }
    }
    if (group.children.length === 0) return;
    root.add(group);
    ud["unitSpellStatusFx"] = group;
    ud["unitSpellStatusFxSig"] = signature;
  }

  private tickUnitProceduralMotion(dt: number): void {
    const ease = 1 - Math.exp(-10.5 * dt);
    for (const [id, root] of this.unitMeshes) {
      const m = this.unitMotionVisuals.get(id);
      if (!m) continue;
      m.speed += (m.targetSpeed - m.speed) * ease;
      m.movingBlend += ((m.moving ? 1 : 0) - m.movingBlend) * (1 - Math.exp(-(m.moving ? 8.5 : 5.2) * dt));
      m.attackKick = Math.max(0, m.attackKick - dt * 3.2);

      const L = unitMeshLinearSize(m.sizeClass);
      const cadence = m.sizeClass === "Swarm" ? 7.8 : m.sizeClass === "Line" ? 6.2 : m.sizeClass === "Heavy" ? 4.6 : 3.4;
      const stride = Math.min(1.8, Math.max(0.35, m.speed / Math.max(1.2, L)));
      m.bobPhase += dt * cadence * stride * (0.35 + m.movingBlend * 0.65);

      const yaw = root.rotation.y;
      const localForward = Math.sin(yaw) * m.velX + Math.cos(yaw) * m.velZ;
      const localSide = Math.cos(yaw) * m.velX - Math.sin(yaw) * m.velZ;
      const leanScale = (m.sizeClass === "Titan" ? 0.015 : m.sizeClass === "Heavy" ? 0.021 : 0.027) / Math.max(1, L);
      const targetPitch =
        THREE.MathUtils.clamp(-localForward * leanScale, -0.13, 0.13) * m.movingBlend -
        Math.sin(m.attackKick * Math.PI) * (m.sizeClass === "Titan" ? 0.055 : 0.075);
      const targetRoll =
        THREE.MathUtils.clamp(-localSide * leanScale, -0.11, 0.11) * m.movingBlend +
        Math.sin(m.bobPhase) * 0.018 * m.movingBlend;
      m.leanPitch += (targetPitch - m.leanPitch) * ease;
      m.leanRoll += (targetRoll - m.leanRoll) * ease;

      const bob = Math.abs(Math.sin(m.bobPhase)) * L * 0.022 * m.movingBlend;
      const settle = Math.sin(m.attackKick * Math.PI) * L * 0.025;
      this.applyUnitMotionPose(root, bob - settle, m.leanPitch, m.leanRoll);
    }
  }

  private applyUnitMotionPose(root: THREE.Object3D, yOffset: number, pitch: number, roll: number): void {
    const targets = [
      root.userData["glbRoot"] as THREE.Object3D | undefined,
      root.userData["bodyMesh"] as THREE.Object3D | undefined,
    ].filter((x): x is THREE.Object3D => !!x);
    for (const target of targets) {
      const ud = target.userData as Record<string, unknown>;
      if (ud["unitMotionBaseY"] === undefined) {
        ud["unitMotionBaseY"] = target.position.y;
        ud["unitMotionBaseRotX"] = target.rotation.x;
        ud["unitMotionBaseRotZ"] = target.rotation.z;
      }
      const baseY = ud["unitMotionBaseY"] as number;
      const baseRotX = ud["unitMotionBaseRotX"] as number;
      const baseRotZ = ud["unitMotionBaseRotZ"] as number;
      target.position.y = baseY + yOffset;
      target.rotation.x = baseRotX + pitch;
      target.rotation.z = baseRotZ + roll;
    }
  }

  private orientHpBars(): void {
    const cam = this.camera.position;
    const orient = (root: THREE.Object3D): void => {
      const ud = root.userData as Record<string, unknown>;
      for (const key of ["u", "st", "relay", "tapA"] as const) {
        const bg = ud[`${key}_hpBg`] as THREE.Mesh | undefined;
        const fg = ud[`${key}_hpFg`] as THREE.Mesh | undefined;
        if (bg) bg.lookAt(cam);
        if (fg) fg.lookAt(cam);
      }
    };
    for (const g of this.unitMeshes.values()) orient(g);
    for (const g of this.structureMeshes.values()) orient(g);
    for (const m of this.relayMeshes.values()) orient(m);
    for (const g of this.tapAnchorRoots.values()) orient(g);
    if (this.heroGroup && this.heroHpBarBg && this.heroHpBarFg) {
      this.heroHpBarBg.lookAt(cam);
      this.heroHpBarFg.lookAt(cam);
    }
    if (this.enemyHeroGroup && this.enemyHeroHpBarBg && this.enemyHeroHpBarFg) {
      this.enemyHeroHpBarBg.lookAt(cam);
      this.enemyHeroHpBarFg.lookAt(cam);
    }
  }

  /** Lock mode: move orbit pivot with the hero; camera moves by the same delta so zoom (scroll) is unchanged. */
  private applyHeroCameraFollow(dt: number): void {
    if (!this.cameraFollowHero && this.cameraFollowUnitId === null) return;
    this.nudgeCameraRigTowardFollowPivot(dt);
  }

  private tickHitPulses(dt: number): void {
    const pulse = (root: THREE.Object3D): void => {
      const ud = root.userData as Record<string, unknown>;
      const t = ud["hitPulse"] as number | undefined;
      if (t === undefined || t <= 0) return;
      const next = t - dt;
      const body = ud["bodyMesh"] as THREE.Mesh | undefined;
      if (next <= 0) {
        ud["hitPulse"] = undefined;
        if (body) body.scale.setScalar(1);
        return;
      }
      ud["hitPulse"] = next;
      const k = 1 + 0.12 * Math.sin((next / 0.22) * Math.PI);
      if (body) body.scale.setScalar(k);
    };
    for (const g of this.unitMeshes.values()) pulse(g);
    for (const g of this.structureMeshes.values()) pulse(g);
    for (const m of this.relayMeshes.values()) pulse(m);
    for (const g of this.tapAnchorRoots.values()) pulse(g);
    if (this.enemyHeroGroup) pulse(this.enemyHeroGroup);
  }

  private tickGlbAnimations(dt: number): void {
    const unitCount = this.unitMeshes.size;
    const mixerDt = Math.min(RENDER_VISUAL_DT_CAP_SEC, Math.max(0, dt));

    let clampBudget = unitCount >= 240 ? 2 : unitCount >= 90 ? 4 : 10;
    const tick = (root: THREE.Object3D | null, allowClamp: boolean): void => {
      const ud = root?.userData as Record<string, unknown> | undefined;
      const mixer = ud?.["glbMixer"] as THREE.AnimationMixer | undefined;
      if (mixer && mixerDt > 0) mixer.update(mixerDt);
      const clampChecks = (ud?.["glbClampChecksRemaining"] as number | undefined) ?? 0;
      if (root && allowClamp && clampChecks > 0 && clampBudget > 0 && ud?.["allowRuntimeGlbScaleClamp"] === true) {
        this.clampUnitGlbScale(root);
        ud!["glbClampChecksRemaining"] = clampChecks - 1;
        clampBudget--;
      }
      const timer = ud?.["glbAttackTimer"] as number | undefined;
      if (timer === undefined) return;
      const next = timer - dt;
      if (next > 0) {
        ud!["glbAttackTimer"] = next;
        return;
      }
      delete ud!["glbAttackTimer"];
      if (root) this.endGlbAttackReturnToLocomotion(root, ud!);
    };
    for (const g of this.unitMeshes.values()) tick(g, true);
    for (const g of this.structureMeshes.values()) tick(g, false);
    tick(this.heroGroup, false);
    tick(this.enemyHeroGroup, false);
    for (let i = this.dyingUnits.length - 1; i >= 0; i--) {
      const d = this.dyingUnits[i]!;
      tick(d.obj, false);
      const p = 1 - Math.max(0, Math.min(1, d.timer / d.life));
      this.applyUnitDissolve(d.obj, p);
      for (let j = 0; j < d.particles.length; j++) {
        const mote = d.particles[j]!;
        const mat = mote.material as THREE.MeshBasicMaterial;
        const drift = 0.05 + j * 0.018;
        mote.position.y += (0.38 + j * 0.08) * dt;
        mote.position.x += Math.sin(p * Math.PI + j * 1.7) * drift * dt;
        mote.position.z += Math.cos(p * Math.PI + j * 1.3) * drift * dt;
        mote.scale.setScalar(Math.max(0.02, 1 - p * 0.7));
        mat.opacity = 0.42 * (1 - p);
      }
      d.timer -= dt;
      if (d.timer > 0) continue;
      this.entities.remove(d.obj);
      this.disposeObject(d.obj);
      this.dyingUnits.splice(i, 1);
    }
  }

  private clampUnitGlbScale(root: THREE.Object3D): void {
    const ud = root.userData as Record<string, unknown>;
    const glb = ud["glbRoot"] as THREE.Object3D | undefined;
    const target = ud["glbTargetMaxExtent"] as number | undefined;
    if (!glb || !(typeof target === "number") || target <= 0) return;

    const basis = (ud["glbExtentBasis"] as GlbExtentBasis | undefined) ?? "max";
    const box = this.localBoundsForObject(glb, root);
    if (box.isEmpty()) return;
    const size = new THREE.Vector3();
    box.getSize(size);
    const ref = glbBoxExtentRef(size, basis);
    if (!Number.isFinite(ref) || ref <= 1e-5) return;

    // Hard safety cage: animated art must not blow past its class target; shrink only.
    // Uses the same extent basis as load-time normalization (height-first for squads).
    if (ref > target * 1.12) {
      glb.scale.multiplyScalar(target / ref);
      glb.updateMatrixWorld(true);
    }
  }

  private localBoundsForObject(obj: THREE.Object3D, relativeTo: THREE.Object3D): THREE.Box3 {
    obj.updateMatrixWorld(true);
    relativeTo.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(relativeTo.matrixWorld).invert();
    const out = new THREE.Box3();
    const tmp = new THREE.Box3();
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      const skinned = m as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh) skinned.computeBoundingBox();
      else m.geometry.computeBoundingBox();
      const bb = skinned.isSkinnedMesh ? skinned.boundingBox : m.geometry.boundingBox;
      if (!bb) return;
      tmp.copy(bb).applyMatrix4(m.matrixWorld).applyMatrix4(inv);
      out.union(tmp);
    });
    return out;
  }

  /** Crossfade window for run ↔ idle (sim-smoothed mesh vs. choppy pops). */
  private glbLocomotionCrossfadeSec(ud: Record<string, unknown>): number {
    const sc = ud["sizeClass"];
    if (sc === "Titan") return 0.28;
    if (sc === "hero") return 0.22;
    if (sc === "Swarm" || sc === "Line") return 0.24;
    if (sc === "Heavy") return 0.22;
    return 0.2;
  }

  /** Attack clip fade-out / recovery into locomotion (tick end, interrupt, hero run break). */
  private glbAttackOutFadeSec(ud: Record<string, unknown>): number {
    if (
      ud["producedUnitId"] === PRODUCED_UNIT_AMBER_GEODE_MONKS ||
      ud["producedUnitId"] === PRODUCED_UNIT_LAVA_WIZARD_MONKS ||
      ud["producedUnitId"] === PRODUCED_UNIT_CHRONO_SENTINELS
    )
      return 0.42;
    if (ud["sizeClass"] === "Titan") return 0.38;
    if (ud["sizeClass"] === "hero") return 0.28;
    if (ud["sizeClass"] === "Swarm" || ud["sizeClass"] === "Line") return 0.34;
    return 0.32;
  }

  /** Attack clip fade-in at swing start (overlaps base underlay). */
  private glbAttackInFadeSec(ud: Record<string, unknown>): number {
    if (
      ud["producedUnitId"] === PRODUCED_UNIT_AMBER_GEODE_MONKS ||
      ud["producedUnitId"] === PRODUCED_UNIT_LAVA_WIZARD_MONKS ||
      ud["producedUnitId"] === PRODUCED_UNIT_CHRONO_SENTINELS
    )
      return 0.24;
    if (ud["sizeClass"] === "Titan") return 0.22;
    if (ud["sizeClass"] === "hero") return 0.2;
    if (ud["sizeClass"] === "Swarm" || ud["sizeClass"] === "Line") return 0.2;
    if (ud["sizeClass"] === "Heavy") return 0.19;
    return 0.18;
  }

  /**
   * Fades the strike out while fading run in (THREE.AnimationAction.crossFadeFrom).
   * Returns false when recovery should use idle or there is no run clip.
   */
  private tryCrossfadeStrikeIntoRun(
    ud: Record<string, unknown>,
    strike: THREE.AnimationAction | undefined,
    fadeSec: number,
    opts?: { forceRun?: boolean },
  ): boolean {
    if (!strike) return false;
    const wantIdle = opts?.forceRun ? false : ud["glbBaseState"] === "idle";
    const run = ud["glbRunAction"] as THREE.AnimationAction | undefined;
    if (wantIdle || !run || run === strike) return false;
    run.enabled = true;
    run.paused = false;
    run.play();
    run.crossFadeFrom(strike, fadeSec, false);
    ud["glbBaseState"] = "run";
    ud["glbBaseFadeUntilMs"] = performance.now() + fadeSec * 1000;
    return true;
  }

  /** Called when `glbAttackTimer` reaches zero: strike → locomotion without snapping base weight. */
  private endGlbAttackReturnToLocomotion(root: THREE.Object3D | null, ud: Record<string, unknown>): void {
    const fade = this.glbAttackOutFadeSec(ud);
    const activeStrike = ud["glbStrikeActive"] as THREE.AnimationAction | undefined;
    const attackDefault = ud["glbAttackAction"] as THREE.AnimationAction | undefined;
    const strike = activeStrike ?? attackDefault;
    const wantIdle = ud["glbBaseState"] === "idle";
    const idle = ud["glbIdleAction"] as THREE.AnimationAction | undefined;
    if (root && strike && this.tryCrossfadeStrikeIntoRun(ud, strike, fade)) {
      delete ud["glbStrikeActive"];
      return;
    }
    if (activeStrike) {
      activeStrike.fadeOut(fade);
      delete ud["glbStrikeActive"];
    } else if (attackDefault) {
      attackDefault.fadeOut(fade);
    }
    if (root) this.setGlbBaseActionWeight(root, wantIdle && idle ? "idle" : "run", 1);
  }

  private setGlbBaseActionWeight(
    root: THREE.Object3D,
    state: "run" | "idle",
    weight: number,
    opts?: { preserveActiveFade?: boolean },
  ): void {
    const ud = root.userData as Record<string, unknown>;
    const run = ud["glbRunAction"] as THREE.AnimationAction | undefined;
    const idle = ud["glbIdleAction"] as THREE.AnimationAction | undefined;
    const resolvedState = state === "idle" && idle ? "idle" : "run";
    const action = resolvedState === "idle" ? idle : run;
    if (!action) return;
    action.enabled = true;
    action.paused = false;
    action.play();
    const fadeUntil = ud["glbBaseFadeUntilMs"] as number | undefined;
    if (opts?.preserveActiveFade && ud["glbBaseState"] === resolvedState && fadeUntil !== undefined && performance.now() < fadeUntil) {
      return;
    }
    action.stopFading();
    action.setEffectiveWeight(weight);
    ud["glbBaseState"] = resolvedState;
  }

  private interruptHeroStrikeForRun(root: THREE.Object3D): void {
    const ud = root.userData as Record<string, unknown>;
    if (ud["sizeClass"] !== "hero" || ud["glbAttackTimer"] === undefined) return;
    const strike = (ud["glbStrikeActive"] ?? ud["glbAttackAction"]) as THREE.AnimationAction | undefined;
    const attackDefault = ud["glbAttackAction"] as THREE.AnimationAction | undefined;
    const fade = this.glbAttackOutFadeSec(ud);
    delete ud["glbAttackTimer"];
    delete ud["glbStrikeActive"];
    if (!this.tryCrossfadeStrikeIntoRun(ud, strike, fade, { forceRun: true })) {
      strike?.fadeOut(fade * 0.85);
      if (attackDefault && attackDefault !== strike) attackDefault.fadeOut(fade * 0.85);
      this.setGlbBaseActionWeight(root, "run", 1);
    }
  }

  private playGlbAttackAnimation(root: THREE.Object3D): void {
    const ud = root.userData as Record<string, unknown>;
    const attackDefault = ud["glbAttackAction"] as THREE.AnimationAction | undefined;
    const strikePool = ud["glbHeroStrikeActions"] as THREE.AnimationAction[] | undefined;
    const strikeDurs = ud["glbHeroStrikeDurations"] as number[] | undefined;
    const isHero = ud["sizeClass"] === "hero";
    const attack =
      isHero && strikePool && strikePool.length > 0
        ? strikePool[Math.floor(Math.random() * strikePool.length)]!
        : attackDefault;
    if (!attack) return;
    if (ud["glbAttackTimer"] !== undefined) return;
    const titan = ud["sizeClass"] === "Titan";
    const producedId = ud["producedUnitId"] as string | undefined;
    const punchyLineMonks =
      producedId === PRODUCED_UNIT_AMBER_GEODE_MONKS ||
      producedId === PRODUCED_UNIT_LAVA_WIZARD_MONKS ||
      producedId === PRODUCED_UNIT_CHRONO_SENTINELS;
    const minDuration = punchyLineMonks
      ? 2.02
      : ud["sizeClass"] === "hero"
        ? 1.78
        : ud["sizeClass"] === "Swarm"
          ? 3.1
          : ud["sizeClass"] === "Line"
            ? 4.35
            : titan
              ? 3.35
              : 3.05;
    let duration = Math.max(minDuration, (ud["glbAttackDuration"] as number | undefined) ?? minDuration);
    if (isHero && strikePool && strikePool.length > 0) {
      const idx = strikePool.indexOf(attack);
      if (idx >= 0 && strikeDurs && strikeDurs[idx] !== undefined) {
        duration = Math.max(minDuration, strikeDurs[idx]!);
      }
    }
    const inFade = this.glbAttackInFadeSec(ud);
    const baseUnderlay = this.glbBaseUnderlayDuringAttack(ud);
    this.setGlbBaseActionWeight(root, ud["glbBaseState"] === "idle" ? "idle" : "run", baseUnderlay);
    if (attackDefault && attack !== attackDefault) {
      attackDefault.fadeOut(Math.max(0.1, inFade * 0.55));
    }
    ud["glbStrikeActive"] = attack;
    attack.enabled = true;
    attack.reset();
    attack.setEffectiveWeight(1);
    attack.fadeIn(inFade);
    attack.play();
    ud["glbAttackTimer"] = duration;
  }

  private cloneMaterialsForDissolve(root: THREE.Object3D): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      if (mesh.userData["dissolveMaterialCloned"]) return;
      if (Array.isArray(mesh.material)) mesh.material = mesh.material.map((m) => m.clone());
      else mesh.material = mesh.material.clone();
      mesh.userData["dissolveMaterialCloned"] = true;
    });
  }

  private applyUnitDissolve(root: THREE.Object3D, p: number): void {
    const opacity = Math.max(0, 1 - p);
    const squash = Math.max(0.58, 1 - p * 0.24);
    root.scale.set(1 + p * 0.08, squash, 1 + p * 0.08);
    root.position.y = -p * 0.08;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const raw of mats) {
        const mat = raw as THREE.Material & { opacity?: number; transparent?: boolean; depthWrite?: boolean };
        if (typeof mat.opacity !== "number") continue;
        mat.transparent = true;
        mat.depthWrite = false;
        mat.opacity = opacity;
      }
    });
  }

  private makeDeathMotes(root: THREE.Object3D): THREE.Mesh[] {
    const ud = root.userData as Record<string, unknown>;
    const team = ud["team"] === "enemy" ? "enemy" : "player";
    const color = team === "enemy" ? 0xff8a70 : 0x8fdcff;
    const titan = ud["sizeClass"] === "Titan";
    const motes: THREE.Mesh[] = [];
    const size = Math.max(0.05, ((ud["unitHeight"] as number | undefined) ?? 1.5) * (titan ? 0.045 : 0.035));
    const count = titan ? 6 : 4;
    for (let i = 0; i < count; i++) {
      const mote = new THREE.Mesh(
        new THREE.IcosahedronGeometry(size * (0.75 + i * 0.08), 0),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.42,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      const a = i * 2.399;
      const r = (titan ? 0.22 : 0.12) + i * (titan ? 0.055 : 0.035);
      mote.position.set(Math.cos(a) * r, (titan ? 0.32 : 0.18) + i * 0.11, Math.sin(a) * r);
      root.add(mote);
      motes.push(mote);
    }
    return motes;
  }

  private startUnitDeathVisual(root: THREE.Object3D): void {
    const ud = root.userData as Record<string, unknown>;
    if (ud["unitDying"]) return;
    ud["unitDying"] = true;
    this.cloneMaterialsForDissolve(root);
    this.setHpBarPairVisible(root, "u", false);
    const label = this.unitCountLabels.get(ud["unitId"] as number);
    if (label) label.sprite.visible = false;
    const particles = this.makeDeathMotes(root);
    const titan = ud["sizeClass"] === "Titan";
    if (titan) {
      spawnCastFx(this.fx, "death_flash", { x: root.position.x, z: root.position.z }, {
        impactRadius: Math.max(2.4, ((ud["unitHeight"] as number | undefined) ?? 3) * 0.36),
        rangeBand: "long",
      });
    }
    const life = titan ? 0.68 : 0.42;
    this.startGlbDeathAnimation(root);
    this.dyingUnits.push({ obj: root, timer: life, life, particles });
  }

  private startGlbDeathAnimation(root: THREE.Object3D): void {
    const ud = root.userData as Record<string, unknown>;
    const death = ud["glbDeathAction"] as THREE.AnimationAction | undefined;
    if (!death) return;
    const dFade = 0.26;
    for (const key of ["glbRunAction", "glbIdleAction", "glbAttackAction"] as const) {
      const a = ud[key] as THREE.AnimationAction | undefined;
      if (a) a.fadeOut(dFade);
    }
    death.enabled = true;
    death.reset();
    death.setEffectiveWeight(0);
    death.fadeIn(dFade);
    death.play();
  }

  /** Base locomotion weight under an active attack crossfade (must match `playGlbAttackAnimation`). */
  private glbBaseUnderlayDuringAttack(ud: Record<string, unknown>): number {
    const producedId = ud["producedUnitId"] as string | undefined;
    const punchyLineMonks =
      producedId === PRODUCED_UNIT_AMBER_GEODE_MONKS ||
      producedId === PRODUCED_UNIT_LAVA_WIZARD_MONKS ||
      producedId === PRODUCED_UNIT_CHRONO_SENTINELS;
    const titan = ud["sizeClass"] === "Titan";
    // Lower run cross-weight so baked root motion in the slam / punch clip is not double-driven (twitchy).
    return punchyLineMonks ? 0.34 : titan ? 0.42 : ud["sizeClass"] === "Swarm" ? 0.58 : 0.62;
  }

  private setGlbMoveAnimation(root: THREE.Object3D, moving: boolean): void {
    const ud = root.userData as Record<string, unknown>;
    const inAttack = ud["glbAttackTimer"] !== undefined;
    const baseW = inAttack ? this.glbBaseUnderlayDuringAttack(ud) : 1;
    const run = ud["glbRunAction"] as THREE.AnimationAction | undefined;
    const idle = ud["glbIdleAction"] as THREE.AnimationAction | undefined;
    if (!run) return;
    // While an attack clip is active, `playGlbAttackAnimation` owns the run/idle underlay. Driving
    // run↔idle from smoothed sim motion here fights that (shouldRun is false whenever attackActive
    // without force catch-up), which reads as constant snapping — especially on Swarm/Line.
    if (inAttack) {
      const pinned = (ud["glbBaseState"] as "run" | "idle" | undefined) ?? "run";
      this.setGlbBaseActionWeight(root, pinned === "idle" && idle ? "idle" : "run", baseW, {
        preserveActiveFade: true,
      });
      return;
    }
    const next = (moving || !idle ? "run" : "idle") as "run" | "idle";
    if (ud["glbBaseState"] === next) {
      this.setGlbBaseActionWeight(root, next, baseW, { preserveActiveFade: true });
      return;
    }
    const from = next === "run" ? idle : run;
    const to = next === "run" ? run : idle;
    if (!to) return;
    const moveFade = this.glbLocomotionCrossfadeSec(ud);
    if (from && from !== to) from.fadeOut(moveFade);
    to.enabled = true;
    to.paused = false;
    to.play();
    to.fadeIn(moveFade);
    ud["glbBaseState"] = next;
    ud["glbBaseFadeUntilMs"] = performance.now() + moveFade * 1000;
  }

  render(): void {
    const now = performance.now();
    const dt = Math.min(RENDER_VISUAL_DT_CAP_SEC, Math.max(0, (now - this.lastRenderFrameMs) / 1000));
    this.lastRenderFrameMs = now;
    this.tickMatchIntroCinematic();
    this.applyHeroCameraFollow(dt);
    this.controls.update();
    this.tickGlbAnimations(dt);
    this.tickUnitProceduralMotion(dt);
    this.tickHitPulses(dt);
    this.orientHpBars();
    stepFx(this.fx, dt);
    this.renderer.render(this.scene, this.camera);
    this.heroLungeTimer = Math.max(0, this.heroLungeTimer - dt);
  }
}
