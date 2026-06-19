/**
 * Architectural style catalogue + material factory, ported from buildin-s.
 *
 * The full 11-style table is preserved verbatim (used by the city/skyline
 * backdrop). For in-match doctrine structures we only derive from
 * `CURATED_STYLE_KEYS`, the subset that fits the stylized signal-wars tone.
 */
import * as THREE from "three";
import { clamp, mulberry32 } from "./rng";

export interface Style {
  name: string;
  col: number;
  wall: number;
  frame: number;
  glass: number;
  roof: number;
  accent?: number;
  neon1?: number;
  neon2?: number;
  wallR: number;
  wallM: number;
  glassR: number;
  glassM: number;
  glassO: number;
  win: "rect" | "arch" | "point";
  winW: number;
  winHF: number;
  gap: number;
  recess?: number;
  roof_: string;
  litWarm: number;
  glow: number;
  litRatio: number;
  floors: [number, number];
  bands?: number;
  tier?: boolean;
  neon?: boolean;
  columns?: boolean;
  tile?: boolean;
  water?: boolean;
}

export const STYLES = {
  modern: { name: "Modern", col: 0x5fb4d6, wall: 0xd6dde4, frame: 0x99a3ad, glass: 0x6fa9c8, roof: 0xb9bfc7, wallR: 0.55, wallM: 0.12, glassR: 0.08, glassM: 0.85, glassO: 0.55, win: "rect", winW: 2.6, winHF: 0.72, gap: 0.5, roof_: "flat", litWarm: 0xfff0d0, glow: 1.0, litRatio: 0.55, floors: [5, 42], bands: 1 },
  brutalist: { name: "Brutalist", col: 0x9a988f, wall: 0x9d9a92, frame: 0x6f6c65, glass: 0x39474f, roof: 0x8a877f, wallR: 0.95, wallM: 0, glassR: 0.5, glassM: 0.1, glassO: 0.85, win: "rect", winW: 1.7, winHF: 0.5, gap: 1.6, recess: 0.45, roof_: "flat", litWarm: 0xffe6b0, glow: 0.7, litRatio: 0.4, floors: [4, 22], bands: 2 },
  artdeco: { name: "Art Deco", col: 0xd8c79f, wall: 0xdac9a2, frame: 0x8c7c57, glass: 0x4b5b67, accent: 0xcaa96b, roof: 0xb6a585, wallR: 0.6, wallM: 0.05, glassR: 0.2, glassM: 0.3, glassO: 0.7, win: "rect", winW: 1.5, winHF: 0.82, gap: 1.1, roof_: "flat", litWarm: 0xffdf9a, glow: 0.85, litRatio: 0.5, floors: [10, 48], tier: true },
  gothic: { name: "Gothic", col: 0x9a958c, wall: 0x9b968d, frame: 0x6a655c, glass: 0x3a4a5a, roof: 0x55504a, wallR: 0.85, wallM: 0, glassR: 0.25, glassM: 0.2, glassO: 0.7, win: "point", winW: 1.5, winHF: 0.86, gap: 1.3, roof_: "spire", litWarm: 0xffcf8a, glow: 0.7, litRatio: 0.45, floors: [3, 14] },
  classical: { name: "Neoclassical", col: 0xe5e1d7, wall: 0xe6e2d8, frame: 0xb7b1a3, glass: 0x5a6a72, accent: 0xefebe1, roof: 0xc8c2b6, wallR: 0.62, wallM: 0.04, glassR: 0.2, glassM: 0.25, glassO: 0.7, win: "rect", winW: 1.9, winHF: 0.76, gap: 1.7, roof_: "flat", litWarm: 0xffeec0, glow: 0.7, litRatio: 0.45, floors: [2, 8], columns: true },
  cyberpunk: { name: "Cyberpunk", col: 0x29e0e8, wall: 0x232830, frame: 0x12151b, glass: 0x1b3a44, neon1: 0x29e0e8, neon2: 0xf06bd6, roof: 0x191c22, wallR: 0.4, wallM: 0.55, glassR: 0.12, glassM: 0.7, glassO: 0.6, win: "rect", winW: 2.4, winHF: 0.72, gap: 0.45, roof_: "flat", litWarm: 0x49f0ff, glow: 1.7, litRatio: 0.62, floors: [8, 52], tier: true, neon: true },
  industrial: { name: "Industrial", col: 0x9a5e4c, wall: 0x8d5645, frame: 0x573a30, glass: 0x49595a, roof: 0x6a4a40, wallR: 0.9, wallM: 0.05, glassR: 0.3, glassM: 0.2, glassO: 0.78, win: "rect", winW: 1.25, winHF: 0.7, gap: 0.45, roof_: "flat", litWarm: 0xffd28a, glow: 0.7, litRatio: 0.45, floors: [1, 8], water: true },
  victorian: { name: "Victorian", col: 0x9c5a52, wall: 0x9c5a52, frame: 0xeee9e1, glass: 0x4a5a66, roof: 0x4f413c, wallR: 0.85, wallM: 0, glassR: 0.2, glassM: 0.25, glassO: 0.72, win: "rect", winW: 1.4, winHF: 0.86, gap: 1.2, roof_: "mansard", litWarm: 0xffd89a, glow: 0.7, litRatio: 0.5, floors: [2, 6] },
  mediterranean: { name: "Mediterranean", col: 0xe7d8bf, wall: 0xe8d9c0, frame: 0xc7b799, glass: 0x59696a, roof: 0xb5663a, wallR: 0.8, wallM: 0, glassR: 0.2, glassM: 0.2, glassO: 0.72, win: "arch", winW: 1.5, winHF: 0.82, gap: 1.5, roof_: "hip", tile: true, litWarm: 0xffdca0, glow: 0.7, litRatio: 0.45, floors: [1, 5] },
  suburban: { name: "Suburban", col: 0xcfc4b2, wall: 0xd7ccba, frame: 0xf2efe8, glass: 0x6a8a9a, roof: 0x6a5a52, wallR: 0.78, wallM: 0, glassR: 0.18, glassM: 0.25, glassO: 0.7, win: "rect", winW: 1.7, winHF: 0.7, gap: 1.7, roof_: "gable", litWarm: 0xffe7b0, glow: 0.7, litRatio: 0.55, floors: [1, 3] },
} satisfies Record<string, Style>;

export type StyleKey = keyof typeof STYLES;

export const STYLE_KEYS = Object.keys(STYLES) as StyleKey[];

/** Curated subset that reads well in the stylized signal-wars setting. */
export const CURATED_STYLE_KEYS: StyleKey[] = [
  "brutalist",
  "gothic",
  "cyberpunk",
  "industrial",
  "classical",
];

export interface Mats {
  wall: THREE.MeshStandardMaterial;
  frame: THREE.MeshStandardMaterial;
  glassUnlit: THREE.MeshStandardMaterial;
  glassLit: THREE.MeshStandardMaterial;
  roof: THREE.MeshStandardMaterial;
  roofDark: THREE.MeshStandardMaterial;
  tile: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  neon1?: THREE.MeshStandardMaterial;
  neon2?: THREE.MeshStandardMaterial;
  glowAmt: number;
  litList: THREE.MeshStandardMaterial[];
}

export interface MakeMaterialsOpts {
  /**
   * Static emissive intensity for "lit" windows. buildin-s drove this from a
   * day/night system at runtime; the match renderer has no such system, so we
   * bake a constant glow (0 = off, matching the original default).
   */
  litEmissive?: number;
  /**
   * Scales neon emissive. The match renderer uses NoToneMapping, so the
   * ACES-tuned defaults read hot — pass < 1 to tame them.
   */
  emissiveScale?: number;
}

export function makeMaterials(style: Style, seed: number, opts: MakeMaterialsOpts = {}): Mats {
  const litEmissive = opts.litEmissive ?? 0;
  const emissiveScale = opts.emissiveScale ?? 1;
  const rng = mulberry32(seed * 7 + 13);
  const vary = (c: number): THREE.Color => {
    const col = new THREE.Color(c);
    const hsl = { h: 0, s: 0, l: 0 };
    col.getHSL(hsl);
    col.setHSL(hsl.h, hsl.s, clamp(hsl.l + (rng() - 0.5) * 0.07, 0.05, 0.95));
    return col;
  };
  const base = {
    color: style.glass,
    roughness: style.glassR,
    metalness: style.glassM,
    transparent: true,
    opacity: style.glassO,
    envMapIntensity: 1.1,
  };
  const neon1 = style.neon
    ? new THREE.MeshStandardMaterial({
        color: style.neon1,
        emissive: style.neon1,
        emissiveIntensity: 2.2 * emissiveScale,
        roughness: 0.3,
      })
    : undefined;
  const neon2 = style.neon
    ? new THREE.MeshStandardMaterial({
        color: style.neon2,
        emissive: style.neon2,
        emissiveIntensity: 2.2 * emissiveScale,
        roughness: 0.3,
      })
    : undefined;
  const glassLit = new THREE.MeshStandardMaterial({
    ...base,
    emissive: new THREE.Color(style.litWarm),
    emissiveIntensity: litEmissive,
  });
  const litList: THREE.MeshStandardMaterial[] = [glassLit];
  if (neon1) litList.push(neon1);
  if (neon2) litList.push(neon2);
  return {
    wall: new THREE.MeshStandardMaterial({ color: vary(style.wall), roughness: style.wallR, metalness: style.wallM }),
    frame: new THREE.MeshStandardMaterial({ color: style.frame, roughness: 0.7, metalness: 0.2 }),
    glassUnlit: new THREE.MeshStandardMaterial(base),
    glassLit,
    roof: new THREE.MeshStandardMaterial({ color: style.roof, roughness: 0.8, metalness: 0.1 }),
    roofDark: new THREE.MeshStandardMaterial({ color: new THREE.Color(style.roof).multiplyScalar(0.7), roughness: 0.85, metalness: 0.08 }),
    tile: new THREE.MeshStandardMaterial({ color: style.tile ? 0xb5663a : style.roof, roughness: 0.75, metalness: 0.05 }),
    accent: new THREE.MeshStandardMaterial({ color: style.accent ?? style.frame, roughness: 0.45, metalness: 0.5 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.6, metalness: 0.4 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.4, metalness: 0.7 }),
    neon1,
    neon2,
    glowAmt: style.glow,
    litList,
  };
}
