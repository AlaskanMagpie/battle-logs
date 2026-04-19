import { getCatalogEntry } from "../../catalog";
import {
  ENEMY_AI_BUILD_ATTEMPT_INTERVAL_TICKS,
  ENEMY_AI_BUILD_CATALOG_IDS,
  ENEMY_HERO_STRIKE_COOLDOWN_TICKS,
  ENEMY_HERO_STRIKE_DAMAGE,
  ENEMY_TAP_WEDGE_MARGIN_X,
  FORWARD_BUILD_TIME_MULT,
  HERO_ATTACK_RANGE,
  HERO_CLAIM_CHANNEL_SEC,
  HERO_CLAIM_FLUX_FEE,
  HERO_CLAIM_RADIUS,
  TAP_YIELD_MAX,
  TICK_HZ,
} from "../../constants";
import { logGame } from "../../gameLog";
import {
  canPlaceEnemyStructureAt,
  claimedEnemyTapCount,
  enemyTerritorySources,
  findKeep,
  inEnemyTerritory,
  nearEnemyInfra,
  rand,
  type CastFxKind,
  type GameState,
  type StructureRuntime,
} from "../../state";
import { isStructureEntry } from "../../types";
import { dist2 } from "./helpers";

function emitFx(s: GameState, kind: CastFxKind, pos: { x: number; z: number }): void {
  s.lastFx = { kind, x: pos.x, z: pos.z, tick: s.tick };
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
  const step = h.speedPerSec / TICK_HZ;
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

function pickMoveTargetForEnemyHero(s: GameState): void {
  const h = s.enemyHero;
  if (h.targetX !== null) return;
  const idx = pickEnemyPreferredInactiveTap(s, h);
  if (idx === null) return;
  const t = s.taps[idx]!;
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
  let buildTicks = Math.max(1, Math.round(def.buildSeconds * TICK_HZ));
  if (placementForward) buildTicks = Math.round(buildTicks * FORWARD_BUILD_TIME_MULT);
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
    hp: def.maxHp,
    maxHp: def.maxHp,
    buildTicksRemaining: buildTicks,
    buildTotalTicks: buildTicks,
    complete: false,
    productionTicksRemaining: Math.round(def.productionSeconds * TICK_HZ),
    doctrineSlotIndex: -1,
    rallyX: pos.x + rdx * rallyLead,
    rallyZ: pos.z + rdz * rallyLead,
    placementForward,
    damageReductionUntilTick: 0,
    productionSilenceUntilTick: 0,
    holdOrders: false,
  };
  s.structures.push(st);
  s.stats.structuresBuilt += 1;
  emitFx(s, "lightning", pos);
  logGame("combat", `Enemy wizard built ${def.name} at (${pos.x.toFixed(0)}, ${pos.z.toFixed(0)})`, s.tick);
  return true;
}

function attemptEnemyAiBuild(s: GameState): void {
  if (s.phase !== "setup" && s.phase !== "playing") return;
  if (s.tick % ENEMY_AI_BUILD_ATTEMPT_INTERVAL_TICKS !== 0) return;
  const half = s.map.world.halfExtents;
  const sources = enemyTerritorySources(s);
  if (sources.length === 0) return;
  for (let attempt = 0; attempt < 18; attempt++) {
    const base = sources[Math.floor(rand(s) * sources.length)]!;
    const x = base.x + (rand(s) - 0.5) * 32;
    const z = base.z + (rand(s) - 0.5) * 32;
    if (Math.abs(x) > half - 8 || Math.abs(z) > half - 8) continue;
    if (!inEnemyTerritory(s, { x, z })) continue;
    const sortedIds = [...ENEMY_AI_BUILD_CATALOG_IDS].sort((a, b) => {
      const ea = getCatalogEntry(a);
      const eb = getCatalogEntry(b);
      const ca = ea && isStructureEntry(ea) ? ea.fluxCost : 9999;
      const cb = eb && isStructureEntry(eb) ? eb.fluxCost : 9999;
      return ca - cb || a.localeCompare(b);
    });
    for (const catalogId of sortedIds) {
      if (tryEnemyPlaceStructure(s, catalogId, { x, z })) return;
    }
  }
}

export function enemyHeroSystem(s: GameState): void {
  const h = s.enemyHero;
  if (h.attackCooldownTicksRemaining > 0) h.attackCooldownTicksRemaining -= 1;

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
      if (s.enemyFlux < HERO_CLAIM_FLUX_FEE) {
        /* wait for tap income */
      } else {
        h.claimChannelTarget = idx;
        h.claimChannelTicksRemaining = Math.round(HERO_CLAIM_CHANNEL_SEC * TICK_HZ);
      }
    }
  }

  if (h.claimChannelTarget !== null) {
    h.claimChannelTicksRemaining -= 1;
    if (h.claimChannelTicksRemaining <= 0) {
      const idx = h.claimChannelTarget;
      const tap = idx !== null ? s.taps[idx] : undefined;
      if (tap && !tap.active) {
        if (s.enemyFlux < HERO_CLAIM_FLUX_FEE) {
          /* skip */
        } else {
          s.enemyFlux -= HERO_CLAIM_FLUX_FEE;
          tap.active = true;
          tap.ownerTeam = "enemy";
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
  if (s.phase !== "setup" && s.phase !== "playing") return;
  const h = s.enemyHero;
  if (h.hp <= 0 || h.attackCooldownTicksRemaining > 0) return;
  const r2 = HERO_ATTACK_RANGE * HERO_ATTACK_RANGE;

  if (s.hero.hp > 0 && dist2(h, s.hero) <= r2) {
    s.hero.hp = Math.max(0, s.hero.hp - ENEMY_HERO_STRIKE_DAMAGE);
    h.attackCooldownTicksRemaining = ENEMY_HERO_STRIKE_COOLDOWN_TICKS;
    emitFx(s, "hero_strike", { x: s.hero.x, z: s.hero.z });
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
    bestU.hp -= ENEMY_HERO_STRIKE_DAMAGE;
    h.attackCooldownTicksRemaining = ENEMY_HERO_STRIKE_COOLDOWN_TICKS;
    emitFx(s, "hero_strike", { x: bestU.x, z: bestU.z });
    return;
  }

  const keep = findKeep(s);
  if (keep && dist2(h, keep) <= r2) {
    keep.hp -= ENEMY_HERO_STRIKE_DAMAGE * 0.45;
    h.attackCooldownTicksRemaining = ENEMY_HERO_STRIKE_COOLDOWN_TICKS;
    emitFx(s, "hero_strike", { x: keep.x, z: keep.z });
  }
}
