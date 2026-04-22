import { getCatalogEntry } from "../../catalog";
import {
  COMMAND_FRIENDLY_PRESENCE_RADIUS,
  DOCTRINE_COMMANDS_ENABLED,
  DOCTRINE_SLOT_COUNT,
  FORWARD_BUILD_TIME_MULT,
  SHATTER_TARGET_RADIUS,
  TICK_HZ,
} from "../../constants";
import { logGame } from "../../gameLog";
import type { PlayerIntent } from "../../intents";
import {
  canPlaceStructureHere,
  canUseDoctrineSlot,
  isKeep,
  nearFriendlyInfra,
  nearFriendlyForward,
  nearSafeDeployAura,
  type CastFxKind,
  type GameState,
  type StructureRuntime,
} from "../../state";
import type { Vec2 } from "../../types";
import { isCommandEntry, isStructureEntry } from "../../types";
import { dist2 } from "./helpers";
import { tryPlayerHeroStrike, type PlayerHeroStrikeTag } from "./heroStrike";

const ALT_HOLD_PICK_RADIUS = 6;

const PICK_STRUCTURE = 5;

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
  if (def.chargeCooldownSeconds > 0) {
    s.doctrineCooldownTicks[doctrineSlotIndex] = Math.round(def.chargeCooldownSeconds * TICK_HZ);
  }
  s.pendingPlacementCatalogId = null;
  s.selectedDoctrineIndex = null;
  s.lastMessage = `${def.name} summoned${placementForward ? " (forward — slower build, fragile)" : ""} — lightning crackles.`;
}

function consumeCommandSlot(s: GameState, slotIdx: number, cooldownSec: number): void {
  if (cooldownSec > 0) {
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

/** Shift+click a friendly tower — instant next spawn, no Mana, no doctrine slot (replaces the old Muster spell). */
function tryFreeMuster(s: GameState, st: StructureRuntime): boolean {
  if (st.team !== "player") return false;
  if (!st.complete) {
    s.lastMessage = "Muster: wait for the structure to finish building.";
    return true;
  }
  st.productionTicksRemaining = 1;
  emitFx(s, "lightning", { x: st.x, z: st.z });
  emitFx(s, "muster", { x: st.x, z: st.z });
  s.lastMessage = "Mustered — next unit spawns now (free).";
  logGame("input", `Free muster → structure #${st.id} (${st.catalogId})`, s.tick);
  return true;
}

/**
 * Summon FX hook for building placements. Always drops a lightning strike at
 * the summoned tower — this is the signature wizard flourish. The main hook
 * keeps the door open for signal-specific flourishes (Vanguard ground burn,
 * Bastion shield pulse, Reclaim restore glow) by branching on catalogId.
 */
function emitSummonFx(s: GameState, _catalogId: string, pos: Vec2): void {
  emitFx(s, "lightning", pos);
}

function tryHeroAttack(s: GameState, _click: Vec2): void {
  if (s.phase !== "playing") return;
  const h = s.hero;
  if (h.attackCooldownTicksRemaining > 0) {
    s.lastMessage = "Attack on cooldown.";
    return;
  }
  const r = tryPlayerHeroStrike(s);
  if (!r.ok) {
    s.lastMessage = "No target in melee range.";
    logGame("attack", "Wizard swing — no target in range", s.tick);
    return;
  }
  const msg: Record<PlayerHeroStrikeTag, string> = {
    unit: "Arcane strike!",
    enemyWizard: "Strike the rival Wizard!",
    fortress: "Strike the fortress!",
    structure: "Strike the enemy tower!",
    tap: "Strike the enemy Mana anchor!",
  };
  s.lastMessage = msg[r.tag];
}

function tryCastCommand(s: GameState, pos: Vec2, slotIdx: number): void {
  if (!DOCTRINE_COMMANDS_ENABLED) return;
  const id = s.doctrineSlotCatalogIds[slotIdx] ?? null;
  const cmd = getCatalogEntry(id);
  if (!cmd || !isCommandEntry(cmd)) return;
  const slotErr = canUseDoctrineSlot(s, slotIdx);
  if (slotErr) {
    s.lastMessage = slotErr;
    return;
  }
  if (s.flux < cmd.fluxCost) {
    s.lastMessage = "Not enough Mana for this spell.";
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
      if (isKeep(st)) {
        s.lastMessage = "The Keep cannot be recycled.";
        return;
      }
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
      emitFx(s, "lightning", target);
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
      emitFx(s, "lightning", pos);
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
      emitFx(s, "lightning", { x: st.x, z: st.z });
      emitFx(s, "fortify", { x: st.x, z: st.z });
      s.lastMessage = `${cmd.name}: ${fx.damageReductionPct}% damage reduction for ${fx.durationSeconds}s.`;
      return;
    }
    case "shatter_structure": {
      const erIdx = pickEnemyRelay(s, pos);
      if (erIdx === null) {
        s.lastMessage = `${cmd.name}: click an enemy Dark Fortress.`;
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
      emitFx(s, "lightning", { x: er.x, z: er.z });
      emitFx(s, "shatter", { x: er.x, z: er.z });
      s.lastMessage = `${cmd.name}: Fortress takes ${fx.damage} damage + ${fx.silenceSeconds}s silence.`;
      return;
    }
    case "noop": {
      payCmd(s, cmd.fluxCost, cmd.salvagePctOnCast);
      consumeCommandSlot(s, slotIdx, cmd.chargeCooldownSeconds);
      emitFx(s, "lightning", pos);
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
  pickedUnitId?: number | null,
): void {
  if (s.phase !== "playing") return;
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

  if (shiftKey && !s.pendingPlacementCatalogId) {
    const stId = pickPlayerStructure(s, pos);
    if (stId !== null) {
      const st = s.structures.find((x) => x.id === stId);
      if (st && tryFreeMuster(s, st)) return;
    }
  }

  const pending = s.pendingPlacementCatalogId;
  const slotIdx = s.selectedDoctrineIndex;
  if (pending && slotIdx !== null) {
    const entry = getCatalogEntry(pending);
    if (entry && isCommandEntry(entry)) {
      if (DOCTRINE_COMMANDS_ENABLED) tryCastCommand(s, pos, slotIdx);
      return;
    }
    if (entry && isStructureEntry(entry)) {
      tryPlaceStructure(s, pending, pos, slotIdx);
      return;
    }
  }

  if (s.rallyClickPending) {
    s.rallyClickPending = false;
    s.globalRallyActive = true;
    s.globalRallyX = pos.x;
    s.globalRallyZ = pos.z;
    s.lastMessage =
      "Rally point set — army marches there in Offense (toggle G to change stance and cancel march).";
    return;
  }

  if (pickedUnitId != null) {
    const u = s.units.find((x) => x.id === pickedUnitId);
    if (u && u.hp > 0) {
      if (u.team === "player") {
        s.selectedUnitId = s.selectedUnitId === u.id ? null : u.id;
        s.selectedStructureId = null;
        s.lastMessage = s.selectedUnitId
          ? `Troop selected — melee range ${u.range.toFixed(1)}.`
          : "Troop deselected.";
        return;
      }
      s.selectedUnitId = null;
    }
  }

  tryHeroAttack(s, pos);
}

function clearGlobalRally(s: GameState): void {
  s.globalRallyActive = false;
  s.rallyClickPending = false;
}

export function applyPlayerIntents(s: GameState, intents: PlayerIntent[]): void {
  for (const it of intents) {
    if (it.type === "select_doctrine_slot") {
      if (it.index < 0 || it.index >= DOCTRINE_SLOT_COUNT) continue;
      const id = s.doctrineSlotCatalogIds[it.index] ?? null;
      if (!id) {
        s.lastMessage = "Empty doctrine slot.";
        continue;
      }
      const e = getCatalogEntry(id);
      if (!DOCTRINE_COMMANDS_ENABLED && e && isCommandEntry(e)) {
        s.lastMessage = "Command spells are disabled.";
        continue;
      }
      s.selectedDoctrineIndex = it.index;
      s.pendingPlacementCatalogId = id;
      s.selectedStructureId = null;
      s.selectedUnitId = null;
      s.rallyClickPending = false;
      s.lastMessage = e
        ? `Selected ${e.name} — ${isCommandEntry(e) ? "click to cast." : "click map to summon."}`
        : `Selected ${id}`;
    } else if (it.type === "begin_rally_click") {
      if (s.phase !== "playing") continue;
      s.rallyClickPending = !s.rallyClickPending;
      s.lastMessage = s.rallyClickPending
        ? "Rally armed — click the map to set rally (R again to cancel)."
        : "Rally arm cancelled.";
    } else if (it.type === "clear_placement") {
      s.pendingPlacementCatalogId = null;
      s.selectedDoctrineIndex = null;
      s.selectedUnitId = null;
      s.rallyClickPending = false;
      s.lastMessage = "Cleared placement selection.";
    } else if (it.type === "try_click_world") {
      handleWorldClick(s, it.pos, it.shiftKey === true, it.altKey === true, it.pickedUnitId);
    } else if (it.type === "toggle_structure_orders") {
      const st = s.structures.find((x) => x.id === it.structureId);
      if (st && st.team === "player") {
        st.holdOrders = !st.holdOrders;
        s.lastMessage = st.holdOrders ? "Orders: Hold." : "Orders: Rally.";
      }
    } else if (it.type === "set_army_stance") {
      if (s.armyStance !== it.stance) {
        clearGlobalRally(s);
        s.armyStance = it.stance;
        s.lastMessage =
          it.stance === "defense"
            ? "Stance: Defense — army rallying on the Wizard."
            : "Stance: Offense — army seeks out foes.";
      }
    } else if (it.type === "toggle_army_stance") {
      clearGlobalRally(s);
      s.armyStance = s.armyStance === "offense" ? "defense" : "offense";
      s.lastMessage =
        s.armyStance === "defense"
          ? "Stance: Defense — army rallying on the Wizard."
          : "Stance: Offense — army seeks out foes.";
    } else if (it.type === "hero_move") {
      const half = s.map.world.halfExtents;
      s.hero.targetX = Math.max(-half, Math.min(half, it.x));
      s.hero.targetZ = Math.max(-half, Math.min(half, it.z));
      if (s.hero.claimChannelTarget !== null) {
        s.hero.claimChannelTarget = null;
        s.hero.claimChannelTicksRemaining = 0;
      }
      logGame("move", `Move order → (${it.x.toFixed(1)}, ${it.z.toFixed(1)})`, s.tick);
    } else if (it.type === "hero_wasd") {
      const sx = Math.max(-1, Math.min(1, it.strafe));
      const sz = Math.max(-1, Math.min(1, it.forward));
      s.hero.wasdStrafe = sx;
      s.hero.wasdForward = sz;
    } else if (it.type === "hero_cancel_claim") {
      if (s.hero.claimChannelTarget !== null) {
        s.hero.claimChannelTarget = null;
        s.hero.claimChannelTicksRemaining = 0;
        s.lastMessage = "Claim cancelled.";
      }
    } else if (it.type === "hero_claim") {
      s.hero.targetX = null;
      s.hero.targetZ = null;
    } else if (it.type === "start_battle") {
      /* No setup phase — match begins in playing. Intent kept for replay compat. */
    }
  }
}
