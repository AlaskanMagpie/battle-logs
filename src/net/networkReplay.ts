import { BattleAuthority } from "./battleAuthority";
import type { TeamId, MapData } from "../game/types";
import type { PlayerIntent } from "../game/intents";
export interface AppliedInputs {
  tick: number;
  player: PlayerIntent[];
  enemy: PlayerIntent[];
}
export interface NetworkReplay {
  version: 2;
  mode: "pvp";
  map: MapData;
  seed: number;
  hands: Record<TeamId, (string | null)[]>;
  inputs: AppliedInputs[];
  throughTick: number;
  terminal: boolean;
  checksum: number;
}
export function playNetworkReplay(replay: NetworkReplay): BattleAuthority {
  const authority = new BattleAuthority(
    structuredClone(replay.map),
    replay.seed,
    replay.hands,
  );
  let cursor = 0;
  while (
    authority.state.tick < replay.throughTick &&
    authority.state.phase === "playing"
  ) {
    const input =
      replay.inputs[cursor]?.tick === authority.state.tick
        ? replay.inputs[cursor++]
        : undefined;
    authority.step(input?.player ?? [], input?.enemy ?? []);
    authority.state.fxQueue.length = 0;
  }
  // The damage clock can settle at the current tick without incrementing it.
  if (replay.terminal && authority.state.phase === "playing")
    authority.step([], []);
  if (authority.checksum() !== replay.checksum)
    throw new Error("Network replay diverged from the room.");
  return authority;
}
