import { describe, expect, it } from "vitest";
import {
  BINDER_CELLS_PER_PAGE,
  BINDER_CELLS_PER_SHEET,
  BINDER_CODEX_SPREAD_COUNT,
} from "../ui/binder/CardBinderEngine";
import { CATALOG } from "./catalog";
import { sortCatalogIds } from "./catalogSort";
import { isCommandEntry } from "./types";

const STRUCTURE_CATALOG_IDS = CATALOG.filter((c) => !isCommandEntry(c)).map((c) => c.id);

describe("Doctrine binder catalog", () => {
  it("pads the doctrine codex to ten sheets (18 catalog slots per sheet, 9 per face)", () => {
    expect(BINDER_CODEX_SPREAD_COUNT).toBe(10);
    expect(BINDER_CELLS_PER_PAGE).toBe(9);
    expect(BINDER_CELLS_PER_SHEET).toBe(18);
    expect(BINDER_CODEX_SPREAD_COUNT * BINDER_CELLS_PER_SHEET).toBe(180);
  });

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
