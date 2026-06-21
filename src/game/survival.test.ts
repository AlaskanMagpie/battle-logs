import { describe, expect, it } from "vitest";
import { MATCH_DURATION_TICKS, SURVIVAL_RAMP_DURATION_TICKS } from "./constants";
import { createInitialState, findKeep } from "./state";
import { survivalHordeDirector } from "./sim/systems/survival";
import { timeLimitCheck, winCheck } from "./sim/systems/winlose";
import type { MapData } from "./types";

const survivalMap: MapData = {
  version: 2,
  mapId: "test_survival",
  world: { halfExtents: 360, groundY: 0 },
  useAuthorTapSlots: true,
  useAllAuthorTapSlots: true,
  tapSlots: [
    { id: "tap_00", x: 0, z: -70 },
    { id: "tap_01", x: 70, z: 0 },
    { id: "tap_02", x: 0, z: 70 },
    { id: "tap_03", x: -70, z: 0 },
    { id: "tap_04", x: 130, z: -130 },
    { id: "tap_05", x: -130, z: -130 },
    { id: "tap_06", x: 130, z: 130 },
    { id: "tap_07", x: -130, z: 130 },
    { id: "tap_08", x: 220, z: 0 },
    { id: "tap_09", x: -220, z: 0 },
    { id: "tap_10", x: 0, z: 220 },
    { id: "tap_11", x: 0, z: -220 },
  ],
  playerRelaySlots: [{ id: "p_core", x: 0, z: 0 }],
  enemyRelaySlots: [],
  playerStart: { x: 0, z: 0 },
  enemyStart: { x: 0, z: -320 },
  enemyCamps: [
    { id: "spawn_n", origin: { x: 0, z: -320 }, aggroRadius: 30, wakeRadius: 420, initialUnitCount: 0 },
    { id: "spawn_s", origin: { x: 0, z: 320 }, aggroRadius: 30, wakeRadius: 420, initialUnitCount: 0 },
    { id: "spawn_e", origin: { x: 320, z: 0 }, aggroRadius: 30, wakeRadius: 420, initialUnitCount: 0 },
    { id: "spawn_w", origin: { x: -320, z: 0 }, aggroRadius: 30, wakeRadius: 420, initialUnitCount: 0 },
  ],
};

describe("survival scenario initialization", () => {
  it("places the Wizard Keep at the centered base anchor and keeps every authored node", () => {
    const s = createInitialState(survivalMap, [], { scenario: "survival" });
    const keep = findKeep(s);

    expect(s.scenario).toBe("survival");
    expect(keep?.x).toBe(0);
    expect(keep?.z).toBe(0);
    expect(s.taps).toHaveLength(survivalMap.tapSlots.length);
    expect(Object.values(s.enemyCampAwake).every(Boolean)).toBe(true);
  });
});

describe("survival rules", () => {
  it("does not end on the standard time limit or rival-wizard win condition", () => {
    const s = createInitialState(survivalMap, [], { scenario: "survival" });

    s.tick = MATCH_DURATION_TICKS;
    timeLimitCheck(s);
    expect(s.phase).toBe("playing");

    s.enemyHero.hp = 0;
    winCheck(s);
    expect(s.phase).toBe("playing");
  });
});

describe("survival horde director", () => {
  it("spawns more pressure at the end of the 10 minute ramp than near the opening", () => {
    const early = createInitialState(survivalMap, [], { scenario: "survival" });
    early.tick = early.survival!.nextSpawnTick;
    survivalHordeDirector(early);
    const earlySpawned = early.stats.enemyUnitsSpawned;

    const late = createInitialState(survivalMap, [], { scenario: "survival" });
    late.tick = SURVIVAL_RAMP_DURATION_TICKS;
    late.survival!.nextSpawnTick = late.tick;
    late.survival!.waveIndex = 30;
    survivalHordeDirector(late);
    const lateSpawned = late.stats.enemyUnitsSpawned;

    expect(earlySpawned).toBeGreaterThan(0);
    expect(lateSpawned).toBeGreaterThan(earlySpawned);
  });

  it("records wave telemetry and marks every tenth wave as a surge", () => {
    const s = createInitialState(survivalMap, [], { scenario: "survival" });
    s.tick = SURVIVAL_RAMP_DURATION_TICKS;
    s.survival!.nextSpawnTick = s.tick;
    s.survival!.waveIndex = 9;

    survivalHordeDirector(s);

    expect(s.survival!.waveIndex).toBe(10);
    expect(s.survival!.lastWave?.surge).toBe(true);
    expect(s.survival!.lastWave?.hostilesSpawned).toBeGreaterThan(0);
    expect(s.survival!.lastWave?.buildingsSpawned).toBeGreaterThan(0);
    expect(s.survival!.totalHostilesSpawned).toBe(s.stats.enemyUnitsSpawned);
    expect(s.survival!.hostileBuildingsSpawned).toBe(s.survival!.lastWave?.buildingsSpawned);
    expect(s.survival!.peakHostilesAlive).toBeGreaterThanOrEqual(s.survival!.lastWave!.hostilesSpawned);
  });
});
