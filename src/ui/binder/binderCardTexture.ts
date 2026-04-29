import * as THREE from "three";
import { getCatalogEntry } from "../../game/catalog";
import { productionBatchSizeForClass } from "../../game/sim/systems/helpers";
import type { CommandCatalogEntry, StructureCatalogEntry } from "../../game/types";
import { isCommandEntry, isStructureEntry } from "../../game/types";
import { catalogPreviewTypeHue } from "../doctrineCard";
import { drawCardArtOverlayOnCanvasRect, isCardOverlayFieldVisible, overlayVisibilityStampForCatalog } from "../cardArtOverlay";
import { CARD_ART_CACHE_BUSTER } from "../cardArtManifest";
import { getCardPreviewDataUrl, configureImageCrossOriginForSrc } from "../cardGlbPreview";
import { binderPanelPixelSize } from "./CardBinderEngine";
import { composeCardIntoBinderSleeve } from "./binderSleeveComposite";
import { drawSpellBinderHero } from "./binderSpellHeroCanvas";

const cache = new Map<string, Promise<THREE.CanvasTexture>>();
/** GLB hero snapshot per structure id (reused for animated spell repaints). */
const structureHeroImageByCatalogId = new Map<string, HTMLImageElement>();
/** Catalog ids whose `/assets/cards/*.png` art fills the whole binder panel (no generated stats strip). */
const manifestFullCardArtCatalogIds = new Set<string>();

function binderTextureCacheKey(catalogId: string): string {
  const { w, h } = binderPanelPixelSize();
  const vis = overlayVisibilityStampForCatalog(catalogId);
  return `${catalogId}@${w}x${h}panel_${CARD_ART_CACHE_BUSTER}_ov${vis}`;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function intrinsicSize(img: CanvasImageSource): { iw: number; ih: number } {
  if (img instanceof HTMLImageElement) return { iw: img.naturalWidth, ih: img.naturalHeight };
  if (img instanceof HTMLCanvasElement) return { iw: img.width, ih: img.height };
  if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) return { iw: img.width, ih: img.height };
  return { iw: 256, ih: 256 };
}

function drawImageCover(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  x: number,
  y: number,
  cw: number,
  ch: number,
): void {
  const { iw, ih } = intrinsicSize(img);
  if (iw < 1 || ih < 1) return;
  const scale = Math.max(cw / iw, ch / ih);
  const sw = cw / scale;
  const sh = ch / scale;
  const sx = (iw - sw) / 2;
  const sy = (ih - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, x, y, cw, ch);
}

/** Match hand / asset-lab `object-fit: contain` — letterbox inside box (same stat coordinate space as DOM overlay). */
function drawImageContain(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
): void {
  const { iw, ih } = intrinsicSize(img);
  if (iw < 1 || ih < 1) return;
  const ar = iw / ih;
  const br = boxW / boxH;
  let dw: number;
  let dh: number;
  let dx: number;
  let dy: number;
  if (ar > br) {
    dw = boxW;
    dh = boxW / ar;
    dx = boxX;
    dy = boxY + (boxH - dh) / 2;
  } else {
    dh = boxH;
    dw = boxH * ar;
    dx = boxX + (boxW - dw) / 2;
    dy = boxY;
  }
  ctx.drawImage(img, 0, 0, iw, ih, dx, dy, dw, dh);
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  configureImageCrossOriginForSrc(img, src);
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("card art load failed"));
    img.src = src;
  });
  return img;
}

const SPELL_TEX_USERDATA_RAF = "binderSpellRafId";
const SPELL_TEX_USERDATA_DEAD = "binderSpellDead";

/**
 * Full panel paint. Manifest full-bleed cards: draw art + stat overlay on canvas (avoids SVG-as-image + external href).
 */
function paintBinderPanelOntoCanvas(catalogId: string, spellTimeSec: number): HTMLCanvasElement {
  const { w, h } = binderPanelPixelSize();
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return c;

  const e = getCatalogEntry(catalogId);
  if (!e) {
    ctx.fillStyle = "#111318";
    ctx.fillRect(0, 0, w, h);
    return c;
  }

  const mappedImg = structureHeroImageByCatalogId.get(catalogId);
  if (mappedImg && manifestFullCardArtCatalogIds.has(catalogId)) {
    ctx.fillStyle = "#080b11";
    ctx.fillRect(0, 0, w, h);
    drawImageContain(ctx, mappedImg, 0, 0, w, h);
    drawCardArtOverlayOnCanvasRect(ctx, catalogId, 0, 0, w, h);
    return c;
  }

  const hue = catalogPreviewTypeHue(e);
  const pad = Math.max(6, Math.round(w * 0.032));
  // Match `.tcg--slot-preview .slot-card-art`: flex fills almost all of the shell above title/subtitle.
  // At 48% the spell AoE canvas sat in a much shorter band than the hand, so rings read “too high”.
  const heroH = Math.round(h * 0.65);

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "#1c2430");
  bg.addColorStop(0.5, "#121722");
  bg.addColorStop(1, "#0a0e14");
  ctx.fillStyle = bg;
  roundRectPath(ctx, 0, 0, w, h, 10);
  ctx.fill();

  ctx.strokeStyle = `hsla(${hue}, 52%, 48%, 0.88)`;
  ctx.lineWidth = 2;
  roundRectPath(ctx, 1, 1, w - 2, h - 2, 9);
  ctx.stroke();

  ctx.fillStyle = "#0a1018";
  roundRectPath(ctx, pad, pad, w - pad * 2, heroH - pad, 6);
  ctx.fill();

  const hx = pad + 2;
  const hy = pad + 2;
  const hw = w - (pad + 2) * 2;
  const hh = heroH - pad - 4;

  if (mappedImg) {
    ctx.save();
    roundRectPath(ctx, hx, hy, hw, hh, 4);
    ctx.clip();
    drawImageCover(ctx, mappedImg, hx, hy, hw, hh);
    ctx.restore();
  } else if (isStructureEntry(e)) {
    // Structure GLB snapshot fallback is populated by `ensureCardHeroLoaded`.
  } else {
    drawSpellBinderHero(ctx, e as CommandCatalogEntry, hx, hy, hw, hh, hue, spellTimeSec);
  }

  let y = heroH + 8;
  ctx.textAlign = "center";
  ctx.fillStyle = "#f6f9ff";
  const nameSize = Math.max(13, Math.round(w * 0.038));
  ctx.font = `bold ${nameSize}px Georgia, "Times New Roman", serif`;
  ctx.fillText(e.name.toUpperCase(), w / 2, y + nameSize * 0.85);

  y += nameSize + 6;
  ctx.font = `${Math.max(9, Math.round(w * 0.022))}px ui-monospace, monospace`;
  ctx.fillStyle = `hsla(${hue}, 48%, 76%, 0.96)`;
  ctx.fillText(isCommandEntry(e) ? "DOCTRINE • COMMAND" : "DOCTRINE • STRUCTURE", w / 2, y);

  y += 14;
  const statFs = Math.max(11, Math.round(w * 0.028));
  const lblFs = Math.max(8, Math.round(w * 0.019));

  if (isStructureEntry(e)) {
    const st = e as StructureCatalogEntry;
    const popCap = st.localPopCap + (st.structureLocalPopCapBonus ?? 0);
    const candidates: Array<{ id: string; v: string; l: string; color: string }> = [
      { id: "hp", v: String(st.maxHp), l: "HP", color: "#e85555" },
      { id: "cooldown", v: `${st.chargeCooldownSeconds}s`, l: "CD", color: "#6ab0ff" },
      { id: "prod", v: `${st.productionSeconds}s`, l: "PROD", color: "#d4b060" },
      { id: "batch", v: `${productionBatchSizeForClass(st.producedSizeClass)}x/${popCap}`, l: "BATCH", color: "#b090ff" },
    ];
    const cols = candidates.filter((c) => isCardOverlayFieldVisible(catalogId, c.id));
    const colW = cols.length > 0 ? (w - pad * 2) / cols.length : 0;
    for (let i = 0; i < cols.length; i++) {
      const cx = pad + colW * i + colW / 2;
      ctx.font = `bold ${statFs}px system-ui, Segoe UI, sans-serif`;
      ctx.fillStyle = cols[i]!.color;
      ctx.fillText(cols[i]!.v, cx, y + 11);
      ctx.font = `${lblFs}px system-ui, Segoe UI, sans-serif`;
      ctx.fillStyle = "rgba(200,210,228,0.78)";
      ctx.fillText(cols[i]!.l, cx, y + 24);
    }
  } else {
    const cmd = e as CommandCatalogEntry;
    const candidates: Array<{ id: string; v: string; l: string; color: string }> = [
      { id: "mana", v: String(cmd.fluxCost), l: "MANA", color: "#b080ff" },
      { id: "cooldown", v: `${cmd.chargeCooldownSeconds}s`, l: "CD", color: "#6ab0ff" },
      { id: "salvage", v: `${cmd.salvagePctOnCast}%`, l: "SALV", color: "#7cdb9f" },
    ];
    const cols = candidates.filter((c) => isCardOverlayFieldVisible(catalogId, c.id));
    const colW = cols.length > 0 ? (w - pad * 2) / cols.length : 0;
    for (let i = 0; i < cols.length; i++) {
      const cx = pad + colW * i + colW / 2;
      ctx.font = `bold ${statFs}px system-ui, Segoe UI, sans-serif`;
      ctx.fillStyle = cols[i]!.color;
      ctx.fillText(cols[i]!.v, cx, y + 11);
      ctx.font = `${lblFs}px system-ui, Segoe UI, sans-serif`;
      ctx.fillStyle = "rgba(200,210,228,0.78)";
      ctx.fillText(cols[i]!.l, cx, y + 24);
    }
  }

  y += 36;
  ctx.textAlign = "left";
  ctx.font = `${Math.max(9, Math.round(w * 0.024))}px system-ui, Segoe UI, sans-serif`;
  ctx.fillStyle = "rgba(190,204,226,0.9)";
  ctx.fillText(`Role  ${isStructureEntry(e) ? `${productionBatchSizeForClass(e.producedSizeClass)}x ${e.producedSizeClass}` : "Mana spell"}`, pad, y);
  ctx.textAlign = "right";
  ctx.fillText(isStructureEntry(e) ? "Place  Territory" : "Cast  Mana", w - pad, y);

  y += 16;
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(160,176,200,0.86)";
  const foot = isStructureEntry(e)
    ? (e.producedFlavor ?? "").trim()
    : !isCardOverlayFieldVisible(catalogId, "effect")
      ? ""
      : (e as CommandCatalogEntry).effect.type.replace(/_/g, " ");
  ctx.font = `italic ${Math.max(8, Math.round(w * 0.02))}px system-ui, Segoe UI, sans-serif`;
  const maxW = w - pad * 2;
  let line = foot.slice(0, 120);
  while (line.length > 8 && ctx.measureText(`${line}…`).width > maxW) {
    line = line.slice(0, -1);
  }
  if (foot.length > line.length) line += "…";
  ctx.fillText(line, pad, y);

  return c;
}

async function ensureCardHeroLoaded(catalogId: string): Promise<void> {
  const e = getCatalogEntry(catalogId);
  if (!e) return;
  if (structureHeroImageByCatalogId.has(catalogId)) return;
  try {
    const previewUrl = await getCardPreviewDataUrl(catalogId);
    if (!previewUrl) {
      manifestFullCardArtCatalogIds.delete(catalogId);
      return;
    }
    const img = await loadImage(previewUrl);
    structureHeroImageByCatalogId.set(catalogId, img);
    /** Full-bleed panel uses manifest PNG URLs; data URLs are GLB snapshots (hero inset path only). */
    if (previewUrl.startsWith("data:")) {
      manifestFullCardArtCatalogIds.delete(catalogId);
    } else {
      manifestFullCardArtCatalogIds.add(catalogId);
    }
  } catch {
    manifestFullCardArtCatalogIds.delete(catalogId);
  }
}

async function paintBinderPanelCanvas(catalogId: string): Promise<HTMLCanvasElement> {
  await ensureCardHeroLoaded(catalogId);
  return paintBinderPanelOntoCanvas(catalogId, 0);
}

function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

function startSpellBinderTextureLoop(catalogId: string, tex: THREE.CanvasTexture): void {
  if (prefersReducedMotion()) return;
  const dest = tex.image as HTMLCanvasElement | undefined;
  if (!dest || !(dest instanceof HTMLCanvasElement)) return;

  tex.userData[SPELL_TEX_USERDATA_DEAD] = false;
  const step = (): void => {
    if (tex.userData[SPELL_TEX_USERDATA_DEAD] === true) return;
    const inner = paintBinderPanelOntoCanvas(catalogId, performance.now() / 1000);
    const composed = composeCardIntoBinderSleeve(inner);
    const dctx = dest.getContext("2d");
    if (dctx) {
      dctx.clearRect(0, 0, dest.width, dest.height);
      dctx.drawImage(composed, 0, 0, dest.width, dest.height);
    }
    tex.needsUpdate = true;
    if (tex.userData[SPELL_TEX_USERDATA_DEAD] === true) return;
    tex.userData[SPELL_TEX_USERDATA_RAF] = requestAnimationFrame(step);
  };
  tex.userData[SPELL_TEX_USERDATA_RAF] = requestAnimationFrame(step);
}

function wrapSpellTextureDispose(tex: THREE.CanvasTexture): void {
  const base = tex.dispose.bind(tex);
  tex.dispose = (): void => {
    tex.userData[SPELL_TEX_USERDATA_DEAD] = true;
    const rafId = tex.userData[SPELL_TEX_USERDATA_RAF] as number | undefined;
    if (typeof rafId === "number") cancelAnimationFrame(rafId);
    delete tex.userData[SPELL_TEX_USERDATA_RAF];
    base();
  };
}

async function rasterizeCatalogId(catalogId: string): Promise<THREE.CanvasTexture> {
  const cvs = await paintBinderPanelCanvas(catalogId);
  const composed = composeCardIntoBinderSleeve(cvs);
  const tex = new THREE.CanvasTexture(composed);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;

  const entry = getCatalogEntry(catalogId);
  if (entry && isCommandEntry(entry)) {
    wrapSpellTextureDispose(tex);
    startSpellBinderTextureLoop(catalogId, tex);
  }

  return tex;
}

/** Cached panel texture for one catalog id (binder pixel size). */
export function getBinderTextureForCatalogId(catalogId: string): Promise<THREE.CanvasTexture> {
  if (!getCatalogEntry(catalogId)) {
    return Promise.reject(new Error(`Unknown catalog id: ${catalogId}`));
  }
  const key = binderTextureCacheKey(catalogId);
  const hit = cache.get(key);
  if (hit) return hit;
  const p = rasterizeCatalogId(catalogId);
  cache.set(key, p);
  return p;
}

/** Warm cache for many ids (sequential to avoid main-thread spikes). */
export async function preloadBinderTextures(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    if (!getCatalogEntry(id)) continue;
    await getBinderTextureForCatalogId(id);
  }
}

export function disposeBinderTextureCache(): void {
  for (const p of cache.values()) {
    void p.then((t) => {
      t.userData[SPELL_TEX_USERDATA_DEAD] = true;
      const rafId = t.userData[SPELL_TEX_USERDATA_RAF] as number | undefined;
      if (typeof rafId === "number") cancelAnimationFrame(rafId);
      delete t.userData[SPELL_TEX_USERDATA_RAF];
      delete t.userData[SPELL_TEX_USERDATA_DEAD];
      t.dispose();
    });
  }
  cache.clear();
  structureHeroImageByCatalogId.clear();
  manifestFullCardArtCatalogIds.clear();
}
