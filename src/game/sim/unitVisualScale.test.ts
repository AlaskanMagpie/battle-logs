import { describe, expect, it } from "vitest";
import {
  FEET_PER_WORLD_UNIT,
  UNIT_HEIGHT_FEET,
  UNIT_MESH_HEAVY,
  UNIT_MESH_LINE,
  UNIT_MESH_SWARM,
  UNIT_MESH_TITAN,
} from "../constants";
import { unitVisualScaleReport } from "./systems/helpers";

describe("unit visual scale ladder", () => {
  it("keeps lower unit classes below towers and ordered by class", () => {
    const s = unitVisualScaleReport();

    expect(s.Swarm).toBeLessThan(s.Line);
    expect(s.Line).toBeLessThan(s.Heavy);
    expect(s.Heavy).toBeLessThan(s.Titan);

    expect(s.Swarm).toBeLessThan(UNIT_MESH_TITAN);
    expect(s.Line).toBeLessThan(UNIT_MESH_TITAN);
    expect(s.Heavy).toBeLessThan(UNIT_MESH_TITAN);
    expect(s.Titan).toBe(UNIT_MESH_TITAN);

    expect(s.Swarm).toBeCloseTo(UNIT_MESH_SWARM, 6);
    expect(s.Line).toBeCloseTo(UNIT_MESH_LINE, 6);
    expect(s.Heavy).toBeCloseTo(UNIT_MESH_HEAVY, 6);

    expect(s.Swarm * FEET_PER_WORLD_UNIT).toBeCloseTo(UNIT_HEIGHT_FEET.Swarm, 6);
    expect(s.Line * FEET_PER_WORLD_UNIT).toBeCloseTo(UNIT_HEIGHT_FEET.Line, 6);
    expect(s.Heavy * FEET_PER_WORLD_UNIT).toBeCloseTo(UNIT_HEIGHT_FEET.Heavy, 6);
    expect(s.Titan * FEET_PER_WORLD_UNIT).toBeCloseTo(UNIT_HEIGHT_FEET.Titan, 6);
  });
});
