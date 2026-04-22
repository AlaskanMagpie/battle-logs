import { getCatalogEntry } from "../game/catalog";
import { DOCTRINE_HAND_ROW_SIZE, DOCTRINE_SLOT_COUNT, GLOBAL_POP_CAP, TICK_HZ } from "../game/constants";
import type { PlayerIntent } from "../game/intents";
import {
  claimedTapCount,
  findKeep,
  placementFailureReason,
  signalCountsSatisfied,
  tierRequirementSatisfied,
  totalPlayerPop,
  wizardTier,
  type GameState,
} from "../game/state";
import { getGameLogLines } from "../game/gameLog";
import { isStructureEntry } from "../game/types";
import {
  CARD_PREVIEW_HOVER_MS,
  onDoctrineCardPreviewHoverLeave,
  showDoctrineCardDetail,
} from "./cardDetailPop";
import { hydrateCardPreviewImages } from "./cardGlbPreview";
import { doctrineCardBody } from "./doctrineCard";

const HAND_ACTIVE_LIFT = 5;

/** Half angular span (rad) from end to end across one fanned row — higher = less overlap. */
const ARC_ALPHA_MAX = 0.42;
const ARC_ALPHA_MIN = 0.12;
const ARC_PAD_X = 10;
const ARC_SLOT_COUNT = DOCTRINE_HAND_ROW_SIZE;

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

  if (track.classList.contains("doctrine-track--deck2x8")) {
    layoutDoctrineDeckArc(track);
    return;
  }

  let n = 0;
  for (let i = 0; i < DOCTRINE_SLOT_COUNT; i++) {
    const id = state.doctrineSlotCatalogIds[i] ?? null;
    if (id && getCatalogEntry(id)) n++;
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
  const reveal = Math.max(12, Math.min(cw, idealReveal));
  track.style.setProperty("--hand-reveal", `${reveal}px`);
}

export type HudIntentSink = (intent: PlayerIntent) => void;

export type HudMountApi = {
  onRematch?: () => void;
  onEditDoctrine?: () => void;
  pushIntent: HudIntentSink;
};

function keepHpSummary(state: GameState): string {
  const keep = findKeep(state);
  if (!keep) return "Keep: —";
  const pct = Math.max(0, Math.round((keep.hp / Math.max(1, keep.maxHp)) * 100));
  return `Keep HP: ${pct}%`;
}

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
    return "Claim a Mana node — walk your Wizard onto a grey ring and stand still; left-click attacks when idle.";
  if (playerTowers.length === 0) return "Drag a tower card into your cyan territory to summon it.";
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
  return "Push toward a red Dark Fortress — shatter them to win.";
}

function campCoreSummary(state: GameState): string {
  const bits: string[] = [];
  for (const c of state.map.enemyCamps) {
    if (!(typeof c.coreMaxHp === "number" && c.coreMaxHp > 0)) continue;
    const hp = state.enemyCampCoreHp[c.id];
    if (hp === undefined) continue;
    bits.push(`${c.id.slice(0, 6)}… ${Math.max(0, Math.round(hp))}`);
  }
  return bits.length ? `Camp cores: ${bits.join(" · ")}` : "";
}

export function mountHud(root: HTMLElement, initial: GameState, api: HudMountApi): void {
  const { onRematch, onEditDoctrine, pushIntent } = api;
  root.innerHTML = `
    <div class="hud-top">
      <div>Mana: <strong id="flux">0</strong></div>
      <div>Salvage: <strong id="salvage">0</strong></div>
      <div>Pop: <strong id="pop">0</strong> / ${GLOBAL_POP_CAP}</div>
      <div>Tier: <strong id="tier">1</strong></div>
      <div>Nodes: <strong id="nodes">0</strong></div>
      <div>Mode: <strong id="mode">idle</strong></div>
    </div>
    <div class="hud-readout" id="hud-readout"></div>
    <details class="hud-gamelog" id="hud-gamelog">
      <summary>Battle log</summary>
      <pre class="hud-gamelog-body" id="hud-gamelog-body"></pre>
    </details>
    <div class="hud-hero-hp" id="hud-hero-hp">Wizard: <span class="bar"><span class="bar-fill" id="hud-hero-hp-fill"></span></span><strong id="hud-hero-hp-val">100%</strong></div>
    <div class="hud-keep-hp" id="hud-keep-hp">Keep: <span class="bar"><span class="bar-fill" id="hud-keep-hp-fill"></span></span><strong id="hud-keep-hp-val">100%</strong></div>
    <div class="hud-objective" id="hud-objective" hidden><b>Objective</b><span id="hud-objective-text"></span></div>
    <div class="hud-select-tag" id="hud-select-tag" hidden></div>
    <div class="hud-phase" id="phase">playing</div>
    <div class="hud-msg" id="msg"></div>
    <div class="hud-actions">
      <button class="hud-btn" id="btn-rally" type="button" title="Arm rally point (R). Next LMB on the map sets where all units march in Offense; G clears march.">
        Rally map…
      </button>
      <button class="hud-btn hud-btn--stance" id="btn-stance" type="button" aria-pressed="false" title="Toggle army stance (G). Offense: engage nearby foes. Defense: gather on the Wizard.">
        Stance: Offense
      </button>
    </div>
    <div class="hud-doctrine-hint">WASD + RMB move · MMB camera · LMB = wizard melee when not placing · troops auto-fight in weapon range · R then click = rally · drag a card to summon · Shift+click a finished friendly tower = free Muster (instant spawn) · Alt+click toggles Hold on a nearby tower · G = Offense/Defense</div>
    <div class="hud-endgame" id="hud-endgame" hidden>
      <div class="hud-endgame-panel">
        <h2 class="hud-endgame-title" id="hud-endgame-title">Match over</h2>
        <p class="hud-endgame-stats" id="hud-endgame-stats"></p>
        <div class="hud-endgame-actions">
          <button class="hud-btn hud-btn--primary" type="button" id="btn-rematch">Rematch</button>
          <button class="hud-btn" type="button" id="btn-edit-doctrine">Edit doctrine</button>
        </div>
      </div>
    </div>
    <div class="doctrine-wrap" id="doctrine-wrap">
      <div class="doctrine-view" id="doctrine-view">
        <div class="doctrine-track doctrine-track--hand doctrine-track--deck2x8" id="doctrine-track" role="grid" aria-label="Doctrine deck, two rows of five" aria-rowcount="2">
          <div class="doctrine-hand doctrine-hand--match doctrine-hand--upper" role="row" aria-rowindex="1"></div>
          <div class="doctrine-hand doctrine-hand--match doctrine-hand--lower" role="row" aria-rowindex="2"></div>
        </div>
      </div>
    </div>
  `;

  const doctrineTrack = root.querySelector("#doctrine-track") as HTMLDivElement;
  const handUpper = doctrineTrack.querySelector(".doctrine-hand--upper") as HTMLDivElement;
  const handLower = doctrineTrack.querySelector(".doctrine-hand--lower") as HTMLDivElement;

  for (let i = 0; i < DOCTRINE_SLOT_COUNT; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "slot";
    b.dataset.slotIndex = String(i);
    b.setAttribute("role", "gridcell");
    b.setAttribute("aria-rowindex", String(Math.floor(i / DOCTRINE_HAND_ROW_SIZE) + 1));
    b.setAttribute("aria-colindex", String((i % DOCTRINE_HAND_ROW_SIZE) + 1));
    b.setAttribute("aria-label", `Doctrine slot ${i + 1}`);
    const catalogId = initial.doctrineSlotCatalogIds[i] ?? null;
    b.innerHTML = `${doctrineCardBody(i, catalogId)}<div class="slot-live" id="slot-live-${i}"></div>`;
    (i < DOCTRINE_HAND_ROW_SIZE ? handUpper : handLower).appendChild(b);
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
  const tier = document.querySelector("#tier");
  const nodes = document.querySelector("#nodes");
  const mode = document.querySelector("#mode");
  const phase = document.querySelector("#phase");
  const msg = document.querySelector("#msg");
  if (flux) flux.textContent = String(Math.floor(state.flux));
  if (salvage) salvage.textContent = String(Math.floor(state.salvage));
  const popVal = totalPlayerPop(state);
  if (pop) {
    pop.textContent = String(popVal);
    const warnBand = Math.min(120, Math.max(8, Math.floor(GLOBAL_POP_CAP * 0.08)));
    const near = popVal >= GLOBAL_POP_CAP - warnBand;
    const full = popVal >= GLOBAL_POP_CAP;
    pop.classList.toggle("cap-warn", near && !full);
    pop.classList.toggle("cap-full", full);
  }
  if (tier) tier.textContent = String(wizardTier(state));
  if (nodes) nodes.textContent = String(claimedTapCount(state));
  if (mode) {
    mode.textContent = state.pendingPlacementCatalogId
      ? `placing:${state.pendingPlacementCatalogId}`
      : state.rallyClickPending
        ? "rally-click"
        : state.globalRallyActive && state.armyStance === "offense"
          ? "marching"
          : "idle";
  }
  if (phase) phase.textContent = `${state.phase} · tick ${state.tick}`;
  if (msg) msg.textContent = state.lastMessage;

  const stanceBtn = document.querySelector<HTMLButtonElement>("#btn-stance");
  if (stanceBtn) {
    const def = state.armyStance === "defense";
    stanceBtn.textContent = def ? "Stance: Defense" : "Stance: Offense";
    stanceBtn.setAttribute("aria-pressed", def ? "true" : "false");
    stanceBtn.classList.toggle("hud-btn--stance-defense", def);
  }

  const selTag = document.querySelector<HTMLElement>("#hud-select-tag");
  if (selTag) {
    let label = "";
    if (state.pendingPlacementCatalogId) {
      const e = getCatalogEntry(state.pendingPlacementCatalogId);
      if (e) label = `Selected: ${e.name}`;
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
    rallyBtn.textContent = state.rallyClickPending ? "Rally: click map" : "Rally map…";
    rallyBtn.setAttribute("aria-pressed", state.rallyClickPending ? "true" : "false");
    rallyBtn.classList.toggle("hud-btn--armed", state.rallyClickPending);
  }

  const readout = document.querySelector("#hud-readout");
  if (readout) {
    const coreLine = campCoreSummary(state);
    readout.innerHTML = `${keepHpSummary(state)} · Hostiles: <strong>${enemyCount(state)}</strong>${
      coreLine ? ` · ${coreLine}` : ""
    }`;
  }

  const logBody = document.querySelector("#hud-gamelog-body");
  if (logBody) {
    const lines = getGameLogLines();
    const tail = lines.slice(-14);
    logBody.textContent = tail.length
      ? tail.map((l) => `[${l.tick}] ${l.category}: ${l.message}`).join("\n")
      : "(no events yet)";
  }

  const objWrap = document.querySelector<HTMLElement>("#hud-objective");
  const objText = document.querySelector<HTMLElement>("#hud-objective-text");
  if (objWrap && objText) {
    if (state.phase === "playing") {
      objText.textContent = ` ${computeObjective(state)}`;
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
    heroHpVal.textContent = `${pct}%`;
  }

  const keepHpFill = document.querySelector<HTMLElement>("#hud-keep-hp-fill");
  const keepHpVal = document.querySelector<HTMLElement>("#hud-keep-hp-val");
  if (keepHpFill && keepHpVal) {
    const keep = findKeep(state);
    const frac = keep && keep.maxHp > 0 ? keep.hp / keep.maxHp : 0;
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    keepHpFill.style.width = `${pct}%`;
    keepHpVal.textContent = keep ? `${pct}%` : "—";
  }

  const end = document.querySelector("#hud-endgame") as HTMLElement | null;
  const endTitle = document.querySelector("#hud-endgame-title");
  const endStats = document.querySelector("#hud-endgame-stats");
  if (end && endTitle && endStats) {
    if (state.phase === "playing") {
      end.hidden = true;
      endTitle.textContent = "Match over";
      endStats.innerHTML = "";
    } else {
      end.hidden = false;
      endTitle.textContent = state.phase === "win" ? "Victory" : "Defeat";
      const mins = (state.tick / TICK_HZ / 60).toFixed(1);
      const st = state.stats;
      endStats.innerHTML = [
        ["Time", `${mins} min`],
        ["Structures built", st.structuresBuilt],
        ["Structures lost", st.structuresLost],
        ["Units produced", st.unitsProduced],
        ["Units lost", st.unitsLost],
        ["Enemy kills", st.enemyKills],
        ["Commands cast", st.commandsCast],
        ["Salvage recovered", Math.floor(st.salvageRecovered)],
      ]
        .map(([k, v]) => `<div><span>${k}</span><strong>${v}</strong></div>`)
        .join("");
    }
  }

  const doctrineTrack = document.querySelector("#doctrine-track");
  if (!doctrineTrack) return;
  const buttons = doctrineTrack.querySelectorAll<HTMLButtonElement>(".slot");
  const isDeck2x8 = doctrineTrack.classList.contains("doctrine-track--deck2x8");

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
      "slot-sigwarn",
      "slot-await-infra",
      "disabled",
      "slot--hand-collapsed",
      "slot--hand-pull",
    );
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
    };

    b.querySelector(".slot-dup-count")?.remove();

    if (!id) {
      b.classList.add("slot-empty");
      if (!isDeck2x8) b.classList.add("slot--hand-collapsed");
      if (live) live.textContent = "";
      b.title = "Empty slot — add a card in the pre-match deck builder.";
      clearHandLayout();
      return;
    }
    const e = getCatalogEntry(id);
    if (!e) {
      b.classList.add("slot-empty");
      if (!isDeck2x8) b.classList.add("slot--hand-collapsed");
      if (live) live.textContent = "";
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

    const cd = state.doctrineCooldownTicks[i] ?? 0;
    const locked = cd > 0;
    const tierOk = tierRequirementSatisfied(state, e);
    const sigOk = tierOk && signalCountsSatisfied(state, e);
    if (locked) b.classList.add("slot-locked");
    else if (!tierOk) b.classList.add("slot-await-infra");
    else if (!sigOk) b.classList.add("slot-sigwarn");
    else b.classList.add("slot-ready");

    if (live) {
      live.innerHTML = cd > 0 ? `CD <b>${(cd / TICK_HZ).toFixed(1)}s</b>` : "";
    }

    const reason = placementFailureReason(state, id, null, i);
    b.title = reason ?? "Drag onto the map to place.";
  });

  if (!isDeck2x8) {
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
    const peelGrid = reducedMotion ? 7 : 13;
    peelTxLeft = -peelGrid;
    peelTxRight = peelGrid;
    peelTyAbove = -peelGrid;
    peelTyBelow = peelGrid;
    peelCenterScale = reducedMotion ? 1.02 : 1.08;
    peelCenterTy = reducedMotion ? -2 : -10;

    if (isDeck2x8) {
      const row = Math.floor(peekIdx / DOCTRINE_HAND_ROW_SIZE);
      const col = peekIdx % DOCTRINE_HAND_ROW_SIZE;
      const vis = (j: number) => (visibleIdx.includes(j) ? j : null);
      peelLeftIdx = col > 0 ? vis(peekIdx - 1) : null;
      peelRightIdx = col < DOCTRINE_HAND_ROW_SIZE - 1 ? vis(peekIdx + 1) : null;
      peelAboveIdx = row > 0 ? vis(peekIdx - DOCTRINE_HAND_ROW_SIZE) : null;
      peelBelowIdx = row < 1 ? vis(peekIdx + DOCTRINE_HAND_ROW_SIZE) : null;
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
