/**
 * P22-1 — agent definitions for the composition root (extracted verbatim from
 * createHarness.ts). mainAgent stays in create-harness.ts (it reads registry
 * state); the subagent/worker definitions are pure config → AgentDefinition.
 */
import { newAgentId, type AgentDefinition } from "@ar/contracts";
import { PRODUCTION_TOOL_NAMES, READONLY_TOOL_NAMES } from "./tool-names.js";
import type { HarnessConfig } from "./config.js";

export function subagentDefinition(config: HarnessConfig): AgentDefinition {
  return {
    id: newAgentId(),
    name: "worker",
    description: "delegated subagent (read-only workspace exploration)",
    mode: "subagent",
    model: config.model,
    systemPrompt: "You are a subagent working inside a delegated session. Complete the goal and report findings.",
    tools: { allow: [...READONLY_TOOL_NAMES] },
    permissions: {
      rules: [
        { action: "read", resource: "file", effect: "allow" },
        { action: "edit", resource: "file", effect: "deny" },
        { action: "exec", resource: "command", effect: "deny" },
        { action: "exec", resource: "network", effect: "deny" },
      ],
    },
    skills: {},
    limits: { maxToolCalls: 30 },
  };
}

/** P3-6: write-capable worker agent. Registered only when delegation is
 *  enabled; its sandbox admits the per-child isolated workspace (the harness
 *  wires the extra roots), so the worker can edit/exec inside its own copy —
 *  and nothing outside it (network stays denied). */
export function workerAgentDefinition(config: HarnessConfig): AgentDefinition {
  return {
    id: newAgentId(),
    name: "worker-w",
    description: "write-capable delegated worker (isolated workspace copy)",
    mode: "subagent",
    model: config.model,
    systemPrompt:
      "You are a write-capable worker in an ISOLATED copy of the parent workspace. " +
      "Make the requested changes in this workspace only. On success they are merged back under conflict detection.",
    tools: { allow: [...PRODUCTION_TOOL_NAMES] },
    permissions: {
      rules: [
        { action: "read", resource: "file", effect: "allow" },
        { action: "edit", resource: "file", effect: "allow" },
        { action: "exec", resource: "command", effect: "allow" },
        { action: "exec", resource: "network", effect: "deny" },
      ],
    },
    skills: {},
    limits: { maxToolCalls: 50 },
  };
}
