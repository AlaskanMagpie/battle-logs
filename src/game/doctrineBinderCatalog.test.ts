import { describe, expect, it } from "vitest";
import {
  BINDER_CELLS_PER_PAGE,
  BINDER_CELLS_PER_SHEET,
  BINDER_CODEX_SPREAD_COUNT,
} from "../ui/binder/CardBinderEngine";
import {
  KEEP_ID,
  PRODUCED_UNIT_AMBER_GEODE_MONKS,
  PRODUCED_UNIT_CHRONO_SENTINELS,
  PRODUCED_UNIT_LANTERNBOUND_LINE,
  PRODUCED_UNIT_LAVA_WIZARD_MONKS,
} from "./constants";
import { productionBatchSizeForClass } from "./sim/systems/helpers";
import { CATALOG, getCatalogEntry, STRUCTURES } from "./catalog";
import { sortCatalogIds } from "./catalogSort";
import { isCommandEntry, isStructureEntry } from "./types";

const STRUCTURE_CATALOG_IDS = CATALOG.filter((c) => !isCommandEntry(c)).map((c) => c.id);

describe("Doctrine binder catalog", () => {
  it("pads the doctrine codex to five sheets (18 catalog slots per sheet, 9 per face)", () => {
    expect(BINDER_CODEX_SPREAD_COUNT).toBe(5);
    expect(BINDER_CELLS_PER_PAGE).toBe(9);
    expect(BINDER_CELLS_PER_SHEET).toBe(18);
    expect(BINDER_CODEX_SPREAD_COUNT * BINDER_CELLS_PER_SHEET).toBe(90);
  });

  it("only exposes the home base and current full-art structure cards", () => {
    expect(STRUCTURE_CATALOG_IDS).toEqual([
      KEEP_ID,
      "outpost",
      "watchtower",
      "bastion_keep",
      "verdant_citadel",
      "emberroot_bastion",
      "aionroot_observatory",
    ]);
  });

  it("sortCatalogIds preserves structure-only ids for every sort key", () => {
    const keys = ["catalog", "name", "cost", "kind", "class", "cooldown"] as const;
    for (const key of keys) {
      const sorted = sortCatalogIds(STRUCTURE_CATALOG_IDS, key);
      expect(sorted.length).toBe(STRUCTURE_CATALOG_IDS.length);
      for (const id of sorted) {
        const e = CATALOG.find((c) => c.id === id);
        expect(e).toBeTruthy();
        expect(isCommandEntry(e!)).toBe(false);
      }
    }
  });

  it("maps Bastion's heavy placeholder slot to Rootbound Crag's two Geode Monks", () => {
    const entry = getCatalogEntry("bastion_keep");
    expect(entry).toBeTruthy();
    expect(isStructureEntry(entry!)).toBe(true);
    if (!entry || !isStructureEntry(entry)) return;
    expect(entry.name).toBe("Rootbound Crag");
    expect(entry.producedSizeClass).toBe("Heavy");
    expect(productionBatchSizeForClass(entry.producedSizeClass)).toBe(2);
    expect(entry.producedFlavor).toContain("Amber Geode Monks");
    expect(entry.producedUnitId).toBe(PRODUCED_UNIT_AMBER_GEODE_MONKS);
  });

  it("only Rootbound Crag uses the Amber Geode Monks spawn profile", () => {
    const ids = STRUCTURES.filter((s) => s.producedUnitId === PRODUCED_UNIT_AMBER_GEODE_MONKS).map((s) => s.id);
    expect(ids).toEqual(["bastion_keep"]);
  });

  it("maps Emberroot Bastion to Line Lava Wizard Monks", () => {
    const entry = getCatalogEntry("emberroot_bastion");
    expect(entry).toBeTruthy();
    expect(isStructureEntry(entry!)).toBe(true);
    if (!entry || !isStructureEntry(entry)) return;
    expect(entry.name).toBe("Emberroot Bastion");
    expect(entry.producedSizeClass).toBe("Line");
    expect(productionBatchSizeForClass(entry.producedSizeClass)).toBe(3);
    expect(entry.producedUnitId).toBe(PRODUCED_UNIT_LAVA_WIZARD_MONKS);
  });

  it("only Emberroot Bastion uses the lava wizard monks spawn profile (emberbound ascetic merged clips)", () => {
    const ids = STRUCTURES.filter((s) => s.producedUnitId === PRODUCED_UNIT_LAVA_WIZARD_MONKS).map((s) => s.id);
    expect(ids).toEqual(["emberroot_bastion"]);
  });

  it("maps Driftwood Oasis to Line lanternbound oasis spellrunners", () => {
    const entry = getCatalogEntry("outpost");
    expect(entry).toBeTruthy();
    expect(isStructureEntry(entry!)).toBe(true);
    if (!entry || !isStructureEntry(entry)) return;
    expect(entry.name).toBe("Driftwood Oasis");
    expect(entry.producedSizeClass).toBe("Line");
    expect(entry.producedUnitId).toBe(PRODUCED_UNIT_LANTERNBOUND_LINE);
  });

  it("only Driftwood Oasis uses the lanternbound_line animation profile", () => {
    const ids = STRUCTURES.filter((s) => s.producedUnitId === PRODUCED_UNIT_LANTERNBOUND_LINE).map((s) => s.id);
    expect(ids).toEqual(["outpost"]);
  });

  it("only Aionroot Observatory uses the Chrono Sentinels spawn profile (astral knight merged clips)", () => {
    const ids = STRUCTURES.filter((s) => s.producedUnitId === PRODUCED_UNIT_CHRONO_SENTINELS).map((s) => s.id);
    expect(ids).toEqual(["aionroot_observatory"]);
  });
});
