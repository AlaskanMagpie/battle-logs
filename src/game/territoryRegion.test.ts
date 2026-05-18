import { describe, expect, it } from "vitest";
import { TERRITORY_LINK_MAX_GAP, TERRITORY_RADIUS } from "./constants";
import {
  inConnectedTerritory,
  pointSegmentDistSqPlanar,
  territoryLinksForSources,
} from "./territoryRegion";
import type { MapData, Vec2 } from "./types";

const planarMap: MapData = {
  version: 2,
  world: { halfExtents: 400, groundY: 0 },
  tapSlots: [],
  playerRelaySlots: [],
  enemyRelaySlots: [],
  playerStart: { x: 0, z: 0 },
  enemyStart: { x: 0, z: 0 },
  enemyCamps: [],
  useAuthorTapSlots: true,
};

describe("territoryRegion", () => {
  it("bridges a gap between two sources when centers are in (2R, 2R+linkMax]", () => {
    const a: Vec2 = { x: 0, z: 0 };
    const b: Vec2 = { x: 160, z: 0 };
    const sources = [a, b];
    const mid: Vec2 = { x: 80, z: 0 };
    expect(2 * TERRITORY_RADIUS).toBeLessThan(160);
    expect(160).toBeLessThanOrEqual(2 * TERRITORY_RADIUS + TERRITORY_LINK_MAX_GAP);

    expect(inConnectedTerritory(planarMap, mid, sources)).toBe(true);
    expect(inConnectedTerritory(planarMap, { x: 80, z: 22 }, sources)).toBe(false);
    expect(inConnectedTerritory(planarMap, { x: 300, z: 0 }, sources)).toBe(false);
  });

  it("does not emit links when disks already overlap", () => {
    const sources: Vec2[] = [
      { x: 0, z: 0 },
      { x: 100, z: 0 },
    ];
    expect(territoryLinksForSources(planarMap, sources)).toHaveLength(0);
    expect(inConnectedTerritory(planarMap, { x: 50, z: 0 }, sources)).toBe(true);
  });

  it("pointSegmentDistSqPlanar matches clamped projection", () => {
    const p: Vec2 = { x: 1, z: 2 };
    const a: Vec2 = { x: 0, z: 0 };
    const b: Vec2 = { x: 10, z: 0 };
    expect(pointSegmentDistSqPlanar(p, a, b)).toBeCloseTo(4, 8);
  });
});
