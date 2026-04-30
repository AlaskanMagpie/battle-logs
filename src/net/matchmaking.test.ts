import { describe, expect, it } from "vitest";
import { findHumanMatch } from "./matchmaking";

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
      reason: "server_unavailable",
    });
  });
});
