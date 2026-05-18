import { validBinderCodexIds } from "./binderCodexIds";
import { DOCTRINE_SLOT_COUNT } from "./constants";
import { normalizeDoctrineSlotsForMatch } from "./state";

/** Same binder codex allow-list as `DoctrineBinderPicker` (manifest-driven extras included). */
const DOCTRINE_BINDER_GRID_IDS = validBinderCodexIds;

/** Same minimum filled slots as prematch **Start match** / Quickmatch fallback. */
export const QUICK_MATCH_MIN_FILLED = 4;

/**
 * Default “jump in” doctrine for URL `?quickMatch=1` and prematch **Quickmatch** fallback —
 * the full-art structure cards in the binder codex + all command spells.
 * Trailing nulls are placeholders only; {@link fillDoctrineSlotsWithDuplicatePicks} completes the row.
 * Length must equal {@link DOCTRINE_SLOT_COUNT}.
 */
export const QUICK_MATCH_DOCTRINE_SLOTS: readonly (string | null)[] = [
  "outpost",
  "watchtower",
  "bastion_keep",
  "verdant_citadel",
  "emberroot_bastion",
  "wooden_aerie",
  "firestorm",
  "fortify",
  "recycle",
  "shatter",
];

if (QUICK_MATCH_DOCTRINE_SLOTS.length !== DOCTRINE_SLOT_COUNT) {
  throw new Error("QUICK_MATCH_DOCTRINE_SLOTS length must match DOCTRINE_SLOT_COUNT");
}
for (const id of QUICK_MATCH_DOCTRINE_SLOTS) {
  if (id != null && !DOCTRINE_BINDER_GRID_IDS.has(id)) {
    throw new Error(`QUICK_MATCH_DOCTRINE_SLOTS contains id not in quick-match allow-list: ${id}`);
  }
}

function padDoctrineSlots(row: (string | null)[]): (string | null)[] {
  const a = row.length > DOCTRINE_SLOT_COUNT ? row.slice(0, DOCTRINE_SLOT_COUNT) : [...row];
  while (a.length < DOCTRINE_SLOT_COUNT) a.push(null);
  return a;
}

function slotsFilteredToBinderGrid(slots: (string | null)[]): (string | null)[] {
  return padDoctrineSlots(slots.map((id) => (id && DOCTRINE_BINDER_GRID_IDS.has(id) ? id : null)));
}

/**
 * True when the player has enough non-empty binder-codex slots to start a match (same bar as prematch Start).
 */
export function isUserDoctrineHandViableForQuickMatch(slots: (string | null)[]): boolean {
  const norm = normalizeDoctrineSlotsForMatch(slotsFilteredToBinderGrid(slots));
  return norm.filter(Boolean).length >= QUICK_MATCH_MIN_FILLED;
}

function normalizedUserHandOrNull(slots: (string | null)[]): (string | null)[] | null {
  if (!isUserDoctrineHandViableForQuickMatch(slots)) return null;
  return normalizeDoctrineSlotsForMatch(slotsFilteredToBinderGrid(slots));
}

function shuffleInPlace<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = items[i]!;
    items[i] = items[j]!;
    items[j] = t;
  }
}

/**
 * Random row of **distinct** catalog ids for binder “Pick for me”: draw from shuffled `primary`, then
 * shuffled `secondary`, without replacement. Trailing nulls only if both pools are exhausted before `slotCount`.
 */
export function pickUniqueDoctrineSlotRow(
  primary: readonly string[],
  secondary: readonly string[],
  slotCount: number,
): (string | null)[] {
  const chosen = new Set<string>();
  const out: (string | null)[] = [];

  const pullFrom = (pool: readonly string[]): void => {
    const copy = [...pool];
    shuffleInPlace(copy);
    for (const id of copy) {
      if (out.length >= slotCount) return;
      if (!id || chosen.has(id)) continue;
      chosen.add(id);
      out.push(id);
    }
  };

  pullFrom(primary);
  if (out.length < slotCount) pullFrom(secondary);
  while (out.length < slotCount) out.push(null);
  return out.slice(0, slotCount);
}

/**
 * Fill empty doctrine slots by cycling through the player’s distinct picks (first-seen row order).
 * Duplicates are allowed so the match always runs with a full {@link DOCTRINE_SLOT_COUNT} row when the pool is non-empty.
 */
export function fillDoctrineSlotsWithDuplicatePicks(slots: (string | null)[]): (string | null)[] {
  const filtered = slotsFilteredToBinderGrid(slots);
  const pool: string[] = [];
  const seen = new Set<string>();
  for (const id of filtered) {
    if (id && !seen.has(id)) {
      seen.add(id);
      pool.push(id);
    }
  }
  if (pool.length === 0) return normalizeDoctrineSlotsForMatch(filtered);
  let fillIdx = 0;
  const filled = filtered.map((id) => {
    if (id) return id;
    const pick = pool[fillIdx % pool.length]!;
    fillIdx += 1;
    return pick;
  });
  return normalizeDoctrineSlotsForMatch(filled);
}

/**
 * `?quickMatch=1` entry: use saved doctrine when it passes the binder viability bar (same row as the player set —
 * no duplicate-fill into empty slots). Otherwise build from the preset row and fill to ten for a clean jump-in.
 */
export function doctrineSlotsForUrlQuickMatch(storedSlots: (string | null)[]): (string | null)[] {
  const user = normalizedUserHandOrNull(storedSlots);
  if (user) return user;
  const preset = normalizeDoctrineSlotsForMatch([...QUICK_MATCH_DOCTRINE_SLOTS]);
  return fillDoctrineSlotsWithDuplicatePicks(preset);
}
