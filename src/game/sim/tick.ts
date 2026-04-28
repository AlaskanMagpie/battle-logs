import type { PlayerIntent } from "../intents";
import { tickHeroTeleportCooldown, type GameState } from "../state";
import { movement, wakeCamps } from "./systems/ai";
import { auras } from "./systems/auras";
import { combat } from "./systems/combat";
import { cleanupDead } from "./systems/deaths";
import { economy, salvageTrickle, tickDoctrineCooldowns } from "./systems/economy";
import { enemyHeroSystem } from "./systems/enemyHero";
import { heroSystem } from "./systems/hero";
import { applyPlayerIntents } from "./systems/intents";
import { portals } from "./systems/portals";
import { buildProgress, production } from "./systems/production";
import { maybeEnemyReinforcements } from "./systems/waves";
import { loseCheck, winCheck } from "./systems/winlose";
import { respawnDeadHeroAtKeep } from "./systems/hero";

export { applyPlayerIntents } from "./systems/intents";

/** Single fixed-step tick. Call at TICK_HZ with accumulated player intents. */
export function advanceTick(s: GameState, intents: PlayerIntent[]): void {
  if (s.phase === "win" || s.phase === "lose") return;
  if (s.tacticsFieldZones.length > 0) {
    s.tacticsFieldZones = s.tacticsFieldZones.filter((z) => z.untilTick > s.tick);
  }
  tickDoctrineCooldowns(s);
  tickHeroTeleportCooldown(s);
  applyPlayerIntents(s, intents);
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
}
