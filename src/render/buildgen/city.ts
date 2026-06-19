/**
 * City-block generator (ported from buildin-s `buildCity`) plus a thin
 * `buildSkylineBackdrop` helper that rings the arena with low-detail buildings
 * for depth. Purely cosmetic — never part of the simulation.
 */
import * as THREE from "three";
import { buildBuilding } from "./building";
import { clamp, lerp, mulberry32, pick, rint, rrange, TAU, type Rng } from "./rng";
import { STYLES, STYLE_KEYS, CURATED_STYLE_KEYS, type Style, type StyleKey } from "./styles";
import type { FootKey } from "./footprints";

export interface CityParams {
  gridSz: number;
  street: number;
  spread: "current" | "mixed";
  style: StyleKey;
  storeys: number;
  skyline: boolean;
  styleKeys?: StyleKey[];
}

export function buildCityBlock(p: CityParams, rng: Rng): THREE.Group {
  const root = new THREE.Group();
  const n = p.gridSz,
    street = p.street;
  const keys = p.styleKeys ?? STYLE_KEYS;
  const cols: number[] = [],
    rows: number[] = [];
  for (let i = 0; i < n; i++) {
    cols.push(rrange(rng, 20, 38));
    rows.push(rrange(rng, 20, 38));
  }
  const totalW = cols.reduce((a, b) => a + b, 0) + street * (n - 1),
    totalD = rows.reduce((a, b) => a + b, 0) + street * (n - 1);
  let maxH = 0,
    count = 0,
    zc = -totalD / 2;
  for (let r = 0; r < n; r++) {
    let xc = -totalW / 2;
    for (let c = 0; c < n; c++) {
      const lw = cols[c]!,
        ld = rows[r]!,
        cx = xc + lw / 2,
        cz = zc + ld / 2;
      if (rng() >= 0.06) {
        const style = p.spread === "current" ? p.style : pick(rng, keys);
        const st: Style = STYLES[style];
        let storeys: number;
        if (p.spread === "current") storeys = clamp(Math.round(p.storeys * rrange(rng, 0.6, 1.25)), 1, 60);
        else
          storeys = rint(
            rng,
            st.floors[0],
            Math.min(st.floors[1], p.skyline ? st.floors[1] : Math.max(st.floors[0] + 2, Math.round(st.floors[1] * 0.6))),
          );
        if (p.skyline) {
          const dist = Math.hypot(cx, cz) / (Math.max(totalW, totalD) / 2);
          storeys = clamp(Math.round(storeys * lerp(1.5, 0.5, clamp(dist, 0, 1))), 1, 60);
        }
        const foot: FootKey = rng() < 0.18 ? pick(rng, ["L", "rect", "rect", "octagon"] as FootKey[]) : "rect";
        const fh = rrange(rng, 3.2, 4);
        const b = buildBuilding(
          {
            style,
            foot,
            storeys,
            width: lw * rrange(rng, 0.7, 0.86),
            depth: ld * rrange(rng, 0.7, 0.86),
            fh,
            roof: "auto",
            tiered: storeys > 22 && rng() < 0.5,
            density: 1,
            seed: (rng() * 1e6) | 0,
          },
          mulberry32((rng() * 1e6) | 0),
        );
        b.position.set(cx, 0, cz);
        if (rng() < 0.5) b.rotation.y = Math.PI / 2;
        root.add(b);
        maxH = Math.max(maxH, storeys * fh);
        count++;
      }
      xc += lw + street;
    }
    zc += rows[r]! + street;
  }
  const ud = root.userData as Record<string, unknown>;
  ud["count"] = count;
  ud["height"] = maxH;
  return root;
}

export interface SkylineParams {
  seed?: number;
  /** Buildings start at this radius from origin (outside the play area). */
  innerRadius?: number;
  /** Number of concentric rings of buildings. */
  rings?: number;
  /** Buildings per ring. */
  perRing?: number;
  styleKeys?: StyleKey[];
}

/**
 * Builds a static ring of low-detail buildings around the arena for backdrop
 * depth. Deterministic for a given seed. Buildings face the origin.
 */
export function buildSkylineBackdrop(params: SkylineParams = {}): THREE.Group {
  const seed = params.seed ?? 1234;
  const innerRadius = params.innerRadius ?? 150;
  const rings = params.rings ?? 2;
  const perRing = params.perRing ?? 28;
  const keys = params.styleKeys ?? CURATED_STYLE_KEYS;
  const rng = mulberry32(seed);
  const root = new THREE.Group();
  root.name = "skyline-backdrop";
  for (let ring = 0; ring < rings; ring++) {
    const radius = innerRadius + ring * rrange(rng, 36, 52);
    const tallScale = 1 + ring * 0.5;
    for (let i = 0; i < perRing; i++) {
      if (rng() < 0.12) continue;
      const ang = (i / perRing) * TAU + rrange(rng, -0.05, 0.05);
      const rr = radius + rrange(rng, -14, 14);
      const x = Math.cos(ang) * rr,
        z = Math.sin(ang) * rr;
      const style = pick(rng, keys);
      const fh = rrange(rng, 4.2, 5.4);
      const bseed = (rng() * 1e6) | 0;
      const b = buildBuilding(
        {
          style,
          foot: "rect",
          storeys: Math.round(rint(rng, 6, 16) * tallScale),
          width: rrange(rng, 16, 30),
          depth: rrange(rng, 16, 30),
          fh,
          roof: "auto",
          density: 0.7,
          seed: bseed,
          litEmissive: 0.4,
          emissiveScale: 0.5,
        },
        mulberry32(bseed),
      );
      b.position.set(x, 0, z);
      b.rotation.y = -ang + Math.PI / 2;
      root.add(b);
    }
  }
  return root;
}
