import { HERO_CLAIM_RADIUS, HERO_MAP_OBSTACLE_RADIUS, HERO_WASD_SPEED, TAP_YIELD_MAX, TICK_HZ } from "../../constants";
import { logGame } from "../../gameLog";
import { planChainedPathAroundMapObstacles, resolveCircleAgainstMapObstacles } from "../../mapObstacles";
import { armTapClaimAnchor, findKeep, pushFx, tacticsFieldSpeedMult, type GameState } from "../../state";
import { structureObstacleFootprints } from "../../structureObstacles";
import { dist2 } from "./helpers";
import { claimChannelSecForTap, claimFluxRewardForTap } from "./homeDistance";
import { tryPlayerHeroStrike } from "./heroStrike";

const HERO_CAPTAIN_IDLE_TICKS = Math.round(1.2 * TICK_HZ);

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

function applyHeroCaptainMode(s: GameState): void {
  const h = s.hero;
  if (!s.heroCaptainEnabled || h.hp <= 0) return;
  if (h.targetX !== null || h.targetZ !== null || h.moveWaypoints.length > 0 || h.claimChannelTarget !== null) return;
  if (s.tick - s.heroCaptainLastManualTick < HERO_CAPTAIN_IDLE_TICKS) return;
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
  h.x = keep.x;
  h.z = keep.z;
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
