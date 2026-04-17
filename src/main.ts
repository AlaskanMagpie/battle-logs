import {
  commandEffectRadius,
  commandTargetingHint,
  getCatalogEntry,
} from "./game/catalog";
import { TICK_HZ } from "./game/constants";
import type { PlayerIntent } from "./game/intents";
import { loadMapMerged } from "./game/loadMap";
import {
  canPlaceStructureHere,
  createInitialState,
  placementFailureReason,
  type GameState,
} from "./game/state";
import { advanceTick } from "./game/sim/tick";
import { GameRenderer } from "./render/scene";
import { CARD_DETAIL_HOLD_MS, showDoctrineCardDetail } from "./ui/cardDetailPop";
import { doctrineCardGhostSummary } from "./ui/doctrineCard";
import {
  destroyDragGhost,
  DRAG_THRESHOLD_PX,
  makeDragGhost,
  moveDragGhost,
  pointInRect,
} from "./ui/doctrineDrag";
import { mountDoctrinePicker } from "./ui/doctrinePicker";
import { attachDoctrineHandPeek, mountHud, updateHud } from "./ui/hud";
import { showRulesToast } from "./ui/rulesToast";
import { isStructureEntry } from "./game/types";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const hudRoot = document.querySelector<HTMLElement>("#hud-root")!;
const pickerRoot = document.querySelector<HTMLElement>("#doctrine-picker")!;

function viewportCssSize(): { w: number; h: number } {
  const vv = window.visualViewport;
  if (vv) return { w: Math.max(1, vv.width), h: Math.max(1, vv.height) };
  return { w: Math.max(1, window.innerWidth), h: Math.max(1, window.innerHeight) };
}

function releasePointerSafe(el: Element, pointerId: number): void {
  try {
    if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
  } catch {
    /* ignore */
  }
}

/** GLB art on by default; set `VITE_USE_UNIT_GLB=false` to force cubes only. */
const USE_GLB = import.meta.env.VITE_USE_UNIT_GLB !== "false";

const DRAG_REASON_ID = "drag-reason";

function ensureDragReasonEl(): HTMLDivElement {
  let el = document.getElementById(DRAG_REASON_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement("div");
    el.id = DRAG_REASON_ID;
    el.className = "drag-reason";
    document.body.appendChild(el);
  }
  return el;
}

function hideDragReason(): void {
  const el = document.getElementById(DRAG_REASON_ID);
  if (el) el.remove();
}

function updateDragReason(
  clientX: number,
  clientY: number,
  text: string,
  ok: boolean,
): void {
  const el = ensureDragReasonEl();
  el.textContent = text;
  el.classList.toggle("drag-reason--ok", ok);
  el.classList.toggle("drag-reason--bad", !ok);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rect = el.getBoundingClientRect();
  const w = rect.width || 240;
  const h = rect.height || 32;
  let x = clientX + 18;
  let y = clientY + 22;
  if (x + w > vw - 8) x = clientX - w - 14;
  if (y + h > vh - 8) y = clientY - h - 14;
  el.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
}

function wireDoctrineDragToMap(
  canvas: HTMLCanvasElement,
  hudRoot: HTMLElement,
  getState: () => GameState,
  renderer: GameRenderer,
  pendingIntents: PlayerIntent[],
  onShortClickSelect: (index: number) => void,
  dragRef: { active: boolean },
  consumeRelayShiftChord: () => boolean,
): void {
  const doctrine = hudRoot.querySelector("#doctrine-track") as HTMLElement | null;
  if (!doctrine) return;

  let session: {
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
    slotIndex: number;
    catalogId: string;
    ghost: HTMLDivElement | null;
  } | null = null;

  let pending: {
    pointerId: number;
    startX: number;
    startY: number;
    slotIndex: number;
    catalogId: string;
    detailTimer: ReturnType<typeof setTimeout> | null;
    detailShown: boolean;
    captureEl: HTMLElement;
  } | null = null;

  function clearPending(): void {
    if (pending?.detailTimer) clearTimeout(pending.detailTimer);
    if (pending) releasePointerSafe(pending.captureEl, pending.pointerId);
    pending = null;
  }

  function onPendingMove(ev: PointerEvent): void {
    if (!pending || ev.pointerId !== pending.pointerId) return;
    const dx = ev.clientX - pending.startX;
    const dy = ev.clientY - pending.startY;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    if (pending.detailTimer) clearTimeout(pending.detailTimer);
    const snap = pending;
    pending = null;
    window.removeEventListener("pointermove", onPendingMove);
    window.removeEventListener("pointerup", onPendingUp);
    window.removeEventListener("pointercancel", onPendingUp);
    releasePointerSafe(snap.captureEl, snap.pointerId);
    session = {
      pointerId: snap.pointerId,
      startX: snap.startX,
      startY: snap.startY,
      dragging: false,
      slotIndex: snap.slotIndex,
      catalogId: snap.catalogId,
      ghost: null,
    };
    try {
      canvas.setPointerCapture(snap.pointerId);
    } catch {
      /* ignore */
    }
    window.addEventListener("pointermove", onWinMove);
    window.addEventListener("pointerup", onWinUp);
    window.addEventListener("pointercancel", onWinUp);
    onWinMove(ev);
  }

  function onPendingUp(ev: PointerEvent): void {
    if (!pending || ev.pointerId !== pending.pointerId) return;
    window.removeEventListener("pointermove", onPendingMove);
    window.removeEventListener("pointerup", onPendingUp);
    window.removeEventListener("pointercancel", onPendingUp);
    if (pending.detailTimer) clearTimeout(pending.detailTimer);
    const snap = pending;
    pending = null;
    releasePointerSafe(snap.captureEl, ev.pointerId);
    if (snap.detailShown) return;
    const dx = ev.clientX - snap.startX;
    const dy = ev.clientY - snap.startY;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) onShortClickSelect(snap.slotIndex);
  }

  function onWinMove(ev: PointerEvent): void {
    if (!session || ev.pointerId !== session.pointerId) return;
    const dx = ev.clientX - session.startX;
    const dy = ev.clientY - session.startY;
    const st = getState();
    if (!session.dragging && dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
      session.dragging = true;
      dragRef.active = true;
      hudRoot.querySelector("#doctrine-track")?.removeAttribute("data-hand-peek");
      renderer.setControlsEnabled(false);
      session.ghost = makeDragGhost(
        `<div class="ghost-compact">${doctrineCardGhostSummary(session.catalogId)}</div>`,
      );
    }
    if (!session.dragging || !session.ghost) return;
    moveDragGhost(session.ghost, ev.clientX, ev.clientY);

    const entry = getCatalogEntry(session.catalogId);
    const rect = canvas.getBoundingClientRect();
    const overCanvas = pointInRect(ev.clientX, ev.clientY, rect);
    const hit = overCanvas ? renderer.pickGround(ev.clientX, ev.clientY, rect) : null;

    if (!entry) {
      renderer.setPlacementGhost(null, false);
      renderer.setCommandGhost(null, null, false);
      updateDragReason(ev.clientX, ev.clientY, "Unknown card.", false);
      return;
    }

    if (isStructureEntry(entry)) {
      renderer.setCommandGhost(null, null, false);
      if (!hit) {
        renderer.setPlacementGhost(null, false);
        const reason = placementFailureReason(st, session.catalogId, null, session.slotIndex);
        updateDragReason(
          ev.clientX,
          ev.clientY,
          reason ?? "Drag onto the map to place.",
          reason === null,
        );
        return;
      }
      const reason = placementFailureReason(st, session.catalogId, hit, session.slotIndex);
      const valid = reason === null;
      renderer.setPlacementGhost(hit, valid);
      updateDragReason(
        ev.clientX,
        ev.clientY,
        reason ?? "Ready — release to build.",
        valid,
      );
      return;
    }

    // Command / spell card.
    renderer.setPlacementGhost(null, false);
    const radius = commandEffectRadius(entry);
    if (hit) {
      renderer.setCommandGhost(hit, radius, true);
    } else {
      renderer.setCommandGhost(null, null, false);
    }
    const hint = commandTargetingHint(entry);
    const warnings: string[] = [];
    const cdTicks = st.doctrineCooldownTicks[session.slotIndex] ?? 0;
    if (cdTicks > 0) {
      warnings.push(`On cooldown ${Math.max(1, Math.ceil(cdTicks / TICK_HZ))}s`);
    }
    const charges = st.doctrineChargesRemaining[session.slotIndex] ?? 0;
    if (charges <= 0) warnings.push("No charges");
    if (st.flux < entry.fluxCost) {
      warnings.push(`Need ${entry.fluxCost} Flux (have ${Math.floor(st.flux)})`);
    }
    const ok = warnings.length === 0;
    updateDragReason(
      ev.clientX,
      ev.clientY,
      ok ? hint : `${hint} — ${warnings.join(", ")}`,
      ok,
    );
  }

  function onWinUp(ev: PointerEvent): void {
    if (!session || ev.pointerId !== session.pointerId) return;
    window.removeEventListener("pointermove", onWinMove);
    window.removeEventListener("pointerup", onWinUp);
    window.removeEventListener("pointercancel", onWinUp);

    const snap = session;
    session = null;
    releasePointerSafe(canvas, ev.pointerId);

    if (!snap.dragging) {
      return;
    }

    dragRef.active = false;
    destroyDragGhost(snap.ghost);
    renderer.setControlsEnabled(true);
    renderer.setPlacementGhost(null, false);
    renderer.setCommandGhost(null, null, false);
    hideDragReason();

    if (getState().phase !== "playing") return;

    const rect = canvas.getBoundingClientRect();
    if (!pointInRect(ev.clientX, ev.clientY, rect)) return;
    const hit = renderer.pickGround(ev.clientX, ev.clientY, rect);
    if (!hit) return;

    const shift = consumeRelayShiftChord() || ev.shiftKey;
    pendingIntents.push({ type: "select_doctrine_slot", index: snap.slotIndex });
    pendingIntents.push({
      type: "try_click_world",
      pos: { x: hit.x, z: hit.z },
      shiftKey: shift,
      altKey: ev.altKey,
    });
  }

  doctrine.addEventListener("pointerdown", (ev: PointerEvent) => {
    if (getState().phase !== "playing") return;
    const slot = (ev.target as HTMLElement).closest("[data-slot-index]") as HTMLElement | null;
    if (!slot || !doctrine.contains(slot)) return;
    if (slot.classList.contains("slot-empty") || slot.classList.contains("slot-locked")) return;
    const i = Number(slot.dataset.slotIndex);
    if (!Number.isFinite(i)) return;
    const id = getState().doctrineSlotCatalogIds[i];
    if (!id) return;
    ev.preventDefault();
    clearPending();
    try {
      slot.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    pending = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      slotIndex: i,
      catalogId: id,
      detailTimer: null,
      detailShown: false,
      captureEl: slot,
    };
    const downPid = ev.pointerId;
    pending.detailTimer = setTimeout(() => {
      if (!pending || pending.pointerId !== downPid) return;
      pending.detailShown = true;
      showDoctrineCardDetail(pending.catalogId);
    }, CARD_DETAIL_HOLD_MS);
    window.addEventListener("pointermove", onPendingMove);
    window.addEventListener("pointerup", onPendingUp);
    window.addEventListener("pointercancel", onPendingUp);
  });
}

function runMatch(initialDoctrine: (string | null)[]): void {
  void (async () => {
    const map = await loadMapMerged();
    let state: GameState = createInitialState(map, initialDoctrine);

    const renderer = new GameRenderer(canvas);
    const resize = (): void => {
      const { w, h } = viewportCssSize();
      renderer.setSize(w, h);
    };
    resize();
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("scroll", resize);

    const pendingIntents: PlayerIntent[] = [];
    const doctrineDragRef = { active: false };

    let relayShiftNextTap = false;
    const relayShiftBtn = (): HTMLButtonElement | null => hudRoot.querySelector("#btn-relay-shift");
    const syncRelayShiftUi = (): void => {
      const b = relayShiftBtn();
      if (!b) return;
      b.classList.toggle("hud-btn--armed", relayShiftNextTap);
      b.setAttribute("aria-pressed", relayShiftNextTap ? "true" : "false");
    };
    const consumeRelayShiftChord = (): boolean => {
      if (!relayShiftNextTap) return false;
      relayShiftNextTap = false;
      syncRelayShiftUi();
      return true;
    };

    let acc = 0;
    let last = performance.now();
    let rafId = 0;

    const tick = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      acc += dt;

      let first = true;
      while (acc >= 1 / TICK_HZ) {
        const chunk = first ? pendingIntents.splice(0, pendingIntents.length) : [];
        first = false;
        advanceTick(state, chunk);
        acc -= 1 / TICK_HZ;
      }

      if (!state.pendingPlacementCatalogId && !doctrineDragRef.active) {
        renderer.setPlacementGhost(null, false);
      }

      renderer.setRelayShiftArmed(relayShiftNextTap);
      renderer.sync(state, USE_GLB);
      renderer.render();
      updateHud(state);

      rafId = requestAnimationFrame(tick);
    };

    const rematch = (): void => {
      cancelAnimationFrame(rafId);
      pendingIntents.length = 0;
      state = createInitialState(map, initialDoctrine);
      renderer.setPlacementGhost(null, false);
      acc = 0;
      last = performance.now();
      rafId = requestAnimationFrame(tick);
    };

    mountHud(hudRoot, state, {
      onClear: () => pendingIntents.push({ type: "clear_placement" }),
      onRematch: rematch,
      onEditDoctrine: () => {
        window.location.reload();
      },
      pushIntent: (intent) => pendingIntents.push(intent),
    });
    const doctrineTrackEl = hudRoot.querySelector("#doctrine-track");
    if (doctrineTrackEl) attachDoctrineHandPeek(doctrineTrackEl as HTMLElement, () => doctrineDragRef.active);
    showRulesToast();

    relayShiftBtn()?.addEventListener("click", () => {
      relayShiftNextTap = !relayShiftNextTap;
      syncRelayShiftUi();
    });

    wireDoctrineDragToMap(
      canvas,
      hudRoot,
      () => state,
      renderer,
      pendingIntents,
      (index) => {
        pendingIntents.push({ type: "select_doctrine_slot", index });
        const d = hudRoot.querySelector("#doctrine-track");
        if (!d) return;
        for (const el of d.querySelectorAll(".slot")) el.classList.remove("active");
        d.querySelector(`[data-slot-index="${index}"]`)?.classList.add("active");
      },
      doctrineDragRef,
      consumeRelayShiftChord,
    );

    let rightHold: { pointerId: number; lastMs: number } | null = null;

    canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

    canvas.addEventListener("pointerdown", (ev) => {
      hudRoot.querySelector("#doctrine-track")?.removeAttribute("data-hand-peek");
      if (state.phase !== "playing") return;
      const rect = canvas.getBoundingClientRect();
      const hit = renderer.pickGround(ev.clientX, ev.clientY, rect);
      if (!hit) return;

      // Right-click (button 2) or middle-click moves the hero.
      if (ev.button === 2 || ev.button === 1) {
        ev.preventDefault();
        pendingIntents.push({ type: "hero_move", x: hit.x, z: hit.z });
        rightHold = { pointerId: ev.pointerId, lastMs: performance.now() };
        try {
          canvas.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        return;
      }

      const shift = consumeRelayShiftChord() || ev.shiftKey;
      pendingIntents.push({
        type: "try_click_world",
        pos: { x: hit.x, z: hit.z },
        shiftKey: shift,
        altKey: ev.altKey,
      });
    });

    canvas.addEventListener("pointerup", (ev) => {
      if (rightHold && ev.pointerId === rightHold.pointerId) {
        rightHold = null;
        try {
          if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
      }
    });
    canvas.addEventListener("pointercancel", (ev) => {
      if (rightHold && ev.pointerId === rightHold.pointerId) rightHold = null;
    });

    canvas.addEventListener("pointermove", (ev) => {
      if (rightHold && ev.pointerId === rightHold.pointerId) {
        const now = performance.now();
        if (now - rightHold.lastMs >= 80) {
          rightHold.lastMs = now;
          const rectM = canvas.getBoundingClientRect();
          const hitM = renderer.pickGround(ev.clientX, ev.clientY, rectM);
          if (hitM) pendingIntents.push({ type: "hero_move", x: hitM.x, z: hitM.z });
        }
        return;
      }

      if (doctrineDragRef.active) return;
      const rect = canvas.getBoundingClientRect();
      const hit = renderer.pickGround(ev.clientX, ev.clientY, rect);
      const pending = state.pendingPlacementCatalogId;
      const slot = state.selectedDoctrineIndex;
      if (!pending || slot === null || !hit) {
        renderer.setPlacementGhost(null, false);
        return;
      }
      const entry = getCatalogEntry(pending);
      if (!entry || !isStructureEntry(entry)) {
        renderer.setPlacementGhost(null, false);
        return;
      }
      const valid = canPlaceStructureHere(state, pending, hit, slot) === null;
      renderer.setPlacementGhost(hit, valid);
    });

    canvas.addEventListener("pointerleave", () => {
      if (!doctrineDragRef.active) renderer.setPlacementGhost(null, false);
    });

    rafId = requestAnimationFrame(tick);
  })().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    document.body.textContent = String(e);
  });
}

mountDoctrinePicker(pickerRoot, (slots) => {
  runMatch(slots);
});
