import type { MapData, MapDecorDef, Vec2 } from "./types";

const EPS = 0.04;
const RESOLVE_PASSES = 8;

/** Axis-aligned disc obstacle (cylinder / cone / sphere footprint on XZ). */
type DiscObs = { cx: number; cz: number; r: number };
/** OBB in XZ: center, half-extents along local X/Z, rotation θ (CCW) matching `lx = dx·cos + dz·sin`, `lz = −dx·sin + dz·cos`. */
type BoxObs = { cx: number; cz: number; hx: number; hz: number; c: number; s: number };

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

function obstacleSets(map: MapData): { discs: DiscObs[]; boxes: BoxObs[] } {
  return collectFromDecor(map.decor);
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
export function resolveCircleAgainstMapObstacles(map: MapData, pos: Vec2, agentR: number): void {
  const { discs, boxes } = obstacleSets(map);
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
export function circleOverlapsMapObstacles(map: MapData, pos: Vec2, agentR: number): boolean {
  const { discs, boxes } = obstacleSets(map);
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
