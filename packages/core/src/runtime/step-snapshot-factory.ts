import { hashPolicyConfig } from "@ar/context";
import {
  isToolAllowedByPolicy,
  snapshotEffectiveConfig,
  stableFingerprint,
  buildLocalEnvironmentSnapshot,
  type AgentDefinition,
  type ContextBlock,
  type EnvironmentSnapshot,
  type FrozenToolBinding,
  type InstructionSource,
  type Message,
  type PermissionProfileSnapshot,
  type SandboxPolicy,
  type SessionId,
  type SkillSnapshot,
  type StepExecutionSnapshot,
  type StepRecord,
  type ToolSemantics,
  type ToolSpec,
  type TurnId,
} from "@ar/contracts";
import { AgentError } from "../errors.js";
import { decideSchemaAdvert, errorInfo, type SchemaAdvertPolicy } from "@ar/contracts";
import { defaultSandboxPolicy } from "./turn-helpers.js";
import { FrozenStepToolRouter } from "./step-execution-snapshot.js";
import type { ToolSelector } from "../tools/tool-selector.js";
import type { StepToolCatalog } from "./tool-catalog.js";

/**
 * P23-1 — inputs for forming ONE step execution snapshot. Everything the
 * model and its tools may observe is pinned HERE, before the model call.
 */
export interface StepSnapshotBuildInput {
  sessionId: SessionId;
  turnId: TurnId;
  agent: AgentDefinition;
  /** Working directory identity at step start. */
  cwd: string;
  /** Per-model-call step ordinal inside the turn (ids: `<turnId>:<n>`). */
  stepIndex: number;
  priorBlocks: readonly ContextBlock[];
  /** Pinned system prompt for this step (before the call). */
  system: string;
  compacted: boolean;
  /** The exact message history handed to the model (for context identity). */
  history: readonly Message[];
  /** Mutable process catalog — only READ at snapshot build time. */
  registry: StepToolCatalog;
  /** P18-1 single execution-policy source (semantics lookup by tool name). */
  semanticsOf: (toolName: string) => ToolSemantics;
  /** The turn goal, used by the goal-based selector to narrow advertisement. */
  goal?: string;
  /** P7-1/P7-2 progressive disclosure selector. Applied ONCE here, BEFORE the
   *  model call — never inside the model controller afterwards. */
  toolSelector?: ToolSelector;
  /** P24: bindings from MCP/plugin sources (frozen by their own snapshot). */
  extraBindings?: readonly FrozenToolBinding[];
  /** P18-2 deferred advertisement policy. Applied at freeze so the model
   *  controller consumes the exact advertised set (stubs included). */
  schemaAdvertPolicy?: SchemaAdvertPolicy;
  /** P23-4: test-only escape — a permissive router resolves unlisted names to
   *  inert bindings. Production never sets this (strict TOOL_NOT_IN_STEP). */
  permissive?: boolean;
  sandboxPolicy?: SandboxPolicy;
  /** P31-3 — pre-built environment snapshot (id + cwd + roots + shell). When
   *  omitted, a deterministic LOCAL snapshot is built from `cwd`. Tool
   *  execution and fingerprinting use this snapshot, never live state. */
  environment?: EnvironmentSnapshot;
  /** P32-1 — the skills selected for this step (identity + body hash +
   *  required tools / MCP servers). Fingerprinted into StepRecord. */
  skills?: SkillSnapshot;
  /** P32-3 — explicit instruction sources (system prompt + AGENTS.md docs +
   *  skill bodies) assembled by the caller. When omitted (legacy callers),
   *  the sources default to a single `system` source over `system`. */
  instructionSources?: readonly InstructionSource[];
  now: () => number;
}

/** P23-1 — form the immutable step execution snapshot for ONE model call.
 *  The returned snapshot is authoritative for that call AND for every tool
 *  call the model response requests. Mid-run catalog/policy/config changes
 *  can only affect the NEXT snapshot. */
export function buildStepExecutionSnapshot(input: StepSnapshotBuildInput): StepExecutionSnapshot {
  const {
    sessionId, turnId, agent, cwd, stepIndex, priorBlocks, system, compacted,
    history, registry, semanticsOf, sandboxPolicy, now,
  } = input;

  const effectiveAgent = snapshotEffectiveConfig(agent);
  const stepId = `${turnId}:${stepIndex}`;

  // --- frozen tool world ----------------------------------------------------
  // P23-2 base path: registry definitions filtered by the agent tool policy.
  // (P23-2 deepens this with deferred schema / goal selector / collision
  // checks; the frozen set is computed here, BEFORE the model call.)
  const specsByName = new Map<string, ToolSpec>(registry.specs().map((spec) => [spec.name, spec]));
  const candidates: FrozenToolBinding[] = [];
  for (const def of registry.list()) {
    if (!isToolAllowedByPolicy(agent.tools, def.name)) continue;
    const spec = specsByName.get(def.name);
    if (spec === undefined) continue; // not advertised → not visible (P23-2 rule)
    candidates.push({
      name: def.name,
      spec,
      definition: def,
      semantics: semanticsOf(def.name),
      provenance: { kind: "builtin" },
    });
  }
  for (const extra of input.extraBindings ?? []) {
    candidates.push(extra);
  }
  // P23-2 collision rule: two sources producing the same model-visible name is
  // a typed TOOL_COLLISION, never a silent last-write-wins.
  const byName = new Map<string, FrozenToolBinding>();
  for (const candidate of candidates) {
    const existing = byName.get(candidate.name);
    if (existing !== undefined) {
      throw new AgentError(
        errorInfo(
          "TOOL_COLLISION",
          `tool "${candidate.name}" produced by ${existing.provenance.kind} and ${candidate.provenance.kind} — resolve before freeze`,
        ),
      );
    }
    byName.set(candidate.name, candidate);
  }
  const available = byName.size;
  let visible = [...byName.values()];
  const dropped: string[] = [];
  // P7-1/P7-2 goal-based selector narrows the advertised set — applied ONCE
  // here; the model controller must consume the frozen result (P23-3).
  if (input.toolSelector !== undefined && input.goal !== undefined) {
    const selection = input.toolSelector.select({
      goal: input.goal,
      tools: visible.map((b) => b.spec),
    });
    const selected = new Set(selection.selected.map((spec) => spec.name));
    dropped.push(...visible.filter((b) => !selected.has(b.name)).map((b) => b.name));
    visible = visible.filter((b) => selected.has(b.name));
  }
  // P18-2 deferred advertisement: below the token budget → full; above →
  // non-core specs advertised as discoverable stubs (full schema via
  // tool_lookup). The bindings keep their FULL schemas for execution.
  const advert = decideSchemaAdvert(
    visible.map((b) => b.spec),
    input.schemaAdvertPolicy,
  );
  const router = new FrozenStepToolRouter(visible, stepId, advert.advertised, input.permissive === true);

  // --- fingerprints ----------------------------------------------------------
  const policyFingerprint = hashPolicyConfig({
    tools: agent.tools,
    permissions: agent.permissions,
    sandbox: sandboxPolicy,
  });
  // P31-3: environment identity is the full snapshot fingerprint (id+shell+
  // roots+capabilities), not a naked cwd hash. A changed shell / workspace set
  // / capability set now correctly re-fingerprints the step.
  const environment: EnvironmentSnapshot =
    input.environment ??
    buildLocalEnvironmentSnapshot({
      cwd,
      shell: "local-default",
      env: undefined,
      permissionsFingerprint: policyFingerprint,
    });
  const environmentFingerprint = environment.fingerprint;

  // P32-3 — instruction world identity: explicit sources (system + AGENTS.md
  // + skill bodies). A changed document mid-run re-fingerprints the NEXT
  // step; the current step's instructionFingerprint is immutable.
  const sources: readonly InstructionSource[] =
    input.instructionSources ??
    [{ kind: "system", source: "system", contentHash: stableFingerprint([system]) }];
  const instructionFingerprint = stableFingerprint([
    sources.map((s) => ({ kind: s.kind, source: s.source, contentHash: s.contentHash, ...(s.path !== undefined ? { path: s.path } : {}) })),
    system,
  ]);

  // P32-1 — skill identity rides the durable record when skills are pinned.
  const skillSnapshotFingerprint = input.skills?.fingerprint;

  const contextFingerprint = stableFingerprint([
    history.map((m) => m.id),
    priorBlocks.map((b) => b.id),
    system,
  ]);

  const record: StepRecord = {
    stepId,
    sessionId,
    turnId,
    agentId: agent.id,
    model: agent.model,
    toolRouterFingerprint: router.fingerprint,
    policyFingerprint,
    environmentFingerprint,
    contextFingerprint,
    instructionFingerprint,
    ...(skillSnapshotFingerprint !== undefined ? { skillSnapshotFingerprint } : {}),
    createdAt: now(),
  };

  const permissions: PermissionProfileSnapshot = {
    toolPolicy: agent.tools,
    permissions: agent.permissions,
    sandboxPolicy: sandboxPolicy ?? defaultSandboxPolicy(),
    fingerprint: policyFingerprint,
  };

  const systemHash = stableFingerprint([system]);

  return {
    record,
    agent: effectiveAgent,
    environment,
    permissions,
    tools: router,
    model: agent.model,
    context: {
      messageIds: history.map((m) => m.id),
      blockIds: priorBlocks.map((b) => b.id),
      systemHash,
      contextHash: contextFingerprint,
      estimatedTokens: Math.ceil(Buffer.byteLength(system, "utf8") / 4),
      compacted,
    },
    instructions: {
      system,
      systemHash,
      sources,
      fingerprint: instructionFingerprint,
    },
    ...(skillSnapshotFingerprint !== undefined ? { skills: input.skills } : {}),
    advertised: {
      available,
      dropped,
    },
  };
}
