import type { Room } from "@colyseus/sdk";
import type { PlayerIntent } from "../game/intents";
import { MULTIPLAYER_PROTOCOL_VERSION, type NetworkGameSnapshot, type SeatIntentBatch } from "./protocol";

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

export interface OnlineMatchSession {
  snapshots: SnapshotBuffer;
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
  } = {},
): OnlineMatchSession {
  const snapshots = new SnapshotBuffer({ matchId: handlers.matchId });
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
  room.onMessage("snapshot", snapshotHandler);
  room.onMessage("opponent_ai_takeover", takeoverHandler);
  room.onMessage("invalid_message", invalidHandler);
  room.onMessage("room_lifecycle", lifecycleHandler);
  return {
    snapshots,
    sendIntents(tick, intents) {
      if (!Number.isInteger(tick) || tick < 0 || intents.length === 0) return;
      const batch: Omit<SeatIntentBatch, "seat"> = { tick, intents: intents.slice(0, 32) };
      room.send("intent_batch", batch);
    },
    stats: () => snapshots.stats(),
    dispose() {
      void room.leave(true);
    },
  };
}
