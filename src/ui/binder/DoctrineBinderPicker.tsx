import * as THREE from "three";
import type { ReactElement } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CATALOG, DEFAULT_DOCTRINE_SLOTS, getCatalogEntry } from "../../game/catalog";
import { getControlProfile } from "../../controlProfile";
import { DOCTRINE_SLOT_COUNT } from "../../game/constants";
import { normalizeDoctrineSlotsForMatch } from "../../game/state";
import { DEFAULT_MAP_URL, MAP_REGISTRY } from "../../game/loadMap";
import {
  buildReturnPortalUrlForPrematch,
  buildVibeJamExitUrlForPrematch,
  type PortalContext,
} from "../../game/portal";
import { hydrateCardPreviewImages, preloadCardPreviewDataUrls } from "../cardGlbPreview";
import { resetCardArtManifestCache } from "../cardArtManifest";
import {
  CARD_PREVIEW_HOVER_MS,
  onDoctrineCardPreviewHoverLeave,
  showDoctrineCardDetail,
} from "../cardDetailPop";
import { doctrineCardBody, tcgCardCompactHtml } from "../doctrineCard";
import { attachDoctrineHandPeek } from "../hud";
import { doctrineSlotHudTone } from "../doctrineSlotHudTone";
import { loadDoctrinePickerState, saveDoctrinePickerState } from "../doctrineStorage";
import { getBinderTextureForCatalogId } from "./binderCardTexture";
import {
  BINDER_CELLS_PER_SHEET,
  BINDER_CODEX_TOTAL_CELLS,
  CardBinderEngine,
  makeEmptyBinderPanelCanvas,
  type CodexPointerDragEvent,
} from "./CardBinderEngine";
import { BinderLayoutCalibratePanel } from "./BinderLayoutCalibratePanel";
import { sortPickerHandByFluxCost } from "./doctrinePickerHandSort";
import "./binderPicker.css";

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

/** Catalog ids pinned to the **first codex cell** (recto top-left) so key cards are always on page 1. */
const CODEX_PIN_FIRST_SLOT: readonly string[] = ["watchtower"];

/** One texture index per duplex slot (`BINDER_CODEX_TOTAL_CELLS`); repeats when the catalog is smaller than the grid. */
function buildShuffledBinderPanelIds(baseIds: readonly string[]): string[] {
  if (baseIds.length === 0) return [];
  const rotated = [...baseIds];
  for (let i = rotated.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rotated[i], rotated[j]] = [rotated[j]!, rotated[i]!];
  }
  const out: string[] = [];
  for (let i = 0; i < BINDER_CODEX_TOTAL_CELLS; i++) {
    out.push(rotated[i % rotated.length]!);
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  for (const pinId of CODEX_PIN_FIRST_SLOT) {
    if (!baseIds.includes(pinId)) continue;
    const at = out.indexOf(pinId);
    if (at >= 0 && at !== 0) {
      const swap = out[0]!;
      out[0] = pinId;
      out[at] = swap;
    }
  }
  return out;
}

export function DoctrineBinderPicker({
  onStart,
  portalContext = { enteredViaPortal: false, params: {}, ref: null },
}: {
  onStart: (slots: (string | null)[], mapUrl: string) => void;
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
  /** Sliders for codex + Vibe portal — open from match select, or land with `?binderCalibrate=1`. */
  const [roomLayoutTunerOpen, setRoomLayoutTunerOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("binderCalibrate") === "1";
  });

  const orderedRef = useRef<string[]>([...BINDER_GRID_CATALOG_IDS]);
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

  const [codexDrag, setCodexDrag] = useState<{ catalogId: string; x: number; y: number } | null>(null);
  const codexGhostRef = useRef<HTMLDivElement | null>(null);
  const [dragOverSlot, setDragOverSlot] = useState<number | null>(null);
  const [dragOverHandZone, setDragOverHandZone] = useState(false);
  const [portalTransitioning, setPortalTransitioning] = useState(false);
  const [portalExitConfirmOpen, setPortalExitConfirmOpen] = useState(false);

  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const binderSlotPickRef = useRef(binderSlotPick);
  binderSlotPickRef.current = binderSlotPick;

  const filledCount = slots.filter(Boolean).length;
  const canStart = filledCount >= MIN_FILLED;

  /** Force refetch card manifest + bust `/assets/cards/*` cache each visit (browser loves to cache JSON/SVG). */
  useEffect(() => {
    resetCardArtManifestCache();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
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

    void (async () => {
      const panelIds = buildShuffledBinderPanelIds(BINDER_GRID_CATALOG_IDS);
      orderedRef.current = panelIds;
      const texList: THREE.Texture[] = panelIds.map(() => makeDeferredBinderTexture());
      const initialVisibleEnd = Math.min(panelIds.length, BINDER_CELLS_PER_SHEET);
      try {
        await preloadCardPreviewDataUrls(panelIds.slice(0, initialVisibleEnd));
      } catch {
        /* best-effort */
      }
      for (let i = 0; i < initialVisibleEnd; i++) {
        if (cancelled) return;
        texList[i] = await getBinderTextureForCatalogId(panelIds[i]!);
      }

      const next = new CardBinderEngine(canvas, texList, { codexHandDragMode: true, controlProfile });
      next.snapBinderFullyOpen();
      next.onClearDoctrineSelection = () => setActiveDoctrineSlot(null);
      next.onPageChange = (c, t) => setPage({ c, t });
      next.onCodexPointerDrag = (ev: CodexPointerDragEvent) => {
        if (ev.phase === "start") {
          const id = orderedRef.current[ev.pickIndex];
          if (!id || !validIds.has(id)) return;
          codexDragBusyRef.current = true;
          setDragOverSlot(null);
          setDragOverHandZone(false);
          setCodexDrag({ catalogId: id, x: ev.clientX, y: ev.clientY });
          return;
        }
        if (ev.phase === "move") {
          setCodexDrag((d) => (d ? { ...d, x: ev.clientX, y: ev.clientY } : d));
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
          codexDragBusyRef.current = false;
          setCodexDrag(null);
          const track = handTrackRef.current;
          const strip = doctrineStripHitRef.current;
          const zr = strip?.getBoundingClientRect();
          const inZone = zr ? pointInRect(ev.clientX, ev.clientY, zr) : false;
          let dropSlot: number | null = null;
          let explicitHandSlot = false;
          if (track && id && validIds.has(id)) {
            const pointed = slotUnderPointerInTrack(ev.clientX, ev.clientY, track);
            if (pointed !== null) {
              dropSlot = pointed;
              explicitHandSlot = true;
            } else if (inZone) {
              const s = slotsRef.current;
              const firstEmpty = s.findIndex((x) => x == null);
              if (firstEmpty >= 0) dropSlot = firstEmpty;
              else {
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
                const landed = sorted.binderPick.findIndex((p, i) => p === ev.pickIndex && sorted.slots[i] === id);
                setActiveDoctrineSlot(landed >= 0 ? landed : null);
                setBinderSlotPick(sorted.binderPick);
                setSlots(normalizeDoctrineSlotsForMatch(padDoctrineSlotsLocal(sorted.slots)));
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
      setLoading(false);

      const hydratePanelTextures = (start: number): void => {
        if (cancelled || engineRef.current !== next) return;
        void (async () => {
          const chunk = controlProfile.mode === "mobile" ? 9 : 18;
          const end = Math.min(panelIds.length, start + chunk);
          const preloadIds = panelIds.slice(start, end);
          try {
            await preloadCardPreviewDataUrls(preloadIds);
          } catch {
            /* best-effort */
          }
          for (let i = start; i < end; i++) {
            if (cancelled || engineRef.current !== next) return;
            texList[i] = await getBinderTextureForCatalogId(panelIds[i]!);
          }
          if (cancelled || engineRef.current !== next) return;
          next.setTextures(texList);
          if (end < panelIds.length) afterIdle(() => hydratePanelTextures(end));
        })();
      };
      if (initialVisibleEnd < panelIds.length) afterIdle(() => hydratePanelTextures(initialVisibleEnd));
    })();

    return () => {
      cancelled = true;
      ro?.disconnect();
      eng?.dispose();
      engineRef.current = null;
      setBinderEngineForUi(null);
    };
  }, [controlProfile]);

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
      b.innerHTML = `<span class="slot-hotkey">${hotkey}</span>${doctrineCardBody(i, id)}<div class="slot-live" id="picker-slot-live-${i}"></div>`;

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

    let doctrineHoverTimer: ReturnType<typeof setTimeout> | null = null;
    let doctrineHoverId: string | null = null;
    const clearDoctrineHover = (): void => {
      if (doctrineHoverTimer) clearTimeout(doctrineHoverTimer);
      doctrineHoverTimer = null;
      doctrineHoverId = null;
    };

    const onOver = (ev: MouseEvent): void => {
      if (!(ev.target instanceof Element)) return;
      const slot = ev.target.closest(".slot");
      if (!(slot instanceof HTMLElement) || !track.contains(slot)) return;
      if (slot.classList.contains("slot-empty") || slot.classList.contains("slot-locked")) return;
      const card = slot.querySelector(".doctrine-card-compact[data-catalog-id]");
      const id = card?.getAttribute("data-catalog-id");
      if (!id) return;
      if (doctrineHoverId === id) return;
      clearDoctrineHover();
      doctrineHoverId = id;
      doctrineHoverTimer = setTimeout(() => {
        doctrineHoverTimer = null;
        showDoctrineCardDetail(id, { fromHover: true, hoverSourceEl: slot });
      }, CARD_PREVIEW_HOVER_MS);
    };
    const onOut = (ev: MouseEvent): void => {
      if (!(ev.target instanceof Element)) return;
      const slot = ev.target.closest(".slot");
      if (!(slot instanceof HTMLElement) || !track.contains(slot)) return;
      const rel = ev.relatedTarget;
      if (rel instanceof Node && slot.contains(rel)) return;
      clearDoctrineHover();
      onDoctrineCardPreviewHoverLeave(ev);
    };

    track.addEventListener("mouseover", onOver);
    track.addEventListener("mouseout", onOut);
    return () => {
      clearDoctrineHover();
      track.removeEventListener("mouseover", onOver);
      track.removeEventListener("mouseout", onOut);
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
    const portalAction = eng.pickVibePortalAction(e.clientX, e.clientY, rect);
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
    const ids = QUICK_PICK_IDS.map((id) => (validIds.has(id) ? id : null));
    const norm = normalizeDoctrineSlotsForMatch(padDoctrineSlotsLocal(ids));
    setActiveDoctrineSlot(null);
    setBinderSlotPick(Array.from({ length: DOCTRINE_SLOT_COUNT }, () => null));
    setSlots(norm);
    saveDoctrinePickerState(norm, null);
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
          {!loading ? (
            <div
              className="binder-picker-tome-hint"
              role="status"
              title="Structures & spells live in the codex. Tap a card for a green outline; empty parchment or Esc clears. Drag into the bottom hand strip to assign (anywhere in the strip counts); filled cards then sort by card cost low→high. Hold ~0.4s to lift with sleeve back. Thin outer strips peel pages; RMB/MMB looks around the portal room within a small range. Double-click for full rules. Match select: Prev/Next."
            >
              Tap card · Esc / empty page clears · drag to hand · edges turn pages
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
        </div>

        {!loading ? (
          <div
            ref={doctrineStripHitRef}
            className={[
              "doctrine-wrap doctrine-wrap--rail binder-picker-doctrine-wrap",
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
        ) : null}
      </div>

      {codexDrag ? (
        <div
          ref={codexGhostRef}
          className="binder-picker-codex-ghost"
          style={{ left: codexDrag.x + 14, top: codexDrag.y + 14 }}
          aria-hidden
        >
          <div
            className="binder-picker-codex-ghost__inner"
            dangerouslySetInnerHTML={{ __html: tcgCardCompactHtml(codexDrag.catalogId, "picker") }}
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
            Thanks for visiting Battle Logs. Hope you had fun here, and have fun at the next game.
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

      {prematchSetupOpen ? (
        <button
          type="button"
          className="binder-picker-setup-backdrop"
          aria-label="Close match select"
          tabIndex={-1}
          onClick={() => setPrematchSetupOpen(false)}
        />
      ) : null}

      <div className="binder-picker-setup-fab">
        <button
          type="button"
          className="binder-picker-setup-toggle"
          aria-expanded={prematchSetupOpen}
          aria-controls="binder-prematch-setup-panel"
          id="binder-prematch-setup-trigger"
          title="Match select: map, page nav, save, start — LMB/MMB/RMB help in the hint above the binder"
          onClick={() => setPrematchSetupOpen((o) => !o)}
        >
          match select
        </button>
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
              <p className="binder-picker-setup-catalog-hint">
                Codex mixes <strong>structures</strong> (towers, production you place on the map) and{" "}
                <strong>spells / commands</strong> (one-shot effects, Mana, and per-slot cooldown after casting).
              </p>
              {!loading ? (
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
                  <button
                    type="button"
                    className="binder-picker-btn"
                    title="Reset camera"
                    onClick={() => engineRef.current?.resetCam()}
                  >
                    View
                  </button>
                  <button
                    type="button"
                    className="binder-picker-btn"
                    title="Move the codex and the Vibe Jam portal in 3D; saves in this browser (copy TS to bake into the repo)"
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
                </div>
              ) : null}
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
                  <button type="button" className="binder-picker-btn" disabled={loading} onClick={resetDefaults}>
                    Reset
                  </button>
                  <button type="button" className="binder-picker-btn" disabled={loading} onClick={pickForMe}>
                    Pick for me
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
        {prematchReturnHref ? (
          <a
            className="binder-picker-vibejam-link"
            href={prematchReturnHref}
            target="_blank"
            rel="noopener noreferrer"
            title="Return to the page that linked you here (portal continuity)"
          >
            ← Return
          </a>
        ) : null}
        <a
          className="binder-picker-vibejam-link"
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

      {roomLayoutTunerOpen ? (
        <BinderLayoutCalibratePanel
          engine={binderEngineForUi}
          visible={!loading && binderEngineForUi != null}
          onClose={() => setRoomLayoutTunerOpen(false)}
        />
      ) : null}
    </div>
  );
}
