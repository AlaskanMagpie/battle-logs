/**
 * Explicit interaction modes for the doctrine binder.
 * Maps engine flags to a single source of truth for gating picks and page gestures.
 */

export type BinderUiMode =
  | "closed"
  | "opening"
  | "open_idle"
  | "page_gesture"
  | "page_spring"
  | "orbit";

export type BinderUiModeInput = {
  /** 0 = closed tome; 1 = binder fully open; (0,1) = cover in motion. */
  openingProgress: number;
  orb: boolean;
  fl: number;
  drag: boolean;
  tgt: number | null;
};

const OPEN_EPS = 1e-4;

/** Must match `CardBinderEngine` gates / `onOpenStateChange` — not `1 - OPEN_EPS` or picks stay dead while the UI looks open. */
export const BINDER_FULLY_OPEN_PROGRESS = 0.999;

export function deriveBinderUiMode(input: BinderUiModeInput): BinderUiMode {
  if (input.orb) return "orbit";
  if (input.openingProgress < BINDER_FULLY_OPEN_PROGRESS) {
    if (input.openingProgress > OPEN_EPS) return "opening";
    return "closed";
  }
  if (input.fl !== 0 && input.drag) return "page_gesture";
  if (input.fl !== 0 && input.tgt !== null && !input.drag) return "page_spring";
  return "open_idle";
}

export function interactionMayPickCatalog(mode: BinderUiMode): boolean {
  return mode === "open_idle";
}

export function interactionMayArmPageTurn(mode: BinderUiMode): boolean {
  return mode === "open_idle";
}
