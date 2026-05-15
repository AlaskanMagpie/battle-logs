import type { UnitSizeClass } from "./types";

const previewByCatalogId: Partial<Record<string, UnitSizeClass>> = {};

/**
 * Asset lab only: override spawned `UnitSizeClass` for GLB routing + card stat overlay preview.
 * Does not change sim / catalog data.
 */
export function setAssetLabProducedSizeClassPreview(catalogId: string, sizeClass: UnitSizeClass | null): void {
  if (sizeClass == null) delete previewByCatalogId[catalogId];
  else previewByCatalogId[catalogId] = sizeClass;
}

export function getAssetLabProducedSizeClassPreview(catalogId: string): UnitSizeClass | undefined {
  return previewByCatalogId[catalogId];
}

export function effectiveProducedSizeClassForAssetLab(catalogId: string, catalogClass: UnitSizeClass): UnitSizeClass {
  return previewByCatalogId[catalogId] ?? catalogClass;
}
