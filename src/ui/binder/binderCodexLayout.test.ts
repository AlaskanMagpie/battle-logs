import { describe, expect, it } from "vitest";
import { getCatalogEntry } from "../../game/catalog";
import { BINDER_CELLS_PER_SHEET, BINDER_CODEX_TOTAL_CELLS } from "./CardBinderEngine";
import { BINDER_GRID_CATALOG_IDS } from "../../game/binderCodexIds";
import { buildSortedCodexPanelIds, CODEX_EMPTY_SLOT, padCodexIdsToSheets } from "./binderCodexLayout";

describe("binderCodexLayout", () => {
  it("padCodexIdsToSheets rounds up to multiples of 18", () => {
    expect(padCodexIdsToSheets(["a"]).length).toBe(18);
    expect(padCodexIdsToSheets(Array.from({ length: 18 }, (_, i) => `x${i}`)).length).toBe(18);
    expect(padCodexIdsToSheets(Array.from({ length: 19 }, (_, i) => `y${i}`)).length).toBe(36);
  });

  it("buildSortedCodexPanelIds is browse length and sheet-aligned", () => {
    const ids = buildSortedCodexPanelIds("cost", true);
    expect(ids.length % BINDER_CELLS_PER_SHEET).toBe(0);
    expect(ids.length).toBe(BINDER_CODEX_TOTAL_CELLS);
    const maxDistinct = new Set(BINDER_GRID_CATALOG_IDS).size;
    const uniqueReal = new Set(ids.filter((id) => id !== CODEX_EMPTY_SLOT));
    expect(uniqueReal.size).toBe(Math.min(maxDistinct, BINDER_CODEX_TOTAL_CELLS));
  });

  it("buildSortedCodexPanelIds uses one sorted pass then empty sleeves (no cycling duplicates)", () => {
    expect(BINDER_GRID_CATALOG_IDS.length).toBeGreaterThan(0);
    const nUnique = new Set(BINDER_GRID_CATALOG_IDS).size;
    const ids = buildSortedCodexPanelIds("cost", true);
    const nonEmpty = ids.filter((id) => id !== CODEX_EMPTY_SLOT);
    expect(nonEmpty.length).toBe(Math.min(nUnique, BINDER_CODEX_TOTAL_CELLS));
    expect(new Set(nonEmpty).size).toBe(nonEmpty.length);
    const costs = nonEmpty.map((id) => getCatalogEntry(id)?.fluxCost ?? 0);
    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
    expect(ids.slice(nonEmpty.length).every((id) => id === CODEX_EMPTY_SLOT)).toBe(true);
  });

  it("buildSortedCodexPanelIds cost descending matches primary sort", () => {
    const ids = buildSortedCodexPanelIds("cost", false);
    const nonEmpty = ids.filter((id) => id !== CODEX_EMPTY_SLOT);
    const costs = nonEmpty.map((id) => getCatalogEntry(id)?.fluxCost ?? 0);
    expect([...costs].sort((a, b) => b - a)).toEqual(costs);
  });
});
