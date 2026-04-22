import * as THREE from "three";
import { getCatalogEntry } from "../../game/catalog";
import type { CatalogEntry, CommandCatalogEntry, StructureCatalogEntry } from "../../game/types";
import { isCommandEntry, isStructureEntry } from "../../game/types";
import { catalogPreviewTypeHue } from "../doctrineCard";
import { getCardPreviewDataUrl } from "../cardGlbPreview";
import { binderPanelPixelSize } from "./CardBinderEngine";
import { binderSleevePixelSize, composeCardIntoBinderSleeve } from "./binderSleeveComposite";

const cache = new Map<string, Promise<THREE.CanvasTexture>>();

function binderTextureCacheKey(catalogId: string): string {
  const { w, h } = binderSleevePixelSize();
  /* Sleeve composite output size; bump token when raster pipeline changes. */
  return `${catalogId}@${w}x${h}sleeve_v2`;
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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("preview img"));
    img.src = src;
  });
}

function dominantSignalLabel(e: CatalogEntry): string {
  if (e.signalTypes.length === 0) return "—";
  if (e.signalTypes.length === 1) return e.signalTypes[0]!;
  return "Mixed";
}

/**
 * Paints a readable “full card” facsimile with 2D canvas + the same GLB→PNG previews as the HUD.
 * Avoids html-to-image / DOM / container-query capture entirely (those were snapping black).
 */
async function paintBinderPanelCanvas(catalogId: string): Promise<HTMLCanvasElement> {
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

  const hue = catalogPreviewTypeHue(e);
  const pad = Math.max(6, Math.round(w * 0.032));
  const heroH = Math.round(h * 0.40);

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

  if (isStructureEntry(e)) {
    try {
      const url = await getCardPreviewDataUrl(catalogId);
      if (url) {
        const img = await loadImage(url);
        ctx.save();
        roundRectPath(ctx, pad + 2, pad + 2, w - (pad + 2) * 2, heroH - pad - 4, 4);
        ctx.clip();
        drawImageCover(ctx, img, pad + 2, pad + 2, w - (pad + 2) * 2, heroH - pad - 4);
        ctx.restore();
      }
    } catch {
      /* keep dark hero */
    }
  } else {
    const cmd = e as CommandCatalogEntry;
    const g2 = ctx.createLinearGradient(pad, pad, w - pad, heroH);
    g2.addColorStop(0, `hsla(${hue}, 48%, 26%, 0.96)`);
    g2.addColorStop(1, `hsla(${hue + 35}, 38%, 14%, 0.96)`);
    ctx.fillStyle = g2;
    roundRectPath(ctx, pad + 2, pad + 2, w - (pad + 2) * 2, heroH - pad - 4, 4);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    ctx.textAlign = "center";
    const fs = Math.max(12, Math.round(w * 0.038));
    ctx.font = `bold ${fs}px system-ui, Segoe UI, sans-serif`;
    ctx.fillText("SPELL", w / 2, pad + (heroH - pad) * 0.42);
    const eff = cmd.effect.type.replace(/_/g, " ");
    ctx.font = `${Math.max(10, Math.round(w * 0.03))}px system-ui, Segoe UI, sans-serif`;
    ctx.fillStyle = "rgba(228,236,248,0.92)";
    ctx.fillText(eff.toUpperCase(), w / 2, pad + (heroH - pad) * 0.62);
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
  const colW = (w - pad * 2) / 4;
  const statFs = Math.max(11, Math.round(w * 0.028));
  const lblFs = Math.max(8, Math.round(w * 0.019));

  if (isStructureEntry(e)) {
    const st = e as StructureCatalogEntry;
    const cols = [
      { v: String(st.maxHp), l: "HP", color: "#e85555" },
      { v: `${st.buildSeconds}s`, l: "BUILD", color: "#6ab0ff" },
      { v: `${st.productionSeconds}s`, l: "PROD", color: "#d4b060" },
      { v: `${st.producedPop}/${st.localPopCap}`, l: "POP", color: "#b090ff" },
    ];
    for (let i = 0; i < 4; i++) {
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
    const cols = [
      { v: String(cmd.fluxCost), l: "MANA", color: "#b080ff" },
      { v: `${cmd.chargeCooldownSeconds}s`, l: "CD", color: "#6ab0ff" },
      { v: `${cmd.salvagePctOnCast}%`, l: "SALV", color: "#7cdb9f" },
      { v: `T${Math.max(1, cmd.requiredRelayTier)}`, l: "TIER", color: "#d4b060" },
    ];
    for (let i = 0; i < 4; i++) {
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
  ctx.fillText(`Signal  ${dominantSignalLabel(e)}`, pad, y);
  ctx.textAlign = "right";
  ctx.fillText(`Unlock  Wizard Tier ${Math.max(1, e.requiredRelayTier)}`, w - pad, y);

  y += 16;
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(160,176,200,0.86)";
  const foot = isStructureEntry(e)
    ? (e.producedFlavor ?? "").trim()
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

async function rasterizeCatalogId(catalogId: string): Promise<THREE.CanvasTexture> {
  const inner = await paintBinderPanelCanvas(catalogId);
  const cvs = composeCardIntoBinderSleeve(inner);
  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
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
      t.dispose();
    });
  }
  cache.clear();
}
