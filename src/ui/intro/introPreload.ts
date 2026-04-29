import { DEFAULT_MAP_URL } from "../../game/loadMap";
import {
  INTRO_HEAVY_GLB_TOP_N,
  INTRO_PAGES,
  introPageCandidateSrcs,
  type IntroPage,
  type ResolvedIntroPage,
} from "./introManifest";

type UnitGlbManifest = {
  files?: string[];
};

type FetchPriorityInit = RequestInit & {
  priority?: "high" | "low" | "auto";
};

const imagePreloadCache = new Map<string, Promise<string>>();

function preloadImage(src: string): Promise<string> {
  let cached = imagePreloadCache.get(src);
  if (!cached) {
    cached = new Promise<string>((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(src);
      img.onerror = () => reject(new Error(`intro image load failed: ${src}`));
      img.src = src;
    });
    imagePreloadCache.set(src, cached);
  }
  return cached;
}

async function resolveIntroPage(page: IntroPage): Promise<ResolvedIntroPage> {
  for (const src of introPageCandidateSrcs(page)) {
    try {
      await preloadImage(src);
      return { ...page, src };
    } catch {
      /* try the next preferred extension */
    }
  }
  return { ...page, src: page.fallbackSrc };
}

async function preloadMapShell(): Promise<void> {
  try {
    await fetch(DEFAULT_MAP_URL, { cache: "force-cache" });
  } catch {
    /* map load still has its normal runtime error path */
  }
}

export async function preloadCritical(): Promise<{ pages: ResolvedIntroPage[] }> {
  const [pages] = await Promise.all([Promise.all(INTRO_PAGES.map(resolveIntroPage)), preloadMapShell()]);
  return { pages };
}

async function glbContentLength(file: string): Promise<{ file: string; bytes: number }> {
  try {
    const res = await fetch(`/assets/units/${file}`, { method: "HEAD", cache: "force-cache" });
    const bytes = Number(res.headers.get("content-length") ?? 0);
    return { file, bytes: Number.isFinite(bytes) ? bytes : 0 };
  } catch {
    return { file, bytes: 0 };
  }
}

async function topHeavyGlbs(files: string[]): Promise<string[]> {
  const sized = await Promise.all(files.map(glbContentLength));
  return sized
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, INTRO_HEAVY_GLB_TOP_N)
    .map((entry) => entry.file);
}

export async function warmupHeavyGlbs(): Promise<void> {
  try {
    const res = await fetch("/assets/units/manifest.json", { cache: "force-cache" });
    if (!res.ok) return;
    const manifest = (await res.json()) as UnitGlbManifest;
    const files = (manifest.files ?? []).filter((file) => file.endsWith(".glb"));
    if (!files.length) return;
    const candidates = await topHeavyGlbs(files);
    await Promise.allSettled(
      candidates.map((file) =>
        fetch(`/assets/units/${file}`, {
          cache: "force-cache",
          priority: "low",
        } satisfies FetchPriorityInit),
      ),
    );
  } catch {
    /* warmup is opportunistic */
  }
}
