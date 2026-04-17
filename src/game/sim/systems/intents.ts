import { getCatalogEntry } from "../../catalog";
import {
  COMMAND_FRIENDLY_PRESENCE_RADIUS,
  FORWARD_BUILD_TIME_MULT,
  RELAY_COSTS_FLUX,
  RELAY_REBUILD_COST,
  SHATTER_TARGET_RADIUS,
  TAP_ACTIVATE_COST,
  TAP_YIELD_MAX,
  TICK_HZ,
} from "../../constants";
import type { PlayerIntent } from "../../intents";
import {
  canPlaceStructureHere,
  canUseDoctrineSlot,
  nearFriendlyInfra,
  nearFriendlyForward,
  nearSafeDeployAura,
  type CastFxKind,
  type GameState,
  type StructureRuntime,
} from "../../state";
import type { SignalType, Vec2 } from "../../types";
import { isCommandEntry, isStructureEntry } from "../../types";
import { dist2 } from "./helpers";

const SIGNAL_CYCLE: SignalType[] = ["Vanguard", "Bastion", "Reclaim"];
const ALT_HOLD_PICK_RADIUS = 6;

const PICK_TAP = 4;
const PICK_RELAY = 5;
const PICK_STRUCTURE = 5;

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

function pickEnemyRelay(s: GameState, pos: Vec2): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  const maxD2 = PICK_STRUCTURE * PICK_STRUCTURE;
  for (let i = 0; i < s.enemyRelays.length; i++) {
    const er = s.enemyRelays[i]!;
    if (er.hp <= 0) continue;
    const d = dist2(pos, er);
    if (d <= maxD2 && d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function relayBuildCostForSlot(s: GameState, slotIndex: number): number {
  const slot = s.playerRelays[slotIndex];
  if (!slot) return Infinity;
  if (slot.destroyed) return RELAY_REBUILD_COST;
  if (slotIndex === 0) return 0;
  return RELAY_COSTS_FLUX[Math.min(slotIndex, RELAY_COSTS_FLUX.length - 1)] ?? 0;
}

function canBuildRelaySlot(s: GameState, slotIndex: number): string | null {
  const slot = s.playerRelays[slotIndex];
  if (!slot) return "No such Relay slot.";
  if (slot.built && !slot.destroyed) return "Relay already active.";
  const cost = relayBuildCostForSlot(s, slotIndex);
  if (s.flux < cost) return "Not enough Flux for Relay.";
  return null;
}

function tryBuildRelayWithSignal(s: GameState, slotIndex: number, signal: SignalType): void {
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
  slot.signalTypes = [signal];
  s.playerRelaysEverBuilt += 1;
  s.pendingRelaySignalSlot = null;
  s.lastMessage = `Relay ${slotIndex + 1} online (−${cost} Flux), signal ${signal}.`;
}

function cycleRelaySignal(s: GameState, relayIndex: number): void {
  const slot = s.playerRelays[relayIndex];
  if (!slot || !slot.built || slot.destroyed) return;
  const cur = slot.signalTypes[0];
  const idx = cur ? SIGNAL_CYCLE.indexOf(cur) : -1;
  const next = SIGNAL_CYCLE[(idx + 1) % SIGNAL_CYCLE.length]!;
  slot.signalTypes = [next];
  s.lastMessage = `Relay ${relayIndex + 1} signal → ${next}.`;
}

function tryActivateTap(s: GameState, tapIndex: number): void {
  const tap = s.taps[tapIndex];
  if (!tap) return;
  if (tap.active) {
    s.lastMessage = "Tap already active.";
    return;
  }
  if (s.flux < TAP_ACTIVATE_COST) {
    s.lastMessage = `Need ${TAP_ACTIVATE_COST} Flux to activate Tap.`;
    return;
  }
  s.flux -= TAP_ACTIVATE_COST;
  tap.active = true;
  tap.ownerTeam = "player";
  tap.yieldRemaining = TAP_YIELD_MAX;
  s.lastMessage = "Tap activated (+1 Flux/sec, finite yield).";
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
  const infra = nearFriendlyInfra(s, pos) || nearSafeDeployAura(s, pos);
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
    damageReductionUntilTick: 0,
    productionSilenceUntilTick: 0,
    holdOrders: false,
  };
  s.structures.push(st);
  s.stats.structuresBuilt += 1;
  emitSummonFx(s, catalogId, pos);
  s.doctrineChargesRemaining[doctrineSlotIndex] = Math.max(
    0,
    s.doctrineChargesRemaining[doctrineSlotIndex]! - 1,
  );
  if (s.doctrineChargesRemaining[doctrineSlotIndex]! <= 0) {
    s.doctrineCooldownTicks[doctrineSlotIndex] = Math.round(def.chargeCooldownSeconds * TICK_HZ);
  }
  s.pendingPlacementCatalogId = null;
  s.selectedDoctrineIndex = null;
  s.lastMessage = `${def.name} placed${placementForward ? " (forward — slower build, fragile)" : ""} (building…).`;
}

function consumeCommandSlot(s: GameState, slotIdx: number, cooldownSec: number): void {
  s.doctrineChargesRemaining[slotIdx] = Math.max(0, s.doctrineChargesRemaining[slotIdx]! - 1);
  if (s.doctrineChargesRemaining[slotIdx]! <= 0) {
    s.doctrineCooldownTicks[slotIdx] = Math.round(cooldownSec * TICK_HZ);
  }
  s.pendingPlacementCatalogId = null;
  s.selectedDoctrineIndex = null;
}

function hasFriendlyPresenceNear(s: GameState, pos: Vec2, radius: number): boolean {
  const r2 = radius * radius;
  for (const u of s.units) {
    if (u.team !== "player" || u.hp <= 0) continue;
    if (dist2(u, pos) <= r2) return true;
  }
  for (const st of s.structures) {
    if (st.team !== "player" || !st.complete) continue;
    if (dist2(st, pos) <= r2) return true;
  }
  return false;
}

function payCmd(s: GameState, cost: number, salvagePct: number): void {
  s.flux -= cost;
  const sal = (cost * salvagePct) / 100;
  s.salvage += sal;
  s.stats.salvageRecovered += sal;
  s.stats.commandsCast += 1;
}

function emitFx(s: GameState, kind: CastFxKind, pos: Vec2): void {
  s.lastFx = { kind, x: pos.x, z: pos.z, tick: s.tick };
}

/**
 * Summon FX hook for building placements. Always drops a lightning strike; add
 * structure-specific flourishes here later (e.g. signal-tinted auras, ground burn
 * for Vanguard, cyan shield pulse for Bastion) by branching on `entry` / `pos`.
 */
function emitSummonFx(s: GameState, _catalogId: string, pos: Vec2): void {
  emitFx(s, "lightning", pos);
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

  const fx = cmd.effect;
  switch (fx.type) {
    case "recycle_structure": {
      const stId = pickPlayerStructure(s, pos);
      if (stId === null) {
        s.lastMessage = "Recycle: click one of your structures.";
        return;
      }
      const st = s.structures.find((x) => x.id === stId);
      if (!st || st.team !== "player") return;
      const target: Vec2 = { x: st.x, z: st.z };
      payCmd(s, cmd.fluxCost, cmd.salvagePctOnCast);
      const bdef = getCatalogEntry(st.catalogId);
      if (bdef && isStructureEntry(bdef)) {
        const refund = bdef.fluxCost * 0.9;
        s.salvage += refund;
        s.stats.salvageRecovered += refund;
      }
      s.units = s.units.filter((u) => u.structureId !== st.id);
      s.structures = s.structures.filter((x) => x.id !== st.id);
      consumeCommandSlot(s, slotIdx, cmd.chargeCooldownSeconds);
      emitFx(s, "recycle", target);
      s.lastMessage = "Recycle — structure scrapped, Salvage refunded.";
      return;
    }
    case "aoe_damage": {
      if (!hasFriendlyPresenceNear(s, pos, COMMAND_FRIENDLY_PRESENCE_RADIUS)) {
        s.lastMessage = `${cmd.name}: requires friendly presence near the target.`;
        return;
      }
      payCmd(s, cmd.fluxCost, cmd.salvagePctOnCast);
      const r2 = fx.radius * fx.radius;
      for (const u of s.units) {
        if (u.team !== "enemy" || u.hp <= 0) continue;
        if (dist2(u, pos) <= r2) u.hp -= fx.damage;
      }
      for (const er of s.enemyRelays) {
        if (er.hp <= 0) continue;
        if (dist2(er, pos) <= r2) er.hp -= fx.damage * 0.5;
      }
      consumeCommandSlot(s, slotIdx, cmd.chargeCooldownSeconds);
      emitFx(s, "firestorm", pos);
      s.lastMessage = `${cmd.name} detonated.`;
      return;
    }
    case "buff_structure": {
      const stId = pickPlayerStructure(s, pos);
      if (stId === null) {
        s.lastMessage = `${cmd.name}: click one of your structures.`;
        return;
      }
      const st = s.structures.find((x) => x.id === stId);
      if (!st) return;
      payCmd(s, cmd.fluxCost, cmd.salvagePctOnCast);
      st.damageReductionUntilTick = s.tick + Math.round(fx.durationSeconds * TICK_HZ);
      consumeCommandSlot(s, slotIdx, cmd.chargeCooldownSeconds);
      emitFx(s, "fortify", { x: st.x, z: st.z });
      s.lastMessage = `${cmd.name}: ${fx.damageReductionPct}% damage reduction for ${fx.durationSeconds}s.`;
      return;
    }
    case "muster_structure": {
      const stId = pickPlayerStructure(s, pos);
      if (stId === null) {
        s.lastMessage = `${cmd.name}: click one of your structures.`;
        return;
      }
      const st = s.structures.find((x) => x.id === stId);
      if (!st || !st.complete) {
        s.lastMessage = `${cmd.name}: target must be a completed structure.`;
        return;
      }
      payCmd(s, cmd.fluxCost, cmd.salvagePctOnCast);
      st.productionTicksRemaining = 1;
      consumeCommandSlot(s, slotIdx, cmd.chargeCooldownSeconds);
      emitFx(s, "muster", { x: st.x, z: st.z });
      s.lastMessage = `${cmd.name}: next unit produced immediately.`;
      return;
    }
    case "shatter_structure": {
      const erIdx = pickEnemyRelay(s, pos);
      if (erIdx === null) {
        s.lastMessage = `${cmd.name}: click an enemy Relay.`;
        return;
      }
      payCmd(s, cmd.fluxCost, cmd.salvagePctOnCast);
      const er = s.enemyRelays[erIdx]!;
      er.hp -= fx.damage;
      const silenceTick = s.tick + Math.round(fx.silenceSeconds * TICK_HZ);
      er.silencedUntilTick = silenceTick;
      const r2 = SHATTER_TARGET_RADIUS * SHATTER_TARGET_RADIUS;
      for (const st of s.structures) {
        if (st.team !== "enemy") continue;
        if (dist2(st, { x: er.x, z: er.z }) <= r2) {
          st.productionSilenceUntilTick = Math.max(st.productionSilenceUntilTick, silenceTick);
        }
      }
      consumeCommandSlot(s, slotIdx, cmd.chargeCooldownSeconds);
      emitFx(s, "shatter", { x: er.x, z: er.z });
      s.lastMessage = `${cmd.name}: Relay takes ${fx.damage} damage + ${fx.silenceSeconds}s silence.`;
      return;
    }
    case "noop": {
      payCmd(s, cmd.fluxCost, cmd.salvagePctOnCast);
      consumeCommandSlot(s, slotIdx, cmd.chargeCooldownSeconds);
      s.lastMessage = `${cmd.name} spent.`;
      return;
    }
  }
}

function nearestPlayerStructureWithin(
  s: GameState,
  pos: Vec2,
  radius: number,
): StructureRuntime | null {
  let best: StructureRuntime | null = null;
  let bestD = radius * radius;
  for (const st of s.structures) {
    if (st.team !== "player") continue;
    const d = dist2(pos, st);
    if (d <= bestD) {
      bestD = d;
      best = st;
    }
  }
  return best;
}

function handleWorldClick(
  s: GameState,
  pos: Vec2,
  shiftKey: boolean,
  altKey: boolean,
): void {
  if (altKey) {
    const stIdExact = pickPlayerStructure(s, pos);
    const stExact = stIdExact !== null ? s.structures.find((x) => x.id === stIdExact) : null;
    const st = stExact ?? nearestPlayerStructureWithin(s, pos, ALT_HOLD_PICK_RADIUS);
    if (st && st.team === "player") {
      st.holdOrders = !st.holdOrders;
      s.lastMessage = st.holdOrders ? "Orders: Hold." : "Orders: Rally.";
    } else {
      s.lastMessage = "Alt+click a friendly structure to toggle Hold.";
    }
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
    if (slot.built && !slot.destroyed) {
      if (shiftKey) {
        cycleRelaySignal(s, relayI);
        return;
      }
    } else {
      const err = canBuildRelaySlot(s, relayI);
      if (err) {
        s.lastMessage = err;
        return;
      }
      s.pendingRelaySignalSlot = relayI;
      s.pendingPlacementCatalogId = null;
      s.selectedDoctrineIndex = null;
      s.selectedStructureId = null;
      s.lastMessage = `Relay ${relayI + 1} — choose Signal: Vanguard / Bastion / Reclaim.`;
      return;
    }
  }

  const stId = pickPlayerStructure(s, pos);
  if (stId !== null) {
    s.selectedStructureId = stId;
    s.pendingPlacementCatalogId = null;
    s.selectedDoctrineIndex = null;
    s.lastMessage = "Structure selected — click ground to set rally, or toggle Hold.";
    return;
  }

  if (s.selectedStructureId !== null) {
    const st = s.structures.find((x) => x.id === s.selectedStructureId);
    if (st && st.team === "player") {
      st.rallyX = pos.x;
      st.rallyZ = pos.z;
      st.holdOrders = false;
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
      s.pendingRelaySignalSlot = null;
      s.lastMessage = e
        ? `Selected ${e.name} — ${isCommandEntry(e) ? "click to cast." : "click map to place."}`
        : `Selected ${id}`;
    } else if (it.type === "clear_placement") {
      s.pendingPlacementCatalogId = null;
      s.selectedDoctrineIndex = null;
      s.pendingRelaySignalSlot = null;
      s.lastMessage = "Cleared placement selection.";
    } else if (it.type === "try_click_world") {
      handleWorldClick(s, it.pos, it.shiftKey === true, it.altKey === true);
    } else if (it.type === "confirm_relay_signal") {
      const idx = s.pendingRelaySignalSlot;
      if (idx === null) continue;
      tryBuildRelayWithSignal(s, idx, it.signal);
    } else if (it.type === "cancel_relay_signal") {
      if (s.pendingRelaySignalSlot !== null) {
        s.pendingRelaySignalSlot = null;
        s.lastMessage = "Relay build cancelled.";
      }
    } else if (it.type === "toggle_structure_orders") {
      const st = s.structures.find((x) => x.id === it.structureId);
      if (st && st.team === "player") {
        st.holdOrders = !st.holdOrders;
        s.lastMessage = st.holdOrders ? "Orders: Hold." : "Orders: Rally.";
      }
    } else if (it.type === "hero_move") {
      const half = s.map.world.halfExtents;
      s.hero.targetX = Math.max(-half, Math.min(half, it.x));
      s.hero.targetZ = Math.max(-half, Math.min(half, it.z));
      if (s.hero.claimChannelTarget !== null) {
        s.hero.claimChannelTarget = null;
        s.hero.claimChannelTicksRemaining = 0;
      }
    } else if (it.type === "hero_cancel_claim") {
      if (s.hero.claimChannelTarget !== null) {
        s.hero.claimChannelTarget = null;
        s.hero.claimChannelTicksRemaining = 0;
        s.lastMessage = "Claim cancelled.";
      }
    } else if (it.type === "hero_claim") {
      // Nudge: stop current move so the hero system can pick up a nearby tap this tick.
      s.hero.targetX = null;
      s.hero.targetZ = null;
    }
  }
}
