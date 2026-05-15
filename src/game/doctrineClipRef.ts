/**
 * Asset Lab stores merged clip labels as `glbStem — rawClipName` (em dash, same as `src/dev/assetLab.ts`).
 * At runtime, donor GLB + raw clip name override manifest routing when the donor exists in `manifest.json` `files`.
 */

/** Separator between GLB stem and raw clip name in merged doctrine labels (space + U+2014 + space). */
export const DOCTRINE_MERGED_LABEL_SEP = " \u2014 ";

export type ParsedDoctrineClipRef = {
  /** Donor basename under `/assets/units/`, e.g. `lanternbound_line_dying.glb`, or null for legacy single-file refs. */
  donorFile: string | null;
  /** Raw clip name inside that GLB’s `gltf.animations[].name`. */
  clipName: string;
};

/**
 * Parse a saved `unitClips` string. Legacy values (no merged separator) use manifest-routed GLBs only.
 */
export function parseDoctrineClipRef(raw: string | undefined | null): ParsedDoctrineClipRef | null {
  if (raw == null) return null;
  const value = raw.trim();
  if (!value) return null;
  const idx = value.indexOf(DOCTRINE_MERGED_LABEL_SEP);
  if (idx === -1) return { donorFile: null, clipName: value };
  const stem = value.slice(0, idx).trim();
  const clipName = value.slice(idx + DOCTRINE_MERGED_LABEL_SEP.length).trim();
  if (!stem) return { donorFile: null, clipName: value };
  return { donorFile: `${stem}.glb`, clipName: clipName.length > 0 ? clipName : value };
}

export function donorFileIsInManifest(donorFile: string, manifestFiles: readonly string[]): boolean {
  return manifestFiles.includes(donorFile);
}
