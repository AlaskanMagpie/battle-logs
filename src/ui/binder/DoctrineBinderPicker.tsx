import * as THREE from "three";
import type { ReactElement } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CATALOG, DEFAULT_DOCTRINE_SLOTS, getCatalogEntry } from "../../game/catalog";
import { getControlProfile } from "../../controlProfile";
import { DOCTRINE_SLOT_COUNT } from "../../game/constants";
import { normalizeDoctrineSlotsForMatch } from "../../game/state";
import { DEFAULT_MAP_URL, MAP_REGISTRY } from "../../game/loadMap";
import { fillDoctrineSlotsWithDuplicatePicks, QUICK_MATCH_DOCTRINE_SLOTS } from "../../game/quickMatchDoctrine";
import {
  buildReturnPortalUrlForPrematch,
  buildVibeJamExitUrlForPrematch,
  type PortalContext,
} from "../../game/portal";
import { hydrateCardPreviewImages, preloadCardPreviewDataUrls } from "../cardGlbPreview";
import { resetCardArtManifestCache } from "../cardArtManifest";
import {
  CARD_PREVIEW_BINDER_HAND_MS,
  CARD_PREVIEW_BINDER_HAND_SLOP_PX,
  closeDoctrineCardDetail,
  showDoctrineCardDetail,
} from "../cardDetailPop";
import { doctrineSlotButtonInnerHtml, tcgCardSlotHtml } from "../doctrineCard";
import { attachDoctrineHandPeek } from "../hud";
import { showComicLoreModal } from "../intro/comicIntro";
import { doctrineSlotHudTone } from "../doctrineSlotHudTone";
import { loadDoctrinePickerState, saveDoctrinePickerState } from "../doctrineStorage";
import { getBinderTextureForCatalogId } from "./binderCardTexture";
import {
  BINDER_CELLS_PER_PAGE,
  BINDER_CELLS_PER_SHEET,
  BINDER_CODEX_TOTAL_CELLS,
  BINDER_COLS,
  BINDER_ROWS,
  CardBinderEngine,
  makeEmptyBinderPanelCanvas,
  type CodexPointerDragEvent,
} from "./CardBinderEngine";
import { BinderLayoutCalibratePanel } from "./BinderLayoutCalibratePanel";
import { BINDER_PREMATCH_GOALS_HTML, MATCH_HELP_INNER_HTML } from "../matchHelpContent";
import { sortPickerHandByFluxCost } from "./doctrinePickerHandSort";
import "./binderPicker.css";

/** Dev-only: 3D room layout sliders. No in-app entry point unless `?binderCalibrate=1` is in the URL. */
function isBinderLayoutCalibrateMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("binderCalibrate") === "1";
}

const FULL_ART_STRUCTURE_CARD_IDS = [
  "outpost",
  "watchtower",
  "bastion_keep",
  "verdant_citadel",
] as const;
const COMMAND_CARD_IDS = CATALOG.filter((c) => c.kind === "command").map((c) => c.id);
/** Codex panel order: updated visual structure cards + legacy spell/command placeholders only. */
const BINDER_GRID_CATALOG_IDS: readonly string[] = [...FULL_ART_STRUCTURE_CARD_IDS, ...COMMAND_CARD_IDS];
const MAP_URL_STORAGE_KEY = "signalWarsMapUrl.v2";
const LEGACY_MAP_URL_STORAGE_KEY = "signalWarsMapUrl";
const validIds = new Set(BINDER_GRID_CATALOG_IDS);
const validMapUrls = new Set(MAP_REGISTRY.map((m) => m.url));
const MIN_FILLED = 4;
/** Long-press on the tome hint strip to open goals + controls without resizing the 3D view. */
const BINDER_HOWTO_HOLD_MS = 480;
/** Open to the first true two-page spread; hydrate enough cells that both visible halves have real card art. */
const BINDER_INITIAL_SPREAD_INDEX = 1;
const BINDER_INITIAL_ART_CELLS = BINDER_CELLS_PER_SHEET + BINDER_CELLS_PER_PAGE;
const QUICK_PICK_IDS: readonly string[] = [
  "outpost",
  "watchtower",
  "bastion_keep",
  "verdant_citadel",
  "firestorm",
  "fortify",
  "recycle",
  "shatter",
];

function makeDeferredBinderTexture(): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(makeEmptyBinderPanelCanvas());
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 2;
  return t;
}

function afterIdle(fn: () => void): void {
  const idle = window.requestIdleCallback;
  if (idle) {
    idle(fn, { timeout: 220 });
    return;
  }
  window.setTimeout(fn, 32);
}

function padDoctrineSlotsLocal(row: (string | null)[]): (string | null)[] {
  const a = row.length > DOCTRINE_SLOT_COUNT ? row.slice(0, DOCTRINE_SLOT_COUNT) : [...row];
  while (a.length < DOCTRINE_SLOT_COUNT) a.push(null);
  return a;
}

function pointInRect(clientX: number, clientY: number, r: DOMRect): boolean {
  return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
}

function slotUnderPointerInTrack(clientX: number, clientY: number, track: HTMLElement): number | null {
  const stack = document.elementsFromPoint(clientX, clientY);
  for (const el of stack) {
    if (!(el instanceof Element)) continue;
    const slot = el.closest("[data-slot-index]");
    if (!(slot instanceof HTMLElement) || !track.contains(slot)) continue;
    const si = Number(slot.dataset.slotIndex);
    if (Number.isFinite(si) && si >= 0 && si < DOCTRINE_SLOT_COUNT) return si;
  }
  return null;
}

function swapBinderSlotPicks(
  picks: readonly (number | null)[] | undefined,
  a: number,
  b: number,
): (number | null)[] {
  const out: (number | null)[] = Array.from(
    { length: DOCTRINE_SLOT_COUNT },
    (_, i) => (i < (picks?.length ?? 0) ? picks![i] ?? null : null),
  );
  for (let i = 0; i < DOCTRINE_SLOT_COUNT; i++) {
    if (out[i] === a) out[i] = b;
    else if (out[i] === b) out[i] = a;
  }
  return out;
}

/** Catalog ids pinned to the **first codex cell** (recto top-left) so key cards are always on page 1. */
const CODEX_PIN_FIRST_SLOT: readonly string[] = ["watchtower"];

const BINDER_SHEET_COUNT = BINDER_CODEX_TOTAL_CELLS / BINDER_CELLS_PER_SHEET;

/** Local panel index 0–17 on one sheet: row-major 3×3 recto then 3×3 verso; includes spine neighbors (2↔9, 5↔12, 8↔15). */
function binderLocalNeighborLocals(local: number): readonly number[] {
  const pageOffset = local < BINDER_CELLS_PER_PAGE ? 0 : BINDER_CELLS_PER_PAGE;
  const loc = local - pageOffset;
  const row = Math.floor(loc / BINDER_COLS);
  const col = loc % BINDER_COLS;
  const n: number[] = [];
  if (col > 0) n.push(local - 1);
  if (col < BINDER_COLS - 1) n.push(local + 1);
  if (row > 0) n.push(local - BINDER_COLS);
  if (row < BINDER_ROWS - 1) n.push(local + BINDER_COLS);
  if (pageOffset === 0 && col === BINDER_COLS - 1) n.push(BINDER_CELLS_PER_PAGE + row * BINDER_COLS);
  if (pageOffset === BINDER_CELLS_PER_PAGE && col === 0) n.push(row * BINDER_COLS + (BINDER_COLS - 1));
  return n;
}

/** Precompute undirected edges within each sheet (each pair once, smaller index first). */
const BINDER_SHEET_EDGE_PAIRS: readonly (readonly [number, number])[] = (() => {
  const pairs: [number, number][] = [];
  const seen = new Set<string>();
  for (let local = 0; local < BINDER_CELLS_PER_SHEET; local++) {
    for (const nb of binderLocalNeighborLocals(local)) {
      const a = Math.min(local, nb);
      const b = Math.max(local, nb);
      const key = `${a},${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([a, b]);
    }
  }
  return pairs;
})();

function scoreBinderCodexLayout(ids: readonly string[]): number {
  let adjacentSame = 0;
  for (let s = 0; s < BINDER_SHEET_COUNT; s++) {
    const base = s * BINDER_CELLS_PER_SHEET;
    for (const [la, lb] of BINDER_SHEET_EDGE_PAIRS) {
      if (ids[base + la] === ids[base + lb]) adjacentSame++;
    }
  }
  let pageBalance = 0;
  for (let s = 0; s < BINDER_SHEET_COUNT; s++) {
    const base = s * BINDER_CELLS_PER_SHEET;
    const left = new Map<string, number>();
    const right = new Map<string, number>();
    for (let k = 0; k < BINDER_CELLS_PER_PAGE; k++) {
      const id = ids[base + k]!;
      left.set(id, (left.get(id) ?? 0) + 1);
    }
    for (let k = 0; k < BINDER_CELLS_PER_PAGE; k++) {
      const id = ids[base + BINDER_CELLS_PER_PAGE + k]!;
      right.set(id, (right.get(id) ?? 0) + 1);
    }
    const idsOnSheet = new Set<string>([...left.keys(), ...right.keys()]);
    for (const id of idsOnSheet) {
      pageBalance += Math.abs((left.get(id) ?? 0) - (right.get(id) ?? 0));
    }
  }
  return adjacentSame * 100 + pageBalance;
}

function fisherYates<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

/**
 * Hill-climb: swap pairs (slot 0 fixed when `fixedIndex === 0`) to reduce same-card neighbors on each sheet
 * (including across the spine) and balance repeats left vs right page.
 */
function optimizeBinderCodexLayout(out: string[], fixedIndex: number | null): void {
  const n = out.length;
  const swapRangeLo = fixedIndex === 0 ? 1 : 0;
  const swapRangeHi = n - 1;
  if (swapRangeHi < swapRangeLo) return;

  let best = scoreBinderCodexLayout(out);
  const maxIter = 14000;
  for (let iter = 0; iter < maxIter; iter++) {
    const i = swapRangeLo + Math.floor(Math.random() * (swapRangeHi - swapRangeLo + 1));
    const j = swapRangeLo + Math.floor(Math.random() * (swapRangeHi - swapRangeLo + 1));
    if (i === j) continue;
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
    const next = scoreBinderCodexLayout(out);
    if (next <= best) {
      best = next;
    } else {
      out[i] = a;
      out[j] = b;
    }
  }
}

const BINDER_LAYOUT_RESTARTS = 4;

/** One texture index per duplex slot (`BINDER_CODEX_TOTAL_CELLS`); repeats when the catalog is smaller than the grid. */
function buildShuffledBinderPanelIds(baseIds: readonly string[]): string[] {
  if (baseIds.length === 0) return [];
  const rotated = [...baseIds];
  fisherYates(rotated);
  const multiset: string[] = [];
  for (let i = 0; i < BINDER_CODEX_TOTAL_CELLS; i++) {
    multiset.push(rotated[i % rotated.length]!);
  }

  let pinId: string | null = null;
  for (const pid of CODEX_PIN_FIRST_SLOT) {
    if (baseIds.includes(pid)) {
      pinId = pid;
      break;
    }
  }

  let bestOut: string[] | null = null;
  let bestScore = Infinity;

  const pinOk = pinId !== null && multiset.includes(pinId);

  const consider = (candidate: string[]): void => {
    optimizeBinderCodexLayout(candidate, pinOk ? 0 : null);
    const sc = scoreBinderCodexLayout(candidate);
    if (sc < bestScore) {
      bestScore = sc;
      bestOut = [...candidate];
    }
  };

  if (pinOk && pinId !== null) {
    const basePool = [...multiset];
    const at = basePool.indexOf(pinId);
    basePool.splice(at, 1);
    for (let r = 0; r < BINDER_LAYOUT_RESTARTS; r++) {
      const fill = [...basePool];
      fisherYates(fill);
      const candidate = new Array<string>(BINDER_CODEX_TOTAL_CELLS);
      candidate[0] = pinId;
      for (let i = 0; i < fill.length; i++) {
        candidate[i + 1] = fill[i]!;
      }
      consider(candidate);
    }
  } else {
    for (let r = 0; r < BINDER_LAYOUT_RESTARTS; r++) {
      const candidate = [...multiset];
      fisherYates(candidate);
      consider(candidate);
    }
  }

  return bestOut ?? [...multiset];
}

export function DoctrineBinderPicker({
  onStart,
  onReady,
  portalContext = { enteredViaPortal: false, params: {}, ref: null },
}: {
  onStart: (slots: (string | null)[], mapUrl: string) => void;
  onReady?: () => void;
  portalContext?: PortalContext;
}): ReactElement {
  const prematchVibeJamHref = useMemo(
    () =>
      typeof window !== "undefined"
        ? buildVibeJamExitUrlForPrematch(portalContext, window.location.href)
        : "https://vibejam.cc/portal/2026",
    [portalContext],
  );
  const prematchReturnHref = useMemo(
    () => (typeof window !== "undefined" ? buildReturnPortalUrlForPrematch(portalContext, window.location.href) : null),
    [portalContext],
  );
  const controlProfile = useMemo(() => getControlProfile(), []);
  const layoutCalibrateAllowed = useMemo(isBinderLayoutCalibrateMode, []);
  const [roomLayoutTunerOpen, setRoomLayoutTunerOpen] = useState(isBinderLayoutCalibrateMode);

  const orderedRef = useRef<string[]>([...BINDER_GRID_CATALOG_IDS]);
  /** Parallel to `orderedRef` — the live texture array passed to `CardBinderEngine.setTextures` (incl. swaps). */
  const binderPanelTexturesRef = useRef<THREE.Texture[] | null>(null);
  const initialPicker = useMemo(() => loadDoctrinePickerState(), []);
  const [slots, setSlots] = useState<(string | null)[]>(() =>
    normalizeDoctrineSlotsForMatch(
      padDoctrineSlotsLocal(initialPicker.slots.map((id) => (id && validIds.has(id) ? id : null))),
    ),
  );
  const [binderSlotPick, setBinderSlotPick] = useState<(number | null)[]>(() => [
    ...initialPicker.binderSlotPickIndex,
  ]);
  const [activeDoctrineSlot, setActiveDoctrineSlot] = useState<number | null>(null);
  const activeDoctrineSlotRef = useRef<number | null>(null);
  activeDoctrineSlotRef.current = activeDoctrineSlot;
  const [loading, setLoading] = useState(true);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [page, setPage] = useState({ c: 0, t: 1 });
  const [mapUrl, setMapUrl] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(MAP_URL_STORAGE_KEY);
      return saved && validMapUrls.has(saved) ? saved : DEFAULT_MAP_URL;
    } catch {
      return DEFAULT_MAP_URL;
    }
  });
  /** Map / page nav / start — floating panel so the binder stays full-bleed. */
  const [prematchSetupOpen, setPrematchSetupOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** Full doctrine strip (wrap + padding) — generous `getBoundingClientRect` for codex drop hit-testing. */
  const doctrineStripHitRef = useRef<HTMLDivElement>(null);
  const handTrackRef = useRef<HTMLDivElement>(null);
  const handRowRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<CardBinderEngine | null>(null);
  const [binderEngineForUi, setBinderEngineForUi] = useState<CardBinderEngine | null>(null);
  /** Two quick taps on the same catalog cell open full rules (pointer-first; complements dblclick). */
  const detailTapRef = useRef<{ t: number; idx: number | null }>({ t: 0, idx: null });
  const codexDragBusyRef = useRef(false);

  const [codexDrag, setCodexDrag] = useState<{ catalogId: string } | null>(null);
  const codexDragPosRef = useRef({ x: 0, y: 0 });
  const codexGhostRef = useRef<HTMLDivElement | null>(null);
  const [dragOverSlot, setDragOverSlot] = useState<number | null>(null);
  const [dragOverHandZone, setDragOverHandZone] = useState(false);
  const [portalTransitioning, setPortalTransitioning] = useState(false);
  const [portalExitConfirmOpen, setPortalExitConfirmOpen] = useState(false);
  const [quickfillConfirmOpen, setQuickfillConfirmOpen] = useState(false);
  const [binderHowToOpen, setBinderHowToOpen] = useState(false);
  const [tomeHintPressed, setTomeHintPressed] = useState(false);
  const binderHowToOpenRef = useRef(false);
  binderHowToOpenRef.current = binderHowToOpen;
  const quickfillConfirmOpenRef = useRef(false);
  quickfillConfirmOpenRef.current = quickfillConfirmOpen;
  const binderHowToHoldTimerRef = useRef<number | null>(null);

  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const binderSlotPickRef = useRef(binderSlotPick);
  binderSlotPickRef.current = binderSlotPick;
  const mapUrlRef = useRef(mapUrl);
  mapUrlRef.current = mapUrl;

  const filledCount = slots.filter(Boolean).length;
  const canStart = filledCount >= MIN_FILLED;

  /** Force refetch card manifest + bust `/assets/cards/*` cache each visit (browser loves to cache JSON/SVG). */
  useEffect(() => {
    resetCardArtManifestCache();
  }, []);

  const clearBinderHowToHoldTimer = useCallback(() => {
    if (binderHowToHoldTimerRef.current != null) {
      window.clearTimeout(binderHowToHoldTimerRef.current);
      binderHowToHoldTimerRef.current = null;
    }
  }, []);

  const moveCodexGhost = useCallback((clientX: number, clientY: number) => {
    codexDragPosRef.current = { x: clientX, y: clientY };
    const ghost = codexGhostRef.current;
    if (!ghost) return;
    ghost.style.left = `${clientX + 14}px`;
    ghost.style.top = `${clientY + 14}px`;
  }, []);

  const onTomeHintPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (loading || binderHowToOpenRef.current) return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      setTomeHintPressed(true);
      clearBinderHowToHoldTimer();
      binderHowToHoldTimerRef.current = window.setTimeout(() => {
        binderHowToHoldTimerRef.current = null;
        setTomeHintPressed(false);
        setBinderHowToOpen(true);
      }, BINDER_HOWTO_HOLD_MS);
    },
    [loading, clearBinderHowToHoldTimer],
  );

  const onTomeHintPointerEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      setTomeHintPressed(false);
      clearBinderHowToHoldTimer();
    },
    [clearBinderHowToHoldTimer],
  );

  useEffect(() => () => clearBinderHowToHoldTimer(), [clearBinderHowToHoldTimer]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (quickfillConfirmOpenRef.current) {
          e.preventDefault();
          setQuickfillConfirmOpen(false);
          return;
        }
        if (binderHowToOpenRef.current) {
          e.preventDefault();
          setBinderHowToOpen(false);
          return;
        }
        engineRef.current?.clearCodexCatalogSelection();
        setActiveDoctrineSlot(null);
        return;
      }
      const t = (e.target as HTMLElement | null)?.tagName?.toLowerCase() ?? "";
      if (t === "select" || t === "input" || t === "textarea" || t === "button") return;

      const pageKeys =
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "PageUp" ||
        e.key === "PageDown" ||
        e.key === "," ||
        e.key === ".";

      if (!engineRef.current?.isBinderOpen()) {
        if (e.key === "Home" || e.key === "End" || pageKeys) e.preventDefault();
        return;
      }

      if (!pageKeys) return;
      e.preventDefault();
      const next =
        e.key === "ArrowRight" || e.key === "PageDown" || (e.key === "." && !e.shiftKey);
      if (next) engineRef.current?.flipNext();
      else engineRef.current?.flipPrev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    let cancelled = false;
    let eng: CardBinderEngine | null = null;
    let ro: ResizeObserver | null = null;

    setLoading(true);
    setLoadingError(null);

    void (async () => {
      try {
        const panelIds = buildShuffledBinderPanelIds(BINDER_GRID_CATALOG_IDS);
        orderedRef.current = panelIds;
        const texList: THREE.Texture[] = panelIds.map(() => makeDeferredBinderTexture());
        binderPanelTexturesRef.current = texList;
        const next = new CardBinderEngine(canvas, texList, { codexHandDragMode: true, controlProfile });
        next.snapBinderFullyOpen();
        next.jumpToSpread(BINDER_INITIAL_SPREAD_INDEX);
        next.onClearDoctrineSelection = () => setActiveDoctrineSlot(null);
        next.onPageChange = (c, t) => setPage({ c, t });
        next.onCodexPointerDrag = (ev: CodexPointerDragEvent) => {
        if (ev.phase === "start") {
          const id = orderedRef.current[ev.pickIndex];
          if (!id || !validIds.has(id)) return;
          codexDragBusyRef.current = true;
          setDragOverSlot(null);
          setDragOverHandZone(false);
          codexDragPosRef.current = { x: ev.clientX, y: ev.clientY };
          setCodexDrag({ catalogId: id });
          return;
        }
        if (ev.phase === "move") {
          moveCodexGhost(ev.clientX, ev.clientY);
          const track = handTrackRef.current;
          const strip = doctrineStripHitRef.current;
          if (!track) {
            setDragOverSlot(null);
            setDragOverHandZone(false);
            return;
          }
          const zr = strip?.getBoundingClientRect();
          const inZone = zr ? pointInRect(ev.clientX, ev.clientY, zr) : false;
          setDragOverHandZone(inZone);
          const over = slotUnderPointerInTrack(ev.clientX, ev.clientY, track);
          setDragOverSlot(over);
          return;
        }
        if (ev.phase === "end") {
          const id = orderedRef.current[ev.pickIndex];
          const from = ev.pickIndex;
          codexDragBusyRef.current = false;
          setCodexDrag(null);
          const track = handTrackRef.current;
          const strip = doctrineStripHitRef.current;
          const zr = strip?.getBoundingClientRect();
          const inZone = zr ? pointInRect(ev.clientX, ev.clientY, zr) : false;
          let handDropHandled = false;
          if (track && id && validIds.has(id)) {
            const pointed = slotUnderPointerInTrack(ev.clientX, ev.clientY, track);
            if (pointed == null) {
              const to = next.pickAt(ev.clientX, ev.clientY, canvas.getBoundingClientRect());
              if (to != null && to >= 0 && to !== from) {
                const o = orderedRef.current;
                const idTo = o[to];
                if (idTo && validIds.has(idTo) && o[from] && validIds.has(o[from]!)) {
                  const texArr = binderPanelTexturesRef.current;
                  if (texArr && from < texArr.length && to < texArr.length) {
                    const t0 = o[from]!;
                    const t1 = o[to]!;
                    o[from] = t1;
                    o[to] = t0;
                    const a = texArr[from]!;
                    const bT = texArr[to]!;
                    texArr[from] = bT;
                    texArr[to] = a;
                    next.setTextures(texArr);
                    const nextPick = swapBinderSlotPicks(binderSlotPickRef.current, from, to);
                    setBinderSlotPick(nextPick);
                    try {
                      const norm = normalizeDoctrineSlotsForMatch(padDoctrineSlotsLocal(slotsRef.current));
                      saveDoctrinePickerState(norm, nextPick);
                    } catch {
                      /* best-effort */
                    }
                    handDropHandled = true;
                  }
                }
              }
            }
            if (!handDropHandled) {
              let dropSlot: number | null = null;
              let explicitHandSlot = false;
              if (pointed !== null) {
                dropSlot = pointed;
                explicitHandSlot = true;
              } else if (inZone) {
                const s = slotsRef.current;
                const firstEmpty = s.findIndex((x) => x == null);
                if (firstEmpty >= 0) {
                  dropSlot = firstEmpty;
                } else {
                  const handRow = track.querySelector(".doctrine-hand--match") as HTMLElement | null;
                  const r = handRow?.getBoundingClientRect() ?? zr;
                  if (r) {
                    const t = (ev.clientX - r.left) / Math.max(1e-6, r.width);
                    dropSlot = Math.min(
                      DOCTRINE_SLOT_COUNT - 1,
                      Math.max(0, Math.floor(t * DOCTRINE_SLOT_COUNT)),
                    );
                  }
                }
              }
              if (dropSlot !== null) {
                const bp = [...binderSlotPickRef.current];
                while (bp.length < DOCTRINE_SLOT_COUNT) bp.push(null);
                const b = bp.slice(0, DOCTRINE_SLOT_COUNT);
                const nextSlots = [...slotsRef.current];
                nextSlots[dropSlot] = id;
                b[dropSlot] = ev.pickIndex;
                if (explicitHandSlot) {
                  setActiveDoctrineSlot(dropSlot);
                  setBinderSlotPick(b);
                  setSlots(normalizeDoctrineSlotsForMatch(padDoctrineSlotsLocal(nextSlots)));
                } else {
                  const sorted = sortPickerHandByFluxCost(nextSlots, b);
                  const landed = sorted.binderPick.findIndex(
                    (p, i) => p === ev.pickIndex && sorted.slots[i] === id,
                  );
                  setActiveDoctrineSlot(landed >= 0 ? landed : null);
                  setBinderSlotPick(sorted.binderPick);
                  setSlots(normalizeDoctrineSlotsForMatch(padDoctrineSlotsLocal(sorted.slots)));
                }
              }
            }
          }
          setDragOverSlot(null);
          setDragOverHandZone(false);
          return;
        }
        if (ev.phase === "cancel") {
          codexDragBusyRef.current = false;
          setCodexDrag(null);
          setDragOverSlot(null);
          setDragOverHandZone(false);
        }
        };
        const rc = wrap.getBoundingClientRect();
        next.resize(rc.width, rc.height);
        if (next.onPageChange) next.onPageChange(next.pageIndex, next.pageCount);

        if (cancelled) {
          next.dispose();
          return;
        }

        eng = next;
        engineRef.current = next;
        setBinderEngineForUi(next);
        ro = new ResizeObserver((es) => {
          for (const e of es) engineRef.current?.resize(e.contentRect.width, e.contentRect.height);
        });
        ro.observe(wrap);
        const hydratePanelTextures = (start: number): void => {
          if (cancelled || engineRef.current !== next) return;
          void (async () => {
            const chunk = controlProfile.mode === "mobile" ? 9 : 18;
            const o = orderedRef.current;
            const end = Math.min(o.length, start + chunk);
            const preloadIds = o.slice(start, end);
            try {
              await preloadCardPreviewDataUrls(preloadIds);
            } catch {
              /* best-effort */
            }
            for (let i = start; i < end; i++) {
              if (cancelled || engineRef.current !== next) return;
              const cid = o[i]!;
              try {
                texList[i] = await getBinderTextureForCatalogId(cid);
              } catch (err) {
                console.warn("[binder] failed to hydrate deferred card texture", cid, err);
              }
            }
            if (cancelled || engineRef.current !== next) return;
            next.setTextures(texList);
            if (end < o.length) afterIdle(() => hydratePanelTextures(end));
          })();
        };

        const initialArtEnd = Math.min(panelIds.length, BINDER_INITIAL_ART_CELLS);
        const initialIds = [...new Set(panelIds.slice(0, initialArtEnd))];
        const initialTextures = new Map<string, THREE.Texture>();
        await Promise.all(
          initialIds.map(async (id) => {
            if (cancelled || engineRef.current !== next) return;
            try {
              initialTextures.set(id, await getBinderTextureForCatalogId(id));
            } catch (err) {
              console.warn("[binder] failed to hydrate initial card texture", id, err);
            }
          }),
        );
        for (let i = 0; i < initialArtEnd; i++) {
          const tex = initialTextures.get(panelIds[i]!);
          if (tex) texList[i] = tex;
        }
        if (cancelled || engineRef.current !== next) return;
        next.setTextures(texList);
        setLoading(false);
        onReady?.();
        if (initialArtEnd < panelIds.length) afterIdle(() => hydratePanelTextures(initialArtEnd));
      } catch (err) {
        console.error("[binder] failed to initialize doctrine picker", err);
        if (!cancelled) {
          setLoadingError("Binder failed to initialize. Hard refresh or use Quick Match while assets recover.");
          setLoading(false);
          onReady?.();
        }
      }
    })();

    return () => {
      cancelled = true;
      ro?.disconnect();
      eng?.dispose();
      engineRef.current = null;
      binderPanelTexturesRef.current = null;
      setBinderEngineForUi(null);
    };
  }, [controlProfile, onReady]);

  useLayoutEffect(() => {
    if (loading) return;
    const track = handTrackRef.current;
    const hand = handRowRef.current;
    if (!track || !hand) return;

    let buttons = [...hand.querySelectorAll<HTMLButtonElement>("button.slot")];
    if (buttons.length !== DOCTRINE_SLOT_COUNT) {
      hand.replaceChildren();
      buttons = [];
      for (let i = 0; i < DOCTRINE_SLOT_COUNT; i++) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "slot";
        b.dataset.slotIndex = String(i);
        b.setAttribute("role", "gridcell");
        b.setAttribute("aria-rowindex", "1");
        b.setAttribute("aria-colindex", String(i + 1));
        const hotkey = i === 9 ? "0" : String(i + 1);
        b.setAttribute("aria-label", `Doctrine slot ${i + 1}, key ${hotkey}`);
        hand.appendChild(b);
        buttons.push(b);
      }
    }

    const idTotalCount = new Map<string, number>();
    for (let i = 0; i < DOCTRINE_SLOT_COUNT; i++) {
      const id = slots[i] ?? null;
      if (!id || !getCatalogEntry(id)) continue;
      idTotalCount.set(id, (idTotalCount.get(id) ?? 0) + 1);
    }

    for (let i = 0; i < DOCTRINE_SLOT_COUNT; i++) {
      const b = buttons[i]!;
      const id = slots[i] ?? null;
      b.classList.remove(
        "slot-empty",
        "slot-ready",
        "slot-locked",
        "slot-sigwarn",
        "slot-await-infra",
        "disabled",
        "slot--hand-collapsed",
        "slot--hand-pull",
      );
      b.removeAttribute("data-slot-tone");
      b.querySelector(".slot-dup-count")?.remove();

      const hotkey = i === 9 ? "0" : String(i + 1);
      b.innerHTML = doctrineSlotButtonInnerHtml(i, id, { variant: "picker", liveIdPrefix: "picker-slot-live" });

      if (!id) {
        b.classList.add("slot-empty");
        b.title = `Empty doctrine slot — drag a codex card here. (key ${hotkey})`;
      } else {
        const e = getCatalogEntry(id);
        if (!e) {
          b.classList.add("slot-empty");
          b.title = `Unknown card in slot. (key ${hotkey})`;
        } else {
          const total = idTotalCount.get(id) ?? 1;
          if (total > 1) {
            const dup = document.createElement("span");
            dup.className = "slot-dup-count";
            dup.textContent = `x${total}`;
            b.appendChild(dup);
          }
          b.classList.add("slot-ready");
          b.dataset.slotTone = doctrineSlotHudTone(e);
          b.title = `${e.name} — codex drag to replace. Sorted by cost when you add cards. (key ${hotkey})`;
        }
      }
    }

    hydrateCardPreviewImages(track);
  }, [loading, slots]);

  useLayoutEffect(() => {
    if (loading) return;
    const hand = handRowRef.current;
    if (!hand) return;
    const buttons = [...hand.querySelectorAll<HTMLButtonElement>("button.slot")];
    if (buttons.length !== DOCTRINE_SLOT_COUNT) return;
    for (let i = 0; i < DOCTRINE_SLOT_COUNT; i++) {
      const b = buttons[i]!;
      b.classList.toggle("binder-picker-slot--drag-over", dragOverSlot === i);
      b.classList.toggle("active", activeDoctrineSlot === i);
    }
  }, [loading, slots, dragOverSlot, activeDoctrineSlot]);

  useLayoutEffect(() => {
    if (!codexDrag) return;
    const root = codexGhostRef.current;
    if (!root) return;
    hydrateCardPreviewImages(root);
  }, [codexDrag?.catalogId]);

  useEffect(() => {
    if (loading) return;
    const track = handTrackRef.current;
    if (!track) return;
    attachDoctrineHandPeek(track, () => codexDragBusyRef.current);
  }, [loading]);

  useEffect(() => {
    if (loading) return;
    const track = handTrackRef.current;
    if (!track) return;

    const slop2 = CARD_PREVIEW_BINDER_HAND_SLOP_PX * CARD_PREVIEW_BINDER_HAND_SLOP_PX;
    let arm: {
      pointerId: number;
      startX: number;
      startY: number;
      slot: HTMLElement;
      catalogId: string;
      timer: number | null;
    } | null = null;

    const detachWin = (): void => {
      window.removeEventListener("pointermove", onWinMove);
      window.removeEventListener("pointerup", onWinEnd);
      window.removeEventListener("pointercancel", onWinEnd);
    };

    const clear = (): void => {
      if (arm?.timer != null) clearTimeout(arm.timer);
      detachWin();
      arm = null;
    };

    const onWinMove = (ev: PointerEvent): void => {
      if (!arm || ev.pointerId !== arm.pointerId) return;
      const dx = ev.clientX - arm.startX;
      const dy = ev.clientY - arm.startY;
      if (dx * dx + dy * dy < slop2) return;
      if (arm.timer != null) {
        clearTimeout(arm.timer);
        arm.timer = null;
      }
      closeDoctrineCardDetail();
      detachWin();
      arm = null;
    };

    const onWinEnd = (ev: PointerEvent): void => {
      if (!arm || ev.pointerId !== arm.pointerId) return;
      if (arm.timer != null) {
        clearTimeout(arm.timer);
        arm.timer = null;
      }
      detachWin();
      arm = null;
    };

    const onDown = (ev: PointerEvent): void => {
      if (ev.button !== 0) return;
      if (!(ev.target instanceof Element)) return;
      const slot = ev.target.closest(".slot");
      if (!(slot instanceof HTMLElement) || !track.contains(slot)) return;
      if (slot.classList.contains("slot-empty") || slot.classList.contains("slot-locked")) return;
      const card = slot.querySelector(".doctrine-card-compact[data-catalog-id]");
      const id = card?.getAttribute("data-catalog-id");
      if (!id) return;
      clear();
      const pid = ev.pointerId;
      const sx = ev.clientX;
      const sy = ev.clientY;
      arm = {
        pointerId: pid,
        startX: sx,
        startY: sy,
        slot,
        catalogId: id,
        timer: window.setTimeout(() => {
          if (!arm || arm.pointerId !== pid) return;
          arm.timer = null;
          detachWin();
          showDoctrineCardDetail(id, { fromHover: true, hoverSourceEl: slot });
          arm = null;
        }, CARD_PREVIEW_BINDER_HAND_MS),
      };
      window.addEventListener("pointermove", onWinMove);
      window.addEventListener("pointerup", onWinEnd);
      window.addEventListener("pointercancel", onWinEnd);
    };

    track.addEventListener("pointerdown", onDown, true);
    return () => {
      clear();
      track.removeEventListener("pointerdown", onDown, true);
    };
  }, [loading, slots]);

  useEffect(() => {
    const track = handTrackRef.current;
    if (!track || loading) return;
    const onDbl = (ev: MouseEvent): void => {
      if (!(ev.target instanceof Element)) return;
      const slot = ev.target.closest(".slot");
      if (!(slot instanceof HTMLElement) || !track.contains(slot)) return;
      if (slot.classList.contains("slot-empty") || slot.classList.contains("slot-locked")) return;
      const card = slot.querySelector(".doctrine-card-compact[data-catalog-id]");
      const id = card?.getAttribute("data-catalog-id");
      if (!id) return;
      ev.preventDefault();
      ev.stopPropagation();
      showDoctrineCardDetail(id);
    };
    track.addEventListener("dblclick", onDbl);
    return () => track.removeEventListener("dblclick", onDbl);
  }, [loading, slots]);

  useEffect(() => {
    if (!prematchSetupOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setPrematchSetupOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prematchSetupOpen]);

  useEffect(() => {
    if (loading) return;
    const end = () => engineRef.current?.releaseInterruptedGesture();
    const onVis = () => {
      if (document.visibilityState === "hidden") end();
    };
    window.addEventListener("blur", end);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("blur", end);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loading]);

  /**
   * `pointerup`/`pointercancel` often target the element under the cursor (hand strip), not the canvas.
   * While a codex card is lifted, finalize the gesture from a window-level capture listener so drops always commit.
   */
  useEffect(() => {
    if (loading) return;
    const onGlobalPointerEnd = (e: PointerEvent): void => {
      const eng = engineRef.current;
      const canvas = canvasRef.current;
      if (!eng?.isCodexBinderPullDragActive() || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      eng.pU(e, rect);
    };
    window.addEventListener("pointerup", onGlobalPointerEnd, true);
    window.addEventListener("pointercancel", onGlobalPointerEnd, true);
    return () => {
      window.removeEventListener("pointerup", onGlobalPointerEnd, true);
      window.removeEventListener("pointercancel", onGlobalPointerEnd, true);
    };
  }, [loading]);

  const confirmVibeJamExit = useCallback(() => {
    setPortalExitConfirmOpen(true);
  }, []);

  const goToVibeJam = useCallback(() => {
    window.location.assign(prematchVibeJamHref);
  }, [prematchVibeJamHref]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* setPointerCapture can fail in edge pointer states */
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const eng = engineRef.current;
    if (!eng) return;
    const portalAction = e.button === 0 ? eng.pickVibePortalAction(e.clientX, e.clientY, rect) : null;
    if (portalAction === "enter") {
      e.preventDefault();
      e.stopPropagation();
      confirmVibeJamExit();
      return;
    }
    if (!loading) {
      const idxPre = eng.pickAt(e.clientX, e.clientY, rect);
      if (idxPre !== null && idxPre >= 0) {
        const idPre = orderedRef.current[idxPre];
        if (idPre && validIds.has(idPre)) {
          const now = performance.now();
          const pr = detailTapRef.current;
          if (pr.idx === idxPre && now - pr.t < 480) {
            eng.clearCatalogTapIntent();
            detailTapRef.current = { t: 0, idx: null };
            eng.pD(e.nativeEvent, rect);
            eng.clearCatalogTapIntent();
            eng.resetCatalogPickArmAfterUiConsume();
            showDoctrineCardDetail(idPre);
            return;
          }
          detailTapRef.current = { t: now, idx: idxPre };
        } else {
          detailTapRef.current = { t: 0, idx: null };
        }
      } else {
        detailTapRef.current = { t: 0, idx: null };
      }
    }
    eng.pD(e.nativeEvent, rect);
  }, [confirmVibeJamExit, loading]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    engineRef.current?.pM(e.nativeEvent, rect);
  }, []);

  const onPointerReleased = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    engineRef.current?.pU(e.nativeEvent, rect);
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    engineRef.current?.wheelAt(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), e.deltaY);
  }, []);

  const openDetailAtClient = useCallback((clientX: number, clientY: number, el: HTMLCanvasElement) => {
    const eng = engineRef.current;
    if (!eng || loading) return;
    eng.clearCatalogTapIntent();
    const rect = el.getBoundingClientRect();
    const idx = eng.pickAt(clientX, clientY, rect);
    if (idx == null || idx < 0) return;
    const id = orderedRef.current[idx];
    if (id && validIds.has(id)) showDoctrineCardDetail(id);
  }, [loading]);

  const onCanvasDoubleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.stopPropagation();
    engineRef.current?.clearCatalogTapIntent();
    openDetailAtClient(e.clientX, e.clientY, e.currentTarget);
  }, [openDetailAtClient]);

  const resetDefaults = useCallback(() => {
    setActiveDoctrineSlot(null);
    setBinderSlotPick(Array.from({ length: DOCTRINE_SLOT_COUNT }, () => null));
    setSlots(
      normalizeDoctrineSlotsForMatch(
        padDoctrineSlotsLocal(DEFAULT_DOCTRINE_SLOTS.map((id) => (id && validIds.has(id) ? id : null))),
      ),
    );
  }, []);

  const pickForMe = useCallback(() => {
    const pool = QUICK_PICK_IDS.filter((id) => validIds.has(id));
    if (!pool.length) return;
    const raw: (string | null)[] = [];
    for (let i = 0; i < DOCTRINE_SLOT_COUNT; i++) {
      raw.push(pool[Math.floor(Math.random() * pool.length)]!);
    }
    let norm = normalizeDoctrineSlotsForMatch(padDoctrineSlotsLocal(raw));
    norm = fillDoctrineSlotsWithDuplicatePicks(norm);
    const mapPick = MAP_REGISTRY[Math.floor(Math.random() * MAP_REGISTRY.length)]!;
    setMapUrl(mapPick.url);
    setActiveDoctrineSlot(null);
    setBinderSlotPick(Array.from({ length: DOCTRINE_SLOT_COUNT }, () => null));
    setSlots(norm);
    saveDoctrinePickerState(norm, null);
    try {
      localStorage.setItem(MAP_URL_STORAGE_KEY, mapPick.url);
      localStorage.removeItem(LEGACY_MAP_URL_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const saveDoctrine = useCallback(() => {
    const norm = normalizeDoctrineSlotsForMatch(padDoctrineSlotsLocal(slots));
    saveDoctrinePickerState(norm, binderSlotPick);
    setSlots(norm);
    setBinderSlotPick(Array.from({ length: DOCTRINE_SLOT_COUNT }, () => null));
  }, [slots, binderSlotPick]);

  const startMatch = useCallback(() => {
    if (slots.filter(Boolean).length < MIN_FILLED) return;
    const norm = normalizeDoctrineSlotsForMatch(padDoctrineSlotsLocal(slots));
    saveDoctrinePickerState(norm, binderSlotPick);
    try {
      localStorage.setItem(MAP_URL_STORAGE_KEY, mapUrl);
      localStorage.removeItem(LEGACY_MAP_URL_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setPortalTransitioning(true);
    void (async () => {
      await (engineRef.current?.playPortalTransition("out") ?? Promise.resolve());
      onStart(norm, mapUrl);
    })();
  }, [slots, binderSlotPick, onStart, mapUrl]);

  const commitQuickMatchStart = useCallback(
    (normSlots: (string | null)[], pickSnapshot: (number | null)[], url: string) => {
      setActiveDoctrineSlot(null);
      saveDoctrinePickerState(normSlots, pickSnapshot);
      try {
        localStorage.setItem(MAP_URL_STORAGE_KEY, url);
        localStorage.removeItem(LEGACY_MAP_URL_STORAGE_KEY);
      } catch {
        /* ignore */
      }
      setPrematchSetupOpen(false);
      setPortalTransitioning(true);
      void (async () => {
        await (engineRef.current?.playPortalTransition("out") ?? Promise.resolve());
        onStart(normSlots, url);
      })();
    },
    [onStart],
  );

  const quickMatchAndStart = useCallback(() => {
    if (loading || portalTransitioning) return;
    const userFiltered = padDoctrineSlotsLocal(slots.map((id) => (id && validIds.has(id) ? id : null)));
    const userNorm = normalizeDoctrineSlotsForMatch(userFiltered);
    const filled = userNorm.filter(Boolean).length;
    if (filled >= MIN_FILLED) {
      if (filled < DOCTRINE_SLOT_COUNT) {
        setQuickfillConfirmOpen(true);
        return;
      }
      commitQuickMatchStart(userNorm, binderSlotPick, mapUrl);
      return;
    }

    const raw = padDoctrineSlotsLocal([...QUICK_MATCH_DOCTRINE_SLOTS]);
    const norm = normalizeDoctrineSlotsForMatch(raw);
    if (norm.filter(Boolean).length < MIN_FILLED) return;
    const emptyPick = Array.from({ length: DOCTRINE_SLOT_COUNT }, () => null as number | null);
    const sorted = sortPickerHandByFluxCost(norm, emptyPick);
    let finalSlots = normalizeDoctrineSlotsForMatch(padDoctrineSlotsLocal(sorted.slots));
    finalSlots = fillDoctrineSlotsWithDuplicatePicks(finalSlots);
    const mapPick = MAP_REGISTRY[Math.floor(Math.random() * MAP_REGISTRY.length)]!;
    setActiveDoctrineSlot(null);
    setBinderSlotPick(sorted.binderPick);
    setSlots(finalSlots);
    setMapUrl(mapPick.url);
    saveDoctrinePickerState(finalSlots, sorted.binderPick);
    try {
      localStorage.setItem(MAP_URL_STORAGE_KEY, mapPick.url);
      localStorage.removeItem(LEGACY_MAP_URL_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setPrematchSetupOpen(false);
    setPortalTransitioning(true);
    void (async () => {
      await (engineRef.current?.playPortalTransition("out") ?? Promise.resolve());
      onStart(finalSlots, mapPick.url);
    })();
  }, [loading, portalTransitioning, onStart, commitQuickMatchStart, slots, binderSlotPick, mapUrl]);
  useEffect(() => {
    if (loading) return;
    let shouldPlay = false;
    try {
      shouldPlay = sessionStorage.getItem("signalWarsPortalReturn") === "1";
      if (shouldPlay) sessionStorage.removeItem("signalWarsPortalReturn");
    } catch {
      shouldPlay = false;
    }
    if (shouldPlay) {
      setPortalTransitioning(true);
      void (engineRef.current?.playPortalTransition("in") ?? Promise.resolve()).finally(() => {
        setPortalTransitioning(false);
      });
    }
  }, [loading]);

  return (
    <div className="binder-picker-root">
      <div className="binder-picker-main">
        <div className="binder-picker-binder-wrap" ref={wrapRef}>
          {loading ? (
            <div className="binder-picker-loading" role="status" aria-live="polite" aria-busy="true">
              Loading…
            </div>
          ) : null}
          {loadingError ? (
            <div className="binder-picker-loading binder-picker-loading--error" role="alert">
              {loadingError}
            </div>
          ) : null}
          <canvas
            ref={canvasRef}
            className="binder-picker-canvas"
            tabIndex={0}
            role="application"
            aria-label="Doctrine codex in the portal room. Tap card to select. Esc or empty page clears. Drag card to hand, or hold to lift. Drag page outer edge to turn. Right mouse looks around a limited room view. Double-click details."
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerReleased}
            onPointerCancel={onPointerReleased}
            onPointerLeave={() => engineRef.current?.clearCardHover()}
            onWheel={onWheel}
            onDoubleClick={onCanvasDoubleClick}
            onAuxClick={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onContextMenu={(e) => e.preventDefault()}
          />
          {!loading ? (
            <>
              <div
                className={[
                  "binder-picker-tome-hint",
                  tomeHintPressed ? "binder-picker-tome-hint--pressed" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                role="button"
                tabIndex={0}
                aria-haspopup="dialog"
                aria-expanded={binderHowToOpen}
                title="Codex: tap a card for outline; Esc or empty page clears. Drag to the bottom hand; cards sort by cost. Hold ~0.4s on a card to lift. Page peel on outer strips; RMB/MMB looks around the room. Hold this strip for match goals and controls."
                onPointerDown={onTomeHintPointerDown}
                onPointerUp={onTomeHintPointerEnd}
                onPointerCancel={onTomeHintPointerEnd}
                onPointerLeave={onTomeHintPointerEnd}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setBinderHowToOpen(true);
                  }
                }}
              >
                Tap card · Esc / empty page clears · drag to hand · edges turn pages · Hold here for how to play
              </div>
              {binderHowToOpen ? (
                <div
                  className="binder-picker-howto-overlay"
                  role="presentation"
                  onClick={() => setBinderHowToOpen(false)}
                >
                  <div
                    className="binder-picker-howto-overlay__panel"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="binder-howto-title"
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    <div className="binder-picker-howto-overlay__head">
                      <h2 id="binder-howto-title" className="binder-picker-howto-overlay__title">
                        How to play
                      </h2>
                      <button
                        type="button"
                        className="binder-picker-howto-overlay__close"
                        aria-label="Close"
                        onClick={() => setBinderHowToOpen(false)}
                      >
                        ×
                      </button>
                    </div>
                    <div
                      className="binder-help-goals-wrap"
                      dangerouslySetInnerHTML={{ __html: BINDER_PREMATCH_GOALS_HTML }}
                    />
                    <h3 className="binder-picker-howto-overlay__sub">Controls</h3>
                    <div
                      className="binder-help-controls-wrap"
                      dangerouslySetInnerHTML={{ __html: MATCH_HELP_INNER_HTML }}
                    />
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        {!loading ? (
          <div className="binder-picker-prematch-bottom">
            <div
              ref={doctrineStripHitRef}
              className={[
                "doctrine-wrap doctrine-wrap--rail binder-picker-doctrine-hand-rail",
                dragOverHandZone ? "binder-picker-doctrine-hand--drag-over" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="binder-picker-hand-zone">
                <div className="doctrine-view">
                  <div
                    ref={handTrackRef}
                    className="doctrine-track doctrine-track--hand doctrine-track--deck10 doctrine-track--rail"
                    id="doctrine-picker-hand-track"
                    role="grid"
                    aria-label="Doctrine hand — drop codex cards anywhere in this bottom strip; cards sort by cost"
                    aria-rowcount={1}
                  >
                    <div
                      ref={handRowRef}
                      className="doctrine-hand doctrine-hand--match"
                      role="row"
                      aria-rowindex={1}
                    />
                  </div>
                </div>
              </div>
            </div>
            <div className="binder-picker-rail-actions">
              <div className="binder-picker-rail-actions__stack">
                <button
                  type="button"
                  className="binder-picker-rail-btn binder-picker-rail-btn--quickmatch"
                  aria-label="Quickmatch"
                  disabled={loading || portalTransitioning || quickfillConfirmOpen}
                  title="Fill all doctrine slots with a starter mix of towers and spells, pick a random battlefield, and start"
                  onClick={quickMatchAndStart}
                >
                  <span className="binder-picker-rail-btn__inner">
                    <span className="binder-picker-rail-btn__glyph" aria-hidden="true">
                      ⚔
                    </span>
                    <svg className="binder-picker-rail-btn__label" viewBox="0 0 160 24" preserveAspectRatio="none" aria-hidden="true">
                      <text x="80" y="16" textAnchor="middle">
                        Quick Match
                      </text>
                    </svg>
                  </span>
                </button>
                <button
                  type="button"
                  className="binder-picker-rail-btn binder-picker-rail-btn--match"
                  aria-label="Match select"
                  aria-expanded={prematchSetupOpen}
                  aria-controls="binder-prematch-setup-panel"
                  id="binder-prematch-setup-trigger"
                  title="Match select: map, page nav, save, start — LMB/MMB/RMB help in the hint above the binder"
                  onClick={() => setPrematchSetupOpen((o) => !o)}
                >
                  <span className="binder-picker-rail-btn__inner">
                    <span className="binder-picker-rail-btn__glyph" aria-hidden="true">
                      ✶
                    </span>
                    <svg className="binder-picker-rail-btn__label" viewBox="0 0 160 24" preserveAspectRatio="none" aria-hidden="true">
                      <text x="80" y="16" textAnchor="middle">
                        Match Setup
                      </text>
                    </svg>
                  </span>
                </button>
                <button
                  type="button"
                  className="binder-picker-rail-btn binder-picker-rail-btn--lore"
                  aria-label="Lore / how to play"
                  title="Open the optional lore / how-to-play comic"
                  onClick={() => {
                    void showComicLoreModal();
                  }}
                >
                  <span className="binder-picker-rail-btn__inner">
                    <span className="binder-picker-rail-btn__glyph" aria-hidden="true">
                      ●
                    </span>
                    <svg className="binder-picker-rail-btn__label binder-picker-rail-btn__label--long" viewBox="0 0 190 24" preserveAspectRatio="none" aria-hidden="true">
                      <text x="95" y="16" textAnchor="middle" textLength="172" lengthAdjust="spacingAndGlyphs">
                        Lore / How To Play
                      </text>
                    </svg>
                  </span>
                </button>
              </div>
              {prematchSetupOpen ? (
                <aside
                  className="binder-picker-setup-panel"
                  id="binder-prematch-setup-panel"
                  role="dialog"
                  aria-labelledby="binder-prematch-setup-trigger"
                  aria-modal="true"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="binder-picker-setup-panel__inner">
                    <div className="binder-picker-nav">
                        <button
                          type="button"
                          className="binder-picker-btn"
                          title={page.c > 0 ? "Previous spread" : "First spread"}
                          disabled={page.c <= 0}
                          onClick={() => engineRef.current?.flipPrev()}
                        >
                          Prev
                        </button>
                        <span className="binder-picker-nav-page">
                          {page.c + 1} / {page.t}
                        </span>
                        <button
                          type="button"
                          className="binder-picker-btn"
                          title={page.c < page.t - 1 ? "Next spread" : "Last spread"}
                          disabled={page.c >= page.t - 1}
                          onClick={() => engineRef.current?.flipNext()}
                        >
                          Next
                        </button>
                        {layoutCalibrateAllowed ? (
                          <button
                            type="button"
                            className="binder-picker-btn"
                            title="Dev: open prematch layout sliders (`?binderCalibrate=1` only). Saves in this browser; copy TS into CardBinderEngine to ship."
                            onClick={() => {
                              setRoomLayoutTunerOpen((o) => {
                                const next = !o;
                                if (next) setPrematchSetupOpen(true);
                                return next;
                              });
                            }}
                          >
                            {roomLayoutTunerOpen ? "Hide layout" : "Tune layout"}
                          </button>
                        ) : null}
                      </div>
                    <div className="binder-picker-toolbar-map">
                      <label htmlFor="binder-map">Battlefield</label>
                      <select
                        id="binder-map"
                        disabled={loading}
                        value={mapUrl}
                        onChange={(ev) => setMapUrl(ev.target.value)}
                      >
                        {MAP_REGISTRY.map((m) => (
                          <option key={m.id} value={m.url}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="binder-picker-toolbar-main">
                      <div className="binder-picker-toolbar-actions">
                        <button
                          type="button"
                          className="binder-picker-btn"
                          disabled={loading}
                          title="Random full doctrine row (codex cards) and a random battlefield — does not start the match"
                          onClick={pickForMe}
                        >
                          Pick for me
                        </button>
                        <button type="button" className="binder-picker-btn" disabled={loading} onClick={resetDefaults}>
                          Reset
                        </button>
                        <button type="button" className="binder-picker-btn" disabled={loading} onClick={saveDoctrine}>
                          Save
                        </button>
                        <button
                          type="button"
                          className="binder-picker-btn binder-picker-btn--primary"
                          disabled={loading || !canStart || portalTransitioning}
                          onClick={() => {
                            setPrematchSetupOpen(false);
                            startMatch();
                          }}
                        >
                          {portalTransitioning ? "Starting…" : "Start"}
                        </button>
                      </div>
                    </div>
                  </div>
                </aside>
              ) : null}
            </div>
            <div className="binder-picker-vibejam-insert binder-picker-vibejam-insert--floated">
              {prematchReturnHref ? (
                <a
                  className="binder-picker-vibejam-link binder-picker-vibejam-link--insert"
                  href={prematchReturnHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Return to the page that linked you here (portal continuity)"
                >
                  ← Return
                </a>
              ) : null}
              <a
                className="binder-picker-vibejam-link binder-picker-vibejam-link--insert"
                href={portalContext.enteredViaPortal ? prematchVibeJamHref : "https://vibej.am/"}
                target="_blank"
                rel="noopener noreferrer"
                title={
                  portalContext.enteredViaPortal
                    ? "Exit to Vibe Jam with continuity params"
                    : "Vibe Jam 2026"
                }
              >
                🎮 Vibe Jam 2026
              </a>
            </div>
          </div>
        ) : null}
      </div>

      {codexDrag ? (
        <div
          ref={codexGhostRef}
          className="binder-picker-codex-ghost"
          style={{ left: codexDragPosRef.current.x + 14, top: codexDragPosRef.current.y + 14 }}
          aria-hidden
        >
          <div
            className="binder-picker-codex-ghost__inner"
            dangerouslySetInnerHTML={{ __html: tcgCardSlotHtml(codexDrag.catalogId, "picker") }}
          />
        </div>
      ) : null}

      {portalExitConfirmOpen ? (
        <div
          className="binder-portal-exit-toast"
          role="dialog"
          aria-modal="true"
          aria-labelledby="binder-portal-exit-title"
          onClick={() => {
            setPortalExitConfirmOpen(false);
          }}
        >
          <div className="binder-portal-exit-toast__title" id="binder-portal-exit-title">
            Visit the next Vibe Jam game?
          </div>
          <p>
            Thanks for playing Doctrine. Hope you had fun here, and have fun at the next game.
          </p>
          <div className="binder-portal-exit-toast__actions">
            <button type="button" onClick={goToVibeJam}>
              Continue to next game
            </button>
            <button
              type="button"
              className="binder-portal-exit-toast__secondary"
              onClick={(ev) => {
                ev.stopPropagation();
                setPortalExitConfirmOpen(false);
              }}
            >
              Stay here
            </button>
          </div>
        </div>
      ) : null}

      {quickfillConfirmOpen ? (
        <div
          className="binder-portal-exit-toast"
          role="dialog"
          aria-modal="true"
          aria-labelledby="binder-quickfill-title"
          onClick={() => setQuickfillConfirmOpen(false)}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <div className="binder-portal-exit-toast__title" id="binder-quickfill-title">
              Fill remaining doctrine slots?
            </div>
            <p>
              Quickmatch runs smoother with all ten slots filled. Fill the empty slots by repeating cards from your
              loadout (duplicates allowed), then jump in?
            </p>
            <div className="binder-portal-exit-toast__actions">
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  const userFiltered = padDoctrineSlotsLocal(
                    slotsRef.current.map((id) => (id && validIds.has(id) ? id : null)),
                  );
                  const expanded = fillDoctrineSlotsWithDuplicatePicks(userFiltered);
                  setSlots(expanded);
                  setQuickfillConfirmOpen(false);
                  commitQuickMatchStart(expanded, binderSlotPickRef.current, mapUrlRef.current);
                }}
              >
                Yes — fill and start
              </button>
              <button
                type="button"
                className="binder-portal-exit-toast__secondary"
                onClick={(ev) => {
                  ev.stopPropagation();
                  const userFiltered = padDoctrineSlotsLocal(
                    slotsRef.current.map((id) => (id && validIds.has(id) ? id : null)),
                  );
                  const userNorm = normalizeDoctrineSlotsForMatch(userFiltered);
                  setQuickfillConfirmOpen(false);
                  commitQuickMatchStart(userNorm, binderSlotPickRef.current, mapUrlRef.current);
                }}
              >
                No — start as-is
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {prematchSetupOpen ? (
        <button
          type="button"
          className="binder-picker-setup-backdrop"
          aria-label="Close match select"
          tabIndex={-1}
          onClick={() => setPrematchSetupOpen(false)}
        />
      ) : null}

      {layoutCalibrateAllowed && roomLayoutTunerOpen ? (
        <BinderLayoutCalibratePanel
          engine={binderEngineForUi}
          visible={!loading && binderEngineForUi != null}
          onClose={() => setRoomLayoutTunerOpen(false)}
        />
      ) : null}
    </div>
  );
}
