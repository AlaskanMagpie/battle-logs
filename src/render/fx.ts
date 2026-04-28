import * as THREE from "three";
import { FX_ABSOLUTE_MAX_LIFETIME_SEC, PRODUCED_UNIT_AMBER_GEODE_MONKS } from "../game/constants";
import type { AttackRangeBand, CastFxKind, CombatHitMark, HeroStrikeFxVariant } from "../game/state";
import type { SpellFxElement, SpellFxShape } from "../game/types";

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
  const keep: ActiveFx[] = [];
  for (const fx of host.active) {
    fx.age += dt;
    fx.update(fx.age, dt);
    const wallMs = now - fx.createdAtMs;
    if (fx.age < fx.life && wallMs < maxWallMs) {
      keep.push(fx);
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
  host.active = keep;
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
    const geo = "geometry" in c ? (c as { geometry?: THREE.BufferGeometry }).geometry : undefined;
    if (geo && typeof geo.dispose === "function") geo.dispose();
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

/** Fan of triangles: apex at origin, opening toward +Z, lying near y. */
function createGroundConeGeometry(halfAngle: number, reach: number, y: number, segments: number): THREE.BufferGeometry {
  const positions: number[] = [0, y, 0];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const ang = -halfAngle + t * (2 * halfAngle);
    positions.push(Math.sin(ang) * reach, y * 0.92, Math.cos(ang) * reach);
  }
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    indices.push(0, 1 + i, 2 + i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
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

function lineMat(color: number, opacity: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function elementalSeed(pos: { x: number; z: number }, opts?: CastFxSpawnOpts): number {
  return opts?.visualSeed ?? pos.x * 0.173 + pos.z * 0.319 + performance.now() * 0.001;
}

function spawnElementalSpell(host: FxHost, pos: { x: number; z: number }, opts?: CastFxSpawnOpts): void {
  const element = opts?.element ?? "arcane";
  const shape = opts?.shape ?? "impact";
  const pal = spellPalette(element);
  switch (shape) {
    case "bolt":
    case "chain":
      return spawnElementalBolt(host, pos, opts, pal);
    case "beam":
      return spawnElementalLine(host, pos, opts, pal, true);
    case "line":
      return spawnElementalLine(host, pos, opts, pal, false);
    case "cone":
      return spawnElementalCone(host, pos, opts, pal);
    case "field":
      return spawnElementalField(host, pos, opts, pal);
    case "meteor":
      return spawnElementalMeteor(host, pos, opts, pal);
    case "aoe":
      return spawnElementalAoe(host, pos, opts, pal, false);
    case "impact":
    case "burst":
    default:
      return spawnElementalAoe(host, pos, opts, pal, true);
  }
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

  const primaryGeo = new THREE.BufferGeometry();
  if (from) {
    primaryGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(heroStrikeBoltPoints(from.x, from.z, pos.x, pos.z, segs, jitter, seed), 3),
    );
  } else {
    const pts: number[] = [];
    const skyY = Math.max(18, opts?.impactRadius ? opts.impactRadius * 1.6 : 22);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const fall = 1 - t;
      const amp = Math.sin(t * Math.PI) * jitter;
      pts.push(
        pos.x + (rnd(seed, i) - 0.5) * amp,
        0.25 + skyY * fall,
        pos.z + (rnd(seed, i + 29) - 0.5) * amp,
      );
    }
    primaryGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  }

  const primaryMat = lineMat(pal.core, 0.96);
  const primary = new THREE.Line(primaryGeo, primaryMat);
  root.add(primary);

  const forks: THREE.Line[] = [];
  const forkCount = from ? 2 : 3;
  for (let k = 0; k < forkCount; k++) {
    const forkGeo = new THREE.BufferGeometry();
    if (from) {
      forkGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(
          heroStrikeBoltPoints(from.x, from.z, pos.x, pos.z, Math.max(5, segs - 2), jitter * 0.72, seed + 11 + k),
          3,
        ),
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
      forkGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    }
    const fork = new THREE.Line(forkGeo, lineMat(k % 2 === 0 ? pal.hot : pal.trail, 0.6));
    forks.push(fork);
    root.add(fork);
  }

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.78, 34), fxMat(pal.rim, 0.78));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(pos.x, 0.1, pos.z);
  root.add(ring);

  const flash = new THREE.Mesh(new THREE.CircleGeometry(1.35, 28), fxMat(pal.core, 0.58));
  flash.rotation.x = -Math.PI / 2;
  flash.position.set(pos.x, 0.11, pos.z);
  root.add(flash);

  spawn(host, root, life, (t) => {
    const p = Math.min(1, t / life);
    const snap = t < 0.16 ? 1 : Math.max(0, 1 - (t - 0.16) / (life - 0.16));
    const flicker = 0.62 + 0.38 * Math.abs(Math.sin(t * 110));
    primaryMat.opacity = 0.96 * snap * flicker;
    primary.visible = primaryMat.opacity > 0.03;
    for (const fork of forks) {
      const m = fork.material as THREE.LineBasicMaterial;
      m.opacity = 0.6 * snap * flicker;
      fork.visible = m.opacity > 0.03;
    }
    ring.scale.setScalar(1 + p * 4.3);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.78 * (1 - p);
    flash.scale.setScalar(1 + p * 0.85);
    (flash.material as THREE.MeshBasicMaterial).opacity = t < 0.12 ? 0.58 * (1 - t / 0.12) : 0;
  });
}

function spawnElementalLine(
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

  const core = new THREE.Mesh(
    new THREE.BoxGeometry(focused ? Math.max(0.24, halfW * 0.58) : halfW * 2, focused ? 0.3 : 0.18, L),
    fxMat(focused ? pal.core : pal.hot, focused ? 0.5 : 0.12),
  );
  group.add(core);
  const rim = new THREE.Mesh(
    new THREE.BoxGeometry(halfW * (focused ? 1.7 : 2.25), 0.12, L + 0.4),
    fxMat(focused ? pal.hot : pal.rim, focused ? 0.28 : 0.1),
  );
  rim.position.y = -0.01;
  group.add(rim);

  const rails: THREE.Line[] = [];
  for (let side = -1; side <= 1; side += 2) {
    const railGeo = new THREE.BufferGeometry();
    const pts = new Float32Array([
      side * halfW * 0.92,
      0.42,
      -L * 0.5,
      side * halfW * 0.35,
      0.58,
      0,
      side * halfW * 0.92,
      0.42,
      L * 0.5,
    ]);
    railGeo.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    const rail = new THREE.Line(railGeo, lineMat(side < 0 ? pal.trail : pal.hot, focused ? 0.66 : 0.36));
    rails.push(rail);
    group.add(rail);
  }

  const seed = elementalSeed(end, opts);
  const motes: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; vx: number; vy: number; vz: number }[] = [];
  const moteCount = focused ? 5 : Math.min(18, Math.max(7, Math.round(L * 0.18)));
  for (let i = 0; i < moteCount; i++) {
    const mat = fxMat(i % 2 === 0 ? pal.trail : pal.hot, 0.78);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(focused ? 0.08 : 0.12, 5, 4), mat);
    const z = -L * 0.45 + rnd(seed, i) * L * 0.9;
    mesh.position.set((rnd(seed, i + 10) - 0.5) * width, 0.26 + rnd(seed, i + 20) * 0.4, z);
    motes.push({
      mesh,
      mat,
      vx: (rnd(seed, i + 30) - 0.5) * 1.2,
      vy: 1.1 + rnd(seed, i + 40) * 1.8,
      vz: (rnd(seed, i + 50) - 0.5) * 2.2,
    });
    group.add(mesh);
  }

  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    const pulse = 1 + Math.sin(p * Math.PI) * (focused ? 0.08 : 0.12);
    group.scale.set(pulse, 1, 1 + Math.sin(p * Math.PI) * 0.03);
    (core.material as THREE.MeshBasicMaterial).opacity = (focused ? 0.5 : 0.12) * (1 - p);
    (rim.material as THREE.MeshBasicMaterial).opacity = (focused ? 0.28 : 0.1) * (1 - p * 0.9);
    for (const rail of rails) {
      (rail.material as THREE.LineBasicMaterial).opacity = (focused ? 0.66 : 0.36) * (1 - p);
    }
    for (const m of motes) {
      m.mesh.position.x += m.vx * dt;
      m.mesh.position.y += m.vy * dt;
      m.mesh.position.z += m.vz * dt;
      m.vy -= 5.8 * dt;
      m.mat.opacity = 0.78 * (1 - p);
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

  const outer = new THREE.Mesh(createGroundConeGeometry(halfAngle, reach, 0.12, 22), fxMat(pal.rim, 0.07));
  const inner = new THREE.Mesh(createGroundConeGeometry(halfAngle * 0.55, reach * 0.95, 0.14, 18), fxMat(pal.hot, 0.09));
  group.add(outer, inner);

  const lip = new THREE.Mesh(
    new THREE.RingGeometry(reach * 0.82, reach * 0.98, 28, 1, -halfAngle, halfAngle * 2),
    fxMat(pal.core, 0.2),
  );
  lip.rotation.x = -Math.PI / 2;
  lip.position.y = 0.16;
  group.add(lip);

  spawn(host, group, life, (t) => {
    const p = Math.min(1, t / life);
    const surge = 0.88 + Math.sin(p * Math.PI) * 0.22;
    group.scale.set(1 + p * 0.08, 1, surge);
    (outer.material as THREE.MeshBasicMaterial).opacity = 0.07 * (1 - p);
    (inner.material as THREE.MeshBasicMaterial).opacity = 0.09 * (1 - p * 0.9);
    (lip.material as THREE.MeshBasicMaterial).opacity = 0.2 * (1 - p);
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

  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.Float32BufferAttribute([sx, sy, sz, pos.x, 0.35, pos.z], 3));
  const trail = new THREE.Line(trailGeo, lineMat(pal.trail, 0.76));
  root.add(trail);

  const meteor = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), fxMat(pal.core, 0.95));
  meteor.position.set(sx, sy, sz);
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
    (trail.material as THREE.LineBasicMaterial).opacity = 0.76 * (1 - p);
    const hitP = Math.max(0, (t - 0.18) / (life - 0.18));
    ring.scale.setScalar(1 + hitP * (radius / 0.8));
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.82 * (1 - hitP);
    scorch.scale.setScalar(radius * (0.42 + hitP * 0.42));
    (scorch.material as THREE.MeshBasicMaterial).opacity = 0.24 * (1 - p * 0.55);
  });
}

function spawnElementalAoe(
  host: FxHost,
  pos: { x: number; z: number },
  opts: CastFxSpawnOpts | undefined,
  pal: ElementalPalette,
  compact: boolean,
): void {
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
    const geo = new THREE.RingGeometry(inner, outer, 40);
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
export function spawnCombatHitMark(host: FxHost, m: CombatHitMark): void {
  if (m.producedUnitId === PRODUCED_UNIT_AMBER_GEODE_MONKS) {
    spawnGeodeMonkForwardRings(host, m);
    return;
  }
  const dx = m.tx - m.ax;
  const dz = m.tz - m.az;
  const dist = Math.hypot(dx, dz);
  const reach = Math.max(0.45, Math.min(m.range, dist + 0.35) * (m.wide ? 1.08 : 1));
  let classAngle = 1;
  let classSpark = 1;
  let classLife = 1;
  switch (m.sizeClass) {
    case "Swarm":
      classAngle = 1.12;
      classSpark = 1.38;
      classLife = 0.92;
      break;
    case "Line":
      classAngle = 1.04;
      classSpark = 1.08;
      break;
    case "Heavy":
      classAngle = 1.18;
      classSpark = 0.92;
      classLife = 1.08;
      break;
    case "Titan":
      classAngle = 1.28;
      classSpark = 0.78;
      classLife = 1.15;
      break;
    default:
      break;
  }
  const halfAngle = (m.wide ? 0.34 : 0.15) * Math.PI * classAngle;
  const seg = Math.max(8, Math.round((m.wide ? 16 : 12) * Math.min(1.1, classAngle)));
  const life = 0.28 * classLife;
  const pal = elementalCombatPalette(m);
  const group = new THREE.Group();
  group.position.set(m.ax, 0.08, m.az);
  group.rotation.y = Math.atan2(dx, dz);

  const mkCone = (scale: number, op: number, hueShift: number): THREE.Mesh => {
    const g = createGroundConeGeometry(halfAngle * scale, reach * (0.85 + (1 - scale) * 0.25), 0.12, seg);
    const c = new THREE.Color(pal.core);
    if (hueShift !== 0) c.offsetHSL(hueShift, 0, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: c.getHex(),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: op,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.rotation.x = 0;
    return mesh;
  };

  const mid = mkCone(1, m.sizeClass === "Swarm" ? 0.16 : 0.24, 0);
  const core = mkCone(0.52, m.sizeClass === "Swarm" ? 0.24 : 0.36, -0.03);
  if (m.sizeClass !== "Swarm") group.add(mid);
  group.add(core);

  const tracerHeight =
    m.sizeClass === "Swarm" ? 0.45 : m.sizeClass === "Line" ? 0.62 : m.sizeClass === "Heavy" ? 0.82 : 1.1;
  const tracerGeo = new THREE.BufferGeometry();
  tracerGeo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, tracerHeight, 0, 0, tracerHeight + 0.12, reach], 3),
  );
  const tracerMat = new THREE.LineBasicMaterial({
    color: m.sizeClass === "Swarm" ? pal.spark : m.sizeClass === "Line" ? pal.glow : pal.rim,
    transparent: true,
    opacity: m.sizeClass === "Titan" ? 0.62 : 0.46,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const tracer = new THREE.Line(tracerGeo, tracerMat);
  group.add(tracer);

  const extraMats: THREE.Material[] = [];
  let titanOrb: THREE.Mesh | null = null;
  let titanShock: THREE.Mesh | null = null;
  let titanTrail: THREE.Line | null = null;
  if (m.sizeClass === "Swarm") {
    for (let i = 0; i < 2; i++) {
      const offset = i === 0 ? -0.16 : 0.16;
      const g = new THREE.BufferGeometry();
      g.setAttribute(
        "position",
        new THREE.Float32BufferAttribute([offset, 0.28, reach * 0.08, offset * -0.35, 0.34, reach * 0.72], 3),
      );
      const mat = new THREE.LineBasicMaterial({
        color: pal.spark,
        transparent: true,
        opacity: 0.52,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      extraMats.push(mat);
      group.add(new THREE.Line(g, mat));
    }
  } else if (m.sizeClass === "Heavy") {
    const slam = new THREE.Mesh(
      new THREE.RingGeometry(reach * 0.2, reach * 0.36, 12),
      new THREE.MeshBasicMaterial({
        color: pal.rim,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    slam.rotation.x = -Math.PI / 2;
    slam.position.set(0, 0.14, reach * 0.72);
    extraMats.push(slam.material as THREE.Material);
    group.add(slam);
  } else if (m.sizeClass === "Titan") {
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [
          0,
          1.05,
          reach * 0.08,
          Math.sin(rnd(m.visualSeed, 201) * Math.PI * 2) * 0.28,
          1.32,
          reach * 0.42,
          Math.sin(rnd(m.visualSeed, 202) * Math.PI * 2) * 0.34,
          1.1,
          reach * 0.78,
        ],
        3,
      ),
    );
    const trailMat = new THREE.LineBasicMaterial({
      color: pal.glow,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    titanTrail = new THREE.Line(trailGeo, trailMat);
    extraMats.push(trailMat);
    group.add(titanTrail);

    titanOrb = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 14, 8),
      new THREE.MeshBasicMaterial({
        color: pal.glow,
        transparent: true,
        opacity: 0.64,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    titanOrb.position.set(0, 1.0, reach * 0.82);
    extraMats.push(titanOrb.material as THREE.Material);
    group.add(titanOrb);

    titanShock = new THREE.Mesh(
      new THREE.RingGeometry(reach * 0.16, reach * 0.3, 24),
      new THREE.MeshBasicMaterial({
        color: pal.rim,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    titanShock.rotation.x = -Math.PI / 2;
    titanShock.position.set(0, 0.155, reach * 0.88);
    extraMats.push(titanShock.material as THREE.Material);
    group.add(titanShock);

    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.18, 1.5, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: pal.glow,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    pillar.position.set(0, 0.75, reach * 0.76);
    extraMats.push(pillar.material as THREE.Material);
    group.add(pillar);
  }

  const rimGeo = new THREE.RingGeometry(reach * 0.88, reach * 1.02, seg, 1, -halfAngle, halfAngle * 2);
  const rim = new THREE.Mesh(
    rimGeo,
    new THREE.MeshBasicMaterial({
      color: pal.rim,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.125;
  group.add(rim);

  const sparks: { mesh: THREE.Mesh; vx: number; vz: number; vy: number; mat: THREE.MeshBasicMaterial }[] = [];
  const nSpark = Math.max(2, Math.round((m.wide ? 6 : 3) * classSpark));
  for (let i = 0; i < nSpark; i++) {
    const u = rnd(m.visualSeed, i + 3);
    const v = rnd(m.visualSeed, i + 19);
    const ang = -halfAngle + u * (2 * halfAngle);
    const rad = reach * (0.15 + v * 0.82);
    const g = new THREE.SphereGeometry(0.045 + (m.wide ? 0.025 : 0), 4, 3);
    const mat = new THREE.MeshBasicMaterial({
      color: i % 3 === 0 ? pal.spark : pal.glow,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(Math.sin(ang) * rad * 0.35, 0.2 + v * 0.35, Math.cos(ang) * rad * 0.35);
    const burst = 1.2 + rnd(m.visualSeed, i + 40) * 2.1;
    sparks.push({
      mesh,
      vx: Math.sin(ang) * burst,
      vz: Math.cos(ang) * burst,
      vy: 1.1 + rnd(m.visualSeed, i + 60) * 1.5,
      mat,
    });
    group.add(mesh);
  }

  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    const breathe = 1 + Math.sin(t * 28) * 0.04 * (1 - p);
    group.scale.setScalar(breathe);
    (mid.material as THREE.MeshBasicMaterial).opacity = (m.sizeClass === "Swarm" ? 0.16 : 0.24) * (1 - p * 0.92);
    (core.material as THREE.MeshBasicMaterial).opacity = (m.sizeClass === "Swarm" ? 0.24 : 0.36) * (1 - p * 0.85);
    tracerMat.opacity = (m.sizeClass === "Titan" ? 0.62 : 0.46) * (1 - p * 0.82);
    (rim.material as THREE.MeshBasicMaterial).opacity = 0.32 * (1 - p);
    for (const mat of extraMats) {
      if ("opacity" in mat) mat.opacity = (m.sizeClass === "Titan" ? 0.32 : 0.46) * (1 - p);
    }
    if (titanOrb) {
      const pulse = 1 + Math.sin(t * 46) * 0.16 * (1 - p);
      titanOrb.scale.setScalar(pulse + p * 0.5);
      (titanOrb.material as THREE.MeshBasicMaterial).opacity = 0.64 * (1 - p);
    }
    if (titanShock) {
      titanShock.scale.setScalar(1 + p * 2.8);
      (titanShock.material as THREE.MeshBasicMaterial).opacity = 0.48 * (1 - p);
    }
    if (titanTrail) {
      const mat = titanTrail.material as THREE.LineBasicMaterial;
      mat.opacity = 0.72 * (1 - p * 0.95);
    }
    for (const s of sparks) {
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.z += s.vz * dt;
      s.mesh.position.y += s.vy * dt;
      s.vy -= 6 * dt;
      s.mat.opacity = 0.62 * (1 - p);
    }
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

/** Short radial burst + **elemental cone** along the strike line + optional ion bolt. */
function spawnHeroStrike(
  host: FxHost,
  pos: { x: number; z: number },
  from?: { x: number; z: number },
  strikeVariant?: HeroStrikeFxVariant,
  visualSeed?: number,
): void {
  const life = 0.42;
  const pal = heroStrikeElementalPalette(strikeVariant, visualSeed);
  const root = new THREE.Group();
  const ringWrap = new THREE.Group();
  ringWrap.position.set(pos.x, 0.15, pos.z);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.35, 1.35, 36),
    new THREE.MeshBasicMaterial({
      color: pal.core,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ringWrap.add(ring);
  root.add(ringWrap);

  let coneGroup: THREE.Group | null = null;
  let outerCone: THREE.Mesh | null = null;
  let innerCone: THREE.Mesh | null = null;
  let boltMat: THREE.LineBasicMaterial | null = null;
  let forkMat: THREE.LineBasicMaterial | null = null;

  if (from) {
    const ax = from.x;
    const az = from.z;
    const dx = pos.x - ax;
    const dz = pos.z - az;
    const dist = Math.hypot(dx, dz);
    const halfAngle = Math.PI * 0.11;
    const reach = Math.max(0.6, dist * 1.02);
    coneGroup = new THREE.Group();
    coneGroup.position.set(ax, 0.1, az);
    coneGroup.rotation.y = Math.atan2(dx, dz);
    const gOut = createGroundConeGeometry(halfAngle * 1.25, reach, 0.11, 20);
    outerCone = new THREE.Mesh(
      gOut,
      new THREE.MeshBasicMaterial({
        color: pal.cone,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const gIn = createGroundConeGeometry(halfAngle * 0.72, reach * 0.92, 0.13, 18);
    innerCone = new THREE.Mesh(
      gIn,
      new THREE.MeshBasicMaterial({
        color: pal.rim,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    coneGroup.add(outerCone);
    coneGroup.add(innerCone);
    root.add(coneGroup);

    const segs = Math.max(6, Math.min(16, Math.round(dist * 1.25)));
    const jitter = Math.min(1.6, 0.28 + dist * 0.09);
    const seed = (ax + pos.z) * 0.413 + dist * 0.17;
    const positions = heroStrikeBoltPoints(ax, az, pos.x, pos.z, segs, jitter, seed);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    boltMat = new THREE.LineBasicMaterial({
      color: pal.bolt,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    root.add(new THREE.Line(geo, boltMat));
    const forkGeo = new THREE.BufferGeometry();
    const forkPos = heroStrikeBoltPoints(ax, az, pos.x, pos.z, segs, jitter * 0.82, seed + 19.1);
    forkGeo.setAttribute("position", new THREE.BufferAttribute(forkPos, 3));
    forkMat = new THREE.LineBasicMaterial({
      color: pal.fork,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    root.add(new THREE.Line(forkGeo, forkMat));
  }

  spawn(host, root, life, (t, _dt) => {
    const p = Math.min(1, t / life);
    ring.scale.setScalar(1 + p * 2.4);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.88 * (1 - p);
    if (coneGroup) coneGroup.scale.setScalar(1 + p * 0.25);
    if (outerCone) (outerCone.material as THREE.MeshBasicMaterial).opacity = 0.28 * (1 - p * 0.9);
    if (innerCone) (innerCone.material as THREE.MeshBasicMaterial).opacity = 0.42 * (1 - p * 0.85);
    if (boltMat) boltMat.opacity = 0.95 * (1 - p);
    if (forkMat) forkMat.opacity = 0.58 * (1 - p);
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

  const coreMat = new THREE.MeshBasicMaterial({
    color: 0xb8ffd4,
    transparent: true,
    opacity: 0.52,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const core = new THREE.Mesh(new THREE.BoxGeometry(halfW * 2, 0.22, L), coreMat);
  group.add(core);

  const rimMat = new THREE.MeshBasicMaterial({
    color: 0xff66dd,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const rim = new THREE.Mesh(new THREE.BoxGeometry(halfW * 2 + 0.55, 0.1, L + 0.35), rimMat);
  rim.position.y = 0.03;
  group.add(rim);

  spawn(host, group, life, (t) => {
    const p = Math.min(1, t / life);
    const pulse = 1 + 0.12 * Math.sin(p * Math.PI);
    group.scale.set(pulse, 1 + 0.25 * Math.sin(p * Math.PI * 2), pulse);
    (core.material as THREE.MeshBasicMaterial).opacity = 0.52 * (1 - p);
    (rim.material as THREE.MeshBasicMaterial).opacity = 0.32 * (1 - p * 0.9);
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

  const boltGeo = new THREE.BufferGeometry().setFromPoints(pts);
  const boltMat = new THREE.LineBasicMaterial({
    color: 0xe8f6ff,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  });
  const bolt = new THREE.Line(boltGeo, boltMat);
  group.add(bolt);

  // Short-lived branch bolts.
  const branches: THREE.Line[] = [];
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
    const bg = new THREE.BufferGeometry().setFromPoints(bpts);
    const bm = new THREE.LineBasicMaterial({
      color: 0xcfeaff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const bl = new THREE.Line(bg, bm);
    group.add(bl);
    branches.push(bl);
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
  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    // Bolt + tube flicker for the first ~0.18s, then fade.
    const strikePhase = t < 0.18 ? 1 : Math.max(0, 1 - (t - 0.18) / (life - 0.18));
    const flicker = 0.55 + 0.45 * Math.abs(Math.sin(t * 90));
    const boltOp = strikePhase * flicker;
    const boltMat = bolt.material as THREE.LineBasicMaterial;
    boltMat.opacity = boltOp;
    /* Some drivers still draw 1px lines at opacity 0; hide the object explicitly. */
    bolt.visible = boltOp > 0.02;
    for (const br of branches) {
      const bOp = 0.85 * strikePhase * flicker;
      const bm = br.material as THREE.LineBasicMaterial;
      bm.opacity = bOp;
      br.visible = bOp > 0.02;
    }
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
