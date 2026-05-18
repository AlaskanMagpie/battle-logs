import type { Room } from "@colyseus/sdk";
import type { PlayerIntent } from "../game/intents";
import { MULTIPLAYER_PROTOCOL_VERSION, type MatchSeat, type NetworkGameSnapshot, type SeatIntentBatch } from "./protocol";

const MAX_RECENT_INTENT_BATCHES = 12;
const INTENT_RESEND_INTERVAL_MS = 100;

export interface SnapshotBufferStats {
  buffered: number;
  droppedStale: number;
  droppedInvalid: number;
  gaps: number;
  latestSeq: number | null;
}

function validSnapshot(snapshot: NetworkGameSnapshot, expectedMatchId?: string): boolean {
  if (snapshot.version !== MULTIPLAYER_PROTOCOL_VERSION) return false;
  if (expectedMatchId && snapshot.matchId !== expectedMatchId) return false;
  if (!Number.isInteger(snapshot.serverTick) || snapshot.serverTick < 0) return false;
  if (!Number.isInteger(snapshot.snapshotSeq) || snapshot.snapshotSeq < 0) return false;
  if (!Number.isFinite(snapshot.checksum)) return false;
  return true;
}

export class SnapshotBuffer {
  private readonly snapshots: NetworkGameSnapshot[] = [];
  private readonly maxSnapshots: number;
  private readonly expectedMatchId?: string;
  private droppedStale = 0;
  private droppedInvalid = 0;
  private gaps = 0;

  constructor(opts: { maxSnapshots?: number; matchId?: string } = {}) {
    this.maxSnapshots = Math.max(2, Math.min(32, opts.maxSnapshots ?? 8));
    this.expectedMatchId = opts.matchId;
  }

  push(snapshot: NetworkGameSnapshot): boolean {
    if (!validSnapshot(snapshot, this.expectedMatchId)) {
      this.droppedInvalid += 1;
      return false;
    }
    const last = this.snapshots[this.snapshots.length - 1];
    if (last && snapshot.snapshotSeq <= last.snapshotSeq) {
      this.droppedStale += 1;
      return false;
    }
    if (last && snapshot.snapshotSeq > last.snapshotSeq + 1) this.gaps += 1;
    this.snapshots.push(snapshot);
    while (this.snapshots.length > this.maxSnapshots) this.snapshots.shift();
    return true;
  }

  latest(): NetworkGameSnapshot | null {
    return this.snapshots[this.snapshots.length - 1] ?? null;
  }

  aroundTick(renderTick: number): [NetworkGameSnapshot, NetworkGameSnapshot] | null {
    if (this.snapshots.length < 2) return null;
    for (let i = 1; i < this.snapshots.length; i++) {
      const a = this.snapshots[i - 1]!;
      const b = this.snapshots[i]!;
      if (a.serverTick <= renderTick && b.serverTick >= renderTick) return [a, b];
    }
    return null;
  }

  stats(): SnapshotBufferStats {
    const latest = this.latest();
    return {
      buffered: this.snapshots.length,
      droppedStale: this.droppedStale,
      droppedInvalid: this.droppedInvalid,
      gaps: this.gaps,
      latestSeq: latest?.snapshotSeq ?? null,
    };
  }
}

/** Buffers relayed `intent_batch` messages (partner seat) for lockstep merge by sim tick. */
export class RemoteIntentLedger {
  private readonly byTick = new Map<number, Map<MatchSeat, PlayerIntent[]>>();

  ingest(seat: MatchSeat, tick: number, intents: PlayerIntent[]): void {
    if (!Number.isInteger(tick) || tick < 0) return;
    let row = this.byTick.get(tick);
    if (!row) {
      row = new Map();
      this.byTick.set(tick, row);
    }
    row.set(seat, intents);
  }

  hasPartnerIntents(tick: number, localSeat: MatchSeat): boolean {
    const partner: MatchSeat = localSeat === "player" ? "enemy" : "player";
    return this.byTick.get(tick)?.has(partner) === true;
  }

  /** Returns partner intents for `tick` and removes that entry (consume-once). */
  takePartnerIntents(tick: number, localSeat: MatchSeat): PlayerIntent[] | undefined {
    const partner: MatchSeat = localSeat === "player" ? "enemy" : "player";
    const row = this.byTick.get(tick);
    if (!row || !row.has(partner)) return undefined;
    const intents = row.get(partner)!;
    row.delete(partner);
    if (row.size === 0) this.byTick.delete(tick);
    return intents;
  }

  clear(): void {
    this.byTick.clear();
  }
}

export interface OnlineMatchSession {
  snapshots: SnapshotBuffer;
  intentLedger: RemoteIntentLedger;
  sendIntents: (tick: number, intents: PlayerIntent[]) => void;
  stats: () => SnapshotBufferStats;
  dispose: () => void;
}

export function attachOnlineMatchRoom(
  room: Room,
  handlers: {
    onSnapshot?: (snapshot: NetworkGameSnapshot) => void;
    onOpponentAiTakeover?: (seat: string) => void;
    onInvalidMessage?: (reason: string) => void;
    onLifecycle?: (event: string, payload: unknown) => void;
    matchId?: string;
    /** Colyseus relays the opponent's batches here (same message name as outbound sends). */
    onRemoteSeatIntents?: (payload: { seat: MatchSeat; tick: number; intents: PlayerIntent[] }) => void;
  } = {},
): OnlineMatchSession {
  const snapshots = new SnapshotBuffer({ matchId: handlers.matchId });
  const intentLedger = new RemoteIntentLedger();
  const sentIntentKeys = new Map<number, string>();
  const recentIntentBatches: Array<Omit<SeatIntentBatch, "seat">> = [];
  let resendCursor = 0;
  let lastResendAtMs = Date.now();
  const snapshotHandler = (snapshot: NetworkGameSnapshot): void => {
    if (!snapshots.push(snapshot)) return;
    handlers.onSnapshot?.(snapshot);
    room.send("snapshot_ack", { snapshotSeq: snapshot.snapshotSeq });
  };
  const takeoverHandler = (payload: { seat?: string }): void => {
    handlers.onOpponentAiTakeover?.(payload.seat ?? "unknown");
  };
  const invalidHandler = (payload: { reason?: string }): void => {
    handlers.onInvalidMessage?.(payload.reason ?? "invalid_message");
  };
  const lifecycleHandler = (payload: { event?: string }): void => {
    handlers.onLifecycle?.(payload.event ?? "unknown", payload);
  };
  const relayedIntentHandler = (msg: { seat?: string; tick?: unknown; intents?: unknown }): void => {
    if (typeof msg.tick !== "number" || !Number.isInteger(msg.tick) || msg.tick < 0) return;
    if (!Array.isArray(msg.intents)) return;
    const seat: MatchSeat = msg.seat === "enemy" ? "enemy" : "player";
    const intents = msg.intents as PlayerIntent[];
    intentLedger.ingest(seat, msg.tick, intents);
    handlers.onRemoteSeatIntents?.({ seat, tick: msg.tick, intents });
  };
  room.onMessage("snapshot", snapshotHandler);
  room.onMessage("opponent_ai_takeover", takeoverHandler);
  room.onMessage("invalid_message", invalidHandler);
  room.onMessage("room_lifecycle", lifecycleHandler);
  room.onMessage("intent_batch", relayedIntentHandler);
  const rememberIntentBatch = (batch: Omit<SeatIntentBatch, "seat">): void => {
    const existing = recentIntentBatches.findIndex((b) => b.tick === batch.tick);
    if (existing >= 0) recentIntentBatches.splice(existing, 1);
    recentIntentBatches.push(batch);
    while (recentIntentBatches.length > MAX_RECENT_INTENT_BATCHES) {
      const dropped = recentIntentBatches.shift();
      if (dropped) sentIntentKeys.delete(dropped.tick);
    }
    if (resendCursor >= recentIntentBatches.length) resendCursor = 0;
  };
  const sendIntentBatch = (batch: Omit<SeatIntentBatch, "seat">): void => {
    room.send("intent_batch", batch);
  };
  const resendRecentIntentBatch = (currentTick: number): void => {
    if (recentIntentBatches.length < 2) return;
    const now = Date.now();
    if (now - lastResendAtMs < INTENT_RESEND_INTERVAL_MS) return;
    lastResendAtMs = now;
    for (let i = 0; i < recentIntentBatches.length; i++) {
      const index = (resendCursor + i) % recentIntentBatches.length;
      const candidate = recentIntentBatches[index]!;
      if (candidate.tick === currentTick) continue;
      resendCursor = (index + 1) % recentIntentBatches.length;
      sendIntentBatch(candidate);
      return;
    }
  };
  return {
    snapshots,
    intentLedger,
    sendIntents(tick, intents) {
      if (!Number.isInteger(tick) || tick < 0) return;
      const batch: Omit<SeatIntentBatch, "seat"> = { tick, intents: intents.slice(0, 32) };
      const key = JSON.stringify(batch);
      if (sentIntentKeys.get(tick) !== key) {
        sentIntentKeys.set(tick, key);
        rememberIntentBatch(batch);
        sendIntentBatch(batch);
      } else {
        resendRecentIntentBatch(tick);
      }
    },
    stats: () => snapshots.stats(),
    dispose() {
      void room.leave(true);
    },
  };
}
