import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentDefinition, SandboxPolicy, SessionId, ToolSemantics } from "@ar/contracts";
import { DEFAULT_TOOL_SEMANTICS, RUNTIME_POLICY_SNAPSHOT_KEY, newAgentId } from "@ar/contracts";
import { ContextPipeline } from "@ar/context";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime, type AgentRuntimeDeps } from "./runtime.js";
import { RecoveryPolicy } from "../recovery/recovery.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "drift-agent",
  description: "test",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a test",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

/** Filesystem-writing semantics vs process-spawning semantics: the same tool
 *  name must hash differently once the host's lookup changes. */
const FS_SEMANTICS: ToolSemantics = {
  ...DEFAULT_TOOL_SEMANTICS,
  readOnly: false,
  retrySafety: "none",
  sideEffectScope: "filesystem",
  networkBehavior: "none",
  outputSensitivity: "high",
};
const PROCESS_SEMANTICS: ToolSemantics = {
  ...FS_SEMANTICS,
  sideEffectScope: "process",
  networkBehavior: "outbound",
};

const SANDBOX_DENY: SandboxPolicy = {
  filesystem: { mode: "read-only" },
  network: { mode: "deny" },
  process: {},
};
const SANDBOX_OPEN: SandboxPolicy = {
  filesystem: { mode: "read-only" },
  network: { mode: "full" },
  process: {},
};

function makeRuntime(
  store: MemorySessionStore,
  events: MemoryEventStore,
  overrides: Partial<AgentRuntimeDeps> = {},
): AgentRuntime {
  return new AgentRuntime({
    toolRegistry: defaultTestToolCatalog(),
    permissiveToolResolution: true,
    store,
    events,
    modelProvider: new ScriptedModelProvider([]),
    orchestrator: new FakeOrchestrator(),
    agents: [AGENT],
    ...overrides,
  });
}

/** Simulates a host restart: the same durable state, a different live policy. */
async function resumeWithDriftedPolicy(
  before: Partial<AgentRuntimeDeps>,
  after: Partial<AgentRuntimeDeps>,
): Promise<{ sessionId: SessionId; events: MemoryEventStore }> {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const first = makeRuntime(store, events, before);
  const session = await first.createSession({ agent: AGENT, cwd: "/work" });
  const restarted = makeRuntime(store, events, after);
  await restarted.getSessionAgent(session.id);
  return { sessionId: session.id, events };
}

async function driftEvents(events: MemoryEventStore, sessionId: SessionId) {
  return (await events.list(sessionId)).filter((e) => e.type === "policy.changed_on_resume");
}

/** The v1 snapshot encoding of retryPolicyHash: a plain hash of the live
 *  `RecoveryPolicy` instance (JSON.stringify over its own properties). */
function legacyRetryHash(policy: RecoveryPolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 16);
}

/** Simulates resuming a session created BEFORE the PKG-003 upgrade: the live
 *  runtime starts from `before`, then its snapshot is rewritten into the v1
 *  shape (arity-constant tool-semantics hash, no sandbox hash). */
async function resumeWithLegacySnapshot(
  before: RecoveryPolicy,
  after: RecoveryPolicy,
): Promise<{ sessionId: SessionId; events: MemoryEventStore }> {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const first = makeRuntime(store, events, { recovery: before });
  const session = await first.createSession({ agent: AGENT, cwd: "/work" });
  const snapshot = (await store.loadStateSnapshot(session.id))!;
  await store.saveStateSnapshot(session.id, {
    ...snapshot,
    [RUNTIME_POLICY_SNAPSHOT_KEY]: {
      version: 1,
      contextPolicyHash: undefined,
      retryPolicyHash: legacyRetryHash(before),
      schedulerPolicyHash: undefined,
      toolSemanticsHash: "1",
      createdAt: 0,
    },
  });
  const restarted = makeRuntime(store, events, { recovery: after });
  await restarted.getSessionAgent(session.id);
  return { sessionId: session.id, events };
}

describe("PKG-003: the safe-resume gate observes every frozen runtime policy dimension", () => {
  it("detects tool-semantics drift on resume (a real hash, not the arity constant)", async () => {
    const { sessionId, events } = await resumeWithDriftedPolicy(
      { toolSemanticsOf: () => FS_SEMANTICS },
      { toolSemanticsOf: () => PROCESS_SEMANTICS },
    );
    const drift = await driftEvents(events, sessionId);
    expect(drift).toHaveLength(1);
    expect(drift[0]!.payload.toolSemanticsChanged).toBe(true);
    expect(drift[0]!.payload.contextPolicyChanged).toBe(false);
    expect(drift[0]!.payload.retryPolicyChanged).toBe(false);
    expect(drift[0]!.payload.sandboxPolicyChanged).toBe(false);
  });

  it("detects retry-policy drift on resume", async () => {
    const { sessionId, events } = await resumeWithDriftedPolicy(
      { recovery: new RecoveryPolicy({ maxAttempts: 3 }) },
      { recovery: new RecoveryPolicy({ maxAttempts: 5 }) },
    );
    const drift = await driftEvents(events, sessionId);
    expect(drift).toHaveLength(1);
    expect(drift[0]!.payload.retryPolicyChanged).toBe(true);
    expect(drift[0]!.payload.toolSemanticsChanged).toBe(false);
  });

  it("detects an ask-only retry-policy change (a Set, invisible to JSON.stringify)", async () => {
    const { sessionId, events } = await resumeWithDriftedPolicy(
      { recovery: new RecoveryPolicy({ maxAttempts: 2 }) },
      {
        recovery: new RecoveryPolicy({
          maxAttempts: 2,
          askOn: new Set(["tool_failure"] as const),
        }),
      },
    );
    const drift = await driftEvents(events, sessionId);
    expect(drift).toHaveLength(1);
    expect(drift[0]!.payload.retryPolicyChanged).toBe(true);
  });

  it("detects sandbox-policy drift on resume", async () => {
    const { sessionId, events } = await resumeWithDriftedPolicy(
      { sandboxPolicy: SANDBOX_DENY },
      { sandboxPolicy: SANDBOX_OPEN },
    );
    const drift = await driftEvents(events, sessionId);
    expect(drift).toHaveLength(1);
    expect(drift[0]!.payload.sandboxPolicyChanged).toBe(true);
    expect(drift[0]!.payload.retryPolicyChanged).toBe(false);
  });

  it("still detects context-pipeline drift on resume", async () => {
    const { sessionId, events } = await resumeWithDriftedPolicy(
      {
        context: {
          pipeline: new ContextPipeline(),
          budget: { maxTokens: 1_000 } as never,
        },
      },
      {
        context: {
          pipeline: new ContextPipeline(),
          budget: { maxTokens: 2_000 } as never,
        },
      },
    );
    const drift = await driftEvents(events, sessionId);
    expect(drift).toHaveLength(1);
    expect(drift[0]!.payload.contextPolicyChanged).toBe(true);
    expect(drift[0]!.payload.toolSemanticsChanged).toBe(false);
    expect(drift[0]!.payload.sandboxPolicyChanged).toBe(false);
  });

  it("stays silent when the host policy is unchanged", async () => {
    const { sessionId, events } = await resumeWithDriftedPolicy(
      {
        toolSemanticsOf: () => FS_SEMANTICS,
        recovery: new RecoveryPolicy({ maxAttempts: 3 }),
        sandboxPolicy: SANDBOX_DENY,
      },
      {
        toolSemanticsOf: () => FS_SEMANTICS,
        recovery: new RecoveryPolicy({ maxAttempts: 3 }),
        sandboxPolicy: SANDBOX_DENY,
      },
    );
    expect(await driftEvents(events, sessionId)).toHaveLength(0);
  });

  it("still detects retry drift for a pre-upgrade (v1) snapshot", async () => {
    const { sessionId, events } = await resumeWithLegacySnapshot(
      new RecoveryPolicy({ maxAttempts: 3 }),
      new RecoveryPolicy({ maxAttempts: 5 }),
    );
    const drift = await driftEvents(events, sessionId);
    expect(drift).toHaveLength(1);
    expect(drift[0]!.payload.retryPolicyChanged).toBe(true);
  });

  it("reports no phantom drift for a pre-upgrade (v1) snapshot under the same policy", async () => {
    const { sessionId, events } = await resumeWithLegacySnapshot(
      new RecoveryPolicy({ maxAttempts: 3 }),
      new RecoveryPolicy({ maxAttempts: 3 }),
    );
    // v1 recorded an arity constant as its tool-semantics hash and no sandbox
    // hash at all; neither may be reported as drift for an old session.
    expect(await driftEvents(events, sessionId)).toHaveLength(0);
  });
});


it("review PR13: observes askOn drift when the configured retry cap exceeds eight", async () => {
  const before = new RecoveryPolicy({ maxAttempts: 16 });
  const after = new RecoveryPolicy({ maxAttempts: 16, askOn: new Set(["tool_failure"] as const) });
  expect(before.decide("tool_failure", 16).action).toBe("fail_safe");
  expect(after.decide("tool_failure", 16).action).toBe("ask");
  const { sessionId, events } = await resumeWithDriftedPolicy({ recovery: before }, { recovery: after });
  const drift = await driftEvents(events, sessionId);
  expect(drift).toHaveLength(1);
  expect(drift[0]!.payload.retryPolicyChanged).toBe(true);
});

it.each([
  { maxAttemptsByKind: { model_error: 64 }, askOn: new Set(["model_error"] as const) },
  { maxAttemptsByKind: { timeout: 1000000 } },
  { retryDelayByKind: { tool_failure: 700 } },
])("observes the complete per-kind retry policy: %j", async options => {
  const { sessionId, events } = await resumeWithDriftedPolicy(
    { recovery: new RecoveryPolicy({ maxAttempts: 16 }) },
    { recovery: new RecoveryPolicy({ maxAttempts: 16, ...options }) },
  );
  expect((await driftEvents(events, sessionId))[0]!.payload.retryPolicyChanged).toBe(true);
});

it("normalizes askOn insertion order without a false resume drift", async () => {
  const { sessionId, events } = await resumeWithDriftedPolicy(
    { recovery: new RecoveryPolicy({ askOn: new Set(["tool_failure", "model_error"]) }) },
    { recovery: new RecoveryPolicy({ askOn: new Set(["model_error", "tool_failure"]) }) },
  );
  expect(await driftEvents(events, sessionId)).toHaveLength(0);
});


it("policy drift without optional policies stays lossless JSON for live Web projection and durable replay", async () => {
  const { sessionId, events } = await resumeWithDriftedPolicy(
    { sandboxPolicy: SANDBOX_DENY }, { sandboxPolicy: SANDBOX_OPEN },
  );
  const [event] = await driftEvents(events, sessionId);
  expect(event!.payload.sandboxPolicyChanged).toBe(true);
  expect(JSON.parse(JSON.stringify(event!.payload))).toStrictEqual(event!.payload);
});


it("repeated and concurrent metadata reads report the same unchanged drift once instead of writing on every Web poll", async () => {
  const store = new MemorySessionStore(), events = new MemoryEventStore();
  const first = makeRuntime(store, events, { sandboxPolicy: SANDBOX_DENY });
  const session = await first.createSession({ agent: AGENT, cwd: "/work" });
  const resumed = makeRuntime(store, events, { sandboxPolicy: SANDBOX_OPEN });
  await Promise.all(Array.from({ length: 3 }, () => resumed.getSessionAgent(session.id)));
  await resumed.getSessionAgent(session.id);
  expect(await driftEvents(events, session.id)).toHaveLength(1);
});


it("a failed drift write remains observable on retry, and returning to baseline does not suppress a later drift", async () => {
  const store = new MemorySessionStore(), events = new MemoryEventStore();
  const first = makeRuntime(store, events, { sandboxPolicy: SANDBOX_DENY });
  const session = await first.createSession({ agent: AGENT, cwd: "/work" });
  const live: SandboxPolicy = { ...SANDBOX_OPEN, network: { mode: "full" } };
  const resumed = makeRuntime(store, events, { sandboxPolicy: live });
  const append = events.appendNew.bind(events);
  events.appendNew = async () => { throw new Error("drift journal unavailable"); };
  await expect(resumed.getSessionAgent(session.id)).rejects.toThrow("journal unavailable");
  events.appendNew = append;
  await resumed.getSessionAgent(session.id);
  expect(await driftEvents(events, session.id)).toHaveLength(1);
  live.network = { mode: "deny" };
  await resumed.getSessionAgent(session.id);
  expect(await driftEvents(events, session.id)).toHaveLength(1);
  live.network = { mode: "full" };
  await resumed.getSessionAgent(session.id);
  expect(await driftEvents(events, session.id)).toHaveLength(2);
});
