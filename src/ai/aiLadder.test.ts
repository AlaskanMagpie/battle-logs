import { describe, expect, it } from "vitest";
import {
  AI_ADMIN_STORAGE_KEY,
  AI_LADDER_OPPONENTS,
  AI_LADDER_WINS_TO_UNLOCK,
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
});
