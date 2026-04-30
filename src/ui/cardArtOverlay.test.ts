import { describe, expect, it } from "vitest";
import { containCardArtRect } from "./cardArtOverlay";

describe("containCardArtRect", () => {
  it("letterboxes tall art inside a wide box", () => {
    const r = containCardArtRect(0, 0, 300, 150, 100, 150);
    expect(r).toEqual({ x: 100, y: 0, w: 100, h: 150 });
  });

  it("letterboxes wide art inside a tall box", () => {
    const r = containCardArtRect(10, 20, 100, 300, 100, 100);
    expect(r).toEqual({ x: 10, y: 120, w: 100, h: 100 });
  });

  it("falls back to the normalized doctrine card aspect for invalid intrinsic sizes", () => {
    const r = containCardArtRect(0, 0, 300, 300, 0, 0);
    expect(r).toEqual({ x: 50, y: 0, w: 200, h: 300 });
  });
});
