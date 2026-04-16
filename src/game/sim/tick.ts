import { getCatalogEntry } from "../catalog";
import {
  ANTI_CLASS_DAMAGE_MULT,
  CAMP_CORE_ATTACK_RADIUS,
  CAMP_CORE_DAMAGE_PER_UNIT_PER_TICK,
  COMMAND_FRIENDLY_PRESENCE_RADIUS,
  ENEMY_WAVE_EVERY_TICKS,
  ENEMY_WAVE_GLOBAL_CAP,
  FIRESTORM_DAMAGE_PER_UNIT,
  FIRESTORM_RADIUS,
  FORTIFY_DURATION_SEC,
  FORTIFY_INCOMING_DAMAGE_MULT,
  FORWARD_BUILD_INCOMING_DAMAGE_MULT,
  FORWARD_BUILD_TIME_MULT,
  GLOBAL_POP_CAP,
  RELAY_COSTS_FLUX,
  RELAY_LOSS_GRACE_TICKS,
  RELAY_REBUILD_COST,
  SALVAGE_FLUX_CAP_PER_SEC,
  SALVAGE_FLUX_PER_POOL_PER_SEC,
  SALVAGE_RETURN_STRUCTURE_FRAC,
  SALVAGE_RETURN_UNIT_DEATH_FRAC,
  SALVAGE_UNIT_DEATH_COST_SHARE,
  SHATTER_DAMAGE,
  SHATTER_PRODUCTION_PAUSE_SEC,
  SHATTER_TARGET_RADIUS,
  TAP_ACTIVATE_COST,
  TAP_FLUX_PER_SEC,
  TICK_HZ,
} from "../constants";
import type { PlayerIntent } from "../intents";
import {
  builtPlayerRelayCount,
  canPlaceStructureHere,
  canUseDoctrineSlot,
  localPopForStructure,
  meetsSignalRequirements,
  nearFriendlyForward,
  nearFriendlyInfra,
  totalPlayerPop,
  type GameState,
  type StructureRuntime,
  type UnitRuntime,
} from "../state";
import type { CommandCatalogEntry, SignalType, Vec2 } from "../types";
import { isCommandEntry, isStructureEntry } from "../types";

const PICK_TAP = 4;
const PICK_RELAY = 5;
const PICK_STRUCTURE = 5;

const SIGNAL_CYCLE: SignalType[] = ["Vanguard", "Bastion", "Reclaim"];

function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function physicalDamage(attacker: UnitRuntime, defender: UnitRuntime): number {
  let d = attacker.dmgPerTick;
  if (attacker.antiClass && defender.sizeClass === attacker.antiClass) d *= ANTI_CLASS_DAMAGE_MULT;
  if (attacker.sizeClass === "Heavy" || attacker.sizeClass === "Titan") {
    if (defender.sizeClass === "Swarm") d *= 2;
    if (attacker.sizeClass === "Titan" && defender.sizeClass === "Line") d *= 1.5;
  }
  return d;
}

function pickNearestTap(s: GameState, pos: Vec2): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  const maxD2 = PICK_TAP * PICK_TAP;
  for (let i = 0; i < s.taps.length; i++) {
    const t = s.taps[i]!;
    const d = dist2(pos, t);
    if (d <= maxD2 && d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function pickNearestPlayerRelay(s: GameState, pos: Vec2): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  const maxD2 = PICK_RELAY * PICK_RELAY;
  for (let i = 0; i < s.playerRelays.length; i++) {
    const r = s.playerRelays[i]!;
    const d = dist2(pos, r);
    if (d <= maxD2 && d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function pickPlayerStructure(s: GameState, pos: Vec2): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  const maxD2 = PICK_STRUCTURE * PICK_STRUCTURE;
  for (const st of s.structures) {
    if (st.team !== "player") continue;
    const d = dist2(pos, st);
    if (d <= maxD2 && d < bestD) {
      bestD = d;
      best = st.id;
    }
  }
  return best;
}

function friendlyPresenceNear(s: GameState, pos: Vec2, radius: number): boolean {
  const r2 = radius * radius;
  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    if (dist2(u, pos) <= r2) return true;
  }
  for (const st of s.structures) {
    if (st.team !== "player" || !st.complete) continue;
    if (dist2(st, pos) <= r2) return true;
  }
  for (const pr of s.playerRelays) {
    if (!pr.built || pr.destroyed) continue;
    if (dist2(pr, pos) <= r2) return true;
  }
  for (const t of s.taps) {
    if (!t.active) continue;
    if (dist2(t, pos) <= r2) return true;
  }
  return false;
}

function toggleHoldNear(s: GameState, pos: Vec2): void {
  const r = 5;
  const r2 = r * r;
  let n = 0;
  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    if (dist2(u, pos) > r2) continue;
    u.hold = !u.hold;
    n++;
  }
  s.lastMessage = n > 0 ? `Hold ${n} unit(s) toggled (Alt+click).` : "Alt+click near friendly units to toggle hold.";
}

function deductCommandCast(s: GameState, cmd: CommandCatalogEntry, slotIdx: number): void {
  s.flux -= cmd.fluxCost;
  s.salvage += (cmd.fluxCost * cmd.salvagePctOnCast) / 100;
  s.doctrineChargesRemaining[slotIdx] = Math.max(0, s.doctrineChargesRemaining[slotIdx]! - 1);
  if (s.doctrineChargesRemaining[slotIdx]! <= 0) {
    s.doctrineCooldownTicks[slotIdx] = Math.round(cmd.chargeCooldownSeconds * TICK_HZ);
  }
  s.pendingPlacementCatalogId = null;
  s.selectedDoctrineIndex = null;
  s.matchStats.commandsCast += 1;
}

function relayBuildCostForSlot(s: GameState, slotIndex: number): number {
  const slot = s.playerRelays[slotIndex];
  if (!slot) return Infinity;
  if (slot.destroyed) return RELAY_REBUILD_COST;
  return RELAY_COSTS_FLUX[Math.min(slotIndex, RELAY_COSTS_FLUX.length - 1)] ?? 0;
}

function canBuildRelaySlot(s: GameState, slotIndex: number): string | null {
  for (let j = 0; j < slotIndex; j++) {
    const prev = s.playerRelays[j]!;
    if (!prev.built || prev.destroyed) return "Repair or build earlier Relay slots first.";
  }
  const slot = s.playerRelays[slotIndex]!;
  if (slot.built && !slot.destroyed) return "Relay already active.";
  const cost = relayBuildCostForSlot(s, slotIndex);
  if (s.flux < cost) return "Not enough Flux for Relay.";
  return null;
}

function tryBuildRelay(s: GameState, slotIndex: number): void {
  const err = canBuildRelaySlot(s, slotIndex);
  if (err) {
    s.lastMessage = err;
    return;
  }
  const cost = relayBuildCostForSlot(s, slotIndex);
  const slot = s.playerRelays[slotIndex]!;
  s.flux -= cost;
  slot.built = true;
  slot.destroyed = false;
  slot.hp = slot.maxHp;
  slot.signalTypes = [SIGNAL_CYCLE[slotIndex % 3]!];
  s.playerRelaysEverBuilt = Math.max(s.playerRelaysEverBuilt, builtPlayerRelayCount(s));
  s.lastMessage = `Relay ${slotIndex + 1} online (−${cost} Flux), signal ${slot.signalTypes[0]}.`;
}

function tryActivateTap(s: GameState, tapIndex: number): void {
  const tap = s.taps[tapIndex];
  if (!tap) return;
  if (tap.active) {
    s.lastMessage = "Tap already active.";
    return;
  }
  if (s.flux < TAP_ACTIVATE_COST) {
    s.lastMessage = "Need 80 Flux to activate Tap.";
    return;
  }
  s.flux -= TAP_ACTIVATE_COST;
  tap.active = true;
  tap.yieldRemaining = 250;
  s.lastMessage = "Tap activated (+1 Flux/sec, finite yield).";
}

function unitStatsForCatalog(size: UnitRuntime["sizeClass"]): {
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

function spawnPlayerUnit(s: GameState, st: StructureRuntime): void {
  const def = getCatalogEntry(st.catalogId);
  if (!def || !isStructureEntry(def)) return;
  const stStats = unitStatsForCatalog(def.producedSizeClass);
  const mult = def.producedDamageVsStructuresMult;
  const u: UnitRuntime = {
    id: s.nextId.unit++,
    team: "player",
    structureId: st.id,
    x: st.x + (Math.random() - 0.5) * 2,
    z: st.z + (Math.random() - 0.5) * 2,
    hp: stStats.maxHp,
    maxHp: stStats.maxHp,
    sizeClass: def.producedSizeClass,
    pop: stStats.pop,
    speedPerSec: stStats.speedPerSec,
    range: stStats.range,
    dmgPerTick: stStats.dmgPerTick,
    visualSeed: (Math.random() * 0xffffffff) >>> 0,
    antiClass: def.producedAntiClass,
    hold: false,
    damageVsStructuresMult: mult !== undefined && mult !== 1 ? mult : undefined,
  };
  s.units.push(u);
  s.matchStats.unitsSpawned += 1;
}

function structureLocalCap(st: StructureRuntime): number {
  const def = getCatalogEntry(st.catalogId);
  return def && isStructureEntry(def) ? def.localPopCap : 0;
}

function tryPlaceStructure(
  s: GameState,
  catalogId: string,
  pos: Vec2,
  doctrineSlotIndex: number,
): void {
  const err = canPlaceStructureHere(s, catalogId, pos, doctrineSlotIndex);
  if (err) {
    s.lastMessage = err;
    return;
  }
  const def = getCatalogEntry(catalogId);
  if (!def || !isStructureEntry(def)) {
    s.lastMessage = "Invalid structure.";
    return;
  }
  s.flux -= def.fluxCost;
  const infra = nearFriendlyInfra(s, pos);
  const placementForward = !infra && nearFriendlyForward(s, pos);
  let buildTicks = Math.max(1, Math.round(def.buildSeconds * TICK_HZ));
  if (placementForward) buildTicks = Math.round(buildTicks * FORWARD_BUILD_TIME_MULT);
  const st: StructureRuntime = {
    id: s.nextId.structure++,
    team: "player",
    catalogId,
    x: pos.x,
    z: pos.z,
    hp: def.maxHp,
    maxHp: def.maxHp,
    buildTicksRemaining: buildTicks,
    buildTotalTicks: buildTicks,
    complete: false,
    productionTicksRemaining: Math.round(def.productionSeconds * TICK_HZ),
    doctrineSlotIndex,
    rallyX: pos.x + 12,
    rallyZ: pos.z,
    placementForward,
    fortifyExpiresAtTick: 0,
    productionPausedUntilTick: 0,
  };
  s.structures.push(st);
  s.matchStats.structuresPlaced += 1;
  s.doctrineChargesRemaining[doctrineSlotIndex] = Math.max(0, s.doctrineChargesRemaining[doctrineSlotIndex]! - 1);
  if (s.doctrineChargesRemaining[doctrineSlotIndex]! <= 0) {
    s.doctrineCooldownTicks[doctrineSlotIndex] = Math.round(def.chargeCooldownSeconds * TICK_HZ);
  }
  s.pendingPlacementCatalogId = null;
  s.selectedDoctrineIndex = null;
  s.lastMessage = `${def.name} placed${placementForward ? " (forward — slower build, fragile)" : ""} (building…).`;
}

function tryCastCommand(s: GameState, pos: Vec2, slotIdx: number): void {
  const id = s.doctrineSlotCatalogIds[slotIdx] ?? null;
  const cmd = getCatalogEntry(id);
  if (!cmd || !isCommandEntry(cmd)) return;
  const slotErr = canUseDoctrineSlot(s, slotIdx);
  if (slotErr) {
    s.lastMessage = slotErr;
    return;
  }
  if (s.flux < cmd.fluxCost) {
    s.lastMessage = "Not enough Flux for command.";
    return;
  }

  if (cmd.effect.type === "recycle_structure") {
    const stId = pickPlayerStructure(s, pos);
    if (stId === null) {
      s.lastMessage = "Recycle: click one of your structures.";
      return;
    }
    const st = s.structures.find((x) => x.id === stId);
    if (!st || st.team !== "player") return;
    s.flux -= cmd.fluxCost;
    s.salvage += (cmd.fluxCost * cmd.salvagePctOnCast) / 100;
    const bdef = getCatalogEntry(st.catalogId);
    if (bdef && isStructureEntry(bdef)) s.salvage += bdef.fluxCost * 0.9;
    s.units = s.units.filter((u) => u.structureId !== st.id);
    s.structures = s.structures.filter((x) => x.id !== st.id);
    s.doctrineChargesRemaining[slotIdx] = Math.max(0, s.doctrineChargesRemaining[slotIdx]! - 1);
    if (s.doctrineChargesRemaining[slotIdx]! <= 0) {
      s.doctrineCooldownTicks[slotIdx] = Math.round(cmd.chargeCooldownSeconds * TICK_HZ);
    }
    s.pendingPlacementCatalogId = null;
    s.selectedDoctrineIndex = null;
    s.matchStats.commandsCast += 1;
    s.lastMessage = "Recycle — structure scrapped, Salvage refunded.";
    return;
  }

  const needPresence =
    cmd.effect.type === "fortify_structure" ||
    cmd.effect.type === "firestorm_aoe" ||
    cmd.effect.type === "muster_production" ||
    cmd.effect.type === "shatter_enemy";

  if (needPresence && !friendlyPresenceNear(s, pos, COMMAND_FRIENDLY_PRESENCE_RADIUS)) {
    s.lastMessage = "Need friendly presence near the target area.";
    return;
  }

  if (cmd.effect.type === "fortify_structure") {
    const stId = pickPlayerStructure(s, pos);
    if (stId === null) {
      s.lastMessage = "Fortify: click one of your structures.";
      return;
    }
    const st = s.structures.find((x) => x.id === stId);
    if (!st || st.team !== "player" || !st.complete) {
      s.lastMessage = "Fortify: target must be a completed friendly structure.";
      return;
    }
    deductCommandCast(s, cmd, slotIdx);
    st.fortifyExpiresAtTick = s.tick + Math.round(FORTIFY_DURATION_SEC * TICK_HZ);
    s.lastMessage = "Fortify — structure takes reduced damage for 15s.";
    return;
  }

  if (cmd.effect.type === "firestorm_aoe") {
    deductCommandCast(s, cmd, slotIdx);
    const r2 = FIRESTORM_RADIUS * FIRESTORM_RADIUS;
    let hit = 0;
    for (const u of s.units) {
      if (u.team !== "enemy" || u.hp <= 0) continue;
      if (dist2(u, pos) > r2) continue;
      u.hp -= FIRESTORM_DAMAGE_PER_UNIT;
      hit++;
    }
    s.lastMessage = `Firestorm — ${hit} hostile(s) burned.`;
    return;
  }

  if (cmd.effect.type === "muster_production") {
    const stId = pickPlayerStructure(s, pos);
    if (stId === null) {
      s.lastMessage = "Muster: click one of your structures.";
      return;
    }
    const st = s.structures.find((x) => x.id === stId);
    const def = st ? getCatalogEntry(st.catalogId) : null;
    if (!st || st.team !== "player" || !st.complete || !def || !isStructureEntry(def)) {
      s.lastMessage = "Muster: target must be a completed friendly production structure.";
      return;
    }
    deductCommandCast(s, cmd, slotIdx);
    st.productionTicksRemaining = 0;
    s.lastMessage = "Muster — production ready immediately.";
    return;
  }

  if (cmd.effect.type === "shatter_enemy") {
    const maxR2 = SHATTER_TARGET_RADIUS * SHATTER_TARGET_RADIUS;
    let best: (typeof s.enemyRelays)[0] | null = null;
    let bestD = Infinity;
    for (const er of s.enemyRelays) {
      if (er.hp <= 0) continue;
      const d = dist2(pos, er);
      if (d <= maxR2 && d < bestD) {
        bestD = d;
        best = er;
      }
    }
    if (!best) {
      s.lastMessage = "Shatter: no enemy Relay in range.";
      return;
    }
    deductCommandCast(s, cmd, slotIdx);
    best.hp -= SHATTER_DAMAGE;
    for (const st of s.structures) {
      if (st.team !== "enemy") continue;
      const d = dist2(pos, st);
      if (d > maxR2) continue;
      st.productionPausedUntilTick = s.tick + Math.round(SHATTER_PRODUCTION_PAUSE_SEC * TICK_HZ);
    }
    s.lastMessage = "Shatter — enemy Relay hammered.";
    return;
  }

  deductCommandCast(s, cmd, slotIdx);
  s.lastMessage = `${cmd.name} spent (no effect).`;
}

function handleWorldClick(s: GameState, pos: Vec2, shiftKey: boolean, altKey: boolean): void {
  if (altKey) {
    toggleHoldNear(s, pos);
    return;
  }

  const tapI = pickNearestTap(s, pos);
  if (tapI !== null && !s.taps[tapI]!.active) {
    tryActivateTap(s, tapI);
    return;
  }

  const relayI = pickNearestPlayerRelay(s, pos);
  if (relayI !== null) {
    const slot = s.playerRelays[relayI]!;
    if (slot.built && !slot.destroyed && shiftKey) {
      const cur = slot.signalTypes[0] ?? "Vanguard";
      const idx = SIGNAL_CYCLE.indexOf(cur);
      slot.signalTypes = [SIGNAL_CYCLE[(idx + 1) % 3]!];
      s.lastMessage = `Relay signal → ${slot.signalTypes[0]}`;
      return;
    }
    if (!slot.built || slot.destroyed) {
      tryBuildRelay(s, relayI);
      return;
    }
  }

  const stId = pickPlayerStructure(s, pos);
  if (stId !== null) {
    s.selectedStructureId = stId;
    s.pendingPlacementCatalogId = null;
    s.selectedDoctrineIndex = null;
    s.lastMessage = "Structure selected — click ground to set rally.";
    return;
  }

  if (s.selectedStructureId !== null) {
    const st = s.structures.find((x) => x.id === s.selectedStructureId);
    if (st && st.team === "player") {
      st.rallyX = pos.x;
      st.rallyZ = pos.z;
      s.lastMessage = "Rally updated.";
    }
    return;
  }

  const pending = s.pendingPlacementCatalogId;
  const slotIdx = s.selectedDoctrineIndex;
  if (pending && slotIdx !== null) {
    const entry = getCatalogEntry(pending);
    if (entry && isCommandEntry(entry)) {
      tryCastCommand(s, pos, slotIdx);
      return;
    }
    if (entry && isStructureEntry(entry)) {
      tryPlaceStructure(s, pending, pos, slotIdx);
    }
  }
}

export function applyPlayerIntents(s: GameState, intents: PlayerIntent[]): void {
  for (const it of intents) {
    if (it.type === "select_doctrine_slot") {
      const id = s.doctrineSlotCatalogIds[it.index] ?? null;
      if (!id) {
        s.lastMessage = "Empty doctrine slot.";
        continue;
      }
      const e = getCatalogEntry(id);
      s.selectedDoctrineIndex = it.index;
      s.pendingPlacementCatalogId = id;
      s.selectedStructureId = null;
      s.lastMessage = e
        ? `Selected ${e.name} — ${
            isCommandEntry(e)
              ? "click to cast (Recycle/Fortify/Muster = your structure; Firestorm/Shatter = ground; needs nearby friendlies)."
              : "click map to place."
          }`
        : `Selected ${id}`;
    } else if (it.type === "clear_placement") {
      s.pendingPlacementCatalogId = null;
      s.selectedDoctrineIndex = null;
      s.lastMessage = "Cleared placement selection.";
    } else if (it.type === "try_click_world") {
      handleWorldClick(s, it.pos, Boolean(it.shiftKey), Boolean(it.altKey));
    } else if (it.type === "toggle_hold_at") {
      toggleHoldNear(s, it.pos);
    }
  }
}

function economy(s: GameState): void {
  const perTap = TAP_FLUX_PER_SEC / TICK_HZ;
  for (const t of s.taps) {
    if (!t.active) continue;
    if (t.yieldRemaining <= 0) continue;
    const take = Math.min(t.yieldRemaining, perTap);
    s.flux += take;
    t.yieldRemaining -= take;
  }
}

function salvageTrickle(s: GameState): void {
  if (s.salvage <= 0) return;
  const capPerTick = SALVAGE_FLUX_CAP_PER_SEC / TICK_HZ;
  const ratePerTick = (s.salvage * SALVAGE_FLUX_PER_POOL_PER_SEC) / TICK_HZ;
  const take = Math.min(s.salvage, capPerTick, ratePerTick);
  s.flux += take;
  s.salvage -= take;
}

function tickDoctrineCooldowns(s: GameState): void {
  for (let i = 0; i < 16; i++) {
    const v = s.doctrineCooldownTicks[i] ?? 0;
    if (v > 0) s.doctrineCooldownTicks[i] = v - 1;
  }
}

function buildProgress(s: GameState): void {
  for (const st of s.structures) {
    if (st.complete) continue;
    st.buildTicksRemaining -= 1;
    if (st.buildTicksRemaining <= 0) {
      st.complete = true;
      st.buildTicksRemaining = 0;
    }
  }
}

function production(s: GameState): void {
  for (const st of s.structures) {
    if (st.team !== "player") continue;
    if (!st.complete) continue;
    const def = getCatalogEntry(st.catalogId);
    if (!def || !isStructureEntry(def)) continue;
    if (!meetsSignalRequirements(s, def)) continue;
    if (s.tick < st.productionPausedUntilTick) continue;

    st.productionTicksRemaining -= 1;
    if (st.productionTicksRemaining > 0) continue;

    const localCap = structureLocalCap(st);
    const local = localPopForStructure(s, st.id);
    const global = totalPlayerPop(s);
    const defPop = unitStatsForCatalog(def.producedSizeClass).pop;
    if (local + defPop > localCap) {
      st.productionTicksRemaining = Math.round(0.5 * TICK_HZ);
      continue;
    }
    if (global + defPop > GLOBAL_POP_CAP) {
      st.productionTicksRemaining = Math.round(0.5 * TICK_HZ);
      continue;
    }

    spawnPlayerUnit(s, st);
    st.productionTicksRemaining = Math.round(def.productionSeconds * TICK_HZ);
  }
}

function nearestEnemyUnit(s: GameState, from: Vec2, maxD2: number): UnitRuntime | null {
  let best: UnitRuntime | null = null;
  let bestD = maxD2;
  for (const u of s.units) {
    if (u.team !== "enemy") continue;
    if (u.hp <= 0) continue;
    const d = dist2(from, u);
    if (d < bestD) {
      bestD = d;
      best = u;
    }
  }
  return best;
}

function nearestPlayerStructure(s: GameState, from: Vec2): StructureRuntime | null {
  let best: StructureRuntime | null = null;
  let bestD = Infinity;
  for (const st of s.structures) {
    if (st.team !== "player" || !st.complete) continue;
    const d = dist2(from, st);
    if (d < bestD) {
      bestD = d;
      best = st;
    }
  }
  return best;
}

/** Enemy prefers player structures (PRD), then units. */
function nearestEnemyAttackTarget(s: GameState, from: Vec2): Vec2 | null {
  const st = nearestPlayerStructure(s, from);
  let best: Vec2 | null = null;
  let bestD = Infinity;
  if (st) {
    best = st;
    bestD = dist2(from, st);
  }
  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    const d = dist2(from, u);
    if (d < bestD) {
      bestD = d;
      best = u;
    }
  }
  return best;
}

function moveToward(u: UnitRuntime, target: Vec2, step: number): void {
  const dx = target.x - u.x;
  const dz = target.z - u.z;
  const len = Math.hypot(dx, dz) || 1;
  const mx = (dx / len) * step;
  const mz = (dz / len) * step;
  if (len <= step) {
    u.x = target.x;
    u.z = target.z;
  } else {
    u.x += mx;
    u.z += mz;
  }
}

function clampToWorld(s: GameState, u: UnitRuntime): void {
  const h = s.map.world.halfExtents;
  u.x = Math.max(-h, Math.min(h, u.x));
  u.z = Math.max(-h, Math.min(h, u.z));
}

function movement(s: GameState): void {
  const stepScale = 1 / TICK_HZ;

  for (const camp of s.map.enemyCamps) {
    const awake = s.enemyCampAwake[camp.id];
    if (!awake) continue;
    for (const u of s.units) {
      if (u.team !== "enemy" || u.hp <= 0) continue;
      const tgt = nearestEnemyAttackTarget(s, u);
      if (!tgt) continue;
      const detect = Math.max(10, u.range * 3);
      if (dist2(u, tgt) > detect * detect) continue;
      moveToward(u, tgt, u.speedPerSec * stepScale);
      clampToWorld(s, u);
    }
  }

  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    if (u.hold) {
      clampToWorld(s, u);
      continue;
    }
    const st = s.structures.find((x) => x.id === u.structureId);
    const rally: Vec2 = st ? { x: st.rallyX, z: st.rallyZ } : { x: u.x, z: u.z };
    const detect = Math.max(10, u.range * 3);
    const foe = nearestEnemyUnit(s, u, detect * detect);
    if (foe && dist2(u, foe) > u.range * u.range) {
      moveToward(u, foe, u.speedPerSec * stepScale);
    } else if (!foe) {
      moveToward(u, rally, u.speedPerSec * stepScale);
    }
    clampToWorld(s, u);
  }
}

function combat(s: GameState): void {
  for (const u of s.units) {
    if (u.hp <= 0) continue;
    const foeTeam = u.team === "player" ? "enemy" : "player";
    let best: UnitRuntime | null = null;
    let bestD = u.range * u.range;
    for (const o of s.units) {
      if (o.team !== foeTeam || o.hp <= 0) continue;
      const d = dist2(u, o);
      if (d <= bestD) {
        bestD = d;
        best = o;
      }
    }
    if (best) best.hp -= physicalDamage(u, best);
  }

  for (const st of s.structures) {
    if (!st.complete || st.team !== "player") continue;
    const def = getCatalogEntry(st.catalogId);
    if (!def || !isStructureEntry(def) || def.damagePerTick <= 0) continue;
    const turretRange = def.turretRange ?? 6;
    const r2 = turretRange * turretRange;
    let best: UnitRuntime | null = null;
    let bestD = r2;
    for (const o of s.units) {
      if (o.team !== "enemy" || o.hp <= 0) continue;
      const d = dist2(st, o);
      if (d <= bestD) {
        bestD = d;
        best = o;
      }
    }
    if (best) best.hp -= def.damagePerTick;
  }

  for (const u of s.units) {
    if (u.team !== "enemy" || u.hp <= 0) continue;
    let best: StructureRuntime | null = null;
    let bestD = 2.5 * 2.5;
    for (const st of s.structures) {
      if (st.team !== "player") continue;
      const d = dist2(u, st);
      if (d <= bestD) {
        bestD = d;
        best = st;
      }
    }
    if (best) {
      let incoming = u.dmgPerTick * 0.35;
      if (!best.complete && best.placementForward) incoming *= FORWARD_BUILD_INCOMING_DAMAGE_MULT;
      if (s.tick < best.fortifyExpiresAtTick) incoming *= FORTIFY_INCOMING_DAMAGE_MULT;
      best.hp -= incoming;
    }

    let bestRelay: (typeof s.playerRelays)[0] | null = null;
    let bestRd = 2.2 * 2.2;
    for (const pr of s.playerRelays) {
      if (!pr.built || pr.destroyed) continue;
      const d = dist2(u, pr);
      if (d <= bestRd) {
        bestRd = d;
        bestRelay = pr;
      }
    }
    if (bestRelay) bestRelay.hp -= u.dmgPerTick * 0.45;
  }

  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    for (const er of s.enemyRelays) {
      if (er.hp <= 0) continue;
      if (dist2(u, er) <= u.range * u.range) {
        const mult = u.damageVsStructuresMult ?? 1;
        er.hp -= u.dmgPerTick * 0.5 * mult;
      }
    }
  }

  for (const camp of s.map.enemyCamps) {
    const cur = s.enemyCampCoreHp[camp.id];
    if (cur === undefined || cur <= 0) continue;
    if (!s.enemyCampAwake[camp.id]) continue;
    const r2 = CAMP_CORE_ATTACK_RADIUS * CAMP_CORE_ATTACK_RADIUS;
    let dmg = 0;
    for (const u of s.units) {
      if (u.team !== "player" || u.hp <= 0) continue;
      if (dist2(u, camp.origin) <= r2) dmg += CAMP_CORE_DAMAGE_PER_UNIT_PER_TICK;
    }
    if (dmg > 0) s.enemyCampCoreHp[camp.id] = Math.max(0, cur - dmg);
  }
}

function salvageFromDeadUnits(s: GameState, dead: UnitRuntime[]): void {
  for (const u of dead) {
    if (u.team !== "player") continue;
    const st = s.structures.find((x) => x.id === u.structureId);
    const def = st ? getCatalogEntry(st.catalogId) : null;
    if (def && isStructureEntry(def)) {
      s.salvage +=
        def.fluxCost *
        SALVAGE_RETURN_UNIT_DEATH_FRAC *
        SALVAGE_UNIT_DEATH_COST_SHARE *
        (u.pop / Math.max(def.localPopCap, 1));
    }
  }
}

function salvageFromDeadStructures(s: GameState, dead: StructureRuntime[]): void {
  for (const st of dead) {
    if (st.team !== "player") continue;
    const def = getCatalogEntry(st.catalogId);
    if (def && isStructureEntry(def)) s.salvage += def.fluxCost * SALVAGE_RETURN_STRUCTURE_FRAC;
  }
}

function cleanupDead(s: GameState): void {
  const deadUnits = s.units.filter((u) => u.hp <= 0);
  salvageFromDeadUnits(s, deadUnits);
  s.units = s.units.filter((u) => u.hp > 0);

  const deadStructs = s.structures.filter((st) => st.hp <= 0);
  salvageFromDeadStructures(s, deadStructs);
  for (const st of s.structures) {
    if (st.hp <= 0) st.hp = 0;
  }
  s.structures = s.structures.filter((st) => st.hp > 0);

  for (const pr of s.playerRelays) {
    if (!pr.built) continue;
    if (pr.hp <= 0 && !pr.destroyed) {
      pr.destroyed = true;
      pr.built = false;
      pr.hp = 0;
      s.lastMessage = "Player Relay destroyed.";
    }
  }
  for (const er of s.enemyRelays) {
    if (er.hp <= 0) er.hp = 0;
  }
}

function wakeCamps(s: GameState): void {
  for (const camp of s.map.enemyCamps) {
    if (s.enemyCampAwake[camp.id]) continue;
    const r = camp.wakeRadius;
    for (const u of s.units) {
      if (u.team !== "player") continue;
      if (dist2(u, camp.origin) <= r * r) {
        s.enemyCampAwake[camp.id] = true;
        s.lastMessage = "Enemy camp alerted.";
        break;
      }
    }
    for (const st of s.structures) {
      if (st.team !== "player" || !st.complete) continue;
      if (dist2(st, camp.origin) <= r * r) {
        s.enemyCampAwake[camp.id] = true;
        s.lastMessage = "Enemy camp alerted.";
        break;
      }
    }
  }
}

function maybeEnemyReinforcements(s: GameState): void {
  let anyAwake = false;
  for (const c of s.map.enemyCamps) {
    if (s.enemyCampAwake[c.id]) {
      anyAwake = true;
      break;
    }
  }
  if (!anyAwake) return;
  if (s.tick === 0 || s.tick % ENEMY_WAVE_EVERY_TICKS !== 0) return;
  const alive = s.units.filter((u) => u.team === "enemy" && u.hp > 0).length;
  if (alive >= ENEMY_WAVE_GLOBAL_CAP) return;
  const camp = s.map.enemyCamps.find((c) => s.enemyCampAwake[c.id]) ?? s.map.enemyCamps[0];
  if (!camp) return;
  const st = unitStatsForCatalog("Swarm");
  s.units.push({
    id: s.nextId.unit++,
    team: "enemy",
    structureId: null,
    x: camp.origin.x + (Math.random() - 0.5) * 4,
    z: camp.origin.z + (Math.random() - 0.5) * 4,
    hp: st.maxHp,
    maxHp: st.maxHp,
    sizeClass: "Swarm",
    pop: st.pop,
    speedPerSec: st.speedPerSec,
    range: st.range,
    dmgPerTick: st.dmgPerTick,
    visualSeed: (Math.random() * 0xffffffff) >>> 0,
    hold: false,
  });
}

function loseCheck(s: GameState): void {
  const active = builtPlayerRelayCount(s);
  if (s.playerRelaysEverBuilt > 0 && active === 0) {
    if (s.loseGraceTicksRemaining <= 0) s.loseGraceTicksRemaining = RELAY_LOSS_GRACE_TICKS;
  } else if (active > 0) {
    s.loseGraceTicksRemaining = 0;
  }

  if (s.loseGraceTicksRemaining > 0) {
    s.loseGraceTicksRemaining -= 1;
    if (s.loseGraceTicksRemaining <= 0 && builtPlayerRelayCount(s) === 0) {
      s.phase = "lose";
      s.lastMessage = "Defeat — all Relays lost.";
    }
  }
}

function winCheck(s: GameState): void {
  const relaysDead =
    s.enemyRelays.length > 0 ? s.enemyRelays.every((r) => r.hp <= 0) : false;
  const enemiesDead = !s.units.some((u) => u.team === "enemy" && u.hp > 0);
  const hasCoreObjective = s.map.enemyCamps.some(
    (c) => typeof c.coreMaxHp === "number" && c.coreMaxHp > 0,
  );
  const coresDestroyed =
    hasCoreObjective &&
    s.map.enemyCamps.every((c) => {
      if (!(typeof c.coreMaxHp === "number" && c.coreMaxHp > 0)) return true;
      return (s.enemyCampCoreHp[c.id] ?? 0) <= 0;
    });
  if (relaysDead || enemiesDead || coresDestroyed) {
    s.phase = "win";
    if (relaysDead) s.lastMessage = "Victory — enemy Relays eliminated.";
    else if (enemiesDead) s.lastMessage = "Victory — hostile force routed.";
    else s.lastMessage = "Victory — camp core destroyed.";
  }
}

export function advanceTick(s: GameState, intents: PlayerIntent[]): void {
  if (s.phase !== "playing") return;
  tickDoctrineCooldowns(s);
  applyPlayerIntents(s, intents);
  economy(s);
  salvageTrickle(s);
  buildProgress(s);
  production(s);
  wakeCamps(s);
  maybeEnemyReinforcements(s);
  movement(s);
  combat(s);
  cleanupDead(s);
  loseCheck(s);
  winCheck(s);
  s.tick += 1;
}
