import {
  CUT_LINE_DAMAGE_PER_UNIT,
  CUT_LINE_HALF_WIDTH,
  CUT_LINE_LENGTH,
  DOCTRINE_SLOT_COUNT,
  FIRESTORM_DAMAGE_PER_UNIT,
  FIRESTORM_RADIUS,
  FORTIFY_FIELD_ALLY_DAMAGE_MULT,
  FORTIFY_FIELD_ALLY_INCOMING_MULT,
  FORTIFY_FIELD_ALLY_SPEED_MULT,
  FORTIFY_FIELD_DURATION_SEC,
  FORTIFY_FIELD_ENEMY_DAMAGE_MULT,
  FORTIFY_FIELD_ENEMY_INCOMING_MULT,
  FORTIFY_FIELD_ENEMY_SPEED_MULT,
  FORTIFY_FIELD_RADIUS,
  KEEP_ID,
  KEEP_MAX_HP,
  KEEP_SWARM_PERIOD_SEC,
  SHATTER_CAST_RADIUS,
  SHATTER_CHAIN_DAMAGE_FALLOFF,
  SHATTER_CHAIN_MAX_TARGETS,
  SHATTER_CHAIN_RANGE,
  SHATTER_DAMAGE,
  SHATTER_PRODUCTION_PAUSE_SEC,
  PRODUCED_UNIT_ACROBAT_WARRIOR_SCOUTS,
  PRODUCED_UNIT_AMBER_GEODE_MONKS,
  PRODUCED_UNIT_LAVA_WIZARD_MONKS,
  PRODUCED_UNIT_CHRONO_SENTINELS,
  PRODUCED_UNIT_RECLAMATION_WRAITH,
  PRODUCED_UNIT_SIEGE_RAM,
} from "./constants";
import type { CatalogEntry, CommandCatalogEntry, StructureCatalogEntry } from "./types";
import { isCommandEntry, isStructureEntry } from "./types";

const STRUCTURE_DATA: StructureCatalogEntry[] = [
  {
    id: KEEP_ID,
    name: "Wizard Keep",
    kind: "structure",
    fluxCost: 0,
    buildSeconds: 0,
    requiredRelayTier: 1,
    signalTypes: [],
    productionSeconds: KEEP_SWARM_PERIOD_SEC,
    producedSizeClass: "Swarm",
    producedUnitId: PRODUCED_UNIT_ACROBAT_WARRIOR_SCOUTS,
    producedPop: 4,
    localPopCap: 8,
    maxHp: KEEP_MAX_HP,
    damagePerTick: 0,
    maxCharges: 0,
    chargeCooldownSeconds: 0,
    producedFlavor: "Permanent wizard base — slowly vents a small T1 guard trickle.",
  },
  {
    id: "outpost",
    name: "Driftwood Oasis",
    kind: "structure",
    fluxCost: 126,
    buildSeconds: 2,
    requiredRelayTier: 1,
    // No requiredSignalCounts — any built relay unlocks this.
    signalTypes: [],
    productionSeconds: 31,
    producedSizeClass: "Line",
    producedPop: 3,
    localPopCap: 12,
    maxHp: 270,
    damagePerTick: 0,
    maxCharges: 3,
    chargeCooldownSeconds: 13,
    producedFlavor:
      "Alchemical outpost that spawns Oasis Spellrunners and sustains nimble desert skirmishers.",
  },
  {
    id: "watchtower",
    name: "Cragrunner Redoubt",
    kind: "structure",
    fluxCost: 72,
    buildSeconds: 2,
    requiredRelayTier: 1,
    requiredSignalCounts: { Vanguard: 1 },
    signalTypes: ["Vanguard"],
    productionSeconds: 22,
    producedSizeClass: "Swarm",
    producedPop: 4,
    producedUnitId: PRODUCED_UNIT_ACROBAT_WARRIOR_SCOUTS,
    localPopCap: 16,
    maxHp: 190,
    damagePerTick: 0,
    maxCharges: 3,
    chargeCooldownSeconds: 10,
    producedFlavor:
      "Cliffside training fortress — spawns Acrobatic Warrior Scouts (fast skirmishers). Assault Drills: rapid-response training.",
  },
  {
    id: "root_bunker",
    name: "Root Bunker",
    kind: "structure",
    fluxCost: 132,
    buildSeconds: 2,
    requiredRelayTier: 1,
    requiredSignalCounts: { Bastion: 1 },
    signalTypes: ["Bastion"],
    productionSeconds: 33,
    producedSizeClass: "Line",
    producedPop: 3,
    localPopCap: 12,
    maxHp: 315,
    damagePerTick: 0,
    maxCharges: 3,
    chargeCooldownSeconds: 14,
    aura: { kind: "turret", radius: 16, value: 0.35 },
    producedFlavor: "Line sentinels (melee, shielded)",
  },
  {
    id: "menders_hut",
    name: "Mender's Hut",
    kind: "structure",
    fluxCost: 128,
    buildSeconds: 2,
    requiredRelayTier: 1,
    requiredSignalCounts: { Reclaim: 1 },
    signalTypes: ["Reclaim"],
    productionSeconds: 34,
    producedSizeClass: "Line",
    producedPop: 3,
    localPopCap: 9,
    maxHp: 250,
    damagePerTick: 0,
    maxCharges: 3,
    chargeCooldownSeconds: 13,
    aura: { kind: "heal_structures", radius: 8, value: 1.5 },
    producedFlavor: "Line medics (heal nearest ally)",
  },
  {
    id: "siege_works",
    name: "Siege Works",
    kind: "structure",
    fluxCost: 205,
    buildSeconds: 2,
    requiredRelayTier: 2,
    requiredSignalCounts: { Vanguard: 2 },
    signalTypes: ["Vanguard", "Vanguard"],
    productionSeconds: 46,
    producedSizeClass: "Heavy",
    producedPop: 2,
    localPopCap: 12,
    maxHp: 470,
    damagePerTick: 0,
    producedAntiClasses: ["Swarm"],
    producedDamageVsStructuresMult: 1.5,
    maxCharges: 2,
    chargeCooldownSeconds: 17,
    producedFlavor: "Heavy rams (ignore 50% building armor)",
    producedUnitId: PRODUCED_UNIT_SIEGE_RAM,
  },
  {
    id: "bastion_keep",
    name: "Rootbound Crag",
    kind: "structure",
    fluxCost: 225,
    buildSeconds: 2,
    requiredRelayTier: 2,
    requiredSignalCounts: { Bastion: 2 },
    signalTypes: ["Bastion", "Bastion"],
    productionSeconds: 50,
    producedSizeClass: "Heavy",
    producedPop: 2,
    localPopCap: 12,
    maxHp: 555,
    damagePerTick: 0,
    producedAntiClasses: ["Swarm"],
    maxCharges: 2,
    chargeCooldownSeconds: 18,
    aura: { kind: "turret", radius: 18, value: 0.6 },
    producedFlavor: "Amber Geode Monks (defensive, impact, anchor)",
    producedUnitId: PRODUCED_UNIT_AMBER_GEODE_MONKS,
  },
  {
    id: "salvage_yard",
    name: "Salvage Yard",
    kind: "structure",
    fluxCost: 122,
    buildSeconds: 2,
    requiredRelayTier: 2,
    requiredSignalCounts: { Reclaim: 2 },
    signalTypes: ["Reclaim", "Reclaim"],
    productionSeconds: 24,
    producedSizeClass: "Swarm",
    producedPop: 4,
    localPopCap: 16,
    maxHp: 275,
    damagePerTick: 0,
    maxCharges: 2,
    chargeCooldownSeconds: 12,
    aura: { kind: "salvage_bonus", radius: 12, value: 0.2 },
    producedFlavor: "Swarm scrappers (fast melee)",
  },
  {
    id: "war_camp",
    name: "War Camp",
    kind: "structure",
    fluxCost: 170,
    buildSeconds: 2,
    requiredRelayTier: 2,
    requiredSignalCounts: { Vanguard: 1, Bastion: 1 },
    signalTypes: ["Vanguard", "Bastion"],
    productionSeconds: 32,
    producedSizeClass: "Line",
    producedPop: 3,
    localPopCap: 12,
    maxHp: 340,
    damagePerTick: 0,
    maxCharges: 2,
    chargeCooldownSeconds: 15,
    aura: { kind: "safe_deploy_radius", radius: 10, value: 1 },
    producedFlavor: "Line soldiers (balanced melee)",
    matchGlobalPopCapBonus: 400,
    structureLocalPopCapBonus: 4,
  },
  {
    id: "raid_nest",
    name: "Raid Nest",
    kind: "structure",
    fluxCost: 145,
    buildSeconds: 2,
    requiredRelayTier: 2,
    requiredSignalCounts: { Vanguard: 1, Reclaim: 1 },
    signalTypes: ["Vanguard", "Reclaim"],
    productionSeconds: 25,
    producedSizeClass: "Swarm",
    producedPop: 4,
    localPopCap: 16,
    maxHp: 260,
    damagePerTick: 0,
    maxCharges: 2,
    chargeCooldownSeconds: 13,
    unitTrait: "lifesteal",
    producedFlavor: "Swarm raiders (heal on kill)",
  },
  {
    id: "root_garden",
    name: "Root Garden",
    kind: "structure",
    fluxCost: 178,
    buildSeconds: 2,
    requiredRelayTier: 2,
    requiredSignalCounts: { Reclaim: 1, Bastion: 1 },
    signalTypes: ["Reclaim", "Bastion"],
    productionSeconds: 34,
    producedSizeClass: "Line",
    producedPop: 3,
    localPopCap: 12,
    maxHp: 330,
    damagePerTick: 0,
    maxCharges: 2,
    chargeCooldownSeconds: 16,
    aura: { kind: "heal_structures", radius: 10, value: 2 },
    producedFlavor: "Line thorns (ranged, poison DoT)",
  },
  {
    id: "dragon_roost",
    name: "Dragon Roost",
    kind: "structure",
    fluxCost: 370,
    buildSeconds: 2,
    requiredRelayTier: 3,
    requiredSignalCounts: { Vanguard: 2 },
    signalTypes: ["Vanguard", "Vanguard"],
    productionSeconds: 76,
    producedSizeClass: "Titan",
    producedPop: 1,
    localPopCap: 8,
    maxHp: 760,
    damagePerTick: 0,
    producedAntiClasses: ["Swarm", "Line"],
    maxCharges: 1,
    chargeCooldownSeconds: 29,
    unitAoeRadius: 3.5,
    unitFlying: true,
    producedFlavor: "Titan wyvern (flying, AoE breath)",
  },
  {
    id: "ironhold_citadel",
    name: "Ironhold Citadel",
    kind: "structure",
    fluxCost: 405,
    buildSeconds: 2,
    requiredRelayTier: 3,
    requiredSignalCounts: { Bastion: 2 },
    signalTypes: ["Bastion", "Bastion"],
    productionSeconds: 84,
    producedSizeClass: "Titan",
    producedPop: 1,
    localPopCap: 8,
    maxHp: 900,
    damagePerTick: 0,
    producedAntiClasses: ["Swarm", "Line"],
    maxCharges: 1,
    chargeCooldownSeconds: 32,
    aura: { kind: "turret", radius: 22, value: 0.95 },
    producedFlavor: "Titan golem (massive HP, slow)",
  },
  {
    id: "verdant_citadel",
    name: "Thornkeep Colossus",
    kind: "structure",
    fluxCost: 320,
    buildSeconds: 2,
    requiredRelayTier: 1,
    signalTypes: [],
    productionSeconds: 68,
    producedSizeClass: "Titan",
    producedPop: 1,
    localPopCap: 8,
    maxHp: 800,
    damagePerTick: 0,
    producedAntiClasses: ["Swarm", "Line"],
    maxCharges: 1,
    chargeCooldownSeconds: 27,
    unitAoeRadius: 3.5,
    producedFlavor: "Living fortress that awakens into a titan and anchors the grove.",
  },
  {
    id: "emberroot_bastion",
    name: "Emberroot Bastion",
    kind: "structure",
    fluxCost: 198,
    buildSeconds: 2,
    requiredRelayTier: 2,
    requiredSignalCounts: { Vanguard: 2 },
    signalTypes: ["Vanguard", "Vanguard"],
    productionSeconds: 38,
    producedSizeClass: "Line",
    producedPop: 3,
    localPopCap: 12,
    maxHp: 410,
    damagePerTick: 0,
    maxCharges: 2,
    chargeCooldownSeconds: 16,
    aura: { kind: "turret", radius: 16, value: 0.38 },
    producedFlavor: "Fire · Caster · Battle monks — volcanic bastion anchors an ember ward.",
    producedUnitId: PRODUCED_UNIT_LAVA_WIZARD_MONKS,
  },
  {
    id: "aionroot_observatory",
    name: "Aionroot Observatory",
    kind: "structure",
    fluxCost: 205,
    buildSeconds: 2,
    requiredRelayTier: 2,
    requiredSignalCounts: { Bastion: 2 },
    signalTypes: ["Bastion", "Bastion"],
    productionSeconds: 42,
    producedSizeClass: "Line",
    producedPop: 3,
    localPopCap: 12,
    maxHp: 430,
    damagePerTick: 0,
    maxCharges: 2,
    chargeCooldownSeconds: 17,
    aura: { kind: "turret", radius: 17, value: 0.32 },
    producedFlavor:
      "Time · Line · Chrono Sentinels — snowbound chronarium steadies nearby squads and holds the rhythm of battle.",
    producedUnitId: PRODUCED_UNIT_CHRONO_SENTINELS,
  },
  {
    id: "reclamation_spire",
    name: "Reclamation Spire",
    kind: "structure",
    fluxCost: 255,
    buildSeconds: 2,
    requiredRelayTier: 3,
    requiredSignalCounts: { Reclaim: 2 },
    signalTypes: ["Reclaim", "Reclaim"],
    productionSeconds: 52,
    producedSizeClass: "Heavy",
    producedPop: 2,
    localPopCap: 12,
    maxHp: 500,
    damagePerTick: 0,
    maxCharges: 1,
    chargeCooldownSeconds: 22,
    salvageRefundFrac: 1,
    producedFlavor: "Heavy wraith (ranged, anti-Titan)",
    producedUnitId: PRODUCED_UNIT_RECLAMATION_WRAITH,
  },
];

const COMMAND_DATA: CommandCatalogEntry[] = [
  {
    id: "recycle",
    name: "Cut Back",
    kind: "command",
    fluxCost: 45,
    requiredRelayTier: 1,
    requiredSignalCounts: { Reclaim: 1 },
    signalTypes: ["Reclaim"],
    salvagePctOnCast: 100,
    maxCharges: 2,
    chargeCooldownSeconds: 12,
    effect: {
      type: "aoe_line_damage",
      length: CUT_LINE_LENGTH,
      halfWidth: CUT_LINE_HALF_WIDTH,
      damage: CUT_LINE_DAMAGE_PER_UNIT,
    },
  },
  {
    id: "fortify",
    name: "Fortify",
    kind: "command",
    fluxCost: 65,
    requiredRelayTier: 1,
    requiredSignalCounts: { Bastion: 1 },
    signalTypes: ["Bastion"],
    salvagePctOnCast: 100,
    maxCharges: 2,
    chargeCooldownSeconds: 14,
    effect: {
      type: "aoe_tactics_field",
      radius: FORTIFY_FIELD_RADIUS,
      durationSeconds: FORTIFY_FIELD_DURATION_SEC,
      allySpeedMult: FORTIFY_FIELD_ALLY_SPEED_MULT,
      allyDamageMult: FORTIFY_FIELD_ALLY_DAMAGE_MULT,
      allyIncomingDamageMult: FORTIFY_FIELD_ALLY_INCOMING_MULT,
      enemySpeedMult: FORTIFY_FIELD_ENEMY_SPEED_MULT,
      enemyDamageMult: FORTIFY_FIELD_ENEMY_DAMAGE_MULT,
      enemyIncomingDamageMult: FORTIFY_FIELD_ENEMY_INCOMING_MULT,
    },
  },
  {
    id: "firestorm",
    name: "Firestorm",
    kind: "command",
    fluxCost: 90,
    requiredRelayTier: 1,
    requiredSignalCounts: { Vanguard: 1 },
    signalTypes: ["Vanguard"],
    salvagePctOnCast: 100,
    maxCharges: 2,
    chargeCooldownSeconds: 16,
    effect: {
      type: "aoe_damage",
      radius: FIRESTORM_RADIUS,
      damage: FIRESTORM_DAMAGE_PER_UNIT,
    },
  },
  {
    id: "shatter",
    name: "Shatter",
    kind: "command",
    fluxCost: 120,
    requiredRelayTier: 2,
    requiredSignalCounts: { Vanguard: 1, Bastion: 1 },
    signalTypes: ["Vanguard", "Bastion"],
    salvagePctOnCast: 100,
    maxCharges: 1,
    chargeCooldownSeconds: 20,
    effect: {
      type: "aoe_shatter_chain",
      castRadius: SHATTER_CAST_RADIUS,
      chainRange: SHATTER_CHAIN_RANGE,
      maxTargets: SHATTER_CHAIN_MAX_TARGETS,
      damage: SHATTER_DAMAGE,
      silenceSeconds: SHATTER_PRODUCTION_PAUSE_SEC,
      chainDamageFalloff: SHATTER_CHAIN_DAMAGE_FALLOFF,
    },
  },
];

export const CATALOG: CatalogEntry[] = [...STRUCTURE_DATA, ...COMMAND_DATA];

export const CATALOG_BY_ID: Record<string, CatalogEntry> = Object.fromEntries(
  CATALOG.map((c) => [c.id, c]),
);

export const STRUCTURES: StructureCatalogEntry[] = CATALOG.filter(isStructureEntry);

export const COMMANDS: CommandCatalogEntry[] = CATALOG.filter(isCommandEntry);

export const COMMAND_BY_ID: Record<string, CommandCatalogEntry> = Object.fromEntries(
  COMMANDS.map((c) => [c.id, c]),
);

/** Default doctrine: empty slots until the player fills them (matches in-match structure-only normalization). */
export const DEFAULT_DOCTRINE_SLOTS: (string | null)[] = Array.from({ length: DOCTRINE_SLOT_COUNT }, () => null);

export function getCatalogEntry(id: string | null | undefined): CatalogEntry | null {
  if (!id) return null;
  return CATALOG_BY_ID[id] ?? null;
}

/**
 * Short "drop on X" hint for command cards — used by the drag tooltip and the
 * compact card caption so players know spells need a target, not empty ground.
 */
export function commandTargetingHint(entry: CommandCatalogEntry): string {
  switch (entry.effect.type) {
    case "aoe_line_damage":
      return "Aim from your Wizard: a long cut sweeps toward where you drop.";
    case "aoe_tactics_field":
      return "Drop on the ground: allies inside move faster and hit harder; enemies are slowed and weakened.";
    case "aoe_shatter_chain":
      return "Drop on the ground: strikes the nearest hostile in the ring, then chain lightning jumps to more targets.";
    case "aoe_damage":
      return "Drop on the ground — burns enemies in the blast ring.";
    case "noop":
      return "Drop anywhere to cast.";
  }
}

/** One-word target label for a command (used as a compact card caption). */
export function commandTargetingLabel(entry: CommandCatalogEntry): string {
  switch (entry.effect.type) {
    case "aoe_line_damage":
      return "Enemy line";
    case "aoe_tactics_field":
      return "Ground zone";
    case "aoe_shatter_chain":
      return "Ground chain";
    case "aoe_damage":
      return "Ground blast";
    case "noop":
      return "Anywhere";
  }
}

/** Visual / effect radius for rendering a command drag ghost, when meaningful. */
export function commandEffectRadius(entry: CommandCatalogEntry): number | null {
  const fx = entry.effect;
  if (fx.type === "aoe_damage") return fx.radius;
  if (fx.type === "aoe_line_damage") return fx.length * 0.5;
  if (fx.type === "aoe_tactics_field") return fx.radius;
  if (fx.type === "aoe_shatter_chain") return fx.castRadius;
  return null;
}

/** When non-null, the in-world command ghost is a line strip from the Wizard toward the cursor. */
export function commandLineGhostPreview(
  entry: CommandCatalogEntry,
): { length: number; halfWidth: number } | null {
  const fx = entry.effect;
  if (fx.type === "aoe_line_damage") return { length: fx.length, halfWidth: fx.halfWidth };
  return null;
}
