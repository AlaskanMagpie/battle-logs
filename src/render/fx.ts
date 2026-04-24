import * as THREE from "three";
import { FX_ABSOLUTE_MAX_LIFETIME_SEC } from "../game/constants";
import type { CastFxKind, CombatHitMark } from "../game/state";

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
      return spawnHeroStrike(host, pos);
  }
}

/**
 * Ground wedge rooted on the attacker, opening toward the target — telegraphs strike direction
 * (narrow melee vs wider breath-style when `wide`).
 */
export function spawnCombatHitMark(host: FxHost, m: CombatHitMark): void {
  const dx = m.tx - m.ax;
  const dz = m.tz - m.az;
  const dist = Math.hypot(dx, dz);
  const outer = Math.max(0.35, Math.min(m.range, dist + 0.5));
  const inner = 0.08;
  const arc = m.wide ? Math.PI * 0.38 : Math.PI * 0.2;
  const thetaStart = -arc / 2;
  const lifeByWeight: Record<CombatHitMark["weight"], number> = {
    light: 0.32,
    medium: 0.4,
    heavy: 0.5,
  };
  const life = lifeByWeight[m.weight];
  const profileByRange: Record<
    CombatHitMark["rangeBand"],
    { primary: number; secondary: number; air: number }
  > = {
    close: { primary: 0x9f7b4f, secondary: 0x7bd470, air: 0xd8f3e8 }, // earth
    medium: { primary: 0x40b9ff, secondary: 0x9be8ff, air: 0xe7f9ff }, // water
    long: { primary: 0xff6a2a, secondary: 0xffc35f, air: 0xfff5dd }, // fire
  };
  const profile = profileByRange[m.rangeBand];
  const weightScale: Record<CombatHitMark["weight"], number> = {
    light: 0.85,
    medium: 1,
    heavy: 1.2,
  };
  const wScale = weightScale[m.weight];
  const group = new THREE.Group();
  group.position.set(m.ax, 0.11, m.az);
  group.rotation.y = Math.atan2(dx, dz) + Math.PI / 2;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, 28, 1, thetaStart, arc),
    new THREE.MeshBasicMaterial({
      color: profile.primary,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.62 * wScale,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);

  const band = new THREE.Mesh(
    new THREE.BoxGeometry(outer, 0.08 * wScale, 0.22 * wScale),
    new THREE.MeshBasicMaterial({
      color: profile.secondary,
      transparent: true,
      opacity: 0.45 * wScale,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  band.position.set(outer * 0.5, 0.08, 0);
  group.add(band);

  const projectile = new THREE.Mesh(
    new THREE.SphereGeometry(0.11 * wScale, 10, 10),
    new THREE.MeshBasicMaterial({
      color: profile.primary,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  projectile.position.set(0.12, 0.2, 0);
  group.add(projectile);

  const airRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.2 * wScale, 0.03 * wScale, 8, 20),
    new THREE.MeshBasicMaterial({
      color: profile.air,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  airRing.rotation.y = Math.PI / 2;
  airRing.position.set(0.14, 0.2, 0);
  group.add(airRing);

  const burstCount = m.weight === "heavy" ? 3 : m.weight === "medium" ? 2 : 1;
  const bursts: THREE.Mesh[] = [];
  for (let i = 0; i < burstCount; i++) {
    const p = new THREE.Mesh(
      new THREE.SphereGeometry(0.06 * wScale, 8, 8),
      new THREE.MeshBasicMaterial({
        color: profile.secondary,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
      }),
    );
    p.position.set(outer * (0.5 + i * 0.15), 0.14, (i - (burstCount - 1) / 2) * 0.18);
    group.add(p);
    bursts.push(p);
  }

  spawn(host, group, life, (t) => {
    const p = Math.min(1, t / life);
    const s = 1 + p * 0.35;
    group.scale.set(s, 1, s);
    const fade = 1 - p;
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.62 * wScale * fade;
    (band.material as THREE.MeshBasicMaterial).opacity = 0.45 * wScale * fade;
    const travel = 0.12 + outer * (0.9 * p);
    projectile.position.x = travel;
    airRing.position.x = travel - 0.04;
    airRing.rotation.z = t * 13;
    const projMat = projectile.material as THREE.MeshBasicMaterial;
    projMat.opacity = 0.9 * fade;
    const airMat = airRing.material as THREE.MeshBasicMaterial;
    airMat.opacity = 0.8 * fade;
    for (let i = 0; i < bursts.length; i++) {
      const b = bursts[i]!;
      b.position.x += 0.03 + i * 0.008;
      b.position.y += 0.015;
      const bm = b.material as THREE.MeshBasicMaterial;
      bm.opacity = Math.max(0, 0.75 * (1 - p * (1.1 + i * 0.1)));
    }
  });
}

/** Short radial burst for wizard melee. */
function spawnHeroStrike(host: FxHost, pos: { x: number; z: number }): void {
  const life = 0.35;
  const group = new THREE.Group();
  group.position.set(pos.x, 0.15, pos.z);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.4, 1.2, 32),
    new THREE.MeshBasicMaterial({
      color: 0xc9a8ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);
  spawn(host, group, life, (t) => {
    const p = Math.min(1, t / life);
    ring.scale.setScalar(1 + p * 2.2);
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - p);
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
