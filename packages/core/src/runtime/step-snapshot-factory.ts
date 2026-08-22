import { hashPolicyConfig } from "@ar/context";
import {
  isToolAllowedByPolicy,
  snapshotEffectiveConfig,
  stableFingerprint,
  type AgentDefinition,
  type ContextBlock,
  type FrozenToolBinding,
  type Message,
  type PermissionProfileSnapshot,
  type SandboxPolicy,
  type SessionId,
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
  const environmentFingerprint = stableFingerprint([cwd]);
  const instructionFingerprint = stableFingerprint([system]);
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
    environment: {
      cwd,
      workspaceRoots: [cwd],
    },
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
    instructions: { system, systemHash },
    advertised: {
      available,
      dropped,
    },
  };
}
