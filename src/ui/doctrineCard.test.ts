import { describe, expect, it } from "vitest";
import { cardArtOverlayHtml } from "./cardArtOverlay";
import { tcgCardSlotHtml } from "./doctrineCard";

describe("doctrine spell card rendering", () => {
  it("includes SVG stat overlays for spells (binder raster strips SVG text; HUD hand hides FX label only)", () => {
    for (const id of ["recycle", "fortify", "firestorm", "shatter"]) {
      const full = cardArtOverlayHtml(id);
      expect(full).toContain("card-art-overlay");
      expect(full).toContain("data-overlay-field=\"mana\"");
      const hudHand = cardArtOverlayHtml(id, { handSlot: true });
      expect(hudHand).toContain("card-art-overlay");
      expect(hudHand).not.toContain("data-overlay-field=\"effect\"");
      const picker = tcgCardSlotHtml(id, "picker");
      expect(picker).toContain("card-art-overlay");
      expect(picker).toContain("data-overlay-field=\"mana\"");
    }
  });
});
