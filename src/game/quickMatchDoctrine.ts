import { DOCTRINE_SLOT_COUNT } from "./constants";

/**
 * Default “jump in” doctrine for URL `?quickMatch=1` and prematch **Quickmatch** — towers + spells.
 * Length must equal {@link DOCTRINE_SLOT_COUNT}.
 */
export const QUICK_MATCH_DOCTRINE_SLOTS: readonly string[] = [
  "outpost",
  "watchtower",
  "root_bunker",
  "menders_hut",
  "salvage_yard",
  "war_camp",
  "firestorm",
  "fortify",
  "recycle",
  "shatter",
] as const;

if (QUICK_MATCH_DOCTRINE_SLOTS.length !== DOCTRINE_SLOT_COUNT) {
  throw new Error("QUICK_MATCH_DOCTRINE_SLOTS length must match DOCTRINE_SLOT_COUNT");
}
