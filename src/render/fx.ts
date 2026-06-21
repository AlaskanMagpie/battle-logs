import * as THREE from "three";
import {
  FX_ABSOLUTE_MAX_LIFETIME_SEC,
  PRODUCED_UNIT_AMBER_GEODE_MONKS,
  PRODUCED_UNIT_LAVA_WIZARD_MONKS,
} from "../game/constants";
import type { CastFxKind, CombatHitMark, HeroStrikeFxVariant } from "../game/state";
import {
  ELEMENTAL_FX_REQUIRED_SHAPES,
  SPELL_FX_ELEMENTS,
  type AttackRangeBand,
  type ElementalFxRequiredShape,
  type SpellFxElement,
  type SpellFxShape,
} from "../game/types";

export type CastFxSpawnOpts = {
  from?: { x: number; z: number };
  strikeVariant?: HeroStrikeFxVariant;
  impactRadius?: number;
  rangeBand?: AttackRangeBand;
  element?: SpellFxElement;
  secondaryElement?: SpellFxElement;
  shape?: SpellFxShape;
  reach?: number;
  width?: number;
  visualSeed?: number;
};

/**
 * Rudimentary, procedural cast/damage FX. One shared group registered on the scene;
 * each event creates a few short-lived meshes that are animated per-frame via `step(dt)`
 * and disposed when their lifetime elapses.
 */
export interface FxHost {
  group: THREE.Group;
  active: ActiveFx[];
}

interface ActiveFx {
  age: number;
  life: number;
  /** Wall-clock start for hard cap (handles stuck/zero `dt` or driver quirks). */
  createdAtMs: number;
  node: THREE.Object3D;
  update: (t: number, dt: number) => void;
  dispose: () => void;
}

export function createFxHost(scene: THREE.Scene): FxHost {
  const group = new THREE.Group();
  group.name = "fx";
  scene.add(group);
  return { group, active: [] };
}

export function stepFx(host: FxHost, dt: number): void {
  const now = performance.now();
  const maxWallMs = FX_ABSOLUTE_MAX_LIFETIME_SEC * 1000;
  // Compact survivors in place rather than allocating a fresh `keep` array every
  // frame — this runs on every render frame, so the per-frame array was steady
  // GC pressure. Survivors are written back to the front; order is preserved.
  const active = host.active;
  let w = 0;
  for (let r = 0; r < active.length; r++) {
    const fx = active[r]!;
    fx.age += dt;
    fx.update(fx.age, dt);
    const wallMs = now - fx.createdAtMs;
    if (fx.age < fx.life && wallMs < maxWallMs) {
      active[w++] = fx;
    } else {
      fx.node.visible = false;
      try {
        host.group.remove(fx.node);
      } catch {
        /* already detached */
      }
      try {
        fx.dispose();
      } catch {
        /* ignore double-dispose */
      }
    }
  }
  active.length = w;
}

/** Remove every active FX (e.g. rematch) so nothing lingers in the scene graph. */
export function clearFx(host: FxHost): void {
  for (const fx of host.active) {
    fx.node.visible = false;
    try {
      host.group.remove(fx.node);
    } catch {
      /* ignore */
    }
    try {
      fx.dispose();
    } catch {
      /* ignore */
    }
  }
  host.active = [];
}

function disposeTree(obj: THREE.Object3D): void {
  obj.traverse((c) => {
    // THREE.Sprite shares a single module-level geometry across every sprite, so
    // disposing it here would free GPU buffers still used by live sprites. Skip it.
    if (!(c instanceof THREE.Sprite)) {
      const geo = "geometry" in c ? (c as { geometry?: THREE.BufferGeometry }).geometry : undefined;
      if (geo && typeof geo.dispose === "function") geo.dispose();
    }
    const m = "material" in c ? (c as { material?: THREE.Material | THREE.Material[] }).material : undefined;
    if (!m) return;
    if (Array.isArray(m)) for (const mm of m) mm?.dispose();
    else m.dispose();
  });
}

function spawn(host: FxHost, node: THREE.Object3D, life: number, update: ActiveFx["update"]): void {
  host.group.add(node);
  host.active.push({
    age: 0,
    life: Math.min(life, FX_ABSOLUTE_MAX_LIFETIME_SEC),
    createdAtMs: performance.now(),
    node,
    update,
    dispose: () => disposeTree(node),
  });
}

export function spawnCastFx(
  host: FxHost,
  kind: CastFxKind,
  pos: { x: number; z: number },
  opts?: CastFxSpawnOpts,
): void {
  switch (kind) {
    case "firestorm":
      return spawnFirestorm(host, pos, opts?.impactRadius);
    case "combat_boom":
      return spawnCombatBoom(host, pos, opts?.impactRadius ?? 8, opts?.rangeBand ?? "medium");
    case "shatter":
      return spawnShatter(host, pos, opts?.impactRadius);
    case "fortify":
      return spawnFortify(host, pos, opts?.impactRadius);
    case "muster":
      return spawnMuster(host, pos);
    case "line_cleave":
      return spawnLineCleave(host, pos, opts?.from, opts?.impactRadius);
    case "claim":
      return spawnClaim(host, pos);
    case "lightning":
      return spawnLightning(host, pos);
    case "hero_strike":
      return spawnHeroStrike(host, pos, opts?.from, opts?.strikeVariant, opts?.visualSeed);
    case "spark_burst":
      return spawnSparkBurst(host, pos);
    case "ground_crack":
      return spawnGroundCrack(host, pos);
    case "reclaim_pulse":
      return spawnReclaimPulse(host, pos);
    case "death_flash":
      return spawnDeathFlash(host, pos, opts?.impactRadius ?? 1.5, opts?.rangeBand ?? "close");
    case "elemental_spell":
      return spawnElementalSpell(host, pos, opts);
  }
}

function mulHex(c: number, r: number, g: number, b: number): number {
  const col = new THREE.Color(c);
  col.r *= r;
  col.g *= g;
  col.b *= b;
  return col.getHex();
}

/** Elemental identity: signal school first, then unit class, then team bias. */
function elementalCombatPalette(m: CombatHitMark): {
  core: number;
  glow: number;
  rim: number;
  spark: number;
} {
  const enemy = m.team === "enemy";
  const biasR = enemy ? 1.08 : 0.92;
  const biasB = enemy ? 0.88 : 1.08;
  const sig = m.signal;
  let core = 0x66ccff;
  let glow = 0xffffff;
  let rim = 0xaaddff;
  let spark = 0xe8f6ff;
  if (sig === "Vanguard") {
    core = 0xff5a38;
    glow = 0xffcc88;
    rim = 0xff2200;
    spark = 0xffeeaa;
  } else if (sig === "Bastion") {
    core = 0x7eb8ff;
    glow = 0xffffff;
    rim = 0x4466aa;
    spark = 0xc8e8ff;
  } else if (sig === "Reclaim") {
    core = 0xc86bff;
    glow = 0x7dffc8;
    rim = 0xff66dd;
    spark = 0xf0ddff;
  } else {
    switch (m.sizeClass) {
      case "Swarm":
        core = 0xe8ff44;
        glow = 0xffffcc;
        rim = 0x88ffaa;
        spark = 0xffffff;
        break;
      case "Line":
        core = 0x44ddff;
        glow = 0xccffff;
        rim = 0x2288cc;
        spark = 0xe0ffff;
        break;
      case "Heavy":
        core = 0xff8833;
        glow = 0xffdd88;
        rim = 0xaa2200;
        spark = 0xffccaa;
        break;
      case "Titan":
        core = 0xdda8ff;
        glow = 0xffffff;
        rim = 0x8844cc;
        spark = 0xf8e8ff;
        break;
      default:
        break;
    }
  }
  if (m.trait === "lifesteal") {
    rim = mulHex(rim, 0.85, 1.12, 0.95);
    spark = mulHex(spark, 0.7, 1.05, 0.85);
  }
  core = mulHex(core, biasR, 1, biasB);
  rim = mulHex(rim, biasR, 1, biasB);
  spark = mulHex(spark, biasR, 1, biasB);
  return { core, glow, rim, spark };
}

function rnd(seed: number, i: number): number {
  const u = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return u - Math.floor(u);
}

interface ElementalPalette {
  core: number;
  hot: number;
  rim: number;
  trail: number;
  shadow: number;
}

type ElementalFxContract = {
  /** Required gameplay silhouettes every element must render: line, cone, ranged AOE, centered AOE, surprise. */
  requiredShapes: readonly ElementalFxRequiredShape[];
  /** The element's bespoke "surprise me" renderer route. Exhaustive by `SpellFxElement`. */
  surpriseShape: Exclude<SpellFxShape, "surprise">;
};

export const ELEMENTAL_FX_CONTRACT: Record<SpellFxElement, ElementalFxContract> = {
  fire: { requiredShapes: ELEMENTAL_FX_REQUIRED_SHAPES, surpriseShape: "meteor" },
  lightning: { requiredShapes: ELEMENTAL_FX_REQUIRED_SHAPES, surpriseShape: "chain" },
  earth: { requiredShapes: ELEMENTAL_FX_REQUIRED_SHAPES, surpriseShape: "burst" },
  water: { requiredShapes: ELEMENTAL_FX_REQUIRED_SHAPES, surpriseShape: "line" },
  air: { requiredShapes: ELEMENTAL_FX_REQUIRED_SHAPES, surpriseShape: "cone" },
  lava: { requiredShapes: ELEMENTAL_FX_REQUIRED_SHAPES, surpriseShape: "meteor" },
  snow: { requiredShapes: ELEMENTAL_FX_REQUIRED_SHAPES, surpriseShape: "burst" },
  arcane: { requiredShapes: ELEMENTAL_FX_REQUIRED_SHAPES, surpriseShape: "field" },
  reclaim: { requiredShapes: ELEMENTAL_FX_REQUIRED_SHAPES, surpriseShape: "beam" },
  shield: { requiredShapes: ELEMENTAL_FX_REQUIRED_SHAPES, surpriseShape: "field" },
};

export function elementalFxContractElements(): readonly SpellFxElement[] {
  return SPELL_FX_ELEMENTS;
}

function spellPalette(element: SpellFxElement): ElementalPalette {
  switch (element) {
    case "fire":
      return { core: 0xfff1aa, hot: 0xff6a22, rim: 0xff2400, trail: 0xffc65a, shadow: 0x7c1d10 };
    case "lightning":
      return { core: 0xffffff, hot: 0xaeeaff, rim: 0x4ab6ff, trail: 0xd8f6ff, shadow: 0x153d88 };
    case "earth":
      return { core: 0xffd7a0, hot: 0xb98955, rim: 0x5f4631, trail: 0xd1b080, shadow: 0x231910 };
    case "water":
      return { core: 0xe8ffff, hot: 0x52d8ff, rim: 0x187dff, trail: 0x9affee, shadow: 0x0a3155 };
    case "air":
      return { core: 0xd7fff2, hot: 0x8df5d3, rim: 0x59bfff, trail: 0xe8fff6, shadow: 0x244455 };
    case "lava":
      return { core: 0xfff0a8, hot: 0xff7a16, rim: 0xd61f00, trail: 0xffb13b, shadow: 0x35120b };
    case "snow":
      return { core: 0xffffff, hot: 0xbff4ff, rim: 0x78bfff, trail: 0xe8fbff, shadow: 0x42607d };
    case "reclaim":
      return { core: 0xf2ddff, hot: 0x8affc8, rim: 0xff66dd, trail: 0xc86bff, shadow: 0x2b1742 };
    case "shield":
      return { core: 0xe8fbff, hot: 0x8ff2ff, rim: 0x5f8cff, trail: 0xffdf88, shadow: 0x12365f };
    case "arcane":
    default:
      return { core: 0xffffff, hot: 0xc8a8ff, rim: 0x7650ff, trail: 0xaaccff, shadow: 0x24154c };
  }
}

function fxMat(
  color: number,
  opacity: number,
  additive = true,
  side: THREE.Side = THREE.DoubleSide,
): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    side,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

function elementalSeed(pos: { x: number; z: number }, opts?: CastFxSpawnOpts): number {
  return opts?.visualSeed ?? pos.x * 0.173 + pos.z * 0.319 + performance.now() * 0.001;
}

// ---------------------------------------------------------------------------
// Volumetric FX toolkit
//
// The old combat reads were flat: triangle-fan ground cones, 2px tracer lines,
// and ring planes. They read as "2D zaps" from the battle camera. This toolkit
// builds genuinely volumetric primitives — camera-facing soft-particle clouds
// (THREE.Points, one draw call), swept tube streams, and torus shock rings — so
// every attack has depth and body from any angle, the way bending arcs do in
// Avatar. Textures are created lazily (the test runner is a DOM-less Node env).
// ---------------------------------------------------------------------------

let _softPuffTex: THREE.Texture | null = null;
/**
 * Soft radial alpha sprite — the building block for volumetric particle puffs.
 * A bright, tight core fading through a long soft tail reads like glowing
 * energy/embers under additive blending rather than a flat disc.
 */
function softPuffTexture(): THREE.Texture {
  if (_softPuffTex) return _softPuffTex;
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.92)");
  g.addColorStop(0.42, "rgba(255,255,255,0.45)");
  g.addColorStop(0.72, "rgba(255,255,255,0.12)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  _softPuffTex = tex;
  return tex;
}

/**
 * A volumetric particle cloud: many soft camera-facing puffs in a single
 * draw call. Positions/velocities are owned here so callers can advect them
 * each frame (rise, swirl, gravity) for a true 3D body of fire/water/dust.
 */
interface VolCloud {
  points: THREE.Points;
  mat: THREE.PointsMaterial;
  geo: THREE.BufferGeometry;
  pos: Float32Array;
  vel: Float32Array;
  /** Per-particle phase used for turbulence/swirl wobble. */
  phase: Float32Array;
  count: number;
  baseOpacity: number;
  baseSize: number;
}

/**
 * Build a volumetric particle cloud (single draw call). When `accent` is given,
 * particles are tinted in a hot→cool band (vertex colors) so the body has depth
 * — a white-hot core fading to a cooler smoke edge — instead of one flat hue.
 */
function makeVolCloud(count: number, color: number, size: number, opacity: number, accent?: number): VolCloud {
  const pos = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) phase[i] = (i * 1.6180339887) % (Math.PI * 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const matParams: THREE.PointsMaterialParameters = {
    size,
    map: softPuffTexture(),
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  };
  if (accent !== undefined) {
    const colors = new Float32Array(count * 3);
    const base = new THREE.Color(color);
    const acc = new THREE.Color(accent);
    const tmp = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const t = (i % 3) / 2; // 3-tone banding: hot / mid / cool
      tmp.copy(base).lerp(acc, t);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    matParams.vertexColors = true;
  } else {
    matParams.color = color;
  }
  const mat = new THREE.PointsMaterial(matParams);
  const points = new THREE.Points(geo, mat);
  // Local-space frustum culling on a tiny initial bound wrongly culls the cloud
  // as particles fly outward; FX are short-lived so skip culling entirely.
  points.frustumCulled = false;
  return { points, mat, geo, pos, vel, phase, count, baseOpacity: opacity, baseSize: size };
}

function setCloudParticle(
  c: VolCloud,
  i: number,
  px: number,
  py: number,
  pz: number,
  vx: number,
  vy: number,
  vz: number,
): void {
  c.pos[i * 3] = px;
  c.pos[i * 3 + 1] = py;
  c.pos[i * 3 + 2] = pz;
  c.vel[i * 3] = vx;
  c.vel[i * 3 + 1] = vy;
  c.vel[i * 3 + 2] = vz;
}

/**
 * Advect every particle by its velocity with gravity + drag, flag GPU upload.
 * `t`/`swirl` add per-particle curl turbulence so smoke and flame churn and
 * billow instead of drifting in dead-straight lines.
 */
function advectCloud(c: VolCloud, dt: number, gravity: number, drag: number, t = 0, swirl = 0): void {
  const damp = Math.max(0, 1 - drag * dt);
  for (let i = 0; i < c.count; i++) {
    c.vel[i * 3 + 1] -= gravity * dt;
    c.vel[i * 3] *= damp;
    c.vel[i * 3 + 1] *= damp;
    c.vel[i * 3 + 2] *= damp;
    c.pos[i * 3] += c.vel[i * 3] * dt;
    c.pos[i * 3 + 1] += c.vel[i * 3 + 1] * dt;
    c.pos[i * 3 + 2] += c.vel[i * 3 + 2] * dt;
    if (swirl !== 0) {
      const ph = c.phase[i]!;
      c.pos[i * 3] += Math.sin(t * 5.0 + ph) * swirl * dt;
      c.pos[i * 3 + 2] += Math.cos(t * 4.3 + ph * 1.7) * swirl * dt;
      c.pos[i * 3 + 1] += Math.sin(t * 3.1 + ph * 0.7) * swirl * 0.5 * dt;
    }
  }
  (c.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
}

/** Tapered volumetric tube swept through control points — an elemental stream/lance/whip. */
function volumetricStream(
  controlPoints: THREE.Vector3[],
  radius: number,
  color: number,
  opacity: number,
  tubularSeg = 22,
  radialSeg = 8,
): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(controlPoints);
  const geo = new THREE.TubeGeometry(curve, tubularSeg, radius, radialSeg, false);
  const mesh = new THREE.Mesh(geo, fxMat(color, opacity));
  mesh.frustumCulled = false;
  return mesh;
}

/** Flat-lying volumetric torus — a shockwave ring with real cross-section, not a ring plane. */
function volumetricShockRing(innerRadius: number, tubeRadius: number, color: number, opacity: number): THREE.Mesh {
  const geo = new THREE.TorusGeometry(innerRadius, tubeRadius, 8, 28);
  const mesh = new THREE.Mesh(geo, fxMat(color, opacity));
  mesh.rotation.x = -Math.PI / 2;
  mesh.frustumCulled = false;
  return mesh;
}

/** Camera-facing soft glow billboard — focal core/impact flash with volumetric falloff. */
function glowSprite(color: number, size: number, opacity: number): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: softPuffTexture(),
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const s = new THREE.Sprite(mat);
  s.scale.setScalar(size);
  return s;
}

/**
 * Anime-style impact starburst — a few elongated screen-facing light streaks
 * radiating from the hit point that stab outward and snap-fade. Adds a sharp,
 * satisfying "crack" of energy to a heavy impact. Pushes its own anim steps.
 */
function addImpactStar(
  group: THREE.Group,
  anim: CombatStrikeStep[],
  x: number,
  y: number,
  z: number,
  color: number,
  spikes: number,
  len: number,
  delay = 0,
): void {
  for (let k = 0; k < spikes; k++) {
    const mat = new THREE.SpriteMaterial({
      map: softPuffTexture(),
      color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      rotation: (k / spikes) * Math.PI,
    });
    const s = new THREE.Sprite(mat);
    s.position.set(x, y, z);
    group.add(s);
    anim.push((p) => {
      const lp = delay > 0 ? Math.max(0, (p - delay) / (1 - delay)) : p;
      const a = Math.sin(Math.min(1, lp * 2.4) * Math.PI);
      mat.opacity = 0.9 * a;
      s.scale.set(0.14 * len, len * (0.45 + lp * 1.15), 1);
    });
  }
}

/**
 * A vertical light shaft erupting upward from the impact — a soft billboard
 * anchored at its base so it shoots up like vented energy / a god-ray, then
 * fades. Sells the verticality of a heavy strike without a hard geometry beam.
 */
function addLightShaft(
  group: THREE.Group,
  anim: CombatStrikeStep[],
  x: number,
  baseY: number,
  z: number,
  color: number,
  width: number,
  height: number,
): void {
  const s = glowSprite(color, 1, 0);
  s.center.set(0.5, 0); // anchor the bottom edge at `position` so it grows upward
  s.position.set(x, baseY, z);
  group.add(s);
  anim.push((p) => {
    const a = Math.sin(Math.min(1, p * 1.8) * Math.PI);
    (s.material as THREE.SpriteMaterial).opacity = 0.55 * a;
    s.scale.set(width * (1 - p * 0.3), height * (0.5 + p * 0.85), 1);
  });
}

/** Self-contained impact starburst (for FX functions that don't keep an anim list). */
function addImpactStarFx(
  host: FxHost,
  x: number,
  y: number,
  z: number,
  color: number,
  spikes: number,
  len: number,
  life: number,
): void {
  const group = new THREE.Group();
  const anim: CombatStrikeStep[] = [];
  addImpactStar(group, anim, x, y, z, color, spikes, len);
  spawn(host, group, life, (t) => {
    const p = t >= life ? 1 : t / life;
    for (let i = 0; i < anim.length; i++) anim[i]!(p, t, 0);
  });
}

function spawnElementalSpell(host: FxHost, pos: { x: number; z: number }, opts?: CastFxSpawnOpts): void {
  const element = opts?.element ?? "arcane";
  const shape = opts?.shape ?? "impact";
  const pal = spellPalette(element);
  if (shape === "surprise") return spawnElementalSurprise(host, pos, opts, pal, element);
  switch (shape) {
    case "bolt":
      return spawnElementalBolt(host, pos, opts, pal);
    case "chain":
      return spawnElementalChainLightning(host, pos, opts, pal);
    case "beam":
      return spawnElementalLine(host, pos, opts, pal, true);
    case "line":
      return spawnElementalLine(host, pos, opts, pal, false);
    case "cone":
      if (element === "air") return spawnElementalAirCone(host, pos, opts, pal);
      return spawnElementalCone(host, pos, opts, pal);
    case "field":
      return spawnElementalField(host, pos, opts, pal);
    case "meteor":
      return element === "fire" || element === "lava"
        ? spawnElementalFireMeteor(host, pos, opts, pal)
        : spawnElementalMeteor(host, pos, opts, pal);
    case "aoe":
      return spawnElementalAoe(host, pos, opts, pal, false);
    case "impact":
    case "burst":
    default:
      return spawnElementalAoe(host, pos, opts, pal, true);
  }
}

function withShape(opts: CastFxSpawnOpts | undefined, shape: SpellFxShape): CastFxSpawnOpts {
  return { ...(opts ?? {}), shape };
}

function spawnElementalSurprise(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
  element: SpellFxElement,
): void {
  const surprise = ELEMENTAL_FX_CONTRACT[element].surpriseShape;
  switch (element) {
    case "fire":
      return spawnElementalFireMeteor(host, pos, { ...withShape(opts, surprise), impactRadius: (opts?.impactRadius ?? 9) * 1.15 }, pal);
    case "lightning":
      return spawnElementalChainLightning(host, pos, { ...withShape(opts, surprise), impactRadius: (opts?.impactRadius ?? 10) * 1.12 }, pal);
    case "earth":
      return spawnElementalGeodeImpact(host, pos, { ...withShape(opts, surprise), impactRadius: (opts?.impactRadius ?? 8) * 1.2 }, pal, false);
    case "water":
      return spawnElementalWaterSpiral(host, pos, opts, pal);
    case "air":
      return spawnElementalAirBurst(host, pos, { ...withShape(opts, surprise), impactRadius: (opts?.impactRadius ?? 8) * 1.18 }, pal, false);
    case "lava":
      return spawnElementalLavaGeyser(host, pos, opts, pal);
    case "snow":
      return spawnElementalSnowBlizzard(host, pos, opts, pal);
    case "arcane":
      return spawnElementalArcaneRift(host, pos, opts, pal);
    case "reclaim":
      return spawnElementalReclaimBloom(host, pos, opts, pal);
    case "shield":
      return spawnElementalShieldBastion(host, pos, opts, pal);
  }
}

function makeSoftSmokeMat(opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: 0x2a201c,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
}

function spawnElementalBolt(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
): void {
  const life = 0.36;
  const root = new THREE.Group();
  const seed = elementalSeed(pos, opts);
  const from = opts?.from;
  const dist = from ? Math.hypot(pos.x - from.x, pos.z - from.z) : 18;
  const segs = Math.max(7, Math.min(24, Math.round(dist * 0.7)));
  const jitter = Math.max(0.32, Math.min(2.2, dist * 0.075));

  let mainPts: THREE.Vector3[];
  if (from) {
    mainPts = boltPointsToVectors(heroStrikeBoltPoints(from.x, from.z, pos.x, pos.z, segs, jitter, seed));
  } else {
    const pts: number[] = [];
    const skyY = Math.max(18, opts?.impactRadius ? opts.impactRadius * 1.6 : 22);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const fall = 1 - t;
      const amp = Math.sin(t * Math.PI) * jitter;
      pts.push(pos.x + (rnd(seed, i) - 0.5) * amp, 0.25 + skyY * fall, pos.z + (rnd(seed, i + 29) - 0.5) * amp);
    }
    mainPts = boltPointsToVectors(pts);
  }
  const tub = Math.max(28, segs * 3);
  const shell = volumetricStream(mainPts, 0.22, pal.rim, 0, tub, 7);
  const core = volumetricStream(mainPts, 0.09, pal.core, 0, tub, 6);
  root.add(shell);
  root.add(core);
  const shellMat = shell.material as THREE.MeshBasicMaterial;
  const coreMat = core.material as THREE.MeshBasicMaterial;

  const forkMats: THREE.MeshBasicMaterial[] = [];
  const forkCount = from ? 2 : 3;
  for (let k = 0; k < forkCount; k++) {
    let fpts: THREE.Vector3[];
    if (from) {
      fpts = boltPointsToVectors(
        heroStrikeBoltPoints(from.x, from.z, pos.x, pos.z, Math.max(5, segs - 2), jitter * 0.72, seed + 11 + k),
      );
    } else {
      const pts: number[] = [];
      const len = 4.5 + rnd(seed, k + 90) * 3.5;
      const ang = rnd(seed, k + 100) * Math.PI * 2;
      for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        pts.push(
          pos.x + Math.cos(ang) * len * t + (rnd(seed, i + k * 13) - 0.5) * 0.35,
          0.4 + (1 - t) * (4 + k * 0.7),
          pos.z + Math.sin(ang) * len * t + (rnd(seed, i + k * 19) - 0.5) * 0.35,
        );
      }
      fpts = boltPointsToVectors(pts);
    }
    const fork = volumetricStream(fpts, 0.05, k % 2 === 0 ? pal.hot : pal.trail, 0, tub, 5);
    root.add(fork);
    forkMats.push(fork.material as THREE.MeshBasicMaterial);
  }

  const ring = volumetricShockRing(0.3, 0.08, pal.rim, 0.78);
  ring.position.set(pos.x, 0.1, pos.z);
  root.add(ring);
  const bloom = glowSprite(pal.core, 1.5, 0);
  bloom.position.set(pos.x, 0.5, pos.z);
  root.add(bloom);

  const burst = makeVolCloud(7, pal.trail, 0.42, 0);
  burst.points.position.set(pos.x, 0, pos.z);
  for (let i = 0; i < 7; i++) {
    const ang = rnd(seed, i + 60) * Math.PI * 2;
    const sp = 1.8 + rnd(seed, i + 70) * 2.6;
    setCloudParticle(burst, i, 0, 0.4, 0, Math.cos(ang) * sp, 1.4 + rnd(seed, i + 80) * 2.4, Math.sin(ang) * sp);
  }
  root.add(burst.points);
  addImpactStarFx(host, pos.x, 0.5, pos.z, pal.core, 4, 3.0, life);

  spawn(host, root, life, (t, dt) => {
    const p = t >= life ? 1 : t / life;
    const snap = t < 0.16 ? 1 : Math.max(0, 1 - (t - 0.16) / (life - 0.16));
    const flicker = 0.62 + 0.38 * Math.abs(Math.sin(t * 110));
    coreMat.opacity = 0.95 * snap * flicker;
    shellMat.opacity = 0.4 * snap * flicker;
    for (const fm of forkMats) fm.opacity = 0.5 * snap * flicker;
    ring.scale.setScalar(1 + p * 4.3);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.78 * (1 - p);
    const a = Math.sin(Math.min(1, p * 2.2) * Math.PI);
    (bloom.material as THREE.SpriteMaterial).opacity = 0.75 * a;
    bloom.scale.setScalar(1.5 + p * 1.3);
    advectCloud(burst, dt, 6, 1.2, t, 1.5);
    burst.mat.opacity = 0.7 * (1 - p);
  });
}

function spawnElementalChainLightning(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
): void {
  const life = 0.46;
  const root = new THREE.Group();
  const seed = elementalSeed(pos, opts);
  const from = opts?.from;
  const radius = Math.max(4, opts?.impactRadius ?? 10);
  const start = from ?? { x: pos.x + (rnd(seed, 1) - 0.5) * radius, z: pos.z + (rnd(seed, 2) - 0.5) * radius };
  const mainDist = Math.hypot(pos.x - start.x, pos.z - start.z);
  const mainSegs = Math.max(8, Math.min(22, Math.round(mainDist * 0.85)));
  const bolts: { mat: THREE.MeshBasicMaterial; base: number }[] = [];
  const makeBolt = (
    ax: number,
    az: number,
    bx: number,
    bz: number,
    color: number,
    opacity: number,
    radiusTube: number,
    jitterMul: number,
    idx: number,
  ): void => {
    const d = Math.hypot(bx - ax, bz - az);
    const pts = boltPointsToVectors(
      heroStrikeBoltPoints(
        ax,
        az,
        bx,
        bz,
        Math.max(5, Math.min(18, Math.round(d * 0.75))),
        Math.max(0.35, d * 0.08 * jitterMul),
        seed + idx * 19,
      ),
    );
    const tube = volumetricStream(pts, radiusTube, color, 0, Math.max(24, Math.round(d * 2)), 6);
    bolts.push({ mat: tube.material as THREE.MeshBasicMaterial, base: opacity });
    root.add(tube);
  };
  makeBolt(start.x, start.z, pos.x, pos.z, pal.core, 0.98, 0.1, 1.05, 0);
  makeBolt(start.x, start.z, pos.x, pos.z, pal.rim, 0.45, 0.22, 1.55, 1);

  const branchCount = 4;
  for (let i = 0; i < branchCount; i++) {
    const t = 0.2 + rnd(seed, i + 20) * 0.62;
    const bx = start.x + (pos.x - start.x) * t;
    const bz = start.z + (pos.z - start.z) * t;
    const a = rnd(seed, i + 30) * Math.PI * 2;
    const len = radius * (0.25 + rnd(seed, i + 40) * 0.32);
    makeBolt(bx, bz, bx + Math.cos(a) * len, bz + Math.sin(a) * len, i % 2 === 0 ? pal.hot : pal.trail, 0.46, 0.06, 1.2, i + 3);
  }

  const impact = volumetricShockRing(0.3, 0.1, pal.core, 0.88);
  impact.position.set(pos.x, 0.12, pos.z);
  root.add(impact);
  const corona = glowSprite(pal.hot, 1.6, 0);
  corona.position.set(pos.x, 0.55, pos.z);
  root.add(corona);

  const sparks = makeVolCloud(8, pal.trail, 0.4, 0);
  sparks.points.position.set(pos.x, 0, pos.z);
  for (let i = 0; i < 8; i++) {
    const a = rnd(seed, i + 50) * Math.PI * 2;
    const sp = 2 + rnd(seed, i + 55) * 3;
    setCloudParticle(sparks, i, 0, 0.4, 0, Math.cos(a) * sp, 1.6 + rnd(seed, i + 65) * 2.8, Math.sin(a) * sp);
  }
  root.add(sparks.points);
  addImpactStarFx(host, pos.x, 0.55, pos.z, pal.core, 5, 3.4, life);

  spawn(host, root, life, (t, dt) => {
    const p = t >= life ? 1 : t / life;
    const snap = t < 0.21 ? 1 : Math.max(0, 1 - (t - 0.21) / (life - 0.21));
    const flicker = 0.54 + 0.46 * Math.abs(Math.sin(t * 137 + mainSegs));
    for (const b of bolts) b.mat.opacity = b.base * snap * flicker;
    impact.scale.setScalar(1 + p * radius * 0.28);
    (impact.material as THREE.MeshBasicMaterial).opacity = 0.88 * (1 - p);
    const a = Math.sin(Math.min(1, p * 2) * Math.PI);
    (corona.material as THREE.SpriteMaterial).opacity = 0.55 * a;
    corona.scale.setScalar(1.6 + p * radius * 0.18);
    advectCloud(sparks, dt, 6, 1);
    sparks.mat.opacity = 0.7 * (1 - p);
  });
}

function spawnElementalLine(
  host: FxHost,
  end: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
  focused: boolean,
): void {
  if (opts?.element === "water" || pal.shadow === 0x0a3155) return spawnElementalWaterLine(host, end, opts, pal, focused);
  const from = opts?.from;
  if (!from) return spawnElementalAoe(host, end, opts, pal, true);
  const dx = end.x - from.x;
  const dz = end.z - from.z;
  const dist = Math.hypot(dx, dz);
  const L = Math.max(1, opts?.reach ?? dist);
  if (L < 0.5) return;
  const width = Math.max(0.45, opts?.width ?? opts?.impactRadius ?? (focused ? 1.7 : 5.5));
  const halfW = width * 0.5;
  const life = focused ? 0.42 : 0.68;
  const group = new THREE.Group();
  const ux = dx / (dist || 1);
  const uz = dz / (dist || 1);
  const ex = from.x + ux * L;
  const ez = from.z + uz * L;
  group.position.set((from.x + ex) * 0.5, 0.12, (from.z + ez) * 0.5);
  group.rotation.y = Math.atan2(ux, uz);

  // Volumetric beam — a tapered tube core inside a soft shell, running the
  // length of the corridor in local Z, instead of flat boxes and rail lines.
  const y = focused ? 0.5 : 0.32;
  const beamPts = [
    new THREE.Vector3(0, y, -L * 0.5),
    new THREE.Vector3(0, y + (focused ? 0.07 : 0.03), 0),
    new THREE.Vector3(0, y, L * 0.5),
  ];
  const coreR = focused ? 0.14 : Math.max(0.32, halfW * 0.5);
  const shellR = focused ? 0.36 : Math.max(0.7, halfW);
  const shell = volumetricStream(beamPts, shellR, focused ? pal.hot : pal.rim, 0, 22, 8);
  const core = volumetricStream(beamPts, coreR, focused ? pal.core : pal.hot, 0, 22, 6);
  group.add(shell);
  group.add(core);
  const shellMat = shell.material as THREE.MeshBasicMaterial;
  const coreMat = core.material as THREE.MeshBasicMaterial;

  const seed = elementalSeed(end, opts);
  const moteCount = focused ? 6 : Math.min(22, Math.max(9, Math.round(L * 0.22)));
  const motes = makeVolCloud(moteCount, pal.trail, focused ? 0.32 : 0.52, 0);
  for (let i = 0; i < moteCount; i++) {
    const z = -L * 0.45 + rnd(seed, i) * L * 0.9;
    setCloudParticle(
      motes,
      i,
      (rnd(seed, i + 10) - 0.5) * width,
      y + rnd(seed, i + 20) * 0.4,
      z,
      (rnd(seed, i + 30) - 0.5) * 1.3,
      1.1 + rnd(seed, i + 40) * 1.8,
      (rnd(seed, i + 50) - 0.5) * 2.2,
    );
  }
  group.add(motes.points);

  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    const pulse = 1 + Math.sin(p * Math.PI) * (focused ? 0.1 : 0.16);
    core.scale.set(pulse, pulse, 1);
    shell.scale.set(pulse, pulse, 1);
    coreMat.opacity = (focused ? 0.85 : 0.4) * (1 - p);
    shellMat.opacity = (focused ? 0.4 : 0.22) * (1 - p * 0.9);
    advectCloud(motes, dt, 5.8, 0.8, t, 1.2);
    motes.mat.opacity = (focused ? 0.8 : 0.7) * (1 - p);
  });
}

function spawnElementalWaterLine(
  host: FxHost,
  end: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
  focused: boolean,
): void {
  const from = opts?.from;
  if (!from) return spawnElementalAoe(host, end, opts, pal, true);
  const dx = end.x - from.x;
  const dz = end.z - from.z;
  const dist = Math.hypot(dx, dz);
  const L = Math.max(1, opts?.reach ?? dist);
  const width = Math.max(1.2, opts?.width ?? opts?.impactRadius ?? 5.5);
  const life = 0.9;
  const group = new THREE.Group();
  const ux = dx / (dist || 1);
  const uz = dz / (dist || 1);
  const ex = from.x + ux * L;
  const ez = from.z + uz * L;
  group.position.set((from.x + ex) * 0.5, 0.12, (from.z + ez) * 0.5);
  group.rotation.y = Math.atan2(ux, uz);

  const wash = new THREE.Mesh(new THREE.BoxGeometry(width, 0.08, L), fxMat(pal.rim, focused ? 0.14 : 0.18));
  wash.position.y = 0.02;
  group.add(wash);

  const waves: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; offset: number; side: number }[] = [];
  const waveCount = Math.min(9, Math.max(4, Math.round(L / 7)));
  for (let i = 0; i < waveCount; i++) {
    const mat = fxMat(i % 2 === 0 ? pal.core : pal.trail, 0.58);
    const wave = new THREE.Mesh(new THREE.TorusGeometry(width * (0.18 + (i % 3) * 0.025), 0.035, 5, 34, Math.PI * 1.15), mat);
    wave.rotation.x = Math.PI / 2;
    wave.rotation.z = i % 2 === 0 ? 0 : Math.PI;
    wave.position.set((i % 2 === 0 ? -1 : 1) * width * 0.18, 0.2, -L * 0.48 + (i / Math.max(1, waveCount - 1)) * L);
    waves.push({ mesh: wave, mat, offset: i / waveCount, side: i % 2 === 0 ? -1 : 1 });
    group.add(wave);
  }

  const seed = elementalSeed(end, opts);
  const droplets: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; vx: number; vy: number; vz: number }[] = [];
  const dropletCount = Math.min(22, Math.max(8, Math.round(L * 0.22)));
  for (let i = 0; i < dropletCount; i++) {
    const mat = fxMat(i % 3 === 0 ? pal.core : pal.hot, 0.62);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.07 + rnd(seed, i) * 0.05, 5, 4), mat);
    mesh.position.set((rnd(seed, i + 10) - 0.5) * width, 0.18 + rnd(seed, i + 20) * 0.34, -L * 0.46 + rnd(seed, i + 30) * L * 0.92);
    droplets.push({
      mesh,
      mat,
      vx: (rnd(seed, i + 40) - 0.5) * 2.2,
      vy: 1.4 + rnd(seed, i + 50) * 2.0,
      vz: 2.6 + rnd(seed, i + 60) * 4.6,
    });
    group.add(mesh);
  }

  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    const crest = Math.sin(p * Math.PI);
    wash.scale.set(1 + crest * 0.08, 1, 1);
    (wash.material as THREE.MeshBasicMaterial).opacity = (focused ? 0.14 : 0.18) * (1 - p * 0.82);
    for (const w of waves) {
      const phase = (p + w.offset) % 1;
      w.mesh.position.z = -L * 0.52 + phase * L * 1.04;
      w.mesh.position.x = w.side * width * (0.16 + Math.sin(t * 10 + w.offset * 9) * 0.08);
      w.mesh.scale.setScalar(0.75 + phase * 1.1);
      w.mat.opacity = 0.58 * Math.sin(phase * Math.PI) * (1 - p * 0.42);
    }
    for (const d of droplets) {
      d.mesh.position.x += d.vx * dt;
      d.mesh.position.y += d.vy * dt;
      d.mesh.position.z += d.vz * dt;
      d.vy -= 6.2 * dt;
      d.mat.opacity = 0.62 * (1 - p);
    }
  });
}

function spawnElementalWaterSpiral(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
): void {
  const radius = Math.max(3.5, opts?.impactRadius ?? 8);
  const life = 1.05;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.12, pos.z);
  const ribbons: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; phase: number }[] = [];
  for (let r = 0; r < 4; r++) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 28; i++) {
      const t = i / 28;
      const a = t * Math.PI * 2.6 + r * Math.PI * 0.5;
      const rr = radius * (0.08 + t * 0.72);
      pts.push(new THREE.Vector3(Math.cos(a) * rr, 0.12 + Math.sin(t * Math.PI) * (0.45 + r * 0.06), Math.sin(a) * rr));
    }
    const tube = volumetricStream(pts, 0.08, r % 2 === 0 ? pal.core : pal.hot, 0.66, 40, 6);
    ribbons.push({ mesh: tube, mat: tube.material as THREE.MeshBasicMaterial, phase: r * 0.7 });
    group.add(tube);
  }
  const eye = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.72, 48), fxMat(pal.rim, 0.64));
  eye.rotation.x = -Math.PI / 2;
  group.add(eye);

  spawn(host, group, life, (t) => {
    const p = Math.min(1, t / life);
    group.rotation.y += 0.08;
    eye.scale.setScalar(1 + Math.sin(p * Math.PI) * radius * 0.18);
    (eye.material as THREE.MeshBasicMaterial).opacity = 0.64 * (1 - p);
    for (const r of ribbons) {
      r.mesh.rotation.y = -t * 2.8 + r.phase;
      r.mesh.scale.setScalar(0.55 + Math.sin(p * Math.PI) * 0.82);
      r.mat.opacity = 0.66 * (1 - p);
    }
  });
}

function spawnElementalCone(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
): void {
  const from = opts?.from;
  if (!from) return spawnElementalAoe(host, pos, opts, pal, true);
  const dx = pos.x - from.x;
  const dz = pos.z - from.z;
  const dist = Math.hypot(dx, dz);
  const reach = Math.max(2, opts?.reach ?? dist);
  const width = Math.max(1, opts?.width ?? opts?.impactRadius ?? reach * 0.55);
  const halfAngle = Math.max(0.16, Math.min(0.72, Math.atan2(width * 0.5, reach)));
  const life = 0.54;
  const group = new THREE.Group();
  group.position.set(from.x, 0.1, from.z);
  group.rotation.y = Math.atan2(dx, dz);

  const seed = elementalSeed(pos, opts);
  // Fanned volumetric jets sweeping across the cone — a firebender's spray, not a flat fan.
  const jetMats: THREE.MeshBasicMaterial[] = [];
  const jetCount = 3;
  for (let j = 0; j < jetCount; j++) {
    const side = jetCount > 1 ? (j - (jetCount - 1) / 2) / ((jetCount - 1) / 2) : 0; // -1..1
    const spread = Math.sin(halfAngle) * reach * side;
    const pts = [
      new THREE.Vector3(0, 0.42, 0.1),
      new THREE.Vector3(spread * 0.45, 0.72, reach * 0.5),
      new THREE.Vector3(spread, 0.5, reach),
    ];
    const jet = volumetricStream(pts, 0.12 + (1 - Math.abs(side)) * 0.08, j === 1 ? pal.core : pal.hot, 0, 18, 6);
    group.add(jet);
    jetMats.push(jet.material as THREE.MeshBasicMaterial);
  }
  // Cone-filling particle body that erupts forward and outward.
  const N = 14;
  const cloud = makeVolCloud(N, pal.hot, 0.62, 0, pal.core);
  for (let i = 0; i < N; i++) {
    const ang = (rnd(seed, i) * 2 - 1) * halfAngle;
    const sp = reach * (1.4 + rnd(seed, i + 30) * 1.2);
    setCloudParticle(
      cloud,
      i,
      Math.sin(ang) * reach * 0.08,
      0.42 + rnd(seed, i + 40) * 0.5,
      reach * 0.06,
      Math.sin(ang) * sp,
      0.6 + rnd(seed, i + 50) * 1.2,
      Math.cos(ang) * sp,
    );
  }
  group.add(cloud.points);
  const flash = glowSprite(pal.core, 1.0, 0);
  flash.position.set(0, 0.5, reach * 0.15);
  group.add(flash);

  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    const env = 1 - p;
    for (const jm of jetMats) jm.opacity = 0.5 * env;
    advectCloud(cloud, dt, 3.5, 1.3, t, 2.4);
    cloud.mat.opacity = 0.6 * (1 - p);
    cloud.mat.size = cloud.baseSize * (1 + p * 0.6);
    const a = Math.sin(Math.min(1, p * 2.5) * Math.PI);
    (flash.material as THREE.SpriteMaterial).opacity = 0.7 * a;
    flash.scale.setScalar(1 + p * 1.2);
  });
}

function spawnElementalAirCone(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
): void {
  const from = opts?.from;
  if (!from) return spawnElementalAirBurst(host, pos, opts, pal, true);
  const dx = pos.x - from.x;
  const dz = pos.z - from.z;
  const dist = Math.hypot(dx, dz);
  const reach = Math.max(3, opts?.reach ?? dist);
  const width = Math.max(2, opts?.width ?? opts?.impactRadius ?? reach * 0.62);
  const life = 0.72;
  const group = new THREE.Group();
  group.position.set(from.x, 0.16, from.z);
  group.rotation.y = Math.atan2(dx, dz);
  const halfAngle = Math.max(0.18, Math.min(0.78, Math.atan2(width * 0.5, reach)));
  // Drifting volumetric wisp body instead of a flat veil cone.
  const seed = elementalSeed(pos, opts);
  const wisps = makeVolCloud(10, pal.hot, 0.7, 0);
  for (let i = 0; i < 10; i++) {
    const ang = (rnd(seed, i) * 2 - 1) * halfAngle;
    const sp = reach * (1.1 + rnd(seed, i + 20) * 1.0);
    setCloudParticle(
      wisps,
      i,
      Math.sin(ang) * reach * 0.08,
      0.4 + rnd(seed, i + 30) * 0.6,
      reach * 0.06,
      Math.sin(ang) * sp,
      0.4 + rnd(seed, i + 40) * 0.8,
      Math.cos(ang) * sp,
    );
  }
  group.add(wisps.points);

  const ribbons: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; phase: number; side: number }[] = [];
  for (let r = 0; r < 5; r++) {
    const side = r % 2 === 0 ? -1 : 1;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const sway = Math.sin(t * Math.PI * 2.2 + r * 1.1) * width * 0.1;
      const fan = side * Math.sin(t * Math.PI) * width * (0.13 + r * 0.028);
      pts.push(new THREE.Vector3(fan + sway, 0.32 + Math.sin(t * Math.PI) * (0.55 + r * 0.07), t * reach));
    }
    const tube = volumetricStream(pts, 0.05 + r * 0.008, r % 2 === 0 ? pal.core : pal.trail, 0.5, 16, 5);
    ribbons.push({ mesh: tube, mat: tube.material as THREE.MeshBasicMaterial, phase: r * 0.47, side });
    group.add(tube);
  }

  const gusts: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; z: number; x: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const mat = fxMat(i % 2 === 0 ? pal.core : pal.hot, 0.34);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(width * (0.09 + i * 0.012), 0.025, 4, 28, Math.PI * 1.45), mat);
    ring.rotation.x = Math.PI / 2;
    ring.rotation.z = i % 2 ? Math.PI : 0;
    ring.position.set((i % 2 ? 1 : -1) * width * 0.12, 0.36 + i * 0.035, reach * (0.14 + i * 0.1));
    gusts.push({ mesh: ring, mat, z: ring.position.z, x: ring.position.x });
    group.add(ring);
  }

  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    const fade = 1 - p;
    advectCloud(wisps, dt, 1.5, 1.0);
    wisps.mat.opacity = 0.45 * fade;
    for (const r of ribbons) {
      r.mesh.position.x = Math.sin(t * 9 + r.phase) * width * 0.045;
      r.mesh.position.y = Math.sin(t * 7 + r.phase) * 0.08;
      r.mat.opacity = 0.5 * fade;
    }
    for (const g of gusts) {
      const q = (p + g.z / reach) % 1;
      g.mesh.position.z = q * reach;
      g.mesh.position.x = g.x + Math.sin(t * 8 + q * 6) * width * 0.08;
      g.mesh.rotation.z += 0.12;
      g.mesh.scale.setScalar(0.7 + q * 0.8);
      g.mat.opacity = 0.34 * Math.sin(q * Math.PI) * fade;
    }
  });
}

function spawnElementalField(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
): void {
  const radius = Math.max(3, opts?.impactRadius ?? 10);
  const life = 0.92;
  const group = new THREE.Group();
  group.position.set(pos.x, 0, pos.z);
  const shell = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.1, 1),
    new THREE.MeshBasicMaterial({
      color: pal.hot,
      wireframe: true,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  shell.position.y = Math.max(2.2, radius * 0.18);
  group.add(shell);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.9, 58), fxMat(pal.rim, 0.72));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.09;
  group.add(ring);
  const inner = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.38, 42), fxMat(pal.core, 0.54));
  inner.rotation.x = -Math.PI / 2;
  inner.position.y = 0.11;
  group.add(inner);

  spawn(host, group, life, (t) => {
    const p = Math.min(1, t / life);
    shell.scale.setScalar(1 + p * Math.max(2.3, radius * 0.17));
    shell.rotation.y = p * 2.4;
    (shell.material as THREE.MeshBasicMaterial).opacity = 0.72 * (1 - p);
    ring.scale.setScalar(Math.max(1, (radius / 0.9) * (0.2 + p * 0.92)));
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.72 * (1 - p * 0.88);
    inner.scale.setScalar(1 + p * Math.max(3, radius * 0.28));
    (inner.material as THREE.MeshBasicMaterial).opacity = 0.54 * (1 - p);
  });
}

function spawnElementalMeteor(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
): void {
  const radius = Math.max(3, opts?.impactRadius ?? 9);
  const life = 0.88;
  const root = new THREE.Group();
  const seed = elementalSeed(pos, opts);
  const sx = pos.x - 5.5 + (rnd(seed, 1) - 0.5) * 2.5;
  const sz = pos.z - 4.2 + (rnd(seed, 2) - 0.5) * 2.5;
  const sy = Math.max(18, radius * 1.45);

  const trailPts = [
    new THREE.Vector3(sx, sy, sz),
    new THREE.Vector3((sx + pos.x) * 0.5, sy * 0.4, (sz + pos.z) * 0.5),
    new THREE.Vector3(pos.x, 0.35, pos.z),
  ];
  const trail = volumetricStream(trailPts, 0.16, pal.trail, 0.76, 18, 5);
  root.add(trail);

  const meteor = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), fxMat(pal.core, 0.95));
  meteor.position.set(sx, sy, sz);
  meteor.add(glowSprite(pal.hot, 1.5, 0.85));
  root.add(meteor);

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.8, 52), fxMat(pal.hot, 0.82));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(pos.x, 0.12, pos.z);
  root.add(ring);
  const scorch = new THREE.Mesh(new THREE.CircleGeometry(1, 34), fxMat(pal.shadow, 0.24, false));
  scorch.rotation.x = -Math.PI / 2;
  scorch.position.set(pos.x, 0.02, pos.z);
  root.add(scorch);

  spawn(host, root, life, (t) => {
    const p = Math.min(1, t / life);
    const fall = Math.min(1, t / 0.28);
    const ease = fall * fall * (3 - 2 * fall);
    meteor.position.set(sx + (pos.x - sx) * ease, sy * (1 - ease) + 0.45 * ease, sz + (pos.z - sz) * ease);
    (meteor.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - Math.max(0, p - 0.72) / 0.28);
    (trail.material as THREE.MeshBasicMaterial).opacity = 0.76 * (1 - p);
    const hitP = Math.max(0, (t - 0.18) / (life - 0.18));
    ring.scale.setScalar(1 + hitP * (radius / 0.8));
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.82 * (1 - hitP);
    scorch.scale.setScalar(radius * (0.42 + hitP * 0.42));
    (scorch.material as THREE.MeshBasicMaterial).opacity = 0.24 * (1 - p * 0.55);
  });
}

function spawnElementalFireMeteor(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
): void {
  const radius = Math.max(4, opts?.impactRadius ?? 10);
  const life = 1.08;
  const root = new THREE.Group();
  const seed = elementalSeed(pos, opts);
  const meteorCount = radius > 12 ? 4 : 3;
  const meteors: {
    mesh: THREE.Mesh;
    trail: THREE.Mesh;
    sx: number;
    sy: number;
    sz: number;
    tx: number;
    tz: number;
    delay: number;
  }[] = [];
  for (let i = 0; i < meteorCount; i++) {
    const a = rnd(seed, i + 8) * Math.PI * 2;
    const landR = i === 0 ? 0 : radius * (0.18 + rnd(seed, i + 13) * 0.38);
    const tx = pos.x + Math.cos(a) * landR;
    const tz = pos.z + Math.sin(a) * landR;
    const sx = tx - 7.5 - rnd(seed, i + 20) * 4.5;
    const sz = tz - 5.5 + (rnd(seed, i + 30) - 0.5) * 5;
    const sy = Math.max(20, radius * 1.55) + i * 1.7;
    const trailPts = [
      new THREE.Vector3(sx, sy, sz),
      new THREE.Vector3((sx + tx) * 0.5, sy * 0.4, (sz + tz) * 0.5),
      new THREE.Vector3(tx, 0.45, tz),
    ];
    const trail = volumetricStream(trailPts, i === 0 ? 0.2 : 0.14, i % 2 === 0 ? pal.trail : pal.hot, 0.72, 18, 5);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(i === 0 ? 0.72 : 0.46, 9, 7), fxMat(i === 0 ? pal.core : pal.hot, 0.96));
    mesh.position.set(sx, sy, sz);
    mesh.add(glowSprite(i === 0 ? pal.core : pal.hot, i === 0 ? 1.9 : 1.3, 0.85));
    meteors.push({ mesh, trail, sx, sy, sz, tx, tz, delay: i * 0.075 });
    root.add(trail, mesh);
  }

  const blast = new THREE.Mesh(new THREE.RingGeometry(0.42, 1.05, 64), fxMat(pal.hot, 0.9));
  blast.rotation.x = -Math.PI / 2;
  blast.position.set(pos.x, 0.13, pos.z);
  root.add(blast);
  const heat = new THREE.Mesh(new THREE.CircleGeometry(1, 48), fxMat(pal.rim, 0.28));
  heat.rotation.x = -Math.PI / 2;
  heat.position.set(pos.x, 0.08, pos.z);
  root.add(heat);
  const scorch = new THREE.Mesh(new THREE.CircleGeometry(1, 42), fxMat(pal.shadow, 0.34, false));
  scorch.rotation.x = -Math.PI / 2;
  scorch.position.set(pos.x, 0.025, pos.z);
  root.add(scorch);

  const smoke: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; vx: number; vy: number; vz: number; delay: number }[] = [];
  const smokeCount = Math.min(16, Math.max(8, Math.round(radius * 0.8)));
  for (let i = 0; i < smokeCount; i++) {
    const mat = makeSoftSmokeMat(0.22);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.42 + rnd(seed, i + 70) * 0.35, 7, 5), mat);
    mesh.position.set(pos.x, 0.28, pos.z);
    const a = rnd(seed, i + 80) * Math.PI * 2;
    const sp = 1.8 + rnd(seed, i + 90) * 3.2;
    smoke.push({
      mesh,
      mat,
      vx: Math.cos(a) * sp,
      vz: Math.sin(a) * sp,
      vy: 1.0 + rnd(seed, i + 100) * 1.7,
      delay: 0.22 + rnd(seed, i + 110) * 0.18,
    });
    root.add(mesh);
  }

  spawn(host, root, life, (t, dt) => {
    const p = Math.min(1, t / life);
    for (const m of meteors) {
      const fall = Math.max(0, Math.min(1, (t - m.delay) / 0.32));
      const ease = fall * fall * (3 - 2 * fall);
      m.mesh.position.set(m.sx + (m.tx - m.sx) * ease, m.sy * (1 - ease) + 0.45 * ease, m.sz + (m.tz - m.sz) * ease);
      (m.mesh.material as THREE.MeshBasicMaterial).opacity = fall <= 0 ? 0 : 0.96 * (1 - Math.max(0, p - 0.74) / 0.26);
      (m.trail.material as THREE.MeshBasicMaterial).opacity = 0.72 * Math.max(0, 1 - p * 1.1) * Math.min(1, fall * 3);
    }
    const hitP = Math.max(0, (t - 0.22) / (life - 0.22));
    blast.scale.setScalar(1 + hitP * (radius / 0.82));
    (blast.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - hitP);
    heat.scale.setScalar(radius * (0.2 + hitP * 0.52));
    (heat.material as THREE.MeshBasicMaterial).opacity = 0.28 * (1 - p * 0.74);
    scorch.scale.setScalar(radius * (0.3 + hitP * 0.62));
    (scorch.material as THREE.MeshBasicMaterial).opacity = 0.34 * (1 - p * 0.38);
    for (const s of smoke) {
      if (t < s.delay) {
        s.mat.opacity = 0;
        continue;
      }
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.z += s.vz * dt;
      s.vy += 0.52 * dt;
      s.mesh.scale.multiplyScalar(1 + dt * 1.25);
      s.mat.opacity = 0.22 * Math.max(0, 1 - (t - s.delay) / (life - s.delay));
    }
  });
}

function spawnElementalAoe(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
  compact: boolean,
): void {
  if (opts?.element === "earth" || pal.shadow === 0x231910) return spawnElementalGeodeImpact(host, pos, opts, pal, compact);
  if (opts?.element === "lava" || pal.shadow === 0x35120b) return spawnElementalLavaPool(host, pos, opts, pal, compact);
  if (opts?.element === "snow" || pal.shadow === 0x42607d) return spawnElementalSnowBurst(host, pos, opts, pal, compact);
  if (opts?.element === "air" || pal.shadow === 0x244455) return spawnElementalAirBurst(host, pos, opts, pal, compact);
  const radius = Math.max(1.6, opts?.impactRadius ?? (compact ? 4.5 : 9));
  const life = compact ? 0.58 : 0.86;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.1, pos.z);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.62, compact ? 32 : 52), fxMat(pal.rim, compact ? 0.78 : 0.68));
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);
  const core = new THREE.Mesh(new THREE.CircleGeometry(0.58, 32), fxMat(pal.core, compact ? 0.42 : 0.34));
  core.rotation.x = -Math.PI / 2;
  core.position.y = 0.015;
  group.add(core);
  const seed = elementalSeed(pos, opts);
  const particles: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; vx: number; vy: number; vz: number }[] = [];
  const count = compact ? 8 : Math.min(28, Math.max(12, Math.round(radius * 1.35)));
  for (let i = 0; i < count; i++) {
    const mat = fxMat(i % 3 === 0 ? pal.core : i % 2 === 0 ? pal.hot : pal.trail, compact ? 0.72 : 0.82);
    const geom =
      pal.shadow === 0x231910
        ? new THREE.BoxGeometry(0.16, 0.16, 0.16)
        : new THREE.SphereGeometry(compact ? 0.08 : 0.12, 5, 4);
    const mesh = new THREE.Mesh(geom, mat);
    const a = rnd(seed, i) * Math.PI * 2;
    const sp = (compact ? 2.2 : 3.4) + rnd(seed, i + 20) * (compact ? 2.1 : 3.2);
    mesh.position.set(Math.cos(a) * 0.3, 0.22, Math.sin(a) * 0.3);
    particles.push({
      mesh,
      mat,
      vx: Math.cos(a) * sp,
      vz: Math.sin(a) * sp,
      vy: 1.6 + rnd(seed, i + 40) * (compact ? 2.4 : 3.6),
    });
    group.add(mesh);
  }

  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    ring.scale.setScalar(1 + p * (radius / 0.62));
    (ring.material as THREE.MeshBasicMaterial).opacity = (compact ? 0.78 : 0.68) * (1 - p);
    core.scale.setScalar(Math.max(0.5, radius * 0.32) * (0.45 + p * 0.36));
    (core.material as THREE.MeshBasicMaterial).opacity = (compact ? 0.42 : 0.34) * (1 - p * 0.85);
    for (const pt of particles) {
      pt.mesh.position.x += pt.vx * dt;
      pt.mesh.position.z += pt.vz * dt;
      pt.mesh.position.y += pt.vy * dt;
      pt.vy -= 7.2 * dt;
      pt.mat.opacity = (compact ? 0.72 : 0.82) * (1 - p);
    }
  });
}

function spawnElementalGeodeImpact(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
  compact: boolean,
): void {
  const radius = Math.max(2.4, opts?.impactRadius ?? (compact ? 4.2 : 8.5));
  const life = compact ? 0.78 : 1.02;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.05, pos.z);
  const seed = elementalSeed(pos, opts);

  const crack = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.92, 52), fxMat(pal.shadow, 0.5, false));
  crack.rotation.x = -Math.PI / 2;
  crack.position.y = 0.012;
  group.add(crack);
  const pulse = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.46, 42), fxMat(pal.hot, 0.58));
  pulse.rotation.x = -Math.PI / 2;
  pulse.position.y = 0.09;
  group.add(pulse);

  const shards: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; baseY: number; rise: number; spin: number }[] = [];
  const shardCount = compact ? 7 : Math.min(18, Math.max(10, Math.round(radius * 1.4)));
  for (let i = 0; i < shardCount; i++) {
    const mat = fxMat(i % 3 === 0 ? pal.core : i % 2 === 0 ? pal.hot : pal.rim, 0.86);
    const h = 0.55 + rnd(seed, i + 10) * (compact ? 1.0 : 1.7);
    const r = radius * (0.12 + rnd(seed, i + 20) * 0.82);
    const a = rnd(seed, i + 30) * Math.PI * 2;
    const geom = new THREE.ConeGeometry(0.12 + rnd(seed, i + 40) * 0.16, h, 5);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(Math.cos(a) * r, h * 0.28, Math.sin(a) * r);
    mesh.rotation.set((rnd(seed, i + 50) - 0.5) * 0.55, a, (rnd(seed, i + 60) - 0.5) * 0.55);
    shards.push({ mesh, mat, baseY: mesh.position.y, rise: h * (0.48 + rnd(seed, i + 70) * 0.55), spin: (rnd(seed, i + 80) - 0.5) * 1.8 });
    group.add(mesh);
  }

  const dust: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; vx: number; vy: number; vz: number }[] = [];
  const dustCount = compact ? 8 : 16;
  for (let i = 0; i < dustCount; i++) {
    const mat = fxMat(pal.shadow, 0.18, false);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.18 + rnd(seed, i + 90) * 0.22, 6, 4), mat);
    const a = rnd(seed, i + 100) * Math.PI * 2;
    const sp = 1.3 + rnd(seed, i + 110) * 2.7;
    mesh.position.set(0, 0.22, 0);
    dust.push({ mesh, mat, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: 0.7 + rnd(seed, i + 120) * 1.1 });
    group.add(mesh);
  }

  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    const erupt = Math.min(1, t / 0.18);
    const settle = Math.max(0, (p - 0.58) / 0.42);
    crack.scale.setScalar(1 + p * radius * 0.42);
    (crack.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - p * 0.8);
    pulse.scale.setScalar(1 + p * radius * 0.26);
    (pulse.material as THREE.MeshBasicMaterial).opacity = 0.58 * (1 - p);
    for (const s of shards) {
      s.mesh.position.y = s.baseY + Math.sin(erupt * Math.PI * 0.5) * s.rise - settle * s.rise * 0.42;
      s.mesh.rotation.y += s.spin * dt;
      s.mesh.scale.y = 1 - settle * 0.28;
      s.mat.opacity = 0.86 * (1 - settle * 0.85);
    }
    for (const d of dust) {
      d.mesh.position.x += d.vx * dt;
      d.mesh.position.y += d.vy * dt;
      d.mesh.position.z += d.vz * dt;
      d.vy -= 1.9 * dt;
      d.mesh.scale.multiplyScalar(1 + dt * 0.62);
      d.mat.opacity = 0.18 * (1 - p);
    }
  });
}

function spawnElementalLavaPool(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
  compact: boolean,
): void {
  const radius = Math.max(2.5, opts?.impactRadius ?? (compact ? 4.5 : 9));
  const life = compact ? 0.9 : 1.18;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.055, pos.z);
  const seed = elementalSeed(pos, opts);
  const pool = new THREE.Mesh(new THREE.CircleGeometry(1, 46), fxMat(pal.hot, 0.3));
  pool.rotation.x = -Math.PI / 2;
  group.add(pool);
  const crust = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.96, 58), fxMat(pal.shadow, 0.42, false));
  crust.rotation.x = -Math.PI / 2;
  crust.position.y = -0.018;
  group.add(crust);
  const rim = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.52, 54), fxMat(pal.rim, 0.68));
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.045;
  group.add(rim);

  const bubbles: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; vx: number; vz: number; phase: number }[] = [];
  const bubbleCount = compact ? 8 : Math.min(20, Math.max(10, Math.round(radius * 1.3)));
  for (let i = 0; i < bubbleCount; i++) {
    const mat = fxMat(i % 3 === 0 ? pal.core : pal.trail, 0.76);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.09 + rnd(seed, i) * 0.12, 6, 5), mat);
    const a = rnd(seed, i + 10) * Math.PI * 2;
    const r = radius * (0.08 + rnd(seed, i + 20) * 0.55);
    mesh.position.set(Math.cos(a) * r, 0.16, Math.sin(a) * r);
    bubbles.push({
      mesh,
      mat,
      vx: Math.cos(a) * (0.2 + rnd(seed, i + 30) * 0.55),
      vz: Math.sin(a) * (0.2 + rnd(seed, i + 40) * 0.55),
      phase: rnd(seed, i + 50) * Math.PI * 2,
    });
    group.add(mesh);
  }

  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    const grow = Math.sin(Math.min(1, p * 1.25) * Math.PI * 0.5);
    pool.scale.setScalar(radius * (0.18 + grow * 0.54));
    (pool.material as THREE.MeshBasicMaterial).opacity = 0.3 * (1 - p * 0.62) * (0.82 + Math.sin(t * 18) * 0.18);
    crust.scale.setScalar(radius * (0.22 + grow * 0.64));
    (crust.material as THREE.MeshBasicMaterial).opacity = 0.42 * (1 - p * 0.5);
    rim.scale.setScalar(1 + p * radius * 0.52);
    (rim.material as THREE.MeshBasicMaterial).opacity = 0.68 * (1 - p);
    for (const b of bubbles) {
      b.mesh.position.x += b.vx * dt;
      b.mesh.position.z += b.vz * dt;
      b.mesh.position.y = 0.12 + Math.abs(Math.sin(t * 8 + b.phase)) * 0.42;
      b.mesh.scale.setScalar(0.75 + Math.sin(t * 11 + b.phase) * 0.22);
      b.mat.opacity = 0.76 * (1 - p);
    }
  });
}

function spawnElementalLavaGeyser(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
): void {
  const radius = Math.max(4, opts?.impactRadius ?? 8);
  const life = 1.15;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.08, pos.z);
  const seed = elementalSeed(pos, opts);
  const vent = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.9, 58), fxMat(pal.rim, 0.82));
  vent.rotation.x = -Math.PI / 2;
  group.add(vent);
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.68, 1, 10, 1, true), fxMat(pal.hot, 0.46));
  column.position.y = 0.6;
  group.add(column);
  const bombs: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; vx: number; vy: number; vz: number; delay: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const mat = fxMat(i % 3 === 0 ? pal.core : pal.trail, 0.86);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.12 + rnd(seed, i) * 0.12, 7, 5), mat);
    const a = rnd(seed, i + 10) * Math.PI * 2;
    bombs.push({
      mesh,
      mat,
      vx: Math.cos(a) * (1.2 + rnd(seed, i + 20) * 3.4),
      vz: Math.sin(a) * (1.2 + rnd(seed, i + 30) * 3.4),
      vy: 5.2 + rnd(seed, i + 40) * 4.3,
      delay: rnd(seed, i + 50) * 0.18,
    });
    group.add(mesh);
  }

  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    vent.scale.setScalar(1 + p * radius * 0.24);
    (vent.material as THREE.MeshBasicMaterial).opacity = 0.82 * (1 - p);
    column.scale.set(1 + Math.sin(t * 12) * 0.08, Math.sin(Math.min(1, p * 1.7) * Math.PI) * radius * 0.22, 1);
    (column.material as THREE.MeshBasicMaterial).opacity = 0.46 * (1 - p * 0.8);
    for (const b of bombs) {
      if (t < b.delay) {
        b.mat.opacity = 0;
        continue;
      }
      b.mesh.position.x += b.vx * dt;
      b.mesh.position.z += b.vz * dt;
      b.mesh.position.y += b.vy * dt;
      b.vy -= 10.5 * dt;
      b.mat.opacity = 0.86 * Math.max(0, 1 - (t - b.delay) / (life - b.delay));
    }
  });
}

function spawnElementalSnowBurst(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
  compact: boolean,
): void {
  const radius = Math.max(2.2, opts?.impactRadius ?? (compact ? 4.5 : 9));
  const life = compact ? 0.92 : 1.18;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.08, pos.z);
  const seed = elementalSeed(pos, opts);
  const frost = new THREE.Mesh(new THREE.CircleGeometry(1, 52), fxMat(pal.hot, 0.18, false));
  frost.rotation.x = -Math.PI / 2;
  frost.position.y = -0.03;
  group.add(frost);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.48, 56), fxMat(pal.core, 0.72));
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);
  const flakes: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; vx: number; vy: number; vz: number; spin: number }[] = [];
  const flakeCount = compact ? 14 : Math.min(34, Math.max(18, Math.round(radius * 2.0)));
  for (let i = 0; i < flakeCount; i++) {
    const mat = fxMat(i % 3 === 0 ? pal.core : pal.trail, 0.78);
    const geom = i % 2 === 0 ? new THREE.OctahedronGeometry(0.07 + rnd(seed, i) * 0.07, 0) : new THREE.TetrahedronGeometry(0.08 + rnd(seed, i) * 0.06, 0);
    const mesh = new THREE.Mesh(geom, mat);
    const a = rnd(seed, i + 10) * Math.PI * 2;
    const sp = 1.6 + rnd(seed, i + 20) * 3.4;
    mesh.position.set(0, 0.32 + rnd(seed, i + 30) * 0.5, 0);
    flakes.push({
      mesh,
      mat,
      vx: Math.cos(a) * sp,
      vz: Math.sin(a) * sp,
      vy: 2.2 + rnd(seed, i + 40) * 2.6,
      spin: (rnd(seed, i + 50) - 0.5) * 7,
    });
    group.add(mesh);
  }

  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    frost.scale.setScalar(radius * (0.2 + p * 0.6));
    (frost.material as THREE.MeshBasicMaterial).opacity = 0.18 * (1 - p * 0.44);
    ring.scale.setScalar(1 + p * radius * 0.58);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.72 * (1 - p);
    for (const f of flakes) {
      f.mesh.position.x += f.vx * dt;
      f.mesh.position.y += f.vy * dt;
      f.mesh.position.z += f.vz * dt;
      f.vy -= 4.8 * dt;
      f.mesh.rotation.x += f.spin * dt;
      f.mesh.rotation.y -= f.spin * 0.7 * dt;
      f.mat.opacity = 0.78 * (1 - p);
    }
  });
}

function spawnElementalSnowBlizzard(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
): void {
  const radius = Math.max(4, opts?.impactRadius ?? 8);
  const life = 1.2;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.12, pos.z);
  const seed = elementalSeed(pos, opts);
  const veil = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.72, radius * 0.28, radius * 0.75, 36, 1, true), fxMat(pal.hot, 0.11));
  veil.position.y = radius * 0.36;
  group.add(veil);
  const flakes: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; a: number; r: number; y: number; spin: number }[] = [];
  for (let i = 0; i < 34; i++) {
    const mat = fxMat(i % 2 === 0 ? pal.core : pal.trail, 0.7);
    const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.06 + rnd(seed, i) * 0.07, 0), mat);
    flakes.push({
      mesh,
      mat,
      a: rnd(seed, i + 10) * Math.PI * 2,
      r: radius * (0.12 + rnd(seed, i + 20) * 0.68),
      y: 0.3 + rnd(seed, i + 30) * radius * 0.7,
      spin: (rnd(seed, i + 40) - 0.5) * 6,
    });
    group.add(mesh);
  }
  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    veil.rotation.y += dt * 1.8;
    (veil.material as THREE.MeshBasicMaterial).opacity = 0.11 * (1 - p);
    for (const f of flakes) {
      f.a += dt * (2.4 + f.r / radius);
      f.y = Math.max(0.08, f.y - dt * (0.8 + f.r * 0.08));
      f.mesh.position.set(Math.cos(f.a) * f.r, f.y, Math.sin(f.a) * f.r);
      f.mesh.rotation.x += f.spin * dt;
      f.mesh.rotation.z -= f.spin * 0.7 * dt;
      f.mat.opacity = 0.7 * (1 - p);
    }
  });
}

function spawnElementalAirBurst(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
  compact: boolean,
): void {
  const radius = Math.max(2.4, opts?.impactRadius ?? (compact ? 4.4 : 8.5));
  const life = compact ? 0.72 : 0.96;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.12, pos.z);
  const rings: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; phase: number }[] = [];
  for (let i = 0; i < 5; i++) {
    const mat = fxMat(i % 2 === 0 ? pal.core : pal.hot, 0.36);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.56 + i * 0.12, 0.025, 4, 42, Math.PI * 1.55), mat);
    ring.rotation.x = Math.PI / 2;
    ring.rotation.z = i * 1.37;
    ring.position.y = 0.12 + i * 0.12;
    rings.push({ mesh: ring, mat, phase: i * 0.17 });
    group.add(ring);
  }
  const seed = elementalSeed(pos, opts);
  const wisps: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; vx: number; vz: number; vy: number }[] = [];
  const wispCount = compact ? 7 : 13;
  const wispPts = [
    new THREE.Vector3(0, 0.15, 0),
    new THREE.Vector3(0.25, 0.55, 0.1),
    new THREE.Vector3(0.55, 0.9, -0.08),
  ];
  for (let i = 0; i < wispCount; i++) {
    const tube = volumetricStream(wispPts, 0.05, i % 2 === 0 ? pal.trail : pal.core, 0.44, 10, 4);
    const a = rnd(seed, i) * Math.PI * 2;
    tube.rotation.y = a;
    wisps.push({
      mesh: tube,
      mat: tube.material as THREE.MeshBasicMaterial,
      vx: Math.cos(a) * (1.8 + rnd(seed, i + 10) * 2.8),
      vz: Math.sin(a) * (1.8 + rnd(seed, i + 20) * 2.8),
      vy: 1.2 + rnd(seed, i + 30) * 1.9,
    });
    group.add(tube);
  }

  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    for (const r of rings) {
      const q = Math.min(1, p + r.phase);
      r.mesh.scale.setScalar(1 + q * radius * 0.38);
      r.mesh.rotation.z += dt * 3.6;
      r.mesh.position.y += dt * 0.34;
      r.mat.opacity = 0.36 * Math.sin(Math.min(1, q) * Math.PI) * (1 - p * 0.45);
    }
    for (const w of wisps) {
      w.mesh.position.x += w.vx * dt;
      w.mesh.position.z += w.vz * dt;
      w.mesh.position.y += w.vy * dt;
      w.mesh.rotation.y += dt * 5.5;
      w.mat.opacity = 0.44 * (1 - p);
    }
  });
}

function spawnElementalArcaneRift(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
): void {
  const radius = Math.max(4, opts?.impactRadius ?? 8);
  const life = 1.05;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.12, pos.z);
  const portal = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.22, 0.055, 5, 52), fxMat(pal.rim, 0.82));
  portal.rotation.x = Math.PI / 2;
  group.add(portal);
  const iris = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.2, 42), fxMat(pal.hot, 0.22));
  iris.rotation.x = -Math.PI / 2;
  group.add(iris);
  const spokeMats: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const pts = [
      new THREE.Vector3(0, 0.2, 0),
      new THREE.Vector3(Math.cos(a) * radius * 0.36, 0.82, Math.sin(a) * radius * 0.36),
      new THREE.Vector3(Math.cos(a) * radius * 0.72, 1.2, Math.sin(a) * radius * 0.72),
    ];
    const tube = volumetricStream(pts, 0.06, i % 2 ? pal.core : pal.trail, 0.48, 12, 5);
    spokeMats.push(tube.material as THREE.MeshBasicMaterial);
    group.add(tube);
  }
  spawn(host, group, life, (t) => {
    const p = Math.min(1, t / life);
    group.rotation.y += 0.06;
    portal.scale.setScalar(1 + Math.sin(p * Math.PI) * 1.1);
    (portal.material as THREE.MeshBasicMaterial).opacity = 0.82 * (1 - p);
    iris.scale.setScalar(0.75 + Math.sin(p * Math.PI) * 1.6);
    (iris.material as THREE.MeshBasicMaterial).opacity = 0.22 * (1 - p);
    for (const sm of spokeMats) sm.opacity = 0.48 * (1 - p);
  });
}

function spawnElementalReclaimBloom(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
): void {
  const radius = Math.max(4, opts?.impactRadius ?? 8);
  const life = 1.05;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.08, pos.z);
  const seed = elementalSeed(pos, opts);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.7, 54), fxMat(pal.hot, 0.68));
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);
  const vines: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; a: number; len: number }[] = [];
  for (let v = 0; v < 10; v++) {
    const a = rnd(seed, v) * Math.PI * 2;
    const len = radius * (0.35 + rnd(seed, v + 10) * 0.48);
    const pts = [
      new THREE.Vector3(0, 0.1, 0),
      new THREE.Vector3(Math.cos(a + 0.35) * len * 0.45, 0.22, Math.sin(a + 0.35) * len * 0.45),
      new THREE.Vector3(Math.cos(a) * len, 0.16, Math.sin(a) * len),
    ];
    const tube = volumetricStream(pts, 0.06, v % 2 ? pal.hot : pal.trail, 0.58, 14, 5);
    vines.push({ mesh: tube, mat: tube.material as THREE.MeshBasicMaterial, a, len });
    group.add(tube);
  }
  spawn(host, group, life, (t) => {
    const p = Math.min(1, t / life);
    ring.scale.setScalar(1 + p * radius * 0.34);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.68 * (1 - p);
    for (const v of vines) {
      v.mesh.scale.setScalar(Math.sin(Math.min(1, p * 1.4) * Math.PI * 0.5));
      v.mesh.position.y = Math.sin(t * 5 + v.a) * 0.08;
      v.mat.opacity = 0.58 * (1 - p);
    }
  });
}

function spawnElementalShieldBastion(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
): void {
  const radius = Math.max(4, opts?.impactRadius ?? 8);
  const life = 1.12;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.04, pos.z);
  const shell = new THREE.Mesh(
    new THREE.IcosahedronGeometry(radius * 0.28, 2),
    new THREE.MeshBasicMaterial({ color: pal.hot, wireframe: true, transparent: true, opacity: 0.72, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  shell.position.y = radius * 0.22;
  group.add(shell);
  const plates: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; a: number }[] = [];
  for (let i = 0; i < 8; i++) {
    const mat = fxMat(i % 2 ? pal.trail : pal.core, 0.42);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(radius * 0.16, 0.04, radius * 0.04), mat);
    const a = (i / 8) * Math.PI * 2;
    mesh.position.set(Math.cos(a) * radius * 0.36, 0.18, Math.sin(a) * radius * 0.36);
    mesh.rotation.y = -a;
    plates.push({ mesh, mat, a });
    group.add(mesh);
  }
  spawn(host, group, life, (t) => {
    const p = Math.min(1, t / life);
    shell.scale.setScalar(0.45 + Math.sin(p * Math.PI) * 1.7);
    shell.rotation.y += 0.045;
    (shell.material as THREE.MeshBasicMaterial).opacity = 0.72 * (1 - p);
    for (const plate of plates) {
      const r = radius * (0.28 + Math.sin(p * Math.PI) * 0.22);
      plate.mesh.position.x = Math.cos(plate.a + t * 1.3) * r;
      plate.mesh.position.z = Math.sin(plate.a + t * 1.3) * r;
      plate.mat.opacity = 0.42 * (1 - p);
    }
  });
}

/**
 * Amber Geode Monks: sequential ground annuli along the strike line — reads as a rolling AoE shock, not a cone wedge.
 */
function spawnGeodeMonkForwardRings(host: FxHost, m: CombatHitMark): void {
  const dx = m.tx - m.ax;
  const dz = m.tz - m.az;
  const dist = Math.hypot(dx, dz) || 1;
  const reach = Math.max(1.05, Math.min(m.range * 1.08, dist + 0.55) * (m.wide ? 1.14 : 0.98));
  const pal = elementalCombatPalette(m);
  const seed = m.visualSeed;
  const group = new THREE.Group();
  group.position.set(m.ax, 0.07, m.az);
  group.rotation.y = Math.atan2(dx, dz);

  const ringCount = m.wide ? 7 : 5;
  const rings: { mesh: THREE.Mesh; z: number; mat: THREE.MeshBasicMaterial }[] = [];
  for (let i = 0; i < ringCount; i++) {
    const t = (i + 1) / (ringCount + 1.25);
    const z = reach * t * 0.94 + 0.38;
    const outer = 0.48 + t * 1.62 + (m.wide ? 0.62 : 0.38) + rnd(seed, i + 11) * 0.2;
    const inner = outer * 0.74;
    // Volumetric torus shockwave (real cross-section) instead of a flat ring plane.
    const geo = new THREE.TorusGeometry((inner + outer) * 0.5, (outer - inner) * 0.5, 6, 32);
    const mat = new THREE.MeshBasicMaterial({
      color: i % 2 === 0 ? pal.core : pal.glow,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, 0.04, z);
    rings.push({ mesh, z, mat });
    group.add(mesh);
  }

  const sparks: { mesh: THREE.Mesh; vx: number; vz: number; vy: number; mat: THREE.MeshBasicMaterial }[] = [];
  const nSpark = m.wide ? 14 : 10;
  for (let i = 0; i < nSpark; i++) {
    const u = rnd(seed, i + 90);
    const v = rnd(seed, i + 190);
    const z0 = 0.4 + u * reach * 0.92;
    const ang = v * Math.PI * 2;
    const rad = 0.15 + rnd(seed, i + 290) * (0.55 + (m.wide ? 0.45 : 0.25));
    const g = new THREE.SphereGeometry(0.038 + rnd(seed, i + 390) * 0.04, 4, 3);
    const mat = new THREE.MeshBasicMaterial({
      color: i % 3 === 0 ? pal.spark : pal.rim,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(Math.sin(ang) * rad, 0.16 + rnd(seed, i + 490) * 0.35, z0 + Math.cos(ang) * rad * 0.25);
    const burst = 0.85 + rnd(seed, i + 590) * 1.6;
    sparks.push({
      mesh,
      vx: Math.sin(ang) * burst * 0.35,
      vz: burst * (0.55 + rnd(seed, i + 690) * 0.55),
      vy: 0.9 + rnd(seed, i + 790) * 1.1,
      mat,
    });
    group.add(mesh);
  }

  const life = 0.56;
  const sigma2 = reach * reach * (m.wide ? 0.034 : 0.028) + 0.02;
  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    const wave = p * (reach + 0.65);
    for (const r of rings) {
      const d = wave - r.z;
      const bell = Math.exp(-(d * d) / sigma2);
      r.mat.opacity = (m.wide ? 0.36 : 0.4) * bell * (1 - p * 0.38);
    }
    for (const s of sparks) {
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.z += s.vz * dt;
      s.mesh.position.y += s.vy * dt;
      s.vy -= 5.5 * dt;
      const sp = Math.min(1, t / life);
      s.mat.opacity = 0.55 * (1 - sp * 0.92);
    }
  });
}

/**
 * Ground **cone** of elemental energy rooted on the attacker, opening toward the target.
 * Layered meshes + spark flecks (additive) — telegraphs melee / breath without implying physical metal.
 */
type CombatStrikeStep = (p: number, t: number, dt: number) => void;
type CombatStrikePalette = { core: number; glow: number; rim: number; spark: number };

/**
 * Swarm — fast paired elemental whips that slash across the target (waterbender
 * lash / airbender swipe), with a forward spray and an impact bloom.
 */
function buildSwarmStrike(
  group: THREE.Group,
  anim: CombatStrikeStep[],
  reach: number,
  pal: CombatStrikePalette,
  seed: number,
): void {
  const h = 0.5;
  for (let k = 0; k < 2; k++) {
    const side = k === 0 ? 1 : -1;
    const color = k === 0 ? pal.core : pal.spark;
    const pts = [
      new THREE.Vector3(side * 0.18, h * 0.55, 0.08),
      new THREE.Vector3(side * 0.5, h + 0.3, reach * 0.45),
      new THREE.Vector3(-side * 0.12, h * 0.95, reach * 0.82),
      new THREE.Vector3(-side * 0.4, h * 0.5, reach),
    ];
    const whip = volumetricStream(pts, 0.09 + k * 0.015, color, 0, 18, 6);
    whip.rotation.y = side * 0.45;
    group.add(whip);
    const mat = whip.material as THREE.MeshBasicMaterial;
    anim.push((p) => {
      const a = Math.sin(Math.min(1, p * 1.25) * Math.PI);
      mat.opacity = 0.9 * a;
      whip.rotation.y = side * (0.45 - p * 0.6);
      whip.scale.setScalar(1 + p * 0.18);
    });
  }
  const spray = makeVolCloud(6, pal.glow, 0.5, 0, pal.spark);
  for (let i = 0; i < 6; i++) {
    const ang = (rnd(seed, i + 11) - 0.5) * 0.9;
    const sp = 2 + rnd(seed, i + 21) * 2.6;
    setCloudParticle(
      spray,
      i,
      Math.sin(ang) * 0.12,
      0.45 + rnd(seed, i + 31) * 0.3,
      reach * 0.82,
      Math.sin(ang) * sp,
      1 + rnd(seed, i + 41) * 1.6,
      Math.cos(ang) * sp * 0.5 + 1.2,
    );
  }
  group.add(spray.points);
  anim.push((p, t, dt) => {
    advectCloud(spray, dt, 5, 1.3, t, 1.6);
    spray.mat.opacity = 0.7 * (1 - p);
    spray.mat.size = spray.baseSize * (1 + p);
  });
  const flash = glowSprite(pal.glow, 0.85, 0);
  flash.position.set(0, 0.5, reach);
  group.add(flash);
  anim.push((p) => {
    const a = Math.sin(Math.min(1, p * 1.6) * Math.PI);
    (flash.material as THREE.SpriteMaterial).opacity = 0.95 * a;
    flash.scale.setScalar(0.85 + p * 1.3);
  });
}

/**
 * Line — a focused elemental lance/jet (firebender beam): bright volumetric core
 * inside a soft shell, a head that travels to the target, then an impact burst.
 */
function buildLineStrike(
  group: THREE.Group,
  anim: CombatStrikeStep[],
  reach: number,
  pal: CombatStrikePalette,
  seed: number,
): void {
  const h = 0.7;
  const pts = [
    new THREE.Vector3(0, h, 0.08),
    new THREE.Vector3(0, h + 0.32, reach * 0.5),
    new THREE.Vector3(0, h * 0.92, reach),
  ];
  const curve = new THREE.CatmullRomCurve3(pts);
  const shell = volumetricStream(pts, 0.2, pal.rim, 0, 24, 8);
  const core = volumetricStream(pts, 0.075, pal.core, 0, 24, 6);
  group.add(shell);
  group.add(core);
  const shellMat = shell.material as THREE.MeshBasicMaterial;
  const coreMat = core.material as THREE.MeshBasicMaterial;
  anim.push((p) => {
    const a = p < 0.22 ? p / 0.22 : Math.max(0, 1 - (p - 0.22) / 0.78);
    shellMat.opacity = 0.45 * a;
    coreMat.opacity = 0.95 * a;
  });
  const head = glowSprite(pal.glow, 0.6, 0);
  group.add(head);
  const headPos = new THREE.Vector3();
  anim.push((p) => {
    const tt = Math.min(1, p / 0.32);
    curve.getPoint(tt, headPos);
    head.position.copy(headPos);
    (head.material as THREE.SpriteMaterial).opacity = tt < 1 ? 0.95 : 0;
    head.scale.setScalar(0.6 + tt * 0.25);
  });
  const burst = makeVolCloud(7, pal.spark, 0.42, 0, pal.core);
  for (let i = 0; i < 7; i++) {
    const ang = rnd(seed, i + 5) * Math.PI * 2;
    const sp = 1.6 + rnd(seed, i + 15) * 2.4;
    setCloudParticle(burst, i, 0, h, reach, Math.cos(ang) * sp, 0.8 + rnd(seed, i + 25) * 2, Math.sin(ang) * sp + 0.6);
  }
  group.add(burst.points);
  anim.push((p, _t, dt) => {
    advectCloud(burst, dt, 5.5, 1.4);
    burst.mat.opacity = p > 0.28 ? 0.85 * Math.max(0, 1 - (p - 0.28) / 0.72) : 0;
  });
  const ring = volumetricShockRing(0.22, 0.05, pal.rim, 0);
  ring.position.set(0, 0.12, reach);
  group.add(ring);
  anim.push((p) => {
    const a = p > 0.28 ? (p - 0.28) / 0.72 : 0;
    ring.scale.setScalar(1 + a * reach * 1.5);
    (ring.material as THREE.MeshBasicMaterial).opacity = p > 0.28 ? 0.6 * (1 - a) : 0;
  });
}

/**
 * Heavy — a ground-shattering slam at the target: an eruption dome of fire/dust,
 * arcing debris chunks, an expanding shock torus, and a bright impact flash.
 */
function buildHeavyStrike(
  group: THREE.Group,
  anim: CombatStrikeStep[],
  reach: number,
  pal: CombatStrikePalette,
  seed: number,
  wide: boolean,
): void {
  const cx = reach * 0.85;
  const domeN = wide ? 11 : 9;
  const dome = makeVolCloud(domeN, pal.core, 0.8, 0, pal.glow);
  for (let i = 0; i < domeN; i++) {
    const ang = (i / domeN) * Math.PI * 2 + rnd(seed, i) * 0.5;
    const out = 1.4 + rnd(seed, i + 17) * 1.8;
    setCloudParticle(
      dome,
      i,
      0,
      0.2,
      cx,
      Math.cos(ang) * out,
      2.2 + rnd(seed, i + 7) * 2.4,
      Math.sin(ang) * out,
    );
  }
  group.add(dome.points);
  anim.push((p, t, dt) => {
    advectCloud(dome, dt, 4.5, 0.9, t, 2.6);
    // Bright flash early, then a slower smoke tail that lingers and grows.
    const flash = p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85;
    dome.mat.opacity = (flash * 0.6 + (1 - p) * (1 - p) * 0.4) * 0.95;
    dome.mat.size = dome.baseSize * (1 + p * 1.3);
  });
  const debris = makeVolCloud(6, pal.rim, 0.3, 0, pal.glow);
  for (let i = 0; i < 6; i++) {
    const ang = rnd(seed, i + 31) * Math.PI * 2;
    const out = 1 + rnd(seed, i + 41) * 2.4;
    setCloudParticle(debris, i, 0, 0.25, cx, Math.cos(ang) * out, 3 + rnd(seed, i + 51) * 3, Math.sin(ang) * out);
  }
  group.add(debris.points);
  anim.push((p, _t, dt) => {
    advectCloud(debris, dt, 9, 0.4);
    debris.mat.opacity = 0.8 * (1 - p);
  });
  const ring = volumetricShockRing(0.3, 0.09, pal.glow, 0);
  ring.position.set(0, 0.12, cx);
  group.add(ring);
  anim.push((p) => {
    ring.scale.setScalar(1 + p * (reach * 0.5 + 2));
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.65 * (1 - p);
  });
  const flash = glowSprite(pal.glow, 1.1, 0);
  flash.position.set(0, 0.6, cx);
  group.add(flash);
  anim.push((p) => {
    const a = Math.sin(Math.min(1, p * 2) * Math.PI);
    (flash.material as THREE.SpriteMaterial).opacity = 0.9 * a;
    flash.scale.setScalar(1.1 + p * 1.4);
  });
  addImpactStar(group, anim, 0, 0.6, cx, pal.glow, 3, reach * 0.4 + 2.4);
  addLightShaft(group, anim, 0, 0.1, cx, pal.glow, reach * 0.18 + 0.9, reach * 0.5 + 3);
}

/**
 * Titan — a colossal swirling vortex column erupting at the target, with a
 * pulsing core, twin shock rings, and heavy debris. Reads as a true 3D maelstrom.
 */
function buildTitanStrike(
  group: THREE.Group,
  anim: CombatStrikeStep[],
  reach: number,
  pal: CombatStrikePalette,
  seed: number,
): void {
  const cx = reach * 0.8;
  const N = 12;
  const vortex = makeVolCloud(N, pal.core, 0.95, 0, pal.glow);
  const ang = new Float32Array(N);
  const rad = new Float32Array(N);
  const baseY = new Float32Array(N);
  const rise = new Float32Array(N);
  const aspd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    ang[i] = rnd(seed, i) * Math.PI * 2;
    rad[i] = 0.35 + rnd(seed, i + 13) * 1.0;
    baseY[i] = rnd(seed, i + 23) * 2.4;
    rise[i] = 1.6 + rnd(seed, i + 33) * 1.8;
    aspd[i] = 4 + rnd(seed, i + 43) * 4;
  }
  group.add(vortex.points);
  anim.push((p, _t, dt) => {
    for (let i = 0; i < N; i++) {
      ang[i]! += aspd[i]! * dt;
      baseY[i]! += rise[i]! * dt;
      const r = rad[i]! * (1 - p * 0.25);
      vortex.pos[i * 3] = Math.cos(ang[i]!) * r;
      vortex.pos[i * 3 + 1] = 0.25 + baseY[i]!;
      vortex.pos[i * 3 + 2] = cx + Math.sin(ang[i]!) * r;
    }
    (vortex.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    vortex.mat.opacity = (p < 0.18 ? p / 0.18 : 1 - (p - 0.18) / 0.82) * 0.8;
  });
  const orb = glowSprite(pal.glow, 1.3, 0);
  orb.position.set(0, 0.8, cx);
  group.add(orb);
  anim.push((p, t) => {
    const pulse = 1 + Math.sin(t * 40) * 0.15 * (1 - p);
    orb.scale.setScalar((1.3 + p * 1.2) * pulse);
    (orb.material as THREE.SpriteMaterial).opacity = 0.85 * (1 - p);
  });
  addImpactStar(group, anim, 0, 0.8, cx, pal.glow, 4, reach * 0.55 + 3);
  addLightShaft(group, anim, 0, 0.1, cx, pal.glow, reach * 0.22 + 1.2, reach * 0.75 + 5);
  for (let k = 0; k < 2; k++) {
    const ring = volumetricShockRing(0.3 + k * 0.2, 0.1, k === 0 ? pal.glow : pal.rim, 0);
    ring.position.set(0, 0.13, cx);
    group.add(ring);
    const delay = k * 0.12;
    anim.push((p) => {
      const a = Math.max(0, (p - delay) / (1 - delay));
      ring.scale.setScalar(1 + a * (reach * 0.7 + 3));
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - a);
    });
  }
  const debris = makeVolCloud(8, pal.rim, 0.34, 0, pal.glow);
  for (let i = 0; i < 8; i++) {
    const a2 = rnd(seed, i + 61) * Math.PI * 2;
    const out = 1.4 + rnd(seed, i + 71) * 2.8;
    setCloudParticle(debris, i, 0, 0.3, cx, Math.cos(a2) * out, 3.4 + rnd(seed, i + 81) * 3.4, Math.sin(a2) * out);
  }
  group.add(debris.points);
  anim.push((p, t, dt) => {
    advectCloud(debris, dt, 9.5, 0.4, t, 1.4);
    debris.mat.opacity = 0.8 * (1 - p);
  });
}

export function spawnCombatHitMark(host: FxHost, m: CombatHitMark): void {
  if (m.producedUnitId === PRODUCED_UNIT_AMBER_GEODE_MONKS || m.producedUnitId === PRODUCED_UNIT_LAVA_WIZARD_MONKS) {
    spawnGeodeMonkForwardRings(host, m);
    return;
  }
  const dx = m.tx - m.ax;
  const dz = m.tz - m.az;
  const dist = Math.hypot(dx, dz);
  const reach = Math.max(0.6, Math.min(m.range, dist + 0.35) * (m.wide ? 1.12 : 1));
  const pal = elementalCombatPalette(m);
  const seed = m.visualSeed;
  const group = new THREE.Group();
  group.position.set(m.ax, 0.05, m.az);
  group.rotation.y = Math.atan2(dx, dz); // +Z aims at the target

  const anim: CombatStrikeStep[] = [];
  const life =
    m.sizeClass === "Titan" ? 0.66 : m.sizeClass === "Heavy" ? 0.56 : m.sizeClass === "Line" ? 0.48 : 0.42;
  switch (m.sizeClass) {
    case "Heavy":
      buildHeavyStrike(group, anim, reach, pal, seed, m.wide);
      break;
    case "Titan":
      buildTitanStrike(group, anim, reach, pal, seed);
      break;
    case "Line":
      buildLineStrike(group, anim, reach, pal, seed);
      break;
    case "Swarm":
    default:
      buildSwarmStrike(group, anim, reach, pal, seed);
      break;
  }

  spawn(host, group, life, (t, dt) => {
    const p = t >= life ? 1 : t / life;
    for (let i = 0; i < anim.length; i++) anim[i]!(p, t, dt);
  });
}

/** Compact unit/structure death cue: visible silhouette pop without the cost of a full spell burst. */
function spawnDeathFlash(host: FxHost, pos: { x: number; z: number }, impactRadius: number, band: AttackRangeBand): void {
  const life = 0.38;
  const pal = boomPalette(band);
  const group = new THREE.Group();
  group.position.set(pos.x, 0.12, pos.z);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.18, 0.36, 18),
    new THREE.MeshBasicMaterial({
      color: pal.hot,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);

  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.11, Math.max(0.8, impactRadius * 0.75), 6, 1, true),
    new THREE.MeshBasicMaterial({
      color: pal.rim,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  beam.position.y = Math.max(0.4, impactRadius * 0.38);
  group.add(beam);

  spawn(host, group, life, (t) => {
    const p = Math.min(1, t / life);
    const s = 1 + p * impactRadius;
    ring.scale.setScalar(s);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - p);
    beam.scale.set(1 + p * 0.45, 1 + p * 0.2, 1 + p * 0.45);
    (beam.material as THREE.MeshBasicMaterial).opacity = 0.34 * (1 - p);
  });
}

/** Jagged polyline in world space (XZ + arc height) for arcane bolt. */
function heroStrikeBoltPoints(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  segments: number,
  jitter: number,
  seed: number,
): Float32Array {
  const px = bz - az;
  const pz = -(bx - ax);
  const plen = Math.hypot(px, pz) || 1;
  const nx = px / plen;
  const nz = pz / plen;
  const rnd = (i: number) => {
    const u = Math.sin(seed * 12.9898 + i * 78.233 + ax * 0.1 + bz * 0.07) * 43758.5453;
    return (u - Math.floor(u)) * 2 - 1;
  };
  const arr = new Float32Array((segments + 1) * 3);
  let o = 0;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const arc = Math.sin(t * Math.PI);
    const j = i > 0 && i < segments ? rnd(i) * jitter : 0;
    arr[o++] = ax + (bx - ax) * t + nx * j;
    arr[o++] = 0.35 + arc * 3.2;
    arr[o++] = az + (bz - az) * t + nz * j;
  }
  return arr;
}

function heroStrikeElementalPalette(v: HeroStrikeFxVariant | undefined, visualSeed?: number): {
  core: number;
  rim: number;
  bolt: number;
  fork: number;
  cone: number;
} {
  if (v?.startsWith("player_") && visualSeed !== undefined) {
    if (visualSeed > 0 && visualSeed % 3 === 0) {
      return { core: 0xb15cff, rim: 0xffffff, bolt: 0xf3dcff, fork: 0xd27cff, cone: 0x7a22ff };
    }
    const elemental = [
      { core: 0xff8a32, rim: 0xfff0bb, bolt: 0xffcf66, fork: 0xff5522, cone: 0xff3b00 },
      { core: 0x6ee7ff, rim: 0xffffff, bolt: 0xdfffff, fork: 0x6aafff, cone: 0x188bff },
      { core: 0x5cff99, rim: 0xeefff5, bolt: 0xb8ffd8, fork: 0x5eea8a, cone: 0x20a860 },
      { core: 0x74a7ff, rim: 0xf4fbff, bolt: 0xcfe4ff, fork: 0x66d8ff, cone: 0x2366ff },
      { core: 0xf4d06f, rim: 0xffffdd, bolt: 0xfff0aa, fork: 0xd49a44, cone: 0x9b6a28 },
    ] as const;
    const nonPurpleIndex = Math.max(0, visualSeed - 1 - Math.floor((visualSeed - 1) / 3));
    return elemental[nonPurpleIndex % elemental.length];
  }
  switch (v) {
    case "player_vs_unit":
      return { core: 0xb8a0ff, rim: 0xffffff, bolt: 0xf0e8ff, fork: 0xaaddff, cone: 0x8866ff };
    case "player_arcane_sweep":
      return { core: 0x66ccff, rim: 0xe8ffff, bolt: 0xffffff, fork: 0x44aaff, cone: 0x2266dd };
    case "player_vs_rival":
      return { core: 0xffaac8, rim: 0xffffff, bolt: 0xffeef8, fork: 0xff88cc, cone: 0xff4488 };
    case "player_vs_fortress":
      return { core: 0xffcc66, rim: 0xffffff, bolt: 0xffeecc, fork: 0xff9944, cone: 0xff6622 };
    case "player_vs_structure":
      return { core: 0x88ddff, rim: 0xffffff, bolt: 0xddffff, fork: 0x66bbff, cone: 0x3399ff };
    case "player_vs_anchor":
      return { core: 0x66eeff, rim: 0xffffff, bolt: 0xe8ffff, fork: 0x44ccff, cone: 0x22aadd };
    case "rival_vs_hero":
      return { core: 0xff4466, rim: 0xffccaa, bolt: 0xffaa88, fork: 0xff2200, cone: 0xaa0022 };
    case "rival_vs_unit":
      return { core: 0xff8866, rim: 0xffddaa, bolt: 0xffcc99, fork: 0xff5533, cone: 0xcc3311 };
    case "rival_vs_anchor":
      return { core: 0xff66aa, rim: 0xffeeff, bolt: 0xffaadd, fork: 0xff3399, cone: 0xaa2266 };
    case "rival_vs_keep":
      return { core: 0xffaa44, rim: 0xffffcc, bolt: 0xffdd99, fork: 0xff7722, cone: 0xcc4400 };
    default:
      return { core: 0xc9a8ff, rim: 0xffffff, bolt: 0xe8ddff, fork: 0xaaccff, cone: 0x8866cc };
  }
}

/** Convert a flat `[x,y,z,...]` bolt path into Vector3 control points for a tube. */
function boltPointsToVectors(arr: ArrayLike<number>): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i + 2 < arr.length; i += 3) out.push(new THREE.Vector3(arr[i]!, arr[i + 1]!, arr[i + 2]!));
  return out;
}

/** Volumetric hero strike: an arcing energy bolt with a glow shell, a fork, and a torus impact bloom. */
function spawnHeroStrike(
  host: FxHost,
  pos: { x: number; z: number },
  from?: { x: number; z: number },
  strikeVariant?: HeroStrikeFxVariant,
  visualSeed?: number,
): void {
  const life = 0.46;
  const pal = heroStrikeElementalPalette(strikeVariant, visualSeed);
  const root = new THREE.Group();
  const anim: CombatStrikeStep[] = [];

  // Impact shockwave — a real torus ring with cross-section, not a flat ring plane.
  const ring = volumetricShockRing(0.35, 0.13, pal.core, 0.9);
  ring.position.set(pos.x, 0.14, pos.z);
  root.add(ring);
  anim.push((p) => {
    ring.scale.setScalar(1 + p * 3);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - p);
  });

  // Impact bloom — soft volumetric flash at the target.
  const flash = glowSprite(pal.rim, 1.4, 0);
  flash.position.set(pos.x, 0.6, pos.z);
  root.add(flash);
  anim.push((p) => {
    const a = Math.sin(Math.min(1, p * 2) * Math.PI);
    (flash.material as THREE.SpriteMaterial).opacity = 0.95 * a;
    flash.scale.setScalar(1.4 + p * 1.7);
  });
  addImpactStar(root, anim, pos.x, 0.6, pos.z, pal.rim, 4, 3.2);
  addLightShaft(root, anim, pos.x, 0.1, pos.z, pal.core, 1.1, 4.2);

  // Impact burst — outward/upward particle body.
  const seed = visualSeed ?? pos.x * 0.41 + pos.z * 0.17;
  const burst = makeVolCloud(9, pal.bolt, 0.55, 0, pal.rim);
  burst.points.position.set(pos.x, 0, pos.z);
  for (let i = 0; i < 9; i++) {
    const ang = rnd(seed, i + 3) * Math.PI * 2;
    const sp = 2 + rnd(seed, i + 13) * 3;
    setCloudParticle(burst, i, 0, 0.5, 0, Math.cos(ang) * sp, 1.4 + rnd(seed, i + 23) * 2.6, Math.sin(ang) * sp);
  }
  root.add(burst.points);
  anim.push((p, t, dt) => {
    advectCloud(burst, dt, 6, 1.1, t, 1.8);
    burst.mat.opacity = 0.85 * (1 - p);
  });

  if (from) {
    const ax = from.x;
    const az = from.z;
    const dx = pos.x - ax;
    const dz = pos.z - az;
    const dist = Math.hypot(dx, dz);
    const segs = Math.max(6, Math.min(16, Math.round(dist * 1.25)));
    const jitter = Math.min(1.6, 0.28 + dist * 0.09);
    const boltSeed = (ax + pos.z) * 0.413 + dist * 0.17;
    const tubular = Math.max(28, segs * 3);

    // Soft outer glow shell around the bolt.
    const shellPts = boltPointsToVectors(heroStrikeBoltPoints(ax, az, pos.x, pos.z, segs, jitter, boltSeed));
    const shell = volumetricStream(shellPts, 0.28, pal.cone, 0, tubular, 8);
    root.add(shell);
    const shellMat = shell.material as THREE.MeshBasicMaterial;
    anim.push((p) => {
      shellMat.opacity = 0.34 * (1 - p);
    });

    // Bright volumetric bolt core.
    const bolt = volumetricStream(shellPts, 0.1, pal.bolt, 0, tubular, 6);
    root.add(bolt);
    const boltMat = bolt.material as THREE.MeshBasicMaterial;
    anim.push((p) => {
      boltMat.opacity = 0.95 * (1 - p * 0.85);
    });

    // Forked branch.
    const forkPts = boltPointsToVectors(heroStrikeBoltPoints(ax, az, pos.x, pos.z, segs, jitter * 0.82, boltSeed + 19.1));
    const fork = volumetricStream(forkPts, 0.06, pal.fork, 0, tubular, 5);
    root.add(fork);
    const forkMat = fork.material as THREE.MeshBasicMaterial;
    anim.push((p) => {
      forkMat.opacity = 0.6 * (1 - p);
    });
  }

  spawn(host, root, life, (t, dt) => {
    const p = t >= life ? 1 : t / life;
    for (let i = 0; i < anim.length; i++) anim[i]!(p, t, dt);
  });
}

/** Expanding red ring + ember surge. */
function spawnFirestorm(host: FxHost, pos: { x: number; z: number }, radius = 11): void {
  const life = 0.95;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.12, pos.z);

  /** Fixed band; scale each frame — avoids dispose+rebuild every step (GPU stalls). */
  const ringGeo = new THREE.RingGeometry(0.1, 0.6, 48);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xff6a2a,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);

  const innerGeo = new THREE.RingGeometry(0.2, 0.5, 32);
  const innerMat = new THREE.MeshBasicMaterial({
    color: 0xffd77a,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const inner = new THREE.Mesh(innerGeo, innerMat);
  inner.rotation.x = -Math.PI / 2;
  group.add(inner);

  const scorch = new THREE.Mesh(
    new THREE.CircleGeometry(1, 36),
    new THREE.MeshBasicMaterial({
      color: 0x8a1f10,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  scorch.rotation.x = -Math.PI / 2;
  scorch.position.y = -0.015;
  group.add(scorch);

  const pillars: THREE.Mesh[] = [];
  const pillarCount = Math.max(6, Math.round(radius * 0.45));
  for (let i = 0; i < pillarCount; i++) {
    const pillarH = Math.max(4.8, radius * 0.58);
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.26, 0.72, pillarH, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? 0xffdd66 : 0xff5522,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const ang = (i / pillarCount) * Math.PI * 2 + 0.35;
    const rr = radius * (i === 0 ? 0 : 0.28 + ((i * 7) % 5) * 0.11);
    pillar.position.set(Math.cos(ang) * rr, pillarH * 0.47, Math.sin(ang) * rr);
    group.add(pillar);
    pillars.push(pillar);
  }

  const embers: { mesh: THREE.Mesh; vy: number; vx: number; vz: number }[] = [];
  const emberCount = Math.max(24, Math.round(radius * 2.3));
  for (let i = 0; i < emberCount; i++) {
    const g = new THREE.SphereGeometry(0.18, 6, 6);
    const m = new THREE.MeshBasicMaterial({
      color: 0xffaa44,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const e = new THREE.Mesh(g, m);
    const ang = (i / emberCount) * Math.PI * 2 + Math.random() * 0.4;
    const sp = 4.5 + Math.random() * 4.5;
    e.position.set(Math.cos(ang) * 0.3, 0.3, Math.sin(ang) * 0.3);
    group.add(e);
    embers.push({
      mesh: e,
      vx: Math.cos(ang) * sp,
      vz: Math.sin(ang) * sp,
      vy: 3 + Math.random() * 2,
    });
  }

  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    const rOuter = 0.6 + p * radius;
    ring.scale.setScalar(rOuter / 0.6);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - p);
    (inner.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - p * 1.4);
    inner.scale.setScalar(1 + p * Math.max(3, radius * 0.34));
    scorch.scale.setScalar(Math.max(0.5, radius * 0.78) * (0.7 + p * 0.45));
    (scorch.material as THREE.MeshBasicMaterial).opacity = 0.28 * (1 - p * 0.55);
    for (const pillar of pillars) {
      pillar.scale.set(1 + p * 0.7, 1 + p * 0.18, 1 + p * 0.7);
      (pillar.material as THREE.MeshBasicMaterial).opacity = 0.32 * (1 - p);
    }
    for (const e of embers) {
      e.mesh.position.x += e.vx * dt;
      e.mesh.position.z += e.vz * dt;
      e.mesh.position.y += e.vy * dt;
      e.vy -= 9 * dt;
      (e.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - p);
    }
  });
}

function boomPalette(band: AttackRangeBand): { core: number; hot: number; rim: number } {
  switch (band) {
    case "close":
      return { core: 0xc4a574, hot: 0xfff2cc, rim: 0x7a5a32 };
    case "long":
      return { core: 0xff5522, hot: 0xffee88, rim: 0xff2200 };
    case "medium":
    default:
      return { core: 0x44b8ff, hot: 0xe8ffff, rim: 0x1166aa };
  }
}

/** Ground shock disc + pillar flash — spell AoE and artillery-style impacts. */
function spawnCombatBoom(
  host: FxHost,
  pos: { x: number; z: number },
  impactRadius: number,
  band: AttackRangeBand,
): void {
  const life = 0.55;
  const pal = boomPalette(band);
  const group = new THREE.Group();
  group.position.set(pos.x, 0.1, pos.z);

  const disc = new THREE.Mesh(
    new THREE.RingGeometry(0.15, 0.45, 40, 1),
    new THREE.MeshBasicMaterial({
      color: pal.core,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  disc.rotation.x = -Math.PI / 2;
  group.add(disc);

  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(impactRadius * 0.12, impactRadius * 0.22, impactRadius * 0.85, 16, 1, true),
    new THREE.MeshBasicMaterial({
      color: pal.hot,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  pillar.position.y = impactRadius * 0.35;
  group.add(pillar);

  const sparks: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < 10; i++) {
    const g = new THREE.SphereGeometry(0.12 + (i % 3) * 0.06, 5, 5);
    const m = new THREE.MeshBasicMaterial({
      color: i % 2 === 0 ? pal.rim : pal.hot,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    sparks.push(m);
    const mesh = new THREE.Mesh(g, m);
    const a = (i / 10) * Math.PI * 2;
    mesh.position.set(Math.cos(a) * impactRadius * 0.2, 0.4 + i * 0.08, Math.sin(a) * impactRadius * 0.2);
    group.add(mesh);
  }

  spawn(host, group, life, (t, _dt) => {
    const p = Math.min(1, t / life);
    const scl = 1 + p * (impactRadius / 0.45);
    disc.scale.setScalar(scl);
    (disc.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - p);
    pillar.scale.set(1 + p * 0.2, 1 + p * 0.35, 1 + p * 0.2);
    (pillar.material as THREE.MeshBasicMaterial).opacity = 0.35 * (1 - p * 0.9);
    for (const m of sparks) m.opacity = 0.9 * (1 - p);
  });
}

/** Concentric shockwave rings + crack decal for Shatter chain impacts. */
function spawnShatter(host: FxHost, pos: { x: number; z: number }, radius = 16): void {
  const life = 1.05;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.2, pos.z);

  const rings: { mesh: THREE.Mesh; speed: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Mesh(
      new THREE.RingGeometry(0.2, 0.55, 40),
      new THREE.MeshBasicMaterial({
        color: i === 0 ? 0xffffff : i === 1 ? 0x8fd6ff : 0xc8b3ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    r.rotation.x = -Math.PI / 2;
    group.add(r);
    rings.push({ mesh: r, speed: radius * (0.55 + i * 0.32) });
  }

  const pillarH = Math.max(5.2, radius * 0.52);
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.48, pillarH, 9, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xe8f6ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  pillar.position.y = pillarH * 0.5;
  group.add(pillar);

  // Crack decal — a few thin rectangles radiating.
  const cracks: THREE.Mesh[] = [];
  for (let i = 0; i < 9; i++) {
    const g = new THREE.PlaneGeometry(0.18, radius * (0.56 + (i % 3) * 0.14));
    const m = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });
    const c = new THREE.Mesh(g, m);
    c.rotation.x = -Math.PI / 2;
    c.rotation.z = (i / 9) * Math.PI * 2;
    c.position.y = 0.01;
    group.add(c);
    cracks.push(c);
  }

  spawn(host, group, life, (t) => {
    const p = Math.min(1, t / life);
    for (const r of rings) {
      const outer = 0.55 + t * r.speed;
      r.mesh.scale.setScalar(outer / 0.55);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - p);
    }
    pillar.scale.set(1 + p * 0.5, 1 + p * 0.22, 1 + p * 0.5);
    (pillar.material as THREE.MeshBasicMaterial).opacity = 0.38 * (1 - p);
    for (const c of cracks) {
      (c.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - p * 0.8);
    }
  });
}

/** Cyan hex-shield shell that expands and fades. */
function spawnFortify(host: FxHost, pos: { x: number; z: number }, radius = 18): void {
  const life = 0.72;
  const group = new THREE.Group();
  group.position.set(pos.x, 0, pos.z);
  const geo = new THREE.IcosahedronGeometry(1.25, 1);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x6ae1ff,
    wireframe: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const shell = new THREE.Mesh(geo, mat);
  shell.position.set(0, Math.max(2.7, radius * 0.2), 0);
  group.add(shell);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.35, 0.75, 56),
    new THREE.MeshBasicMaterial({
      color: 0x92f2ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.08;
  group.add(ring);

  spawn(host, group, life, (t) => {
    const p = Math.min(1, t / life);
    const s = 1 + p * Math.max(3.4, radius * 0.18);
    shell.scale.setScalar(s);
    shell.rotation.y = p * 1.8;
    (shell.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - p);
    ring.scale.setScalar(Math.max(1, (radius / 0.75) * (0.25 + p * 0.9)));
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.68 * (1 - p * 0.9);
  });
}

/** Upward gold beam flash. */
function spawnMuster(host: FxHost, pos: { x: number; z: number }): void {
  const life = 0.45;
  const h = 7;
  const geo = new THREE.CylinderGeometry(0.2, 0.7, h, 20, 1, true);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffd968,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const beam = new THREE.Mesh(geo, mat);
  beam.position.set(pos.x, h / 2, pos.z);

  spawn(host, beam, life, (t) => {
    const p = Math.min(1, t / life);
    beam.scale.set(1 + p * 0.8, 1, 1 + p * 0.8);
    (beam.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - p);
  });
}

/** Reclaim line sweep: additive corridor aligned from `from` → `end`. */
function spawnLineCleave(
  host: FxHost,
  end: { x: number; z: number },
  from?: { x: number; z: number },
  corridorWidth?: number,
): void {
  if (!from) return;
  const dx = end.x - from.x;
  const dz = end.z - from.z;
  const L = Math.hypot(dx, dz);
  if (L < 0.5) return;
  const halfW = Math.max(0.6, (corridorWidth ?? 7) * 0.5);
  const life = 0.62;
  const group = new THREE.Group();
  const cx = (from.x + end.x) * 0.5;
  const cz = (from.z + end.z) * 0.5;
  group.position.set(cx, 0.12, cz);
  group.rotation.y = Math.atan2(dx, dz);

  // Volumetric blade edge (core tube + soft shell) sweeping the corridor, with a
  // particle swath bursting along its length — not a flat slab box.
  const y = 0.45;
  const bladePts = [
    new THREE.Vector3(0, y, -L * 0.5),
    new THREE.Vector3(0, y + 0.15, 0),
    new THREE.Vector3(0, y, L * 0.5),
  ];
  const shell = volumetricStream(bladePts, Math.max(0.5, halfW * 0.7), 0xff66dd, 0, 22, 8);
  const core = volumetricStream(bladePts, Math.max(0.18, halfW * 0.22), 0xb8ffd4, 0, 22, 6);
  group.add(shell);
  group.add(core);
  const shellMat = shell.material as THREE.MeshBasicMaterial;
  const coreMat = core.material as THREE.MeshBasicMaterial;

  const seed = (cx + cz) * 0.21 + L * 0.13;
  const N = Math.min(24, Math.max(10, Math.round(L * 0.6)));
  const swath = makeVolCloud(N, 0xcfffe4, 0.5, 0);
  for (let i = 0; i < N; i++) {
    const z = (rnd(seed, i) - 0.5) * L;
    const side = rnd(seed, i + 20) < 0.5 ? -1 : 1;
    setCloudParticle(
      swath,
      i,
      side * halfW * 0.2,
      y,
      z,
      side * (2 + rnd(seed, i + 30) * 3),
      1 + rnd(seed, i + 40) * 2,
      (rnd(seed, i + 50) - 0.5) * 1.5,
    );
  }
  group.add(swath.points);

  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    const pulse = 1 + 0.18 * Math.sin(p * Math.PI);
    core.scale.set(pulse, pulse, 1);
    shell.scale.set(pulse, pulse, 1);
    coreMat.opacity = 0.7 * (1 - p);
    shellMat.opacity = 0.32 * (1 - p * 0.9);
    advectCloud(swath, dt, 4, 1.1, t, 1.6);
    swath.mat.opacity = 0.6 * (1 - p);
  });
}

/** Cyan claim burst: expanding ring + upward streaks. */
function spawnClaim(host: FxHost, pos: { x: number; z: number }): void {
  const life = 0.9;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.12, pos.z);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.8, 48),
    new THREE.MeshBasicMaterial({
      color: 0x6ae1ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);

  const streaks: { mesh: THREE.Mesh; vy: number; vx: number; vz: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const ang = (i / 10) * Math.PI * 2;
    const g = new THREE.CylinderGeometry(0.06, 0.06, 0.9, 6);
    const m = new THREE.MeshBasicMaterial({
      color: 0x9ef0ff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const p = new THREE.Mesh(g, m);
    p.position.set(Math.cos(ang) * 0.6, 0.5, Math.sin(ang) * 0.6);
    group.add(p);
    streaks.push({
      mesh: p,
      vx: Math.cos(ang) * 0.6,
      vz: Math.sin(ang) * 0.6,
      vy: 3.5 + Math.random() * 1.6,
    });
  }

  const maxR = 4.5;
  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    const outer = 0.8 + p * maxR;
    ring.scale.setScalar(outer / 0.8);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - p);
    for (const st of streaks) {
      st.mesh.position.x += st.vx * dt;
      st.mesh.position.z += st.vz * dt;
      st.mesh.position.y += st.vy * dt;
      st.vy -= 5 * dt;
      (st.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - p);
    }
  });
}

/** Vanguard-style summon accent: fast outward sparks. */
function spawnSparkBurst(host: FxHost, pos: { x: number; z: number }): void {
  const life = 0.42;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.05, pos.z);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.25, 0.48, 22),
    new THREE.MeshBasicMaterial({
      color: 0xff5522,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);
  spawn(host, group, life, (t) => {
    const p = Math.min(1, t / life);
    ring.scale.setScalar(1 + p * 10);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.88 * (1 - p);
  });
}

/** Bastion-style summon accent: dusty radial crack. */
function spawnGroundCrack(host: FxHost, pos: { x: number; z: number }): void {
  const life = 0.48;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.04, pos.z);
  const crack = new THREE.Mesh(
    new THREE.RingGeometry(0.25, 3.35, 40, 1, 0, Math.PI * 1.72),
    new THREE.MeshBasicMaterial({
      color: 0x8899aa,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    }),
  );
  crack.rotation.x = -Math.PI / 2;
  crack.rotation.z = Math.random() * Math.PI * 2;
  group.add(crack);
  spawn(host, group, life, (t) => {
    const p = Math.min(1, t / life);
    (crack.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - p);
  });
}

/** Reclaim-style summon accent: violet pulse ring. */
function spawnReclaimPulse(host: FxHost, pos: { x: number; z: number }): void {
  const life = 0.48;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.06, pos.z);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.4, 0.62, 24),
    new THREE.MeshBasicMaterial({
      color: 0xcc66ff,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);
  spawn(host, group, life, (t) => {
    const p = Math.min(1, t / life);
    ring.scale.setScalar(1 + p * 6.2);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - p);
  });
}

/**
 * Summon lightning: a jagged bolt flashes from the sky to the strike point,
 * detonates a bright ground flash + shockwave ring, and throws up cyan sparks.
 * Used for building placements (and anything else that should feel like a
 * powerful spell being cast).
 */
function spawnLightning(host: FxHost, pos: { x: number; z: number }): void {
  /** Short bolt read; wall-clock cap in `spawn` / `stepFx` enforces FX_ABSOLUTE_MAX_LIFETIME_SEC. */
  const life = 0.42;
  const group = new THREE.Group();
  group.position.set(pos.x, 0, pos.z);

  const skyY = 34;
  const segments = 10;
  const jitter = 0.9;
  const pts: THREE.Vector3[] = [];
  pts.push(new THREE.Vector3(0, 0.05, 0));
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    const y = t * skyY;
    const jx = (Math.random() - 0.5) * jitter * (1 - Math.abs(0.5 - t) * 2);
    const jz = (Math.random() - 0.5) * jitter * (1 - Math.abs(0.5 - t) * 2);
    pts.push(new THREE.Vector3(jx, y, jz));
  }
  pts.push(new THREE.Vector3(0, skyY, 0));

  // Volumetric bolt — a glowing tube core inside a soft shell, not a 2px line.
  const boltTubular = Math.max(28, segments * 3);
  const boltShell = volumetricStream(pts, 0.34, 0x9fdcff, 0, boltTubular, 7);
  const bolt = volumetricStream(pts, 0.13, 0xe8f6ff, 1, boltTubular, 6);
  group.add(boltShell);
  group.add(bolt);

  // Short-lived branch bolts (thin tubes).
  const branchMats: THREE.MeshBasicMaterial[] = [];
  for (let b = 0; b < 2; b++) {
    const anchor = pts[3 + b * 2] ?? pts[3]!;
    const bpts: THREE.Vector3[] = [anchor.clone()];
    const dirX = (Math.random() - 0.5) * 2;
    const dirZ = (Math.random() - 0.5) * 2;
    let cur = anchor.clone();
    for (let i = 0; i < 5; i++) {
      cur = cur.clone();
      cur.x += dirX * 0.6 + (Math.random() - 0.5) * 0.4;
      cur.z += dirZ * 0.6 + (Math.random() - 0.5) * 0.4;
      cur.y -= 0.6 + Math.random() * 0.6;
      if (cur.y < 0.1) cur.y = 0.1;
      bpts.push(cur);
    }
    const tube = volumetricStream(bpts, 0.07, 0xcfeaff, 0.85, 16, 5);
    group.add(tube);
    branchMats.push(tube.material as THREE.MeshBasicMaterial);
  }

  // Ground flash disc (bright, very short).
  const flash = new THREE.Mesh(
    new THREE.CircleGeometry(2.6, 40),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  flash.rotation.x = -Math.PI / 2;
  flash.position.y = 0.05;
  group.add(flash);

  // Expanding shockwave ring (scaled each frame — no geometry churn).
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.4, 0.9, 48),
    new THREE.MeshBasicMaterial({
      color: 0x8fd6ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  group.add(ring);

  // Cyan sparks shooting up + out.
  const sparks: { mesh: THREE.Mesh; vx: number; vy: number; vz: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = 3 + Math.random() * 4;
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 6, 6),
      new THREE.MeshBasicMaterial({
        color: 0xd0f2ff,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    m.position.set(Math.cos(ang) * 0.2, 0.3, Math.sin(ang) * 0.2);
    group.add(m);
    sparks.push({
      mesh: m,
      vx: Math.cos(ang) * sp,
      vz: Math.sin(ang) * sp,
      vy: 4 + Math.random() * 3,
    });
  }

  const maxRing = 5.2;
  addImpactStarFx(host, pos.x, 0.6, pos.z, 0xeaf6ff, 4, 3.6, life);
  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    // Bolt + tube flicker for the first ~0.18s, then fade.
    const strikePhase = t < 0.18 ? 1 : Math.max(0, 1 - (t - 0.18) / (life - 0.18));
    const flicker = 0.55 + 0.45 * Math.abs(Math.sin(t * 90));
    const boltOp = strikePhase * flicker;
    (bolt.material as THREE.MeshBasicMaterial).opacity = boltOp;
    bolt.visible = boltOp > 0.02;
    (boltShell.material as THREE.MeshBasicMaterial).opacity = boltOp * 0.42;
    boltShell.visible = boltOp > 0.02;
    for (const bm of branchMats) bm.opacity = 0.85 * strikePhase * flicker;
    // Ground flash pops for ~0.12s then disappears.
    const flashP = t < 0.12 ? 1 - t / 0.12 : 0;
    (flash.material as THREE.MeshBasicMaterial).opacity = 0.95 * flashP;
    flash.scale.setScalar(1 + (1 - flashP) * 0.8);
    // Shockwave ring expands.
    const outer = 0.9 + p * maxRing;
    ring.scale.setScalar(outer / 0.9);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - p);
    // Sparks arc outward with gravity.
    for (const sp of sparks) {
      sp.mesh.position.x += sp.vx * dt;
      sp.mesh.position.z += sp.vz * dt;
      sp.mesh.position.y += sp.vy * dt;
      sp.vy -= 10 * dt;
      if (sp.mesh.position.y < 0.05) sp.mesh.position.y = 0.05;
      (sp.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - p;
    }
  });
}

/** B10 siege tell — a small orange ring at an enemy building that was just shredded. */
export function spawnSiegeTell(host: FxHost, pos: { x: number; z: number }): void {
  const life = 0.35;
  const geo = new THREE.RingGeometry(0.4, 0.7, 24);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff9040,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(geo, mat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(pos.x, 0.18, pos.z);

  spawn(host, ring, life, (t) => {
    const p = Math.min(1, t / life);
    const rOuter = 0.7 + p * 1.2;
    ring.scale.setScalar(rOuter / 0.7);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - p);
  });
}
