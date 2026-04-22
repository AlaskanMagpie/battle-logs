import { DEFAULT_DOCTRINE_SLOTS } from "../game/catalog";
import { DOCTRINE_SLOT_COUNT } from "../game/constants";

export const DOCTRINE_STORAGE_KEY = "signalWars_doctrine_v2";

function normalizeLoadedRow(x: unknown): string | null {
  if (typeof x !== "string") return null;
  if (x === "muster") return null;
  return x;
}

function padDoctrineSlots(row: (string | null)[]): (string | null)[] {
  const a = row.length > DOCTRINE_SLOT_COUNT ? row.slice(0, DOCTRINE_SLOT_COUNT) : [...row];
  while (a.length < DOCTRINE_SLOT_COUNT) a.push(null);
  return a;
}

/** Reads v2 storage, or migrates legacy v1 16-slot array to the first 10 entries. */
export function loadDoctrineSlots(): (string | null)[] {
  const fromV1 = (): (string | null)[] | null => {
    try {
      const raw = localStorage.getItem("signalWars_doctrine_v1");
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return null;
      const mapped = parsed.map(normalizeLoadedRow) as (string | null)[];
      if (mapped.length === 16 || mapped.length === DOCTRINE_SLOT_COUNT) {
        localStorage.removeItem("signalWars_doctrine_v1");
        return padDoctrineSlots(mapped);
      }
      return null;
    } catch {
      return null;
    }
  };

  try {
    const raw = localStorage.getItem(DOCTRINE_STORAGE_KEY);
    if (!raw) {
      const migrated = fromV1();
      if (migrated) {
        saveDoctrineSlots(migrated);
        return migrated;
      }
      return [...DEFAULT_DOCTRINE_SLOTS];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return [...DEFAULT_DOCTRINE_SLOTS];
    const mapped = parsed.map(normalizeLoadedRow) as (string | null)[];
    if (mapped.length !== DOCTRINE_SLOT_COUNT) {
      const migrated = fromV1();
      if (migrated) {
        saveDoctrineSlots(migrated);
        return migrated;
      }
    }
    return padDoctrineSlots(mapped);
  } catch {
    return [...DEFAULT_DOCTRINE_SLOTS];
  }
}

export function saveDoctrineSlots(slots: (string | null)[]): void {
  localStorage.setItem(DOCTRINE_STORAGE_KEY, JSON.stringify(padDoctrineSlots(slots)));
}
