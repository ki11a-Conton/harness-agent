// PR-A (task-12) — focused regressions for two independently-confirmed defects.
//
// DEFECT-1 (M5, trace lies): the legacy recovery ladder emitted
//   `recovery.decided{action:"retry_safe"}` BEFORE consulting the tool's
//   `retrySafety` gate, so a tool that was never re-dispatched still left a
//   "retry_safe / retrying" record behind. Fixed by resolving the reported
//   action before emitting: `retry_safe` only when a retry IS dispatched, and
//   `retry_refused` when the safety gate declines the escalation.
//
// DEFECT-2 (M8, missing security event): a `denied` result returned by the
//   orchestrator emitted no `security.*_denied` event, so a refusal from the
//   real permission engine / sandbox / write-safety guard was invisible to
//   `packages/evaluation/src/security-evidence-execution.ts`, which builds
//   POLICY_DENIED from exactly those events. Fixed by classifying the denial
//   code onto a security event, with a fail-closed fallback.

import { describe, expect, it } from "vitest";
import type {
  AgentDefinition,
  AgentEvent,
  ModelEvent,
  ToolCallRequest,
  ToolExecutionContext,
  ToolResult,
  ToolSemantics,
} from "@ar/contracts";
import { DEFAULT_TOOL_SEMANTICS, errorInfo, newAgentId } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime } from "./runtime.js";
import { RecoveryPolicy } from "../recovery/recovery.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "recovery-trace-security-agent",
  description: "task-12 focused regressions",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a trace/security conformance agent",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

const READ_ONLY_SAFE: ToolSemantics = {
  ...DEFAULT_TOOL_SEMANTICS,
  retrySafety: "safe",
  readOnly: true,
  idempotent: true,
};

interface Harness {
  runtime: AgentRuntime;
  store: MemorySessionStore;
  events: MemoryEventStore;
  orch: CountingOrchestrator;
}

/** Counts every dispatch, so "did it really retry?" is answerable without
 *  trusting the event stream (the whole point of DEFECT-1). */
class CountingOrchestrator extends FakeOrchestrator {
  dispatched = 0;
  constructor(fixed: ToolResult) {
    super(fixed);
  }
  override async execute(request: ToolCallRequest, context: ToolExecutionContext): Promise<ToolResult> {
    this.dispatched += 1;
    return super.execute(request, context);
  }
}

async function makeHarness(opts: {
  scripts: ModelEvent[][];
  orch: CountingOrchestrator;
  recovery?: RecoveryPolicy;
  toolSemantics?: (name: string) => ToolSemantics;
}): Promise<Harness> {
  const store = new MemorySessionStore();
  const events = new MemoryEventStore();
  const runtime = new AgentRuntime({
    toolRegistry: defaultTestToolCatalog(),
    permissiveToolResolution: true,
    store,
    events,
    modelProvider: new ScriptedModelProvider(opts.scripts),
    orchestrator: opts.orch,
    agents: [{ ...AGENT, limits: {} }],
    recovery: opts.recovery ?? new RecoveryPolicy({ maxAttempts: 3, retryDelayMs: 0 }),
    ...(opts.toolSemantics !== undefined ? { toolSemanticsOf: opts.toolSemantics } : {}),
  });
  return { runtime, store, events, orch: opts.orch };
}

async function run(h: Harness, text = "go"): Promise<{ status: string; all: AgentEvent[] }> {
  const session = await h.runtime.createSession({ agent: AGENT, cwd: process.cwd() });
  const turn = await h.runtime.startTurn(session.id, text);
  const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
  return { status: outcome.status, all: await h.events.list(session.id) };
}

function decisions(all: AgentEvent[]) {
  return all
    .filter((e) => e.type === "recovery.decided")
    .map((e) => e.payload as { action: string; tool?: string; reason?: string });
}

describe("task-12 / DEFECT-1: recovery.decided must not claim a retry that never happened", () => {
  it("[1] non-safe tool failure: NO retry_safe, dispatch count stays 1, refusal is named", async () => {
    // write_file is NOT retrySafety="safe" (unknown side effects).
    const orch = new CountingOrchestrator({
      status: "failed",
      error: errorInfo("PROCESS_ERROR", "boom"),
    });
    const h = await makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("write_file", { path: "x.txt", content: "1" }),
        ScriptedModelProvider.text("stopped"),
      ],
      orch,
    });
    const { all } = await run(h);

    const ds = decisions(all);
    expect(ds.length).toBeGreaterThan(0);
    // The trace must NOT advertise a retry that was never dispatched.
    expect(ds.filter((d) => d.action === "retry_safe")).toHaveLength(0);
    // …and the refusal must be POSITIVELY recorded, not merely omitted.
    expect(ds.some((d) => d.action === "retry_refused")).toBe(true);
    // Ground truth: exactly one dispatch.
    expect(orch.dispatched).toBe(1);
  });

  it("[2] safe tool failure: retry_safe count == real retries, bounded by maxAttempts", async () => {
    const orch = new CountingOrchestrator({
      status: "failed",
      error: errorInfo("PROCESS_ERROR", "transient", { retryable: true, safeToRetry: true }),
    });
    const h = await makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("read_file", { path: "a.txt" }),
        ScriptedModelProvider.text("done"),
      ],
      orch,
      recovery: new RecoveryPolicy({ maxAttempts: 3, retryDelayMs: 0 }),
      toolSemantics: () => READ_ONLY_SAFE,
    });
    const { all } = await run(h);

    const retrySafe = decisions(all).filter((d) => d.action === "retry_safe");
    // 1 original dispatch + N retries; retry_safe == N == dispatched - 1.
    const retries = orch.dispatched - 1;
    expect(retrySafe).toHaveLength(retries);
    expect(retrySafe.length).toBeGreaterThan(0);
    // Bounded: maxAttempts=3 bounds the ladder, and every advertised retry
    // really was dispatched.
    expect(retries).toBeLessThanOrEqual(2);
    expect(decisions(all).some((d) => d.action === "fail_safe")).toBe(true);
    // No refusal is recorded when the gate actually allows the retry.
    expect(decisions(all).filter((d) => d.action === "retry_refused")).toHaveLength(0);
  });
});

describe("task-12 / DEFECT-2: an orchestrator denial must appear on the security stream", () => {
  function securityEvents(all: AgentEvent[]) {
    return all.filter((e) => e.type.startsWith("security."));
  }

  it("[3] orchestrator `denied` produces a security.*_denied carrying the toolCallId and tool", async () => {
    const orch = new CountingOrchestrator({
      status: "denied",
      error: errorInfo("WRITE_SAFETY_DENIED", "write blocked by write-safety guard"),
    });
    const h = await makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("write_file", { path: "keep.txt", content: "overwrite" }),
        ScriptedModelProvider.text("stopped"),
      ],
      orch,
    });
    const { all } = await run(h);

    const denied = securityEvents(all);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.type).toBe("security.filesystem_denied");
    // The fact is attributable: it names the exact call and tool.
    const requested = all.find((e) => e.type === "tool.requested");
    expect(denied[0]!.payload.toolCallId).toBe(requested!.payload.toolCallId);
    expect(denied[0]!.payload.tool).toBe("write_file");
    expect(denied[0]!.payload.source).toBe("orchestrator");
    expect(denied[0]!.payload.code).toBe("WRITE_SAFETY_DENIED");
    // Exactly one dispatch — the denial was not retried.
    expect(orch.dispatched).toBe(1);
  });

  it("[4] the denial dimension is classifiable: distinct codes → distinct event types", async () => {
    const cases: Array<{ code: string; errorType: string; expected: string }> = [
      { code: "WRITE_SAFETY_DENIED", errorType: "security.filesystem_denied", expected: "security.filesystem_denied" },
      { code: "SANDBOX_BACKEND_DENIED", errorType: "security.process_denied", expected: "security.process_denied" },
      { code: "SECURITY_DENIED", errorType: "security.capability_denied", expected: "security.capability_denied" },
    ];
    for (const c of cases) {
      const orch = new CountingOrchestrator({
        status: "denied",
        error: errorInfo(c.code as never, `denied: ${c.code}`),
      });
      const h = await makeHarness({
        scripts: [
          ScriptedModelProvider.toolCall("write_file", { path: "x.txt", content: "1" }),
          ScriptedModelProvider.text("stopped"),
        ],
        orch,
      });
      const { all } = await run(h);
      const denied = securityEvents(all);
      expect(denied).toHaveLength(1);
      expect(denied[0]!.type).toBe(c.expected);
      // No `unmapped_code` marker: the code WAS recognised.
      expect(denied[0]!.payload.unmapped_code).toBeUndefined();
    }
  });

  it("[5] an unrecognised denial code fails CLOSED (still journaled) instead of vanishing", async () => {
    // A host/plugin orchestrator may return a denial with a code the runtime has
    // never heard of. `errorInfo` refuses unknown codes (no defaults entry), so
    // the result carries a hand-built error — exactly what such an orchestrator
    // would produce. The runtime must NOT drop the fact.
    const orch = new CountingOrchestrator({
      status: "denied",
      error: {
        code: "SOME_BRAND_NEW_DENIAL_CODE",
        message: "denied by a plugin guard",
        retryable: false,
        safeToRetry: false,
      } as never,
    });
    const h = await makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("write_file", { path: "x.txt", content: "1" }),
        ScriptedModelProvider.text("stopped"),
      ],
      orch,
    });
    const { all } = await run(h);

    const denied = securityEvents(all);
    // Fail-closed: NOT silently dropped.
    expect(denied).toHaveLength(1);
    expect(denied[0]!.type).toBe("security.permission_denied");
    // …and the fact that the mapping was a fallback stays auditable.
    expect(denied[0]!.payload.unmapped_code).toBe(true);
    expect(denied[0]!.payload.code).toBe("SOME_BRAND_NEW_DENIAL_CODE");
  });

  it("[5b] a denial with NO error code still fails closed", async () => {
    // Worst case: the orchestrator denies without saying why. Silently emitting
    // nothing here is precisely the fail-open behavior this task removes.
    const orch = new CountingOrchestrator({ status: "denied" });
    const h = await makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("write_file", { path: "x.txt", content: "1" }),
        ScriptedModelProvider.text("stopped"),
      ],
      orch,
    });
    const { all } = await run(h);

    const denied = securityEvents(all);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.type).toBe("security.permission_denied");
    // The synthetic code marks it as "reported without a classification".
    expect(denied[0]!.payload.unmapped_code).toBe(true);
  });

  it("[6] no double-emit: codes the orchestrator already journals produce exactly one security fact", async () => {
    for (const code of ["PERMISSION_DENIED", "SANDBOX_FILESYSTEM_DENIED", "SANDBOX_NETWORK_DENIED"]) {
      const orch = new CountingOrchestrator({
        status: "denied",
        error: errorInfo(code as never, `denied: ${code}`),
      });
      const h = await makeHarness({
        scripts: [
          ScriptedModelProvider.toolCall("write_file", { path: "x.txt", content: "1" }),
          ScriptedModelProvider.text("stopped"),
        ],
        orch,
      });
      const { all } = await run(h);
      // The runtime does NOT re-emit a fact a lower layer owns. (The fake
      // orchestrator here emits nothing, which is precisely the point: the
      // ownership decision — not luck — is what keeps the stream single-fact.)
      const denied = securityEvents(all);
      expect(denied).toHaveLength(0);
    }
  });
});
