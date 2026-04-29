type CardArtManifest = {
  schemaVersion?: number;
  cards?: Record<string, string>;
};

/**
 * Bump when changing `public/assets/cards/manifest.json` or any card file so browsers
 * cannot keep stale `/assets/cards/*` responses across refreshes.
 */
export const CARD_ART_CACHE_BUSTER = "20";

let manifest: CardArtManifest | null | undefined;
let manifestPromise: Promise<CardArtManifest | null> | null = null;

function withCardArtBust(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}cb=${CARD_ART_CACHE_BUSTER}`;
}

async function loadCardArtManifest(): Promise<CardArtManifest | null> {
  if (manifest !== undefined) return manifest;
  if (!manifestPromise) {
    manifestPromise = (async () => {
      try {
        const res = await fetch(`/assets/cards/manifest.json?cb=${CARD_ART_CACHE_BUSTER}`, { cache: "no-store" });
        if (!res.ok) return null;
        const parsed = (await res.json()) as CardArtManifest;
        return parsed;
      } catch {
        return null;
      }
    })()
      .then((m) => {
        manifest = m;
        return m;
      })
      .finally(() => {
        manifestPromise = null;
      });
  }
  return manifestPromise;
}

/** Clear cached manifest (e.g. binder open) so the next read refetches JSON. */
export function resetCardArtManifestCache(): void {
  manifest = undefined;
  manifestPromise = null;
}

const CARD_ART_EXTS = [".png", ".webp", ".jpg", ".jpeg", ".svg"] as const;

/** Dev-only: find `public/assets/cards/{id}.ext` if missing from manifest (saves a sync pass). */
async function findCardArtByConvention(catalogId: string): Promise<string | null> {
  if (!import.meta.env.DEV) return null;
  for (const ext of CARD_ART_EXTS) {
    const path = `/assets/cards/${catalogId}${ext}`;
    try {
      const r = await fetch(path, { method: "HEAD", cache: "no-store" });
      if (r.ok) return withCardArtBust(path);
    } catch {
      /* ignore */
    }
  }
  return null;
}

export async function getCardArtUrl(catalogId: string): Promise<string | null> {
  const m = await loadCardArtManifest();
  const fromManifest = m?.cards?.[catalogId];
  if (fromManifest && fromManifest.length > 0) return withCardArtBust(fromManifest);
  return findCardArtByConvention(catalogId);
}

export async function preloadCardArtManifest(): Promise<void> {
  await loadCardArtManifest();
}
