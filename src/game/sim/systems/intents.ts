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
  SPELL_KNOCKBACK_SPEED,
  TAP_UNIT_ORDER_SNAP_RADIUS,
  TICK_HZ,
} from "../../constants";
import { logGame } from "../../gameLog";
import type { PlayerIntent } from "../../intents";
import { circleOverlapsMapObstacles, resolveCircleAgainstMapObstacles } from "../../mapObstacles";
import {
  canPlaceStructureHere,
  canUseDoctrineSlot,
  classifyAttackRangeBand,
  heroTeleportCooldownSeconds,
  nearFriendlyInfra,
  nearFriendlyForward,
  nearSafeDeployAura,
  pushFx,
  resetHeroTeleportCooldown,
  type CastFxKind,
  type GameState,
  type StructureRuntime,
  type UnitOrderMode,
} from "../../state";
import type { CommandCatalogEntry, Vec2 } from "../../types";
import { isCommandEntry, isStructureEntry } from "../../types";
import { applyAttackImpulse } from "./combat";
import { findNeutralTapIndexNearHero } from "./hero";
import { dist2 } from "./helpers";
import { claimChannelSecForTap, claimFluxFeeForTap } from "./homeDistance";

const ALT_HOLD_PICK_RADIUS = 6;

const PICK_STRUCTURE = 5;

function tapIndexNearForCaptureOrder(s: GameState, pos: Vec2): number | null {
  const r2 = TAP_UNIT_ORDER_SNAP_RADIUS * TAP_UNIT_ORDER_SNAP_RADIUS;
  let best: number | null = null;
  let bestD = r2;
  for (let i = 0; i < s.taps.length; i++) {
    const t = s.taps[i]!;
    if (t.active && t.ownerTeam === "player") continue;
    const d = dist2(pos, t);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

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
  const captureTapIdx = !queue && mode !== "stay" ? tapIndexNearForCaptureOrder(s, pos) : null;
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
    const tap = captureTapIdx !== null ? s.taps[captureTapIdx]! : null;
    const target = tap
      ? { x: tap.x + jx * 0.45, z: tap.z + jz * 0.45 }
      : { x: pos.x + jx * 0.9, z: pos.z + jz * 0.9 };
    if (queue && u.order) {
      u.order.queued.push(target);
    } else {
      u.order =
        captureTapIdx !== null
          ? { mode, x: target.x, z: target.z, waypoints: [], queued: [], captureTapIndex: captureTapIdx }
          : { mode, x: target.x, z: target.z, waypoints: [], queued: [] };
    }
  }
  if (n > 0) {
    s.globalRallyActive = false;
    if (captureTapIdx !== null) {
      s.lastMessage = `${n} unit${n === 1 ? "" : "s"} committed to capture this Mana node (fight there until it is yours or they fall).`;
    } else {
      s.lastMessage =
        mode === "stay"
          ? `${n} unit${n === 1 ? "" : "s"} holding position.`
          : `${n} unit${n === 1 ? "" : "s"} ordered to ${mode === "attack_move" ? "attack-move" : "move"}.`;
    }
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
  pushFx(s, { kind: "lightning", x: s.hero.x, z: s.hero.z, fromX: from.x, fromZ: from.z });
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
    localPopCapBonus: 0,
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

function consumeCommandSlot(s: GameState, slotIdx: number, cmd: CommandCatalogEntry): void {
  const used = s.doctrineCommandUses[slotIdx] ?? 0;
  const exhausted = used >= cmd.maxCharges;
  s.flux -= cmd.fluxCost;
  if (cmd.salvagePctOnCast > 0) {
    s.salvage += cmd.fluxCost * (cmd.salvagePctOnCast / 100);
  }
  s.doctrineCommandUses[slotIdx] = used + 1;
  s.stats.commandsCast += 1;
  if (cmd.chargeCooldownSeconds > 0) {
    s.doctrineCooldownTicks[slotIdx] = Math.round(cmd.chargeCooldownSeconds * (exhausted ? 3 : 1) * TICK_HZ);
  }
  s.pendingPlacementCatalogId = null;
  s.selectedDoctrineIndex = null;
}

function emitFx(s: GameState, kind: CastFxKind, pos: Vec2): void {
  pushFx(s, { kind, x: pos.x, z: pos.z });
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

/** Unit direction from hero `hx,hz` toward `aim`; defaults to +X if aim is on the Wizard. */
function aimUnitFromHero(hx: number, hz: number, aimX: number, aimZ: number): { ux: number; uz: number } {
  let dx = aimX - hx;
  let dz = aimZ - hz;
  const d = Math.hypot(dx, dz);
  if (d < 0.25) {
    return { ux: 1, uz: 0 };
  }
  return { ux: dx / d, uz: dz / d };
}

function pointInCorridor(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  halfW: number,
): boolean {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const ab2 = abx * abx + abz * abz;
  const t = ab2 < 1e-8 ? 0 : Math.max(0, Math.min(1, (apx * abx + apz * abz) / ab2));
  const cx = ax + abx * t;
  const cz = az + abz * t;
  const ddx = px - cx;
  const ddz = pz - cz;
  return ddx * ddx + ddz * ddz <= halfW * halfW;
}

function corridorKnockNormal(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): { nx: number; nz: number } {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const ab2 = abx * abx + abz * abz;
  const t = ab2 < 1e-8 ? 0 : Math.max(0, Math.min(1, (apx * abx + apz * abz) / ab2));
  const cx = ax + abx * t;
  const cz = az + abz * t;
  let nx = px - cx;
  let nz = pz - cz;
  const nlen = Math.hypot(nx, nz) || 1;
  nx /= nlen;
  nz /= nlen;
  return { nx, nz };
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
    s.lastMessage = `Need ${cmd.fluxCost} Mana (have ${Math.floor(s.flux)}).`;
    return;
  }
  const fx = cmd.effect;
  const usesLeft = Math.max(0, cmd.maxCharges - (s.doctrineCommandUses[slotIdx] ?? 0));
  const castSuffix = usesLeft > 0 ? `${usesLeft - 1} free uses left.` : "exhausted cast - triple cooldown.";
  switch (fx.type) {
    case "aoe_line_damage": {
      const hx = s.hero.x;
      const hz = s.hero.z;
      const { ux, uz } = aimUnitFromHero(hx, hz, pos.x, pos.z);
      const L = fx.length;
      const ex = hx + ux * L;
      const ez = hz + uz * L;
      const hw = fx.halfWidth;
      for (const u of s.units) {
        if (u.team !== "enemy" || u.hp <= 0) continue;
        if (!pointInCorridor(u.x, u.z, hx, hz, ex, ez, hw)) continue;
        u.hp -= fx.damage;
        const { nx, nz } = corridorKnockNormal(u.x, u.z, hx, hz, ex, ez);
        applyAttackImpulse(u, { x: u.x - nx, z: u.z - nz }, SPELL_KNOCKBACK_SPEED);
      }
      for (const er of s.enemyRelays) {
        if (er.hp <= 0) continue;
        if (!pointInCorridor(er.x, er.z, hx, hz, ex, ez, hw)) continue;
        er.hp -= fx.damage * 0.35;
      }
      consumeCommandSlot(s, slotIdx, cmd);
      const mx = (hx + ex) * 0.5;
      const mz = (hz + ez) * 0.5;
      pushFx(s, { kind: "lightning", x: ex, z: ez, fromX: hx, fromZ: hz });
      emitFx(s, "reclaim_pulse", { x: mx, z: mz });
      pushFx(s, {
        kind: "line_cleave",
        x: ex,
        z: ez,
        fromX: hx,
        fromZ: hz,
        impactRadius: hw * 2,
      });
      s.lastMessage = `${cmd.name} — cleaving ${L}u; ${castSuffix}`;
      return;
    }
    case "aoe_damage": {
      const r = fx.radius;
      const r2 = r * r;
      for (const u of s.units) {
        if (u.team !== "enemy" || u.hp <= 0) continue;
        if (dist2(u, pos) > r2) continue;
        u.hp -= fx.damage;
        applyAttackImpulse(u, pos, SPELL_KNOCKBACK_SPEED);
      }
      for (const er of s.enemyRelays) {
        if (er.hp <= 0) continue;
        if (dist2(er, pos) <= r2) er.hp -= fx.damage * 0.5;
      }
      consumeCommandSlot(s, slotIdx, cmd);
      emitFx(s, "lightning", pos);
      emitFx(s, "firestorm", pos);
      pushFx(s, {
        kind: "combat_boom",
        x: pos.x,
        z: pos.z,
        impactRadius: r,
        rangeBand: classifyAttackRangeBand(r),
      });
      s.lastMessage = `${cmd.name} detonated; ${castSuffix}`;
      return;
    }
    case "aoe_tactics_field": {
      s.tacticsFieldZones.push({
        x: pos.x,
        z: pos.z,
        radius: fx.radius,
        untilTick: s.tick + Math.round(fx.durationSeconds * TICK_HZ),
        allySpeedMult: fx.allySpeedMult,
        allyDamageMult: fx.allyDamageMult,
        allyIncomingDamageMult: fx.allyIncomingDamageMult,
        enemySpeedMult: fx.enemySpeedMult,
        enemyDamageMult: fx.enemyDamageMult,
        enemyIncomingDamageMult: fx.enemyIncomingDamageMult,
      });
      consumeCommandSlot(s, slotIdx, cmd);
      emitFx(s, "lightning", pos);
      emitFx(s, "fortify", pos);
      pushFx(s, {
        kind: "combat_boom",
        x: pos.x,
        z: pos.z,
        impactRadius: fx.radius,
        rangeBand: classifyAttackRangeBand(fx.radius),
      });
      s.lastMessage = `${cmd.name}: ${fx.durationSeconds}s control field — allies empowered, enemies hindered; ${castSuffix}`;
      return;
    }
    case "aoe_shatter_chain": {
      const used = new Set<string>();
      let ox = pos.x;
      let oz = pos.z;
      let hits = 0;
      const silenceR2 = SHATTER_TARGET_RADIUS * SHATTER_TARGET_RADIUS;
      for (let hop = 0; hop < fx.maxTargets; hop++) {
        const maxR2 = hop === 0 ? fx.castRadius * fx.castRadius : fx.chainRange * fx.chainRange;
        let bestKey: string | null = null;
        let bestD = maxR2;
        let bx = 0;
        let bz = 0;
        for (let i = 0; i < s.enemyRelays.length; i++) {
          const er = s.enemyRelays[i]!;
          if (er.hp <= 0) continue;
          const k = `r:${i}`;
          if (used.has(k)) continue;
          const d = dist2(er, { x: ox, z: oz });
          if (d <= bestD) {
            bestD = d;
            bestKey = k;
            bx = er.x;
            bz = er.z;
          }
        }
        for (const st of s.structures) {
          if (st.team !== "enemy") continue;
          const k = `s:${st.id}`;
          if (used.has(k)) continue;
          const d = dist2(st, { x: ox, z: oz });
          if (d <= bestD) {
            bestD = d;
            bestKey = k;
            bx = st.x;
            bz = st.z;
          }
        }
        for (const u of s.units) {
          if (u.team !== "enemy" || u.hp <= 0) continue;
          const k = `u:${u.id}`;
          if (used.has(k)) continue;
          const d = dist2(u, { x: ox, z: oz });
          if (d <= bestD) {
            bestD = d;
            bestKey = k;
            bx = u.x;
            bz = u.z;
          }
        }
        if (!bestKey) break;
        const dmg = fx.damage * Math.pow(fx.chainDamageFalloff, hop);
        used.add(bestKey);
        pushFx(s, { kind: "lightning", x: bx, z: bz, fromX: ox, fromZ: oz });
        if (hop === 0) emitFx(s, "shatter", { x: bx, z: bz });
        if (bestKey.startsWith("r:")) {
          const idx = Number(bestKey.slice(2));
          const er = s.enemyRelays[idx]!;
          er.hp -= dmg;
          const silenceTick = s.tick + Math.round(fx.silenceSeconds * TICK_HZ);
          er.silencedUntilTick = Math.max(er.silencedUntilTick, silenceTick);
          for (const st of s.structures) {
            if (st.team !== "enemy") continue;
            if (dist2(st, { x: er.x, z: er.z }) <= silenceR2) {
              st.productionSilenceUntilTick = Math.max(st.productionSilenceUntilTick, silenceTick);
            }
          }
        } else if (bestKey.startsWith("s:")) {
          const sid = Number(bestKey.slice(2));
          const st = s.structures.find((x) => x.id === sid);
          if (st) st.hp -= dmg;
        } else {
          const uid = Number(bestKey.slice(2));
          const u = s.units.find((x) => x.id === uid);
          if (u) {
            u.hp -= dmg;
            applyAttackImpulse(u, { x: ox, z: oz }, SPELL_KNOCKBACK_SPEED * 0.8);
          }
        }
        hits++;
        ox = bx;
        oz = bz;
      }
      if (hits === 0) {
        s.lastMessage = `${cmd.name}: no enemies in the cast ring — try dropping closer.`;
        return;
      }
      consumeCommandSlot(s, slotIdx, cmd);
      s.lastMessage = `${cmd.name}: ${hits} chain strike${hits === 1 ? "" : "s"} (lightning); ${castSuffix}`;
      return;
    }
    case "noop": {
      consumeCommandSlot(s, slotIdx, cmd);
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
          ? `Troop selected — weapon range ${u.range.toFixed(1)}.`
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
