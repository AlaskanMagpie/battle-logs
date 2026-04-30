import { Client, type Room } from "@colyseus/sdk";
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  type MatchFoundPayload,
  type MatchmakingFallbackReason,
  type MatchmakingRequest,
  type MatchmakingResult,
} from "./protocol";

export interface MatchmakingClientOptions {
  endpoint?: string;
  timeoutMs: number;
  mapUrl: string;
  doctrineSlots: (string | null)[];
  username?: string;
}

type BattleRoomState = {
  matchId?: string;
  seed?: number;
  mapUrl?: string;
  startsAtMs?: number;
  playerSession?: string;
  enemySession?: string;
};

type MatchFoundMessage = Omit<MatchFoundPayload, "sessionId" | "seat"> & {
  seats?: { player?: string; enemy?: string };
};

let activeBattleRoom: Room<BattleRoomState> | null = null;

export function getActiveBattleRoom(): Room<BattleRoomState> | null {
  return activeBattleRoom;
}

function configuredEndpoint(explicit?: string): string | null {
  const raw = explicit ?? String(import.meta.env.VITE_COLYSEUS_URL ?? "");
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function fallback(reason: MatchmakingFallbackReason): MatchmakingResult {
  const copy: Record<MatchmakingFallbackReason, string> = {
    timeout: "No human opponent found quickly; starting against AI.",
    server_unavailable: "Multiplayer server is unavailable; starting against AI.",
    cancelled: "Matchmaking cancelled; starting against AI.",
    opponent_left: "Opponent left before start; starting against AI.",
    invalid_response: "Multiplayer room returned invalid setup; starting against AI.",
  };
  return { mode: "fallback_ai", reason, message: copy[reason] };
}

function roomPayload(room: Room<BattleRoomState>, request: MatchmakingRequest): MatchFoundPayload | null {
  const state = room.state;
  const sessionId = room.sessionId;
  const playerSession = state.playerSession;
  const enemySession = state.enemySession;
  const seat = sessionId === playerSession ? "player" : sessionId === enemySession ? "enemy" : null;
  if (!seat || !state.matchId || typeof state.seed !== "number") return null;
  return {
    version: MULTIPLAYER_PROTOCOL_VERSION,
    roomId: room.roomId,
    sessionId,
    seat,
    matchId: state.matchId,
    seed: state.seed >>> 0,
    mapUrl: state.mapUrl || request.mapUrl,
    doctrineSlotsBySeat: {
      player: request.doctrineSlots,
      enemy: request.doctrineSlots,
    },
    startsAtMs: typeof state.startsAtMs === "number" ? state.startsAtMs : Date.now() + 600,
  };
}

function messagePayload(room: Room<BattleRoomState>, message: MatchFoundMessage, request: MatchmakingRequest): MatchFoundPayload | null {
  const sessionId = room.sessionId;
  const playerSession = message.seats?.player;
  const enemySession = message.seats?.enemy;
  const seat = sessionId === playerSession ? "player" : sessionId === enemySession ? "enemy" : null;
  if (!seat || !message.matchId || typeof message.seed !== "number") return roomPayload(room, request);
  return {
    version: MULTIPLAYER_PROTOCOL_VERSION,
    roomId: room.roomId,
    sessionId,
    seat,
    matchId: message.matchId,
    seed: message.seed >>> 0,
    mapUrl: message.mapUrl || request.mapUrl,
    doctrineSlotsBySeat: {
      player: request.doctrineSlots,
      enemy: request.doctrineSlots,
    },
    startsAtMs: typeof message.startsAtMs === "number" ? message.startsAtMs : Date.now() + 600,
  };
}

export async function findHumanMatch(options: MatchmakingClientOptions): Promise<MatchmakingResult> {
  activeBattleRoom = null;
  const endpoint = configuredEndpoint(options.endpoint);
  if (!endpoint) return fallback("server_unavailable");
  const request: MatchmakingRequest = {
    version: MULTIPLAYER_PROTOCOL_VERSION,
    mapUrl: options.mapUrl,
    doctrineSlots: options.doctrineSlots,
    username: options.username,
    timeoutMs: options.timeoutMs,
  };
  let joinedRoom: Room<BattleRoomState> | null = null;
  const client = new Client(endpoint);
  const joinPromise = client.joinOrCreate<BattleRoomState>("battle_room", request).then((room) => {
    joinedRoom = room;
    return room;
  });
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    window.setTimeout(() => resolve("timeout"), options.timeoutMs);
  });
  try {
    const result = await Promise.race([joinPromise, timeoutPromise]);
    if (result === "timeout") {
      void joinPromise.then((room) => room.leave(true)).catch(() => undefined);
      return fallback("timeout");
    }
    const payload = await Promise.race([
      new Promise<MatchFoundPayload | null>((resolve) => {
        const fallbackTimer = window.setTimeout(() => resolve(roomPayload(result, request)), Math.min(800, options.timeoutMs));
        result.onMessage("match_found", (message: MatchFoundMessage) => {
          window.clearTimeout(fallbackTimer);
          resolve(messagePayload(result, message, request));
        });
      }),
      timeoutPromise.then(() => null),
    ]);
    if (!payload) {
      void result.leave(true);
      return fallback("invalid_response");
    }
    activeBattleRoom = result;
    return { mode: "pvp", room: payload };
  } catch {
    if (joinedRoom) void joinedRoom.leave(true);
    return fallback("server_unavailable");
  }
}
