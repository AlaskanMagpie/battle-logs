import { TICK_HZ } from "./constants";

/** Elapsed sim time in seconds (uses `state.tick` and `TICK_HZ`). */
export function simSecondsFromMatchTick(tick: number): number {
  return tick / TICK_HZ;
}

/**
 * Formats how long the match ran in the sim, as m:ss, from the final `state.tick`
 * (same time basis as the match timer and `MATCH_DURATION_TICKS`).
 */
export function formatMatchDurationFromTicks(tick: number): string {
  const totalSec = Math.max(0, Math.floor(simSecondsFromMatchTick(tick) + 1e-9));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
