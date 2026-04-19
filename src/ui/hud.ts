import { getCatalogEntry } from "../game/catalog";
import { GLOBAL_POP_CAP, TICK_HZ } from "../game/constants";
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
import { doctrineCardBody } from "./doctrineCard";

const HAND_ACTIVE_LIFT = 5;

/** Sizes the fanned overlap so every visible card fits flat in the tray with no clipping. */
function syncDoctrineHandOverlap(track: HTMLElement, state: GameState): void {
  if (!track.classList.contains("doctrine-track--hand")) return;

  if (track.classList.contains("doctrine-track--deck2x8")) {
    track.style.removeProperty("--hand-reveal");
    return;
  }

  let n = 0;
  for (let i = 0; i < 16; i++) {
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
  onClear: () => void;
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
  const tier = wizardTier(state);
  const playerStructs = state.structures.filter((s) => s.team === "player");
  const playerTowers = playerStructs.filter((s) => {
    const e = getCatalogEntry(s.catalogId);
    return e && isStructureEntry(e) && s.catalogId !== "wizard_keep";
  });
  const playerUnits = state.units.filter((u) => u.team === "player" && u.hp > 0);

  if (state.phase === "setup") {
    if (claimedNodes === 0)
      return "Setup: WASD or right-click to move; stand on a grey Mana ring to claim (no click-to-claim).";
    if (playerTowers.length === 0) return "Setup: drag a tower card into your cyan territory — it arrives with a flash of lightning.";
    return `Setup: Tier ${tier} · ${claimedNodes} Mana node${claimedNodes === 1 ? "" : "s"} claimed. Start Battle when ready.`;
  }

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
  const { onClear, onRematch, onEditDoctrine, pushIntent } = api;
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
      <button class="hud-btn hud-btn--start" id="btn-start-battle" type="button" hidden title="Begin combat. Enemy camps wake up and the battle begins.">
        Start Battle
      </button>
      <button class="hud-btn" id="btn-orders" type="button" hidden>Orders: Rally</button>
      <button class="hud-btn hud-btn--stance" id="btn-stance" type="button" aria-pressed="false" title="Toggle army stance (G). Offense: engage nearby foes. Defense: gather on the Wizard.">
        Stance: Offense
      </button>
      <button class="hud-btn" id="btn-clear" type="button">Clear placement</button>
    </div>
    <div class="hud-doctrine-hint">WASD + RMB move · MMB camera · LMB strike when not placing · drag a card to summon · Alt+click toggles hold on nearby units · G toggles Offense/Defense</div>
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
        <div class="doctrine-track doctrine-track--hand doctrine-track--deck2x8" id="doctrine-track" role="grid" aria-label="Doctrine deck, two by eight"></div>
      </div>
    </div>
  `;

  const doctrineTrack = root.querySelector("#doctrine-track") as HTMLDivElement;

  for (let i = 0; i < 16; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "slot";
    b.dataset.slotIndex = String(i);
    b.setAttribute("role", "gridcell");
    const catalogId = initial.doctrineSlotCatalogIds[i] ?? null;
    b.innerHTML = `${doctrineCardBody(i, catalogId)}<div class="slot-live" id="slot-live-${i}"></div>`;
    doctrineTrack.appendChild(b);
  }

  root.querySelector("#btn-clear")!.addEventListener("click", () => {
    onClear();
    for (const el of doctrineTrack.querySelectorAll(".slot")) el.classList.remove("active");
  });

  root.querySelector("#btn-start-battle")!.addEventListener("click", () => {
    pushIntent({ type: "start_battle" });
  });

  root.querySelector("#btn-orders")!.addEventListener("click", () => {
    const btn = root.querySelector<HTMLButtonElement>("#btn-orders");
    if (!btn) return;
    const id = Number(btn.dataset.structureId ?? "");
    if (!Number.isFinite(id)) return;
    pushIntent({ type: "toggle_structure_orders", structureId: id });
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
    const near = popVal >= GLOBAL_POP_CAP - 4;
    const full = popVal >= GLOBAL_POP_CAP;
    pop.classList.toggle("cap-warn", near && !full);
    pop.classList.toggle("cap-full", full);
  }
  if (tier) tier.textContent = String(wizardTier(state));
  if (nodes) nodes.textContent = String(claimedTapCount(state));
  if (mode) {
    mode.textContent = state.pendingPlacementCatalogId
      ? `placing:${state.pendingPlacementCatalogId}`
      : state.selectedStructureId !== null
        ? "rally"
        : "idle";
  }
  if (phase) phase.textContent = `${state.phase} · tick ${state.tick}`;
  if (msg) msg.textContent = state.lastMessage;

  const startBtn = document.querySelector<HTMLButtonElement>("#btn-start-battle");
  if (startBtn) {
    if (state.phase === "setup") {
      startBtn.hidden = false;
      const ready = !!findKeep(state);
      startBtn.disabled = !ready;
      startBtn.classList.toggle("hud-btn--start-ready", ready);
      startBtn.textContent = ready ? "Start Battle" : "Start Battle (Keep missing)";
    } else {
      startBtn.hidden = true;
    }
  }

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
    } else if (state.selectedStructureId !== null) {
      const st = state.structures.find((x) => x.id === state.selectedStructureId);
      if (st) {
        const e = getCatalogEntry(st.catalogId);
        label = `Selected: ${e?.name ?? "Structure"} · ${st.holdOrders ? "Hold" : "Rally"}`;
      }
    }
    if (label) {
      selTag.textContent = label;
      selTag.hidden = false;
    } else {
      selTag.hidden = true;
    }
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
    if (state.phase === "playing" || state.phase === "setup") {
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

  const ordersBtn = document.querySelector<HTMLButtonElement>("#btn-orders");
  if (ordersBtn) {
    if (state.selectedStructureId !== null) {
      const st = state.structures.find((x) => x.id === state.selectedStructureId);
      if (st && st.team === "player" && st.complete && st.catalogId !== "wizard_keep") {
        ordersBtn.hidden = false;
        ordersBtn.dataset.structureId = String(st.id);
        ordersBtn.textContent = st.holdOrders ? "Orders: Hold" : "Orders: Rally";
      } else {
        ordersBtn.hidden = true;
      }
    } else {
      ordersBtn.hidden = true;
    }
  }

  const end = document.querySelector("#hud-endgame") as HTMLElement | null;
  const endTitle = document.querySelector("#hud-endgame-title");
  const endStats = document.querySelector("#hud-endgame-stats");
  if (end && endTitle && endStats) {
    if (state.phase === "playing" || state.phase === "setup") {
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
  for (let i = 0; i < 16; i++) {
    const id = state.doctrineSlotCatalogIds[i] ?? null;
    if (!id || !getCatalogEntry(id)) continue;
    idTotalCount.set(id, (idTotalCount.get(id) ?? 0) + 1);
  }

  buttons.forEach((b) => {
    const i = Number(b.dataset.slotIndex);
    if (!Number.isFinite(i) || i < 0 || i > 15) return;

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
    const ch = state.doctrineChargesRemaining[i] ?? 0;
    const locked = cd > 0 || ch <= 0;
    const tierOk = tierRequirementSatisfied(state, e);
    const sigOk = tierOk && signalCountsSatisfied(state, e);
    if (locked) b.classList.add("slot-locked");
    else if (!tierOk) b.classList.add("slot-await-infra");
    else if (!sigOk) b.classList.add("slot-sigwarn");
    else b.classList.add("slot-ready");

    if (live) {
      const parts: string[] = [];
      parts.push(`Charges <b>${ch}</b>`);
      if (cd > 0) parts.push(`CD <b>${(cd / TICK_HZ).toFixed(1)}s</b>`);
      if (!tierOk) {
        const need = Math.max(1, e.requiredRelayTier || 1);
        const tapsNeeded = need === 2 ? 2 : 4;
        parts.push(`<span class="live-info">Needs Tier ${need} (${tapsNeeded} nodes)</span>`);
      }
      live.innerHTML = parts.join(" · ");
    }

    const reason = placementFailureReason(state, id, null, i);
    b.title = reason ?? "Ready — drag onto the map to summon with lightning.";
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
    if (!Number.isFinite(si) || si < 0 || si > 15) return;
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
      const row = Math.floor(peekIdx / 8);
      const col = peekIdx % 8;
      const vis = (j: number) => (visibleIdx.includes(j) ? j : null);
      peelLeftIdx = col > 0 ? vis(peekIdx - 1) : null;
      peelRightIdx = col < 7 ? vis(peekIdx + 1) : null;
      peelAboveIdx = row > 0 ? vis(peekIdx - 8) : null;
      peelBelowIdx = row < 1 ? vis(peekIdx + 8) : null;
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
    if (!Number.isFinite(i) || i < 0 || i > 15) return;
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

    b.style.transform =
      sx !== 0 || sy !== 0 || sc !== 1 ? `translate(${sx}px, ${sy}px) scale(${sc})` : "";

    let z = 40 + i;
    if (peekIdx !== null && i === peekIdx) z = 340;
    else if (
      peekIdx !== null &&
      (i === peelLeftIdx || i === peelRightIdx || i === peelAboveIdx || i === peelBelowIdx)
    )
      z = 282;
    else if (b.classList.contains("active")) z = 240;
    b.style.zIndex = String(z);
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
      if (!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
        queueMicrotask(() => slot.scrollIntoView({ inline: "center", block: "nearest", behavior: "auto" }));
      }
    },
    true,
  );
  track.addEventListener("pointerleave", (ev: PointerEvent) => {
    const rel = ev.relatedTarget as Node | null;
    if (rel && track.contains(rel)) return;
    clear();
  });
}
