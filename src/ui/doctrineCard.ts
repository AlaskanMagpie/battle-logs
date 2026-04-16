import { getCatalogEntry } from "../game/catalog";
import type { CatalogEntry, CommandCatalogEntry, SignalCountRequirement, StructureCatalogEntry } from "../game/types";
import { isCommandEntry } from "../game/types";

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
  switch (e.effect.type) {
    case "recycle_structure":
      return "Click your structure → scrap + Salvage";
    case "fortify_structure":
      return "Friendly presence + click structure → 15s damage reduction";
    case "firestorm_aoe":
      return "Friendly presence + ground → AoE burn on hostiles";
    case "muster_production":
      return "Friendly presence + click structure → instant production pulse";
    case "shatter_enemy":
      return "Friendly presence + ground → heavy hit on nearest enemy Relay";
    default:
      return "Flux → Salvage (no extra effect)";
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Stable hue 0–359 for card frame / art gradients. */
export function catalogCardHue(catalogId: string): number {
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

function rulesRowsStructureFull(e: StructureCatalogEntry): string {
  const sig = signalReqLine(e);
  const anti = e.producedAntiClass ? `Anti ${e.producedAntiClass}` : "Anti —";
  const ch = `⚡${e.maxCharges} · CD ${e.chargeCooldownSeconds}s`;
  const dpt = e.damagePerTick > 0 ? `${e.damagePerTick}/tick` : "0";
  return [
    `<p class="tcg-rule"><span class="tcg-rule-label">Flux</span> ${e.fluxCost} to place</p>`,
    `<p class="tcg-rule"><span class="tcg-rule-label">Build</span> ${e.buildSeconds}s · <span class="tcg-rule-label">Prod</span> ${e.productionSeconds}s</p>`,
    `<p class="tcg-rule"><span class="tcg-rule-label">HP</span> ${e.maxHp} · <span class="tcg-rule-label">Dmg</span> ${dpt}</p>`,
    `<p class="tcg-rule">${escapeHtml(sig)}</p>`,
    `<p class="tcg-rule"><span class="tcg-rule-label">Signals</span> ${escapeHtml(signalTypesLine(e))}</p>`,
    `<p class="tcg-rule"><span class="tcg-rule-label">Unit</span> ${e.producedSizeClass} · pop ${e.producedPop} · cap ${e.localPopCap}</p>`,
    `<p class="tcg-rule">${escapeHtml(anti)} · ${ch}</p>`,
  ].join("");
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
  const v = Math.abs(catalogId.split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % 3;
  const shapes =
    v === 0
      ? `<rect x="22" y="18" width="36" height="62" rx="4" fill="rgba(0,0,0,0.35)"/><rect x="24" y="16" width="32" height="64" rx="3" fill="rgba(255,255,255,0.1)"/><rect x="34" y="8" width="12" height="14" rx="2" fill="rgba(255,255,255,0.08)"/>`
      : v === 1
        ? `<path fill="rgba(0,0,0,0.35)" d="M40 10 L68 30 L60 78 L20 78 L12 30 Z"/><path fill="rgba(255,255,255,0.1)" d="M40 14 L62 30 L56 74 L24 74 L18 30 Z"/>`
        : `<rect x="14" y="38" width="20" height="42" rx="3" fill="rgba(0,0,0,0.32)"/><rect x="46" y="28" width="20" height="52" rx="3" fill="rgba(0,0,0,0.32)"/><rect x="30" y="20" width="20" height="60" rx="3" fill="rgba(255,255,255,0.09)"/>`;
  return `<svg class="tcg-portrait-svg" viewBox="0 0 80 96" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <linearGradient id="${gid}" x1="0%" y1="0%" x2="80%" y2="100%">
        <stop offset="0%" stop-color="hsl(${hue}, 48%, 36%)"/>
        <stop offset="100%" stop-color="hsl(${hue + 48}, 26%, 11%)"/>
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
