import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { getCatalogEntry } from "../../game/catalog";
import { isStructureEntry, type StructureCatalogEntry } from "../../game/types";
import {
  buildProceduralBuilding,
  buildSkylineBackdrop,
  CURATED_STYLE_KEYS,
  resolveStructureBuild,
  STYLES,
} from "./index";

function countInstanced(g: THREE.Object3D): number {
  let n = 0;
  g.traverse((c) => {
    if (c instanceof THREE.InstancedMesh) n++;
  });
  return n;
}

describe("buildgen", () => {
  it("builds a non-empty group with instanced windows (no GL context)", () => {
    const g = buildProceduralBuilding({
      style: "brutalist",
      foot: "rect",
      storeys: 8,
      width: 20,
      depth: 18,
      fh: 4,
      seed: 12345,
    });
    expect(g).toBeInstanceOf(THREE.Group);
    expect(g.children.length).toBeGreaterThan(0);
    expect(countInstanced(g)).toBeGreaterThan(0);
  });

  it("is deterministic for a given seed", () => {
    const params = { style: "cyberpunk" as const, foot: "octagon" as const, storeys: 12, width: 22, depth: 22, fh: 4, seed: 999 };
    const a = buildProceduralBuilding(params);
    const b = buildProceduralBuilding(params);
    expect(a.children.length).toBe(b.children.length);
    expect(countInstanced(a)).toBe(countInstanced(b));
  });

  it("builds every curated style without throwing", () => {
    for (const style of CURATED_STYLE_KEYS) {
      const g = buildProceduralBuilding({ style, foot: "rect", storeys: 6, width: 18, depth: 18, fh: 4, seed: 7 });
      expect(g.children.length).toBeGreaterThan(0);
    }
  });

  it("resolveStructureBuild is deterministic and style-valid for a real structure", () => {
    const entry = getCatalogEntry("outpost");
    expect(entry && isStructureEntry(entry)).toBe(true);
    const struct = entry as StructureCatalogEntry;
    const r1 = resolveStructureBuild(struct);
    const r2 = resolveStructureBuild(struct);
    expect(r1).toEqual(r2);
    expect(STYLES[r1.style]).toBeDefined();
    expect(r1.storeys).toBeGreaterThanOrEqual(3);
    expect(r1.storeys).toBeLessThanOrEqual(12);
  });

  it("derives the override style when provided", () => {
    const base = getCatalogEntry("outpost") as StructureCatalogEntry;
    const overridden: StructureCatalogEntry = { ...base, buildStyleId: "gothic" };
    expect(resolveStructureBuild(overridden).style).toBe("gothic");
  });

  it("builds a skyline backdrop ring", () => {
    const g = buildSkylineBackdrop({ seed: 42, rings: 1, perRing: 12 });
    expect(g.children.length).toBeGreaterThan(0);
  });
});
