import { describe, expect, it } from "vitest";
import { getCatalogEntry } from "./catalog";
import { buildProgress, production } from "./sim/systems/production";
import { availableProductionSlots } from "./sim/systems/production";
import { applyAttackImpulse, combat } from "./sim/systems/combat";
import { applyPlayerIntents } from "./sim/systems/intents";
import { advanceTick } from "./sim/tick";
import { unitStatsForCatalog } from "./sim/systems/helpers";
import {
  ENEMY_DAMAGE_MULT,
  ENEMY_PRODUCTION_RATE_MULT,
  KEEP_ID,
  KEEP_SWARM_PERIOD_SEC,
  TICK_HZ,
  UNIT_ATTACK_COOLDOWN_TICKS,
  UNIT_ATTACK_DAMAGE_MULT,
} from "./constants";
import {
  canPlaceEnemyStructureAt,
  canUseDoctrineSlot,
  createInitialState,
  HERO_SELECTION_ID,
  inPlayerTerritory,
  liveSquadCount,
  placementFailureReason,
  territorySources,
  type StructureRuntime,
  type UnitRuntime,
} from "./state";
import { isStructureEntry } from "./types";
import type { MapData, UnitSizeClass } from "./types";

const tinyMap: MapData = {
  version: 2,
  world: { halfExtents: 160, groundY: 0 },
  tapSlots: [{ id: "tap_a", x: 18, z: 12 }],
  playerRelaySlots: [{ id: "p0", x: -44, z: 0 }],
  enemyRelaySlots: [{ id: "e0", x: 80, z: 0 }],
  playerStart: { x: -44, z: 0 },
  enemyStart: { x: 80, z: 0 },
  enemyCamps: [],
  useAuthorTapSlots: true,
};

function structure(catalogId: string, id: number, team: "player" | "enemy" = "player"): StructureRuntime {
  const e = getCatalogEntry(catalogId);
  if (!e || !isStructureEntry(e)) throw new Error(`bad structure ${catalogId}`);
  return {
    id,
    team,
    catalogId,
    x: team === "player" ? -42 : 78,
    z: 3,
    hp: e.maxHp,
    maxHp: e.maxHp,
    buildTicksRemaining: 0,
    buildTotalTicks: 0,
    complete: true,
    productionTicksRemaining: 1,
    doctrineSlotIndex: -1,
    rallyX: team === "player" ? -30 : 65,
    rallyZ: 3,
    placementForward: false,
    damageReductionUntilTick: 0,
    productionSilenceUntilTick: 0,
    holdOrders: false,
    localPopCapBonus: 0,
  };
}

function unit(id: number, team: "player" | "enemy", sizeClass: UnitSizeClass, structureId: number | null): UnitRuntime {
  const stats = unitStatsForCatalog(sizeClass);
  return {
    id,
    team,
    structureId,
    x: -42,
    z: 3,
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    sizeClass,
    pop: stats.pop,
    speedPerSec: stats.speedPerSec,
    range: stats.range,
    dmgPerTick: stats.dmgPerTick,
    visualSeed: id,
    vxImpulse: 0,
    vzImpulse: 0,
  };
}

describe("resource-first doctrine gates", () => {
  it("ignores old tier and signal metadata when Mana, cooldown, and territory pass", () => {
    const s = createInitialState(tinyMap, ["dragon_roost"]);
    s.flux = 1000;

    expect(canUseDoctrineSlot(s, 0)).toBeNull();
    expect(placementFailureReason(s, "dragon_roost", { x: -38, z: 0 }, 0)).toBeNull();
  });

  it("enemy placement is also resource-only", () => {
    const s = createInitialState(tinyMap, []);
    s.enemyFlux = 1000;

    expect(canPlaceEnemyStructureAt(s, "ironhold_citadel", { x: 78, z: 4 })).toBeNull();
  });
});

describe("batch production", () => {
  it.each([
    ["watchtower", "Swarm", 4],
    ["outpost", "Line", 3],
    ["siege_works", "Heavy", 2],
    ["dragon_roost", "Titan", 1],
  ] as const)("spawns aggregate %s squads", (catalogId, sizeClass, expected) => {
    const s = createInitialState(tinyMap, []);
    const st = structure(catalogId, 100);
    const stats = unitStatsForCatalog(sizeClass);
    s.structures.push(st);
    const before = s.units.length;

    production(s);

    const spawned = s.units.slice(before).filter((u) => u.team === "player" && u.structureId === st.id);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.sizeClass).toBe(sizeClass);
    expect(spawned[0]!.squadMaxCount).toBe(expected);
    expect(spawned[0]!.singleMaxHp).toBe(stats.maxHp);
    expect(spawned[0]!.maxHp).toBe(stats.maxHp * expected);
    expect(spawned[0]!.pop).toBe(stats.pop * expected);
  });

  it("respects local pop room and retries when capped", () => {
    const s = createInitialState(tinyMap, []);
    const st = structure("watchtower", 200);
    s.structures.push(st);
    for (let i = 0; i < 16; i++) s.units.push(unit(1000 + i, "player", "Swarm", st.id));

    expect(availableProductionSlots(s, st)).toBe(0);
    production(s);

    expect(s.units.filter((u) => u.structureId === st.id)).toHaveLength(16);
    expect(st.productionTicksRemaining).toBe(1);
  });

  it("uses partial local pop room instead of overfilling", () => {
    const s = createInitialState(tinyMap, []);
    const st = structure("watchtower", 201);
    s.structures.push(st);
    for (let i = 0; i < 14; i++) s.units.push(unit(2000 + i, "player", "Swarm", st.id));

    expect(availableProductionSlots(s, st)).toBe(2);
    production(s);

    expect(s.units.filter((u) => u.structureId === st.id)).toHaveLength(15);
    expect(s.units.find((u) => u.structureId === st.id && u.squadMaxCount === 2)?.squadMaxCount).toBe(2);
    expect(st.productionTicksRemaining).toBeGreaterThan(1);
  });

  it("spawns the first batch as soon as construction completes", () => {
    const s = createInitialState(tinyMap, []);
    const st = structure("watchtower", 202);
    const def = getCatalogEntry("watchtower");
    if (!def || !isStructureEntry(def)) throw new Error("bad watchtower");
    st.complete = false;
    st.buildTicksRemaining = 1;
    st.buildTotalTicks = 1;
    st.productionTicksRemaining = 999;
    s.structures.push(st);

    buildProgress(s);

    expect(st.complete).toBe(true);
    const spawned = s.units.filter((u) => u.structureId === st.id);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.squadMaxCount).toBe(4);
    expect(st.productionTicksRemaining).toBe(Math.round(def.productionSeconds * TICK_HZ));
  });

  it("slows enemy production cadence and reduces enemy unit damage", () => {
    const s = createInitialState(tinyMap, []);
    const st = structure("watchtower", 203, "enemy");
    const def = getCatalogEntry("watchtower");
    if (!def || !isStructureEntry(def)) throw new Error("bad watchtower");
    s.structures.push(st);

    production(s);

    const spawned = s.units.filter((u) => u.team === "enemy" && u.structureId === st.id);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.squadMaxCount).toBe(4);
    expect(spawned.every((u) => u.dmgPerTick === unitStatsForCatalog("Swarm").dmgPerTick * ENEMY_DAMAGE_MULT)).toBe(true);
    expect(st.productionTicksRemaining).toBe(Math.round((def.productionSeconds * TICK_HZ) / ENEMY_PRODUCTION_RATE_MULT));
  });

  it("keeps the Wizard Keep to a small aggregate guard trickle", () => {
    const s = createInitialState(tinyMap, []);
    const keep = s.structures.find((st) => st.catalogId === KEEP_ID);
    if (!keep) throw new Error("missing keep");

    keep.productionTicksRemaining = 1;
    production(s);

    const first = s.units.filter((u) => u.structureId === keep.id);
    expect(first).toHaveLength(1);
    expect(first[0]!.squadMaxCount).toBe(4);
    expect(first[0]!.singleMaxHp).toBe(unitStatsForCatalog("Swarm").maxHp);
    expect(keep.productionTicksRemaining).toBe(Math.round(KEEP_SWARM_PERIOD_SEC * TICK_HZ));

    keep.productionTicksRemaining = 1;
    production(s);
    expect(s.units.filter((u) => u.structureId === keep.id)).toHaveLength(2);

    keep.productionTicksRemaining = 1;
    production(s);
    expect(s.units.filter((u) => u.structureId === keep.id)).toHaveLength(2);
    expect(keep.productionTicksRemaining).toBe(1);
  });

  it("degrades squad count and combat output as pooled HP drops", () => {
    const s = createInitialState(tinyMap, []);
    const swarm = unitStatsForCatalog("Swarm");
    const attacker = unit(3000, "player", "Swarm", 100);
    attacker.x = -10;
    attacker.z = 0;
    attacker.squadCount = 4;
    attacker.squadMaxCount = 4;
    attacker.singleMaxHp = swarm.maxHp;
    attacker.maxHp = swarm.maxHp * 4;
    attacker.hp = swarm.maxHp * 3;
    attacker.pop = swarm.pop * 4;
    const defender = unit(3001, "enemy", "Swarm", null);
    defender.x = -9;
    defender.z = 0;
    defender.hp = 100;
    defender.maxHp = 100;
    s.units.push(attacker, defender);

    expect(liveSquadCount(attacker)).toBe(3);
    combat(s);

    const expectedHit = swarm.dmgPerTick * 3 * UNIT_ATTACK_COOLDOWN_TICKS.Swarm * UNIT_ATTACK_DAMAGE_MULT.Swarm;
    expect(defender.hp).toBeCloseTo(100 - expectedHit, 5);
    const afterFirst = defender.hp;
    expect(attacker.attackCooldownTicksRemaining).toBeGreaterThan(0);

    combat(s);
    expect(defender.hp).toBeCloseTo(afterFirst, 5);
  });
});

describe("territory", () => {
  it("uses Keep plus owned Mana anchors, not the moving hero disk", () => {
    const s = createInitialState(tinyMap, []);
    s.hero.x = 70;
    s.hero.z = 0;

    expect(inPlayerTerritory(s, { x: 70, z: 0 })).toBe(false);
    s.taps[0]!.active = true;
    s.taps[0]!.ownerTeam = "player";
    s.taps[0]!.anchorHp = 200;
    expect(inPlayerTerritory(s, { x: 18, z: 12 })).toBe(true);
    expect(territorySources(s).map((p) => `${Math.round(p.x)},${Math.round(p.z)}`)).toEqual(["-44,0", "18,12"]);
  });
});

describe("hero resilience", () => {
  it("respawns the Wizard at the Keep instead of losing when the hero drops", () => {
    const s = createInitialState(tinyMap, []);
    const keep = s.structures.find((st) => st.catalogId === KEEP_ID);
    if (!keep) throw new Error("missing keep");
    s.hero.hp = 0;
    s.hero.x = 40;
    s.hero.z = 25;
    s.hero.targetX = 70;
    s.hero.targetZ = 10;

    advanceTick(s, []);

    expect(s.phase).toBe("playing");
    expect(s.hero.hp).toBe(s.hero.maxHp);
    expect(s.hero.x).toBe(keep.x);
    expect(s.hero.z).toBe(keep.z);
    expect(s.hero.targetX).toBeNull();
    expect(s.lastMessage).toBe("Wizard reformed at the Keep.");
  });
});

describe("command spells", () => {
  it("Cut Back cleaves through the clicked point even beyond the base line length", () => {
    const s = createInitialState(tinyMap, ["recycle"]);
    s.flux = 1000;
    const enemy = unit(4000, "enemy", "Swarm", null);
    enemy.x = 20;
    enemy.z = 0;
    enemy.hp = 100;
    enemy.maxHp = 100;
    s.units.push(enemy);

    applyPlayerIntents(s, [
      { type: "select_doctrine_slot", index: 0 },
      { type: "try_click_world", pos: { x: 20, z: 0 } },
    ]);

    expect(enemy.hp).toBeLessThan(100);
    expect(s.stats.commandsCast).toBe(1);
    expect(s.fxQueue.some((fx) => fx.kind === "line_cleave")).toBe(true);
  });

  it("Firestorm damages units and emits its cast visuals", () => {
    const s = createInitialState(tinyMap, ["firestorm"]);
    s.flux = 1000;
    const enemy = unit(4001, "enemy", "Line", null);
    enemy.x = 18;
    enemy.z = 0;
    enemy.hp = 100;
    enemy.maxHp = 100;
    s.units.push(enemy);

    applyPlayerIntents(s, [
      { type: "select_doctrine_slot", index: 0 },
      { type: "try_click_world", pos: { x: 18, z: 0 } },
    ]);

    expect(enemy.hp).toBeLessThan(100);
    expect(s.stats.commandsCast).toBe(1);
    expect(s.fxQueue.some((fx) => fx.kind === "firestorm")).toBe(true);
  });

  it("Fortify creates a tactics field", () => {
    const s = createInitialState(tinyMap, ["fortify"]);
    s.flux = 1000;

    applyPlayerIntents(s, [
      { type: "select_doctrine_slot", index: 0 },
      { type: "try_click_world", pos: { x: -20, z: 4 } },
    ]);

    expect(s.tacticsFieldZones).toHaveLength(1);
    expect(s.stats.commandsCast).toBe(1);
    expect(s.fxQueue.some((fx) => fx.kind === "fortify")).toBe(true);
  });

  it("Shatter chains into enemy fortresses and silences production", () => {
    const s = createInitialState(tinyMap, ["shatter"]);
    s.flux = 1000;

    applyPlayerIntents(s, [
      { type: "select_doctrine_slot", index: 0 },
      { type: "try_click_world", pos: { x: 80, z: 0 } },
    ]);

    expect(s.enemyRelays[0]!.hp).toBeLessThan(s.enemyRelays[0]!.maxHp);
    expect(s.enemyRelays[0]!.silencedUntilTick).toBeGreaterThan(s.tick);
    expect(s.stats.commandsCast).toBe(1);
    expect(s.fxQueue.some((fx) => fx.kind === "shatter")).toBe(true);
  });
});

describe("attack impulses", () => {
  it("pushes live units, clamps accumulated impulse, and skips dead units", () => {
    const live = unit(1, "enemy", "Swarm", null);
    live.x = 4;
    live.z = 0;
    applyAttackImpulse(live, { x: 0, z: 0 }, 50);
    expect(Math.hypot(live.vxImpulse, live.vzImpulse)).toBeLessThanOrEqual(8.5);
    expect(live.vxImpulse).toBeGreaterThan(0);

    const dead = unit(2, "enemy", "Line", null);
    dead.hp = 0;
    applyAttackImpulse(dead, { x: 0, z: 0 }, 50);
    expect(dead.vxImpulse).toBe(0);
    expect(dead.vzImpulse).toBe(0);
  });
});

describe("selection commands", () => {
  it("allows drag selection to command the Wizard and squads together", () => {
    const s = createInitialState(tinyMap, []);
    const ally = unit(5000, "player", "Swarm", null);
    s.units.push(ally);

    applyPlayerIntents(s, [
      { type: "select_units", unitIds: [HERO_SELECTION_ID, ally.id] },
      { type: "command_selected_units", x: -20, z: 12, mode: "move" },
    ]);

    expect(s.hero.targetX).toBe(-20);
    expect(s.hero.targetZ).toBe(12);
    expect(ally.order?.mode).toBe("move");
  });

  it("lets radial commands recruit nearby idle squads without selecting them first", () => {
    const s = createInitialState(tinyMap, []);
    const nearbyIdle = unit(5100, "player", "Swarm", null);
    nearbyIdle.x = -20;
    nearbyIdle.z = 14;
    const farIdle = unit(5101, "player", "Swarm", null);
    farIdle.x = 20;
    farIdle.z = 14;
    const busy = unit(5102, "player", "Swarm", null);
    busy.x = -18;
    busy.z = 12;
    busy.order = { mode: "move", x: -45, z: 0, waypoints: [], queued: [] };
    s.units.push(nearbyIdle, farIdle, busy);

    applyPlayerIntents(s, [
      { type: "command_selected_units", x: -20, z: 12, mode: "attack_move", includeNearbyIdle: true },
    ]);

    expect(nearbyIdle.order?.mode).toBe("attack_move");
    expect(farIdle.order).toBeUndefined();
    expect(busy.order?.x).toBe(-45);
  });
});
