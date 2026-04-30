import { describe, expect, it } from "vitest";
import { clampMatchmakingTimeoutMs, normalizeMatchMode } from "./protocol";

describe("multiplayer protocol helpers", () => {
  it("normalizes opponent mode URL params", () => {
    expect(normalizeMatchMode("matchmake")).toBe("matchmake");
    expect(normalizeMatchMode("pvp")).toBe("matchmake");
    expect(normalizeMatchMode("fallback_ai")).toBe("fallback_ai");
    expect(normalizeMatchMode("anything")).toBe("ai");
    expect(normalizeMatchMode(null)).toBe("ai");
  });

  it("keeps matchmaking timeout in a short safe range", () => {
    expect(clampMatchmakingTimeoutMs("50")).toBe(1000);
    expect(clampMatchmakingTimeoutMs("4000")).toBe(4000);
    expect(clampMatchmakingTimeoutMs("999999")).toBe(10000);
    expect(clampMatchmakingTimeoutMs("nope")).toBe(4000);
  });
});
