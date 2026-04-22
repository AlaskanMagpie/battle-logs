import { hydrateCardPreviewImages } from "./cardGlbPreview";
import { doctrineCardFullModalHtml } from "./doctrineCard";

/** @deprecated Long-press to open detail was removed. */
export const CARD_DETAIL_HOLD_MS = 0;

/** Hover preview only after the pointer rests this long (ms). */
export const CARD_PREVIEW_HOVER_MS = 320;

let layer: HTMLElement | null = null;
let detailResizeRo: ResizeObserver | null = null;

/** True while the open dialog was opened from a hover preview (not button / long-press). */
let detailOpenedFromHover = false;
/** Catalog tile / deck slot / HUD slot — preview stays only while the pointer is inside this rect (screen space). */
let hoverPreviewSourceEl: HTMLElement | null = null;

/** When the dimmer covers the source tile, it stops getting `mouseout` — use global pointer checks vs. source rect. */
let hoverDismissPointerMove: ((ev: PointerEvent) => void) | null = null;
let hoverDismissPointerDown: ((ev: PointerEvent) => void) | null = null;

function disarmHoverOutsideDismiss(): void {
  if (hoverDismissPointerMove) {
    document.removeEventListener("pointermove", hoverDismissPointerMove, true);
    hoverDismissPointerMove = null;
  }
  if (hoverDismissPointerDown) {
    document.removeEventListener("pointerdown", hoverDismissPointerDown, true);
    hoverDismissPointerDown = null;
  }
}

function pointerInsideHoverSource(clientX: number, clientY: number): boolean {
  const el = hoverPreviewSourceEl;
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  const pad = 2;
  return (
    clientX >= r.left - pad &&
    clientX <= r.right + pad &&
    clientY >= r.top - pad &&
    clientY <= r.bottom + pad
  );
}

function armHoverOutsideDismiss(): void {
  disarmHoverOutsideDismiss();
  if (!detailOpenedFromHover || !hoverPreviewSourceEl || !layer || layer.hasAttribute("hidden")) return;

  hoverDismissPointerMove = (ev: PointerEvent) => {
    if (!detailOpenedFromHover || !layer || layer.hasAttribute("hidden")) {
      disarmHoverOutsideDismiss();
      return;
    }
    if (!pointerInsideHoverSource(ev.clientX, ev.clientY)) closePop();
  };

  hoverDismissPointerDown = (ev: PointerEvent) => {
    if (!detailOpenedFromHover || !layer || layer.hasAttribute("hidden")) {
      disarmHoverOutsideDismiss();
      return;
    }
    if (!pointerInsideHoverSource(ev.clientX, ev.clientY)) closePop();
  };

  const opts: AddEventListenerOptions = { capture: true, passive: true };
  document.addEventListener("pointermove", hoverDismissPointerMove, opts);
  document.addEventListener("pointerdown", hoverDismissPointerDown, opts);
}

/**
 * Call when the pointer leaves a doctrine card that may have opened a hover preview (same element subtree).
 */
export function onDoctrineCardPreviewHoverLeave(ev: MouseEvent): void {
  if (!detailOpenedFromHover || !layer || layer.hasAttribute("hidden")) return;
  const rel = ev.relatedTarget;
  const src = hoverPreviewSourceEl;
  if (src && rel instanceof Node && src.contains(rel)) return;
  closePop();
}

/** Fixed “print size” for detail cards; whole frame scales uniformly to fit the dialog. */
const DETAIL_CARD_W = 400;
const DETAIL_CARD_H = 600;

function layoutCardDetailFit(): void {
  if (!layer || layer.hasAttribute("hidden")) return;
  const body = layer.querySelector("#card-detail-pop-body") as HTMLElement | null;
  const fit = body?.querySelector(".card-detail-pop-fit") as HTMLElement | null;
  if (!body || !fit) return;
  fit.style.transform = "";
  const pw = body.clientWidth;
  const ph = body.clientHeight;
  if (pw < 2 || ph < 2) return;
  const s = Math.min(1, (pw * 0.97) / DETAIL_CARD_W, (ph * 0.97) / DETAIL_CARD_H);
  fit.style.transformOrigin = "center center";
  fit.style.transform = s < 0.999 ? `scale(${s})` : "";
}

function wireDetailResize(): void {
  if (!layer) return;
  const body = layer.querySelector("#card-detail-pop-body") as HTMLElement | null;
  if (!body) return;
  detailResizeRo?.disconnect();
  detailResizeRo = new ResizeObserver(() => layoutCardDetailFit());
  detailResizeRo.observe(body);
}

function unwireDetailResize(): void {
  detailResizeRo?.disconnect();
  detailResizeRo = null;
}

function closePop(): void {
  if (!layer || layer.hasAttribute("hidden")) return;
  disarmHoverOutsideDismiss();
  detailOpenedFromHover = false;
  hoverPreviewSourceEl = null;
  unwireDetailResize();
  layer.setAttribute("hidden", "");
  layer.setAttribute("aria-hidden", "true");
  layer.classList.remove("card-detail-pop--hover-dock");
  const body = layer.querySelector("#card-detail-pop-body");
  if (body) body.innerHTML = "";
}

function ensureLayer(): HTMLElement {
  if (layer) return layer;
  const el = document.createElement("div");
  el.id = "card-detail-pop";
  el.className = "card-detail-pop";
  el.setAttribute("hidden", "");
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `
    <button type="button" class="card-detail-pop-backdrop" aria-label="Close card details"></button>
    <div class="card-detail-pop-body" id="card-detail-pop-body" role="dialog" aria-modal="true" aria-label="Card details" tabindex="-1"></div>
  `;
  document.body.appendChild(el);
  layer = el;

  const backdropBtn = el.querySelector(".card-detail-pop-backdrop") as HTMLButtonElement;
  backdropBtn.addEventListener("click", closePop);
  /* Full-screen dimmer: dismiss on press everywhere under the card (incl. catalog chrome). */
  backdropBtn.addEventListener(
    "pointerdown",
    (ev: PointerEvent) => {
      if (!layer || layer.hasAttribute("hidden")) return;
      ev.preventDefault();
      closePop();
    },
    { capture: true },
  );
  window.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && !el.hasAttribute("hidden")) {
      ev.preventDefault();
      closePop();
    }
  });

  return el;
}

export function isDoctrineCardDetailOpen(): boolean {
  return layer != null && !layer.hasAttribute("hidden");
}

export function closeDoctrineCardDetail(): void {
  closePop();
}

export type ShowDoctrineCardDetailOpts = {
  /** When true, preview dismisses as soon as the pointer leaves `hoverSourceEl`’s screen rect. */
  fromHover?: boolean;
  /** Required with `fromHover` — the catalog tile, picker deck slot, or HUD slot bounds. */
  hoverSourceEl?: HTMLElement;
};

export function showDoctrineCardDetail(catalogId: string, opts?: ShowDoctrineCardDetailOpts): void {
  disarmHoverOutsideDismiss();
  const wantHover = opts?.fromHover === true;
  const src = wantHover && opts?.hoverSourceEl instanceof HTMLElement ? opts.hoverSourceEl : null;
  detailOpenedFromHover = wantHover && !!src;
  hoverPreviewSourceEl = src;
  const el = ensureLayer();
  if (detailOpenedFromHover) el.classList.add("card-detail-pop--hover-dock");
  else el.classList.remove("card-detail-pop--hover-dock");
  const body = el.querySelector("#card-detail-pop-body") as HTMLElement;
  body.innerHTML = `<div class="card-detail-pop-fit">${doctrineCardFullModalHtml(catalogId)}</div>`;
  hydrateCardPreviewImages(body);
  el.removeAttribute("hidden");
  el.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    body.focus({ preventScroll: true });
    layoutCardDetailFit();
    wireDetailResize();
    if (detailOpenedFromHover) armHoverOutsideDismiss();
  });
}
