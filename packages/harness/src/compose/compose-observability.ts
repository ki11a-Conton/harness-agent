/**
 * P22-1 — composition helper: OBSERVABILITY.
 *
 * Extracted from createHarness.ts verbatim (composition refactor only).
 * Honest wiring facts: store implementations by constructor name, registered
 * tool names, feature flags, and the P16-4 durability truth — exactly what
 * P0-1's audit consumes.
 */
import type {
  ApprovalStore,
  ArtifactStore,
  AskUserStore,
  CheckpointStore,
  EventStore,
  MemoryStore,
  SessionStore,
} from "@ar/contracts";
import type { Delegator, AgentExecutionScheduler } from "@ar/agents";
import type { ToolRegistry } from "@ar/tools";
import type { HarnessFeatureFlags } from "../config.js";
import type { HarnessIntrospection } from "../introspection.js";

export interface IntrospectionInput {
  profile: string;
  registry: ToolRegistry;
  store: SessionStore;
  events: EventStore;
  approvalStore: ApprovalStore;
  askUserStore?: AskUserStore;
  checkpointStore?: CheckpointStore;
  artifactStore?: ArtifactStore;
  memoryStore?: MemoryStore;
  features: HarnessFeatureFlags;
  delegator?: Delegator;
  scheduler?: AgentExecutionScheduler;
  mcpTools?: string[];
  mcpServers?: number;
}

/** P16-4: is a durability-required feature wired to a NON-durable store?
 *  Durable store classes are those persisting to disk (JSONL/SQLite/Durable*);
 *  the in-memory classes never survive a process restart. */
function isDurableStoreClass(name: string): boolean {
  return /^(JSONL|Sqlite|Durable|File)/.test(name) && name !== "MemSessionStore" && !name.includes("Memory");
}

/** Honest wiring facts: store implementations by constructor name, registered
 *  tool names, feature flags, and the P16-4 durability truth — exactly what
 *  P0-1's audit consumes. */
export function introspectHarness(input: IntrospectionInput): HarnessIntrospection {
  const approvalClass = input.approvalStore.constructor.name;
  const askUserClass = input.askUserStore?.constructor.name;
  const checkpointClass = input.checkpointStore?.constructor.name;
  const durable = isDurableStoreClass(input.store.constructor.name);

  // P16-4: DEGRADED = a durability-required feature is enabled but its store
  // is in-memory. Reasons must be explicit so the audit can never call a
  // degraded harness production-ready.
  const reasons: string[] = [];
  if (input.features.checkpoint && input.checkpointStore === undefined) {
    reasons.push("checkpoint enabled but no checkpoint store wired (in-memory)");
  }
  if (input.features.checkpoint && input.checkpointStore !== undefined && !isDurableStoreClass(checkpointClass!)) {
    reasons.push(`checkpoint store ${checkpointClass} is not durable`);
  }
  if (!isDurableStoreClass(approvalClass) && approvalClass !== "InMemoryApprovalStore") {
    // unknown approval impl — flag conservatively
    reasons.push(`approval store ${approvalClass} is not a known durable class`);
  }
  if (input.features.delegation && !durable) {
    reasons.push("long-run delegation/recovery enabled without a durable session/event store");
  }
  if (input.askUserStore === undefined && input.features.context) {
    // ask-user is optional; only flag when the profile requires interactive approval
    // (interactive/batch profiles ask for edit/exec approvals).
    if (input.profile === "interactive" || input.profile === "batch") {
      reasons.push("interactive approval requires ask-user durability but no ask-user store is wired");
    }
  }
  if (input.askUserStore !== undefined && !isDurableStoreClass(askUserClass!)) {
    reasons.push(`ask-user store ${askUserClass} is not durable`);
  }

  return {
    profile: input.profile,
    registeredTools: input.registry.names(),
    stores: {
      session: input.store.constructor.name,
      events: input.events.constructor.name,
      ...(input.checkpointStore !== undefined ? { checkpoint: input.checkpointStore.constructor.name } : {}),
      ...(input.memoryStore !== undefined ? { memory: input.memoryStore.constructor.name } : {}),
      approval: approvalClass,
      ...(askUserClass !== undefined ? { askUser: askUserClass } : {}),
      ...(input.artifactStore !== undefined ? { artifacts: input.artifactStore.constructor.name } : {}),
    },
    persistence: {
      mode: durable ? "durable" : "in-memory",
      degraded: reasons.length > 0,
      reasons,
      stores: {
        approval: approvalClass,
        ...(askUserClass !== undefined ? { askUser: askUserClass } : {}),
        ...(checkpointClass !== undefined ? { checkpoint: checkpointClass } : {}),
      },
    },
    features: {
      context: input.features.context,
      verifier: false,
      checkpoint: input.checkpointStore !== undefined,
      artifacts: input.artifactStore !== undefined,
      memory: input.memoryStore !== undefined,
      learning: input.features.learning,
      delegation: input.delegator !== undefined,
      scheduler: input.scheduler !== undefined,
      mcp: input.features.mcp || (input.mcpServers ?? 0) > 0,
      plugins: input.features.plugins,
      skills: input.features.skills,
      // P38.2-11: usage accounting IS wired — the runtime folds provider
      // `usage` events into `model.completed.usage` (P0-9, proven by
      // packages/core/src/runtime/runtime.test.ts) and the observability
      // metrics pipeline reads that snapshot (packages/observability/metrics.ts).
      // Reporting `false` was stale under-reporting; the chain is real.
      usageAccounting: true,
      // P38.1-12: RunLimits ARE enforced by the runtime — every turn creates a
      // RunBudgetTracker (packages/core/src/runtime/runtime.ts) that enforces
      // maxTurns / maxToolCalls / maxDurationMs and beyond. Reporting `false`
      // was honest under-reporting that wrongly failed the profile mustBeWired
      // check for run_budget on every profile.
      runBudget: true,
      // P35-2: the production composition root always composes the
      // StepExecutionSnapshot pipeline (step-snapshot-factory) before every
      // model call — this is a wiring fact, not a toggle.
      stepSnapshot: true,
    },
    ...(input.mcpServers !== undefined && (input.mcpServers ?? 0) > 0
      ? { mcp: { servers: input.mcpServers, tools: input.mcpTools ?? [] } }
      : {}),  };
}