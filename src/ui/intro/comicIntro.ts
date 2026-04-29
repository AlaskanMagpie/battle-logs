import { INTRO_BGM_SRC, INTRO_PAGES, introPageCandidateSrcs, type IntroPage, type ResolvedIntroPage } from "./introManifest";

const INTRO_BGM_KEY = "intro:bgm";
const COMIC_FIT_KEY = "intro:comicFit";
type ComicFitMode = "width" | "screen";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.15;

function storageGet(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    /* ignore private-mode storage failures */
  }
}

function fallbackPages(): ResolvedIntroPage[] {
  return INTRO_PAGES.map((page) => ({ ...page, src: page.fallbackSrc }));
}

function preloadImage(src: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(src);
    img.onerror = () => reject(new Error(`comic image failed: ${src}`));
    img.src = src;
  });
}

async function resolveIntroPage(page: IntroPage): Promise<ResolvedIntroPage> {
  for (const src of introPageCandidateSrcs(page)) {
    try {
      await preloadImage(src);
      return { ...page, src };
    } catch {
      /* try next extension */
    }
  }
  return { ...page, src: page.fallbackSrc };
}

/** Resize the bordered frame to each page’s intrinsic aspect (viewport letterbox, no squish). */
function syncComicFrameAspect(pageWrap: HTMLElement, image: HTMLImageElement): void {
  const apply = (): void => {
    const w = image.naturalWidth;
    const h = image.naturalHeight;
    if (w <= 0 || h <= 0) return;
    pageWrap.style.setProperty("--comic-aw", String(w));
    pageWrap.style.setProperty("--comic-ah", String(h));
  };
  if (image.complete) apply();
  else image.addEventListener("load", apply, { once: true });
}

let activeComicPromise: Promise<void> | null = null;

export function showComicLoreModal(): Promise<void> {
  if (activeComicPromise) return activeComicPromise;
  const root = document.querySelector<HTMLElement>("#comic-intro") ?? document.createElement("div");
  if (!root.id) {
    root.id = "comic-intro";
    document.body.prepend(root);
  }

  activeComicPromise = new Promise<void>((resolve) => {
    let pages = fallbackPages();
    let pageIndex = 0;
    let dismissed = false;
    let fitMode: ComicFitMode = storageGet(localStorage, COMIC_FIT_KEY) === "screen" ? "screen" : "width";
    let comicUserZoom = 1;
    let audio: HTMLAudioElement | null = null;
    let keyHandler: ((ev: KeyboardEvent) => void) | null = null;
    let rootClickHandler: ((ev: MouseEvent) => void) | null = null;
    let wheelHandler: ((ev: WheelEvent) => void) | null = null;

    root.innerHTML = `
      <section class="comic-intro comic-intro--manual" role="dialog" aria-modal="true" aria-label="Lore and how to play comic">
        <div class="comic-intro__scroll">
          <div class="comic-intro__page-wrap" data-page-hitbox>
            <img class="comic-intro__page" alt="" draggable="false" />
          </div>
        </div>
        <div class="comic-intro__chrome">
          <div class="comic-intro__count" aria-live="polite"></div>
          <div class="comic-intro__controls">
            <button type="button" class="comic-intro__fit-toggle">Fit screen</button>
            <button type="button" class="comic-intro__zoom-out" title="Zoom out (scroll wheel; add Ctrl/⌘/Alt if the page is scrolling)">−</button>
            <button type="button" class="comic-intro__zoom-reset" title="Reset zoom">100%</button>
            <button type="button" class="comic-intro__zoom-in" title="Zoom in">+</button>
            <button type="button" class="comic-intro__bgm" aria-pressed="false">BGM Off</button>
            <button type="button" class="comic-intro__prev">Prev</button>
            <button type="button" class="comic-intro__next">Next</button>
            <button type="button" class="comic-intro__skip">Close</button>
          </div>
        </div>
      </section>
    `;

    const shell = root.querySelector<HTMLElement>(".comic-intro")!;
    const scrollEl = root.querySelector<HTMLElement>(".comic-intro__scroll")!;
    const pageWrap = root.querySelector<HTMLElement>(".comic-intro__page-wrap")!;
    const img = root.querySelector<HTMLImageElement>(".comic-intro__page")!;
    const count = root.querySelector<HTMLElement>(".comic-intro__count")!;
    const skipButton = root.querySelector<HTMLButtonElement>(".comic-intro__skip")!;
    const prevButton = root.querySelector<HTMLButtonElement>(".comic-intro__prev")!;
    const nextButton = root.querySelector<HTMLButtonElement>(".comic-intro__next")!;
    const bgmButton = root.querySelector<HTMLButtonElement>(".comic-intro__bgm")!;
    const fitToggle = root.querySelector<HTMLButtonElement>(".comic-intro__fit-toggle")!;
    const zoomOutBtn = root.querySelector<HTMLButtonElement>(".comic-intro__zoom-out")!;
    const zoomResetBtn = root.querySelector<HTMLButtonElement>(".comic-intro__zoom-reset")!;
    const zoomInBtn = root.querySelector<HTMLButtonElement>(".comic-intro__zoom-in")!;

    const stopAudio = (): void => {
      if (!audio) return;
      audio.pause();
      audio.currentTime = 0;
      audio = null;
    };

    const syncFitClasses = (): void => {
      shell.classList.toggle("comic-intro--fit-width", fitMode === "width");
      shell.classList.toggle("comic-intro--fit-screen", fitMode === "screen");
    };

    const syncFitToggleLabel = (): void => {
      fitToggle.textContent = fitMode === "width" ? "Fit screen" : "Fill width";
      fitToggle.setAttribute(
        "title",
        fitMode === "width"
          ? "Show the whole page inside the window (smaller on wide displays)"
          : "Use almost full window width; scroll vertically when the page is tall",
      );
    };

    const syncZoomLabel = (): void => {
      const pct = Math.round(comicUserZoom * 100);
      zoomResetBtn.textContent = pct === 100 ? "100%" : `${pct}%`;
    };

    const applyZoom = (): void => {
      shell.style.setProperty("--comic-user-zoom", String(comicUserZoom));
      syncZoomLabel();
    };

    const completeDismissal = (): void => {
      if (dismissed) return;
      dismissed = true;
      if (wheelHandler) {
        scrollEl.removeEventListener("wheel", wheelHandler);
        wheelHandler = null;
      }
      if (keyHandler) {
        window.removeEventListener("keydown", keyHandler);
        keyHandler = null;
      }
      if (rootClickHandler) {
        root.removeEventListener("click", rootClickHandler);
        rootClickHandler = null;
      }
      stopAudio();
      shell.classList.add("comic-intro--leaving");
      window.setTimeout(() => {
        root.innerHTML = "";
        activeComicPromise = null;
        resolve();
      }, 180);
    };

    const renderPage = (): void => {
      const page = pages[pageIndex] ?? pages[0]!;
      img.alt = page.alt;
      img.src = page.src;
      comicUserZoom = 1;
      applyZoom();
      syncComicFrameAspect(pageWrap, img);
      count.textContent = `Page ${pageIndex + 1} / ${pages.length}`;
      prevButton.disabled = pageIndex <= 0;
      nextButton.textContent = pageIndex >= pages.length - 1 ? "Done" : "Next";
    };

    const advance = (): void => {
      if (pageIndex >= pages.length - 1) {
        completeDismissal();
        return;
      }
      pageIndex += 1;
      renderPage();
    };

    const retreat = (): void => {
      if (pageIndex <= 0) return;
      pageIndex -= 1;
      renderPage();
    };

    const syncBgmButton = (): void => {
      const enabled = storageGet(localStorage, INTRO_BGM_KEY) === "1";
      bgmButton.setAttribute("aria-pressed", enabled ? "true" : "false");
      bgmButton.textContent = enabled ? "BGM On" : "BGM Off";
    };

    const tryStartAudio = (): void => {
      stopAudio();
      audio = new Audio(INTRO_BGM_SRC);
      audio.loop = true;
      audio.volume = 0.4;
      void audio.play().catch(() => {
        stopAudio();
        storageSet(localStorage, INTRO_BGM_KEY, "0");
        syncBgmButton();
      });
    };

    rootClickHandler = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target?.closest("button")) return;
      advance();
    };
    root.addEventListener("click", rootClickHandler);

    skipButton.addEventListener("click", completeDismissal);
    prevButton.addEventListener("click", retreat);
    nextButton.addEventListener("click", advance);
    bgmButton.addEventListener("click", () => {
      const next = storageGet(localStorage, INTRO_BGM_KEY) === "1" ? "0" : "1";
      storageSet(localStorage, INTRO_BGM_KEY, next);
      syncBgmButton();
      if (next === "1") tryStartAudio();
      else stopAudio();
    });

    syncFitClasses();
    syncFitToggleLabel();
    applyZoom();

    fitToggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      fitMode = fitMode === "width" ? "screen" : "width";
      storageSet(localStorage, COMIC_FIT_KEY, fitMode);
      syncFitClasses();
      syncFitToggleLabel();
    });

    zoomOutBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      comicUserZoom = Math.max(ZOOM_MIN, comicUserZoom - ZOOM_STEP);
      applyZoom();
    });
    zoomInBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      comicUserZoom = Math.min(ZOOM_MAX, comicUserZoom + ZOOM_STEP);
      applyZoom();
    });
    zoomResetBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      comicUserZoom = 1;
      applyZoom();
    });

    wheelHandler = (ev: WheelEvent): void => {
      const canScrollY = scrollEl.scrollHeight > scrollEl.clientHeight + 2;
      const canScrollX = scrollEl.scrollWidth > scrollEl.clientWidth + 2;
      const modifierZoom = ev.ctrlKey || ev.metaKey || ev.altKey;
      // After "Fit screen", content often fits exactly — no overflow so native wheel does nothing.
      // Treat wheel as zoom whenever the pane cannot scroll; keep plain wheel = scroll when it can.
      const useWheelForZoom = modifierZoom || (!canScrollY && !canScrollX);
      if (!useWheelForZoom) return;
      ev.preventDefault();
      const dir = ev.deltaY > 0 ? 1 : -1;
      const factor = Math.exp(-dir * 0.18);
      comicUserZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, comicUserZoom * factor));
      applyZoom();
    };
    scrollEl.addEventListener("wheel", wheelHandler, { passive: false });

    keyHandler = (ev: KeyboardEvent) => {
      if (dismissed) return;
      if (ev.key === "Escape") {
        ev.preventDefault();
        completeDismissal();
      } else if (ev.key === "ArrowRight" || ev.key === "PageDown") {
        ev.preventDefault();
        advance();
      } else if (ev.key === "ArrowLeft" || ev.key === "PageUp") {
        ev.preventDefault();
        retreat();
      } else if ((ev.key === "+" || ev.key === "=") && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        comicUserZoom = Math.min(ZOOM_MAX, comicUserZoom + ZOOM_STEP);
        applyZoom();
      } else if ((ev.key === "-" || ev.key === "_") && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        comicUserZoom = Math.max(ZOOM_MIN, comicUserZoom - ZOOM_STEP);
        applyZoom();
      } else if (ev.key === "0" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        comicUserZoom = 1;
        applyZoom();
      }
    };
    window.addEventListener("keydown", keyHandler);

    syncBgmButton();
    if (storageGet(localStorage, INTRO_BGM_KEY) === "1") tryStartAudio();
    renderPage();
    void Promise.all(INTRO_PAGES.map(resolveIntroPage)).then(
      (resolvedPages) => {
        if (dismissed) return;
        pages = resolvedPages.length ? resolvedPages : pages;
        pageIndex = Math.min(pageIndex, pages.length - 1);
        renderPage();
      },
      () => {
        /* fallback pages are already visible */
      },
    );
  });

  return activeComicPromise;
}
