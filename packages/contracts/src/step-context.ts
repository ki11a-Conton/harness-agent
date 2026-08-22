import type { AgentId } from "./ids.js";
import type { ModelRef } from "./model.js";
import type { EffectiveAgentConfig } from "./agent.js";
import type { SessionId, TurnId } from "./ids.js";

/**
 * P15-2 — immutable StepContext, formed ONCE per model call.
 *
 * A step is the smallest consistent execution unit: one model round-trip plus
 * the batch of tool calls it requests. Everything the model and its tools may
 * observe — frozen effective agent config, cwd identity, tool spec snapshot,
 * permission/sandbox policy fingerprint, the current context selection, the
 * model reference and the turn/session ids — is pinned here BEFORE the model
 * call and MUST be used unchanged for every tool call in the same batch.
 *
 * A mid-run config/policy change can only take effect on the NEXT step (a
 * fresh StepContext is formed per iteration), or an explicit drift gate must
 * fire. The object is never mutated after construction; callers treat it as
 * frozen.
 */
export interface StepContext {
  /** Unique id of this step (one per model call). */
  stepId: string;
  sessionId: SessionId;
  turnId: TurnId;
  agentId: AgentId;
  /** Frozen effective agent config (snapshot at step start). */
  effectiveAgent: EffectiveAgentConfig;
  /** Working directory identity at step start. */
  cwd: string;
  /** Allowed tool specs snapshot (names + schemas) for this step. */
  toolSpecs: readonly import("./tool.js").ToolSpec[];
  /** Fingerprint of the permission + sandbox + tool policy inputs for this
   *  step; a changed hash across steps signals a policy drift boundary. */
  policyHash: string;
  /** The context selection this step was built from. */
  contextSelection: {
    blocks: number;
    tokens: number;
    compacted: boolean;
  };
  /** Model reference used for this step's model call. */
  model: ModelRef;
}
