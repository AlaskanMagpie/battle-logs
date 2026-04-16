import { getCatalogEntry } from "../game/catalog";
import { GLOBAL_POP_CAP, TICK_HZ } from "../game/constants";
import type { PlayerIntent } from "../game/intents";
import { builtPlayerRelayCount, meetsSignalRequirements, totalPlayerPop, type GameState } from "../game/state";
import type { SignalType } from "../game/types";
import { doctrineCardBody } from "./doctrineCard";

export type HudIntentSink = (intent: PlayerIntent) => void;

export function mountHud(
  root: HTMLElement,
  initial: GameState,
  onClear: () => void,
  pushIntent: HudIntentSink,
): void {
  root.innerHTML = `
    <div class="hud-top">
      <div>Flux: <strong id="flux">0</strong></div>
      <div>Salvage: <strong id="salvage">0</strong></div>
      <div>Pop: <strong id="pop">0</strong> / ${GLOBAL_POP_CAP}</div>
      <div>Relays: <strong id="relays">0</strong></div>
      <div>Mode: <strong id="mode">idle</strong></div>
    </div>
    <div class="hud-phase" id="phase">playing</div>
    <div class="hud-msg" id="msg"></div>
    <div class="hud-actions">
      <button class="hud-btn" id="btn-orders" type="button" hidden>Orders: Rally</button>
      <button class="hud-btn" id="btn-clear" type="button">Clear placement</button>
    </div>
    <div class="hud-doctrine-hint">Drag a ready card onto the map to place / cast · short click selects · hold for full card</div>
    <div class="doctrine-wrap" id="doctrine-wrap">
      <div class="doctrine-view" id="doctrine-view">
        <div class="doctrine-track doctrine-track-grid-4x4" id="doctrine-track" role="grid" aria-label="Doctrine deck"></div>
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
    <div class="match-end-pop" id="match-end-pop" hidden>
      <div class="match-end-panel">
        <div class="match-end-title" id="match-end-title">—</div>
        <div class="match-end-sub" id="match-end-sub"></div>
        <div class="match-end-stats" id="match-end-stats"></div>
        <div class="match-end-actions">
          <button class="hud-btn" id="match-end-reload" type="button">Return to Doctrine</button>
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
    b.setAttribute("role", "gridcell");
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

  root.querySelector("#match-end-reload")!.addEventListener("click", () => {
    location.reload();
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

  // Orders toggle button visibility + state
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

  // Relay-signal picker visibility
  const relayPop = document.querySelector<HTMLElement>("#relay-signal-pop");
  if (relayPop) relayPop.hidden = state.pendingRelaySignalSlot === null;

  // End-game overlay
  const endPop = document.querySelector<HTMLElement>("#match-end-pop");
  if (endPop) {
    if (state.phase === "playing") {
      endPop.hidden = true;
    } else {
      endPop.hidden = false;
      const title = document.querySelector("#match-end-title");
      const sub = document.querySelector("#match-end-sub");
      const stats = document.querySelector("#match-end-stats");
      if (title) title.textContent = state.phase === "win" ? "Victory" : "Defeat";
      if (sub) sub.textContent = state.lastMessage;
      if (stats) {
        stats.innerHTML = [
          ["Structures built", state.stats.structuresBuilt],
          ["Structures lost", state.stats.structuresLost],
          ["Units produced", state.stats.unitsProduced],
          ["Units lost", state.stats.unitsLost],
          ["Enemy kills", state.stats.enemyKills],
          ["Salvage recovered", Math.floor(state.stats.salvageRecovered)],
        ]
          .map(([k, v]) => `<div><span>${k}</span><strong>${v}</strong></div>`)
          .join("");
      }
    }
  }

  const doctrineTrack = document.querySelector("#doctrine-track");
  if (!doctrineTrack) return;
  const buttons = doctrineTrack.querySelectorAll<HTMLButtonElement>(".slot");
  buttons.forEach((b, i) => {
    b.classList.remove("slot-empty", "slot-ready", "slot-locked", "slot-sigwarn", "disabled");
    const id = state.doctrineSlotCatalogIds[i] ?? null;
    const live = document.querySelector(`#slot-live-${i}`);
    if (!id) {
      b.classList.add("slot-empty");
      if (live) live.textContent = "";
      b.title = "Empty slot — add a card in the pre-match deck builder.";
      return;
    }
    const e = getCatalogEntry(id);
    if (!e) {
      b.classList.add("slot-empty");
      if (live) live.textContent = "";
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
        : "Ready — drag to the map to place / cast, or click once to arm then click the map.";
  });
}
