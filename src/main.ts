import {
  commandEffectRadius,
  commandLineGhostPreview,
  commandTargetingHint,
  getCatalogEntry,
} from "./game/catalog";
import { DOCTRINE_SLOT_COUNT, TICK_HZ } from "./game/constants";
import type { PlayerIntent } from "./game/intents";
import { DEFAULT_MAP_URL, loadMapMerged, MAP_REGISTRY } from "./game/loadMap";
import {
  doctrineSlotsForUrlQuickMatch,
  isUserDoctrineHandViableForQuickMatch,
} from "./game/quickMatchDoctrine";
import { recordLocalLeaderboardResult } from "./game/leaderboard";
import {
  submitDamageLeaderboardEntry,
} from "./leaderboard/damageLeaderboard";
import { captureReplayTick, createReplayCapture, type ReplayCapture } from "./game/replay";
import {
  canPlaceStructureHere,
  createInitialState,
  doctrineCardPlayability,
  pushFx,
  type GameState,
} from "./game/state";
import { clearGameLog, logGame } from "./game/gameLog";
import { computeFormationSlots, formationKindLabel } from "./game/sim/systems/formationLayout";
import { advanceTick } from "./game/sim/tick";
import { configureGamePortals, parsePortalContext, type PortalContext } from "./game/portal";
import { GameRenderer } from "./render/scene";
import { hydrateCardPreviewImages } from "./ui/cardGlbPreview";
import { tcgCardSlotHtml } from "./ui/doctrineCard";
import { loadDoctrineSlots } from "./ui/doctrineStorage";
import {
  destroyDragGhost,
  DRAG_THRESHOLD_PX,
  makeDragGhost,
  moveDragGhost,
  pointInRect,
} from "./ui/doctrineDrag";
import { mountDoctrinePicker } from "./ui/doctrinePicker";
import { installCardArtOverlayCalibrator } from "./ui/cardArtOverlay";
import {
  CARD_PREVIEW_LONG_PRESS_MS,
  closeDoctrineCardDetail,
  showDoctrineCardDetail,
} from "./ui/cardDetailPop";
import { attachDoctrineHandPeek, mountHud, updateHud } from "./ui/hud";
import { hideRulesToast, showRulesToast } from "./ui/rulesToast";
import {
  isStructureEntry,
  type MapDifficulty,
  type SpellFxElement,
  type SpellFxShape,
  type Vec2,
} from "./game/types";
import { applyControlProfileToDocument, getControlProfile } from "./controlProfile";
import { findHumanMatch, getActiveBattleRoom } from "./net/matchmaking";
import { attachOnlineMatchRoom, type OnlineMatchSession } from "./net/onlineMatch";
import {
  clampMatchmakingStrictTimeoutMs,
  clampMatchmakingTimeoutMs,
  makeClientMatchId,
  normalizeMatchMode,
  type MatchLaunchOptions,
} from "./net/protocol";
import {
  isAiLadderProgressEligible,
  isOwnerAiDuelAuthorized,
  readAiLadderProgress,
  recordAiLadderWin,
  resolvePlayableAiOpponent,
} from "./ai/aiLadder";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const hudRoot = document.querySelector<HTMLElement>("#hud-root")!;
const pickerRoot = document.querySelector<HTMLElement>("#doctrine-picker")!;
const CONTROL_PROFILE = getControlProfile();
applyControlProfileToDocument(CONTROL_PROFILE);

const DIFFICULTY_PRESETS: Record<string, MapDifficulty> = {
  easy: { enemyEffectivenessMult: 0.6 },
  normal: { enemyEffectivenessMult: 1 },
  hard: { enemyEffectivenessMult: 1.18 },
  brutal: { enemyEffectivenessMult: 1.4 },
};

function queryDifficultyOverride(search: string): MapDifficulty | null {
  const params = new URLSearchParams(search);
  const out: MapDifficulty = {};
  const preset = params.get("difficulty")?.trim().toLowerCase();
  if (preset) {
    const numericPreset = Number(preset);
    const named = DIFFICULTY_PRESETS[preset];
    if (named) Object.assign(out, named);
    else if (Number.isFinite(numericPreset) && numericPreset > 0) out.enemyEffectivenessMult = numericPreset;
  }

  // URL tuning accepts either the full slider names or short names, e.g.
  // ?difficulty=easy&enemyCapture=0.5&enemyDamage=0.7
  const mappings: [keyof MapDifficulty, string[]][] = [
    ["enemyEffectivenessMult", ["enemyEffectiveness", "enemyEffectivenessMult"]],
    ["enemyDamageMult", ["enemyDamage", "enemyDamageMult"]],
    ["enemyAttackSpeedMult", ["enemyAttackSpeed", "enemyAttackSpeedMult"]],
    ["enemyCaptureSpeedMult", ["enemyCapture", "enemyCaptureSpeed", "enemyCaptureSpeedMult"]],
    ["enemyBuildSpeedMult", ["enemyBuild", "enemyBuildSpeed", "enemyBuildSpeedMult"]],
    ["enemyEconomyMult", ["enemyEconomy", "enemyEconomyMult"]],
    ["enemyProductionSpeedMult", ["enemyProduction", "enemyProductionSpeed", "enemyProductionSpeedMult"]],
  ];
  for (const [key, names] of mappings) {
    const raw = names.map((name) => params.get(name)).find((v): v is string => v !== null);
    if (raw == null) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function mountMatchSkyboxAdjuster(renderer: GameRenderer, signal: AbortSignal): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("skyboxAdjust")) return;

  const panel = document.createElement("div");
  panel.style.cssText = [
    "position:fixed",
    "right:max(10px, env(safe-area-inset-right, 0px))",
    "bottom:calc(132px + env(safe-area-inset-bottom, 0px))",
    "z-index:70000",
    "width:min(260px, calc(100vw - 20px))",
    "padding:10px",
    "border:1px solid rgba(126,200,255,.35)",
    "border-radius:10px",
    "background:rgba(6,10,18,.86)",
    "color:#e8f4ff",
    "font:12px/1.35 system-ui, Segoe UI, sans-serif",
    "box-shadow:0 14px 34px rgba(0,0,0,.42)",
    "backdrop-filter:blur(10px)",
  ].join(";");

  const title = document.createElement("div");
  title.textContent = "Battle skybox XYZ";
  title.style.cssText = "font-weight:700;margin-bottom:6px;letter-spacing:.04em;text-transform:uppercase";
  panel.append(title);

  const value = renderer.getMatchSkyboxPlacement();
  const inputs: Partial<Record<"x" | "y" | "z", HTMLInputElement>> = {};
  const copy = document.createElement("code");
  const update = (): void => {
    renderer.setMatchSkyboxPlacement({
      x: Number(inputs.x?.value ?? value.x),
      y: Number(inputs.y?.value ?? value.y),
      z: Number(inputs.z?.value ?? value.z),
    });
    copy.textContent = JSON.stringify(renderer.getMatchSkyboxPlacement());
  };

  const makeRow = (axis: "x" | "y" | "z"): void => {
    const row = document.createElement("label");
    row.style.cssText = "display:grid;grid-template-columns:18px 1fr 54px;gap:7px;align-items:center;margin:5px 0";
    const name = document.createElement("b");
    name.textContent = axis.toUpperCase();
    const range = document.createElement("input");
    range.type = "range";
    range.min = "-360";
    range.max = "360";
    range.step = "2";
    range.value = String(value[axis]);
    const number = document.createElement("input");
    number.type = "number";
    number.step = "2";
    number.value = String(value[axis]);
    number.style.cssText =
      "width:54px;background:#101927;color:#e8f4ff;border:1px solid rgba(126,200,255,.3);border-radius:6px;padding:3px";
    range.addEventListener("input", () => {
      number.value = range.value;
      inputs[axis] = number;
      update();
    }, { signal });
    number.addEventListener("input", () => {
      range.value = number.value;
      update();
    }, { signal });
    inputs[axis] = number;
    row.append(name, range, number);
    panel.append(row);
  };

  makeRow("x");
  makeRow("y");
  makeRow("z");

  copy.textContent = JSON.stringify(value);
  copy.style.cssText = "display:block;margin-top:7px;color:#9fd8ff;word-break:break-all;font-size:10px";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset";
  reset.style.cssText =
    "margin-top:8px;padding:5px 9px;border-radius:7px;border:1px solid rgba(126,200,255,.35);background:#152238;color:#e8f4ff";
  reset.addEventListener("click", () => {
    const next = renderer.resetMatchSkyboxPlacement();
    for (const axis of ["x", "y", "z"] as const) {
      const input = inputs[axis];
      if (input) input.value = String(next[axis]);
    }
    copy.textContent = JSON.stringify(next);
  }, { signal });
  panel.append(copy, reset);
  document.body.append(panel);
  signal.addEventListener("abort", () => panel.remove(), { once: true });
}

function syncCameraFollowUi(root: HTMLElement, follow: boolean): void {
  const btn = root.querySelector("#btn-camera-follow");
  if (!btn) return;
  const copy = btn.querySelector<HTMLElement>(".hud-side-value text, .hud-side-value");
  if (copy) copy.textContent = follow ? "lock" : "free";
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

function isMatchSurfaceTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("#game, #hud-root, #doctrine-picker"));
}

function applyControlProfileDefaults(state: GameState): void {
  state.heroCaptainEnabled = CONTROL_PROFILE.captainDefault;
  state.heroCaptainLastManualTick = state.tick;
}

function markFirstInteractiveOnce(state: GameState): void {
  const w = window as Window & { __doctrineFirstInteractiveMarked?: boolean };
  if (w.__doctrineFirstInteractiveMarked) return;
  w.__doctrineFirstInteractiveMarked = true;
  performance.mark("doctrine:first-interactive");
  const params = new URLSearchParams(window.location.search);
  if (params.get("perf") !== "1") return;
  const transferred = performance
    .getEntriesByType("resource")
    .reduce((sum, e) => sum + ((e as PerformanceResourceTiming).transferSize || 0), 0);
  // eslint-disable-next-line no-console
  console.info(
    `[Doctrine perf] first interactive tick=${state.tick} resources=${(transferred / 1024 / 1024).toFixed(2)}MB`,
  );
}

/** GLB art on by default; set `VITE_USE_UNIT_GLB=false` to force cubes only. */
const USE_GLB = import.meta.env.VITE_USE_UNIT_GLB !== "false";

const DRAG_REASON_ID = "drag-reason";
const SELECT_BOX_ID = "unit-select-box";

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
    sourceCardHtml: string | null;
    ghost: HTMLDivElement | null;
  } | null = null;

  let pending: {
    pointerId: number;
    startX: number;
    startY: number;
    slotIndex: number;
    catalogId: string;
    captureEl: HTMLElement;
    sourceCardHtml: string | null;
    longPressTimer: number | null;
  } | null = null;

  function clearPending(): void {
    if (pending) {
      if (pending.longPressTimer != null) {
        clearTimeout(pending.longPressTimer);
        pending.longPressTimer = null;
      }
      releasePointerSafe(pending.captureEl, pending.pointerId);
    }
    pending = null;
  }

  function onPendingMove(ev: PointerEvent): void {
    if (!pending || ev.pointerId !== pending.pointerId) return;
    const dx = ev.clientX - pending.startX;
    const dy = ev.clientY - pending.startY;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    if (pending.longPressTimer != null) {
      clearTimeout(pending.longPressTimer);
      pending.longPressTimer = null;
    }
    closeDoctrineCardDetail();
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
      sourceCardHtml: snap.sourceCardHtml,
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
    if (snap.longPressTimer != null) {
      clearTimeout(snap.longPressTimer);
      snap.longPressTimer = null;
    }
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
        `<div class="doctrine-drag-ghost-card-face-inner">${session.sourceCardHtml ?? tcgCardSlotHtml(session.catalogId, "picker")}</div>`,
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
        const playable = doctrineCardPlayability(st, session.catalogId, null, session.slotIndex);
        updateDragReason(
          ev.clientX,
          ev.clientY,
          playable.reason ?? playable.hint,
          playable.reason === null,
        );
        return;
      }
      const playable = doctrineCardPlayability(st, session.catalogId, hit, session.slotIndex);
      const valid = playable.reason === null;
      renderer.setPlacementGhost(hit, valid);
      updateDragReason(
        ev.clientX,
        ev.clientY,
        playable.reason ?? playable.hint,
        valid,
      );
      return;
    }

    // Command / spell card.
    renderer.setPlacementGhost(null, false);
    const radius = commandEffectRadius(entry);
    const linePrev = commandLineGhostPreview(entry);
    const playable = doctrineCardPlayability(st, session.catalogId, hit, session.slotIndex);
    const valid = playable.reason === null;
    if (hit) {
      if (linePrev) {
        renderer.setCommandGhost(hit, null, valid, {
          fromX: st.hero.x,
          fromZ: st.hero.z,
          length: linePrev.length,
          halfWidth: linePrev.halfWidth,
        }, entry.effect.type);
      } else {
        renderer.setCommandGhost(hit, radius, valid, undefined, entry.effect.type);
      }
    } else {
      renderer.setCommandGhost(null, null, false);
    }
    const hint = commandTargetingHint(entry);
    const msg = playable.reason ?? hint;
    updateDragReason(
      ev.clientX,
      ev.clientY,
      msg,
      valid,
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

    const st = getState();
    const entry = getCatalogEntry(snap.catalogId);
    if (!entry) {
      st.lastMessage = "Unknown card.";
      logGame("input", "Could not play card: unknown card.", st.tick);
      updateHud(st);
      return;
    }

    const rect = canvas.getBoundingClientRect();
    if (!pointInRect(ev.clientX, ev.clientY, rect)) {
      st.lastMessage = "Drop a doctrine card on the battlefield to play it.";
      logGame("input", `Could not play ${entry.name}: drop was outside the battlefield.`, st.tick);
      updateHud(st);
      return;
    }
    const hit = renderer.pickGround(ev.clientX, ev.clientY, rect);
    if (!hit) {
      st.lastMessage = "No valid ground under the card drop.";
      logGame("input", `Could not play ${entry.name}: no valid ground under drop.`, st.tick);
      updateHud(st);
      return;
    }
    const pickedUnitId = renderer.pickUnitId(ev.clientX, ev.clientY, rect);

    const playable = doctrineCardPlayability(st, snap.catalogId, hit, snap.slotIndex);
    if (playable.reason) {
      st.lastMessage = playable.reason;
      logGame("input", `Could not play ${entry.name}: ${playable.reason}`, st.tick);
      updateHud(st);
      return;
    }
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
      sourceCardHtml: (slot.querySelector(".doctrine-card-compact") as HTMLElement | null)?.outerHTML ?? null,
      longPressTimer: window.setTimeout(() => {
        if (!pending || pending.pointerId !== ev.pointerId) return;
        pending.longPressTimer = null;
        showDoctrineCardDetail(id, { fromHover: true, hoverSourceEl: slot });
      }, CARD_PREVIEW_LONG_PRESS_MS),
    };
    window.addEventListener("pointermove", onPendingMove);
    window.addEventListener("pointerup", onPendingUp);
    window.addEventListener("pointercancel", onPendingUp);
  });
}

const MATCHMAKING_OVERLAY_ID = "signal-wars-matchmaking-overlay";

function removeMatchmakingOverlay(): void {
  document.getElementById(MATCHMAKING_OVERLAY_ID)?.remove();
}

/** Full-screen shim after the binder hides: Colyseus join can take a moment; user can cancel back to prematch. */
function openMatchmakingOverlay(opts: { strict: boolean; onLeave: () => void }): () => void {
  removeMatchmakingOverlay();
  const el = document.createElement("div");
  el.id = MATCHMAKING_OVERLAY_ID;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "signal-wars-matchmaking-title");
  el.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:99999",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "background:rgba(8,10,14,0.78)",
    "backdrop-filter:blur(6px)",
    "font:600 15px system-ui,Segoe UI,sans-serif",
    "color:#f3eadc",
  ].join(";");
  const panel = document.createElement("div");
  panel.style.cssText =
    "max-width:min(92vw,420px);padding:22px 24px;border-radius:14px;border:1px solid rgba(212,190,140,0.35);background:rgba(18,16,24,0.96);box-shadow:0 14px 44px rgba(0,0,0,0.55);text-align:center;";
  const title = document.createElement("h2");
  title.id = "signal-wars-matchmaking-title";
  title.textContent = opts.strict ? "Waiting for a human opponent" : "Finding a human opponent…";
  title.style.cssText =
    "margin:0 0 10px;font-size:clamp(15px,3.5vmin,20px);font-weight:700;color:#ebe4d6;font-family:Georgia,serif;";
  const sub = document.createElement("p");
  sub.style.cssText = "margin:0 0 18px;line-height:1.45;font-size:14px;color:rgba(235,228,214,0.88);";
  sub.textContent = opts.strict
    ? "Human-only queue: there is no AI fallback if the wait expires. You can leave any time."
    : "Short queue: if no one pairs in time, you will start against an AI rival.";
  const leave = document.createElement("button");
  leave.type = "button";
  leave.textContent = "Leave — back to doctrine";
  leave.style.cssText =
    "cursor:pointer;padding:10px 18px;border-radius:10px;border:1px solid rgba(244,180,96,0.5);background:rgba(40,28,12,0.92);color:#ffe8c8;font-weight:650;font-family:inherit;";
  leave.addEventListener("click", () => opts.onLeave());
  panel.appendChild(title);
  panel.appendChild(sub);
  panel.appendChild(leave);
  el.appendChild(panel);
  document.body.appendChild(el);
  return () => removeMatchmakingOverlay();
}

function runMatch(
  initialDoctrine: (string | null)[],
  mapUrl: string,
  onReturnToDoctrine: () => void,
  portalContext: PortalContext = parsePortalContext(""),
  launchOptions: Partial<MatchLaunchOptions> = {},
): void {
  void (async () => {
    const requestedMode = launchOptions.mode ?? "ai";
    const matchId = launchOptions.matchId ?? makeClientMatchId();
    const ownerAiBattle = requestedMode === "ai" && isOwnerAiDuelAuthorized(params);
    const aiProgress = readAiLadderProgress();
    const aiOpponent = resolvePlayableAiOpponent(
      launchOptions.aiOpponentId ?? params.get("aiOpponent"),
      aiProgress,
      { allowLocked: ownerAiBattle },
    );
    let resolvedLaunch: MatchLaunchOptions = {
      mode: requestedMode,
      matchId,
      seat: launchOptions.seat,
      queueState: launchOptions.queueState ?? "idle",
      fallbackReason: launchOptions.fallbackReason,
      room: launchOptions.room,
      aiOpponentId: requestedMode === "pvp" ? undefined : aiOpponent.id,
      aiBattle: ownerAiBattle,
    };
    const needsHumanQueue = requestedMode === "matchmake" || requestedMode === "matchmake_strict";
    const matchmakingAbort = new AbortController();
    let dismissMatchmakingOverlay: (() => void) | null = null;
    if (needsHumanQueue) {
      dismissMatchmakingOverlay = openMatchmakingOverlay({
        strict: requestedMode === "matchmake_strict",
        onLeave: () => matchmakingAbort.abort(),
      });
    }
    try {
      if (needsHumanQueue) {
        const strict = requestedMode === "matchmake_strict";
        const result = await findHumanMatch({
          timeoutMs: strict
            ? clampMatchmakingStrictTimeoutMs(params.get("matchStrictTimeoutMs"))
            : clampMatchmakingTimeoutMs(params.get("matchTimeoutMs")),
          mapUrl,
          doctrineSlots: initialDoctrine,
          username: portalContext.params.username,
          abortSignal: matchmakingAbort.signal,
          strictHumanMatch: strict,
        });
        if (result.mode === "search_aborted") {
          dismissMatchmakingOverlay?.();
          mountPortalPicker();
          return;
        }
        if (result.mode === "human_not_found") {
          dismissMatchmakingOverlay?.();
          try {
            sessionStorage.setItem("signalWarsPrematchFlash", result.message);
          } catch {
            /* ignore */
          }
          mountPortalPicker();
          return;
        }
        if (result.mode === "pvp") {
          resolvedLaunch = {
            mode: "pvp",
            matchId: result.room.matchId,
            seat: result.room.seat,
            queueState: "matched",
            room: result.room,
            aiOpponentId: undefined,
            aiBattle: false,
          };
        } else {
          resolvedLaunch = {
            mode: "fallback_ai",
            matchId,
            queueState: "fallback_ai",
            fallbackReason: result.reason,
            aiOpponentId: aiOpponent.id,
            aiBattle: false,
          };
        }
      }
    } finally {
      dismissMatchmakingOverlay?.();
    }
    const loadedMap = await loadMapMerged(mapUrl);
    const difficultyOverride = queryDifficultyOverride(window.location.search);
    const map =
      resolvedLaunch.mode === "pvp" && !difficultyOverride
        ? loadedMap
        : {
          ...loadedMap,
          difficulty: {
            ...(loadedMap.difficulty ?? {}),
            ...(resolvedLaunch.mode === "pvp" ? {} : aiOpponent.difficulty),
            ...(difficultyOverride ?? {}),
          },
        };
    const renderer = new GameRenderer(canvas, CONTROL_PROFILE);
    await renderer.loadTerrainFromMap(map);
    let state: GameState = createInitialState(map, initialDoctrine);
    applyControlProfileDefaults(state);
    configureGamePortals(state, portalContext, window.location.href);
    if (resolvedLaunch.aiBattle) {
      state.heroCaptainEnabled = true;
      state.heroCaptainLastManualTick = -9999;
      state.lastMessage = `Owner AI duel: Captain mode vs tier ${aiOpponent.tier} ${aiOpponent.name}.`;
    } else if (resolvedLaunch.mode === "ai") {
      state.lastMessage = `AI ladder: tier ${aiOpponent.tier} ${aiOpponent.name}. Beat it twice to unlock the next model.`;
    }
    if (resolvedLaunch.mode === "pvp") {
      state.lastMessage = `Matched online (${resolvedLaunch.seat ?? "seat"}). Server-authoritative sync is active for room ${resolvedLaunch.room?.roomId ?? "battle"}.`;
    } else if (resolvedLaunch.mode === "fallback_ai") {
      state.lastMessage = "No human opponent found quickly — AI rival engaged.";
    }
    let onlineSession: OnlineMatchSession | null = null;
    if (resolvedLaunch.mode === "pvp") {
      const room = getActiveBattleRoom();
      if (room) {
        onlineSession = attachOnlineMatchRoom(room, {
          matchId: resolvedLaunch.matchId,
          onSnapshot: (snapshot) => {
            if (snapshot.phase === "playing") {
              const syncStats = onlineSession?.stats();
              const gapCopy = syncStats && syncStats.gaps > 0 ? ` (${syncStats.gaps} net gap${syncStats.gaps === 1 ? "" : "s"})` : "";
              state.lastMessage = `Online sync tick ${snapshot.serverTick}${gapCopy} — rendering authoritative snapshots.`;
            }
          },
          onOpponentAiTakeover: () => {
            resolvedLaunch = {
              ...resolvedLaunch,
              mode: "fallback_ai",
              fallbackReason: "opponent_left",
              aiOpponentId: aiOpponent.id,
              aiBattle: false,
            };
            state.lastMessage = "Opponent disconnected — AI has taken over.";
          },
          onInvalidMessage: (reason) => {
            console.warn("[multiplayer] invalid message", reason);
          },
          onLifecycle: (event, payload) => {
            console.info("[multiplayer] lifecycle", event, payload);
          },
        });
      }
    }
    let replay = createReplayCapture(state, map);
    const matchAbort = new AbortController();
    const signal = matchAbort.signal;
    mountMatchSkyboxAdjuster(renderer, signal);
    const testWindow = window as Window & {
      render_game_to_text?: () => string;
      advanceTime?: (ms: number) => void;
      __signalWarsDebugCastSlot?: (slotIndex: number, x: number, z: number) => string | null;
      __signalWarsDebugSpellFx?: (
        element: SpellFxElement,
        shape: SpellFxShape,
        x: number,
        z: number,
        opts?: { fromX?: number; fromZ?: number; radius?: number; reach?: number; width?: number },
      ) => string | null;
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
        portal: {
          enteredViaPortal: state.portal.enteredViaPortal,
          exit: state.portal.exitPortal,
          return: state.portal.returnUrl ? state.portal.returnPortal : null,
          pendingRedirect: !!state.portal.pendingRedirectUrl,
        },
        aiOpponent: resolvedLaunch.mode === "pvp"
          ? null
          : {
            id: aiOpponent.id,
            tier: aiOpponent.tier,
            name: aiOpponent.name,
            provider: aiOpponent.provider,
            model: aiOpponent.model,
            aiBattle: resolvedLaunch.aiBattle === true,
          },
        controlProfile: CONTROL_PROFILE.mode,
        captainMode: state.heroCaptainEnabled,
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
      if (!renderer.isMatchIntroActive()) {
        for (let i = 0; i < steps; i++) advanceTick(state, []);
      }
      if (state.portal.pendingRedirectUrl) return;
      renderer.sync(state, USE_GLB);
      renderer.render();
      markFirstInteractiveOnce(state);
      updateHud(state);
    };
    renderer.sync(state, USE_GLB);
    renderer.setCameraFollowHero(true);
    const resize = (): void => {
      const { w, h } = viewportCssSize();
      renderer.setSize(w, h);
    };
    resize();
    window.addEventListener("resize", resize, { signal });
    window.visualViewport?.addEventListener("resize", resize, { signal });
    window.visualViewport?.addEventListener("scroll", resize, { signal });

    const pendingIntents: PlayerIntent[] = [];
    const doctrineDragRef = { active: false };
    let invalidCommandTargetAttempts = 0;

    const clearCommandTargetingAfterInvalidTry = (reason: string): void => {
      invalidCommandTargetAttempts = 0;
      state.pendingPlacementCatalogId = null;
      state.selectedDoctrineIndex = null;
      renderer.setCommandGhost(null, null, false);
      state.lastMessage = `${reason} Targeting cancelled.`;
      updateHud(state);
    };

    const shouldCancelRepeatedInvalidCommandTarget = (pos: Vec2): boolean => {
      const pending = state.pendingPlacementCatalogId;
      const slot = state.selectedDoctrineIndex;
      if (!pending || slot === null) {
        invalidCommandTargetAttempts = 0;
        return false;
      }
      const entry = getCatalogEntry(pending);
      if (!entry || isStructureEntry(entry)) {
        invalidCommandTargetAttempts = 0;
        return false;
      }
      const playable = doctrineCardPlayability(state, pending, pos, slot);
      if (playable.reason === null) {
        invalidCommandTargetAttempts = 0;
        return false;
      }
      invalidCommandTargetAttempts++;
      if (invalidCommandTargetAttempts < 2) return false;
      clearCommandTargetingAfterInvalidTry(playable.reason);
      return true;
    };

    const syncDebugFrame = (): string | null => {
      renderer.sync(state, USE_GLB);
      renderer.render();
      updateHud(state);
      return testWindow.render_game_to_text?.() ?? null;
    };
    testWindow.__signalWarsDebugCastSlot = (slotIndex: number, x: number, z: number): string | null => {
      if (state.phase !== "playing") return null;
      if (slotIndex < 0 || slotIndex >= DOCTRINE_SLOT_COUNT) return null;
      state.flux = Math.max(state.flux, 9999);
      state.doctrineCooldownTicks[slotIndex] = 0;
      invalidCommandTargetAttempts = 0;
      pendingIntents.push({ type: "select_doctrine_slot", index: slotIndex });
      pendingIntents.push({ type: "try_click_world", pos: { x, z }, shiftKey: false, altKey: false });
      advanceTick(state, pendingIntents.splice(0, pendingIntents.length));
      return syncDebugFrame();
    };
    testWindow.__signalWarsDebugSpellFx = (
      element: SpellFxElement,
      shape: SpellFxShape,
      x: number,
      z: number,
      opts?: { fromX?: number; fromZ?: number; radius?: number; reach?: number; width?: number },
    ): string | null => {
      if (state.phase !== "playing") return null;
      pushFx(state, {
        kind: "elemental_spell",
        x,
        z,
        fromX: opts?.fromX,
        fromZ: opts?.fromZ,
        element,
        shape,
        impactRadius: opts?.radius,
        reach: opts?.reach,
        width: opts?.width,
        visualSeed: state.tick + Math.round(x * 13 + z * 7),
      });
      return syncDebugFrame();
    };

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
    window.addEventListener("keydown", onKeyDown, { signal });
    window.addEventListener("keyup", onKeyUp, { signal });

    let acc = 0;
    let last = performance.now();
    let lastHudUpdateMs = 0;
    let lastHudTick = -1;
    let lastHudPhase: GameState["phase"] | null = null;
    let rafId = 0;
    let leaderboardRecordedPhase: GameState["phase"] | null = null;
    const recordCompletedMatch = (completed: GameState): void => {
      recordLocalLeaderboardResult(completed, portalContext.params.username);
      void submitDamageLeaderboardEntry({
        username: portalContext.params.username,
        damage: completed.stats.damageDealtPlayer,
        phase: completed.phase,
        durationTicks: completed.tick,
        matchMode: resolvedLaunch.mode,
        mapId: map.mapId ?? mapUrl,
        clientMatchId: resolvedLaunch.matchId,
      })
        .catch(() => undefined);
      if (
        completed.phase === "win" &&
        isAiLadderProgressEligible({
          matchMode: resolvedLaunch.mode,
          aiBattle: resolvedLaunch.aiBattle === true,
          opponentId: resolvedLaunch.aiOpponentId ?? null,
        }) &&
        resolvedLaunch.aiOpponentId
      ) {
        const nextProgress = recordAiLadderWin(resolvedLaunch.aiOpponentId);
        const wins = nextProgress.winsByOpponentId[resolvedLaunch.aiOpponentId] ?? 0;
        completed.lastMessage = `AI ladder win recorded: ${wins} vs ${aiOpponent.name}.`;
        console.info("[ai_ladder] win recorded", {
          opponentId: resolvedLaunch.aiOpponentId,
          wins,
        });
      }
    };

    const tick = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      acc += dt;

      /** Avoid multi-second catch-up stalls after tab backgrounding or long breakpoints. */
      /** Wall-time catch-up cap (~2.4s of sim at current TICK_HZ). */
      const maxTicksThisFrame = 48;
      let ticksThisFrame = 0;
      let first = true;
      if (renderer.isMatchIntroActive()) {
        acc = 0;
      } else {
        while (acc >= 1 / TICK_HZ && ticksThisFrame < maxTicksThisFrame) {
          ticksThisFrame += 1;
          const chunk = first ? pendingIntents.splice(0, pendingIntents.length) : [];
          first = false;
          const tickBefore = state.tick;
          if (onlineSession && chunk.length > 0) onlineSession.sendIntents(tickBefore, chunk);
          advanceTick(state, chunk);
          captureReplayTick(replay, tickBefore, chunk, state);
          if (state.portal.pendingRedirectUrl) {
            window.location.assign(state.portal.pendingRedirectUrl);
            return;
          }
          acc -= 1 / TICK_HZ;
        }
      }

      if (state.phase === "playing" && !renderer.isMatchIntroActive() && (keysHeld.a || keysHeld.d || keysHeld.w || keysHeld.s)) {
        let strafe = 0;
        let forward = 0;
        if (keysHeld.a) strafe -= 1;
        if (keysHeld.d) strafe += 1;
        if (keysHeld.w) forward += 1;
        if (keysHeld.s) forward -= 1;
        renderer.panCameraOnGround(strafe, forward, dt);
        syncCameraFollowUi(hudRoot, renderer.getCameraFollowHero());
      }

      if (!state.pendingPlacementCatalogId && !doctrineDragRef.active) {
        renderer.setPlacementGhost(null, false);
      }

      renderer.sync(state, USE_GLB);
      renderer.render();
      markFirstInteractiveOnce(state);
      if (state.phase !== "playing" && leaderboardRecordedPhase !== state.phase) {
        recordCompletedMatch(state);
        leaderboardRecordedPhase = state.phase;
      }
      const hudDue =
        CONTROL_PROFILE.mode !== "mobile" ||
        state.phase !== lastHudPhase ||
        (state.tick !== lastHudTick && now - lastHudUpdateMs >= 90) ||
        now - lastHudUpdateMs >= 260;
      if (hudDue) {
        updateHud(state);
        syncCameraFollowUi(hudRoot, renderer.getCameraFollowHero());
        lastHudUpdateMs = now;
        lastHudTick = state.tick;
        lastHudPhase = state.phase;
      }

      rafId = requestAnimationFrame(tick);
    };

    const rematch = (): void => {
      cancelAnimationFrame(rafId);
      onlineSession?.dispose();
      onlineSession = null;
      pendingIntents.length = 0;
      clearGameLog();
      renderer.clearCastFx();
      state = createInitialState(map, initialDoctrine);
      applyControlProfileDefaults(state);
      configureGamePortals(state, portalContext, window.location.href);
      if (resolvedLaunch.aiBattle) {
        state.heroCaptainEnabled = true;
        state.heroCaptainLastManualTick = -9999;
        state.lastMessage = `Owner AI duel: Captain mode vs tier ${aiOpponent.tier} ${aiOpponent.name}.`;
      } else if (resolvedLaunch.mode === "ai") {
        state.lastMessage = `AI ladder: tier ${aiOpponent.tier} ${aiOpponent.name}. Beat it twice to unlock the next model.`;
      } else if (resolvedLaunch.mode === "fallback_ai") {
        state.lastMessage = `AI takeover: tier ${aiOpponent.tier} ${aiOpponent.name}.`;
      }
      replay = createReplayCapture(state, map);
      renderer.setPlacementGhost(null, false);
      renderer.sync(state, USE_GLB);
      if (renderer.getCameraFollowHero()) renderer.setCameraFollowHero(true);
      syncCameraFollowUi(hudRoot, renderer.getCameraFollowHero());
      acc = 0;
      last = performance.now();
      leaderboardRecordedPhase = null;
      rafId = requestAnimationFrame(tick);
    };

    const returnToDoctrine = (): void => {
      cancelAnimationFrame(rafId);
      onlineSession?.dispose();
      onlineSession = null;
      matchAbort.abort();
      pendingIntents.length = 0;
      clearGameLog();
      hideSelectBox();
      renderer.clearCastFx();
      renderer.dispose();
      hudRoot.innerHTML = "";
      hideRulesToast();
      try {
        sessionStorage.setItem("signalWarsPortalReturn", "1");
      } catch {
        /* ignore */
      }
      onReturnToDoctrine();
    };

    const applyCameraToggle = (): void => {
      const follow = renderer.toggleCameraFollowHero();
      state.lastMessage = follow
        ? "Camera locked on wizard — zoom with the mouse wheel only."
        : "Camera free — MMB orbit; lock on wizard with Camera or C.";
      syncCameraFollowUi(hudRoot, follow);
    };

    mountHud(hudRoot, state, {
      controlProfile: CONTROL_PROFILE,
      onRematch: rematch,
      onEditDoctrine: returnToDoctrine,
      onCameraFollowToggle: applyCameraToggle,
      pushIntent: (intent) => {
        if (intent.type === "select_doctrine_slot" || intent.type === "clear_placement") invalidCommandTargetAttempts = 0;
        pendingIntents.push(intent);
      },
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
      invalidCommandTargetAttempts = 0;
      pendingIntents.push({ type: "select_doctrine_slot", index });
      const d = hudRoot.querySelector("#doctrine-track");
      if (!d) return;
      for (const el of d.querySelectorAll(".slot")) el.classList.remove("active");
      d.querySelector(`[data-slot-index="${index}"]`)?.classList.add("active");
    };

    // G = stance; V = formation preset; R = arm global rally; C = camera; Z = selected-unit battle cam; T = teleport; 1–0 = doctrine slots.
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
      } else if (ev.code === "KeyV") {
        ev.preventDefault();
        pendingIntents.push({ type: "toggle_formation_preset" });
      } else if (ev.key === "r" || ev.key === "R") {
        ev.preventDefault();
        pendingIntents.push({ type: "begin_rally_click" });
      } else if (ev.code === "KeyC") {
        ev.preventDefault();
        applyCameraToggle();
      } else if (ev.code === "KeyZ") {
        ev.preventDefault();
        const ok = renderer.zoomCameraToSelectedUnit();
        state.lastMessage = ok ? "Battle cam: following selected unit." : "Select a unit first, then press Z for battle cam.";
        syncCameraFollowUi(hudRoot, renderer.getCameraFollowHero());
      } else if (ev.code === "KeyT") {
        ev.preventDefault();
        pendingIntents.push({ type: "begin_hero_teleport" });
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        cancelRightHold();
        if (state.pendingPlacementCatalogId || state.rallyClickPending || state.teleportClickPending) {
          pendingIntents.push({ type: "clear_placement" });
        }
      }
    }, { signal });

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
      startHitX: number;
      startHitZ: number;
      hitX: number;
      hitZ: number;
      shiftKey: boolean;
      altKey: boolean;
      hasSelection: boolean;
      dragFollow: boolean;
      formationDragging: boolean;
    } | null = null;
    let leftSelect: { pointerId: number; startX: number; startY: number; dragging: boolean } | null = null;
    let chordDrag: { pointerId: number; lastX: number; lastY: number } | null = null;
    let middlePanDrag: { pointerId: number; startX: number; startY: number; releasedFollow: boolean } | null = null;
    const mobilePointers = new Map<number, { x: number; y: number }>();
    let mobileCameraDrag: { pointerId: number; lastX: number; lastY: number } | null = null;
    let mobileTap: {
      pointerId: number;
      startX: number;
      startY: number;
      hitX: number;
      hitZ: number;
      moved: boolean;
      longPressArmed: boolean;
      longPressTriggered: boolean;
      longPressTimer: number | null;
    } | null = null;

    const cancelRightHold = (): void => {
      rightHold = null;
      renderer.setFormationGhost(null, null);
    };

    const selectedFormationSlots = (from: { x: number; z: number }, to: { x: number; z: number }, wide: boolean) => {
      const selected = state.units.filter((u) => state.selectedUnitIds.includes(u.id) && u.team === "player" && u.hp > 0);
      return computeFormationSlots(
        selected.map((u) => ({
          id: u.id,
          x: u.x,
          z: u.z,
          sizeClass: u.sizeClass,
          range: u.range,
          flying: u.flying,
        })),
        { from, to, kind: state.formationPreset, depthScale: wide ? 1.75 : 1 },
        state.map.world.halfExtents,
      );
    };

    const beginChordCameraDrag = (ev: PointerEvent): void => {
      ev.preventDefault();
      cancelRightHold();
      leftSelect = null;
      hideSelectBox();
      chordDrag = { pointerId: ev.pointerId, lastX: ev.clientX, lastY: ev.clientY };
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
    };

    const isMobilePointer = (ev: PointerEvent): boolean =>
      CONTROL_PROFILE.mode === "mobile" && ev.pointerType !== "mouse";

    const clearMobileTapLongPressTimer = (tap: NonNullable<typeof mobileTap>): void => {
      if (tap.longPressTimer != null) {
        window.clearTimeout(tap.longPressTimer);
        tap.longPressTimer = null;
      }
    };

    const cancelMobileTap = (): void => {
      if (mobileTap) clearMobileTapLongPressTimer(mobileTap);
      mobileTap = null;
    };

    const beginMobileCameraDrag = (ev: PointerEvent): void => {
      cancelMobileTap();
      cancelRightHold();
      leftSelect = null;
      hideSelectBox();
      mobileCameraDrag = { pointerId: ev.pointerId, lastX: ev.clientX, lastY: ev.clientY };
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
    };

    const issueMobileTapCommand = (ev: PointerEvent, tap: NonNullable<typeof mobileTap>): void => {
      const rect = canvas.getBoundingClientRect();
      const hit = renderer.pickGround(ev.clientX, ev.clientY, rect) ?? { x: tap.hitX, z: tap.hitZ };
      if (state.teleportClickPending) {
        pendingIntents.push({ type: "hero_teleport", x: hit.x, z: hit.z });
        return;
      }
      const pickedUnitId = renderer.pickUnitId(ev.clientX, ev.clientY, rect);
      if (pickedUnitId != null) {
        pendingIntents.push({ type: "select_units", unitIds: [pickedUnitId] });
        return;
      }
      if (state.pendingPlacementCatalogId || state.rallyClickPending) {
        if (shouldCancelRepeatedInvalidCommandTarget(hit)) return;
        pendingIntents.push({
          type: "try_click_world",
          pos: { x: hit.x, z: hit.z },
          shiftKey: false,
          altKey: false,
          pickedUnitId: null,
        });
        return;
      }
      pendingIntents.push({ type: "hero_move", x: hit.x, z: hit.z, shiftKey: false });
      if (state.selectedUnitIds.length > 0) {
        pendingIntents.push({
          type: "command_selected_units",
          x: hit.x,
          z: hit.z,
          mode: "attack_move",
          queue: false,
          includeNearbyIdle: true,
        });
      }
      logGame("move", `Mobile tap → (${hit.x.toFixed(1)}, ${hit.z.toFixed(1)})`, state.tick);
    };

    window.addEventListener(
      "contextmenu",
      (ev) => {
        if (isMatchSurfaceTarget(ev.target)) ev.preventDefault();
      },
      { capture: true, signal },
    );

    canvas.addEventListener("pointerdown", (ev) => {
      hudRoot.querySelector("#doctrine-track")?.removeAttribute("data-hand-peek");
      if (state.phase !== "playing") return;
      if (isMobilePointer(ev)) {
        ev.preventDefault();
        mobilePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (mobilePointers.size >= 2) {
          beginMobileCameraDrag(ev);
          return;
        }
        const rect = canvas.getBoundingClientRect();
        const hit = renderer.pickGround(ev.clientX, ev.clientY, rect);
        if (!hit) return;
        mobileTap = {
          pointerId: ev.pointerId,
          startX: ev.clientX,
          startY: ev.clientY,
          hitX: hit.x,
          hitZ: hit.z,
          moved: false,
          longPressArmed: !state.teleportClickPending,
          longPressTriggered: false,
          longPressTimer: null,
        };
        if (mobileTap.longPressArmed) {
          mobileTap.longPressTimer = window.setTimeout(() => {
            if (!mobileTap || mobileTap.pointerId !== ev.pointerId || mobileTap.moved || mobileCameraDrag) return;
            mobileTap.longPressTriggered = true;
            mobileTap.longPressTimer = null;
            if (state.selectedUnitIds.length > 0) {
              rightHold = {
                pointerId: ev.pointerId,
                lastMs: performance.now(),
                startX: mobileTap.startX,
                startY: mobileTap.startY,
                startHitX: mobileTap.hitX,
                startHitZ: mobileTap.hitZ,
                hitX: mobileTap.hitX,
                hitZ: mobileTap.hitZ,
                shiftKey: false,
                altKey: false,
                hasSelection: true,
                dragFollow: false,
                formationDragging: false,
              };
              state.lastMessage = "Touch hold: drag to shape formation, release to command.";
            } else {
              pendingIntents.push({ type: "hero_move", x: mobileTap.hitX, z: mobileTap.hitZ, shiftKey: false });
              state.lastMessage = "Touch hold: hero move issued.";
            }
          }, CONTROL_PROFILE.longPressMs);
        }
        try {
          canvas.setPointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        return;
      }
      // Middle + modifier rotates through OrbitControls; rotation should keep camera follow locked.
      if (ev.button === 1 && (ev.shiftKey || ev.ctrlKey || ev.metaKey)) return;
      // Middle = camera pan (OrbitControls); this is an explicit camera takeover, not a map click.
      if (ev.button === 1) {
        middlePanDrag = { pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY, releasedFollow: false };
        if (renderer.releaseCameraFollowLock()) {
          state.lastMessage = "Camera free — lock on wizard with Camera/C or select a unit and press Z.";
          syncCameraFollowUi(hudRoot, false);
        }
        return;
      }
      if (ev.button !== 0 && ev.button !== 2) return;
      if ((ev.buttons & 1) && (ev.buttons & 2)) {
        beginChordCameraDrag(ev);
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

      if (ev.button === 2) {
        ev.preventDefault();
        if (state.pendingPlacementCatalogId || state.rallyClickPending) {
          pendingIntents.push({ type: "clear_placement" });
          cancelRightHold();
          return;
        }
        const hasSelection = state.selectedUnitIds.length > 0;
        rightHold = {
          pointerId: ev.pointerId,
          lastMs: performance.now(),
          startX: ev.clientX,
          startY: ev.clientY,
          startHitX: hit.x,
          startHitZ: hit.z,
          hitX: hit.x,
          hitZ: hit.z,
          shiftKey: ev.shiftKey,
          altKey: ev.altKey,
          hasSelection,
          dragFollow: false,
          formationDragging: false,
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
      if (shouldCancelRepeatedInvalidCommandTarget(hit)) return;
      pendingIntents.push({
        type: "try_click_world",
        pos: { x: hit.x, z: hit.z },
        shiftKey: ev.shiftKey,
        altKey: ev.altKey,
        pickedUnitId,
      });
    }, { signal });

    canvas.addEventListener("pointerup", (ev) => {
      if (isMobilePointer(ev)) {
        mobilePointers.delete(ev.pointerId);
        if (mobileCameraDrag && ev.pointerId === mobileCameraDrag.pointerId) mobileCameraDrag = null;
        if (mobileTap && ev.pointerId === mobileTap.pointerId) {
          const snap = mobileTap;
          cancelMobileTap();
          try {
            if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
          } catch {
            /* ignore */
          }
          if (!snap.moved && !snap.longPressTriggered) issueMobileTapCommand(ev, snap);
        }
        return;
      }
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
            if (shouldCancelRepeatedInvalidCommandTarget(hit)) return;
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
      if (middlePanDrag && ev.pointerId === middlePanDrag.pointerId) middlePanDrag = null;
      if (chordDrag && ev.pointerId === chordDrag.pointerId) chordDrag = null;
      if (rightHold && ev.pointerId === rightHold.pointerId) {
        const snap = rightHold;
        rightHold = null;
        renderer.setFormationGhost(null, null);
        try {
          if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        if (snap.formationDragging) {
          pendingIntents.push({
            type: "command_selected_units_formation",
            from: { x: snap.startHitX, z: snap.startHitZ },
            to: { x: snap.hitX, z: snap.hitZ },
            mode: snap.altKey ? "attack_move" : "move",
            queue: snap.shiftKey,
            formationKind: state.formationPreset,
            depthScale: snap.shiftKey ? 1.75 : 1,
          });
          logGame(
            "move",
            `RMB ${formationKindLabel(state.formationPreset)} formation → (${snap.hitX.toFixed(1)}, ${snap.hitZ.toFixed(
              1,
            )})`,
            state.tick,
          );
        } else if (!snap.dragFollow) {
          pendingIntents.push({ type: "hero_move", x: snap.hitX, z: snap.hitZ, shiftKey: snap.shiftKey });
          logGame("move", `RMB move → (${snap.hitX.toFixed(1)}, ${snap.hitZ.toFixed(1)})`, state.tick);
          if (snap.hasSelection) {
            pendingIntents.push({
              type: "command_selected_units",
              x: snap.hitX,
              z: snap.hitZ,
              mode: snap.altKey ? "attack_move" : "move",
              queue: snap.shiftKey,
            });
          }
        }
      }
    }, { signal });
    canvas.addEventListener("pointercancel", (ev) => {
      if (isMobilePointer(ev)) {
        mobilePointers.delete(ev.pointerId);
        if (mobileCameraDrag && ev.pointerId === mobileCameraDrag.pointerId) mobileCameraDrag = null;
        if (mobileTap && ev.pointerId === mobileTap.pointerId) cancelMobileTap();
      }
      hideSelectBox();
      if (leftSelect && ev.pointerId === leftSelect.pointerId) leftSelect = null;
      if (middlePanDrag && ev.pointerId === middlePanDrag.pointerId) middlePanDrag = null;
      if (chordDrag && ev.pointerId === chordDrag.pointerId) chordDrag = null;
      if (rightHold && ev.pointerId === rightHold.pointerId) {
        cancelRightHold();
      }
    }, { signal });

    canvas.addEventListener("pointermove", (ev) => {
      if (isMobilePointer(ev)) {
        const prev = mobilePointers.get(ev.pointerId);
        mobilePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (mobileCameraDrag && ev.pointerId === mobileCameraDrag.pointerId) {
          const dx = ev.clientX - mobileCameraDrag.lastX;
          const dy = ev.clientY - mobileCameraDrag.lastY;
          mobileCameraDrag.lastX = ev.clientX;
          mobileCameraDrag.lastY = ev.clientY;
          renderer.rotateCameraByPixels(dx, dy);
          syncCameraFollowUi(hudRoot, renderer.getCameraFollowHero());
          return;
        }
        if (mobilePointers.size >= 2 && !mobileCameraDrag) {
          beginMobileCameraDrag(ev);
          return;
        }
        if (mobileTap && ev.pointerId === mobileTap.pointerId) {
          const dx = ev.clientX - mobileTap.startX;
          const dy = ev.clientY - mobileTap.startY;
          if (!mobileTap.moved && dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
            mobileTap.moved = true;
            clearMobileTapLongPressTimer(mobileTap);
          }
          const rectM = canvas.getBoundingClientRect();
          const hitM = renderer.pickGround(ev.clientX, ev.clientY, rectM);
          if (hitM) {
            mobileTap.hitX = hitM.x;
            mobileTap.hitZ = hitM.z;
          } else if (!prev) {
            return;
          }
          return;
        }
      }
      if (middlePanDrag && ev.pointerId === middlePanDrag.pointerId) {
        const dx = ev.clientX - middlePanDrag.startX;
        const dy = ev.clientY - middlePanDrag.startY;
        if (!middlePanDrag.releasedFollow && dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
          middlePanDrag.releasedFollow = true;
          if (renderer.releaseCameraFollowLockNow()) {
            state.lastMessage = "Camera free - lock on wizard with Camera/C or select a unit and press Z.";
            syncCameraFollowUi(hudRoot, false);
          }
        }
        return;
      }
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
        beginChordCameraDrag(ev);
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
        const moved = mdx * mdx + mdy * mdy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX;
        if (moved && !rightHold.hasSelection) rightHold.dragFollow = true;
        if (moved && rightHold.hasSelection) rightHold.formationDragging = true;
        rightHold.shiftKey = ev.shiftKey;
        rightHold.altKey = ev.altKey;
        const now = performance.now();
        if (now - rightHold.lastMs >= 80) {
          rightHold.lastMs = now;
          const rectM = canvas.getBoundingClientRect();
          const hitM = renderer.pickGround(ev.clientX, ev.clientY, rectM);
          /** Drag-update follows cursor only (no queue append each tick). */
          if (hitM) {
            rightHold.hitX = hitM.x;
            rightHold.hitZ = hitM.z;
            if (rightHold.dragFollow) pendingIntents.push({ type: "hero_move", x: hitM.x, z: hitM.z, shiftKey: false });
            if (rightHold.formationDragging) {
              const from = { x: rightHold.startHitX, z: rightHold.startHitZ };
              const to = { x: hitM.x, z: hitM.z };
              renderer.setFormationGhost(from, to, selectedFormationSlots(from, to, ev.shiftKey), true);
              state.lastMessage = `Formation: ${formationKindLabel(state.formationPreset)}${ev.shiftKey ? " wide ranks" : ""}.`;
            }
          }
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
        const playable = doctrineCardPlayability(state, pending, hit, slot);
        const valid = playable.reason === null;
        const linePrev = commandLineGhostPreview(entry);
        if (linePrev) {
          renderer.setCommandGhost(hit, null, valid, {
            fromX: state.hero.x,
            fromZ: state.hero.z,
            length: linePrev.length,
            halfWidth: linePrev.halfWidth,
          }, entry.effect.type);
        } else {
          renderer.setCommandGhost(hit, commandEffectRadius(entry), valid, undefined, entry.effect.type);
        }
        return;
      }
      renderer.setCommandGhost(null, null, false);
      const valid = canPlaceStructureHere(state, pending, hit, slot) === null;
      renderer.setPlacementGhost(hit, valid);
    }, { signal });

    canvas.addEventListener("pointerleave", () => {
      if (!doctrineDragRef.active) {
        renderer.setPlacementGhost(null, false);
        renderer.setCommandGhost(null, null, false);
      }
    }, { signal });

    bindReplayDebugGlobals(() => replay);
    rafId = requestAnimationFrame(tick);
  })().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    document.body.textContent = String(e);
  });
}

/** Legacy dev URL; prematch layout is now the shipped defaults — drop so bookmarks land clean. */
function stripLegacyPrematchCalibrateParams(): void {
  try {
    const url = new URL(window.location.href);
    let changed = false;
    /** Keep `?binderCalibrate=1` — dev-only prematch layout panel (see `DoctrineBinderPicker` / `BinderLayoutCalibratePanel`). */
    if (url.searchParams.get("calibrate") === "1") {
      url.searchParams.delete("calibrate");
      changed = true;
    }
    if (!changed) return;
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", next);
  } catch {
    /* ignore */
  }
}
stripLegacyPrematchCalibrateParams();
installCardArtOverlayCalibrator();
const params = new URLSearchParams(window.location.search);
const portalContext = parsePortalContext(params);
const quickMatch = params.get("quickMatch") === "1" || params.get("testMatch") === "1";
function mountPortalPicker(onReady?: () => void): void {
  pickerRoot.style.display = "";
  if (portalContext.enteredViaPortal) {
    try {
      sessionStorage.setItem("signalWarsPortalReturn", "1");
    } catch {
      /* ignore */
    }
  }
  mountDoctrinePicker(pickerRoot, (slots, chosenMapUrl, mode = "ai", launchOptions = {}) => {
    runMatch(slots, chosenMapUrl, mountPortalPicker, portalContext, {
      ...launchOptions,
      mode,
      matchId: makeClientMatchId(),
      queueState: mode === "matchmake" || mode === "matchmake_strict" ? "searching" : "idle",
    });
  }, portalContext, onReady);
}

async function boot(): Promise<void> {
  if (quickMatch) {
    pickerRoot.style.display = "none";
    const stored = loadDoctrineSlots();
    const slotRow = doctrineSlotsForUrlQuickMatch(stored);
    const mapParam = params.get("map");
    let mapUrl = mapParam ?? DEFAULT_MAP_URL;
    if (!mapParam && isUserDoctrineHandViableForQuickMatch(stored)) {
      try {
        const saved = localStorage.getItem("signalWarsMapUrl.v2");
        if (saved && MAP_REGISTRY.some((m) => m.url === saved)) mapUrl = saved;
      } catch {
        /* ignore */
      }
    }
    const mode = normalizeMatchMode(params.get("opponent"));
    runMatch([...slotRow], mapUrl, mountPortalPicker, portalContext, {
      mode,
      matchId: makeClientMatchId(),
      queueState: mode === "matchmake" || mode === "matchmake_strict" ? "searching" : "idle",
    });
  } else {
    mountPortalPicker();
  }
}

void boot();
