import { getCatalogEntry } from "../game/catalog";
import { GLOBAL_POP_CAP, TICK_HZ } from "../game/constants";
import { builtPlayerRelayCount, meetsSignalRequirements, totalPlayerPop, type GameState } from "../game/state";
import { doctrineCardBody } from "./doctrineCard";

export function mountHud(root: HTMLElement, initial: GameState, onClear: () => void): void {
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
      <button class="hud-btn" id="btn-clear" type="button">Clear placement</button>
    </div>
    <div class="hud-doctrine-hint">Drag a ready card onto the map to place / cast · short click selects · hold for full card</div>
    <div class="doctrine-wrap" id="doctrine-wrap">
      <div class="doctrine-view" id="doctrine-view">
        <div class="doctrine-track doctrine-track-grid-4x4" id="doctrine-track" role="grid" aria-label="Doctrine deck"></div>
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
    mode.textContent = state.pendingPlacementCatalogId
      ? `placing:${state.pendingPlacementCatalogId}`
      : state.selectedStructureId !== null
        ? "rally"
        : "idle";
  }
  if (phase) phase.textContent = `${state.phase} · tick ${state.tick}`;
  if (msg) msg.textContent = state.lastMessage;

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
