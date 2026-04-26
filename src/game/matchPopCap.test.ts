import { describe, expect, it } from "vitest";
import { GLOBAL_POP_CAP } from "./constants";
import { createInitialState, effectiveGlobalPopCap } from "./state";
import type { MapData } from "./types";

const tinyMap: MapData = {
  version: 2,
  world: { halfExtents: 120, groundY: 0 },
  tapSlots: [],
  playerRelaySlots: [{ id: "p0", x: -40, z: 0 }],
  enemyRelaySlots: [{ id: "e0", x: 40, z: 0 }],
  playerStart: { x: -40, z: 0 },
  enemyStart: { x: 40, z: 0 },
  enemyCamps: [
    {
      id: "c1",
      origin: { x: 20, z: 0 },
      aggroRadius: 20,
      wakeRadius: 40,
      roster: [{ sizeClass: "Line", offset: { x: 2, z: 0 } }],
    },
  ],
};

describe("doctrine match global pop cap", () => {
  it("war_camp in loadout raises effective army cap", () => {
    const slots = Array.from({ length: 10 }, (_, i) => (i === 0 ? "war_camp" : null));
    const s = createInitialState(tinyMap, slots);
    expect(s.globalPopCapBonus).toBe(400);
    expect(effectiveGlobalPopCap(s)).toBe(GLOBAL_POP_CAP + 400);
  });

  it("empty slots use base cap only", () => {
    const s = createInitialState(tinyMap, []);
    expect(s.globalPopCapBonus).toBe(0);
    expect(effectiveGlobalPopCap(s)).toBe(GLOBAL_POP_CAP);
  });
});
