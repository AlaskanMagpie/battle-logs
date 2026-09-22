import * as THREE from "three";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { STRUCTURES } from "../game/catalog";
import type { CastFxKind, CombatHitMark } from "../game/state";
import { SPELL_FX_ELEMENTS, type SpellFxShape } from "../game/types";
import { clearFx, createFxHost, MAX_ACTIVE_FX, spawnCastFx, spawnCombatHitMark, stepFx } from "./fx";

// Exercise the actual Three geometry routes in Node without a WebGL context.
// The lazily made radial texture only needs a canvas and a 2D paint surface.
beforeAll(() => {
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error(`Unexpected element: ${tag}`);
      return {
        width: 128,
        height: 128,
        getContext: () => ({
          createRadialGradient: () => ({ addColorStop: () => undefined }),
          fillRect: () => undefined,
          fillStyle: "",
        }),
      };
    },
  });
});
afterAll(() => vi.unstubAllGlobals());

const CAST_KINDS: Record<CastFxKind, true> = {
  firestorm: true, combat_boom: true, shatter: true, fortify: true, muster: true,
  line_cleave: true, claim: true, lightning: true, hero_strike: true,
  spark_burst: true, ground_crack: true, reclaim_pulse: true, death_flash: true,
  elemental_spell: true,
};

const SPELL_SHAPES: Record<SpellFxShape, true> = {
  aoe: true, bolt: true, chain: true, cone: true, beam: true, line: true,
  field: true, meteor: true, impact: true, burst: true, surprise: true,
};

function renderables(host: ReturnType<typeof createFxHost>): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  host.group.traverse((node) => {
    if (node instanceof THREE.Mesh || node instanceof THREE.Sprite || node instanceof THREE.Points) out.push(node);
  });
  return out;
}

function assertFiniteGeometry(host: ReturnType<typeof createFxHost>): void {
  host.group.traverse((node) => {
    if (!node.position.toArray().every(Number.isFinite) || !node.scale.toArray().every(Number.isFinite)) {
      throw new Error(`Invalid transform on ${node.name || node.type}`);
    }
    if (node instanceof THREE.Mesh || node instanceof THREE.Points) {
      const position = node.geometry.getAttribute("position");
      if (!position || !Array.from(position.array).every(Number.isFinite)) {
        throw new Error(`Invalid geometry on ${node.name || node.type}`);
      }
      if (node instanceof THREE.InstancedMesh && !Array.from(node.instanceMatrix.array).every(Number.isFinite)) {
        throw new Error("Invalid instance transform");
      }
    }
  });
}

function mark(producedUnitId: string | undefined, sizeClass: CombatHitMark["sizeClass"], producerCatalogId?: string): CombatHitMark {
  return {
    ax: -5, az: 0, tx: 6, tz: 2, range: 13, wide: sizeClass === "Titan",
    team: "player", sizeClass, producedUnitId, producerCatalogId, visualSeed: 42, signal: "Vanguard",
  };
}

describe("live combat and spell FX routes", () => {
  it("renders every cast event with valid finite geometry and cleans it up", () => {
    const host = createFxHost(new THREE.Scene());
    for (const kind of Object.keys(CAST_KINDS) as CastFxKind[]) {
      spawnCastFx(host, kind, { x: 6, z: 2 }, {
        from: { x: -6, z: 0 }, element: "arcane", shape: "impact", impactRadius: 9, visualSeed: 11,
      });
      expect(renderables(host).length, kind).toBeGreaterThan(0);
      stepFx(host, 1 / 60);
      assertFiniteGeometry(host);
      clearFx(host);
      expect(host.group.children, kind).toHaveLength(0);
    }
  });

  it("renders every element in every supported shape, including ten distinct surprise routes", () => {
    const host = createFxHost(new THREE.Scene());
    const surprises = new Set<string>();
    for (const element of SPELL_FX_ELEMENTS) {
      for (const shape of Object.keys(SPELL_SHAPES) as SpellFxShape[]) {
        spawnCastFx(host, "elemental_spell", { x: 6, z: 2 }, {
          from: { x: -6, z: 0 }, element, shape, impactRadius: 8, reach: 12,
          width: 5, visualSeed: 31,
        });
        const nodes = renderables(host);
        expect(nodes.length, `${element}/${shape}`).toBeGreaterThan(0);
        expect(nodes.length, `${element}/${shape}`).toBeLessThanOrEqual(36);
        if (shape === "surprise") {
          const geometryKinds = nodes.filter((node) => node instanceof THREE.Mesh)
            .map((node) => (node as THREE.Mesh).geometry.type).join(",");
          surprises.add(geometryKinds);
        }
        stepFx(host, 1 / 60);
        assertFiniteGeometry(host);
        clearFx(host);
      }
    }
    // Surprises have their own composed geometry, beyond a palette swap.
    expect(surprises.size).toBeGreaterThanOrEqual(7);
  }, 20_000);

  it("covers each authored producer and all four generic class fallbacks with readable, bounded looks", () => {
    const host = createFxHost(new THREE.Scene());
    const signatures = new Set<string>();
    const producers = STRUCTURES.filter((structure) => structure.producedUnitId || structure.producedSizeClass === "Titan");
    for (const producer of producers) {
      spawnCombatHitMark(host, mark(producer.producedUnitId, producer.producedSizeClass, producer.id));
      const nodes = renderables(host);
      expect(nodes.length, producer.id).toBeGreaterThan(0);
      expect(nodes.length, producer.id).toBeLessThanOrEqual(16);
      const signature = nodes.map((node) => {
        const material = (node as THREE.Mesh).material as THREE.Material | undefined;
        const color = material && "color" in material ? (material.color as THREE.Color).getHexString() : "none";
        return `${node.type}:${color}`;
      }).join("|");
      signatures.add(signature);
      stepFx(host, 1 / 60);
      assertFiniteGeometry(host);
      clearFx(host);
    }
    // Wizard Keep and Cragrunner intentionally share one scout unit profile.
    expect(signatures.size).toBe(6);
    for (const sizeClass of ["Swarm", "Line", "Heavy", "Titan"] as const) {
      spawnCombatHitMark(host, mark(undefined, sizeClass));
      expect(renderables(host).length, sizeClass).toBeGreaterThan(0);
      clearFx(host);
    }
  });

  it("makes both schools in the paired Cut Back and Fortify spells visible", () => {
    const host = createFxHost(new THREE.Scene());
    const colors = () => renderables(host).flatMap((node) => {
      const material = (node as THREE.Mesh).material as THREE.Material | undefined;
      return material && "color" in material ? [(material.color as THREE.Color).getHex()] : [];
    });
    spawnCastFx(host, "elemental_spell", { x: 6, z: 2 }, {
      element: "water", secondaryElement: "reclaim", shape: "line", from: { x: -6, z: 0 }, visualSeed: 3,
    });
    expect(colors()).toContain(0xff66dd);
    clearFx(host);
    spawnCastFx(host, "elemental_spell", { x: 6, z: 2 }, {
      element: "shield", secondaryElement: "air", shape: "field", visualSeed: 3,
    });
    expect(colors()).toContain(0x59bfff);
    clearFx(host);
  });

  it("keeps directional spell cues visible when a cast has no origin", () => {
    const host = createFxHost(new THREE.Scene());
    for (const shape of ["bolt", "chain", "cone", "beam", "line"] as const) {
      spawnCastFx(host, "elemental_spell", { x: 8, z: -2 }, {
        element: "air", shape, impactRadius: 6, visualSeed: 18,
      });
      expect(renderables(host).length, shape).toBeGreaterThan(0);
      assertFiniteGeometry(host);
      clearFx(host);
    }
  });

  it("bounds dense combat and preserves spells ahead of new low-priority hit marks", () => {
    const host = createFxHost(new THREE.Scene());
    for (let i = 0; i < MAX_ACTIVE_FX + 12; i++) spawnCombatHitMark(host, mark(undefined, "Swarm"));
    expect(host.active).toHaveLength(MAX_ACTIVE_FX);
    spawnCastFx(host, "firestorm", { x: 3, z: 1 }, { impactRadius: 9 });
    const spell = host.active.at(-1)!.node;
    for (let i = 0; i < MAX_ACTIVE_FX + 12; i++) spawnCombatHitMark(host, mark(undefined, "Swarm"));
    expect(host.active).toHaveLength(MAX_ACTIVE_FX);
    expect(host.active.some((fx) => fx.node === spell)).toBe(true);
    clearFx(host);
    expect(host.group.children).toHaveLength(0);
  });

  it("holds a short impact cue still when reduced motion is requested", () => {
    const host = createFxHost(new THREE.Scene());
    host.reducedMotion = true;
    spawnCastFx(host, "firestorm", { x: 4, z: 1 }, { impactRadius: 9 });
    const opacity = renderables(host).map((node) => ((node as THREE.Mesh).material as THREE.Material & { opacity: number }).opacity);
    expect(opacity.some((value) => value > 0.1)).toBe(true);
    for (let i = 0; i < 3; i++) stepFx(host, 1 / 60);
    expect(renderables(host).map((node) => ((node as THREE.Mesh).material as THREE.Material & { opacity: number }).opacity)).toEqual(opacity);
    for (let i = 0; i < 8; i++) stepFx(host, 0.05);
    expect(host.active).toHaveLength(0);
    expect(host.group.children).toHaveLength(0);
  });
});
