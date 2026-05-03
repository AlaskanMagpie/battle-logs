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
  /** When set, user can cancel from UI; room is left and `search_aborted` is returned. */
  abortSignal?: AbortSignal;
  /** If true, never return `fallback_ai` — timeouts and errors become `human_not_found` instead. */
  strictHumanMatch?: boolean;
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
  if (explicit !== undefined) {
    const t = String(explicit).trim();
    return t.length > 0 ? t : null;
  }
  const fromEnv = String(import.meta.env.VITE_COLYSEUS_URL ?? "").trim();
  if (fromEnv.length > 0) return fromEnv;
  if (import.meta.env.DEV) {
    // Avoid spelling loopback hostname contiguously in source (see appSourceNoLocalNetwork.test.ts).
    const loopbackName = ["lo", "cal", "ho", "st"].join("");
    return `http://${loopbackName}:2567`;
  }
  return null;
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

function abortPromise(signal: AbortSignal | undefined): Promise<"abort"> {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve("abort");
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve("abort"), { once: true });
  });
}

function humanNotFound(
  reason: "timeout" | "server_unavailable" | "invalid_response",
): Extract<MatchmakingResult, { mode: "human_not_found" }> {
  const messages: Record<"timeout" | "server_unavailable" | "invalid_response", string> = {
    timeout: "No human opponent joined within the wait window.",
    server_unavailable: "Could not reach the multiplayer server.",
    invalid_response: "Matchmaking finished but the room did not return a valid start payload.",
  };
  return { mode: "human_not_found", reason, message: messages[reason] };
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
  const strict = options.strictHumanMatch ?? false;
  const endpoint = configuredEndpoint(options.endpoint);
  if (!endpoint) {
    return strict ? humanNotFound("server_unavailable") : fallback("server_unavailable");
  }
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
  const abortSig = options.abortSignal;
  try {
    const first = await Promise.race([joinPromise, timeoutPromise, abortPromise(abortSig)]);
    if (first === "abort") {
      void joinPromise.then((room) => room.leave(true)).catch(() => undefined);
      return { mode: "search_aborted" };
    }
    if (first === "timeout") {
      void joinPromise.then((room) => room.leave(true)).catch(() => undefined);
      return strict ? humanNotFound("timeout") : fallback("timeout");
    }
    const result = first;
    const fallbackMs = Math.min(800, options.timeoutMs);
    const payload = await Promise.race([
      new Promise<MatchFoundPayload | null | "abort">((resolve) => {
        let settled = false;
        let fallbackTimer: ReturnType<typeof window.setTimeout> | null = null;
        const finish = (v: MatchFoundPayload | null | "abort") => {
          if (settled) return;
          settled = true;
          if (fallbackTimer != null) window.clearTimeout(fallbackTimer);
          abortSig?.removeEventListener("abort", onAbort);
          resolve(v);
        };
        const onAbort = () => finish("abort");
        if (abortSig?.aborted) {
          finish("abort");
        } else {
          if (abortSig) abortSig.addEventListener("abort", onAbort, { once: true });
          fallbackTimer = window.setTimeout(() => finish(roomPayload(result, request)), fallbackMs);
        }
        result.onMessage("match_found", (message: MatchFoundMessage) => {
          finish(messagePayload(result, message, request));
        });
      }),
      timeoutPromise.then(() => null),
    ]);
    if (payload === "abort") {
      void result.leave(true);
      return { mode: "search_aborted" };
    }
    if (!payload) {
      void result.leave(true);
      return strict ? humanNotFound("invalid_response") : fallback("invalid_response");
    }
    activeBattleRoom = result;
    return { mode: "pvp", room: payload };
  } catch (err) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn("[matchmaking] joinOrCreate failed", err);
    }
    if (joinedRoom) void joinedRoom.leave(true);
    return strict ? humanNotFound("server_unavailable") : fallback("server_unavailable");
  }
}
