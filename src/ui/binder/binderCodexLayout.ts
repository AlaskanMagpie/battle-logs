import { BINDER_CELLS_PER_SHEET, BINDER_CODEX_TOTAL_CELLS } from "./CardBinderEngine";
import { BINDER_GRID_CATALOG_IDS } from "../../game/binderCodexIds";
import { type CodexSortMode, sortBinderCodexCellOrder } from "./binderCodexSort";

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
 * Sorted codex: one deduped pass over the binder catalog, ordered by the active sort keys,
 * then padded with {@link CODEX_EMPTY_SLOT} to {@link BINDER_CODEX_TOTAL_CELLS}. Each real
 * card appears at most once (no cycling repeats), so row-major order matches the sort.
 */
export function buildSortedCodexPanelIds(mode: CodexSortMode, asc: boolean): string[] {
  const cap = BINDER_CODEX_TOTAL_CELLS;
  const gridUnique = dedupePreserveOrder(BINDER_GRID_CATALOG_IDS);
  const mainSorted = sortSection(gridUnique, mode, asc);
  if (mainSorted.length === 0) {
    return Array.from({ length: cap }, () => CODEX_EMPTY_SLOT);
  }
  const clipped = mainSorted.length > cap ? mainSorted.slice(0, cap) : mainSorted;
  const out: string[] = [...clipped];
  while (out.length < cap) out.push(CODEX_EMPTY_SLOT);
  return out;
}
