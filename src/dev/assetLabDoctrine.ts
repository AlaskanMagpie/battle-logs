/**
 * Asset lab — manual “doctrine” workspace: per-structure card, optional tower/unit GLB overrides
 * and named animation clips. Persisted locally (+ JSON export/import).
 *
 * Cross-GLB animation retargeting is not implemented — clips must exist on the assigned unit rig.
 */

export type UnitAnimRole = "run" | "idle" | "attack" | "die";

export const UNIT_ANIM_ROLES: readonly UnitAnimRole[] = ["run", "idle", "attack", "die"];

export type AssetLabCardDoctrine = {
  /** Empty string means “use catalog routing default” from glbPool. */
  towerGlb: string;
  unitGlb: string;
  /** Clip name on the tower model (first clip if empty). */
  towerClip: string;
  /** Clip names on the assigned unit GLB (must exist on that file). */
  unitClips: Partial<Record<UnitAnimRole, string>>;
};

type DoctrineStoreV1 = {
  version: 1;
  cards: Record<string, AssetLabCardDoctrine>;
};

const STORAGE_KEY = "battleLogs.assetLab.doctrine.v1";

function emptyDoctrine(): AssetLabCardDoctrine {
  return {
    towerGlb: "",
    unitGlb: "",
    towerClip: "",
    unitClips: {},
  };
}

function loadStore(): DoctrineStoreV1 {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, cards: {} };
    const j = JSON.parse(raw) as DoctrineStoreV1;
    if (j?.version !== 1 || typeof j.cards !== "object" || !j.cards) return { version: 1, cards: {} };
    return j;
  } catch {
    return { version: 1, cards: {} };
  }
}

function saveStore(s: DoctrineStoreV1): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* quota / private mode */
  }
}

export function getDoctrineForCard(catalogId: string): AssetLabCardDoctrine {
  const s = loadStore();
  const row = s.cards[catalogId];
  if (!row) return emptyDoctrine();
  return {
    towerGlb: typeof row.towerGlb === "string" ? row.towerGlb : "",
    unitGlb: typeof row.unitGlb === "string" ? row.unitGlb : "",
    towerClip: typeof row.towerClip === "string" ? row.towerClip : "",
    unitClips:
      row.unitClips && typeof row.unitClips === "object"
        ? { ...row.unitClips }
        : {},
  };
}

export function clearDoctrineForCard(catalogId: string): void {
  const s = loadStore();
  delete s.cards[catalogId];
  saveStore(s);
}

export function mergeDoctrineForCard(catalogId: string, patch: Partial<AssetLabCardDoctrine>): AssetLabCardDoctrine {
  const cur = getDoctrineForCard(catalogId);
  let unitClips = { ...cur.unitClips, ...(patch.unitClips ?? {}) };
  if (patch.unitClips) {
    for (const k of Object.keys(patch.unitClips) as UnitAnimRole[]) {
      const v = patch.unitClips[k];
      if (v === undefined || v === "") delete unitClips[k];
    }
  }
  const next: AssetLabCardDoctrine = {
    towerGlb: patch.towerGlb !== undefined ? patch.towerGlb : cur.towerGlb,
    unitGlb: patch.unitGlb !== undefined ? patch.unitGlb : cur.unitGlb,
    towerClip: patch.towerClip !== undefined ? patch.towerClip : cur.towerClip,
    unitClips,
  };
  const s = loadStore();
  s.cards[catalogId] = next;
  saveStore(s);
  return next;
}

export function exportDoctrineStoreJson(): string {
  const s = loadStore();
  return `${JSON.stringify(s, null, 2)}\n`;
}

/** Merge imported cards into local storage; returns number of card ids merged. */
export function importDoctrineStoreJson(text: string): { merged: number; error?: string } {
  try {
    const j = JSON.parse(text) as DoctrineStoreV1;
    if (j?.version !== 1 || typeof j.cards !== "object" || !j.cards) {
      return { merged: 0, error: "Expected { version: 1, cards: { ... } }" };
    }
    const cur = loadStore();
    let n = 0;
    for (const [id, row] of Object.entries(j.cards)) {
      if (!/^[a-z0-9_-]+$/i.test(id)) continue;
      const existing = cur.cards[id] ?? emptyDoctrine();
      cur.cards[id] = {
        towerGlb: typeof row.towerGlb === "string" ? row.towerGlb : existing.towerGlb,
        unitGlb: typeof row.unitGlb === "string" ? row.unitGlb : existing.unitGlb,
        towerClip: typeof row.towerClip === "string" ? row.towerClip : existing.towerClip,
        unitClips: {
          ...existing.unitClips,
          ...(row.unitClips && typeof row.unitClips === "object" ? row.unitClips : {}),
        },
      };
      n += 1;
    }
    saveStore(cur);
    return { merged: n };
  } catch (e) {
    return { merged: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Pick first clip whose name matches any substring (case-insensitive). */
export function guessClipByKeywords(clips: ReadonlyArray<{ name: string }>, keywords: readonly string[]): string | null {
  const lower = keywords.map((k) => k.toLowerCase());
  for (const c of clips) {
    const n = c.name.toLowerCase();
    if (lower.some((k) => n.includes(k))) return c.name;
  }
  return null;
}

export function guessUnitClipsFromNames(clips: ReadonlyArray<{ name: string }>): Partial<Record<UnitAnimRole, string>> {
  const out: Partial<Record<UnitAnimRole, string>> = {};
  const tryRole = (role: UnitAnimRole, keys: readonly string[]): void => {
    const g = guessClipByKeywords(clips, keys);
    if (g) out[role] = g;
  };
  tryRole("run", ["run", "sprint", "jog", "move"]);
  tryRole("idle", ["idle", "stand", "breath", "stance", "combat"]);
  tryRole("attack", ["attack", "slash", "strike", "swing", "cast", "combo", "charge"]);
  tryRole("die", ["die", "death", "dead", "knock", "dying"]);
  return out;
}
