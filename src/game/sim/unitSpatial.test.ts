import { describe, expect, it } from "vitest";
import type { GameState, UnitRuntime } from "../state";
import { buildCombatUnitBuckets, nearestFoeInBuckets } from "./unitSpatial";
import { unitStatsForCatalog } from "./systems/helpers";

function unit(id: number, team: "player" | "enemy", x: number, z: number): UnitRuntime {
  return {
    id,
    team,
    structureId: null,
    x,
    z,
    hp: 10,
    maxHp: 10,
    sizeClass: "Swarm",
    pop: 1,
    speedPerSec: 1,
    range: 1,
    dmgPerTick: 1,
    visualSeed: id,
    vxImpulse: 0,
    vzImpulse: 0,
  };
}

describe("combat spatial lookup", () => {
  it("finds foes across multiple cells for longer weapon ranges", () => {
    const attacker = unit(1, "player", 0, 0);
    const target = unit(2, "enemy", 17.5, 0);
    const state = { units: [attacker, target] } as GameState;
    const buckets = buildCombatUnitBuckets(state, 6);

    expect(nearestFoeInBuckets(attacker, "enemy", 18 * 18, buckets, 6)).toBe(target);
    expect(nearestFoeInBuckets(attacker, "enemy", 12 * 12, buckets, 6)).toBeNull();
  });
});

describe("unit combat ranges", () => {
  it("uses longer ranges with lower damage for farther-reaching classes", () => {
    const swarm = unitStatsForCatalog("Swarm");
    const line = unitStatsForCatalog("Line");
    const heavy = unitStatsForCatalog("Heavy");
    const titan = unitStatsForCatalog("Titan");

    expect(swarm.range).toBeGreaterThan(line.range);
    expect(swarm.dmgPerTick).toBeLessThan(line.dmgPerTick);
    expect(titan.range).toBeGreaterThan(heavy.range);
    expect(titan.dmgPerTick).toBeGreaterThan(heavy.dmgPerTick);
    expect(swarm.dmgPerTick).toBe(0.12);
    expect(line.dmgPerTick).toBe(0.22);
    expect(heavy.dmgPerTick).toBe(0.55);
    expect(titan.dmgPerTick).toBe(1.15);
  });
});
