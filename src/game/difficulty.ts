import { ENEMY_DAMAGE_MULT, ENEMY_PRODUCTION_RATE_MULT } from "./constants";
import type { GameState } from "./state";
import type { MapData, MapDifficulty } from "./types";

export interface ResolvedMapDifficulty {
  enemyEffectivenessMult: number;
  enemyHpMult: number;
  enemyDmgMult: number;
  enemyDamageMult: number;
  enemyAttackSpeedMult: number;
  enemyCaptureSpeedMult: number;
  enemyBuildSpeedMult: number;
  enemyEconomyMult: number;
  enemyProductionSpeedMult: number;
}

const DEFAULT_ENEMY_EFFECTIVENESS_MULT = 0.6;
const MIN_SCALAR = 0.05;

function scalar(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_SCALAR, value);
}

export function normalizeMapDifficulty(d?: MapDifficulty): ResolvedMapDifficulty {
  const effect = scalar(d?.enemyEffectivenessMult, DEFAULT_ENEMY_EFFECTIVENESS_MULT);
  return {
    enemyEffectivenessMult: effect,
    enemyHpMult: scalar(d?.enemyHpMult, 1),
    enemyDmgMult: scalar(d?.enemyDmgMult, 1),
    enemyDamageMult: scalar(d?.enemyDamageMult, effect),
    enemyAttackSpeedMult: scalar(d?.enemyAttackSpeedMult, effect),
    enemyCaptureSpeedMult: scalar(d?.enemyCaptureSpeedMult, effect),
    enemyBuildSpeedMult: scalar(d?.enemyBuildSpeedMult, effect),
    enemyEconomyMult: scalar(d?.enemyEconomyMult, effect),
    enemyProductionSpeedMult: scalar(d?.enemyProductionSpeedMult, effect),
  };
}

function difficultyFromMap(map: MapData): ResolvedMapDifficulty {
  return normalizeMapDifficulty(map.difficulty);
}

export function enemyHpScalar(map: MapData): number {
  const d = difficultyFromMap(map);
  return d.enemyHpMult * d.enemyEffectivenessMult;
}

export function enemyDamageScalar(map: MapData): number {
  const d = difficultyFromMap(map);
  return ENEMY_DAMAGE_MULT * d.enemyDmgMult * d.enemyDamageMult;
}

export function enemyAttackSpeedScalar(s: GameState): number {
  return difficultyFromMap(s.map).enemyAttackSpeedMult;
}

export function enemyCaptureSpeedScalar(s: GameState): number {
  return difficultyFromMap(s.map).enemyCaptureSpeedMult;
}

export function enemyBuildSpeedScalar(s: GameState): number {
  return difficultyFromMap(s.map).enemyBuildSpeedMult;
}

export function enemyEconomyScalar(s: GameState): number {
  return difficultyFromMap(s.map).enemyEconomyMult;
}

export function enemyProductionSpeedScalar(s: GameState): number {
  return ENEMY_PRODUCTION_RATE_MULT * difficultyFromMap(s.map).enemyProductionSpeedMult;
}

export function enemyProductionSpeedScalarForMap(map: MapData): number {
  return ENEMY_PRODUCTION_RATE_MULT * difficultyFromMap(map).enemyProductionSpeedMult;
}
