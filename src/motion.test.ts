import { afterEach, describe, expect, it, vi } from "vitest";
import {
  motionStagger,
  prefersReducedMotion,
  resetCount,
  tweenBarPercent,
  tweenCount,
  tweenNumber,
} from "./motion";

/** Minimal stand-in for the few element fields the helpers touch. */
function fakeEl(): HTMLElement {
  return { textContent: "", style: {} as CSSStyleDeclaration } as unknown as HTMLElement;
}

describe("motion: SSR-safe snap behavior", () => {
  it("treats a missing window (node/SSR) as motion-allowed rather than throwing", () => {
    expect(prefersReducedMotion()).toBe(false);
  });

  it("tweenNumber with from===to snaps and fires callbacks synchronously", () => {
    const seen: number[] = [];
    let completed = false;
    const handle = tweenNumber({
      from: 5,
      to: 5,
      onRender: (v) => seen.push(v),
      onComplete: () => {
        completed = true;
      },
    });
    expect(handle).toBeNull();
    expect(seen).toEqual([5]);
    expect(completed).toBe(true);
  });

  it("tweenCount seeds an element's text on first call (no prior state to animate from)", () => {
    const el = fakeEl();
    tweenCount(el, 42);
    expect(el.textContent).toBe("42");
  });

  it("tweenCount honors a custom formatter (e.g. cur/max HP)", () => {
    const el = fakeEl();
    tweenCount(el, 7, { format: (v) => `${Math.round(v)}/100` });
    expect(el.textContent).toBe("7/100");
  });

  it("tweenBarPercent clamps to 0..100 and writes a width on first call", () => {
    const over = fakeEl();
    tweenBarPercent(over, 150);
    expect(over.style.width).toBe("100%");
    const under = fakeEl();
    tweenBarPercent(under, -20);
    expect(under.style.width).toBe("0%");
  });

  it("motionStagger returns a stagger function when motion is allowed", () => {
    expect(typeof motionStagger(40)).toBe("function");
  });

  it("resetCount clears retained tween state without throwing", () => {
    const el = fakeEl();
    tweenCount(el, 1);
    expect(() => resetCount(el)).not.toThrow();
  });
});

describe("motion: reduced-motion contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("snaps to final values and collapses stagger when the user prefers reduced motion", async () => {
    // Fresh module instance so the cached media query reflects the stubbed window.
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    vi.resetModules();
    const m = await import("./motion");

    expect(m.prefersReducedMotion()).toBe(true);
    // A cascade collapses to a single instant snap (delay 0).
    expect(m.motionStagger(40)).toBe(0);
    // A large jump still snaps straight to the target instead of animating.
    const el = { textContent: "", style: {} as CSSStyleDeclaration } as unknown as HTMLElement;
    m.tweenCount(el, 99, { from: 0 });
    expect(el.textContent).toBe("99");
  });
});
