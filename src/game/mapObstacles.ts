import type { MapData, MapDecorDef, Vec2 } from "./types";

const EPS = 0.055;
const RESOLVE_PASSES = 8;

/** Axis-aligned disc obstacle (cylinder / cone / sphere footprint on XZ). */
type DiscObs = { cx: number; cz: number; r: number };
/** OBB in XZ: center, half-extents along local X/Z, rotation θ (CCW) matching `lx = dx·cos + dz·sin`, `lz = −dx·sin + dz·cos`. */
type BoxObs = { cx: number; cz: number; hx: number; hz: number; c: number; s: number };

export type MapObstacleFootprint =
  | { kind: "disc"; cx: number; cz: number; r: number }
  | { kind: "box"; cx: number; cz: number; hx: number; hz: number; c: number; s: number };

function collectFromDecor(decor: MapDecorDef[] | undefined): { discs: DiscObs[]; boxes: BoxObs[] } {
  const discs: DiscObs[] = [];
  const boxes: BoxObs[] = [];
  if (!decor) return { discs, boxes };
  for (const d of decor) {
    if (!d.blocksMovement) continue;
    const th = ((((d as { rotYDeg?: number }).rotYDeg ?? 0) * Math.PI) / 180) as number;
    const c = Math.cos(th);
    const s = Math.sin(th);
    if (d.kind === "box") {
      boxes.push({ cx: d.x, cz: d.z, hx: d.w * 0.5, hz: d.d * 0.5, c, s });
    } else if (d.kind === "cylinder") {
      discs.push({ cx: d.x, cz: d.z, r: d.radius });
    } else if (d.kind === "sphere") {
      discs.push({ cx: d.x, cz: d.z, r: d.radius });
    } else if (d.kind === "cone") {
      discs.push({ cx: d.x, cz: d.z, r: d.radius });
    } else if (d.kind === "torus") {
      discs.push({ cx: d.x, cz: d.z, r: d.radius + d.tube });
    }
  }
  return { discs, boxes };
}

function obstacleSets(map: MapData, extra: MapObstacleFootprint[] = []): { discs: DiscObs[]; boxes: BoxObs[] } {
  const sets = collectFromDecor(map.decor);
  for (const fp of extra) {
    if (fp.kind === "disc") sets.discs.push(fp);
    else sets.boxes.push(fp);
  }
  return sets;
}

export function mapObstacleFootprints(map: MapData, extra: MapObstacleFootprint[] = []): MapObstacleFootprint[] {
  const { discs, boxes } = obstacleSets(map, extra);
  return [
    ...discs.map((d) => ({ kind: "disc" as const, ...d })),
    ...boxes.map((b) => ({ kind: "box" as const, ...b })),
  ];
}

function worldFromLocal(box: BoxObs, lx: number, lz: number): Vec2 {
  return {
    x: box.cx + lx * box.c - lz * box.s,
    z: box.cz + lx * box.s + lz * box.c,
  };
}

/** Local coords: lx = dx·cos + dz·sin, lz = −dx·sin + dz·cos. */
function toLocal(box: BoxObs, px: number, pz: number): { lx: number; lz: number } {
  const dx = px - box.cx;
  const dz = pz - box.cz;
  return { lx: dx * box.c + dz * box.s, lz: -dx * box.s + dz * box.c };
}

function closestOnBox(box: BoxObs, px: number, pz: number): Vec2 {
  const { lx, lz } = toLocal(box, px, pz);
  const clx = Math.max(-box.hx, Math.min(box.hx, lx));
  const clz = Math.max(-box.hz, Math.min(box.hz, lz));
  return worldFromLocal(box, clx, clz);
}

function pushFromDisc(px: number, pz: number, o: DiscObs, agentR: number, out: Vec2): void {
  const dx = px - o.cx;
  const dz = pz - o.cz;
  const d = Math.hypot(dx, dz) || 1e-6;
  const need = o.r + agentR + EPS;
  if (d >= need) return;
  const nx = dx / d;
  const nz = dz / d;
  out.x = o.cx + nx * need;
  out.z = o.cz + nz * need;
}

function pushFromBox(px: number, pz: number, box: BoxObs, agentR: number, out: Vec2): void {
  const q = closestOnBox(box, px, pz);
  const dx = px - q.x;
  const dz = pz - q.z;
  const d = Math.hypot(dx, dz);
  if (d >= agentR + EPS) return;
  if (d < 1e-5) {
    const { lx, lz } = toLocal(box, px, pz);
    const sx = lx >= 0 ? 1 : -1;
    const sz = lz >= 0 ? 1 : -1;
    const nx = sx * box.c - sz * box.s;
    const nz = sx * box.s + sz * box.c;
    const len = Math.hypot(nx, nz) || 1;
    out.x = q.x + (nx / len) * (agentR + EPS);
    out.z = q.z + (nz / len) * (agentR + EPS);
    return;
  }
  const nx = dx / d;
  const nz = dz / d;
  out.x = q.x + nx * (agentR + EPS);
  out.z = q.z + nz * (agentR + EPS);
}

/**
 * After moving in XZ, slide `pos` out of any `blocksMovement` decor so a circle of radius `agentR`
 * stays outside solid obstacles.
 */
export function resolveCircleAgainstMapObstacles(
  map: MapData,
  pos: Vec2,
  agentR: number,
  extra: MapObstacleFootprint[] = [],
): void {
  const { discs, boxes } = obstacleSets(map, extra);
  if (discs.length === 0 && boxes.length === 0) return;
  for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
    let moved = false;
    for (const o of discs) {
      const dx = pos.x - o.cx;
      const dz = pos.z - o.cz;
      if (dx * dx + dz * dz < (o.r + agentR + EPS) * (o.r + agentR + EPS)) {
        pushFromDisc(pos.x, pos.z, o, agentR, pos);
        moved = true;
      }
    }
    for (const b of boxes) {
      const q = closestOnBox(b, pos.x, pos.z);
      const dx = pos.x - q.x;
      const dz = pos.z - q.z;
      if (dx * dx + dz * dz < (agentR + EPS) * (agentR + EPS)) {
        pushFromBox(pos.x, pos.z, b, agentR, pos);
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/** True if a circle at `pos` with radius `agentR` intersects any blocking decor. */
export function circleOverlapsMapObstacles(
  map: MapData,
  pos: Vec2,
  agentR: number,
  extra: MapObstacleFootprint[] = [],
): boolean {
  return circleOverlapsSets(obstacleSets(map, extra), pos, agentR);
}

function circleOverlapsSets(
  { discs, boxes }: { discs: DiscObs[]; boxes: BoxObs[] },
  pos: Vec2,
  agentR: number,
): boolean {
  for (const o of discs) {
    const dx = pos.x - o.cx;
    const dz = pos.z - o.cz;
    if (dx * dx + dz * dz < (o.r + agentR) * (o.r + agentR)) return true;
  }
  for (const b of boxes) {
    const q = closestOnBox(b, pos.x, pos.z);
    const dx = pos.x - q.x;
    const dz = pos.z - q.z;
    if (dx * dx + dz * dz < agentR * agentR) return true;
  }
  return false;
}

function segmentDist2ToPoint(a: Vec2, b: Vec2, p: Vec2): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const wx = p.x - a.x;
  const wz = p.z - a.z;
  const vv = vx * vx + vz * vz || 1;
  const t = Math.max(0, Math.min(1, (wx * vx + wz * vz) / vv));
  const x = a.x + vx * t;
  const z = a.z + vz * t;
  const dx = p.x - x;
  const dz = p.z - z;
  return dx * dx + dz * dz;
}

function segmentHitsBox(a: Vec2, b: Vec2, box: BoxObs, pad: number): boolean {
  const la = toLocal(box, a.x, a.z);
  const lb = toLocal(box, b.x, b.z);
  let t0 = 0;
  let t1 = 1;
  const dx = lb.lx - la.lx;
  const dz = lb.lz - la.lz;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-8) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  const hx = box.hx + pad;
  const hz = box.hz + pad;
  return clip(-dx, la.lx + hx) && clip(dx, hx - la.lx) && clip(-dz, la.lz + hz) && clip(dz, hz - la.lz);
}

function segmentHitsObstacleSets(
  { discs, boxes }: { discs: DiscObs[]; boxes: BoxObs[] },
  from: Vec2,
  to: Vec2,
  agentR: number,
): boolean {
  for (const d of discs) {
    if (segmentDist2ToPoint(from, to, { x: d.cx, z: d.cz }) <= (d.r + agentR) * (d.r + agentR)) return true;
  }
  for (const b of boxes) {
    if (segmentHitsBox(from, to, b, agentR)) return true;
  }
  return false;
}

function clampWorld(map: MapData, p: Vec2, agentR = 0): Vec2 {
  const h = Math.max(0, map.world.halfExtents - agentR);
  return { x: Math.max(-h, Math.min(h, p.x)), z: Math.max(-h, Math.min(h, p.z)) };
}

function detourCandidates(o: MapObstacleFootprint, pad: number): Vec2[] {
  if (o.kind === "disc") {
    const r = o.r + pad;
    const count = Math.max(8, Math.ceil(Math.PI / Math.acos(Math.min(0.999, (o.r + pad - 2) / r))));
    return Array.from({ length: count }, (_, i) => ({
      x: o.cx + r * Math.cos((i * Math.PI * 2) / count),
      z: o.cz + r * Math.sin((i * Math.PI * 2) / count),
    }));
  }
  const hx = o.hx + pad;
  const hz = o.hz + pad;
  const corners = [
    { lx: hx, lz: hz },
    { lx: hx, lz: -hz },
    { lx: -hx, lz: hz },
    { lx: -hx, lz: -hz },
  ];
  return corners.map((c) => worldFromLocal(o, c.lx, c.lz));
}

/**
 * Small, deterministic local planner for wall maps. It returns one or more corner detours
 * when the direct segment intersects blocking decor; callers still resolve each step.
 */
export function planPathAroundMapObstacles(
  map: MapData,
  from: Vec2,
  to: Vec2,
  agentR: number,
  extra: MapObstacleFootprint[] = [],
): Vec2[] {
  return planChainedPathAroundMapObstacles(map, from, to, agentR, extra);
}

/** True if the open segment `a`→`b` intersects expanded blocking decor for an agent of radius `agentR`. */
export function segmentHitsMapObstacles(
  map: MapData,
  a: Vec2,
  b: Vec2,
  agentR: number,
  extra: MapObstacleFootprint[] = [],
): boolean {
  return segmentHitsObstacleSets(obstacleSets(map, extra), a, b, agentR);
}

/**
 * Shortest safe polyline through obstacle corners/ring points. An empty path means the
 * destination is unreachable; callers must hold rather than step directly into a wall.
 */
export function planChainedPathAroundMapObstacles(
  map: MapData,
  from: Vec2,
  to: Vec2,
  agentR: number,
  extra: MapObstacleFootprint[] = [],
): Vec2[] {
  const goal = clampWorld(map, to, agentR);
  if (Math.hypot(goal.x - from.x, goal.z - from.z) <= 0.35) return [];
  const staticSets = obstacleSets(map);
  const allSets = obstacleSets(map, extra);
  const playableHalf = map.world.halfExtents - agentR;
  // A wall sealed against both map edges divides the arena; no visibility
  // search can cross it. This also keeps impossible squad orders cheap.
  for (const b of allSets.boxes) {
    if (Math.abs(b.s) < 1e-6 && b.cz - b.hz <= -playableHalf && b.cz + b.hz >= playableHalf &&
        (from.x < b.cx - b.hx - agentR && goal.x > b.cx + b.hx + agentR ||
         goal.x < b.cx - b.hx - agentR && from.x > b.cx + b.hx + agentR)) return [];
    if (Math.abs(b.s) < 1e-6 && b.cx - b.hx <= -playableHalf && b.cx + b.hx >= playableHalf &&
        (from.z < b.cz - b.hz - agentR && goal.z > b.cz + b.hz + agentR ||
         goal.z < b.cz - b.hz - agentR && from.z > b.cz + b.hz + agentR)) return [];
  }
  // Built structures are solid, but their centers are attack targets. Route to
  // the accessible rim; authored scenery, by contrast, is an invalid destination.
  if (circleOverlapsSets(staticSets, goal, agentR)) return [];
  const hitExtra = extra.filter((o) => circleOverlapsSets(
    o.kind === "disc" ? { discs: [o], boxes: [] } : { discs: [], boxes: [o] }, goal, agentR,
  ));
  const terminalPoints = hitExtra.length
    ? hitExtra.flatMap((o) => detourCandidates(o, agentR + 0.35)).filter((p) =>
        Math.abs(p.x) <= map.world.halfExtents - agentR &&
        Math.abs(p.z) <= map.world.halfExtents - agentR &&
        !circleOverlapsSets(allSets, p, agentR))
    : [goal];
  if (!terminalPoints.length) return [];
  if (hitExtra.length === 0 && !segmentHitsObstacleSets(allSets, from, goal, agentR)) return [goal];

  const pad = Math.max(agentR + 3.2, 6);
  const points: Vec2[] = [from, ...terminalPoints];
  const terminals = new Set(terminalPoints.map((_, i) => i + 1));
  for (const obstacle of [...allSets.discs.map((d) => ({ kind: "disc" as const, ...d })),
    ...allSets.boxes.map((b) => ({ kind: "box" as const, ...b }))]) {
    for (const p of detourCandidates(obstacle, pad)) {
      const h = map.world.halfExtents - agentR;
      if (Math.abs(p.x) > h || Math.abs(p.z) > h) continue;
      if (!circleOverlapsSets(allSets, p, agentR)) points.push(p);
    }
  }
  // Dijkstra on visible edges. Evaluate edges lazily so clear, short routes do not
  // spend time checking the full graph; all emitted legs have collision clearance.
  const cost = Array<number>(points.length).fill(Infinity);
  const previous = Array<number>(points.length).fill(-1);
  const visited = new Set<number>();
  cost[0] = 0;
  for (let pass = 0; pass < points.length; pass++) {
    let current = -1;
    for (let i = 0; i < points.length; i++) {
      if (!visited.has(i) && (current < 0 || cost[i]! < cost[current]!)) current = i;
    }
    if (current < 0 || !Number.isFinite(cost[current])) break;
    if (terminals.has(current)) {
      const route: Vec2[] = [];
      for (let at = current; at !== 0; at = previous[at]!) route.push(points[at]!);
      return route.reverse();
    }
    visited.add(current);
    for (let next = 1; next < points.length; next++) {
      if (next === current || visited.has(next)) continue;
      const a = points[current]!;
      const b = points[next]!;
      const candidate = cost[current]! + Math.hypot(a.x - b.x, a.z - b.z);
      if (candidate >= cost[next]!) continue;
      if (segmentHitsObstacleSets(allSets, a, b, agentR)) continue;
      cost[next] = candidate;
      previous[next] = current;
    }
  }
  return [];
}
