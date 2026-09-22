import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAP_REGISTRY } from "./loadMap";
import { circleOverlapsMapObstacles, mapObstacleFootprints, planChainedPathAroundMapObstacles, segmentHitsMapObstacles } from "./mapObstacles";
import type { MapData, Vec2 } from "./types";

const AGENT_RADIUS = 2;

describe("published battle maps", () => {
  for (const entry of MAP_REGISTRY) {
    it(`${entry.label} has reachable objectives and clear spawn points`, () => {
      const map = JSON.parse(readFileSync(`public${entry.url}`, "utf8")) as MapData;
      const half = map.world.halfExtents;
      expect(map.mapId).toBe(entry.id);
      expect(half).toBeGreaterThan(0);
      const slots: Array<{ id: string; point: Vec2 }> = [
        { id: "playerStart", point: map.playerStart },
        ...(map.enemyStart ? [{ id: "enemyStart", point: map.enemyStart }] : []),
        ...map.tapSlots.map((point) => ({ id: point.id, point })),
        ...map.playerRelaySlots.map((point) => ({ id: point.id, point })),
        ...map.enemyRelaySlots.map((point) => ({ id: point.id, point })),
        ...map.enemyCamps.map((camp) => ({ id: camp.id, point: camp.origin })),
      ];
      expect(new Set(map.tapSlots.map((tap) => tap.id)).size).toBe(map.tapSlots.length);
      for (const { id, point } of slots) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.z), id).toBe(true);
        expect(Math.abs(point.x), id).toBeLessThanOrEqual(half - AGENT_RADIUS);
        expect(Math.abs(point.z), id).toBeLessThanOrEqual(half - AGENT_RADIUS);
        expect(circleOverlapsMapObstacles(map, point, AGENT_RADIUS), id).toBe(false);
      }
      for (const footprint of mapObstacleFootprints(map)) {
        const reachX = footprint.kind === "disc" ? footprint.r : Math.abs(footprint.hx * footprint.c) + Math.abs(footprint.hz * footprint.s);
        const reachZ = footprint.kind === "disc" ? footprint.r : Math.abs(footprint.hx * footprint.s) + Math.abs(footprint.hz * footprint.c);
        expect(Math.abs(footprint.cx) + reachX).toBeLessThanOrEqual(half + 3);
        expect(Math.abs(footprint.cz) + reachZ).toBeLessThanOrEqual(half + 3);
      }
      const objectives = [...map.tapSlots, ...map.playerRelaySlots, ...map.enemyRelaySlots,
        ...map.enemyCamps.map((camp) => ({ ...camp.origin, id: camp.id }))];
      for (const start of [map.playerStart, map.enemyStart ?? { x: -map.playerStart.x, z: -map.playerStart.z }]) {
        for (const objective of objectives) {
          const path = planChainedPathAroundMapObstacles(map, start, objective, AGENT_RADIUS);
          if (Math.hypot(objective.x - start.x, objective.z - start.z) > 0.35) {
            expect(path.length, `${entry.id}: ${objective.id} is unreachable`).toBeGreaterThan(0);
          }
          let from = start;
          for (const to of path) {
            expect(segmentHitsMapObstacles(map, from, to, AGENT_RADIUS), `${entry.id}: ${objective.id} has a blocked leg`).toBe(false);
            from = to;
          }
        }
      }
    });
  }
});
