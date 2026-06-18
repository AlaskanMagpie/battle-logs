import {
  FORMATION_ASSEMBLY_CATCHUP_MULT,
  FORMATION_ASSEMBLY_TICKS,
  FORMATION_CATCHUP_RADIUS,
  FORMATION_TRAVEL_CATCHUP_MULT,
  HERO_FOLLOW_RADIUS,
  KNOCKBACK_DECAY_PER_SEC,
  TICK_HZ,
  UNIT_FORMATION_SPACING,
  UNIT_MOVEMENT_SPEED_SCALE,
  UNIT_SEPARATION_GRID,
  UNIT_SEPARATION_MAX_STEP,
  UNIT_SEPARATION_PASSES,
  UNIT_SEPARATION_STRENGTH,
  UNIT_MAP_OBSTACLE_RADIUS_MULT,
  HERO_CLAIM_RADIUS,
  TAP_ANCHOR_STRIKE_RADIUS,
  TAP_CAPTURE_CONTEST_RADIUS,
  TAP_YIELD_MAX,
} from "../../constants";
import { enemyCaptureSpeedScalar } from "../../difficulty";
import {
  circleOverlapsMapObstacles,
  type MapObstacleFootprint,
  planChainedPathAroundMapObstacles,
  resolveCircleAgainstMapObstacles,
  segmentHitsMapObstacles,
} from "../../mapObstacles";
import {
  armTapClaimAnchor,
  pushFx,
  tacticsFieldSpeedMult,
  unitSpellStatusSpeedMult,
  type GameState,
  type StructureRuntime,
  type UnitRuntime,
} from "../../state";
import { structureObstacleFootprintsForUnit } from "../../structureObstacles";
import type { Vec2 } from "../../types";
import { clampOrderXZ, isSphereWorld, ringPointOnSphere, stepDirectionXZ, stepGreatCircleToward } from "../../surface";
import { playerAcquireRadius } from "../engagement";
import { gameDist2, unitSeparationRadiusXZ } from "./helpers";
import { claimChannelSecForTap, claimFluxRewardForTap } from "./homeDistance";

/** Stable ring around a point (wizard blob / idle clump). */
function formationRingAround(s: GameState, center: Vec2, u: UnitRuntime, spacing: number): Vec2 {
  const seed = (u.id * 1103515245 + (u.visualSeed | 0)) >>> 0;
  const ang = ((seed & 0xffffff) / 0xffffff) * Math.PI * 2;
  const rad = spacing * (0.48 + ((seed >>> 16) % 6) * 0.17);
  return ringPointOnSphere(s.map, center, ang, rad);
}

/**
 * Rank/file slot behind `anchor` along the march axis `anchor - origin`, with lateral spread.
 * Units share the same anchor so they walk in a block instead of converging on one tile.
 */
function formationMarchSlot(u: UnitRuntime, anchor: Vec2, origin: Vec2, spacing: number): Vec2 {
  let dx = anchor.x - origin.x;
  let dz = anchor.z - origin.z;
  const len0 = Math.hypot(dx, dz);
  if (len0 < 1.25) {
    dx = 1;
    dz = 0;
  } else {
    dx /= len0;
    dz /= len0;
  }
  const px = -dz;
  const pz = dx;
  const seed = (u.id * 1103515245 + (u.visualSeed | 0)) >>> 0;
  const file = ((seed % 19) - 9) * spacing * 0.38;
  const rank = (seed >>> 5) % 7;
  const rankF = rank * spacing * 0.48;
  return {
    x: anchor.x - dx * rankF + px * file,
    z: anchor.z - dz * rankF + pz * file,
  };
}

export function nearestEnemyUnit(s: GameState, from: Vec2, maxD2: number): UnitRuntime | null {
  let best: UnitRuntime | null = null;
  let bestD = maxD2;
  for (const u of s.units) {
    if (u.team !== "enemy") continue;
    if (u.hp <= 0) continue;
    const d = gameDist2(s.map, from, u);
    if (d < bestD) {
      bestD = d;
      best = u;
    }
  }
  return best;
}

function countEnemyFieldUnits(s: GameState): number {
  let n = 0;
  for (const u of s.units) {
    if (u.team === "enemy" && u.hp > 0) n++;
  }
  return n;
}

/**
 * When few enemy squads remain, treat enemy *units* as farther away so armies prioritize
 * towers, relays, nodes, and camp cores instead of chasing one straggler while objectives stand.
 */
function enemyUnitAutoTargetBiasSq(s: GameState): number {
  const n = countEnemyFieldUnits(s);
  if (n >= 18) return 1;
  const t = (18 - n) / 18;
  const mult = 1 + t * t * 4.8;
  return mult * mult;
}

/**
 * Best attackable enemy position within `maxD2` (squared distance cap): units, towers, relays,
 * enemy-owned Mana anchors, and awake enemy camp cores. Uses **effective** distance for enemy
 * units so buildings win more often in cleanup / endgame.
 */
function nearestEnemyCombatObjective(s: GameState, from: Vec2, maxD2: number): Vec2 | null {
  let best: Vec2 | null = null;
  let bestScore = maxD2;
  const unitBiasSq = enemyUnitAutoTargetBiasSq(s);
  const considerObjective = (p: Vec2, d2: number): void => {
    if (d2 > maxD2) return;
    if (d2 < bestScore) {
      bestScore = d2;
      best = p;
    }
  };
  const considerEnemyUnit = (p: Vec2, d2: number): void => {
    if (d2 > maxD2) return;
    const score = d2 * unitBiasSq;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  };
  for (const eu of s.units) {
    if (eu.team !== "enemy" || eu.hp <= 0) continue;
    considerEnemyUnit(eu, gameDist2(s.map, from, eu));
  }
  for (const st of s.structures) {
    if (st.team !== "enemy" || st.hp <= 0) continue;
    considerObjective(st, gameDist2(s.map, from, st));
  }
  for (const t of s.taps) {
    if (!t.active || t.ownerTeam !== "enemy") continue;
    if ((t.anchorHp ?? 0) <= 0) continue;
    considerObjective(t, gameDist2(s.map, from, t));
  }
  for (const er of s.enemyRelays) {
    if (er.hp <= 0) continue;
    considerObjective(er, gameDist2(s.map, from, er));
  }
  for (const camp of s.map.enemyCamps) {
    const cur = s.enemyCampCoreHp[camp.id];
    if (cur === undefined || cur <= 0) continue;
    if (!s.enemyCampAwake[camp.id]) continue;
    considerObjective(camp.origin, gameDist2(s.map, from, camp.origin));
  }
  return best;
}

/** Nearest enemy to `fromUnit` among those contesting a point (e.g. a Mana node). */
function nearestEnemyContestingPoint(
  s: GameState,
  fromUnit: UnitRuntime,
  origin: Vec2,
  contestR2: number,
): UnitRuntime | null {
  let best: UnitRuntime | null = null;
  let bestD = Infinity;
  for (const o of s.units) {
    if (o.team !== "enemy" || o.hp <= 0) continue;
    if (gameDist2(s.map, origin, o) > contestR2) continue;
    const d = gameDist2(s.map, fromUnit, o);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

function nearestPlayerStructure(s: GameState, from: Vec2): StructureRuntime | null {
  let best: StructureRuntime | null = null;
  let bestD = Infinity;
  for (const st of s.structures) {
    if (st.team !== "player" || !st.complete) continue;
    const d = gameDist2(s.map, from, st);
    if (d < bestD) {
      bestD = d;
      best = st;
    }
  }
  return best;
}

function countPlayerFieldUnits(s: GameState): number {
  let n = 0;
  for (const u of s.units) {
    if (u.team === "player" && u.hp > 0) n++;
  }
  return n;
}

function playerUnitDefenseBiasSq(s: GameState): number {
  const n = countPlayerFieldUnits(s);
  if (n >= 14) return 1;
  const t = (14 - n) / 14;
  const mult = 1 + t * t * 4.2;
  return mult * mult;
}

export function nearestEnemyAttackTarget(s: GameState, from: Vec2): Vec2 | null {
  const st = nearestPlayerStructure(s, from);
  let best: Vec2 | null = null;
  let bestScore = Infinity;
  const unitBiasSq = playerUnitDefenseBiasSq(s);
  const consider = (p: Vec2, d2: number, isUnit: boolean): void => {
    const score = isUnit ? d2 * unitBiasSq : d2;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  };
  if (st) consider(st, gameDist2(s.map, from, st), false);
  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    consider(u, gameDist2(s.map, from, u), true);
  }
  const wiz = s.hero;
  if (wiz.hp > 0) {
    consider({ x: wiz.x, z: wiz.z }, gameDist2(s.map, from, wiz), true);
  }
  return best;
}

function moveToward(s: GameState, u: UnitRuntime, target: Vec2, step: number): void {
  if (isSphereWorld(s.map)) {
    const p = stepGreatCircleToward(s.map, { x: u.x, z: u.z }, target, step);
    u.x = p.x;
    u.z = p.z;
    return;
  }
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

function moveUnitOnPath(
  s: GameState,
  u: UnitRuntime,
  target: Vec2,
  step: number,
  structureObstacles: MapObstacleFootprint[],
): boolean {
  const r = unitSeparationRadiusXZ(u.sizeClass, u.flying) * UNIT_MAP_OBSTACLE_RADIUS_MULT;
  if (!u.flying && u.order && u.order.waypoints.length > 0) {
    const wp = u.order.waypoints[0]!;
    if (segmentHitsMapObstacles(s.map, u, wp, r, structureObstacles)) u.order.waypoints.length = 0;
  }
  if (!u.flying && (!u.order || u.order.waypoints.length === 0)) {
    const path = planChainedPathAroundMapObstacles(s.map, u, target, r, structureObstacles);
    if (u.order) u.order.waypoints = path;
    else u.order = { mode: "move", x: target.x, z: target.z, waypoints: path, queued: [] };
  }
  const next = !u.flying && u.order && u.order.waypoints.length > 0 ? u.order.waypoints[0]! : target;
  moveToward(s, u, next, step);
  clampToWorldAndObstacles(s, u, structureObstacles);
  if (gameDist2(s.map, u, next) <= 1.4 * 1.4 && u.order && u.order.waypoints.length > 0) u.order.waypoints.shift();
  return gameDist2(s.map, u, target) <= 2.2 * 2.2;
}

function moveUnitAutonomousOnPath(
  s: GameState,
  u: UnitRuntime,
  target: Vec2,
  step: number,
  structureObstacles: MapObstacleFootprint[],
): boolean {
  const r = unitSeparationRadiusXZ(u.sizeClass, u.flying) * UNIT_MAP_OBSTACLE_RADIUS_MULT;
  const wp0 = u.autoOrder?.waypoints[0];
  const pathBlocked =
    !u.flying &&
    wp0 !== undefined &&
    (segmentHitsMapObstacles(s.map, u, wp0, r, structureObstacles) ||
      circleOverlapsMapObstacles(s.map, wp0, r, structureObstacles));
  const ao0 = u.autoOrder;
  const stale =
    !ao0 ||
    gameDist2(s.map, ao0, target) > 8 * 8 ||
    pathBlocked ||
    (!u.flying && ao0.waypoints.length === 0 && gameDist2(s.map, u, target) > 3.4 * 3.4);
  if (stale) {
    u.autoOrder = {
      x: target.x,
      z: target.z,
      waypoints: u.flying ? [] : planChainedPathAroundMapObstacles(s.map, u, target, r, structureObstacles),
    };
  }
  const ao = u.autoOrder!;
  const next = !u.flying && ao.waypoints.length > 0 ? ao.waypoints[0]! : target;
  moveToward(s, u, next, step);
  clampToWorldAndObstacles(s, u, structureObstacles);
  if (gameDist2(s.map, u, next) <= 1.4 * 1.4 && ao.waypoints.length > 0) ao.waypoints.shift();
  const arrived = gameDist2(s.map, u, target) <= 2.2 * 2.2;
  if (arrived) u.autoOrder = undefined;
  return arrived;
}

function clampToWorld(s: GameState, u: UnitRuntime): void {
  const p = clampOrderXZ(s.map, { x: u.x, z: u.z });
  u.x = p.x;
  u.z = p.z;
}

function clampToWorldAndObstacles(s: GameState, u: UnitRuntime, structureObstacles: MapObstacleFootprint[]): void {
  clampToWorld(s, u);
  if (u.flying) return;
  const r = unitSeparationRadiusXZ(u.sizeClass, u.flying) * UNIT_MAP_OBSTACLE_RADIUS_MULT;
  resolveCircleAgainstMapObstacles(s.map, u, r, structureObstacles);
}

/** Knockback velocity integration (world units/sec, exponential decay). */
function integrateKnockback(
  s: GameState,
  u: UnitRuntime,
  stepScale: number,
  structureObstacles: MapObstacleFootprint[],
): void {
  if (u.hp <= 0) return;
  const vx = u.vxImpulse;
  const vz = u.vzImpulse;
  if (Math.abs(vx) < 0.015 && Math.abs(vz) < 0.015) {
    u.vxImpulse = 0;
    u.vzImpulse = 0;
    return;
  }
  if (isSphereWorld(s.map)) {
    const mag = Math.hypot(vx, vz) * stepScale;
    if (mag > 1e-8) {
      const next = stepDirectionXZ(s.map, { x: u.x, z: u.z }, vx, vz, mag);
      u.x = next.x;
      u.z = next.z;
    }
  } else {
    u.x += vx * stepScale;
    u.z += vz * stepScale;
  }
  const decay = Math.exp(-KNOCKBACK_DECAY_PER_SEC * stepScale);
  u.vxImpulse *= decay;
  u.vzImpulse *= decay;
  clampToWorldAndObstacles(s, u, structureObstacles);
}

/** Push overlapping units apart (all teams) so large armies keep readable spacing. */
function applyUnitSeparation(
  s: GameState,
  structureObstaclesForUnit: (u: UnitRuntime) => MapObstacleFootprint[],
): void {
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
      clampToWorldAndObstacles(s, u, structureObstaclesForUnit(u));
    }
  }
}

function nearestNeutralTapTarget(s: GameState, from: Vec2): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const tap of s.taps) {
    if (tap.active) continue;
    const d = gameDist2(s.map, from, tap);
    if (d < bestD) {
      bestD = d;
      best = tap;
    }
  }
  return best;
}

function nearestFriendlyPointUnderThreat(s: GameState, from: Vec2, maxTravelD2: number): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = maxTravelD2;
  const threatR2 = 38 * 38;
  const consider = (point: Vec2): void => {
    let threatened = false;
    for (const enemy of s.units) {
      if (enemy.team !== "enemy" || enemy.hp <= 0) continue;
      if (gameDist2(s.map, enemy, point) <= threatR2) {
        threatened = true;
        break;
      }
    }
    if (!threatened) return;
    const d = gameDist2(s.map, from, point);
    if (d < bestD) {
      bestD = d;
      best = point;
    }
  };

  if (s.hero.hp > 0) consider(s.hero);
  for (const st of s.structures) {
    if (st.team === "player" && st.complete && st.hp > 0) consider(st);
  }
  for (const tap of s.taps) {
    if (tap.active && tap.ownerTeam === "player") consider(tap);
  }
  return best;
}

function patrolTarget(s: GameState, u: UnitRuntime, anchor: Vec2): Vec2 {
  const seed = (u.id * 1664525 + (u.visualSeed | 0) + 1013904223) >>> 0;
  const patrolPhase = Math.floor(s.tick / Math.max(1, TICK_HZ * 5));
  const slot = (seed + patrolPhase) % 8;
  const angle = (slot / 8) * Math.PI * 2 + (((seed >>> 8) & 0xff) / 0xff) * 0.35;
  const radius = UNIT_FORMATION_SPACING * (1.55 + ((seed >>> 16) % 4) * 0.24);
  return ringPointOnSphere(s.map, anchor, angle, radius);
}

function idleOffenseTarget(s: GameState, u: UnitRuntime, st: StructureRuntime | undefined, hero: Vec2): Vec2 {
  const defensePoint = nearestFriendlyPointUnderThreat(s, u, 96 * 96);
  if (defensePoint) return formationMarchSlot(u, defensePoint, hero, UNIT_FORMATION_SPACING);

  const pressure = pushLaneTarget(s, u);
  if (pressure) return formationMarchSlot(u, pressure, hero, UNIT_FORMATION_SPACING);

  const neutralTap = nearestNeutralTapTarget(s, u);
  if (neutralTap) return formationMarchSlot(u, neutralTap, hero, UNIT_FORMATION_SPACING);

  const half = s.map.world.halfExtents;
  const idleScanR2 = Math.min((half * 5.5) ** 2, 520 * 520);
  const wincon = nearestEnemyCombatObjective(s, u, idleScanR2);
  if (wincon) return formationMarchSlot(u, wincon, hero, UNIT_FORMATION_SPACING);

  const anchor =
    st && (st.rallyX !== st.x || st.rallyZ !== st.z)
      ? { x: st.rallyX, z: st.rallyZ }
      : st
        ? { x: st.x, z: st.z }
        : hero;
  return patrolTarget(s, u, anchor);
}

function clearFormationOrderFields(u: UnitRuntime): void {
  if (!u.order) return;
  delete u.order.formationGroupId;
  delete u.order.formationOffsetX;
  delete u.order.formationOffsetZ;
  u.order.waypoints = [];
}

function clearFormationMarch(s: GameState, id: number): void {
  const march = s.formationMarches.find((m) => m.id === id);
  if (!march) return;
  s.formationMarches = s.formationMarches.filter((m) => m.id !== id);
  const ids = new Set(march.memberIds);
  for (const u of s.units) {
    if (ids.has(u.id) && u.order?.formationGroupId === id) clearFormationOrderFields(u);
  }
}

function activeFormationMarch(s: GameState, u: UnitRuntime): GameState["formationMarches"][number] | null {
  const id = u.order?.formationGroupId;
  if (id === undefined) return null;
  return s.formationMarches.find((m) => m.id === id) ?? null;
}

function advanceFormationMarches(s: GameState, stepScale: number): void {
  for (const march of [...s.formationMarches]) {
    const assembling = s.tick - march.issuedTick <= FORMATION_ASSEMBLY_TICKS;
    let shouldBreak = false;
    const keepIds: number[] = [];
    for (const id of march.memberIds) {
      const u = s.units.find((x) => x.id === id);
      if (!u || u.hp <= 0 || u.order?.formationGroupId !== march.id) {
        if (assembling) {
          shouldBreak = true;
          break;
        }
        continue;
      }
      const scattered = Math.hypot(u.vxImpulse, u.vzImpulse) > 0.2;
      const controlled = (u.spellStatuses ?? []).some((st) => st.untilTick > s.tick);
      if (scattered || controlled) {
        shouldBreak = true;
        break;
      }
      keepIds.push(id);
    }
    if (shouldBreak) {
      clearFormationMarch(s, march.id);
      continue;
    }
    if (keepIds.length !== march.memberIds.length) {
      march.memberIds = keepIds;
      if (march.memberIds.length === 0) {
        clearFormationMarch(s, march.id);
        continue;
      }
    }

    const dx = march.goalX - march.anchorX;
    const dz = march.goalZ - march.anchorZ;
    const d = Math.hypot(dx, dz);
    if (d <= 0.03) {
      march.anchorX = march.goalX;
      march.anchorZ = march.goalZ;
      continue;
    }
    const step = march.speedPerSec * UNIT_MOVEMENT_SPEED_SCALE * stepScale;
    const t = Math.min(1, step / d);
    march.anchorX += dx * t;
    march.anchorZ += dz * t;
  }
}

export function movement(s: GameState): void {
  const stepScale = 1 / TICK_HZ;
  const half = s.map.world.halfExtents;
  const structureObsCache = new Map<string, MapObstacleFootprint[]>();
  const structureObstaclesFor = (u: UnitRuntime): MapObstacleFootprint[] => {
    const key = `${u.team}:${u.order?.mode === "stay" ? 1 : 0}`;
    let cached = structureObsCache.get(key);
    if (!cached) {
      cached = structureObstacleFootprintsForUnit(s, u);
      structureObsCache.set(key, cached);
    }
    return cached;
  };
  const stepU = (u: UnitRuntime) =>
    u.speedPerSec *
    stepScale *
    tacticsFieldSpeedMult(s, u.team, u.x, u.z) *
    unitSpellStatusSpeedMult(u) *
    UNIT_MOVEMENT_SPEED_SCALE;

  for (const u of s.units) {
    if (u.hp <= 0) continue;
    integrateKnockback(s, u, stepScale, structureObstaclesFor(u));
  }
  advanceFormationMarches(s, stepScale);

  const anyEnemyCampAwake =
    s.map.enemyCamps.length === 0 || s.map.enemyCamps.some((c) => s.enemyCampAwake[c.id]);
  if (anyEnemyCampAwake) {
    for (const u of s.units) {
      if (u.team !== "enemy" || u.hp <= 0) continue;
      if (s.enemyHumanControlled && u.order) continue;
      const tgt = nearestEnemyAttackTarget(s, u);
      if (!tgt) continue;
      const engage = Math.max(5, u.range * 0.82);
      const engageR2 = engage * engage;
      if (gameDist2(s.map, u, tgt) > engageR2) {
        moveUnitAutonomousOnPath(s, u, tgt, stepU(u), structureObstaclesFor(u));
      } else {
        const slot = formationRingAround(s, tgt, u, UNIT_FORMATION_SPACING * 0.42);
        moveUnitAutonomousOnPath(s, u, slot, stepU(u), structureObstaclesFor(u));
      }
      clampToWorldAndObstacles(s, u, structureObstaclesFor(u));
    }
  }

  const hero = s.hero;
  const defense = s.armyStance === "defense";
  const DEFENSE_ENGAGE_RADIUS = HERO_FOLLOW_RADIUS * 1.42;
  const defR2 = DEFENSE_ENGAGE_RADIUS * DEFENSE_ENGAGE_RADIUS;

  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    if (u.order) {
      u.autoOrder = undefined;
      if (u.order.mode === "stay") {
        clampToWorldAndObstacles(s, u, structureObstaclesFor(u));
        continue;
      }
      const capIdx = u.order.captureTapIndex;
      if (capIdx !== undefined) {
        const tap = capIdx >= 0 && capIdx < s.taps.length ? s.taps[capIdx]! : null;
        if (!tap || (tap.active && tap.ownerTeam === "player")) {
          u.order = undefined;
          continue;
        }
        const jx = ((u.id * 17) % 7) * 0.45 - 1.35;
        const jz = ((u.id * 11) % 7) * 0.45 - 1.35;
        u.order.x = tap.x + jx;
        u.order.z = tap.z + jz;
        const contestR2 = TAP_CAPTURE_CONTEST_RADIUS * TAP_CAPTURE_CONTEST_RADIUS;
        const foeCap = nearestEnemyContestingPoint(s, u, tap, contestR2);
        if (foeCap && gameDist2(s.map, u, foeCap) > u.range * u.range) {
          moveUnitOnPath(s, u, foeCap, stepU(u), structureObstaclesFor(u));
          continue;
        }
        if (foeCap) {
          clampToWorldAndObstacles(s, u, structureObstaclesFor(u));
          continue;
        }
        moveUnitOnPath(s, u, { x: u.order.x, z: u.order.z }, stepU(u), structureObstaclesFor(u));
        continue;
      }
      const acquire2 = playerAcquireRadius(half, u.range) ** 2;
      const foe = u.order.mode === "attack_move" ? nearestEnemyCombatObjective(s, u, acquire2) : null;
      const formation = activeFormationMarch(s, u);
      if (formation && foe) {
        clearFormationMarch(s, formation.id);
      }
      if (foe && gameDist2(s.map, u, foe) > u.range * u.range) {
        moveUnitOnPath(s, u, foe, stepU(u), structureObstaclesFor(u));
        continue;
      }
      if (foe) {
        clampToWorldAndObstacles(s, u, structureObstaclesFor(u));
        continue;
      }
      if (formation) {
        const target = {
          x: formation.anchorX + (u.order.formationOffsetX ?? 0),
          z: formation.anchorZ + (u.order.formationOffsetZ ?? 0),
        };
        if (gameDist2(s.map, u.order, target) > 1.2 * 1.2) u.order.waypoints = [];
        u.order.x = target.x;
        u.order.z = target.z;
        const error = Math.sqrt(gameDist2(s.map, u, target));
        const catchingUp = Math.min(1, error / FORMATION_CATCHUP_RADIUS);
        const catchupCap =
          s.tick - formation.issuedTick <= FORMATION_ASSEMBLY_TICKS
            ? FORMATION_ASSEMBLY_CATCHUP_MULT
            : FORMATION_TRAVEL_CATCHUP_MULT;
        const step = stepU(u) * (1 + (catchupCap - 1) * catchingUp);
        moveUnitOnPath(s, u, target, step, structureObstaclesFor(u));
        continue;
      }
      const arrived = moveUnitOnPath(s, u, { x: u.order.x, z: u.order.z }, stepU(u), structureObstaclesFor(u));
      if (arrived) {
        const next = u.order.queued.shift();
        if (next) {
          u.order.x = next.x;
          u.order.z = next.z;
          u.order.waypoints = [];
          clearFormationOrderFields(u);
        } else {
          u.order = undefined;
        }
      }
      continue;
    }
    const st = s.structures.find((x) => x.id === u.structureId);
    const hold = st?.holdOrders ?? false;
    const detectR = playerAcquireRadius(half, u.range);
    const detectR2 = detectR * detectR;
    const foeUnit = nearestEnemyUnit(s, u, detectR2);

    const engageReach = Math.max(u.range, TAP_ANCHOR_STRIKE_RADIUS);
    const engageReach2 = engageReach * engageReach;

    if (defense) {
      const canEngage = foeUnit && gameDist2(s.map, foeUnit, hero) <= defR2;
      if (canEngage && foeUnit && gameDist2(s.map, u, foeUnit) > u.range * u.range) {
        moveUnitAutonomousOnPath(s, u, foeUnit, stepU(u), structureObstaclesFor(u));
        continue;
      }
      if (canEngage) {
        clampToWorldAndObstacles(s, u, structureObstaclesFor(u));
        continue;
      }
    } else {
      const pursueTarget = nearestEnemyCombatObjective(s, u, detectR2);
      if (pursueTarget && gameDist2(s.map, u, pursueTarget) > engageReach2) {
        moveUnitAutonomousOnPath(s, u, pursueTarget, stepU(u), structureObstaclesFor(u));
        continue;
      }
      if (pursueTarget) {
        clampToWorldAndObstacles(s, u, structureObstaclesFor(u));
        continue;
      }
    }
    if (hold && !defense) {
      if (st) {
        const holdGoal = formationMarchSlot(
          u,
          { x: st.x, z: st.z },
          { x: hero.x, z: hero.z },
          UNIT_FORMATION_SPACING,
        );
        moveUnitAutonomousOnPath(s, u, holdGoal, stepU(u), structureObstaclesFor(u));
      } else {
        clampToWorldAndObstacles(s, u, structureObstaclesFor(u));
      }
      continue;
    }

    let target: Vec2;
    if (defense) {
      const defensePoint = nearestFriendlyPointUnderThreat(s, u, 140 * 140);
      target = defensePoint
        ? formationMarchSlot(u, defensePoint, { x: hero.x, z: hero.z }, UNIT_FORMATION_SPACING)
        : formationRingAround(s, { x: hero.x, z: hero.z }, u, UNIT_FORMATION_SPACING * 0.92);
    } else if (s.globalRallyActive) {
      const anchor = { x: s.globalRallyX, z: s.globalRallyZ };
      target = formationMarchSlot(u, anchor, { x: hero.x, z: hero.z }, UNIT_FORMATION_SPACING);
    } else {
      target = idleOffenseTarget(s, u, st, { x: hero.x, z: hero.z });
    }
    moveUnitAutonomousOnPath(s, u, target, stepU(u), structureObstaclesFor(u));
  }

  applyUnitSeparation(s, structureObstaclesFor);
  for (const u of s.units) {
    if (u.hp <= 0 || u.flying) continue;
    clampToWorldAndObstacles(s, u, structureObstaclesFor(u));
  }
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
      if (gameDist2(s.map, u, tap) > r2) continue;
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
      const teamCaptureSpeed = team === "enemy" ? enemyCaptureSpeedScalar(s) : 1;
      tap.claimTicksRemaining = Math.max(
        1,
        Math.round((claimChannelSecForTap(s, team, tap) * TICK_HZ * 1.35) / teamCaptureSpeed),
      );
    }
    tap.claimTicksRemaining -= 1;
    if (tap.claimTicksRemaining > 0) continue;
    tap.active = true;
    tap.ownerTeam = team;
    armTapClaimAnchor(tap);
    tap.yieldRemaining = Math.max(tap.yieldRemaining, TAP_YIELD_MAX);
    const reward = claimFluxRewardForTap(s, team, tap);
    if (team === "player") s.flux += reward;
    else s.enemyFlux += reward * enemyCaptureSpeedScalar(s);
    pushFx(s, { kind: "claim", x: tap.x, z: tap.z });
    s.lastMessage =
      team === "player"
        ? `Unit squad captured a Mana node (+${reward} Mana).`
        : "Enemy units captured a Mana node.";
    tap.claimTeam = undefined;
    tap.claimTicksRemaining = undefined;
  }
}

function pushLaneTarget(s: GameState, from: Vec2): Vec2 | null {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const st of s.structures) {
    if (st.team !== "enemy" || st.hp <= 0) continue;
    const d = gameDist2(s.map, from, st);
    if (d < bestD) {
      bestD = d;
      best = { x: st.x, z: st.z };
    }
  }
  for (const t of s.taps) {
    if (!t.active || t.ownerTeam !== "enemy") continue;
    if ((t.anchorHp ?? 0) <= 0) continue;
    const d = gameDist2(s.map, from, t);
    if (d < bestD) {
      bestD = d;
      best = { x: t.x, z: t.z };
    }
  }
  for (const er of s.enemyRelays) {
    if (er.hp <= 0) continue;
    const d = gameDist2(s.map, from, er);
    if (d < bestD) {
      bestD = d;
      best = { x: er.x, z: er.z };
    }
  }
  if (best) return best;
  for (const camp of s.map.enemyCamps) {
    const d = gameDist2(s.map, from, camp.origin);
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
      if (gameDist2(s.map, u, camp.origin) <= r * r) {
        s.enemyCampAwake[camp.id] = true;
        s.lastMessage = "Enemy camp alerted.";
        break;
      }
    }
    for (const st of s.structures) {
      if (st.team !== "player" || !st.complete) continue;
      if (gameDist2(s.map, st, camp.origin) <= r * r) {
        s.enemyCampAwake[camp.id] = true;
        s.lastMessage = "Enemy camp alerted.";
        break;
      }
    }
  }
}
