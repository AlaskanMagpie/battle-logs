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
  CARD_PREVIEW_HOVER_MS,
  onDoctrineCardPreviewHoverLeave,
  showDoctrineCardDetail,
} from "./cardDetailPop";
import type { ControlProfile } from "../controlProfile";
import { hydrateCardPreviewImages } from "./cardGlbPreview";
import { doctrineSlotButtonInnerHtml } from "./doctrineCard";
import { doctrineSlotHudTone } from "./doctrineSlotHudTone";
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

export function mountHud(root: HTMLElement, initial: GameState, api: HudMountApi): void {
  const { controlProfile, onRematch, onEditDoctrine, onCameraFollowToggle, pushIntent } = api;
  root.dataset.controlProfile = controlProfile?.mode ?? "desktop";
  root.innerHTML = `
    <header class="hud-chrome" aria-label="Match status">
      <aside class="hud-match-side-controls" aria-label="Commands and battle log">
        <button class="hud-btn hud-btn--ghost hud-btn--side-art" id="btn-rally" type="button" title="Arm rally point (R). Next LMB on the map sets where all units march in Offense; G clears march.">
          <span class="hud-side-sprite hud-side-sprite--rally" aria-hidden="true"></span>
          <span class="hud-side-copy"><span class="hud-side-eyebrow">Rally</span><b>Map</b></span>
        </button>
        <button class="hud-btn hud-btn--ghost hud-btn--stance hud-btn--side-art" id="btn-stance" type="button" aria-pressed="false" title="Toggle army stance (G). Offense: engage nearby foes. Defense: gather on the Wizard.">
          <span class="hud-side-sprite hud-side-sprite--stance" aria-hidden="true"></span>
          <span class="hud-side-copy"><span class="hud-side-eyebrow">Stance</span><b>Offense</b></span>
        </button>
        <button class="hud-btn hud-btn--ghost hud-btn--side-art" id="btn-formation" type="button" title="Cycle RMB-drag formation (V). Drag RMB with squads selected to set the line; hold Shift for wider ranks.">
          <span class="hud-side-sprite hud-side-sprite--formation" aria-hidden="true"></span>
          <span class="hud-side-copy"><span class="hud-side-eyebrow">Formation</span><b>Line</b></span>
        </button>
        <button
          class="hud-btn hud-btn--ghost hud-btn--side-art"
          id="btn-camera-follow"
          type="button"
          aria-pressed="true"
          title="Lock camera on wizard (scroll to zoom only) vs free orbit. Same as C."
        >
          <span class="hud-side-sprite hud-side-sprite--camera" aria-hidden="true"></span>
          <span class="hud-side-copy"><span class="hud-side-eyebrow">Camera</span><b>lock</b></span>
        </button>
        <button class="hud-btn hud-btn--ghost hud-btn--side-art" id="btn-teleport" type="button" aria-pressed="false" title="Teleport Wizard squad (T). Click your half; carries nearby friendly troops.">
          <span class="hud-side-sprite hud-side-sprite--teleport" aria-hidden="true"></span>
          <span class="hud-side-copy"><span class="hud-side-eyebrow">Teleport</span><b>Ready</b></span>
        </button>
        <button class="hud-btn hud-btn--ghost" id="btn-captain" type="button" aria-pressed="${initial.heroCaptainEnabled ? "true" : "false"}" title="Captain mode: the Wizard picks nearby objectives when idle. Default on for mobile.">
          <span class="hud-side-ico hud-side-ico--captain" aria-hidden="true"><i></i><em>A</em></span><span class="hud-side-copy"><span class="hud-side-eyebrow">Captain</span><b>${initial.heroCaptainEnabled ? "auto" : "manual"}</b></span>
        </button>
      </aside>
      <div class="hud-brand" aria-hidden="true"><span class="hud-brand__mark">A</span></div>
      <div class="hud-chrome__cluster hud-chrome__cluster--main">
        <div class="hud-chrome__stats">
          <span class="hud-stat hud-stat--econ hud-stat--mana"><span class="hud-stat__ico" aria-hidden="true"></span><span class="hud-stat__txt"><span>Mana</span><strong id="flux">0</strong></span></span>
          <span class="hud-stat hud-stat--econ hud-stat--salvage"><span class="hud-stat__ico" aria-hidden="true"></span><span class="hud-stat__txt"><span>Salvage</span><strong id="salvage">0</strong></span></span>
          <span class="hud-stat hud-stat--econ hud-stat--pop"><span class="hud-stat__ico" aria-hidden="true"></span><span class="hud-stat__txt"><span>Pop</span><strong id="pop">0</strong></span></span>
          <span class="hud-stat hud-stat--field hud-stat--nodes"><span class="hud-stat__ico" aria-hidden="true"></span><span class="hud-stat__txt"><span>Nodes</span><strong id="nodes">0</strong></span></span>
          <span class="hud-stat hud-stat--mode"><span class="hud-stat__txt"><span>Mode</span><strong id="mode">idle</strong></span></span>
        </div>
        <div class="hud-chrome__phase" id="phase">playing · tick 0</div>
      </div>
      <div class="hud-chrome__cluster hud-chrome__cluster--status">
        <div class="hud-chrome__readout hud-status-card hud-status-card--hostiles" id="hud-readout" aria-label="Enemy intelligence"></div>
        <div class="hud-chrome__vitals">
          <div class="hud-vital hud-status-card" id="hud-hero-hp"><span class="hud-vital__ico" aria-hidden="true">W</span><span class="hud-vital__lbl">Wizard</span><span class="bar"><span class="bar-fill" id="hud-hero-hp-fill"></span></span><strong id="hud-hero-hp-val">100%</strong></div>
          <div class="hud-vital hud-status-card" id="hud-keep-hp"><span class="hud-vital__ico" aria-hidden="true">K</span><span class="hud-vital__lbl">Keep</span><span class="bar"><span class="bar-fill" id="hud-keep-hp-fill"></span></span><strong id="hud-keep-hp-val">100%</strong></div>
        </div>
      </div>
      <div class="hud-chrome__objective" id="hud-objective" hidden role="status">
        <span class="hud-chrome__objective-icon" aria-hidden="true"></span>
        <span class="hud-chrome__objective-body"><span class="hud-chrome__objective-k">Next</span><span class="hud-chrome__objective-t" id="hud-objective-text"></span></span>
      </div>
      <div class="hud-select-tag" id="hud-select-tag" hidden></div>
    </header>
    <div class="hud-endgame" id="hud-endgame" hidden>
      <div class="hud-endgame-panel">
        <img class="hud-endgame-art" id="hud-endgame-art" src="/assets/hud/end-victory.png" alt="" />
        <h2 class="hud-endgame-title sr-only" id="hud-endgame-title">Match over</h2>
        <dl class="hud-endgame-stats" id="hud-endgame-stats" aria-label="Match results">
          <div class="hud-endgame-stat hud-endgame-stat--time"><dt>Time</dt><dd id="hud-endgame-stat-time">—</dd></div>
          <div class="hud-endgame-stat hud-endgame-stat--score"><dt>Score</dt><dd id="hud-endgame-stat-score">—</dd></div>
          <div class="hud-endgame-stat hud-endgame-stat--best"><dt>Best local</dt><dd id="hud-endgame-stat-best">—</dd></div>
          <div class="hud-endgame-stat hud-endgame-stat--structures-built"><dt>Structures you built</dt><dd id="hud-endgame-stat-structures-built">—</dd></div>
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

  let doctrineHoverTimer: ReturnType<typeof setTimeout> | null = null;
  let doctrineHoverId: string | null = null;
  const clearDoctrineHover = (): void => {
    if (doctrineHoverTimer) clearTimeout(doctrineHoverTimer);
    doctrineHoverTimer = null;
    doctrineHoverId = null;
  };
  doctrineTrack.addEventListener("mouseover", (ev) => {
    if (!(ev.target instanceof Element)) return;
    const slot = ev.target.closest(".slot");
    if (!(slot instanceof HTMLElement) || !doctrineTrack.contains(slot)) return;
    if (slot.classList.contains("slot-empty") || slot.classList.contains("slot-locked")) return;
    const card = slot.querySelector(".doctrine-card-compact[data-catalog-id]");
    const id = card?.getAttribute("data-catalog-id");
    if (!id) return;
    if (doctrineHoverId === id) return;
    clearDoctrineHover();
    doctrineHoverId = id;
    doctrineHoverTimer = setTimeout(() => {
      doctrineHoverTimer = null;
      showDoctrineCardDetail(id, { fromHover: true, hoverSourceEl: slot });
    }, CARD_PREVIEW_HOVER_MS);
  });
  doctrineTrack.addEventListener("mouseout", (ev) => {
    if (!(ev.target instanceof Element)) return;
    const slot = ev.target.closest(".slot");
    if (!(slot instanceof HTMLElement) || !doctrineTrack.contains(slot)) return;
    const rel = ev.relatedTarget;
    if (rel instanceof Node && slot.contains(rel)) return;
    clearDoctrineHover();
    onDoctrineCardPreviewHoverLeave(ev);
  });

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
  const phase = document.querySelector("#phase");
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
  if (phase) {
    const dp = Math.round(state.stats.damageDealtPlayer);
    const de = Math.round(state.stats.damageDealtEnemy);
    if (state.phase === "playing") {
      const sec = Math.max(0, (MATCH_DURATION_TICKS - state.tick) / TICK_HZ);
      phase.textContent = `${state.phase} · ${sec.toFixed(0)}s · ${dp}↔${de} dmg`;
    } else {
      phase.textContent = `${state.phase} · tick ${state.tick} · ${dp}↔${de} dmg`;
    }
  }
  if (captain) {
    captain.setAttribute("aria-pressed", state.heroCaptainEnabled ? "true" : "false");
    const copy = captain.querySelector<HTMLElement>(".hud-side-copy b");
    if (copy) copy.textContent = state.heroCaptainEnabled ? "auto" : "manual";
    captain.classList.toggle("active", state.heroCaptainEnabled);
  }
  if (msg) msg.textContent = state.lastMessage;

  const stanceBtn = document.querySelector<HTMLButtonElement>("#btn-stance");
  if (stanceBtn) {
    const def = state.armyStance === "defense";
    const copy = stanceBtn.querySelector<HTMLElement>(".hud-side-copy b");
    if (copy) copy.textContent = def ? "Defense" : "Offense";
    stanceBtn.setAttribute("aria-pressed", def ? "true" : "false");
    stanceBtn.classList.toggle("hud-btn--stance-defense", def);
  }

  const formationBtn = document.querySelector<HTMLButtonElement>("#btn-formation");
  if (formationBtn) {
    const copy = formationBtn.querySelector<HTMLElement>(".hud-side-copy b");
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
    const copy = rallyBtn.querySelector<HTMLElement>(".hud-side-copy b");
    if (copy) copy.textContent = state.rallyClickPending ? "Click map" : "Map";
    rallyBtn.setAttribute("aria-pressed", state.rallyClickPending ? "true" : "false");
    rallyBtn.classList.toggle("hud-btn--armed", state.rallyClickPending);
  }

  const teleportBtn = document.querySelector<HTMLButtonElement>("#btn-teleport");
  if (teleportBtn) {
    const cd = heroTeleportCooldownSeconds(state);
    const cooling = state.heroTeleportCooldownTicks > 0;
    const copy = teleportBtn.querySelector<HTMLElement>(".hud-side-copy b");
    if (copy) copy.textContent = cooling ? `${cd}s` : state.teleportClickPending ? "Click" : "Ready";
    teleportBtn.disabled = cooling;
    teleportBtn.setAttribute("aria-pressed", state.teleportClickPending ? "true" : "false");
    teleportBtn.classList.toggle("hud-btn--armed", state.teleportClickPending);
  }

  const readout = document.querySelector("#hud-readout");
  if (readout) {
    const coreLine = campCoreSummary(state);
    const n = enemyCount(state);
    readout.innerHTML = `<span class="hud-status-card__ico" aria-hidden="true">!</span><span class="hud-readout__body"><span class="hud-readout__hostiles">Hostiles <strong class="hud-ink-hostile">${n}</strong> alive</span>${
      coreLine
        ? ` <span class="hud-readout__sep" aria-hidden="true">·</span> <span class="hud-readout__camps"><span class="hud-readout__camps-k">Enemy camps</span> ${coreLine}</span>`
        : ""
    }</span>`;
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
  if (end && endTitle && endStats && endArt) {
    if (state.phase === "playing") {
      end.hidden = true;
      end.classList.remove("hud-endgame--win", "hud-endgame--lose");
      endTitle.textContent = "Match over";
    } else {
      const won = state.phase === "win";
      end.hidden = false;
      end.classList.toggle("hud-endgame--win", won);
      end.classList.toggle("hud-endgame--lose", !won);
      endTitle.textContent = won ? "Victory" : "Defeat";
      endArt.src = won ? "/assets/hud/end-victory.png" : "/assets/hud/end-defeat.png";
      const mins = (state.tick / TICK_HZ / 60).toFixed(1);
      const st = state.stats;
      const best = readLocalLeaderboard()[0];
      const setStat = (id: string, value: string | number): void => {
        const el = document.querySelector<HTMLElement>(`#hud-endgame-stat-${id}`);
        if (el) el.textContent = String(value);
      };
      setStat("time", `${mins} min`);
      setStat("score", scoreMatchResult(state));
      setStat("best", best ? best.score : "—");
      setStat("structures-built", st.structuresBuilt);
      setStat("structures-lost", st.structuresLost);
      setStat("units-produced", st.unitsProduced);
      setStat("units-lost", st.unitsLost);
      setStat("enemy-kills", st.enemyKills);
      setStat("commands-cast", st.commandsCast);
      setStat("salvage-recovered", Math.floor(st.salvageRecovered));
    }
  }

  const doctrineTrack = document.querySelector("#doctrine-track");
  if (!doctrineTrack) return;
  const buttons = doctrineTrack.querySelectorAll<HTMLButtonElement>(".slot");
  const isDeck2x8 = doctrineTrack.classList.contains("doctrine-track--deck2x8");
  const isDeck10 = doctrineTrack.classList.contains("doctrine-track--deck10");
  const isRail = doctrineTrack.classList.contains("doctrine-track--rail");

  const idTotalCount = new Map<string, number>();
  for (let i = 0; i < DOCTRINE_SLOT_COUNT; i++) {
    const id = state.doctrineSlotCatalogIds[i] ?? null;
    if (!id || !getCatalogEntry(id)) continue;
    idTotalCount.set(id, (idTotalCount.get(id) ?? 0) + 1);
  }

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

    const total = idTotalCount.get(id) ?? 1;
    if (total > 1) {
      const dup = document.createElement("span");
      dup.className = "slot-dup-count";
      dup.textContent = `x${total}`;
      b.appendChild(dup);
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
    b.dataset.slotTone = doctrineSlotHudTone(e);
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
