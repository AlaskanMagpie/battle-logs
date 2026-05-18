import { getCatalogEntry } from "../../game/catalog";
import { DOCTRINE_SLOT_COUNT } from "../../game/constants";
import type { UnitSizeClass } from "../../game/types";
import { isStructureEntry } from "../../game/types";

export type CodexSortMode = "cost" | "class" | "type";

const SIZE_CLASS_RANK: Record<UnitSizeClass, number> = {
  Swarm: 0,
  Line: 1,
  Heavy: 2,
  Titan: 3,
};

/** Commands (and unknown rows) sort after all structure size classes. */
const COMMAND_CLASS_RANK = 4;

type SortRow = {
  id: string;
  oldIndex: number;
  name: string;
  primary: number;
};

function rowForId(id: string, oldIndex: number): SortRow {
  const e = getCatalogEntry(id);
  const name = e?.name ?? id;
  return { id, oldIndex, name, primary: 0 };
}

function primaryCost(id: string): number {
  return getCatalogEntry(id)?.fluxCost ?? 0;
}

function primaryClass(id: string): number {
  const e = getCatalogEntry(id);
  if (!e) return COMMAND_CLASS_RANK + 1;
  if (isStructureEntry(e)) {
    return SIZE_CLASS_RANK[e.producedSizeClass] ?? 99;
  }
  return COMMAND_CLASS_RANK;
}

/** Ascending: structure (0) before command (1). */
function primaryType(id: string): number {
  const e = getCatalogEntry(id);
  if (!e) return 0;
  return e.kind === "structure" ? 0 : 1;
}

function primaryForMode(id: string, mode: CodexSortMode): number {
  switch (mode) {
    case "cost":
      return primaryCost(id);
    case "class":
      return primaryClass(id);
    case "type":
      return primaryType(id);
    default:
      return 0;
  }
}

function cmpNumber(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Stable codex reorder: primary key respects `ascending`; tie-breakers always
 * name → id → original index (ascending) so duplicate catalog ids stay deterministic.
 */
export function sortBinderCodexCellOrder(
  ids: readonly string[],
  mode: CodexSortMode,
  ascending: boolean,
): { sortedIds: string[]; oldToNew: number[] } {
  const n = ids.length;
  const rows: SortRow[] = [];
  for (let oldIndex = 0; oldIndex < n; oldIndex++) {
    const id = ids[oldIndex]!;
    const r = rowForId(id, oldIndex);
    r.primary = primaryForMode(id, mode);
    rows.push(r);
  }
  rows.sort((a, b) => {
    const primaryCmp = ascending
      ? cmpNumber(a.primary, b.primary)
      : cmpNumber(b.primary, a.primary);
    if (primaryCmp !== 0) return primaryCmp;
    const nameCmp = a.name.localeCompare(b.name);
    if (nameCmp !== 0) return nameCmp;
    const idCmp = a.id.localeCompare(b.id);
    if (idCmp !== 0) return idCmp;
    return cmpNumber(a.oldIndex, b.oldIndex);
  });
  const sortedIds = rows.map((r) => r.id);
  const oldToNew = new Array<number>(n);
  for (let newIdx = 0; newIdx < n; newIdx++) {
    oldToNew[rows[newIdx]!.oldIndex] = newIdx;
  }
  return { sortedIds, oldToNew };
}

export function remapBinderSlotPicks(
  picks: readonly (number | null)[] | undefined,
  oldToNew: readonly number[],
  slotCount: number = DOCTRINE_SLOT_COUNT,
): (number | null)[] {
  const out: (number | null)[] = Array.from({ length: slotCount }, () => null);
  const srcLen = picks?.length ?? 0;
  for (let i = 0; i < slotCount; i++) {
    const p = i < srcLen ? picks![i] : null;
    if (p == null || !Number.isFinite(p)) {
      out[i] = null;
      continue;
    }
    const j = Math.floor(p);
    if (j < 0 || j >= oldToNew.length) {
      out[i] = null;
      continue;
    }
    out[i] = oldToNew[j]!;
  }
  return out;
}
