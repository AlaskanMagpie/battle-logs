import { PORTAL_TRIGGER_RADIUS } from "../../constants";
import type { GameState } from "../../state";
import type { Vec2 } from "../../types";

function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function triggerPortal(s: GameState, url: string): void {
  s.portal.pendingRedirectUrl = url;
  s.lastMessage = "Portal opening...";
}

export function portals(s: GameState): void {
  if (s.phase !== "playing") return;
  if (s.portal.pendingRedirectUrl) return;
  if (s.portal.cooldownTicksRemaining > 0) {
    s.portal.cooldownTicksRemaining -= 1;
    return;
  }

  const r2 = PORTAL_TRIGGER_RADIUS * PORTAL_TRIGGER_RADIUS;
  if (s.portal.returnPortal && s.portal.returnUrl && dist2(s.hero, s.portal.returnPortal) <= r2) {
    triggerPortal(s, s.portal.returnUrl);
    return;
  }
  if (s.portal.exitUrl && dist2(s.hero, s.portal.exitPortal) <= r2) {
    triggerPortal(s, s.portal.exitUrl);
  }
}
