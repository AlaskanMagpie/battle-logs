import { getCatalogEntry } from "../game/catalog";
import type { CatalogEntry, CommandCatalogEntry, SignalCountRequirement, SignalType, StructureCatalogEntry } from "../game/types";
import { isCommandEntry, isStructureEntry } from "../game/types";

function signalHue(sig: SignalType | undefined): number {
  switch (sig) {
    case "Vanguard":
      return 22;
    case "Bastion":
      return 212;
    case "Reclaim":
      return 142;
    default:
      return 212;
  }
}

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

function signalReqLine(e: { requiredRelayTier: number; requiredSignalCounts?: SignalCountRequirement }): string {
  const bits: string[] = [`R≥${e.requiredRelayTier}`];
  const rc = e.requiredSignalCounts;
  if (rc) {
    for (const k of ["Vanguard", "Bastion", "Reclaim"] as const) {
      const n = rc[k];
      if (n && n > 0) bits.push(`${n}×${k.slice(0, 3)}`);
    }
  }
  return bits.join(" ");
}

function commandEffectLine(e: CommandCatalogEntry): string {
  const fx = e.effect;
  switch (fx.type) {
    case "recycle_structure":
      return "Click your structure → scrap + Salvage";
    case "aoe_damage":
      return `AoE ${fx.damage} dmg (radius ${fx.radius}) near friendlies`;
    case "buff_structure":
      return `Target structure: ${fx.damageReductionPct}% DR for ${fx.durationSeconds}s`;
    case "muster_structure":
      return "Target structure: produce next unit instantly";
    case "shatter_structure":
      return `Enemy Relay: ${fx.damage} dmg + ${fx.silenceSeconds}s silence`;
    case "noop":
      return "Stub — Flux becomes Salvage";
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Hue derived from the card's dominant Signal (Vanguard / Bastion / Reclaim) so
 * frame + art palette match the 3D silhouette. Falls back to a stable per-id
 * hue for odd cases (empty signals, unknown).
 */
export function catalogCardHue(catalogId: string): number {
  const e = getCatalogEntry(catalogId);
  if (e) {
    const dom = dominantSignalFromEntry(e);
    if (dom) return signalHue(dom);
  }
  let h = 2166136261 >>> 0;
  for (let i = 0; i < catalogId.length; i++) h = Math.imul(h ^ catalogId.charCodeAt(i), 16777619) >>> 0;
  return h % 360;
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function signalEdgePips(e: CatalogEntry): string {
  const rc = e.requiredSignalCounts;
  if (!rc) return "";
  const pips: string[] = [];
  for (const k of ["Vanguard", "Bastion", "Reclaim"] as const) {
    const n = rc[k] ?? 0;
    for (let i = 0; i < n; i++) pips.push(`<span class="tcg-sig-pip" title="${k}">${k[0]}</span>`);
  }
  if (pips.length === 0) return "";
  return `<div class="tcg-sig-edge" aria-hidden="true">${pips.join("")}</div>`;
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
  else if (e.unitTrait === "anti_building") bits.push("Unit: +50% vs buildings");
  if (e.unitAoeRadius) bits.push(`Unit: AoE r${e.unitAoeRadius}`);
  if (e.unitFlying) bits.push("Unit: flying");
  if (e.salvageRefundFrac && e.salvageRefundFrac > 0.8) {
    bits.push(`Refund ${Math.round(e.salvageRefundFrac * 100)}% on death`);
  }
  return bits.length ? bits.join(" · ") : null;
}

function rulesRowsStructureFull(e: StructureCatalogEntry): string {
  const sig = signalReqLine(e);
  const anti = e.producedAntiClass ? `Anti ${e.producedAntiClass}` : "Anti —";
  const ch = `⚡${e.maxCharges} · CD ${e.chargeCooldownSeconds}s`;
  const aura = auraLabel(e);
  const trait = traitLabel(e);
  const rows = [
    `<p class="tcg-rule"><span class="tcg-rule-label">Flux</span> ${e.fluxCost} to place</p>`,
    `<p class="tcg-rule"><span class="tcg-rule-label">Build</span> ${e.buildSeconds}s · <span class="tcg-rule-label">Prod</span> ${e.productionSeconds}s</p>`,
    `<p class="tcg-rule"><span class="tcg-rule-label">HP</span> ${e.maxHp}</p>`,
    `<p class="tcg-rule">${escapeHtml(sig)}</p>`,
    `<p class="tcg-rule"><span class="tcg-rule-label">Signals</span> ${escapeHtml(signalTypesLine(e))}</p>`,
    `<p class="tcg-rule"><span class="tcg-rule-label">Unit</span> ${e.producedSizeClass} · pop ${e.producedPop} · cap ${e.localPopCap}</p>`,
    `<p class="tcg-rule">${escapeHtml(anti)} · ${ch}</p>`,
  ];
  if (aura) rows.push(`<p class="tcg-rule"><span class="tcg-rule-label">Aura</span> ${escapeHtml(aura)}</p>`);
  if (trait) rows.push(`<p class="tcg-rule"><span class="tcg-rule-label">Traits</span> ${escapeHtml(trait)}</p>`);
  if (e.producedFlavor) rows.push(`<p class="tcg-rule"><em>${escapeHtml(e.producedFlavor)}</em></p>`);
  return rows.join("");
}

function rulesRowsCommandFull(e: CommandCatalogEntry): string {
  const sig = signalReqLine(e);
  const ch = `⚡${e.maxCharges} · CD ${e.chargeCooldownSeconds}s`;
  const eff = e.effect.type;
  return [
    `<p class="tcg-rule"><span class="tcg-rule-label">Cost</span> ${e.fluxCost} Flux → ${e.salvagePctOnCast}% Salvage</p>`,
    `<p class="tcg-rule">${escapeHtml(sig)}</p>`,
    `<p class="tcg-rule"><span class="tcg-rule-label">Signals</span> ${escapeHtml(signalTypesLine(e))}</p>`,
    `<p class="tcg-rule"><span class="tcg-rule-label">Effect</span> ${escapeHtml(eff)}</p>`,
    `<p class="tcg-rule">${escapeHtml(commandEffectLine(e))}</p>`,
    `<p class="tcg-rule">${ch}</p>`,
  ].join("");
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

export type TcgCardVariant = "hud" | "picker";

/** Compact face: portrait, name, class line, corner costs only (no full rules). */
export function tcgCardCompactHtml(catalogId: string, variant: TcgCardVariant, deckSlotIndex?: number): string {
  const e = getCatalogEntry(catalogId);
  if (!e) {
    return `<div class="tcg tcg--compact doctrine-card-compact tcg--unknown" data-catalog-id="${escapeHtml(catalogId)}"><div class="tcg-frame"><div class="tcg-art tcg-art--empty"><span>?</span></div><div class="tcg-title-band"><span class="tcg-name">Unknown</span></div><div class="tcg-class-line">—</div></div></div>`;
  }
  const hue = catalogCardHue(catalogId);
  const cmd = isCommandEntry(e);
  const classLine = cmd ? "Command" : e.producedSizeClass;
  const pipTl = `R${e.requiredRelayTier}`;
  const pipTr = String(e.fluxCost);
  const pipBl = `⚡${e.maxCharges}`;
  const pipBr = `${e.chargeCooldownSeconds}s`;
  const svgKey = deckSlotIndex != null ? `${catalogId}_slot${deckSlotIndex}` : `${catalogId}_${variant}`;
  const portrait = catalogPortraitSvg(catalogId, hue, cmd, svgKey);
  const deckNo =
    deckSlotIndex != null
      ? `<div class="tcg-deck-no" aria-label="Deck slot ${deckSlotIndex + 1}">${deckSlotIndex + 1}</div>`
      : "";

  return `<div class="tcg tcg--compact doctrine-card-compact ${cmd ? "tcg--command" : "tcg--structure"}" data-catalog-id="${escapeHtml(catalogId)}" style="--tcg-h:${hue}">
  <div class="tcg-frame">
    ${deckNo}
    <div class="tcg-pip tcg-pip-tl" title="Relay tier">${escapeHtml(pipTl)}</div>
    <div class="tcg-pip tcg-pip-tr" title="Flux cost">${escapeHtml(pipTr)}</div>
    <div class="tcg-pip tcg-pip-bl" title="Charges per match">${escapeHtml(pipBl)}</div>
    <div class="tcg-pip tcg-pip-br" title="Charge cooldown">${escapeHtml(pipBr)}</div>
    <div class="tcg-art tcg-art--portrait">${portrait}</div>
    <div class="tcg-title-band">
      <span class="tcg-name">${escapeHtml(e.name)}</span>
    </div>
    <div class="tcg-class-line">${escapeHtml(classLine)}</div>
  </div>
</div>`;
}

/** Full rules text, type line, watermark — use only in the long-press detail popover (or internal tooling). */
export function tcgCardFullHtml(catalogId: string, variant: TcgCardVariant, deckSlotIndex?: number): string {
  const e = getCatalogEntry(catalogId);
  if (!e) {
    return `<div class="tcg tcg--full tcg--unknown tcg--${variant}" data-catalog-id="${escapeHtml(catalogId)}"><div class="tcg-frame"><div class="tcg-art tcg-art--empty"><span>?</span></div><div class="tcg-title-band"><span class="tcg-name">Unknown</span></div><div class="tcg-type-line">—</div><div class="tcg-rules"></div></div></div>`;
  }
  const hue = catalogCardHue(catalogId);
  const cmd = isCommandEntry(e);
  const artLine = cmd ? "Command" : e.producedSizeClass;
  const pipTl = `R${e.requiredRelayTier}`;
  const pipTr = String(e.fluxCost);
  const pipBl = `⚡${e.maxCharges}`;
  const pipBr = `${e.chargeCooldownSeconds}s`;
  const typeLine = cmd ? "Doctrine — Command" : "Doctrine — Structure";
  const rules = cmd ? rulesRowsCommandFull(e) : rulesRowsStructureFull(e as StructureCatalogEntry);
  const sigEdge = signalEdgePips(e);
  const svgKey = deckSlotIndex != null ? `${catalogId}_slot${deckSlotIndex}_full` : `${catalogId}_full_${variant}`;
  const portrait = catalogPortraitSvg(catalogId, hue, cmd, svgKey);

  const artExtra = !cmd
    ? `<span class="tcg-art-meta">${e.producedPop} pop · cap ${e.localPopCap}</span>`
    : `<span class="tcg-art-meta">${e.salvagePctOnCast}% to Salvage</span>`;

  const deckNo =
    deckSlotIndex != null
      ? `<div class="tcg-deck-no" aria-label="Deck slot ${deckSlotIndex + 1}">${deckSlotIndex + 1}</div>`
      : "";

  return `<div class="tcg tcg--full ${cmd ? "tcg--command" : "tcg--structure"} tcg--${variant}" data-catalog-id="${escapeHtml(catalogId)}" style="--tcg-h:${hue}">
  <div class="tcg-frame">
    ${deckNo}
    ${sigEdge}
    <div class="tcg-pip tcg-pip-tl" title="Relay tier">${escapeHtml(pipTl)}</div>
    <div class="tcg-pip tcg-pip-tr" title="Flux cost">${escapeHtml(pipTr)}</div>
    <div class="tcg-pip tcg-pip-bl" title="Charges per match">${escapeHtml(pipBl)}</div>
    <div class="tcg-pip tcg-pip-br" title="Charge cooldown">${escapeHtml(pipBr)}</div>
    <div class="tcg-art tcg-art--portrait tcg-art--full-bleed">
      ${portrait}
      <span class="tcg-art-mono tcg-art-mono--overlay" aria-hidden="true">${escapeHtml(initials(e.name))}</span>
      <span class="tcg-art-line tcg-art-line--overlay">${escapeHtml(artLine)}</span>
      ${artExtra}
    </div>
    <div class="tcg-title-band">
      <span class="tcg-name">${escapeHtml(e.name)}</span>
    </div>
    <div class="tcg-type-line">${typeLine}</div>
    <div class="tcg-rules">${rules}</div>
    <div class="tcg-id-watermark">${escapeHtml(catalogId)}</div>
  </div>
</div>`;
}

/** Large readable card for the global detail dialog (not bound to deck slot). */
export function doctrineCardFullModalHtml(catalogId: string): string {
  return tcgCardFullHtml(catalogId, "picker").replace(
    /class="tcg tcg--full/g,
    'class="tcg tcg--full tcg--detail-pop',
  );
}

/** Picker catalog + deck slots: compact only. */
export function doctrineCardLibraryHtml(catalogId: string, deckSlotIndex?: number): string {
  return tcgCardCompactHtml(catalogId, "picker", deckSlotIndex);
}

/** Compact floating label while dragging to the map. */
export function doctrineCardGhostSummary(catalogId: string): string {
  const e = getCatalogEntry(catalogId);
  if (!e) return `<span class="ghost-title">?</span>`;
  const hue = catalogCardHue(catalogId);
  const tag = isCommandEntry(e) ? "CMD" : "STR";
  return `<div class="ghost-tcg" style="--tcg-h:${hue}"><span class="ghost-tcg-mono">${escapeHtml(initials(e.name))}</span><span class="ghost-title">${escapeHtml(e.name)}</span><span class="ghost-tag">${tag}</span><span class="ghost-flux">${e.fluxCost}</span></div>`;
}

/** HUD tray slot body (compact). */
export function doctrineCardBody(slotIndex: number, catalogId: string | null): string {
  if (!catalogId) {
    return `<div class="tcg tcg--compact doctrine-card-compact tcg--empty">
      <div class="tcg-frame">
        <div class="tcg-pip tcg-pip-tr tcg-pip--muted">${slotIndex + 1}</div>
        <div class="tcg-art tcg-art--empty"><span class="tcg-art-mono">—</span><span class="tcg-art-line">Empty slot</span></div>
        <div class="tcg-title-band"><span class="tcg-name">No card</span></div>
        <div class="tcg-class-line">Deck</div>
      </div>
    </div>`;
  }
  return tcgCardCompactHtml(catalogId, "picker", slotIndex);
}
