/**
 * Parametric building footprints + polygon utilities, ported from buildin-s.
 * Footprints are centered on the origin and expressed as [x, z] points.
 */
import * as THREE from "three";
import { TAU } from "./rng";

export type Pt = [number, number];
export type Poly = Pt[];

export interface Edge {
  a: Pt;
  b: Pt;
  len: number;
  nx: number;
  nz: number;
  mx: number;
  mz: number;
}

export interface Prepped {
  points: Poly;
  edges: Edge[];
  centroid: Pt;
}

export type FootKey = "rect" | "L" | "U" | "T" | "plus" | "round" | "hex" | "octagon";

export const FOOT: Record<FootKey, (W: number, D: number) => Poly> = {
  rect: (W, D) => {
    const x = W / 2,
      z = D / 2;
    return [
      [-x, -z],
      [x, -z],
      [x, z],
      [-x, z],
    ];
  },
  L: (W, D) => {
    const X = W / 2,
      Z = D / 2,
      mx = -X + W * 0.52,
      my = -Z + D * 0.52;
    return [
      [-X, -Z],
      [X, -Z],
      [X, my],
      [mx, my],
      [mx, Z],
      [-X, Z],
    ];
  },
  U: (W, D) => {
    const X = W / 2,
      Z = D / 2,
      t = W * 0.32,
      b = D * 0.42;
    return [
      [-X, -Z],
      [X, -Z],
      [X, Z],
      [X - t, Z],
      [X - t, -Z + b],
      [-X + t, -Z + b],
      [-X + t, Z],
      [-X, Z],
    ];
  },
  T: (W, D) => {
    const X = W / 2,
      Z = D / 2,
      s = W * 0.22,
      tb = Z - D * 0.42;
    return [
      [-s, -Z],
      [s, -Z],
      [s, tb],
      [X, tb],
      [X, Z],
      [-X, Z],
      [-X, tb],
      [-s, tb],
    ];
  },
  plus: (W, D) => {
    const a = W * 0.22,
      b = D * 0.22,
      X = W / 2,
      Z = D / 2;
    return [
      [-a, -Z],
      [a, -Z],
      [a, -b],
      [X, -b],
      [X, b],
      [a, b],
      [a, Z],
      [-a, Z],
      [-a, b],
      [-X, b],
      [-X, -b],
      [-a, -b],
    ];
  },
  round: (W, D) => {
    const p: Poly = [];
    for (let i = 0; i < 34; i++) {
      const t = (i / 34) * TAU;
      p.push([(Math.cos(t) * W) / 2, (Math.sin(t) * D) / 2]);
    }
    return p;
  },
  hex: (W, D) => {
    const p: Poly = [];
    for (let i = 0; i < 6; i++) {
      const t = Math.PI / 6 + (i / 6) * TAU;
      p.push([(Math.cos(t) * W) / 2, (Math.sin(t) * D) / 2]);
    }
    return p;
  },
  octagon: (W, D) => {
    const p: Poly = [];
    for (let i = 0; i < 8; i++) {
      const t = Math.PI / 8 + (i / 8) * TAU;
      p.push([(Math.cos(t) * W) / 2, (Math.sin(t) * D) / 2]);
    }
    return p;
  },
};

export function signedArea(p: Poly): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length;
    a += p[i]![0] * p[j]![1] - p[j]![0] * p[i]![1];
  }
  return a / 2;
}

export function centroid(p: Poly): Pt {
  let a = 0,
    cx = 0,
    cz = 0;
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length;
    const cr = p[i]![0] * p[j]![1] - p[j]![0] * p[i]![1];
    a += cr;
    cx += (p[i]![0] + p[j]![0]) * cr;
    cz += (p[i]![1] + p[j]![1]) * cr;
  }
  a /= 2;
  if (Math.abs(a) < 1e-6) return [0, 0];
  return [cx / (6 * a), cz / (6 * a)];
}

export function edgesOf(points: Poly): Edge[] {
  const e: Edge[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!,
      b = points[(i + 1) % points.length]!;
    const dx = b[0] - a[0],
      dz = b[1] - a[1],
      len = Math.hypot(dx, dz);
    let nx = dz,
      nz = -dx;
    const nl = Math.hypot(nx, nz) || 1;
    e.push({ a, b, len, nx: nx / nl, nz: nz / nl, mx: (a[0] + b[0]) / 2, mz: (a[1] + b[1]) / 2 });
  }
  return e;
}

export function prepPoly(pRaw: Poly): Prepped {
  let p = pRaw.map((q) => q.slice() as Pt);
  if (signedArea(p) < 0) p.reverse();
  const C = centroid(p);
  const edges = edgesOf(p);
  const e0 = edges[0]!;
  if (e0.nx * (e0.mx - C[0]) + e0.nz * (e0.mz - C[1]) < 0) {
    for (const e of edges) {
      e.nx *= -1;
      e.nz *= -1;
    }
  }
  return { points: p, edges, centroid: C };
}

export function scalePoly(p: Poly, s: number, C: Pt): Poly {
  return p.map((q) => [C[0] + (q[0] - C[0]) * s, C[1] + (q[1] - C[1]) * s] as Pt);
}

export function polyShape(points: Poly): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(points[0]![0], -points[0]![1]);
  for (let i = 1; i < points.length; i++) s.lineTo(points[i]![0], -points[i]![1]);
  s.closePath();
  return s;
}

export interface Bbox {
  minx: number;
  maxx: number;
  minz: number;
  maxz: number;
  w: number;
  d: number;
}

export function bbox(points: Poly): Bbox {
  let a = 1e9,
    b = -1e9,
    c = 1e9,
    d = -1e9;
  for (const p of points) {
    a = Math.min(a, p[0]);
    b = Math.max(b, p[0]);
    c = Math.min(c, p[1]);
    d = Math.max(d, p[1]);
  }
  return { minx: a, maxx: b, minz: c, maxz: d, w: b - a, d: d - c };
}

export function isRect(points: Poly): boolean {
  return points.length === 4;
}
