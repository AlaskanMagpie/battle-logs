import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { clipForRole } from "./glbPool";

/** Minimal clip with one moving position track (matches `movingTrackCount` heuristics in glbPool). */
function mkMovingClip(name: string): THREE.AnimationClip {
  const times = new Float32Array([0, 1]);
  const values = new Float32Array([0, 0, 0, 0.2, 0.1, 0]);
  const track = new THREE.VectorKeyframeTrack("Hips.position", [...times], [...values]);
  return new THREE.AnimationClip(name, 1, [track]);
}

describe("clipForRole explicit selection", () => {
  it("pins non-merged GLB by exact clip name from doctrine", () => {
    const idle = mkMovingClip("Armature|Idle");
    const run = mkMovingClip("Armature|Run");
    const file = "bastion_keep_compressed.glb";
    expect(clipForRole([run, idle], "idle", file, "Armature|Idle")).toBe(idle);
  });

  it("falls back to heuristics when explicit name missing", () => {
    const idle = mkMovingClip("Armature|Idle");
    const run = mkMovingClip("Armature|Run");
    const file = "bastion_keep_compressed.glb";
    const picked = clipForRole([run, idle], "idle", file, "Nope");
    expect(picked).not.toBeNull();
    expect(picked?.name).toBe("Armature|Idle");
  });
});
