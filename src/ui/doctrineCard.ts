import { commandEffectRadius, getCatalogEntry } from "../game/catalog";
import {
  ANTI_CLASS_DAMAGE_MULT,
  PLAYER_UNIT_STRUCTURE_DAMAGE_MULT,
  TICK_HZ,
  UNIT_ATTACK_DAMAGE_MULT,
  UNIT_AOE_SPLASH_DAMAGE_MULT,
  UNIT_LIFESTEAL_DAMAGE_FRAC,
  UNIT_TAP_ANCHOR_DAMAGE_MULT,
} from "../game/constants";
import { productionBatchSizeForClass, TRAMPLE, unitStatsForCatalog } from "../game/sim/systems/helpers";
import type {
  CatalogEntry,
  CommandCatalogEntry,
  StructureCatalogEntry,
  UnitSizeClass,
} from "../game/types";
import { isCommandEntry, isStructureEntry } from "../game/types";

function structurePopCapLine(e: StructureCatalogEntry): string {
  return `${productionBatchSizeForClass(e.producedSizeClass)} bodies`;
}

function structureProductionLine(e: StructureCatalogEntry): string {
  return `${productionBatchSizeForClass(e.producedSizeClass)}x ${e.producedSizeClass} every ${e.productionSeconds}s`;
}

function matchArmyPopBonusNote(e: StructureCatalogEntry): string {
  if (!e.matchGlobalPopCapBonus) return "";
  return `<p class="dc-note">Doctrine loadout bonus retained for army scaling; production itself is uncapped.</p>`;
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
  const payLine = `Costs ${e.fluxCost} Mana · ${e.salvagePctOnCast}% of that cost goes to Salvage · ${e.chargeCooldownSeconds}s cooldown on this slot after casting`;
  switch (fx.type) {
    case "aoe_line_damage":
      return {
        target: "Aim from your Wizard toward the enemy tide — the cut runs forward a fixed distance.",
        rolls: [
          `Corridor ${fx.length}u long × ${fx.halfWidth * 2}u wide: each enemy unit inside takes ${fx.damage} damage.`,
          "Enemy Dark Fortresses crossed by the corridor take reduced damage from this spell.",
        ],
        payLine,
      };
    case "aoe_damage":
      return {
        target: "Ground point — drag onto the map and release.",
        rolls: [
          `Ring radius ${fx.radius}: every enemy unit inside takes ${fx.damage} damage.`,
          "Enemy Dark Fortresses touched by the ring take half that damage from this spell.",
        ],
        payLine,
      };
    case "aoe_tactics_field":
      return {
        target: "Ground zone — drag onto the map and release.",
        rolls: [
          `For ${fx.durationSeconds}s, radius ${fx.radius}: player units and your Wizard move faster (${fx.allySpeedMult}×) and deal more damage (${fx.allyDamageMult}×).`,
          `Enemies inside move slower (${fx.enemySpeedMult}×), deal less damage (${fx.enemyDamageMult}×), and take more (${fx.enemyIncomingDamageMult}× incoming).`,
        ],
        payLine,
      };
    case "aoe_shatter_chain":
      return {
        target: `Ground point — first hit picks the nearest hostile within ${fx.castRadius}u of the drop.`,
        rolls: [
          `Up to ${fx.maxTargets} strikes (first in the cast ring, then up to ${fx.maxTargets - 1} chain jumps up to ${fx.chainRange}u): fortresses, towers, and troops.`,
          `Primary damage ${fx.damage} (each hop multiplies by ${fx.chainDamageFalloff}); Dark Fortresses silenced ${fx.silenceSeconds}s with splash silence on nearby enemy towers.`,
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
  return `${e.fluxCost} Mana · ${e.chargeCooldownSeconds}s cooldown · ${e.salvagePctOnCast}% to Salvage`;
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

function compactNumber(n: number, digits = 1): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(digits).replace(/\.0$/, "");
}

function multiplier(n: number): string {
  return `${compactNumber(n, 2)}x`;
}

function bonusPct(mult: number): string {
  return `+${Math.round((mult - 1) * 100)}%`;
}

function trampleText(sizeClass: UnitSizeClass): string | null {
  const table = TRAMPLE[sizeClass];
  const parts = (Object.keys(table) as UnitSizeClass[])
    .map((target) => {
      const mult = table[target];
      return mult ? `${multiplier(mult)} vs ${target}` : "";
    })
    .filter(Boolean);
  return parts.length ? parts.join(" / ") : null;
}

function antiClassList(e: StructureCatalogEntry): UnitSizeClass[] {
  if (e.producedAntiClasses?.length) return e.producedAntiClasses;
  return e.producedAntiClass ? [e.producedAntiClass] : [];
}

function dcCombatProfile(e: StructureCatalogEntry): string {
  const st = unitStatsForCatalog(e.producedSizeClass);
  const dps = st.dmgPerTick * TICK_HZ * (UNIT_ATTACK_DAMAGE_MULT[e.producedSizeClass] ?? 1);
  const objectiveMult = e.producedDamageVsStructuresMult ?? 1;
  const trample = trampleText(e.producedSizeClass);
  const anti = antiClassList(e);
  const chips = [
    anti.length ? `Anti-${anti.join(" / ")} ${bonusPct(ANTI_CLASS_DAMAGE_MULT)}` : "No anti-class",
    trample ? `Trample ${trample}` : "No trample",
    `Objectives ${multiplier(PLAYER_UNIT_STRUCTURE_DAMAGE_MULT * objectiveMult)} structures / ${multiplier(
      UNIT_TAP_ANCHOR_DAMAGE_MULT * objectiveMult,
    )} anchors`,
  ];
  if (e.unitTrait === "lifesteal") {
    chips.push(`Lifesteal ${Math.round(UNIT_LIFESTEAL_DAMAGE_FRAC * 100)}% dealt`);
  }
  if (e.unitAoeRadius) {
    chips.push(`AoE r${compactNumber(e.unitAoeRadius)} splash ${Math.round(UNIT_AOE_SPLASH_DAMAGE_MULT * 100)}%`);
  }
  if (e.unitFlying) chips.push("Flying pathing");

  const cell = (value: string, label: string, mod: string) =>
    `<div class="dc-combat-cell dc-combat-cell--${mod}"><span>${escapeHtml(value)}</span><small>${escapeHtml(label)}</small></div>`;
  const chipHtml = chips.map((chip) => `<span class="dc-combat-chip">${escapeHtml(chip)}</span>`).join("");
  return `<section class="dc-combat-profile" aria-label="Produced unit combat profile">
    <div class="dc-combat-head">
      <span class="dc-combat-title">Combat Profile</span>
      <span class="dc-combat-note">${escapeHtml(e.producedSizeClass)} unit</span>
    </div>
    <div class="dc-combat-grid">
      ${cell(String(st.maxHp), "Unit HP", "hp")}
      ${cell(`${compactNumber(st.range)}u`, "Range", "range")}
      ${cell(`${compactNumber(st.speedPerSec)}u/s`, "Speed", "speed")}
      ${cell(compactNumber(dps), "Sustained DPS", "dps")}
    </div>
    <div class="dc-combat-chips">${chipHtml}</div>
  </section>`;
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

const DC_ICON_SWORDS = `<span class="dc-ico dc-ico--txt" aria-hidden="true">⚔</span>`;

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
  if (fx.type === "aoe_shatter_chain") return "0.78";
  if (fx.type === "aoe_tactics_field") return "0.72";
  if (fx.type === "aoe_line_damage") return "0.88";
  if (fx.type === "noop") return "0.55";
  return "0.65";
}

function spellGhostClass(e: CommandCatalogEntry): string {
  switch (e.effect.type) {
    case "aoe_damage":
      return "spell-card-viz__ghost--firestorm";
    case "aoe_tactics_field":
      return "spell-card-viz__ghost--fortify";
    case "aoe_shatter_chain":
      return "spell-card-viz__ghost--shatter";
    case "aoe_line_damage":
      return "spell-card-viz__ghost--cut_line";
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

function spellSlashRibbons(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`<span class="spell-card-viz__slash" style="--slash-i:${i}"></span>`);
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
  } else if (fxType === "aoe_shatter_chain") {
    aoeDecor = `<div class="spell-card-viz__cracks" aria-hidden="true">${spellAoeCrackLines(6)}</div>`;
  }
  let ghostDecor = "";
  if (fxType === "aoe_line_damage") {
    ghostDecor = `<div class="spell-card-viz__slash-ribbons" aria-hidden="true">${spellSlashRibbons(5)}</div>`;
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
  usePreview: boolean,
  spell?: CommandCatalogEntry,
): string {
  const mod = compact ? "dc-hero-art--compact" : "dc-hero-art--full";
  const img = usePreview
    ? `<img class="tcg-card-preview-img" data-catalog-preview="${escapeHtml(catalogId)}" alt="" decoding="async" hidden />`
    : "";
  if (spell) {
    return `<div class="dc-hero-art dc-hero-art--spell ${mod}">
      ${img}
      ${spellPortraitStack(portrait, spell)}
    </div>`;
  }
  const fbMod = usePreview ? "" : " tcg-portrait-fallback--solo";
  return `<div class="dc-hero-art ${mod}">
    ${img}
    <div class="tcg-portrait-fallback${fbMod}">${portrait}</div>
  </div>`;
}

/** Compact face art — spells show AoE + ghost cast preview (structures may use GLB raster). */
function dmHeroArt(catalogId: string, portrait: string, usePreview: boolean, spell?: CommandCatalogEntry): string {
  const img = usePreview
    ? `<img class="tcg-card-preview-img" data-catalog-preview="${escapeHtml(catalogId)}" alt="" decoding="async" hidden />`
    : "";
  if (spell) {
    return `<div class="dm-art dm-art--spell">
      ${img}
      ${spellPortraitStack(portrait, spell)}
    </div>`;
  }
  const fbMod = usePreview ? "" : " tcg-portrait-fallback--solo";
  return `<div class="dm-art">
    ${img}
    <div class="tcg-portrait-fallback${fbMod}">${portrait}</div>
  </div>`;
}

function dmCdTitle(cmd: boolean): string {
  return cmd ? "Per-use cooldown after casting this spell" : "Cooldown between spawned units";
}

function dmStatsOneLine(e: CatalogEntry): string {
  if (isCommandEntry(e)) {
    return `${e.fluxCost} · ${e.chargeCooldownSeconds}s · ${e.salvagePctOnCast}%`;
  }
  return `${e.maxHp} HP · ${e.buildSeconds}s build · ${structureProductionLine(e)}`;
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

type DcStatTone = "hp" | "build" | "prod" | "pop" | "mana" | "cd" | "salv" | "uses";

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

function dcUnitPill(e: StructureCatalogEntry): string {
  const tags = flavorTraitTags(e);
  const tagHtml = tags.map((t) => `<span class="dc-unit-tag">${escapeHtml(t)}</span>`).join("");
  return `<div class="dc-unit-pill">
    <div class="dc-unit-pill-left"><span class="dc-unit-ico" aria-hidden="true">${DC_ICON_SWORDS}</span><span class="dc-unit-name">${escapeHtml(unitPillTitle(e))}</span></div>
    <div class="dc-unit-tags">${tagHtml}</div>
  </div>`;
}

function dcAbilityStructure(e: StructureCatalogEntry): string {
  const anti = antiClassList(e);
  if (e.chargeCooldownSeconds <= 0 && anti.length === 0) return "";
  const title = anti.length ? `Anti ${anti.join(" / ")}` : "Unit ability";
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
  const lines: string[] = [];
  if (a) lines.push(a);
  if (t) lines.push(t);
  const body = lines.map((line) => `<div>${escapeHtml(line)}</div>`).join("");
  return `<div class="dc-passive" role="group" aria-label="Passive structure effects">
    <div class="dc-passive-ico" aria-hidden="true">▣</div>
    <div class="dc-passive-mid">
      <div class="dc-passive-title">Structure Upkeep</div>
      <div class="dc-passive-lines">${body}</div>
    </div>
    <div class="dc-passive-right">Passive</div>
  </div>`;
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
  const cdSec = e.chargeCooldownSeconds;
  const cdShow = cdSec > 0 ? `${cdSec}s` : "—";
  const statsLine = dmStatsOneLine(e);
  const statsTitle = isCommandEntry(e)
    ? commandSpellTooltipSummary(e as CommandCatalogEntry)
    : `${e.maxHp} HP · ${e.buildSeconds}s build · ${structureProductionLine(e)} · ${structurePopCapLine(e)} per event`;
  const spellFx = cmd ? dmSpellFxCompact(e as CommandCatalogEntry) : "";
  const statsBlock = cmd
    ? `<div class="dm-stats dm-stats--spell-cost" title="${escapeHtml(statsTitle)}">${escapeHtml(dmSpellCostLine(e as CommandCatalogEntry))}</div>`
    : `<div class="dm-stats" title="${escapeHtml(statsTitle)}">${escapeHtml(statsLine)}</div>`;

  return `<div class="tcg tcg--compact tcg--layout-min doctrine-card-compact ${kindClass} ${previewTypeClass}" data-catalog-id="${escapeHtml(catalogId)}" style="--tcg-h:${hue}">
  <div class="dm-shell dm-shell--compact">
    ${deckNo}
    ${dmHeroArt(catalogId, portrait, true, cmd ? (e as CommandCatalogEntry) : undefined)}
    <div class="dm-top">
      <span class="dm-mana" title="Mana (flux) cost">${escapeHtml(manaVal)}</span>
      <span class="dm-class" title="${cmd ? "Command spell" : "Produced unit class"}">${escapeHtml(classTag)}</span>
      <span class="dm-cd" title="${escapeHtml(dmCdTitle(cmd))}">${escapeHtml(cdShow)}</span>
    </div>
    <div class="dm-name" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</div>
    ${spellFx}
    ${statsBlock}
    <div class="dm-foot">
      <span class="dm-sig" title="Resource gate">${escapeHtml(cmd ? "Mana spell" : structureProductionLine(e as StructureCatalogEntry))}</span>
      <span class="dm-zone" title="${cmd ? "Cast with Mana" : "Build inside territory"}">${cmd ? "Cast" : "Zone"}</span>
    </div>
  </div>
</div>`;
}

type SlotBadgeTone = "hp" | "build" | "prod" | "batch" | "mana" | "cd" | "salv" | "uses" | "effect";

function slotInfoBadge(value: string, label: string, tone: SlotBadgeTone, title?: string): string {
  const tip = title ? ` title="${escapeHtml(title)}"` : "";
  return `<span class="slot-card-stat slot-card-stat--${tone}"${tip}><b>${escapeHtml(value)}</b><small>${escapeHtml(label)}</small></span>`;
}

function commandSlotEffectLabel(e: CommandCatalogEntry): string {
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

function slotCardStatBadges(e: CatalogEntry): string {
  if (isCommandEntry(e)) {
    return [
      slotInfoBadge(`${e.chargeCooldownSeconds}s`, "CD", "cd", "Per-slot cooldown after casting"),
      slotInfoBadge(`${e.salvagePctOnCast}%`, "SALV", "salv", "Mana cost converted into Salvage"),
      slotInfoBadge(String(e.maxCharges), "USES", "uses", "Per-match uses before long cooldown"),
      slotInfoBadge(commandSlotEffectLabel(e), "FX", "effect", commandSpellTooltipSummary(e)),
    ].join("");
  }
  return [
    slotInfoBadge(String(e.maxHp), "HP", "hp", "Structure health"),
    slotInfoBadge(`${e.buildSeconds}s`, "BUILD", "build", "Build time"),
    slotInfoBadge(`${e.productionSeconds}s`, "PROD", "prod", "Production cadence"),
    slotInfoBadge(structurePopCapLine(e), "BATCH", "batch", structureProductionLine(e)),
  ].join("");
}

/** Full-preview doctrine face for clickable hand slots: art first, rules reduced to overlaid stat badges. */
export function tcgCardSlotHtml(catalogId: string, variant: TcgCardVariant, deckSlotIndex?: number): string {
  const e = getCatalogEntry(catalogId);
  if (!e) {
    return `<div class="tcg tcg--compact tcg--slot-preview doctrine-card-compact tcg--unknown tcg--preview-type-unknown" data-catalog-id="${escapeHtml(catalogId)}" style="--tcg-h:210"><div class="slot-card-shell"><div class="slot-card-art slot-card-art--empty"><span class="dm-empty">?</span></div><div class="slot-card-title">Unknown</div></div></div>`;
  }
  const hue = catalogPreviewTypeHue(e);
  const previewTypeClass = catalogPreviewTypeClass(e);
  const cmd = isCommandEntry(e);
  const sizeClass = cmd ? "" : e.producedSizeClass;
  const sizeMod = cmd ? "" : ` tcg--size-${sizeClass}`;
  const classTag = cmd ? "Spell" : e.producedSizeClass;
  const manaVal = String(e.fluxCost);
  const svgKey = deckSlotIndex != null ? `${catalogId}_slot${deckSlotIndex}_hand` : `${catalogId}_${variant}_hand`;
  const portrait = catalogPortraitSvg(catalogId, hue, cmd, svgKey);
  const kindClass = cmd ? "tcg--kind-spell tcg--command" : `tcg--kind-structure tcg--structure${sizeMod}`;
  const cdSec = e.chargeCooldownSeconds;
  const cdShow = cdSec > 0 ? `${cdSec}s` : "—";
  const art = dmHeroArt(catalogId, portrait, true, cmd ? e : undefined);
  const subtitle = cmd ? commandSlotEffectLabel(e) : structureProductionLine(e);
  const title = cmd ? commandSpellTooltipSummary(e) : `${e.maxHp} HP · ${e.buildSeconds}s build · ${structureProductionLine(e)}`;

  return `<div class="tcg tcg--compact tcg--slot-preview doctrine-card-compact ${kindClass} ${previewTypeClass} tcg--${variant}" data-catalog-id="${escapeHtml(catalogId)}" style="--tcg-h:${hue}">
  <div class="slot-card-shell" title="${escapeHtml(title)}">
    <div class="slot-card-art">
      ${art}
      <div class="slot-card-scrim" aria-hidden="true"></div>
      <span class="slot-card-mana" title="Mana cost">${escapeHtml(manaVal)}</span>
      <span class="slot-card-type" title="${cmd ? "Command spell" : "Produced unit class"}">${escapeHtml(classTag)}</span>
      <span class="slot-card-cd" title="${escapeHtml(dmCdTitle(cmd))}">${escapeHtml(cdShow)}</span>
      <div class="slot-card-stats" aria-label="Key card stats">${slotCardStatBadges(e)}</div>
    </div>
    <div class="slot-card-title" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</div>
    <div class="slot-card-subtitle" title="${escapeHtml(subtitle)}">${escapeHtml(subtitle)}</div>
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
        { v: `${e.maxCharges}`, l: "USES", t: "uses" },
        false,
      )
    : dcStatRail4(
        { v: String(e.maxHp), l: "HP", t: "hp" },
        { v: `${e.buildSeconds}s`, l: "BUILD", t: "build" },
        { v: `${e.productionSeconds}s`, l: "PROD", t: "prod" },
        {
          v: structurePopCapLine(e as StructureCatalogEntry),
          l: "BATCH",
          t: "pop",
        },
        false,
      );
  const bodyFull = cmd
    ? `<div class="dc-body">${dcSpellEffectPanel(e as CommandCatalogEntry)}</div>`
    : `<div class="dc-body">${dcUnitPill(e as StructureCatalogEntry)}${dcCombatProfile(e as StructureCatalogEntry)}${dcAbilityStructure(e as StructureCatalogEntry)}${dcAuxStructure(e as StructureCatalogEntry)}${matchArmyPopBonusNote(e as StructureCatalogEntry)}${dcFlavor((e as StructureCatalogEntry).producedFlavor)}</div>`;

  return `<div class="tcg tcg--full tcg--layout-v2 ${kindClass} ${previewTypeClass} tcg--${variant}${detailCls}" data-catalog-id="${escapeHtml(catalogId)}" style="--tcg-h:${hue}">
  <div class="dc-shell">
    ${deckNo}
    ${detailBtn}
    <header class="dc-hero dc-hero--full">
      ${dcHeroArt(catalogId, portrait, false, true, cmd ? (e as CommandCatalogEntry) : undefined)}
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

/** HUD / picker tray slot body. Slot faces omit deck index — the hotkey badge supplies position. */
export function doctrineCardBody(
  slotIndex: number,
  catalogId: string | null,
  variant: TcgCardVariant = "hud",
): string {
  if (!catalogId) {
    return `<div class="tcg tcg--compact tcg--slot-preview doctrine-card-compact tcg--empty" data-slot-index="${slotIndex}">
      <div class="slot-card-shell slot-card-shell--empty">
        <div class="slot-card-art slot-card-art--empty"><span class="dm-empty">—</span></div>
        <div class="slot-card-title slot-card-title--muted">Empty</div>
        <div class="slot-card-subtitle slot-card-subtitle--muted">Locked or unused</div>
      </div>
    </div>`;
  }
  return tcgCardSlotHtml(catalogId, variant, slotIndex);
}

export function doctrineSlotButtonInnerHtml(
  slotIndex: number,
  catalogId: string | null,
  opts?: {
    variant?: TcgCardVariant;
    liveIdPrefix?: string;
  },
): string {
  const hotkey = slotIndex === 9 ? "0" : String(slotIndex + 1);
  const livePrefix = opts?.liveIdPrefix ?? "slot-live";
  return `<span class="slot-hotkey">${hotkey}</span>${doctrineCardBody(slotIndex, catalogId, opts?.variant ?? "hud")}<div class="slot-live" id="${escapeHtml(livePrefix)}-${slotIndex}"></div>`;
}
