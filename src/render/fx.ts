import * as THREE from "three";
import { FX_ABSOLUTE_MAX_LIFETIME_SEC } from "../game/constants";
import type { AttackRangeBand, CastFxKind, CombatHitMark, HeroStrikeFxVariant } from "../game/state";

export type CastFxSpawnOpts = {
  from?: { x: number; z: number };
  strikeVariant?: HeroStrikeFxVariant;
  impactRadius?: number;
  rangeBand?: AttackRangeBand;
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
      return spawnFortify(host, pos);
    case "muster":
      return spawnMuster(host, pos);
    case "line_cleave":
      return spawnLineCleave(host, pos, opts?.from, opts?.impactRadius);
    case "claim":
      return spawnClaim(host, pos);
    case "lightning":
      return spawnLightning(host, pos);
    case "hero_strike":
      return spawnHeroStrike(host, pos, opts?.from, opts?.strikeVariant);
    case "spark_burst":
      return spawnSparkBurst(host, pos);
    case "ground_crack":
      return spawnGroundCrack(host, pos);
    case "reclaim_pulse":
      return spawnReclaimPulse(host, pos);
    case "death_flash":
      return spawnDeathFlash(host, pos, opts?.impactRadius ?? 1.5, opts?.rangeBand ?? "close");
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

/**
 * Ground **cone** of elemental energy rooted on the attacker, opening toward the target.
 * Layered meshes + spark flecks (additive) — telegraphs melee / breath without implying physical metal.
 */
export function spawnCombatHitMark(host: FxHost, m: CombatHitMark): void {
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

function heroStrikeElementalPalette(v: HeroStrikeFxVariant | undefined): {
  core: number;
  rim: number;
  bolt: number;
  fork: number;
  cone: number;
} {
  switch (v) {
    case "player_vs_unit":
      return { core: 0xb8a0ff, rim: 0xffffff, bolt: 0xf0e8ff, fork: 0xaaddff, cone: 0x8866ff };
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
): void {
  const life = 0.42;
  const pal = heroStrikeElementalPalette(strikeVariant);
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
  for (let i = 0; i < 5; i++) {
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.55, 4.6, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? 0xffdd66 : 0xff5522,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const ang = (i / 5) * Math.PI * 2 + 0.35;
    const rr = radius * (i === 0 ? 0 : 0.34 + (i % 2) * 0.22);
    pillar.position.set(Math.cos(ang) * rr, 2.1, Math.sin(ang) * rr);
    group.add(pillar);
    pillars.push(pillar);
  }

  const embers: { mesh: THREE.Mesh; vy: number; vx: number; vz: number }[] = [];
  for (let i = 0; i < 22; i++) {
    const g = new THREE.SphereGeometry(0.18, 6, 6);
    const m = new THREE.MeshBasicMaterial({
      color: 0xffaa44,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const e = new THREE.Mesh(g, m);
    const ang = (i / 22) * Math.PI * 2 + Math.random() * 0.4;
    const sp = 4 + Math.random() * 3;
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
    scorch.scale.setScalar(Math.max(0.5, radius * 0.72) * (0.7 + p * 0.45));
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
function spawnShatter(host: FxHost, pos: { x: number; z: number }, radius = 9): void {
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

  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.38, Math.max(2.2, radius * 0.42), 9, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xe8f6ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  pillar.position.y = Math.max(1.1, radius * 0.22);
  group.add(pillar);

  // Crack decal — a few thin rectangles radiating.
  const cracks: THREE.Mesh[] = [];
  for (let i = 0; i < 9; i++) {
    const g = new THREE.PlaneGeometry(0.14, radius * (0.5 + (i % 3) * 0.12));
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
function spawnFortify(host: FxHost, pos: { x: number; z: number }): void {
  const life = 0.55;
  const geo = new THREE.IcosahedronGeometry(1.2, 1);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x6ae1ff,
    wireframe: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const shell = new THREE.Mesh(geo, mat);
  shell.position.set(pos.x, 2.4, pos.z);

  spawn(host, shell, life, (t) => {
    const p = Math.min(1, t / life);
    const s = 1 + p * 2.8;
    shell.scale.setScalar(s);
    shell.rotation.y = p * 1.8;
    (shell.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - p);
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
  const life = 0.34;
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
    ring.scale.setScalar(1 + p * 7);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.88 * (1 - p);
  });
}

/** Bastion-style summon accent: dusty radial crack. */
function spawnGroundCrack(host: FxHost, pos: { x: number; z: number }): void {
  const life = 0.4;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.04, pos.z);
  const crack = new THREE.Mesh(
    new THREE.RingGeometry(0.15, 2.1, 32, 1, 0, Math.PI * 1.65),
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
  const life = 0.38;
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
    ring.scale.setScalar(1 + p * 4.5);
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
