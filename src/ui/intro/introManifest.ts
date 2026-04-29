export type IntroPage = {
  id: string;
  fallbackSrc: string;
  alt: string;
  holdMs?: number;
};

export type ResolvedIntroPage = IntroPage & {
  src: string;
};

const INTRO_ASSET_BASE = "/assets/intro";

export const INTRO_PAGE_DURATION_MS = 3500;
export const INTRO_SKIP_FAILSAFE_MS = 2000;
export const INTRO_HEAVY_GLB_TOP_N = 6;
export const INTRO_BGM_SRC = `${INTRO_ASSET_BASE}/bgm.ogg`;
export const INTRO_PAGE_EXTENSIONS = [".png", ".webp", ".jpg", ".jpeg", ".svg"] as const;

export const INTRO_PAGES: IntroPage[] = [
  {
    id: "page-01",
    fallbackSrc: `${INTRO_ASSET_BASE}/page-01.svg`,
    alt: "Doctrine — meet Idama",
  },
  {
    id: "page-02",
    fallbackSrc: `${INTRO_ASSET_BASE}/page-02.svg`,
    alt: "Doctrine — premise",
  },
  {
    id: "page-03",
    fallbackSrc: `${INTRO_ASSET_BASE}/page-03.svg`,
    alt: "Doctrine — how to play",
  },
];

export function introPageCandidateSrcs(page: IntroPage): string[] {
  return INTRO_PAGE_EXTENSIONS.map((ext) => `${INTRO_ASSET_BASE}/${page.id}${ext}`);
}
