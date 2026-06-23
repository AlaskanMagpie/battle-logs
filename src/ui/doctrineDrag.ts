import { motionAnimate, prefersReducedMotion } from "../motion";

/** Pixels of movement before a pointer gesture counts as a drag (vs click). */
export const DRAG_THRESHOLD_PX = 10;

export function makeDragGhost(innerHtml: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "doctrine-drag-ghost";
  el.innerHTML = innerHtml;
  el.style.pointerEvents = "none";
  document.body.appendChild(el);
  return el;
}

export function moveDragGhost(el: HTMLElement | null, clientX: number, clientY: number): void {
  if (!el) return;
  el.style.left = `${clientX + 14}px`;
  el.style.top = `${clientY + 14}px`;
}

export function destroyDragGhost(el: HTMLElement | null): void {
  el?.remove();
}

/**
 * Failed play: glide the drag ghost back to its source slot and fade it out
 * before removing, so a rejected card reads as "returned to hand" rather than
 * vanishing. Removes immediately under reduced motion or without a target.
 */
export function snapBackDragGhost(el: HTMLElement | null, targetEl: HTMLElement | null): void {
  if (!el) return;
  if (prefersReducedMotion() || !targetEl || !targetEl.isConnected) {
    el.remove();
    return;
  }
  const r = targetEl.getBoundingClientRect();
  motionAnimate(el, {
    left: `${r.left + r.width / 2}px`,
    top: `${r.top + r.height / 2}px`,
    scale: [1, 0.55],
    opacity: [1, 0.18, 0],
    duration: 260,
    ease: "outQuad",
    onComplete: () => el.remove(),
  });
}

/**
 * Successful play: pop the ghost at the drop point — a brief swell then
 * collapse into the battlefield — handing off to the 3D cast FX. Removes
 * immediately under reduced motion.
 */
export function spendDragGhost(el: HTMLElement | null): void {
  if (!el) return;
  if (prefersReducedMotion()) {
    el.remove();
    return;
  }
  motionAnimate(el, {
    translateY: -16,
    scale: [1, 1.16, 0.2],
    opacity: [1, 0.9, 0],
    rotate: "6deg",
    duration: 280,
    ease: "outQuad",
    onComplete: () => el.remove(),
  });
}

export function pointInRect(px: number, py: number, r: DOMRect): boolean {
  return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
}
