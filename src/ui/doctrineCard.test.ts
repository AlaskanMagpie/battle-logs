import { describe, expect, it } from "vitest";
import { cardArtOverlayHtml } from "./cardArtOverlay";
import { tcgCardSlotHtml } from "./doctrineCard";

describe("doctrine spell card rendering", () => {
  it("spell overlay SVG is Mana only (salvage / FX labels omitted for polish)", () => {
    for (const id of ["recycle", "fortify", "firestorm", "shatter"]) {
      const full = cardArtOverlayHtml(id);
      expect(full).toContain("card-art-overlay");
      expect(full).toContain("data-overlay-field=\"mana\"");
      expect(full).not.toContain("data-overlay-field=\"effect\"");
      expect(full).not.toContain("data-overlay-field=\"salvage\"");
      const hudHand = cardArtOverlayHtml(id, { handSlot: true });
      expect(hudHand).toContain("card-art-overlay");
      expect(hudHand).not.toContain("data-overlay-field=\"effect\"");
      expect(hudHand).not.toContain("data-overlay-field=\"salvage\"");
      const picker = tcgCardSlotHtml(id, "picker");
      expect(picker).toContain("card-art-overlay");
      expect(picker).toContain("data-overlay-field=\"mana\"");
    }
  });
});
