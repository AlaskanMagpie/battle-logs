/**
 * Plastic “binder sleeve” panel (2D) — layout mirrors CardBinder reference.
 * Keep numeric layout aligned with `BINDER_CFG` + 3×3 grid in CardBinderEngine.ts.
 */
const PANEL_TEX_W = 400;
const PAGE_W = 2.1;
const PAGE_H = 2.85;
const SEAM_GAP = 0.04;
const GRID = 3;

const colW = (PAGE_W - SEAM_GAP * 2) / GRID;
const rowH = (PAGE_H - SEAM_GAP * 2) / GRID;

export function binderSleevePixelSize(): { w: number; h: number } {
  const h = Math.round(PANEL_TEX_W * (rowH / colW));
  return { w: PANEL_TEX_W, h };
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawImageContain(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  x: number,
  y: number,
  cw: number,
  ch: number,
): void {
  const iw =
    img instanceof HTMLImageElement
      ? img.naturalWidth
      : img instanceof HTMLVideoElement
        ? img.videoWidth
        : (img as HTMLCanvasElement).width;
  const ih =
    img instanceof HTMLImageElement
      ? img.naturalHeight
      : img instanceof HTMLVideoElement
        ? img.videoHeight
        : (img as HTMLCanvasElement).height;
  if (iw < 1 || ih < 1) return;
  const scale = Math.min(cw / iw, ch / ih);
  const sw = iw * scale;
  const sh = ih * scale;
  const ox = x + (cw - sw) / 2;
  const oy = y + (ch - sh) / 2;
  ctx.drawImage(img, ox, oy, sw, sh);
}

/** Pocket frame + optional full-card art (scaled into cavity). */
export function composeCardIntoBinderSleeve(inner: HTMLCanvasElement | null): HTMLCanvasElement {
  const { w: W, h: H } = binderSleevePixelSize();
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  if (!ctx) return c;

  const b = 14;

  ctx.fillStyle = "#111318";
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "rgba(255,255,255,.12)";
  for (let i = 0; i < 20; i++) {
    const t = i / 19;
    ctx.fillRect(6 + t * (W - 12), 3, 2, 2);
    ctx.fillRect(6 + t * (W - 12), H - 5, 2, 2);
  }
  for (let i = 0; i < 28; i++) {
    const t = i / 27;
    ctx.fillRect(3, 6 + t * (H - 12), 2, 2);
    ctx.fillRect(W - 5, 6 + t * (H - 12), 2, 2);
  }

  ctx.fillStyle = "#08090e";
  roundRectPath(ctx, b, b, W - b * 2, H - b * 2, 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1;
  roundRectPath(ctx, b + 0.5, b + 0.5, W - b * 2 - 1, H - b * 2 - 1, 7.5);
  ctx.stroke();

  const cardX = b + 6;
  const cardY = b + 6;
  const cardW = W - b * 2 - 12;
  const cardH = H - b * 2 - 12;

  if (inner) {
    drawImageContain(ctx, inner, cardX, cardY, cardW, cardH);
  } else {
    ctx.fillStyle = "rgba(255,255,255,.04)";
    roundRectPath(ctx, b + 4, b + 4, W - b * 2 - 8, H - b * 2 - 8, 6);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.12)";
    ctx.font = "500 12px monospace";
    ctx.textAlign = "center";
    ctx.fillText("EMPTY", W / 2, H / 2);
  }

  let gr: CanvasGradient;
  gr = ctx.createLinearGradient(0, b, 0, b + 22);
  gr.addColorStop(0, "rgba(0,0,0,.6)");
  gr.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gr;
  ctx.fillRect(b, b, W - b * 2, 22);
  gr = ctx.createLinearGradient(0, H - b, 0, H - b - 16);
  gr.addColorStop(0, "rgba(0,0,0,.45)");
  gr.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gr;
  ctx.fillRect(b, H - b - 16, W - b * 2, 16);
  gr = ctx.createLinearGradient(b, 0, b + 14, 0);
  gr.addColorStop(0, "rgba(0,0,0,.4)");
  gr.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gr;
  ctx.fillRect(b, b + 16, 14, H - b * 2 - 16);
  gr = ctx.createLinearGradient(W - b, 0, W - b - 14, 0);
  gr.addColorStop(0, "rgba(0,0,0,.4)");
  gr.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gr;
  ctx.fillRect(W - b - 14, b + 16, 14, H - b * 2 - 16);

  ctx.globalAlpha = 0.07;
  gr = ctx.createLinearGradient(0, 0, W, H);
  gr.addColorStop(0, "rgba(255,255,255,0)");
  gr.addColorStop(0.38, "rgba(200,220,255,.6)");
  gr.addColorStop(0.62, "rgba(200,220,255,.6)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;

  return c;
}
