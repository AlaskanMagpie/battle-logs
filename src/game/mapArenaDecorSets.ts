import {
  pushBridgeBetweenBanks,
  pushCanyonRim,
  pushChannelFords,
  pushChokeRuinGate,
  pushFoliageAlongPolyline,
  pushFoliageAnnulus,
  pushFoliageGrove,
  pushKnoll,
  pushMesaSpire,
  pushPassableSphereScatter,
  pushWaterBasin,
  pushWaterChannel,
} from "./mapDecorAuthoring";
import type { MapDecorDef, Vec2 } from "./types";

/** East–west arroyo in the north or south band (flow along +X). */
function ewChannel(z: number, x0: number, x1: number): Vec2[] {
  const bend = Math.sign(z || 1) * Math.min(4, Math.abs(z) * 0.02);
  return [
    { x: x0, z },
    { x: (x0 + x1) * 0.5, z: z + bend },
    { x: x1, z },
  ];
}

/** The Line — corner bastions, gate chokes, twin E–W arroyos with fords, dry center lane. */
export function buildTheLineArenaDecor(halfExtents: number): MapDecorDef[] {
  const H = halfExtents;
  const out: MapDecorDef[] = [];
  const northZ = H * 0.48;
  const southZ = -H * 0.48;
  const chanW = H * 0.09;

  const northChan = ewChannel(northZ, -H * 0.64, H * 0.58);
  const southChan = ewChannel(southZ, -H * 0.62, H * 0.56);
  pushWaterChannel(out, northChan, chanW, { wobble: 0.08 });
  pushWaterChannel(out, southChan, chanW, { wobble: 0.08 });
  pushWaterBasin(out, -H * 0.58, northZ + H * 0.04, chanW * 0.95, chanW * 0.75, 8);
  pushWaterBasin(out, H * 0.54, southZ - H * 0.03, chanW * 0.9, chanW * 0.72, -6);

  pushChannelFords(out, northChan, chanW, [0.22, 0.5, 0.78], { deckRun: 22, clearance: 16 });
  pushChannelFords(out, southChan, chanW, [0.28, 0.55, 0.8], { deckRun: 20, clearance: 14 });

  pushBridgeBetweenBanks(out, { x: -H * 0.05, z: 0 }, { x: H * 0.05, z: 0 }, 24);

  pushChokeRuinGate(out, -H * 0.22, 0, H * 0.14, 12, 0);
  pushChokeRuinGate(out, H * 0.22, 0, H * 0.14, 12, 0);
  pushKnoll(out, -H * 0.42, H * 0.34, H * 0.04, 8, 18, "ruins");
  pushKnoll(out, H * 0.42, -H * 0.34, H * 0.04, 8, -12, "ruins");
  pushKnoll(out, -H * 0.42, -H * 0.36, H * 0.035, 7, -20, "ruins");
  pushKnoll(out, H * 0.42, H * 0.36, H * 0.035, 7, 14, "ruins");

  pushFoliageAlongPolyline(
    out,
    [
      { x: -H * 0.5, z: H * 0.22 },
      { x: H * 0.45, z: H * 0.2 },
    ],
    Math.max(18, H * 0.036),
    0x11c0,
    ["scrub", "bush", "tree"],
  );
  pushFoliageAlongPolyline(
    out,
    [
      { x: H * 0.5, z: -H * 0.22 },
      { x: -H * 0.42, z: -H * 0.2 },
    ],
    Math.max(18, H * 0.036),
    0x11c1,
    ["scrub", "tree"],
  );
  pushFoliageGrove(out, { x: -H * 0.74, z: 0 }, 18, H * 0.085, 0x11a2, ["tree", "scrub", "bush"]);
  pushFoliageGrove(out, { x: H * 0.74, z: 0 }, 16, H * 0.08, 0x22b3, ["tree", "scrub"]);
  pushFoliageAnnulus(out, 0, northZ, chanW * 1.2, chanW * 2.4, 12, 0x11d0, ["scrub", "bush"]);

  return out;
}

/** Forgewarden — crucible ring, E–W cooling channels on outer bands, fords onto mid lane. */
export function buildForgewardenArenaDecor(halfExtents: number): MapDecorDef[] {
  const H = halfExtents;
  const out: MapDecorDef[] = [];
  const northZ = H * 0.64;
  const southZ = -H * 0.7;
  const chanW = 18;

  out.push({
    kind: "torus",
    x: 0,
    z: 0,
    radius: 26,
    tube: 3.2,
    blocksMovement: true,
    color: 0x3a3038,
    terrainKind: "metal",
  });
  pushKnoll(out, -24, 0, 8, 6, 0, "lava");
  pushKnoll(out, 24, 0, 8, 6, 0, "lava");

  const northChan = ewChannel(northZ, -H * 0.58, H * 0.52);
  const southChan = ewChannel(southZ, -H * 0.54, H * 0.48);
  pushWaterChannel(out, northChan, chanW, { wobble: 0.06 });
  pushWaterChannel(out, southChan, chanW);
  pushWaterBasin(out, -H * 0.44, northZ, 28, 20, 0);
  pushWaterBasin(out, H * 0.4, southZ, 26, 18, 5);

  pushChannelFords(out, northChan, chanW, [0.35, 0.68], { deckRun: 18, clearance: 12 });
  pushChannelFords(out, southChan, chanW, [0.4, 0.72], { deckRun: 16, clearance: 12 });
  pushBridgeBetweenBanks(out, { x: -38, z: 0 }, { x: 38, z: 0 }, 14);

  pushMesaSpire(out, -58, 26, 6, 7);
  pushMesaSpire(out, 58, -26, 6, 7);
  pushKnoll(out, -62, -96, 14, 10, 15, "basalt");
  pushKnoll(out, 62, 96, 14, 10, -12, "basalt");

  pushCanyonRim(out, 0, H * 0.68, 48, 16, 0);
  pushCanyonRim(out, 0, -H * 0.68, 48, 16, 0);

  pushFoliageGrove(out, { x: -H * 0.62, z: -H * 0.32 }, 12, 28, 0xf01, ["scrub", "bush"]);
  pushFoliageGrove(out, { x: H * 0.58, z: H * 0.34 }, 12, 26, 0xf02, ["scrub"]);
  pushPassableSphereScatter(out, { x: 0, z: northZ }, 10, 24, 1.0, 2.0, 0xf12, "metal", 0x4a484e);

  return out;
}

/** Glacierline — bergs + E–W melt channels, fords, no random mid slabs. */
export function buildGlacierlineArenaDecor(halfExtents: number): MapDecorDef[] {
  const H = halfExtents;
  const out: MapDecorDef[] = [];
  const northZ = H * 0.6;
  const southZ = -H * 0.6;
  const chanW = 22;

  pushMesaSpire(out, 88, 96, 7, 12);
  pushMesaSpire(out, -72, -88, 8, 14);

  const northChan = ewChannel(northZ, -H * 0.56, H * 0.5);
  const southChan = ewChannel(southZ, -H * 0.52, H * 0.48);
  pushWaterChannel(out, northChan, chanW, { wobble: 0.1 });
  pushWaterChannel(out, southChan, chanW);
  pushWaterBasin(out, -H * 0.28, northZ + 4, 26, 20, 0);
  pushWaterBasin(out, H * 0.32, southZ - 4, 24, 18, 0);

  pushChannelFords(out, northChan, chanW, [0.3, 0.62], { deckRun: 16, clearance: 12 });
  pushChannelFords(out, southChan, chanW, [0.35, 0.65], { deckRun: 15, clearance: 12 });

  pushKnoll(out, -32, 8, 9, 5, 22, "ice");
  pushKnoll(out, 34, -10, 9, 5, -18, "ice");

  pushCanyonRim(out, 0, H * 0.66, 56, 12, 4);
  pushCanyonRim(out, 0, -H * 0.66, 56, 12, -4);

  pushFoliageGrove(out, { x: -H * 0.68, z: H * 0.38 }, 16, 32, 0x901, ["pine", "scrub"]);
  pushFoliageGrove(out, { x: H * 0.65, z: -H * 0.36 }, 14, 30, 0x902, ["pine", "scrub"]);
  pushFoliageAnnulus(out, 0, 44, 12, 26, 10, 0x907, ["pine", "scrub"]);
  pushPassableSphereScatter(out, { x: -H * 0.36, z: northZ }, 14, 28, 0.85, 1.8, 0x905, "ice", 0xc8dce8);

  return out;
}

/** Mesa Badlands — twin E–W arroyos, perpendicular fords, knolls not random walls. */
export function buildMesaBadlandsArenaDecor(halfExtents: number): MapDecorDef[] {
  const H = halfExtents;
  const out: MapDecorDef[] = [];
  const northZ = H * 0.64;
  const southZ = -H * 0.76;
  const chanW = 24;

  pushMesaSpire(out, 26, 56, 6.5, 16);
  pushKnoll(out, -80, 10, 9, 9, 12);
  pushKnoll(out, 48, -105, 10, 10, -18);

  const northChan = ewChannel(northZ, -H * 0.58, H * 0.52);
  const southChan = ewChannel(southZ, -H * 0.54, H * 0.48);
  pushWaterChannel(out, northChan, chanW, { wobble: 0.12 });
  pushWaterChannel(out, southChan, chanW * 0.92, { wobble: 0.08 });
  pushWaterBasin(out, -H * 0.34, northZ + H * 0.06, 34, 26, 0);
  pushWaterBasin(out, H * 0.28, southZ - H * 0.04, 32, 24, 0);

  pushChannelFords(out, northChan, chanW, [0.25, 0.52, 0.78], { deckRun: 18, clearance: 14 });
  pushChannelFords(out, southChan, chanW * 0.92, [0.32, 0.68], { deckRun: 16, clearance: 12 });

  pushChokeRuinGate(out, 0, 0, 32, 10, 32);

  pushCanyonRim(out, 0, H * 0.68, 72, 14, 6);
  pushCanyonRim(out, 0, -H * 0.68, 72, 14, -6);

  pushFoliageGrove(out, { x: -H * 0.62, z: 0 }, 20, 38, 0x701, ["scrub", "bush", "tree", "palm"]);
  pushFoliageGrove(out, { x: H * 0.6, z: H * 0.18 }, 16, 34, 0x702, ["scrub", "bush"]);
  pushFoliageAlongPolyline(
    out,
    [
      { x: -H * 0.48, z: H * 0.26 },
      { x: H * 0.42, z: H * 0.24 },
    ],
    Math.max(16, H * 0.038),
    0x714,
    ["tree", "scrub", "bush"],
  );
  pushFoliageAnnulus(out, 26, 56, 12, 28, 18, 0x712, ["scrub", "bush", "tree"]);
  pushPassableSphereScatter(out, { x: -56, z: 38 }, 10, 18, 0.95, 2.0, 0x711, "hill", 0x6b5a48);

  return out;
}

/** Sphere — polar pools only; equator stays dry; fords span N–S over polar channels. */
export function buildSpherePlanetArenaDecor(halfExtents: number): MapDecorDef[] {
  const H = halfExtents;
  const out: MapDecorDef[] = [];
  const cap = H * 0.55;
  const northZ = cap * 0.5;
  const southZ = -cap * 0.48;
  const chanW = 14;

  const northChan: Vec2[] = [
    { x: -cap * 0.42, z: northZ },
    { x: cap * 0.4, z: northZ },
  ];
  const southChan: Vec2[] = [
    { x: -cap * 0.38, z: southZ },
    { x: cap * 0.36, z: southZ },
  ];
  pushWaterChannel(out, northChan, chanW);
  pushWaterChannel(out, southChan, chanW * 0.9);
  pushWaterBasin(out, 0, northZ + cap * 0.06, cap * 0.18, cap * 0.12, 0);
  pushWaterBasin(out, 0, southZ - cap * 0.05, cap * 0.16, cap * 0.1, 0);

  pushChannelFords(out, northChan, chanW, [0.5], { deckRun: 14, clearance: 10 });
  pushChannelFords(out, southChan, chanW * 0.9, [0.5], { deckRun: 12, clearance: 10 });

  pushFoliageGrove(out, { x: -cap * 0.55, z: 0 }, 10, cap * 0.2, 0x501, ["scrub", "bush"]);
  pushFoliageGrove(out, { x: cap * 0.5, z: 0 }, 9, cap * 0.18, 0x502, ["scrub"]);

  return out;
}

const RUNTIME_DECOR_BUILDERS: Record<string, (half: number) => MapDecorDef[]> = {
  the_line: buildTheLineArenaDecor,
  forgewarden: buildForgewardenArenaDecor,
  glacierline: buildGlacierlineArenaDecor,
  mesa_badlands: buildMesaBadlandsArenaDecor,
  sphere_planet: buildSpherePlanetArenaDecor,
};

export function arenaDecorForMap(mapId: string, halfExtents: number): MapDecorDef[] | null {
  const fn = RUNTIME_DECOR_BUILDERS[mapId];
  return fn ? fn(halfExtents) : null;
}
