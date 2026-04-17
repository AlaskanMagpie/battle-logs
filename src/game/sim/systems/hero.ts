import {
  HERO_CLAIM_CHANNEL_SEC,
  HERO_CLAIM_FLUX_FEE,
  HERO_CLAIM_RADIUS,
  TAP_YIELD_MAX,
  TICK_HZ,
} from "../../constants";
import type { GameState } from "../../state";
import { dist2 } from "./helpers";

function moveHeroToward(s: GameState): void {
  const h = s.hero;
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

function findClaimableTapIndex(s: GameState): number | null {
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

export function heroSystem(s: GameState): void {
  const h = s.hero;

  moveHeroToward(s);

  const moving = h.targetX !== null || h.targetZ !== null;

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
    const idx = findClaimableTapIndex(s);
    if (idx !== null) {
      if (s.flux < HERO_CLAIM_FLUX_FEE) {
        // Only surface the message once per tap-adjacency to avoid tick spam.
        if (s.lastMessage.indexOf("to claim") === -1) {
          s.lastMessage = `Need ${HERO_CLAIM_FLUX_FEE} Flux to claim this node.`;
        }
      } else {
        h.claimChannelTarget = idx;
        h.claimChannelTicksRemaining = Math.round(HERO_CLAIM_CHANNEL_SEC * TICK_HZ);
        s.lastMessage = `Claiming node… stand still for ${HERO_CLAIM_CHANNEL_SEC.toFixed(0)}s (−${HERO_CLAIM_FLUX_FEE} Flux).`;
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
        if (s.flux < HERO_CLAIM_FLUX_FEE) {
          s.lastMessage = `Not enough Flux to claim (need ${HERO_CLAIM_FLUX_FEE}).`;
        } else {
          s.flux -= HERO_CLAIM_FLUX_FEE;
          tap.active = true;
          tap.ownerTeam = "player";
          tap.yieldRemaining = Math.max(tap.yieldRemaining, TAP_YIELD_MAX);
          s.lastFx = { kind: "claim", x: tap.x, z: tap.z, tick: s.tick };
          s.lastMessage = `Node claimed (+1 Flux/sec). Territory expanded.`;
        }
      }
      h.claimChannelTarget = null;
      h.claimChannelTicksRemaining = 0;
    }
  }
}
