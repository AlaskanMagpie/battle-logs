import { getCatalogEntry } from "../../catalog";
import {
  DOCTRINE_COMMANDS_ENABLED,
  DOCTRINE_SLOT_COUNT,
  FORWARD_BUILD_TIME_MULT,
  FORWARD_STRUCTURE_HP_MULT,
  HERO_MAP_OBSTACLE_RADIUS,
  HERO_MOVE_WAYPOINT_CAP,
  HERO_TELEPORT_DEST_RADIUS,
  HERO_TELEPORT_UNIT_RADIUS,
  SHATTER_TARGET_RADIUS,
  TICK_HZ,
} from "../../constants";
import { logGame } from "../../gameLog";
import type { PlayerIntent } from "../../intents";
import { circleOverlapsMapObstacles, resolveCircleAgainstMapObstacles } from "../../mapObstacles";
import {
  canPlaceStructureHere,
  canUseDoctrineSlot,
  heroTeleportCooldownSeconds,
  isKeep,
  nearFriendlyInfra,
  nearFriendlyForward,
  nearSafeDeployAura,
  resetHeroTeleportCooldown,
  type CastFxKind,
  type GameState,
  type StructureRuntime,
  type UnitOrderMode,
} from "../../state";
import type { Vec2 } from "../../types";
import { isCommandEntry, isStructureEntry } from "../../types";
import { findNeutralTapIndexNearHero } from "./hero";
import { dist2 } from "./helpers";
import { claimChannelSecForTap, claimFluxFeeForTap } from "./homeDistance";

const ALT_HOLD_PICK_RADIUS = 6;

const PICK_STRUCTURE = 5;

export function orderPlayerUnits(
  s: GameState,
  ids: number[],
  pos: Vec2,
  mode: UnitOrderMode,
  queue = false,
): void {
  const chosen = ids.length ? ids : s.selectedUnitIds;
  if (chosen.length === 0) {
    s.lastMessage = "No units selected.";
    return;
  }
  let n = 0;
  for (const id of chosen) {
    const u = s.units.find((x) => x.id === id && x.team === "player" && x.hp > 0);
    if (!u) continue;
    n++;
    if (mode === "stay") {
      u.order = { mode: "stay", x: u.x, z: u.z, waypoints: [], queued: [] };
      continue;
    }
    const jx = ((id * 17) % 9) - 4;
    const jz = ((id * 11) % 9) - 4;
    const target = { x: pos.x + jx * 0.9, z: pos.z + jz * 0.9 };
    if (queue && u.order) {
      u.order.queued.push(target);
    } else {
      u.order = { mode, x: target.x, z: target.z, waypoints: [], queued: [] };
    }
  }
  if (n > 0) {
    s.globalRallyActive = false;
    s.lastMessage =
      mode === "stay"
        ? `${n} unit${n === 1 ? "" : "s"} holding position.`
        : `${n} unit${n === 1 ? "" : "s"} ordered to ${mode === "attack_move" ? "attack-move" : "move"}.`;
  }
}

function canTeleportHeroTo(s: GameState, pos: Vec2): string | null {
  if (s.heroTeleportCooldownTicks > 0) {
    return `Teleport cooling down (${heroTeleportCooldownSeconds(s)}s).`;
  }
  if (pos.x > 0) return "Teleport can only target your half of the map.";
  if (circleOverlapsMapObstacles(s.map, pos, HERO_TELEPORT_DEST_RADIUS)) {
    return "Teleport destination is blocked.";
  }
  return null;
}

function tryHeroTeleport(s: GameState, pos: Vec2): void {
  const half = s.map.world.halfExtents;
  const dest = {
    x: Math.max(-half, Math.min(0, pos.x)),
    z: Math.max(-half, Math.min(half, pos.z)),
  };
  const err = canTeleportHeroTo(s, dest);
  if (err) {
    s.lastMessage = err;
    return;
  }
  const from = { x: s.hero.x, z: s.hero.z };
  const dx = dest.x - s.hero.x;
  const dz = dest.z - s.hero.z;
  const r2 = HERO_TELEPORT_UNIT_RADIUS * HERO_TELEPORT_UNIT_RADIUS;
  const carried = s.units.filter((u) => u.team === "player" && u.hp > 0 && dist2(u, s.hero) <= r2);
  s.hero.x = dest.x;
  s.hero.z = dest.z;
  s.hero.targetX = null;
  s.hero.targetZ = null;
  s.hero.moveWaypoints.length = 0;
  s.hero.claimChannelTarget = null;
  s.hero.claimChannelTicksRemaining = 0;
  resolveCircleAgainstMapObstacles(s.map, s.hero, HERO_MAP_OBSTACLE_RADIUS);
  for (const u of carried) {
    u.x += dx;
    u.z += dz;
    u.x = Math.max(-half, Math.min(half, u.x));
    u.z = Math.max(-half, Math.min(half, u.z));
  }
  resetHeroTeleportCooldown(s);
  s.teleportClickPending = false;
  s.lastFx = { kind: "lightning", x: s.hero.x, z: s.hero.z, tick: s.tick, fromX: from.x, fromZ: from.z };
  s.lastMessage = `Teleported Wizard squad (${carried.length} troops carried).`;
  logGame("move", `Teleport -> (${s.hero.x.toFixed(1)}, ${s.hero.z.toFixed(1)})`, s.tick);
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
  const hpMult = placementForward ? FORWARD_STRUCTURE_HP_MULT : 1;
  const hp0 = Math.max(1, Math.round(def.maxHp * hpMult));
  const st: StructureRuntime = {
    id: s.nextId.structure++,
    team: "player",
    catalogId,
    x: pos.x,
    z: pos.z,
    hp: hp0,
    maxHp: hp0,
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

function consumeCommandSlot(s: GameState, slotIdx: number, cooldownSec: number, maxFreeUses: number): void {
  const used = s.doctrineCommandUses[slotIdx] ?? 0;
  const exhausted = used >= maxFreeUses;
  s.doctrineCommandUses[slotIdx] = used + 1;
  s.stats.commandsCast += 1;
  if (cooldownSec > 0) {
    s.doctrineCooldownTicks[slotIdx] = Math.round(cooldownSec * (exhausted ? 3 : 1) * TICK_HZ);
  }
  s.pendingPlacementCatalogId = null;
  s.selectedDoctrineIndex = null;
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
function emitSummonFx(s: GameState, catalogId: string, pos: Vec2): void {
  const e = getCatalogEntry(catalogId);
  const sigs = e && isStructureEntry(e) ? e.signalTypes : [];
  const v = sigs.includes("Vanguard") ? 1 : 0;
  const b = sigs.includes("Bastion") ? 1 : 0;
  const r = sigs.includes("Reclaim") ? 1 : 0;
  emitFx(s, "lightning", pos);
  if (v >= b && v >= r) emitFx(s, "spark_burst", pos);
  else if (b >= r) emitFx(s, "ground_crack", pos);
  else emitFx(s, "reclaim_pulse", pos);
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
  const fx = cmd.effect;
  const usesLeft = Math.max(0, cmd.maxCharges - (s.doctrineCommandUses[slotIdx] ?? 0));
  const castSuffix = usesLeft > 0 ? `${usesLeft - 1} free uses left.` : "exhausted cast - triple cooldown.";
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
      const bdef = getCatalogEntry(st.catalogId);
      if (bdef && isStructureEntry(bdef)) {
        const refund = bdef.fluxCost * 0.9;
        s.salvage += refund;
        s.stats.salvageRecovered += refund;
      }
      s.units = s.units.filter((u) => u.structureId !== st.id);
      s.structures = s.structures.filter((x) => x.id !== st.id);
      consumeCommandSlot(s, slotIdx, cmd.chargeCooldownSeconds, cmd.maxCharges);
      emitFx(s, "lightning", target);
      emitFx(s, "recycle", target);
      s.lastMessage = "Recycle — structure scrapped, Salvage refunded.";
      return;
    }
    case "aoe_damage": {
      const r2 = fx.radius * fx.radius;
      for (const u of s.units) {
        if (u.team !== "enemy" || u.hp <= 0) continue;
        if (dist2(u, pos) <= r2) u.hp -= fx.damage;
      }
      for (const er of s.enemyRelays) {
        if (er.hp <= 0) continue;
        if (dist2(er, pos) <= r2) er.hp -= fx.damage * 0.5;
      }
      consumeCommandSlot(s, slotIdx, cmd.chargeCooldownSeconds, cmd.maxCharges);
      emitFx(s, "lightning", pos);
      emitFx(s, "firestorm", pos);
      s.lastMessage = `${cmd.name} detonated; ${castSuffix}`;
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
      st.damageReductionUntilTick = s.tick + Math.round(fx.durationSeconds * TICK_HZ);
      consumeCommandSlot(s, slotIdx, cmd.chargeCooldownSeconds, cmd.maxCharges);
      emitFx(s, "lightning", { x: st.x, z: st.z });
      emitFx(s, "fortify", { x: st.x, z: st.z });
      s.lastMessage = `${cmd.name}: ${fx.damageReductionPct}% damage reduction for ${fx.durationSeconds}s; ${castSuffix}`;
      return;
    }
    case "shatter_structure": {
      const erIdx = pickEnemyRelay(s, pos);
      if (erIdx === null) {
        s.lastMessage = `${cmd.name}: click an enemy Dark Fortress.`;
        return;
      }
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
      consumeCommandSlot(s, slotIdx, cmd.chargeCooldownSeconds, cmd.maxCharges);
      emitFx(s, "lightning", { x: er.x, z: er.z });
      emitFx(s, "shatter", { x: er.x, z: er.z });
      s.lastMessage = `${cmd.name}: Fortress takes ${fx.damage} damage + ${fx.silenceSeconds}s silence; ${castSuffix}`;
      return;
    }
    case "noop": {
      consumeCommandSlot(s, slotIdx, cmd.chargeCooldownSeconds, cmd.maxCharges);
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

  if (s.teleportClickPending) {
    tryHeroTeleport(s, pos);
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
      s.teleportClickPending = false;
      s.lastMessage = e
        ? `Selected ${e.name} — ${isCommandEntry(e) ? "click to cast." : "click map to summon."}`
        : `Selected ${id}`;
    } else if (it.type === "begin_rally_click") {
      if (s.phase !== "playing") continue;
      s.rallyClickPending = !s.rallyClickPending;
      if (s.rallyClickPending) s.teleportClickPending = false;
      s.lastMessage = s.rallyClickPending
        ? "Rally armed — click the map to set rally (R again to cancel)."
        : "Rally arm cancelled.";
    } else if (it.type === "begin_hero_teleport") {
      if (s.phase !== "playing") continue;
      if (s.heroTeleportCooldownTicks > 0) {
        s.lastMessage = `Teleport cooling down (${heroTeleportCooldownSeconds(s)}s).`;
        continue;
      }
      s.teleportClickPending = !s.teleportClickPending;
      if (s.teleportClickPending) {
        s.rallyClickPending = false;
        s.pendingPlacementCatalogId = null;
        s.selectedDoctrineIndex = null;
      }
      s.lastMessage = s.teleportClickPending
        ? "Teleport armed - click your half to blink the Wizard and nearby troops."
        : "Teleport cancelled.";
    } else if (it.type === "hero_teleport") {
      if (s.phase !== "playing") continue;
      tryHeroTeleport(s, { x: it.x, z: it.z });
    } else if (it.type === "clear_placement") {
      s.pendingPlacementCatalogId = null;
      s.selectedDoctrineIndex = null;
      s.selectedUnitId = null;
      s.rallyClickPending = false;
      s.teleportClickPending = false;
      s.lastMessage = "Cleared placement selection.";
    } else if (it.type === "try_click_world") {
      handleWorldClick(s, it.pos, it.shiftKey === true, it.altKey === true, it.pickedUnitId);
    } else if (it.type === "select_units") {
      const ids = it.unitIds.filter((id) => s.units.some((u) => u.id === id && u.team === "player" && u.hp > 0));
      s.selectedUnitIds = ids;
      s.selectedUnitId = ids[0] ?? null;
      s.selectedStructureId = null;
      if (ids.length > 0) s.lastMessage = `${ids.length} unit${ids.length === 1 ? "" : "s"} selected.`;
    } else if (it.type === "command_selected_units") {
      orderPlayerUnits(s, s.selectedUnitIds, { x: it.x, z: it.z }, it.mode, it.queue === true);
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
      if (s.selectedUnitIds.length > 0) continue;
      s.teleportClickPending = false;
      const half = s.map.world.halfExtents;
      const x = Math.max(-half, Math.min(half, it.x));
      const z = Math.max(-half, Math.min(half, it.z));
      const h = s.hero;
      if (h.claimChannelTarget !== null) {
        h.claimChannelTarget = null;
        h.claimChannelTicksRemaining = 0;
      }
      const shift = it.shiftKey === true;
      if (shift) {
        if (h.targetX !== null && h.targetZ !== null) {
          if (h.moveWaypoints.length >= HERO_MOVE_WAYPOINT_CAP) {
            s.lastMessage = `Waypoint queue full (max ${HERO_MOVE_WAYPOINT_CAP}).`;
          } else {
            h.moveWaypoints.push({ x, z });
            logGame("move", `Move queued → (${x.toFixed(1)}, ${z.toFixed(1)})`, s.tick);
          }
        } else {
          h.targetX = x;
          h.targetZ = z;
          logGame("move", `Move order → (${x.toFixed(1)}, ${z.toFixed(1)})`, s.tick);
        }
      } else {
        h.moveWaypoints.length = 0;
        h.targetX = x;
        h.targetZ = z;
        logGame("move", `Move order → (${x.toFixed(1)}, ${z.toFixed(1)})`, s.tick);
      }
    } else if (it.type === "hero_wasd") {
      const sx = Math.max(-1, Math.min(1, it.strafe));
      const sz = Math.max(-1, Math.min(1, it.forward));
      const { camFx, camFz, camRx, camRz } = it;
      if (
        camFx !== undefined &&
        camFz !== undefined &&
        camRx !== undefined &&
        camRz !== undefined &&
        (sx !== 0 || sz !== 0)
      ) {
        // World XZ move (normalized): W/S along camera forward on ground, A/D along camera right.
        let wx = sz * camFx + sx * camRx;
        let wz = sz * camFz + sx * camRz;
        const len = Math.hypot(wx, wz);
        if (len > 1e-6) {
          wx /= len;
          wz /= len;
        } else {
          wx = 0;
          wz = 0;
        }
        s.hero.wasdStrafe = wx;
        s.hero.wasdForward = wz;
      } else {
        s.hero.wasdStrafe = sx;
        s.hero.wasdForward = -sz;
      }
    } else if (it.type === "hero_cancel_claim") {
      if (s.hero.claimChannelTarget !== null) {
        s.hero.claimChannelTarget = null;
        s.hero.claimChannelTicksRemaining = 0;
        s.lastMessage = "Claim cancelled.";
      }
    } else if (it.type === "hero_claim") {
      s.hero.targetX = null;
      s.hero.targetZ = null;
      s.hero.moveWaypoints.length = 0;
      const idx = findNeutralTapIndexNearHero(s);
      if (idx !== null && s.hero.claimChannelTarget === null) {
        const tap = s.taps[idx];
        if (tap && !tap.active) {
          const fee = claimFluxFeeForTap(s, "player", tap);
          const chSec = claimChannelSecForTap(s, "player", tap);
          if (s.flux >= fee) {
            s.hero.claimChannelTarget = idx;
            s.hero.claimChannelTicksRemaining = Math.round(chSec * TICK_HZ);
            s.lastMessage = `Claiming node… stand still for ${chSec.toFixed(1)}s (−${fee} Mana).`;
          }
        }
      }
    } else if (it.type === "start_battle") {
      /* No setup phase — match begins in playing. Intent kept for replay compat. */
    }
  }
}
