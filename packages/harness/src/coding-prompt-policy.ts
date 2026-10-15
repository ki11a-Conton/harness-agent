import { buildCodingSystemPrompt, buildCodingV2SystemPrompt, CODING_PROMPT_VERSION, CODING_PROMPT_V2 } from "@ar/agents";
import { createProductionTools } from "@ar/tools";
import { PRODUCTION_TOOL_NAMES, READONLY_TOOL_NAMES } from "./tool-names.js";

/** Persist actual compiled text, not just an identifier: the existing config
 * fingerprint then rejects silent same-version prompt changes on resume. */
export interface AgentPromptPolicy {
  readonly version: string;
  readonly primary: string;
  readonly readonlyWorker: string;
  readonly writeWorker: string;
}

export function createCodingPromptPolicy(version: "coding-v1" | "coding-v2" = "coding-v1"): AgentPromptPolicy {
  if (version === CODING_PROMPT_V2) {
    const tools = createProductionTools({ networkMode: "deny", availableTools: () => [] });
    return Object.freeze({ version,
      primary: buildCodingV2SystemPrompt({ role: "primary", tools }),
      readonlyWorker: buildCodingV2SystemPrompt({ role: "readonly-worker", tools: tools.filter(t => (READONLY_TOOL_NAMES as readonly string[]).includes(t.name)) }),
      writeWorker: buildCodingV2SystemPrompt({ role: "write-worker", tools }),
    });
  }
  if (version !== CODING_PROMPT_VERSION) throw new TypeError("unsupported coding prompt version");
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
  if (value === CODING_PROMPT_V2) return createCodingPromptPolicy(CODING_PROMPT_V2);
  throw new TypeError(`Unsupported HARNESS_AGENT_PROMPT: use legacy, ${CODING_PROMPT_VERSION} or ${CODING_PROMPT_V2}`);
}
