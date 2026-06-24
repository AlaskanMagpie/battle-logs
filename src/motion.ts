/**
 * Shared motion layer — a thin, reduced-motion-aware wrapper over anime.js (v4)
 * used across the HUD, card UI, comic intro, and 3D scene choreography.
 *
 * Why a wrapper instead of importing `animejs` directly at each call site:
 *
 *  - **One reduced-motion gate.** Doctrine already honors
 *    `prefers-reduced-motion` in `hud.ts` and `hud.css`. Going animation-heavy
 *    must not break that contract, so every helper here resolves to the final
 *    state *immediately* (no tween, callbacks still fire) when the user opts
 *    out of motion. Call sites never have to branch.
 *  - **Count-ups in one place.** `tweenCount` drives the HUD resource/stat
 *    numbers from their last displayed value toward a new target, retargeting
 *    smoothly instead of integer-stepping.
 *  - **Small primitives** (`flashElement`, `shakeElement`) shared by the
 *    "can't afford" and damage feedback paths.
 *
 * anime.js v4 notes: the easing field is `ease` (not v3's `easing`), callbacks
 * are `onUpdate`/`onComplete`/`onBegin`, and `utils.remove(target)` cancels any
 * in-flight animation of a target. Easings may be passed as strings
 * (e.g. "outExpo", "outBack(1.7)", "outElastic(1, .5)").
 */
import { animate, utils, stagger } from "animejs";

export { animate, utils, stagger };

/** Parameter object accepted by anime.js `animate(targets, params)`. */
export type MotionParams = Parameters<typeof animate>[1];
/** Targets accepted by anime.js `animate(targets, params)`. */
export type MotionTargets = Parameters<typeof animate>[0];
export type MotionHandle = ReturnType<typeof animate>;

/**
 * Cache the reduced-motion MediaQueryList. `window.matchMedia(...)` is a
 * comparatively expensive call to make on every animation; reading `.matches`
 * on a cached query stays live (it reflects later preference changes) while
 * avoiding the per-call cost. Mirrors the same pattern in `ui/hud.ts`.
 */
let reducedMotionQuery: MediaQueryList | null | undefined;
export function prefersReducedMotion(): boolean {
  if (reducedMotionQuery === undefined) {
    reducedMotionQuery =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
  }
  return reducedMotionQuery?.matches ?? false;
}

/**
 * Reduced-motion-aware `animate`. When the user prefers reduced motion the
 * animation snaps to its end state in a single 0ms tick — anime.js still
 * applies the final property values and fires `onBegin`/`onComplete`, so
 * sequencing callbacks keep working. Otherwise it behaves exactly like
 * `animate(targets, params)`.
 */
export function motionAnimate(targets: MotionTargets, params: MotionParams): MotionHandle {
  if (prefersReducedMotion()) {
    return animate(targets, { ...params, duration: 0, delay: 0, ease: "linear" });
  }
  return animate(targets, params);
}

/**
 * Stagger delay that collapses to `0` under reduced motion (so a cascade
 * becomes a single instant snap) and is a normal `stagger(...)` otherwise.
 * Use as the `delay` of a `motionAnimate` over many targets.
 */
export function motionStagger(value: number, params?: Parameters<typeof stagger>[1]) {
  if (prefersReducedMotion()) return 0;
  return stagger(value, params);
}

/** Cancel any in-flight animation(s) of the given target(s). */
export function motionStop(targets: MotionTargets): void {
  try {
    utils.remove(targets);
  } catch {
    /* target may already be gone */
  }
}

export type TweenNumberOptions = {
  from: number;
  to: number;
  duration?: number;
  ease?: string;
  /** Render the (possibly fractional) tweened value to the screen. */
  onRender: (value: number) => void;
  onComplete?: () => void;
};

/**
 * Tween a single scalar from `from` to `to`, calling `onRender` each frame.
 * Animates a private proxy object (anime.js animates plain JS objects), so it
 * works for any displayed number — DOM text, a bar width, etc. Snaps under
 * reduced motion.
 */
export function tweenNumber(opts: TweenNumberOptions): MotionHandle | null {
  const { from, to, duration = 280, ease = "outQuad", onRender, onComplete } = opts;
  if (prefersReducedMotion() || from === to) {
    onRender(to);
    onComplete?.();
    return null;
  }
  const proxy = { v: from };
  return animate(proxy, {
    v: to,
    duration,
    ease,
    onUpdate: () => onRender(proxy.v),
    onComplete: () => {
      onRender(to);
      onComplete?.();
    },
  });
}

/** Per-element bookkeeping so repeated updates retarget a single value smoothly. */
type TrackState = { displayed: number; target: number };
const trackStates = new WeakMap<Element, TrackState>();

type TrackOptions = {
  duration?: number;
  ease?: string;
  minDelta?: number;
  /** Starting value when no prior state is retained (e.g. roll up from 0). */
  from?: number;
  /** Delay before the tween starts — handy for staggering a group of counts. */
  delay?: number;
};

/**
 * Core retargeting tween: animate one scalar per element from its previously
 * displayed value toward `target`, calling `render` each frame. Retargets
 * in-flight if called again before settling — so it can be driven every frame
 * from `updateHud`. Snaps under reduced motion or when within `minDelta`.
 */
function tweenTracked(
  el: Element,
  target: number,
  render: (value: number) => void,
  opts: TrackOptions,
): void {
  const prev = trackStates.get(el);
  if (prev && prev.target === target) return;

  const from = prev ? prev.displayed : opts.from ?? target;
  const state: TrackState = { displayed: from, target };
  trackStates.set(el, state);

  const minDelta = opts.minDelta ?? 0;
  if (prefersReducedMotion() || Math.abs(target - from) <= minDelta) {
    state.displayed = target;
    render(target);
    return;
  }

  motionStop(prev ?? state);
  render(from);
  animate(state, {
    displayed: target,
    duration: opts.duration ?? 300,
    ease: opts.ease ?? "outQuad",
    delay: opts.delay ?? 0,
    onUpdate: () => render(state.displayed),
    onComplete: () => {
      state.displayed = target;
      render(target);
    },
  });
}

export type CountOptions = TrackOptions & {
  /** Format the value for display. Defaults to `String(Math.round(v))`. */
  format?: (value: number) => string;
};

/**
 * Animate an element's text from its previously displayed number toward
 * `target`. Ideal for HUD resources/stats updated every frame: trickle reads as
 * a smooth rising counter, discrete jumps get a satisfying roll-up.
 */
export function tweenCount(el: HTMLElement, target: number, opts: CountOptions = {}): void {
  const format = opts.format ?? ((v: number) => String(Math.round(v)));
  tweenTracked(el, target, (v) => (el.textContent = format(v)), opts);
}

/**
 * Animate an element's `width` toward `pct` (0..100), so HP/progress bars drain
 * and fill smoothly instead of snapping. Retargets every frame.
 */
export function tweenBarPercent(el: HTMLElement, pct: number, opts: TrackOptions = {}): void {
  const clamped = Math.max(0, Math.min(100, pct));
  // anime.js writes width every frame; suppress any CSS `transition: width` on
  // the element so the two don't compound (and so reduced motion snaps cleanly).
  el.style.transition = "none";
  tweenTracked(
    el,
    clamped,
    (v) => {
      el.style.width = `${Math.max(0, Math.min(100, v))}%`;
    },
    { duration: 240, ...opts },
  );
}

/** Drop any retained tween state for an element (e.g. on teardown/rebuild). */
export function resetCount(el: HTMLElement): void {
  const s = trackStates.get(el);
  if (s) motionStop(s);
  trackStates.delete(el);
}

export type FlashOptions = {
  /** CSS color for the flash overlay tint via box-shadow/filter. */
  color?: string;
  duration?: number;
  /** Peak intensity 0..1. */
  intensity?: number;
};

/**
 * Brief brightness flash on an element — used for "can't afford" denials and
 * damage hits. Cancels any in-flight flash on the same element first (so rapid
 * hits don't stack competing filter animations) and clears the inline filter on
 * completion. No-op under reduced motion.
 */
export function flashElement(el: HTMLElement | null, opts: FlashOptions = {}): MotionHandle | null {
  if (!el || prefersReducedMotion()) return null;
  const intensity = opts.intensity ?? 1;
  const color = opts.color ?? "rgba(255,90,90,0.85)";
  motionStop(el);
  return animate(el, {
    filter: [
      "brightness(1) drop-shadow(0 0 0 transparent)",
      `brightness(${1 + 0.6 * intensity}) drop-shadow(0 0 ${8 * intensity}px ${color})`,
      "brightness(1) drop-shadow(0 0 0 transparent)",
    ],
    duration: opts.duration ?? 420,
    ease: "outQuad",
    onComplete: () => {
      el.style.filter = "";
    },
  });
}

/** Short horizontal shake — pairs with `flashElement` for denied actions. */
export function shakeElement(el: HTMLElement | null, amplitude = 6): MotionHandle | null {
  if (!el || prefersReducedMotion()) return null;
  return animate(el, {
    translateX: [0, -amplitude, amplitude, -amplitude * 0.6, amplitude * 0.6, 0],
    duration: 360,
    ease: "outQuad",
  });
}
