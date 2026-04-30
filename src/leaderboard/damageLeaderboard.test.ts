import { describe, expect, it } from "vitest";
import { normalizeDamageSubmission } from "./damageLeaderboard";

describe("damage leaderboard submission normalization", () => {
  it("submits only completed matches and rounds damage", () => {
    expect(
      normalizeDamageSubmission({
        username: " wizard ",
        damage: 1234.6,
        phase: "win",
        durationTicks: 400.4,
        matchMode: "ai",
        mapId: "/map.json",
        clientMatchId: "abc",
      }),
    ).toMatchObject({
      username: "wizard",
      damage: 1235,
      phase: "win",
      duration_ticks: 400,
      match_mode: "ai",
      map_id: "/map.json",
      client_match_id: "abc",
    });
    expect(
      normalizeDamageSubmission({
        damage: 1,
        phase: "playing",
        durationTicks: 0,
        matchMode: "ai",
      }),
    ).toBeNull();
  });

  it("clamps public write fields to safe bounds", () => {
    const row = normalizeDamageSubmission({
      username: "x".repeat(100),
      damage: Number.POSITIVE_INFINITY,
      phase: "lose",
      durationTicks: 10,
      matchMode: "fallback_ai",
    });
    expect(row?.damage).toBe(2_000_000_000);
    expect(row?.username?.length).toBe(32);

    const clamped = normalizeDamageSubmission({
      username: "x".repeat(100),
      damage: 3_000_000_000,
      phase: "lose",
      durationTicks: 3_000_000_000,
      matchMode: "fallback_ai",
      mapId: "m".repeat(200),
      clientMatchId: "c".repeat(200),
    });
    expect(clamped?.damage).toBe(2_000_000_000);
    expect(clamped?.duration_ticks).toBe(2_000_000_000);
    expect(clamped?.username?.length).toBe(32);
    expect(clamped?.map_id?.length).toBe(128);
    expect(clamped?.client_match_id?.length).toBe(96);
  });
});
