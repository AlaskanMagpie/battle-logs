// Run against npm run multiplayer:dev with node --import tsx scripts/multiplayer-parity.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client, type Room } from "@colyseus/sdk";
import {
  playNetworkReplay,
  type NetworkReplay,
} from "../src/net/networkReplay";
import { BattleAuthority } from "../src/net/battleAuthority";
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  type NetworkGameSnapshot,
} from "../src/net/protocol";
import { QUICK_MATCH_DOCTRINE_SLOTS } from "../src/game/quickMatchDoctrine";
import type { PlayerIntent } from "../src/game/intents";
const endpoint = process.env.DOCTRINE_TEST_ROOM ?? "ws://127.0.0.1:2567";
const hands = {
  player: [...QUICK_MATCH_DOCTRINE_SLOTS],
  enemy: [...QUICK_MATCH_DOCTRINE_SLOTS].reverse(),
};
const mapUrl = "/maps/drowned_causeway.json";
const opts = { version: MULTIPLAYER_PROTOCOL_VERSION, mapUrl };
const map = JSON.parse(
  readFileSync(new URL("../public" + mapUrl, import.meta.url), "utf8"),
);
const rooms: Room[] = [];
const samples: Map<number, NetworkGameSnapshot>[] = [new Map(), new Map()];
let reconnected = false;
try {
  rooms.push(
    await new Client(endpoint).create("battle_room", {
      ...opts,
      doctrineSlots: hands.player,
    }),
  );
  rooms.push(
    await new Client(endpoint).joinById(rooms[0].roomId, {
      ...opts,
      doctrineSlots: hands.enemy,
    }),
  );
  for (const [i, room] of rooms.entries()) {
    room.onMessage("*", () => {});
    room.onMessage("snapshot", (snap: NetworkGameSnapshot) =>
      samples[i].set(snap.serverTick, snap),
    );
  }
  const peer = rooms[1];
  peer.reconnection.minUptime = 0;
  peer.onReconnect(() => {
    reconnected = true;
  });
  const send = (index: number, tick: number, intents: PlayerIntent[]) =>
    rooms[index].send("intent_batch", { tick, intents });
  const waitFor = async (fn: () => boolean) => {
    const end = Date.now() + 16000;
    while (!fn()) {
      if (Date.now() > end) throw Error("Room check timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  await waitFor(() => samples.every((m) => m.has(4)));
  const first = samples[0].get(4)!.world!;
  const nearest = (which: "hero" | "enemyHero") =>
    first.taps.reduce((a, b) => {
      const hero = first[which];
      return Math.hypot(a.x - hero.x, a.z - hero.z) <
        Math.hypot(b.x - hero.x, b.z - hero.z)
        ? a
        : b;
    });
  for (const [i, which] of (["hero", "enemyHero"] as const).entries()) {
    const tap = nearest(which);
    send(i, 4, [{ type: "hero_move", x: tap.x, z: tap.z }]);
  }
  await waitFor(() => samples.every((m) => m.has(100)));
  for (const [i, which] of (["hero", "enemyHero"] as const).entries()) {
    const cast = (i ? hands.enemy : hands.player).indexOf("firestorm");
    send(i, 100, [
      { type: "select_doctrine_slot", index: cast },
      { type: "try_click_world", pos: first[which] },
    ]);
  }
  peer.connection.close(4010, "reconnect test");
  await waitFor(() => reconnected);
  await waitFor(() => samples.every((m) => m.has(160)));
  const seed = Number(rooms[0].state.seed) >>> 0;

  const model = new BattleAuthority(map, seed, hands);
  let frames = 0;
  for (const [tick, snap] of samples[0]) {
    if (tick > 160) break;
    const view = snap.world!;
    for (; model.state.tick < tick; ) {
      const input = snap.appliedInputs?.find(
        (i) => i.tick === model.state.tick,
      );
      model.step(input?.player ?? [], input?.enemy ?? []);
    }
    assert.equal(
      model.checksum(),
      snap.checksum,
      "local replay at tick " + tick,
    );
    assert.deepEqual(
      model.state.taps.map((t) => [
        t.ownerTeam ?? null,
        t.anchorHp ?? null,
        t.yieldRemaining,
      ]),
      view.taps.map((t) => [
        t.ownerTeam ?? null,
        t.anchorHp ?? null,
        t.yieldRemaining,
      ]),
    );
    assert.equal(
      model.state.hero.surfaceId ?? null,
      view.hero.surfaceId ?? null,
    );
    const partner = samples[1].get(tick);
    if (partner) {
      assert.equal(partner.checksum, snap.checksum);
      assert.equal(partner.world!.hero.x, view.enemyHero.x);
      assert.equal(partner.world!.flux, view.enemyFlux);
    }
    frames++;
  }
  assert(model.state.taps.some((t) => t.ownerTeam === "player"));
  assert(model.state.taps.some((t) => t.ownerTeam === "enemy"));
  const end = samples[0].get(160)!.world!;
  assert(end.doctrineCooldownTicks[hands.player.indexOf("firestorm")] > 0);
  assert(
    samples[1].get(160)!.world!.doctrineCooldownTicks[
      hands.enemy.indexOf("firestorm")
    ] > 0,
  );
  const replayPromise = new Promise<NetworkReplay>((resolve) =>
    rooms[0].onMessage("network_replay", resolve),
  );
  rooms[0].send("request_replay", {});
  const replay = await replayPromise;
  const playback = playNetworkReplay(replay);
  assert(playback.state.tick >= 160);
  console.log(
    JSON.stringify({
      seed,
      replayedThrough: playback.state.tick,
      frames,
      throughTick: 160,
      reconnected,
      owners: end.taps.map((t) => t.ownerTeam ?? null),
      wallets: [end.flux, end.enemyFlux],
    }),
  );
} finally {
  for (const room of rooms.reverse()) await room.leave();
}
