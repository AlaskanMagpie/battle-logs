import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STRUCTURES } from "./catalog";
import { KEEP_ID } from "./constants";
import { MAP_REGISTRY } from "./loadMap";
import { circleOverlapsMapObstacles } from "./mapObstacles";
import { spawnPlayerUnit } from "./sim/systems/production";
import { unitSeparationRadiusXZ } from "./sim/systems/helpers";
import { createInitialState, inPlayerTerritory, structureSiteBlockReason } from "./state";
import { structureObstacleFootprints, structureObstacleRadius, structureVisualRadius } from "./structureObstacles";
import type { MapData, Vec2 } from "./types";

const smallMap: MapData = {
  version: 2,
  world: { halfExtents: 160, groundY: 0 },
  tapSlots: [{ id: "tap", x: 40, z: 20 }],
  playerRelaySlots: [{ id: "keep", x: -65, z: 0 }],
  enemyRelaySlots: [{ id: "relay", x: 65, z: 0 }],
  playerStart: { x: -65, z: 0 },
  enemyStart: { x: 65, z: 0 },
  enemyCamps: [{ id: "camp", origin: { x: 70, z: 50 }, aggroRadius: 15, wakeRadius: 35 }],
  useAuthorTapSlots: true,
  decor: [{ kind: "box", x: 0, z: -50, w: 12, h: 8, d: 12, blocksMovement: true }],
};

describe("completed building footprints", () => {
  it("rejects terrain, map edges, objectives and occupied sites", () => {
    const s = createInitialState(smallMap, []);
    const def = STRUCTURES.find((entry) => entry.id === "watchtower")!;
    expect(structureSiteBlockReason(s, def, { x: 0, z: -50 })).toMatch(/terrain/);
    expect(structureSiteBlockReason(s, def, { x: 155, z: 0 })).toMatch(/edge/);
    expect(structureSiteBlockReason(s, def, { x: 40, z: 20 })).toMatch(/Mana/);
    expect(structureSiteBlockReason(s, def, { x: 65, z: 0 })).toMatch(/relay/);
    expect(structureSiteBlockReason(s, def, { x: 70, z: 50 })).toMatch(/camp/);
    expect(structureSiteBlockReason(s, def, { x: s.hero.x, z: s.hero.z })).toBeTruthy();
    expect(structureSiteBlockReason(s, def, { x: -65, z: 0 })).toMatch(/building/);
  });

  it("reserves the full future footprint during construction", () => {
    const s = createInitialState(smallMap, []);
    const keep = s.structures[0]!;
    keep.complete = false;
    keep.buildTicksRemaining = 100;
    expect(structureObstacleRadius(keep)).toBeCloseTo(structureVisualRadius(STRUCTURES.find((entry) => entry.id === KEEP_ID)!));
    const def = STRUCTURES.find((entry) => entry.id === "watchtower")!;
    const pos = { x: keep.x + structureObstacleRadius(keep) + structureVisualRadius(def) - 0.1, z: keep.z };
    expect(structureSiteBlockReason(s, def, pos)).toMatch(/building/);
  });

  it("releases produced units outside tower art and existing unit footprints", () => {
    const s = createInitialState(smallMap, []);
    const keep = s.structures[0]!;
    const tower = { ...keep, id: s.nextId.structure++, catalogId: "watchtower", x: 0, z: 35 };
    s.structures.push(tower);
    const before = s.units.length;
    const spawned = spawnPlayerUnit(s, tower);
    expect(spawned).toBeGreaterThan(0);
    expect(s.units.length - before).toBe(spawned);
    const newUnits = s.units.slice(before);
    for (const u of newUnits) {
      const radius = unitSeparationRadiusXZ(u.sizeClass, u.flying);
      expect(Math.hypot(u.x - tower.x, u.z - tower.z)).toBeGreaterThanOrEqual(structureObstacleRadius(tower) + radius);
      expect(circleOverlapsMapObstacles(s.map, u, radius, structureObstacleFootprints(s))).toBe(false);
      for (const other of newUnits) {
        if (other.id === u.id) continue;
        expect(Math.hypot(u.x - other.x, u.z - other.z)).toBeGreaterThanOrEqual(radius + unitSeparationRadiusXZ(other.sizeClass, other.flying) - 0.01);
      }
    }
  });

  for (const mapRef of MAP_REGISTRY) {
    it(`${mapRef.label} leaves legal territory sites for every structure size`, () => {
      const map = JSON.parse(readFileSync(`public${mapRef.url}`, "utf8")) as MapData;
      const s = createInitialState(map, []);
      const keep = s.structures.find((st) => st.catalogId === KEEP_ID)!;
      expect(circleOverlapsMapObstacles(map, keep, structureObstacleRadius(keep)), `${mapRef.id}: Keep overlaps terrain`).toBe(false);
      const sites: Vec2[] = [];
      for (const distance of [34, 43, 52, 61]) {
        for (let index = 0; index < 48; index++) {
          const angle = index * Math.PI * 2 / 48;
          sites.push({ x: keep.x + Math.cos(angle) * distance, z: keep.z + Math.sin(angle) * distance });
        }
      }
      for (const def of STRUCTURES) {
        expect(sites.some((site) => inPlayerTerritory(s, site) && !structureSiteBlockReason(s, def, site)), `${mapRef.id}: ${def.id}`).toBe(true);
      }
    });
  }
});
