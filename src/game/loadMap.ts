import type { MapData } from "./types";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge plain objects; arrays and primitives from `over` replace `base`. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (over === null || typeof over !== "object" || Array.isArray(over)) return over;
  if (!isPlainObject(base)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const bv = base[k];
    if (Array.isArray(v)) out[k] = v;
    else if (isPlainObject(v) && isPlainObject(bv)) out[k] = deepMerge(bv, v);
    else out[k] = v;
  }
  return out;
}

/** Pre-match map picker entries (site-root URLs). */
export const MAP_REGISTRY: readonly { id: string; label: string; url: string }[] = [
  { id: "the_line", label: "The Line", url: "/map.json" },
  { id: "forgewarden", label: "Forgewarden Crucible", url: "/maps/forgewarden.json" },
  { id: "glacierline", label: "Glacierline Expanse", url: "/maps/glacierline.json" },
  { id: "mesa_badlands", label: "Mesa Badlands", url: "/maps/mesa_badlands.json" },
] as const;

export const DEFAULT_MAP_URL = "/map.json";

/**
 * Load a battle map JSON, then deep-merge `map.local.json` on top (optional dev override).
 * @param baseMapUrl Site path (e.g. `/maps/forgewarden.json` or `/map.json`).
 */
export async function loadMapMerged(baseMapUrl: string = DEFAULT_MAP_URL): Promise<MapData> {
  const url = baseMapUrl.trim() || DEFAULT_MAP_URL;
  const baseRes = await fetch(url);
  if (!baseRes.ok) throw new Error(`${url}: ${baseRes.status}`);
  const base = (await baseRes.json()) as unknown;

  let merged: unknown = base;
  try {
    const localRes = await fetch("/map.local.json");
    if (localRes.ok) {
      const local = (await localRes.json()) as unknown;
      merged = deepMerge(base, local);
    }
  } catch {
    // dev server may 404; ignore
  }

  return merged as MapData;
}
