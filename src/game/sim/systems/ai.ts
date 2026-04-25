import {
  ENEMY_UNIT_HUNT_DETECT,
  HERO_FOLLOW_RADIUS,
  PLAYER_UNIT_HUNT_DETECT_MIN,
  PLAYER_UNIT_HUNT_DETECT_MULT,
  TICK_HZ,
  UNIT_SEPARATION_GRID,
  UNIT_SEPARATION_MAX_STEP,
  UNIT_SEPARATION_PASSES,
  UNIT_SEPARATION_STRENGTH,
  HERO_CLAIM_CHANNEL_SEC,
  HERO_CLAIM_RADIUS,
  TAP_YIELD_MAX,
} from "../../constants";
import { planPathAroundMapObstacles, resolveCircleAgainstMapObstacles } from "../../mapObstacles";
import { armTapClaimAnchor, type GameState, type StructureRuntime, type UnitRuntime } from "../../state";
import type { Vec2 } from "../../types";
import { dist2, unitSeparationRadiusXZ } from "./helpers";

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

function moveUnitOnPath(s: GameState, u: UnitRuntime, target: Vec2, step: number): boolean {
  const r = unitSeparationRadiusXZ(u.sizeClass, u.flying) * 0.92;
  if (!u.flying && (!u.order || u.order.waypoints.length === 0)) {
    const path = planPathAroundMapObstacles(s.map, u, target, r);
    if (u.order) u.order.waypoints = path;
    else u.order = { mode: "move", x: target.x, z: target.z, waypoints: path, queued: [] };
  }
  const next = !u.flying && u.order && u.order.waypoints.length > 0 ? u.order.waypoints[0]! : target;
  moveToward(u, next, step);
  clampToWorldAndObstacles(s, u);
  if (dist2(u, next) <= 1.4 * 1.4 && u.order && u.order.waypoints.length > 0) u.order.waypoints.shift();
  return dist2(u, target) <= 2.2 * 2.2;
}

function clampToWorld(s: GameState, u: UnitRuntime): void {
  const h = s.map.world.halfExtents;
  u.x = Math.max(-h, Math.min(h, u.x));
  u.z = Math.max(-h, Math.min(h, u.z));
}

function clampToWorldAndObstacles(s: GameState, u: UnitRuntime): void {
  clampToWorld(s, u);
  if (u.flying) return;
  const r = unitSeparationRadiusXZ(u.sizeClass, u.flying) * 0.92;
  resolveCircleAgainstMapObstacles(s.map, u, r);
}

/** Push overlapping units apart (all teams) so large armies keep readable spacing. */
function applyUnitSeparation(s: GameState): void {
  const alive = s.units.filter((u) => u.hp > 0);
  if (alive.length < 2) return;

  const G = UNIT_SEPARATION_GRID;
  const str = UNIT_SEPARATION_STRENGTH;
  const cap = UNIT_SEPARATION_MAX_STEP;

  for (let pass = 0; pass < UNIT_SEPARATION_PASSES; pass++) {
    const buckets = new Map<string, UnitRuntime[]>();
    for (const u of alive) {
      const k = `${Math.floor(u.x / G)},${Math.floor(u.z / G)}`;
      const arr = buckets.get(k);
      if (arr) arr.push(u);
      else buckets.set(k, [u]);
    }

    const fx = new Map<number, number>();
    const fz = new Map<number, number>();

    const add = (id: number, dx: number, dz: number): void => {
      fx.set(id, (fx.get(id) ?? 0) + dx);
      fz.set(id, (fz.get(id) ?? 0) + dz);
    };

    for (const u of alive) {
      const gx = Math.floor(u.x / G);
      const gz = Math.floor(u.z / G);
      const ru = unitSeparationRadiusXZ(u.sizeClass, u.flying);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const cell = buckets.get(`${gx + ox},${gz + oz}`);
          if (!cell) continue;
          for (const o of cell) {
            if (o.id <= u.id) continue;
            const ro = unitSeparationRadiusXZ(o.sizeClass, o.flying);
            const minD = ru + ro;
            let dx = o.x - u.x;
            let dz = o.z - u.z;
            let d = Math.hypot(dx, dz);
            if (d < 1e-5) {
              const a = (((u.id * 7919) ^ (o.id * 66041)) >>> 0) / 0xffffffff;
              const ang = a * Math.PI * 2;
              dx = Math.cos(ang);
              dz = Math.sin(ang);
              d = 1;
            }
            if (d >= minD) continue;
            const overlap = (minD - d) * str;
            const nx = dx / d;
            const nz = dz / d;
            const half = overlap * 0.5;
            add(u.id, -nx * half, -nz * half);
            add(o.id, nx * half, nz * half);
          }
        }
      }
    }

    for (const u of alive) {
      let dx = fx.get(u.id) ?? 0;
      let dz = fz.get(u.id) ?? 0;
      const m = Math.hypot(dx, dz);
      if (m > cap && m > 1e-6) {
        const scl = cap / m;
        dx *= scl;
        dz *= scl;
      }
      u.x += dx;
      u.z += dz;
      clampToWorldAndObstacles(s, u);
    }
  }
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
      clampToWorldAndObstacles(s, u);
    }
  }

  const hero = s.hero;
  const heroR2 = HERO_FOLLOW_RADIUS * HERO_FOLLOW_RADIUS;
  const defense = s.armyStance === "defense";
  const DEFENSE_ENGAGE_RADIUS = HERO_FOLLOW_RADIUS * 1.42;
  const defR2 = DEFENSE_ENGAGE_RADIUS * DEFENSE_ENGAGE_RADIUS;

  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    if (u.order) {
      if (u.order.mode === "stay") {
        clampToWorldAndObstacles(s, u);
        continue;
      }
      const foe = u.order.mode === "attack_move"
        ? nearestEnemyUnit(s, u, Math.max(PLAYER_UNIT_HUNT_DETECT_MIN, u.range * PLAYER_UNIT_HUNT_DETECT_MULT) ** 2)
        : null;
      if (foe && dist2(u, foe) > u.range * u.range) {
        moveUnitOnPath(s, u, foe, u.speedPerSec * stepScale);
        continue;
      }
      if (foe) {
        clampToWorldAndObstacles(s, u);
        continue;
      }
      const arrived = moveUnitOnPath(s, u, { x: u.order.x, z: u.order.z }, u.speedPerSec * stepScale);
      if (arrived) {
        const next = u.order.queued.shift();
        if (next) {
          u.order.x = next.x;
          u.order.z = next.z;
          u.order.waypoints = [];
        } else {
          u.order = undefined;
        }
      }
      continue;
    }
    const st = s.structures.find((x) => x.id === u.structureId);
    const hold = st?.holdOrders ?? false;
    const detect = Math.max(PLAYER_UNIT_HUNT_DETECT_MIN, u.range * PLAYER_UNIT_HUNT_DETECT_MULT);
    const foe = nearestEnemyUnit(s, u, detect * detect);

    // In Defense: units only engage foes that are near the wizard; otherwise
    // they ignore aggression and gather on the hero.
    const canEngage = foe && (!defense || dist2(foe, hero) <= defR2);

    if (canEngage && foe && dist2(u, foe) > u.range * u.range) {
      moveUnitOnPath(s, u, foe, u.speedPerSec * stepScale);
      continue;
    }
    if (canEngage) {
      clampToWorldAndObstacles(s, u);
      continue;
    }
    if (hold && !defense) {
      if (st) {
        const jx = ((u.id * 13) % 10) * 0.55 - 2.5;
        const jz = ((u.id * 7) % 11) * 0.5 - 2.5;
        moveUnitOnPath(s, u, { x: st.x + jx, z: st.z + jz }, u.speedPerSec * stepScale);
      } else {
        clampToWorldAndObstacles(s, u);
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
    moveUnitOnPath(s, u, target, u.speedPerSec * stepScale);
  }

  applyUnitSeparation(s);
  unitCaptureNodes(s);
}

function unitCaptureNodes(s: GameState): void {
  for (let i = 0; i < s.taps.length; i++) {
    const tap = s.taps[i]!;
    if (tap.active) {
      tap.claimTeam = undefined;
      tap.claimTicksRemaining = undefined;
      continue;
    }
    let team: "player" | "enemy" | null = null;
    const r2 = HERO_CLAIM_RADIUS * HERO_CLAIM_RADIUS;
    for (const u of s.units) {
      if (u.hp <= 0) continue;
      if (dist2(u, tap) > r2) continue;
      if (team && team !== u.team) {
        team = null;
        break;
      }
      team = u.team;
    }
    if (!team) {
      tap.claimTeam = undefined;
      tap.claimTicksRemaining = undefined;
      continue;
    }
    if (tap.claimTeam !== team || tap.claimTicksRemaining == null) {
      tap.claimTeam = team;
      tap.claimTicksRemaining = Math.round(HERO_CLAIM_CHANNEL_SEC * TICK_HZ * 1.35);
    }
    tap.claimTicksRemaining -= 1;
    if (tap.claimTicksRemaining > 0) continue;
    tap.active = true;
    tap.ownerTeam = team;
    armTapClaimAnchor(tap);
    tap.yieldRemaining = Math.max(tap.yieldRemaining, TAP_YIELD_MAX);
    s.lastFx = { kind: "claim", x: tap.x, z: tap.z, tick: s.tick };
    s.lastMessage = team === "player" ? "Unit squad captured a Mana node." : "Enemy units captured a Mana node.";
    tap.claimTeam = undefined;
    tap.claimTicksRemaining = undefined;
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
