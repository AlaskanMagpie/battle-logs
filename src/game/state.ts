import { DEFAULT_DOCTRINE_SLOTS, getCatalogEntry } from "./catalog";
import {
  FORWARD_PLACE_RADIUS,
  INFRA_PLACE_RADIUS,
  PLAYER_STARTING_FLUX,
} from "./constants";
import type { CatalogEntry, MapData, SignalType, TeamId, UnitSizeClass, Vec2 } from "./types";
import { isStructureEntry } from "./types";

export interface TapRuntime {
  defId: string;
  x: number;
  z: number;
  active: boolean;
  yieldRemaining: number;
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
  enemyCampAwake: Record<string, boolean>;
  playerRelaysEverBuilt: number;
  loseGraceTicksRemaining: number;
  lastMessage: string;
}

function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function unitStats(size: UnitSizeClass): {
  maxHp: number;
  speedPerSec: number;
  range: number;
  dmgPerTick: number;
  pop: number;
} {
  switch (size) {
    case "Swarm":
      return { maxHp: 28, speedPerSec: 9, range: 7, dmgPerTick: 0.55, pop: 4 };
    case "Line":
      return { maxHp: 55, speedPerSec: 6, range: 2.2, dmgPerTick: 0.45, pop: 2 };
    case "Heavy":
      return { maxHp: 140, speedPerSec: 4, range: 2.8, dmgPerTick: 0.95, pop: 4 };
    case "Titan":
      return { maxHp: 420, speedPerSec: 3, range: 5, dmgPerTick: 1.8, pop: 8 };
  }
}

export function playerRelaySignalCounts(s: GameState): Record<SignalType, number> {
  const c: Record<SignalType, number> = { Vanguard: 0, Bastion: 0, Reclaim: 0 };
  for (const pr of s.playerRelays) {
    if (!pr.built || pr.destroyed) continue;
    for (const sig of pr.signalTypes) c[sig]++;
  }
  return c;
}

export function meetsSignalRequirements(s: GameState, entry: CatalogEntry): boolean {
  if (builtPlayerRelayCount(s) < entry.requiredRelayTier) return false;
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
  }));

  const playerRelays: PlayerRelayRuntime[] = map.playerRelaySlots.map((r) => ({
    defId: r.id,
    x: r.x,
    z: r.z,
    built: false,
    destroyed: false,
    hp: 0,
    maxHp: 260,
    signalTypes: ["Vanguard"] as SignalType[],
  }));

  const enemyRelays: EnemyRelayRuntime[] = map.enemyRelaySlots.map((r) => ({
    defId: r.id,
    x: r.x,
    z: r.z,
    hp: 520,
    maxHp: 520,
  }));

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
    enemyCampAwake: Object.fromEntries(map.enemyCamps.map((c) => [c.id, false])),
    playerRelaysEverBuilt: 0,
    loseGraceTicksRemaining: 0,
    lastMessage:
      "Pick Doctrine (or defaults), Start. Tap → Relay (Shift+click built Relay to cycle Signal) → place Structures / Commands.",
  };

  const camp = map.enemyCamps[0];
  if (camp) {
    const offsets: Vec2[] = [
      { x: 4, z: 0 },
      { x: -3, z: 3 },
      { x: 0, z: -4 },
      { x: 6, z: 4 },
      { x: -5, z: -2 },
    ];
    for (let i = 0; i < offsets.length; i++) {
      const sz: UnitSizeClass = i % 2 === 0 ? "Line" : "Swarm";
      const st = unitStats(sz);
      state.units.push({
        id: state.nextId.unit++,
        team: "enemy",
        structureId: null,
        x: camp.origin.x + offsets[i]!.x,
        z: camp.origin.z + offsets[i]!.z,
        hp: st.maxHp,
        maxHp: st.maxHp,
        sizeClass: sz,
        pop: st.pop,
        speedPerSec: st.speedPerSec,
        range: st.range,
        dmgPerTick: st.dmgPerTick,
        visualSeed: (Math.random() * 0xffffffff) >>> 0,
      });
    }
  }

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

export function nearFriendlyForward(s: GameState, pos: Vec2): boolean {
  if (nearFriendlyInfra(s, pos)) return false;
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
  const infra = nearFriendlyInfra(s, pos);
  const fwd = nearFriendlyForward(s, pos);
  if (!infra && !fwd) return "Must place near Tap/Relay, or forward near a friendly unit/structure (not on infra).";
  return null;
}
