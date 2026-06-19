/**
 * Deterministic mapping from a doctrine structure catalog entry to procedural
 * building parameters. Style/footprint are derived from the structure's signal
 * types + a stable per-id seed, with optional per-card overrides from the
 * catalog (derive-with-override). Same id always yields the same building, so
 * placements never shuffle across sessions or clients.
 */
import type { SignalType, StructureCatalogEntry } from "../../game/types";
import { hashStringToSeed } from "../glbPool";
import { clamp, mulberry32, pick, rint, type Rng } from "./rng";
import { type FootKey } from "./footprints";
import { CURATED_STYLE_KEYS, STYLES, type StyleKey } from "./styles";

export interface ResolvedBuild {
  style: StyleKey;
  foot: FootKey;
  storeys: number;
  seed: number;
  litEmissive: number;
  emissiveScale: number;
}

const FORTRESS: StyleKey[] = ["brutalist", "gothic", "classical"];
const TECH: StyleKey[] = ["cyberpunk"];
const UTILITY: StyleKey[] = ["industrial"];

const FOOT_BIAS: Partial<Record<StyleKey, FootKey[]>> = {
  brutalist: ["rect", "rect", "T", "plus"],
  gothic: ["rect", "hex", "octagon"],
  cyberpunk: ["rect", "octagon", "hex"],
  industrial: ["rect", "L", "T"],
  classical: ["rect", "U", "T"],
};

const SIZE_BASE_STOREYS: Record<string, number> = { Swarm: 4, Line: 5, Heavy: 7, Titan: 9 };

function deriveStyle(signalTypes: SignalType[], rng: Rng): StyleKey {
  const counts: Record<SignalType, number> = { Vanguard: 0, Bastion: 0, Reclaim: 0 };
  for (const s of signalTypes) counts[s]++;
  const max = Math.max(counts.Vanguard, counts.Bastion, counts.Reclaim);
  if (max === 0) return pick(rng, CURATED_STYLE_KEYS);
  if (counts.Bastion === max) return pick(rng, FORTRESS);
  if (counts.Vanguard === max) return pick(rng, TECH);
  if (counts.Reclaim === max) return pick(rng, UTILITY);
  return pick(rng, CURATED_STYLE_KEYS);
}

function isStyleKey(v: string | undefined): v is StyleKey {
  return v !== undefined && Object.prototype.hasOwnProperty.call(STYLES, v);
}

const FOOT_KEYS: FootKey[] = ["rect", "L", "U", "T", "plus", "round", "hex", "octagon"];
function isFootKey(v: string | undefined): v is FootKey {
  return v !== undefined && (FOOT_KEYS as string[]).includes(v);
}

export function resolveStructureBuild(entry: StructureCatalogEntry): ResolvedBuild {
  const seed = entry.buildVariantSeed ?? hashStringToSeed(entry.id);
  const rng = mulberry32(seed);
  const style = isStyleKey(entry.buildStyleId) ? entry.buildStyleId : deriveStyle(entry.signalTypes, rng);
  const foot = isFootKey(entry.buildFootprintKey)
    ? entry.buildFootprintKey
    : pick(rng, FOOT_BIAS[style] ?? (["rect"] as FootKey[]));
  const base = SIZE_BASE_STOREYS[entry.producedSizeClass] ?? 5;
  const storeys = entry.buildStoreys ?? clamp(base + rint(rng, 0, 2), 3, 12);
  // Match renderer uses NoToneMapping: tame neon, give windows a soft static glow.
  const emissiveScale = 0.6;
  const litEmissive = style === "cyberpunk" ? 0.85 : 0.5;
  return { style, foot, storeys, seed, litEmissive, emissiveScale };
}
