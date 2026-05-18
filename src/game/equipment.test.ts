import { describe, expect, it } from "vitest";
import { applyEquipmentStatModifiers, equipmentSignature, resolveEquipmentLoadout } from "./equipment";

describe("unit equipment resolver", () => {
  it("omits empty or unresolved loadouts", () => {
    expect(resolveEquipmentLoadout(undefined)).toBeUndefined();
    expect(resolveEquipmentLoadout({ leftHand: null, rightHand: "missing-item" })).toBeUndefined();
  });

  it("keeps inline cosmetic items without applying stat changes", () => {
    const loadout = resolveEquipmentLoadout({
      leftHand: { id: "buckler", name: "Buckler", glb: "buckler.glb" },
    });
    const unit = { range: 10, dmgPerTick: 0.2, damageVsStructuresMult: 1 };

    applyEquipmentStatModifiers(unit, loadout);

    expect(loadout?.leftHand?.slot).toBe("leftHand");
    expect(equipmentSignature(loadout)).toContain("leftHand:buckler:buckler.glb");
    expect(unit).toEqual({ range: 10, dmgPerTick: 0.2, damageVsStructuresMult: 1 });
  });

  it("applies explicit stat modifiers deterministically", () => {
    const loadout = resolveEquipmentLoadout({
      rightHand: {
        id: "halberd",
        name: "Halberd",
        glb: "halberd.glb",
        stats: {
          rangeAdd: 3,
          dmgPerTickMult: 1.25,
          aoeRadiusSet: 2,
          damageVsStructuresMult: 1.4,
        },
      },
    });
    const unit: { range: number; dmgPerTick: number; damageVsStructuresMult: number; aoeRadius?: number } = {
      range: 12,
      dmgPerTick: 0.4,
      damageVsStructuresMult: 1,
    };

    applyEquipmentStatModifiers(unit, loadout);

    expect(unit.range).toBe(15);
    expect(unit.dmgPerTick).toBeCloseTo(0.5, 5);
    expect(unit.aoeRadius).toBe(2);
    expect(unit.damageVsStructuresMult).toBeCloseTo(1.4, 5);
  });
});
