import { describe, expect, it } from "vitest";
import type { MapData } from "./types";
import { circleOverlapsMapObstacles, resolveCircleAgainstMapObstacles } from "./mapObstacles";

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
});
