import type { MapDifficulty } from "../game/types";
import type { MatchMode } from "../net/protocol";

export const AI_LADDER_WINS_TO_UNLOCK = 2;
export const AI_LADDER_PROGRESS_KEY = "signalWars_aiLadderProgress_v1";
export const AI_ADMIN_STORAGE_KEY = "signalWars_aiAdmin.v1";

export type AiProviderKind = "local" | "groq" | "cloudflare" | "gemini" | "openserv";
export type AiPricingConfidence =
  | "known_api_pricing"
  | "submitter_paid"
  | "inferred_pass_through"
  | "unknown_platform_fee";
export type AiCostOwner = "game" | "submitter" | "unknown";

export interface AiLadderOpponent {
  id: string;
  tier: number;
  name: string;
  title: string;
  provider: AiProviderKind;
  model: string;
  /** Adapter id for future provider-backed calls. Current MVP still uses the built-in rival executor. */
  adapter: "local-openai-compatible" | "openai-compatible" | "gemini";
  maxDecisionCalls: number;
  decisionCadenceSec: number;
  estimatedCostPer1000MatchesUsd: number;
  pricingConfidence: AiPricingConfidence;
  costOwner: AiCostOwner;
  budgetNote: string;
  difficulty: MapDifficulty;
}

export interface AiProviderChartRow {
  id: string;
  provider: AiProviderKind;
  mode: string;
  pricingModel: string;
  estimatedCostPer1000Matches: string;
  mvpVerdict: string;
  pricingConfidence: AiPricingConfidence;
  costOwner: AiCostOwner;
  includeInPlayerLadder: boolean;
  notes: string;
  sources?: readonly string[];
}

export interface AiLadderProgress {
  winsByOpponentId: Record<string, number>;
}

const BUDGET_DECISION_CALLS = 45;

export const AI_LADDER_OPPONENTS: readonly AiLadderOpponent[] = [
  {
    id: "local-oss-20b",
    tier: 1,
    name: "Socket Apprentice",
    title: "Local gpt-oss:20b / LM Studio",
    provider: "local",
    model: "gpt-oss:20b",
    adapter: "local-openai-compatible",
    maxDecisionCalls: BUDGET_DECISION_CALLS,
    decisionCadenceSec: 4,
    estimatedCostPer1000MatchesUsd: 0,
    pricingConfidence: "known_api_pricing",
    costOwner: "game",
    budgetNote: "No hosted API cost when run locally.",
    difficulty: { enemyEffectivenessMult: 0.62 },
  },
  {
    id: "groq-llama-3-1-8b",
    tier: 2,
    name: "Needle-Quick Adept",
    title: "Groq llama-3.1-8b-instant",
    provider: "groq",
    model: "llama-3.1-8b-instant",
    adapter: "openai-compatible",
    maxDecisionCalls: BUDGET_DECISION_CALLS,
    decisionCadenceSec: 4,
    estimatedCostPer1000MatchesUsd: 3.14,
    pricingConfidence: "known_api_pricing",
    costOwner: "game",
    budgetNote: "Budget cadence keeps 1,000 matches well under $10.",
    difficulty: { enemyEffectivenessMult: 0.72 },
  },
  {
    id: "cloudflare-llama-3-1-8b-fast",
    tier: 3,
    name: "Edge Warlock",
    title: "Cloudflare llama-3.1-8b-instruct-fp8-fast",
    provider: "cloudflare",
    model: "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
    adapter: "openai-compatible",
    maxDecisionCalls: BUDGET_DECISION_CALLS,
    decisionCadenceSec: 4,
    estimatedCostPer1000MatchesUsd: 4.5,
    pricingConfidence: "known_api_pricing",
    costOwner: "game",
    budgetNote: "Fast low-cost hosted lane.",
    difficulty: { enemyEffectivenessMult: 0.82 },
  },
  {
    id: "cloudflare-qwen3-30b-a3b",
    tier: 4,
    name: "Qwen Tactician",
    title: "Cloudflare qwen3-30b-a3b-fp8",
    provider: "cloudflare",
    model: "@cf/qwen/qwen3-30b-a3b-fp8",
    adapter: "openai-compatible",
    maxDecisionCalls: BUDGET_DECISION_CALLS,
    decisionCadenceSec: 4,
    estimatedCostPer1000MatchesUsd: 4.56,
    pricingConfidence: "known_api_pricing",
    costOwner: "game",
    budgetNote: "Best cheap strategist lane in the MVP set.",
    difficulty: { enemyEffectivenessMult: 0.94 },
  },
  {
    id: "groq-gpt-oss-20b",
    tier: 5,
    name: "Open-Weight Archmage",
    title: "Groq openai/gpt-oss-20b",
    provider: "groq",
    model: "openai/gpt-oss-20b",
    adapter: "openai-compatible",
    maxDecisionCalls: BUDGET_DECISION_CALLS,
    decisionCadenceSec: 4,
    estimatedCostPer1000MatchesUsd: 5.67,
    pricingConfidence: "known_api_pricing",
    costOwner: "game",
    budgetNote: "OpenAI-flavored open model under the $10/1k target.",
    difficulty: { enemyEffectivenessMult: 1.06 },
  },
  {
    id: "gemini-2-5-flash-lite",
    tier: 6,
    name: "Gemini Rift Oracle",
    title: "Gemini 2.5 Flash-Lite",
    provider: "gemini",
    model: "gemini-2.5-flash-lite",
    adapter: "gemini",
    maxDecisionCalls: BUDGET_DECISION_CALLS,
    decisionCadenceSec: 4,
    estimatedCostPer1000MatchesUsd: 7.56,
    pricingConfidence: "known_api_pricing",
    costOwner: "game",
    budgetNote: "Final MVP cap; uses 4s budget cadence instead of 3s.",
    difficulty: { enemyEffectivenessMult: 1.16 },
  },
] as const;

export const AI_MATCH_COST_BENCHMARK = {
  decisionCallsPerMatch: BUDGET_DECISION_CALLS,
  decisionCadenceSec: 4,
  inputTokensPerDecisionRange: [250, 700] as const,
  outputTokensPerDecisionRange: [40, 120] as const,
  agentCallsPer1000Matches: BUDGET_DECISION_CALLS * 1000,
  formula:
    "per match = decision_calls_per_match * avg_tokens_per_decision * provider_price_per_token + hosting + platform fees if any",
} as const;

const OPENSERV_SOURCES = [
  "https://github.com/openserv-labs/sdk",
  "https://docs.openserv.ai/getting-started/agent-tutorial",
  "https://docs.openserv.ai/docs/no-code/agents",
  "https://docs.openserv.ai/docs/what-is-serv/the-serv-token",
  "https://docs.openserv.ai/resources/sdk",
] as const;

function formatUsdPer1000(value: number): string {
  return value <= 0 ? "$0 API" : `$${value.toFixed(2)}`;
}

export const AI_LADDER_PROVIDER_CHART_ROWS: readonly AiProviderChartRow[] = AI_LADDER_OPPONENTS.map((o) => ({
  id: o.id,
  provider: o.provider,
  mode: o.title,
  pricingModel: o.provider === "local" ? "Local runtime; no hosted API spend." : "Known hosted model API estimate.",
  estimatedCostPer1000Matches: formatUsdPer1000(o.estimatedCostPer1000MatchesUsd),
  mvpVerdict: "Yes, included in player ladder.",
  pricingConfidence: o.pricingConfidence,
  costOwner: o.costOwner,
  includeInPlayerLadder: true,
  notes: o.budgetNote,
}));

export const OPENSERV_PROVIDER_CHART_ROWS: readonly AiProviderChartRow[] = [
  {
    id: "openserv-submitter-owned-custom-agent",
    provider: "openserv",
    mode: "OpenServ submitter-owned custom agent",
    pricingModel: "Submitter pays OpenServ/model/hosting.",
    estimatedCostPer1000Matches: "$0 to us",
    mvpVerdict: "Yes, best intake lane.",
    pricingConfidence: "submitter_paid",
    costOwner: "submitter",
    includeInPlayerLadder: false,
    notes: "Green-light as an approved competitor intake path; not a public ladder tier.",
    sources: OPENSERV_SOURCES,
  },
  {
    id: "openserv-sdk-self-hosted-direct-model",
    provider: "openserv",
    mode: "OpenServ SDK self-hosted agent using direct model keys",
    pricingModel: "Underlying model API plus submitter hosting.",
    estimatedCostPer1000Matches: "Same as chosen model + hosting",
    mvpVerdict: "Yes if submitter-owned.",
    pricingConfidence: "inferred_pass_through",
    costOwner: "submitter",
    includeInPlayerLadder: false,
    notes: "Use the neutral Battle Agent API so this also covers Eliza, LangChain, local bots, and company agents.",
    sources: OPENSERV_SOURCES,
  },
  {
    id: "openserv-runless-platform-managed",
    provider: "openserv",
    mode: "OpenServ runless/platform-managed capability",
    pricingModel: "OpenServ/platform pricing not public.",
    estimatedCostPer1000Matches: "Unknown",
    mvpVerdict: "Maybe; requires dashboard or quote.",
    pricingConfidence: "unknown_platform_fee",
    costOwner: "unknown",
    includeInPlayerLadder: false,
    notes: "Do not show a dollar-per-1k claim without account billing data or published pricing.",
    sources: OPENSERV_SOURCES,
  },
  {
    id: "openserv-your-owned-ladder-bot",
    provider: "openserv",
    mode: "OpenServ your-owned ladder bot",
    pricingModel: "Your OpenServ account plus possible model/platform fees.",
    estimatedCostPer1000Matches: "Unknown until account pricing visible",
    mvpVerdict: "Not green-light for $10/1k yet.",
    pricingConfidence: "unknown_platform_fee",
    costOwner: "unknown",
    includeInPlayerLadder: false,
    notes: "Feasible later, but not ranked as a guaranteed cheap ladder provider.",
    sources: OPENSERV_SOURCES,
  },
] as const;

export const AI_PROVIDER_CHART_ROWS: readonly AiProviderChartRow[] = [
  ...AI_LADDER_PROVIDER_CHART_ROWS,
  ...OPENSERV_PROVIDER_CHART_ROWS,
] as const;

const KNOWN_IDS = new Set(AI_LADDER_OPPONENTS.map((o) => o.id));

function emptyProgress(): AiLadderProgress {
  return { winsByOpponentId: {} };
}

function sanitizeWins(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const rec = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const id of KNOWN_IDS) {
    const n = Number(rec[id]);
    if (Number.isFinite(n) && n > 0) out[id] = Math.floor(n);
  }
  return out;
}

export function readAiLadderProgress(storage: Storage | undefined = globalThis.localStorage): AiLadderProgress {
  try {
    const parsed = JSON.parse(storage?.getItem(AI_LADDER_PROGRESS_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object") return emptyProgress();
    const winsByOpponentId = sanitizeWins((parsed as Partial<AiLadderProgress>).winsByOpponentId);
    return { winsByOpponentId };
  } catch {
    return emptyProgress();
  }
}

export function writeAiLadderProgress(
  progress: AiLadderProgress,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(AI_LADDER_PROGRESS_KEY, JSON.stringify({
      winsByOpponentId: sanitizeWins(progress.winsByOpponentId),
    }));
  } catch {
    /* ignore storage failures */
  }
}

export function winsAgainst(progress: AiLadderProgress, opponentId: string): number {
  return Math.max(0, Math.floor(progress.winsByOpponentId[opponentId] ?? 0));
}

export function highestUnlockedAiIndex(progress: AiLadderProgress): number {
  let idx = 0;
  while (idx < AI_LADDER_OPPONENTS.length - 1) {
    const cur = AI_LADDER_OPPONENTS[idx]!;
    if (winsAgainst(progress, cur.id) < AI_LADDER_WINS_TO_UNLOCK) break;
    idx++;
  }
  return idx;
}

export function currentAiLadderOpponent(progress: AiLadderProgress): AiLadderOpponent {
  return AI_LADDER_OPPONENTS[highestUnlockedAiIndex(progress)]!;
}

export function aiLadderOpponentById(id: string | null | undefined): AiLadderOpponent | null {
  if (!id) return null;
  return AI_LADDER_OPPONENTS.find((o) => o.id === id) ?? null;
}

export function isAiLadderOpponentUnlocked(progress: AiLadderProgress, opponentId: string): boolean {
  const idx = AI_LADDER_OPPONENTS.findIndex((o) => o.id === opponentId);
  if (idx < 0) return false;
  return idx <= highestUnlockedAiIndex(progress);
}

export function nextLockedAiOpponent(progress: AiLadderProgress): AiLadderOpponent | null {
  const next = highestUnlockedAiIndex(progress) + 1;
  return AI_LADDER_OPPONENTS[next] ?? null;
}

export function resolvePlayableAiOpponent(
  requestedId: string | null | undefined,
  progress: AiLadderProgress,
  opts: { allowLocked?: boolean } = {},
): AiLadderOpponent {
  const requested = aiLadderOpponentById(requestedId);
  if (requested && (opts.allowLocked || isAiLadderOpponentUnlocked(progress, requested.id))) return requested;
  return currentAiLadderOpponent(progress);
}

export function aiLadderProgressLabel(progress: AiLadderProgress, opponent: AiLadderOpponent): string {
  const wins = winsAgainst(progress, opponent.id);
  const cappedWins = Math.min(AI_LADDER_WINS_TO_UNLOCK, wins);
  const next = nextLockedAiOpponent(progress);
  if (!next) return "Final opponent unlocked";
  return `${cappedWins}/${AI_LADDER_WINS_TO_UNLOCK} wins to unlock ${next.name}`;
}

export function recordAiLadderWin(
  opponentId: string,
  storage: Storage | undefined = globalThis.localStorage,
): AiLadderProgress {
  const progress = readAiLadderProgress(storage);
  if (!KNOWN_IDS.has(opponentId)) return progress;
  const winsByOpponentId = { ...progress.winsByOpponentId };
  winsByOpponentId[opponentId] = winsAgainst(progress, opponentId) + 1;
  const next = { winsByOpponentId };
  writeAiLadderProgress(next, storage);
  return next;
}

export function isAiLadderProgressEligible(opts: {
  matchMode: MatchMode;
  aiBattle: boolean;
  opponentId: string | null;
}): boolean {
  return opts.matchMode === "ai" && !opts.aiBattle && opts.opponentId != null;
}

export function isOwnerAiDuelAuthorized(
  params: URLSearchParams,
  storage: Storage | undefined = globalThis.localStorage,
): boolean {
  if (params.get("aiDuel") !== "1" && params.get("aiBattle") !== "1") return false;
  try {
    return storage?.getItem(AI_ADMIN_STORAGE_KEY) === "enabled";
  } catch {
    return false;
  }
}

export function aiOpponentRosterSummary(): string {
  return AI_LADDER_OPPONENTS.map((o) => `${o.tier}. ${o.name} (${o.title})`).join("\n");
}

export function aiProviderChartMarkdown(rows: readonly AiProviderChartRow[] = AI_PROVIDER_CHART_ROWS): string {
  const header = "| Provider / mode | Pricing model | Est. 1,000 matches | MVP verdict |";
  const divider = "|---|---:|---:|---|";
  const body = rows.map((row) =>
    `| ${row.mode} | ${row.pricingModel} | ${row.estimatedCostPer1000Matches} | ${row.mvpVerdict} |`,
  );
  return [header, divider, ...body].join("\n");
}
