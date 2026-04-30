import type { PlayerIntent } from "../game/intents";
import type { GamePhase } from "../game/types";

export const MULTIPLAYER_PROTOCOL_VERSION = 1;

export type MatchMode = "ai" | "matchmake" | "pvp" | "fallback_ai";
export type MatchSeat = "player" | "enemy";
export type QueueState = "idle" | "searching" | "matched" | "starting" | "fallback_ai" | "cancelled" | "error";

export interface MatchmakingRequest {
  version: number;
  mapUrl: string;
  doctrineSlots: (string | null)[];
  username?: string;
  timeoutMs: number;
}

export interface MatchFoundPayload {
  version: number;
  roomId: string;
  sessionId: string;
  seat: MatchSeat;
  matchId: string;
  seed: number;
  mapUrl: string;
  doctrineSlotsBySeat: Record<MatchSeat, (string | null)[]>;
  startsAtMs: number;
}

export type MatchmakingFallbackReason = "timeout" | "server_unavailable" | "cancelled" | "opponent_left" | "invalid_response";

export interface MatchmakingFallbackPayload {
  mode: "fallback_ai";
  reason: MatchmakingFallbackReason;
  message: string;
}

export interface MatchmakingHumanPayload {
  mode: "pvp";
  room: MatchFoundPayload;
}

export type MatchmakingResult = MatchmakingHumanPayload | MatchmakingFallbackPayload;

export interface SeatIntentBatch {
  seat: MatchSeat;
  tick: number;
  intents: PlayerIntent[];
}

export interface NetworkGameSnapshot {
  version: number;
  matchId: string;
  serverTick: number;
  snapshotSeq: number;
  phase: GamePhase;
  checksum: number;
  damage: Record<MatchSeat, number>;
  hero: { x: number; z: number; hp: number };
  enemyHero: { x: number; z: number; hp: number };
  units: Array<{ id: number; team: MatchSeat; x: number; z: number; hp: number; maxHp: number }>;
}

export interface MatchLaunchOptions {
  mode: MatchMode;
  matchId: string;
  seat?: MatchSeat;
  queueState?: QueueState;
  fallbackReason?: MatchmakingFallbackPayload["reason"];
  room?: MatchFoundPayload;
}

export function normalizeMatchMode(raw: string | null | undefined): MatchMode {
  const value = raw?.trim().toLowerCase();
  if (value === "matchmake" || value === "pvp") return "matchmake";
  if (value === "fallback_ai") return "fallback_ai";
  return "ai";
}

export function clampMatchmakingTimeoutMs(raw: string | null | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 4_000;
  return Math.max(1_000, Math.min(10_000, Math.round(n)));
}

export function makeClientMatchId(): string {
  const cryptoObj = globalThis.crypto;
  if (typeof cryptoObj?.randomUUID === "function") return cryptoObj.randomUUID();
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
