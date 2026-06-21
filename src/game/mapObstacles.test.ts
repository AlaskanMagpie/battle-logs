import { describe, expect, it } from "vitest";
import type { MapData } from "./types";
import {
  circleOverlapsMapObstacles,
  planChainedPathAroundMapObstacles,
  resolveCircleAgainstMapObstacles,
  segmentHitsMapObstacles,
} from "./mapObstacles";

describe("mapObstacles", () => {
  const map: MapData = {
    version: 2,
    world: { halfExtents: 100, groundY: 0 },
    tapSlots: [],
    playerRelaySlots: [],
    enemyRelaySlots: [],
    playerStart: { x: 0, z: 0 },
    enemyCamps: [],
    decor: [
      {
        kind: "box",
        x: 10,
        z: 0,
        w: 20,
        h: 10,
        d: 10,
        rotYDeg: 0,
        blocksMovement: true,
      },
    ],
  };

  it("pushes a circle out of a blocking box", () => {
    const p = { x: 10, z: 0 };
    resolveCircleAgainstMapObstacles(map, p, 1);
    expect(Math.abs(p.x)).toBeGreaterThan(9);
    expect(circleOverlapsMapObstacles(map, p, 1)).toBe(false);
  });

  it("detects overlap inside a disc obstacle", () => {
    const m2: MapData = {
      ...map,
      decor: [{ kind: "cylinder", x: 0, z: 0, radius: 5, h: 8, blocksMovement: true }],
    };
    expect(circleOverlapsMapObstacles(m2, { x: 0, z: 0 }, 1)).toBe(true);
    expect(circleOverlapsMapObstacles(m2, { x: 20, z: 0 }, 1)).toBe(false);
  });

  it("chained path yields obstacle-free legs around a blocking box", () => {
    const from = { x: -30, z: 0 };
    const to = { x: 30, z: 0 };
    const agentR = 1.2;
    const path = planChainedPathAroundMapObstacles(map, from, to, agentR);
    expect(path.length).toBeGreaterThanOrEqual(1);
    let cur = { ...from };
    for (const wp of path) {
      expect(segmentHitsMapObstacles(map, cur, wp, agentR)).toBe(false);
      cur = wp;
    }
  });

  it("treats a blocking building as an oriented-box obstacle", () => {
    const m3: MapData = {
      ...map,
      decor: [{ kind: "building", x: 0, z: 0, w: 24, d: 12, storeys: 6, style: "brutalist", blocksMovement: true }],
    };
    // Inside the building footprint → overlaps.
    expect(circleOverlapsMapObstacles(m3, { x: 4, z: 2 }, 1)).toBe(true);
    // Clear of it → no overlap.
    expect(circleOverlapsMapObstacles(m3, { x: 40, z: 0 }, 1)).toBe(false);
    // A unit caught inside is pushed back out of the footprint.
    const p = { x: 4, z: 2 };
    resolveCircleAgainstMapObstacles(m3, p, 1);
    expect(circleOverlapsMapObstacles(m3, p, 1)).toBe(false);
  });

  it("a non-blocking building does not obstruct movement", () => {
    const m4: MapData = {
      ...map,
      decor: [{ kind: "building", x: 0, z: 0, w: 24, d: 12 }],
    };
    expect(circleOverlapsMapObstacles(m4, { x: 0, z: 0 }, 1)).toBe(false);
  });

  it("accepts dynamic footprints for live structure blockers", () => {
    const emptyMap = { ...map, decor: [] };
    const extra = [{ kind: "disc" as const, cx: 0, cz: 0, r: 5 }];
    expect(circleOverlapsMapObstacles(emptyMap, { x: 0, z: 0 }, 1, extra)).toBe(true);
    const path = planChainedPathAroundMapObstacles(emptyMap, { x: -20, z: 0 }, { x: 20, z: 0 }, 1, extra);
    let cur = { x: -20, z: 0 };
    for (const wp of path) {
      expect(segmentHitsMapObstacles(emptyMap, cur, wp, 1, extra)).toBe(false);
      cur = wp;
    }
  });
});
