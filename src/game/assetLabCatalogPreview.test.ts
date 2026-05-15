import { describe, expect, it } from "vitest";
import {
  effectiveProducedSizeClassForAssetLab,
  getAssetLabProducedSizeClassPreview,
  setAssetLabProducedSizeClassPreview,
} from "./assetLabCatalogPreview";

describe("assetLabCatalogPreview", () => {
  it("defaults to catalog class when unset", () => {
    setAssetLabProducedSizeClassPreview("watchtower", null);
    expect(effectiveProducedSizeClassForAssetLab("watchtower", "Swarm")).toBe("Swarm");
    expect(getAssetLabProducedSizeClassPreview("watchtower")).toBeUndefined();
  });

  it("overrides effective class when preview set", () => {
    setAssetLabProducedSizeClassPreview("watchtower", "Titan");
    expect(effectiveProducedSizeClassForAssetLab("watchtower", "Swarm")).toBe("Titan");
    expect(getAssetLabProducedSizeClassPreview("watchtower")).toBe("Titan");
    setAssetLabProducedSizeClassPreview("watchtower", null);
  });
});
