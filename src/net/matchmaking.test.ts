import { afterEach, describe, expect, it, vi } from "vitest";
import { findHumanMatch } from "./matchmaking";
import type { MatchFoundPayload } from "./protocol";

const mockColyseus = vi.hoisted(() => ({
  joinOrCreate: vi.fn(),
}));

vi.mock("@colyseus/sdk", () => ({
  Client: class {
    joinOrCreate(roomName: string, request: unknown): Promise<MockRoom> {
      return mockColyseus.joinOrCreate(roomName, request) as Promise<MockRoom>;
    }
  },
}));

class MockRoom {
  readonly roomId = "room-1";
  readonly sessionId = "player-session";
  readonly state: {
    matchId?: string;
    seed?: number;
    mapUrl?: string;
    startsAtMs?: number;
    playerSession?: string;
    enemySession?: string;
  } = {
    matchId: "match-1",
    seed: 123,
    mapUrl: "/map.json",
    startsAtMs: 2000,
    playerSession: "player-session",
  };
  readonly leave = vi.fn();
  private readonly handlers = new Map<string, (payload: MatchFoundPayload) => void>();

  onMessage(name: string, handler: (payload: MatchFoundPayload) => void): void {
    this.handlers.set(name, handler);
  }

  emitMatchFound(): void {
    this.state.enemySession = "enemy-session";
    this.handlers.get("match_found")?.({
      version: 1,
      roomId: this.roomId,
      sessionId: this.sessionId,
      seat: "player",
      matchId: "match-1",
      seed: 123,
      mapUrl: "/map.json",
      doctrineSlotsBySeat: { player: [], enemy: [] },
      startsAtMs: 2000,
    });
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mockColyseus.joinOrCreate.mockReset();
  delete (globalThis as { window?: unknown }).window;
});

describe("matchmaking client fallback", () => {
  it("falls back to AI when no Colyseus endpoint is configured", async () => {
    const result = await findHumanMatch({
      timeoutMs: 1000,
      mapUrl: "/map.json",
      doctrineSlots: [],
      endpoint: "",
    });
    expect(result).toMatchObject({
      mode: "fallback_ai",
      reason: "not_configured",
    });
  });

  it("strict human-only mode does not fall back to AI when the endpoint is missing", async () => {
    const result = await findHumanMatch({
      timeoutMs: 1000,
      mapUrl: "/map.json",
      doctrineSlots: [],
      endpoint: "",
      strictHumanMatch: true,
    });
    expect(result).toMatchObject({
      mode: "human_not_found",
      reason: "not_configured",
    });
  });

  it("waits for match_found after joining an empty room", async () => {
    vi.useFakeTimers();
    (globalThis as { window?: typeof globalThis }).window = globalThis;
    const room = new MockRoom();
    mockColyseus.joinOrCreate.mockResolvedValue(room);

    const match = findHumanMatch({
      timeoutMs: 30_000,
      mapUrl: "/map.json",
      doctrineSlots: [],
      endpoint: "ws://matchmaker.test",
      strictHumanMatch: true,
    });

    let settled = false;
    void match.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);

    room.emitMatchFound();
    await expect(match).resolves.toMatchObject({
      mode: "pvp",
      room: {
        matchId: "match-1",
        seat: "player",
      },
    });
  });
});
