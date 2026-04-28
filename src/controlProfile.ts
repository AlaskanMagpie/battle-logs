export type ControlProfileMode = "desktop" | "mobile";

export interface ControlProfile {
  mode: ControlProfileMode;
  coarsePointer: boolean;
  touchPoints: number;
  lowPower: boolean;
  maxPixelRatio: number;
  binderMaxPixelRatio: number;
  longPressMs: number;
  captainDefault: boolean;
}

export interface ControlProfileInput {
  override?: string | null;
  coarsePointer?: boolean;
  touchPoints?: number;
  hardwareConcurrency?: number;
  devicePixelRatio?: number;
}

function cleanOverride(value: string | null | undefined): ControlProfileMode | null {
  const v = value?.trim().toLowerCase();
  return v === "mobile" || v === "desktop" ? v : null;
}

export function resolveControlProfile(input: ControlProfileInput = {}): ControlProfile {
  const override = cleanOverride(input.override);
  const coarsePointer = input.coarsePointer === true;
  const touchPoints = Math.max(0, Math.floor(input.touchPoints ?? 0));
  const cores = Math.max(1, Math.floor(input.hardwareConcurrency ?? 8));
  const dpr = Math.max(1, input.devicePixelRatio ?? 1);
  const lowPower = cores <= 4 || dpr >= 2.5;
  const mode: ControlProfileMode = override ?? (coarsePointer || touchPoints > 0 ? "mobile" : "desktop");

  return {
    mode,
    coarsePointer,
    touchPoints,
    lowPower,
    maxPixelRatio: mode === "mobile" ? 1 : lowPower ? 1 : 1.25,
    binderMaxPixelRatio: mode === "mobile" ? 1 : lowPower ? 1.25 : 1.6,
    longPressMs: mode === "mobile" ? 560 : 360,
    captainDefault: mode === "mobile",
  };
}

export function getStoredControlProfileOverride(): ControlProfileMode | null {
  try {
    return cleanOverride(window.localStorage.getItem("sw:controlProfile"));
  } catch {
    return null;
  }
}

export function getControlProfile(): ControlProfile {
  const nav = globalThis.navigator;
  const win = globalThis.window;
  return resolveControlProfile({
    override: getStoredControlProfileOverride(),
    coarsePointer: win.matchMedia?.("(pointer: coarse)")?.matches === true,
    touchPoints: nav.maxTouchPoints ?? 0,
    hardwareConcurrency: nav.hardwareConcurrency ?? 8,
    devicePixelRatio: win.devicePixelRatio ?? 1,
  });
}

export function applyControlProfileToDocument(profile: ControlProfile): void {
  document.documentElement.dataset.controlProfile = profile.mode;
  document.documentElement.classList.toggle("is-mobile-profile", profile.mode === "mobile");
  document.documentElement.classList.toggle("is-desktop-profile", profile.mode === "desktop");
}
