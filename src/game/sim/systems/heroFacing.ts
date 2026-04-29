import type { GameState } from "../../state";

const MIN_FACE_EPS = 0.08;

/** World yaw (`rotation.y`) so the hero looks toward `(tx, tz)` from current `(x,z)`. */
export function applyHeroFacingTowardWorld(s: GameState, tx: number, tz: number): void {
  const h = s.hero;
  const dx = tx - h.x;
  const dz = tz - h.z;
  if (Math.hypot(dx, dz) <= MIN_FACE_EPS) return;
  h.facing = Math.atan2(dx, dz);
}

/** Same as {@link applyHeroFacingTowardWorld} for the rival wizard. */
export function applyEnemyHeroFacingTowardWorld(s: GameState, tx: number, tz: number): void {
  const h = s.enemyHero;
  const dx = tx - h.x;
  const dz = tz - h.z;
  if (Math.hypot(dx, dz) <= MIN_FACE_EPS) return;
  h.facing = Math.atan2(dx, dz);
}
