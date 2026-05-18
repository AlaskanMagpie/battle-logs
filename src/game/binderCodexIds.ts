/** Bundler copy of `public/assets/cards/manifest.json` — Vite cannot import from `public/`. Kept in sync by `scripts/sync-card-manifest.mjs`. */
import bundledCardManifest from "./cardArtManifest.bundle.json";
import { CATALOG, getCatalogEntry } from "./catalog";
import { KEEP_ID } from "./constants";
import { isStructureEntry } from "./types";

/** Primary codex order for structures with authored full-card art (PNG/SVG). */
export const FULL_ART_STRUCTURE_CARD_IDS = [
  "outpost",
  "watchtower",
  "bastion_keep",
  "verdant_citadel",
  "steelbark_motorpool",
  "emberroot_bastion",
  "aionroot_observatory",
  "frostroot_keep",
  "wooden_aerie",
  "hollowmarket_stump",
  "townwatch_keep",
] as const;

const fullArtSet = new Set<string>(FULL_ART_STRUCTURE_CARD_IDS);

/** Structures that have a file in the card art manifest but are not in {@link FULL_ART_STRUCTURE_CARD_IDS}. */
const MANIFEST_ONLY_STRUCTURE_IDS: readonly string[] = Object.keys(bundledCardManifest.cards ?? {})
  .filter((id) => {
    if (id === KEEP_ID) return false;
    const e = getCatalogEntry(id);
    return e && isStructureEntry(e) && !fullArtSet.has(id);
  })
  .sort((a, b) => a.localeCompare(b));

const COMMAND_CARD_IDS = CATALOG.filter((c) => c.kind === "command").map((c) => c.id);

/** Codex panel: ordered full-art row + any extra manifest-only structures + commands. */
export const BINDER_GRID_CATALOG_IDS: readonly string[] = [
  ...FULL_ART_STRUCTURE_CARD_IDS,
  ...MANIFEST_ONLY_STRUCTURE_IDS,
  ...COMMAND_CARD_IDS,
];

export const validBinderCodexIds = new Set(BINDER_GRID_CATALOG_IDS);
