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

  it("stops on impossible and scenery-occupied destinations", () => {
    const barrier = { ...map, decor: [{ kind: "box" as const, x: 0, z: 0, w: 8, d: 200, h: 8, blocksMovement: true }] };
    expect(planChainedPathAroundMapObstacles(barrier, { x: -30, z: 0 }, { x: 30, z: 0 }, 1)).toEqual([]);
    expect(planChainedPathAroundMapObstacles(map, { x: -30, z: 0 }, { x: 10, z: 0 }, 1)).toEqual([]);
  });

  it("approaches a solid attack target at a clear perimeter, without crossing it", () => {
    const empty = { ...map, decor: [] };
    const structure = [{ kind: "disc" as const, cx: 0, cz: 0, r: 6 }];
    const path = planChainedPathAroundMapObstacles(empty, { x: -30, z: 0 }, { x: 0, z: 0 }, 1, structure);
    expect(path.length).toBeGreaterThan(0);
    let cur = { x: -30, z: 0 };
    for (const wp of path) {
      expect(segmentHitsMapObstacles(empty, cur, wp, 1, structure)).toBe(false);
      cur = wp;
    }
    expect(Math.hypot(cur.x, cur.z)).toBeCloseTo(7.35, 1);
  });

  it("routes around a large round blocker and a second wall without unsafe legs", () => {
    const clutter = { ...map, decor: [
      { kind: "cylinder" as const, x: -5, z: 0, radius: 21, h: 6, blocksMovement: true },
      { kind: "box" as const, x: 28, z: 0, w: 10, d: 27, h: 6, blocksMovement: true },
    ] };
    const path = planChainedPathAroundMapObstacles(clutter, { x: -45, z: 0 }, { x: 50, z: 0 }, 1.5);
    expect(path.length).toBeGreaterThan(1);
    let cur = { x: -45, z: 0 };
    for (const wp of path) {
      expect(segmentHitsMapObstacles(clutter, cur, wp, 1.5)).toBe(false);
      cur = wp;
    }
    expect(cur).toEqual({ x: 50, z: 0 });
  });
});
