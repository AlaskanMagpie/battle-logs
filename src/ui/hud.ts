import { getCatalogEntry } from "../game/catalog";
import {
  DOCTRINE_SLOT_COUNT,
  MATCH_DURATION_TICKS,
  SALVAGE_FLUX_CAP_PER_SEC,
  SALVAGE_FLUX_PER_POOL_PER_SEC,
  TAP_FLUX_PER_SEC,
  TICK_HZ,
} from "../game/constants";
import type { PlayerIntent } from "../game/intents";
import { readLocalLeaderboard, scoreMatchResult } from "../game/leaderboard";
import { formatMatchDurationFromTicks, simSecondsFromMatchTick } from "../game/matchDisplay";
import {
  claimedTapCount,
  doctrineCardPlayability,
  findKeep,
  heroTeleportCooldownSeconds,
  totalPlayerPop,
  type GameState,
} from "../game/state";
import { isStructureEntry } from "../game/types";
import {
  showDoctrineCardDetail,
} from "./cardDetailPop";
import type { ControlProfile } from "../controlProfile";
import { hydrateCardPreviewImages } from "./cardGlbPreview";
import { doctrineSlotButtonInnerHtml } from "./doctrineCard";
import { tapYieldMultForOwner } from "../game/sim/systems/homeDistance";

const HAND_ACTIVE_LIFT = 5;

function escapeHudHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function playerManaIncomePerSec(state: GameState): number {
  let perSec = 0;
  for (const t of state.taps) {
    if (!t.active || t.ownerTeam !== "player") continue;
    if ((t.anchorHp ?? 0) <= 0 || t.yieldRemaining <= 0) continue;
    perSec += TAP_FLUX_PER_SEC * tapYieldMultForOwner(state, "player", t);
  }
  return perSec;
}

function salvageManaPerSec(state: GameState): number {
  if (state.salvage <= 0) return 0;
  return Math.min(state.salvage, SALVAGE_FLUX_CAP_PER_SEC, state.salvage * SALVAGE_FLUX_PER_POOL_PER_SEC);
}

/** Half angular span (rad) from end to end across one fanned row — higher = less overlap. */
const ARC_ALPHA_MAX = 0.42;
const ARC_ALPHA_MIN = 0.12;
const ARC_PAD_X = 10;
const ARC_SLOT_COUNT = 5;

/** θ_i = -α … +α in equal steps so every card center lies on one shared circular arc (one curve per hand). */
function arcSlotThetas(alpha: number): number[] {
  const n = ARC_SLOT_COUNT;
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, i) => -alpha + (i / (n - 1)) * (2 * alpha));
}

/**
 * One circle per hand row: evenly spaced angles, single radius. Upper and lower rows share the same
 * (α, R, θ_i); only DOM stacking separates the two rows — no inner/outer “double fan”.
 */
function layoutDoctrineDeckArc(track: HTMLElement): void {
  if (!track.classList.contains("doctrine-track--deck2x8")) return;

  const sampleCard = track.querySelector(
    ".doctrine-hand--match .slot .doctrine-card-compact",
  ) as HTMLElement | null;
  const cardRect = sampleCard?.getBoundingClientRect();
  const cardW = cardRect && cardRect.width > 2 ? cardRect.width : 0;
  const cardH = cardRect && cardRect.height > 2 ? cardRect.height : 0;
  if (cardW < 4 || cardH < 4) return;

  const hands = [...track.querySelectorAll<HTMLElement>(".doctrine-hand--match")];
  if (hands.length < 1) return;

  const innerWs = hands.map((h) => Math.max(0, h.getBoundingClientRect().width - 2 * ARC_PAD_X));
  const innerW = Math.min(...innerWs);
  if (innerW < cardW + 8) return;

  const spanX = (alpha: number, R: number): number => {
    const thetas = arcSlotThetas(alpha);
    let minX = Infinity;
    let maxX = -Infinity;
    for (const th of thetas) {
      const cx = innerW / 2 + R * Math.sin(th);
      const half = (Math.abs(Math.cos(th)) * cardW + Math.abs(Math.sin(th)) * cardH) * 0.5;
      minX = Math.min(minX, cx - half);
      maxX = Math.max(maxX, cx + half);
    }
    return maxX - minX;
  };

  let alpha = ARC_ALPHA_MAX;
  let arcR = Math.max(96, Math.min(300, innerW * 0.5));
  for (let iter = 0; iter < 40; iter++) {
    if (spanX(alpha, arcR) <= innerW && alpha >= ARC_ALPHA_MIN) break;
    alpha *= 0.92;
    arcR *= 0.965;
    if (alpha < ARC_ALPHA_MIN) alpha = ARC_ALPHA_MIN;
  }

  const thetas = arcSlotThetas(alpha);
  /** Circle center sits “below” the band so the segment reads as a gentle smile. */
  const cyBase = arcR + cardH * 0.55;

  const placeHand = (hand: HTMLElement): void => {
    const handInnerW = Math.max(0, hand.getBoundingClientRect().width - 2 * ARC_PAD_X);
    const slots = hand.querySelectorAll<HTMLElement>(".slot");

    let minTop = Infinity;
    let maxBot = -Infinity;
    slots.forEach((slot, i) => {
      if (i >= ARC_SLOT_COUNT) return;
      if (slot.classList.contains("slot--hand-collapsed")) return;
      const th = thetas[i]!;
      const cx = handInnerW / 2 + arcR * Math.sin(th);
      const cyy = cyBase - arcR * Math.cos(th);
      const left = ARC_PAD_X + cx - cardW / 2;
      const top = cyy - cardH / 2;
      minTop = Math.min(minTop, top);
      maxBot = Math.max(maxBot, top + cardH);
      const rotDeg = (-th * 180) / Math.PI;
      slot.style.setProperty("--arc-left", `${left}px`);
      slot.style.setProperty("--arc-top", `${top}px`);
      slot.style.setProperty("--arc-deg", `${rotDeg}deg`);
    });

    if (Number.isFinite(minTop) && Number.isFinite(maxBot)) {
      const arcH = Math.max(maxBot - minTop + 10, cardH + 18);
      hand.style.setProperty("--hand-arc-h", `${arcH}px`);
    } else {
      hand.style.removeProperty("--hand-arc-h");
    }
  };

  for (const hand of hands) placeHand(hand);
}

/** Sizes the fanned overlap so every visible card fits flat in the tray with no clipping. */
function syncDoctrineHandOverlap(track: HTMLElement, state: GameState): void {
  if (!track.classList.contains("doctrine-track--hand")) return;

  if (track.classList.contains("doctrine-track--rail")) {
    track.style.removeProperty("--hand-reveal");
    return;
  }

  if (track.classList.contains("doctrine-track--deck2x8")) {
    layoutDoctrineDeckArc(track);
    return;
  }

  let n = 0;
  if (track.classList.contains("doctrine-track--deck10")) {
    n = DOCTRINE_SLOT_COUNT;
  } else {
    for (let i = 0; i < DOCTRINE_SLOT_COUNT; i++) {
      const id = state.doctrineSlotCatalogIds[i] ?? null;
      if (id && getCatalogEntry(id)) n++;
    }
  }
  if (n <= 1) {
    track.style.removeProperty("--hand-reveal");
    return;
  }
  const firstCard = track.querySelector(
    ".slot:not(.slot--hand-collapsed) .doctrine-card-compact",
  ) as HTMLElement | null;
  const cw = firstCard?.getBoundingClientRect().width ?? 0;
  if (cw < 4) return;
  const pad = 24;
  const avail = Math.max(0, track.getBoundingClientRect().width - pad);
  const idealReveal = (avail - cw) / (n - 1);
  const minReveal = track.classList.contains("doctrine-track--deck10") ? 6 : 12;
  const reveal = Math.max(minReveal, Math.min(cw, idealReveal));
  track.style.setProperty("--hand-reveal", `${reveal}px`);
}

export type HudIntentSink = (intent: PlayerIntent) => void;

export type HudMountApi = {
  controlProfile?: ControlProfile;
  onRematch?: () => void;
  onEditDoctrine?: () => void;
  /** Lock camera pivot on wizard vs free orbit (same as C). */
  onCameraFollowToggle?: () => void;
  pushIntent: HudIntentSink;
};

function enemyCount(state: GameState): number {
  return state.units.filter((u) => u.team === "enemy" && u.hp > 0).length;
}

function computeObjective(state: GameState): string {
  const claimedNodes = claimedTapCount(state);
  const playerStructs = state.structures.filter((s) => s.team === "player");
  const playerTowers = playerStructs.filter((s) => {
    const e = getCatalogEntry(s.catalogId);
    return e && isStructureEntry(e) && s.catalogId !== "wizard_keep";
  });
  const playerUnits = state.units.filter((u) => u.team === "player" && u.hp > 0);

  if (claimedNodes === 0)
    return "Claim a node — walk into the nearest grey ring and stay inside to earn a Mana burst plus faster income.";
  if (playerTowers.length === 0) return "Drop a tower inside claimed territory (blue field) to start batch production.";
  if (playerUnits.length === 0) {
    const producing = playerStructs.find((st) => st.complete);
    if (producing) {
      const def = getCatalogEntry(producing.catalogId);
      const secs = Math.max(0, Math.ceil(producing.productionTicksRemaining / TICK_HZ));
      const name = def && isStructureEntry(def) ? def.name : "Tower";
      return `Waiting on first production — ${name} in ${secs}s.`;
    }
    return "Waiting for your tower to finish summoning…";
  }
  return "Push toward the red Dark Fortresses — shatter them to win.";
}

function campCoreSummary(state: GameState): string {
  const bits: string[] = [];
  for (const c of state.map.enemyCamps) {
    if (!(typeof c.coreMaxHp === "number" && c.coreMaxHp > 0)) continue;
    const hp = state.enemyCampCoreHp[c.id];
    if (hp === undefined) continue;
    const pct =
      c.coreMaxHp > 0 ? Math.max(0, Math.min(100, Math.round((hp / c.coreMaxHp) * 100))) : Math.round(hp);
    bits.push(`${c.id.slice(0, 5)}… ${pct}%`);
  }
  return bits.length ? bits.join(" · ") : "";
}

function hudSvgText(
  className: string,
  text: string,
  id?: string,
  opts?: { anchor?: "middle" | "start" },
): string {
  const idAttr = id ? ` id="${escapeHudHtml(id)}"` : "";
  const anchor = opts?.anchor ?? "middle";
  const isCompactText =
    className.includes("hud-svg-label") ||
    className.includes("hud-svg-value") ||
    className.includes("hud-svg-vital");
  const viewW = anchor === "start" ? 640 : isCompactText ? 88 : 160;
  const x = anchor === "start" ? "4" : String(viewW / 2);
  const ta = anchor === "start" ? "start" : "middle";
  const preserve = anchor === "start" ? "xMinYMid meet" : "xMidYMid meet";
  return `<svg class="hud-svg-text ${className}" viewBox="0 0 ${viewW} 24" preserveAspectRatio="${preserve}" aria-hidden="true"><text${idAttr} x="${x}" y="16" text-anchor="${ta}">${escapeHudHtml(text)}</text></svg>`;
}

function hudCommandIcon(kind: "rally" | "stance" | "formation" | "camera" | "teleport" | "captain"): string {
  const common = `class="hud-command-icon hud-command-icon--${kind}" viewBox="0 0 64 64" aria-hidden="true" focusable="false"`;
  const shared = `fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"`;
  if (kind === "rally") {
    return `<span class="hud-side-sprite hud-side-sprite--rally">${[
      `<svg ${common}>`,
      `<path class="hud-command-icon__halo" d="M32 7 37 18 49 23 37 28 32 39 27 28 15 23 27 18Z"/>`,
      `<path ${shared} d="M17 51c9-9 21-9 30 0"/>`,
      `<path ${shared} d="M32 13v34"/>`,
      `<path ${shared} d="M32 17h15l-5 7 5 7H32"/>`,
      `</svg>`,
    ].join("")}</span>`;
  }
  if (kind === "stance") {
    return `<span class="hud-side-sprite hud-side-sprite--stance">${[
      `<svg ${common}>`,
      `<path class="hud-command-icon__halo" d="M32 8c9 6 16 8 22 9-1 18-8 30-22 39C18 47 11 35 10 17c6-1 13-3 22-9Z"/>`,
      `<path ${shared} d="M32 11c8 5 14 7 19 8-1 15-7 25-19 33-12-8-18-18-19-33 5-1 11-3 19-8Z"/>`,
      `<path ${shared} d="M32 20v24"/>`,
      `<path ${shared} d="M22 31h20"/>`,
      `</svg>`,
    ].join("")}</span>`;
  }
  if (kind === "formation") {
    return `<span class="hud-side-sprite hud-side-sprite--formation">${[
      `<svg ${common}>`,
      `<path class="hud-command-icon__halo" d="M32 9 53 47H11Z"/>`,
      `<path ${shared} d="M32 11v38"/>`,
      `<path ${shared} d="M16 48c4-8 10-13 16-13s12 5 16 13"/>`,
      `<circle class="hud-command-icon__dot" cx="32" cy="16" r="4"/>`,
      `<circle class="hud-command-icon__dot" cx="23" cy="34" r="4"/>`,
      `<circle class="hud-command-icon__dot" cx="41" cy="34" r="4"/>`,
      `<circle class="hud-command-icon__dot" cx="14" cy="50" r="3.5"/>`,
      `<circle class="hud-command-icon__dot" cx="50" cy="50" r="3.5"/>`,
      `</svg>`,
    ].join("")}</span>`;
  }
  if (kind === "camera") {
    return `<span class="hud-side-sprite hud-side-sprite--camera">${[
      `<svg ${common}>`,
      `<path class="hud-command-icon__halo" d="M11 22h14l4-6h18a6 6 0 0 1 6 6v22a6 6 0 0 1-6 6H17a6 6 0 0 1-6-6Z"/>`,
      `<path ${shared} d="M13 24h12l4-6h18a5 5 0 0 1 5 5v20a5 5 0 0 1-5 5H17a5 5 0 0 1-5-5V25"/>`,
      `<circle ${shared} cx="32" cy="35" r="10"/>`,
      `<path ${shared} d="M47 15v8h8"/>`,
      `</svg>`,
    ].join("")}</span>`;
  }
  if (kind === "teleport") {
    return `<span class="hud-side-sprite hud-side-sprite--teleport">${[
      `<svg ${common}>`,
      `<path class="hud-command-icon__halo" d="M32 5 46 22 32 59 18 22Z"/>`,
      `<path ${shared} d="M32 7 44 22 32 56 20 22Z"/>`,
      `<path ${shared} d="M22 22h20"/>`,
      `<path ${shared} d="M32 14v32"/>`,
      `<path ${shared} d="M16 50c8 5 24 5 32 0"/>`,
      `</svg>`,
    ].join("")}</span>`;
  }
  return `<span class="hud-side-ico hud-side-ico--captain">${[
    `<svg ${common}>`,
    `<circle class="hud-command-icon__halo" cx="32" cy="32" r="25"/>`,
    `<path ${shared} d="M32 8 39 24 56 26 43 37 47 54 32 45 17 54 21 37 8 26 25 24Z"/>`,
    `<path ${shared} d="M32 18v23"/>`,
    `<path ${shared} d="M24 42h16"/>`,
    `</svg>`,
  ].join("")}</span>`;
}

function hudResourceIcon(kind: "mana" | "salvage" | "pop" | "nodes"): string {
  const common = `class="hud-resource-icon hud-resource-icon--${kind}" viewBox="0 0 48 48" aria-hidden="true" focusable="false"`;
  const shared = `fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"`;
  if (kind === "mana") {
    return `<span class="hud-stat__ico">${[
      `<svg ${common}>`,
      `<path class="hud-resource-icon__glow" d="M26 4C18 13 14 20 14 28a10 10 0 0 0 20 0c0-6-4-10-8-15 1 8-7 9-4 18"/>`,
      `<path ${shared} d="M26 5C18 14 15 21 15 28a9 9 0 0 0 18 0c0-6-4-10-8-15 1 8-7 9-4 18"/>`,
      `</svg>`,
    ].join("")}</span>`;
  }
  if (kind === "salvage") {
    return `<span class="hud-stat__ico">${[
      `<svg ${common}>`,
      `<circle class="hud-resource-icon__glow" cx="24" cy="24" r="14"/>`,
      `<path ${shared} d="M24 7v7M24 34v7M7 24h7M34 24h7M12 12l5 5M31 31l5 5M36 12l-5 5M17 31l-5 5"/>`,
      `<circle ${shared} cx="24" cy="24" r="8"/>`,
      `</svg>`,
    ].join("")}</span>`;
  }
  if (kind === "pop") {
    return `<span class="hud-stat__ico">${[
      `<svg ${common}>`,
      `<path class="hud-resource-icon__glow" d="M12 39c2-8 8-12 12-12s10 4 12 12"/>`,
      `<circle ${shared} cx="24" cy="15" r="7"/>`,
      `<path ${shared} d="M10 39c2-8 8-12 14-12s12 4 14 12"/>`,
      `<path ${shared} d="M9 31c-1-5 2-9 7-10M39 31c1-5-2-9-7-10"/>`,
      `</svg>`,
    ].join("")}</span>`;
  }
  return `<span class="hud-stat__ico">${[
    `<svg ${common}>`,
    `<path class="hud-resource-icon__glow" d="M24 8 39 18v12L24 40 9 30V18Z"/>`,
    `<circle ${shared} cx="24" cy="10" r="4"/>`,
    `<circle ${shared} cx="10" cy="31" r="4"/>`,
    `<circle ${shared} cx="38" cy="31" r="4"/>`,
    `<path ${shared} d="M21 12 13 28M27 12l8 16M15 31h18"/>`,
    `</svg>`,
  ].join("")}</span>`;
}

export function mountHud(root: HTMLElement, initial: GameState, api: HudMountApi): void {
  const { controlProfile, onRematch, onEditDoctrine, onCameraFollowToggle, pushIntent } = api;
  root.dataset.controlProfile = controlProfile?.mode ?? "desktop";
  root.innerHTML = `
    <header class="hud-chrome" aria-label="Match status">
      <aside class="hud-match-side-controls" aria-label="Commands and battle log">
        <button
          class="hud-btn hud-btn--ghost hud-btn--side-art"
          id="btn-rally"
          type="button"
          title="Rally: arm a march point (R). In Offense, the next left-click on the map sets where your army walks; use G to clear the march when needed."
        >
          ${hudCommandIcon("rally")}
          <span class="hud-side-copy"
            ><span class="hud-side-eyebrow">Rally <kbd class="hud-side-hk">R</kbd></span
            ><span class="hud-side-hint">Set army march on map (Offense)</span
            ><span class="hud-side-value">Rally</span></span
          >
        </button>
        <button
          class="hud-btn hud-btn--ghost hud-btn--stance hud-btn--side-art"
          id="btn-stance"
          type="button"
          aria-pressed="false"
          title="Stance: Offense (seek fights) or Defense (gather on Wizard) — G."
        >
          ${hudCommandIcon("stance")}
          <span class="hud-side-copy"
            ><span class="hud-side-eyebrow">Stance <kbd class="hud-side-hk">G</kbd></span
            ><span class="hud-side-hint">Offense vs gather on Wizard</span
            ><span class="hud-side-value">Push</span></span
          >
        </button>
        <button
          class="hud-btn hud-btn--ghost hud-btn--side-art"
          id="btn-formation"
          type="button"
          title="Formation: V cycles preset. With squads selected, RMB drag sets the shape; Shift = wider ranks."
        >
          ${hudCommandIcon("formation")}
          <span class="hud-side-copy"
            ><span class="hud-side-eyebrow">Shape <kbd class="hud-side-hk">V</kbd></span
            ><span class="hud-side-hint">RMB drag on selected units</span
            ><span class="hud-side-value">Line</span></span
          >
        </button>
        <button
          class="hud-btn hud-btn--ghost hud-btn--side-art"
          id="btn-camera-follow"
          type="button"
          aria-pressed="true"
          title="Camera: follow Wizard (scroll = zoom) or free orbit (MMB) — C to toggle."
        >
          ${hudCommandIcon("camera")}
          <span class="hud-side-copy"
            ><span class="hud-side-eyebrow">View <kbd class="hud-side-hk">C</kbd></span
            ><span class="hud-side-hint">Lock on wizard vs free cam</span
            ><span class="hud-side-value">lock</span></span
          >
        </button>
        <button
          class="hud-btn hud-btn--ghost hud-btn--side-art"
          id="btn-teleport"
          type="button"
          aria-pressed="false"
          title="Teleport: T arms a squad blink on your side; carries nearby troops. Cooldown shown on the button."
        >
          ${hudCommandIcon("teleport")}
          <span class="hud-side-copy"
            ><span class="hud-side-eyebrow">Blink <kbd class="hud-side-hk">T</kbd></span
            ><span class="hud-side-hint">Jump squad + nearby allies</span
            ><span class="hud-side-value">Blink</span></span
          >
        </button>
        <button
          class="hud-btn hud-btn--ghost"
          id="btn-captain"
          type="button"
          aria-pressed="${initial.heroCaptainEnabled ? "true" : "false"}"
          title="Captain: when on, the Wizard auto-picks objectives when idle. Turn off for full manual control."
        >
          ${hudCommandIcon("captain")}
          <span class="hud-side-copy"
            ><span class="hud-side-eyebrow">Captain <kbd class="hud-side-hk">A</kbd></span
            ><span class="hud-side-hint">Auto path when idle</span
            ><span class="hud-side-value">Auto</span></span
          >
        </button>
      </aside>
      <div class="hud-brand" aria-hidden="true">${hudSvgText("hud-svg-brand", "A")}</div>
      <div class="hud-chrome__cluster hud-chrome__cluster--main">
        <div class="hud-chrome__stats">
          <span class="hud-stat hud-stat--econ hud-stat--mana">${hudResourceIcon("mana")}<span class="hud-stat__txt"><span class="hud-stat__label">Mana</span><span class="hud-stat__value" id="flux">0</span></span></span>
          <span class="hud-stat hud-stat--econ hud-stat--salvage">${hudResourceIcon("salvage")}<span class="hud-stat__txt"><span class="hud-stat__label">Salv</span><span class="hud-stat__value" id="salvage">0</span></span></span>
          <span class="hud-stat hud-stat--econ hud-stat--pop">${hudResourceIcon("pop")}<span class="hud-stat__txt"><span class="hud-stat__label">Pop</span><span class="hud-stat__value" id="pop">0</span></span></span>
          <span class="hud-stat hud-stat--field hud-stat--nodes">${hudResourceIcon("nodes")}<span class="hud-stat__txt"><span class="hud-stat__label">Nodes</span><span class="hud-stat__value" id="nodes">0</span></span></span>
          <span class="hud-stat hud-stat--mode"><span class="hud-stat__txt"><span class="hud-stat__label">Mode</span><span class="hud-stat__value hud-stat__value--mode" id="mode">idle</span></span></span>
        </div>
        <div
          class="hud-chrome__phase"
          role="status"
          aria-live="polite"
          aria-label="Match time remaining and total damage dealt in this match"
        >
          <div class="hud-phase__row hud-phase__row--time">
            <span class="hud-phase__kicker">Time Left</span>
            <span class="hud-phase-timer" id="hud-phase-timer">0s</span>
          </div>
          <div
            class="hud-phase__row hud-phase__row--damage"
            title="Total hit-point damage in this match: first number = damage you dealt to the enemy, second = damage they dealt to you. Used to break ties if the match timer runs out."
          >
            <span class="hud-phase__kicker">Damage You / Foe</span>
            <span class="hud-phase-stats">
              <span class="hud-phase-stats-you" id="hud-phase-dmg-p">0</span>
              <span class="hud-phase-stats-sep" aria-hidden="true">/</span>
              <span class="hud-phase-stats-en" id="hud-phase-dmg-e">0</span>
            </span>
          </div>
        </div>
        <div class="hud-territory-key" role="group" aria-label="Territory map key">
          <div class="hud-territory-key__row">
            <span class="hud-territory-key__swatch hud-territory-key__swatch--yours" aria-hidden="true"></span>
            <span class="hud-territory-key__txt">Your territory — build &amp; deploy</span>
          </div>
          <div class="hud-territory-key__row">
            <span class="hud-territory-key__swatch hud-territory-key__swatch--enemy" aria-hidden="true"></span>
            <span class="hud-territory-key__txt">Enemy zone — hostile</span>
          </div>
        </div>
      </div>
      <div class="hud-chrome__cluster hud-chrome__cluster--status">
        <div class="hud-chrome__readout hud-status-card hud-status-card--hostiles" id="hud-readout" aria-label="Enemy intelligence"></div>
        <div class="hud-chrome__vitals">
          <div class="hud-vital hud-status-card" id="hud-hero-hp"><span class="hud-vital__ico" aria-hidden="true">${hudSvgText("hud-svg-icon-letter", "W")}</span>${hudSvgText("hud-svg-vital-label hud-vital__lbl", "Wizard")}<span class="bar"><span class="bar-fill" id="hud-hero-hp-fill"></span></span>${hudSvgText("hud-svg-vital-value", "100%", "hud-hero-hp-val")}</div>
          <div class="hud-vital hud-status-card" id="hud-keep-hp"><span class="hud-vital__ico" aria-hidden="true">${hudSvgText("hud-svg-icon-letter", "K")}</span>${hudSvgText("hud-svg-vital-label hud-vital__lbl", "Keep")}<span class="bar"><span class="bar-fill" id="hud-keep-hp-fill"></span></span>${hudSvgText("hud-svg-vital-value", "100%", "hud-keep-hp-val")}</div>
        </div>
      </div>
      <div class="hud-chrome__objective" id="hud-objective" hidden role="status">
        <span class="hud-chrome__objective-icon" aria-hidden="true"></span>
        <span class="hud-chrome__objective-body">${hudSvgText("hud-svg-objective-label hud-chrome__objective-k", "Next Objective")}${hudSvgText("hud-svg-objective-text hud-chrome__objective-t", "", "hud-objective-text", { anchor: "start" })}</span>
      </div>
      <div class="hud-select-tag" id="hud-select-tag" hidden></div>
    </header>
    <div class="hud-endgame" id="hud-endgame" hidden>
      <div
        class="hud-endgame-panel"
        aria-labelledby="hud-endgame-title"
        aria-describedby="hud-endgame-reason"
      >
        <img class="hud-endgame-art" id="hud-endgame-art" src="/assets/hud/end-victory.png" alt="" />
        <h2 class="hud-endgame-title sr-only" id="hud-endgame-title">Match over</h2>
        <p class="hud-endgame-reason" id="hud-endgame-reason" role="status" hidden></p>
        <dl class="hud-endgame-stats" id="hud-endgame-stats" aria-label="Match results">
          <div class="hud-endgame-stat hud-endgame-stat--time"><dt>Time</dt><dd id="hud-endgame-stat-time">—</dd></div>
          <div class="hud-endgame-stat hud-endgame-stat--score"><dt>Score</dt><dd id="hud-endgame-stat-score">—</dd></div>
          <div class="hud-endgame-stat hud-endgame-stat--best"><dt>Best local</dt><dd id="hud-endgame-stat-best">—</dd></div>
          <div class="hud-endgame-stat hud-endgame-stat--structures-built"><dt>Doctrine structures placed</dt><dd id="hud-endgame-stat-structures-built">—</dd></div>
          <div class="hud-endgame-stat hud-endgame-stat--structures-lost"><dt>Structures lost</dt><dd id="hud-endgame-stat-structures-lost">—</dd></div>
          <div class="hud-endgame-stat hud-endgame-stat--units-produced"><dt>Units produced</dt><dd id="hud-endgame-stat-units-produced">—</dd></div>
          <div class="hud-endgame-stat hud-endgame-stat--units-lost"><dt>Units lost</dt><dd id="hud-endgame-stat-units-lost">—</dd></div>
          <div class="hud-endgame-stat hud-endgame-stat--enemy-kills"><dt>Enemy kills</dt><dd id="hud-endgame-stat-enemy-kills">—</dd></div>
          <div class="hud-endgame-stat hud-endgame-stat--commands-cast"><dt>Commands cast</dt><dd id="hud-endgame-stat-commands-cast">—</dd></div>
          <div class="hud-endgame-stat hud-endgame-stat--salvage-recovered"><dt>Salvage recovered</dt><dd id="hud-endgame-stat-salvage-recovered">—</dd></div>
        </dl>
        <div class="hud-endgame-actions">
          <button class="hud-endgame-action hud-endgame-action--rematch" type="button" id="btn-rematch">Rematch</button>
          <button class="hud-endgame-action hud-endgame-action--edit" type="button" id="btn-edit-doctrine">Edit doctrine</button>
        </div>
      </div>
    </div>
    <footer class="hud-dock hud-dock--overlay" id="hud-dock">
      <div class="hud-dock__bar hud-dock__bar--message-only">
        <p class="hud-dock__msg" id="msg"></p>
      </div>
      <div class="doctrine-wrap doctrine-wrap--rail" id="doctrine-wrap">
        <div class="doctrine-view" id="doctrine-view">
          <div
            class="doctrine-track doctrine-track--hand doctrine-track--deck10 doctrine-track--rail"
            id="doctrine-track"
            role="grid"
            aria-label="Doctrine deck, slots 1 through 0"
            aria-rowcount="1"
          >
            <div class="doctrine-hand doctrine-hand--match" role="row" aria-rowindex="1"></div>
          </div>
        </div>
      </div>
    </footer>
    <a
      class="hud-vibejam-link"
      href="https://vibej.am/"
      target="_blank"
      rel="noopener noreferrer"
      title="Vibe Jam 2026"
      aria-label="Vibe Jam 2026"
    >
      🎮 Vibe Jam 2026
    </a>
  `;

  const doctrineTrack = root.querySelector("#doctrine-track") as HTMLDivElement;
  const doctrineHand = doctrineTrack.querySelector(".doctrine-hand--match") as HTMLDivElement;

  for (let i = 0; i < DOCTRINE_SLOT_COUNT; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "slot";
    b.dataset.slotIndex = String(i);
    b.setAttribute("role", "gridcell");
    b.setAttribute("aria-rowindex", "1");
    b.setAttribute("aria-colindex", String(i + 1));
    const hotkey = i === 9 ? "0" : String(i + 1);
    b.setAttribute("aria-label", `Doctrine slot ${i + 1}, key ${hotkey}`);
    const catalogId = initial.doctrineSlotCatalogIds[i] ?? null;
    b.innerHTML = doctrineSlotButtonInnerHtml(i, catalogId, { variant: "hud", liveIdPrefix: "slot-live" });
    doctrineHand.appendChild(b);
  }

  hydrateCardPreviewImages(doctrineTrack);

  doctrineTrack.addEventListener("dblclick", (ev) => {
    if (!(ev.target instanceof Element)) return;
    const slot = ev.target.closest(".slot");
    if (!slot || !doctrineTrack.contains(slot)) return;
    if (slot.classList.contains("slot-empty") || slot.classList.contains("slot-locked")) return;
    const card = slot.querySelector(".doctrine-card-compact[data-catalog-id]");
    const id = card?.getAttribute("data-catalog-id");
    if (!id) return;
    ev.preventDefault();
    ev.stopPropagation();
    showDoctrineCardDetail(id);
  });

  root.querySelector("#btn-rally")!.addEventListener("click", () => {
    pushIntent({ type: "begin_rally_click" });
  });

  root.querySelector("#btn-stance")!.addEventListener("click", () => {
    pushIntent({ type: "toggle_army_stance" });
  });

  root.querySelector("#btn-formation")?.addEventListener("click", () => {
    pushIntent({ type: "toggle_formation_preset" });
  });

  root.querySelector("#btn-camera-follow")?.addEventListener("click", () => {
    onCameraFollowToggle?.();
  });

  root.querySelector("#btn-teleport")?.addEventListener("click", () => {
    pushIntent({ type: "begin_hero_teleport" });
  });
  root.querySelector("#btn-captain")?.addEventListener("click", () => {
    pushIntent({ type: "toggle_hero_captain" });
  });

  root.querySelector("#btn-rematch")?.addEventListener("click", () => {
    onRematch?.();
  });
  root.querySelector("#btn-edit-doctrine")?.addEventListener("click", () => {
    onEditDoctrine?.();
  });
}

export function updateHud(state: GameState): void {
  const flux = document.querySelector("#flux");
  const salvage = document.querySelector("#salvage");
  const pop = document.querySelector("#pop");
  const nodes = document.querySelector("#nodes");
  const mode = document.querySelector("#mode");
  const phaseTimer = document.querySelector("#hud-phase-timer");
  const phaseDmgP = document.querySelector("#hud-phase-dmg-p");
  const phaseDmgE = document.querySelector("#hud-phase-dmg-e");
  const msg = document.querySelector("#msg");
  const captain = document.querySelector("#btn-captain");
  const nodeIncome = playerManaIncomePerSec(state);
  const salvageIncome = salvageManaPerSec(state);
  if (flux) {
    flux.textContent = String(Math.floor(state.flux));
    const parent = flux.closest<HTMLElement>(".hud-stat");
    if (parent) parent.title = `Mana pays for cards. Income: +${(nodeIncome + salvageIncome).toFixed(1)}/s (${nodeIncome.toFixed(1)} from nodes, ${salvageIncome.toFixed(1)} from Salvage).`;
  }
  if (salvage) {
    salvage.textContent = String(Math.floor(state.salvage));
    const parent = salvage.closest<HTMLElement>(".hud-stat");
    if (parent) parent.title = `Salvage is a reserve that converts into Mana over time: +${salvageIncome.toFixed(1)}/s right now.`;
  }
  const popVal = totalPlayerPop(state);
  if (pop) pop.textContent = String(popVal);
  if (nodes) {
    const claimed = claimedTapCount(state);
    nodes.textContent = String(claimed);
    const parent = nodes.closest<HTMLElement>(".hud-stat");
    const activeYielding = state.taps.filter((t) => t.active && t.ownerTeam === "player" && t.yieldRemaining > 0 && (t.anchorHp ?? 0) > 0).length;
    if (parent) parent.title = `${claimed} Mana nodes claimed; ${activeYielding} still producing. Claim neutral rings to expand the cyan build area.`;
  }
  if (mode) {
    if (state.pendingPlacementCatalogId) {
      const e = getCatalogEntry(state.pendingPlacementCatalogId);
      mode.textContent = e
        ? `Placing ${e.name} — Esc or right-click cancels`
        : "Placing card — Esc or right-click cancels";
    } else {
      mode.textContent = state.rallyClickPending
        ? "Set rally"
        : state.teleportClickPending
          ? "Teleport"
          : state.globalRallyActive && state.armyStance === "offense"
            ? "Marching"
            : "Idle";
    }
  }
  if (phaseTimer && phaseDmgP && phaseDmgE) {
    const dp = Math.round(state.stats.damageDealtPlayer);
    const de = Math.round(state.stats.damageDealtEnemy);
    phaseDmgP.textContent = String(dp);
    phaseDmgE.textContent = String(de);
    if (state.phase === "playing") {
      const sec = Math.max(0, (MATCH_DURATION_TICKS - state.tick) / TICK_HZ);
      phaseTimer.textContent = `${sec.toFixed(0)}s`;
    } else {
      phaseTimer.textContent = state.phase;
    }
  }
  if (captain) {
    captain.setAttribute("aria-pressed", state.heroCaptainEnabled ? "true" : "false");
    const copy = captain.querySelector<HTMLElement>(".hud-side-value");
    if (copy) copy.textContent = "Auto";
    captain.classList.toggle("active", state.heroCaptainEnabled);
  }
  if (msg) msg.textContent = state.lastMessage;

  const stanceBtn = document.querySelector<HTMLButtonElement>("#btn-stance");
  if (stanceBtn) {
    const def = state.armyStance === "defense";
    const copy = stanceBtn.querySelector<HTMLElement>(".hud-side-value");
    if (copy) copy.textContent = def ? "Hold" : "Push";
    stanceBtn.setAttribute("aria-pressed", def ? "true" : "false");
    stanceBtn.classList.toggle("hud-btn--stance-defense", def);
  }

  const formationBtn = document.querySelector<HTMLButtonElement>("#btn-formation");
  if (formationBtn) {
    const copy = formationBtn.querySelector<HTMLElement>(".hud-side-value");
    if (copy) copy.textContent = state.formationPreset[0]!.toUpperCase() + state.formationPreset.slice(1);
  }

  const selTag = document.querySelector<HTMLElement>("#hud-select-tag");
  if (selTag) {
    let label = "";
    if (state.pendingPlacementCatalogId) {
      const e = getCatalogEntry(state.pendingPlacementCatalogId);
    if (e) label = `Selected: ${e.name} — Esc cancels`;
    } else if (state.teleportClickPending) {
      label = "Teleport armed - click your half";
    } else if (state.rallyClickPending) {
      label = "Rally armed — click map (R to cancel)";
    }
    if (label) {
      selTag.textContent = label;
      selTag.hidden = false;
    } else {
      selTag.hidden = true;
    }
  }

  const rallyBtn = document.querySelector<HTMLButtonElement>("#btn-rally");
  if (rallyBtn) {
    const copy = rallyBtn.querySelector<HTMLElement>(".hud-side-value");
    if (copy) copy.textContent = state.rallyClickPending ? "Click" : "Rally";
    rallyBtn.setAttribute("aria-pressed", state.rallyClickPending ? "true" : "false");
    rallyBtn.classList.toggle("hud-btn--armed", state.rallyClickPending);
  }

  const teleportBtn = document.querySelector<HTMLButtonElement>("#btn-teleport");
  if (teleportBtn) {
    const cd = heroTeleportCooldownSeconds(state);
    const cooling = state.heroTeleportCooldownTicks > 0;
    const copy = teleportBtn.querySelector<HTMLElement>(".hud-side-value");
    if (copy) copy.textContent = cooling ? `${cd}s` : state.teleportClickPending ? "Click" : "Blink";
    teleportBtn.disabled = cooling;
    teleportBtn.setAttribute("aria-pressed", state.teleportClickPending ? "true" : "false");
    teleportBtn.classList.toggle("hud-btn--armed", state.teleportClickPending);
  }

  const readout = document.querySelector("#hud-readout");
  if (readout) {
    const coreLine = campCoreSummary(state);
    const n = enemyCount(state);
    const nEsc = escapeHudHtml(String(n));
    const coreBlock =
      coreLine.length > 0
        ? `<div class="hud-readout__camps" role="status"><span class="hud-readout__camps-lbl">Camp cores</span><span class="hud-readout__camps-val">${escapeHudHtml(
            coreLine,
          )}</span></div>`
        : "";
    readout.innerHTML = `<span class="hud-status-card__ico" aria-hidden="true">!</span><div class="hud-readout__body"><div class="hud-readout__hostiles"><div class="hud-readout__hostiles-lbl">Hostiles</div><div class="hud-readout__hostiles-val" id="hud-readout-hostile-n">${nEsc}</div></div>${coreBlock}</div>`;
  }

  const objWrap = document.querySelector<HTMLElement>("#hud-objective");
  const objText = document.querySelector<HTMLElement>("#hud-objective-text");
  if (objWrap && objText) {
    if (state.phase === "playing") {
      objText.textContent = computeObjective(state);
      objWrap.hidden = false;
    } else {
      objWrap.hidden = true;
    }
  }

  const heroHpFill = document.querySelector<HTMLElement>("#hud-hero-hp-fill");
  const heroHpVal = document.querySelector<HTMLElement>("#hud-hero-hp-val");
  if (heroHpFill && heroHpVal) {
    const frac = state.hero.maxHp > 0 ? state.hero.hp / state.hero.maxHp : 0;
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    heroHpFill.style.width = `${pct}%`;
    heroHpVal.textContent = `${Math.max(0, Math.ceil(state.hero.hp))}/${Math.ceil(state.hero.maxHp)}`;
    const card = heroHpFill.closest<HTMLElement>(".hud-vital");
    if (card) {
      card.classList.toggle("hud-vital--low", pct > 0 && pct <= 35);
      card.classList.toggle("hud-vital--critical", pct > 0 && pct <= 18);
      card.classList.toggle("hud-vital--empty", pct <= 0);
      card.title = `Wizard health: ${pct}%`;
    }
  }

  const keepHpFill = document.querySelector<HTMLElement>("#hud-keep-hp-fill");
  const keepHpVal = document.querySelector<HTMLElement>("#hud-keep-hp-val");
  if (keepHpFill && keepHpVal) {
    const keep = findKeep(state);
    const frac = keep && keep.maxHp > 0 ? keep.hp / keep.maxHp : 0;
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    keepHpFill.style.width = `${pct}%`;
    keepHpVal.textContent = keep ? `${Math.max(0, Math.ceil(keep.hp))}/${Math.ceil(keep.maxHp)}` : "-";
    const card = keepHpFill.closest<HTMLElement>(".hud-vital");
    if (card) {
      card.classList.toggle("hud-vital--low", pct > 0 && pct <= 35);
      card.classList.toggle("hud-vital--critical", pct > 0 && pct <= 18);
      card.classList.toggle("hud-vital--empty", pct <= 0 || !keep);
      card.title = keep ? `Keep health: ${pct}%` : "Keep destroyed.";
    }
  }

  const end = document.querySelector("#hud-endgame") as HTMLElement | null;
  const endTitle = document.querySelector("#hud-endgame-title");
  const endArt = document.querySelector<HTMLImageElement>("#hud-endgame-art");
  const endStats = document.querySelector("#hud-endgame-stats");
  const endReason = document.querySelector<HTMLElement>("#hud-endgame-reason");
  if (end && endTitle && endStats && endArt) {
    if (state.phase === "playing") {
      end.hidden = true;
      end.classList.remove("hud-endgame--win", "hud-endgame--lose");
      endTitle.textContent = "Match over";
      if (endReason) {
        endReason.textContent = "";
        endReason.hidden = true;
      }
    } else {
      const won = state.phase === "win";
      end.hidden = false;
      end.classList.toggle("hud-endgame--win", won);
      end.classList.toggle("hud-endgame--lose", !won);
      endTitle.textContent = won ? "Victory" : "Defeat";
      endArt.src = won ? "/assets/hud/end-victory.png" : "/assets/hud/end-defeat.png";
      const st = state.stats;
      const best = readLocalLeaderboard()[0];
      const timeSec = simSecondsFromMatchTick(state.tick);
      const setEndStat = (id: string, value: string | number, title?: string): void => {
        const el = document.querySelector<HTMLElement>(`#hud-endgame-stat-${id}`);
        if (!el) return;
        el.textContent = String(value);
        if (title) el.setAttribute("title", title);
        else el.removeAttribute("title");
      };
      setEndStat(
        "time",
        formatMatchDurationFromTicks(state.tick),
        `Match time in the simulation: ${timeSec < 10 ? timeSec.toFixed(2) : timeSec.toFixed(1)} s of game at ${TICK_HZ} ticks per second (same as the match clock). This is not wall-clock time if the game tab was throttled or paused.`,
      );
      setEndStat(
        "score",
        scoreMatchResult(state),
        "Post-match score: win bonus + enemy kills×14 + claimed nodes×180 + doctrine buildings placed×55 − your unit losses×5 − one point per sim minute. Same value as best local when this run is stored.",
      );
      setEndStat("best", best ? best.score : "—", "Highest post-match score stored in this browser (last 10 runs).");
      setEndStat(
        "structures-built",
        st.structuresBuilt,
        "Doctrine or Captain auto-placed buildings. The pre-placed Wizard Keep is not included.",
      );
      setEndStat("structures-lost", st.structuresLost, "Player buildings destroyed in the sim (the Keep can count if destroyed).");
      setEndStat("units-produced", st.unitsProduced, "Player units spawned from your production (swarm/line/… batches count each unit).");
      setEndStat("units-lost", st.unitsLost, "Your troop casualties (squad sizes count).");
      setEndStat("enemy-kills", st.enemyKills, "Enemy units and troops eliminated (squad sizes count).");
      setEndStat("commands-cast", st.commandsCast, "Command doctrine cards cast (spells, not building placements).");
      setEndStat(
        "salvage-recovered",
        Math.round(st.salvageRecovered),
        "Salvage that entered your salvage pool: refunds when your non-Keep buildings were lost, and salvage from command effects that add to the pool.",
      );
      if (endReason) {
        const how = (state.matchEndDetail ?? state.lastMessage).trim();
        endReason.textContent = how;
        endReason.hidden = !how.length;
      }
    }
  }

  const doctrineTrack = document.querySelector("#doctrine-track");
  if (!doctrineTrack) return;
  const buttons = doctrineTrack.querySelectorAll<HTMLButtonElement>(".slot");
  const isDeck2x8 = doctrineTrack.classList.contains("doctrine-track--deck2x8");
  const isDeck10 = doctrineTrack.classList.contains("doctrine-track--deck10");
  const isRail = doctrineTrack.classList.contains("doctrine-track--rail");

  buttons.forEach((b) => {
    const i = Number(b.dataset.slotIndex);
    if (!Number.isFinite(i) || i < 0 || i >= DOCTRINE_SLOT_COUNT) return;

    b.classList.remove(
      "slot-empty",
      "slot-ready",
      "slot-locked",
      "slot-need-mana",
      "slot-blocked",
      "slot-sigwarn",
      "slot-await-infra",
      "disabled",
      "slot--hand-collapsed",
      "slot--hand-pull",
      "active",
    );
    b.removeAttribute("data-slot-tone");
    const id = state.doctrineSlotCatalogIds[i] ?? null;
    const live = b.querySelector(`#slot-live-${i}`) ?? document.querySelector(`#slot-live-${i}`);

    const clearHandLayout = (): void => {
      b.style.transform = "";
      b.style.zIndex = "";
      b.style.removeProperty("--peel-tx");
      b.style.removeProperty("--peel-ty");
      b.style.removeProperty("--peel-sc");
      if (isDeck2x8) {
        b.style.removeProperty("--arc-left");
        b.style.removeProperty("--arc-top");
        b.style.removeProperty("--arc-deg");
      }
      if (isRail) {
        b.style.removeProperty("--arc-left");
        b.style.removeProperty("--arc-top");
        b.style.removeProperty("--arc-deg");
      }
    };

    b.querySelector(".slot-dup-count")?.remove();

    if (!id) {
      b.classList.add("slot-empty");
      if (!isDeck2x8 && !isDeck10 && !isRail) b.classList.add("slot--hand-collapsed");
      if (live) live.textContent = "";
      const hkE = i === 9 ? "0" : String(i + 1);
      b.title = `Empty slot — add a card in the pre-match deck builder. (key ${hkE})`;
      clearHandLayout();
      return;
    }
    const e = getCatalogEntry(id);
    if (!e) {
      b.classList.add("slot-empty");
      if (!isDeck2x8 && !isDeck10 && !isRail) b.classList.add("slot--hand-collapsed");
      if (live) live.textContent = "";
      const hkU = i === 9 ? "0" : String(i + 1);
      b.title = `Unknown card in slot. (key ${hkU})`;
      clearHandLayout();
      return;
    }

    const play = doctrineCardPlayability(state, id, null, i);
    if (play.kind === "cooldown") b.classList.add("slot-locked");
    else if (play.kind === "mana") b.classList.add("slot-need-mana");
    else if (!play.ok) b.classList.add("slot-blocked");
    else b.classList.add("slot-ready");

    if (state.selectedDoctrineIndex === i) b.classList.add("active");

    if (live) {
      const cls = play.ok ? "live-info" : play.kind === "mana" ? "live-warn" : "live-bad";
      live.innerHTML = play.liveLabel ? `<span class="${cls}">${escapeHudHtml(play.liveLabel)}</span>` : "";
    }

    const hk = i === 9 ? "0" : String(i + 1);
    b.title = `${play.reason ?? play.hint} (key ${hk})`;
    b.setAttribute("aria-disabled", play.reason ? "true" : "false");
  });

  if (!isDeck2x8 && !isDeck10 && !isRail) {
    let seenFilled = false;
    buttons.forEach((b) => {
      if (b.classList.contains("slot--hand-collapsed")) return;
      if (!seenFilled) {
        seenFilled = true;
        return;
      }
      b.classList.add("slot--hand-pull");
    });
  }

  const rawPeek = doctrineTrack.getAttribute("data-hand-peek");
  const peekIdx =
    rawPeek !== null && rawPeek !== "" && Number.isFinite(Number(rawPeek)) ? Number(rawPeek) : null;

  const visibleIdx: number[] = [];
  buttons.forEach((b) => {
    const si = Number(b.dataset.slotIndex);
    if (!Number.isFinite(si) || si < 0 || si >= DOCTRINE_SLOT_COUNT) return;
    if (!b.classList.contains("slot--hand-collapsed")) visibleIdx.push(si);
  });

  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

  let peelLeftIdx: number | null = null;
  let peelRightIdx: number | null = null;
  let peelBelowIdx: number | null = null;
  let peelAboveIdx: number | null = null;
  let peelTxLeft = 0;
  let peelTxRight = 0;
  let peelTyBelow = 0;
  let peelTyAbove = 0;
  let peelCenterScale = 1;
  let peelCenterTy = 0;
  if (peekIdx !== null && visibleIdx.includes(peekIdx)) {
    if (isRail) {
      peelLeftIdx = null;
      peelRightIdx = null;
      peelAboveIdx = null;
      peelBelowIdx = null;
      peelTxLeft = 0;
      peelTxRight = 0;
      peelTyAbove = 0;
      peelTyBelow = 0;
      peelCenterScale = 1;
      peelCenterTy = 0;
    } else {
    const peelGrid = reducedMotion ? 7 : 13;
    peelTxLeft = -peelGrid;
    peelTxRight = peelGrid;
    peelTyAbove = -peelGrid;
    peelTyBelow = peelGrid;
    peelCenterScale = reducedMotion ? 1.02 : 1.08;
    peelCenterTy = reducedMotion ? -2 : -10;

    if (isDeck2x8) {
      const deck2x8Cols = 8;
      const row = Math.floor(peekIdx / deck2x8Cols);
      const col = peekIdx % deck2x8Cols;
      const vis = (j: number) => (visibleIdx.includes(j) ? j : null);
      peelLeftIdx = col > 0 ? vis(peekIdx - 1) : null;
      peelRightIdx = col < deck2x8Cols - 1 ? vis(peekIdx + 1) : null;
      peelAboveIdx = row > 0 ? vis(peekIdx - deck2x8Cols) : null;
      peelBelowIdx = row < 1 ? vis(peekIdx + deck2x8Cols) : null;
    } else {
      const pos = visibleIdx.indexOf(peekIdx);
      peelLeftIdx = pos > 0 ? visibleIdx[pos - 1]! : null;
      peelRightIdx = pos < visibleIdx.length - 1 ? visibleIdx[pos + 1]! : null;
      peelAboveIdx = null;
      peelBelowIdx = null;
      const sample = doctrineTrack.querySelector(
        ".slot:not(.slot--hand-collapsed) .doctrine-card-compact",
      ) as HTMLElement | null;
      const cardW = sample?.offsetWidth ?? 0;
      const revealParsed = Number.parseFloat(
        getComputedStyle(doctrineTrack).getPropertyValue("--hand-reveal").trim(),
      );
      const reveal = Number.isFinite(revealParsed) ? revealParsed : 14;
      const overlap = Math.max(0, cardW - reveal);
      const peel = reducedMotion ? Math.min(10, overlap * 0.2) : Math.max(20, Math.min(72, overlap * 0.92));
      peelTxLeft = -peel;
      peelTxRight = peel;
      peelCenterScale = reducedMotion ? 1.02 : 1.1;
      peelCenterTy = reducedMotion ? -2 : -14;
    }
    }
  }

  syncDoctrineHandOverlap(doctrineTrack as HTMLElement, state);

  buttons.forEach((b) => {
    const i = Number(b.dataset.slotIndex);
    if (!Number.isFinite(i) || i < 0 || i >= DOCTRINE_SLOT_COUNT) return;
    if (b.classList.contains("slot--hand-collapsed")) return;
    b.classList.remove("hand-slot--peek-focus", "hand-slot--peek-neighbor");
    const lift = b.classList.contains("active") ? HAND_ACTIVE_LIFT : 0;
    let sx = 0;
    let sy = -lift;

    if (peekIdx !== null && i === peelLeftIdx) sx += peelTxLeft;
    if (peekIdx !== null && i === peelRightIdx) sx += peelTxRight;
    if (peekIdx !== null && i === peelAboveIdx) sy += peelTyAbove;
    if (peekIdx !== null && i === peelBelowIdx) sy += peelTyBelow;

    let sc = 1;
    if (peekIdx !== null && i === peekIdx) {
      sy += peelCenterTy;
      sc = peelCenterScale;
      b.classList.add("hand-slot--peek-focus");
    } else if (
      peekIdx !== null &&
      (i === peelLeftIdx || i === peelRightIdx || i === peelAboveIdx || i === peelBelowIdx)
    ) {
      b.classList.add("hand-slot--peek-neighbor");
    }

    if (isDeck2x8) {
      if (sx !== 0 || sy !== 0 || sc !== 1) {
        b.style.setProperty("--peel-tx", `${sx}px`);
        b.style.setProperty("--peel-ty", `${sy}px`);
        b.style.setProperty("--peel-sc", String(sc));
      } else {
        b.style.removeProperty("--peel-tx");
        b.style.removeProperty("--peel-ty");
        b.style.removeProperty("--peel-sc");
      }
    } else {
      b.style.transform =
        sx !== 0 || sy !== 0 || sc !== 1 ? `translate(${sx}px, ${sy}px) scale(${sc})` : "";
    }

    if (isDeck2x8) {
      b.style.removeProperty("z-index");
      if (peekIdx !== null && i === peekIdx) b.style.setProperty("z-index", "380");
      else if (
        peekIdx !== null &&
        (i === peelLeftIdx || i === peelRightIdx || i === peelAboveIdx || i === peelBelowIdx)
      )
        b.style.setProperty("z-index", "320");
      else if (b.classList.contains("active")) b.style.setProperty("z-index", "260");
    } else {
      let z = 40 + i;
      if (peekIdx !== null && i === peekIdx) z = 340;
      else if (
        peekIdx !== null &&
        (i === peelLeftIdx || i === peelRightIdx || i === peelAboveIdx || i === peelBelowIdx)
      )
        z = 282;
      else if (b.classList.contains("active")) z = 240;
      b.style.zIndex = String(z);
    }
  });
}

export function attachDoctrineHandPeek(track: HTMLElement, getDragBusy: () => boolean): void {
  const clear = (): void => {
    track.removeAttribute("data-hand-peek");
  };
  const setPeek = (idx: number | null): void => {
    if (getDragBusy()) {
      clear();
      return;
    }
    if (idx === null || !Number.isFinite(idx)) clear();
    else track.setAttribute("data-hand-peek", String(idx));
  };
  track.addEventListener(
    "pointerenter",
    (ev: PointerEvent) => {
      const slot = (ev.target as HTMLElement | null)?.closest?.("[data-slot-index]") as HTMLElement | null;
      if (!slot || !track.contains(slot)) return;
      if (slot.classList.contains("slot--hand-collapsed")) return;
      const i = Number(slot.dataset.slotIndex);
      if (!Number.isFinite(i)) return;
      setPeek(i);
    },
    true,
  );
  track.addEventListener("pointerleave", (ev: PointerEvent) => {
    const rel = ev.relatedTarget as Node | null;
    if (rel && track.contains(rel)) return;
    clear();
  });
}
