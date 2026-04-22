import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog";
import { sortCatalogIds } from "./catalogSort";
import { isCommandEntry } from "./types";

const STRUCTURE_CATALOG_IDS = CATALOG.filter((c) => !isCommandEntry(c)).map((c) => c.id);

describe("Doctrine binder catalog", () => {
  it("includes enough structures to fill more than one 3×3 page", () => {
    expect(STRUCTURE_CATALOG_IDS.length).toBeGreaterThan(9);
  });

  it("sortCatalogIds preserves structure-only ids for every sort key", () => {
    const keys = ["catalog", "name", "cost", "kind", "class", "cooldown"] as const;
    for (const key of keys) {
      const sorted = sortCatalogIds(STRUCTURE_CATALOG_IDS, key);
      expect(sorted.length).toBe(STRUCTURE_CATALOG_IDS.length);
      for (const id of sorted) {
        const e = CATALOG.find((c) => c.id === id);
        expect(e).toBeTruthy();
        expect(isCommandEntry(e!)).toBe(false);
      }
    }
  });
});
