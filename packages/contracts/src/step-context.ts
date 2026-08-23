import { createHash } from "node:crypto";
import type { AgentId } from "./ids.js";
import type { EnvironmentId } from "./ids.js";
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
export interface EnvironmentCapabilities {
  /** Read-only host capability set. Absent flavors are not supported. */
  readonly filesystem: readonly ("local" | "workspace-only" | "remote")[];
  readonly exec: readonly ("local" | "remote")[];
  readonly network: readonly ("denied" | "allowlist" | "full")[];
  readonly sandbox: readonly ("none" | "local-process" | "container")[];
}

/** P31-1 — frozen shell configuration a tool may observe/use. */
export interface ShellSnapshot {
  /** Executable path of the shell binary (e.g. "/bin/bash"). */
  readonly shell: string;
  /** Immutable-enough env for this step; changes re-derive fingerprints. */
  readonly envVars?: Record<string, string>;
  /** Hash of env vars present in the snapshot (stable across key order). */
  readonly envVarsFingerprint?: string;
}

/** P31-1 — snapshot of a single executable environment. Local environments get
 *  a DETERMINISTIC id derived from the cwd+workspace root set (same dir →
 *  same environment), so step records correlate across restarts and replays
 *  without holding host details. */
export interface EnvironmentSnapshot {
  /** P31-1 — identity of this environment (local: deterministic). */
  readonly id: EnvironmentId;
  readonly cwd: string;
  readonly workspaceRoots: readonly string[];
  readonly shell: ShellSnapshot;
  /** Hash of the permission/sandbox policy inputs for this step. */
  readonly permissionsFingerprint: string;
  readonly capabilities: EnvironmentCapabilities;
  /** Full environment identity: id + shell + workspaceRoots + capabilities. */
  readonly fingerprint: string;
}

/**
 * P31-1 — build a deterministic local environment snapshot. Pure: no IO, the
 * caller gathers workspace roots and shell facts. The id is stable across
 * process runs: same cwd+roots+shell → same id.
 */
export function buildLocalEnvironmentSnapshot(input: {
  cwd: string;
  workspaceRoots?: readonly string[];
  shell: string;
  env?: Readonly<Record<string, string | undefined>>;
  capabilities?: EnvironmentCapabilities;
  permissionsFingerprint: string;
}): EnvironmentSnapshot {
  const workspaceRoots = input.workspaceRoots ?? [input.cwd];
  const guard: Record<string, string> = {};
  for (const key of Object.keys(input.env ?? {})) {
    const value = input.env![key];
    if (value !== undefined) guard[key] = value;
  }
  const envKeys = Object.keys(guard).sort();
  const envVarsFingerprint =
    input.env !== undefined
      ? stableFingerprint([envKeys, envKeys.map((k) => guard[k])])
      : undefined;
  const shell: ShellSnapshot = {
    shell: input.shell,
    ...(input.env !== undefined ? { envVars: guard } : {}),
    ...(envVarsFingerprint !== undefined ? { envVarsFingerprint } : {}),
  };
  const capabilities = input.capabilities ?? localCapabilities();
  const id = `env_local_${stableFingerprint([workspaceRoots, shell.shell, capabilities])}` as EnvironmentId;
  const fingerprint = stableFingerprint([id, shell, capabilities]);
  return {
    id,
    cwd: input.cwd,
    workspaceRoots,
    shell,
    permissionsFingerprint: input.permissionsFingerprint,
    capabilities,
    fingerprint,
  };
}

/** Local-process host capability set (P31-4 — the only shipped executor). */
export function localCapabilities(): EnvironmentCapabilities {
  return {
    filesystem: ["local"],
    exec: ["local"],
    network: ["full"],
    sandbox: ["local-process"],
  };
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

/** P23-1 — pinned system/instruction surface. P32 deepens: the instruction /
 *  skill world is captured as EXPLICIT SOURCES (system prompt, project
 *  instruction documents, skill bodies) with a deterministic fingerprint, so
 *  a mid-step AGENTS.md or skill-body change can only affect the NEXT step. */
export interface InstructionSource {
  /** Kind of instruction source. */
  readonly kind: "system" | "project_instruction" | "skill_body";
  /** Where the content came from (AGENTS.md path, skill name, "system"). */
  readonly source: string;
  /** Hash of the rendered content this source contributed. */
  readonly contentHash: string;
  /** Canonical path for document sources (AGENTS.md) — absent for system. */
  readonly path?: string;
}

export interface InstructionSnapshot {
  readonly system: string;
  readonly systemHash: string;
  /** P32-3 — ordered instruction sources that produced this system surface. */
  readonly sources: readonly InstructionSource[];
  /** P32-3 — deterministic fingerprint over sources + system hash. A changed
   *  AGENTS.md / skill body / system prompt re-fingerprints the step. */
  readonly fingerprint: string;
}

/** P32-1 — immutable snapshot of the skills selected for this step. Identical
 *  selection with different object insertion order hashes identically; a
 *  body hash / required-tools / MCP-requirement change produces a NEW
 *  fingerprint. Never holds live process state — only identity + provenance. */
export interface SkillSnapshot {
  readonly fingerprint: string;
  readonly selected: readonly {
    name: string;
    source: string;
    bodyHash?: string;
    requiredTools: readonly string[];
    requiredMcpServers: readonly string[];
  }[];
}

export function buildSkillSnapshot(
  selected: readonly {
    name: string;
    source?: string;
    bodyHash?: string;
    requiredTools?: readonly string[];
    requiredMcpServers?: readonly string[];
  }[],
): SkillSnapshot {
  const normalized = selected.map((s) => ({
    name: s.name,
    source: s.source ?? "unknown",
    ...(s.bodyHash !== undefined ? { bodyHash: s.bodyHash } : {}),
    requiredTools: [...(s.requiredTools ?? [])],
    requiredMcpServers: [...(s.requiredMcpServers ?? [])],
  }));
  return {
    fingerprint: stableFingerprint(normalized),
    selected: normalized,
  };
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
  /** P32-1: SkillSnapshot when skills are pinned. */
  readonly skills?: SkillSnapshot;
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
