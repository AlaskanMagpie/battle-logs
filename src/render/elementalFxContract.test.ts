import { describe, expect, it } from "vitest";
import { ELEMENTAL_FX_REQUIRED_SHAPES, SPELL_FX_ELEMENTS } from "../game/types";
import { ELEMENTAL_FX_CONTRACT } from "./fx";

describe("elemental FX contract", () => {
  it("requires every element to support the full battlefield shape set plus a surprise route", () => {
    for (const element of SPELL_FX_ELEMENTS) {
      const contract = ELEMENTAL_FX_CONTRACT[element];
      expect(contract, element).toBeTruthy();
      expect(new Set(contract.requiredShapes), element).toEqual(new Set(ELEMENTAL_FX_REQUIRED_SHAPES));
      expect(contract.surpriseShape, element).not.toBe("surprise");
    }
  });
});
