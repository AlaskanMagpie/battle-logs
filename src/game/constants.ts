/** Simulation ticks per second — higher = smoother movement/combat cadence (balance uses per-tick scaling). */
export const TICK_HZ = 20;

/** Cast FX (lightning, rings, etc.) are forcibly removed after this many wall-clock seconds. */
export const FX_ABSOLUTE_MAX_LIFETIME_SEC = 3;

/** When false, doctrine slots are normalized to structure cards only (no command "spells"). */
export const DOCTRINE_COMMANDS_ENABLED = true;

/** Player doctrine size everywhere (binder picker, match HUD, sim). */
export const DOCTRINE_SLOT_COUNT = 10;

/** In-match HUD: two fanned rows of this many slots each. */
export const DOCTRINE_HAND_ROW_SIZE = DOCTRINE_SLOT_COUNT / 2;

/** Enemy wizard initial Mana pool. */
export const ENEMY_SETUP_STARTING_FLUX = 500;

/** Enemy AI tries to place a tower on this tick interval (scaled by map difficulty). Wall-time ≈ 2s at default TICK_HZ. */
export const ENEMY_AI_BUILD_ATTEMPT_INTERVAL_TICKS = 40;

/** Baseline Mana/sec for the rival wizard (scaled slightly by `map.difficulty`). */
export const ENEMY_AI_PASSIVE_FLUX_PER_SEC = 2.5;

/** While the rival has fewer than this many claimed nodes and neutral nodes remain, keep this much Mana in reserve so claims are not priced out by builds. */
export const ENEMY_AI_CLAIM_RESERVE_TAP_GOAL = 2;
export const ENEMY_AI_BUILD_RESERVE_AFTER_CLAIM_FEE = 22;

/** Prefer new enemy AI towers at least this far (world units) from existing enemy structures. */
export const ENEMY_AI_MIN_BUILD_SEP = 11;

/** Structure ids the enemy wizard may auto-build (cheapest viable first; placement still gated by `canPlaceEnemyStructureAt`). */
export const ENEMY_AI_BUILD_CATALOG_IDS: readonly string[] = [
  "outpost",
  "watchtower",
  "root_bunker",
  "menders_hut",
  "salvage_yard",
  "war_camp",
];

/** Enemy camp units: hunt player targets within this world radius (larger = more aggressive). */
export const ENEMY_UNIT_HUNT_DETECT = 118;

/** Scales enemy hunt radius with `map.world.halfExtents` (large arenas need larger acquire). */
export const ENEMY_HUNT_DETECT_MAP_MULT = 0.42;

/** Player units (offense): larger than old `max(10, range*3)` so armies actually contest space. */
export const PLAYER_UNIT_HUNT_DETECT_MULT = 6;
export const PLAYER_UNIT_HUNT_DETECT_MIN = 28;

/** Extra floor for player acquire radius from map half-extent (world units). */
export const PLAYER_ACQUIRE_MAP_MULT = 0.22;

/** Spatial hash cell size (world XZ) for unit–unit separation. Covers the 50ft Titan footprint. */
export const UNIT_SEPARATION_GRID = 8;

/** Portion of pairwise overlap to resolve per separation pass (0..1). */
export const UNIT_SEPARATION_STRENGTH = 0.62;

/** Extra separation passes per tick (rebuilds grid each pass) for dense armies. */
export const UNIT_SEPARATION_PASSES = 2;

/** Max XZ displacement from separation in one pass (world units). */
export const UNIT_SEPARATION_MAX_STEP = 1.6;

/**
 * Multiplies unit walk speed in `movement()` only (player + enemy units — not wizards).
 * Lower leaves more time between contacts for strategy.
 */
export const UNIT_MOVEMENT_SPEED_SCALE = 0.52;

/** Base spacing (world units) for formation slots when marching or gathering. */
export const UNIT_FORMATION_SPACING = 3.2;

/** Prefer inactive Mana nodes with x >= this value (matches procedural enemy wedge in `generateProceduralTaps`). */
export const ENEMY_TAP_WEDGE_MARGIN_X = 52;

/** Rival wizard melee — tuned slightly below player strike. */
export const ENEMY_HERO_STRIKE_DAMAGE = 32;
export const ENEMY_HERO_STRIKE_COOLDOWN_TICKS = 22;
/** Global enemy pressure scalars for balance passes. */
export const ENEMY_DAMAGE_MULT = 0.75;
export const ENEMY_PRODUCTION_RATE_MULT = 0.75;

export const TAP_FLUX_PER_SEC = 1;
export const TAP_YIELD_MAX = 250;

/** Physical claim pillar on a Mana node — HP pool; when destroyed the node returns to neutral. */
export const TAP_ANCHOR_MAX_HP = 200;
/** Melee / strike range from unit or wizard to tap (x,z) to damage the anchor. */
export const TAP_ANCHOR_STRIKE_RADIUS = 7;

/** Build / place proximity to Tap or Keep (world units). */
export const INFRA_PLACE_RADIUS = 18;

/** Forward placement: near friendly unit/structure but not near infra (world units). */
export const FORWARD_PLACE_RADIUS = 10;

export const ENEMY_RELAY_MAX_HP = 520;

/** Wizard Keep — permanent base structure spawned at playerStart. Acts as the
 *  player's HP anchor and slowly produces a small free T1 guard trickle. */
export const KEEP_MAX_HP = 900;
export const KEEP_SWARM_PERIOD_SEC = 12;
export const KEEP_ID = "wizard_keep";

/** Army-wide population ceiling for player and rival structure production. */
export const GLOBAL_POP_CAP = 1000;

/** Hard ceiling for `GLOBAL_POP_CAP + doctrine match bonuses` (prevents absurd overflow). */
export const GLOBAL_POP_CAP_MAX = 9999;

/**
 * Visual scale contract (canonical standing height). Titan = 50′ defines world scale;
 * Swarm / Line / Heavy step down in fixed feet. GLB normalization uses a height-first
 * extent so wide models (e.g. treant titans) are not shrunk to their horizontal AABB.
 */
export const UNIT_HEIGHT_FEET = {
  Swarm: 15,
  Line: 25,
  Heavy: 35,
  Titan: 50,
} as const;
/** World-space vertical target for a 50′ titan (same units as map XZ). */
export const UNIT_MESH_TITAN = 9.3;
export const FEET_PER_WORLD_UNIT = UNIT_HEIGHT_FEET.Titan / UNIT_MESH_TITAN;
export const UNIT_MESH_SWARM = UNIT_HEIGHT_FEET.Swarm / FEET_PER_WORLD_UNIT;
export const UNIT_MESH_LINE = UNIT_HEIGHT_FEET.Line / FEET_PER_WORLD_UNIT;
export const UNIT_MESH_HEAVY = UNIT_HEIGHT_FEET.Heavy / FEET_PER_WORLD_UNIT;

/** Spatial cell size (world XZ) for combat nearest-neighbor queries. */
export const COMBAT_SPATIAL_CELL = 18;

/** Firestorm / spell knockback initial planar speed (world units/sec impulse integrated per tick). */
export const SPELL_KNOCKBACK_SPEED = 9;

/** Small knockback on melee AoE splash targets (world units/sec impulse). */
export const SPELL_AOE_KNOCKBACK = 4.2;

/** Exponential decay per second for unit knockback velocity. */
export const KNOCKBACK_DECAY_PER_SEC = 7.5;

/** Enough for an early Mana node claim plus a first resource-gated structure. */
export const PLAYER_STARTING_FLUX = 280;

export const STRUCTURE_AGGRO_BLOCK_RADIUS = 15;

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

/** Unit combat derived-card constants. Keep these synced with `combat.ts` reads, not card copy. */
export const UNIT_LIFESTEAL_DAMAGE_FRAC = 0.35;
export const UNIT_AOE_SPLASH_DAMAGE_MULT = 0.6;
export const PLAYER_UNIT_STRUCTURE_DAMAGE_MULT = 0.5;
export const ENEMY_UNIT_STRUCTURE_DAMAGE_MULT = 0.35;
export const UNIT_TAP_ANCHOR_DAMAGE_MULT = 0.42;
/** Normal units attack on cadence, not every sim tick. Damage is scaled by cooldown, so slower swings hit harder. */
export const UNIT_ATTACK_COOLDOWN_TICKS = {
  Swarm: 56,
  Line: 82,
  Heavy: 70,
  Titan: 92,
} as const;
/** Per-hit lift over old per-tick DPS so slower attacks feel decisive when they land. */
export const UNIT_ATTACK_DAMAGE_MULT = {
  Swarm: 1.08,
  Line: 1.2,
  Heavy: 1.38,
  Titan: 1.6,
} as const;
/** Long-RMB radial can pull in idle nearby squads even when they were not selected. */
export const SMART_RADIAL_IDLE_RADIUS = 20;

/** Legacy radius for match-floor portal triggers (`portals.ts`); URLs are not set during matches. */
export const PORTAL_TRIGGER_RADIUS = 4.2;
export const PORTAL_SPAWN_COOLDOWN_TICKS = 2 * TICK_HZ;

/** Commands: friendly unit or completed player structure must be within this radius of the cast point (world units). */
export const COMMAND_FRIENDLY_PRESENCE_RADIUS = 18;

/** Fortify: duration and incoming damage multiplier while active (50% DR → multiply incoming by this). */
export const FORTIFY_DURATION_SEC = 15;
export const FORTIFY_INCOMING_DAMAGE_MULT = 0.5;

/** Fortify field: ground AoE duration and radius (drag-and-drop like other spells). */
export const FORTIFY_FIELD_RADIUS = 18;
export const FORTIFY_FIELD_DURATION_SEC = 14;
/** Allies in the field: move faster, hit harder, take slightly less from attacks. */
export const FORTIFY_FIELD_ALLY_SPEED_MULT = 1.2;
export const FORTIFY_FIELD_ALLY_DAMAGE_MULT = 1.14;
export const FORTIFY_FIELD_ALLY_INCOMING_MULT = 0.9;
/** Enemies in the field: slowed, weakened outgoing damage, take more damage. */
export const FORTIFY_FIELD_ENEMY_SPEED_MULT = 0.76;
export const FORTIFY_FIELD_ENEMY_DAMAGE_MULT = 0.8;
export const FORTIFY_FIELD_ENEMY_INCOMING_MULT = 1.12;

/** Firestorm: radius and burst damage to each enemy unit in the area. */
export const FIRESTORM_RADIUS = 16;
export const FIRESTORM_DAMAGE_PER_UNIT = 46;

/** Cut Back (Reclaim line spell): corridor from the Wizard toward aim; damages enemy units in the strip. */
export const CUT_LINE_LENGTH = 55;
export const CUT_LINE_HALF_WIDTH = 7.5;
export const CUT_LINE_DAMAGE_PER_UNIT = 56;

/** Weapon reach thresholds for close / medium / long combat FX profiles (world units). */
export const ATTACK_RANGE_CLOSE_MAX = 10;
export const ATTACK_RANGE_MEDIUM_MAX = 16;

/** Shatter (interim vs enemy relay): pick radius and burst damage; production pause when enemy structures exist uses structure runtime. */
export const SHATTER_TARGET_RADIUS = 12;
export const SHATTER_DAMAGE = 340;
export const SHATTER_PRODUCTION_PAUSE_SEC = 10;
/** Shatter: ground AoE to acquire first target, then chain lightning hops. */
export const SHATTER_CAST_RADIUS = 16;
export const SHATTER_CHAIN_RANGE = 22;
/** Total targets struck: first hit in the cast ring, then up to five chain jumps. */
export const SHATTER_CHAIN_MAX_TARGETS = 6;
/** Per-hop damage multiplier after the first strike. */
export const SHATTER_CHAIN_DAMAGE_FALLOFF = 0.72;

/** Optional camp scenario: player units within this range of a camp origin damage the camp core while the camp is awake. */
export const CAMP_CORE_ATTACK_RADIUS = 12;
export const CAMP_CORE_DAMAGE_PER_UNIT_PER_TICK = 0.225;

/** After any enemy camp wakes, spawn a reinforcement Swarm on this cadence while under the cap. */
export const ENEMY_WAVE_EVERY_TICKS = 12 * TICK_HZ;
/** Max living enemy units before camp waves stop adding more (stress-test scale). */
export const ENEMY_WAVE_GLOBAL_CAP = 8000;
/** Swarm count per reinforcement pulse; keep low so camp/orb bursts stay readable/perf-safe. */
export const REINFORCEMENT_WAVE_BATCH = 4;

/** Player-controlled hero. */
export const HERO_SPEED = 11;
/** Max queued RMB destinations after the current move (Shift+right-click). */
export const HERO_MOVE_WAYPOINT_CAP = 16;
export const HERO_FOLLOW_RADIUS = 14;
/** Wizard must stay within this radius to channel a neutral Mana node. */
export const HERO_CLAIM_RADIUS = 14;
/** Player right-click near a Mana node: assign capture order within this radius of the node's center. */
export const TAP_UNIT_ORDER_SNAP_RADIUS = 18;
/** While capturing, only chase enemies within this radius of the node (stay focused on the objective). */
export const TAP_CAPTURE_CONTEST_RADIUS = 30;
export const HERO_CLAIM_CHANNEL_SEC = 2;
export const HERO_CLAIM_FLUX_FEE = 20;

/** Home distance (world units): no extra claim time / flux below this radius from Keep + relays (player) or relays + enemy start (enemy). */
export const HOME_CLAIM_DISTANCE_NEAR = 42;
/** At or beyond this distance from home, claim scaling reaches its maximum. */
export const HOME_CLAIM_DISTANCE_FAR = 130;
/** Far from home: channel length multiplier (1 = unchanged at home, this value at max distance). */
export const HOME_CLAIM_CHANNEL_MULT_MAX = 2.15;
/** Far from home: Mana fee multiplier vs `HERO_CLAIM_FLUX_FEE` (1 at home). */
export const HOME_CLAIM_FLUX_MULT_MAX = 1.72;
/** Far from home / closer to mid-field: tap Mana/sec yield scales up to this multiplier. */
export const HOME_TAP_YIELD_MULT_MAX = 1.65;
export const HERO_MAX_HP = 500;
/** WASD strafe/forward uses same speed scale as click-move. */
export const HERO_WASD_SPEED = 11;
/** Circle radius vs `map.decor` with `blocksMovement` for wizard pathing (world units). */
export const HERO_MAP_OBSTACLE_RADIUS = 2.85;
/** Structure ghost center must stay outside blocking decor by at least this radius. */
export const STRUCTURE_MAP_OBSTACLE_RADIUS = 11;
/** Melee strike — range from wizard, damage per hit, cooldown in sim ticks (~0.8s wall time). */
export const HERO_ATTACK_RANGE = 18;
export const HERO_ATTACK_DAMAGE = 48;
export const HERO_ATTACK_COOLDOWN_TICKS = 14;
/** Tactical recall/blink: moves Wizard plus nearby friendly troops, never into the enemy half. */
export const HERO_TELEPORT_COOLDOWN_SEC = 30;
export const HERO_TELEPORT_UNIT_RADIUS = 16;
export const HERO_TELEPORT_DEST_RADIUS = 4;
/** Extra damage multiplier when the strike hits a Swarm-class unit. */
export const HERO_ATTACK_SWARM_MULT = 1.7;
/** Rival strike vs Swarm (below player Swarm mult for parity). */
export const ENEMY_HERO_STRIKE_SWARM_MULT = 1.45;

/** Forward-placed structures use this fraction of catalog maxHp (snowball: faster to kill than claiming deep nodes). */
export const FORWARD_STRUCTURE_HP_MULT = 0.58;
/** Hero strike damage vs enemy structures within this radius of an enemy-owned tap anchor (tower-on-node). */
export const HERO_STRIKE_NEAR_ENEMY_TAP_RADIUS = 22;
export const HERO_STRIKE_STRUCTURE_ON_ENEMY_NODE_MULT = 1.42;

/** Procedural Mana nodes per match (each side). */
export const TAP_NODES_PER_SIDE = 10;
/** Minimum spacing between procedurally placed Mana nodes (world units). */
export const TAP_GENERATION_MIN_SEP = 36;

/** Territory: union of radii around the Keep and owned Mana anchors (world units). */
export const TERRITORY_RADIUS = 72;
