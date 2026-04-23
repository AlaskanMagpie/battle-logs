import { commandEffectRadius, getCatalogEntry } from "../game/catalog";
import { COMMAND_FRIENDLY_PRESENCE_RADIUS } from "../game/constants";
import type {
  CatalogEntry,
  CommandCatalogEntry,
  SignalCountRequirement,
  SignalType,
  StructureCatalogEntry,
  UnitSizeClass,
} from "../game/types";
import { isCommandEntry, isStructureEntry } from "../game/types";

function dominantSignalFromEntry(e: CatalogEntry): SignalType | undefined {
  if (!e.signalTypes.length) return undefined;
  const counts: Record<SignalType, number> = { Vanguard: 0, Bastion: 0, Reclaim: 0 };
  for (const s of e.signalTypes) counts[s]++;
  let best: SignalType = e.signalTypes[0]!;
  let bestN = -1;
  for (const k of Object.keys(counts) as SignalType[]) {
    if (counts[k] > bestN) {
      bestN = counts[k];
      best = k;
    }
  }
  return best;
}

function wizardTierShort(requiredTier: number): string {
  const t = Math.max(1, requiredTier || 1);
  return `Wizard Tier ${t}`;
}

/** Readable relay gate (matches `requiredSignalCounts` in catalog). */
function formatRelayRequirement(rc: SignalCountRequirement): string {
  const parts: string[] = [];
  for (const k of ["Vanguard", "Bastion", "Reclaim"] as const) {
    const n = rc[k];
    if (n && n > 0) parts.push(`${n}× ${k}`);
  }
  return parts.join(", ");
}

function relayRequirementSentence(e: { requiredSignalCounts?: SignalCountRequirement }): string | null {
  const rc = e.requiredSignalCounts;
  if (!rc) return null;
  const s = formatRelayRequirement(rc);
  return s ? `You need ${s} on the field from built relays before you can play this card.` : null;
}

/** Readable spell summary for tooltips / titles. */
function commandSpellTooltipSummary(e: CommandCatalogEntry): string {
  const { target, rolls, payLine } = commandSpellFxRows(e);
  return `${target} ${rolls.join(" ")} · ${payLine}`;
}

function commandSpellFxRows(e: CommandCatalogEntry): {
  target: string;
  rolls: string[];
  payLine: string;
} {
  const fx = e.effect;
  const payLine = `Costs ${e.fluxCost} mana · ${e.salvagePctOnCast}% of that cost goes to Salvage · ${e.chargeCooldownSeconds}s cooldown on this slot after casting`;
  switch (fx.type) {
    case "recycle_structure":
      return {
        target: "One of your finished towers (the Keep cannot be picked).",
        rolls: [
          "Destroys the tower and removes any units tied to it.",
          "You gain Salvage equal to about 90% of that tower's original build price.",
        ],
        payLine,
      };
    case "aoe_damage":
      return {
        target: `Ground point; a friendly unit or tower must be within ${COMMAND_FRIENDLY_PRESENCE_RADIUS} world units of the blast center.`,
        rolls: [
          `Ring radius ${fx.radius}: every enemy unit inside takes ${fx.damage} damage.`,
          "Enemy Dark Fortresses touched by the ring take half that damage from this spell.",
        ],
        payLine,
      };
    case "buff_structure":
      return {
        target: "One of your finished towers.",
        rolls: [
          `For ${fx.durationSeconds}s incoming damage to that tower is reduced by ${fx.damageReductionPct}% (multiplicative with other effects).`,
        ],
        payLine,
      };
    case "shatter_structure":
      return {
        target: "Enemy Dark Fortress — click the fortress itself.",
        rolls: [
          `The fortress loses ${fx.damage} HP.`,
          `Its production is silenced for ${fx.silenceSeconds}s; nearby enemy towers can catch the same silence window.`,
        ],
        payLine,
      };
    case "noop":
      return {
        target: "Anywhere on the map.",
        rolls: ["No combat resolution yet — Mana is still spent and Salvage still applies per the card."],
        payLine,
      };
  }
}

function dmSpellCostLine(e: CommandCatalogEntry): string {
  return `${e.fluxCost} mana · ${e.chargeCooldownSeconds}s cooldown · ${e.salvagePctOnCast}% → Salvage`;
}

function dmSpellFxCompact(e: CommandCatalogEntry): string {
  const { target, rolls, payLine } = commandSpellFxRows(e);
  const lis = rolls.map((t) => `<li class="dm-spell-fx-li">${escapeHtml(t)}</li>`).join("");
  const tip = escapeHtml(`${e.name} — ${commandSpellTooltipSummary(e)}`);
  return `<div class="dm-spell-fx" title="${tip}">
    <div class="dm-spell-fx-cap">Effect</div>
    <div class="dm-spell-fx-target"><span class="dm-spell-fx-k">Target</span> ${escapeHtml(target)}</div>
    <ul class="dm-spell-fx-ul" aria-label="Spell resolution">${lis}</ul>
    <div class="dm-spell-fx-pay">${escapeHtml(payLine)}</div>
  </div>`;
}

function dcSpellEffectPanel(e: CommandCatalogEntry): string {
  const { target, rolls, payLine } = commandSpellFxRows(e);
  const lis = rolls.map((t) => `<li>${escapeHtml(t)}</li>`).join("");
  return `<section class="dc-spell-panel" aria-label="Spell effect details">
    <div class="dc-spell-panel__banner" role="heading" aria-level="3">Spell effect</div>
    <div class="dc-spell-panel__grid">
      <div class="dc-spell-panel__label">Target</div>
      <p class="dc-spell-panel__text">${escapeHtml(target)}</p>
      <div class="dc-spell-panel__label">Resolves</div>
      <ul class="dc-spell-panel__ul">${lis}</ul>
      <div class="dc-spell-panel__label">Each cast</div>
      <p class="dc-spell-panel__text dc-spell-panel__pay">${escapeHtml(payLine)}</p>
    </div>
  </section>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Doctrine / HUD preview accent: one stable hue per produced class or spells. */
const PREVIEW_HUE_SPELL = 278;
const PREVIEW_HUE_BY_CLASS: Record<UnitSizeClass, number> = {
  Swarm: 103,
  Line: 199,
  Heavy: 30,
  Titan: 328,
};

/**
 * Preview-card accent hue by type: **Spell**, **Swarm**, **Line**, **Heavy**, **Titan**
 * (structures use `producedSizeClass`; commands use the spell bucket).
 */
export function catalogPreviewTypeHue(e: CatalogEntry | null): number {
  if (!e) return 210;
  if (isCommandEntry(e)) return PREVIEW_HUE_SPELL;
  if (isStructureEntry(e)) return PREVIEW_HUE_BY_CLASS[e.producedSizeClass] ?? 210;
  return 210;
}

/** @deprecated Prefer `catalogPreviewTypeHue(getCatalogEntry(id))` — kept for call sites that only have an id string. */
export function catalogCardHue(catalogId: string): number {
  return catalogPreviewTypeHue(getCatalogEntry(catalogId));
}

/** CSS hook `tcg--preview-type-*` for type-tinted chrome (Line / Swarm / Heavy / Titan / Spell). */
export function catalogPreviewTypeClass(e: CatalogEntry): string {
  if (isCommandEntry(e)) return "tcg--preview-type-spell";
  if (isStructureEntry(e)) return `tcg--preview-type-${e.producedSizeClass}`;
  return "tcg--preview-type-unknown";
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function signalTypesLine(e: CatalogEntry): string {
  return e.signalTypes?.length ? e.signalTypes.join(", ") : "—";
}

function auraLabel(e: StructureCatalogEntry): string | null {
  if (!e.aura) return null;
  const a = e.aura;
  switch (a.kind) {
    case "heal_structures":
      return `Heals friendly structures (${a.value} HP/s, r${a.radius})`;
    case "salvage_bonus":
      return `+${Math.round(a.value * 100)}% Salvage on deaths within r${a.radius}`;
    case "turret":
      return `Turret: ${a.value} dmg/tick (r${a.radius})`;
    case "safe_deploy_radius":
      return `Safe-deploy aura (r${a.radius})`;
  }
}

function traitLabel(e: StructureCatalogEntry): string | null {
  const bits: string[] = [];
  if (e.unitTrait === "lifesteal") bits.push("Unit: lifesteal");
  if (
    typeof e.producedDamageVsStructuresMult === "number" &&
    e.producedDamageVsStructuresMult > 1
  ) {
    const pct = Math.round((e.producedDamageVsStructuresMult - 1) * 100);
    bits.push(`Unit: +${pct}% vs enemy structures`);
  }
  if (e.unitAoeRadius) bits.push(`Unit: AoE r${e.unitAoeRadius}`);
  if (e.unitFlying) bits.push("Unit: flying");
  if (e.salvageRefundFrac && e.salvageRefundFrac > 0.8) {
    bits.push(`Refund ${Math.round(e.salvageRefundFrac * 100)}% on death`);
  }
  return bits.length ? bits.join(" · ") : null;
}

function silhouetteShapes(e: StructureCatalogEntry): string {
  const sigs = e.signalTypes;
  const v = sigs.filter((s) => s === "Vanguard").length;
  const b = sigs.filter((s) => s === "Bastion").length;
  const r = sigs.filter((s) => s === "Reclaim").length;

  const vanguardSpire = `
    <rect x="30" y="56" width="20" height="28" rx="2" fill="rgba(0,0,0,0.4)"/>
    <rect x="32" y="56" width="16" height="24" rx="2" fill="rgba(255,255,255,0.08)"/>
    <rect x="36" y="28" width="8" height="32" rx="2" fill="rgba(255,255,255,0.16)"/>
    <path d="M40 12 L46 30 L34 30 Z" fill="rgba(255, 220, 170, 0.55)"/>
    <rect x="20" y="40" width="6" height="28" rx="1" fill="rgba(0,0,0,0.32)"/>
    <rect x="54" y="40" width="6" height="28" rx="1" fill="rgba(0,0,0,0.32)"/>`;

  const bastionKeep = `
    <rect x="12" y="40" width="56" height="44" rx="3" fill="rgba(0,0,0,0.35)"/>
    <rect x="14" y="40" width="52" height="40" rx="2" fill="rgba(255,255,255,0.08)"/>
    <rect x="24" y="24" width="32" height="20" rx="2" fill="rgba(255,255,255,0.13)"/>
    <rect x="16" y="34" width="6" height="8" fill="rgba(0,0,0,0.45)"/>
    <rect x="28" y="34" width="6" height="8" fill="rgba(0,0,0,0.45)"/>
    <rect x="40" y="34" width="6" height="8" fill="rgba(0,0,0,0.45)"/>
    <rect x="52" y="34" width="6" height="8" fill="rgba(0,0,0,0.45)"/>`;

  const reclaimGrove = `
    <ellipse cx="40" cy="70" rx="26" ry="10" fill="rgba(0,0,0,0.32)"/>
    <circle cx="40" cy="54" r="18" fill="rgba(255,255,255,0.14)"/>
    <ellipse cx="40" cy="52" rx="16" ry="14" fill="rgba(150,220,170,0.22)"/>
    <circle cx="28" cy="44" r="4" fill="rgba(180,240,200,0.5)"/>
    <circle cx="52" cy="42" r="5" fill="rgba(180,240,200,0.55)"/>
    <circle cx="40" cy="32" r="3.5" fill="rgba(220,255,220,0.6)"/>`;

  if (v >= 2) return vanguardSpire;
  if (b >= 2) return bastionKeep;
  if (r >= 2) return reclaimGrove;
  if (v && b) return bastionKeep + `<path d="M40 10 L46 36 L34 36 Z" fill="rgba(255,200,140,0.6)"/>`;
  if (v && r) return reclaimGrove + `<path d="M40 14 L44 34 L36 34 Z" fill="rgba(255,200,140,0.5)"/>`;
  if (r && b) return bastionKeep + `<circle cx="40" cy="30" r="8" fill="rgba(150,220,170,0.48)"/>`;
  if (v) return vanguardSpire;
  if (b) return bastionKeep;
  if (r) return reclaimGrove;
  return vanguardSpire;
}

function cardDetailButton(catalogId: string): string {
  return `<button type="button" class="tcg-detail-btn" data-card-detail="${escapeHtml(catalogId)}" aria-label="Full card details" title="Details">i</button>`;
}

/** Stylized structure / command portrait (no external image assets). */
function catalogPortraitSvg(catalogId: string, hue: number, cmd: boolean, idSuffix: string): string {
  const gid = `svg_${idSuffix.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  if (cmd) {
    return `<svg class="tcg-portrait-svg" viewBox="0 0 80 96" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="hsl(${hue}, 52%, 38%)"/>
          <stop offset="100%" stop-color="hsl(${hue + 55}, 28%, 10%)"/>
        </linearGradient>
      </defs>
      <rect width="80" height="96" fill="url(#${gid})"/>
      <path fill="rgba(0,0,0,0.28)" d="M40 14 L62 36 L40 82 L18 36 Z"/>
      <circle cx="40" cy="40" r="11" fill="rgba(255,255,255,0.14)"/>
    </svg>`;
  }
  const entry = getCatalogEntry(catalogId);
  const shapes = entry && isStructureEntry(entry) ? silhouetteShapes(entry) : "";
  return `<svg class="tcg-portrait-svg" viewBox="0 0 80 96" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <linearGradient id="${gid}" x1="0%" y1="0%" x2="80%" y2="100%">
        <stop offset="0%" stop-color="hsl(${hue}, 48%, 36%)"/>
        <stop offset="100%" stop-color="hsl(${hue + 40}, 26%, 11%)"/>
      </linearGradient>
    </defs>
    <rect width="80" height="96" fill="url(#${gid})"/>
    ${shapes}
  </svg>`;
}

/* —— Doctrine card “blueprint” layout (dc-*) —— */

const DC_ICON_SIG = `<svg class="dc-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 2v11h3v9l7-12h-4l4-10H7z"/></svg>`;
const DC_ICON_LOCK = `<svg class="dc-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1V8z"/></svg>`;
const DC_ICON_SWORDS = `<span class="dc-ico dc-ico--txt" aria-hidden="true">⚔</span>`;

function signalSlug(e: CatalogEntry): string {
  const d = dominantSignalFromEntry(e);
  if (!d) return "none";
  return d.toLowerCase();
}

function unitPillTitle(e: StructureCatalogEntry): string {
  const f = e.producedFlavor?.trim();
  if (f) {
    const head = f.split("(")[0]!.trim();
    if (head) return head;
  }
  return `${e.producedSizeClass} squad`;
}

function flavorTraitTags(e: StructureCatalogEntry): string[] {
  const f = e.producedFlavor;
  if (!f) return [];
  const m = f.match(/\(([^)]+)\)/);
  if (!m) return [];
  return m[1]!
    .split(/[,/·]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toUpperCase());
}

/** CSS `--spell-aoe` scale for impact rings (larger = reads as bigger in-world footprint). */
function spellAoeScale(e: CommandCatalogEntry): string {
  const rWorld = commandEffectRadius(e);
  if (rWorld != null) {
    const t = Math.min(1, Math.max(0, (rWorld - 5) / 10));
    return (0.84 + t * 0.36).toFixed(3);
  }
  const fx = e.effect;
  if (fx.type === "shatter_structure") return "0.78";
  if (fx.type === "recycle_structure" || fx.type === "buff_structure") return "0.5";
  if (fx.type === "noop") return "0.55";
  return "0.65";
}

function spellGhostClass(e: CommandCatalogEntry): string {
  switch (e.effect.type) {
    case "aoe_damage":
      return "spell-card-viz__ghost--firestorm";
    case "buff_structure":
      return "spell-card-viz__ghost--fortify";
    case "shatter_structure":
      return "spell-card-viz__ghost--shatter";
    case "recycle_structure":
      return "spell-card-viz__ghost--recycle";
    default:
      return "spell-card-viz__ghost--noop";
  }
}

function spellAoeEmberDots(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`<span class="spell-card-viz__ember" style="--ember-i:${i}"></span>`);
  }
  return parts.join("");
}

function spellAoeCrackLines(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`<span class="spell-card-viz__crack" style="--crack-i:${i}"></span>`);
  }
  return parts.join("");
}

function spellRecycleCubes(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`<span class="spell-card-viz__scrap" style="--scrap-i:${i}"></span>`);
  }
  return parts.join("");
}

/** AoE footprint + looping “ghost” of the cast FX (card-only; mirrors `spawnCastFx` palettes). */
function spellCardVizHtml(e: CommandCatalogEntry): string {
  const fx = e.effect;
  const aoe = spellAoeScale(e);
  const ghost = spellGhostClass(e);
  const fxType = fx.type;
  let aoeDecor = "";
  if (fxType === "aoe_damage") {
    aoeDecor = `<div class="spell-card-viz__embers" aria-hidden="true">${spellAoeEmberDots(10)}</div>`;
  } else if (fxType === "shatter_structure") {
    aoeDecor = `<div class="spell-card-viz__cracks" aria-hidden="true">${spellAoeCrackLines(6)}</div>`;
  }
  let ghostDecor = "";
  if (fxType === "recycle_structure") {
    ghostDecor = `<div class="spell-card-viz__ghost-scraps" aria-hidden="true">${spellRecycleCubes(6)}</div>`;
  }
  return `<div class="spell-card-viz spell-card-viz--${escapeHtml(fxType)}" data-spell-effect="${escapeHtml(fxType)}" style="--spell-aoe:${aoe}">
    <div class="spell-card-viz__aoe" aria-hidden="true">
      <div class="spell-card-viz__aoe-ring spell-card-viz__aoe-ring--outer"></div>
      <div class="spell-card-viz__aoe-ring spell-card-viz__aoe-ring--inner"></div>
      ${aoeDecor}
    </div>
    <div class="spell-card-viz__ghost ${ghost}" aria-hidden="true">${ghostDecor}</div>
  </div>`;
}

function spellPortraitStack(portrait: string, spell: CommandCatalogEntry): string {
  return `<div class="tcg-portrait-fallback tcg-portrait-fallback--solo tcg-portrait-fallback--spell">
    <div class="spell-card-portrait-under" aria-hidden="true">${portrait}</div>
    ${spellCardVizHtml(spell)}
  </div>`;
}

function dcHeroArt(
  catalogId: string,
  portrait: string,
  compact: boolean,
  useGlbPreview: boolean,
  spell?: CommandCatalogEntry,
): string {
  const mod = compact ? "dc-hero-art--compact" : "dc-hero-art--full";
  const img = useGlbPreview
    ? `<img class="tcg-card-preview-img" data-catalog-preview="${escapeHtml(catalogId)}" alt="" decoding="async" hidden />`
    : "";
  if (spell) {
    return `<div class="dc-hero-art dc-hero-art--spell ${mod}">
      ${img}
      ${spellPortraitStack(portrait, spell)}
    </div>`;
  }
  const fbMod = useGlbPreview ? "" : " tcg-portrait-fallback--solo";
  return `<div class="dc-hero-art ${mod}">
    ${img}
    <div class="tcg-portrait-fallback${fbMod}">${portrait}</div>
  </div>`;
}

/** Compact face art — spells show AoE + ghost cast preview (structures may use GLB raster). */
function dmHeroArt(catalogId: string, portrait: string, useGlbPreview: boolean, spell?: CommandCatalogEntry): string {
  const img = useGlbPreview
    ? `<img class="tcg-card-preview-img" data-catalog-preview="${escapeHtml(catalogId)}" alt="" decoding="async" hidden />`
    : "";
  if (spell) {
    return `<div class="dm-art dm-art--spell">
      ${img}
      ${spellPortraitStack(portrait, spell)}
    </div>`;
  }
  const fbMod = useGlbPreview ? "" : " tcg-portrait-fallback--solo";
  return `<div class="dm-art">
    ${img}
    <div class="tcg-portrait-fallback${fbMod}">${portrait}</div>
  </div>`;
}

function dmSignalLabel(e: CatalogEntry): string {
  const dom = dominantSignalFromEntry(e);
  if (dom) return dom;
  if (e.signalTypes.length === 1) return e.signalTypes[0]!;
  if (e.signalTypes.length > 1) return "Mixed signals";
  return "—";
}

function dmCdTitle(cmd: boolean): string {
  return cmd ? "Per-use cooldown after casting this spell" : "Cooldown between spawned units";
}

function dmStatsOneLine(e: CatalogEntry): string {
  if (isCommandEntry(e)) {
    return `${e.fluxCost} · ${e.chargeCooldownSeconds}s · ${e.salvagePctOnCast}%`;
  }
  return `${e.maxHp} HP · ${e.buildSeconds} / ${e.productionSeconds}s · ${e.producedPop}/${e.localPopCap}`;
}

function dcHeroTopTags(cmd: boolean, classOrSpell: string, cdSeconds: number): string {
  const cdShow = cdSeconds > 0 ? `${cdSeconds}s` : "—";
  const pillClass = cmd ? "dc-pill dc-pill--spell" : "dc-pill dc-pill--class";
  const pillCd = "dc-pill dc-pill--cd";
  return `<div class="dc-hero-tags">
    <span class="${pillClass}"><span class="dc-pill-dot" aria-hidden="true"></span>${escapeHtml(classOrSpell)}</span>
    <span class="${pillCd}"><span class="dc-pill-dot dc-pill-dot--cd" aria-hidden="true"></span>${escapeHtml(cdShow)}</span>
  </div>`;
}

function dcTitleBlock(name: string, kindWord: "Structure" | "Command", compact: boolean): string {
  const titleTag = compact ? "h2" : "h1";
  const up = escapeHtml(name.toUpperCase());
  return `<div class="dc-hero-titles">
    <${titleTag} class="dc-title">${up}</${titleTag}>
    <p class="dc-subtitle"><span class="dc-subtitle-strong">Doctrine</span><span class="dc-subtitle-sep"> • </span><span class="dc-subtitle-kind">${kindWord}</span></p>
  </div>`;
}

type DcStatTone = "hp" | "build" | "prod" | "pop" | "mana" | "cd" | "salv" | "tier";

function dcStatRail4(
  a: { v: string; l: string; t: DcStatTone },
  b: { v: string; l: string; t: DcStatTone },
  c: { v: string; l: string; t: DcStatTone },
  d: { v: string; l: string; t: DcStatTone },
  compact: boolean,
): string {
  const cell = (x: { v: string; l: string; t: DcStatTone }) =>
    `<div class="dc-stat"><span class="dc-stat-val dc-stat-val--${x.t}">${escapeHtml(x.v)}</span><span class="dc-stat-lbl">${escapeHtml(x.l)}</span></div>`;
  const div = `<span class="dc-stat-div" aria-hidden="true"></span>`;
  const railMod = compact ? "dc-stat-rail--compact" : "";
  return `<div class="dc-stat-rail ${railMod}">${cell(a)}${div}${cell(b)}${div}${cell(c)}${div}${cell(d)}</div>`;
}

function dcMetaSignal(e: CatalogEntry): string {
  const slug = signalSlug(e);
  const line = signalTypesLine(e);
  return `<div class="dc-meta-row">
    <span class="dc-meta-ico dc-meta-ico--sig" aria-hidden="true">${DC_ICON_SIG}</span>
    <span class="dc-meta-k">Signal</span>
    <span class="dc-meta-v dc-meta-v--sig-${slug}">${escapeHtml(line)}</span>
  </div>`;
}

function dcMetaUnlock(tier: number): string {
  return `<div class="dc-meta-row">
    <span class="dc-meta-ico dc-meta-ico--lock" aria-hidden="true">${DC_ICON_LOCK}</span>
    <span class="dc-meta-k">Unlock</span>
    <span class="dc-meta-v dc-meta-v--unlock">${escapeHtml(wizardTierShort(tier))}</span>
  </div>`;
}

function dcRelayRow(e: CatalogEntry): string {
  const s = relayRequirementSentence(e);
  if (!s) return "";
  return `<div class="dc-meta-row dc-meta-row--relay"><span class="dc-meta-k">Relays</span><span class="dc-meta-v dc-meta-v--relay">${escapeHtml(s)}</span></div>`;
}

function dcUnitPill(e: StructureCatalogEntry): string {
  const tags = flavorTraitTags(e);
  const tagHtml = tags.map((t) => `<span class="dc-unit-tag">${escapeHtml(t)}</span>`).join("");
  return `<div class="dc-unit-pill">
    <div class="dc-unit-pill-left"><span class="dc-unit-ico" aria-hidden="true">${DC_ICON_SWORDS}</span><span class="dc-unit-name">${escapeHtml(unitPillTitle(e))}</span></div>
    <div class="dc-unit-tags">${tagHtml}</div>
  </div>`;
}

function dcAbilityStructure(e: StructureCatalogEntry): string {
  if (e.chargeCooldownSeconds <= 0 && !e.producedAntiClass) return "";
  const title = e.producedAntiClass ? `Anti ${e.producedAntiClass}` : "Unit ability";
  const cd = e.chargeCooldownSeconds > 0 ? `${e.chargeCooldownSeconds}s` : "—";
  return `<div class="dc-ability" role="group" aria-label="Spawned unit ability">
    <div class="dc-ability-ico" aria-hidden="true">⌖</div>
    <div class="dc-ability-mid">
      <div class="dc-ability-title">${escapeHtml(title)}</div>
      <div class="dc-ability-sub">Unlimited uses</div>
    </div>
    <div class="dc-ability-right">
      <div class="dc-ability-cd">${escapeHtml(cd)}</div>
      <div class="dc-ability-cd-lbl">COOLDOWN</div>
    </div>
  </div>`;
}

function dcFlavor(text: string | undefined): string {
  if (!text?.trim()) return "";
  return `<div class="dc-flavor"><div class="dc-flavor-accent" aria-hidden="true"></div><p class="dc-flavor-text">${escapeHtml(text)}</p></div>`;
}

function dcAuxStructure(e: StructureCatalogEntry): string {
  const a = auraLabel(e);
  const t = traitLabel(e);
  if (!a && !t) return "";
  const bits: string[] = [];
  if (a) bits.push(`<div class="dc-aux">${escapeHtml(a)}</div>`);
  if (t) bits.push(`<div class="dc-aux">${escapeHtml(t)}</div>`);
  return bits.join("");
}

export type TcgCardVariant = "hud" | "picker";

/** Compact face: minimal layout — art + short lines only (full stats in modal / hover). */
export function tcgCardCompactHtml(catalogId: string, variant: TcgCardVariant, deckSlotIndex?: number): string {
  const e = getCatalogEntry(catalogId);
  if (!e) {
    return `<div class="tcg tcg--compact tcg--layout-min doctrine-card-compact tcg--unknown tcg--preview-type-unknown" data-catalog-id="${escapeHtml(catalogId)}" style="--tcg-h:210"><div class="dm-shell dm-shell--compact"><div class="dm-art dm-art--empty"><span class="dm-empty">?</span></div><div class="dm-name">Unknown</div><div class="dm-stats">—</div></div></div>`;
  }
  const hue = catalogPreviewTypeHue(e);
  const previewTypeClass = catalogPreviewTypeClass(e);
  const cmd = isCommandEntry(e);
  const sizeClass = cmd ? "" : e.producedSizeClass;
  const sizeMod = cmd ? "" : ` tcg--size-${sizeClass}`;
  const classTag = cmd ? "Spell" : e.producedSizeClass;
  const manaVal = String(e.fluxCost);
  const svgKey = deckSlotIndex != null ? `${catalogId}_slot${deckSlotIndex}` : `${catalogId}_${variant}`;
  const portrait = catalogPortraitSvg(catalogId, hue, cmd, svgKey);
  const deckNo =
    deckSlotIndex != null
      ? `<div class="tcg-deck-no" aria-label="Deck slot ${deckSlotIndex + 1}">${deckSlotIndex + 1}</div>`
      : "";
  const kindClass = cmd ? "tcg--kind-spell tcg--command" : `tcg--kind-structure tcg--structure${sizeMod}`;
  const slug = signalSlug(e);
  const sigLine = dmSignalLabel(e);
  const tier = Math.max(1, e.requiredRelayTier || 1);
  const cdSec = e.chargeCooldownSeconds;
  const cdShow = cdSec > 0 ? `${cdSec}s` : "—";
  const statsLine = dmStatsOneLine(e);
  const statsTitle = isCommandEntry(e)
    ? commandSpellTooltipSummary(e as CommandCatalogEntry)
    : `${e.maxHp} HP · ${e.buildSeconds}s build · ${e.productionSeconds}s spawn · ${e.producedPop}/${e.localPopCap} pop`;
  const spellFx = cmd ? dmSpellFxCompact(e as CommandCatalogEntry) : "";
  const statsBlock = cmd
    ? `<div class="dm-stats dm-stats--spell-cost" title="${escapeHtml(statsTitle)}">${escapeHtml(dmSpellCostLine(e as CommandCatalogEntry))}</div>`
    : `<div class="dm-stats" title="${escapeHtml(statsTitle)}">${escapeHtml(statsLine)}</div>`;

  return `<div class="tcg tcg--compact tcg--layout-min doctrine-card-compact ${kindClass} ${previewTypeClass}" data-catalog-id="${escapeHtml(catalogId)}" style="--tcg-h:${hue}">
  <div class="dm-shell dm-shell--compact">
    ${deckNo}
    ${dmHeroArt(catalogId, portrait, !cmd, cmd ? (e as CommandCatalogEntry) : undefined)}
    <div class="dm-top">
      <span class="dm-mana" title="Mana (flux) cost">${escapeHtml(manaVal)}</span>
      <span class="dm-class" title="${cmd ? "Command spell" : "Produced unit class"}">${escapeHtml(classTag)}</span>
      <span class="dm-cd" title="${escapeHtml(dmCdTitle(cmd))}">${escapeHtml(cdShow)}</span>
    </div>
    <div class="dm-name" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</div>
    ${spellFx}
    ${statsBlock}
    <div class="dm-foot">
      <span class="dm-sig dm-sig--${slug}" title="Dominant signal">${escapeHtml(sigLine)}</span>
      <span class="dm-tier" title="${escapeHtml(wizardTierShort(tier))}">T${tier}</span>
    </div>
  </div>
</div>`;
}

export type TcgCardFullOpts = {
  /** Full-screen detail overlay (scales to viewport). */
  detailPop?: boolean;
};

/** Full doctrine card — blueprint layout (detail pop + any full-card surface). */
export function tcgCardFullHtml(
  catalogId: string,
  variant: TcgCardVariant,
  deckSlotIndex?: number,
  opts?: TcgCardFullOpts,
): string {
  const detailPop = opts?.detailPop === true;
  const e = getCatalogEntry(catalogId);
  if (!e) {
    return `<div class="tcg tcg--full tcg--layout-v2 tcg--unknown tcg--preview-type-unknown tcg--${variant}${detailPop ? " tcg--detail-pop" : ""}" data-catalog-id="${escapeHtml(catalogId)}" style="--tcg-h:210"><div class="dc-shell"><header class="dc-hero dc-hero--full dc-hero--empty"><div class="dc-hero-art dc-hero-art--full"><span class="dc-empty-q">?</span></div>${dcTitleBlock("Unknown", "Structure", false)}</header></div></div>`;
  }
  const hue = catalogPreviewTypeHue(e);
  const previewTypeClass = catalogPreviewTypeClass(e);
  const cmd = isCommandEntry(e);
  const sizeMod = cmd ? "" : ` tcg--size-${e.producedSizeClass}`;
  const classTag = cmd ? "Spell" : e.producedSizeClass;
  const manaVal = String(e.fluxCost);
  const svgKey = deckSlotIndex != null ? `${catalogId}_slot${deckSlotIndex}_full` : `${catalogId}_full_${variant}`;
  const portrait = catalogPortraitSvg(catalogId, hue, cmd, svgKey);
  const deckNo =
    deckSlotIndex != null
      ? `<div class="tcg-deck-no" aria-label="Deck slot ${deckSlotIndex + 1}">${deckSlotIndex + 1}</div>`
      : "";
  const kindClass = cmd ? "tcg--kind-spell tcg--command" : `tcg--kind-structure tcg--structure${sizeMod}`;
  const detailCls = detailPop ? " tcg--detail-pop" : "";
  const detailBtn = detailPop ? "" : cardDetailButton(catalogId);
  const watermark = detailPop ? "" : `<div class="dc-id-watermark">${escapeHtml(catalogId)}</div>`;
  const rail = isCommandEntry(e)
    ? dcStatRail4(
        { v: manaVal, l: "MANA", t: "mana" },
        { v: `${e.chargeCooldownSeconds}s`, l: "COOLDOWN", t: "cd" },
        { v: `${e.salvagePctOnCast}%`, l: "SALVAGE", t: "salv" },
        { v: `T${Math.max(1, e.requiredRelayTier || 1)}`, l: "TIER", t: "tier" },
        false,
      )
    : dcStatRail4(
        { v: String(e.maxHp), l: "HP", t: "hp" },
        { v: `${e.buildSeconds}s`, l: "BUILD", t: "build" },
        { v: `${e.productionSeconds}s`, l: "PROD", t: "prod" },
        {
          v: `${e.producedPop}/${e.localPopCap}`,
          l: "POP / CAP",
          t: "pop",
        },
        false,
      );
  const bodyFull = cmd
    ? `<div class="dc-body">${dcMetaSignal(e)}${dcMetaUnlock(e.requiredRelayTier)}${dcRelayRow(e)}${dcSpellEffectPanel(e as CommandCatalogEntry)}</div>`
    : `<div class="dc-body">${dcMetaSignal(e)}${dcMetaUnlock(e.requiredRelayTier)}${dcRelayRow(e)}${dcUnitPill(e as StructureCatalogEntry)}${dcAbilityStructure(e as StructureCatalogEntry)}${dcAuxStructure(e as StructureCatalogEntry)}${dcFlavor((e as StructureCatalogEntry).producedFlavor)}</div>`;

  return `<div class="tcg tcg--full tcg--layout-v2 ${kindClass} ${previewTypeClass} tcg--${variant}${detailCls}" data-catalog-id="${escapeHtml(catalogId)}" style="--tcg-h:${hue}">
  <div class="dc-shell">
    ${deckNo}
    ${detailBtn}
    <header class="dc-hero dc-hero--full">
      ${dcHeroArt(catalogId, portrait, false, !cmd, cmd ? (e as CommandCatalogEntry) : undefined)}
      <div class="dc-hero-scrim" aria-hidden="true"></div>
      <div class="dc-hero-top">
        <span class="dc-mana" title="Mana cost">${escapeHtml(manaVal)}</span>
        ${dcHeroTopTags(cmd, classTag, e.chargeCooldownSeconds)}
      </div>
      ${dcTitleBlock(e.name, cmd ? "Command" : "Structure", false)}
    </header>
    ${rail}
    ${bodyFull}
    ${watermark}
  </div>
</div>`;
}

/** Large readable card for the global detail dialog (not bound to deck slot). */
export function doctrineCardFullModalHtml(catalogId: string): string {
  return tcgCardFullHtml(catalogId, "picker", undefined, { detailPop: true });
}

/** Picker catalog + deck slots: compact only. */
export function doctrineCardLibraryHtml(catalogId: string, deckSlotIndex?: number): string {
  return tcgCardCompactHtml(catalogId, "picker", deckSlotIndex);
}

/** Legacy one-line drag chip; prefer `tcgCardCompactHtml` + `.doctrine-drag-ghost--card-face` for a full face. */
export function doctrineCardGhostSummary(catalogId: string): string {
  const e = getCatalogEntry(catalogId);
  if (!e) return `<span class="ghost-title">?</span>`;
  const hue = catalogPreviewTypeHue(e);
  const typeCls = catalogPreviewTypeClass(e);
  const tag = isCommandEntry(e) ? "Spell" : e.producedSizeClass;
  return `<div class="ghost-tcg ${typeCls}" style="--tcg-h:${hue}"><span class="ghost-tcg-mono">${escapeHtml(initials(e.name))}</span><span class="ghost-title">${escapeHtml(e.name)}</span><span class="ghost-tag">${escapeHtml(tag)}</span><span class="ghost-flux">${e.fluxCost}</span></div>`;
}

/** HUD tray slot body (compact). In-match faces omit deck index — slot is obvious from grid position. */
export function doctrineCardBody(slotIndex: number, catalogId: string | null): string {
  if (!catalogId) {
    return `<div class="tcg tcg--compact tcg--layout-min doctrine-card-compact tcg--empty" data-slot-index="${slotIndex}">
      <div class="dm-shell dm-shell--compact dm-shell--empty">
        <div class="dm-art dm-art--empty"><span class="dm-empty">—</span></div>
        <div class="dm-name dm-name--muted">Empty</div>
        <div class="dm-stats dm-stats--muted">Locked or unused</div>
      </div>
    </div>`;
  }
  return tcgCardCompactHtml(catalogId, "picker");
}
