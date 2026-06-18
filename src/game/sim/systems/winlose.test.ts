import { describe, expect, it } from "vitest";
import { MATCH_DURATION_TICKS } from "../../constants";
import { createInitialState } from "../../state";
import type { MapData } from "../../types";
import { timeLimitCheck, winCheck } from "./winlose";

const winloseMap: MapData = {
  version: 2,
  world: { halfExtents: 90, groundY: 0 },
  tapSlots: [{ id: "tap_a", x: 18, z: 12 }],
  playerRelaySlots: [{ id: "p0", x: -20, z: 0 }],
  enemyRelaySlots: [{ id: "e0", x: 40, z: 0 }],
  playerStart: { x: -20, z: 0 },
  enemyStart: { x: 20, z: 0 },
  enemyCamps: [],
  useAuthorTapSlots: true,
};

describe("winlose", () => {
  it("ends in draw when time limit damage is tied", () => {
    const s = createInitialState(winloseMap);
    s.phase = "playing";
    s.tick = MATCH_DURATION_TICKS;
    s.stats.damageDealtPlayer = 100;
    s.stats.damageDealtEnemy = 100;
    timeLimitCheck(s);
    expect(s.phase).toBe("draw");
    expect(s.matchEndDetail).toContain("equal total damage");
  });

  it("wins when all enemy relays are destroyed even if enemy units remain", () => {
    const s = createInitialState(winloseMap);
    s.units.push({
      id: 999,
      team: "enemy",
      structureId: null,
      x: 0,
      z: 0,
      hp: 10,
      maxHp: 10,
      sizeClass: "Swarm",
      pop: 1,
      speedPerSec: 5,
      range: 8,
      dmgPerTick: 0.1,
      visualSeed: 1,
      vxImpulse: 0,
      vzImpulse: 0,
    });
    for (const r of s.enemyRelays) r.hp = 0;
    winCheck(s);
    expect(s.phase).toBe("win");
    expect(s.matchEndDetail).toContain("Dark Fortress");
  });

  it("does not win when only the enemy hero dies", () => {
    const s = createInitialState(winloseMap);
    s.enemyHero.hp = 0;
    winCheck(s);
    expect(s.phase).toBe("playing");
  });
});
