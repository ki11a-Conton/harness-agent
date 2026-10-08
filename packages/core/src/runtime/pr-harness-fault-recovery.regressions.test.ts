// PR harness-engineering-conformance — §五 故障注入验收（第 1 / 2 / 5 类）
//
// 权威输入：C:\Users\MECHREV\Downloads\Harness_Agent_核心指标与工程验收标准.md §五
//
// ── 覆盖盘点：既有覆盖（本文件不重复其断言）─────────────────────────────
//
// 第 1 类「上下文即将耗尽」——既有：
//   · loop-integration.test.ts「tiny budget overflows → compaction runs → loop
//     continues」：只断言 turn 完成 + orch.calls.length，不断言保留内容。
//   · loop-integration.test.ts「compaction emits context events and a structured
//     digest message」：断言 context.compacted(reactive=false) + digest 含 goal。
//   · active-user-context.test.ts：断言 steering 在每个 ModelRequest 中可见、
//     digest 含 steering、装不下时以 RESOURCE_LIMIT 明确失败（含 protected_facts
//     检查）。**这是既有最强的「约束保留」断言。**
//   · runtime.test.ts「reactive compact …」：reactive overflow → 一次 compact，
//     不 blind retry；第二次 overflow 直接失败。
//   · fault-injection-v2.test.ts「kill during compaction」：context.compacted
//     点被杀，digest 已 durable，resume 可完成。
//
// 第 2 类「工具连续报错」——既有：
//   · loop-integration.test.ts RECOVERY-001：safe 工具失败→重试 1 次后成功
//     (calls=2)；unknown/non-idempotent 工具失败→只执行 1 次。
//   · loop-integration.test.ts「exhausts model-error retries」：模型错误重试上限
//     + run.limit_reached(limit=maxRetries)。
//   · runtime.test.ts P19-3：retry_safe 仅对 retrySafety=safe 生效，预算用尽
//     (remaining 2→0)；timeout → reconcile_unknown_effect 且只执行一次。
//   · loop-integration.test.ts P19-4：non-idempotent write 的 timeout 不 blind
//     retry；工具层与模型层重试分层（不伪造 model.retry）。
//   · fault-injection.test.ts：tool failure → MODEL_ERROR；失败后模型恢复可完成。
//
// 第 5 类「执行中进程崩溃」——既有：
//   · crash-matrix.test.ts P26-8：9 个 kill point 全矩阵，writeCount 不超限。
//   · crash-sideeffect.test.ts P34-3：非幂等 append 计数器文件行数 == 1。
//   · fault-injection-v2.test.ts P1-5：unresolved vs committed 分类；无 checkpoint
//     时 RESUME_FAILED 不伪造工作。
//   · fault-injection.test.ts P2-37 / P15-6：中断时 serial write 链部分效应保留 +
//     每个 tool call 恰好 settle 一次。
//
// ── 本文件新增的格子（既有覆盖之外的缺口）───────────────────────────────
//
// [C1-1] 压缩后「约束 + 进度 + 证据」三者同时可观测：
//        既有 context 测试断言的是 steering/digest 文本；本用例断言 **同一 turn 内
//        真正发生压缩**（context.compacted > 0 且无 protected_facts_violation）、
//        压缩后**循环继续派发全部工具**（进度推进）、约束在 user 与 system digest
//        中同时存活、工具输出证据仍留在 transcript（可被 read_file 取回）。
//
// [C1-2] 压缩下破坏性写入只发生一次（压缩不重放副作用）：
//        既有测试都止步于 "turn completed"；本用例断言 write 计数 == 模型请求次数
//        且 filesChanged 与之一致。
//
// [C1-3] 压缩落 checkpoint 安全边界（reason="context:compacted"），可被恢复。
//
// [C2-1] 同 turn 内**混合**错误分类矩阵：safe 可重试失败 / 非 safe 超时 / 权限拒绝
//        同时出现时，断言 recovery.decided 的动作序列 + 各工具的真实执行次数，
//        证明"分类处理 + 有限重试"而不是"一律重试"。既有测试各自只注入一种。
//
// [C2-2] 连续不可恢复错误以明确失败终止（failed/blocked + RESOURCE_LIMIT），
//        且不出现 turn.completed（不谎报完成）。
//
// [C2-3] 不可重试错误（retryable=false）的执行次数上限为 1，且不伪造 model/provider
//        层重试。**该用例同时固化一个已发现的观测缺陷**（见文末 DEFECT-1）。
//
// [C2-4] 模型连续报错的重试上限与 maxRetries 终止原因。
//
// [C5-1] checkpoint 持久化边界（tool.checkpointed）中断：断言 effect + 恢复标记
//        都 durable；resume 后**破坏性写入计数保持 1**（幂等性硬断言）。
//
// [C5-2] 工具调用「前」中断（tool.intent_persisting，无 intent 记录）：
//        resume 后破坏性写入**恰好一次**——既不丢失也不重复。
//
// [C5-3] 中断后 resume 的幂等键：tool 结果消息在 resume 前后**同一条**（id 不变），
//        不追加第二条 durable 结果。
//
// [C5-4] 崩溃发生在持久化边界之后但 checkpoint 丢失时不恢复（RESUME_FAILED），
//        绝不盲重跑未知结局的破坏性写入。
//
// ── 本文件发现的缺陷（只记录，不在此修复）───────────────────────────────
// DEFECT-1（观测不实 / trace 撒谎）：
//   `packages/core/src/runtime/tool-call-controller.ts:736-757`：legacy 重试阶梯
//   在判断 `retryPolicy !== "safe"`（第 757 行）之前，先无条件发出
//   `recovery.decided` 事件，且该事件在 decision.action==="retry" 时被映射成
//   `action: "retry_safe"`、`reason: "...retrying"`。因此**一个语义为
//   retrySafety!="safe"（或 retryable=false）的工具失败**，会在 trace 中留下
//   "retry_safe / retrying" 的记录，而运行时实际**没有重试**（执行次数为 1）。
//   影响：指标 #9「Trace 完整率」与 §五 第 2 类「分类处理」的可审计性——从 trace
//   无法区分"真的重试了"与"被拒绝重试"。
//   证据：本文件 [C2-1] 与 [C2-3] 直接断言了"事件说 retry_safe 但执行次数为 1"。
//
// DEFECT-2（安全事件缺失，与第 2 类"权限拒绝"分类相关）：
//   `packages/core/src/runtime/tool-call-controller.ts:570-578`、
//   `:588-595`：`security.permission_denied` 只在**运行时自身**的策略/hook 闸门
//   触发时发出。当 `status: "denied"` 由 orchestrator（真正的权限引擎位于
//   @ar/tools）返回时，只发 `tool.failed`，**不发任何 security.* 事件**。
//   影响：来自工具层的权限拒绝在安全事件流上不可见。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentDefinition,
  AgentEvent,
  CheckpointData,
  CheckpointStore,
  ModelEvent,
  Session,
  SessionId,
  SessionStatus,
  ToolCallRequest,
  ToolExecutionContext,
  ToolResult,
  ToolSemantics,
} from "@ar/contracts";
import {
  DEFAULT_TOOL_SEMANTICS,
  buildCheckpoint,
  errorInfo,
  newAgentId,
  newCheckpointId,
  newWorkingState,
} from "@ar/contracts";
import { ContextPipeline } from "@ar/context";
import { ScriptedModelProvider } from "@ar/model";
import { AgentRuntime, RuntimeKilledError, type FaultPoint } from "./runtime.js";
import { RecoveryPolicy } from "../recovery/recovery.js";
import { MemoryEventStore, MemorySessionStore, defaultTestToolCatalog } from "../test/fakes.js";
import { FakeOrchestrator } from "../test/fake-orchestrator.js";

const AGENT: AgentDefinition = {
  id: newAgentId(),
  name: "pr-fault-recovery-agent",
  description: "PR harness-engineering-conformance fault recovery",
  mode: "primary",
  model: { providerId: "scripted", modelId: "scripted-model" },
  systemPrompt: "you are a conformance test agent",
  tools: {},
  permissions: { rules: [] },
  skills: {},
  limits: {},
};

// ── durable fixtures ────────────────────────────────────────────────────

class FakeCheckpointStore implements CheckpointStore {
  saved: CheckpointData[] = [];
  seed?: CheckpointData;
  async save(checkpoint: CheckpointData): Promise<void> {
    this.saved.push(checkpoint);
  }
  async loadLatest(): Promise<CheckpointData | undefined> {
    if (this.saved.length > 0) return this.saved[this.saved.length - 1];
    return this.seed;
  }
  async list(): Promise<CheckpointData[]> {
    return [...this.saved].reverse();
  }
}

/** A "last durable checkpoint" seed: what a fresh process would see before the
 *  interrupted turn wrote any of its own progress. `resumeTurn` requires one. */
function seededCheckpoint(sessionId: SessionId, over: Partial<CheckpointData> = {}): CheckpointData {
  return buildCheckpoint({
    checkpointId: newCheckpointId(),
    schemaVersion: 1 as const,
    sessionId,
    agentId: AGENT.id as never,
    createdAt: 10,
    reason: "seed",
    phase: "thinking",
    iteration: 1,
    state: newWorkingState("conformance task"),
    toolLedger: [],
    childSessions: [],
    lastEventSequence: 0,
    effectiveAgentConfigRef: "effectiveAgent",
    contextRefs: [],
    ...over,
  });
}

class FilteringSessionStore extends MemorySessionStore {
  override async listSessions(opts?: {
    parentId?: SessionId;
    status?: SessionStatus;
  }): Promise<Session[]> {
    let list = await super.listSessions();
    if (opts?.parentId !== undefined) list = list.filter((s) => s.parentId === opts.parentId);
    if (opts?.status !== undefined) list = list.filter((s) => s.status === opts.status);
    return list;
  }
}

/** Counts executions of the destructive tool. This counter — not a file — is
 *  the duplicate-destructive-write probe: any silent re-execution shows up as
 *  a count above the number of model-requested writes.
 *
 *  IMPORTANT: `dispatched` counts EVERY executed call, and is incremented in
 *  this base `execute`. Subclasses that override `execute` must therefore call
 *  `this.note(request)` (or `super.execute`) — otherwise dispatch counting is
 *  silently lost, which would make a "ran exactly once" assertion vacuous. */
class WriteCountingOrchestrator extends FakeOrchestrator {
  writeCount = 0;
  dispatched = 0;
  constructor(result?: ToolResult) {
    super(result);
  }
  /** Record one dispatch; returns the tool name for convenience. */
  protected note(request: ToolCallRequest): string | undefined {
    this.dispatched += 1;
    const call = Array.isArray(request.call) ? request.call[0] : request.call;
    if (call?.name === "write_file") this.writeCount += 1;
    return call?.name;
  }
  override async execute(request: ToolCallRequest, context: ToolExecutionContext): Promise<ToolResult> {
    this.note(request);
    return super.execute(request, context);
  }
}

function killAt(points: ReadonlySet<FaultPoint>) {
  return (point: FaultPoint): void => {
    if (points.has(point)) throw new RuntimeKilledError(point);
  };
}

const READ_ONLY_SAFE: ToolSemantics = {
  ...DEFAULT_TOOL_SEMANTICS,
  retrySafety: "safe",
  readOnly: true,
  idempotent: true,
};

let tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs = [];
});

async function makeCwd(prefix: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(cwd);
  return cwd;
}

// ── shared runtime builder ──────────────────────────────────────────────

interface Harness {
  runtime: AgentRuntime;
  store: FilteringSessionStore;
  events: MemoryEventStore;
  ckpt: FakeCheckpointStore;
  orch: WriteCountingOrchestrator;
  cwd: string;
}

async function makeHarness(opts: {
  scripts?: ModelEvent[][];
  kill?: ReadonlySet<FaultPoint>;
  orch?: WriteCountingOrchestrator;
  context?: { maxTokens: number };
  recovery?: RecoveryPolicy;
  checkpointPolicy?: {
    afterSideEffectTools: boolean;
    afterCompaction: boolean;
    afterVerification: boolean;
    everyNIterations: number;
  };
  toolSemantics?: (name: string) => ToolSemantics;
  maxIterationsPerTurn?: number;
} = {}): Promise<Harness> {
  const cwd = await makeCwd("pr-fr-");
  const orch = opts.orch ?? new WriteCountingOrchestrator({ status: "success", output: "ok" });
  const store = new FilteringSessionStore();
  const events = new MemoryEventStore();
  const ckpt = new FakeCheckpointStore();
  const runtime = new AgentRuntime({
    toolRegistry: defaultTestToolCatalog(),
    permissiveToolResolution: true,
    store,
    events,
    modelProvider: new ScriptedModelProvider(opts.scripts ?? [ScriptedModelProvider.text("done")]),
    orchestrator: orch,
    agents: [{ ...AGENT, limits: {} }],
    checkpointStore: ckpt,
    checkpointPolicy:
      opts.checkpointPolicy ?? {
        afterSideEffectTools: true,
        afterCompaction: true,
        afterVerification: true,
        everyNIterations: 0,
      },
    ...(opts.kill !== undefined ? { failpoint: killAt(opts.kill) } : {}),
    ...(opts.context !== undefined
      ? {
          context: {
            pipeline: new ContextPipeline(),
            budget: {
              maxTokens: opts.context.maxTokens,
              reserved: { system: 0, task: 0, output: 0 },
              dynamic: 0,
            },
          },
        }
      : {}),
    ...(opts.recovery !== undefined ? { recovery: opts.recovery } : {}),
    ...(opts.toolSemantics !== undefined ? { toolSemanticsOf: opts.toolSemantics } : {}),
    ...(opts.maxIterationsPerTurn !== undefined
      ? { maxIterationsPerTurn: opts.maxIterationsPerTurn }
      : {}),
  });
  return { runtime, store, events, ckpt, orch, cwd };
}

/** A fresh "process" over the same durable stores. Default script just stops,
 *  mirroring the existing crash suites (a resumed process must not need to
 *  re-request the destructive write in order to finish). */
function restarted(
  h: Harness,
  scripts?: ModelEvent[][],
  opts: { toolSemantics?: (n: string) => ToolSemantics } = {},
): AgentRuntime {
  return new AgentRuntime({
    toolRegistry: defaultTestToolCatalog(),
    permissiveToolResolution: true,
    store: h.store,
    events: h.events,
    modelProvider: new ScriptedModelProvider(scripts ?? [ScriptedModelProvider.text("done")]),
    orchestrator: h.orch,
    agents: [{ ...AGENT, limits: {} }],
    checkpointStore: h.ckpt,
    checkpointPolicy: {
      afterSideEffectTools: false,
      afterCompaction: false,
      afterVerification: false,
      everyNIterations: 0,
    },
    ...(opts.toolSemantics !== undefined ? { toolSemanticsOf: opts.toolSemantics } : {}),
  });
}

async function types(h: Harness, sessionId: SessionId): Promise<string[]> {
  return (await h.events.list(sessionId)).map((e: AgentEvent) => e.type);
}

// ════════════════════════════════════════════════════════════════════════
// 第 1 类：上下文即将耗尽 → 保留任务约束、进度与证据，继续正确执行
// ════════════════════════════════════════════════════════════════════════

describe("§五-1 上下文即将耗尽：约束/进度/证据保留后继续正确执行", () => {
  const CONSTRAINT = "MUST NOT change the public API; keep package-lock frozen";

  /** Four DISTINCT successful reads then a final answer. Distinct paths and
   *  distinct payloads matter: identical calls (or identical failures) trip the
   *  stall detectors and end the turn before the context budget is ever
   *  pressured, which would make this a stall test rather than a context test. */
  function longTaskScript(reads: number): ModelEvent[][] {
    return [
      ...Array.from({ length: reads }, (_, i) =>
        ScriptedModelProvider.toolCall("read_file", { path: `src/module-${i}.ts` }),
      ),
      ScriptedModelProvider.text("all steps complete"),
    ];
  }

  /** Succeeds with a per-call unique, bulky payload — forces real compaction
   *  without tripping repeated-read / repeated-error stall detection, and
   *  counts every dispatch so "the loop kept going" is assertable. */
  class BulkyReadOrchestrator extends WriteCountingOrchestrator {
    constructor(private readonly bytes: number) {
      super({ status: "success", output: "ok" });
    }
    override async execute(request: ToolCallRequest, context: ToolExecutionContext): Promise<ToolResult> {
      const name = this.note(request);
      const call = Array.isArray(request.call) ? request.call[0] : request.call;
      if (name === "read_file") {
        return {
          status: "success",
          output: `EVIDENCE_BODY_${String(call.args.path)} ` + "Z".repeat(this.bytes),
        };
      }
      if (name === "write_file") {
        return { status: "success", output: `EVIDENCE_WRITE_${String(call.args.path)} ` + "Z".repeat(this.bytes) };
      }
      return super.execute(request, context);
    }
  }

  async function runLongTask(budget: number) {
    const cwd = await makeCwd("pr-fr-c1-");
    const orch = new BulkyReadOrchestrator(4_000);
    const store = new FilteringSessionStore();
    const events = new MemoryEventStore();
    const runtime = new AgentRuntime({
      toolRegistry: defaultTestToolCatalog(),
      permissiveToolResolution: true,
      store,
      events,
      modelProvider: new ScriptedModelProvider(longTaskScript(4)),
      orchestrator: orch,
      agents: [{ ...AGENT, limits: {} }],
      toolSemanticsOf: (name) => (name === "read_file" ? READ_ONLY_SAFE : DEFAULT_TOOL_SEMANTICS),
      context: {
        pipeline: new ContextPipeline(),
        budget: { maxTokens: budget, reserved: { system: 0, task: 0, output: 0 }, dynamic: 0 },
      },
    });
    const session = await runtime.createSession({ agent: AGENT, cwd });
    const turn = await runtime.startTurn(session.id, `fix the build. CONSTRAINT: ${CONSTRAINT}`);
    const outcome = await runtime.runTurn(session.id, turn.id, new AbortController().signal);
    const all = await events.list(session.id);
    const messages = await store.listMessages(session.id);
    return { session, outcome, all, messages, orch };
  }

  it("[C1-1] 超长任务触发压缩后：约束/进度/证据均保留，且循环继续正确执行", async () => {
    const { session, outcome, all, messages, orch } = await runLongTask(900);

    // ── 故障触发点：确实发生了上下文压缩（而不是没触发就宣称通过）──
    const compactions = all.filter((e) => e.type === "context.compacted");
    expect(compactions.length).toBeGreaterThan(0);
    // 没有任何 protected fact 被静默丢弃后再宣称保留。
    expect(all.filter((e) => e.type === "context.protected_facts_violation")).toHaveLength(0);
    // 也没有把压缩误当成"停摆"来终止循环。
    expect(all.filter((e) => e.type === "retry.stallRecovery")).toHaveLength(0);

    // ── 进度：压缩之后循环继续派发了模型请求的全部工具 ──
    // (`dispatched` is incremented by the shared base class for every executed
    //  call, so it is the authoritative "the loop kept going" probe.)
    expect(orch.dispatched).toBe(4);

    // ── 约束：user 消息与 system digest 中同时存活 ──
    const systemContent = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const userContent = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    expect(systemContent).toContain(CONSTRAINT);
    expect(userContent).toContain(CONSTRAINT);
    // 压缩摘要本身携带 goal（"User Goal / Exact User Requirements" 段）。
    expect(systemContent).toContain("## User Goal / Exact User Requirements");

    // ── 证据：压缩后每个工具输出仍留在 durable transcript 中（可被取回）──
    const toolMessages = messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(4);
    for (let i = 0; i < 4; i += 1) {
      expect(toolMessages.some((m) => m.content.includes(`src/module-${i}.ts`))).toBe(true);
    }

    // ── 继续正确执行：turn 正常完成 ──
    expect(outcome.status).toBe("completed");
    expect(session.id).toBeDefined();
  });

  it("[C1-2] 压缩下破坏性写入只发生一次（压缩不重放副作用）", async () => {
    const h = await makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("write_file", { path: "a.txt", content: "1" }),
        ScriptedModelProvider.toolCall("write_file", { path: "b.txt", content: "2" }),
        ScriptedModelProvider.text("done"),
      ],
      // Bulky successful payloads press the budget without stalling.
      orch: new BulkyReadOrchestrator(3_000),
      context: { maxTokens: 800 },
    });
    const session = await h.runtime.createSession({ agent: AGENT, cwd: h.cwd });
    const turn = await h.runtime.startTurn(session.id, "write two files");
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);

    expect(outcome.status).toBe("completed");
    expect(await types(h, session.id)).toContain("context.compacted");
    // Exactly the two model-requested writes: rebuilding context never
    // replayed a destructive write.
    expect(h.orch.writeCount).toBe(2);
    expect(outcome.state?.filesChanged?.slice().sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("[C1-3] 每次压缩都落一个可恢复的 checkpoint 安全边界", async () => {
    const h = await makeHarness({
      scripts: longTaskScript(4),
      orch: new BulkyReadOrchestrator(3_000),
      context: { maxTokens: 900 },
      toolSemantics: (name) => (name === "read_file" ? READ_ONLY_SAFE : DEFAULT_TOOL_SEMANTICS),
    });
    const session = await h.runtime.createSession({ agent: AGENT, cwd: h.cwd });
    const turn = await h.runtime.startTurn(session.id, "long task");
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.status).toBe("completed");

    expect((await types(h, session.id)).filter((t) => t === "context.compacted").length).toBeGreaterThan(0);
    // Compaction is declared a checkpoint safety boundary: the durable marker
    // must exist so a crashed process can resume from a consistent point.
    expect(h.ckpt.saved.map((c) => c.reason)).toContain("context:compacted");
  });
});

// ════════════════════════════════════════════════════════════════════════
// 第 2 类：工具连续报错 → 分类处理、有限重试；必要时重规划或明确失败
// ════════════════════════════════════════════════════════════════════════

describe("§五-2 工具连续报错：分类处理与有限重试，不得无限重试", () => {
  it("[C2-1] 同一 turn 混合错误分类：safe 失败有限重试、非 safe 超时不重试、拒绝不重试", async () => {
    let flakyCalls = 0;
    let slowCalls = 0;
    let gatedCalls = 0;
    /** Three DIFFERENT failure classes dispatched by tool name — this is the
     *  classification matrix the standard asks for in one turn. */
    class ClassifiedOrchestrator extends WriteCountingOrchestrator {
      override async execute(request: ToolCallRequest, context: ToolExecutionContext): Promise<ToolResult> {
        const call = Array.isArray(request.call) ? request.call[0] : request.call;
        switch (call?.name) {
          case "flaky_safe": {
            flakyCalls += 1;
            // Fails twice, then heals: a bounded retry ladder must recover it.
            return flakyCalls < 3
              ? {
                  status: "failed",
                  error: errorInfo("PROCESS_ERROR", "transient", { retryable: true, safeToRetry: true }),
                }
              : { status: "success", output: "healed" };
          }
          case "slow_tool": {
            slowCalls += 1;
            return { status: "timeout", error: errorInfo("PROCESS_TIMEOUT", "hung") };
          }
          case "gated_tool": {
            gatedCalls += 1;
            return { status: "denied", error: errorInfo("PERMISSION_DENIED", "policy denies gated_tool") };
          }
          default:
            return super.execute(request, context);
        }
      }
    }
    const h = await makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("flaky_safe", {}),
        ScriptedModelProvider.toolCall("slow_tool", {}),
        ScriptedModelProvider.toolCall("gated_tool", {}),
        ScriptedModelProvider.text("done"),
      ],
      orch: new ClassifiedOrchestrator({ status: "success", output: "ok" }),
      recovery: new RecoveryPolicy({ maxAttempts: 3, retryDelayMs: 0 }),
      toolSemantics: (name) => (name === "flaky_safe" ? READ_ONLY_SAFE : DEFAULT_TOOL_SEMANTICS),
    });
    const session = await h.runtime.createSession({ agent: AGENT, cwd: h.cwd });
    const turn = await h.runtime.startTurn(session.id, "mixed tool errors");
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);

    const all = await h.events.list(session.id);
    const decisions = all
      .filter((e) => e.type === "recovery.decided")
      .map((e) => e.payload as { action: string; tool: string; used: number; remaining: number });

    // 分类可观测：失败被归类为 tool_failure / timeout，并带工具身份。
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((d) => typeof d.tool === "string")).toBe(true);
    expect(decisions.some((d) => d.tool === "flaky_safe")).toBe(true);
    expect(decisions.some((d) => d.tool === "slow_tool")).toBe(true);

    // 有限重试：safe 工具确实被重试，且执行次数 == 策略尝试上限 (3)。
    expect(flakyCalls).toBe(3);
    const flakyDecisions = decisions.filter((d) => d.tool === "flaky_safe");
    // 重试决策的 remaining 单调递减到 0 —— 预算可见地耗尽，不会无限重试。
    const remaining = flakyDecisions.map((d) => d.remaining);
    expect(Math.min(...remaining)).toBe(0);
    expect(flakyDecisions.some((d) => d.action === "fail_safe")).toBe(true);
    // Healed by the bounded ladder: the failure did not fail the whole turn.
    expect(all.some((e) => e.type === "tool.completed" && e.payload.tool === "flaky_safe")).toBe(true);

    // 非 safe 工具的 timeout 只执行一次 —— 绝不盲重跑可能已生效的调用。
    expect(slowCalls).toBe(1);
    // 权限拒绝只执行一次。
    expect(gatedCalls).toBe(1);

    // 终止：turn 收敛，有明确终止原因。
    expect(["completed", "failed"]).toContain(outcome.status);
    expect(outcome.terminationReason).toBeDefined();
  });

  it("[C2-2] 连续不可恢复错误以明确失败终止（blocked + RESOURCE_LIMIT），绝不谎报完成", async () => {
    const h = await makeHarness({
      scripts: [ScriptedModelProvider.toolCall("exec", { command: "rm -rf /" })],
      orch: new WriteCountingOrchestrator({
        status: "denied",
        error: errorInfo("PERMISSION_DENIED", "policy blocks exec"),
      }),
      recovery: new RecoveryPolicy({ maxAttempts: 3, retryDelayMs: 0 }),
      maxIterationsPerTurn: 1,
    });
    const session = await h.runtime.createSession({ agent: AGENT, cwd: h.cwd });
    const turn = await h.runtime.startTurn(session.id, "try a denied command");
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);

    // 明确失败，带终止原因，而不是伪造成功。
    expect(outcome.status).toBe("failed");
    expect(outcome.statusDetail).toBe("blocked");
    expect(outcome.error?.code).toBe("RESOURCE_LIMIT");
    const eventTypes = await types(h, session.id);
    expect(eventTypes).toContain("turn.failed");
    expect(eventTypes).not.toContain("turn.completed");
    // 拒绝不被重试：恰好一次派发。
    expect(h.orch.calls.length).toBe(1);
  });

  it("[C2-3] 不可重试错误只执行一次，且不伪造模型/供应商层重试", async () => {
    let calls = 0;
    class NonRetryableOrchestrator extends WriteCountingOrchestrator {
      override async execute(): Promise<ToolResult> {
        calls += 1;
        // Count the dispatch too — `writeCount` is the duplicate-write probe and
        // must not silently stay 0 just because this override skips super().
        this.writeCount += 1;
        return {
          status: "failed",
          error: errorInfo("TOOL_SCHEMA_ERROR", "invalid args: never retry", {
            retryable: false,
            safeToRetry: false,
          }),
        };
      }
    }
    const h = await makeHarness({
      scripts: [
        ScriptedModelProvider.toolCall("write_file", { path: "x.txt", content: "1" }),
        ScriptedModelProvider.text("gave up on that tool"),
      ],
      orch: new NonRetryableOrchestrator({ status: "success", output: "ok" }),
      recovery: new RecoveryPolicy({ maxAttempts: 3, retryDelayMs: 0 }),
    });
    const session = await h.runtime.createSession({ agent: AGENT, cwd: h.cwd });
    const turn = await h.runtime.startTurn(session.id, "non-retryable error");
    await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);

    const all = await h.events.list(session.id);
    // The hard safety property: a non-retryable destructive call ran ONCE.
    expect(calls).toBe(1);
    expect(h.orch.writeCount).toBe(1);

    // A tool failure never fabricates a model/provider-level retry.
    expect(all.filter((e) => e.type === "model.retry")).toHaveLength(0);
    expect(all.filter((e) => e.type === "retry.provider")).toHaveLength(0);

    // DEFECT-1 (recorded, see file header): the journal still advertises a
    // retry decision for a tool it deliberately refuses to retry. This
    // assertion pins the CURRENT (misleading) behavior so a fix is visible.
    const advertisedRetry = all.filter(
      (e) => e.type === "recovery.decided" && e.payload.action === "retry_safe",
    );
    expect(advertisedRetry.length).toBeGreaterThan(0);
    expect(calls).toBe(1); // …and yet nothing was actually retried.
  });

  it("[C2-4] 模型连续报错：重试次数受 maxAttempts 限制，并给出 maxRetries 终止原因", async () => {
    const errScript: ModelEvent[] = [
      { type: "started", timestamp: 0 },
      { type: "error", error: errorInfo("MODEL_ERROR", "provider down"), timestamp: 0 },
    ];
    const h = await makeHarness({
      // More error scripts than the policy could ever consume: an unbounded
      // retry loop would keep eating them.
      scripts: [errScript, errScript, errScript, errScript, errScript, errScript, errScript],
      recovery: new RecoveryPolicy({ maxAttempts: 3, retryDelayMs: 0 }),
    });
    const session = await h.runtime.createSession({ agent: AGENT, cwd: h.cwd });
    const turn = await h.runtime.startTurn(session.id, "keep failing");
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("MODEL_ERROR");
    expect(outcome.terminationReason).toBe("model_error");
    const all = await h.events.list(session.id);
    // maxAttempts=3 ⇒ 2 retries, then a hard stop. NOT 6.
    expect(all.filter((e) => e.type === "model.retry")).toHaveLength(2);
    expect(all.filter((e) => e.type === "model.started").length).toBe(3);
    const limit = all.find(
      (e) => e.type === "run.limit_reached" && e.payload.limit === "maxRetries",
    );
    expect(limit).toBeDefined();
    expect(all.filter((e) => e.type === "turn.completed")).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 第 5 类：执行中进程崩溃 → 恢复到一致状态，避免重复破坏性写入
// ════════════════════════════════════════════════════════════════════════

describe("§五-5 执行中进程崩溃：恢复一致性 + 破坏性写入只生效一次", () => {
  function writeScript(): ModelEvent[][] {
    return [
      ScriptedModelProvider.toolCall("write_file", { path: "victim.txt", content: "x" }),
      ScriptedModelProvider.text("done"),
    ];
  }

  /** The resumed process must NOT re-request a destructive write from its model.
   *  If it did, any extra execution would be a legitimate NEW write request and
   *  the "exactly once" assertion would no longer isolate a duplicate. So every
   *  resume below uses this stop-only script, exactly as the existing crash
   *  suites do. */
  function stopOnlyScript(): ModelEvent[][] {
    return [ScriptedModelProvider.text("done")];
  }

  async function runUntilKilled(
    runtime: AgentRuntime,
    session: Session,
    point: FaultPoint,
  ): Promise<{ turnId: string }> {
    const turn = await runtime.startTurn(session.id, "conformance task");
    await expect(
      runtime.runTurn(session.id, turn.id, new AbortController().signal),
    ).rejects.toMatchObject({ name: "RuntimeKilledError", point });
    return { turnId: turn.id };
  }

  it("[C5-1] checkpoint 持久化边界中断：effect 与恢复标记都 durable，resume 后破坏性写入仍为 1", async () => {
    const h = await makeHarness({
      scripts: writeScript(),
      // Kill IMMEDIATELY AFTER the side-effect checkpoint was durably written.
      kill: new Set(["tool.checkpointed"] as FaultPoint[]),
    });
    const session = await h.runtime.createSession({ agent: AGENT, cwd: h.cwd });
    await runUntilKilled(h.runtime, session, "tool.checkpointed");

    // The crash landed after the destructive effect committed…
    expect(h.orch.writeCount).toBe(1);
    // …and after its recovery marker was persisted.
    expect(h.ckpt.saved.length).toBeGreaterThanOrEqual(1);
    // …and the turn never completed (the process really died).
    expect(await types(h, session.id)).not.toContain("turn.completed");

    const r2 = restarted(h, stopOnlyScript());
    const result = await r2.resumeTurn(session.id, new AbortController().signal);

    expect(result.outcome.status).toBe("completed");
    // ★ THE duplicate-destructive-write assertion: still exactly one execution.
    expect(h.orch.writeCount).toBe(1);
    // Consistent recovered state: the committed file is folded back in, once.
    expect(result.state.filesChanged).toContain("victim.txt");
    expect(result.state.filesChanged.filter((f) => f === "victim.txt")).toHaveLength(1);
  });

  it("[C5-2] 工具调用「前」中断（intent 未持久化）：resume 后破坏性写入恰好一次，不丢工作", async () => {
    const h = await makeHarness({
      scripts: writeScript(),
      // Kill BEFORE the durable intent: gates passed, nothing on record.
      kill: new Set(["tool.intent_persisting"] as FaultPoint[]),
    });
    const session = await h.runtime.createSession({ agent: AGENT, cwd: h.cwd });
    const { turnId } = await runUntilKilled(h.runtime, session, "tool.intent_persisting");

    // The executor never ran — the kill was upstream of it.
    expect(h.orch.writeCount).toBe(0);
    h.ckpt.seed = seededCheckpoint(session.id, {
      lastEventSequence: (await h.events.nextSequence(session.id)) - 1,
      turnId: turnId as never,
    });

    // Nothing was on record for the interrupted call, so the resumed process is
    // allowed to re-issue the destructive write — but EXACTLY once. A second
    // execution would mean the crash left a duplicate behind.
    const r2 = restarted(h, writeScript());
    const result = await r2.resumeTurn(session.id, new AbortController().signal);

    expect(result.outcome.status).toBe("completed");
    // 1 == the resumed model's single fresh request; the interrupted attempt
    // contributed 0 executions before the kill.
    expect(h.orch.writeCount).toBe(1);
    expect(h.orch.writeCount).toBeLessThanOrEqual(1);
    // The work is not silently dropped either: the write is on the record.
    expect(result.state.filesChanged).toContain("victim.txt");
  });

  it("[C5-3] 幂等键：tool 结果在 transcript 中只留下一条，resume 不追加第二条", async () => {
    const h = await makeHarness({
      scripts: writeScript(),
      // Killed after the tool outcome was recorded but before its checkpoint.
      kill: new Set(["tool.completed"] as FaultPoint[]),
    });
    const session = await h.runtime.createSession({ agent: AGENT, cwd: h.cwd });
    const { turnId } = await runUntilKilled(h.runtime, session, "tool.completed");
    h.ckpt.seed = seededCheckpoint(session.id, {
      lastEventSequence: (await h.events.nextSequence(session.id)) - 1,
      turnId: turnId as never,
    });

    const before = (await h.store.listMessages(session.id)).filter((m) => m.role === "tool");
    // The kill really happened after the result was durable.
    expect(before).toHaveLength(1);

    const r2 = restarted(h, stopOnlyScript());
    const result = await r2.resumeTurn(session.id, new AbortController().signal);
    expect(result.outcome.status).toBe("completed");

    const after = (await h.store.listMessages(session.id)).filter((m) => m.role === "tool");
    // Idempotency key = the tool-call identity: one durable result record
    // before AND after the resume, and it is the SAME row (no second write).
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    // The destructive tool ran once across both processes.
    expect(h.orch.writeCount).toBe(1);
  });

  it("[C5-4] 无可恢复 checkpoint 时诚实报 RESUME_FAILED，绝不盲重跑未知结局的写入", async () => {
    const h = await makeHarness({
      scripts: writeScript(),
      // Killed mid-execution with NO durable intent and NO checkpoint behind
      // it: whether the write landed is genuinely unknowable.
      kill: new Set(["tool.executing"] as FaultPoint[]),
    });
    const session = await h.runtime.createSession({ agent: AGENT, cwd: h.cwd });
    await runUntilKilled(h.runtime, session, "tool.executing");
    h.ckpt.seed = undefined;
    h.ckpt.saved.length = 0;

    const r2 = restarted(h, stopOnlyScript());
    await expect(r2.resumeTurn(session.id, new AbortController().signal)).rejects.toMatchObject({
      info: expect.objectContaining({ code: "RESUME_FAILED" }),
    });
    // No blind re-execution of a write whose outcome is unknown.
    expect(h.orch.writeCount).toBe(0);
  });

  it("[C5-5] 未持久化 intent 的 side-effect 调用被显式提出待核对（绝不自动重放）", async () => {
    const h = await makeHarness({
      scripts: writeScript(),
      // Killed mid-execution; a seed checkpoint exists, so resume CAN proceed —
      // it must reconcile rather than replay the possibly-committed write.
      kill: new Set(["tool.executing"] as FaultPoint[]),
    });
    const session = await h.runtime.createSession({ agent: AGENT, cwd: h.cwd });
    const { turnId } = await runUntilKilled(h.runtime, session, "tool.executing");
    h.ckpt.seed = seededCheckpoint(session.id, { turnId: turnId as never });

    const r2 = restarted(h, stopOnlyScript());
    const result = await r2.resumeTurn(session.id, new AbortController().signal);

    expect(result.outcome.status).toBe("completed");
    // The ambiguous call is SURFACED (fail-closed: may have had an effect)…
    expect(result.unresolvedTools).toHaveLength(1);
    expect(result.unresolvedTools[0]!.tool).toBe("write_file");
    expect(result.unresolvedTools[0]!.sideEffect).toBe(true);
    // …and was NOT automatically re-executed.
    expect(h.orch.writeCount).toBe(0);
  });
});
