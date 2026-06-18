import { describe, expect, it } from "vitest";
import { RemoteIntentLedger } from "./onlineMatch";

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
