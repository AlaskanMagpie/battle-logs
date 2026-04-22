import {
  ENEMY_UNIT_HUNT_DETECT,
  HERO_FOLLOW_RADIUS,
  PLAYER_UNIT_HUNT_DETECT_MIN,
  PLAYER_UNIT_HUNT_DETECT_MULT,
  TICK_HZ,
} from "../../constants";
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
  const wiz = s.hero;
  if (wiz.hp > 0) {
    const d = dist2(from, wiz);
    if (d < bestD) {
      bestD = d;
      best = { x: wiz.x, z: wiz.z };
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

  const anyEnemyCampAwake = s.map.enemyCamps.some((c) => s.enemyCampAwake[c.id]);
  if (anyEnemyCampAwake) {
    const detect = ENEMY_UNIT_HUNT_DETECT;
    const d2 = detect * detect;
    for (const u of s.units) {
      if (u.team !== "enemy" || u.hp <= 0) continue;
      const tgt = nearestEnemyAttackTarget(s, u);
      if (!tgt) continue;
      if (dist2(u, tgt) > d2) continue;
      moveToward(u, tgt, u.speedPerSec * stepScale);
      clampToWorld(s, u);
    }
  }

  const hero = s.hero;
  const heroR2 = HERO_FOLLOW_RADIUS * HERO_FOLLOW_RADIUS;
  const defense = s.armyStance === "defense";
  const DEFENSE_ENGAGE_RADIUS = HERO_FOLLOW_RADIUS * 1.42;
  const defR2 = DEFENSE_ENGAGE_RADIUS * DEFENSE_ENGAGE_RADIUS;

  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    const st = s.structures.find((x) => x.id === u.structureId);
    const hold = st?.holdOrders ?? false;
    const detect = Math.max(PLAYER_UNIT_HUNT_DETECT_MIN, u.range * PLAYER_UNIT_HUNT_DETECT_MULT);
    const foe = nearestEnemyUnit(s, u, detect * detect);

    // In Defense: units only engage foes that are near the wizard; otherwise
    // they ignore aggression and gather on the hero.
    const canEngage = foe && (!defense || dist2(foe, hero) <= defR2);

    if (canEngage && foe && dist2(u, foe) > u.range * u.range) {
      moveToward(u, foe, u.speedPerSec * stepScale);
      clampToWorld(s, u);
      continue;
    }
    if (canEngage) {
      clampToWorld(s, u);
      continue;
    }
    if (hold && !defense) {
      if (st) {
        const jx = ((u.id * 13) % 10) * 0.55 - 2.5;
        const jz = ((u.id * 7) % 11) * 0.5 - 2.5;
        moveToward(u, { x: st.x + jx, z: st.z + jz }, u.speedPerSec * stepScale);
        clampToWorld(s, u);
      } else {
        clampToWorld(s, u);
      }
      continue;
    }

    let target: Vec2;
    if (defense) {
      // Every friendly gathers on the wizard. Small radius offset keeps them from stacking.
      target = { x: hero.x, z: hero.z };
    } else if (s.globalRallyActive) {
      target = { x: s.globalRallyX, z: s.globalRallyZ };
    } else {
      const near = dist2(u, hero) <= heroR2;
      if (near) {
        const jx = ((u.id * 17) % 10) * 0.4 - 1.8;
        const jz = ((u.id * 11) % 10) * 0.4 - 1.8;
        target = { x: hero.x + jx, z: hero.z + jz };
      } else if (st && (st.rallyX !== st.x || st.rallyZ !== st.z)) {
        target = { x: st.rallyX, z: st.rallyZ };
      } else {
        target = pushLaneTarget(s, u) ?? { x: u.x, z: u.z };
      }
    }
    moveToward(u, target, u.speedPerSec * stepScale);
    clampToWorld(s, u);
  }
}

function pushLaneTarget(s: GameState, from: Vec2): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const st of s.structures) {
    if (st.team !== "enemy" || !st.complete) continue;
    const d = dist2(from, st);
    if (d < bestD) {
      bestD = d;
      best = { x: st.x, z: st.z };
    }
  }
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
  if (s.phase !== "playing") return;
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
