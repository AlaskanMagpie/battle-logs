import { describe, expect, it } from "vitest";
import { remapBinderSlotPicks, sortBinderCodexCellOrder } from "./binderCodexSort";

describe("sortBinderCodexCellOrder", () => {
  it("orders by cost ascending with stable name ties", () => {
    const ids = ["b", "a"]; // not real catalog ids — fluxCost 0, tie name
    const { sortedIds, oldToNew } = sortBinderCodexCellOrder(ids, "cost", true);
    expect(sortedIds).toEqual(["a", "b"]);
    expect(oldToNew).toEqual([1, 0]);
  });

  it("keeps duplicate ids distinct via oldIndex in tie-break", () => {
    const ids = ["same", "same", "same"];
    const { sortedIds, oldToNew } = sortBinderCodexCellOrder(ids, "cost", true);
    expect(sortedIds).toEqual(["same", "same", "same"]);
    expect(oldToNew).toEqual([0, 1, 2]);
  });

  it("remaps pick indices through oldToNew", () => {
    const ids = ["x", "y", "z"];
    const { oldToNew } = sortBinderCodexCellOrder(ids, "cost", true);
    // identity sort on unknown ids — all cost 0, sorted by name
    const picks: (number | null)[] = [2, null, 0];
    const remapped = remapBinderSlotPicks(picks, oldToNew, 3);
    expect(remapped[0]).toBe(oldToNew[2]);
    expect(remapped[1]).toBeNull();
    expect(remapped[2]).toBe(oldToNew[0]);
  });

  it("maps each old cell to exactly one new index", () => {
    const ids = ["z", "y", "x"];
    const { oldToNew } = sortBinderCodexCellOrder(ids, "cost", true);
    const seen = new Set<number>();
    for (let o = 0; o < ids.length; o++) {
      expect(oldToNew[o]).toBeGreaterThanOrEqual(0);
      expect(oldToNew[o]).toBeLessThan(ids.length);
      seen.add(oldToNew[o]!);
    }
    expect(seen.size).toBe(ids.length);
  });
});
