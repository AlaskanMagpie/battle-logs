import { getCatalogEntry } from "./game/catalog";
import { TICK_HZ } from "./game/constants";
import type { PlayerIntent } from "./game/intents";
import { loadMapMerged } from "./game/loadMap";
import { canPlaceStructureHere, createInitialState, type GameState } from "./game/state";
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
import { mountHud, updateHud } from "./ui/hud";
import { showRulesToast } from "./ui/rulesToast";
import { isStructureEntry } from "./game/types";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const hudRoot = document.querySelector<HTMLElement>("#hud-root")!;
const pickerRoot = document.querySelector<HTMLElement>("#doctrine-picker")!;

/** GLB art on by default; set `VITE_USE_UNIT_GLB=false` to force cubes only. */
const USE_GLB = import.meta.env.VITE_USE_UNIT_GLB !== "false";

function wireDoctrineDragToMap(
  canvas: HTMLCanvasElement,
  hudRoot: HTMLElement,
  getState: () => GameState,
  renderer: GameRenderer,
  pendingIntents: PlayerIntent[],
  onShortClickSelect: (index: number) => void,
  dragRef: { active: boolean },
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
  } | null = null;

  function clearPending(): void {
    if (pending?.detailTimer) clearTimeout(pending.detailTimer);
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
    session = {
      pointerId: snap.pointerId,
      startX: snap.startX,
      startY: snap.startY,
      dragging: false,
      slotIndex: snap.slotIndex,
      catalogId: snap.catalogId,
      ghost: null,
    };
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
      renderer.setControlsEnabled(false);
      session.ghost = makeDragGhost(
        `<div class="ghost-compact">${doctrineCardGhostSummary(session.catalogId)}</div>`,
      );
    }
    if (!session.dragging || !session.ghost) return;
    moveDragGhost(session.ghost, ev.clientX, ev.clientY);

    const rect = canvas.getBoundingClientRect();
    if (!pointInRect(ev.clientX, ev.clientY, rect)) {
      renderer.setPlacementGhost(null, false);
      return;
    }
    const hit = renderer.pickGround(ev.clientX, ev.clientY, rect);
    const entry = getCatalogEntry(session.catalogId);
    if (hit && entry && isStructureEntry(entry)) {
      const valid = canPlaceStructureHere(st, session.catalogId, hit, session.slotIndex) === null;
      renderer.setPlacementGhost(hit, valid);
    } else {
      renderer.setPlacementGhost(null, false);
    }
  }

  function onWinUp(ev: PointerEvent): void {
    if (!session || ev.pointerId !== session.pointerId) return;
    window.removeEventListener("pointermove", onWinMove);
    window.removeEventListener("pointerup", onWinUp);
    window.removeEventListener("pointercancel", onWinUp);

    const snap = session;
    session = null;

    if (!snap.dragging) {
      return;
    }

    dragRef.active = false;
    destroyDragGhost(snap.ghost);
    renderer.setControlsEnabled(true);
    renderer.setPlacementGhost(null, false);

    if (getState().phase !== "playing") return;

    const rect = canvas.getBoundingClientRect();
    if (!pointInRect(ev.clientX, ev.clientY, rect)) return;
    const hit = renderer.pickGround(ev.clientX, ev.clientY, rect);
    if (!hit) return;

    pendingIntents.push({ type: "select_doctrine_slot", index: snap.slotIndex });
    pendingIntents.push({
      type: "try_click_world",
      pos: { x: hit.x, z: hit.z },
      shiftKey: ev.shiftKey,
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
    pending = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      slotIndex: i,
      catalogId: id,
      detailTimer: null,
      detailShown: false,
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
    const state: GameState = createInitialState(map, initialDoctrine);

    const renderer = new GameRenderer(canvas);
    const resize = (): void => {
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    resize();
    window.addEventListener("resize", resize);

    const pendingIntents: PlayerIntent[] = [];
    const doctrineDragRef = { active: false };

    mountHud(
      hudRoot,
      state,
      () => pendingIntents.push({ type: "clear_placement" }),
      (intent) => pendingIntents.push(intent),
    );
    showRulesToast();

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
    );

    canvas.addEventListener("pointerdown", (ev) => {
      if (state.phase !== "playing") return;
      const rect = canvas.getBoundingClientRect();
      const hit = renderer.pickGround(ev.clientX, ev.clientY, rect);
      if (!hit) return;
      pendingIntents.push({
        type: "try_click_world",
        pos: { x: hit.x, z: hit.z },
        shiftKey: ev.shiftKey,
      });
    });

    canvas.addEventListener("pointermove", (ev) => {
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

    let acc = 0;
    let last = performance.now();

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

      renderer.sync(state, USE_GLB);
      renderer.render();
      updateHud(state);

      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  })().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    document.body.textContent = String(e);
  });
}

mountDoctrinePicker(pickerRoot, (slots) => {
  runMatch(slots);
});
