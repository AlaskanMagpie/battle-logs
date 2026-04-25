/** Simulation ticks per second — higher = smoother movement/combat cadence (balance uses per-tick scaling). */
export const TICK_HZ = 20;

/** Cast FX (lightning, rings, etc.) are forcibly removed after this many wall-clock seconds. */
export const FX_ABSOLUTE_MAX_LIFETIME_SEC = 3;

/** When false, doctrine slots are normalized to structure cards only (no command "spells"). */
export const DOCTRINE_COMMANDS_ENABLED = false;

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

/** Player units (offense): larger than old `max(10, range*3)` so armies actually contest space. */
export const PLAYER_UNIT_HUNT_DETECT_MULT = 6;
export const PLAYER_UNIT_HUNT_DETECT_MIN = 28;

/** Spatial hash cell size (world XZ) for unit–unit separation. */
export const UNIT_SEPARATION_GRID = 3.5;

/** Portion of pairwise overlap to resolve per separation pass (0..1). */
export const UNIT_SEPARATION_STRENGTH = 0.62;

/** Extra separation passes per tick (rebuilds grid each pass) for dense armies. */
export const UNIT_SEPARATION_PASSES = 2;

/** Max XZ displacement from separation in one pass (world units). */
export const UNIT_SEPARATION_MAX_STEP = 1.6;

/** Prefer inactive Mana nodes with x >= this value (matches procedural enemy wedge in `generateProceduralTaps`). */
export const ENEMY_TAP_WEDGE_MARGIN_X = 52;

/** Rival wizard melee — tuned slightly below player strike. */
export const ENEMY_HERO_STRIKE_DAMAGE = 32;
export const ENEMY_HERO_STRIKE_COOLDOWN_TICKS = 22;

export const TAP_FLUX_PER_SEC = 1;
export const TAP_YIELD_MAX = 250;

/** Physical claim pillar on a Mana node — HP pool; when destroyed the node returns to neutral. */
export const TAP_ANCHOR_MAX_HP = 200;
/** Melee / strike range from unit or wizard to tap (x,z) to damage the anchor. */
export const TAP_ANCHOR_STRIKE_RADIUS = 3.2;

/** Build / place proximity to Tap or Keep (world units). */
export const INFRA_PLACE_RADIUS = 16;

/** Forward placement: near friendly unit/structure but not near infra (world units). */
export const FORWARD_PLACE_RADIUS = 8;

export const ENEMY_RELAY_MAX_HP = 520;

/** Wizard Keep — permanent base structure spawned at playerStart. Acts as the
 *  player's HP anchor (lose if it dies) and slowly produces a free T1 melee
 *  swarm so the wizard always has chaff on the field. */
export const KEEP_MAX_HP = 900;
export const KEEP_SWARM_PERIOD_SEC = 6;
export const KEEP_ID = "wizard_keep";

/** Army-wide population ceiling (sum of unit `pop`). High cap for stress tests / swarm play. */
export const GLOBAL_POP_CAP = 1000;

/** Enough for Tap + first Relay + one Tier-1 structure in one beat (playtest pacing). */
export const PLAYER_STARTING_FLUX = 280;

export const STRUCTURE_AGGRO_BLOCK_RADIUS = 12;

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
export const CAMP_CORE_DAMAGE_PER_UNIT_PER_TICK = 0.225;

/** After any enemy camp wakes, spawn a reinforcement Swarm on this cadence while under the cap. */
export const ENEMY_WAVE_EVERY_TICKS = 12 * TICK_HZ;
export const ENEMY_WAVE_GLOBAL_CAP = 22;

/** Player-controlled hero. */
export const HERO_SPEED = 11;
/** Max queued RMB destinations after the current move (Shift+right-click). */
export const HERO_MOVE_WAYPOINT_CAP = 16;
export const HERO_FOLLOW_RADIUS = 14;
/** Wizard must stand within this radius (idle) to channel a neutral Mana node. */
export const HERO_CLAIM_RADIUS = 12;
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
/** Far from home: tap Mana/sec yield scales down to this fraction (1 at home). */
export const HOME_TAP_YIELD_MULT_MIN = 0.52;
export const HERO_MAX_HP = 500;
/** WASD strafe/forward uses same speed scale as click-move. */
export const HERO_WASD_SPEED = 11;
/** Melee strike — range from wizard, damage per hit, cooldown in sim ticks (~0.8s wall time). */
export const HERO_ATTACK_RANGE = 9.25;
export const HERO_ATTACK_DAMAGE = 54;
export const HERO_ATTACK_COOLDOWN_TICKS = 14;
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

/** Territory: union of radii around the Keep, the Wizard, and claimed player taps (world units). */
export const TERRITORY_RADIUS = 72;
