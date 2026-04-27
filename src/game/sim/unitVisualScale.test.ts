import { describe, expect, it } from "vitest";
import { UNIT_MESH_TITAN } from "../constants";
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

    expect(s.Line / s.Swarm).toBeCloseTo(1.5, 6);
    expect(s.Heavy / s.Line).toBeCloseTo(1.5, 6);
    expect(s.Titan / s.Heavy).toBeCloseTo(1.5, 6);
  });
});
