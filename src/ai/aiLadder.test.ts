import { describe, expect, it } from "vitest";
import {
  AI_ADMIN_STORAGE_KEY,
  AI_MATCH_COST_BENCHMARK,
  AI_PROVIDER_CHART_ROWS,
  AI_LADDER_OPPONENTS,
  AI_LADDER_WINS_TO_UNLOCK,
  OPENSERV_PROVIDER_CHART_ROWS,
  aiProviderChartMarkdown,
  currentAiLadderOpponent,
  isAiLadderProgressEligible,
  isOwnerAiDuelAuthorized,
  readAiLadderProgress,
  recordAiLadderWin,
  resolvePlayableAiOpponent,
  winsAgainst,
} from "./aiLadder";

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

describe("ai ladder", () => {
  it("unlocks the next model after two wins", () => {
    const storage = new MemoryStorage();
    const first = AI_LADDER_OPPONENTS[0]!;
    const second = AI_LADDER_OPPONENTS[1]!;

    expect(currentAiLadderOpponent(readAiLadderProgress(storage)).id).toBe(first.id);

    recordAiLadderWin(first.id, storage);
    let progress = readAiLadderProgress(storage);
    expect(winsAgainst(progress, first.id)).toBe(AI_LADDER_WINS_TO_UNLOCK - 1);
    expect(currentAiLadderOpponent(progress).id).toBe(first.id);

    recordAiLadderWin(first.id, storage);
    progress = readAiLadderProgress(storage);
    expect(winsAgainst(progress, first.id)).toBe(AI_LADDER_WINS_TO_UNLOCK);
    expect(currentAiLadderOpponent(progress).id).toBe(second.id);
  });

  it("blocks locked model requests unless owner tooling explicitly allows them", () => {
    const progress = readAiLadderProgress(new MemoryStorage());
    const first = AI_LADDER_OPPONENTS[0]!;
    const final = AI_LADDER_OPPONENTS[AI_LADDER_OPPONENTS.length - 1]!;

    expect(resolvePlayableAiOpponent(final.id, progress).id).toBe(first.id);
    expect(resolvePlayableAiOpponent(final.id, progress, { allowLocked: true }).id).toBe(final.id);
  });

  it("requires both the URL flag and local owner gate for AI duels", () => {
    const storage = new MemoryStorage();
    const duelParams = new URLSearchParams("aiDuel=1");

    expect(isOwnerAiDuelAuthorized(duelParams, storage)).toBe(false);
    storage.setItem(AI_ADMIN_STORAGE_KEY, "enabled");
    expect(isOwnerAiDuelAuthorized(duelParams, storage)).toBe(true);
    expect(isOwnerAiDuelAuthorized(new URLSearchParams(""), storage)).toBe(false);
  });

  it("only records ladder progress for normal human-vs-ai ladder wins", () => {
    const opponentId = AI_LADDER_OPPONENTS[0]!.id;

    expect(isAiLadderProgressEligible({ matchMode: "ai", aiBattle: false, opponentId })).toBe(true);
    expect(isAiLadderProgressEligible({ matchMode: "ai", aiBattle: true, opponentId })).toBe(false);
    expect(isAiLadderProgressEligible({ matchMode: "fallback_ai", aiBattle: false, opponentId })).toBe(false);
    expect(isAiLadderProgressEligible({ matchMode: "pvp", aiBattle: false, opponentId })).toBe(false);
    expect(isAiLadderProgressEligible({ matchMode: "ai", aiBattle: false, opponentId: null })).toBe(false);
  });

  it("keeps OpenServ rows in the provider chart but out of the player ladder", () => {
    expect(OPENSERV_PROVIDER_CHART_ROWS).toHaveLength(4);
    expect(AI_LADDER_OPPONENTS.some((o) => o.provider === "openserv")).toBe(false);
    expect(AI_PROVIDER_CHART_ROWS.some((row) => row.provider === "openserv")).toBe(true);
    expect(OPENSERV_PROVIDER_CHART_ROWS.every((row) => row.includeInPlayerLadder === false)).toBe(true);
  });

  it("labels OpenServ pricing confidence without inventing a token price", () => {
    const submitterOwned = OPENSERV_PROVIDER_CHART_ROWS.find((row) => row.id === "openserv-submitter-owned-custom-agent")!;
    const ownedLadder = OPENSERV_PROVIDER_CHART_ROWS.find((row) => row.id === "openserv-your-owned-ladder-bot")!;

    expect(submitterOwned.costOwner).toBe("submitter");
    expect(submitterOwned.pricingConfidence).toBe("submitter_paid");
    expect(submitterOwned.estimatedCostPer1000Matches).toBe("$0 to us");
    expect(ownedLadder.costOwner).toBe("unknown");
    expect(ownedLadder.pricingConfidence).toBe("unknown_platform_fee");
    expect(ownedLadder.estimatedCostPer1000Matches.toLowerCase()).toContain("unknown");
  });

  it("documents the shared match-cost benchmark used by the provider chart", () => {
    expect(AI_MATCH_COST_BENCHMARK.decisionCallsPerMatch).toBe(45);
    expect(AI_MATCH_COST_BENCHMARK.agentCallsPer1000Matches).toBe(45_000);
    expect(AI_MATCH_COST_BENCHMARK.formula).toContain("platform fees");
  });

  it("renders a master provider chart that includes OpenServ without a fake dollar estimate", () => {
    const chart = aiProviderChartMarkdown(OPENSERV_PROVIDER_CHART_ROWS);

    expect(chart).toContain("OpenServ submitter-owned custom agent");
    expect(chart).toContain("$0 to us");
    expect(chart).toContain("OpenServ your-owned ladder bot");
    expect(chart).toContain("Unknown until account pricing visible");
  });
});
