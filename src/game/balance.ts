import type { UnitSizeClass } from "./types";

export const UNIT_CLASS_ORDER = ["Swarm", "Line", "Heavy", "Titan"] as const satisfies readonly UnitSizeClass[];

export const UNIT_CLASS_RANK: Record<UnitSizeClass, number> = {
  Swarm: 0,
  Line: 1,
  Heavy: 2,
  Titan: 3,
};

export interface UnitClassBalancePoint {
  rank: number;
  cost: number;
  structureHp: number;
  productionSeconds: number;
  cooldownSeconds: number;
}

/**
 * Smooth superlinear balance guide for current and future classes.
 * It is intentionally between linear and exponential: each higher rank gets
 * more expensive and sturdier, but the gap does not explode when extrapolated.
 */
export function unitClassBalancePoint(rank: number): UnitClassBalancePoint {
  const r = rank < 0 ? rank * 0.28 : rank;
  const power = (base: number, perRank: number, exponent: number) =>
    Math.round(base * Math.pow(Math.max(0.6, 1 + r * perRank), exponent));

  return {
    rank,
    cost: power(72, 0.42, 1.34),
    structureHp: power(190, 0.38, 1.26),
    productionSeconds: Math.round(22 + r * 11 + Math.max(0, r - 1) * 4),
    cooldownSeconds: Math.round(10 + r * 5 + Math.max(0, r - 1) * 2),
  };
}

export function unitClassRank(size: UnitSizeClass): number {
  return UNIT_CLASS_RANK[size];
}

export function unitClassBalancePointForClass(size: UnitSizeClass): UnitClassBalancePoint {
  return unitClassBalancePoint(unitClassRank(size));
}
