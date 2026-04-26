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
    producedPop: 3,
    localPopCap: 12,
    maxHp: KEEP_MAX_HP,
    damagePerTick: 0,
    maxCharges: 0,
    chargeCooldownSeconds: 0,
    producedFlavor: "Permanent wizard base — slowly vents a T1 melee swarm.",
  },
  {
    id: "outpost",
    name: "Outpost",
    kind: "structure",
    fluxCost: 60,
    buildSeconds: 14,
    requiredRelayTier: 1,
    // No requiredSignalCounts — any built relay unlocks this.
    signalTypes: [],
    productionSeconds: 18,
    producedSizeClass: "Line",
    producedPop: 2,
    localPopCap: 6,
    maxHp: 240,
    damagePerTick: 0,
    maxCharges: 3,
    chargeCooldownSeconds: 11,
    producedFlavor: "Generic garrison (no signal requirement)",
  },
  {
    id: "watchtower",
    name: "Watchtower",
    kind: "structure",
    fluxCost: 60,
    buildSeconds: 12,
    requiredRelayTier: 1,
    requiredSignalCounts: { Vanguard: 1 },
    signalTypes: ["Vanguard"],
    productionSeconds: 18,
    producedSizeClass: "Swarm",
    producedPop: 4,
    localPopCap: 8,
    maxHp: 155,
    damagePerTick: 0,
    producedAntiClass: "Heavy",
    maxCharges: 3,
    chargeCooldownSeconds: 10,
    producedFlavor: "Swarm scouts (ranged, fast, fragile)",
  },
  {
    id: "root_bunker",
    name: "Root Bunker",
    kind: "structure",
    fluxCost: 70,
    buildSeconds: 14,
    requiredRelayTier: 1,
    requiredSignalCounts: { Bastion: 1 },
    signalTypes: ["Bastion"],
    productionSeconds: 16,
    producedSizeClass: "Line",
    producedPop: 2,
    localPopCap: 6,
    maxHp: 320,
    damagePerTick: 0,
    producedAntiClass: "Swarm",
    maxCharges: 3,
    chargeCooldownSeconds: 11,
    aura: { kind: "turret", radius: 6, value: 0.8 },
    producedFlavor: "Line sentinels (melee, shielded)",
  },
  {
    id: "menders_hut",
    name: "Mender's Hut",
    kind: "structure",
    fluxCost: 60,
    buildSeconds: 11,
    requiredRelayTier: 1,
    requiredSignalCounts: { Reclaim: 1 },
    signalTypes: ["Reclaim"],
    productionSeconds: 20,
    producedSizeClass: "Line",
    producedPop: 2,
    localPopCap: 4,
    maxHp: 180,
    damagePerTick: 0,
    maxCharges: 3,
    chargeCooldownSeconds: 9,
    aura: { kind: "heal_structures", radius: 8, value: 1.5 },
    producedFlavor: "Line medics (heal nearest ally)",
  },
  {
    id: "siege_works",
    name: "Siege Works",
    kind: "structure",
    fluxCost: 150,
    buildSeconds: 18,
    requiredRelayTier: 2,
    requiredSignalCounts: { Vanguard: 2 },
    signalTypes: ["Vanguard", "Vanguard"],
    productionSeconds: 30,
    producedSizeClass: "Heavy",
    producedPop: 4,
    localPopCap: 8,
    maxHp: 380,
    damagePerTick: 0,
    producedAntiClass: "Line",
    producedDamageVsStructuresMult: 1.5,
    maxCharges: 2,
    chargeCooldownSeconds: 14,
    producedFlavor: "Heavy rams (ignore 50% building armor)",
  },
  {
    id: "bastion_keep",
    name: "Bastion Keep",
    kind: "structure",
    fluxCost: 180,
    buildSeconds: 20,
    requiredRelayTier: 2,
    requiredSignalCounts: { Bastion: 2 },
    signalTypes: ["Bastion", "Bastion"],
    productionSeconds: 28,
    producedSizeClass: "Heavy",
    producedPop: 4,
    localPopCap: 8,
    maxHp: 520,
    damagePerTick: 0,
    producedAntiClass: "Line",
    maxCharges: 2,
    chargeCooldownSeconds: 15,
    aura: { kind: "turret", radius: 7, value: 0.6 },
    producedFlavor: "Heavy knights (high HP melee)",
  },
  {
    id: "salvage_yard",
    name: "Salvage Yard",
    kind: "structure",
    fluxCost: 120,
    buildSeconds: 15,
    requiredRelayTier: 2,
    requiredSignalCounts: { Reclaim: 2 },
    signalTypes: ["Reclaim", "Reclaim"],
    productionSeconds: 16,
    producedSizeClass: "Swarm",
    producedPop: 4,
    localPopCap: 8,
    maxHp: 260,
    damagePerTick: 0,
    producedAntiClass: "Swarm",
    maxCharges: 2,
    chargeCooldownSeconds: 11,
    aura: { kind: "salvage_bonus", radius: 12, value: 0.2 },
    producedFlavor: "Swarm scrappers (fast melee)",
  },
  {
    id: "war_camp",
    name: "War Camp",
    kind: "structure",
    fluxCost: 140,
    buildSeconds: 16,
    requiredRelayTier: 2,
    requiredSignalCounts: { Vanguard: 1, Bastion: 1 },
    signalTypes: ["Vanguard", "Bastion"],
    productionSeconds: 14,
    producedSizeClass: "Line",
    producedPop: 2,
    localPopCap: 8,
    maxHp: 300,
    damagePerTick: 0,
    producedAntiClass: "Heavy",
    maxCharges: 2,
    chargeCooldownSeconds: 13,
    aura: { kind: "safe_deploy_radius", radius: 10, value: 1 },
    producedFlavor: "Line soldiers (balanced melee)",
    matchGlobalPopCapBonus: 400,
    structureLocalPopCapBonus: 4,
  },
  {
    id: "raid_nest",
    name: "Raid Nest",
    kind: "structure",
    fluxCost: 130,
    buildSeconds: 15,
    requiredRelayTier: 2,
    requiredSignalCounts: { Vanguard: 1, Reclaim: 1 },
    signalTypes: ["Vanguard", "Reclaim"],
    productionSeconds: 15,
    producedSizeClass: "Swarm",
    producedPop: 4,
    localPopCap: 8,
    maxHp: 240,
    damagePerTick: 0,
    producedAntiClass: "Swarm",
    maxCharges: 2,
    chargeCooldownSeconds: 12,
    unitTrait: "lifesteal",
    producedFlavor: "Swarm raiders (heal on kill)",
  },
  {
    id: "root_garden",
    name: "Root Garden",
    kind: "structure",
    fluxCost: 130,
    buildSeconds: 16,
    requiredRelayTier: 2,
    requiredSignalCounts: { Reclaim: 1, Bastion: 1 },
    signalTypes: ["Reclaim", "Bastion"],
    productionSeconds: 18,
    producedSizeClass: "Line",
    producedPop: 2,
    localPopCap: 6,
    maxHp: 280,
    damagePerTick: 0,
    producedAntiClass: "Line",
    maxCharges: 2,
    chargeCooldownSeconds: 13,
    aura: { kind: "heal_structures", radius: 10, value: 2 },
    producedFlavor: "Line thorns (ranged, poison DoT)",
  },
  {
    id: "dragon_roost",
    name: "Dragon Roost",
    kind: "structure",
    fluxCost: 280,
    buildSeconds: 22,
    requiredRelayTier: 3,
    requiredSignalCounts: { Vanguard: 2 },
    signalTypes: ["Vanguard", "Vanguard"],
    productionSeconds: 50,
    producedSizeClass: "Titan",
    producedPop: 8,
    localPopCap: 8,
    maxHp: 640,
    damagePerTick: 0,
    producedAntiClass: "Swarm",
    maxCharges: 1,
    chargeCooldownSeconds: 28,
    unitAoeRadius: 3.5,
    unitFlying: true,
    producedFlavor: "Titan wyvern (flying, AoE breath)",
  },
  {
    id: "ironhold_citadel",
    name: "Ironhold Citadel",
    kind: "structure",
    fluxCost: 300,
    buildSeconds: 24,
    requiredRelayTier: 3,
    requiredSignalCounts: { Bastion: 2 },
    signalTypes: ["Bastion", "Bastion"],
    productionSeconds: 55,
    producedSizeClass: "Titan",
    producedPop: 8,
    localPopCap: 8,
    maxHp: 780,
    damagePerTick: 0,
    producedAntiClass: "Heavy",
    maxCharges: 1,
    chargeCooldownSeconds: 30,
    aura: { kind: "turret", radius: 8, value: 1.2 },
    producedFlavor: "Titan golem (massive HP, slow)",
  },
  {
    id: "reclamation_spire",
    name: "Reclamation Spire",
    kind: "structure",
    fluxCost: 250,
    buildSeconds: 22,
    requiredRelayTier: 3,
    requiredSignalCounts: { Reclaim: 2 },
    signalTypes: ["Reclaim", "Reclaim"],
    productionSeconds: 35,
    producedSizeClass: "Heavy",
    producedPop: 4,
    localPopCap: 8,
    maxHp: 440,
    damagePerTick: 0,
    producedAntiClass: "Titan",
    maxCharges: 1,
    chargeCooldownSeconds: 26,
    salvageRefundFrac: 1,
    producedFlavor: "Heavy wraith (ranged, anti-Titan)",
  },
];

const COMMAND_DATA: CommandCatalogEntry[] = [
  {
    id: "recycle",
    name: "Cut Back",
    kind: "command",
    fluxCost: 40,
    requiredRelayTier: 1,
    requiredSignalCounts: { Reclaim: 1 },
    signalTypes: ["Reclaim"],
    salvagePctOnCast: 100,
    maxCharges: 2,
    chargeCooldownSeconds: 11,
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
    fluxCost: 60,
    requiredRelayTier: 1,
    requiredSignalCounts: { Bastion: 1 },
    signalTypes: ["Bastion"],
    salvagePctOnCast: 100,
    maxCharges: 2,
    chargeCooldownSeconds: 13,
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
    fluxCost: 80,
    requiredRelayTier: 1,
    requiredSignalCounts: { Vanguard: 1 },
    signalTypes: ["Vanguard"],
    salvagePctOnCast: 100,
    maxCharges: 2,
    chargeCooldownSeconds: 15,
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
    fluxCost: 100,
    requiredRelayTier: 2,
    requiredSignalCounts: { Vanguard: 1, Bastion: 1 },
    signalTypes: ["Vanguard", "Bastion"],
    salvagePctOnCast: 100,
    maxCharges: 1,
    chargeCooldownSeconds: 18,
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
