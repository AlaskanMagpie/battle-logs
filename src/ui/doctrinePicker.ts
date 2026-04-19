import { CATALOG, DEFAULT_DOCTRINE_SLOTS } from "../game/catalog";
import {
  CARD_DETAIL_HOLD_MS,
  closeDoctrineCardDetail,
  isDoctrineCardDetailOpen,
  showDoctrineCardDetail,
} from "./cardDetailPop";
import { doctrineCardGhostSummary, doctrineCardLibraryHtml } from "./doctrineCard";
import {
  destroyDragGhost,
  DRAG_THRESHOLD_PX,
  makeDragGhost,
  moveDragGhost,
  pointInRect,
} from "./doctrineDrag";
import { wirePanStrip } from "./panStrip";

const STORAGE_KEY = "signalWars_doctrine_v1";

export function loadDoctrineSlots(): (string | null)[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_DOCTRINE_SLOTS];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 16) return [...DEFAULT_DOCTRINE_SLOTS];
    return parsed.map((x) => (typeof x === "string" ? x : null)) as (string | null)[];
  } catch {
    return [...DEFAULT_DOCTRINE_SLOTS];
  }
}

export function saveDoctrineSlots(slots: (string | null)[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(slots));
}

function renderDeckSlot(i: number, catalogId: string | null): string {
  if (!catalogId) {
    return `<div class="pick-slot pick-slot-empty" data-deck-i="${i}" tabindex="0" role="gridcell"><span class="pick-slot-ix">${i + 1}</span><span class="pick-slot-drop-hint">Tap</span></div>`;
  }
  return `<div class="pick-slot pick-slot-filled" data-deck-i="${i}" draggable="false" tabindex="0" role="gridcell">${doctrineCardLibraryHtml(catalogId, i)}</div>`;
}

export function mountDoctrinePicker(root: HTMLElement, onStart: (slots: (string | null)[]) => void): void {
  const validIds = new Set(CATALOG.map((c) => c.id));

  const catalogHtml = CATALOG.map((c) => {
    return `<article class="catalog-card" data-catalog-id="${c.id}" tabindex="0" role="listitem">${doctrineCardLibraryHtml(c.id)}</article>`;
  }).join("");

  root.innerHTML = `
    <div class="picker-shell picker-shell--solo">
      <div class="picker-panel picker-deck-panel picker-deck-solo">
        <div class="picker-deck-solo-head">
          <h2>Doctrine deck</h2>
          <p class="pick-hint">Two rows of eight — <strong>tap a slot</strong> to open the catalog and pick a card. <strong>Press and hold</strong> any card for full stats. Drag between slots to swap, or onto the catalog panel while open to clear.</p>
        </div>
        <div class="picker-deck-solo-stack">
          <div class="picker-deck-view" id="picker-deck-view">
            <div class="picker-card-track picker-deck-track picker-deck-grid-2x8" id="picker-deck-track" role="grid" aria-label="Doctrine slots, two by eight"></div>
          </div>
        </div>
        <div class="pick-actions">
          <button type="button" id="pick-defaults">Reset defaults</button>
          <button type="button" id="pick-start">Start match</button>
        </div>
      </div>
    </div>

    <div class="picker-catalog-overlay" id="picker-catalog-overlay" hidden aria-hidden="true">
      <button type="button" class="picker-catalog-overlay-backdrop" id="picker-catalog-backdrop" tabindex="-1" aria-label="Close catalog"></button>
      <div class="picker-catalog-overlay-panel" role="dialog" aria-modal="true" aria-labelledby="picker-catalog-title">
        <div class="picker-catalog-overlay-head">
          <h2 id="picker-catalog-title">Catalog</h2>
          <button type="button" class="picker-catalog-close-x" id="picker-catalog-close-x" aria-label="Close">×</button>
        </div>
        <p class="pick-hint" id="picker-catalog-subtitle"></p>
        <div class="picker-card-stack picker-catalog-overlay-body">
          <div class="picker-card-view" id="picker-catalog-view">
            <div class="picker-card-track" id="picker-catalog-track" role="list">${catalogHtml}</div>
          </div>
          <div class="picker-pan-stack" aria-hidden="true">
            <div class="picker-pan-row" id="picker-catalog-pan-row-y" hidden>
              <span class="picker-pan-label">Up / down</span>
              <input type="range" class="picker-pan-slider" id="picker-catalog-pan-y" min="0" max="1" value="0" step="1" />
            </div>
            <div class="picker-pan-row" id="picker-catalog-pan-row-x" hidden>
              <span class="picker-pan-label">Left / right</span>
              <input type="range" class="picker-pan-slider" id="picker-catalog-pan-x" min="0" max="1" value="0" step="1" />
            </div>
          </div>
        </div>
        <div class="picker-catalog-overlay-footer">
          <button type="button" class="hud-btn" id="picker-catalog-close-done">Done</button>
        </div>
      </div>
    </div>
  `;

  const overlay = root.querySelector("#picker-catalog-overlay") as HTMLElement;
  const backdrop = root.querySelector("#picker-catalog-backdrop") as HTMLButtonElement;
  const subtitle = root.querySelector("#picker-catalog-subtitle") as HTMLElement;
  const catalogWrap = root.querySelector(".picker-catalog-overlay-body") as HTMLElement;
  const catalogView = root.querySelector("#picker-catalog-view") as HTMLElement;
  const catalogTrack = root.querySelector("#picker-catalog-track") as HTMLElement;
  const catalogPanX = root.querySelector("#picker-catalog-pan-x") as HTMLInputElement;
  const catalogPanY = root.querySelector("#picker-catalog-pan-y") as HTMLInputElement;
  const catalogRowX = root.querySelector("#picker-catalog-pan-row-x") as HTMLElement;
  const catalogRowY = root.querySelector("#picker-catalog-pan-row-y") as HTMLElement;

  const deckTrack = root.querySelector("#picker-deck-track") as HTMLElement;

  function layoutCatalogCols(): void {
    const w = Math.max(1, catalogView.clientWidth);
    const gap = 8;
    const minCardW = 88;
    const cols = Math.max(2, Math.min(6, Math.floor((w + gap) / (minCardW + gap))));
    catalogTrack.style.setProperty("--picker-cols", String(cols));
  }

  const catalogRo = new ResizeObserver(() => layoutCatalogCols());
  catalogRo.observe(catalogView);
  layoutCatalogCols();
  window.addEventListener("resize", layoutCatalogCols);

  wirePanStrip({
    view: catalogView,
    track: catalogTrack,
    sliderX: catalogPanX,
    rowX: catalogRowX,
    sliderY: catalogPanY,
    rowY: catalogRowY,
  });

  let slots: (string | null)[] = loadDoctrineSlots().map((id) => (id && validIds.has(id) ? id : null));
  let activeSlotIndex: number | null = null;

  function paintDeck(): void {
    deckTrack.innerHTML = Array.from({ length: 16 }, (_, i) => renderDeckSlot(i, slots[i] ?? null)).join("");
    deckTrack.querySelectorAll(".pick-slot").forEach((el) => el.classList.remove("pick-slot-active"));
    if (activeSlotIndex !== null) {
      deckTrack.querySelector(`[data-deck-i="${activeSlotIndex}"]`)?.classList.add("pick-slot-active");
    }
  }

  function openCatalog(slotIndex: number): void {
    activeSlotIndex = slotIndex;
    paintDeck();
    subtitle.textContent = `Slot ${slotIndex + 1} — tap or click a card to assign, or drag it onto the deck.`;
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
    layoutCatalogCols();
    queueMicrotask(() => layoutCatalogCols());
    catalogPanX.value = "0";
    catalogPanY.value = "0";
    catalogTrack.style.transform = "translate(0px, 0px)";
  }

  function closeCatalog(): void {
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
    activeSlotIndex = null;
    paintDeck();
    catalogWrap.classList.remove("picker-catalog-drop");
  }

  paintDeck();

  type DragFrom = { kind: "catalog"; catalogId: string } | { kind: "deck"; fromIndex: number; catalogId: string };

  let session: {
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
    from: DragFrom;
    ghost: HTMLDivElement | null;
  } | null = null;

  /** Tap deck slot (no drag) → open catalog. */
  let slotTap: { pointerId: number; slotIndex: number; x: number; y: number } | null = null;

  function findDeckIndexUnder(px: number, py: number): number | null {
    const el = document.elementFromPoint(px, py);
    const slot = el?.closest("[data-deck-i]") as HTMLElement | null;
    if (!slot || !deckTrack.contains(slot)) return null;
    const i = Number(slot.dataset.deckI);
    return Number.isFinite(i) ? i : null;
  }

  function catalogPanelRect(): DOMRect {
    return (root.querySelector(".picker-catalog-overlay-panel") as HTMLElement).getBoundingClientRect();
  }

  function onCatalogArea(px: number, py: number): boolean {
    if (overlay.hidden) return false;
    return pointInRect(px, py, catalogPanelRect());
  }

  function endSession(ev: PointerEvent): void {
    if (!session || ev.pointerId !== session.pointerId) return;
    window.removeEventListener("pointermove", onWinMove);
    window.removeEventListener("pointerup", onWinUp);
    window.removeEventListener("pointercancel", onWinUp);
    const { dragging, from, ghost } = session;
    session = null;
    try {
      if (document.body.hasPointerCapture(ev.pointerId)) document.body.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    destroyDragGhost(ghost);

    if (!dragging) return;

    const px = ev.clientX;
    const py = ev.clientY;
    const targetI = findDeckIndexUnder(px, py);

    if (from.kind === "catalog") {
      if (targetI !== null) slots[targetI] = from.catalogId;
    } else {
      if (onCatalogArea(px, py)) {
        slots[from.fromIndex] = null;
      } else if (targetI !== null) {
        const other = slots[targetI] ?? null;
        slots[from.fromIndex] = other;
        slots[targetI] = from.catalogId;
      }
    }
    paintDeck();
  }

  function onWinMove(ev: PointerEvent): void {
    if (!session || ev.pointerId !== session.pointerId) return;
    const dx = ev.clientX - session.startX;
    const dy = ev.clientY - session.startY;
    if (!session.dragging && dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
      session.dragging = true;
      slotTap = null;
      try {
        document.body.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      session.ghost = makeDragGhost(
        `<div class="ghost-compact">${doctrineCardGhostSummary(session.from.catalogId)}</div>`,
      );
    }
    if (session.dragging && session.ghost) moveDragGhost(session.ghost, ev.clientX, ev.clientY);

    const targetI = findDeckIndexUnder(ev.clientX, ev.clientY);
    for (const el of deckTrack.querySelectorAll(".pick-slot")) el.classList.remove("pick-slot-hover");
    if (targetI !== null) deckTrack.querySelector(`[data-deck-i="${targetI}"]`)?.classList.add("pick-slot-hover");
    if (session.from.kind === "deck" && onCatalogArea(ev.clientX, ev.clientY)) {
      catalogWrap.classList.add("picker-catalog-drop");
    } else {
      catalogWrap.classList.remove("picker-catalog-drop");
    }
  }

  function onWinUp(ev: PointerEvent): void {
    catalogWrap.classList.remove("picker-catalog-drop");
    endSession(ev);
  }

  function beginPointerDrag(from: DragFrom, ev: PointerEvent, start?: { x: number; y: number }): void {
    if (session) return;
    session = {
      pointerId: ev.pointerId,
      startX: start?.x ?? ev.clientX,
      startY: start?.y ?? ev.clientY,
      dragging: false,
      from,
      ghost: null,
    };
    window.addEventListener("pointermove", onWinMove);
    window.addEventListener("pointerup", onWinUp);
    window.addEventListener("pointercancel", onWinUp);
  }

  type DeckPending = {
    pointerId: number;
    fromIndex: number;
    catalogId: string;
    x: number;
    y: number;
    detailTimer: ReturnType<typeof setTimeout> | null;
    detailShown: boolean;
    captureEl: HTMLElement;
  };

  let deckDragPending: DeckPending | null = null;

  function clearDeckPending(): void {
    if (deckDragPending) {
      if (deckDragPending.detailTimer) clearTimeout(deckDragPending.detailTimer);
      try {
        if (deckDragPending.captureEl.hasPointerCapture(deckDragPending.pointerId)) {
          deckDragPending.captureEl.releasePointerCapture(deckDragPending.pointerId);
        }
      } catch {
        /* ignore */
      }
    }
    deckDragPending = null;
    window.removeEventListener("pointermove", onDeckPendingMove);
    window.removeEventListener("pointerup", onDeckPendingUp);
    window.removeEventListener("pointercancel", onDeckPendingUp);
  }

  function onDeckPendingMove(ev: PointerEvent): void {
    if (!deckDragPending || deckDragPending.pointerId !== ev.pointerId) return;
    const dx = ev.clientX - deckDragPending.x;
    const dy = ev.clientY - deckDragPending.y;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    if (deckDragPending.detailTimer) clearTimeout(deckDragPending.detailTimer);
    const p = deckDragPending;
    clearDeckPending();
    beginPointerDrag({ kind: "deck", fromIndex: p.fromIndex, catalogId: p.catalogId }, ev, { x: p.x, y: p.y });
  }

  function onDeckPendingUp(ev: PointerEvent): void {
    if (!deckDragPending || deckDragPending.pointerId !== ev.pointerId) return;
    if (deckDragPending.detailTimer) clearTimeout(deckDragPending.detailTimer);
    const dx = ev.clientX - deckDragPending.x;
    const dy = ev.clientY - deckDragPending.y;
    const i = deckDragPending.fromIndex;
    const showed = deckDragPending.detailShown;
    clearDeckPending();
    if (showed) return;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
      openCatalog(i);
    }
  }

  type CatalogPending = {
    pointerId: number;
    catalogId: string;
    x: number;
    y: number;
    detailTimer: ReturnType<typeof setTimeout> | null;
    detailShown: boolean;
    captureEl: HTMLElement;
  };

  let catalogDragPending: CatalogPending | null = null;
  let suppressNextCatalogClick = false;

  function clearCatalogPending(): void {
    if (catalogDragPending) {
      if (catalogDragPending.detailTimer) clearTimeout(catalogDragPending.detailTimer);
      try {
        if (catalogDragPending.captureEl.hasPointerCapture(catalogDragPending.pointerId)) {
          catalogDragPending.captureEl.releasePointerCapture(catalogDragPending.pointerId);
        }
      } catch {
        /* ignore */
      }
    }
    catalogDragPending = null;
    window.removeEventListener("pointermove", onCatalogPendingMove);
    window.removeEventListener("pointerup", onCatalogPendingUp);
    window.removeEventListener("pointercancel", onCatalogPendingUp);
  }

  function onCatalogPendingMove(ev: PointerEvent): void {
    if (!catalogDragPending || catalogDragPending.pointerId !== ev.pointerId) return;
    const dx = ev.clientX - catalogDragPending.x;
    const dy = ev.clientY - catalogDragPending.y;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    if (catalogDragPending.detailTimer) clearTimeout(catalogDragPending.detailTimer);
    const p = catalogDragPending;
    clearCatalogPending();
    beginPointerDrag({ kind: "catalog", catalogId: p.catalogId }, ev, { x: p.x, y: p.y });
  }

  function onCatalogPendingUp(ev: PointerEvent): void {
    if (!catalogDragPending || catalogDragPending.pointerId !== ev.pointerId) return;
    if (catalogDragPending.detailTimer) clearTimeout(catalogDragPending.detailTimer);
    const showed = catalogDragPending.detailShown;
    clearCatalogPending();
    if (showed) suppressNextCatalogClick = true;
  }

  root.addEventListener("pointerdown", (ev: PointerEvent) => {
    const card = (ev.target as HTMLElement).closest(".catalog-card") as HTMLElement | null;
    if (card && catalogTrack.contains(card)) {
      const id = card.dataset.catalogId;
      if (!id || !validIds.has(id)) return;
      ev.preventDefault();
      clearDeckPending();
      slotTap = null;
      clearCatalogPending();
      const downPid = ev.pointerId;
      try {
        card.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      catalogDragPending = {
        pointerId: downPid,
        catalogId: id,
        x: ev.clientX,
        y: ev.clientY,
        detailTimer: null,
        detailShown: false,
        captureEl: card,
      };
      catalogDragPending.detailTimer = setTimeout(() => {
        if (!catalogDragPending || catalogDragPending.pointerId !== downPid) return;
        catalogDragPending.detailShown = true;
        showDoctrineCardDetail(catalogDragPending.catalogId);
      }, CARD_DETAIL_HOLD_MS);
      window.addEventListener("pointermove", onCatalogPendingMove);
      window.addEventListener("pointerup", onCatalogPendingUp);
      window.addEventListener("pointercancel", onCatalogPendingUp);
      return;
    }
    const slot = (ev.target as HTMLElement).closest("[data-deck-i]") as HTMLElement | null;
    if (slot && deckTrack.contains(slot)) {
      const i = Number(slot.dataset.deckI);
      if (!Number.isFinite(i)) return;
      const id = slots[i];
      if (id) {
        ev.preventDefault();
        clearCatalogPending();
        slotTap = null;
        clearDeckPending();
        const downPid = ev.pointerId;
        try {
          slot.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        deckDragPending = {
          pointerId: downPid,
          fromIndex: i,
          catalogId: id,
          x: ev.clientX,
          y: ev.clientY,
          detailTimer: null,
          detailShown: false,
          captureEl: slot,
        };
        deckDragPending.detailTimer = setTimeout(() => {
          if (!deckDragPending || deckDragPending.pointerId !== downPid) return;
          deckDragPending.detailShown = true;
          showDoctrineCardDetail(deckDragPending.catalogId);
        }, CARD_DETAIL_HOLD_MS);
        window.addEventListener("pointermove", onDeckPendingMove);
        window.addEventListener("pointerup", onDeckPendingUp);
        window.addEventListener("pointercancel", onDeckPendingUp);
      } else {
        clearCatalogPending();
        slotTap = { pointerId: ev.pointerId, slotIndex: i, x: ev.clientX, y: ev.clientY };
      }
    }
  });

  window.addEventListener(
    "pointerup",
    (ev: PointerEvent) => {
      if (!slotTap || slotTap.pointerId !== ev.pointerId) return;
      if (session?.pointerId === ev.pointerId) {
        slotTap = null;
        return;
      }
      const dx = ev.clientX - slotTap.x;
      const dy = ev.clientY - slotTap.y;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        openCatalog(slotTap.slotIndex);
      }
      slotTap = null;
    },
    true,
  );

  catalogTrack.addEventListener("click", (ev: MouseEvent) => {
    if (suppressNextCatalogClick) {
      suppressNextCatalogClick = false;
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (overlay.hidden || activeSlotIndex === null) return;
    const card = (ev.target as HTMLElement).closest(".catalog-card") as HTMLElement | null;
    if (!card || !catalogTrack.contains(card)) return;
    const id = card.dataset.catalogId;
    if (!id || !validIds.has(id)) return;
    ev.preventDefault();
    slots[activeSlotIndex] = id;
    paintDeck();
    closeCatalog();
  });

  function wireClose(): void {
    closeCatalog();
  }

  backdrop.addEventListener("click", wireClose);
  root.querySelector("#picker-catalog-close-x")!.addEventListener("click", wireClose);
  root.querySelector("#picker-catalog-close-done")!.addEventListener("click", wireClose);

  window.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    if (isDoctrineCardDetailOpen()) {
      ev.preventDefault();
      closeDoctrineCardDetail();
      return;
    }
    if (!overlay.hidden) {
      ev.preventDefault();
      wireClose();
    }
  });

  root.querySelector("#pick-defaults")!.addEventListener("click", () => {
    slots = DEFAULT_DOCTRINE_SLOTS.map((id) => (id && validIds.has(id) ? id : null));
    closeCatalog();
    paintDeck();
  });

  root.querySelector("#pick-start")!.addEventListener("click", () => {
    saveDoctrineSlots(slots);
    root.style.display = "none";
    onStart(slots);
  });
}
