/** Simulation ticks per second (PRD). */
export const TICK_HZ = 10;

export const TAP_ACTIVATE_COST = 80;
export const TAP_FLUX_PER_SEC = 1;
export const TAP_YIELD_MAX = 250;

/** Build / place proximity to Tap or Relay (world units). */
export const INFRA_PLACE_RADIUS = 10;

/** Forward placement: near friendly unit/structure but not near infra (world units). */
export const FORWARD_PLACE_RADIUS = 8;

export const RELAY_COSTS_FLUX = [0, 120, 200, 250] as const;
export const RELAY_REBUILD_COST = 80;

export const GLOBAL_POP_CAP = 80;

/** Enough for Tap (80) + first Relay (0) + one Tier-1 structure in one beat (playtest pacing). */
export const PLAYER_STARTING_FLUX = 280;

export const STRUCTURE_AGGRO_BLOCK_RADIUS = 12;

/** Grace after losing all player relays (ticks). */
export const RELAY_LOSS_GRACE_TICKS = 10 * TICK_HZ;

/** Salvage → Flux: pool/40 per second, capped at 15 Flux/sec (implemented per tick). */
export const SALVAGE_FLUX_PER_POOL_PER_SEC = 1 / 40;
export const SALVAGE_FLUX_CAP_PER_SEC = 15;

/** % of structure build cost returned to Salvage on destroy (PRD 80%). */
export const SALVAGE_RETURN_STRUCTURE_FRAC = 0.8;

/** Forward build: time multiplier. */
export const FORWARD_BUILD_TIME_MULT = 2;
/** Forward build: incoming damage multiplier while constructing. */
export const FORWARD_BUILD_INCOMING_DAMAGE_MULT = 2;

export const ANTI_CLASS_DAMAGE_MULT = 1.5;
