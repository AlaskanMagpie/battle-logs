import { afterEach, describe, expect, it, vi } from "vitest";
import { attachOnlineMatchRoom, RemoteIntentLedger } from "./onlineMatch";

type SentMessage = { type: string; payload: unknown };

class MockRoom {
  readonly sent: SentMessage[] = [];
  readonly handlers = new Map<string, (payload: unknown) => void>();
  readonly leave = vi.fn();

  send(type: string, payload: unknown): void {
    this.sent.push({ type, payload });
  }

  onMessage(type: string, handler: (payload: unknown) => void): void {
    this.handlers.set(type, handler);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RemoteIntentLedger", () => {
  it("buffers partner intents per tick and consumes once", () => {
    const ledger = new RemoteIntentLedger();
    ledger.ingest("enemy", 3, [{ type: "clear_placement" }]);
    expect(ledger.hasPartnerIntents(3, "player")).toBe(true);
    expect(ledger.hasPartnerIntents(3, "enemy")).toBe(false);
    const got = ledger.takePartnerIntents(3, "player");
    expect(got).toEqual([{ type: "clear_placement" }]);
    expect(ledger.hasPartnerIntents(3, "player")).toBe(false);
    expect(ledger.takePartnerIntents(3, "player")).toBeUndefined();
  });
});

describe("attachOnlineMatchRoom", () => {
  it("resends recent intent batches without spamming the current tick", () => {
    vi.useFakeTimers();
    const room = new MockRoom();
    const session = attachOnlineMatchRoom(room as never);

    session.sendIntents(1, []);
    session.sendIntents(1, []);
    expect(room.sent).toEqual([{ type: "intent_batch", payload: { tick: 1, intents: [] } }]);

    session.sendIntents(2, []);
    vi.advanceTimersByTime(250);
    session.sendIntents(2, []);

    expect(room.sent).toEqual([
      { type: "intent_batch", payload: { tick: 1, intents: [] } },
      { type: "intent_batch", payload: { tick: 2, intents: [] } },
      { type: "intent_batch", payload: { tick: 1, intents: [] } },
    ]);
  });
});
