import { describe, expect, it } from "vitest";
import { BINDER_CELLS_PER_SHEET, BINDER_CODEX_TOTAL_CELLS } from "./CardBinderEngine";
import { BINDER_GRID_CATALOG_IDS } from "../../game/binderCodexIds";
import { buildSortedCodexPanelIds, CODEX_EMPTY_SLOT, padCodexIdsToSheets } from "./binderCodexLayout";

describe("binderCodexLayout", () => {
  it("padCodexIdsToSheets rounds up to multiples of 18", () => {
    expect(padCodexIdsToSheets(["a"]).length).toBe(18);
    expect(padCodexIdsToSheets(Array.from({ length: 18 }, (_, i) => `x${i}`)).length).toBe(18);
    expect(padCodexIdsToSheets(Array.from({ length: 19 }, (_, i) => `y${i}`)).length).toBe(36);
  });

  it("buildSortedCodexPanelIds is at least browse minimum and sheet-aligned", () => {
    const ids = buildSortedCodexPanelIds("cost", true);
    expect(ids.length % BINDER_CELLS_PER_SHEET).toBe(0);
    expect(ids.length).toBeGreaterThanOrEqual(BINDER_CODEX_TOTAL_CELLS);
    const maxDistinct = new Set(BINDER_GRID_CATALOG_IDS).size;
    const uniqueReal = new Set(ids.filter((id) => id !== CODEX_EMPTY_SLOT));
    expect(uniqueReal.size).toBeLessThanOrEqual(maxDistinct);
  });
});
