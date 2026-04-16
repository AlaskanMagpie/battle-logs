export type TeamId = "player" | "enemy";

export type SignalType = "Vanguard" | "Bastion" | "Reclaim";

export type UnitSizeClass = "Swarm" | "Line" | "Heavy" | "Titan";

export type DoctrineEntryKind = "structure" | "command";

export type GamePhase = "playing" | "win" | "lose";

export interface Vec2 {
  x: number;
  z: number;
}

export interface TapSlotDef {
  id: string;
  x: number;
  z: number;
}

export interface RelaySlotDef {
  id: string;
  x: number;
  z: number;
}

export interface EnemyCampDef {
  id: string;
  origin: Vec2;
  aggroRadius: number;
  wakeRadius: number;
  /** Optional scenario objective: destroy this HP pool at camp origin to help win. */
  coreMaxHp?: number;
  /** Initial sleeping defenders spawned near this camp's origin (default 5). */
  initialUnitCount?: number;
}

export interface MapData {
  version: number;
  world: { halfExtents: number; groundY: number };
  tapSlots: TapSlotDef[];
  playerRelaySlots: RelaySlotDef[];
  enemyRelaySlots: RelaySlotDef[];
  playerStart: Vec2;
  enemyCamps: EnemyCampDef[];
  decor?: unknown[];
}

/** Minimum built relays of each signal type (count relays whose `signalTypes` includes that type). */
export type SignalCountRequirement = Partial<Record<SignalType, number>>;

export interface StructureCatalogEntry {
  id: string;
  name: string;
  kind: "structure";
  fluxCost: number;
  buildSeconds: number;
  /** Minimum player relays built (tier). */
  requiredRelayTier: number;
  /** Require this many active signals of each type from built Relays. */
  requiredSignalCounts?: SignalCountRequirement;
  /** Structure's own signal tags (UI / future hybrid rules). */
  signalTypes: SignalType[];
  productionSeconds: number;
  producedSizeClass: UnitSizeClass;
  producedPop: number;
  localPopCap: number;
  maxHp: number;
  damagePerTick: number;
  /** +50% damage vs this enemy size class when set. */
  producedAntiClass?: UnitSizeClass;
  maxCharges: number;
  chargeCooldownSeconds: number;
  /** If set with damagePerTick > 0, structure fires at enemies in this radius (world units). */
  turretRange?: number;
  /** Extra damage multiplier when this structure's units attack enemy structures (e.g. Siege Works). */
  producedDamageVsStructuresMult?: number;
}

export type CommandEffect =
  | { type: "recycle_structure" }
  | { type: "fortify_structure" }
  | { type: "firestorm_aoe" }
  | { type: "muster_production" }
  | { type: "shatter_enemy" }
  | { type: "noop" };

export interface CommandCatalogEntry {
  id: string;
  name: string;
  kind: "command";
  fluxCost: number;
  requiredRelayTier: number;
  requiredSignalCounts?: SignalCountRequirement;
  signalTypes: SignalType[];
  /** 100 = all spell cost goes to Salvage pool (PRD). */
  salvagePctOnCast: number;
  maxCharges: number;
  chargeCooldownSeconds: number;
  effect: CommandEffect;
}

export type CatalogEntry = StructureCatalogEntry | CommandCatalogEntry;

export function isStructureEntry(e: CatalogEntry): e is StructureCatalogEntry {
  return e.kind === "structure";
}

export function isCommandEntry(e: CatalogEntry): e is CommandCatalogEntry {
  return e.kind === "command";
}

export interface DoctrineSlotDef {
  index: number;
  catalogId: string | null;
}
