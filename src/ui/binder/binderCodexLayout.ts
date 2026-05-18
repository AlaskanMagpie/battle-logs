import { getCatalogEntry } from "../../game/catalog";
import { BINDER_CELLS_PER_SHEET, BINDER_CODEX_TOTAL_CELLS } from "./CardBinderEngine";
import { BINDER_GRID_CATALOG_IDS } from "../../game/binderCodexIds";
import { type CodexSortMode, sortBinderCodexCellOrder } from "./binderCodexSort";
import { isCommandEntry, isStructureEntry } from "../../game/types";

/** Sentinel catalog id for padded codex cells (no card art). Not in `validBinderCodexIds`. */
export const CODEX_EMPTY_SLOT = "__binder_codex_empty__";

function dedupePreserveOrder(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Pad to full duplex sheets (18 cells) with {@link CODEX_EMPTY_SLOT}. */
export function padCodexIdsToSheets(ids: readonly string[]): string[] {
  const out = [...ids];
  const need = (BINDER_CELLS_PER_SHEET - (out.length % BINDER_CELLS_PER_SHEET)) % BINDER_CELLS_PER_SHEET;
  for (let i = 0; i < need; i++) out.push(CODEX_EMPTY_SLOT);
  return out;
}

function sortSection(ids: readonly string[], mode: CodexSortMode, asc: boolean): string[] {
  if (ids.length === 0) return [];
  return sortBinderCodexCellOrder(ids, mode, asc).sortedIds;
}

/**
 * Sorted codex only: one copy per card in the main block (binder grid order deduped),
 * packed into full sheets; then structure-only and command-only appendix sections
 * (each sorted the same way, sheet-padded). Finally pad to at least browse minimum length.
 */
export function buildSortedCodexPanelIds(mode: CodexSortMode, asc: boolean): string[] {
  const gridUnique = dedupePreserveOrder(BINDER_GRID_CATALOG_IDS);
  const mainSorted = sortSection(gridUnique, mode, asc);
  const mainPacked = padCodexIdsToSheets(mainSorted);

  const structurePool = BINDER_GRID_CATALOG_IDS.filter((id) => {
    const e = getCatalogEntry(id);
    return e && isStructureEntry(e);
  });
  const structureSorted = sortSection(dedupePreserveOrder(structurePool), mode, asc);
  const structurePacked = padCodexIdsToSheets(structureSorted);

  const commandPool = BINDER_GRID_CATALOG_IDS.filter((id) => {
    const e = getCatalogEntry(id);
    return e && isCommandEntry(e);
  });
  const commandSorted = sortSection(dedupePreserveOrder(commandPool), mode, asc);
  const commandPacked = padCodexIdsToSheets(commandSorted);

  const merged = [...mainPacked, ...structurePacked, ...commandPacked];
  while (merged.length < BINDER_CODEX_TOTAL_CELLS) merged.push(CODEX_EMPTY_SLOT);
  return padCodexIdsToSheets(merged);
}
