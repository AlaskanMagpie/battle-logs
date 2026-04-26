import type { PlayerIntent } from "./intents";
import type { GameState } from "./state";
import type { MapData } from "./types";

const CHECKSUM_INTERVAL_TICKS = 30;
const REPLAY_VERSION = 1;

export interface ReplayTickIntents {
  tick: number;
  intents: PlayerIntent[];
}

export interface ReplayChecksum {
  tick: number;
  hash: number;
}

export interface ReplayCapture {
  version: number;
  createdAtIso: string;
  mapVersion: number;
  doctrineSlots: (string | null)[];
  seed: number;
  ticks: ReplayTickIntents[];
  checksums: ReplayChecksum[];
}

function cloneIntent(intent: PlayerIntent): PlayerIntent {
  return { ...intent };
}

export function createReplayCapture(s: GameState, map: MapData): ReplayCapture {
  return {
    version: REPLAY_VERSION,
    createdAtIso: new Date().toISOString(),
    mapVersion: map.version,
    doctrineSlots: [...s.doctrineSlotCatalogIds],
    seed: s.rngState >>> 0,
    ticks: [],
    checksums: [],
  };
}

function mix(h: number, n: number): number {
  let x = (n | 0) ^ (h + 0x9e3779b9 + ((h << 6) | 0) + (h >>> 2));
  x |= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x | 0;
}

function quant(v: number): number {
  return Math.round(v * 1000) | 0;
}

export function stateChecksum(s: GameState): number {
  let h = 0x811c9dc5 | 0;
  h = mix(h, s.tick);
  h = mix(h, s.phase === "playing" ? 1 : s.phase === "win" ? 2 : 3);
  h = mix(h, quant(s.flux));
  h = mix(h, quant(s.salvage));
  h = mix(h, quant(s.enemyFlux));
  h = mix(h, s.rngState | 0);
  h = mix(h, s.units.length);
  h = mix(h, s.structures.length);

  for (const u of s.units) {
    h = mix(h, u.id);
    h = mix(h, u.team === "player" ? 1 : 2);
    h = mix(h, quant(u.x));
    h = mix(h, quant(u.z));
    h = mix(h, quant(u.hp));
    h = mix(h, quant(u.maxHp));
  }
  for (const st of s.structures) {
    h = mix(h, st.id);
    h = mix(h, st.team === "player" ? 1 : 2);
    h = mix(h, quant(st.x));
    h = mix(h, quant(st.z));
    h = mix(h, quant(st.hp));
    h = mix(h, st.complete ? 1 : 0);
    h = mix(h, st.buildTicksRemaining);
    h = mix(h, st.productionTicksRemaining);
  }
  h = mix(h, quant(s.hero.hp));
  h = mix(h, quant(s.hero.x));
  h = mix(h, quant(s.hero.z));
  h = mix(h, s.hero.attackCooldownTicksRemaining | 0);
  h = mix(h, quant(s.hero.wasdStrafe));
  h = mix(h, quant(s.hero.wasdForward));
  h = mix(h, quant(s.enemyHero.hp));
  h = mix(h, quant(s.enemyHero.x));
  h = mix(h, quant(s.enemyHero.z));
  h = mix(h, s.enemyHero.attackCooldownTicksRemaining | 0);
  h = mix(h, s.armyStance === "defense" ? 1 : 0);
  h = mix(h, s.globalRallyActive ? 1 : 0);
  h = mix(h, s.rallyClickPending ? 1 : 0);
  h = mix(h, s.tacticsFieldZones.length | 0);
  for (const zf of s.tacticsFieldZones) {
    h = mix(h, quant(zf.x));
    h = mix(h, quant(zf.z));
    h = mix(h, quant(zf.radius));
    h = mix(h, zf.untilTick | 0);
  }
  h = mix(h, s.globalPopCapBonus | 0);
  h = mix(h, quant(s.globalRallyX));
  h = mix(h, quant(s.globalRallyZ));
  for (const er of s.enemyRelays) {
    h = mix(h, quant(er.hp));
    h = mix(h, er.silencedUntilTick);
  }
  for (const t of s.taps) {
    h = mix(h, t.active ? 1 : 0);
    h = mix(h, quant(t.yieldRemaining));
    h = mix(h, t.ownerTeam === "player" ? 1 : t.ownerTeam === "enemy" ? 2 : 0);
    h = mix(h, quant(t.anchorHp ?? 0));
  }
  const bid = s.enemyAiLastBuildCatalogId;
  if (bid) for (let i = 0; i < bid.length; i++) h = mix(h, bid.charCodeAt(i) | 0);
  else h = mix(h, 0);
  return h >>> 0;
}

export function captureReplayTick(
  replay: ReplayCapture,
  tick: number,
  intents: PlayerIntent[],
  stateAfterTick: GameState,
): void {
  if (intents.length > 0) {
    replay.ticks.push({
      tick,
      intents: intents.map(cloneIntent),
    });
  }
  if (stateAfterTick.tick % CHECKSUM_INTERVAL_TICKS === 0) {
    replay.checksums.push({
      tick: stateAfterTick.tick,
      hash: stateChecksum(stateAfterTick),
    });
  }
}
