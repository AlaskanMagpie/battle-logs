import { getCatalogEntry } from "../../game/catalog";
import { DOCTRINE_SLOT_COUNT } from "../../game/constants";

/** Left-pack non-empty doctrine slots ascending by catalog `fluxCost` (stable tie-break: name, then index). */
export function sortPickerHandByFluxCost(
  slots: (string | null)[],
  binderPick: (number | null)[],
): { slots: (string | null)[]; binderPick: (number | null)[] } {
  type Row = { id: string; pick: number | null; cost: number; name: string; orig: number };
  const rows: Row[] = [];
  for (let i = 0; i < DOCTRINE_SLOT_COUNT; i++) {
    const id = slots[i];
    if (!id) continue;
    const e = getCatalogEntry(id);
    rows.push({
      id,
      pick: binderPick[i] ?? null,
      cost: e?.fluxCost ?? 0,
      name: e?.name ?? id,
      orig: i,
    });
  }
  rows.sort((a, b) => {
    if (a.cost !== b.cost) return a.cost - b.cost;
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.orig - b.orig;
  });
  const outSlots: (string | null)[] = Array.from({ length: DOCTRINE_SLOT_COUNT }, () => null);
  const outPick: (number | null)[] = Array.from({ length: DOCTRINE_SLOT_COUNT }, () => null);
  for (let j = 0; j < rows.length; j++) {
    outSlots[j] = rows[j]!.id;
    outPick[j] = rows[j]!.pick;
  }
  return { slots: outSlots, binderPick: outPick };
}
