import { getCatalogEntry } from "../game/catalog";
import { productionBatchSizeForClass } from "../game/sim/systems/helpers";
import type { CatalogEntry, CommandCatalogEntry, StructureCatalogEntry } from "../game/types";
import { isCommandEntry } from "../game/types";
import overlayLayoutsJson from "./cardArtOverlayLayouts.json";

type OverlayField = {
  id: string;
  /** Single-line value only (e.g. `11s`, `80`, `3x`) — no separate label row on card art. */
  value: string;
  x: number;
  y: number;
  width?: number;
  /** Hit box height in overlay units (viewBox height — matches `CARD_OVERLAY_HEIGHT`). */
  height?: number;
  tone?: "mana" | "hp" | "prod" | "batch" | "cooldown" | "uses" | "salvage";
  size?: "xl" | "lg" | "md" | "sm";
  anchor?: "middle" | "start" | "end";
};

type OverlayFieldLayout = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  anchor?: OverlayField["anchor"];
};

type OverlayCardLayout = {
  profile?: string;
  fields?: Record<string, OverlayFieldLayout>;
};

type OverlayLayoutConfig = {
  profiles?: Record<string, { fields?: Record<string, OverlayFieldLayout> }>;
  cards?: Record<string, OverlayCardLayout>;
};

/** Normalized card face — **2:3** with `tcgCardPrint` / binder panel (`TCG_FULL_CARD_W:H`) so DOM + canvas `meet` match authored PNG/SVG art (legacy was 100×140 and letterboxed inside 2:3, drifting stats). */
const CARD_OVERLAY_WIDTH = 100;
const CARD_OVERLAY_HEIGHT = 150;

export type CardArtContainRect = { x: number; y: number; w: number; h: number };

/**
 * Same geometry as CSS `object-fit: contain`. Use this whenever authored card art
 * and overlay coordinates must share one letterboxed rectangle.
 */
export function containCardArtRect(
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  intrinsicW = CARD_OVERLAY_WIDTH,
  intrinsicH = CARD_OVERLAY_HEIGHT,
): CardArtContainRect {
  if (boxW <= 0 || boxH <= 0) return { x: boxX, y: boxY, w: Math.max(0, boxW), h: Math.max(0, boxH) };
  const iw = intrinsicW > 0 && Number.isFinite(intrinsicW) ? intrinsicW : CARD_OVERLAY_WIDTH;
  const ih = intrinsicH > 0 && Number.isFinite(intrinsicH) ? intrinsicH : CARD_OVERLAY_HEIGHT;
  const scale = Math.min(boxW / iw, boxH / ih);
  const w = iw * scale;
  const h = ih * scale;
  return {
    x: boxX + (boxW - w) / 2,
    y: boxY + (boxH - h) / 2,
    w,
    h,
  };
}

/** Legacy global defaults (asset lab used to write here). Used only when a card has no per-card override for that field. */
const OVERLAY_FIELD_VISIBILITY_LEGACY_KEY = "battleLogs.cardOverlay.fieldVisibility";
/** Per-catalog-id overlay visibility overrides. */
const OVERLAY_FIELD_VISIBILITY_BY_CARD_KEY = "battleLogs.cardOverlay.fieldVisibilityByCard";

/** Per-field visibility toggles (asset lab + global card art). IDs shared by structure/command where applicable. */
export const CARD_OVERLAY_FIELD_TOGGLES: readonly { id: string; label: string }[] = [
  { id: "mana", label: "Mana" },
  { id: "cooldown", label: "Cooldown" },
  { id: "hp", label: "HP" },
  { id: "prod", label: "Production" },
  { id: "batch", label: "Batch" },
  { id: "uses", label: "Uses" },
  { id: "salvage", label: "Salvage" },
  { id: "effect", label: "FX" },
];

let overlayFieldVisibilityLegacyCache: Record<string, boolean> | null = null;
let overlayFieldVisibilityPerCardCache: Record<string, Record<string, boolean>> | null = null;

function getOverlayFieldVisibilityLegacyMap(): Record<string, boolean> {
  if (overlayFieldVisibilityLegacyCache) return overlayFieldVisibilityLegacyCache;
  try {
    const raw = globalThis.localStorage?.getItem(OVERLAY_FIELD_VISIBILITY_LEGACY_KEY);
    overlayFieldVisibilityLegacyCache = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    overlayFieldVisibilityLegacyCache = {};
  }
  return overlayFieldVisibilityLegacyCache;
}

function getOverlayFieldVisibilityPerCardMap(): Record<string, Record<string, boolean>> {
  if (overlayFieldVisibilityPerCardCache) return overlayFieldVisibilityPerCardCache;
  try {
    const raw = globalThis.localStorage?.getItem(OVERLAY_FIELD_VISIBILITY_BY_CARD_KEY);
    overlayFieldVisibilityPerCardCache = raw ? (JSON.parse(raw) as Record<string, Record<string, boolean>>) : {};
  } catch {
    overlayFieldVisibilityPerCardCache = {};
  }
  return overlayFieldVisibilityPerCardCache;
}

function overlayFieldIsIncluded(fieldId: string, catalogId: string): boolean {
  const perCard = getOverlayFieldVisibilityPerCardMap()[catalogId];
  if (perCard && Object.prototype.hasOwnProperty.call(perCard, fieldId)) {
    return perCard[fieldId] !== false;
  }
  const legacy = getOverlayFieldVisibilityLegacyMap()[fieldId];
  if (legacy !== undefined) return legacy !== false;
  return true;
}

/** Whether a normalized overlay stat field is shown for this card (asset lab toggles + legacy fallback). */
export function isCardOverlayFieldVisible(catalogId: string, fieldId: string): boolean {
  return overlayFieldIsIncluded(fieldId, catalogId);
}

/** Bumps binder texture cache when overlay visibility changes so canvases repaint. */
export function overlayVisibilityStampForCatalog(catalogId: string): string {
  return CARD_OVERLAY_FIELD_TOGGLES.map(({ id }) => (overlayFieldIsIncluded(id, catalogId) ? "1" : "0")).join("");
}

let overlayLayouts: OverlayLayoutConfig = overlayLayoutsJson as OverlayLayoutConfig;

const DEFAULT_STRUCTURE_FIELDS = {
  mana: { x: 16.7, y: 25.7, width: 14 },
  cooldown: { x: 84.5, y: 19.3, width: 13 },
  hp: { x: 23.6, y: 96.2, width: 17 },
  prod: { x: 24.0, y: 110.6, width: 17 },
  batch: { x: 75.0, y: 110.6, width: 24 },
} as const;

const DEFAULT_COMMAND_FIELDS = {
  mana: { x: 16.7, y: 25.7, width: 14 },
  cooldown: { x: 84.5, y: 19.3, width: 13 },
  uses: { x: 24.0, y: 99.6, width: 17 },
  salvage: { x: 50.0, y: 99.6, width: 17 },
  effect: { x: 75.0, y: 110.6, width: 24 },
} as const;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function cleanFieldLayout(layout: OverlayFieldLayout | undefined): OverlayFieldLayout {
  if (!layout) return {};
  const next: OverlayFieldLayout = {};
  if (typeof layout.x === "number" && Number.isFinite(layout.x)) next.x = clamp(round1(layout.x), 0, CARD_OVERLAY_WIDTH);
  if (typeof layout.y === "number" && Number.isFinite(layout.y)) next.y = clamp(round1(layout.y), 0, CARD_OVERLAY_HEIGHT);
  if (typeof layout.width === "number" && Number.isFinite(layout.width)) {
    next.width = clamp(round1(layout.width), 4, CARD_OVERLAY_WIDTH);
  }
  if (typeof layout.height === "number" && Number.isFinite(layout.height)) {
    next.height = clamp(round1(layout.height), 4, 48);
  }
  if (layout.anchor === "start" || layout.anchor === "middle" || layout.anchor === "end") next.anchor = layout.anchor;
  return next;
}

function defaultProfileIdForEntry(entry: CatalogEntry): string {
  return isCommandEntry(entry) ? "command" : "structure";
}

function layoutForField(entry: CatalogEntry, catalogId: string, fieldId: string): OverlayFieldLayout {
  const cardLayout = overlayLayouts.cards?.[catalogId];
  const profileId = cardLayout?.profile ?? defaultProfileIdForEntry(entry);
  return {
    ...cleanFieldLayout(overlayLayouts.profiles?.[profileId]?.fields?.[fieldId]),
    ...cleanFieldLayout(cardLayout?.fields?.[fieldId]),
  };
}

function applyLayoutsToFields(entry: CatalogEntry, catalogId: string, fields: OverlayField[]): OverlayField[] {
  return fields.map((field) => ({
    ...field,
    ...layoutForField(entry, catalogId, field.id),
  }));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function structureFields(e: StructureCatalogEntry): OverlayField[] {
  const n = productionBatchSizeForClass(e.producedSizeClass);
  const batch = `${n}x`;
  return [
    { id: "mana", value: String(e.fluxCost), tone: "mana", size: "xl", ...DEFAULT_STRUCTURE_FIELDS.mana },
    {
      id: "cooldown",
      value: `${e.chargeCooldownSeconds}s`,
      tone: "cooldown",
      size: "sm",
      ...DEFAULT_STRUCTURE_FIELDS.cooldown,
    },
    { id: "hp", value: String(e.maxHp), tone: "hp", size: "md", ...DEFAULT_STRUCTURE_FIELDS.hp },
    {
      id: "prod",
      value: `${e.productionSeconds}s`,
      tone: "prod",
      size: "md",
      ...DEFAULT_STRUCTURE_FIELDS.prod,
    },
    {
      id: "batch",
      value: batch,
      tone: "batch",
      size: "md",
      ...DEFAULT_STRUCTURE_FIELDS.batch,
    },
  ];
}

function commandEffectLabel(e: CommandCatalogEntry): string {
  switch (e.effect.type) {
    case "aoe_damage":
      return "AOE";
    case "aoe_line_damage":
      return "LINE";
    case "aoe_shatter_chain":
      return "CHAIN";
    case "aoe_tactics_field":
      return "FIELD";
    case "noop":
      return "SPELL";
  }
}

function commandFields(e: CommandCatalogEntry): OverlayField[] {
  return [
    { id: "mana", value: String(e.fluxCost), tone: "mana", size: "xl", ...DEFAULT_COMMAND_FIELDS.mana },
    {
      id: "cooldown",
      value: `${e.chargeCooldownSeconds}s`,
      tone: "cooldown",
      size: "sm",
      ...DEFAULT_COMMAND_FIELDS.cooldown,
    },
    {
      id: "salvage",
      value: `${e.salvagePctOnCast}%`,
      tone: "salvage",
      size: "md",
      ...DEFAULT_COMMAND_FIELDS.salvage,
    },
    {
      id: "effect",
      value: commandEffectLabel(e),
      tone: "batch",
      size: "md",
      ...DEFAULT_COMMAND_FIELDS.effect,
    },
  ];
}

/** All overlay fields with catalog + saved layout merged (for persistence). */
function mergedOverlayFields(entry: CatalogEntry, catalogId: string): OverlayField[] {
  const raw = isCommandEntry(entry) ? commandFields(entry as CommandCatalogEntry) : structureFields(entry as StructureCatalogEntry);
  return applyLayoutsToFields(entry, catalogId, raw);
}

function fieldsForEntry(e: CatalogEntry, catalogId: string): OverlayField[] {
  // Same stat fields as canvas binder (`drawCardArtOverlayOnCanvasRect`). Authored card
  // SVGs may have text stripped when rasterized — overlays keep mana / CD / salvage readable.
  return mergedOverlayFields(e, catalogId).filter((f) => overlayFieldIsIncluded(f.id, catalogId));
}

function baseValueFontUserUnits(field: OverlayField): number {
  switch (field.size) {
    case "xl":
      return 7.9;
    case "sm":
      return 4.0;
    case "lg":
    case "md":
    default:
      return 6.8;
  }
}

const TONE_VALUE_FILL: Record<NonNullable<OverlayField["tone"]>, string> = {
  mana: "#fff7ee",
  hp: "#ffddd6",
  cooldown: "#d9ecff",
  prod: "#ffe38b",
  batch: "#ead7ff",
  uses: "#ead7ff",
  salvage: "#caffdf",
};

/**
 * Binder / canvas: same stat layout as the DOM SVG overlay. Prefer this over SVG-as-image
 * (nested `data:image/svg+xml` cannot reliably load external `<image href>` in all browsers).
 */
export function drawCardArtOverlayOnCanvasRect(
  ctx: CanvasRenderingContext2D,
  catalogId: string,
  destX: number,
  destY: number,
  destW: number,
  destH: number,
): void {
  const entry = getCatalogEntry(catalogId);
  if (!entry) return;
  const fields = fieldsForEntry(entry, catalogId);
  if (!fields.length) return;

  /** Match SVG `preserveAspectRatio="xMidYMid meet"` — uniform scale + centered letterboxing. */
  const scale = Math.min(destW / CARD_OVERLAY_WIDTH, destH / CARD_OVERLAY_HEIGHT);
  const ox = destX + (destW - scale * CARD_OVERLAY_WIDTH) / 2;
  const oy = destY + (destH - scale * CARD_OVERLAY_HEIGHT) / 2;

  ctx.save();
  for (const field of fields) {
    const { sx: fsu } = fieldTextScale(field, entry);
    const fontPx = Math.max(6.5, baseValueFontUserUnits(field) * fsu * scale);
    const cx = ox + field.x * scale;
    const cy = oy + field.y * scale;
    const anchor = field.anchor ?? "middle";
    ctx.textAlign = anchor === "start" ? "left" : anchor === "end" ? "right" : "center";
    ctx.font = `900 ${fontPx}px Georgia, "Times New Roman", serif`;
    ctx.letterSpacing = `${-0.04 * fontPx}px`;
    const m = ctx.measureText(field.value);
    const asc = m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent : fontPx * 0.72;
    const desc = m.actualBoundingBoxDescent > 0 ? m.actualBoundingBoxDescent : fontPx * 0.22;
    ctx.textBaseline = "alphabetic";
    const yBaseline = cy + (desc - asc) / 2;
    const fill = field.tone ? TONE_VALUE_FILL[field.tone] ?? "#fff7ee" : "#fff7ee";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1.6, fontPx * 0.31);
    ctx.strokeStyle = "rgba(0,0,0,0.92)";
    ctx.fillStyle = fill;
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = Math.max(1, fontPx * 0.12);
    ctx.shadowOffsetY = Math.max(0.5, fontPx * 0.1);
    ctx.strokeText(field.value, cx, yBaseline);
    ctx.fillText(field.value, cx, yBaseline);
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }
  ctx.restore();
}

function fieldClass(field: OverlayField): string {
  return [
    "card-art-overlay__field",
    `card-art-overlay__field--${field.id}`,
    field.tone ? `card-art-overlay__field--tone-${field.tone}` : "",
    field.size ? `card-art-overlay__field--${field.size}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function fieldSvg(field: OverlayField, entry: CatalogEntry): string {
  const anchor = field.anchor ?? "middle";
  const { w, h } = fieldBoxDims(field);
  const { sx, sy } = fieldTextScale(field, entry);
  return `<g class="${fieldClass(field)}" data-overlay-field="${escapeHtml(field.id)}" data-overlay-x="${field.x}" data-overlay-y="${field.y}" data-overlay-w="${w}" data-overlay-h="${h}" transform="translate(${field.x} ${field.y})">
    <g class="card-art-overlay__text-scale" data-overlay-role="text-scale" transform="scale(${sx} ${sy})">
      <text class="card-art-overlay__value" text-anchor="${anchor}" dominant-baseline="middle" data-overlay-role="value">${escapeHtml(field.value)}</text>
    </g>
    <rect class="card-art-overlay__hit" x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="2" />
    ${handlesSvg(field)}
  </g>`;
}

function defaultBoxHeight(_field: OverlayField): number {
  return 10;
}

function fieldBoxDims(field: OverlayField): { w: number; h: number } {
  return {
    w: field.width ?? 18,
    h: field.height ?? defaultBoxHeight(field),
  };
}

/** Default authored box size per field — text scales when layout width/height differ from this. */
function referenceBoxDims(field: OverlayField, entry: CatalogEntry): { rw: number; rh: number } {
  const rh = defaultBoxHeight(field);
  if (isCommandEntry(entry)) {
    const row = DEFAULT_COMMAND_FIELDS[field.id as keyof typeof DEFAULT_COMMAND_FIELDS];
    return { rw: row?.width ?? 18, rh };
  }
  const row = DEFAULT_STRUCTURE_FIELDS[field.id as keyof typeof DEFAULT_STRUCTURE_FIELDS];
  return { rw: row?.width ?? 18, rh };
}

function fieldTextScale(field: OverlayField, entry: CatalogEntry): { sx: number; sy: number } {
  const { w, h } = fieldBoxDims(field);
  const { rw, rh } = referenceBoxDims(field, entry);
  /** Uniform scale only — non-uniform sx/sy skewed text vs calibrated PNG slots (asset lab saves box size, not independent X/Y stretch). */
  const u = clamp(Math.min(w / rw, h / rh), 0.15, 12);
  return { sx: u, sy: u };
}

type ResizeHandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

function applyEdgeResize(
  handleId: "n" | "s" | "e" | "w",
  L0: number,
  T0: number,
  R0: number,
  B0: number,
  dx: number,
  dy: number,
): { cx: number; cy: number; w: number; h: number } {
  let L = L0;
  let T = T0;
  let R = R0;
  let B = B0;
  switch (handleId) {
    case "e":
      R = R0 + dx;
      break;
    case "w":
      L = L0 + dx;
      break;
    case "s":
      B = B0 + dy;
      break;
    case "n":
      T = T0 + dy;
      break;
    default:
      break;
  }
  if (L > R) [L, R] = [R, L];
  if (T > B) [T, B] = [B, T];
  const w = Math.max(4, R - L);
  const h = Math.max(4, B - T);
  const cx = (L + R) / 2;
  const cy = (T + B) / 2;
  return { cx, cy, w, h };
}

/**
 * Corner drag: preserve width/height ratio (uniform scale from fixed opposite corner).
 * Pointer (px, py) projects onto the diagonal ray through that corner.
 */
function applyCornerResize(
  handleId: "nw" | "ne" | "sw" | "se",
  L0: number,
  T0: number,
  R0: number,
  B0: number,
  px: number,
  py: number,
): { cx: number; cy: number; w: number; h: number } {
  const w0 = R0 - L0;
  const h0 = B0 - T0;
  const denom = w0 * w0 + h0 * h0;
  if (denom < 1e-8) {
    const w = 4;
    const h = 4;
    const cx = (L0 + R0) / 2;
    const cy = (T0 + B0) / 2;
    return { cx, cy, w, h };
  }

  let ax: number;
  let ay: number;
  let vx: number;
  let vy: number;
  switch (handleId) {
    case "se":
      ax = L0;
      ay = T0;
      vx = w0;
      vy = h0;
      break;
    case "nw":
      ax = R0;
      ay = B0;
      vx = -w0;
      vy = -h0;
      break;
    case "ne":
      ax = L0;
      ay = B0;
      vx = w0;
      vy = T0 - B0;
      break;
    case "sw":
      ax = R0;
      ay = T0;
      vx = -w0;
      vy = B0 - T0;
      break;
    default:
      ax = L0;
      ay = T0;
      vx = w0;
      vy = h0;
  }

  const denomV = vx * vx + vy * vy;
  let t = ((px - ax) * vx + (py - ay) * vy) / denomV;

  const tMin = Math.max(4 / w0, 4 / h0);
  let tMax = Infinity;
  switch (handleId) {
    case "se":
      tMax = Math.min((CARD_OVERLAY_WIDTH - L0) / w0, (CARD_OVERLAY_HEIGHT - T0) / h0, 48 / h0);
      break;
    case "nw":
      tMax = Math.min(R0 / w0, B0 / h0, 48 / h0);
      break;
    case "ne":
      tMax = Math.min((CARD_OVERLAY_WIDTH - L0) / w0, B0 / h0, 48 / h0);
      break;
    case "sw":
      tMax = Math.min(R0 / w0, (CARD_OVERLAY_HEIGHT - T0) / h0, 48 / h0);
      break;
  }
  t = clamp(t, tMin, tMax);

  let L: number;
  let T: number;
  let R: number;
  let B: number;
  switch (handleId) {
    case "se":
      L = L0;
      T = T0;
      R = L0 + t * w0;
      B = T0 + t * h0;
      break;
    case "nw":
      R = R0;
      B = B0;
      L = R0 - t * w0;
      T = B0 - t * h0;
      break;
    case "ne":
      L = L0;
      B = B0;
      R = L0 + t * w0;
      T = B0 - t * h0;
      break;
    case "sw":
      R = R0;
      T = T0;
      L = R0 - t * w0;
      B = T0 + t * h0;
      break;
    default:
      L = L0;
      R = R0;
      T = T0;
      B = B0;
  }

  if (L > R) [L, R] = [R, L];
  if (T > B) [T, B] = [B, T];
  const w = Math.max(4, R - L);
  const h = Math.max(4, B - T);
  const cx = (L + R) / 2;
  const cy = (T + B) / 2;
  return { cx, cy, w, h };
}

function handlesSvg(field: OverlayField): string {
  const { w, h } = fieldBoxDims(field);
  const L = -w / 2;
  const R = w / 2;
  const T = -h / 2;
  const B = h / 2;
  const pts: [ResizeHandleId, number, number][] = [
    ["nw", L, T],
    ["n", 0, T],
    ["ne", R, T],
    ["w", L, 0],
    ["e", R, 0],
    ["sw", L, B],
    ["s", 0, B],
    ["se", R, B],
  ];
  return `<g class="card-art-overlay__handles" aria-hidden="true">${pts
    .map(
      ([id, cx, cy]) =>
        `<circle class="card-art-overlay__handle" data-overlay-handle="${id}" cx="${cx}" cy="${cy}" r="2" />`,
    )
    .join("")}</g>`;
}

export type CardArtOverlayHtmlOpts = {
  calibrate?: boolean;
  /** In-match HUD slots: hide FX shape labels (AOE/LINE/FIELD) — stats stay on rules text / detail pop. */
  handSlot?: boolean;
};

export function cardArtOverlayHtml(catalogId: string, opts?: CardArtOverlayHtmlOpts): string {
  const entry = getCatalogEntry(catalogId);
  if (!entry) return "";
  const calibrate = opts?.calibrate === true || cardArtOverlayCalibrationEnabled();
  const edit = cardArtOverlayEditEnabled();
  let fields = fieldsForEntry(entry, catalogId);
  if (opts?.handSlot) fields = fields.filter((f) => f.id !== "effect");
  if (!fields.length) return "";
  const classes = ["card-art-overlay", calibrate ? "card-art-overlay--calibrate" : "", edit ? "card-art-overlay--edit" : ""]
    .filter(Boolean)
    .join(" ");
  /** `meet` keeps uniform scale vs card art; `none` stretched X/Y independently and misaligned labels (binder-style glitch). */
  return `<svg class="${classes}" data-card-art-overlay="${escapeHtml(catalogId)}" viewBox="0 0 ${CARD_OVERLAY_WIDTH} ${CARD_OVERLAY_HEIGHT}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    ${fields.map((f) => fieldSvg(f, entry)).join("")}
  </svg>`;
}

/** When set (e.g. asset lab page), overrides URL query flags for calibrate/edit. */
let overlayDevOverrides: Partial<{ edit: boolean; calibrate: boolean }> | null = null;

/**
 * Dev / asset-lab: toggle overlay modes without URL params. Pass `null` to use `?cardOverlayEdit=` / `?cardOverlayCalibrate=` only.
 * Call `refreshCardArtOverlayUi()` after changing HTML that contains overlays.
 */
export function setCardArtOverlayDevOverrides(
  next: Partial<{ edit: boolean; calibrate: boolean }> | null,
): void {
  overlayDevOverrides = next === null ? null : { ...overlayDevOverrides, ...next };
  refreshCardArtOverlayUi();
}

function cardArtOverlayCalibrationEnabled(): boolean {
  const o = overlayDevOverrides?.calibrate;
  if (o !== undefined) return o;
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get("cardOverlayCalibrate") === "1";
  } catch {
    return false;
  }
}

function cardArtOverlayEditEnabled(): boolean {
  const o = overlayDevOverrides?.edit;
  if (o !== undefined) return o;
  try {
    return import.meta.env.DEV && new URLSearchParams(globalThis.location?.search ?? "").get("cardOverlayEdit") === "1";
  } catch {
    return false;
  }
}

/** Default dev-server token — matches `vite.config.ts` fallback when `CARD_OVERLAY_WRITE_KEY` is unset. */
export const DEFAULT_CARD_OVERLAY_WRITE_KEY = "9889";

/** Optional override (e.g. asset lab session); when null, saves use `DEFAULT_CARD_OVERLAY_WRITE_KEY`. */
let overlayWriteSecretOverride: string | null = null;

export function setCardOverlayWriteKey(key: string | null): void {
  overlayWriteSecretOverride = key?.trim() ? key.trim() : null;
}

function resolvedOverlayWriteKeyForFetch(): string {
  return overlayWriteSecretOverride ?? DEFAULT_CARD_OVERLAY_WRITE_KEY;
}

let calibrationInstalled = false;
let editorPanel: HTMLElement | null = null;
/** When set (e.g. asset lab `#al-overlay-editor-host`), editor panel is appended here instead of `document.body`. */
let editorPanelMount: HTMLElement | null = null;

/**
 * Dock the dev overlay editor into a container (e.g. asset lab sidebar). Pass `null` to use default fixed positioning on `document.body`.
 */
export function setCardOverlayEditorMount(el: HTMLElement | null): void {
  editorPanelMount = el;
  if (editorPanel) {
    const parent = el ?? document.body;
    parent.appendChild(editorPanel);
    editorPanel.classList.toggle("card-overlay-editor-panel--docked", Boolean(el));
  }
}
let editorState: {
  catalogId: string | null;
  fieldId: string | null;
  dirty: boolean;
  status: string;
} = {
  catalogId: null,
  fieldId: null,
  dirty: false,
  status: "Drag a stat on a card, then Save.",
};

function cardPointFromPointer(svg: SVGSVGElement, ev: PointerEvent): { x: number; y: number } | null {
  const rect = svg.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: clamp(round1(((ev.clientX - rect.left) / rect.width) * CARD_OVERLAY_WIDTH), 0, CARD_OVERLAY_WIDTH),
    y: clamp(round1(((ev.clientY - rect.top) / rect.height) * CARD_OVERLAY_HEIGHT), 0, CARD_OVERLAY_HEIGHT),
  };
}

function parseFieldPoint(fieldEl: Element): { x: number; y: number } {
  const x = Number((fieldEl as HTMLElement).dataset.overlayX);
  const y = Number((fieldEl as HTMLElement).dataset.overlayY);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  const transform = fieldEl.getAttribute("transform") ?? "";
  const match = /translate\(([-\d.]+)[,\s]+([-\d.]+)\)/.exec(transform);
  return {
    x: match ? Number(match[1]) : 0,
    y: match ? Number(match[2]) : 0,
  };
}

function setRuntimeCardField(catalogId: string, fieldId: string, placement: OverlayFieldLayout): void {
  const card = overlayLayouts.cards?.[catalogId] ?? {};
  overlayLayouts = {
    ...overlayLayouts,
    cards: {
      ...(overlayLayouts.cards ?? {}),
      [catalogId]: {
        ...card,
        fields: {
          ...(card.fields ?? {}),
          [fieldId]: {
            ...(card.fields?.[fieldId] ?? {}),
            ...cleanFieldLayout(placement),
          },
        },
      },
    },
  };
}

function replaceRuntimeCardFields(catalogId: string, fields: Record<string, OverlayFieldLayout>): void {
  const card = overlayLayouts.cards?.[catalogId] ?? {};
  const cleanFields: Record<string, OverlayFieldLayout> = {};
  for (const [fieldId, layout] of Object.entries(fields)) {
    cleanFields[fieldId] = cleanFieldLayout(layout);
  }
  overlayLayouts = {
    ...overlayLayouts,
    cards: {
      ...(overlayLayouts.cards ?? {}),
      [catalogId]: {
        ...card,
        fields: cleanFields,
      },
    },
  };
}

function updateFieldElement(fieldEl: Element, field: OverlayField, entry: CatalogEntry): void {
  const { w, h } = fieldBoxDims(field);
  const { sx, sy } = fieldTextScale(field, entry);
  fieldEl.setAttribute("transform", `translate(${field.x} ${field.y})`);
  const hel = fieldEl as HTMLElement;
  hel.dataset.overlayX = String(field.x);
  hel.dataset.overlayY = String(field.y);
  hel.dataset.overlayW = String(w);
  hel.dataset.overlayH = String(h);
  const scaleG = fieldEl.querySelector<SVGGElement>('[data-overlay-role="text-scale"]');
  if (scaleG) scaleG.setAttribute("transform", `scale(${sx} ${sy})`);
  const valueEl = fieldEl.querySelector<SVGTextElement>('[data-overlay-role="value"]');
  if (valueEl) valueEl.textContent = field.value;
  const hit = fieldEl.querySelector<SVGRectElement>(".card-art-overlay__hit");
  if (hit) {
    hit.setAttribute("x", String(-w / 2));
    hit.setAttribute("y", String(-h / 2));
    hit.setAttribute("width", String(w));
    hit.setAttribute("height", String(h));
  }
  const L = -w / 2;
  const R = w / 2;
  const T = -h / 2;
  const B = h / 2;
  const pts: Record<string, [number, number]> = {
    nw: [L, T],
    n: [0, T],
    ne: [R, T],
    w: [L, 0],
    e: [R, 0],
    sw: [L, B],
    s: [0, B],
    se: [R, B],
  };
  for (const hEl of fieldEl.querySelectorAll<SVGCircleElement>(".card-art-overlay__handle")) {
    const hid = hEl.getAttribute("data-overlay-handle");
    const p = hid ? pts[hid] : undefined;
    if (p) {
      hEl.setAttribute("cx", String(p[0]));
      hEl.setAttribute("cy", String(p[1]));
    }
  }
}

function syncOverlaySvg(svg: SVGSVGElement): void {
  const catalogId = svg.getAttribute("data-card-art-overlay");
  if (!catalogId) return;
  const entry = getCatalogEntry(catalogId);
  if (!entry) return;
  const fields = fieldsForEntry(entry, catalogId);
  for (const fieldEl of svg.querySelectorAll(".card-art-overlay__field")) {
    const fieldId = fieldEl.getAttribute("data-overlay-field");
    const field = fields.find((f) => f.id === fieldId);
    if (field) updateFieldElement(fieldEl, field, entry);
  }
}

function syncDocumentOverlays(catalogId: string): void {
  for (const svg of document.querySelectorAll<SVGSVGElement>(".card-art-overlay")) {
    if (svg.getAttribute("data-card-art-overlay") === catalogId) syncOverlaySvg(svg);
  }
  syncSelectedFieldClasses();
}

function collectCardFieldPlacements(catalogId: string): Record<string, OverlayFieldLayout> {
  const entry = getCatalogEntry(catalogId);
  if (!entry) return {};
  const fields = mergedOverlayFields(entry, catalogId);
  const result: Record<string, OverlayFieldLayout> = {};
  for (const field of fields) {
    const { w, h } = fieldBoxDims(field);
    result[field.id] = {
      x: round1(field.x),
      y: round1(field.y),
      width: round1(w),
      height: round1(h),
    };
  }
  return result;
}

function syncSelectedFieldClasses(): void {
  for (const fieldEl of document.querySelectorAll(".card-art-overlay__field")) {
    const svg = fieldEl.closest(".card-art-overlay");
    const selected =
      Boolean(editorState.catalogId && editorState.fieldId) &&
      svg?.getAttribute("data-card-art-overlay") === editorState.catalogId &&
      fieldEl.getAttribute("data-overlay-field") === editorState.fieldId;
    fieldEl.classList.toggle("card-art-overlay__field--selected", selected);
  }
}

function ensureEditorPanel(): HTMLElement {
  if (editorPanel) return editorPanel;
  const panel = document.createElement("div");
  panel.className = "card-overlay-editor-panel";
  panel.addEventListener("click", (ev) => {
    const action = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-overlay-editor-action]")?.dataset
      .overlayEditorAction;
    if (action === "save") {
      void saveCurrentEditorLayout();
    } else if (action === "copy") {
      void copyCurrentEditorLayout();
    }
  });
  const parent = editorPanelMount ?? document.body;
  parent.append(panel);
  panel.classList.toggle("card-overlay-editor-panel--docked", Boolean(editorPanelMount));
  editorPanel = panel;
  renderEditorPanel();
  return panel;
}

function renderEditorPanel(): void {
  const panel = ensureEditorPanel();
  const catalogId = editorState.catalogId ?? "No card selected";
  const fieldId = editorState.fieldId ?? "No stat selected";
  const dirty = editorState.dirty ? "Unsaved changes" : "Saved / unchanged";
  panel.innerHTML = `
    <div class="card-overlay-editor-panel__eyebrow">Dev card overlay editor</div>
    <div class="card-overlay-editor-panel__row"><strong>Card</strong><span>${escapeHtml(catalogId)}</span></div>
    <div class="card-overlay-editor-panel__row"><strong>Field</strong><span>${escapeHtml(fieldId)}</span></div>
    <div class="card-overlay-editor-panel__row"><strong>State</strong><span>${escapeHtml(dirty)}</span></div>
    <div class="card-overlay-editor-panel__status">${escapeHtml(editorState.status)}</div>
    <div class="card-overlay-editor-panel__actions">
      <button type="button" data-overlay-editor-action="save" ${editorState.catalogId ? "" : "disabled"}>Save card default</button>
      <button type="button" data-overlay-editor-action="copy" ${editorState.catalogId ? "" : "disabled"}>Copy JSON</button>
    </div>
  `;
}

function selectEditorField(catalogId: string, fieldId: string): void {
  editorState = {
    ...editorState,
    catalogId,
    fieldId,
    status: "Drag body to move; drag handles to resize. Save makes this card's default layout.",
  };
  syncSelectedFieldClasses();
  renderEditorPanel();
}

async function saveCurrentEditorLayout(): Promise<void> {
  const catalogId = editorState.catalogId;
  if (!catalogId) return;
  const fields = collectCardFieldPlacements(catalogId);
  editorState = { ...editorState, status: "Saving layout...", dirty: true };
  renderEditorPanel();
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Card-Overlay-Write-Key": resolvedOverlayWriteKeyForFetch(),
    };
    const res = await fetch("/__card-overlay-layout", {
      method: "POST",
      headers,
      body: JSON.stringify({ catalogId, fields }),
    });
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    replaceRuntimeCardFields(catalogId, fields);
    syncDocumentOverlays(catalogId);
    editorState = { ...editorState, status: "Saved to src/ui/cardArtOverlayLayouts.json.", dirty: false };
  } catch (err) {
    editorState = {
      ...editorState,
      status: `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      dirty: true,
    };
  }
  renderEditorPanel();
}

async function copyCurrentEditorLayout(): Promise<void> {
  const catalogId = editorState.catalogId;
  if (!catalogId) return;
  const json = JSON.stringify({ [catalogId]: { fields: collectCardFieldPlacements(catalogId) } }, null, 2);
  try {
    await navigator.clipboard?.writeText(json);
    editorState = { ...editorState, status: "Copied layout JSON.", dirty: editorState.dirty };
  } catch {
    console.info("[card-overlay-edit]", json);
    editorState = { ...editorState, status: "Clipboard unavailable; JSON logged to console.", dirty: editorState.dirty };
  }
  renderEditorPanel();
}

function isResizeHandleId(s: string): s is ResizeHandleId {
  return /^(nw|n|ne|e|se|s|sw|w)$/.test(s);
}

function startOverlayResize(ev: PointerEvent, svg: SVGSVGElement, fieldEl: Element, handleId: string): void {
  if (!isResizeHandleId(handleId)) return;
  const catalogId = svg.getAttribute("data-card-art-overlay");
  const fieldId = fieldEl.getAttribute("data-overlay-field");
  if (!catalogId || !fieldId) return;
  const entry = getCatalogEntry(catalogId);
  if (!entry) return;
  const field = fieldsForEntry(entry, catalogId).find((f) => f.id === fieldId);
  if (!field) return;
  const { w, h } = fieldBoxDims(field);
  const cx = field.x;
  const cy = field.y;
  const L0 = cx - w / 2;
  const R0 = cx + w / 2;
  const T0 = cy - h / 2;
  const B0 = cy + h / 2;
  const start = cardPointFromPointer(svg, ev);
  if (!start) return;
  selectEditorField(catalogId, fieldId);
  ev.preventDefault();
  ev.stopPropagation();

  const move = (moveEv: PointerEvent): void => {
    const cur = cardPointFromPointer(svg, moveEv);
    if (!cur) return;
    let ncx: number;
    let ncy: number;
    let nw: number;
    let nh: number;
    if (handleId === "nw" || handleId === "ne" || handleId === "sw" || handleId === "se") {
      ({ cx: ncx, cy: ncy, w: nw, h: nh } = applyCornerResize(handleId, L0, T0, R0, B0, cur.x, cur.y));
    } else {
      const dx = cur.x - start.x;
      const dy = cur.y - start.y;
      ({ cx: ncx, cy: ncy, w: nw, h: nh } = applyEdgeResize(handleId as "n" | "s" | "e" | "w", L0, T0, R0, B0, dx, dy));
    }
    nw = clamp(round1(nw), 4, CARD_OVERLAY_WIDTH);
    nh = clamp(round1(nh), 4, 48);
    ncx = clamp(round1(ncx), 0, CARD_OVERLAY_WIDTH);
    ncy = clamp(round1(ncy), 0, CARD_OVERLAY_HEIGHT);
    setRuntimeCardField(catalogId, fieldId, {
      x: ncx,
      y: ncy,
      width: nw,
      height: nh,
    });
    editorState = { ...editorState, dirty: true, status: "Unsaved resize. Save card default when it looks right." };
    syncDocumentOverlays(catalogId);
    renderEditorPanel();
  };
  const done = (): void => {
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", done, true);
    document.removeEventListener("pointercancel", done, true);
  };
  document.addEventListener("pointermove", move, true);
  document.addEventListener("pointerup", done, true);
  document.addEventListener("pointercancel", done, true);
}

function startOverlayEditDrag(ev: PointerEvent, svg: SVGSVGElement, fieldEl: Element): void {
  const catalogId = svg.getAttribute("data-card-art-overlay");
  const fieldId = fieldEl.getAttribute("data-overlay-field");
  if (!catalogId || !fieldId) return;
  const startPoint = cardPointFromPointer(svg, ev);
  if (!startPoint) return;
  const current = parseFieldPoint(fieldEl);
  const offset = { x: current.x - startPoint.x, y: current.y - startPoint.y };
  selectEditorField(catalogId, fieldId);
  ev.preventDefault();
  ev.stopPropagation();

  const move = (moveEv: PointerEvent): void => {
    const point = cardPointFromPointer(svg, moveEv);
    if (!point) return;
    setRuntimeCardField(catalogId, fieldId, {
      x: clamp(round1(point.x + offset.x), 0, CARD_OVERLAY_WIDTH),
      y: clamp(round1(point.y + offset.y), 0, CARD_OVERLAY_HEIGHT),
    });
    editorState = { ...editorState, dirty: true, status: "Unsaved drag. Click Save card default when it looks right." };
    syncDocumentOverlays(catalogId);
    renderEditorPanel();
  };
  const done = (): void => {
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", done, true);
    document.removeEventListener("pointercancel", done, true);
  };
  document.addEventListener("pointermove", move, true);
  document.addEventListener("pointerup", done, true);
  document.addEventListener("pointercancel", done, true);
}

/** Replace every overlay SVG in the document so visibility / layout edits apply (cheap vs patch per-node). */
function rebuildAllCardArtOverlaySvgsFromDom(): void {
  for (const svg of document.querySelectorAll<SVGSVGElement>(".card-art-overlay")) {
    const catalogId = svg.getAttribute("data-card-art-overlay");
    if (!catalogId) continue;
    const html = cardArtOverlayHtml(catalogId).trim();
    if (!html) continue;
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const next = tpl.content.firstElementChild;
    if (next instanceof SVGSVGElement) svg.replaceWith(next);
  }
}

/**
 * Effective checkbox state per overlay field for one catalog card (legacy global defaults + per-card overrides).
 */
export function getOverlayFieldVisibilityForCard(catalogId: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const { id } of CARD_OVERLAY_FIELD_TOGGLES) {
    out[id] = overlayFieldIsIncluded(id, catalogId);
  }
  return out;
}

/**
 * Persist overlay stat toggles for a single catalog card (`localStorage` key `battleLogs.cardOverlay.fieldVisibilityByCard`).
 * Older global saves under `battleLogs.cardOverlay.fieldVisibility` still apply as fallback for fields not overridden here.
 */
export function setOverlayFieldVisibilityForCard(catalogId: string, patch: Partial<Record<string, boolean>>): void {
  const map = { ...getOverlayFieldVisibilityPerCardMap() };
  const card = { ...(map[catalogId] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "boolean") card[k] = v;
  }
  map[catalogId] = card;
  overlayFieldVisibilityPerCardCache = map;
  try {
    globalThis.localStorage?.setItem(OVERLAY_FIELD_VISIBILITY_BY_CARD_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
  rebuildAllCardArtOverlaySvgsFromDom();
  refreshCardArtOverlayUi();
}

/** Sync HTML classes + editor panel visibility with current edit/calibrate flags (after overrides change). */
export function refreshCardArtOverlayUi(): void {
  const edit = cardArtOverlayEditEnabled();
  const cal = cardArtOverlayCalibrationEnabled();
  document.documentElement.classList.toggle("is-card-overlay-editing", edit);
  document.documentElement.classList.toggle("is-card-overlay-calibrating", cal);
  if (editorPanel) editorPanel.style.display = edit ? "" : "none";
  if (edit) ensureEditorPanel();
  for (const svg of document.querySelectorAll<SVGElement>(".card-art-overlay")) {
    svg.classList.toggle("card-art-overlay--edit", edit);
    svg.classList.toggle("card-art-overlay--calibrate", cal);
  }
  renderEditorPanel();
}

/**
 * Dev-only helpers. `?cardOverlayEdit=1` opens a draggable editor with Save-to-repo support;
 * `?cardOverlayCalibrate=1` keeps the older click-to-copy coordinate logger.
 * Asset lab uses `setCardArtOverlayDevOverrides` instead of query flags.
 */
export function installCardArtOverlayCalibrator(): void {
  const editEnabled = cardArtOverlayEditEnabled();
  const calibrateEnabled = cardArtOverlayCalibrationEnabled();
  if (calibrationInstalled || (!editEnabled && !calibrateEnabled)) return;
  calibrationInstalled = true;
  refreshCardArtOverlayUi();
  document.addEventListener(
    "pointerdown",
    (ev) => {
      const editOn = cardArtOverlayEditEnabled();
      const calOn = cardArtOverlayCalibrationEnabled();
      const target = ev.target as Element | null;
      const svg = target?.closest?.(".card-art-overlay") as SVGSVGElement | null;
      if (!svg) return;
      const handleEl = target?.closest?.("[data-overlay-handle]");
      const fieldEl = target?.closest?.("[data-overlay-field]");
      if (editOn && handleEl && fieldEl) {
        const hid = handleEl.getAttribute("data-overlay-handle");
        if (hid) {
          startOverlayResize(ev, svg, fieldEl, hid);
          return;
        }
      }
      if (editOn && fieldEl) {
        startOverlayEditDrag(ev, svg, fieldEl);
        return;
      }
      if (!calOn) return;
      const point = cardPointFromPointer(svg, ev);
      if (!point) return;
      ev.preventDefault();
      ev.stopPropagation();
      const field = fieldEl?.getAttribute("data-overlay-field") ?? "newField";
      const catalogId = svg.getAttribute("data-card-art-overlay") ?? "unknown";
      const snippet = `${field}: { x: ${point.x.toFixed(1)}, y: ${point.y.toFixed(1)} }`;
      console.info(`[card-overlay-calibrate] ${catalogId} ${snippet}`);
      void navigator.clipboard?.writeText(snippet).catch(() => {});
    },
    { capture: true },
  );
}
