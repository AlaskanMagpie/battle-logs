import { describe, expect, it } from "vitest";
import { resolveControlProfile } from "./controlProfile";

describe("control profile", () => {
  it("uses explicit desktop and mobile overrides", () => {
    expect(resolveControlProfile({ override: "desktop", coarsePointer: true }).mode).toBe("desktop");
    expect(resolveControlProfile({ override: "mobile" }).mode).toBe("mobile");
  });

  it("defaults coarse pointer devices to mobile with lower pixel budgets", () => {
    const p = resolveControlProfile({ coarsePointer: true, touchPoints: 2, devicePixelRatio: 3 });
    expect(p.mode).toBe("mobile");
    expect(p.captainDefault).toBe(true);
    expect(p.maxPixelRatio).toBe(1);
    expect(p.binderMaxPixelRatio).toBe(1);
  });
});
