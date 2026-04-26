import { describe, expect, it } from "vitest";
import { getCatalogEntry } from "./catalog";
import { production } from "./sim/systems/production";
import { availableProductionSlots } from "./sim/systems/production";
import { applyAttackImpulse } from "./sim/systems/combat";
import { unitStatsForCatalog } from "./sim/systems/helpers";
import {
  canPlaceEnemyStructureAt,
  canUseDoctrineSlot,
  createInitialState,
  inPlayerTerritory,
  placementFailureReason,
  territorySources,
  type StructureRuntime,
  type UnitRuntime,
} from "./state";
import { isStructureEntry } from "./types";
import type { MapData, UnitSizeClass } from "./types";

const tinyMap: MapData = {
  version: 2,
  world: { halfExtents: 160, groundY: 0 },
  tapSlots: [{ id: "tap_a", x: 18, z: 12 }],
  playerRelaySlots: [{ id: "p0", x: -44, z: 0 }],
  enemyRelaySlots: [{ id: "e0", x: 80, z: 0 }],
  playerStart: { x: -44, z: 0 },
  enemyStart: { x: 80, z: 0 },
  enemyCamps: [],
  useAuthorTapSlots: true,
};

function structure(catalogId: string, id: number, team: "player" | "enemy" = "player"): StructureRuntime {
  const e = getCatalogEntry(catalogId);
  if (!e || !isStructureEntry(e)) throw new Error(`bad structure ${catalogId}`);
  return {
    id,
    team,
    catalogId,
    x: team === "player" ? -42 : 78,
    z: 3,
    hp: e.maxHp,
    maxHp: e.maxHp,
    buildTicksRemaining: 0,
    buildTotalTicks: 0,
    complete: true,
    productionTicksRemaining: 1,
    doctrineSlotIndex: -1,
    rallyX: team === "player" ? -30 : 65,
    rallyZ: 3,
    placementForward: false,
    damageReductionUntilTick: 0,
    productionSilenceUntilTick: 0,
    holdOrders: false,
    localPopCapBonus: 0,
  };
}

function unit(id: number, team: "player" | "enemy", sizeClass: UnitSizeClass, structureId: number | null): UnitRuntime {
  const stats = unitStatsForCatalog(sizeClass);
  return {
    id,
    team,
    structureId,
    x: -42,
    z: 3,
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    sizeClass,
    pop: stats.pop,
    speedPerSec: stats.speedPerSec,
    range: stats.range,
    dmgPerTick: stats.dmgPerTick,
    visualSeed: id,
    vxImpulse: 0,
    vzImpulse: 0,
  };
}

describe("resource-first doctrine gates", () => {
  it("ignores old tier and signal metadata when Mana, cooldown, and territory pass", () => {
    const s = createInitialState(tinyMap, ["dragon_roost"]);
    s.flux = 1000;

    expect(canUseDoctrineSlot(s, 0)).toBeNull();
    expect(placementFailureReason(s, "dragon_roost", { x: -38, z: 0 }, 0)).toBeNull();
  });

  it("enemy placement is also resource-only", () => {
    const s = createInitialState(tinyMap, []);
    s.enemyFlux = 1000;

    expect(canPlaceEnemyStructureAt(s, "ironhold_citadel", { x: 78, z: 4 })).toBeNull();
  });
});

describe("batch production", () => {
  it.each([
    ["watchtower", "Swarm", 4],
    ["outpost", "Line", 3],
    ["siege_works", "Heavy", 2],
    ["dragon_roost", "Titan", 1],
  ] as const)("spawns literal %s batches", (catalogId, sizeClass, expected) => {
    const s = createInitialState(tinyMap, []);
    const st = structure(catalogId, 100);
    s.structures.push(st);
    const before = s.units.length;

    production(s);

    const spawned = s.units.slice(before).filter((u) => u.team === "player" && u.structureId === st.id);
    expect(spawned).toHaveLength(expected);
    expect(spawned.every((u) => u.sizeClass === sizeClass)).toBe(true);
  });

  it("respects local pop room and retries when capped", () => {
    const s = createInitialState(tinyMap, []);
    const st = structure("watchtower", 200);
    s.structures.push(st);
    for (let i = 0; i < 16; i++) s.units.push(unit(1000 + i, "player", "Swarm", st.id));

    expect(availableProductionSlots(s, st)).toBe(0);
    production(s);

    expect(s.units.filter((u) => u.structureId === st.id)).toHaveLength(16);
    expect(st.productionTicksRemaining).toBe(1);
  });

  it("uses partial local pop room instead of overfilling", () => {
    const s = createInitialState(tinyMap, []);
    const st = structure("watchtower", 201);
    s.structures.push(st);
    for (let i = 0; i < 14; i++) s.units.push(unit(2000 + i, "player", "Swarm", st.id));

    expect(availableProductionSlots(s, st)).toBe(2);
    production(s);

    expect(s.units.filter((u) => u.structureId === st.id)).toHaveLength(16);
    expect(st.productionTicksRemaining).toBeGreaterThan(1);
  });
});

describe("territory", () => {
  it("uses Keep plus owned Mana anchors, not the moving hero disk", () => {
    const s = createInitialState(tinyMap, []);
    s.hero.x = 70;
    s.hero.z = 0;

    expect(inPlayerTerritory(s, { x: 70, z: 0 })).toBe(false);
    s.taps[0]!.active = true;
    s.taps[0]!.ownerTeam = "player";
    s.taps[0]!.anchorHp = 200;
    expect(inPlayerTerritory(s, { x: 18, z: 12 })).toBe(true);
    expect(territorySources(s).map((p) => `${Math.round(p.x)},${Math.round(p.z)}`)).toEqual(["-44,0", "18,12"]);
  });
});

describe("attack impulses", () => {
  it("pushes live units, clamps accumulated impulse, and skips dead units", () => {
    const live = unit(1, "enemy", "Swarm", null);
    live.x = 4;
    live.z = 0;
    applyAttackImpulse(live, { x: 0, z: 0 }, 50);
    expect(Math.hypot(live.vxImpulse, live.vzImpulse)).toBeLessThanOrEqual(8.5);
    expect(live.vxImpulse).toBeGreaterThan(0);

    const dead = unit(2, "enemy", "Line", null);
    dead.hp = 0;
    applyAttackImpulse(dead, { x: 0, z: 0 }, 50);
    expect(dead.vxImpulse).toBe(0);
    expect(dead.vzImpulse).toBe(0);
  });
});
