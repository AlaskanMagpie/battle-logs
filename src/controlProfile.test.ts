import { afterEach, describe, expect, it, vi } from "vitest";
import { getControlProfile, resolveControlProfile } from "./controlProfile";

describe("control profile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses explicit desktop and mobile overrides", () => {
    expect(resolveControlProfile({ override: "desktop", coarsePointer: true }).mode).toBe("desktop");
    expect(resolveControlProfile({ override: "mobile" }).mode).toBe("mobile");
  });

  it("defaults coarse pointer devices to mobile with lower pixel budgets", () => {
    const p = resolveControlProfile({ coarsePointer: true, touchPoints: 2, devicePixelRatio: 3 });
    expect(p.mode).toBe("mobile");
    expect(p.captainDefault).toBe(true);
    expect(p.maxPixelRatio).toBe(0.85);
    expect(p.binderMaxPixelRatio).toBe(1);
  });

  it("allows URL profile override for repeatable mobile smoke tests", () => {
    vi.stubGlobal("navigator", { maxTouchPoints: 0, hardwareConcurrency: 8 });
    vi.stubGlobal("window", {
      devicePixelRatio: 1,
      location: { search: "?controlProfile=mobile" },
      localStorage: { getItem: () => "desktop" },
      matchMedia: () => ({ matches: false }),
    });

    expect(getControlProfile().mode).toBe("mobile");
  });
});
