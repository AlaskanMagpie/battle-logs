import type {
  EquipmentSlot,
  UnitEquipmentItemDef,
  UnitEquipmentLoadout,
  UnitEquipmentLoadoutDef,
  UnitEquipmentStatModifiers,
} from "./types";

export const EQUIPMENT_SLOTS = ["leftHand", "rightHand", "back"] as const satisfies readonly EquipmentSlot[];

export const UNIT_EQUIPMENT_CATALOG: readonly UnitEquipmentItemDef[] = [];

const EQUIPMENT_BY_ID: Record<string, UnitEquipmentItemDef> = Object.fromEntries(
  UNIT_EQUIPMENT_CATALOG.map((item) => [item.id, item]),
);

function cloneItem(item: UnitEquipmentItemDef): UnitEquipmentItemDef {
  return {
    ...item,
    stats: item.stats ? { ...item.stats } : undefined,
    transform: item.transform ? { ...item.transform } : undefined,
  };
}

export function getEquipmentItemDef(id: string | null | undefined): UnitEquipmentItemDef | null {
  if (!id) return null;
  return EQUIPMENT_BY_ID[id] ?? null;
}

export function resolveEquipmentLoadout(loadout: UnitEquipmentLoadoutDef | undefined): UnitEquipmentLoadout | undefined {
  if (!loadout) return undefined;
  const out: UnitEquipmentLoadout = {};
  for (const slot of EQUIPMENT_SLOTS) {
    const raw = loadout[slot];
    if (!raw) continue;
    const item = typeof raw === "string" ? getEquipmentItemDef(raw) : raw;
    if (!item || !item.glb) continue;
    if (item.slot && item.slot !== slot) continue;
    out[slot] = cloneItem({ ...item, slot });
  }
  return Object.keys(out).length ? out : undefined;
}

export function equipmentSignature(loadout: UnitEquipmentLoadout | undefined): string {
  if (!loadout) return "";
  return EQUIPMENT_SLOTS.map((slot) => {
    const item = loadout[slot];
    return item ? `${slot}:${item.id}:${item.glb}` : `${slot}:`;
  }).join("|");
}

export function applyEquipmentStatModifiers<T extends {
  range: number;
  dmgPerTick: number;
  trait?: UnitEquipmentStatModifiers["trait"];
  aoeRadius?: number;
  damageVsStructuresMult?: number;
}>(unit: T, loadout: UnitEquipmentLoadout | undefined): T {
  if (!loadout) return unit;
  for (const slot of EQUIPMENT_SLOTS) {
    const stats = loadout[slot]?.stats;
    if (!stats) continue;
    if (typeof stats.rangeAdd === "number") unit.range += stats.rangeAdd;
    if (typeof stats.rangeMult === "number") unit.range *= stats.rangeMult;
    if (typeof stats.dmgPerTickAdd === "number") unit.dmgPerTick += stats.dmgPerTickAdd;
    if (typeof stats.dmgPerTickMult === "number") unit.dmgPerTick *= stats.dmgPerTickMult;
    if (stats.trait) unit.trait = stats.trait;
    if (typeof stats.aoeRadiusSet === "number") unit.aoeRadius = stats.aoeRadiusSet;
    if (typeof stats.aoeRadiusAdd === "number") unit.aoeRadius = (unit.aoeRadius ?? 0) + stats.aoeRadiusAdd;
    if (typeof stats.damageVsStructuresMult === "number") {
      unit.damageVsStructuresMult = (unit.damageVsStructuresMult ?? 1) * stats.damageVsStructuresMult;
    }
  }
  return unit;
}
