import { hydrateCardPreviewImages } from "./cardGlbPreview";
import { getCardArtUrl } from "./cardArtManifest";
import { doctrineCardFullModalHtml } from "./doctrineCard";
import { getCatalogEntry } from "../game/catalog";
import { cardArtOverlayHtml } from "./cardArtOverlay";

/** @deprecated Long-press to open detail was removed. */
export const CARD_DETAIL_HOLD_MS = 0;

/**
 * Full card preview (docked) only after the pointer is held this long on a doctrine slot
 * (no quick hover). Moving past the drag threshold cancels the timer and uses cast/drag instead.
 */
export const CARD_PREVIEW_LONG_PRESS_MS = 520;

/**
 * Prematch binder / doctrine picker — DOM hand strip only.
 * Longer than match HUD (`CARD_PREVIEW_LONG_PRESS_MS`) and codex lift (~400ms in `CardBinderEngine`)
 * so full-card preview does not compete with grabbing a codex card.
 */
export const CARD_PREVIEW_BINDER_HAND_MS = 1050;

/** Cancel binder-hand preview only after movement exceeds this (same “stay put” idea as codex long-press slop). */
export const CARD_PREVIEW_BINDER_HAND_SLOP_PX = 22;

/** @deprecated Use `CARD_PREVIEW_LONG_PRESS_MS` — preview is no longer hover-timed. */
export const CARD_PREVIEW_HOVER_MS = CARD_PREVIEW_LONG_PRESS_MS;

let layer: HTMLElement | null = null;
let detailResizeRo: ResizeObserver | null = null;
let detailRenderToken = 0;

/** True when the open dialog was opened from a long-press / docked preview (not dblclick / direct open). */
let detailOpenedFromHover = false;
/** Screen bounds used for dismissing the docked preview (doctrine hand slot, etc.). */
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

/** Hover preview stays open while the pointer is over the rail slot or the floating preview panel. */
function pointerInsideHoverDismissSafeZone(clientX: number, clientY: number): boolean {
  if (pointerInsideHoverSource(clientX, clientY)) return true;
  const body = layer?.querySelector("#card-detail-pop-body");
  if (!(body instanceof HTMLElement)) return false;
  const r = body.getBoundingClientRect();
  const pad = 8;
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
    if (!pointerInsideHoverDismissSafeZone(ev.clientX, ev.clientY)) closePop();
  };

  hoverDismissPointerDown = (ev: PointerEvent) => {
    if (!detailOpenedFromHover || !layer || layer.hasAttribute("hidden")) {
      disarmHoverOutsideDismiss();
      return;
    }
    if (!pointerInsideHoverDismissSafeZone(ev.clientX, ev.clientY)) closePop();
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
  if (rel instanceof Node && layer.contains(rel)) return;
  closePop();
}

function layoutCardDetailFit(): void {
  if (!layer || layer.hasAttribute("hidden")) return;
  const body = layer.querySelector("#card-detail-pop-body") as HTMLElement | null;
  const fit = body?.querySelector(".card-detail-pop-fit") as HTMLElement | null;
  if (!body || !fit) return;
  fit.style.transform = "";
  const pw = body.clientWidth;
  const ph = body.clientHeight;
  if (pw < 2 || ph < 2) return;
  const nw = Math.max(1, fit.offsetWidth, fit.scrollWidth);
  const nh = Math.max(1, fit.offsetHeight, fit.scrollHeight);
  const s = Math.min(1, (pw * 0.97) / nw, (ph * 0.97) / nh);
  fit.style.transformOrigin = "center center";
  fit.style.transform = s < 0.999 ? `scale(${s})` : "";
}

function wireDetailResize(): void {
  if (!layer) return;
  const body = layer.querySelector("#card-detail-pop-body") as HTMLElement | null;
  const fit = body?.querySelector(".card-detail-pop-fit") as HTMLElement | null;
  if (!body) return;
  detailResizeRo?.disconnect();
  detailResizeRo = new ResizeObserver(() => layoutCardDetailFit());
  detailResizeRo.observe(body);
  if (fit) detailResizeRo.observe(fit);
}

function unwireDetailResize(): void {
  detailResizeRo?.disconnect();
  detailResizeRo = null;
}

function escapeAttr(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function authoredCardImageHtml(catalogId: string, url: string): string {
  const name = getCatalogEntry(catalogId)?.name ?? catalogId;
  return `<div class="card-detail-pop-fit card-detail-pop-fit--art"><div class="card-detail-pop-card-frame"><img class="card-detail-pop-card-img" src="${escapeAttr(url)}" alt="${escapeAttr(name)} full card" draggable="false" />${cardArtOverlayHtml(catalogId)}</div></div>`;
}

function generatedCardHtml(catalogId: string): string {
  return `<div class="card-detail-pop-fit">${doctrineCardFullModalHtml(catalogId)}</div>`;
}

function loadingCardHtml(): string {
  return `<div class="card-detail-pop-fit card-detail-pop-fit--loading">Loading card…</div>`;
}

function refitDetailSoon(body: HTMLElement): void {
  const refitSoon = (): void => {
    requestAnimationFrame(() => layoutCardDetailFit());
  };
  body.querySelectorAll("img").forEach((img) => {
    if (!(img instanceof HTMLImageElement)) return;
    img.addEventListener("load", refitSoon, { once: true, passive: true });
    if (img.complete && img.naturalWidth > 0) refitSoon();
  });
  requestAnimationFrame(() => {
    body.focus({ preventScroll: true });
    layoutCardDetailFit();
    wireDetailResize();
    refitSoon();
    if (detailOpenedFromHover) armHoverOutsideDismiss();
  });
}

function closePop(): void {
  if (!layer || layer.hasAttribute("hidden")) return;
  detailRenderToken++;
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

function wireCardDetailPopEvents(el: HTMLElement): void {
  if (el.dataset.detailPopWired === "1") return;
  el.dataset.detailPopWired = "1";

  const backdropBtn = el.querySelector(".card-detail-pop-backdrop") as HTMLButtonElement | null;
  if (!backdropBtn) return;

  backdropBtn.addEventListener("click", closePop);
  /* Full-screen dimmer: dismiss on press everywhere under the card (incl. catalog chrome). */
  backdropBtn.addEventListener(
    "pointerdown",
    (ev: PointerEvent) => {
      const L = layer;
      if (!L || L.hasAttribute("hidden")) return;
      ev.preventDefault();
      closePop();
    },
    { capture: true },
  );
  window.addEventListener("keydown", (ev: KeyboardEvent) => {
    const L = layer;
    if (ev.key === "Escape" && L && !L.hasAttribute("hidden")) {
      ev.preventDefault();
      closePop();
    }
  });
}

function ensureLayer(): HTMLElement {
  const nodes = document.querySelectorAll(".card-detail-pop");
  nodes.forEach((n, i) => {
    if (i > 0) (n as HTMLElement).remove();
  });

  let el = nodes[0] as HTMLElement | undefined;
  if (!el) {
    el = document.createElement("div");
    el.id = "card-detail-pop";
    el.className = "card-detail-pop";
    el.setAttribute("hidden", "");
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = `
    <button type="button" class="card-detail-pop-backdrop" aria-label="Close card details"></button>
    <div class="card-detail-pop-body" id="card-detail-pop-body" role="dialog" aria-modal="true" aria-label="Card details" tabindex="-1"></div>
  `;
    document.body.appendChild(el);
  } else if (!el.id) el.id = "card-detail-pop";

  layer = el;
  wireCardDetailPopEvents(el);
  return el;
}

export function isDoctrineCardDetailOpen(): boolean {
  return layer != null && !layer.hasAttribute("hidden");
}

export function closeDoctrineCardDetail(): void {
  closePop();
}

export type ShowDoctrineCardDetailOpts = {
  /** When true, preview uses the docked rail mode and dismisses when the pointer leaves the slot/preview. */
  fromHover?: boolean;
  /** Required with `fromHover` — the catalog tile, picker deck slot, or HUD slot bounds. */
  hoverSourceEl?: HTMLElement;
};

export function showDoctrineCardDetail(catalogId: string, opts?: ShowDoctrineCardDetailOpts): void {
  disarmHoverOutsideDismiss();
  const renderToken = ++detailRenderToken;
  const wantHover = opts?.fromHover === true;
  const src = wantHover && opts?.hoverSourceEl instanceof HTMLElement ? opts.hoverSourceEl : null;
  detailOpenedFromHover = wantHover && !!src;
  hoverPreviewSourceEl = src;
  const el = ensureLayer();
  if (detailOpenedFromHover) el.classList.add("card-detail-pop--hover-dock");
  else el.classList.remove("card-detail-pop--hover-dock");
  const body = el.querySelector("#card-detail-pop-body") as HTMLElement;
  unwireDetailResize();
  body.innerHTML = loadingCardHtml();
  el.removeAttribute("hidden");
  el.setAttribute("aria-hidden", "false");
  refitDetailSoon(body);

  void (async () => {
    const artUrl = await getCardArtUrl(catalogId);
    if (renderToken !== detailRenderToken || !layer || layer.hasAttribute("hidden")) return;
    unwireDetailResize();
    body.innerHTML = artUrl ? authoredCardImageHtml(catalogId, artUrl) : generatedCardHtml(catalogId);
    if (!artUrl) hydrateCardPreviewImages(body);
    refitDetailSoon(body);
  })();
}
