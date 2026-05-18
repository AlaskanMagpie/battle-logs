import { describe, expect, it } from "vitest";
import { binderDecodedHeroArtRect } from "./binderCardTexture";
import { containCardArtRect } from "../cardArtOverlay";

describe("binderDecodedHeroArtRect", () => {
  it("matches containCardArtRect for table-driven panel + intrinsic sizes", () => {
    const cases: Array<{ pw: number; ph: number; iw: number; ih: number }> = [
      { pw: 400, ph: 600, iw: 400, ih: 600 },
      { pw: 400, ph: 600, iw: 512, ih: 512 },
      { pw: 200, ph: 300, iw: 100, ih: 100 },
    ];
    for (const { pw, ph, iw, ih } of cases) {
      expect(binderDecodedHeroArtRect(pw, ph, iw, ih)).toEqual(containCardArtRect(0, 0, pw, ph, iw, ih));
    }
  });
});