import type { GameState } from "../game/state";

export const TRAILER_HERO_MODE =
  import.meta.env.MODE !== "test" && import.meta.env.VITE_TRAILER_HERO_MODE === "true";

export const TRAILER_HERO_MODE_MANA = 999_999;

export function trailerHeroModeStartingFlux(normalFlux: number): number {
  return TRAILER_HERO_MODE ? TRAILER_HERO_MODE_MANA : normalFlux;
}

export function trailerHeroModeSpend(cost: number): number {
  return TRAILER_HERO_MODE ? 0 : cost;
}

export function trailerHeroModeCooldownTicks(ticks: number): number {
  return TRAILER_HERO_MODE ? 0 : ticks;
}

export function applyTrailerHeroModeResources(s: GameState): void {
  if (!TRAILER_HERO_MODE) return;
  s.flux = Math.max(s.flux, TRAILER_HERO_MODE_MANA);
  for (let i = 0; i < s.doctrineCooldownTicks.length; i++) {
    s.doctrineCooldownTicks[i] = 0;
  }
}
