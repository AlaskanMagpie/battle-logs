import { describe, expect, it } from "vitest";
import { SnapshotBuffer } from "./onlineMatch";
import type { NetworkGameSnapshot } from "./protocol";

function snapshot(seq: number, tick = seq * 4, matchId = "m1"): NetworkGameSnapshot {
  return {
    version: 1,
    matchId,
    serverTick: tick,
    snapshotSeq: seq,
    phase: "playing",
    checksum: seq,
    damage: { player: 0, enemy: 0 },
    hero: { x: 0, z: 0, hp: 1 },
    enemyHero: { x: 0, z: 0, hp: 1 },
    units: [],
  };
}

describe("SnapshotBuffer", () => {
  it("drops stale and wrong-match snapshots", () => {
    const buffer = new SnapshotBuffer({ matchId: "m1" });
    expect(buffer.push(snapshot(1))).toBe(true);
    expect(buffer.push(snapshot(1))).toBe(false);
    expect(buffer.push(snapshot(2, 8, "other"))).toBe(false);
    expect(buffer.stats()).toMatchObject({
      buffered: 1,
      droppedStale: 1,
      droppedInvalid: 1,
      latestSeq: 1,
    });
  });

  it("caps buffer length and records sequence gaps", () => {
    const buffer = new SnapshotBuffer({ maxSnapshots: 3 });
    expect(buffer.push(snapshot(1))).toBe(true);
    expect(buffer.push(snapshot(2))).toBe(true);
    expect(buffer.push(snapshot(5))).toBe(true);
    expect(buffer.push(snapshot(6))).toBe(true);
    expect(buffer.stats()).toMatchObject({ buffered: 3, gaps: 1, latestSeq: 6 });
    expect(buffer.aroundTick(22)?.map((s) => s.snapshotSeq)).toEqual([5, 6]);
  });
});
