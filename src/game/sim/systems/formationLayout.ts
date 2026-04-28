import { UNIT_FORMATION_SPACING } from "../../constants";
import type { UnitFormationKind, UnitSizeClass, Vec2 } from "../../types";
import { unitSeparationRadiusXZ } from "./helpers";

export interface FormationLayoutUnit {
  id: number;
  x: number;
  z: number;
  sizeClass: UnitSizeClass;
  range: number;
  flying?: boolean;
}

export interface FormationLayoutSpec {
  from: Vec2;
  to: Vec2;
  kind: UnitFormationKind;
  depthScale?: number;
}

export interface FormationSlot {
  id: number;
  x: number;
  z: number;
}

const FORMATION_KINDS: UnitFormationKind[] = ["line", "wedge", "arc"];

export function nextFormationKind(kind: UnitFormationKind): UnitFormationKind {
  const idx = FORMATION_KINDS.indexOf(kind);
  return FORMATION_KINDS[(idx + 1) % FORMATION_KINDS.length] ?? "line";
}

export function formationKindLabel(kind: UnitFormationKind): string {
  switch (kind) {
    case "line":
      return "Line";
    case "wedge":
      return "Wedge";
    case "arc":
      return "Arc";
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function unitSpacing(u: FormationLayoutUnit): number {
  return Math.max(UNIT_FORMATION_SPACING * 0.62, unitSeparationRadiusXZ(u.sizeClass, u.flying) * 2.1);
}

function orderedUnits(units: FormationLayoutUnit[]): FormationLayoutUnit[] {
  return [...units].sort((a, b) => {
    const range = a.range - b.range;
    if (Math.abs(range) > 0.001) return range;
    return a.id - b.id;
  });
}

function basis(units: FormationLayoutUnit[], spec: FormationLayoutSpec): {
  cx: number;
  cz: number;
  lx: number;
  lz: number;
  bx: number;
  bz: number;
  len: number;
} {
  const cx = (spec.from.x + spec.to.x) * 0.5;
  const cz = (spec.from.z + spec.to.z) * 0.5;
  let lx = spec.to.x - spec.from.x;
  let lz = spec.to.z - spec.from.z;
  let len = Math.hypot(lx, lz);
  if (len < 0.1) {
    lx = 1;
    lz = 0;
    len = 0;
  } else {
    lx /= len;
    lz /= len;
  }
  let bx = -lz;
  let bz = lx;
  if (units.length > 0) {
    const ux = units.reduce((n, u) => n + u.x, 0) / units.length;
    const uz = units.reduce((n, u) => n + u.z, 0) / units.length;
    if ((ux - cx) * bx + (uz - cz) * bz < 0) {
      bx = -bx;
      bz = -bz;
    }
  }
  return { cx, cz, lx, lz, bx, bz, len };
}

function clampToMap(p: Vec2, halfExtents: number): Vec2 {
  const pad = 2;
  return {
    x: clamp(p.x, -halfExtents + pad, halfExtents - pad),
    z: clamp(p.z, -halfExtents + pad, halfExtents - pad),
  };
}

export function computeFormationSlots(
  units: FormationLayoutUnit[],
  spec: FormationLayoutSpec,
  halfExtents: number,
): FormationSlot[] {
  if (units.length === 0) return [];
  const ordered = orderedUnits(units);
  const { cx, cz, lx, lz, bx, bz, len } = basis(ordered, spec);
  const avgSpacing = ordered.reduce((sum, u) => sum + unitSpacing(u), 0) / ordered.length;
  const spacing = avgSpacing * Math.max(0.75, Math.min(2.2, spec.depthScale ?? 1));
  const cols =
    spec.kind === "wedge"
      ? 1
      : Math.max(1, Math.min(ordered.length, Math.max(1, Math.floor(Math.max(len, spacing) / spacing) + 1)));
  const out: FormationSlot[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const u = ordered[i]!;
    let lateral = 0;
    let back = 0;

    if (spec.kind === "wedge") {
      if (i === 0) {
        lateral = 0;
        back = 0;
      } else {
        const rank = Math.ceil(i / 2);
        const side = i % 2 === 1 ? -1 : 1;
        lateral = side * rank * spacing * 0.58;
        back = rank * spacing * 0.88;
      }
    } else {
      const row = Math.floor(i / cols);
      const col = i % cols;
      lateral = (col - (Math.min(cols, ordered.length - row * cols) - 1) * 0.5) * spacing;
      back = row * spacing * 0.92;
      if (spec.kind === "arc") {
        back += Math.abs(lateral) * 0.2;
      }
    }

    const p = clampToMap(
      {
        x: cx + lx * lateral + bx * back,
        z: cz + lz * lateral + bz * back,
      },
      halfExtents,
    );
    out.push({ id: u.id, x: p.x, z: p.z });
  }

  return out;
}
