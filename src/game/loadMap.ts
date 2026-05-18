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
  { id: "sphere_planet", label: "Sphere Planet (demo)", url: "/maps/sphere_planet.json" },
] as const;

/** Looping match BGM per battle map (`public/assets/audio/`). Beta maps omit here until shipped. */
export const MATCH_MUSIC_BY_MAP_URL: Readonly<Record<string, string>> = {
  "/map.json": "/assets/audio/level_cluster_captain.mp3",
  "/maps/forgewarden.json": "/assets/audio/level_aphelion_burn.mp3",
  "/maps/glacierline.json": "/assets/audio/level_cluster_captain_b.mp3",
  "/maps/mesa_badlands.json": "/assets/audio/level_equipping_the_future.mp3",
};

export const DEFAULT_MAP_URL = "/map.json";

/** Sphere Planet stays in the picker but has no dedicated BGM while in beta. */
const SPHERE_PLANET_MAP_URL = "/maps/sphere_planet.json";

/** Resolved BGM URL, or `null` when this map intentionally has no match music yet. */
export function matchMusicUrlForMap(mapUrl: string): string | null {
  const key = mapUrl.trim() || DEFAULT_MAP_URL;
  if (key === SPHERE_PLANET_MAP_URL) return null;
  return MATCH_MUSIC_BY_MAP_URL[key] ?? MATCH_MUSIC_BY_MAP_URL[DEFAULT_MAP_URL]!;
}

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
