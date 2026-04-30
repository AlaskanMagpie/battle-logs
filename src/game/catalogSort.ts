import { CATALOG, getCatalogEntry } from "./catalog";
import { unitClassRank } from "./balance";
import { isCommandEntry } from "./types";

export type CatalogSortKey = "catalog" | "name" | "cost" | "kind" | "class" | "cooldown";

const CATALOG_IDS_DEFAULT = CATALOG.map((c) => c.id);

export function sortCatalogIds(ids: readonly string[], key: CatalogSortKey): string[] {
  const copy = [...ids];
  const byName = (a: string, b: string): number => {
    const ea = getCatalogEntry(a);
    const eb = getCatalogEntry(b);
    return (ea?.name ?? a).localeCompare(eb?.name ?? b) || a.localeCompare(b);
  };
  switch (key) {
    case "name":
      return copy.sort(byName);
    case "cost":
      return copy.sort((a, b) => {
        const ca = getCatalogEntry(a)?.fluxCost ?? 0;
        const cb = getCatalogEntry(b)?.fluxCost ?? 0;
        return ca - cb || byName(a, b);
      });
    case "cooldown":
      return copy.sort((a, b) => {
        const ca = getCatalogEntry(a)?.chargeCooldownSeconds ?? 0;
        const cb = getCatalogEntry(b)?.chargeCooldownSeconds ?? 0;
        return ca - cb || byName(a, b);
      });
    case "kind":
      return copy.sort((a, b) => {
        const ea = getCatalogEntry(a);
        const eb = getCatalogEntry(b);
        const ka = ea && isCommandEntry(ea) ? 1 : 0;
        const kb = eb && isCommandEntry(eb) ? 1 : 0;
        return ka - kb || byName(a, b);
      });
    case "class": {
      const rank = (id: string): number => {
        const e = getCatalogEntry(id);
        if (!e) return 100;
        if (isCommandEntry(e)) return 99;
        return unitClassRank(e.producedSizeClass);
      };
      return copy.sort((a, b) => rank(a) - rank(b) || byName(a, b));
    }
    case "catalog":
    default:
      return copy.sort((a, b) => CATALOG_IDS_DEFAULT.indexOf(a) - CATALOG_IDS_DEFAULT.indexOf(b));
  }
}
