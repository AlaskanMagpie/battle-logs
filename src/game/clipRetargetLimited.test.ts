import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { applyClipRetargetOverride, stripNonRootPositionTracks } from "./clipRetargetLimited";

function posTrack(name: string): THREE.VectorKeyframeTrack {
  return new THREE.VectorKeyframeTrack(name, [0, 1], [0, 0, 0, 1, 1, 1]);
}

function quatTrack(name: string): THREE.QuaternionKeyframeTrack {
  return new THREE.QuaternionKeyframeTrack(name, [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]);
}

describe("stripNonRootPositionTracks", () => {
  it("drops Spine.position but keeps Hips.position and rotations", () => {
    const clip = new THREE.AnimationClip("c", 1, [
      posTrack("Armature|mixamorig:Hips.position"),
      posTrack("Armature|mixamorig:Spine.position"),
      quatTrack("Armature|mixamorig:Spine.quaternion"),
    ]);
    const out = stripNonRootPositionTracks(clip);
    expect(out.tracks.map((t) => t.name)).toEqual([
      "Armature|mixamorig:Hips.position",
      "Armature|mixamorig:Spine.quaternion",
    ]);
  });
});

describe("applyClipRetargetOverride", () => {
  it("no-ops when producedUnitId missing", () => {
    const clip = new THREE.AnimationClip("c", 1, [posTrack("Spine.position")]);
    const m = {
      clipRetargetOverrides: [
        {
          producedUnitId: "town_levy",
          donorFile: "donor.glb",
          roles: ["death"] as const,
          mode: "stripNonRootPosition" as const,
        },
      ],
    };
    expect(applyClipRetargetOverride(clip, m, { producedUnitId: undefined, donorFile: "donor.glb", role: "death" })).toBe(
      clip,
    );
  });

  it("applies when manifest row matches", () => {
    const clip = new THREE.AnimationClip("c", 1, [posTrack("Spine.position"), posTrack("Hips.position")]);
    const m = {
      clipRetargetOverrides: [
        {
          producedUnitId: "town_levy",
          donorFile: "donor.glb",
          roles: ["death"] as const,
          mode: "stripNonRootPosition" as const,
        },
      ],
    };
    const out = applyClipRetargetOverride(clip, m, {
      producedUnitId: "town_levy",
      donorFile: "donor.glb",
      role: "death",
    });
    expect(out.tracks.map((t) => t.name)).toEqual(["Hips.position"]);
  });
});
