import { describe, expect, it } from "vitest";
import {
  BATTLE_AGENT_MAX_COMMANDS_PER_DECISION,
  BATTLE_AGENT_SCHEMA_VERSION,
  type BattleAgentSubmission,
  validateBattleAgentDecisionResponse,
  validateBattleAgentSubmission,
} from "./battleAgentProtocol";

const validSubmission: BattleAgentSubmission = {
  id: "openserv-alpha",
  displayName: "OpenServ Alpha",
  kind: "openserv",
  endpointUrl: "https://agent.example.com/battle/decision",
  contact: "builder@example.com",
  profileUrl: "https://openserv.ai/agent/openserv-alpha",
  underlyingModel: "submitter disclosed model",
  inferencePaidBy: "submitter",
  maxCallsPerMinute: 20,
  runtime: "hybrid",
  publicNotes: "Self-hosted OpenServ custom agent.",
};

describe("battle agent protocol", () => {
  it("accepts a submitter-owned OpenServ intake record", () => {
    expect(validateBattleAgentSubmission(validSubmission)).toEqual([]);
  });

  it("rejects unsafe or incomplete intake records", () => {
    expect(validateBattleAgentSubmission({
      ...validSubmission,
      id: "",
      endpointUrl: "http://agent.example.com/battle/decision",
      maxCallsPerMinute: 500,
    })).toEqual([
      "id is required",
      "maxCallsPerMinute must be an integer from 1 to 120",
      "endpointUrl must be https or a loopback development host",
    ]);
  });

  it("accepts only legal bounded command responses", () => {
    expect(validateBattleAgentDecisionResponse({
      schemaVersion: BATTLE_AGENT_SCHEMA_VERSION,
      commands: [{ type: "noop", reason: "budget hold" }, { type: "hero_move" }],
    }, ["noop", "hero_move"])).toEqual([]);
  });

  it("rejects oversized, stale-schema, or illegal command responses", () => {
    const errors = validateBattleAgentDecisionResponse({
      schemaVersion: 999 as typeof BATTLE_AGENT_SCHEMA_VERSION,
      commands: [
        ...Array.from({ length: BATTLE_AGENT_MAX_COMMANDS_PER_DECISION + 1 }, () => ({ type: "noop" as const })),
        { type: "rally", reason: "x".repeat(181) },
      ],
    }, ["noop"]);

    expect(errors).toContain("schemaVersion is unsupported");
    expect(errors).toContain(`commands cannot exceed ${BATTLE_AGENT_MAX_COMMANDS_PER_DECISION}`);
    expect(errors).toContain("commands[9].type is not legal for this decision");
    expect(errors).toContain("commands[9].reason is too long");
  });
});
