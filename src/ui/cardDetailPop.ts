import { doctrineCardFullModalHtml } from "./doctrineCard";

/** Hold duration before opening the full doctrine card popover. */
export const CARD_DETAIL_HOLD_MS = 480;

let layer: HTMLElement | null = null;
let detailResizeRo: ResizeObserver | null = null;

function layoutCardDetailFit(): void {
  if (!layer || layer.hasAttribute("hidden")) return;
  const body = layer.querySelector("#card-detail-pop-body") as HTMLElement | null;
  const fit = body?.querySelector(".card-detail-pop-fit") as HTMLElement | null;
  const card = fit?.querySelector(".tcg--detail-pop") as HTMLElement | null;
  if (!body || !fit || !card) return;
  card.style.transform = "";
  const pw = body.clientWidth;
  const ph = body.clientHeight;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  if (cw < 2 || ch < 2 || pw < 2 || ph < 2) return;
  const s = Math.min(1, (pw * 0.97) / cw, (ph * 0.97) / ch);
  card.style.transformOrigin = "center center";
  card.style.transform = `scale(${s})`;
}

function wireDetailResize(): void {
  if (!layer) return;
  const panel = layer.querySelector(".card-detail-pop-panel") as HTMLElement | null;
  if (!panel) return;
  detailResizeRo?.disconnect();
  detailResizeRo = new ResizeObserver(() => layoutCardDetailFit());
  detailResizeRo.observe(panel);
}

function unwireDetailResize(): void {
  detailResizeRo?.disconnect();
  detailResizeRo = null;
}

function closePop(): void {
  if (!layer || layer.hasAttribute("hidden")) return;
  unwireDetailResize();
  layer.setAttribute("hidden", "");
  layer.setAttribute("aria-hidden", "true");
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
    <div class="card-detail-pop-panel" role="dialog" aria-modal="true" aria-labelledby="card-detail-pop-title">
      <div class="card-detail-pop-head">
        <h2 id="card-detail-pop-title" class="card-detail-pop-title">Doctrine card</h2>
        <button type="button" class="card-detail-pop-close" aria-label="Close">×</button>
      </div>
      <div class="card-detail-pop-body" id="card-detail-pop-body"></div>
    </div>
  `;
  document.body.appendChild(el);
  layer = el;

  el.querySelector(".card-detail-pop-backdrop")!.addEventListener("click", closePop);
  el.querySelector(".card-detail-pop-close")!.addEventListener("click", closePop);
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

export function showDoctrineCardDetail(catalogId: string): void {
  const el = ensureLayer();
  const body = el.querySelector("#card-detail-pop-body") as HTMLElement;
  body.innerHTML = `<div class="card-detail-pop-fit">${doctrineCardFullModalHtml(catalogId)}</div>`;
  el.removeAttribute("hidden");
  el.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    layoutCardDetailFit();
    wireDetailResize();
  });
}
