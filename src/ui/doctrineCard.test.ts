import { describe, expect, it } from "vitest";
import { cardArtOverlayHtml } from "./cardArtOverlay";
import { tcgCardSlotHtml } from "./doctrineCard";

describe("doctrine spell card rendering", () => {
  it("does not stamp generated SVG stat labels over authored spell art", () => {
    for (const id of ["cut_line", "fortify", "firestorm", "shatter"]) {
      expect(cardArtOverlayHtml(id)).toBe("");
      const hand = tcgCardSlotHtml(id, "picker");
      expect(hand).not.toContain("card-art-overlay");
      expect(hand).not.toContain(">AOE<");
      expect(hand).not.toContain(">FIELD<");
      expect(hand).not.toContain(">LINE<");
      expect(hand).not.toContain(">SALVAGE<");
      expect(hand).not.toContain(">100%<");
    }
  });
});
