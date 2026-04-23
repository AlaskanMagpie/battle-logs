import { describe, expect, it } from "vitest";
import { KEEP_ID } from "../../game/constants";
import { sortPickerHandByFluxCost } from "./doctrinePickerHandSort";

describe("sortPickerHandByFluxCost", () => {
  it("left-packs by ascending fluxCost", () => {
    const slots: (string | null)[] = [
      "siege_works",
      null,
      KEEP_ID,
      "outpost",
      null,
      null,
      null,
      null,
      null,
      null,
    ];
    const binderPick: (number | null)[] = [3, null, 1, 2, null, null, null, null, null, null];
    const { slots: out, binderPick: picks } = sortPickerHandByFluxCost(slots, binderPick);
    expect(out[0]).toBe(KEEP_ID);
    expect(out[1]).toBe("outpost");
    expect(out[2]).toBe("siege_works");
    expect(out.slice(3).every((x) => x == null)).toBe(true);
    expect(picks[0]).toBe(1);
    expect(picks[1]).toBe(2);
    expect(picks[2]).toBe(3);
  });
});
