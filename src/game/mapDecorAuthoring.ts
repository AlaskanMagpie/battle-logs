import type { MapDecorDef, MapFoliageStyle, MapTerrainKind, Vec2 } from "./types";

const WATER = 0x1a4a62;

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function samplePolyline(points: Vec2[], t01: number): { pos: Vec2; tangent: Vec2 } {
  if (points.length === 0) return { pos: { x: 0, z: 0 }, tangent: { x: 1, z: 0 } };
  if (points.length === 1) return { pos: points[0]!, tangent: { x: 1, z: 0 } };
  const segLens: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    segLens.push(len);
    total += len;
  }
  const target = Math.max(0, Math.min(1, t01)) * (total || 1);
  let acc = 0;
  for (let i = 0; i < segLens.length; i++) {
    const len = segLens[i]!;
    if (acc + len >= target || i === segLens.length - 1) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const u = len < 1e-6 ? 0 : (target - acc) / len;
      return {
        pos: { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u },
        tangent: { x: b.x - a.x, z: b.z - a.z },
      };
    }
    acc += len;
  }
  const last = points[points.length - 1]!;
  const prev = points[points.length - 2]!;
  return { pos: last, tangent: { x: last.x - prev.x, z: last.z - prev.z } };
}

export function pushWaterBasin(
  out: MapDecorDef[],
  x: number,
  z: number,
  radiusX: number,
  radiusZ: number,
  rotYDeg = 0,
): void {
  out.push({
    kind: "water_basin",
    x,
    z,
    radiusX,
    radiusZ,
    rotYDeg,
    h: 0.38,
    blocksMovement: true,
    color: WATER,
    terrainKind: "lake",
  });
}

/**
 * Water along a polyline. Basins are elongated along the channel tangent (flow direction),
 * not across it — so crossings can be perpendicular.
 */
export function pushWaterChannel(
  out: MapDecorDef[],
  points: Vec2[],
  width: number,
  opts?: { wobble?: number; depthScale?: number },
): void {
  if (points.length < 2) return;
  const wobble = opts?.wobble ?? 0.1;
  const depthScale = opts?.depthScale ?? 1;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const steps = Math.max(2, Math.ceil(len / (width * 0.65)));
    const flowDeg = (Math.atan2(dx, dz) * 180) / Math.PI;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = a.x + dx * t + (s % 2 === 0 ? 1 : -1) * wobble * width * 0.12;
      const pz = a.z + dz * t;
      const along = 0.88 + 0.2 * Math.sin(t * Math.PI);
      const halfW = width * 0.5 * along * depthScale;
      pushWaterBasin(out, px, pz, halfW * 1.15, halfW * 0.92, flowDeg);
    }
  }
}

export function pushBridge(
  out: MapDecorDef[],
  x: number,
  z: number,
  span: number,
  width: number,
  rotYDeg = 0,
): void {
  out.push({
    kind: "bridge",
    x,
    z,
    span,
    width,
    rotYDeg,
    h: 2.8,
    blocksMovement: false,
    color: 0x5a4030,
    terrainKind: "bridge",
  });
}

/**
 * Deck spans **across** the channel (perpendicular to flow), not along it.
 * `span` = length over water; `width` = deck depth along the road.
 */
export function pushBridgeAcrossChannel(
  out: MapDecorDef[],
  channel: Vec2[],
  t01: number,
  channelWidth: number,
  opts?: { deckRun?: number; clearance?: number },
): void {
  const { pos, tangent } = samplePolyline(channel, t01);
  const len = Math.hypot(tangent.x, tangent.z) || 1;
  const nx = -tangent.z / len;
  const nz = tangent.x / len;
  const span = channelWidth + (opts?.clearance ?? 14);
  const deckRun = opts?.deckRun ?? 20;
  const rotDeg = (Math.atan2(-nx, nz) * 180) / Math.PI;
  pushBridge(out, pos.x, pos.z, span, deckRun, rotDeg);
}

/** Multiple ford crossings at arc-length fractions along the channel. */
export function pushChannelFords(
  out: MapDecorDef[],
  channel: Vec2[],
  channelWidth: number,
  crossingT01: number[],
  opts?: { deckRun?: number; clearance?: number },
): void {
  for (const t of crossingT01) {
    pushBridgeAcrossChannel(out, channel, t, channelWidth, opts);
  }
}

/** Dry crossing: bridge between two bank points (must be on opposite sides of water, not along it). */
export function pushBridgeBetweenBanks(
  out: MapDecorDef[],
  bankA: Vec2,
  bankB: Vec2,
  deckRun: number,
): void {
  const dx = bankB.x - bankA.x;
  const dz = bankB.z - bankA.z;
  const span = Math.hypot(dx, dz);
  if (span < 10) return;
  const rotDeg = (Math.atan2(-dx, dz) * 180) / Math.PI;
  pushBridge(out, (bankA.x + bankB.x) * 0.5, (bankA.z + bankB.z) * 0.5, span + 6, deckRun, rotDeg);
}

export function pushFoliage(
  out: MapDecorDef[],
  x: number,
  z: number,
  radius: number,
  style: MapFoliageStyle,
  rotYDeg = 0,
): void {
  out.push({
    kind: "foliage",
    x,
    z,
    radius,
    style,
    rotYDeg,
    blocksMovement: false,
    terrainKind: "foliage",
  });
}

export function pushFoliageGrove(
  out: MapDecorDef[],
  center: Vec2,
  count: number,
  spread: number,
  seed: number,
  styles: MapFoliageStyle[] = ["bush", "tree", "scrub"],
): void {
  const rnd = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const d = spread * (0.25 + rnd() * 0.75);
    const style = styles[Math.floor(rnd() * styles.length)] ?? "bush";
    const r = 2.2 + rnd() * (style === "tree" || style === "pine" ? 4.8 : 3.2);
    pushFoliage(out, center.x + Math.cos(a) * d, center.z + Math.sin(a) * d, r, style, rnd() * 40 - 20);
  }
}

export function pushFoliageAnnulus(
  out: MapDecorDef[],
  cx: number,
  cz: number,
  innerR: number,
  outerR: number,
  count: number,
  seed: number,
  styles: MapFoliageStyle[] = ["bush", "scrub"],
): void {
  if (outerR <= innerR || count <= 0) return;
  const rnd = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const rad = innerR + rnd() * (outerR - innerR);
    const style = styles[Math.floor(rnd() * styles.length)] ?? "scrub";
    const r = 1.5 + rnd() * (style === "tree" || style === "pine" ? 4.2 : 2.9);
    pushFoliage(out, cx + Math.cos(a) * rad, cz + Math.sin(a) * rad, r, style, rnd() * 40 - 20);
  }
}

export function pushFoliageAlongPolyline(
  out: MapDecorDef[],
  points: Vec2[],
  stepWorld: number,
  seed: number,
  styles: MapFoliageStyle[] = ["scrub", "bush", "tree"],
): void {
  if (points.length < 2 || stepWorld < 4) return;
  const rnd = mulberry32(seed);
  let pick = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const steps = Math.max(1, Math.floor(len / stepWorld));
    for (let s = 0; s <= steps; s++) {
      const t = steps === 0 ? 0 : s / steps;
      const jx = (rnd() - 0.5) * stepWorld * 0.38;
      const jz = (rnd() - 0.5) * stepWorld * 0.38;
      const style = styles[pick % styles.length] ?? "scrub";
      pick++;
      const r = 1.5 + rnd() * (style === "tree" || style === "pine" ? 3.6 : 2.5);
      pushFoliage(out, a.x + dx * t + jx, a.z + dz * t + jz, r, style, rnd() * 50 - 25);
    }
  }
}

export function pushPassableSphereScatter(
  out: MapDecorDef[],
  center: Vec2,
  count: number,
  spread: number,
  radiusLo: number,
  radiusHi: number,
  seed: number,
  terrainKind: MapTerrainKind,
  color: number,
): void {
  if (count <= 0 || spread < 0.5) return;
  const rnd = mulberry32(seed);
  const lo = Math.min(radiusLo, radiusHi);
  const hi = Math.max(radiusLo, radiusHi);
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const d = spread * (0.15 + rnd() * 0.85);
    const r = lo + rnd() * Math.max(0.05, hi - lo);
    out.push({
      kind: "sphere",
      x: center.x + Math.cos(a) * d,
      z: center.z + Math.sin(a) * d,
      radius: r,
      y: r * 0.95,
      blocksMovement: false,
      color,
      terrainKind,
    });
  }
}

/** Organic blocking hill (cone). */
export function pushKnoll(
  out: MapDecorDef[],
  x: number,
  z: number,
  radius: number,
  height: number,
  rotYDeg = 0,
  tk: MapTerrainKind = "hill",
): void {
  out.push({
    kind: "cone",
    x,
    z,
    radius,
    h: height,
    rotYDeg,
    blocksMovement: true,
    color: 0x6b5a46,
    terrainKind: tk,
  });
}

/** Tall mesa / spire — reads as natural pillar, not a random cube. */
export function pushMesaSpire(
  out: MapDecorDef[],
  x: number,
  z: number,
  radius: number,
  height: number,
): void {
  out.push({
    kind: "cylinder",
    x,
    z,
    radius,
    h: height,
    blocksMovement: true,
    color: 0x6b5548,
    terrainKind: "mesa_slab",
  });
}

/**
 * Two angled ruin teeth with a deliberate gap — choke, not a random wall slab.
 */
export function pushChokeRuinGate(
  out: MapDecorDef[],
  x: number,
  z: number,
  gapWidth: number,
  depth: number,
  rotYDeg: number,
): void {
  const half = gapWidth * 0.5 + depth * 0.45;
  for (const side of [-1, 1]) {
    out.push({
      kind: "box",
      x: x + side * half * Math.sin((rotYDeg * Math.PI) / 180),
      z: z + side * half * Math.cos((rotYDeg * Math.PI) / 180),
      w: depth,
      h: 5 + depth * 0.08,
      d: depth * 0.85,
      rotYDeg: rotYDeg + side * 14,
      blocksMovement: true,
      color: 0x5e4a3a,
      terrainKind: "ruins",
    });
  }
}

/** Map-edge canyon lip — long low mesa wall (only at arena rim, not mid-map clutter). */
export function pushCanyonRim(
  out: MapDecorDef[],
  x: number,
  z: number,
  length: number,
  height: number,
  rotYDeg: number,
): void {
  out.push({
    kind: "box",
    x,
    z,
    w: length,
    h: height,
    d: Math.max(8, length * 0.08),
    rotYDeg,
    blocksMovement: true,
    color: 0x4d4038,
    terrainKind: "mesa_slab",
  });
}
