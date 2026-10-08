import { buildCodingSystemPrompt, CODING_PROMPT_VERSION } from "@ar/agents";
import { PRODUCTION_TOOL_NAMES, READONLY_TOOL_NAMES } from "./tool-names.js";

/** Persist actual compiled text, not just an identifier: the existing config
 * fingerprint then rejects silent same-version prompt changes on resume. */
export interface AgentPromptPolicy {
  readonly version: string;
  readonly primary: string;
  readonly readonlyWorker: string;
  readonly writeWorker: string;
}

export function createCodingPromptPolicy(): AgentPromptPolicy {
  return Object.freeze({
    version: CODING_PROMPT_VERSION,
    primary: buildCodingSystemPrompt({ role: "primary", toolNames: PRODUCTION_TOOL_NAMES }),
    readonlyWorker: buildCodingSystemPrompt({ role: "readonly-worker", toolNames: READONLY_TOOL_NAMES }),
    writeWorker: buildCodingSystemPrompt({ role: "write-worker", toolNames: PRODUCTION_TOOL_NAMES }),
  });
}

/** Shared CLI/Web opt-in. Legacy is the unchanged baseline; quality promotion
 * requires a real paired evaluation, independently of engineering acceptance. */
export function resolveAgentPromptPolicy(value?: string): AgentPromptPolicy | undefined {
  if (value === undefined || value === "legacy") return undefined;
  if (value === CODING_PROMPT_VERSION) return createCodingPromptPolicy();
  throw new TypeError(`Unsupported HARNESS_AGENT_PROMPT: use legacy or ${CODING_PROMPT_VERSION}`);
}
