import { describe, expect, it } from "vitest";
import {
  DOCTRINE_MERGED_LABEL_SEP,
  donorFileIsInManifest,
  parseDoctrineClipRef,
} from "./doctrineClipRef";

describe("parseDoctrineClipRef", () => {
  it("returns null for empty / missing", () => {
    expect(parseDoctrineClipRef(undefined)).toBeNull();
    expect(parseDoctrineClipRef(null)).toBeNull();
    expect(parseDoctrineClipRef("")).toBeNull();
    expect(parseDoctrineClipRef("   ")).toBeNull();
  });

  it("treats values without merged separator as legacy raw clip names", () => {
    expect(parseDoctrineClipRef("Armature|Running")).toEqual({
      donorFile: null,
      clipName: "Armature|Running",
    });
  });

  it("splits stem and clip on first em-dash separator", () => {
    const raw = `lanternbound_line_dying${DOCTRINE_MERGED_LABEL_SEP}Armature|Dying`;
    expect(parseDoctrineClipRef(raw)).toEqual({
      donorFile: "lanternbound_line_dying.glb",
      clipName: "Armature|Dying",
    });
  });

  it("supports spaces in GLB stem (chrono tower)", () => {
    const raw = `chrono tower${DOCTRINE_MERGED_LABEL_SEP}Take 001`;
    expect(parseDoctrineClipRef(raw)).toEqual({
      donorFile: "chrono tower.glb",
      clipName: "Take 001",
    });
  });

  it("if stem empty after trim, treats whole value as legacy clip name", () => {
    const raw = `${DOCTRINE_MERGED_LABEL_SEP}orphan_clip`;
    expect(parseDoctrineClipRef(raw)).toEqual({
      donorFile: null,
      clipName: raw.trim(),
    });
  });

  it("dedup suffix stays in clipName portion", () => {
    const raw = `town_levy${DOCTRINE_MERGED_LABEL_SEP}Idle (2)`;
    expect(parseDoctrineClipRef(raw)).toEqual({
      donorFile: "town_levy.glb",
      clipName: "Idle (2)",
    });
  });
});

describe("donorFileIsInManifest", () => {
  it("matches exact manifest basename", () => {
    expect(donorFileIsInManifest("town_levy.glb", ["town_levy.glb", "a.glb"])).toBe(true);
    expect(donorFileIsInManifest("missing.glb", ["town_levy.glb"])).toBe(false);
  });
});
