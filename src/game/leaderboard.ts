import type { GameState } from "./state";

export const LOCAL_LEADERBOARD_KEY = "signalWars_localLeaderboard_v1";

export interface LocalLeaderboardEntry {
  id: string;
  createdAtIso: string;
  phase: GameState["phase"];
  score: number;
  timeTicks: number;
  enemyKills: number;
  nodesClaimed: number;
  structuresBuilt: number;
  unitsLost: number;
  portalOrigin: boolean;
  username?: string;
}

export function scoreMatchResult(s: GameState): number {
  const victory = s.phase === "win" ? 2500 : 0;
  const nodesClaimed = s.taps.filter((t) => t.active && t.ownerTeam === "player").length;
  const timePenalty = Math.floor(s.tick / 60);
  return Math.max(
    0,
    victory + s.stats.enemyKills * 14 + nodesClaimed * 180 + s.stats.structuresBuilt * 55 - s.stats.unitsLost * 5 - timePenalty,
  );
}

function safeEntries(raw: string | null): LocalLeaderboardEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is LocalLeaderboardEntry => {
      if (typeof x !== "object" || x === null) return false;
      const rec = x as Partial<LocalLeaderboardEntry>;
      return typeof rec.id === "string" && typeof rec.score === "number" && typeof rec.timeTicks === "number";
    });
  } catch {
    return [];
  }
}

export function readLocalLeaderboard(storage: Storage | undefined = globalThis.localStorage): LocalLeaderboardEntry[] {
  try {
    return safeEntries(storage?.getItem(LOCAL_LEADERBOARD_KEY) ?? null).sort((a, b) => b.score - a.score || a.timeTicks - b.timeTicks);
  } catch {
    return [];
  }
}

export function recordLocalLeaderboardResult(
  s: GameState,
  username: string | undefined,
  storage: Storage | undefined = globalThis.localStorage,
): LocalLeaderboardEntry | null {
  if (s.phase === "playing") return null;
  const entry: LocalLeaderboardEntry = {
    id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAtIso: new Date().toISOString(),
    phase: s.phase,
    score: scoreMatchResult(s),
    timeTicks: s.tick,
    enemyKills: s.stats.enemyKills,
    nodesClaimed: s.taps.filter((t) => t.active && t.ownerTeam === "player").length,
    structuresBuilt: s.stats.structuresBuilt,
    unitsLost: s.stats.unitsLost,
    portalOrigin: s.portal.enteredViaPortal,
    username: username?.trim() || undefined,
  };
  try {
    const next = [...readLocalLeaderboard(storage), entry]
      .sort((a, b) => b.score - a.score || a.timeTicks - b.timeTicks)
      .slice(0, 10);
    storage?.setItem(LOCAL_LEADERBOARD_KEY, JSON.stringify(next));
    return entry;
  } catch {
    return null;
  }
}
