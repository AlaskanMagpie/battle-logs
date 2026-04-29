import { describe, expect, it } from "vitest";
import { createInitialState } from "./state";
import { scoreMatchResult } from "./leaderboard";
import { MATCH_DURATION_TICKS, TICK_HZ } from "./constants";
import type { MapData } from "./types";
import { formatMatchDurationFromTicks, simSecondsFromMatchTick } from "./matchDisplay";

const scoreTinyMap: MapData = {
  version: 2,
  world: { halfExtents: 120, groundY: 0 },
  tapSlots: [],
  playerRelaySlots: [{ id: "p0", x: -40, z: 0 }],
  enemyRelaySlots: [{ id: "e0", x: 40, z: 0 }],
  playerStart: { x: -40, z: 0 },
  enemyStart: { x: 40, z: 0 },
  enemyCamps: [
    {
      id: "c1",
      origin: { x: 20, z: 0 },
      aggroRadius: 20,
      wakeRadius: 40,
      roster: [{ sizeClass: "Line", offset: { x: 2, z: 0 } }],
    },
  ],
};

describe("matchDisplay", () => {
  it("converts tick to sim seconds with TICK_HZ", () => {
    expect(simSecondsFromMatchTick(0)).toBe(0);
    expect(simSecondsFromMatchTick(TICK_HZ)).toBe(1);
    expect(simSecondsFromMatchTick(3600)).toBe(180);
  });

  it("formats duration as m:ss (full time-limit match = 3:00)", () => {
    expect(formatMatchDurationFromTicks(3600)).toBe("3:00");
  });

  it("formats shorter matches with seconds", () => {
    expect(formatMatchDurationFromTicks(2000)).toBe("1:40");
  });
});

describe("scoreMatchResult time penalty", () => {
  it("applies one penalty point per sim minute, not tick/60", () => {
    const s = createInitialState(scoreTinyMap, []);
    s.phase = "win";
    s.tick = MATCH_DURATION_TICKS;
    s.stats.enemyKills = 0;
    s.taps = [];
    s.stats.structuresBuilt = 0;
    s.stats.unitsLost = 0;
    const expected = 2500 - 3;
    expect(scoreMatchResult(s)).toBe(expected);
  });
});
