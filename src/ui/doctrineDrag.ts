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

export function pointInRect(px: number, py: number, r: DOMRect): boolean {
  return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
}
