import * as THREE from "three";

/** Single supported “lite retarget” — strips bone position tracks except root hips (keeps rotations). */
export type ClipRetargetMode = "stripNonRootPosition";

export type ClipRetargetOverride = {
  /** `animationProfiles[].id` / catalog `producedUnitId` for the unit receiving the clip. */
  producedUnitId: string;
  /** Donor basename under `/assets/units/` (e.g. `lanternbound_line_dying.glb`). */
  donorFile: string;
  /** Which runtime role load this applies to (donor must be the file used for that role). */
  roles: readonly ("run" | "idle" | "attack" | "death")[];
  mode: ClipRetargetMode;
};

export type ClipRetargetManifestSlice = {
  clipRetargetOverrides?: readonly ClipRetargetOverride[] | undefined;
};

/** Bone path leaf before `.position` — root motion / vertical bounce often stay on Hips. */
function isRootHipsPositionTrack(trackName: string): boolean {
  const lower = trackName.toLowerCase();
  if (!lower.endsWith(".position")) return false;
  const path = trackName.slice(0, -".position".length);
  const leaf = path.split(/[|./\\]/u).pop() ?? path;
  const L = leaf.trim().toLowerCase();
  return L === "hips" || L === "mixamorig:hips" || L === "root";
}

/**
 * Removes non–root `.position` tracks so donor clips authored for different bone lengths
 * distort the mesh less (rotations still apply). Does not mutate the input clip.
 */
export function stripNonRootPositionTracks(clip: THREE.AnimationClip): THREE.AnimationClip {
  const kept = clip.tracks.filter((t) => {
    if (!/\.position$/i.test(t.name)) return true;
    return isRootHipsPositionTrack(t.name);
  });
  return new THREE.AnimationClip(clip.name, clip.duration, kept);
}

function isValidOverride(o: unknown): o is ClipRetargetOverride {
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  if (typeof r.producedUnitId !== "string" || !r.producedUnitId.trim()) return false;
  if (typeof r.donorFile !== "string" || !r.donorFile.endsWith(".glb")) return false;
  if (!Array.isArray(r.roles) || r.roles.length === 0) return false;
  const okRole = (x: unknown): x is "run" | "idle" | "attack" | "death" =>
    x === "run" || x === "idle" || x === "attack" || x === "death";
  if (!r.roles.every(okRole)) return false;
  return r.mode === "stripNonRootPosition";
}

/** Returns a new clip when a manifest override applies; otherwise returns `clip` unchanged. */
export function applyClipRetargetOverride(
  clip: THREE.AnimationClip,
  manifest: ClipRetargetManifestSlice | undefined,
  ctx: {
    producedUnitId: string | undefined;
    donorFile: string;
    role: "run" | "idle" | "attack" | "death";
  },
): THREE.AnimationClip {
  const list = manifest?.clipRetargetOverrides;
  if (!list?.length || !ctx.producedUnitId) return clip;
  for (const raw of list) {
    if (!isValidOverride(raw)) continue;
    if (raw.producedUnitId !== ctx.producedUnitId) continue;
    if (raw.donorFile !== ctx.donorFile) continue;
    if (!raw.roles.includes(ctx.role)) continue;
    if (raw.mode === "stripNonRootPosition") return stripNonRootPositionTracks(clip);
  }
  return clip;
}
