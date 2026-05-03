import { DEFAULT_DOCTRINE_SLOTS } from "../game/catalog";
import { DOCTRINE_COMMANDS_ENABLED, DOCTRINE_SLOT_COUNT } from "../game/constants";
import { QUICK_MATCH_DOCTRINE_SLOTS } from "../game/quickMatchDoctrine";
import { normalizeDoctrineSlotsForMatch } from "../game/state";

export const DOCTRINE_STORAGE_KEY = "signalWars_doctrine_v2";

export type DoctrinePickerStored = {
  slots: (string | null)[];
  /** Codex panel index used when assigning slot `i` from the binder; null = legacy / unknown. */
  binderSlotPickIndex: (number | null)[];
  /** True only for the live return from a browser's first no-save load. Not persisted. */
  isFirstRun?: boolean;
};

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

function slotsForMatch(row: (string | null)[]): (string | null)[] {
  return normalizeDoctrineSlotsForMatch(padDoctrineSlots(row));
}

function firstRunStarterSlots(): (string | null)[] {
  return slotsForMatch([...QUICK_MATCH_DOCTRINE_SLOTS]);
}

function nullPicks(): (number | null)[] {
  return Array.from({ length: DOCTRINE_SLOT_COUNT }, () => null);
}

function padBinderSlotPickIndex(row: unknown[] | undefined): (number | null)[] {
  const out = nullPicks();
  if (!row) return out;
  for (let i = 0; i < DOCTRINE_SLOT_COUNT && i < row.length; i++) {
    const v = row[i];
    out[i] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return out;
}

function fromV1(): (string | null)[] | null {
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
}

/**
 * Full picker state (slots + which codex cell each slot came from).
 * Legacy saves: plain JSON array of catalog ids → `binderSlotPickIndex` is all null (highlights use greedy fallback).
 */
export function loadDoctrinePickerState(): DoctrinePickerStored {
  try {
    const raw = localStorage.getItem(DOCTRINE_STORAGE_KEY);
    if (!raw) {
      const migrated = fromV1();
      if (migrated) {
        const slots = slotsForMatch(migrated);
        saveDoctrinePickerState(slots, nullPicks());
        return { slots, binderSlotPickIndex: nullPicks() };
      }
      const slots = firstRunStarterSlots();
      saveDoctrinePickerState(slots, nullPicks());
      return { slots, binderSlotPickIndex: nullPicks(), isFirstRun: true };
    }
    const parsed = JSON.parse(raw) as unknown;

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray((parsed as DoctrinePickerStored).slots)) {
      const o = parsed as { slots: unknown[]; binderSlotPickIndex?: unknown[] };
      const slots = slotsForMatch(o.slots.map(normalizeLoadedRow) as (string | null)[]);
      if (slots.length !== DOCTRINE_SLOT_COUNT) {
        const migrated = fromV1();
        if (migrated) {
          const mslots = slotsForMatch(migrated);
          saveDoctrinePickerState(mslots, nullPicks());
          return { slots: mslots, binderSlotPickIndex: nullPicks() };
        }
        return { slots: slotsForMatch([...DEFAULT_DOCTRINE_SLOTS]), binderSlotPickIndex: nullPicks() };
      }
      return { slots, binderSlotPickIndex: padBinderSlotPickIndex(o.binderSlotPickIndex) };
    }

    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        const slots = firstRunStarterSlots();
        saveDoctrinePickerState(slots, nullPicks());
        return { slots, binderSlotPickIndex: nullPicks(), isFirstRun: true };
      }
      const mapped = parsed.map(normalizeLoadedRow) as (string | null)[];
      if (mapped.length !== DOCTRINE_SLOT_COUNT) {
        const migrated = fromV1();
        if (migrated) {
          const mslots = slotsForMatch(migrated);
          saveDoctrinePickerState(mslots, nullPicks());
          return { slots: mslots, binderSlotPickIndex: nullPicks() };
        }
        return { slots: slotsForMatch([...DEFAULT_DOCTRINE_SLOTS]), binderSlotPickIndex: nullPicks() };
      }
      return { slots: slotsForMatch(mapped), binderSlotPickIndex: nullPicks() };
    }
  } catch {
    /* fall through */
  }
  return { slots: slotsForMatch([...DEFAULT_DOCTRINE_SLOTS]), binderSlotPickIndex: nullPicks() };
}

export function saveDoctrinePickerState(
  slots: (string | null)[],
  binderSlotPickIndex?: (number | null)[] | null,
): void {
  const norm = slotsForMatch(slots);
  const stored: DoctrinePickerStored = {
    slots: norm,
    binderSlotPickIndex:
      DOCTRINE_COMMANDS_ENABLED && binderSlotPickIndex != null
        ? padBinderSlotPickIndex(binderSlotPickIndex as unknown[])
        : nullPicks(),
  };
  localStorage.setItem(DOCTRINE_STORAGE_KEY, JSON.stringify(stored));
}

/** Reads v2 storage, or migrates legacy v1 16-slot array to the first 10 entries. */
export function loadDoctrineSlots(): (string | null)[] {
  return loadDoctrinePickerState().slots;
}

/** Saves slot ids only; clears binder pick provenance (safe for callers that don't track picks). */
export function saveDoctrineSlots(slots: (string | null)[]): void {
  saveDoctrinePickerState(slots, nullPicks());
}
