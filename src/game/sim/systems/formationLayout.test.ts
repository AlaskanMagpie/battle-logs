import { describe, expect, it } from "vitest";
import { computeFormationSlots, nextFormationKind } from "./formationLayout";
import type { UnitFormationKind, UnitSizeClass } from "../../types";

function u(id: number, sizeClass: UnitSizeClass, range = 12, x = -20, z = 0) {
  return { id, sizeClass, range, x, z };
}

function minPairDistance(slots: { x: number; z: number }[]): number {
  let best = Infinity;
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i]!;
      const b = slots[j]!;
      best = Math.min(best, Math.hypot(a.x - b.x, a.z - b.z));
    }
  }
  return best;
}

describe("formation layout", () => {
  it.each(["line", "wedge", "arc"] as UnitFormationKind[])("creates stable non-overlapping %s slots", (kind) => {
    const slots = computeFormationSlots(
      [u(4, "Swarm"), u(2, "Line", 16), u(8, "Heavy", 10), u(6, "Swarm", 14), u(7, "Titan", 20)],
      { from: { x: 0, z: -10 }, to: { x: 0, z: 10 }, kind },
      80,
    );

    expect(slots.map((s) => s.id)).toEqual([8, 4, 6, 2, 7]);
    expect(minPairDistance(slots)).toBeGreaterThan(1.8);
    for (const slot of slots) {
      expect(Math.abs(slot.x)).toBeLessThanOrEqual(78);
      expect(Math.abs(slot.z)).toBeLessThanOrEqual(78);
    }
  });

  it("cycles formation presets in the player-facing order", () => {
    expect(nextFormationKind("line")).toBe("wedge");
    expect(nextFormationKind("wedge")).toBe("arc");
    expect(nextFormationKind("arc")).toBe("line");
  });
});
