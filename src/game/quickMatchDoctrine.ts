import { CATALOG } from "./catalog";
import { DOCTRINE_SLOT_COUNT } from "./constants";
import { normalizeDoctrineSlotsForMatch } from "./state";

/**
 * Same binder codex allow-list as `DoctrineBinderPicker` — structures shown in the codex + commands.
 */
const FULL_ART_STRUCTURE_CARD_IDS = ["outpost", "watchtower", "bastion_keep", "verdant_citadel"] as const;
const COMMAND_CARD_IDS = CATALOG.filter((c) => c.kind === "command").map((c) => c.id);
/** Quick match / binder codex: four Unity structure cards + command spells only (no legacy catalog towers). */
const DOCTRINE_BINDER_GRID_IDS = new Set<string>([...FULL_ART_STRUCTURE_CARD_IDS, ...COMMAND_CARD_IDS]);

/** Same minimum filled slots as prematch **Start match** / Quickmatch fallback. */
export const QUICK_MATCH_MIN_FILLED = 4;

/**
 * Default “jump in” doctrine for URL `?quickMatch=1` and prematch **Quickmatch** fallback —
 * the four full-art structure cards (one per unit class) + all command spells.
 * Trailing nulls are placeholders only; {@link fillDoctrineSlotsWithDuplicatePicks} completes the row.
 * Length must equal {@link DOCTRINE_SLOT_COUNT}.
 */
export const QUICK_MATCH_DOCTRINE_SLOTS: readonly (string | null)[] = [
  "outpost",
  "watchtower",
  "bastion_keep",
  "verdant_citadel",
  "firestorm",
  "fortify",
  "recycle",
  "shatter",
  null,
  null,
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
 * `?quickMatch=1` entry: use saved doctrine when it passes the binder viability bar; otherwise the preset row.
 * Sparse hands are expanded with duplicate picks so all ten slots are filled when possible.
 */
export function doctrineSlotsForUrlQuickMatch(storedSlots: (string | null)[]): (string | null)[] {
  const user = normalizedUserHandOrNull(storedSlots);
  if (user) return fillDoctrineSlotsWithDuplicatePicks(user);
  const preset = normalizeDoctrineSlotsForMatch([...QUICK_MATCH_DOCTRINE_SLOTS]);
  return fillDoctrineSlotsWithDuplicatePicks(preset);
}
