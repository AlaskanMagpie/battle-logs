import { HERO_SPEED } from "./constants";
import type { GameState } from "./state";

export const VIBE_JAM_PORTAL_URL = "https://vibej.am/portal/2026";

const PORTAL_PARAM_KEYS = [
  "username",
  "color",
  "speed",
  "ref",
  "avatar_url",
  "team",
  "hp",
  "speed_x",
  "speed_y",
  "speed_z",
  "rotation_x",
  "rotation_y",
  "rotation_z",
] as const;

export type PortalParamKey = (typeof PORTAL_PARAM_KEYS)[number];

export interface PortalContext {
  enteredViaPortal: boolean;
  params: Partial<Record<PortalParamKey, string>>;
  ref: string | null;
}

function cleanParam(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) return null;
  return trimmed;
}

export function parsePortalContext(search: string | URLSearchParams): PortalContext {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const out: Partial<Record<PortalParamKey, string>> = {};
  for (const key of PORTAL_PARAM_KEYS) {
    const value = params.get(key);
    if (value == null) continue;
    const clean = cleanParam(value);
    if (clean != null) out[key] = clean;
  }
  return {
    enteredViaPortal: params.get("portal") === "true",
    params: out,
    ref: out.ref ?? null,
  };
}

function currentGameRef(currentUrl: string): string {
  try {
    const url = new URL(currentUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return currentUrl.split("?")[0] ?? currentUrl;
  }
}

function normalizeRedirectBase(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).toString();
  } catch {
    try {
      return new URL(`https://${trimmed}`).toString();
    } catch {
      return null;
    }
  }
}

function addParams(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function portalContinuityParams(
  ctx: PortalContext,
  state: GameState,
  currentUrl: string,
): Record<string, string> {
  const hp = state.hero.maxHp > 0 ? Math.round((state.hero.hp / state.hero.maxHp) * 100) : 100;
  return {
    ...ctx.params,
    color: ctx.params.color ?? "56c9ff",
    speed: ctx.params.speed ?? HERO_SPEED.toFixed(1),
    hp: String(Math.max(1, Math.min(100, hp))),
    ref: currentGameRef(currentUrl),
  };
}

export function buildVibeJamExitUrl(ctx: PortalContext, state: GameState, currentUrl: string): string {
  return addParams(VIBE_JAM_PORTAL_URL, portalContinuityParams(ctx, state, currentUrl));
}

export function buildReturnPortalUrl(ctx: PortalContext, state: GameState, currentUrl: string): string | null {
  if (!ctx.ref) return null;
  const base = normalizeRedirectBase(ctx.ref);
  if (!base) return null;
  return addParams(base, {
    ...portalContinuityParams(ctx, state, currentUrl),
    portal: "true",
  });
}

/** Return URL for binder / pre-match (no live `GameState` hero snapshot). */
export function buildReturnPortalUrlForPrematch(ctx: PortalContext, currentUrl: string): string | null {
  if (!ctx.ref) return null;
  const base = normalizeRedirectBase(ctx.ref);
  if (!base) return null;
  const raw = ctx.params.hp;
  const parsed = raw != null ? Number.parseInt(raw, 10) : NaN;
  const hpStr = Number.isFinite(parsed) ? String(Math.max(1, Math.min(100, parsed))) : "100";
  return addParams(base, {
    ...ctx.params,
    color: ctx.params.color ?? "56c9ff",
    speed: ctx.params.speed ?? HERO_SPEED.toFixed(1),
    hp: hpStr,
    ref: currentGameRef(currentUrl),
    portal: "true",
  });
}

/**
 * Match-time portal state: Vibe Jam exit/return URLs are **not** used on the battlefield.
 * Continuity links are built in the doctrine binder (`buildVibeJamExitUrlForPrematch` / `buildReturnPortalUrl`)
 * so the arcane portal UX stays in the staging room only.
 */
export function configureGamePortals(state: GameState, ctx: PortalContext, _currentUrl: string): void {
  state.portal.enteredViaPortal = ctx.enteredViaPortal;
  state.portal.exitUrl = "";
  state.portal.returnUrl = null;
  state.portal.pendingRedirectUrl = null;
  state.portal.cooldownTicksRemaining = 0;
}

/** Exit URL for the binder / pre-match UI (no `GameState` hero snapshot yet). */
export function buildVibeJamExitUrlForPrematch(ctx: PortalContext, currentUrl: string): string {
  const raw = ctx.params.hp;
  const parsed = raw != null ? Number.parseInt(raw, 10) : NaN;
  const hpStr = Number.isFinite(parsed) ? String(Math.max(1, Math.min(100, parsed))) : "100";
  return addParams(VIBE_JAM_PORTAL_URL, {
    ...ctx.params,
    color: ctx.params.color ?? "56c9ff",
    speed: ctx.params.speed ?? HERO_SPEED.toFixed(1),
    hp: hpStr,
    ref: currentGameRef(currentUrl),
  });
}
