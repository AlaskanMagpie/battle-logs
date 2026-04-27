import { getCatalogEntry } from "../../catalog";
import {
  ENEMY_AI_BUILD_ATTEMPT_INTERVAL_TICKS,
  ENEMY_AI_BUILD_CATALOG_IDS,
  ENEMY_AI_BUILD_RESERVE_AFTER_CLAIM_FEE,
  ENEMY_AI_CLAIM_RESERVE_TAP_GOAL,
  ENEMY_AI_MIN_BUILD_SEP,
  ENEMY_DAMAGE_MULT,
  ENEMY_HERO_STRIKE_COOLDOWN_TICKS,
  ENEMY_HERO_STRIKE_DAMAGE,
  ENEMY_HERO_STRIKE_SWARM_MULT,
  ENEMY_PRODUCTION_RATE_MULT,
  ENEMY_TAP_WEDGE_MARGIN_X,
  FORWARD_STRUCTURE_HP_MULT,
  HERO_ATTACK_RANGE,
  HERO_CLAIM_FLUX_FEE,
  HERO_CLAIM_RADIUS,
  HERO_MAP_OBSTACLE_RADIUS,
  HOME_CLAIM_FLUX_MULT_MAX,
  TAP_YIELD_MAX,
  TICK_HZ,
} from "../../constants";
import { logGame } from "../../gameLog";
import {
  armTapClaimAnchor,
  canPlaceEnemyStructureAt,
  claimedEnemyTapCount,
  emitHeroStrikeFx,
  enemyTerritorySources,
  findKeep,
  inEnemyTerritory,
  nearEnemyInfra,
  pushFx,
  rand,
  shatterTapAnchor,
  tacticsFieldSpeedMult,
  type CastFxKind,
  type GameState,
  type StructureRuntime,
} from "../../state";
import { isStructureEntry } from "../../types";
import { resolveCircleAgainstMapObstacles } from "../../mapObstacles";
import { applyAttackImpulse } from "./combat";
import { dist2 } from "./helpers";
import { claimChannelSecForTap, claimFluxFeeForTap } from "./homeDistance";

function emitFx(s: GameState, kind: CastFxKind, pos: { x: number; z: number }): void {
  pushFx(s, { kind, x: pos.x, z: pos.z });
}

function moveEnemyHeroToward(s: GameState): void {
  const h = s.enemyHero;
  if (h.targetX === null || h.targetZ === null) return;
  const dx = h.targetX - h.x;
  const dz = h.targetZ - h.z;
  const len = Math.hypot(dx, dz);
  if (len <= 0.001) {
    h.targetX = null;
    h.targetZ = null;
    return;
  }
  h.facing = Math.atan2(dx, dz);
  const step = (h.speedPerSec / TICK_HZ) * tacticsFieldSpeedMult(s, "enemy", h.x, h.z);
  if (len <= step) {
    h.x = h.targetX;
    h.z = h.targetZ;
    h.targetX = null;
    h.targetZ = null;
  } else {
    h.x += (dx / len) * step;
    h.z += (dz / len) * step;
  }
  const half = s.map.world.halfExtents;
  h.x = Math.max(-half, Math.min(half, h.x));
  h.z = Math.max(-half, Math.min(half, h.z));
  resolveCircleAgainstMapObstacles(s.map, h, HERO_MAP_OBSTACLE_RADIUS);
}

/** In-range inactive tap for channeling; prefers enemy wedge when tied in radius. */
function findClaimableTapIndexNearEnemy(s: GameState, actor: { x: number; z: number }): number | null {
  const margin = ENEMY_TAP_WEDGE_MARGIN_X;
  const r2 = HERO_CLAIM_RADIUS * HERO_CLAIM_RADIUS;
  let bestSide: number | null = null;
  let bestDSide = r2;
  let bestAny: number | null = null;
  let bestDAny = r2;
  for (let i = 0; i < s.taps.length; i++) {
    const t = s.taps[i]!;
    if (t.active) continue;
    const d = dist2(actor, t);
    if (d > r2) continue;
    if (t.x >= margin && d <= bestDSide) {
      bestDSide = d;
      bestSide = i;
    }
    if (d <= bestDAny) {
      bestDAny = d;
      bestAny = i;
    }
  }
  return bestSide ?? bestAny;
}

/**
 * Move goal: prefer inactive taps on the enemy wedge (x >= margin), like procedural
 * east-side nodes; if none left, fall back to nearest neutral tap anywhere.
 */
function pickEnemyPreferredInactiveTap(s: GameState, actor: { x: number; z: number }): number | null {
  const margin = ENEMY_TAP_WEDGE_MARGIN_X;
  let bestSide: number | null = null;
  let bestDSide = Infinity;
  let bestAny: number | null = null;
  let bestDAny = Infinity;
  for (let i = 0; i < s.taps.length; i++) {
    const t = s.taps[i]!;
    if (t.active) continue;
    const d = dist2(actor, t);
    if (t.x >= margin && d < bestDSide) {
      bestDSide = d;
      bestSide = i;
    }
    if (d < bestDAny) {
      bestDAny = d;
      bestAny = i;
    }
  }
  return bestSide ?? bestAny;
}

function invalidateStaleEnemyHeroMoveTarget(s: GameState): void {
  const h = s.enemyHero;
  if (h.targetX === null || h.targetZ === null) return;
  for (let i = 0; i < s.taps.length; i++) {
    const t = s.taps[i]!;
    const dx = t.x - h.targetX;
    const dz = t.z - h.targetZ;
    if (dx * dx + dz * dz > 0.25) continue;
    if (t.active) {
      h.targetX = null;
      h.targetZ = null;
    }
    return;
  }
}

/**
 * Walk toward the best neutral tap. If we are already inside claim range of that tap, do **not**
 * assign a move target — otherwise `moving` stays true forever and the claim channel never starts.
 */
function pickMoveTargetForEnemyHero(s: GameState): void {
  const h = s.enemyHero;
  if (h.targetX !== null || h.targetZ !== null) return;
  const idx = pickEnemyPreferredInactiveTap(s, h);
  if (idx === null) return;
  const t = s.taps[idx]!;
  const r2 = HERO_CLAIM_RADIUS * HERO_CLAIM_RADIUS;
  if (dist2(h, t) <= r2) return;
  h.targetX = t.x;
  h.targetZ = t.z;
}

function tryEnemyPlaceStructure(s: GameState, catalogId: string, pos: { x: number; z: number }): boolean {
  const err = canPlaceEnemyStructureAt(s, catalogId, pos);
  if (err) return false;
  const def = getCatalogEntry(catalogId);
  if (!def || !isStructureEntry(def)) return false;
  s.enemyFlux -= def.fluxCost;
  const placementForward = !nearEnemyInfra(s, pos) && inEnemyTerritory(s, pos);
  const buildTicks = Math.max(1, Math.round(def.buildSeconds * TICK_HZ));
  const hpMult = placementForward ? FORWARD_STRUCTURE_HP_MULT : 1;
  const hp0 = Math.max(1, Math.round(def.maxHp * hpMult));
  const keep = findKeep(s);
  const towardX = keep ? keep.x : -s.map.world.halfExtents * 0.55;
  const towardZ = keep ? keep.z : 0;
  let rdx = towardX - pos.x;
  let rdz = towardZ - pos.z;
  const rlen = Math.hypot(rdx, rdz) || 1;
  rdx /= rlen;
  rdz /= rlen;
  const rallyLead = 16;
  const st: StructureRuntime = {
    id: s.nextId.structure++,
    team: "enemy",
    catalogId,
    x: pos.x,
    z: pos.z,
    hp: hp0,
    maxHp: hp0,
    buildTicksRemaining: buildTicks,
    buildTotalTicks: buildTicks,
    complete: false,
    productionTicksRemaining: Math.round((def.productionSeconds * TICK_HZ) / ENEMY_PRODUCTION_RATE_MULT),
    doctrineSlotIndex: -1,
    rallyX: pos.x + rdx * rallyLead,
    rallyZ: pos.z + rdz * rallyLead,
    placementForward,
    damageReductionUntilTick: 0,
    productionSilenceUntilTick: 0,
    holdOrders: false,
    localPopCapBonus: 0,
  };
  s.structures.push(st);
  s.stats.structuresBuilt += 1;
  s.enemyAiLastBuildCatalogId = catalogId;
  emitFx(s, "lightning", pos);
  logGame("combat", `Enemy wizard built ${def.name} at (${pos.x.toFixed(0)}, ${pos.z.toFixed(0)})`, s.tick);
  return true;
}

function unclaimedTapCount(s: GameState): number {
  let n = 0;
  for (const t of s.taps) {
    if (!t.active) n++;
  }
  return n;
}

/** Mana floor to leave after a build so the rival can still channel the next node claim. */
function enemyBuildFluxReserve(s: GameState): number {
  const taps = claimedEnemyTapCount(s);
  if (taps >= ENEMY_AI_CLAIM_RESERVE_TAP_GOAL) return 8;
  if (unclaimedTapCount(s) === 0) return 0;
  return Math.ceil(HERO_CLAIM_FLUX_FEE * HOME_CLAIM_FLUX_MULT_MAX) + ENEMY_AI_BUILD_RESERVE_AFTER_CLAIM_FEE;
}

function minDist2ToEnemyStructures(s: GameState, pos: { x: number; z: number }): number {
  let m = Infinity;
  for (const st of s.structures) {
    if (st.team !== "enemy") continue;
    const d = dist2(pos, st);
    if (d < m) m = d;
  }
  return m;
}

function enemyAiBuildIntervalTicks(s: GameState): number {
  const d = s.map.difficulty;
  const stress = d ? Math.max(d.enemyHpMult, d.enemyDmgMult) : 1;
  const cadence = 0.62 + 0.38 * Math.min(Math.max(stress, 0.85), 1.65);
  return Math.max(
    Math.round(1.6 * TICK_HZ),
    Math.round(ENEMY_AI_BUILD_ATTEMPT_INTERVAL_TICKS / cadence),
  );
}

function attemptEnemyAiBuild(s: GameState): void {
  if (s.phase !== "playing") return;
  if (s.tick % enemyAiBuildIntervalTicks(s) !== 0) return;
  const half = s.map.world.halfExtents;
  const sources = enemyTerritorySources(s);
  const n = sources.length;
  if (n === 0) return;
  const reserve = enemyBuildFluxReserve(s);
  const sep2 = ENEMY_AI_MIN_BUILD_SEP * ENEMY_AI_MIN_BUILD_SEP;
  const legalIds = [...ENEMY_AI_BUILD_CATALOG_IDS].filter((id) => {
    const e = getCatalogEntry(id);
    return e && isStructureEntry(e);
  });
  if (legalIds.length === 0) return;
  const weights = legalIds.map((id) => {
    const e = getCatalogEntry(id);
    const cost = e && isStructureEntry(e) ? e.fluxCost : 999;
    const w = 1 / Math.sqrt(Math.max(28, cost));
    const last = s.enemyAiLastBuildCatalogId;
    const diversity = id === last ? 0.22 : 1;
    const early = claimedEnemyTapCount(s) < 2 && cost > 95 ? 0.55 : 1;
    return w * diversity * early;
  });
  const sumW = weights.reduce((a, b) => a + b, 0) || 1;
  function pickWeightedCatalogId(): string {
    let r = rand(s) * sumW;
    for (let i = 0; i < legalIds.length; i++) {
      r -= weights[i]!;
      if (r <= 0) return legalIds[i]!;
    }
    return legalIds[legalIds.length - 1]!;
  }
  for (let attempt = 0; attempt < 22; attempt++) {
    const pick = Math.min(n - 1, Math.max(0, Math.floor(rand(s) * n)));
    const base = sources[pick];
    if (!base) continue;
    const x = base.x + (rand(s) - 0.5) * 32;
    const z = base.z + (rand(s) - 0.5) * 32;
    if (Math.abs(x) > half - 8 || Math.abs(z) > half - 8) continue;
    if (!inEnemyTerritory(s, { x, z })) continue;
    if (minDist2ToEnemyStructures(s, { x, z }) < sep2) continue;
    for (let k = 0; k < 8; k++) {
      const catalogId = pickWeightedCatalogId();
      const def = getCatalogEntry(catalogId);
      if (!def || !isStructureEntry(def)) continue;
      if (s.enemyFlux < def.fluxCost + reserve) continue;
      if (tryEnemyPlaceStructure(s, catalogId, { x, z })) return;
    }
  }
}

export function enemyHeroSystem(s: GameState): void {
  const h = s.enemyHero;
  if (h.attackCooldownTicksRemaining > 0) h.attackCooldownTicksRemaining -= 1;

  invalidateStaleEnemyHeroMoveTarget(s);
  moveEnemyHeroToward(s);
  pickMoveTargetForEnemyHero(s);

  const moving = h.targetX !== null || h.targetZ !== null;
  if (moving && h.claimChannelTarget !== null) {
    h.claimChannelTarget = null;
    h.claimChannelTicksRemaining = 0;
  }

  if (h.claimChannelTarget !== null) {
    const tap = s.taps[h.claimChannelTarget];
    if (!tap || tap.active || dist2(h, tap) > HERO_CLAIM_RADIUS * HERO_CLAIM_RADIUS) {
      h.claimChannelTarget = null;
      h.claimChannelTicksRemaining = 0;
    }
  }

  if (!moving && h.claimChannelTarget === null) {
    const idx = findClaimableTapIndexNearEnemy(s, h);
    if (idx !== null) {
      const tap0 = s.taps[idx]!;
      const fee0 = claimFluxFeeForTap(s, "enemy", tap0);
      if (s.enemyFlux < fee0) {
        /* wait for tap income */
      } else {
        h.claimChannelTarget = idx;
        h.claimChannelTicksRemaining = Math.round(claimChannelSecForTap(s, "enemy", tap0) * TICK_HZ);
      }
    }
  }

  if (h.claimChannelTarget !== null) {
    h.claimChannelTicksRemaining -= 1;
    if (h.claimChannelTicksRemaining <= 0) {
      const idx = h.claimChannelTarget;
      const tap = idx !== null ? s.taps[idx] : undefined;
      if (tap && !tap.active) {
        const fee = claimFluxFeeForTap(s, "enemy", tap);
        if (s.enemyFlux < fee) {
          /* skip */
        } else {
          s.enemyFlux -= fee;
          tap.active = true;
          tap.ownerTeam = "enemy";
          armTapClaimAnchor(tap);
          tap.yieldRemaining = Math.max(tap.yieldRemaining, TAP_YIELD_MAX);
          emitFx(s, "claim", { x: tap.x, z: tap.z });
          logGame("claim", `Enemy wizard claimed ${tap.defId}`, s.tick);
          if (claimedEnemyTapCount(s) === 1) {
            s.lastMessage = "The rival Wizard has claimed a Mana node.";
          }
        }
      }
      h.claimChannelTarget = null;
      h.claimChannelTicksRemaining = 0;
    }
  }

  attemptEnemyAiBuild(s);
  enemyHeroTryStrike(s);
}

/** Rival wizard melee: player hero, then a nearby player unit, then the Keep. */
function enemyHeroTryStrike(s: GameState): void {
  if (s.phase !== "playing") return;
  const h = s.enemyHero;
  if (h.hp <= 0 || h.attackCooldownTicksRemaining > 0) return;
  const r2 = HERO_ATTACK_RANGE * HERO_ATTACK_RANGE;

  const from = { x: h.x, z: h.z };
  if (s.hero.hp > 0 && dist2(h, s.hero) <= r2) {
    s.hero.hp = Math.max(0, s.hero.hp - ENEMY_HERO_STRIKE_DAMAGE * ENEMY_DAMAGE_MULT);
    h.attackCooldownTicksRemaining = ENEMY_HERO_STRIKE_COOLDOWN_TICKS;
    emitHeroStrikeFx(s, { x: s.hero.x, z: s.hero.z }, from, "rival_vs_hero");
    return;
  }

  let bestU: (typeof s.units)[0] | null = null;
  let bestD = r2;
  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    const d2 = dist2(h, u);
    if (d2 <= bestD) {
      bestD = d2;
      bestU = u;
    }
  }
  if (bestU) {
    const swarmMult = bestU.sizeClass === "Swarm" ? ENEMY_HERO_STRIKE_SWARM_MULT : 1;
    bestU.hp -= ENEMY_HERO_STRIKE_DAMAGE * ENEMY_DAMAGE_MULT * swarmMult;
    applyAttackImpulse(bestU, from, 2.1 * swarmMult);
    h.attackCooldownTicksRemaining = ENEMY_HERO_STRIKE_COOLDOWN_TICKS;
    emitHeroStrikeFx(s, { x: bestU.x, z: bestU.z }, from, "rival_vs_unit");
    return;
  }

  let bestTap: (typeof s.taps)[0] | null = null;
  let bestTapD = r2;
  for (const t of s.taps) {
    if (!t.active || t.ownerTeam !== "player") continue;
    if ((t.anchorHp ?? 0) <= 0) continue;
    const d2 = dist2(h, t);
    if (d2 <= bestTapD) {
      bestTapD = d2;
      bestTap = t;
    }
  }
  if (bestTap) {
    const cur = bestTap.anchorHp ?? 0;
    bestTap.anchorHp = Math.max(0, cur - ENEMY_HERO_STRIKE_DAMAGE * ENEMY_DAMAGE_MULT * 0.42);
    h.attackCooldownTicksRemaining = ENEMY_HERO_STRIKE_COOLDOWN_TICKS;
    emitHeroStrikeFx(s, { x: bestTap.x, z: bestTap.z }, from, "rival_vs_anchor");
    if ((bestTap.anchorHp ?? 0) <= 0) shatterTapAnchor(s, bestTap);
    return;
  }

  const keep = findKeep(s);
  if (keep && dist2(h, keep) <= r2) {
    keep.hp -= ENEMY_HERO_STRIKE_DAMAGE * ENEMY_DAMAGE_MULT * 0.45;
    h.attackCooldownTicksRemaining = ENEMY_HERO_STRIKE_COOLDOWN_TICKS;
    emitHeroStrikeFx(s, { x: keep.x, z: keep.z }, from, "rival_vs_keep");
  }
}
