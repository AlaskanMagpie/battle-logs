import {
  ENEMY_HUNT_DETECT_MAP_MULT,
  ENEMY_UNIT_HUNT_DETECT,
  PLAYER_ACQUIRE_MAP_MULT,
  PLAYER_UNIT_HUNT_DETECT_MIN,
  PLAYER_UNIT_HUNT_DETECT_MULT,
} from "../constants";

/** Enemy pursuit / step-toward-target activation distance (world units). */
export function enemyHuntDetectRadius(halfExtents: number): number {
  return Math.max(ENEMY_UNIT_HUNT_DETECT, halfExtents * ENEMY_HUNT_DETECT_MAP_MULT);
}

/**
 * Player unit search radius for nearest enemy (world units).
 * Blends weapon-based detect with a floor from map size so large maps still meet.
 */
export function playerAcquireRadius(halfExtents: number, unitWeaponRange: number): number {
  const fromWeapon = Math.max(PLAYER_UNIT_HUNT_DETECT_MIN, unitWeaponRange * PLAYER_UNIT_HUNT_DETECT_MULT);
  const fromMap = Math.max(PLAYER_UNIT_HUNT_DETECT_MIN, halfExtents * PLAYER_ACQUIRE_MAP_MULT);
  return Math.max(fromWeapon, fromMap * 0.55 + fromWeapon * 0.45);
}
