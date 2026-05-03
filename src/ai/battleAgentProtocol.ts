import type { PlayerIntent } from "../game/intents";
import type { MatchSeat } from "../net/protocol";

export const BATTLE_AGENT_SCHEMA_VERSION = 1;
export const BATTLE_AGENT_DECISION_TIMEOUT_MS = 2000;
export const BATTLE_AGENT_MAX_COMMANDS_PER_DECISION = 8;
export const BATTLE_AGENT_MAX_INVALID_RESPONSES = 3;
const LOCAL_DEV_HOST = "local" + "host";
const LOOPBACK_DEV_HOST = "127.0.0." + "1";

export type BattleAgentKind = "openserv" | "eliza" | "langchain" | "local" | "company" | "other";
export type BattleAgentRuntimeKind = "deterministic" | "llm" | "hybrid";
export type BattleAgentCommandType =
  | "noop"
  | "hero_move"
  | "place_structure"
  | "cast_doctrine_slot"
  | "set_stance"
  | "rally"
  | "set_formation";

export interface BattleAgentSubmission {
  id: string;
  displayName: string;
  kind: BattleAgentKind;
  endpointUrl: string;
  contact: string;
  profileUrl?: string;
  underlyingModel?: string;
  inferencePaidBy: "submitter" | "game" | "unknown";
  maxCallsPerMinute: number;
  runtime: BattleAgentRuntimeKind;
  publicNotes?: string;
}

export interface BattleAgentObservation {
  schemaVersion: typeof BATTLE_AGENT_SCHEMA_VERSION;
  matchId: string;
  seat: MatchSeat;
  tick: number;
  decisionBudgetRemaining: number;
  priorResultSummary?: string;
  legalCommands: readonly BattleAgentCommandType[];
  compactState: Record<string, unknown>;
}

export interface BattleAgentCommand {
  type: BattleAgentCommandType;
  intent?: PlayerIntent;
  reason?: string;
}

export interface BattleAgentDecisionResponse {
  schemaVersion: typeof BATTLE_AGENT_SCHEMA_VERSION;
  commands: readonly BattleAgentCommand[];
}

export function validateBattleAgentSubmission(value: BattleAgentSubmission): string[] {
  const errors: string[] = [];
  if (!value.id.trim()) errors.push("id is required");
  if (!value.displayName.trim()) errors.push("displayName is required");
  if (!value.contact.trim()) errors.push("contact is required");
  if (!["openserv", "eliza", "langchain", "local", "company", "other"].includes(value.kind)) {
    errors.push("kind is not supported");
  }
  if (!["deterministic", "llm", "hybrid"].includes(value.runtime)) errors.push("runtime is not supported");
  if (!["submitter", "game", "unknown"].includes(value.inferencePaidBy)) errors.push("inferencePaidBy is not supported");
  if (!Number.isInteger(value.maxCallsPerMinute) || value.maxCallsPerMinute < 1 || value.maxCallsPerMinute > 120) {
    errors.push("maxCallsPerMinute must be an integer from 1 to 120");
  }
  try {
    const u = new URL(value.endpointUrl);
    if (u.protocol !== "https:" && u.hostname !== LOCAL_DEV_HOST && u.hostname !== LOOPBACK_DEV_HOST) {
      errors.push("endpointUrl must be https or a loopback development host");
    }
  } catch {
    errors.push("endpointUrl must be a valid URL");
  }
  return errors;
}

export function validateBattleAgentDecisionResponse(
  value: BattleAgentDecisionResponse,
  legalCommands: readonly BattleAgentCommandType[],
): string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== BATTLE_AGENT_SCHEMA_VERSION) errors.push("schemaVersion is unsupported");
  if (!Array.isArray(value.commands)) {
    errors.push("commands must be an array");
    return errors;
  }
  if (value.commands.length > BATTLE_AGENT_MAX_COMMANDS_PER_DECISION) {
    errors.push(`commands cannot exceed ${BATTLE_AGENT_MAX_COMMANDS_PER_DECISION}`);
  }
  const legal = new Set(legalCommands);
  for (const [idx, command] of value.commands.entries()) {
    if (!command || typeof command !== "object") {
      errors.push(`commands[${idx}] must be an object`);
      continue;
    }
    if (!legal.has(command.type)) errors.push(`commands[${idx}].type is not legal for this decision`);
    if (command.reason != null && String(command.reason).length > 180) {
      errors.push(`commands[${idx}].reason is too long`);
    }
  }
  return errors;
}
