import * as THREE from "three";
import { getCatalogEntry } from "../../game/catalog";
import { productionBatchSizeForClass } from "../../game/sim/systems/helpers";
import type { CatalogEntry, CommandCatalogEntry, StructureCatalogEntry } from "../../game/types";
import { isCommandEntry, isStructureEntry } from "../../game/types";
import { catalogPreviewTypeHue } from "../doctrineCard";
import {
  containCardArtRect,
  drawCardArtOverlayOnCanvasRect,
  isCardOverlayFieldVisible,
  overlayVisibilityStampForCatalog,
  type CardArtContainRect,
} from "../cardArtOverlay";
import { CARD_ART_CACHE_BUSTER } from "../cardArtManifest";
import { getCardPreviewDataUrl, configureImageCrossOriginForSrc } from "../cardGlbPreview";
import { binderPanelPixelSize } from "./CardBinderEngine";
import { composeCardIntoBinderSleeve } from "./binderSleeveComposite";
import { drawSpellBinderHero } from "./binderSpellHeroCanvas";

type BinderPanelTexture = THREE.CanvasTexture;

const cache = new Map<string, Promise<BinderPanelTexture>>();
/** GLB hero snapshot per structure id (reused for animated spell repaints). */
const structureHeroImageByCatalogId = new Map<string, HTMLImageElement>();

function comparableCardArtUrl(url: string): string {
  try {
    const u = new URL(url, globalThis.location?.origin ?? "https://example.com");
    u.searchParams.delete("cb");
    u.searchParams.delete("lab");
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

function evictBinderTexturesForCatalogId(catalogId: string): void {
  const prefix = `${catalogId}@`;
  for (const key of [...cache.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const p = cache.get(key);
    cache.delete(key);
    if (!p) continue;
    void p.then((tex) => {
      tex.userData[SPELL_TEX_USERDATA_DEAD] = true;
      const rafId = tex.userData[SPELL_TEX_USERDATA_RAF] as number | undefined;
      if (typeof rafId === "number") cancelAnimationFrame(rafId);
      delete tex.userData[SPELL_TEX_USERDATA_RAF];
      delete tex.userData[SPELL_TEX_USERDATA_DEAD];
      tex.dispose();
    });
  }
}

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

function authoredSpellGlowPalette(e: CommandCatalogEntry, hue: number): { core: string; rim: string; hot: string } {
  switch (e.effect.type) {
    case "aoe_damage":
      return { core: "rgba(255, 118, 20, 0.42)", rim: "rgba(255, 210, 88, 0.56)", hot: "rgba(255, 248, 196, 0.72)" };
    case "aoe_shatter_chain":
      return { core: "rgba(116, 156, 255, 0.42)", rim: "rgba(190, 220, 255, 0.58)", hot: "rgba(245, 250, 255, 0.72)" };
    case "aoe_tactics_field":
      return { core: "rgba(52, 160, 255, 0.34)", rim: "rgba(118, 226, 255, 0.52)", hot: "rgba(218, 250, 255, 0.68)" };
    case "aoe_line_damage":
      return { core: "rgba(198, 80, 255, 0.36)", rim: "rgba(255, 122, 224, 0.52)", hot: "rgba(255, 230, 255, 0.68)" };
    default:
      return {
        core: `hsla(${hue}, 72%, 52%, 0.34)`,
        rim: `hsla(${hue}, 86%, 72%, 0.52)`,
        hot: "rgba(255,255,255,0.66)",
      };
  }
}

function drawAuthoredSpellBinderMotion(
  ctx: CanvasRenderingContext2D,
  e: CommandCatalogEntry,
  w: number,
  h: number,
  hue: number,
  t: number,
): void {
  const pal = authoredSpellGlowPalette(e, hue);
  const cx = w * 0.5;
  const cy = h * 0.245;
  const baseR = w * 0.205;
  const pulse = (Math.sin(t * Math.PI * 2 * 0.9) + 1) * 0.5;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.translate(cx, cy);

  for (let i = 0; i < 3; i++) {
    const p = (t * (0.12 + i * 0.035) + i / 3) % 1;
    const r = baseR * (0.72 + p * 0.58);
    ctx.globalAlpha = (0.42 + 0.22 * pulse) * (1 - p);
    ctx.strokeStyle = i === 0 ? pal.hot : i === 1 ? pal.rim : pal.core;
    ctx.lineWidth = Math.max(1.2, w * (0.006 - i * 0.001));
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.rotate(t * (e.effect.type === "aoe_shatter_chain" ? -0.9 : 0.65));
  ctx.globalAlpha = 0.48 + pulse * 0.28;
  ctx.strokeStyle = pal.rim;
  ctx.lineWidth = Math.max(1, w * 0.004);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r0 = baseR * 0.38;
    const r1 = baseR * (0.82 + pulse * 0.08);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.stroke();
  }

  const orbA = t * Math.PI * 2 * 0.42;
  const orbR = baseR * 0.58;
  const orbX = Math.cos(orbA) * orbR;
  const orbY = Math.sin(orbA) * orbR;
  const orb = ctx.createRadialGradient(orbX, orbY, 0, orbX, orbY, baseR * 0.18);
  orb.addColorStop(0, pal.hot);
  orb.addColorStop(0.45, pal.rim);
  orb.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalAlpha = 0.72;
  ctx.fillStyle = orb;
  ctx.beginPath();
  ctx.arc(orbX, orbY, baseR * 0.18, 0, Math.PI * 2);
  ctx.fill();

  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, baseR * 0.68);
  core.addColorStop(0, pal.hot);
  core.addColorStop(0.28, pal.core);
  core.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalAlpha = 0.28 + pulse * 0.18;
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(0, 0, baseR * 0.68, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Procedural panel when hero art is missing or not yet decoded (no `drawCardArtOverlayOnCanvasRect`).
 * Any decoded bitmap (HTTP or `data:` GLB snapshot) uses the unified contain path in `paintBinderPanelOntoCanvas`.
 */
function paintBinderLegacyPanelLayout(
  ctx: CanvasRenderingContext2D,
  catalogId: string,
  e: CatalogEntry,
  mappedImg: HTMLImageElement | undefined,
  w: number,
  h: number,
  hue: number,
  spellTimeSec: number,
): void {
  const pad = Math.max(6, Math.round(w * 0.032));
  // Match `.tcg--slot-preview .slot-card-art`: flex fills almost all of the shell above title/subtitle.
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
      { id: "salvage", v: `${cmd.salvagePctOnCast}%`, l: "SALV", color: "#7cdb9f" },
    ];
    const cols = candidates.filter((c) => c.id === "mana" && isCardOverlayFieldVisible(catalogId, c.id));
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
}

async function loadRasterImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  configureImageCrossOriginForSrc(img, src);
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("card art load failed"));
    img.src = src;
  });
  return img;
}

function isSameOriginSvgAsset(src: string): boolean {
  if (!/\.svg(?:[?#]|$)/i.test(src)) return false;
  try {
    const resolved = new URL(src, globalThis.location?.href);
    return resolved.origin === globalThis.location?.origin;
  } catch {
    return false;
  }
}

function svgWithExplicitIntrinsicSize(raw: string): string {
  const m = raw.match(/<svg\b([^>]*)>/i);
  if (!m) return raw;
  const attrs = m[1] ?? "";
  if (/\swidth\s*=/.test(attrs) && /\sheight\s*=/.test(attrs)) return raw;
  const vb = attrs.match(/\sviewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i);
  const w = vb?.[1] ?? "512";
  const h = vb?.[2] ?? "768";
  const widthAttr = /\swidth\s*=/.test(attrs) ? "" : ` width="${w}"`;
  const heightAttr = /\sheight\s*=/.test(attrs) ? "" : ` height="${h}"`;
  const parAttr = /\spreserveAspectRatio\s*=/.test(attrs) ? "" : ` preserveAspectRatio="xMidYMid meet"`;
  return raw.replace(/<svg\b([^>]*)>/i, `<svg$1${widthAttr}${heightAttr}${parAttr}>`);
}

function svgWithoutTextNodes(raw: string): string {
  return raw
    .replace(/<text\b[\s\S]*?<\/text>/gi, "")
    .replace(/<text\b[^/>]*\/>/gi, "")
    .replace(/<tspan\b[\s\S]*?<\/tspan>/gi, "")
    .replace(/<tspan\b[^/>]*\/>/gi, "");
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  if (!isSameOriginSvgAsset(src)) return loadRasterImage(src);
  const res = await fetch(src, { cache: "force-cache" });
  if (!res.ok) throw new Error("card svg load failed");
  const svg = svgWithoutTextNodes(svgWithExplicitIntrinsicSize(await res.text()));
  const blobUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    return await loadRasterImage(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

const SPELL_TEX_USERDATA_RAF = "binderSpellRafId";
const SPELL_TEX_USERDATA_DEAD = "binderSpellDead";

/**
 * Full panel paint: decoded hero (HTTP or `data:`) uses the same contain + overlay path as HUD slots;
 * otherwise procedural legacy layout (no overlay canvas draw).
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

  const hue = catalogPreviewTypeHue(e);
  const mappedImg = structureHeroImageByCatalogId.get(catalogId);
  const decodedHero =
    Boolean(mappedImg?.complete && mappedImg.naturalWidth > 0 && mappedImg.naturalHeight > 0);
  if (mappedImg && decodedHero) {
    ctx.fillStyle = "#080b11";
    ctx.fillRect(0, 0, w, h);
    const artRect = containCardArtRect(0, 0, w, h, mappedImg.naturalWidth, mappedImg.naturalHeight);
    ctx.drawImage(mappedImg, 0, 0, mappedImg.naturalWidth, mappedImg.naturalHeight, artRect.x, artRect.y, artRect.w, artRect.h);
    if (isCommandEntry(e)) drawAuthoredSpellBinderMotion(ctx, e as CommandCatalogEntry, w, h, hue, spellTimeSec);
    drawCardArtOverlayOnCanvasRect(ctx, catalogId, artRect.x, artRect.y, artRect.w, artRect.h);
    return c;
  }

  paintBinderLegacyPanelLayout(ctx, catalogId, e, mappedImg, w, h, hue, spellTimeSec);
  return c;
}

async function ensureCardHeroLoaded(catalogId: string): Promise<void> {
  const e = getCatalogEntry(catalogId);
  if (!e) return;

  let previewUrl: string | null = null;
  try {
    previewUrl = await getCardPreviewDataUrl(catalogId);
  } catch {
    previewUrl = null;
  }

  const prev = structureHeroImageByCatalogId.get(catalogId);
  if (prev && previewUrl) {
    const okDims = prev.complete && prev.naturalWidth > 0 && prev.naturalHeight > 0;
    const same = okDims && comparableCardArtUrl(prev.currentSrc || prev.src) === comparableCardArtUrl(previewUrl);
    if (same) return;
  }

  if (prev) {
    structureHeroImageByCatalogId.delete(catalogId);
    evictBinderTexturesForCatalogId(catalogId);
  }

  if (!previewUrl) {
    return;
  }

  try {
    const img = await loadImage(previewUrl);
    structureHeroImageByCatalogId.set(catalogId, img);
  } catch {
    /* leave missing — procedural panel */
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

async function rasterizeCatalogId(catalogId: string): Promise<BinderPanelTexture> {
  const cvs = await paintBinderPanelCanvas(catalogId);
  const composed = composeCardIntoBinderSleeve(cvs);
  const tex = new THREE.CanvasTexture(composed);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;

  const entry = getCatalogEntry(catalogId);
  if (entry && isCommandEntry(entry)) {
    wrapSpellTextureDispose(tex);
    /** Authored SVG spells and procedural fallback spells both repaint so animated spell art stays alive in the 3D binder. */
    startSpellBinderTextureLoop(catalogId, tex);
  }

  return tex;
}

/** Cached panel texture for one catalog id (binder pixel size). */
export function getBinderTextureForCatalogId(catalogId: string): Promise<BinderPanelTexture> {
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
}

/** Same `containCardArtRect` inputs as HUD slot + DOM overlay fit (tests + tooling). */
export function binderDecodedHeroArtRect(
  panelW: number,
  panelH: number,
  intrinsicW: number,
  intrinsicH: number,
): CardArtContainRect {
  return containCardArtRect(0, 0, panelW, panelH, intrinsicW, intrinsicH);
}
