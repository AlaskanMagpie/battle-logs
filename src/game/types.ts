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
  /** Optional per-camp roster overriding default. Each entry is one hostile unit. */
  roster?: { sizeClass: UnitSizeClass; offset: Vec2 }[];
  /** Optional scenario objective: destroy this HP pool at camp origin to help win. */
  coreMaxHp?: number;
  /** Initial sleeping defenders spawned near this camp's origin when no roster is given. */
  initialUnitCount?: number;
}

export interface MapDifficulty {
  enemyHpMult: number;
  enemyDmgMult: number;
}

/** Optional on any decor: when true, ground units / wizards cannot walk through this shape (sim). */
type MapDecorBlock = { blocksMovement?: boolean };

export type MapDecorDef =
  | ({
      kind: "box";
      x: number;
      z: number;
      w: number;
      h: number;
      d: number;
      rotYDeg?: number;
      color?: number;
    } & MapDecorBlock)
  | ({
      kind: "cylinder";
      x: number;
      z: number;
      radius: number;
      h: number;
      color?: number;
    } & MapDecorBlock)
  | ({
      kind: "sphere";
      x: number;
      z: number;
      radius: number;
      /** Center Y; defaults to `radius` so the sphere sits on the ground. */
      y?: number;
      color?: number;
    } & MapDecorBlock)
  | ({
      kind: "cone";
      x: number;
      z: number;
      radius: number;
      h: number;
      rotYDeg?: number;
      color?: number;
    } & MapDecorBlock)
  | ({
      kind: "torus";
      x: number;
      z: number;
      /** Major radius of the ring. */
      radius: number;
      /** Tube thickness. */
      tube: number;
      rotYDeg?: number;
      color?: number;
    } & MapDecorBlock);

/** Ground appearance for the default plane (ignored when `terrainGlbUrl` loads). */
export type MapGroundPreset = "solid" | "ember_wastes" | "glacier_grid" | "mesa_band";

export interface MapVisualSettings {
  groundPreset?: MapGroundPreset;
  /** Ignored by the renderer (grid removed); kept for older map JSON. */
  showGrid?: boolean;
  /** Exponential fog color (hex, e.g. 0x0e1116). */
  fogHex?: number;
  fogNear?: number;
  fogFar?: number;
  /** Hemisphere sky color (hex). */
  skyHex?: number;
  /** Directional light color (hex). */
  sunHex?: number;
}

export interface MapData {
  version: number;
  world: { halfExtents: number; groundY: number };
  tapSlots: TapSlotDef[];
  playerRelaySlots: RelaySlotDef[];
  enemyRelaySlots: RelaySlotDef[];
  playerStart: Vec2;
  /** Spawn for the AI enemy wizard; if omitted, code mirrors `playerStart` across the origin. */
  enemyStart?: Vec2;
  enemyCamps: EnemyCampDef[];
  difficulty?: MapDifficulty;
  decor?: MapDecorDef[];
  /** Optional id for tooling / UI (e.g. `forgewarden`). */
  mapId?: string;
  /** Renderer: ground shader, fog, lighting tweaks. */
  visual?: MapVisualSettings;
  /**
   * When true, `tapSlots` from this map file are used as Mana node positions instead of
   * procedural `generateProceduralTaps` (editor / hand-authored layouts).
   */
  useAuthorTapSlots?: boolean;
  /**
   * Optional site-root URL for custom terrain (e.g. `/terrain/arena.glb`). When set, the
   * renderer loads this mesh for raycasts and hides the default ground plane.
   */
  terrainGlbUrl?: string;
}

/** Minimum built relays of each signal type (count relays whose `signalTypes` includes that type). */
export type SignalCountRequirement = Partial<Record<SignalType, number>>;

export type StructureAuraKind =
  | "heal_structures"
  | "salvage_bonus"
  | "turret"
  | "safe_deploy_radius";

export interface StructureAura {
  kind: StructureAuraKind;
  radius: number;
  /** Damage/tick for turret, hp/sec for heal, fractional bonus for salvage (+0.2 = +20%), unused for safe_deploy. */
  value: number;
}

export type UnitTrait = "lifesteal";

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
  /** Deprecated: generic tick damage. Prefer `aura.kind === "turret"`. Kept for legacy. */
  damagePerTick: number;
  /** +50% damage vs this enemy size class when set. */
  producedAntiClass?: UnitSizeClass;
  maxCharges: number;
  chargeCooldownSeconds: number;
  /** Data-driven structure effect applied while alive. */
  aura?: StructureAura;
  /** Per-structure salvage refund override (0..1). Default resolves via constants. */
  salvageRefundFrac?: number;
  /** Trait applied to units produced by this structure. */
  unitTrait?: UnitTrait;
  /** Produced unit's AoE radius (world units). 0 / undefined = single-target. */
  unitAoeRadius?: number;
  /** Produced unit ignores ground collision / walks over obstacles (flying). */
  unitFlying?: boolean;
  /** Flavor: what the structure produces (UI copy only). */
  producedFlavor?: string;
  /** Extra damage multiplier when this structure's units attack enemy structures (e.g. Siege Works). */
  producedDamageVsStructuresMult?: number;
}

export type CommandEffect =
  | { type: "recycle_structure" }
  | { type: "aoe_damage"; radius: number; damage: number }
  | { type: "buff_structure"; damageReductionPct: number; durationSeconds: number }
  | { type: "shatter_structure"; damage: number; silenceSeconds: number }
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
