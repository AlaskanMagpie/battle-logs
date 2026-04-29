import { getCatalogEntry } from "../../catalog";
import {
  ENEMY_AI_BUILD_ATTEMPT_INTERVAL_TICKS,
  ENEMY_AI_MIN_BUILD_SEP,
  FORWARD_STRUCTURE_HP_MULT,
  HERO_CLAIM_RADIUS,
  HERO_MAP_OBSTACLE_RADIUS,
  HERO_WASD_SPEED,
  TAP_YIELD_MAX,
  TICK_HZ,
} from "../../constants";
import { logGame } from "../../gameLog";
import { planChainedPathAroundMapObstacles, resolveCircleAgainstMapObstacles } from "../../mapObstacles";
import {
  armTapClaimAnchor,
  canPlaceStructureHere,
  findKeep,
  heroStandPositionNearKeepAnchor,
  nearFriendlyInfra,
  nearFriendlyForward,
  nearSafeDeployAura,
  pushFx,
  rand,
  tacticsFieldSpeedMult,
  territorySources,
  type GameState,
  type StructureRuntime,
} from "../../state";
import { structureObstacleFootprints } from "../../structureObstacles";
import { isStructureEntry, type Vec2 } from "../../types";
import { dist2 } from "./helpers";
import { claimChannelSecForTap, claimFluxRewardForTap } from "./homeDistance";
import { applyHeroFacingTowardWorld } from "./heroFacing";
import { tryPlayerHeroStrike } from "./heroStrike";

const HERO_CAPTAIN_IDLE_TICKS = Math.round(1.2 * TICK_HZ);
const HERO_CAPTAIN_BUILD_INTERVAL_TICKS = ENEMY_AI_BUILD_ATTEMPT_INTERVAL_TICKS;

/** Neutral tap index within `HERO_CLAIM_RADIUS` of the Wizard (closest wins). */
export function findNeutralTapIndexNearHero(s: GameState): number | null {
  const r2 = HERO_CLAIM_RADIUS * HERO_CLAIM_RADIUS;
  let best: number | null = null;
  let bestD = r2;
  for (let i = 0; i < s.taps.length; i++) {
    const t = s.taps[i]!;
    if (t.active) continue;
    const d = dist2(s.hero, t);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function popNextHeroWaypoint(h: GameState["hero"]): void {
  const next = h.moveWaypoints.shift();
  if (next) {
    h.targetX = next.x;
    h.targetZ = next.z;
  } else {
    h.targetX = null;
    h.targetZ = null;
  }
}

export function setHeroMovePath(s: GameState, target: { x: number; z: number }): void {
  const h = s.hero;
  const half = s.map.world.halfExtents;
  const clamped = {
    x: Math.max(-half, Math.min(half, target.x)),
    z: Math.max(-half, Math.min(half, target.z)),
  };
  const path = planChainedPathAroundMapObstacles(
    s.map,
    h,
    clamped,
    HERO_MAP_OBSTACLE_RADIUS,
    structureObstacleFootprints(s),
  );
  const first = path.shift() ?? clamped;
  h.targetX = first.x;
  h.targetZ = first.z;
  h.moveWaypoints.length = 0;
  h.moveWaypoints.push(...path);
}

function moveHeroToward(s: GameState): void {
  const h = s.hero;
  if (h.targetX === null || h.targetZ === null) return;
  const dx = h.targetX - h.x;
  const dz = h.targetZ - h.z;
  const len = Math.hypot(dx, dz);
  if (len <= 0.001) {
    popNextHeroWaypoint(h);
    return;
  }
  h.facing = Math.atan2(dx, dz);
  const step = (h.speedPerSec / TICK_HZ) * tacticsFieldSpeedMult(s, "player", h.x, h.z);
  if (len <= step) {
    h.x = h.targetX;
    h.z = h.targetZ;
    popNextHeroWaypoint(h);
  } else {
    h.x += (dx / len) * step;
    h.z += (dz / len) * step;
  }
  const half = s.map.world.halfExtents;
  h.x = Math.max(-half, Math.min(half, h.x));
  h.z = Math.max(-half, Math.min(half, h.z));
  resolveCircleAgainstMapObstacles(s.map, h, HERO_MAP_OBSTACLE_RADIUS, structureObstacleFootprints(s));
}

function applyWasd(s: GameState): boolean {
  const h = s.hero;
  const wx = h.wasdStrafe;
  const wz = h.wasdForward;
  if (wx === 0 && wz === 0) return false;
  let dx = wx;
  let dz = wz;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return false;
  dx /= len;
  dz /= len;
  h.facing = Math.atan2(dx, dz);
  const step = (HERO_WASD_SPEED / TICK_HZ) * tacticsFieldSpeedMult(s, "player", h.x, h.z);
  h.x += dx * step;
  h.z += dz * step;
  const half = s.map.world.halfExtents;
  h.x = Math.max(-half, Math.min(half, h.x));
  h.z = Math.max(-half, Math.min(half, h.z));
  resolveCircleAgainstMapObstacles(s.map, h, HERO_MAP_OBSTACLE_RADIUS, structureObstacleFootprints(s));
  h.targetX = null;
  h.targetZ = null;
  h.moveWaypoints.length = 0;
  return true;
}

function nearestHeroCaptainObjective(s: GameState): { x: number; z: number } | null {
  const h = s.hero;
  let best: { x: number; z: number } | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  const consider = (p: { x: number; z: number }): void => {
    const d = dist2(h, p);
    if (d < bestD) {
      bestD = d;
      best = { x: p.x, z: p.z };
    }
  };

  for (const t of s.taps) {
    if (!t.active) consider(t);
  }
  if (best) return best;

  for (const st of s.structures) {
    if (st.team === "enemy" && st.hp > 0) consider(st);
  }
  for (const r of s.enemyRelays) {
    if (r.hp > 0) consider(r);
  }
  for (const c of s.map.enemyCamps) {
    const hp = s.enemyCampCoreHp[c.id];
    if (hp !== undefined && hp > 0) consider(c.origin);
  }
  for (const u of s.units) {
    if (u.team === "enemy" && u.hp > 0) consider(u);
  }
  return best;
}

function emitCaptainSummonFx(s: GameState, catalogId: string, pos: Vec2): void {
  const e = getCatalogEntry(catalogId);
  const sigs = e && isStructureEntry(e) ? e.signalTypes : [];
  const v = sigs.includes("Vanguard") ? 1 : 0;
  const b = sigs.includes("Bastion") ? 1 : 0;
  const r = sigs.includes("Reclaim") ? 1 : 0;
  pushFx(s, { kind: "lightning", x: pos.x, z: pos.z });
  if (v >= b && v >= r) pushFx(s, { kind: "spark_burst", x: pos.x, z: pos.z });
  else if (b >= r) pushFx(s, { kind: "ground_crack", x: pos.x, z: pos.z });
  else pushFx(s, { kind: "reclaim_pulse", x: pos.x, z: pos.z });
}

function minDist2ToPlayerStructures(s: GameState, pos: Vec2): number {
  let m = Infinity;
  for (const st of s.structures) {
    if (st.team !== "player") continue;
    const d = dist2(pos, st);
    if (d < m) m = d;
  }
  return m;
}

function captainAutoBuildChoices(s: GameState): { catalogId: string; slotIndex: number; weight: number }[] {
  const counts = new Map<string, number>();
  for (const st of s.structures) {
    if (st.team !== "player") continue;
    counts.set(st.catalogId, (counts.get(st.catalogId) ?? 0) + 1);
  }

  const out: { catalogId: string; slotIndex: number; weight: number }[] = [];
  for (let slotIndex = 0; slotIndex < s.doctrineSlotCatalogIds.length; slotIndex++) {
    const catalogId = s.doctrineSlotCatalogIds[slotIndex];
    if (!catalogId) continue;
    const e = getCatalogEntry(catalogId);
    if (!e || !isStructureEntry(e)) continue;
    if ((s.doctrineCooldownTicks[slotIndex] ?? 0) > 0) continue;
    if (s.flux < e.fluxCost) continue;
    const costWeight = 1 / Math.sqrt(Math.max(28, e.fluxCost));
    const diversityWeight = 1 / (1 + (counts.get(catalogId) ?? 0) * 0.65);
    out.push({ catalogId, slotIndex, weight: costWeight * diversityWeight });
  }
  return out;
}

function pickCaptainAutoBuildChoice(
  s: GameState,
  choices: readonly { catalogId: string; slotIndex: number; weight: number }[],
): { catalogId: string; slotIndex: number } | null {
  const sum = choices.reduce((a, c) => a + c.weight, 0);
  if (sum <= 0) return null;
  let r = rand(s) * sum;
  for (const c of choices) {
    r -= c.weight;
    if (r <= 0) return c;
  }
  return choices[choices.length - 1] ?? null;
}

function placeCaptainStructure(s: GameState, catalogId: string, slotIndex: number, pos: Vec2): boolean {
  if (canPlaceStructureHere(s, catalogId, pos, slotIndex)) return false;
  const def = getCatalogEntry(catalogId);
  if (!def || !isStructureEntry(def)) return false;

  s.flux -= def.fluxCost;
  const infra = nearFriendlyInfra(s, pos) || nearSafeDeployAura(s, pos);
  const placementForward = !infra && nearFriendlyForward(s, pos);
  const buildTicks = Math.max(1, Math.round(def.buildSeconds * TICK_HZ));
  const hpMult = placementForward ? FORWARD_STRUCTURE_HP_MULT : 1;
  const hp0 = Math.max(1, Math.round(def.maxHp * hpMult));
  const objective = nearestHeroCaptainObjective(s);
  const rallyFrom = objective ?? { x: s.map.world.halfExtents * 0.55, z: 0 };
  let rdx = rallyFrom.x - pos.x;
  let rdz = rallyFrom.z - pos.z;
  const rlen = Math.hypot(rdx, rdz) || 1;
  rdx /= rlen;
  rdz /= rlen;
  const rallyLead = 16;
  const st: StructureRuntime = {
    id: s.nextId.structure++,
    team: "player",
    catalogId,
    x: pos.x,
    z: pos.z,
    hp: hp0,
    maxHp: hp0,
    buildTicksRemaining: buildTicks,
    buildTotalTicks: buildTicks,
    complete: false,
    productionTicksRemaining: Math.round(def.productionSeconds * TICK_HZ),
    doctrineSlotIndex: slotIndex,
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
  if (def.chargeCooldownSeconds > 0) {
    s.doctrineCooldownTicks[slotIndex] = Math.round(def.chargeCooldownSeconds * TICK_HZ);
  }
  emitCaptainSummonFx(s, catalogId, pos);
  logGame("combat", `Captain mode built ${def.name} at (${pos.x.toFixed(0)}, ${pos.z.toFixed(0)})`, s.tick);
  s.lastMessage = `Captain mode: ${def.name} summoned automatically.`;
  return true;
}

function attemptCaptainAutoBuild(s: GameState): void {
  if (s.phase !== "playing") return;
  if (s.pendingPlacementCatalogId !== null || s.selectedDoctrineIndex !== null) return;
  if (s.tick % HERO_CAPTAIN_BUILD_INTERVAL_TICKS !== 0) return;
  const choices = captainAutoBuildChoices(s);
  if (!choices.length) return;
  const sources = territorySources(s);
  if (!sources.length) return;
  const half = s.map.world.halfExtents;
  const sep2 = ENEMY_AI_MIN_BUILD_SEP * ENEMY_AI_MIN_BUILD_SEP;
  for (let attempt = 0; attempt < 22; attempt++) {
    const source = sources[Math.min(sources.length - 1, Math.floor(rand(s) * sources.length))];
    if (!source) continue;
    const pos = {
      x: source.x + (rand(s) - 0.5) * 32,
      z: source.z + (rand(s) - 0.5) * 32,
    };
    if (Math.abs(pos.x) > half - 8 || Math.abs(pos.z) > half - 8) continue;
    if (minDist2ToPlayerStructures(s, pos) < sep2) continue;
    for (let k = 0; k < 8; k++) {
      const choice = pickCaptainAutoBuildChoice(s, choices);
      if (!choice) return;
      if (placeCaptainStructure(s, choice.catalogId, choice.slotIndex, pos)) return;
    }
  }
}

function applyHeroCaptainMode(s: GameState): void {
  const h = s.hero;
  if (!s.heroCaptainEnabled || h.hp <= 0) return;
  if (s.tick - s.heroCaptainLastManualTick < HERO_CAPTAIN_IDLE_TICKS) return;
  attemptCaptainAutoBuild(s);
  if (h.targetX !== null || h.targetZ !== null || h.moveWaypoints.length > 0 || h.claimChannelTarget !== null) return;
  const target = nearestHeroCaptainObjective(s);
  if (!target) return;
  setHeroMovePath(s, target);
  s.lastMessage = "Captain mode: Wizard moving on the next objective.";
}

export function heroSystem(s: GameState): void {
  const h = s.hero;

  if (h.attackCooldownTicksRemaining > 0) {
    h.attackCooldownTicksRemaining -= 1;
  }

  const wasdMoving = applyWasd(s);
  if (!wasdMoving) {
    moveHeroToward(s);
  }

  h.wasdStrafe = 0;
  h.wasdForward = 0;

  applyHeroCaptainMode(s);

  // Drop a claim only if the Wizard leaves the node. Movement inside the ring
  // should keep channeling so capture feels continuous while pathing.
  if (h.claimChannelTarget !== null) {
    const tap = s.taps[h.claimChannelTarget];
    if (!tap || tap.active || dist2(h, tap) > HERO_CLAIM_RADIUS * HERO_CLAIM_RADIUS) {
      h.claimChannelTarget = null;
      h.claimChannelTicksRemaining = 0;
      s.lastMessage = "Claim cancelled.";
    }
  }

  // Auto-start a channel whenever the Wizard is inside range of a neutral tap (and can afford the fee).
  if (h.claimChannelTarget === null) {
    const idx = findNeutralTapIndexNearHero(s);
    if (idx !== null) {
      const tap = s.taps[idx]!;
      const chSec = claimChannelSecForTap(s, "player", tap);
      h.claimChannelTarget = idx;
      h.claimChannelTicksRemaining = Math.round(chSec * TICK_HZ);
      s.lastMessage = `Claiming node… stay inside the ring for ${chSec.toFixed(1)}s.`;
    }
  }

  // Progress channel.
  if (h.claimChannelTarget !== null) {
    h.claimChannelTicksRemaining -= 1;
    if (h.claimChannelTicksRemaining <= 0) {
      const idx = h.claimChannelTarget;
      const tap = s.taps[idx];
      if (tap && !tap.active) {
        const reward = claimFluxRewardForTap(s, "player", tap);
        s.flux += reward;
        tap.active = true;
        tap.ownerTeam = "player";
        armTapClaimAnchor(tap);
        tap.yieldRemaining = Math.max(tap.yieldRemaining, TAP_YIELD_MAX);
        pushFx(s, { kind: "claim", x: tap.x, z: tap.z });
        s.lastMessage = `Node claimed (+${reward} Mana now, faster income). Territory expanded.`;
        logGame("claim", `Mana node ${tap.defId} claimed`, s.tick);
      }
      h.claimChannelTarget = null;
      h.claimChannelTicksRemaining = 0;
    }
  }

  const sf = h.spellFacingToward;
  if (sf !== undefined) {
    h.spellFacingToward = undefined;
    applyHeroFacingTowardWorld(s, sf.x, sf.z);
  }

  if (h.claimChannelTarget !== null) {
    const tap = s.taps[h.claimChannelTarget];
    if (tap) applyHeroFacingTowardWorld(s, tap.x, tap.z);
  }

  // Auto arcane strike when in range (no HUD copy; intents still handle manual LMB feedback).
  if (h.attackCooldownTicksRemaining === 0) {
    tryPlayerHeroStrike(s);
  }
}

export function respawnDeadHeroAtKeep(s: GameState): void {
  if (s.phase !== "playing") return;
  const h = s.hero;
  if (h.hp > 0) return;
  const keep = findKeep(s);
  if (!keep) return;
  h.hp = h.maxHp;
  const pos = heroStandPositionNearKeepAnchor({ x: keep.x, z: keep.z }, s.map, "player");
  h.x = pos.x;
  h.z = pos.z;
  h.targetX = null;
  h.targetZ = null;
  h.moveWaypoints.length = 0;
  h.wasdStrafe = 0;
  h.wasdForward = 0;
  h.claimChannelTarget = null;
  h.claimChannelTicksRemaining = 0;
  h.attackCooldownTicksRemaining = 0;
  pushFx(s, { kind: "muster", x: h.x, z: h.z });
  s.lastMessage = "Wizard reformed at the Keep.";
}
