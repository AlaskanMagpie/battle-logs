import { randomUUID } from "node:crypto";
import { Client, Room } from "colyseus";
import { Schema, defineTypes } from "@colyseus/schema";

const PROTOCOL_VERSION = 1;
const TICK_HZ = 20;
const MAX_INTENTS_PER_TICK = 32;
const RECONNECT_GRACE_SECONDS = 20;
const MAX_MESSAGES_PER_SECOND = 40;
const MAX_INVALID_MESSAGES = 5;
const MAP_URL_PATTERN = /^\/[a-zA-Z0-9_./-]+\.json$/;

type Seat = "player" | "enemy";
type ClientIntent = { type?: unknown };
type SeatIntentBatch = { tick?: unknown; intents?: unknown };
type JoinOptions = { version?: unknown; mapUrl?: unknown; username?: unknown; timeoutMs?: unknown };
type SnapshotAck = { snapshotSeq?: unknown };
type LifecycleEvent =
  | "room_created"
  | "join_rejected"
  | "player_joined"
  | "match_found"
  | "player_dropped"
  | "player_reconnected"
  | "player_left"
  | "ai_takeover"
  | "invalid_message"
  | "room_disposed";

class BattleState extends Schema {
  matchId = "";
  mapUrl = "";
  seed = 0;
  startsAtMs = 0;
  phase = "waiting";
  serverTick = 0;
  snapshotSeq = 0;
  playerSession = "";
  enemySession = "";
  playerConnected = false;
  enemyConnected = false;
  playerDamage = 0;
  enemyDamage = 0;
}

defineTypes(BattleState, {
  matchId: "string",
  mapUrl: "string",
  seed: "number",
  startsAtMs: "number",
  phase: "string",
  serverTick: "number",
  snapshotSeq: "number",
  playerSession: "string",
  enemySession: "string",
  playerConnected: "boolean",
  enemyConnected: "boolean",
  playerDamage: "number",
  enemyDamage: "number",
});

function seedFromMatchId(matchId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < matchId.length; i++) {
    h ^= matchId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function seatForClient(state: BattleState, client: Client): Seat | null {
  if (state.playerSession === client.sessionId) return "player";
  if (state.enemySession === client.sessionId) return "enemy";
  return null;
}

function sanitizeMapUrl(value: unknown): string {
  if (typeof value !== "string") return "/map.json";
  const trimmed = value.trim().slice(0, 128);
  return MAP_URL_PATTERN.test(trimmed) ? trimmed : "/map.json";
}

function validJoinOptions(options: JoinOptions): boolean {
  return options.version === PROTOCOL_VERSION;
}

function validIntentBatch(value: SeatIntentBatch): boolean {
  if (typeof value.tick !== "number" || !Number.isInteger(value.tick) || value.tick < 0) return false;
  if (!Array.isArray(value.intents) || value.intents.length > MAX_INTENTS_PER_TICK) return false;
  return value.intents.every((intent: ClientIntent) => typeof intent === "object" && intent !== null && typeof intent.type === "string");
}

export class BattleRoom extends Room<{ state: BattleState }> {
  maxClients = 2;
  maxMessagesPerSecond = MAX_MESSAGES_PER_SECOND;
  private invalidMessageCount = new Map<string, number>();
  private messageWindow = new Map<string, { t: number; n: number }>();
  private aiControlledSeats = new Set<Seat>();
  private lastSnapshotAck = new Map<string, number>();

  onCreate(options: JoinOptions): void {
    const matchId = randomUUID();
    const state = new BattleState();
    state.matchId = matchId;
    state.mapUrl = sanitizeMapUrl(options.mapUrl);
    state.seed = seedFromMatchId(matchId);
    state.startsAtMs = Date.now() + 1_000;
    this.setState(state);
    this.setPrivate(false);
    this.onMessage("intent_batch", (client, message: SeatIntentBatch) => this.handleIntentBatch(client, message));
    this.onMessage("snapshot_ack", (client, message: SnapshotAck) => this.handleSnapshotAck(client, message));
    this.setSimulationInterval(() => this.step(), 1000 / TICK_HZ);
    this.lifecycle("room_created", null, { mapUrl: state.mapUrl });
  }

  onJoin(client: Client, options: JoinOptions): void {
    if (!validJoinOptions(options)) {
      this.lifecycle("join_rejected", null, { sessionId: client.sessionId, reason: "protocol_version" });
      client.leave(4002);
      return;
    }
    const seat: Seat = this.state.playerSession ? "enemy" : "player";
    void options.username;
    if (seat === "player") {
      this.state.playerSession = client.sessionId;
      this.state.playerConnected = true;
    }
    else {
      this.state.enemySession = client.sessionId;
      this.state.enemyConnected = true;
      this.lock();
      this.state.phase = "starting";
      this.lifecycle("match_found", null, { player: this.state.playerSession, enemy: this.state.enemySession });
      this.clock.setTimeout(() => this.broadcast("match_found", this.matchFoundPayload()), 100);
    }
    this.lifecycle("player_joined", seat, { sessionId: client.sessionId });
  }

  onDrop(client: Client): void {
    const seat = seatForClient(this.state, client);
    if (seat) {
      if (seat === "player") this.state.playerConnected = false;
      else this.state.enemyConnected = false;
      this.lifecycle("player_dropped", seat, { sessionId: client.sessionId, graceSeconds: RECONNECT_GRACE_SECONDS });
    }
    void this.allowReconnection(client, RECONNECT_GRACE_SECONDS).catch(() => {
      this.convertDroppedSeatToAi(client);
    });
  }

  onReconnect(client: Client): void {
    const seat = seatForClient(this.state, client);
    if (seat === "player") this.state.playerConnected = true;
    else if (seat === "enemy") this.state.enemyConnected = true;
    if (seat) this.aiControlledSeats.delete(seat);
    this.lifecycle("player_reconnected", seat, { sessionId: client.sessionId });
    this.broadcast("player_reconnected", { sessionId: client.sessionId, seat });
  }

  onLeave(client: Client, code?: number): void {
    this.lifecycle("player_left", seatForClient(this.state, client), { sessionId: client.sessionId, code });
    this.convertDroppedSeatToAi(client);
  }

  onDispose(): void {
    this.lifecycle("room_disposed", null, {
      serverTick: this.state.serverTick,
      snapshotSeq: this.state.snapshotSeq,
    });
  }

  private matchFoundPayload(): Record<string, unknown> {
    return {
      version: PROTOCOL_VERSION,
      roomId: this.roomId,
      matchId: this.state.matchId,
      seed: this.state.seed,
      mapUrl: this.state.mapUrl,
      startsAtMs: this.state.startsAtMs,
      seats: {
        player: this.state.playerSession,
        enemy: this.state.enemySession,
      },
    };
  }

  private touchRateLimit(client: Client): boolean {
    const now = Date.now();
    const prior = this.messageWindow.get(client.sessionId);
    const next = !prior || now - prior.t > 1_000 ? { t: now, n: 1 } : { t: prior.t, n: prior.n + 1 };
    this.messageWindow.set(client.sessionId, next);
    return next.n <= MAX_MESSAGES_PER_SECOND;
  }

  private rejectInvalid(client: Client, reason: string): void {
    const n = (this.invalidMessageCount.get(client.sessionId) ?? 0) + 1;
    this.invalidMessageCount.set(client.sessionId, n);
    this.lifecycle("invalid_message", seatForClient(this.state, client), { sessionId: client.sessionId, reason, count: n });
    client.send("invalid_message", { reason, count: n });
    if (n >= MAX_INVALID_MESSAGES) client.leave(4002);
  }

  private handleIntentBatch(client: Client, message: SeatIntentBatch): void {
    if (!this.touchRateLimit(client)) {
      this.rejectInvalid(client, "rate_limit");
      return;
    }
    const seat = seatForClient(this.state, client);
    if (!seat) {
      this.rejectInvalid(client, "unknown_seat");
      return;
    }
    if (!validIntentBatch(message)) {
      this.rejectInvalid(client, "invalid_intent_batch");
      return;
    }
    this.broadcast("intent_batch", { seat, tick: message.tick, intents: message.intents }, { except: client });
  }

  private handleSnapshotAck(client: Client, message: SnapshotAck): void {
    if (!this.touchRateLimit(client)) {
      this.rejectInvalid(client, "rate_limit");
      return;
    }
    if (typeof message?.snapshotSeq !== "number" || !Number.isInteger(message.snapshotSeq) || message.snapshotSeq < 0) {
      this.rejectInvalid(client, "invalid_snapshot_ack");
      return;
    }
    this.lastSnapshotAck.set(client.sessionId, message.snapshotSeq);
  }

  private step(): void {
    if (this.state.phase === "starting" && Date.now() >= this.state.startsAtMs) this.state.phase = "playing";
    if (this.state.phase !== "playing") return;
    this.state.serverTick += 1;
    if (this.state.serverTick % 4 !== 0) return;
    this.state.snapshotSeq += 1;
    this.broadcast("snapshot", {
      version: PROTOCOL_VERSION,
      matchId: this.state.matchId,
      serverTick: this.state.serverTick,
      snapshotSeq: this.state.snapshotSeq,
      phase: this.state.phase,
      checksum: this.state.serverTick ^ this.state.seed,
      damage: { player: this.state.playerDamage, enemy: this.state.enemyDamage },
      hero: { x: 0, z: -20, hp: 1 },
      enemyHero: { x: 0, z: 20, hp: 1 },
      units: [],
    });
  }

  private convertDroppedSeatToAi(client: Client): void {
    const seat = seatForClient(this.state, client);
    if (!seat) return;
    if (this.aiControlledSeats.has(seat)) return;
    this.aiControlledSeats.add(seat);
    if (seat === "player") this.state.playerConnected = false;
    else this.state.enemyConnected = false;
    this.lifecycle("ai_takeover", seat, { sessionId: client.sessionId });
    this.broadcast("opponent_ai_takeover", { seat, reason: "disconnect" });
  }

  private lifecycle(event: LifecycleEvent, seat: Seat | null, detail: Record<string, unknown>): void {
    const payload = {
      event,
      roomId: this.roomId,
      matchId: this.state?.matchId ?? "",
      seat,
      phase: this.state?.phase ?? "unknown",
      at: Date.now(),
      ...detail,
    };
    console.info("[battle_room]", JSON.stringify(payload));
    this.broadcast("room_lifecycle", payload);
  }
}
