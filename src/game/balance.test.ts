import { describe, expect, it } from "vitest";
import { unitClassBalancePoint, unitClassRank, UNIT_CLASS_ORDER } from "./balance";
import { STRUCTURES } from "./catalog";
import { KEEP_ID } from "./constants";

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

describe("unit class balance curve", () => {
  it("keeps the current class ladder upward without exponential gaps", () => {
    const points = UNIT_CLASS_ORDER.map((size) => unitClassBalancePoint(unitClassRank(size)));

    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]!;
      const cur = points[i]!;
      expect(cur.cost).toBeGreaterThan(prev.cost);
      expect(cur.structureHp).toBeGreaterThan(prev.structureHp);
      expect(cur.productionSeconds).toBeGreaterThan(prev.productionSeconds);
      expect(cur.cost / prev.cost).toBeLessThan(1.75);
      expect(cur.structureHp / prev.structureHp).toBeLessThan(1.7);
    }
  });

  it("leaves space for future units below Swarm and above Titan", () => {
    const belowSwarm = unitClassBalancePoint(-1);
    const swarm = unitClassBalancePoint(0);
    const titan = unitClassBalancePoint(3);
    const aboveTitan = unitClassBalancePoint(4);

    expect(belowSwarm.cost).toBeLessThan(swarm.cost);
    expect(aboveTitan.cost).toBeGreaterThan(titan.cost);
    expect(aboveTitan.cost / titan.cost).toBeLessThan(1.55);
  });
});

describe("structure catalog balance", () => {
  it("has mostly upward cost, HP, cooldown, and production medians by produced class", () => {
    const playable = STRUCTURES.filter((s) => s.id !== KEEP_ID);
    const medians = UNIT_CLASS_ORDER.map((size) => {
      const entries = playable.filter((s) => s.producedSizeClass === size);
      return {
        cost: median(entries.map((s) => s.fluxCost)),
        hp: median(entries.map((s) => s.maxHp)),
        cooldown: median(entries.map((s) => s.chargeCooldownSeconds)),
        production: median(entries.map((s) => s.productionSeconds)),
      };
    });

    for (let i = 1; i < medians.length; i++) {
      const prev = medians[i - 1]!;
      const cur = medians[i]!;
      expect(cur.cost).toBeGreaterThan(prev.cost);
      expect(cur.hp).toBeGreaterThan(prev.hp);
      expect(cur.cooldown).toBeGreaterThan(prev.cooldown);
      expect(cur.production).toBeGreaterThan(prev.production);
      expect(cur.cost / prev.cost).toBeLessThan(2.1);
    }
  });
});
