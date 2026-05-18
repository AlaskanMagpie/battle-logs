export type TeamId = "player" | "enemy";

export type SignalType = "Vanguard" | "Bastion" | "Reclaim";

export type UnitSizeClass = "Swarm" | "Line" | "Heavy" | "Titan";
export type UnitFormationKind = "line" | "wedge" | "arc";

export type DoctrineEntryKind = "structure" | "command";

export type GamePhase = "playing" | "win" | "lose" | "draw";

export interface Vec2 {
  x: number;
  z: number;
}

/** Optional layout hint for tooling / validation (gameplay ignores). */
export type TapNodeRole = "home" | "lane" | "flank" | "contested" | "forward" | "neutral";

export interface TapSlotDef {
  id: string;
  x: number;
  z: number;
  role?: TapNodeRole;
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
  /** Master AI pressure knob. Values below 1 slow and soften the enemy. Defaults to 0.6. */
  enemyEffectivenessMult?: number;
  /** Legacy health multiplier from authored maps; composed with `enemyEffectivenessMult`. */
  enemyHpMult?: number;
  /** Legacy damage multiplier from authored maps; composed with `enemyEffectivenessMult`. */
  enemyDmgMult?: number;
  enemyDamageMult?: number;
  enemyAttackSpeedMult?: number;
  enemyCaptureSpeedMult?: number;
  enemyBuildSpeedMult?: number;
  enemyEconomyMult?: number;
  enemyProductionSpeedMult?: number;
}

/** Optional biome read for renderer + tooling; sim still uses `blocksMovement` + shape for collision. */
export type MapTerrainKind =
  | "lake"
  | "hill"
  | "rock_spire"
  | "mesa_slab"
  | "basalt"
  | "ice"
  | "metal"
  | "timber"
  | "ruins"
  | "crystal"
  | "lava"
  | "foliage"
  | "bridge";

/** Visual style for `kind: "foliage"` clusters (non-blocking by default). */
export type MapFoliageStyle = "bush" | "tree" | "pine" | "palm" | "scrub";

/** Optional on any decor: when true, ground units / wizards cannot walk through this shape (sim). */
type MapDecorBlock = { blocksMovement?: boolean; terrainKind?: MapTerrainKind };

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
      rotYDeg?: number;
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
    } & MapDecorBlock)
  | ({
      kind: "water_basin";
      x: number;
      z: number;
      /** Ellipse semi-axis along local X (after `rotYDeg`). */
      radiusX: number;
      /** Ellipse semi-axis along local Z. */
      radiusZ: number;
      rotYDeg?: number;
      h?: number;
      color?: number;
    } & MapDecorBlock)
  | ({
      kind: "bridge";
      x: number;
      z: number;
      /** Deck length along local Z. */
      span: number;
      width: number;
      rotYDeg?: number;
      h?: number;
      color?: number;
    } & MapDecorBlock)
  | ({
      kind: "foliage";
      x: number;
      z: number;
      radius: number;
      style?: MapFoliageStyle;
      rotYDeg?: number;
      h?: number;
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

export type WorldGeometryMode = "plane" | "sphere";

/** Procedural radial hills/valleys on `worldGeometry: "sphere"` when no `terrainGlbUrl` is used. */
export interface SphereTerrainDef {
  /** When false, the shell is a smooth sphere. Defaults to enabled on sphere maps. */
  enabled?: boolean;
  /** Peak radial displacement in world units. */
  amplitude?: number;
  /** Integer seed for reproducible noise. */
  seed?: number;
  /** fBM octaves in the range 1–6. */
  octaves?: number;
  /** Spatial scale of macro landforms (higher = larger features). */
  macroScale?: number;
}

/** Playable XZ footprint on plane maps (optional; default is full square `halfExtents`). */
export type MapArenaFootprintKind =
  | "rectangle"
  | "circle"
  | "ellipse"
  | "diamond"
  | "capsule_x"
  | "capsule_z"
  | "twin_lobes";

export interface MapArenaFootprint {
  kind?: MapArenaFootprintKind;
  /** Circle / spherical-cap style radius as a fraction of `halfExtents`. Default 1. */
  radiusMult?: number;
  /** Ellipse / diamond semi-axis along X as a fraction of `halfExtents`. Default 1. */
  semiAxisXMult?: number;
  /** Ellipse / diamond semi-axis along Z as a fraction of `halfExtents`. Default 1. */
  semiAxisZMult?: number;
  /** Capsule: half-length of the straight section + cap (along major axis), as fraction of `halfExtents`. */
  capsuleLengthMult?: number;
  /** Capsule: tube radius as a fraction of `halfExtents`. */
  capsuleRadiusMult?: number;
  /** Twin lobes: lobe center offset along ±X as a fraction of `halfExtents`. */
  lobeCenterMult?: number;
  /** Twin lobes: each lobe radius as a fraction of `halfExtents`. */
  lobeRadiusMult?: number;
}

export interface MapWorldDef {
  halfExtents: number;
  groundY: number;
  /** Non-square playable region on plane maps (optional). */
  arenaFootprint?: MapArenaFootprint;
  /** Planet radius (world units). Required when `worldGeometry` is `sphere`. */
  sphereRadius?: number;
  /** Optional procedural terrain on the sphere shell. */
  sphereTerrain?: SphereTerrainDef;
}

export interface MapData {
  version: number;
  /** Defaults to `plane` when omitted (legacy maps). */
  worldGeometry?: WorldGeometryMode;
  world: MapWorldDef;
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

/** Melee / breath / artillery reach bucket for combat FX. */
export type AttackRangeBand = "close" | "medium" | "long";

/** Renderer-facing spell school. Gameplay still lives in `CommandEffect`; this is the visual language. */
export const SPELL_FX_ELEMENTS = [
  "fire",
  "lightning",
  "earth",
  "water",
  "air",
  "lava",
  "snow",
  "arcane",
  "reclaim",
  "shield",
] as const;

export type SpellFxElement =
  (typeof SPELL_FX_ELEMENTS)[number];

export const ELEMENTAL_FX_REQUIRED_SHAPES = ["line", "cone", "aoe", "impact", "surprise"] as const;

export type ElementalFxRequiredShape = (typeof ELEMENTAL_FX_REQUIRED_SHAPES)[number];

/** Renderer-facing spell silhouette. Keeps range/shape readable even when damage rules differ. */
export type SpellFxShape =
  | "aoe"
  | "bolt"
  | "chain"
  | "cone"
  | "beam"
  | "line"
  | "field"
  | "meteor"
  | "impact"
  | "burst"
  | "surprise";

/** Optional per-cast palette remap for spell/liquid shader coloring. */
export interface SpellFxColorTint {
  core?: number;
  hot?: number;
  rim?: number;
  trail?: number;
  shadow?: number;
}

/**
 * Spawn/visual profile for units from this structure (`glbPool` animationProfiles id).
 * When omitted, runtime uses size-class defaults only.
 */
export type ProducedUnitId = string;

export type EquipmentSlot = "leftHand" | "rightHand" | "back";

export interface UnitEquipmentTransform {
  position?: readonly [number, number, number];
  rotation?: readonly [number, number, number];
  scale?: number | readonly [number, number, number];
}

export interface UnitEquipmentStatModifiers {
  rangeAdd?: number;
  rangeMult?: number;
  dmgPerTickAdd?: number;
  dmgPerTickMult?: number;
  trait?: UnitTrait;
  aoeRadiusAdd?: number;
  aoeRadiusSet?: number;
  damageVsStructuresMult?: number;
}

export interface UnitEquipmentItemDef {
  id: string;
  name: string;
  /** GLB file name under `/assets/units/`, or a root-relative URL beginning with `/`. */
  glb: string;
  slot?: EquipmentSlot;
  stats?: UnitEquipmentStatModifiers;
  transform?: UnitEquipmentTransform;
}

export type UnitEquipmentLoadout = Partial<Record<EquipmentSlot, UnitEquipmentItemDef>>;
export type UnitEquipmentLoadoutDef = Partial<Record<EquipmentSlot, string | UnitEquipmentItemDef | null>>;

export interface StructureCatalogEntry {
  id: string;
  name: string;
  kind: "structure";
  fluxCost: number;
  buildSeconds: number;
  /** Deprecated/back-compat only: progression is resource based. */
  requiredRelayTier?: number;
  /** Deprecated/back-compat only: progression is resource based. */
  requiredSignalCounts?: SignalCountRequirement;
  /** Structure's own signal tags (UI / future hybrid rules). */
  signalTypes: SignalType[];
  productionSeconds: number;
  producedSizeClass: UnitSizeClass;
  /** Optional GLB/visual identity for produced squads (see `UnitRuntime.producedUnitId`). */
  producedUnitId?: ProducedUnitId;
  /** Optional equipment props/stat modifiers copied to produced units. Omitted means no equipment. */
  equipmentLoadout?: UnitEquipmentLoadoutDef;
  producedPop: number;
  localPopCap: number;
  maxHp: number;
  /** Deprecated: generic tick damage. Prefer `aura.kind === "turret"`. Kept for legacy. */
  damagePerTick: number;
  /** +50% damage vs this enemy size class when set. Back-compat single-tag form. */
  producedAntiClass?: UnitSizeClass;
  /** +50% damage vs each listed enemy size class. Preferred over `producedAntiClass`. */
  producedAntiClasses?: UnitSizeClass[];
  maxCharges: number;
  /** Legacy catalog field — doctrine slots no longer use a recharge timer; repeat plays are Mana-only. */
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
  /** Multiplies the produced unit's class movement speed. */
  producedSpeedMult?: number;
  /** Flavor: what the structure produces (UI copy only). */
  producedFlavor?: string;
  /** Extra damage multiplier when this structure's units attack enemy structures (e.g. Siege Works). */
  producedDamageVsStructuresMult?: number;
  /** Added to `GLOBAL_POP_CAP` for this match when this card is in the doctrine loadout (prematch binder). */
  matchGlobalPopCapBonus?: number;
  /** Added to this spawner's local pop cap once the structure finishes building. */
  structureLocalPopCapBonus?: number;
}

export type CommandEffect =
  | { type: "aoe_line_damage"; length: number; halfWidth: number; damage: number }
  | { type: "aoe_damage"; radius: number; damage: number }
  | {
      type: "aoe_tactics_field";
      radius: number;
      durationSeconds: number;
      allySpeedMult: number;
      allyDamageMult: number;
      allyIncomingDamageMult: number;
      enemySpeedMult: number;
      enemyDamageMult: number;
      enemyIncomingDamageMult: number;
    }
  | {
      type: "aoe_shatter_chain";
      castRadius: number;
      chainRange: number;
      maxTargets: number;
      damage: number;
      silenceSeconds: number;
      chainDamageFalloff: number;
    }
  | { type: "noop" };

export interface CommandCatalogEntry {
  id: string;
  name: string;
  kind: "command";
  fluxCost: number;
  /** Deprecated/back-compat only: progression is resource based. */
  requiredRelayTier?: number;
  requiredSignalCounts?: SignalCountRequirement;
  signalTypes: SignalType[];
  /** 100 = all spell cost goes to Salvage pool (PRD). */
  salvagePctOnCast: number;
  maxCharges: number;
  /** Legacy catalog field — doctrine slots no longer use a recharge timer; repeat casts are Mana-only. */
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
