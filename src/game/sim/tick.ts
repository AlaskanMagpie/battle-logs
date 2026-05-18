import type { PlayerIntent } from "../intents";
import type { MatchSeat } from "../../net/protocol";
import { TICK_HZ } from "../constants";
import { pruneUnitSpellStatuses, recordMatchDamageTimelinePoint, tickHeroTeleportCooldown, type GameState } from "../state";
import { movement, wakeCamps } from "./systems/ai";
import { auras } from "./systems/auras";
import { combat } from "./systems/combat";
import { cleanupDead } from "./systems/deaths";
import { economy, salvageTrickle } from "./systems/economy";
import { enemyHeroSystem } from "./systems/enemyHero";
import { heroSystem } from "./systems/hero";
import { applyPlayerIntents, applySeatIntents } from "./systems/intents";
import { portals } from "./systems/portals";
import { buildProgress, production } from "./systems/production";
import { maybeEnemyReinforcements } from "./systems/waves";
import { loseCheck, timeLimitCheck, winCheck } from "./systems/winlose";
import { respawnDeadHeroAtKeep } from "./systems/hero";

export { applyPlayerIntents, applySeatIntents } from "./systems/intents";

export type PvpSeatIntentBundle = { seat: MatchSeat; intents: PlayerIntent[] };

function runTickSimulation(s: GameState, applyIntents: () => void): void {
  if (s.phase === "win" || s.phase === "lose" || s.phase === "draw") return;
  timeLimitCheck(s);
  if (s.phase !== "playing") return;
  if (s.tacticsFieldZones.length > 0) {
    s.tacticsFieldZones = s.tacticsFieldZones.filter((z) => z.untilTick > s.tick);
  }
  pruneUnitSpellStatuses(s);
  tickHeroTeleportCooldown(s);
  applyIntents();
  economy(s);
  salvageTrickle(s);
  buildProgress(s);
  production(s);
  auras(s);
  wakeCamps(s);
  maybeEnemyReinforcements(s);
  heroSystem(s);
  enemyHeroSystem(s);
  movement(s);
  portals(s);
  combat(s);
  cleanupDead(s);
  respawnDeadHeroAtKeep(s);
  loseCheck(s);
  winCheck(s);
  s.tick += 1;
  if (s.phase === "playing") {
    if (s.tick % TICK_HZ === 0) recordMatchDamageTimelinePoint(s);
  } else {
    recordMatchDamageTimelinePoint(s);
  }
}

/** Single fixed-step tick. Call at TICK_HZ with accumulated player intents. */
export function advanceTick(s: GameState, intents: PlayerIntent[]): void {
  runTickSimulation(s, () => {
    applyPlayerIntents(s, intents);
  });
}

/** PvP: apply both seats' intents in deterministic seat order (`player` then `enemy`) before sim. */
export function advanceTickPvp(s: GameState, bundles: PvpSeatIntentBundle[]): void {
  const ordered = [...bundles].sort((a, b) => (a.seat === "player" ? 0 : 1) - (b.seat === "player" ? 0 : 1));
  runTickSimulation(s, () => {
    for (const b of ordered) applySeatIntents(s, b.seat, b.intents);
  });
}
