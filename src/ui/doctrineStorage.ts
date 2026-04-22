import { DEFAULT_DOCTRINE_SLOTS } from "../game/catalog";
import { DOCTRINE_SLOT_COUNT } from "../game/constants";

export const DOCTRINE_STORAGE_KEY = "signalWars_doctrine_v1";

export function loadDoctrineSlots(): (string | null)[] {
  try {
    const raw = localStorage.getItem(DOCTRINE_STORAGE_KEY);
    if (!raw) return [...DEFAULT_DOCTRINE_SLOTS];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return [...DEFAULT_DOCTRINE_SLOTS];
    const row = parsed.slice(0, DOCTRINE_SLOT_COUNT) as unknown[];
    while (row.length < DOCTRINE_SLOT_COUNT) row.push(null);
    return row.map((x) => {
      if (typeof x !== "string") return null;
      if (x === "muster") return null;
      return x;
    }) as (string | null)[];
  } catch {
    return [...DEFAULT_DOCTRINE_SLOTS];
  }
}

export function saveDoctrineSlots(slots: (string | null)[]): void {
  localStorage.setItem(DOCTRINE_STORAGE_KEY, JSON.stringify(slots));
}
