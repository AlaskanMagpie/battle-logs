import * as THREE from "three";
import { FX_ABSOLUTE_MAX_LIFETIME_SEC } from "../game/constants";
import type { CastFxKind, CombatHitMark, HeroStrikeFxVariant } from "../game/state";

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
  opts?: { from?: { x: number; z: number }; strikeVariant?: HeroStrikeFxVariant },
): void {
  switch (kind) {
    case "firestorm":
      return spawnFirestorm(host, pos);
    case "shatter":
      return spawnShatter(host, pos);
    case "fortify":
      return spawnFortify(host, pos);
    case "muster":
      return spawnMuster(host, pos);
    case "recycle":
      return spawnRecycle(host, pos);
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
  const halfAngle = (m.wide ? 0.42 : 0.19) * Math.PI * classAngle;
  const seg = Math.max(12, Math.round((m.wide ? 28 : 22) * Math.min(1.15, classAngle)));
  const life = 0.44 * classLife;
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

  const outer = mkCone(1.18, 0.22, 0.02);
  const mid = mkCone(1, 0.38, 0);
  const core = mkCone(0.52, 0.55, -0.03);
  group.add(outer);
  group.add(mid);
  group.add(core);

  const rimGeo = new THREE.RingGeometry(reach * 0.88, reach * 1.02, seg, 1, -halfAngle, halfAngle * 2);
  const rim = new THREE.Mesh(
    rimGeo,
    new THREE.MeshBasicMaterial({
      color: pal.rim,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.125;
  group.add(rim);

  const sparks: { mesh: THREE.Mesh; vx: number; vz: number; vy: number; mat: THREE.MeshBasicMaterial }[] = [];
  const nSpark = Math.max(6, Math.round((m.wide ? 22 : 12) * classSpark));
  for (let i = 0; i < nSpark; i++) {
    const u = rnd(m.visualSeed, i + 3);
    const v = rnd(m.visualSeed, i + 19);
    const ang = -halfAngle + u * (2 * halfAngle);
    const rad = reach * (0.15 + v * 0.82);
    const g = new THREE.SphereGeometry(0.06 + (m.wide ? 0.04 : 0), 5, 5);
    const mat = new THREE.MeshBasicMaterial({
      color: i % 3 === 0 ? pal.spark : pal.glow,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(Math.sin(ang) * rad * 0.35, 0.2 + v * 0.35, Math.cos(ang) * rad * 0.35);
    const burst = 2.2 + rnd(m.visualSeed, i + 40) * 3.5;
    sparks.push({
      mesh,
      vx: Math.sin(ang) * burst,
      vz: Math.cos(ang) * burst,
      vy: 1.8 + rnd(m.visualSeed, i + 60) * 2.2,
      mat,
    });
    group.add(mesh);
  }

  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    const breathe = 1 + Math.sin(t * 28) * 0.04 * (1 - p);
    group.scale.setScalar(breathe);
    (outer.material as THREE.MeshBasicMaterial).opacity = 0.22 * (1 - p);
    (mid.material as THREE.MeshBasicMaterial).opacity = 0.38 * (1 - p * 0.92);
    (core.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - p * 0.85);
    (rim.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - p);
    for (const s of sparks) {
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.z += s.vz * dt;
      s.mesh.position.y += s.vy * dt;
      s.vy -= 7 * dt;
      s.mat.opacity = 0.95 * (1 - p);
    }
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

/** Expanding red ring + 12 ember billboards. */
function spawnFirestorm(host: FxHost, pos: { x: number; z: number }): void {
  const life = 0.7;
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
  });
  const inner = new THREE.Mesh(innerGeo, innerMat);
  inner.rotation.x = -Math.PI / 2;
  group.add(inner);

  const embers: { mesh: THREE.Mesh; vy: number; vx: number; vz: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const g = new THREE.SphereGeometry(0.18, 6, 6);
    const m = new THREE.MeshBasicMaterial({
      color: 0xffaa44,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const e = new THREE.Mesh(g, m);
    const ang = (i / 12) * Math.PI * 2 + Math.random() * 0.4;
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

  const maxRadius = 11;
  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    const rOuter = 0.6 + p * maxRadius;
    ring.scale.setScalar(rOuter / 0.6);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - p);
    (inner.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - p * 1.4);
    inner.scale.setScalar(1 + p * 3);
    for (const e of embers) {
      e.mesh.position.x += e.vx * dt;
      e.mesh.position.z += e.vz * dt;
      e.mesh.position.y += e.vy * dt;
      e.vy -= 9 * dt;
      (e.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - p);
    }
  });
}

/** Two concentric shockwave rings at different speeds + a crack decal. */
function spawnShatter(host: FxHost, pos: { x: number; z: number }): void {
  const life = 0.9;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.2, pos.z);

  const rings: { mesh: THREE.Mesh; speed: number }[] = [];
  for (let i = 0; i < 2; i++) {
    const r = new THREE.Mesh(
      new THREE.RingGeometry(0.2, 0.55, 40),
      new THREE.MeshBasicMaterial({
        color: i === 0 ? 0x8fd6ff : 0xc8b3ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      }),
    );
    r.rotation.x = -Math.PI / 2;
    group.add(r);
    rings.push({ mesh: r, speed: 8 + i * 6 });
  }

  // Crack decal — a few thin rectangles radiating.
  const cracks: THREE.Mesh[] = [];
  for (let i = 0; i < 6; i++) {
    const g = new THREE.PlaneGeometry(0.12, 3.4);
    const m = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });
    const c = new THREE.Mesh(g, m);
    c.rotation.x = -Math.PI / 2;
    c.rotation.z = (i / 6) * Math.PI * 2;
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

/** Scrap cubes tumbling + fading. */
function spawnRecycle(host: FxHost, pos: { x: number; z: number }): void {
  const life = 0.9;
  const group = new THREE.Group();
  group.position.set(pos.x, 0, pos.z);

  const scraps: { mesh: THREE.Mesh; vx: number; vy: number; vz: number; wx: number; wy: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const s = 0.25 + Math.random() * 0.2;
    const g = new THREE.BoxGeometry(s, s, s);
    const m = new THREE.MeshStandardMaterial({
      color: 0x8a8f99,
      roughness: 0.85,
      transparent: true,
      opacity: 1,
    });
    const cube = new THREE.Mesh(g, m);
    const ang = Math.random() * Math.PI * 2;
    const sp = 1.5 + Math.random() * 2.5;
    cube.position.set(0, 1.2 + Math.random() * 1.2, 0);
    group.add(cube);
    scraps.push({
      mesh: cube,
      vx: Math.cos(ang) * sp,
      vz: Math.sin(ang) * sp,
      vy: 2 + Math.random() * 2,
      wx: (Math.random() - 0.5) * 8,
      wy: (Math.random() - 0.5) * 8,
    });
  }

  spawn(host, group, life, (t, dt) => {
    const p = Math.min(1, t / life);
    for (const s of scraps) {
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.z += s.vz * dt;
      s.mesh.position.y += s.vy * dt;
      s.vy -= 8 * dt;
      s.mesh.rotation.x += s.wx * dt;
      s.mesh.rotation.y += s.wy * dt;
      const mat = s.mesh.material as THREE.MeshStandardMaterial;
      mat.transparent = true;
      mat.opacity = 1 - p;
    }
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
