import { readFileSync } from "node:fs";
import type { AppliedInputs, NetworkReplay } from "../../src/net/networkReplay";
import { BattleAuthority } from "../../src/net/battleAuthority";
import { MAP_REGISTRY } from "../../src/game/loadMap";
import { normalizeDoctrineSlotsForMatch } from "../../src/game/state";
import type { PlayerIntent } from "../../src/game/intents";
import { validRoomIntent } from "./roomIntents";
import { randomUUID } from "node:crypto";
import { Client, Room } from "colyseus";
import { Schema, defineTypes } from "@colyseus/schema";

import { MULTIPLAYER_PROTOCOL_VERSION as PROTOCOL_VERSION } from "../../src/net/protocol";
const TICK_HZ = 20;
const MAX_INTENTS_PER_TICK = 32;
const RECONNECT_GRACE_SECONDS = 20;
const MAX_MESSAGES_PER_SECOND = 40;
const MAX_INVALID_MESSAGES = 5;
const MAP_URL_PATTERN = /^\/[a-zA-Z0-9_./-]+\.json$/;

type Seat = "player" | "enemy";
type ClientIntent = { type?: unknown };
type SeatIntentBatch = { tick?: unknown; intents?: unknown };
type JoinOptions = {
  doctrineSlots?: unknown;
  version?: unknown;
  mapUrl?: unknown;
  username?: unknown;
  timeoutMs?: unknown;
};
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
  declare matchId: string;
  declare mapUrl: string;
  declare seed: number;
  declare startsAtMs: number;
  declare phase: string;
  declare serverTick: number;
  declare snapshotSeq: number;
  declare playerSession: string;
  declare enemySession: string;
  declare playerConnected: boolean;
  declare enemyConnected: boolean;
  declare playerDamage: number;
  declare enemyDamage: number;

  constructor() {
    super();
    this.matchId = "";
    this.mapUrl = "";
    this.seed = 0;
    this.startsAtMs = 0;
    this.phase = "waiting";
    this.serverTick = 0;
    this.snapshotSeq = 0;
    this.playerSession = "";
    this.enemySession = "";
    this.playerConnected = false;
    this.enemyConnected = false;
    this.playerDamage = 0;
    this.enemyDamage = 0;
  }
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
  return MAP_URL_PATTERN.test(trimmed) &&
    MAP_REGISTRY.some((map) => map.url === trimmed)
    ? trimmed
    : "/map.json";
}

function validJoinOptions(options: JoinOptions): boolean {
  return options.version === PROTOCOL_VERSION;
}

function validIntentBatch(value: SeatIntentBatch): boolean {
  if (
    typeof value.tick !== "number" ||
    !Number.isInteger(value.tick) ||
    value.tick < 0
  )
    return false;
  if (
    !Array.isArray(value.intents) ||
    value.intents.length > MAX_INTENTS_PER_TICK
  )
    return false;
  return value.intents.every(
    (intent: ClientIntent) =>
      typeof intent === "object" &&
      intent !== null &&
      typeof intent.type === "string",
  );
}

export class BattleRoom extends Room<{ state: BattleState }> {
  maxClients = 2;
  maxMessagesPerSecond = MAX_MESSAGES_PER_SECOND;
  private authority?: BattleAuthority;
  private readonly hands: Record<Seat, (string | null)[]> = {
    player: [],
    enemy: [],
  };
  private readonly appliedInputs: AppliedInputs[] = [];
  private readonly journal: AppliedInputs[] = [];
  private replayMap?: NetworkReplay["map"];
  private readonly pending: Record<Seat, PlayerIntent[]> = {
    player: [],
    enemy: [],
  };
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
    this.onMessage("intent_batch", (client, message: SeatIntentBatch) =>
      this.handleIntentBatch(client, message),
    );
    this.onMessage("request_replay", (client) => {
      if (this.touchRateLimit(client) && this.authority && this.replayMap)
        client.send("network_replay", this.replay());
    });
    this.onMessage("snapshot_ack", (client, message: SnapshotAck) =>
      this.handleSnapshotAck(client, message),
    );
    this.setSimulationInterval(() => this.step(), 1000 / TICK_HZ);
    this.lifecycle("room_created", null, { mapUrl: state.mapUrl });
  }

  onJoin(client: Client, options: JoinOptions): void {
    if (!validJoinOptions(options)) {
      this.lifecycle("join_rejected", null, {
        sessionId: client.sessionId,
        reason: "protocol_version",
      });
      client.leave(4002);
      return;
    }
    const seat: Seat = this.state.playerSession ? "enemy" : "player";
    this.hands[seat] = normalizeDoctrineSlotsForMatch(
      Array.isArray(options.doctrineSlots)
        ? options.doctrineSlots
            .slice(0, 10)
            .map((v) => (typeof v === "string" ? v : null))
        : [],
    );
    if (seat === "player") {
      this.state.playerSession = client.sessionId;
      this.state.playerConnected = true;
    } else {
      this.state.enemySession = client.sessionId;
      this.state.enemyConnected = true;
      this.lock();
      const path = new URL("../../public" + this.state.mapUrl, import.meta.url);
      this.replayMap = JSON.parse(readFileSync(path, "utf8"));
      this.authority = new BattleAuthority(
        structuredClone(this.replayMap!),
        this.state.seed,
        this.hands,
      );
      this.state.startsAtMs = Date.now() + 1000;
      this.state.phase = "starting";
      this.lifecycle("match_found", null, {
        player: this.state.playerSession,
        enemy: this.state.enemySession,
      });
      this.clock.setTimeout(
        () => this.broadcast("match_found", this.matchFoundPayload()),
        100,
      );
    }
    this.lifecycle("player_joined", seat, { sessionId: client.sessionId });
  }

  onDrop(client: Client): void {
    const seat = seatForClient(this.state, client);
    if (seat) {
      if (seat === "player") this.state.playerConnected = false;
      else this.state.enemyConnected = false;
      this.lifecycle("player_dropped", seat, {
        sessionId: client.sessionId,
        graceSeconds: RECONNECT_GRACE_SECONDS,
      });
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
    this.lifecycle("player_left", seatForClient(this.state, client), {
      sessionId: client.sessionId,
      code,
    });
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
      doctrineSlotsBySeat: this.hands,
      seats: {
        player: this.state.playerSession,
        enemy: this.state.enemySession,
      },
    };
  }

  private touchRateLimit(client: Client): boolean {
    const now = Date.now();
    const prior = this.messageWindow.get(client.sessionId);
    const next =
      !prior || now - prior.t > 1_000
        ? { t: now, n: 1 }
        : { t: prior.t, n: prior.n + 1 };
    this.messageWindow.set(client.sessionId, next);
    return next.n <= MAX_MESSAGES_PER_SECOND;
  }

  private rejectInvalid(client: Client, reason: string): void {
    const n = (this.invalidMessageCount.get(client.sessionId) ?? 0) + 1;
    this.invalidMessageCount.set(client.sessionId, n);
    this.lifecycle("invalid_message", seatForClient(this.state, client), {
      sessionId: client.sessionId,
      reason,
      count: n,
    });
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
    if (
      !message ||
      !this.authority ||
      !validIntentBatch(message) ||
      !(message.intents as unknown[]).every((it) =>
        validRoomIntent(it, this.authority!.state.map),
      )
    ) {
      this.rejectInvalid(client, "invalid_intent_batch");
      return;
    }
    const intents = message.intents as PlayerIntent[];
    if (this.pending[seat].length + intents.length > MAX_INTENTS_PER_TICK)
      return this.rejectInvalid(client, "tick_capacity");
    this.pending[seat].push(...intents);
  }

  private handleSnapshotAck(client: Client, message: SnapshotAck): void {
    if (!this.touchRateLimit(client)) {
      this.rejectInvalid(client, "rate_limit");
      return;
    }
    if (
      typeof message?.snapshotSeq !== "number" ||
      !Number.isInteger(message.snapshotSeq) ||
      message.snapshotSeq < 0
    ) {
      this.rejectInvalid(client, "invalid_snapshot_ack");
      return;
    }
    this.lastSnapshotAck.set(client.sessionId, message.snapshotSeq);
  }

  private step(): void {
    if (this.state.phase === "starting" && Date.now() >= this.state.startsAtMs)
      this.state.phase = "playing";
    if (this.state.phase !== "playing") return;
    const battle = this.authority;
    if (!battle) return;
    const player = this.pending.player.splice(0);
    const enemy = this.pending.enemy.splice(0);
    if (player.length || enemy.length)
      this.appliedInputs.push({ tick: battle.state.tick, player, enemy });
    battle.step(player, enemy);
    const world = battle.state;
    this.state.serverTick = world.tick;
    this.state.phase = world.phase;
    this.state.playerDamage = world.stats.damageDealtPlayer;
    this.state.enemyDamage = world.stats.damageDealtEnemy;
    if (world.tick % 4 !== 0 && world.phase === "playing") return;
    const snapshotSeq = ++this.state.snapshotSeq;
    const checksum = battle.checksum();
    for (const client of this.clients) {
      const seat = seatForClient(this.state, client);
      if (!seat) continue;
      const view = battle.forSeat(seat);
      client.send("snapshot", {
        version: PROTOCOL_VERSION,
        matchId: this.state.matchId,
        serverTick: world.tick,
        snapshotSeq,
        phase: view.phase,
        checksum,
        damage: {
          player: this.state.playerDamage,
          enemy: this.state.enemyDamage,
        },
        hero: world.hero,
        enemyHero: world.enemyHero,
        units: world.units.map(({ id, team, x, z, hp, maxHp, surfaceId }) => ({
          id,
          team,
          x,
          z,
          hp,
          maxHp,
          surfaceId,
        })),
        world: view,
        appliedInputs: this.appliedInputs,
      });
    }
    this.journal.push(...this.appliedInputs);
    this.appliedInputs.length = 0;
    if (world.phase !== "playing")
      this.broadcast("network_replay", this.replay());
    world.fxQueue.length = 0;
  }

  private replay(): NetworkReplay {
    const model = this.authority!;
    return {
      version: 2,
      mode: "pvp",
      map: this.replayMap!,
      seed: this.state.seed,
      hands: this.hands,
      inputs: this.journal.concat(this.appliedInputs),
      throughTick: model.state.tick,
      terminal: model.state.phase !== "playing",
      checksum: model.checksum(),
    };
  }

  private convertDroppedSeatToAi(client: Client): void {
    const seat = seatForClient(this.state, client);
    if (!seat) return;
    if (this.aiControlledSeats.has(seat)) return;
    this.aiControlledSeats.add(seat);
    this.pending[seat].push({ type: "set_hero_captain", enabled: true });
    if (seat === "player") this.state.playerConnected = false;
    else this.state.enemyConnected = false;
    this.lifecycle("ai_takeover", seat, { sessionId: client.sessionId });
    this.broadcast("opponent_ai_takeover", { seat, reason: "disconnect" });
  }

  private lifecycle(
    event: LifecycleEvent,
    seat: Seat | null,
    detail: Record<string, unknown>,
  ): void {
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
