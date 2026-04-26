import {
  commandEffectRadius,
  commandLineGhostPreview,
  commandTargetingHint,
  getCatalogEntry,
} from "./game/catalog";
import { DOCTRINE_SLOT_COUNT, TICK_HZ } from "./game/constants";
import type { PlayerIntent } from "./game/intents";
import { loadMapMerged } from "./game/loadMap";
import { captureReplayTick, createReplayCapture, type ReplayCapture } from "./game/replay";
import {
  canPlaceStructureHere,
  canUseDoctrineSlot,
  createInitialState,
  placementFailureReason,
  type GameState,
} from "./game/state";
import { clearGameLog, logGame } from "./game/gameLog";
import { advanceTick } from "./game/sim/tick";
import { GameRenderer } from "./render/scene";
import { hydrateCardPreviewImages } from "./ui/cardGlbPreview";
import { tcgCardCompactHtml } from "./ui/doctrineCard";
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

function syncCameraFollowUi(root: HTMLElement, follow: boolean): void {
  const btn = root.querySelector("#btn-camera-follow");
  if (!btn) return;
  btn.textContent = follow ? "Camera: lock" : "Camera: free";
  btn.setAttribute("aria-pressed", follow ? "true" : "false");
}

function bindReplayDebugGlobals(getReplay: () => ReplayCapture): void {
  const w = window as Window & {
    __signalWarsReplay?: ReplayCapture;
    __signalWarsReplayJson?: () => string;
  };
  w.__signalWarsReplay = getReplay();
  w.__signalWarsReplayJson = () => JSON.stringify(getReplay());
}

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
const SELECT_BOX_ID = "unit-select-box";
const RADIAL_ID = "unit-command-radial";

function ensureSelectBoxEl(): HTMLDivElement {
  let el = document.getElementById(SELECT_BOX_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement("div");
    el.id = SELECT_BOX_ID;
    el.className = "unit-select-box";
    document.body.appendChild(el);
  }
  return el;
}

function updateSelectBox(a: { x: number; y: number }, b: { x: number; y: number }): void {
  const el = ensureSelectBoxEl();
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  el.style.transform = `translate(${x}px, ${y}px)`;
  el.style.width = `${Math.abs(a.x - b.x)}px`;
  el.style.height = `${Math.abs(a.y - b.y)}px`;
}

function hideSelectBox(): void {
  document.getElementById(SELECT_BOX_ID)?.remove();
}

function hideRadial(): void {
  document.getElementById(RADIAL_ID)?.remove();
}

function showUnitCommandRadial(
  clientX: number,
  clientY: number,
  onCommand: (mode: "move" | "attack_move" | "stay", queue: boolean) => void,
): void {
  hideRadial();
  const el = document.createElement("div");
  el.id = RADIAL_ID;
  el.className = "unit-command-radial";
  el.style.left = `${clientX}px`;
  el.style.top = `${clientY}px`;
  const buttons: Array<[string, "move" | "attack_move" | "stay", boolean, string]> = [
    ["Move", "move", false, "Move selected units here"],
    ["Attack", "attack_move", false, "Attack-move selected units"],
    ["Queue", "move", true, "Queue this move after current order"],
    ["Stay", "stay", false, "Hold selected units in place"],
  ];
  for (const [label, mode, queue, title] of buttons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onCommand(mode, queue);
      hideRadial();
    });
    el.appendChild(btn);
  }
  document.body.appendChild(el);
}

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
    captureEl: HTMLElement;
  } | null = null;

  function clearPending(): void {
    if (pending) releasePointerSafe(pending.captureEl, pending.pointerId);
    pending = null;
  }

  function onPendingMove(ev: PointerEvent): void {
    if (!pending || ev.pointerId !== pending.pointerId) return;
    const dx = ev.clientX - pending.startX;
    const dy = ev.clientY - pending.startY;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
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
    const snap = pending;
    pending = null;
    releasePointerSafe(snap.captureEl, ev.pointerId);
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
        `<div class="doctrine-drag-ghost-card-face-inner">${tcgCardCompactHtml(session.catalogId, "picker")}</div>`,
      );
      session.ghost.classList.add("doctrine-drag-ghost--card-face");
      hydrateCardPreviewImages(session.ghost);
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
        reason ?? "Release to place.",
        valid,
      );
      return;
    }

    // Command / spell card.
    renderer.setPlacementGhost(null, false);
    const radius = commandEffectRadius(entry);
    const linePrev = commandLineGhostPreview(entry);
    if (hit) {
      if (linePrev) {
        renderer.setCommandGhost(hit, null, true, {
          fromX: st.hero.x,
          fromZ: st.hero.z,
          length: linePrev.length,
          halfWidth: linePrev.halfWidth,
        });
      } else {
        renderer.setCommandGhost(hit, radius, true);
      }
    } else {
      renderer.setCommandGhost(null, null, false);
    }
    const hint = commandTargetingHint(entry);
    const warnings: string[] = [];
    const cdTicks = st.doctrineCooldownTicks[session.slotIndex] ?? 0;
    if (cdTicks > 0) {
      warnings.push(`On cooldown ${Math.max(1, Math.ceil(cdTicks / TICK_HZ))}s`);
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

    const dropPhase = getState().phase;
    if (dropPhase !== "playing") return;

    const rect = canvas.getBoundingClientRect();
    if (!pointInRect(ev.clientX, ev.clientY, rect)) return;
    const hit = renderer.pickGround(ev.clientX, ev.clientY, rect);
    if (!hit) return;
    const pickedUnitId = renderer.pickUnitId(ev.clientX, ev.clientY, rect);

    pendingIntents.push({ type: "select_doctrine_slot", index: snap.slotIndex });
    pendingIntents.push({
      type: "try_click_world",
      pos: { x: hit.x, z: hit.z },
      shiftKey: ev.shiftKey,
      altKey: ev.altKey,
      pickedUnitId,
    });
  }

  doctrine.addEventListener("pointerdown", (ev: PointerEvent) => {
    const pdPhase = getState().phase;
    if (pdPhase !== "playing") return;
    const slot = (ev.target as HTMLElement).closest("[data-slot-index]") as HTMLElement | null;
    if (!slot || !doctrine.contains(slot)) return;
    if (slot.classList.contains("slot-empty") || slot.classList.contains("slot-locked")) return;
    const i = Number(slot.dataset.slotIndex);
    if (!Number.isFinite(i) || i < 0 || i >= DOCTRINE_SLOT_COUNT) return;
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
      captureEl: slot,
    };
    window.addEventListener("pointermove", onPendingMove);
    window.addEventListener("pointerup", onPendingUp);
    window.addEventListener("pointercancel", onPendingUp);
  });
}

function runMatch(initialDoctrine: (string | null)[], mapUrl: string): void {
  void (async () => {
    const map = await loadMapMerged(mapUrl);
    const renderer = new GameRenderer(canvas);
    await renderer.loadTerrainFromMap(map);
    let state: GameState = createInitialState(map, initialDoctrine);
    let replay = createReplayCapture(state, map);
    const testWindow = window as Window & {
      render_game_to_text?: () => string;
      advanceTime?: (ms: number) => void;
    };
    testWindow.render_game_to_text = () =>
      JSON.stringify({
        coords: "world XZ, origin center, +X enemy side",
        phase: state.phase,
        tick: state.tick,
        hero: {
          x: Number(state.hero.x.toFixed(1)),
          z: Number(state.hero.z.toFixed(1)),
          hp: Math.round(state.hero.hp),
          teleportCooldown: Math.ceil(state.heroTeleportCooldownTicks / TICK_HZ),
          teleportArmed: state.teleportClickPending,
        },
        selectedUnitIds: state.selectedUnitIds,
        taps: state.taps.map((t) => ({
          id: t.defId,
          x: t.x,
          z: t.z,
          owner: t.ownerTeam ?? "neutral",
          active: t.active,
        })),
        units: state.units
          .filter((u) => u.hp > 0)
          .slice(0, 30)
          .map((u) => ({ id: u.id, team: u.team, x: Number(u.x.toFixed(1)), z: Number(u.z.toFixed(1)) })),
      });
    testWindow.advanceTime = (ms: number) => {
      const steps = Math.max(1, Math.round(ms / (1000 / TICK_HZ)));
      for (let i = 0; i < steps; i++) advanceTick(state, []);
      renderer.sync(state, USE_GLB);
      renderer.render();
      updateHud(state);
    };
    renderer.sync(state, USE_GLB);
    renderer.setCameraFollowHero(true);
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

    const keysHeld = { w: false, a: false, s: false, d: false };
    const onKeyDown = (ev: KeyboardEvent): void => {
      const tag = (ev.target as HTMLElement | null)?.tagName?.toLowerCase?.() ?? "";
      if (tag === "input" || tag === "textarea") return;
      if (ev.code === "KeyW") keysHeld.w = true;
      if (ev.code === "KeyS") keysHeld.s = true;
      if (ev.code === "KeyA") keysHeld.a = true;
      if (ev.code === "KeyD") keysHeld.d = true;
    };
    const onKeyUp = (ev: KeyboardEvent): void => {
      if (ev.code === "KeyW") keysHeld.w = false;
      if (ev.code === "KeyS") keysHeld.s = false;
      if (ev.code === "KeyA") keysHeld.a = false;
      if (ev.code === "KeyD") keysHeld.d = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    let acc = 0;
    let last = performance.now();
    let rafId = 0;

    const tick = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      acc += dt;

      /** Avoid multi-second catch-up stalls after tab backgrounding or long breakpoints. */
      /** Wall-time catch-up cap (~2.4s of sim at current TICK_HZ). */
      const maxTicksThisFrame = 48;
      let ticksThisFrame = 0;
      let first = true;
      const camBasis =
        state.phase === "playing" &&
        (keysHeld.a || keysHeld.d || keysHeld.w || keysHeld.s)
          ? renderer.getCameraGroundMoveBasis()
          : null;
      while (acc >= 1 / TICK_HZ && ticksThisFrame < maxTicksThisFrame) {
        ticksThisFrame += 1;
        const chunk = first ? pendingIntents.splice(0, pendingIntents.length) : [];
        first = false;
        if (state.phase === "playing" && camBasis) {
          let strafe = 0;
          let forward = 0;
          if (keysHeld.a) strafe -= 1;
          if (keysHeld.d) strafe += 1;
          if (keysHeld.w) forward += 1;
          if (keysHeld.s) forward -= 1;
          if (strafe !== 0 || forward !== 0) {
            const { fx, fz, rx, rz } = camBasis;
            chunk.push({ type: "hero_wasd", strafe, forward, camFx: fx, camFz: fz, camRx: rx, camRz: rz });
          }
        }
        const tickBefore = state.tick;
        advanceTick(state, chunk);
        captureReplayTick(replay, tickBefore, chunk, state);
        acc -= 1 / TICK_HZ;
      }

      if (!state.pendingPlacementCatalogId && !doctrineDragRef.active) {
        renderer.setPlacementGhost(null, false);
      }

      renderer.sync(state, USE_GLB);
      renderer.render();
      updateHud(state);

      rafId = requestAnimationFrame(tick);
    };

    const rematch = (): void => {
      cancelAnimationFrame(rafId);
      pendingIntents.length = 0;
      clearGameLog();
      renderer.clearCastFx();
      state = createInitialState(map, initialDoctrine);
      replay = createReplayCapture(state, map);
      renderer.setPlacementGhost(null, false);
      renderer.sync(state, USE_GLB);
      if (renderer.getCameraFollowHero()) renderer.setCameraFollowHero(true);
      syncCameraFollowUi(hudRoot, renderer.getCameraFollowHero());
      acc = 0;
      last = performance.now();
      rafId = requestAnimationFrame(tick);
    };

    const applyCameraToggle = (): void => {
      const follow = renderer.toggleCameraFollowHero();
      state.lastMessage = follow
        ? "Camera locked on wizard — zoom with the mouse wheel only."
        : "Camera free — MMB orbit; lock on wizard with Camera or C.";
      syncCameraFollowUi(hudRoot, follow);
    };

    mountHud(hudRoot, state, {
      onRematch: rematch,
      onEditDoctrine: () => {
        window.location.reload();
      },
      onCameraFollowToggle: applyCameraToggle,
      pushIntent: (intent) => pendingIntents.push(intent),
    });
    syncCameraFollowUi(hudRoot, renderer.getCameraFollowHero());
    const doctrineTrackEl = hudRoot.querySelector("#doctrine-track");
    if (doctrineTrackEl) attachDoctrineHandPeek(doctrineTrackEl as HTMLElement, () => doctrineDragRef.active);
    showRulesToast();

    const digitKeyToDoctrineSlot: Record<string, number> = {
      Digit1: 0,
      Digit2: 1,
      Digit3: 2,
      Digit4: 3,
      Digit5: 4,
      Digit6: 5,
      Digit7: 6,
      Digit8: 7,
      Digit9: 8,
      Digit0: 9,
    };

    const selectDoctrineSlotUi = (index: number): void => {
      if (state.phase !== "playing") return;
      if (index < 0 || index >= DOCTRINE_SLOT_COUNT) return;
      pendingIntents.push({ type: "select_doctrine_slot", index });
      const d = hudRoot.querySelector("#doctrine-track");
      if (!d) return;
      for (const el of d.querySelectorAll(".slot")) el.classList.remove("active");
      d.querySelector(`[data-slot-index="${index}"]`)?.classList.add("active");
    };

    // G = stance; R = arm global rally; C = camera; 1–0 = doctrine slots.
    window.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.repeat) return;
      const tag = (ev.target as HTMLElement | null)?.tagName?.toLowerCase?.() ?? "";
      if (tag === "input" || tag === "textarea") return;
      const slotIdx = digitKeyToDoctrineSlot[ev.code];
      if (slotIdx !== undefined) {
        ev.preventDefault();
        selectDoctrineSlotUi(slotIdx);
        return;
      }
      if (ev.key === "g" || ev.key === "G") {
        ev.preventDefault();
        pendingIntents.push({ type: "toggle_army_stance" });
      } else if (ev.key === "r" || ev.key === "R") {
        ev.preventDefault();
        pendingIntents.push({ type: "begin_rally_click" });
      } else if (ev.code === "KeyC") {
        ev.preventDefault();
        applyCameraToggle();
      } else if (ev.code === "KeyT") {
        ev.preventDefault();
        pendingIntents.push({ type: "begin_hero_teleport" });
      }
    });

    wireDoctrineDragToMap(
      canvas,
      hudRoot,
      () => state,
      renderer,
      pendingIntents,
      selectDoctrineSlotUi,
      doctrineDragRef,
    );

    let rightHold: {
      pointerId: number;
      lastMs: number;
      startX: number;
      startY: number;
      radialTimer: ReturnType<typeof setTimeout> | null;
    } | null = null;
    let leftSelect: { pointerId: number; startX: number; startY: number; dragging: boolean } | null = null;
    let chordDrag: { pointerId: number; lastX: number; lastY: number } | null = null;

    canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

    canvas.addEventListener("pointerdown", (ev) => {
      hudRoot.querySelector("#doctrine-track")?.removeAttribute("data-hand-peek");
      if (state.phase !== "playing") return;
      // Middle = camera pan (OrbitControls); do not treat as a map click.
      if (ev.button !== 0 && ev.button !== 2) return;
      if ((ev.buttons & 1) && (ev.buttons & 2)) {
        ev.preventDefault();
        hideRadial();
        chordDrag = { pointerId: ev.pointerId, lastX: ev.clientX, lastY: ev.clientY };
        try {
          canvas.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const hit = renderer.pickGround(ev.clientX, ev.clientY, rect);
      if (!hit) return;

      if (state.teleportClickPending) {
        ev.preventDefault();
        pendingIntents.push({ type: "hero_teleport", x: hit.x, z: hit.z });
        return;
      }

      if (ev.button === 0) {
        ev.preventDefault();
        leftSelect = { pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY, dragging: false };
        try {
          canvas.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        return;
      }

      // Right-click only moves the hero (middle mouse is camera orbit).
      if (ev.button === 2) {
        ev.preventDefault();
        pendingIntents.push({ type: "hero_move", x: hit.x, z: hit.z, shiftKey: ev.shiftKey });
        logGame("move", `RMB move → (${hit.x.toFixed(1)}, ${hit.z.toFixed(1)})`, state.tick);
        const hasSelection = state.selectedUnitIds.length > 0;
        if (hasSelection) {
          pendingIntents.push({
            type: "command_selected_units",
            x: hit.x,
            z: hit.z,
            mode: ev.altKey ? "attack_move" : "move",
            queue: ev.shiftKey,
          });
        }
        const radialTimer = hasSelection
          ? setTimeout(() => {
              showUnitCommandRadial(ev.clientX, ev.clientY, (mode, queue) => {
                pendingIntents.push({ type: "command_selected_units", x: hit.x, z: hit.z, mode, queue });
              });
            }, 500)
          : null;
        rightHold = {
          pointerId: ev.pointerId,
          lastMs: performance.now(),
          startX: ev.clientX,
          startY: ev.clientY,
          radialTimer,
        };
        try {
          canvas.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        return;
      }

      if (state.teleportClickPending) {
        ev.preventDefault();
        pendingIntents.push({ type: "hero_teleport", x: hit.x, z: hit.z });
        return;
      }

      const pickedUnitId = renderer.pickUnitId(ev.clientX, ev.clientY, rect);
      pendingIntents.push({
        type: "try_click_world",
        pos: { x: hit.x, z: hit.z },
        shiftKey: ev.shiftKey,
        altKey: ev.altKey,
        pickedUnitId,
      });
    });

    canvas.addEventListener("pointerup", (ev) => {
      if (leftSelect && ev.pointerId === leftSelect.pointerId) {
        const snap = leftSelect;
        leftSelect = null;
        hideSelectBox();
        const rect = canvas.getBoundingClientRect();
        if (snap.dragging) {
          const ids = renderer.pickUnitIdsInScreenRect(
            { x: snap.startX, y: snap.startY },
            { x: ev.clientX, y: ev.clientY },
            rect,
          );
          pendingIntents.push({ type: "select_units", unitIds: ids });
        } else {
          const pickedUnitId = renderer.pickUnitId(ev.clientX, ev.clientY, rect);
          const hit = renderer.pickGround(ev.clientX, ev.clientY, rect);
          if (pickedUnitId != null) {
            pendingIntents.push({ type: "select_units", unitIds: [pickedUnitId] });
          } else if (hit && (state.pendingPlacementCatalogId || state.rallyClickPending)) {
            pendingIntents.push({
              type: "try_click_world",
              pos: { x: hit.x, z: hit.z },
              shiftKey: ev.shiftKey,
              altKey: ev.altKey,
              pickedUnitId: null,
            });
          } else {
            pendingIntents.push({ type: "select_units", unitIds: [] });
          }
        }
      }
      if (chordDrag && ev.pointerId === chordDrag.pointerId) chordDrag = null;
      if (rightHold && ev.pointerId === rightHold.pointerId) {
        if (rightHold.radialTimer) clearTimeout(rightHold.radialTimer);
        rightHold = null;
        try {
          if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
      }
    });
    canvas.addEventListener("pointercancel", (ev) => {
      hideSelectBox();
      if (leftSelect && ev.pointerId === leftSelect.pointerId) leftSelect = null;
      if (chordDrag && ev.pointerId === chordDrag.pointerId) chordDrag = null;
      if (rightHold && ev.pointerId === rightHold.pointerId) {
        if (rightHold.radialTimer) clearTimeout(rightHold.radialTimer);
        rightHold = null;
      }
    });

    canvas.addEventListener("pointermove", (ev) => {
      if (chordDrag) {
        const dx = ev.clientX - chordDrag.lastX;
        const dy = ev.clientY - chordDrag.lastY;
        chordDrag.lastX = ev.clientX;
        chordDrag.lastY = ev.clientY;
        renderer.rotateCameraByPixels(dx, dy);
        syncCameraFollowUi(hudRoot, renderer.getCameraFollowHero());
        return;
      }
      if ((ev.buttons & 1) && (ev.buttons & 2)) {
        hideRadial();
        chordDrag = { pointerId: ev.pointerId, lastX: ev.clientX, lastY: ev.clientY };
        return;
      }
      if (leftSelect && ev.pointerId === leftSelect.pointerId) {
        const dx = ev.clientX - leftSelect.startX;
        const dy = ev.clientY - leftSelect.startY;
        if (!leftSelect.dragging && dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
          leftSelect.dragging = true;
        }
        if (leftSelect.dragging) {
          updateSelectBox({ x: leftSelect.startX, y: leftSelect.startY }, { x: ev.clientX, y: ev.clientY });
        }
        return;
      }
      if (rightHold && ev.pointerId === rightHold.pointerId) {
        const mdx = ev.clientX - rightHold.startX;
        const mdy = ev.clientY - rightHold.startY;
        if (rightHold.radialTimer && mdx * mdx + mdy * mdy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
          clearTimeout(rightHold.radialTimer);
          rightHold.radialTimer = null;
        }
        const now = performance.now();
        if (now - rightHold.lastMs >= 80) {
          rightHold.lastMs = now;
          const rectM = canvas.getBoundingClientRect();
          const hitM = renderer.pickGround(ev.clientX, ev.clientY, rectM);
          /** Drag-update follows cursor only (no queue append each tick). */
          if (hitM && state.selectedUnitIds.length === 0) pendingIntents.push({ type: "hero_move", x: hitM.x, z: hitM.z, shiftKey: false });
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
        renderer.setCommandGhost(null, null, false);
        return;
      }
      const entry = getCatalogEntry(pending);
      if (!entry) {
        renderer.setPlacementGhost(null, false);
        renderer.setCommandGhost(null, null, false);
        return;
      }
      if (!isStructureEntry(entry)) {
        renderer.setPlacementGhost(null, false);
        const slotErr = canUseDoctrineSlot(state, slot);
        const valid = !slotErr;
        const linePrev = commandLineGhostPreview(entry);
        if (linePrev) {
          renderer.setCommandGhost(hit, null, valid, {
            fromX: state.hero.x,
            fromZ: state.hero.z,
            length: linePrev.length,
            halfWidth: linePrev.halfWidth,
          });
        } else {
          renderer.setCommandGhost(hit, commandEffectRadius(entry), valid);
        }
        return;
      }
      renderer.setCommandGhost(null, null, false);
      const valid = canPlaceStructureHere(state, pending, hit, slot) === null;
      renderer.setPlacementGhost(hit, valid);
    });

    canvas.addEventListener("pointerleave", () => {
      if (!doctrineDragRef.active) {
        renderer.setPlacementGhost(null, false);
        renderer.setCommandGhost(null, null, false);
      }
    });

    bindReplayDebugGlobals(() => replay);
    rafId = requestAnimationFrame(tick);
  })().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    document.body.textContent = String(e);
  });
}

mountDoctrinePicker(pickerRoot, (slots, chosenMapUrl) => {
  runMatch(slots, chosenMapUrl);
});
