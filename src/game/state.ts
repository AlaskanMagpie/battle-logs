import { DEFAULT_DOCTRINE_SLOTS, getCatalogEntry } from "./catalog";
import {
  ENEMY_RELAY_MAX_HP,
  FORWARD_PLACE_RADIUS,
  HERO_FOLLOW_RADIUS,
  HERO_MAX_HP,
  HERO_SPEED,
  INFRA_PLACE_RADIUS,
  PLAYER_RELAY_MAX_HP,
  PLAYER_STARTING_FLUX,
  TERRITORY_RADIUS,
  TICK_HZ,
} from "./constants";
import { unitStatsForCatalog } from "./sim/systems/helpers";
import type {
  CatalogEntry,
  MapData,
  SignalType,
  TeamId,
  UnitSizeClass,
  UnitTrait,
  Vec2,
} from "./types";
import { isStructureEntry } from "./types";

export type CastFxKind =
  | "firestorm"
  | "shatter"
  | "fortify"
  | "muster"
  | "recycle"
  | "claim"
  | "lightning";

export interface CastFxEvent {
  kind: CastFxKind;
  x: number;
  z: number;
  tick: number;
}

export interface TapRuntime {
  defId: string;
  x: number;
  z: number;
  active: boolean;
  yieldRemaining: number;
  /** Ownership: "player" once the hero claims, unset otherwise. */
  ownerTeam?: TeamId;
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
}

export interface PlayerRelayRuntime {
  defId: string;
  x: number;
  z: number;
  built: boolean;
  destroyed: boolean;
  hp: number;
  maxHp: number;
  signalTypes: SignalType[];
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
  /** True if placed via forward placement (not near Tap/Relay). */
  placementForward: boolean;
  /** Fortify damage reduction end tick (0 if inactive). */
  damageReductionUntilTick: number;
  /** Production silence end tick (Shatter / signal loss uses requirement check separately). */
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
  phase: "playing" | "win" | "lose";
  flux: number;
  salvage: number;
  taps: TapRuntime[];
  playerRelays: PlayerRelayRuntime[];
  enemyRelays: EnemyRelayRuntime[];
  structures: StructureRuntime[];
  units: UnitRuntime[];
  nextId: { structure: number; unit: number };
  doctrineSlotCatalogIds: (string | null)[];
  /** Remaining placements per doctrine slot (match start). */
  doctrineChargesRemaining: number[];
  doctrineCooldownTicks: number[];
  selectedDoctrineIndex: number | null;
  selectedStructureId: number | null;
  pendingPlacementCatalogId: string | null;
  /** Slot index awaiting a signal-type choice before build proceeds. */
  pendingRelaySignalSlot: number | null;
  enemyCampAwake: Record<string, boolean>;
  playerRelaysEverBuilt: number;
  loseGraceTicksRemaining: number;
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
  /** Player-controlled hero. */
  hero: HeroRuntime;
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

export function playerRelaySignalCounts(s: GameState): Record<SignalType, number> {
  const c: Record<SignalType, number> = { Vanguard: 0, Bastion: 0, Reclaim: 0 };
  for (const pr of s.playerRelays) {
    if (!pr.built || pr.destroyed) continue;
    for (const sig of pr.signalTypes) c[sig]++;
  }
  return c;
}

export function relayTierSatisfied(s: GameState, entry: CatalogEntry): boolean {
  return builtPlayerRelayCount(s) >= entry.requiredRelayTier;
}

export function signalCountsSatisfied(s: GameState, entry: CatalogEntry): boolean {
  const req = entry.requiredSignalCounts;
  if (!req) return true;
  const have = playerRelaySignalCounts(s);
  for (const k of Object.keys(req) as SignalType[]) {
    const need = req[k] ?? 0;
    if (need <= 0) continue;
    if ((have[k] ?? 0) < need) return false;
  }
  return true;
}

export function meetsSignalRequirements(s: GameState, entry: CatalogEntry): boolean {
  return relayTierSatisfied(s, entry) && signalCountsSatisfied(s, entry);
}

function initDoctrineRuntime(slots: (string | null)[]): { charges: number[]; cd: number[] } {
  const charges: number[] = [];
  const cd: number[] = [];
  for (let i = 0; i < 16; i++) {
    const id = slots[i] ?? null;
    const e = getCatalogEntry(id);
    charges.push(e ? e.maxCharges : 0);
    cd.push(0);
  }
  return { charges, cd };
}

export function createInitialState(map: MapData, doctrineSlots?: (string | null)[]): GameState {
  const slots = doctrineSlots ?? [...DEFAULT_DOCTRINE_SLOTS];
  const rt = initDoctrineRuntime(slots);

  const taps: TapRuntime[] = map.tapSlots.map((t) => ({
    defId: t.id,
    x: t.x,
    z: t.z,
    active: false,
    yieldRemaining: 0,
    ownerTeam: undefined,
  }));

  const playerRelays: PlayerRelayRuntime[] = map.playerRelaySlots.map((r) => ({
    defId: r.id,
    x: r.x,
    z: r.z,
    built: false,
    destroyed: false,
    hp: 0,
    maxHp: PLAYER_RELAY_MAX_HP,
    signalTypes: [] as SignalType[],
  }));

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

  const heroSpawn = map.playerRelaySlots[0] ?? map.playerStart ?? { x: 0, z: 0 };
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
  };

  const state: GameState = {
    map,
    tick: 0,
    phase: "playing",
    flux: PLAYER_STARTING_FLUX,
    salvage: 0,
    taps,
    playerRelays,
    enemyRelays,
    structures: [],
    units: [],
    nextId: { structure: 1, unit: 1 },
    doctrineSlotCatalogIds: slots,
    doctrineChargesRemaining: rt.charges,
    doctrineCooldownTicks: rt.cd,
    selectedDoctrineIndex: null,
    selectedStructureId: null,
    pendingPlacementCatalogId: null,
    pendingRelaySignalSlot: null,
    enemyCampAwake: Object.fromEntries(map.enemyCamps.map((c) => [c.id, false])),
    playerRelaysEverBuilt: 0,
    loseGraceTicksRemaining: 0,
    lastMessage:
      "Pick Doctrine (or defaults), Start. Tap → build Relay (choose Signal) → place Structures / Commands.",
    rngState: 0xc0ffee01 >>> 0,
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
  };

  const defaultOffsets: Vec2[] = [
    { x: 4, z: 0 },
    { x: -3, z: 3 },
    { x: 0, z: -4 },
    { x: 6, z: 4 },
    { x: -5, z: -2 },
  ];
  for (const camp of map.enemyCamps) {
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

export function builtPlayerRelayCount(s: GameState): number {
  return s.playerRelays.filter((r) => r.built && !r.destroyed).length;
}

export function totalPlayerPop(s: GameState): number {
  return s.units.filter((u) => u.team === "player").reduce((a, u) => a + u.pop, 0);
}

export function localPopForStructure(s: GameState, structureId: number): number {
  return s.units
    .filter((u) => u.team === "player" && u.structureId === structureId)
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

export function nearFriendlyInfra(s: GameState, pos: Vec2): boolean {
  const r2 = INFRA_PLACE_RADIUS * INFRA_PLACE_RADIUS;
  for (const t of s.taps) {
    if (!t.active) continue;
    if (dist2(pos, t) <= r2) return true;
  }
  for (const pr of s.playerRelays) {
    if (!pr.built || pr.destroyed) continue;
    if (dist2(pos, pr) <= r2) return true;
  }
  return false;
}

/** Territory = union of `TERRITORY_RADIUS` around built player relays and claimed (player-owned) taps. */
export function inPlayerTerritory(s: GameState, pos: Vec2): boolean {
  const r2 = TERRITORY_RADIUS * TERRITORY_RADIUS;
  for (const pr of s.playerRelays) {
    if (!pr.built || pr.destroyed) continue;
    if (dist2(pos, pr) <= r2) return true;
  }
  for (const t of s.taps) {
    if (!t.active || t.ownerTeam !== "player") continue;
    if (dist2(pos, t) <= r2) return true;
  }
  return false;
}

/** Current list of positions feeding the territory union (relays + claimed taps). */
export function territorySources(s: GameState): Vec2[] {
  const out: Vec2[] = [];
  for (const pr of s.playerRelays) {
    if (pr.built && !pr.destroyed) out.push({ x: pr.x, z: pr.z });
  }
  for (const t of s.taps) {
    if (t.active && t.ownerTeam === "player") out.push({ x: t.x, z: t.z });
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
  const id = s.doctrineSlotCatalogIds[slotIndex] ?? null;
  if (!id) return "Empty doctrine slot.";
  const e = getCatalogEntry(id);
  if (!e) return "Unknown entry.";
  if ((s.doctrineCooldownTicks[slotIndex] ?? 0) > 0) return "Doctrine slot on cooldown.";
  if ((s.doctrineChargesRemaining[slotIndex] ?? 0) <= 0) return "No charges remaining for this slot.";
  if (!meetsSignalRequirements(s, e)) return "Relay / Signal requirements not met.";
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
  if (s.flux < entry.fluxCost) return "Not enough Flux.";
  if (nearestEnemyAggroBlocked(s, pos)) return "Too close to enemy (aggro).";
  if (!inPlayerTerritory(s, pos) && !nearSafeDeployAura(s, pos)) {
    return "Must place inside your territory (cyan area). Claim more nodes to expand.";
  }
  return null;
}

/**
 * Specific, player-facing explanation of why a tower cannot be placed right now
 * at `pos`. Mirrors `canPlaceStructureHere` gate order but returns a targeted
 * sentence per failing gate (tier count, signal gap, flux deficit, territory).
 * Returns `null` when the placement is valid — callers should treat that as
 * "Ready to build". Pass `pos=null` for gate checks that don't need a world
 * position (hand-card locked state).
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
  const charges = s.doctrineChargesRemaining[slotIndex] ?? 0;
  if (charges <= 0) return "No charges remaining.";

  const relays = builtPlayerRelayCount(s);
  if (relays < entry.requiredRelayTier) {
    return `Requires ${entry.requiredRelayTier} Relay${entry.requiredRelayTier === 1 ? "" : "s"} built (you have ${relays}).`;
  }

  const req = entry.requiredSignalCounts;
  if (req) {
    const have = playerRelaySignalCounts(s);
    const gaps: string[] = [];
    for (const k of Object.keys(req) as SignalType[]) {
      const need = req[k] ?? 0;
      const got = have[k] ?? 0;
      if (got < need) gaps.push(`${need - got} ${k}`);
    }
    if (gaps.length > 0) return `Needs Relay signal: ${gaps.join(", ")}.`;
  }

  if (s.flux < entry.fluxCost) {
    return `Need ${entry.fluxCost} Flux (have ${Math.floor(s.flux)}).`;
  }

  // Position-dependent gates apply to structures only. Commands resolve their
  // targeting at cast time (handled by commandTargetingHint / intent).
  if (isStructureEntry(entry) && pos) {
    if (nearestEnemyAggroBlocked(s, pos)) return "Too close to enemy — can't build here.";
    if (!inPlayerTerritory(s, pos) && !nearSafeDeployAura(s, pos)) {
      return "Outside your territory — claim more nodes to expand the cyan area.";
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
