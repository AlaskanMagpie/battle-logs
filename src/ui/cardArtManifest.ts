type CardArtManifest = {
  schemaVersion?: number;
  cards?: Record<string, string>;
};

let manifest: CardArtManifest | null | undefined;
let manifestPromise: Promise<CardArtManifest | null> | null = null;

async function loadCardArtManifest(): Promise<CardArtManifest | null> {
  if (manifest !== undefined) return manifest;
  if (!manifestPromise) {
    manifestPromise = (async () => {
      try {
        const res = await fetch("/assets/cards/manifest.json", { cache: "no-store" });
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

export async function getCardArtUrl(catalogId: string): Promise<string | null> {
  const m = await loadCardArtManifest();
  const url = m?.cards?.[catalogId];
  return url && url.length > 0 ? url : null;
}

export async function preloadCardArtManifest(): Promise<void> {
  await loadCardArtManifest();
}
