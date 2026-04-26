import { describe, expect, it } from "vitest";
import { enemyHuntDetectRadius, playerAcquireRadius } from "./engagement";

describe("engagement radii scale with arena half-extent", () => {
  it("enemy hunt exceeds legacy constant on large maps", () => {
    expect(enemyHuntDetectRadius(420)).toBeGreaterThan(118);
    expect(enemyHuntDetectRadius(300)).toBeGreaterThan(118);
    expect(enemyHuntDetectRadius(80)).toBe(118);
  });

  it("player acquire exceeds weapon-only detect on large maps", () => {
    const smallMap = playerAcquireRadius(80, 7);
    const largeMap = playerAcquireRadius(420, 7);
    expect(largeMap).toBeGreaterThan(smallMap);
    expect(largeMap).toBeGreaterThan(7 * 6);
  });
});
