import { insidePlaneArena, sphereTangentCapRadius } from "./arenaFootprint";
import { circleOverlapsMapObstacles } from "./mapObstacles";
import { isSphereWorld } from "./surface";
import type { MapData, TapSlotDef, Vec2 } from "./types";

const TAP_MIN = 6;
const TAP_MAX = 16;
const TAP_PAIR_SEP = 26;
const TAP_PAIR_SEP2 = TAP_PAIR_SEP * TAP_PAIR_SEP;
const TAP_CLEAR_R = 14.5;
const SIDE_MARGIN = 18;

export interface MapValidationIssue {
  level: "error" | "warn";
  message: string;
}

export function validateMapLayout(map: MapData): MapValidationIssue[] {
  const issues: MapValidationIssue[] = [];
  const half = map.world.halfExtents;
  if (!Number.isFinite(half) || half < 40) {
    issues.push({ level: "error", message: "world.halfExtents must be a number >= 40" });
    return issues;
  }

  const inArena = (p: Vec2): boolean => {
    if (isSphereWorld(map)) {
      const cap = sphereTangentCapRadius(map);
      return p.x * p.x + p.z * p.z <= cap * cap + 1e-6;
    }
    return insidePlaneArena(map, p);
  };

  const checkPt = (label: string, p: Vec2): void => {
    if (!inArena(p)) issues.push({ level: "error", message: `${label} outside arena footprint` });
    if (Math.abs(p.x) > half + 1e-3 || Math.abs(p.z) > half + 1e-3) {
      issues.push({ level: "warn", message: `${label} outside outer halfExtents box` });
    }
  };

  checkPt("playerStart", map.playerStart);
  if (map.enemyStart) checkPt("enemyStart", map.enemyStart);

  for (const r of map.playerRelaySlots) checkPt(`playerRelay ${r.id}`, r);
  for (const r of map.enemyRelaySlots) checkPt(`enemyRelay ${r.id}`, r);
  for (const c of map.enemyCamps) checkPt(`enemyCamp ${c.id}`, c.origin);

  if (map.useAuthorTapSlots && map.tapSlots.length > 0) {
    const n = map.tapSlots.length;
    if (n < TAP_MIN || n > TAP_MAX) {
      issues.push({
        level: "warn",
        message: `Author tap count ${n} is outside recommended range ${TAP_MIN}–${TAP_MAX}`,
      });
    }
    const playerTaps = map.tapSlots.filter((t) => t.x < -SIDE_MARGIN);
    const enemyTaps = map.tapSlots.filter((t) => t.x > SIDE_MARGIN);
    if (playerTaps.length === 0 || enemyTaps.length === 0) {
      issues.push({
        level: "error",
        message: "Author taps should include nodes on both sides (player x < -margin, enemy x > margin)",
      });
    }
    for (const t of map.tapSlots) {
      checkPt(`tap ${t.id}`, t);
      if (circleOverlapsMapObstacles(map, { x: t.x, z: t.z }, TAP_CLEAR_R)) {
        issues.push({ level: "error", message: `tap ${t.id} overlaps blocking decor` });
      }
    }
    for (let i = 0; i < map.tapSlots.length; i++) {
      for (let j = i + 1; j < map.tapSlots.length; j++) {
        const a = map.tapSlots[i]!;
        const b = map.tapSlots[j]!;
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        if (dx * dx + dz * dz < TAP_PAIR_SEP2) {
          issues.push({ level: "warn", message: `taps ${a.id} and ${b.id} are closer than ${TAP_PAIR_SEP}u` });
        }
      }
    }
    assertMirroredFairness(map.tapSlots, issues);
  }

  return issues;
}

/** Soft symmetry: for each player-side tap near mirrored z, expect an enemy-side partner. */
function assertMirroredFairness(slots: TapSlotDef[], issues: MapValidationIssue[]): void {
  const player = slots.filter((s) => s.x < 0);
  const enemy = slots.filter((s) => s.x > 0);
  if (player.length === 0 || enemy.length === 0) return;
  const tol = 22;
  for (const p of player) {
    let best: TapSlotDef | null = null;
    let bestD = Infinity;
    for (const e of enemy) {
      const dx = -p.x - e.x;
      const dz = p.z - e.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (best && bestD > tol * tol) {
      issues.push({
        level: "warn",
        message: `Tap ${p.id} has no close mirrored enemy counterpart (|Δ|>${tol})`,
      });
    }
  }
}
