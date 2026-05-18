import * as THREE from "three";
import { TCG_FULL_CARD_H, TCG_FULL_CARD_W } from "../tcgCardPrint";
import { composeCardIntoBinderSleeve } from "./binderSleeveComposite";

/** Match `binderPanelPixelSize()` / sleeve composite aspect (no import cycle with `CardBinderEngine`). */
function panelPixelSize(): { w: number; h: number } {
  return { w: TCG_FULL_CARD_W, h: TCG_FULL_CARD_H };
}

/** Root-relative art for binder sleeve backs (see `public/assets/cards/card_back.png`). */
export const BINDER_CARD_BACK_IMAGE_URL = "/assets/cards/card_back.png";

/** Slight inset inside the inner 400×600 so the back reads a touch smaller than full bleed (matches neighbor faces). */
const INNER_ART_INSET_FRAC = 0.045;

function intrinsicPx(img: CanvasImageSource): { iw: number; ih: number } {
  if (img instanceof HTMLImageElement) return { iw: img.naturalWidth, ih: img.naturalHeight };
  if (img instanceof HTMLVideoElement) return { iw: img.videoWidth, ih: img.videoHeight };
  if (img instanceof HTMLCanvasElement) return { iw: img.width, ih: img.height };
  if (typeof OffscreenCanvas !== "undefined" && img instanceof OffscreenCanvas) return { iw: img.width, ih: img.height };
  return { iw: 256, ih: 256 };
}

function drawImageContain(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  x: number,
  y: number,
  cw: number,
  ch: number,
): void {
  const { iw, ih } = intrinsicPx(img);
  if (iw < 1 || ih < 1) return;
  const scale = Math.min(cw / iw, ch / ih);
  const sw = iw * scale;
  const sh = ih * scale;
  const ox = x + (cw - sw) / 2;
  const oy = y + (ch - sh) / 2;
  ctx.drawImage(img, ox, oy, sw, sh);
}

function rasterBackIntoSleeveTexture(img: CanvasImageSource | null): THREE.CanvasTexture {
  const { w: W, h: H } = panelPixelSize();
  const inner = document.createElement("canvas");
  inner.width = W;
  inner.height = H;
  const ctx = inner.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#0b0c10";
    ctx.fillRect(0, 0, W, H);
    if (img) {
      const px = W * INNER_ART_INSET_FRAC;
      const py = H * INNER_ART_INSET_FRAC;
      drawImageContain(ctx, img, px, py, W - px * 2, H - py * 2);
    }
  }
  const composed = composeCardIntoBinderSleeve(inner);
  const t = new THREE.CanvasTexture(composed);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/**
 * Dark placeholder until `loadBinderCardBackTexture` finishes (avoids flashing “Battle Logs” text).
 * Same sleeve framing as catalog faces so scale matches the grid.
 */
export function createBinderCardBackPlaceholderTexture(): THREE.CanvasTexture {
  return rasterBackIntoSleeveTexture(null);
}

/**
 * Loads PNG/WebP art and rasterizes through the binder sleeve composite (same footprint as codex faces).
 */
export async function loadBinderCardBackTexture(
  loader: THREE.TextureLoader,
  url: string,
): Promise<THREE.CanvasTexture> {
  const loaded = await loader.loadAsync(url);
  const img = loaded.image as HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;
  const out = rasterBackIntoSleeveTexture(img);
  loaded.dispose();
  return out;
}
