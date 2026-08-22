import { createHash } from "node:crypto";
import type { AgentId } from "./ids.js";
import type { ModelRef } from "./model.js";
import type { EffectiveAgentConfig, ToolPolicy } from "./agent.js";
import type { PermissionPolicy } from "./permission.js";
import type { SandboxPolicy } from "./sandbox.js";
import type { SessionId, TurnId } from "./ids.js";
import type { ToolDefinition, ToolSemantics, ToolSpec } from "./tool.js";

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

// ============================================================================
// P23-1 — Step World Snapshot V2. StepContext (above) stays as the compatible
// legacy surface; the authoritative concepts are StepRecord (durable identity)
// + StepExecutionSnapshot (runtime bindings).
// ============================================================================

/** P23-1 — durable/observable step identity. NEVER holds function closures or
 *  runtime object references — only fingerprints/provenance, so it can be
 *  persisted, replayed and correlated across restarts. */
export interface StepRecord {
  readonly stepId: string;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly agentId: AgentId;
  readonly model: ModelRef;
  readonly toolRouterFingerprint: string;
  readonly policyFingerprint: string;
  readonly environmentFingerprint: string;
  readonly contextFingerprint: string;
  readonly instructionFingerprint: string;
  /** P24: MCP binding generation fingerprint when an MCP binding is in play. */
  readonly mcpBindingFingerprint?: string;
  /** P32: skill snapshot fingerprint when skills are pinned. */
  readonly skillSnapshotFingerprint?: string;
  readonly createdAt: number;
}

/** P23-2 — provenance of a frozen tool binding (which source produced it). */
export type ToolSourceKind = "builtin" | "mcp" | "plugin" | "dynamic";

export interface ToolProvenance {
  readonly kind: ToolSourceKind;
  readonly sourceId?: string;
  readonly generation?: string;
}

/** P23-2 — one immutable tool binding inside a frozen router. */
export interface FrozenToolBinding {
  readonly name: string;
  readonly spec: ToolSpec;
  readonly definition: ToolDefinition;
  readonly semantics: ToolSemantics;
  readonly provenance: ToolProvenance;
}

/** P23-2 — immutable per-sampling tool world. The process-wide ToolRegistry
 *  stays the mutable catalog; a StepToolRouter is a per-sampling execution
 *  snapshot built FROM the catalog and never mutated afterwards. */
export interface StepToolRouter {
  readonly id: string;
  readonly fingerprint: string;
  readonly modelVisibleSpecs: readonly ToolSpec[];
  has(name: string): boolean;
  resolve(name: string): FrozenToolBinding | undefined;
}

/** P23-1 — exact execution environment identity (P31 deepens this). */
export interface EnvironmentSnapshot {
  readonly cwd: string;
  readonly workspaceRoots?: readonly string[];
}

/** P23-1 — the exact permission world a step executes under. P23-5 makes this
 *  the execution authority instead of mutable turn/global state. */
export interface PermissionProfileSnapshot {
  readonly toolPolicy: ToolPolicy;
  readonly permissions: PermissionPolicy;
  readonly sandboxPolicy: SandboxPolicy;
  readonly fingerprint: string;
}

/** P23-7 — exact context identity: message/block ids + hashes, not a coarse
 *  block count. Events carry ids/hashes, never duplicated transcript text. */
export interface ModelContextSnapshot {
  readonly messageIds: readonly string[];
  readonly blockIds: readonly string[];
  readonly systemHash: string;
  readonly contextHash: string;
  readonly estimatedTokens: number;
  readonly compacted: boolean;
}

/** P23-1 — pinned system/instruction surface (P32 deepens with skills). */
export interface InstructionSnapshot {
  readonly system: string;
  readonly systemHash: string;
}

/** P23-1 — the frozen execution world for ONE model call. May hold runtime
 *  object references (router, policies); the durable StepRecord holds
 *  fingerprints only. MODEL_VISIBLE_WORLD == TOOL_EXECUTION_WORLD for every
 *  model-originated action issued under this snapshot. */
export interface StepExecutionSnapshot {
  readonly record: StepRecord;
  readonly agent: EffectiveAgentConfig;
  readonly environment: EnvironmentSnapshot;
  readonly permissions: PermissionProfileSnapshot;
  readonly tools: StepToolRouter;
  readonly model: ModelRef;
  readonly context: ModelContextSnapshot;
  readonly instructions: InstructionSnapshot;
  /** P24: McpBindingSnapshot when an MCP binding is pinned. */
  readonly mcp?: unknown;
  /** P32: SkillSnapshot when skills are pinned. */
  readonly skills?: unknown;
  /** P23-3: advertisement telemetry frozen with the step — the catalog size
   *  BEFORE selection/deferral and everything dropped from advertisement. */
  readonly advertised?: {
    available: number;
    dropped: readonly string[];
  };
}

/**
 * P23-6 — why this sampling attempt is happening. Determines whether the SAME
 * StepExecutionSnapshot may be reused (semantic inputs identical) or a NEW
 * snapshot must be built:
 *
 * - transport_retry / model_retry → same snapshot (same prompt/tool world)
 * - reactive_compaction / context_rebuild / tool_world_changed / model_switch
 *   → NEW snapshot (the model-visible world changed).
 */
export type SamplingAttemptKind =
  | "transport_retry"
  | "model_retry"
  | "reactive_compaction"
  | "context_rebuild"
  | "tool_world_changed"
  | "model_switch";

/** P23-1 — canonical key-order JSON. Deterministic fingerprint input: object
 *  key order is normalized recursively, so equivalent values produce identical
 *  output regardless of insertion order. NEVER depends on function toString,
 *  object identity, random iteration order, memory address, or the clock. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** P23-1 — deterministic sha256 fingerprint over canonical parts. */
export function stableFingerprint(parts: readonly unknown[]): string {
  return createHash("sha256").update(parts.map(canonicalJson).join("|"), "utf8").digest("hex");
}
