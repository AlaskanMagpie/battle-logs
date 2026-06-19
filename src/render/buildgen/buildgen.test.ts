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

function countStaticMeshes(g: THREE.Object3D): number {
  let n = 0;
  g.traverse((c) => {
    if (c instanceof THREE.Mesh && !(c instanceof THREE.InstancedMesh)) n++;
  });
  return n;
}

function countTriangles(g: THREE.Object3D): number {
  let tris = 0;
  g.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      const pos = c.geometry.getAttribute("position");
      const perInstance = c instanceof THREE.InstancedMesh ? c.count : 1;
      if (pos) tris += (pos.count / 3) * perInstance;
    }
  });
  return tris;
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

  it("merges static meshes into few draw calls while keeping windows instanced", () => {
    const merged = buildProceduralBuilding({ style: "brutalist", foot: "rect", storeys: 10, width: 22, depth: 20, fh: 4, seed: 5 });
    const unmerged = buildProceduralBuilding({ style: "brutalist", foot: "rect", storeys: 10, width: 22, depth: 20, fh: 4, seed: 5, mergeStatics: false });
    // Merge collapses dozens of static meshes to one-per-material (a handful).
    expect(countStaticMeshes(merged)).toBeLessThan(countStaticMeshes(unmerged));
    expect(countStaticMeshes(merged)).toBeLessThanOrEqual(8);
    // Windows stay batched (frames + lit + unlit), untouched by the merge.
    expect(countInstanced(merged)).toBe(countInstanced(unmerged));
    expect(countInstanced(merged)).toBeGreaterThan(0);
    // litMesh userData contract preserved for any future glow control.
    expect(merged.userData["litMesh"]).toBeDefined();
  });

  it("low detail produces no more triangles than high detail", () => {
    const params = { style: "cyberpunk" as const, foot: "rect" as const, storeys: 12, width: 22, depth: 22, fh: 4, seed: 3 };
    const high = buildProceduralBuilding({ ...params, detail: "high" });
    const low = buildProceduralBuilding({ ...params, detail: "low" });
    expect(countTriangles(low)).toBeLessThanOrEqual(countTriangles(high));
  });

  it("applies an enemy tint distinct from the player palette", () => {
    const params = { style: "brutalist" as const, foot: "rect" as const, storeys: 8, width: 20, depth: 18, fh: 4, seed: 11, mergeStatics: false };
    const player = buildProceduralBuilding({ ...params, team: "player" });
    const enemy = buildProceduralBuilding({ ...params, team: "enemy" });
    const wallOf = (g: THREE.Object3D): THREE.Color => {
      let col = new THREE.Color(0xffffff);
      g.traverse((c) => {
        if (c instanceof THREE.Mesh) {
          const m = c.material as THREE.MeshStandardMaterial;
          if (m && m.color && m.roughness >= 0.9) col = m.color;
        }
      });
      return col;
    };
    const ep = wallOf(enemy);
    const pp = wallOf(player);
    // Enemy reads redder: red dominates green/blue more than the neutral player wall.
    expect(ep.r - ep.g).toBeGreaterThan(pp.r - pp.g);
  });
});
