import { ENEMY_WAVE_EVERY_TICKS, ENEMY_WAVE_GLOBAL_CAP } from "../../constants";
import { rand, randU32, type GameState } from "../../state";
import { unitStatsForCatalog } from "./helpers";

/**
 * While at least one enemy camp is awake, periodically spawn a Swarm reinforcement
 * from a random awake camp (up to a global cap). Deterministic via seeded RNG.
 */
export function maybeEnemyReinforcements(s: GameState): void {
  const awakeCamps = s.map.enemyCamps.filter((c) => s.enemyCampAwake[c.id]);
  if (awakeCamps.length === 0) return;
  if (s.tick === 0 || s.tick % ENEMY_WAVE_EVERY_TICKS !== 0) return;

  const alive = s.units.reduce((n, u) => (u.team === "enemy" && u.hp > 0 ? n + 1 : n), 0);
  if (alive >= ENEMY_WAVE_GLOBAL_CAP) return;

  const camp = awakeCamps[Math.floor(rand(s) * awakeCamps.length)] ?? awakeCamps[0]!;
  const hpMult = s.map.difficulty?.enemyHpMult ?? 1;
  const dmgMult = s.map.difficulty?.enemyDmgMult ?? 1;
  const st = unitStatsForCatalog("Swarm");
  const hp = Math.max(1, Math.round(st.maxHp * hpMult));
  s.units.push({
    id: s.nextId.unit++,
    team: "enemy",
    structureId: null,
    x: camp.origin.x + (rand(s) - 0.5) * 4,
    z: camp.origin.z + (rand(s) - 0.5) * 4,
    hp,
    maxHp: hp,
    sizeClass: "Swarm",
    pop: st.pop,
    speedPerSec: st.speedPerSec,
    range: st.range,
    dmgPerTick: st.dmgPerTick * dmgMult,
    visualSeed: randU32(s),
  });
  s.stats.enemyUnitsSpawned += 1;
}
