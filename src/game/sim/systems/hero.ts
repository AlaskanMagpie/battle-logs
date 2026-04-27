import { HERO_CLAIM_RADIUS, HERO_MAP_OBSTACLE_RADIUS, HERO_WASD_SPEED, TAP_YIELD_MAX, TICK_HZ } from "../../constants";
import { logGame } from "../../gameLog";
import { resolveCircleAgainstMapObstacles } from "../../mapObstacles";
import { armTapClaimAnchor, findKeep, pushFx, tacticsFieldSpeedMult, type GameState } from "../../state";
import { dist2 } from "./helpers";
import { claimChannelSecForTap, claimFluxFeeForTap } from "./homeDistance";
import { tryPlayerHeroStrike } from "./heroStrike";

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
  resolveCircleAgainstMapObstacles(s.map, h, HERO_MAP_OBSTACLE_RADIUS);
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
  resolveCircleAgainstMapObstacles(s.map, h, HERO_MAP_OBSTACLE_RADIUS);
  h.targetX = null;
  h.targetZ = null;
  h.moveWaypoints.length = 0;
  return true;
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

  const moving = wasdMoving || h.targetX !== null || h.targetZ !== null;

  // If moving, cancel any in-progress claim.
  if (moving && h.claimChannelTarget !== null) {
    h.claimChannelTarget = null;
    h.claimChannelTicksRemaining = 0;
    s.lastMessage = "Claim cancelled.";
  }

  // Drop a claim if we drifted out of range.
  if (h.claimChannelTarget !== null) {
    const tap = s.taps[h.claimChannelTarget];
    if (!tap || tap.active || dist2(h, tap) > HERO_CLAIM_RADIUS * HERO_CLAIM_RADIUS) {
      h.claimChannelTarget = null;
      h.claimChannelTicksRemaining = 0;
      s.lastMessage = "Claim cancelled.";
    }
  }

  // Auto-start a channel when idle inside range of a neutral tap (and can afford the fee).
  if (!moving && h.claimChannelTarget === null) {
    const idx = findNeutralTapIndexNearHero(s);
    if (idx !== null) {
      const tap = s.taps[idx]!;
      const fee = claimFluxFeeForTap(s, "player", tap);
      const chSec = claimChannelSecForTap(s, "player", tap);
      if (s.flux < fee) {
        // Only surface the message once per tap-adjacency to avoid tick spam.
        if (s.lastMessage.indexOf("to claim") === -1) {
          s.lastMessage = `Need ${fee} Mana to claim this node.`;
        }
      } else {
        h.claimChannelTarget = idx;
        h.claimChannelTicksRemaining = Math.round(chSec * TICK_HZ);
        s.lastMessage = `Claiming node… stand still for ${chSec.toFixed(1)}s (−${fee} Mana).`;
      }
    }
  }

  // Progress channel.
  if (h.claimChannelTarget !== null) {
    h.claimChannelTicksRemaining -= 1;
    if (h.claimChannelTicksRemaining <= 0) {
      const idx = h.claimChannelTarget;
      const tap = s.taps[idx];
      if (tap && !tap.active) {
        const fee = claimFluxFeeForTap(s, "player", tap);
        if (s.flux < fee) {
          s.lastMessage = `Not enough Mana to claim (need ${fee}).`;
        } else {
          s.flux -= fee;
          tap.active = true;
          tap.ownerTeam = "player";
          armTapClaimAnchor(tap);
          tap.yieldRemaining = Math.max(tap.yieldRemaining, TAP_YIELD_MAX);
          pushFx(s, { kind: "claim", x: tap.x, z: tap.z });
          s.lastMessage = `Node claimed (+1 Mana/sec). Territory expanded.`;
          logGame("claim", `Mana node ${tap.defId} claimed`, s.tick);
        }
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
