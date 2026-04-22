import { DEFAULT_DOCTRINE_SLOTS, getCatalogEntry } from "./catalog";
import { logGame } from "./gameLog";
import {
  DOCTRINE_COMMANDS_ENABLED,
  DOCTRINE_SLOT_COUNT,
  ENEMY_RELAY_MAX_HP,
  ENEMY_SETUP_STARTING_FLUX,
  FORWARD_PLACE_RADIUS,
  HERO_FOLLOW_RADIUS,
  HERO_MAX_HP,
  HERO_SPEED,
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
} from "./constants";
import { unitStatsForCatalog } from "./sim/systems/helpers";
import type {
  CatalogEntry,
  GamePhase,
  MapData,
  SignalType,
  TeamId,
  TapSlotDef,
  UnitSizeClass,
  UnitTrait,
  Vec2,
} from "./types";
import { isCommandEntry, isStructureEntry } from "./types";

export type CastFxKind =
  | "firestorm"
  | "shatter"
  | "fortify"
  | "muster"
  | "recycle"
  | "claim"
  | "lightning"
  | "hero_strike";

/** One throttled combat telegraph: wedge rooted on attacker, opening toward target. */
export interface CombatHitMark {
  ax: number;
  az: number;
  tx: number;
  tz: number;
  /** Weapon reach used to cap wedge length (world units). */
  range: number;
  /** Wider cone for breath-style AoE attackers. */
  wide: boolean;
}

export interface CastFxEvent {
  kind: CastFxKind;
  x: number;
  z: number;
  tick: number;
  /** Strike origin (wizard xz) — when set, renderer draws a bolt from here to (x,z). */
  fromX?: number;
  fromZ?: number;
}

/** Arcane strike / rival strike FX: impact at `target`, optional bolt from `from`. */
export function emitHeroStrikeFx(s: GameState, target: Vec2, from: Vec2): void {
  s.lastFx = {
    kind: "hero_strike",
    x: target.x,
    z: target.z,
    tick: s.tick,
    fromX: from.x,
    fromZ: from.z,
  };
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
  speedPerSec: number;
  /** Follow-aura pickup radius. */
  radius: number;
  /** Index into state.taps currently being claimed, or null. */
  claimChannelTarget: number | null;
  claimChannelTicksRemaining: number;
  hp: number;
  maxHp: number;
  facing: number;
  /** -1 / 0 / 1 strafe (world X) from WASD; cleared after each sim tick. */
  wasdStrafe: number;
  /** -1 / 0 / 1 forward (world -Z as "up" in key W) from WASD; cleared after each sim tick. */
  wasdForward: number;
  attackCooldownTicksRemaining: number;
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
  pop: number;
  speedPerSec: number;
  range: number;
  dmgPerTick: number;
  visualSeed: number;
  antiClass?: UnitSizeClass;
  trait?: UnitTrait;
  aoeRadius?: number;
  flying?: boolean;
  /** Signal inherited from parent structure (for coloring). */
  signal?: SignalType;
  /** Bonus vs enemy relays / structures (Siege Works). Default 1 when unset. */
  damageVsStructuresMult?: number;
}

export interface MatchStats {
  structuresBuilt: number;
  structuresLost: number;
  unitsProduced: number;
  unitsLost: number;
  salvageRecovered: number;
  enemyKills: number;
  commandsCast: number;
  /** Enemy units spawned this match (initial camps + reinforcements). Win "routed" only counts if this is > 0. */
  enemyUnitsSpawned: number;
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
  nextId: { structure: number; unit: number };
  doctrineSlotCatalogIds: (string | null)[];
  /** Remaining placements per doctrine slot (match start). */
  doctrineChargesRemaining: number[];
  doctrineCooldownTicks: number[];
  selectedDoctrineIndex: number | null;
  /** @deprecated No longer set by gameplay; kept for replay/checksum compat. */
  selectedStructureId: number | null;
  /** Friendly unit picked for range preview (LMB on unit when not placing/casting). */
  selectedUnitId: number | null;
  /**
   * Throttled combat telegraphs for this tick (attacker-anchored wedges); renderer consumes and clears.
   * Not part of replay checksum.
   */
  combatHitMarks: CombatHitMark[];
  pendingPlacementCatalogId: string | null;
  /** Global stance for friendly units. Offense → seek/engage; Defense → rally to wizard. */
  armyStance: ArmyStance;
  /** After R / rally button: next map click sets `globalRally*`. */
  rallyClickPending: boolean;
  /** When true (offense only), player units march to `globalRallyX/Z` until stance toggles. */
  globalRallyActive: boolean;
  globalRallyX: number;
  globalRallyZ: number;
  enemyCampAwake: Record<string, boolean>;
  lastMessage: string;
  /** Seeded RNG state (xorshift32). */
  rngState: number;
  /** Per-match counters for end-screen / telemetry. */
  stats: MatchStats;
  /** Per camp id: remaining HP for optional scenario core (see `EnemyCampDef.coreMaxHp`). */
  enemyCampCoreHp: Record<string, number>;
  /** Most recent spell cast event; renderer consumes and clears each sync. */
  lastFx: CastFxEvent | null;
  /** One-shot flag: at least one player unit dealt bonus damage to an enemy building this tick. Set by combat.ts, consumed by renderer. */
  lastSiegeHit: { x: number; z: number; tick: number } | null;
  /** Player-controlled hero wizard. */
  hero: HeroRuntime;
  /** AI opponent wizard — claims taps for `enemy`, spends `enemyFlux`, builds enemy towers. */
  enemyHero: HeroRuntime;
  /** Enemy team's Mana (from enemy-owned taps). */
  enemyFlux: number;
}

/** Seeded xorshift32 PRNG on state. Returns [0, 1). */
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
  return wizardTier(s) >= Math.max(1, entry.requiredRelayTier || 1);
}

export function enemyTierRequirementSatisfied(s: GameState, entry: CatalogEntry): boolean {
  return enemyWizardTier(s) >= Math.max(1, entry.requiredRelayTier || 1);
}

/** Signals are no longer required in the wizard build — keep the hook for
 *  back-compat with catalog entries that still carry `requiredSignalCounts`. */
export function signalCountsSatisfied(_s: GameState, _entry: CatalogEntry): boolean {
  return true;
}

export function meetsSignalRequirements(s: GameState, entry: CatalogEntry): boolean {
  return tierRequirementSatisfied(s, entry);
}

export function meetsEnemyStructureRequirements(s: GameState, entry: CatalogEntry): boolean {
  return enemyTierRequirementSatisfied(s, entry);
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
 * One-time match init: optionally strip command cards, then sort remaining structure
 * ids by ascending flux cost (stable tie-break by id). Packs to DOCTRINE_SLOT_COUNT slots, nulls last.
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
  const structs: { id: string; cost: number }[] = [];
  for (const id of slots) {
    if (!id) continue;
    const e = getCatalogEntry(id);
    if (!e) continue;
    if (isCommandEntry(e)) continue;
    if (isStructureEntry(e)) structs.push({ id, cost: e.fluxCost });
  }
  structs.sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));
  const out: (string | null)[] = structs.map((s) => s.id);
  while (out.length < DOCTRINE_SLOT_COUNT) out.push(null);
  return out.slice(0, DOCTRINE_SLOT_COUNT);
}

/** Spawn the Wizard Keep at playerStart — complete immediately, no build time,
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
export function mapWithRuntimeTapSlots(map: MapData, taps: TapRuntime[]): MapData {
  const tapSlots: TapSlotDef[] = taps.map((t) => ({ id: t.defId, x: t.x, z: t.z }));
  return { ...map, tapSlots };
}

function spawnKeep(state: GameState): void {
  const entry = getCatalogEntry(KEEP_ID);
  if (!entry || !isStructureEntry(entry)) return;
  const p = state.map.playerStart ?? { x: 0, z: 0 };
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
  });
}

export function createInitialState(map: MapData, doctrineSlots?: (string | null)[]): GameState {
  const rawSlots = doctrineSlots ?? [...DEFAULT_DOCTRINE_SLOTS];
  const slots = normalizeDoctrineSlotsForMatch(rawSlots);
  const rt = initDoctrineRuntime(slots);

  const rngScratch = { v: 0xc0ffee01 >>> 0 };
  const taps: TapRuntime[] =
    map.useAuthorTapSlots && map.tapSlots.length > 0
      ? map.tapSlots.map((ts) => ({
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

  const hpMult = map.difficulty?.enemyHpMult ?? 1;
  const dmgMult = map.difficulty?.enemyDmgMult ?? 1;

  const heroSpawn = mapResolved.playerStart ?? { x: 0, z: 0 };
  const hero: HeroRuntime = {
    x: heroSpawn.x,
    z: heroSpawn.z,
    targetX: null,
    targetZ: null,
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
  };

  const enemySpawn =
    mapResolved.enemyStart ??
    ({ x: -heroSpawn.x, z: heroSpawn.z } as Vec2);
  const enemyHero: HeroRuntime = {
    x: enemySpawn.x,
    z: enemySpawn.z,
    targetX: null,
    targetZ: null,
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
  };

  const state: GameState = {
    map: mapResolved,
    tick: 0,
    phase: "playing",
    flux: PLAYER_STARTING_FLUX,
    salvage: 0,
    enemyFlux: ENEMY_SETUP_STARTING_FLUX,
    taps,
    enemyRelays,
    structures: [],
    units: [],
    nextId: { structure: 1, unit: 1 },
    doctrineSlotCatalogIds: slots,
    doctrineChargesRemaining: rt.charges,
    doctrineCooldownTicks: rt.cd,
    selectedDoctrineIndex: null,
    selectedStructureId: null,
    selectedUnitId: null,
    combatHitMarks: [],
    pendingPlacementCatalogId: null,
    armyStance: "offense",
    rallyClickPending: false,
    globalRallyActive: false,
    globalRallyX: 0,
    globalRallyZ: 0,
    enemyCampAwake: Object.fromEntries(mapResolved.enemyCamps.map((c) => [c.id, true])),
    lastMessage: "Battle on — claim nodes, summon towers, break the enemy.",
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
    },
    enemyCampCoreHp: {},
    lastFx: null,
    lastSiegeHit: null,
    hero,
    enemyHero,
  };

  spawnKeep(state);

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
    const roster = camp.roster ?? defaultOffsets.map((o, i) => ({
      sizeClass: (i % 2 === 0 ? "Line" : "Swarm") as UnitSizeClass,
      offset: o,
    }));
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

/** Territory = union of `TERRITORY_RADIUS` around the Keep and claimed taps. */
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

export function canUseDoctrineSlot(s: GameState, slotIndex: number): string | null {
  if (slotIndex < 0 || slotIndex >= DOCTRINE_SLOT_COUNT) return "Invalid doctrine slot.";
  const id = s.doctrineSlotCatalogIds[slotIndex] ?? null;
  if (!id) return "Empty doctrine slot.";
  const e = getCatalogEntry(id);
  if (!e) return "Unknown entry.";
  if ((s.doctrineCooldownTicks[slotIndex] ?? 0) > 0) return "Doctrine slot on cooldown.";
  if (!meetsSignalRequirements(s, e)) return "Tier requirements not met.";
  return null;
}

export function canPlaceStructureHere(
  s: GameState,
  catalogId: string,
  pos: Vec2,
  slotIndex: number,
): string | null {
  const entry = getCatalogEntry(catalogId);
  if (!entry || !isStructureEntry(entry)) return "Not a structure card.";
  const slotErr = canUseDoctrineSlot(s, slotIndex);
  if (slotErr) return slotErr;
  if (s.flux < entry.fluxCost) return "Not enough Mana.";
  if (nearestEnemyAggroBlocked(s, pos)) return "Too close to enemy (aggro).";
  if (!inPlayerTerritory(s, pos) && !nearSafeDeployAura(s, pos)) {
    return "Must place inside your territory (cyan area). Claim more nodes to expand.";
  }
  return null;
}

const ENEMY_KEEP_EXCLUSION_RADIUS = 24;

/** Validates a position for an AI-placed enemy structure (no doctrine slot). */
export function canPlaceEnemyStructureAt(s: GameState, catalogId: string, pos: Vec2): string | null {
  const entry = getCatalogEntry(catalogId);
  if (!entry || !isStructureEntry(entry)) return "Not a structure.";
  if (!meetsEnemyStructureRequirements(s, entry)) return "Enemy tier too low.";
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
  return null;
}

/**
 * Specific, player-facing explanation of why a tower cannot be placed right now
 * at `pos`. Mirrors `canPlaceStructureHere` gate order but returns a targeted
 * sentence per failing gate (tier count, flux deficit, territory).
 */
export function placementFailureReason(
  s: GameState,
  catalogId: string,
  pos: Vec2 | null,
  slotIndex: number,
): string | null {
  const entry = getCatalogEntry(catalogId);
  if (!entry) return "Unknown card.";

  const cdTicks = s.doctrineCooldownTicks[slotIndex] ?? 0;
  if (cdTicks > 0) {
    const secs = Math.max(1, Math.ceil(cdTicks / TICK_HZ));
    return `Card on cooldown (${secs}s).`;
  }
  const tier = wizardTier(s);
  const need = Math.max(1, entry.requiredRelayTier || 1);
  if (tier < need) {
    const taps = claimedTapCount(s);
    const nextNeed = need === 2 ? 2 : 4;
    return `Requires wizard tier ${need} (claim ${nextNeed} Mana nodes — you have ${taps}).`;
  }

  if (s.flux < entry.fluxCost) {
    return `Need ${entry.fluxCost} Mana (have ${Math.floor(s.flux)}).`;
  }

  if (isStructureEntry(entry) && pos) {
    if (nearestEnemyAggroBlocked(s, pos)) return "Too close to enemy — can't summon here.";
    if (!inPlayerTerritory(s, pos) && !nearSafeDeployAura(s, pos)) {
      return "Outside your territory — claim more Mana nodes to expand the cyan area.";
    }
  }

  return null;
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
