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

/** Commands: friendly unit or completed player structure must be within this radius of the cast point (world units). */
export const COMMAND_FRIENDLY_PRESENCE_RADIUS = 12;

/** Fortify: duration and incoming damage multiplier while active (50% DR → multiply incoming by this). */
export const FORTIFY_DURATION_SEC = 15;
export const FORTIFY_INCOMING_DAMAGE_MULT = 0.5;

/** Firestorm: radius and burst damage to each enemy unit in the area. */
export const FIRESTORM_RADIUS = 11;
export const FIRESTORM_DAMAGE_PER_UNIT = 38;

/** Shatter (interim vs enemy relay): pick radius and burst damage; production pause when enemy structures exist uses structure runtime. */
export const SHATTER_TARGET_RADIUS = 9;
export const SHATTER_DAMAGE = 300;
export const SHATTER_PRODUCTION_PAUSE_SEC = 10;

/** Optional camp scenario: player units within this range of a camp origin damage the camp core while the camp is awake. */
export const CAMP_CORE_ATTACK_RADIUS = 7;
export const CAMP_CORE_DAMAGE_PER_UNIT_PER_TICK = 0.45;

/** After any enemy camp wakes, spawn a reinforcement Swarm on this cadence while under the cap. */
export const ENEMY_WAVE_EVERY_TICKS = 18 * TICK_HZ;
export const ENEMY_WAVE_GLOBAL_CAP = 22;
