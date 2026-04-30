import { DEFAULT_DOCTRINE_SLOTS, getCatalogEntry } from "./catalog";
import { logGame } from "./gameLog";
import {
  DOCTRINE_COMMANDS_ENABLED,
  DOCTRINE_SLOT_COUNT,
  ENEMY_CAMP_INITIAL_DEFENDER_CAP,
  ENEMY_RELAY_MAX_HP,
  FORWARD_PLACE_RADIUS,
  HERO_FOLLOW_RADIUS,
  HERO_MAX_HP,
  HERO_MAP_OBSTACLE_RADIUS,
  HERO_SPAWN_FORWARD_FROM_KEEP,
  HERO_SPAWN_SIDE_FROM_KEEP,
  HERO_SPEED,
  HERO_TELEPORT_COOLDOWN_SEC,
  STRUCTURE_MAP_OBSTACLE_RADIUS,
  INFRA_PLACE_RADIUS,
  KEEP_ID,
  KEEP_MAX_HP,
  KEEP_SWARM_PERIOD_SEC,
  PLAYER_STARTING_FLUX,
  TAP_ANCHOR_MAX_HP,
  TAP_GENERATION_MIN_SEP,
  TAP_NODES_PER_SIDE,
  TERRITORY_RADIUS,
  TICK_HZ,
  GLOBAL_POP_CAP,
  GLOBAL_POP_CAP_MAX,
  ATTACK_RANGE_CLOSE_MAX,
  ATTACK_RANGE_MEDIUM_MAX,
} from "./constants";
import { enemyDamageScalar, enemyHpScalar, normalizeMapDifficulty } from "./difficulty";
import { unitStatsForCatalog } from "./sim/systems/helpers";
import type {
  AttackRangeBand,
  CatalogEntry,
  GamePhase,
  MapData,
  ProducedUnitId,
  SignalType,
  SpellFxElement,
  SpellFxShape,
  TeamId,
  TapSlotDef,
  UnitFormationKind,
  UnitSizeClass,
  UnitTrait,
  Vec2,
} from "./types";
import { isCommandEntry, isStructureEntry } from "./types";
import { circleOverlapsMapObstacles, resolveCircleAgainstMapObstacles } from "./mapObstacles";
import { structureObstacleFootprints } from "./structureObstacles";

export type CastFxKind =
  | "firestorm"
  | "shatter"
  | "fortify"
  | "muster"
  | "line_cleave"
  | "claim"
  | "lightning"
  | "hero_strike"
  | "spark_burst"
  | "ground_crack"
  | "reclaim_pulse"
  | "death_flash"
  | "combat_boom"
  | "elemental_spell";

/** One throttled combat telegraph: wedge rooted on attacker, opening toward target. */
export interface CombatHitMark {
  /** Runtime id of the unit that committed this hit (for attack animation triggers). */
  attackerId?: number;
  /** When set, renderer may swap wedge FX (e.g. geode monks → traveling ring shock). */
  producedUnitId?: ProducedUnitId;
  ax: number;
  az: number;
  tx: number;
  tz: number;
  /** Weapon reach used to cap wedge length (world units). */
  range: number;
  /** Wider cone for breath-style AoE attackers. */
  wide: boolean;
  team: TeamId;
  sizeClass: UnitSizeClass;
  /** Inherited from producer structure — drives elemental hue. */
  signal?: SignalType;
  /** Stable per-unit hash for FX variety (spark seeds, fork count). */
  visualSeed: number;
  trait?: UnitTrait;
  /** Reach bucket for layered zap / cone / boom reads in the renderer. */
  rangeBand?: AttackRangeBand;
}

/** Wizard melee burst palette (both heroes). */
export type HeroStrikeFxVariant =
  | "player_vs_unit"
  | "player_arcane_sweep"
  | "player_vs_rival"
  | "player_vs_fortress"
  | "player_vs_structure"
  | "player_vs_anchor"
  | "rival_vs_hero"
  | "rival_vs_unit"
  | "rival_vs_anchor"
  | "rival_vs_keep";

export interface CastFxEvent {
  kind: CastFxKind;
  x: number;
  z: number;
  tick: number;
  /** Strike origin (wizard xz) — when set, renderer draws a bolt from here to (x,z). */
  fromX?: number;
  fromZ?: number;
  /** When `kind === "hero_strike"`, picks elemental cone + bolt colors. */
  strikeVariant?: HeroStrikeFxVariant;
  /** Ground boom / shock disc radius for `combat_boom` and similar. */
  impactRadius?: number;
  rangeBand?: AttackRangeBand;
  /** Optional renderer-only element/shape profile for reusable spell FX. */
  element?: SpellFxElement;
  secondaryElement?: SpellFxElement;
  shape?: SpellFxShape;
  /** Optional spell reach/width in world units. Falls back to impact radius / origin distance. */
  reach?: number;
  width?: number;
  visualSeed?: number;
}

/** Arcane strike / rival strike FX: impact at `target`, optional bolt from `from`. */
const FX_QUEUE_CAP = 48;

/** Classify weapon reach for combat FX (close / medium / long). */
export function classifyAttackRangeBand(range: number): AttackRangeBand {
  if (range <= ATTACK_RANGE_CLOSE_MAX) return "close";
  if (range <= ATTACK_RANGE_MEDIUM_MAX) return "medium";
  return "long";
}

/** Queue a cast / spell / proc FX event (multiple per tick supported). */
export function pushFx(s: GameState, evt: Omit<CastFxEvent, "tick"> & { tick?: number }): void {
  const tick = evt.tick ?? s.tick;
  if (s.fxQueue.length >= FX_QUEUE_CAP) s.fxQueue.shift();
  s.fxQueue.push({ ...evt, tick } as CastFxEvent);
}

export function emitHeroStrikeFx(
  s: GameState,
  target: Vec2,
  from: Vec2,
  strikeVariant: HeroStrikeFxVariant,
  visualSeed?: number,
): void {
  pushFx(s, {
    kind: "hero_strike",
    x: target.x,
    z: target.z,
    fromX: from.x,
    fromZ: from.z,
    strikeVariant,
    visualSeed,
  });
}

export type ArmyStance = "offense" | "defense";

export interface TapRuntime {
  defId: string;
  x: number;
  z: number;
  active: boolean;
  yieldRemaining: number;
  /** Ownership: "player" once the hero claims, unset otherwise. */
  ownerTeam?: TeamId;
  /**
   * Claim anchor pillar — present while `active`; at 0 HP the node reverts to neutral (re-channel to claim).
   */
  anchorHp?: number;
  anchorMaxHp?: number;
  claimTeam?: TeamId;
  claimTicksRemaining?: number;
}

/** Instantly spawn full anchor HP when a wizard finishes claiming a node. */
export function armTapClaimAnchor(tap: TapRuntime): void {
  tap.anchorMaxHp = TAP_ANCHOR_MAX_HP;
  tap.anchorHp = TAP_ANCHOR_MAX_HP;
}

/** Strip claim and yield when the anchor is destroyed. */
export function shatterTapAnchor(s: GameState, tap: TapRuntime): void {
  if (!tap.active) return;
  const wasPlayer = tap.ownerTeam === "player";
  tap.active = false;
  tap.ownerTeam = undefined;
  tap.anchorHp = undefined;
  tap.anchorMaxHp = undefined;
  tap.yieldRemaining = 0;
  s.lastMessage = wasPlayer
    ? "Your Mana anchor was destroyed — that node is neutral again."
    : "Enemy Mana anchor destroyed — the node can be claimed again.";
  logGame("claim", `Mana node ${tap.defId} anchor shattered`, s.tick);
}

export interface HeroRuntime {
  x: number;
  z: number;
  /** Move target in world; null when idle. */
  targetX: number | null;
  targetZ: number | null;
  /** After the current `targetX/Z`, visit these in order (player hero only; cleared on replace / WASD / claim). */
  moveWaypoints: Vec2[];
  speedPerSec: number;
  /** Follow-aura pickup radius. */
  radius: number;
  /** Index into state.taps currently being claimed, or null. */
  claimChannelTarget: number | null;
  claimChannelTicksRemaining: number;
  hp: number;
  maxHp: number;
  facing: number;
  /** World X impulse from WASD this tick (camera-relative or legacy axis); cleared after sim. */
  wasdStrafe: number;
  /** World Z impulse from WASD this tick; cleared after sim. */
  wasdForward: number;
  attackCooldownTicksRemaining: number;
  /** Monotonic cast counter used only for hero strike visual variety. */
  strikeSequence: number;
  /**
   * Doctrine spell queued same tick — `heroSystem` applies facing toward this world point **after**
   * movement so locomotion does not overwrite cast aim (intents run before movement).
   */
  spellFacingToward?: { x: number; z: number };
}

export interface EnemyRelayRuntime {
  defId: string;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  /** Prod-silence on Shatter (tick at which silence ends). */
  silencedUntilTick: number;
}

export interface StructureRuntime {
  id: number;
  team: TeamId;
  catalogId: string;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  buildTicksRemaining: number;
  buildTotalTicks: number;
  complete: boolean;
  productionTicksRemaining: number;
  doctrineSlotIndex: number;
  rallyX: number;
  rallyZ: number;
  /** True if placed via forward placement (not near Tap/Keep). */
  placementForward: boolean;
  /** Fortify damage reduction end tick (0 if inactive). */
  damageReductionUntilTick: number;
  /** Production silence end tick (Shatter). */
  productionSilenceUntilTick: number;
  /** Hold orders — produced units don't advance to rally, only engage foes in range. */
  holdOrders: boolean;
  /** Extra local pop cap from catalog `structureLocalPopCapBonus` applied when build completes. */
  localPopCapBonus: number;
}

export interface UnitRuntime {
  id: number;
  team: TeamId;
  structureId: number | null;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  sizeClass: UnitSizeClass;
  /** GLB animation profile id when spawned from a structure with `StructureCatalogEntry.producedUnitId`. */
  producedUnitId?: ProducedUnitId;
  /** Number of visual/combat models represented by this shared-movement squad. */
  squadCount?: number;
  /** Original squad size for display/stat accounting. */
  squadMaxCount?: number;
  /** HP for one model inside this squad; live count degrades as pooled HP crosses this threshold. */
  singleMaxHp?: number;
  pop: number;
  speedPerSec: number;
  range: number;
  dmgPerTick: number;
  visualSeed: number;
  /** +50% damage bonus applies when the defender class is in this set. */
  antiClasses?: UnitSizeClass[];
  /** Back-compat single-target anti tag; mirrored into `antiClasses` at spawn time. */
  antiClass?: UnitSizeClass;
  trait?: UnitTrait;
  aoeRadius?: number;
  flying?: boolean;
  /** Signal inherited from parent structure (for coloring). */
  signal?: SignalType;
  /** Bonus vs enemy relays / structures (Siege Works). Default 1 when unset. */
  damageVsStructuresMult?: number;
  order?: UnitOrderRuntime;
  /** Internal autonomous path cache; unlike `order`, this is never a player-issued command. */
  autoOrder?: UnitAutoOrderRuntime;
  /** Knockback velocity XZ (world units/sec), decayed in movement. */
  vxImpulse: number;
  vzImpulse: number;
  /** Temporary elemental crowd-control / aftermath reads applied by spells. */
  spellStatuses?: UnitSpellStatus[];
  /** Normal attacks are event-based; when positive this squad is winding up/recovering. */
  attackCooldownTicksRemaining?: number;
  /** Last sim tick this squad committed a normal attack, consumed by renderer animations. */
  lastAttackTick?: number;
}

export type UnitSpellStatusKind = "frozen" | "rooted" | "chilled" | "burning" | "winded";

export interface UnitSpellStatus {
  kind: UnitSpellStatusKind;
  untilTick: number;
  /** Strength is 0..1 for renderer opacity / sim slow severity. */
  strength: number;
}

export function maxSquadCount(u: UnitRuntime): number {
  return Math.max(1, Math.round(u.squadMaxCount ?? u.squadCount ?? 1));
}

export function liveSquadCount(u: UnitRuntime): number {
  if (u.hp <= 0) return 0;
  const maxCount = maxSquadCount(u);
  const singleMaxHp = Math.max(1, u.singleMaxHp ?? u.maxHp / maxCount);
  return Math.max(1, Math.min(maxCount, Math.ceil(u.hp / singleMaxHp)));
}

export type UnitOrderMode = "move" | "attack_move" | "stay";

/** Sentinel used only in selection arrays so marquee select can include the Wizard. */
export const HERO_SELECTION_ID = -1;

export interface UnitOrderRuntime {
  mode: UnitOrderMode;
  x: number;
  z: number;
  waypoints: Vec2[];
  queued: Vec2[];
  /**
   * When set, this order is a commitment to that Mana node index in `GameState.taps`:
   * move/fight there until your team owns the node or this unit dies — no "arrived and idle" early exit.
   */
  captureTapIndex?: number;
  /** Shared moving formation anchor, if this command came from RMB-drag formation. */
  formationGroupId?: number;
  /** Desired slot offset from the shared formation anchor. */
  formationOffsetX?: number;
  formationOffsetZ?: number;
}

export interface UnitAutoOrderRuntime {
  x: number;
  z: number;
  waypoints: Vec2[];
}

export interface FormationMarchRuntime {
  id: number;
  issuedTick: number;
  anchorX: number;
  anchorZ: number;
  goalX: number;
  goalZ: number;
  speedPerSec: number;
  memberIds: number[];
}

export interface MatchStats {
  /** Doctrine or Captain-placed player buildings (excludes the pre-spawned Wizard Keep). */
  structuresBuilt: number;
  structuresLost: number;
  unitsProduced: number;
  unitsLost: number;
  /** Salvage that entered the pool: player building loss refunds + command effects that add salvage. */
  salvageRecovered: number;
  enemyKills: number;
  commandsCast: number;
  /** Enemy units spawned this match (initial camps + reinforcements). Win "routed" only counts if this is > 0. */
  enemyUnitsSpawned: number;
  /** Total HP damage dealt by the player's army (units, wizard, spells, auras) to enemy-side targets. */
  damageDealtPlayer: number;
  /** Total HP damage dealt by the enemy to player-side targets. */
  damageDealtEnemy: number;
}

/** Accumulate scored damage for time-limit tiebreaker / HUD. */
export function recordDamageDealtBy(s: GameState, attackerTeam: TeamId, amount: number): void {
  if (amount <= 0 || !Number.isFinite(amount)) return;
  if (attackerTeam === "player") s.stats.damageDealtPlayer += amount;
  else s.stats.damageDealtEnemy += amount;
}

/** Player Fortify (and similar): persistent ground zone that buffs allies and debuffs enemies. */
export interface TacticsFieldZone {
  x: number;
  z: number;
  radius: number;
  untilTick: number;
  allySpeedMult: number;
  allyDamageMult: number;
  allyIncomingDamageMult: number;
  enemySpeedMult: number;
  enemyDamageMult: number;
  enemyIncomingDamageMult: number;
}

export interface PortalRuntime {
  enteredViaPortal: boolean;
  exitPortal: Vec2;
  returnPortal: Vec2 | null;
  exitUrl: string;
  returnUrl: string | null;
  cooldownTicksRemaining: number;
  pendingRedirectUrl: string | null;
}

export interface GameState {
  map: MapData;
  tick: number;
  phase: GamePhase;
  flux: number;
  salvage: number;
  taps: TapRuntime[];
  enemyRelays: EnemyRelayRuntime[];
  structures: StructureRuntime[];
  units: UnitRuntime[];
  nextId: { structure: number; unit: number; formation: number };
  doctrineSlotCatalogIds: (string | null)[];
  /** Remaining placements per doctrine slot (match start). */
  doctrineChargesRemaining: number[];
  doctrineCooldownTicks: number[];
  selectedDoctrineIndex: number | null;
  /** @deprecated No longer set by gameplay; kept for replay/checksum compat. */
  selectedStructureId: number | null;
  /** Primary friendly unit picked for range preview (compat). */
  selectedUnitId: number | null;
  /** Current RTS selection; can include friendly units plus `HERO_SELECTION_ID` for the Wizard. */
  selectedUnitIds: number[];
  selectedUnitBox: { x1: number; z1: number; x2: number; z2: number } | null;
  /** Mobile-friendly Wizard autopilot. Manual hero orders suppress it briefly. */
  heroCaptainEnabled: boolean;
  heroCaptainLastManualTick: number;
  /** After T / teleport button: next valid map click blinks the Wizard squad. */
  teleportClickPending: boolean;
  heroTeleportCooldownTicks: number;
  /**
   * Throttled combat telegraphs for this tick (attacker-anchored wedges); renderer consumes and clears.
   * Not part of replay checksum.
   */
  combatHitMarks: CombatHitMark[];
  pendingPlacementCatalogId: string | null;
  /** Global stance for friendly units. Offense → seek/engage; Defense → rally to wizard. */
  armyStance: ArmyStance;
  /** Player-selected RMB drag formation preset. */
  formationPreset: UnitFormationKind;
  /** Active player-issued formation marches keyed by `UnitOrderRuntime.formationGroupId`. */
  formationMarches: FormationMarchRuntime[];
  /** After R / rally button: next map click sets `globalRally*`. */
  rallyClickPending: boolean;
  /** When true (offense only), player units march to `globalRallyX/Z` until stance toggles. */
  globalRallyActive: boolean;
  globalRallyX: number;
  globalRallyZ: number;
  enemyCampAwake: Record<string, boolean>;
  lastMessage: string;
  /**
   * When `phase` is win/lose, why the match ended. Not reused for HUD toasts, so it is not
   * overwritten by gameplay messages after the fact. Not part of replay checksums.
   */
  matchEndDetail: string | null;
  /** Seeded RNG state (xorshift32). */
  rngState: number;
  /** Per-match counters for end-screen / telemetry. */
  stats: MatchStats;
  /** Per camp id: remaining HP for optional scenario core (see `EnemyCampDef.coreMaxHp`). */
  enemyCampCoreHp: Record<string, number>;
  /** Pending cast / proc FX for the renderer (drained each frame). */
  fxQueue: CastFxEvent[];
  /** Doctrine loadout bonus: sum of `matchGlobalPopCapBonus` from structure cards in slots. */
  globalPopCapBonus: number;
  /** One-shot flag: at least one player unit dealt bonus damage to an enemy building this tick. Set by combat.ts, consumed by renderer. */
  lastSiegeHit: { x: number; z: number; tick: number } | null;
  /** Player-controlled hero wizard. */
  hero: HeroRuntime;
  /** AI opponent wizard — claims taps for `enemy`, spends `enemyFlux`, builds enemy towers. */
  enemyHero: HeroRuntime;
  /** Enemy team's Mana (from enemy-owned taps). */
  enemyFlux: number;
  /** Enemy auto-build: last placed catalog id (soft diversity so AI does not spam one tower). */
  enemyAiLastBuildCatalogId: string | null;
  /** Active Fortify-style fields (tick-based expiry). */
  tacticsFieldZones: TacticsFieldZone[];
  /** Portal continuity flag + legacy ring positions; exit/return URLs stay empty during matches (binder UI only). */
  portal: PortalRuntime;
}

/** Seeded xorshift32 PRNG on state. Returns [0, 1). */
function inTacticsFieldAt(zf: TacticsFieldZone, x: number, z: number, tick: number): boolean {
  if (zf.untilTick <= tick) return false;
  const dx = x - zf.x;
  const dz = z - zf.z;
  return dx * dx + dz * dz <= zf.radius * zf.radius;
}

/** Movement speed multiplier from active tactics fields at (x,z). */
export function tacticsFieldSpeedMult(s: GameState, team: TeamId, x: number, z: number): number {
  let m = 1;
  for (const zf of s.tacticsFieldZones) {
    if (!inTacticsFieldAt(zf, x, z, s.tick)) continue;
    if (team === "player") m *= zf.allySpeedMult;
    else m *= zf.enemySpeedMult;
  }
  return team === "player" ? Math.min(1.45, m) : Math.max(0.5, m);
}

export function pruneUnitSpellStatuses(s: GameState): void {
  for (const u of s.units) {
    if (!u.spellStatuses?.length) continue;
    u.spellStatuses = u.spellStatuses.filter((st) => st.untilTick > s.tick);
    if (u.spellStatuses.length === 0) delete u.spellStatuses;
  }
}

export function applyUnitSpellStatus(
  s: GameState,
  u: UnitRuntime,
  kind: UnitSpellStatusKind,
  durationTicks: number,
  strength = 1,
): void {
  if (u.hp <= 0 || durationTicks <= 0) return;
  const untilTick = s.tick + Math.max(1, Math.round(durationTicks));
  const clamped = Math.max(0, Math.min(1, strength));
  const arr = (u.spellStatuses ??= []);
  const existing = arr.find((st) => st.kind === kind);
  if (existing) {
    existing.untilTick = Math.max(existing.untilTick, untilTick);
    existing.strength = Math.max(existing.strength, clamped);
  } else {
    arr.push({ kind, untilTick, strength: clamped });
  }
}

export function unitSpellStatusSpeedMult(u: UnitRuntime): number {
  let mult = 1;
  for (const st of u.spellStatuses ?? []) {
    if (st.kind === "frozen") mult *= 0.04 + (1 - st.strength) * 0.18;
    else if (st.kind === "rooted") mult *= 0.16 + (1 - st.strength) * 0.24;
    else if (st.kind === "chilled") mult *= 1 - 0.45 * st.strength;
    else if (st.kind === "winded") mult *= 1 - 0.24 * st.strength;
  }
  return Math.max(0.02, mult);
}

/** Outgoing attack damage multiplier for a team at (x,z). */
export function tacticsFieldOutgoingDamageMult(s: GameState, team: TeamId, x: number, z: number): number {
  let m = 1;
  for (const zf of s.tacticsFieldZones) {
    if (!inTacticsFieldAt(zf, x, z, s.tick)) continue;
    if (team === "player") m *= zf.allyDamageMult;
    else m *= zf.enemyDamageMult;
  }
  return team === "player" ? Math.min(1.55, m) : Math.max(0.55, m);
}

/** Incoming damage multiplier for a team at (x,z) (lower = tougher). */
export function tacticsFieldIncomingDamageMult(s: GameState, team: TeamId, x: number, z: number): number {
  let m = 1;
  for (const zf of s.tacticsFieldZones) {
    if (!inTacticsFieldAt(zf, x, z, s.tick)) continue;
    if (team === "player") m *= zf.allyIncomingDamageMult;
    else m *= zf.enemyIncomingDamageMult;
  }
  return team === "player" ? Math.max(0.72, m) : Math.min(1.5, m);
}

export function rand(s: GameState): number {
  let x = s.rngState | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  s.rngState = x >>> 0;
  return (s.rngState & 0xffffffff) / 0x100000000;
}

/** Seeded random u32. */
export function randU32(s: GameState): number {
  rand(s);
  return s.rngState >>> 0;
}

function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/** Claimed Taps drive the wizard's tier progression (replaces Relay tier). */
export function claimedTapCount(s: GameState): number {
  let n = 0;
  for (const t of s.taps) {
    if (t.active && t.ownerTeam === "player" && (t.anchorHp ?? 0) > 0) n++;
  }
  return n;
}

export function claimedEnemyTapCount(s: GameState): number {
  let n = 0;
  for (const t of s.taps) {
    if (t.active && t.ownerTeam === "enemy" && (t.anchorHp ?? 0) > 0) n++;
  }
  return n;
}

/** Tier = 1 (0 taps) → 2 (≥2) → 3 (≥4). Mirrors the old Relay ladder. */
export function wizardTier(s: GameState): number {
  const n = claimedTapCount(s);
  if (n >= 4) return 3;
  if (n >= 2) return 2;
  return 1;
}

/** Enemy wizard tier from enemy-owned Mana nodes (mirrors `wizardTier`). */
export function enemyWizardTier(s: GameState): number {
  const n = claimedEnemyTapCount(s);
  if (n >= 4) return 3;
  if (n >= 2) return 2;
  return 1;
}

export function tierRequirementSatisfied(s: GameState, entry: CatalogEntry): boolean {
  void s;
  void entry;
  return true;
}

export function enemyTierRequirementSatisfied(s: GameState, entry: CatalogEntry): boolean {
  void s;
  void entry;
  return true;
}

/** Signals are no longer required in the wizard build — keep the hook for
 *  back-compat with catalog entries that still carry `requiredSignalCounts`. */
export function signalCountsSatisfied(_s: GameState, _entry: CatalogEntry): boolean {
  return true;
}

export function meetsSignalRequirements(s: GameState, entry: CatalogEntry): boolean {
  void s;
  void entry;
  return true;
}

export function meetsEnemyStructureRequirements(s: GameState, entry: CatalogEntry): boolean {
  void s;
  void entry;
  return true;
}

/** The Wizard Keep structure (completed or still alive). Null if already destroyed. */
export function findKeep(s: GameState): StructureRuntime | null {
  for (const st of s.structures) {
    if (st.team !== "player") continue;
    if (st.catalogId !== KEEP_ID) continue;
    if (st.hp <= 0) continue;
    return st;
  }
  return null;
}

export function isKeep(st: StructureRuntime): boolean {
  return st.team === "player" && st.catalogId === KEEP_ID;
}

/**
 * Horizontal yaw (radians) so a structure mesh faces **across the map** toward the opposing team's
 * home anchor (relay slots → starts → heroes). Matches “face the fight,” not camera billboard.
 */
export function structureFacingYawRad(s: GameState, st: StructureRuntime): number {
  const m = s.map;
  let tx: number;
  let tz: number;
  if (st.team === "player") {
    const er = m.enemyRelaySlots[0];
    if (er) {
      tx = er.x;
      tz = er.z;
    } else if (m.enemyStart) {
      tx = m.enemyStart.x;
      tz = m.enemyStart.z;
    } else {
      tx = s.enemyHero.x;
      tz = s.enemyHero.z;
    }
  } else {
    const pr = m.playerRelaySlots[0];
    if (pr) {
      tx = pr.x;
      tz = pr.z;
    } else {
      const pk = findKeep(s);
      if (pk) {
        tx = pk.x;
        tz = pk.z;
      } else if (m.playerStart) {
        tx = m.playerStart.x;
        tz = m.playerStart.z;
      } else {
        tx = s.hero.x;
        tz = s.hero.z;
      }
    }
  }
  let dx = tx - st.x;
  let dz = tz - st.z;
  let len = Math.hypot(dx, dz);
  if (len < 0.01) {
    if (st.team === "player") {
      dx = s.enemyHero.x - st.x;
      dz = s.enemyHero.z - st.z;
    } else {
      dx = s.hero.x - st.x;
      dz = s.hero.z - st.z;
    }
    len = Math.hypot(dx, dz);
  }
  if (len < 1e-6) return 0;
  return Math.atan2(dx / len, dz / len);
}

/** Wizard spawn/respawn disk — offset from the Keep anchor toward the field so the GLB clears the HQ mesh. */
export function heroStandPositionNearKeepAnchor(anchor: Vec2, map: MapData, team: "player" | "enemy"): Vec2 {
  const h = map.world.halfExtents;
  const margin = 12;
  const fwd = HERO_SPAWN_FORWARD_FROM_KEEP;
  const side = team === "player" ? HERO_SPAWN_SIDE_FROM_KEEP : -HERO_SPAWN_SIDE_FROM_KEEP;
  let dx = 0;
  let dz = 0;
  if (Math.abs(anchor.x) > 8) {
    dx = -Math.sign(anchor.x) * fwd;
    dz += side;
  } else if (Math.abs(anchor.z) > 8) {
    dz = -Math.sign(anchor.z) * fwd;
    dx += team === "player" ? side : -side;
  } else {
    dx = team === "player" ? fwd : -fwd;
    dz += team === "player" ? side * 0.5 : -side * 0.5;
  }
  const x = Math.max(-h + margin, Math.min(h - margin, anchor.x + dx));
  const z = Math.max(-h + margin, Math.min(h - margin, anchor.z + dz));
  return { x, z };
}

function initDoctrineRuntime(_slots: (string | null)[]): { charges: number[]; cd: number[] } {
  const charges: number[] = [];
  const cd: number[] = [];
  for (let i = 0; i < DOCTRINE_SLOT_COUNT; i++) {
    /** Unused for locking — doctrine uses per-cast cooldown only. */
    charges.push(1);
    cd.push(0);
  }
  return { charges, cd };
}

/**
 * One-time match init / binder: when commands are disabled, strip invalid/command entries per slot
 * and preserve slot order (nulls stay in place). With commands enabled, pad and validate only.
 */
export function normalizeDoctrineSlotsForMatch(slots: (string | null)[]): (string | null)[] {
  const catalogOk = (id: string | null): string | null => {
    if (!id) return null;
    return getCatalogEntry(id) ? id : null;
  };
  if (DOCTRINE_COMMANDS_ENABLED) {
    const copy = [...slots];
    while (copy.length < DOCTRINE_SLOT_COUNT) copy.push(null);
    return copy.slice(0, DOCTRINE_SLOT_COUNT).map(catalogOk);
  }
  const row = [...slots];
  while (row.length < DOCTRINE_SLOT_COUNT) row.push(null);
  return row.slice(0, DOCTRINE_SLOT_COUNT).map((id) => {
    const ok = catalogOk(id);
    if (!ok) return null;
    const e = getCatalogEntry(ok);
    if (!e || isCommandEntry(e) || !isStructureEntry(e)) return null;
    return ok;
  });
}

/** Spawn the Wizard Keep at the player HQ anchor — complete immediately, no build time,
 *  no flux cost. This is the permanent base that anchors the wizard. */
/** Random Mana node layout: TAP_NODES_PER_SIDE on x<0, same on x>0; ignores map.json tapSlots. */
export function generateProceduralTaps(map: MapData, rngScratch: { v: number }): TapRuntime[] {
  function rnd(): number {
    let x = rngScratch.v | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    rngScratch.v = x >>> 0;
    return (rngScratch.v & 0xffffffff) / 0x100000000;
  }
  const half = map.world.halfExtents;
  const margin = Math.min(140, Math.max(44, half * 0.2));
  const minSep2 = TAP_GENERATION_MIN_SEP * TAP_GENERATION_MIN_SEP;
  const sx = map.playerStart?.x ?? 0;
  const sz = map.playerStart?.z ?? 0;
  const placed: { x: number; z: number }[] = [];
  const edgePad = Math.max(18, half * 0.04);
  const keepClear = Math.max(36, half * 0.11);
  const keepClear2 = keepClear * keepClear;

  function okPos(x: number, z: number, playerSide: boolean): boolean {
    if (Math.abs(x) > half - edgePad || Math.abs(z) > half - edgePad) return false;
    if (playerSide) {
      if (x > -margin) return false;
    } else if (x < margin) {
      return false;
    }
    const kd2 = keepClear2;
    if ((x - sx) * (x - sx) + (z - sz) * (z - sz) < kd2) return false;
    for (const p of placed) {
      const dx = p.x - x;
      const dz = p.z - z;
      if (dx * dx + dz * dz < minSep2) return false;
    }
    return true;
  }

  const taps: TapRuntime[] = [];
  let id = 0;
  for (const playerSide of [true, false]) {
    let n = 0;
    let attempts = 0;
    while (n < TAP_NODES_PER_SIDE && attempts < 1200) {
      attempts++;
      const x = playerSide
        ? -margin - rnd() * Math.max(16, half - margin * 2)
        : margin + rnd() * Math.max(16, half - margin * 2);
      const z = (rnd() * 2 - 1) * (half - margin - edgePad);
      if (!okPos(x, z, playerSide)) continue;
      placed.push({ x, z });
      taps.push({
        defId: `tap_gen_${id++}`,
        x,
        z,
        active: false,
        yieldRemaining: 0,
        ownerTeam: undefined,
      });
      n++;
    }
  }
  return taps;
}

/** Runtime map with procedural tap slots for types that expect `map.tapSlots`. */
function pickReadableTapSlots(slots: TapSlotDef[], halfExtents: number): TapSlotDef[] {
  const perSide = TAP_NODES_PER_SIDE;
  if (slots.length <= perSide * 2) return slots;

  const targets = [
    { p: 0.24, z: 0 },
    { p: 0.5, z: -0.42 },
    { p: 0.5, z: 0.42 },
    { p: 0.82, z: 0 },
  ];
  const pickSide = (sideSlots: TapSlotDef[], side: "player" | "enemy"): TapSlotDef[] => {
    const picked: TapSlotDef[] = [];
    const used = new Set<string>();
    for (const target of targets.slice(0, perSide)) {
      let best: TapSlotDef | null = null;
      let bestScore = Infinity;
      for (const slot of sideSlots) {
        if (used.has(slot.id)) continue;
        const p = side === "player" ? (slot.x + halfExtents) / halfExtents : (halfExtents - slot.x) / halfExtents;
        const z = halfExtents > 0 ? slot.z / halfExtents : 0;
        const score = Math.abs(p - target.p) * 1.8 + Math.abs(z - target.z);
        if (score < bestScore) {
          bestScore = score;
          best = slot;
        }
      }
      if (best) {
        picked.push(best);
        used.add(best.id);
      }
    }
    return picked;
  };

  const player = slots.filter((s) => s.x < 0);
  const enemy = slots.filter((s) => s.x >= 0);
  if (player.length === 0 || enemy.length === 0) return slots.slice(0, perSide * 2);
  return [...pickSide(player, "player"), ...pickSide(enemy, "enemy")];
}

function isAuthorBoundaryDecor(map: MapData, decor: NonNullable<MapData["decor"]>[number]): boolean {
  if (decor.kind !== "box" || !decor.blocksMovement) return false;
  const half = map.world.halfExtents;
  const edgeTol = Math.max(10, half * 0.04);
  const longSpan = half * 1.6;
  const thinSpan = 18;
  const nearEastWest = Math.abs(Math.abs(decor.x) - half) <= edgeTol && decor.d >= longSpan && decor.w <= thinSpan;
  const nearNorthSouth = Math.abs(Math.abs(decor.z) - half) <= edgeTol && decor.w >= longSpan && decor.d <= thinSpan;
  return nearEastWest || nearNorthSouth;
}

function stripAuthorBoundaryDecor(map: MapData): MapData {
  if (!map.decor?.length) return map;
  const decor = map.decor.filter((d) => !isAuthorBoundaryDecor(map, d));
  return decor.length === map.decor.length ? map : { ...map, decor };
}

export function mapWithRuntimeTapSlots(map: MapData, taps: TapRuntime[]): MapData {
  const tapSlots: TapSlotDef[] = taps.map((t) => ({ id: t.defId, x: t.x, z: t.z }));
  return stripAuthorBoundaryDecor({ ...map, tapSlots });
}

function spawnKeep(state: GameState, anchor: Vec2): void {
  const entry = getCatalogEntry(KEEP_ID);
  if (!entry || !isStructureEntry(entry)) return;
  /** HQ mesh stays at the authored anchor; the hero stands offset via `heroStandPositionNearKeepAnchor`. */
  const p = { x: anchor.x, z: anchor.z };
  const periodTicks = Math.max(1, Math.round(KEEP_SWARM_PERIOD_SEC * TICK_HZ));
  state.structures.push({
    id: state.nextId.structure++,
    team: "player",
    catalogId: KEEP_ID,
    x: p.x,
    z: p.z,
    hp: KEEP_MAX_HP,
    maxHp: KEEP_MAX_HP,
    buildTicksRemaining: 0,
    buildTotalTicks: 0,
    complete: true,
    productionTicksRemaining: periodTicks,
    doctrineSlotIndex: -1,
    rallyX: p.x,
    rallyZ: p.z,
    placementForward: false,
    damageReductionUntilTick: 0,
    productionSilenceUntilTick: 0,
    holdOrders: false,
    localPopCapBonus: 0,
  });
}

function doctrineMatchGlobalPopCapBonus(slots: (string | null)[]): number {
  let sum = 0;
  for (const id of slots) {
    const e = getCatalogEntry(id);
    if (e && isStructureEntry(e) && typeof e.matchGlobalPopCapBonus === "number") sum += e.matchGlobalPopCapBonus;
  }
  return Math.min(Math.max(0, GLOBAL_POP_CAP_MAX - GLOBAL_POP_CAP), sum);
}

/** Army-wide pop cap for this match (base + doctrine loadout bonuses). */
export function effectiveGlobalPopCap(s: GameState): number {
  return Math.min(GLOBAL_POP_CAP_MAX, GLOBAL_POP_CAP + s.globalPopCapBonus);
}

export function createInitialState(map: MapData, doctrineSlots?: (string | null)[]): GameState {
  const rawIn = doctrineSlots ?? [...DEFAULT_DOCTRINE_SLOTS];
  const rawSlots =
    rawIn.length >= DOCTRINE_SLOT_COUNT
      ? rawIn.slice(0, DOCTRINE_SLOT_COUNT)
      : [...rawIn, ...Array.from({ length: DOCTRINE_SLOT_COUNT - rawIn.length }, () => null)];
  const slots = normalizeDoctrineSlotsForMatch(rawSlots);
  const rt = initDoctrineRuntime(slots);
  const globalPopCapBonus = doctrineMatchGlobalPopCapBonus(slots);

  const rngScratch = { v: 0xc0ffee01 >>> 0 };
  const taps: TapRuntime[] =
    map.useAuthorTapSlots && map.tapSlots.length > 0
      ? pickReadableTapSlots(map.tapSlots, map.world.halfExtents).map((ts) => ({
          defId: ts.id,
          x: ts.x,
          z: ts.z,
          active: false,
          yieldRemaining: 0,
          ownerTeam: undefined,
        }))
      : generateProceduralTaps(map, rngScratch);
  const mapResolved = mapWithRuntimeTapSlots(map, taps);

  const enemyRelays: EnemyRelayRuntime[] = map.enemyRelaySlots.map((r) => ({
    defId: r.id,
    x: r.x,
    z: r.z,
    hp: ENEMY_RELAY_MAX_HP,
    maxHp: ENEMY_RELAY_MAX_HP,
    silencedUntilTick: 0,
  }));

  const hpMult = enemyHpScalar(mapResolved);
  const dmgMult = enemyDamageScalar(mapResolved);
  const enemyEconomyMult = normalizeMapDifficulty(mapResolved.difficulty).enemyEconomyMult;
  const enemyStartingFlux = Math.max(0, Math.round(PLAYER_STARTING_FLUX * enemyEconomyMult));

  /** HQ anchor: first player relay when present, else `playerStart`. */
  const relay0 = mapResolved.playerRelaySlots[0];
  const playerKeepAnchor: Vec2 =
    relay0 != null ? { x: relay0.x, z: relay0.z } : (mapResolved.playerStart ?? { x: 0, z: 0 });
  const heroSpawn = heroStandPositionNearKeepAnchor(playerKeepAnchor, mapResolved, "player");
  const hero: HeroRuntime = {
    x: heroSpawn.x,
    z: heroSpawn.z,
    targetX: null,
    targetZ: null,
    moveWaypoints: [],
    speedPerSec: HERO_SPEED,
    radius: HERO_FOLLOW_RADIUS,
    claimChannelTarget: null,
    claimChannelTicksRemaining: 0,
    hp: HERO_MAX_HP,
    maxHp: HERO_MAX_HP,
    facing: 0,
    wasdStrafe: 0,
    wasdForward: 0,
    attackCooldownTicksRemaining: 0,
    strikeSequence: 0,
  };

  const enemyRelay0 = mapResolved.enemyRelaySlots[0];
  const enemyKeepAnchor: Vec2 =
    enemyRelay0 != null
      ? { x: enemyRelay0.x, z: enemyRelay0.z }
      : (mapResolved.enemyStart ?? ({ x: -playerKeepAnchor.x, z: playerKeepAnchor.z } as Vec2));
  const enemySpawn = heroStandPositionNearKeepAnchor(enemyKeepAnchor, mapResolved, "enemy");
  const enemyHero: HeroRuntime = {
    x: enemySpawn.x,
    z: enemySpawn.z,
    targetX: null,
    targetZ: null,
    moveWaypoints: [],
    speedPerSec: HERO_SPEED * 1.02,
    radius: HERO_FOLLOW_RADIUS,
    claimChannelTarget: null,
    claimChannelTicksRemaining: 0,
    hp: HERO_MAX_HP,
    maxHp: HERO_MAX_HP,
    facing: Math.PI,
    wasdStrafe: 0,
    wasdForward: 0,
    attackCooldownTicksRemaining: 0,
    strikeSequence: 0,
  };

  resolveCircleAgainstMapObstacles(mapResolved, hero, HERO_MAP_OBSTACLE_RADIUS);
  resolveCircleAgainstMapObstacles(mapResolved, enemyHero, HERO_MAP_OBSTACLE_RADIUS);

  const portalExit = {
    x: Math.max(-mapResolved.world.halfExtents + 12, playerKeepAnchor.x + 13),
    z: Math.max(-mapResolved.world.halfExtents + 12, Math.min(mapResolved.world.halfExtents - 12, playerKeepAnchor.z - 12)),
  };
  const portalReturn = {
    x: Math.max(-mapResolved.world.halfExtents + 12, playerKeepAnchor.x - 11),
    z: Math.max(-mapResolved.world.halfExtents + 12, Math.min(mapResolved.world.halfExtents - 12, playerKeepAnchor.z + 11)),
  };

  const state: GameState = {
    map: mapResolved,
    tick: 0,
    phase: "playing",
    flux: PLAYER_STARTING_FLUX,
    salvage: 0,
    /** Same `enemyEconomyMult` as tap income / passive (default 0.6 = 60% of human opening budget). */
    enemyFlux: enemyStartingFlux,
    taps,
    enemyRelays,
    structures: [],
    units: [],
    nextId: { structure: 1, unit: 1, formation: 1 },
    doctrineSlotCatalogIds: slots,
    doctrineChargesRemaining: rt.charges,
    doctrineCooldownTicks: rt.cd,
    selectedDoctrineIndex: null,
    selectedStructureId: null,
    selectedUnitId: null,
    selectedUnitIds: [],
    selectedUnitBox: null,
    heroCaptainEnabled: false,
    heroCaptainLastManualTick: -9999,
    teleportClickPending: false,
    heroTeleportCooldownTicks: 0,
    combatHitMarks: [],
    pendingPlacementCatalogId: null,
    armyStance: "offense",
    formationPreset: "line",
    formationMarches: [],
    rallyClickPending: false,
    globalRallyActive: false,
    globalRallyX: 0,
    globalRallyZ: 0,
    enemyCampAwake: Object.fromEntries(mapResolved.enemyCamps.map((c) => [c.id, false])),
    lastMessage: "Battle on — claim nodes, summon towers, break the enemy.",
    matchEndDetail: null,
    rngState: rngScratch.v >>> 0,
    stats: {
      structuresBuilt: 0,
      structuresLost: 0,
      unitsProduced: 0,
      unitsLost: 0,
      salvageRecovered: 0,
      enemyKills: 0,
      commandsCast: 0,
      enemyUnitsSpawned: 0,
      damageDealtPlayer: 0,
      damageDealtEnemy: 0,
    },
    enemyCampCoreHp: {},
    fxQueue: [],
    globalPopCapBonus,
    lastSiegeHit: null,
    hero,
    enemyHero,
    enemyAiLastBuildCatalogId: null,
    tacticsFieldZones: [],
    portal: {
      enteredViaPortal: false,
      exitPortal: portalExit,
      returnPortal: portalReturn,
      exitUrl: "",
      returnUrl: null,
      cooldownTicksRemaining: 0,
      pendingRedirectUrl: null,
    },
  };

  spawnKeep(state, playerKeepAnchor);

  const defaultOffsets: Vec2[] = [
    { x: 4, z: 0 },
    { x: -3, z: 3 },
    { x: 0, z: -4 },
    { x: 6, z: 4 },
    { x: -5, z: -2 },
  ];
  for (const camp of mapResolved.enemyCamps) {
    if (typeof camp.coreMaxHp === "number" && camp.coreMaxHp > 0) {
      state.enemyCampCoreHp[camp.id] = camp.coreMaxHp;
    }
    const authoredRoster = camp.roster ?? defaultOffsets.map((o, i) => ({
      sizeClass: (i % 2 === 0 ? "Line" : "Swarm") as UnitSizeClass,
      offset: o,
    }));
    const openingRoster = authoredRoster.filter((r) => r.sizeClass === "Swarm");
    const initialCount = Math.max(0, Math.min(camp.initialUnitCount ?? ENEMY_CAMP_INITIAL_DEFENDER_CAP, openingRoster.length));
    const roster = openingRoster.slice(0, initialCount);
    for (const r of roster) {
      const base = unitStatsForCatalog(r.sizeClass);
      const hp = Math.max(1, Math.round(base.maxHp * hpMult));
      state.units.push({
        id: state.nextId.unit++,
        team: "enemy",
        structureId: null,
        x: camp.origin.x + r.offset.x,
        z: camp.origin.z + r.offset.z,
        hp,
        maxHp: hp,
        sizeClass: r.sizeClass,
        pop: base.pop,
        speedPerSec: base.speedPerSec,
        range: base.range,
        dmgPerTick: base.dmgPerTick * dmgMult,
        visualSeed: randU32(state),
        vxImpulse: 0,
        vzImpulse: 0,
      });
    }
  }

  state.stats.enemyUnitsSpawned = state.units.filter((u) => u.team === "enemy").length;

  return state;
}

export function totalPlayerPop(s: GameState): number {
  return s.units.filter((u) => u.team === "player").reduce((a, u) => a + u.pop, 0);
}

export function totalEnemyPop(s: GameState): number {
  return s.units.filter((u) => u.team === "enemy").reduce((a, u) => a + u.pop, 0);
}

export function localPopForStructure(s: GameState, structureId: number): number {
  return s.units
    .filter((u) => u.team === "player" && u.structureId === structureId)
    .reduce((a, u) => a + u.pop, 0);
}

export function localPopForEnemyStructure(s: GameState, structureId: number): number {
  return s.units
    .filter((u) => u.team === "enemy" && u.structureId === structureId)
    .reduce((a, u) => a + u.pop, 0);
}

export function nearestEnemyAggroBlocked(s: GameState, pos: Vec2): boolean {
  for (const camp of s.map.enemyCamps) {
    const r = camp.aggroRadius;
    for (const u of s.units) {
      if (u.team !== "enemy") continue;
      if (dist2(pos, u) < r * r) return true;
    }
    for (const er of s.enemyRelays) {
      if (er.hp <= 0) continue;
      if (dist2(pos, er) < r * r) return true;
    }
  }
  return false;
}

/** "Near friendly infra" now means near a claimed Tap or the live Keep. */
export function nearFriendlyInfra(s: GameState, pos: Vec2): boolean {
  const r2 = INFRA_PLACE_RADIUS * INFRA_PLACE_RADIUS;
  for (const t of s.taps) {
    if (!t.active || t.ownerTeam !== "player" || (t.anchorHp ?? 0) <= 0) continue;
    if (dist2(pos, t) <= r2) return true;
  }
  const keep = findKeep(s);
  if (keep && dist2(pos, keep) <= r2) return true;
  return false;
}

/** Near enemy relay, enemy-claimed tap, or completed enemy tower (for AI placement). */
export function nearEnemyInfra(s: GameState, pos: Vec2): boolean {
  const r2 = INFRA_PLACE_RADIUS * INFRA_PLACE_RADIUS;
  for (const t of s.taps) {
    if (!t.active || t.ownerTeam !== "enemy" || (t.anchorHp ?? 0) <= 0) continue;
    if (dist2(pos, t) <= r2) return true;
  }
  for (const er of s.enemyRelays) {
    if (er.hp <= 0) continue;
    if (dist2(pos, er) <= r2) return true;
  }
  for (const st of s.structures) {
    if (st.team !== "enemy" || !st.complete) continue;
    if (dist2(pos, st) <= r2) return true;
  }
  return false;
}

/** Territory = union of `TERRITORY_RADIUS` around the live Keep and owned Mana anchors. */
export function inPlayerTerritory(s: GameState, pos: Vec2): boolean {
  const r2 = TERRITORY_RADIUS * TERRITORY_RADIUS;
  const keep = findKeep(s);
  if (keep && dist2(pos, keep) <= r2) return true;
  for (const t of s.taps) {
    if (!t.active || t.ownerTeam !== "player" || (t.anchorHp ?? 0) <= 0) continue;
    if (dist2(pos, t) <= r2) return true;
  }
  return false;
}

/** Union of territory disks around enemy relays, enemy-claimed taps, and completed enemy structures. */
export function inEnemyTerritory(s: GameState, pos: Vec2): boolean {
  const r2 = TERRITORY_RADIUS * TERRITORY_RADIUS;
  for (const er of s.enemyRelays) {
    if (er.hp <= 0) continue;
    if (dist2(pos, er) <= r2) return true;
  }
  for (const t of s.taps) {
    if (!t.active || t.ownerTeam !== "enemy" || (t.anchorHp ?? 0) <= 0) continue;
    if (dist2(pos, t) <= r2) return true;
  }
  for (const st of s.structures) {
    if (st.team !== "enemy" || !st.complete) continue;
    if (dist2(pos, st) <= r2) return true;
  }
  return false;
}

export function enemyTerritorySources(s: GameState): Vec2[] {
  const out: Vec2[] = [];
  for (const er of s.enemyRelays) {
    if (er.hp > 0) out.push({ x: er.x, z: er.z });
  }
  for (const t of s.taps) {
    if (t.active && t.ownerTeam === "enemy" && (t.anchorHp ?? 0) > 0) out.push({ x: t.x, z: t.z });
  }
  for (const st of s.structures) {
    if (st.team === "enemy" && st.complete) out.push({ x: st.x, z: st.z });
  }
  return out;
}

/** Current list of positions feeding the territory union (Keep + claimed taps). */
export function territorySources(s: GameState): Vec2[] {
  const out: Vec2[] = [];
  const keep = findKeep(s);
  if (keep) out.push({ x: keep.x, z: keep.z });
  for (const t of s.taps) {
    if (t.active && t.ownerTeam === "player" && (t.anchorHp ?? 0) > 0) out.push({ x: t.x, z: t.z });
  }
  return out;
}

export function heroTeleportCooldownSeconds(s: GameState): number {
  return Math.ceil(Math.max(0, s.heroTeleportCooldownTicks) / TICK_HZ);
}

export function tickHeroTeleportCooldown(s: GameState): void {
  if (s.heroTeleportCooldownTicks > 0) s.heroTeleportCooldownTicks -= 1;
}

export function resetHeroTeleportCooldown(s: GameState): void {
  s.heroTeleportCooldownTicks = Math.round(HERO_TELEPORT_COOLDOWN_SEC * TICK_HZ);
}

/**
 * War Camp aura: safe_deploy_radius extends "near infra" (safe placement) around
 * its own position so new structures don't suffer forward-placement penalties.
 */
export function nearSafeDeployAura(s: GameState, pos: Vec2): boolean {
  for (const st of s.structures) {
    if (st.team !== "player" || !st.complete) continue;
    const def = getCatalogEntry(st.catalogId);
    if (!def || !isStructureEntry(def) || !def.aura) continue;
    if (def.aura.kind !== "safe_deploy_radius") continue;
    const r = def.aura.radius;
    if (dist2(pos, st) <= r * r) return true;
  }
  return false;
}

export function nearFriendlyForward(s: GameState, pos: Vec2): boolean {
  if (nearFriendlyInfra(s, pos)) return false;
  if (nearSafeDeployAura(s, pos)) return false;
  const r2 = FORWARD_PLACE_RADIUS * FORWARD_PLACE_RADIUS;
  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    if (dist2(pos, u) <= r2) return true;
  }
  for (const st of s.structures) {
    if (st.team !== "player" || !st.complete) continue;
    if (dist2(pos, st) <= r2) return true;
  }
  return false;
}

export type DoctrinePlayabilityKind =
  | "ready"
  | "cooldown"
  | "mana"
  | "territory"
  | "enemy"
  | "terrain"
  | "invalid"
  | "empty";

export interface DoctrinePlayability {
  ok: boolean;
  kind: DoctrinePlayabilityKind;
  reason: string | null;
  hint: string;
  liveLabel: string;
  missingMana?: number;
  cooldownSeconds?: number;
}

function blocked(kind: DoctrinePlayabilityKind, reason: string, liveLabel: string, extra?: Partial<DoctrinePlayability>): DoctrinePlayability {
  return { ok: false, kind, reason, hint: reason, liveLabel, ...extra };
}

function ready(hint: string, liveLabel = "Ready", extra?: Partial<DoctrinePlayability>): DoctrinePlayability {
  return { ok: true, kind: "ready", reason: null, hint, liveLabel, ...extra };
}

export function doctrineCardPlayability(
  s: GameState,
  catalogId: string | null,
  pos: Vec2 | null,
  slotIndex: number,
): DoctrinePlayability {
  if (slotIndex < 0 || slotIndex >= DOCTRINE_SLOT_COUNT) {
    return blocked("invalid", "Invalid doctrine slot.", "Invalid");
  }
  if (!catalogId) return blocked("empty", "Empty doctrine slot.", "Empty");
  const entry = getCatalogEntry(catalogId);
  if (!entry) return blocked("invalid", "Unknown card.", "Unknown");
  if (s.doctrineSlotCatalogIds[slotIndex] !== catalogId) {
    return blocked("invalid", "Card is not in this doctrine slot.", "Invalid");
  }

  const cdTicks = s.doctrineCooldownTicks[slotIndex] ?? 0;
  if (cdTicks > 0) {
    const secs = Math.max(1, Math.ceil(cdTicks / TICK_HZ));
    return blocked("cooldown", `Card on cooldown (${secs}s).`, `CD ${secs}s`, {
      cooldownSeconds: secs,
    });
  }

  if (isCommandEntry(entry) && !DOCTRINE_COMMANDS_ENABLED) {
    return blocked("invalid", "Command cards are disabled.", "Disabled");
  }

  const missingMana = Math.max(0, Math.ceil(entry.fluxCost - s.flux));
  if (missingMana > 0) {
    return blocked("mana", `Need ${missingMana} more Mana (${entry.fluxCost} total; have ${Math.floor(s.flux)}).`, `Need ${missingMana}`, {
      missingMana,
    });
  }

  if (isStructureEntry(entry) && pos) {
    if (nearestEnemyAggroBlocked(s, pos)) return blocked("enemy", "Too close to enemy — can't summon here.", "Enemy close");
    if (!inPlayerTerritory(s, pos) && !nearSafeDeployAura(s, pos)) {
      return blocked("territory", "Outside your territory — claim more Mana nodes to expand the cyan area.", "Need territory");
    }
    if (circleOverlapsMapObstacles(s.map, pos, STRUCTURE_MAP_OBSTACLE_RADIUS, structureObstacleFootprints(s))) {
      return blocked("terrain", "Blocked by terrain — try another spot.", "Blocked");
    }
  }

  if (isCommandEntry(entry)) {
    return ready(
      pos ? `Click map to cast (${entry.fluxCost} Mana).` : `Ready — ${entry.fluxCost} Mana per cast.`,
      `${entry.fluxCost}`,
    );
  }

  if (isStructureEntry(entry)) {
    return ready(pos ? "Release to summon here." : `Ready — costs ${entry.fluxCost} Mana.`, `Play ${entry.fluxCost}`);
  }

  return blocked("invalid", "Unknown card type.", "Invalid");
}

export function canUseDoctrineSlot(s: GameState, slotIndex: number): string | null {
  const id = slotIndex >= 0 && slotIndex < DOCTRINE_SLOT_COUNT ? (s.doctrineSlotCatalogIds[slotIndex] ?? null) : null;
  const play = doctrineCardPlayability(s, id, null, slotIndex);
  if (play.kind === "mana") return null;
  return play.reason;
}

export function canPlaceStructureHere(
  s: GameState,
  catalogId: string,
  pos: Vec2,
  slotIndex: number,
): string | null {
  const entry = getCatalogEntry(catalogId);
  if (!entry || !isStructureEntry(entry)) return "Not a structure card.";
  return doctrineCardPlayability(s, catalogId, pos, slotIndex).reason;
}

const ENEMY_KEEP_EXCLUSION_RADIUS = 24;

/** Validates a position for an AI-placed enemy structure (no doctrine slot). */
export function canPlaceEnemyStructureAt(s: GameState, catalogId: string, pos: Vec2): string | null {
  const entry = getCatalogEntry(catalogId);
  if (!entry || !isStructureEntry(entry)) return "Not a structure.";
  if (s.enemyFlux < entry.fluxCost) return "Enemy lacks Mana.";
  if (!inEnemyTerritory(s, pos)) return "Outside enemy territory.";
  const keep = findKeep(s);
  if (keep) {
    const dx = pos.x - keep.x;
    const dz = pos.z - keep.z;
    if (dx * dx + dz * dz < ENEMY_KEEP_EXCLUSION_RADIUS * ENEMY_KEEP_EXCLUSION_RADIUS) {
      return "Too close to Wizard Keep.";
    }
  }
  if (circleOverlapsMapObstacles(s.map, pos, STRUCTURE_MAP_OBSTACLE_RADIUS, structureObstacleFootprints(s))) {
    return "Blocked by terrain.";
  }
  return null;
}

/**
 * Specific, player-facing explanation of why a card cannot be used right now.
 * Mirrors the shared doctrine card gates: cooldown, Mana, territory, enemy
 * proximity, and terrain. A null result means playable.
 */
export function placementFailureReason(
  s: GameState,
  catalogId: string,
  pos: Vec2 | null,
  slotIndex: number,
): string | null {
  return doctrineCardPlayability(s, catalogId, pos, slotIndex).reason;
}

/** Map signal → display color (HSL). Used by 3D and cards for visual consistency. */
export function signalColorHex(sig: SignalType | undefined): number {
  switch (sig) {
    case "Vanguard":
      return 0xe06b3a;
    case "Bastion":
      return 0x4da3ff;
    case "Reclaim":
      return 0x5fc48a;
    default:
      return 0x8ea0b8;
  }
}

/** Dominant signal for a structure's visual. */
export function dominantSignal(entry: CatalogEntry | null): SignalType | undefined {
  if (!entry || !isStructureEntry(entry)) return undefined;
  if (entry.signalTypes.length === 0) return undefined;
  const counts: Record<SignalType, number> = { Vanguard: 0, Bastion: 0, Reclaim: 0 };
  for (const s of entry.signalTypes) counts[s]++;
  let best: SignalType = entry.signalTypes[0]!;
  let bestN = -1;
  for (const k of Object.keys(counts) as SignalType[]) {
    if (counts[k] > bestN) {
      bestN = counts[k];
      best = k;
    }
  }
  return best;
}
