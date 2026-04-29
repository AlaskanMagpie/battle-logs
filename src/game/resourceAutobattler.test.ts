import { describe, expect, it } from "vitest";
import { getCatalogEntry } from "./catalog";
import { buildProgress, production } from "./sim/systems/production";
import { availableProductionSlots } from "./sim/systems/production";
import { movement } from "./sim/systems/ai";
import { applyAttackImpulse, combat } from "./sim/systems/combat";
import { applyPlayerIntents } from "./sim/systems/intents";
import { advanceTick } from "./sim/tick";
import { unitStatsForCatalog } from "./sim/systems/helpers";
import { claimChannelSecForTap } from "./sim/systems/homeDistance";
import {
  buildReturnPortalUrl,
  buildVibeJamExitUrl,
  buildVibeJamExitUrlForPrematch,
  configureGamePortals,
  parsePortalContext,
} from "./portal";
import { readLocalLeaderboard, recordLocalLeaderboardResult, scoreMatchResult } from "./leaderboard";
import {
  KEEP_ID,
  KEEP_SWARM_PERIOD_SEC,
  PRODUCED_UNIT_ACROBAT_WARRIOR_SCOUTS,
  PRODUCED_UNIT_SIEGE_RAM,
  TICK_HZ,
  UNIT_ATTACK_COOLDOWN_TICKS,
  UNIT_ATTACK_DAMAGE_MULT,
} from "./constants";
import { enemyCaptureSpeedScalar, enemyDamageScalar, enemyProductionSpeedScalar } from "./difficulty";
import {
  canPlaceEnemyStructureAt,
  canUseDoctrineSlot,
  createInitialState,
  doctrineCardPlayability,
  heroStandPositionNearKeepAnchor,
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
    /** Outside keep disc + `STRUCTURE_MAP_OBSTACLE_RADIUS` union (see `structureObstacleFootprints`). */
    expect(placementFailureReason(s, "dragon_roost", { x: -20, z: 0 }, 0)).toBeNull();
  });

  it("enemy placement is also resource-only", () => {
    const s = createInitialState(tinyMap, []);
    s.enemyFlux = 1000;

    expect(canPlaceEnemyStructureAt(s, "ironhold_citadel", { x: 78, z: 4 })).toBeNull();
  });
});

describe("doctrine card playability", () => {
  it("explains affordable, unaffordable, cooldown, and territory states", () => {
    const ready = createInitialState(tinyMap, ["watchtower"]);
    ready.flux = 1000;
    expect(doctrineCardPlayability(ready, "watchtower", { x: -20, z: 0 }, 0).kind).toBe("ready");

    const poor = createInitialState(tinyMap, ["watchtower"]);
    poor.flux = 0;
    const mana = doctrineCardPlayability(poor, "watchtower", { x: -20, z: 0 }, 0);
    expect(mana.kind).toBe("mana");
    expect(mana.reason).toContain("more Mana");

    const cooling = createInitialState(tinyMap, ["watchtower"]);
    cooling.flux = 1000;
    cooling.doctrineCooldownTicks[0] = TICK_HZ * 3;
    const cd = doctrineCardPlayability(cooling, "watchtower", { x: -20, z: 0 }, 0);
    expect(cd.kind).toBe("cooldown");
    expect(cd.liveLabel).toBe("CD 3s");

    const outside = createInitialState(tinyMap, ["watchtower"]);
    outside.flux = 1000;
    const territory = doctrineCardPlayability(outside, "watchtower", { x: 130, z: 0 }, 0);
    expect(territory.kind).toBe("territory");
  });

  it("treats command spells as ready when Mana and cooldown allow (no per-match use cap)", () => {
    const s = createInitialState(tinyMap, ["firestorm"]);
    s.flux = 1000;

    const play = doctrineCardPlayability(s, "firestorm", { x: 10, z: 0 }, 0);

    expect(play.ok).toBe(true);
    expect(play.kind).toBe("ready");
    expect(placementFailureReason(s, "firestorm", { x: 10, z: 0 }, 0)).toBeNull();
  });
});

describe("batch production", () => {
  it.each([
    ["watchtower", "Swarm", 4, PRODUCED_UNIT_ACROBAT_WARRIOR_SCOUTS],
    ["outpost", "Line", 3, undefined],
    ["siege_works", "Heavy", 2, PRODUCED_UNIT_SIEGE_RAM],
    ["dragon_roost", "Titan", 1, undefined],
  ] as const)("spawns literal %s bodies", (catalogId, sizeClass, expected, producedUnitId) => {
    const s = createInitialState(tinyMap, []);
    const st = structure(catalogId, 100);
    const stats = unitStatsForCatalog(sizeClass);
    s.structures.push(st);
    const before = s.units.length;

    production(s);

    const spawned = s.units.slice(before).filter((u) => u.team === "player" && u.structureId === st.id);
    expect(spawned).toHaveLength(expected);
    expect(spawned.every((u) => u.sizeClass === sizeClass)).toBe(true);
    expect(spawned.every((u) => u.squadMaxCount === undefined && u.singleMaxHp === undefined)).toBe(true);
    expect(spawned.every((u) => u.maxHp === stats.maxHp && u.pop === stats.pop)).toBe(true);
    expect(spawned.every((u) => u.producedUnitId === producedUnitId)).toBe(true);
  });

  it("ignores old local pop caps and always emits the full batch", () => {
    const s = createInitialState(tinyMap, []);
    const st = structure("watchtower", 200);
    s.structures.push(st);
    for (let i = 0; i < 16; i++) s.units.push(unit(1000 + i, "player", "Swarm", st.id));

    expect(availableProductionSlots(s, st)).toBe(4);
    production(s);

    expect(s.units.filter((u) => u.structureId === st.id)).toHaveLength(20);
    expect(st.productionTicksRemaining).toBeGreaterThan(1);
  });

  it("does not partial-fill production batches", () => {
    const s = createInitialState(tinyMap, []);
    const st = structure("watchtower", 201);
    s.structures.push(st);
    for (let i = 0; i < 14; i++) s.units.push(unit(2000 + i, "player", "Swarm", st.id));

    expect(availableProductionSlots(s, st)).toBe(4);
    production(s);

    const spawned = s.units.filter((u) => u.structureId === st.id);
    expect(spawned).toHaveLength(18);
    expect(spawned.filter((u) => u.squadMaxCount === undefined)).toHaveLength(18);
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
    expect(spawned).toHaveLength(4);
    expect(spawned.every((u) => u.sizeClass === "Swarm")).toBe(true);
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
    expect(spawned).toHaveLength(4);
    expect(spawned.every((u) => u.dmgPerTick === unitStatsForCatalog("Swarm").dmgPerTick * enemyDamageScalar(s.map))).toBe(true);
    expect(st.productionTicksRemaining).toBe(Math.round((def.productionSeconds * TICK_HZ) / enemyProductionSpeedScalar(s)));
  });

  it("keeps the Wizard Keep producing literal guard bodies", () => {
    const s = createInitialState(tinyMap, []);
    const keep = s.structures.find((st) => st.catalogId === KEEP_ID);
    if (!keep) throw new Error("missing keep");

    keep.productionTicksRemaining = 1;
    production(s);

    const first = s.units.filter((u) => u.structureId === keep.id);
    expect(first).toHaveLength(4);
    expect(first.every((u) => u.maxHp === unitStatsForCatalog("Swarm").maxHp)).toBe(true);
    expect(keep.productionTicksRemaining).toBe(Math.round(KEEP_SWARM_PERIOD_SEC * TICK_HZ));

    keep.productionTicksRemaining = 1;
    production(s);
    expect(s.units.filter((u) => u.structureId === keep.id)).toHaveLength(8);

    keep.productionTicksRemaining = 1;
    production(s);
    expect(s.units.filter((u) => u.structureId === keep.id)).toHaveLength(12);
    expect(keep.productionTicksRemaining).toBe(Math.round(KEEP_SWARM_PERIOD_SEC * TICK_HZ));
  });

  it("production spawns bodies without combat energy hit marks", () => {
    const s = createInitialState(tinyMap, []);
    const st = structure("watchtower", 204);
    s.structures.push(st);

    production(s);

    expect(s.units.filter((u) => u.structureId === st.id)).toHaveLength(4);
    expect(s.combatHitMarks).toHaveLength(0);
    expect(s.fxQueue).toHaveLength(0);
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
    expect(attacker.lastAttackTick).toBe(s.tick);
    expect(s.combatHitMarks.some((m) => m.attackerId === attacker.id)).toBe(true);
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
    const expected = heroStandPositionNearKeepAnchor({ x: keep.x, z: keep.z }, s.map, "player");
    expect(s.hero.x).toBe(expected.x);
    expect(s.hero.z).toBe(expected.z);
    expect(s.hero.targetX).toBeNull();
    expect(s.lastMessage).toBe("Wizard reformed at the Keep.");
  });
});

describe("vibe jam portals", () => {
  it("parses and forwards portal query params with current game ref defaults", () => {
    const s = createInitialState(tinyMap, []);
    s.hero.hp = s.hero.maxHp / 2;
    const ctx = parsePortalContext("?portal=true&username=levelsio&color=red&speed=5&ref=fly.pieter.com");

    expect(ctx.enteredViaPortal).toBe(true);
    expect(ctx.params.username).toBe("levelsio");
    const exit = buildVibeJamExitUrl(ctx, s, "https://battle.logs/game?portal=true");
    expect(exit).toContain("https://vibejam.cc/portal/2026");
    expect(exit).toContain("username=levelsio");
    expect(exit).toContain("color=red");
    expect(exit).toContain("hp=50");
    expect(exit).toContain("ref=https%3A%2F%2Fbattle.logs%2Fgame");

    const back = buildReturnPortalUrl(ctx, s, "https://battle.logs/game?portal=true");
    expect(back).toContain("https://fly.pieter.com/");
    expect(back).toContain("portal=true");
    expect(back).toContain("username=levelsio");
  });

  it("does not place Vibe Jam walk-in portals on the battlefield during matches", () => {
    const s = createInitialState(tinyMap, []);
    const heroBefore = { x: s.hero.x, z: s.hero.z };
    const ctx = parsePortalContext("?portal=true&ref=https%3A%2F%2Fprevious.example%2Fgame");
    configureGamePortals(s, ctx, "https://battle.logs/game");

    expect(s.portal.enteredViaPortal).toBe(true);
    expect(s.portal.exitUrl).toBe("");
    expect(s.portal.returnUrl).toBeNull();
    expect(s.portal.cooldownTicksRemaining).toBe(0);
    expect(s.hero.x).toBe(heroBefore.x);
    expect(s.hero.z).toBe(heroBefore.z);

    s.hero.x = s.portal.exitPortal.x;
    s.hero.z = s.portal.exitPortal.z;
    advanceTick(s, []);

    expect(s.portal.pendingRedirectUrl).toBeNull();
  });

  it("builds a prematch Vibe Jam exit URL without a live GameState", () => {
    const ctx = parsePortalContext("?portal=true&username=levelsio&color=red&speed=5");
    const href = buildVibeJamExitUrlForPrematch(ctx, "https://battle.logs/game?portal=true");
    expect(href).toContain("https://vibejam.cc/portal/2026");
    expect(href).toContain("username=levelsio");
  });
});

describe("local leaderboard", () => {
  it("scores and stores completed matches without requiring a backend", () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
      removeItem: (key: string) => {
        stored.delete(key);
      },
      clear: () => stored.clear(),
      key: (index: number) => [...stored.keys()][index] ?? null,
      get length() {
        return stored.size;
      },
    } satisfies Storage;
    const s = createInitialState(tinyMap, []);
    s.phase = "win";
    s.stats.enemyKills = 7;
    s.stats.structuresBuilt = 3;
    s.tick = TICK_HZ * 90;

    const entry = recordLocalLeaderboardResult(s, "wizard", storage);

    expect(entry?.score).toBe(scoreMatchResult(s));
    const rows = readLocalLeaderboard(storage);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.username).toBe("wizard");
    expect(rows[0]!.phase).toBe("win");
  });
});

describe("hero node claiming", () => {
  it("channels and claims while the Wizard is still moving inside the node ring", () => {
    const s = createInitialState(tinyMap, []);
    const tap = s.taps[0]!;
    s.flux = 1000;
    const startFlux = s.flux;
    s.hero.x = tap.x - 3;
    s.hero.z = tap.z;
    s.hero.targetX = tap.x + 3;
    s.hero.targetZ = tap.z;

    advanceTick(s, []);

    expect(s.hero.claimChannelTarget).toBe(0);
    expect(s.hero.targetX).not.toBeNull();

    let guard = TICK_HZ * 8;
    while (!tap.active && guard-- > 0) {
      const side = guard % 2 === 0 ? 3 : -3;
      s.hero.targetX = tap.x + side;
      s.hero.targetZ = tap.z;
      advanceTick(s, []);
    }

    expect(tap.active).toBe(true);
    expect(tap.ownerTeam).toBe("player");
    expect(s.flux).toBeGreaterThan(startFlux);
  });
});

describe("hero captain mode", () => {
  it("moves the idle Wizard toward map objectives and pauses after manual orders", () => {
    const s = createInitialState(tinyMap, []);
    const startX = s.hero.x;
    s.heroCaptainEnabled = true;
    s.heroCaptainLastManualTick = -9999;

    advanceTick(s, []);

    expect(s.hero.targetX).toBe(s.taps[0]!.x);
    expect(s.hero.targetZ).toBe(s.taps[0]!.z);
    expect(s.lastMessage).toContain("Captain mode");

    applyPlayerIntents(s, [{ type: "hero_move", x: startX - 10, z: s.hero.z }]);
    expect(s.heroCaptainLastManualTick).toBe(s.tick);
    const manualTarget = s.hero.targetX;

    s.hero.targetX = null;
    s.hero.targetZ = null;
    advanceTick(s, []);

    expect(s.hero.targetX).toBeNull();

    s.tick += TICK_HZ * 2;
    advanceTick(s, []);
    expect(s.hero.targetX).not.toBe(manualTarget);
    expect(s.hero.targetX).toBe(s.taps[0]!.x);
  });

  it("routes the Wizard around blocking decor instead of driving straight into walls", () => {
    const walledMap: MapData = {
      ...tinyMap,
      tapSlots: [{ id: "tap_blocked", x: 40, z: 0 }],
      decor: [{ kind: "box", x: 0, z: 0, w: 8, h: 8, d: 80, blocksMovement: true }],
    };
    const s = createInitialState(walledMap, []);
    s.heroCaptainEnabled = true;
    s.heroCaptainLastManualTick = -9999;

    advanceTick(s, []);

    const tap = s.taps[0]!;
    const pathEnd =
      s.hero.moveWaypoints.length > 0
        ? s.hero.moveWaypoints.at(-1)!
        : { x: s.hero.targetX, z: s.hero.targetZ };
    expect(pathEnd).toEqual({ x: tap.x, z: tap.z });
    /** When the planner emits a multi-hop chain, the first leg should not jump straight to the objective. */
    if (s.hero.moveWaypoints.length > 0) {
      expect(s.hero.targetX).not.toBe(tap.x);
      expect(s.hero.targetZ).not.toBe(tap.z);
    }
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

  it("player-cast damage spells do not damage friendly units inside the area", () => {
    const s = createInitialState(tinyMap, ["firestorm", "recycle", "shatter"]);
    s.flux = 1000;
    const friendlyFirestorm = unit(4100, "player", "Line", null);
    friendlyFirestorm.x = 18;
    friendlyFirestorm.z = 0;
    const friendlyCutBack = unit(4101, "player", "Swarm", null);
    friendlyCutBack.x = 20;
    friendlyCutBack.z = 0;
    const friendlyShatter = unit(4102, "player", "Heavy", null);
    friendlyShatter.x = 80;
    friendlyShatter.z = 0;
    s.units.push(friendlyFirestorm, friendlyCutBack, friendlyShatter);

    applyPlayerIntents(s, [
      { type: "select_doctrine_slot", index: 0 },
      { type: "try_click_world", pos: { x: 18, z: 0 } },
      { type: "select_doctrine_slot", index: 1 },
      { type: "try_click_world", pos: { x: 20, z: 0 } },
      { type: "select_doctrine_slot", index: 2 },
      { type: "try_click_world", pos: { x: 80, z: 0 } },
    ]);

    expect(friendlyFirestorm.hp).toBe(friendlyFirestorm.maxHp);
    expect(friendlyCutBack.hp).toBe(friendlyCutBack.maxHp);
    expect(friendlyShatter.hp).toBe(friendlyShatter.maxHp);
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

describe("autonomous unit movement", () => {
  it("keeps idle offense units pressing map objectives without creating player orders", () => {
    const s = createInitialState(tinyMap, []);
    const ally = unit(5200, "player", "Swarm", null);
    ally.x = s.hero.x;
    ally.z = s.hero.z;
    s.units.push(ally);

    movement(s);

    expect(ally.order).toBeUndefined();
    expect(ally.autoOrder).toBeDefined();
    expect(ally.x).toBeGreaterThan(s.hero.x);
  });

  it("uses home-distance claim timing for squad captures", () => {
    const nearMap: MapData = { ...tinyMap, tapSlots: [{ id: "tap_near", x: -40, z: 0 }] };
    const farMap: MapData = { ...tinyMap, tapSlots: [{ id: "tap_far", x: 130, z: 0 }] };
    const near = createInitialState(nearMap, []);
    const far = createInitialState(farMap, []);
    const nearUnit = unit(5400, "player", "Swarm", null);
    const farUnit = unit(5401, "player", "Swarm", null);
    nearUnit.x = near.taps[0]!.x;
    nearUnit.z = near.taps[0]!.z;
    farUnit.x = far.taps[0]!.x;
    farUnit.z = far.taps[0]!.z;
    near.units.push(nearUnit);
    far.units.push(farUnit);

    movement(near);
    movement(far);

    const nearExpected = Math.round(claimChannelSecForTap(near, "player", near.taps[0]!) * TICK_HZ * 1.35) - 1;
    const farExpected = Math.round(claimChannelSecForTap(far, "player", far.taps[0]!) * TICK_HZ * 1.35) - 1;
    expect(near.taps[0]!.claimTicksRemaining).toBe(nearExpected);
    expect(far.taps[0]!.claimTicksRemaining).toBe(farExpected);
    expect(farExpected).toBeGreaterThan(nearExpected);
  });

  it("applies the enemy capture speed slider to squad captures", () => {
    const map: MapData = {
      ...tinyMap,
      tapSlots: [{ id: "tap_enemy", x: 80, z: 0 }],
      difficulty: { enemyEffectivenessMult: 0.5 },
    };
    const s = createInitialState(map, []);
    const hostile = unit(5500, "enemy", "Swarm", null);
    hostile.x = s.taps[0]!.x;
    hostile.z = s.taps[0]!.z;
    s.units.push(hostile);

    movement(s);

    const expected =
      Math.round((claimChannelSecForTap(s, "enemy", s.taps[0]!) * TICK_HZ * 1.35) / enemyCaptureSpeedScalar(s)) - 1;
    expect(s.taps[0]!.claimTeam).toBe("enemy");
    expect(s.taps[0]!.claimTicksRemaining).toBe(expected);
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

  it("orders selected squads into drag-defined formations", () => {
    const s = createInitialState(tinyMap, []);
    const a = unit(5300, "player", "Swarm", null);
    const b = unit(5301, "player", "Line", null);
    const c = unit(5302, "player", "Heavy", null);
    s.units.push(a, b, c);

    applyPlayerIntents(s, [
      { type: "select_units", unitIds: [a.id, b.id, c.id] },
      {
        type: "command_selected_units_formation",
        from: { x: -10, z: -12 },
        to: { x: -10, z: 12 },
        mode: "move",
        formationKind: "line",
      },
    ]);

    expect(a.order?.mode).toBe("move");
    expect(b.order?.mode).toBe("move");
    expect(c.order?.mode).toBe("move");
    expect(new Set(s.units.map((x) => `${x.order?.x.toFixed(1)},${x.order?.z.toFixed(1)}`)).size).toBe(3);
    expect(s.lastMessage).toContain("Line formation");
  });

  it("lets attack-move with includeNearbyIdle recruit nearby idle squads without selecting them first", () => {
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

  it("queues attack-move orders after the current unit command", () => {
    const s = createInitialState(tinyMap, []);
    const ally = unit(5200, "player", "Swarm", null);
    ally.order = { mode: "move", x: -30, z: 2, waypoints: [], queued: [] };
    s.units.push(ally);

    applyPlayerIntents(s, [
      { type: "select_units", unitIds: [ally.id] },
      { type: "command_selected_units", x: -10, z: 8, mode: "attack_move", queue: true },
    ]);

    expect(ally.order?.mode).toBe("move");
    expect(ally.order?.queued).toHaveLength(1);
    expect(s.lastMessage).toContain("queued to attack-move");
  });

  it("sets a global rally point from set_global_rally intent", () => {
    const s = createInitialState(tinyMap, []);
    s.armyStance = "defense";

    applyPlayerIntents(s, [{ type: "set_global_rally", x: -12, z: 9 }]);

    expect(s.armyStance).toBe("offense");
    expect(s.globalRallyActive).toBe(true);
    expect(s.globalRallyX).toBe(-12);
    expect(s.globalRallyZ).toBe(9);
  });

  it("sets the formation preset from set_formation_preset intent", () => {
    const s = createInitialState(tinyMap, []);

    applyPlayerIntents(s, [{ type: "set_formation_preset", formationKind: "arc" }]);

    expect(s.formationPreset).toBe("arc");
    expect(s.lastMessage).toContain("Arc");
  });

  it("lets formation commands with includeNearbyIdle recruit nearby idle squads", () => {
    const s = createInitialState(tinyMap, []);
    const nearbyIdle = unit(5300, "player", "Line", null);
    nearbyIdle.x = -20;
    nearbyIdle.z = 14;
    const farIdle = unit(5301, "player", "Line", null);
    farIdle.x = 40;
    farIdle.z = 14;
    s.units.push(nearbyIdle, farIdle);

    applyPlayerIntents(s, [
      {
        type: "command_selected_units_formation",
        from: { x: -24, z: 10 },
        to: { x: -16, z: 14 },
        mode: "move",
        includeNearbyIdle: true,
        formationKind: "wedge",
      },
    ]);

    expect(nearbyIdle.order?.mode).toBe("move");
    expect(farIdle.order).toBeUndefined();
    expect(s.lastMessage).toContain("Wedge formation");
  });
});
