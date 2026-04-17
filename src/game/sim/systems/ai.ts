import { HERO_FOLLOW_RADIUS, TICK_HZ } from "../../constants";
import type { GameState, StructureRuntime, UnitRuntime } from "../../state";
import type { Vec2 } from "../../types";
import { dist2 } from "./helpers";

export function nearestEnemyUnit(s: GameState, from: Vec2, maxD2: number): UnitRuntime | null {
  let best: UnitRuntime | null = null;
  let bestD = maxD2;
  for (const u of s.units) {
    if (u.team !== "enemy") continue;
    if (u.hp <= 0) continue;
    const d = dist2(from, u);
    if (d < bestD) {
      bestD = d;
      best = u;
    }
  }
  return best;
}

function nearestPlayerStructure(s: GameState, from: Vec2): StructureRuntime | null {
  let best: StructureRuntime | null = null;
  let bestD = Infinity;
  for (const st of s.structures) {
    if (st.team !== "player" || !st.complete) continue;
    const d = dist2(from, st);
    if (d < bestD) {
      bestD = d;
      best = st;
    }
  }
  return best;
}

export function nearestEnemyAttackTarget(s: GameState, from: Vec2): Vec2 | null {
  const st = nearestPlayerStructure(s, from);
  let best: Vec2 | null = null;
  let bestD = Infinity;
  if (st) {
    best = st;
    bestD = dist2(from, st);
  }
  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    const d = dist2(from, u);
    if (d < bestD) {
      bestD = d;
      best = u;
    }
  }
  return best;
}

function moveToward(u: UnitRuntime, target: Vec2, step: number): void {
  const dx = target.x - u.x;
  const dz = target.z - u.z;
  const len = Math.hypot(dx, dz) || 1;
  if (len <= step) {
    u.x = target.x;
    u.z = target.z;
  } else {
    u.x += (dx / len) * step;
    u.z += (dz / len) * step;
  }
}

function clampToWorld(s: GameState, u: UnitRuntime): void {
  const h = s.map.world.halfExtents;
  u.x = Math.max(-h, Math.min(h, u.x));
  u.z = Math.max(-h, Math.min(h, u.z));
}

export function movement(s: GameState): void {
  const stepScale = 1 / TICK_HZ;

  for (const camp of s.map.enemyCamps) {
    const awake = s.enemyCampAwake[camp.id];
    if (!awake) continue;
    for (const u of s.units) {
      if (u.team !== "enemy" || u.hp <= 0) continue;
      const tgt = nearestEnemyAttackTarget(s, u);
      if (!tgt) continue;
      const detect = Math.max(10, u.range * 3);
      if (dist2(u, tgt) > detect * detect) continue;
      moveToward(u, tgt, u.speedPerSec * stepScale);
      clampToWorld(s, u);
    }
  }

  const hero = s.hero;
  const heroR2 = HERO_FOLLOW_RADIUS * HERO_FOLLOW_RADIUS;

  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    const st = s.structures.find((x) => x.id === u.structureId);
    const hold = st?.holdOrders ?? false;
    const detect = Math.max(10, u.range * 3);
    const foe = nearestEnemyUnit(s, u, detect * detect);

    if (foe && dist2(u, foe) > u.range * u.range) {
      moveToward(u, foe, u.speedPerSec * stepScale);
      clampToWorld(s, u);
      continue;
    }
    if (foe) {
      clampToWorld(s, u);
      continue;
    }
    if (hold) {
      clampToWorld(s, u);
      continue;
    }

    // Fallthrough: follow hero (in range) → structure rally (if explicitly set) → push lane.
    const near = dist2(u, hero) <= heroR2;
    let target: Vec2;
    if (near) {
      target = { x: hero.x, z: hero.z };
    } else if (st && (st.rallyX !== st.x || st.rallyZ !== st.z)) {
      target = { x: st.rallyX, z: st.rallyZ };
    } else {
      target = pushLaneTarget(s, u) ?? { x: u.x, z: u.z };
    }
    moveToward(u, target, u.speedPerSec * stepScale);
    clampToWorld(s, u);
  }
}

function pushLaneTarget(s: GameState, from: Vec2): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const er of s.enemyRelays) {
    if (er.hp <= 0) continue;
    const d = dist2(from, er);
    if (d < bestD) {
      bestD = d;
      best = { x: er.x, z: er.z };
    }
  }
  if (best) return best;
  for (const camp of s.map.enemyCamps) {
    const d = dist2(from, camp.origin);
    if (d < bestD) {
      bestD = d;
      best = { x: camp.origin.x, z: camp.origin.z };
    }
  }
  return best;
}

export function wakeCamps(s: GameState): void {
  for (const camp of s.map.enemyCamps) {
    if (s.enemyCampAwake[camp.id]) continue;
    const r = camp.wakeRadius;
    for (const u of s.units) {
      if (u.team !== "player") continue;
      if (dist2(u, camp.origin) <= r * r) {
        s.enemyCampAwake[camp.id] = true;
        s.lastMessage = "Enemy camp alerted.";
        break;
      }
    }
    for (const st of s.structures) {
      if (st.team !== "player" || !st.complete) continue;
      if (dist2(st, camp.origin) <= r * r) {
        s.enemyCampAwake[camp.id] = true;
        s.lastMessage = "Enemy camp alerted.";
        break;
      }
    }
  }
}
