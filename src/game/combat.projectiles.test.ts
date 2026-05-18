import { describe, expect, it } from "vitest";
import { combat } from "./sim/systems/combat";
import { createInitialState } from "./state";
import { unitStatsForCatalog } from "./sim/systems/helpers";
import type { MapData, UnitRuntime, UnitSizeClass } from "./types";

const walledMap: MapData = {
  version: 2,
  world: { halfExtents: 160, groundY: 0 },
  tapSlots: [{ id: "tap_a", x: 18, z: 12 }],
  playerRelaySlots: [{ id: "p0", x: -44, z: 0 }],
  enemyRelaySlots: [{ id: "e0", x: 80, z: 0 }],
  playerStart: { x: -44, z: 0 },
  enemyStart: { x: 80, z: 0 },
  enemyCamps: [],
  useAuthorTapSlots: true,
  decor: [{ kind: "box", x: 0, z: 0, w: 12, h: 8, d: 12, blocksMovement: true, color: 0x333344 }],
};

function mkUnit(id: number, team: "player" | "enemy", sizeClass: UnitSizeClass, x: number, z: number): UnitRuntime {
  const st = unitStatsForCatalog(sizeClass);
  return {
    id,
    team,
    structureId: null,
    x,
    z,
    hp: st.maxHp * 3,
    maxHp: st.maxHp * 3,
    sizeClass,
    pop: st.pop,
    speedPerSec: st.speedPerSec,
    range: st.range,
    dmgPerTick: st.dmgPerTick,
    visualSeed: id,
    vxImpulse: 0,
    vzImpulse: 0,
    attackCooldownTicksRemaining: 0,
  };
}

describe("combat projectiles and LOS", () => {
  it("direct attacks do not connect when blocking decor interrupts segment LOS", () => {
    const s = createInitialState(walledMap, []);
    const a = mkUnit(501, "player", "Line", -6, 0);
    const d = mkUnit(502, "enemy", "Line", 6, 0);
    s.units.push(a, d);
    const hp0 = d.hp;
    combat(s);
    expect(d.hp).toBe(hp0);
    expect(s.combatHitMarks).toHaveLength(0);
    expect(s.combatProjectiles).toHaveLength(0);
    expect(a.attackCooldownTicksRemaining ?? 0).toBe(0);
  });

  it("long-range artillery enqueues a delayed strike that ignores decor blocking", () => {
    const s = createInitialState(walledMap, []);
    const a = mkUnit(601, "player", "Titan", -9, 0);
    const d = mkUnit(602, "enemy", "Swarm", 9, 0);
    s.units.push(a, d);
    const hp0 = d.hp;
    combat(s);
    const mine = s.combatProjectiles.filter((p) => p.attackerId === a.id);
    expect(mine).toHaveLength(1);
    expect(s.combatHitMarks).toHaveLength(0);
    expect(d.hp).toBe(hp0);
    expect(a.attackCooldownTicksRemaining).toBeGreaterThan(0);
    const proj = mine[0]!;
    expect(proj.spawnTick).toBe(s.tick);
    for (let t = s.tick + 1; t < proj.impactTick; t++) {
      s.tick = t;
      combat(s);
      expect(d.hp).toBe(hp0);
    }
    s.tick = proj.impactTick;
    combat(s);
    expect(d.hp).toBeLessThan(hp0);
    expect(s.combatHitMarks.some((m) => m.attackerId === a.id)).toBe(true);
  });

  it("commits attack cooldown when artillery fires, not on impact", () => {
    const s = createInitialState(walledMap, []);
    const a = mkUnit(701, "player", "Titan", -9, 0);
    const d = mkUnit(702, "enemy", "Swarm", 9, 0);
    s.units.push(a, d);
    combat(s);
    const cd = a.attackCooldownTicksRemaining ?? 0;
    expect(cd).toBeGreaterThan(0);
    const proj = s.combatProjectiles[0]!;
    s.tick = proj.impactTick;
    combat(s);
    expect(a.attackCooldownTicksRemaining).toBe(Math.max(0, cd - 1));
  });
});
