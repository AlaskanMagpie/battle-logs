import { getCatalogEntry } from "../../catalog";
import {
  SURVIVAL_ENEMY_GLOBAL_CAP,
  SURVIVAL_ENEMY_STRUCTURE_CAP,
  SURVIVAL_RAMP_DURATION_TICKS,
  SURVIVAL_WAVE_INTERVAL_MAX_SEC,
  SURVIVAL_WAVE_INTERVAL_MIN_SEC,
  TICK_HZ,
} from "../../constants";
import { enemyHpScalar } from "../../difficulty";
import { pushFx, rand, type GameState, type StructureRuntime } from "../../state";
import { isStructureEntry, type EnemyCampDef, type Vec2 } from "../../types";
import { dist2 } from "./helpers";
import { spawnEnemyBatchFromStructureCatalogId } from "./production";

const SURVIVAL_UNIT_CATALOG_IDS = [
  "watchtower",
  "outpost",
  "emberroot_bastion",
  "aionroot_observatory",
  "bastion_keep",
  "verdant_citadel",
] as const;

const SURVIVAL_BUILDING_CATALOG_IDS = [
  "watchtower",
  "outpost",
  "emberroot_bastion",
  "aionroot_observatory",
  "bastion_keep",
] as const;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function survivalRampProgress(s: GameState): number {
  if (s.scenario !== "survival") return 0;
  const rampTicks = Math.max(1, s.survival?.rampDurationTicks ?? SURVIVAL_RAMP_DURATION_TICKS);
  return clamp01(s.tick / rampTicks);
}

function livingEnemyUnitCount(s: GameState): number {
  return s.units.reduce((n, u) => (u.team === "enemy" && u.hp > 0 ? n + 1 : n), 0);
}

function livingEnemyStructureCount(s: GameState): number {
  return s.structures.reduce((n, st) => (st.team === "enemy" && st.hp > 0 ? n + 1 : n), 0);
}

function campAnchors(s: GameState): readonly EnemyCampDef[] {
  return s.map.enemyCamps.length > 0
    ? s.map.enemyCamps
    : [
        {
          id: "survival_north_fallback",
          origin: { x: 0, z: -s.map.world.halfExtents * 0.85 },
          aggroRadius: 44,
          wakeRadius: s.map.world.halfExtents * 2,
        },
        {
          id: "survival_south_fallback",
          origin: { x: 0, z: s.map.world.halfExtents * 0.85 },
          aggroRadius: 44,
          wakeRadius: s.map.world.halfExtents * 2,
        },
      ];
}

function shuffledAnchors(s: GameState, count: number): EnemyCampDef[] {
  const pool = [...campAnchors(s)];
  const out: EnemyCampDef[] = [];
  while (pool.length > 0 && out.length < count) {
    const idx = Math.floor(rand(s) * pool.length);
    const [picked] = pool.splice(idx, 1);
    if (picked) out.push(picked);
  }
  return out;
}

function pickUnitCatalogId(s: GameState, intensity: number): string {
  const maxIndex =
    intensity < 0.18
      ? 0
      : intensity < 0.38
        ? 1
        : intensity < 0.58
          ? 3
          : intensity < 0.82
            ? 4
            : SURVIVAL_UNIT_CATALOG_IDS.length - 1;
  const roll = Math.floor(rand(s) * (maxIndex + 1));
  return SURVIVAL_UNIT_CATALOG_IDS[Math.max(0, Math.min(maxIndex, roll))]!;
}

function jitteredAnchorPoint(s: GameState, anchor: Vec2, radius: number): Vec2 {
  const ang = rand(s) * Math.PI * 2;
  const dist = radius * (0.25 + rand(s) * 0.75);
  const half = s.map.world.halfExtents;
  const edgePad = 20;
  return {
    x: Math.max(-half + edgePad, Math.min(half - edgePad, anchor.x + Math.cos(ang) * dist)),
    z: Math.max(-half + edgePad, Math.min(half - edgePad, anchor.z + Math.sin(ang) * dist)),
  };
}

function spawnSurvivalBuilding(s: GameState, pos: Vec2, intensity: number): boolean {
  if (livingEnemyStructureCount(s) >= SURVIVAL_ENEMY_STRUCTURE_CAP) return false;
  const maxIndex = intensity < 0.42 ? 1 : intensity < 0.72 ? 3 : SURVIVAL_BUILDING_CATALOG_IDS.length - 1;
  const catalogId = SURVIVAL_BUILDING_CATALOG_IDS[Math.floor(rand(s) * (maxIndex + 1))]!;
  const def = getCatalogEntry(catalogId);
  if (!def || !isStructureEntry(def)) return false;

  const minSep2 = 22 * 22;
  for (const st of s.structures) {
    if (st.hp <= 0) continue;
    if (dist2(st, pos) < minSep2) return false;
  }

  const hp = Math.max(1, Math.round(def.maxHp * enemyHpScalar(s.map) * (0.72 + intensity * 0.45)));
  const productionTicks = Math.max(1, Math.round(def.productionSeconds * TICK_HZ * (1.08 - intensity * 0.28)));
  const st: StructureRuntime = {
    id: s.nextId.structure++,
    team: "enemy",
    catalogId,
    x: pos.x,
    z: pos.z,
    hp,
    maxHp: hp,
    buildTicksRemaining: 0,
    buildTotalTicks: 0,
    complete: true,
    productionTicksRemaining: Math.max(1, Math.round(productionTicks * 0.55)),
    doctrineSlotIndex: -1,
    rallyX: 0,
    rallyZ: 0,
    placementForward: false,
    damageReductionUntilTick: 0,
    productionSilenceUntilTick: 0,
    holdOrders: false,
    localPopCapBonus: 0,
  };
  s.structures.push(st);
  pushFx(s, { kind: "lightning", x: st.x, z: st.z, visualSeed: st.id });
  return true;
}

function spawnSurvivalArmies(s: GameState, anchors: readonly EnemyCampDef[], intensity: number): number {
  let spawned = 0;
  const alive = livingEnemyUnitCount(s);
  let room = Math.max(0, SURVIVAL_ENEMY_GLOBAL_CAP - alive);
  if (room <= 0) return 0;

  const wave = s.survival?.waveIndex ?? 0;
  const batchesPerAnchor = 1 + Math.floor(intensity * 3.2) + Math.floor(Math.min(3, wave / 24));
  for (const anchor of anchors) {
    const batchTotal = Math.max(1, batchesPerAnchor + (rand(s) < intensity * 0.45 ? 1 : 0));
    for (let i = 0; i < batchTotal && room > 0; i++) {
      const before = s.units.length;
      const catalogId = pickUnitCatalogId(s, intensity);
      const pos = jitteredAnchorPoint(s, anchor.origin, 18 + intensity * 24);
      const n = spawnEnemyBatchFromStructureCatalogId(s, catalogId, pos);
      if (n <= 0) continue;
      spawned += n;
      room -= n;
      if (s.units.length > before) {
        pushFx(s, { kind: "death_flash", x: pos.x, z: pos.z, impactRadius: 6 + intensity * 8 });
      }
    }
  }
  return spawned;
}

function nextWaveIntervalTicks(intensity: number): number {
  const sec = SURVIVAL_WAVE_INTERVAL_MAX_SEC + (SURVIVAL_WAVE_INTERVAL_MIN_SEC - SURVIVAL_WAVE_INTERVAL_MAX_SEC) * intensity;
  return Math.max(1, Math.round(sec * TICK_HZ));
}

export function survivalHordeDirector(s: GameState): void {
  if (s.scenario !== "survival" || !s.survival) return;
  if (s.tick < s.survival.nextSpawnTick) return;

  const intensity = survivalRampProgress(s);
  if (intensity >= 1 && s.survival.maxIntensityReachedTick === undefined) {
    s.survival.maxIntensityReachedTick = s.tick;
  }

  s.survival.waveIndex += 1;
  const anchorCount = Math.min(campAnchors(s).length, 1 + Math.floor(intensity * 3) + (s.survival.waveIndex % 7 === 0 ? 1 : 0));
  const anchors = shuffledAnchors(s, anchorCount);
  const spawned = spawnSurvivalArmies(s, anchors, intensity);

  let buildings = 0;
  const buildingChance = intensity < 0.22 ? 0.08 : 0.18 + intensity * 0.48;
  if (rand(s) < buildingChance || s.survival.waveIndex % 6 === 0) {
    const buildingAnchors = anchors.length > 0 ? anchors : shuffledAnchors(s, 1);
    const attempts = 1 + (intensity > 0.66 ? 1 : 0) + (intensity > 0.92 && s.survival.waveIndex % 3 === 0 ? 1 : 0);
    for (let i = 0; i < attempts; i++) {
      const anchor = buildingAnchors[i % buildingAnchors.length];
      if (!anchor) continue;
      const pos = jitteredAnchorPoint(s, anchor.origin, 28 + intensity * 48);
      if (spawnSurvivalBuilding(s, pos, intensity)) buildings += 1;
    }
  }

  if (spawned > 0 || buildings > 0) {
    const rampPct = Math.round(intensity * 100);
    s.lastMessage =
      buildings > 0
        ? `Survival wave ${s.survival.waveIndex}: ${spawned} hostiles and ${buildings} hostile building${buildings === 1 ? "" : "s"} flashed in (${rampPct}% ramp).`
        : `Survival wave ${s.survival.waveIndex}: ${spawned} hostiles flashed in (${rampPct}% ramp).`;
  }

  s.survival.nextSpawnTick = s.tick + nextWaveIntervalTicks(intensity);
}
