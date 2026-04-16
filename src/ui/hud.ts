import { getCatalogEntry } from "../game/catalog";
import { GLOBAL_POP_CAP, TICK_HZ } from "../game/constants";
import type { PlayerIntent } from "../game/intents";
import {
  builtPlayerRelayCount,
  meetsSignalRequirements,
  totalPlayerPop,
  type GameState,
} from "../game/state";
import type { SignalType } from "../game/types";
import { doctrineCardBody } from "./doctrineCard";

const HAND_STACK_DY = 6;
const HAND_STACK_DX = 2;
const HAND_ACTIVE_LIFT = 5;

function syncDoctrineHandOverlap(track: HTMLElement, state: GameState): void {
  if (!track.classList.contains("doctrine-track--hand")) return;
  let n = 0;
  for (let i = 0; i < 16; i++) {
    const id = state.doctrineSlotCatalogIds[i] ?? null;
    if (id && getCatalogEntry(id)) n++;
  }
  if (n <= 1) {
    track.style.removeProperty("--hand-reveal");
    return;
  }
  const firstCard = track.querySelector(".slot:not(.slot--hand-collapsed) .doctrine-card-compact") as HTMLElement | null;
  const cw = firstCard?.getBoundingClientRect().width ?? 0;
  if (cw < 4) return;
  const pad = 48;
  const avail = Math.max(0, track.getBoundingClientRect().width - pad);
  const reveal = Math.max(6, Math.min(36, (avail - cw) / (n - 1)));
  track.style.setProperty("--hand-reveal", `${reveal}px`);
}

export type HudIntentSink = (intent: PlayerIntent) => void;

export type HudMountApi = {
  onClear: () => void;
  onRematch?: () => void;
  onEditDoctrine?: () => void;
  pushIntent: HudIntentSink;
};

function relayHpSummary(state: GameState): string {
  const built = state.playerRelays.filter((r) => r.built && !r.destroyed);
  if (built.length === 0) return "Relays HP: —";
  let worst = 1;
  for (const r of built) {
    const frac = r.maxHp > 0 ? r.hp / r.maxHp : 0;
    if (frac < worst) worst = frac;
  }
  return `Relays HP (lowest): ${Math.round(worst * 100)}%`;
}

function enemyCount(state: GameState): number {
  return state.units.filter((u) => u.team === "enemy" && u.hp > 0).length;
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
      <div>Flux: <strong id="flux">0</strong></div>
      <div>Salvage: <strong id="salvage">0</strong></div>
      <div>Pop: <strong id="pop">0</strong> / ${GLOBAL_POP_CAP}</div>
      <div>Relays: <strong id="relays">0</strong></div>
      <div>Mode: <strong id="mode">idle</strong></div>
    </div>
    <div class="hud-readout" id="hud-readout"></div>
    <div class="hud-phase" id="phase">playing</div>
    <div class="hud-msg" id="msg"></div>
    <div class="hud-actions">
      <button class="hud-btn" id="btn-orders" type="button" hidden>Orders: Rally</button>
      <button class="hud-btn" id="btn-relay-shift" type="button" aria-pressed="false" title="Arms the next map tap to count as Shift+click (cycle signal on a built relay). Same as holding Shift on desktop.">
        Relay shift
      </button>
      <button class="hud-btn" id="btn-clear" type="button">Clear placement</button>
    </div>
    <div class="hud-doctrine-hint">Drag a card onto the map to place / cast · tap to select · Alt+click toggles hold on nearby units · hold for full card · hover to fan open with neighbors · duplicates stack</div>
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
        <div class="doctrine-track doctrine-track--hand" id="doctrine-track" role="list" aria-label="Doctrine hand"></div>
      </div>
    </div>
    <div class="relay-signal-pop" id="relay-signal-pop" hidden>
      <div class="relay-signal-pop-panel" role="dialog" aria-modal="true" aria-label="Choose Relay Signal">
        <div class="relay-signal-pop-title">Choose Relay Signal</div>
        <div class="relay-signal-pop-row">
          <button class="relay-sig-btn relay-sig-Vanguard" data-signal="Vanguard" type="button">
            <span class="relay-sig-dot"></span><b>Vanguard</b><span>Aggro / speed</span>
          </button>
          <button class="relay-sig-btn relay-sig-Bastion" data-signal="Bastion" type="button">
            <span class="relay-sig-dot"></span><b>Bastion</b><span>Defense / armor</span>
          </button>
          <button class="relay-sig-btn relay-sig-Reclaim" data-signal="Reclaim" type="button">
            <span class="relay-sig-dot"></span><b>Reclaim</b><span>Heal / attrition</span>
          </button>
        </div>
        <div class="relay-signal-pop-actions">
          <button class="hud-btn" id="relay-sig-cancel" type="button">Cancel</button>
        </div>
      </div>
    </div>
  `;

  const doctrineTrack = root.querySelector("#doctrine-track") as HTMLDivElement;

  for (let i = 0; i < 16; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "slot";
    b.dataset.slotIndex = String(i);
    b.setAttribute("role", "listitem");
    const catalogId = initial.doctrineSlotCatalogIds[i] ?? null;
    b.innerHTML = `${doctrineCardBody(i, catalogId)}<div class="slot-live" id="slot-live-${i}"></div>`;
    doctrineTrack.appendChild(b);
  }

  root.querySelector("#btn-clear")!.addEventListener("click", () => {
    onClear();
    for (const el of doctrineTrack.querySelectorAll(".slot")) el.classList.remove("active");
  });

  root.querySelector("#btn-orders")!.addEventListener("click", () => {
    const btn = root.querySelector<HTMLButtonElement>("#btn-orders");
    if (!btn) return;
    const id = Number(btn.dataset.structureId ?? "");
    if (!Number.isFinite(id)) return;
    pushIntent({ type: "toggle_structure_orders", structureId: id });
  });

  root.querySelectorAll<HTMLButtonElement>(".relay-sig-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sig = btn.dataset.signal as SignalType | undefined;
      if (!sig) return;
      pushIntent({ type: "confirm_relay_signal", signal: sig });
    });
  });

  root.querySelector("#relay-sig-cancel")!.addEventListener("click", () => {
    pushIntent({ type: "cancel_relay_signal" });
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
  const relays = document.querySelector("#relays");
  const mode = document.querySelector("#mode");
  const phase = document.querySelector("#phase");
  const msg = document.querySelector("#msg");
  if (flux) flux.textContent = String(Math.floor(state.flux));
  if (salvage) salvage.textContent = String(Math.floor(state.salvage));
  if (pop) pop.textContent = String(totalPlayerPop(state));
  if (relays) relays.textContent = String(builtPlayerRelayCount(state));
  if (mode) {
    mode.textContent = state.pendingRelaySignalSlot !== null
      ? "relay signal"
      : state.pendingPlacementCatalogId
        ? `placing:${state.pendingPlacementCatalogId}`
        : state.selectedStructureId !== null
          ? "rally"
          : "idle";
  }
  if (phase) phase.textContent = `${state.phase} · tick ${state.tick}`;
  if (msg) msg.textContent = state.lastMessage;

  const readout = document.querySelector("#hud-readout");
  if (readout) {
    const coreLine = campCoreSummary(state);
    readout.innerHTML = `${relayHpSummary(state)} · Hostiles: <strong>${enemyCount(state)}</strong>${
      coreLine ? ` · ${coreLine}` : ""
    }`;
  }

  const ordersBtn = document.querySelector<HTMLButtonElement>("#btn-orders");
  if (ordersBtn) {
    if (state.selectedStructureId !== null) {
      const st = state.structures.find((x) => x.id === state.selectedStructureId);
      if (st && st.team === "player" && st.complete) {
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

  const relayPop = document.querySelector<HTMLElement>("#relay-signal-pop");
  if (relayPop) relayPop.hidden = state.pendingRelaySignalSlot === null;

  const end = document.querySelector("#hud-endgame") as HTMLElement | null;
  const endTitle = document.querySelector("#hud-endgame-title");
  const endStats = document.querySelector("#hud-endgame-stats");
  if (end && endTitle && endStats) {
    if (state.phase === "playing") {
      end.hidden = true;
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

  const stackDepth: number[] = new Array(16).fill(0);
  const idRun = new Map<string, number>();
  for (let i = 0; i < 16; i++) {
    const id = state.doctrineSlotCatalogIds[i] ?? null;
    if (!id || !getCatalogEntry(id)) continue;
    stackDepth[i] = idRun.get(id) ?? 0;
    idRun.set(id, (idRun.get(id) ?? 0) + 1);
  }

  buttons.forEach((b, i) => {
    b.classList.remove("slot-empty", "slot-ready", "slot-locked", "slot-sigwarn", "disabled", "slot--hand-collapsed", "slot--hand-pull");
    const id = state.doctrineSlotCatalogIds[i] ?? null;
    const live = document.querySelector(`#slot-live-${i}`);

    const clearHandLayout = (): void => {
      b.style.transform = "";
      b.style.zIndex = "";
    };

    if (!id) {
      b.classList.add("slot-empty", "slot--hand-collapsed");
      if (live) live.textContent = "";
      b.title = "Empty slot — add a card in the pre-match deck builder.";
      clearHandLayout();
      return;
    }
    const e = getCatalogEntry(id);
    if (!e) {
      b.classList.add("slot-empty", "slot--hand-collapsed");
      if (live) live.textContent = "";
      clearHandLayout();
      return;
    }
    const cd = state.doctrineCooldownTicks[i] ?? 0;
    const ch = state.doctrineChargesRemaining[i] ?? 0;
    const locked = cd > 0 || ch <= 0;
    const sigOk = meetsSignalRequirements(state, e);
    if (locked) b.classList.add("slot-locked");
    else if (!sigOk) b.classList.add("slot-sigwarn");
    else b.classList.add("slot-ready");

    if (live) {
      const parts: string[] = [];
      parts.push(`Charges <b>${ch}</b>`);
      if (cd > 0) parts.push(`CD <b>${(cd / TICK_HZ).toFixed(1)}s</b>`);
      if (!sigOk) parts.push(`<span class="live-warn">Signals locked</span>`);
      live.innerHTML = parts.join(" · ");
    }

    b.title = locked
      ? cd > 0
        ? `Cooldown (${cd} ticks) — cannot play yet.`
        : "No charges — cannot play yet."
      : !sigOk
        ? "Relay / signal requirements not met — card is readable but play will fail until infrastructure matches."
        : "Ready — drag to the map to place / cast, or tap once to arm then tap the map.";
  });

  let seenFilled = false;
  buttons.forEach((b) => {
    if (b.classList.contains("slot--hand-collapsed")) return;
    if (!seenFilled) {
      seenFilled = true;
      return;
    }
    b.classList.add("slot--hand-pull");
  });

  const rawPeek = doctrineTrack.getAttribute("data-hand-peek");
  const peekIdx =
    rawPeek !== null && rawPeek !== "" && Number.isFinite(Number(rawPeek)) ? Number(rawPeek) : null;

  const visibleIdx: number[] = [];
  buttons.forEach((b, i) => {
    if (!b.classList.contains("slot--hand-collapsed")) visibleIdx.push(i);
  });

  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

  let peelLeftIdx: number | null = null;
  let peelRightIdx: number | null = null;
  let peelTxLeft = 0;
  let peelTxRight = 0;
  let peelCenterScale = 1;
  let peelCenterTy = 0;
  if (peekIdx !== null && visibleIdx.includes(peekIdx)) {
    const pos = visibleIdx.indexOf(peekIdx);
    peelLeftIdx = pos > 0 ? visibleIdx[pos - 1]! : null;
    peelRightIdx = pos < visibleIdx.length - 1 ? visibleIdx[pos + 1]! : null;
    const sample = doctrineTrack.querySelector(
      ".slot:not(.slot--hand-collapsed) .doctrine-card-compact",
    ) as HTMLElement | null;
    const cardW = sample?.offsetWidth ?? 0;
    const revealParsed = Number.parseFloat(getComputedStyle(doctrineTrack).getPropertyValue("--hand-reveal").trim());
    const reveal = Number.isFinite(revealParsed) ? revealParsed : 14;
    const overlap = Math.max(0, cardW - reveal);
    const peel = reducedMotion ? Math.min(10, overlap * 0.2) : Math.max(20, Math.min(72, overlap * 0.92));
    peelTxLeft = -peel;
    peelTxRight = peel;
    peelCenterScale = reducedMotion ? 1.02 : 1.1;
    peelCenterTy = reducedMotion ? -2 : -14;
  }

  buttons.forEach((b, i) => {
    if (b.classList.contains("slot--hand-collapsed")) return;
    b.classList.remove("hand-slot--peek-focus", "hand-slot--peek-neighbor");
    const d = stackDepth[i] ?? 0;
    const lift = b.classList.contains("active") ? HAND_ACTIVE_LIFT : 0;
    let sx = d * HAND_STACK_DX;
    const syBase = -d * HAND_STACK_DY - lift;

    if (peekIdx !== null && i === peelLeftIdx) sx += peelTxLeft;
    if (peekIdx !== null && i === peelRightIdx) sx += peelTxRight;

    let sy = syBase;
    let sc = 1;
    if (peekIdx !== null && i === peekIdx) {
      sy += peelCenterTy;
      sc = peelCenterScale;
      b.classList.add("hand-slot--peek-focus");
    } else if (peekIdx !== null && (i === peelLeftIdx || i === peelRightIdx)) {
      b.classList.add("hand-slot--peek-neighbor");
    }

    b.style.transform =
      sx !== 0 || sy !== 0 || sc !== 1 ? `translate(${sx}px, ${sy}px) scale(${sc})` : "";

    let z = 40 + i + d * 4;
    if (peekIdx !== null && i === peekIdx) z = 340;
    else if (peekIdx !== null && (i === peelLeftIdx || i === peelRightIdx)) z = 282;
    else if (b.classList.contains("active")) z = 240;
    b.style.zIndex = String(z);
  });

  queueMicrotask(() => syncDoctrineHandOverlap(doctrineTrack as HTMLElement, state));
}

/** Hover / pointer focus: sets `data-hand-peek` on the track; `updateHud` applies peel + highlight. */
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
