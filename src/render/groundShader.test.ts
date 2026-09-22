import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { MAP_REGISTRY } from "../game/loadMap";
import type { MapData, MapGroundPreset } from "../game/types";
import { createGroundShaderMaterial, isShaderGroundPreset } from "./groundShader";

describe("authored map ground materials", () => {
  it("assigns all five published maps distinct supported terrain styles", () => {
    const presets = MAP_REGISTRY.map(({ url }) => {
      const map = JSON.parse(readFileSync(`public${url}`, "utf8")) as MapData;
      return map.visual?.groundPreset;
    });
    expect(presets).toHaveLength(5);
    expect(new Set(presets).size).toBe(5);
    expect(presets.every((preset) => isShaderGroundPreset(preset))).toBe(true);
    expect(isShaderGroundPreset("solid")).toBe(false);
    expect(isShaderGroundPreset(undefined)).toBe(false);
  });

  it("keeps style values finite, distinct and bounded below combat highlights", () => {
    const presets: MapGroundPreset[] = ["ember_wastes", "forge_slag", "cinder_field", "glacier_grid", "mesa_band"];
    const signatures = new Set<string>();
    for (const preset of presets) {
      if (!isShaderGroundPreset(preset)) throw new Error(`Unsupported test preset ${preset}`);
      const material = createGroundShaderMaterial(preset);
      expect(material.glslVersion).toBe(THREE.GLSL3);
      expect(material.transparent).toBe(false);
      const colors = ["uColorA", "uColorB", "uColorC", "uAccent"]
        .map((name) => material.uniforms[name]?.value as THREE.Vector3);
      for (const color of colors) {
        expect(color.toArray().every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1)).toBe(true);
      }
      const darkest = colors[0]!;
      const mid = colors[1]!;
      const light = colors[2]!;
      expect(darkest.length()).toBeLessThan(mid.length());
      expect(mid.length()).toBeLessThan(light.length());
      expect(Math.max(...light.toArray())).toBeLessThan(0.6);
      signatures.add(colors.map((color) => color.toArray().join(",")).join("|"));
      const flow = material.uniforms.uFlow?.value as THREE.Vector2;
      expect(flow.length()).toBeCloseTo(1, 4);
      for (const name of ["uNoiseScale", "uStrataScale", "uCrackScale", "uBandStrength", "uSeamStrength", "uSeamGlow"]) {
        expect(Number.isFinite(material.uniforms[name]?.value), `${preset}:${name}`).toBe(true);
      }
      material.dispose();
    }
    expect(signatures.size).toBe(presets.length);
  });

  it("uses a fixed two-noise shader with distance-faded fine detail", () => {
    const material = createGroundShaderMaterial("forge_slag");
    const fragment = material.fragmentShader;
    expect(fragment.match(/\bnoise\(flow\b/g)).toHaveLength(2);
    expect(fragment).not.toMatch(/\bfbm\b|for\s*\(/);
    expect(fragment).toContain("fwidth(flow.x * grainScale)");
    expect(fragment).toContain("fwidth(fault)");
    material.dispose();
  });
});
