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

export async function loadMapMerged(): Promise<MapData> {
  const baseRes = await fetch("/map.json");
  if (!baseRes.ok) throw new Error(`map.json: ${baseRes.status}`);
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
