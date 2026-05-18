import { describe, expect, it } from "vitest";
import { clampPlaneArena, insidePlaneArena, planeArenaSemiAxes } from "./arenaFootprint";
import type { MapData } from "./types";

function rectMap(H: number): MapData {
  return {
    version: 2,
    world: { halfExtents: H, groundY: 0 },
    tapSlots: [],
    playerRelaySlots: [],
    enemyRelaySlots: [],
    playerStart: { x: 0, z: 0 },
    enemyCamps: [],
  };
}

function ellipseMap(H: number, sx: number, sz: number): MapData {
  return {
    ...rectMap(H),
    world: {
      halfExtents: H,
      groundY: 0,
      arenaFootprint: { kind: "ellipse", semiAxisXMult: sx, semiAxisZMult: sz },
    },
  };
}

describe("arenaFootprint", () => {
  it("rectangle matches legacy box", () => {
    const m = rectMap(100);
    expect(insidePlaneArena(m, { x: 99, z: 99 })).toBe(true);
    expect(insidePlaneArena(m, { x: 101, z: 0 })).toBe(false);
    const c = clampPlaneArena(m, { x: 200, z: 10 });
    expect(c.x).toBe(100);
    expect(c.z).toBe(10);
  });

  it("ellipse excludes corners of outer square", () => {
    const m = ellipseMap(100, 0.55, 0.95);
    const { ax, bz } = planeArenaSemiAxes(m);
    expect(ax).toBeLessThan(100);
    expect(insidePlaneArena(m, { x: 90, z: 90 })).toBe(false);
    expect(insidePlaneArena(m, { x: 0, z: 0 })).toBe(true);
    const edge = clampPlaneArena(m, { x: 500, z: 0 });
    expect(Math.abs(edge.x)).toBeLessThanOrEqual(ax + 0.01);
    expect(edge.z).toBeCloseTo(0, 5);
  });
});
