# Harness Agent v5 — P38.1 Release Integrity & Followup Hotfix Closure Plan

> 目标：**不要开始 P39，不要新增大机制，不要继续堆抽象层。**  
> 本阶段只修复 P38 验收中暴露出来的真实 correctness / liveness / release-integrity 缺口，直到 exact HEAD 在 Linux、Windows、Coverage、Release Attestation 上同时成立，并且不存在“测试假绿 / evidence 假绿 / followup 重复执行 / SDK 已取消仍启动”等语义漏洞。

---

## 0. 阶段定位

P38.1 不是新功能阶段，而是 **P38 Release Candidate Hotfix / Closure**。

如果 P38 的目标是“关闭 architecture closure 阶段”，那么 P38.1 的唯一职责就是：

1. 把 P38 中已经发现、但尚未被真正证明关闭的缺陷全部修完；
2. 让 release evidence 本身具备可信度；
3. exact HEAD 的 Linux / Windows / Coverage / Release Attestation 同时全绿；
4. 完成后**停止 architecture hotfix loop**，正式进入 benchmark-driven challenger 阶段。

### 允许做的事

- 修 correctness / liveness / durability / evidence / CI bug；
- 补 deterministic regression；
- 修 release verifier；
- 修 evidence schema / semantics；
- 重分类 perf / soak test；
- 补最小必要文档与 release truth contract。

### 禁止做的事

- 新增 agent 大机制；
- 新增 planner / reasoner / memory 大架构；
- 重写整个 runtime；
- 新增与本阶段无关的 benchmark 机制；
- 为了“看起来更强”同时修改多个行为变量；
- 把失败标记为 known noise 后继续宣布 READY。

### 成功标准

只有满足以下条件才能写 `READY`：

```text
exact HEAD
  + Linux PASS
  + Windows PASS
  + Coverage PASS
  + Required Gates PASS
  + Evidence consistency PASS
  + Command provenance PASS
  + Release Attestation READY
  + failed = 0
  + blocked = 0
  + not_run = 0
  + stale = 0
```

---

# 1. Baseline Truth Capture — 执行前必须重新采样

本计划写作时审查基线为：

```text
728f23a451754c9ad03346be89490bf7f9cb70ce
```

但 Agent 开始执行本计划时，**必须重新读取 exact HEAD**。
不要把这个 SHA 当成执行时真相。

## 做什么

- 记录 exact HEAD；
- 记录 working tree；
- 记录 Node / pnpm；
- 记录 Linux / Windows / Coverage / Release Attestation 当前状态；
- 记录本地 required gates 当前真实结果；
- 写入 `.ci/p38-1-baseline.json`。

## 怎么做

```bash
git rev-parse HEAD
git status --short
git log -1 --oneline
node --version
pnpm --version
```

执行 baseline gates：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:coverage
pnpm docs:verify
```

如果已经存在以下 scripts，也一并执行：

```bash
pnpm test:protocol
pnpm test:security
pnpm test:race
pnpm test:chaos
pnpm benchmark:smoke
pnpm capability:audit
pnpm release:verify
```

## 怎么验收

- [ ] `.ci/p38-1-baseline.json` 记录 exact HEAD；
- [ ] 记录 working tree 是否 clean；
- [ ] 每个 baseline gate 有真实 command；
- [ ] 每个 baseline gate 有真实 exitCode；
- [ ] 不存在“命令失败但 artifact 写 exitCode=0”；
- [ ] 不把任何红项写成 known noise。

---

# 2. 当前 Blocking Findings

## P0-1 — Followup hydration duplication

路径：

```text
enqueueFollowup(A)
  ↓
local queue += A
  +
durable inbox += A

第一次 reservePendingFollowup()
  ↓
hydrate()
  ↓
又从 durable inbox 读到 A
  ↓
local queue += A
```

结果：同一 prompt 可能 promotion 两次。

## P0-2 — Followup resolver liveness

promotion 失败时 durable input 会 release/requeue，但 caller `handle.outcome` 可能永久 pending。

## P0-3 — Followup durable ack / cancellation ordering

存在：

```text
turn created
  ↓
markConsumed(prompt) await
  ↓
cancel/interrupt
  ↓
reservation invalid
```

的灰区，可能出现 consumed prompt 没有真正 running owner。

## P0-4 — starting existing-turn cancellation late promotion

`cancelTurn(turnId)` 如果只 abort controller、不 revoke reservation，后续仍可能 late promote。

## P0-5 — SDK pre-abort still invokes turn/run

pre-aborted signal 已让 Hub settle interrupted，但 `runStreamed()` 仍可能无条件 invoke `turn/run`。

## P0-6 — CI evidence false-green

失败分支存在写出：

```json
{"passed": false, "exitCode": 0}
```

的可能，而 release verifier 若主要按 exitCode 解释，会错误 PASS。

## P0-7 — capability_audit provenance 不真实

`capability_audit` 必须来自真实：

```bash
pnpm capability:audit
```

不能由其它 audit command + 人工 PASS artifact 代替。

## P0-8 — strict audit 没有硬绑定 evidenceFresh

`audit --strict` 必须在 required execution evidence stale / missing 时退出 1。

## P1-1 — canonical realpath injection seam 只接通一半

ancestor walker 必须使用 injected `rp(current)`，不能偷偷回到 `realpathSync(current)`。

## P1-2 — regression 假绿

存在 tautology / disconnected counter，例如：

```ts
expect(x === undefined || x !== undefined).toBe(true);
```

这种测试不能证明 invariant。

## P1-3 — race tests 仍有 wall-clock ordering sleep

Actor / Manager correctness test 应使用 barrier / deferred，不应依赖 10ms / 20ms。

## P1-4 — heavy perf/soak 塞进普通 pnpm test

Windows 上 20k/50k append/fsync 型测试会拖垮 correctness CI。

---

# 3. Mandatory Invariants

- **INV-P38.1-001** — 一个 durable followup prompt 在一次 actor lifecycle 中最多被 promotion 一次；hydrate 不得制造 duplicate local entry。
- **INV-P38.1-002** — Followup promotion 失败时：durable input 可恢复，调用者 Promise 必须 terminal settle。
- **INV-P38.1-003** — 任何被 markConsumed 的 followup 必须绑定到一个可恢复的 promoted turn。
- **INV-P38.1-004** — starting reservation 一旦被 interrupt/cancel/close revoke，永远不能再次 promoteToRunning。
- **INV-P38.1-005** — cancelTurn(turnId) 对 starting existing-turn 必须等价于 abort + reservation invalidation。
- **INV-P38.1-006** — SDK 收到 pre-aborted AbortSignal 时 `turn/run` 调用次数必须为 0。
- **INV-P38.1-007** — SDK 本地 terminal 状态不得和 server-side lifecycle 矛盾。
- **INV-P38.1-008** — gate evidence 的 `passed` 和 `exitCode` 必须一致；矛盾 evidence 必须 INVALID/BLOCKED。
- **INV-P38.1-009** — 每个 required gate evidence 必须证明执行了它声明的 canonical command。
- **INV-P38.1-010** — capability_audit 只能由 `pnpm capability:audit` 证明。
- **INV-P38.1-011** — `audit --strict` 必须失败于 stale / missing required execution evidence。
- **INV-P38.1-012** — injected realpath adapter 必须贯穿 full path + ancestor walk。
- **INV-P38.1-013** — P38/P38.1 concurrency regressions 不允许靠 wall-clock sleep 证明 ordering。
- **INV-P38.1-014** — regression 必须能在对应旧错误实现上失败。
- **INV-P38.1-015** — `pnpm test` 是 correctness gate，不应被大型 soak workload 主导。
- **INV-P38.1-016** — official release attestation 必须绑定 exact HEAD。
- **INV-P38.1-017** — failed=0、blocked=0、not_run=0、inconsistent=0、stale=0、command_mismatch=0。
- **INV-P38.1-018** — P38.1 完成后停止 architecture closure loop，进入 benchmark-driven challenger。

---

# 4. Delivery Map

严格按顺序执行：

```text
P38.1-0   Baseline truth capture
P38.1-1   Followup hydration deduplication
P38.1-2   Followup resolver terminal semantics
P38.1-3   Followup durable promotion / cancellation closure
P38.1-4   Starting reservation cancellation hardening
P38.1-5   SDK pre-abort no-run closure
P38.1-6   Gate evidence schema + parser truthfulness
P38.1-7   Canonical gate command provenance
P38.1-8   Strict capability audit freshness closure
P38.1-9   Canonical path deterministic seam closure
P38.1-10  Regression quality / race determinism cleanup
P38.1-11  Perf / soak gate reclassification
P38.1-12  Exact-HEAD CI attestation / zero-red RC gate
P38.1-13  Final comprehensive audit + release truth
```

---

# P38.1-0 — Baseline Truth Capture

## 做什么

- [ ] 冻结 exact HEAD；
- [ ] 收集当前 CI 状态；
- [ ] 收集本地 gate 状态；
- [ ] 保存 baseline evidence；
- [ ] 对当前红项分类，但不得 exempt。

## 怎么做

建议 evidence 结构：

```ts
interface BaselineGateResult {
  command: string;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
}

interface P381Baseline {
  headSha: string;
  workingTreeClean: boolean;
  nodeVersion: string;
  pnpmVersion: string;
  gates: Record<string, BaselineGateResult>;
}
```

## 怎么验收

- [ ] exact HEAD 写入 baseline；
- [ ] 所有命令真实执行；
- [ ] 不伪造 PASS；
- [ ] 后续每个 phase 都以此 baseline 做 attribution。

---

# P38.1-1 — Followup Hydration Deduplication

## 目标

关闭：

```text
enqueue durable + local
  ↓
first hydrate
  ↓
durable same prompt loaded again
```

导致 duplicate promotion 的 P0 correctness bug。

## 重点文件

```text
packages/core/src/runtime/session-actor.ts
packages/core/src/runtime/session-actor.test.ts
```

必要时涉及 InboxStore 测试 fixture。

## 做什么

- [ ] local followup 保留 durable identity `promptId`；
- [ ] hydrate 时跳过 local queue 已存在的 promptId；
- [ ] hydrate 时跳过 reserved slot 已存在的 promptId；
- [ ] dedup 只能按 prompt identity，不得按 text；
- [ ] restart 后仍能加载真正未出现过的 durable pending prompt。

## 怎么做

推荐：

```ts
type LocalFollowup = {
  id: string;
  input: UserMessage;
  promptId?: PromptId;
};

private collectKnownPromptIds(): Set<PromptId> {
  const ids = new Set<PromptId>();

  for (const f of this.followups) {
    if (f.promptId !== undefined) {
      ids.add(f.promptId);
    }
  }

  if (this.reserved?.promptId !== undefined) {
    ids.add(this.reserved.promptId);
  }

  return ids;
}
```

hydrate：

```ts
private async hydrate(): Promise<void> {
  const inbox = this.deps.inbox;
  if (inbox === undefined) return;

  const pending = await inbox.listPending(this.sessionId);
  const known = this.collectKnownPromptIds();

  for (const p of pending) {
    if (p.kind !== "followup") continue;
    if (known.has(p.id)) continue;

    this.followups.push({
      id: `durable-${p.id}`,
      input: {
        sessionId: this.sessionId,
        text: p.text,
      },
      promptId: p.id,
    });

    known.add(p.id);
  }
}
```

## 必须先写的 regression

### Test A — enqueue before first hydration

```text
hydrated=false
enqueueFollowup(A)
reservePendingFollowup()
```

验收：

```text
A only once
runtime.startTurn count == 1
```

### Test B — same text, different promptId

两条内容完全相同：

```text
A1: text="retry"
A2: text="retry"
```

但 promptId 不同。

验收：两条都保留。

### Test C — restart hydration

```text
local empty
inbox pending A
```

hydrate 后 A 正常进入 local queue。

### Test D — reserved + hydrate

reserved prompt 不得重复回 followups。

## 怎么验收

```bash
pnpm vitest packages/core/src/runtime/session-actor.test.ts
pnpm typecheck
```

- [ ] regression 在旧实现上可失败；
- [ ] 新实现 PASS；
- [ ] 同 prompt 最多 promotion 一次。

---

# P38.1-2 — Followup Resolver Terminal Semantics

## 目标

关闭：

```text
promotion failure
  ↓
durable requeue
  ↓
caller outcome forever pending
```

## 做什么

- [ ] `Map<followupId, resolve>` 改为完整 Deferred；
- [ ] 每个 deferred 必须 exactly-once settle；
- [ ] promotion failure 要 terminal settle 当前 caller；
- [ ] actor close/unload 要 settle 未完成 followup caller；
- [ ] resolver map terminal 后必须清理。

## 推荐实现

```ts
interface FollowupDeferred {
  settled: boolean;
  resolve: (value: TurnOutcome) => void;
  reject: (reason: unknown) => void;
}

private readonly followupDeferred =
  new Map<string, FollowupDeferred>();
```

helper：

```ts
private rejectFollowup(
  id: string,
  err: unknown,
): void {
  const deferred = this.followupDeferred.get(id);
  if (deferred === undefined || deferred.settled) return;

  deferred.settled = true;
  deferred.reject(err);
  this.followupDeferred.delete(id);
}
```

建议错误码：

```text
FOLLOWUP_PROMOTION_FAILED
```

## promotion failure 语义

```text
reserve followup
  ↓
runtime.startTurn throws
  ↓
releasePromotion(id)
  ↓
reject caller outcome
  ↓
clear resolver
```

durable input 可以保留等待未来 retry，但**本次调用者不能永远挂住**。

## 必须先写的 regression

- [ ] runtime.startTurn throws → durable pending/requeued；
- [ ] 同一路径 `handle.outcome` 必须 reject；
- [ ] test 使用明确 watchdog 证明不是永久 pending；
- [ ] actor close 时 queued followup outcome settle；
- [ ] exactly-once：同一个 deferred 不能 resolve 后又 reject。

## 验收

```bash
pnpm vitest packages/core/src/runtime/session-actor.test.ts
pnpm typecheck
```

---

# P38.1-3 — Followup Durable Promotion / Cancellation Closure

## 目标

不允许出现：

```text
prompt.status = consumed
BUT
no recoverable promoted turn owner
```

## 原因

当前危险窗口：

```text
runtime.startTurn()
  ↓
turn record created
  ↓
await completePromotion()
  ↓
markConsumed()

         interrupt/cancel
         ↓
         revoke reservation

markConsumed completes
  ↓
promoteToRunning rejected
```

## 做什么

需要明确一种 durable promotion contract。

### 推荐方案 A

如果 schema 易扩：

```text
pending
  ↓
promoting(turnId)
  ↓
running/committed
  ↓
consumed
```

Inbox record 加：

```ts
status: "pending" | "promoting" | "consumed";
promotedTurnId?: TurnId;
```

### 最小方案 B

如果不扩 schema：

- turn durable record 建立后；
- 必须确认 current reservation 仍 valid；
- durable consumed ack 后如果发生 crash/cancel，recovery 必须能根据 prompt ↔ turn 关系恢复；
- 不允许 consumed record 完全失去 owner identity。

## 核心状态机

```text
pending
  └─ reserve
      ↓
promoting(promptId, turnId, requestId)
      ├─ request still valid
      │      ↓
      │   running
      │      ↓
      │   consumed
      │
      └─ cancellation / failure
             ↓
           pending
```

## 必须写的 deterministic regression

### Test A — cancel between create and durable ack

人为 gate：

```text
startTurn created
completePromotion blocked
interrupt
release ack gate
```

验收：

- [ ] 不出现 consumed-without-owner；
- [ ] caller terminal settle；
- [ ] durable prompt 可恢复。

### Test B — completePromotion throws

验收：

- [ ] prompt 没丢；
- [ ] active owner 没伪造；
- [ ] resolver settle；
- [ ] no double promotion。

### Test C — crash/reload

如果 prompt 已进入 promoting / consumed：

- [ ] 能证明对应 turnId；
- [ ] 不会把它当全新 followup 再执行第二次。

## 验收

```bash
pnpm vitest packages/core/src/runtime/session-actor.test.ts
pnpm test:race
pnpm typecheck
```

---

# P38.1-4 — Starting Reservation Cancellation Hardening

## 目标

所有：

```text
interrupt
cancelTurn
close
```

都必须真正 revoke `starting` ownership。

## 做什么

- [ ] cancelTurn(starting existing turn) = abort + revoke；
- [ ] interrupt(starting) = abort + revoke；
- [ ] close(starting) = abort + revoke；
- [ ] promotion 前再次检查 requestId；
- [ ] promotion 前再次检查 `controller.signal.aborted`。

## 推荐 helper

```ts
private revokeStarting(
  expectedRequestId?: number,
): void {
  if (this.state.kind !== "starting") return;

  if (
    expectedRequestId !== undefined &&
    this.state.requestId !== expectedRequestId
  ) {
    return;
  }

  this.state.controller.abort();

  if (this.closed) {
    this.state = { kind: "closing" };
  } else {
    this.state = { kind: "idle" };
  }
}
```

实际 state name 按现有类型适配，不要为抄这个 helper 破坏现有 state machine。

## Promotion guard

```ts
if (
  this.state.kind !== "starting" ||
  this.state.requestId !== requestId ||
  controller.signal.aborted
) {
  throw new AgentError(
    errorInfo(
      "TURN_START_CANCELLED",
      "starting reservation was revoked before promotion",
    ),
  );
}
```

## 必须写的 race tests

### Test A — runTurn(existing) + cancelTurn

```text
runTurn(existing)
  ↓
blocked before runtime.runTurn

cancelTurn(turnId)
  ↓
release gate
```

验收：

```text
runtime.runTurn call count == 0
activeTurn == undefined
```

### Test B — startTurn + interrupt

- [ ] no late running；
- [ ] no owner overwrite。

### Test C — close during starting

- [ ] no late publication；
- [ ] no active turn after close。

### Test D — 100-way mixed ownership

使用 barrier，不使用 sleep。

## 验收

```bash
pnpm vitest packages/core/src/runtime/session-actor.test.ts
pnpm test:race
pnpm typecheck
```

---

# P38.1-5 — SDK Pre-Abort No-Run Closure

## 目标

当 signal 在进入 `runStreamed()` 前已经 aborted：

```text
turn/run calls == 0
```

## 重点文件

```text
packages/sdk/src/client.ts
packages/sdk/src/client.test.ts
packages/sdk/src/event-stream.test.ts
```

## 做什么

- [ ] Hub 创建后检查 pre-abort；
- [ ] pre-aborted 不再 invoke `turn/run`；
- [ ] mid-run abort 语义保持不变；
- [ ] subscribe-before-run invariant 保持。

## 推荐实现

```ts
const hub = new RunEventHub(
  this.transport,
  this.id,
  turnId,
  opts.signal,
);

if (opts.signal?.aborted === true) {
  return {
    events: hub.events,
    done: hub.done,
  };
}

const runPromise = this.transport.invoke(
  "turn/run",
  {
    threadId: this.id,
    turnId,
  },
);

hub.attachRunPromise(runPromise);

return {
  events: hub.events,
  done: hub.done,
};
```

## 必须补 regression

### already-aborted

记录：

```ts
let turnRunCalls = 0;
let interruptCalls = 0;
```

验收：

```text
turnRunCalls == 0
done.status == interrupted
```

### mid-run abort

验收：

```text
turnRunCalls == 1
interruptCalls >= 1
done.status == interrupted
```

### normal streaming

- [ ] synchronous emission 无丢事件；
- [ ] subscribe-before-invoke 仍成立；
- [ ] listener cleanup 仍为 0 growth。

## 验收

```bash
pnpm vitest packages/sdk/src/client.test.ts
pnpm vitest packages/sdk/src/event-stream.test.ts
pnpm vitest packages/sdk/src/conformance.test.ts
pnpm typecheck
```

---

# P38.1-6 — Gate Evidence Schema + Parser Truthfulness

## 目标

彻底消灭：

```json
{"passed": false, "exitCode": 0}
```

被解释成 PASS。

## Evidence schema

建议：

```ts
interface GateExecutionEvidence {
  schemaVersion: 2;
  gate: GateId;
  command: string;
  headSha: string;

  startedAt: string;
  finishedAt: string;

  exitCode: number | null;
  passed: boolean;

  runner?: {
    os?: string;
    arch?: string;
    node?: string;
    pnpm?: string;
  };

  artifactDigest?: string;
}
```

## 做什么

### 单一 truth

`passed` 必须派生自 exitCode：

```ts
function createGateEvidence(
  exitCode: number | null,
  input: Omit<GateExecutionEvidence, "passed" | "exitCode">,
): GateExecutionEvidence {
  return {
    ...input,
    exitCode,
    passed: exitCode === 0,
  };
}
```

### Parser consistency

```ts
if (record.exitCode === null) {
  return blocked("gate was not executed");
}

if (record.passed !== (record.exitCode === 0)) {
  return blocked(
    "inconsistent gate evidence: passed does not match exitCode",
  );
}
```

## 禁止的 CI 写法

```bash
cmd && echo '{"exitCode":0,"passed":true}' \
    || echo '{"exitCode":0,"passed":false}'
```

## 推荐 CI 写法

```bash
set +e
pnpm test:security
code=$?
set -e

node scripts/write-gate-evidence.mjs \
  --gate security \
  --command "pnpm test:security" \
  --exit-code "$code"

exit "$code"
```

## 必须补 verifier tests

- [ ] `passed=false, exitCode=0` → INVALID/BLOCKED；
- [ ] `passed=true, exitCode=1` → INVALID/BLOCKED；
- [ ] `exitCode=null` → NOT_RUN/BLOCKED；
- [ ] `passed=true, exitCode=0` + exact SHA + command match → PASS；
- [ ] malformed schema → BLOCKED，不 silent fallback。

## 验收

```bash
pnpm vitest apps/cli/src/release-verify.test.ts
pnpm typecheck
```

---

# P38.1-7 — Canonical Gate Command Provenance

## 目标

Release verifier 不仅验证：

```text
有 evidence artifact
```

还必须验证：

```text
artifact 确实来自 canonical command
```

## Canonical commands

推荐集中定义：

```ts
type GateId =
  | "typecheck"
  | "test"
  | "build"
  | "coverage"
  | "docs"
  | "benchmark_smoke"
  | "protocol"
  | "security"
  | "race"
  | "chaos"
  | "capability_audit";

const GATE_COMMANDS: Record<GateId, string> = {
  typecheck: "pnpm typecheck",
  test: "pnpm test",
  build: "pnpm build",
  coverage: "pnpm test:coverage",
  docs: "pnpm docs:verify",
  benchmark_smoke: "pnpm benchmark:smoke",
  protocol: "pnpm test:protocol",
  security: "pnpm test:security",
  race: "pnpm test:race",
  chaos: "pnpm test:chaos",
  capability_audit: "pnpm capability:audit",
};
```

## 做什么

- [ ] release verifier 校验 `record.command === GATE_COMMANDS[id]`；
- [ ] CI 真正运行 `pnpm capability:audit`；
- [ ] 不允许 `agent audit --out` 冒充 capability_audit；
- [ ] 每个 required gate 独立 artifact。

## 必须补测试

### Wrong command

```text
gate=security
command=pnpm test:race
```

验收：BLOCKED。

### capability audit impersonation

```text
gate=capability_audit
command=node apps/cli/dist/main.js audit --out report.json
```

验收：BLOCKED。

### exact canonical command

```text
gate=capability_audit
command=pnpm capability:audit
exitCode=0
headSha=current
```

验收：PASS。

## 验收

```bash
pnpm vitest apps/cli/src/release-verify.test.ts
pnpm capability:audit
pnpm typecheck
```

---

# P38.1-8 — Strict Capability Audit Freshness Closure

## 目标

`audit --strict` 必须对 evidence freshness 负责。

## 正确 strict truth

```ts
const strictOk =
  summary.verdict.documentationClaimsOk &&
  summary.verdict.profileRequirementsOk &&
  summary.verdict.evidenceFresh;
```

不要：

```ts
strictOk = profileRequirementsOk;
```

## 做什么

- [ ] strict 模式加入 evidenceFresh；
- [ ] stale test evidence → exit 1；
- [ ] stale benchmark evidence → exit 1；
- [ ] missing required evidence → exit 1；
- [ ] 非 strict 兼容行为可保留，但 release 一律 strict。

## 必须补测试

- [ ] docs PASS + profile PASS + stale test evidence → exit 1；
- [ ] docs PASS + profile PASS + missing benchmark evidence → exit 1；
- [ ] docs PASS + profile FAIL + evidence fresh → exit 1；
- [ ] 全部 PASS → exit 0。

## 验收

```bash
pnpm vitest apps/cli/src/audit*.test.ts
pnpm capability:audit
pnpm typecheck
```

---

# P38.1-9 — Canonical Path Deterministic Seam Closure

## 目标

`canonicalizePath(..., {realpath: fake})` 必须控制：

```text
full-path realpath
+
ancestor-walk realpath
```

全部调用。

## 生产修复

找到：

```ts
function canonicalAncestorAndTail(
  p: string,
  rp: (p: string) => string = realpathSync,
): string {
```

循环中必须使用：

```ts
const ancestor = normaliseSeparators(
  rp(current),
);
```

不能继续：

```ts
realpathSync(current)
```

## 必须补 taxonomy regression

- [ ] full path EACCES → permission；
- [ ] full path EPERM → permission；
- [ ] full path ELOOP → symlink_loop；
- [ ] full path EIO → io；
- [ ] full path ENOENT → ancestor EACCES → permission；
- [ ] full path ENOENT → ancestor ELOOP → symlink_loop；
- [ ] full path ENOENT → ancestor EIO → io；
- [ ] 64+ 层 ENOENT → depth；
- [ ] fake adapter 调用次数可断言，证明 ancestor 没偷偷走真实 FS。

## 验收

```bash
pnpm vitest packages/security/src/canonical-path.test.ts
pnpm test:security
pnpm typecheck
```

---

# P38.1-10 — Regression Quality / Race Determinism Cleanup

## 目标

删除所有“名字像 regression，但不能证明 invariant”的假绿测试。

## 必须全局审查

```bash
rg "P38-|P38\.1-" packages apps
rg "setTimeout\(" packages/core/src/runtime
```

## 禁止模式 A — tautology

```ts
expect(
  actor.activeTurn === undefined ||
  actor.activeTurn !== undefined
).toBe(true);
```

必须重写成具体 invariant，例如：

```ts
expect(maxOwners).toBeLessThanOrEqual(1);
expect(runtimeStartCalls).toBe(1);
```

## 禁止模式 B — disconnected counter

错误：

```ts
let runCalls = 0;
expect(runCalls).toBe(0);
```

但 fake runtime 从未 `runCalls += 1`。

正确：

```ts
const runtime = {
  runTurn: async (...) => {
    runCalls += 1;
    ...
  },
};
```

## 禁止模式 C — sleep 作为 ordering primitive

错误：

```ts
await new Promise(r => setTimeout(r, 10));
```

然后假设“另一个 async 已进入某状态”。

正确：

```ts
const entered = deferred<void>();
const release = deferred<void>();
```

被测函数显式：

```ts
entered.resolve();
await release.promise;
```

## 允许 timeout 的唯一用途

只允许 test-level watchdog：

```text
如果 2 秒仍未 settle，则测试失败
```

不能拿它证明执行顺序。

## 推荐 helper

```ts
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}
```

## Meta review rule

对每条 P38 / P38.1 regression 都问：

```text
如果把 production code 恢复成旧 bug，
这条测试会明确失败吗？
```

如果答案不是明确“会”，测试必须重写。

## 验收

- [ ] 0 tautological assertion；
- [ ] 0 disconnected counter；
- [ ] Actor/Manager ownership tests 0 sleep-ordering；
- [ ] focused race tests 连续执行多次稳定。

推荐：

```bash
for i in 1 2 3 4 5; do
  pnpm test:race || exit 1
done
```

Windows 用 PowerShell 等价循环。

---

# P38.1-11 — Perf / Soak Gate Reclassification

## 目标

让：

```text
pnpm test
```

重新成为稳定的 correctness gate。

不要简单：

```text
240s → 600s
```

## 分类原则

### correctness

默认进：

```bash
pnpm test
```

特点：

- 功能/不变量；
- 稳定；
- 快；
- 跨平台。

### perf regression

进：

```bash
pnpm test:perf
```

特点：

- 检测 O(n²) / pathological growth；
- 使用较小 deterministic workload；
- 不需要 50k 真 fsync 才能证明复杂度。

### soak / scale

进：

```bash
pnpm test:soak
```

特点：

- 20k/50k/100k；
- 大量磁盘 I/O；
- long-session；
- nightly / scheduled / dedicated runner。

## 推荐 root scripts

根据当前 Vitest 版本调整实际 glob：

```json
{
  "scripts": {
    "test": "vitest run --exclude '**/*.perf.test.ts' --exclude '**/*.soak.test.ts'",
    "test:perf": "vitest run '**/*.perf.test.ts'",
    "test:soak": "vitest run '**/*.soak.test.ts'"
  }
}
```

如果当前 Vitest CLI 不接受上述形式，按实际版本支持语法实现，不要照抄后不验证。

## event-store perf 建议

普通 correctness/perf gate 保留：

```text
1k 或 5k append
linesRead ~ O(1)
window growth factor bounded
```

重型：

```text
20k Windows
50k Linux
```

移动到 soak/scale。

## Windows 验收

- [ ] `pnpm test` 不再因 20k/50k fsync timeout；
- [ ] Windows 仍运行所有 runtime/security/path/store/sdk correctness tests；
- [ ] perf gate 若 required，不使用不合理统一 wall-clock hard threshold；
- [ ] soak 是否 required 在 CI policy 中明确写出。

---

# P38.1-12 — Exact-HEAD CI Attestation / Zero-Red RC Gate

## 目标

这是最终发布门。

只有 exact HEAD 的 required jobs 全 PASS，attestation 才能 READY。

## Required gates

```text
typecheck          PASS
test               PASS
build              PASS
coverage           PASS
docs               PASS
benchmark_smoke    PASS
protocol           PASS
security           PASS
race               PASS
chaos               PASS
capability_audit   PASS
linux_ci            PASS
windows_ci          PASS
```

最终：

```text
failed              0
blocked             0
not_run             0
inconsistent        0
stale_sha           0
command_mismatch    0
```

## Attestation 必须包含

- [ ] exact headSha；
- [ ] workflow run id；
- [ ] 每个 required gate id；
- [ ] 每个 gate canonical command；
- [ ] 每个 gate exitCode；
- [ ] passed；
- [ ] runner OS；
- [ ] artifact digest（可行时）；
- [ ] overall verdict。

## READY truth

```ts
const ready =
  everyRequiredGatePassed &&
  everyEvidenceHeadShaMatches &&
  everyEvidenceCommandMatches &&
  noInconsistentEvidence &&
  linuxPassed &&
  windowsPassed &&
  coveragePassed;
```

## Release attestation job

可以使用：

```yaml
if: always()
```

来生成 BLOCKED report。

但绝不能因为 job 自己成功执行就写 READY。

READY 必须来自上述 conjunctive truth。

## Self-reference 规则

不要：

```text
generate evidence at commit A
commit evidence
HEAD becomes B
evidence still says A
```

正确：

```text
commit B
  ↓
CI checkout B
  ↓
run gates
  ↓
generate attestation(headSha=B)
  ↓
upload artifact / check / release asset
```

Attestation 是对 commit 的外部证明，不应该依赖一个提交里“自称自己就是最终 SHA”的 tracked file。

## 验收

- [ ] Linux job PASS；
- [ ] Windows job PASS；
- [ ] Coverage PASS；
- [ ] release attestation 未 skipped；
- [ ] exact HEAD 一致；
- [ ] final verdict READY。

---

# P38.1-13 — Final Comprehensive Audit + Release Truth

## 目标

全部代码修好后，再做一次全仓库大审查。

不能只看：

```text
pnpm test green
```

还要看测试本身是否真的证明了对应语义。

## 最终大审查清单

### Runtime / Followup

- [ ] 同一个 durable prompt 是否可能重复 promotion？
- [ ] hydration 是否按 prompt identity dedup？
- [ ] 相同 text 不同 promptId 是否被错误去重？
- [ ] promotion failure caller 是否 terminal settle？
- [ ] durable requeue 是否仍可恢复？
- [ ] consumed prompt 是否一定存在 recoverable owner？
- [ ] cancel/interrupt/close 后是否有 late promotion？

### SDK

- [ ] pre-aborted turn/run calls == 0？
- [ ] mid-run abort interrupt 正常？
- [ ] sync emission 无 event loss？
- [ ] done exactly once？
- [ ] listeners 最终 0 growth？

### Evidence

- [ ] passed 和 exitCode 一致？
- [ ] malformed evidence fail closed？
- [ ] stale SHA fail closed？
- [ ] command mismatch fail closed？
- [ ] capability_audit 来自真实 canonical command？

### Audit

- [ ] strict 对 docs claims？
- [ ] strict 对 profile requirements？
- [ ] strict 对 evidenceFresh？
- [ ] benchmark evidence freshness 也参与？

### Canonical path

- [ ] full-path realpath 使用 injected adapter？
- [ ] ancestor walker 也使用 injected adapter？
- [ ] depth cap fail closed？
- [ ] error taxonomy deterministic？

### Tests

- [ ] 0 tautology；
- [ ] 0 disconnected counter；
- [ ] concurrency tests 0 ordering sleep；
- [ ] regression 在旧错误实现上可失败。

### CI

- [ ] Linux PASS；
- [ ] Windows PASS；
- [ ] Coverage PASS；
- [ ] Required gates PASS；
- [ ] Attestation READY；
- [ ] exact HEAD match。

---

# 5. Detailed Regression Matrix

| Area | Scenario | Required Result |
|---|---|---|
| Followup | enqueue before first hydration | 同一 prompt 只出现一次 |
| Followup | same text, different promptIds | 两条都保留 |
| Followup | promotion startTurn throws | durable requeue + caller settle |
| Followup | completePromotion throws | input 不丢、caller settle |
| Followup | interrupt during ack window | 无 consumed-without-owner |
| Followup | restart hydration | pending prompt 恢复一次 |
| Actor | runTurn blocked + cancelTurn | runtime.runTurn calls == 0 |
| Actor | startTurn blocked + interrupt | no late running |
| Actor | startTurn blocked + close | no late owner |
| Actor | mixed ownership race | max live owner <= 1 |
| SDK | pre-aborted signal | turn/run calls == 0 |
| SDK | abort mid-run | interrupt invoked |
| SDK | sync transport emission | no event loss |
| SDK | 1000 short runs | listener growth == 0 |
| Evidence | passed=false + exitCode=0 | INVALID/BLOCKED |
| Evidence | passed=true + exitCode=1 | INVALID/BLOCKED |
| Evidence | wrong command | BLOCKED |
| Evidence | stale SHA | BLOCKED |
| Audit | fresh=false under strict | exit 1 |
| Path | ENOENT then ancestor EACCES | permission |
| Path | ENOENT then ancestor ELOOP | symlink_loop |
| Path | 64+ missing ancestors | depth |
| CI | Linux exact HEAD | PASS |
| CI | Windows exact HEAD | PASS |
| CI | Coverage | PASS |
| Release | all required exact-head gates | READY only if all PASS |

---

# 6. Required Package Scripts

执行完成后 root `package.json` 至少需要清晰可重复的命令面。

如果已有等价命令，保留已有命名即可；关键是 CI 和 verifier 使用同一 canonical 定义。

```json
{
  "scripts": {
    "typecheck": "...",
    "test": "...",
    "build": "...",
    "test:coverage": "...",
    "docs:verify": "...",
    "benchmark:smoke": "...",

    "test:protocol": "...",
    "test:security": "...",
    "test:race": "...",
    "test:chaos": "...",

    "capability:audit": "node apps/cli/dist/main.js audit --strict",
    "release:verify": "node apps/cli/dist/main.js release verify",

    "test:perf": "...",
    "test:soak": "..."
  }
}
```

---

# 7. Per-Phase Execution Discipline

每个 phase 强制：

```text
1. 写 regression
2. 证明 regression 对旧 bug 会失败
3. 修改 production code
4. focused test
5. cross-package regression
6. pnpm typecheck
7. checkpoint / commit
8. 再进入下一 phase
```

禁止：

```text
一次性改 20 个文件
  ↓
最后才 pnpm test
  ↓
红了不知道是谁引入
```

---

# 8. Commit / Checkpoint 建议

建议保持小 commit，便于回归定位：

```text
fix(p38.1-1): dedupe hydrated durable followups by prompt identity
fix(p38.1-2): terminally settle failed followup promotions
fix(p38.1-3): close durable promotion cancellation window
fix(p38.1-4): revoke starting reservations on cancel
fix(p38.1-5): do not invoke turn/run for pre-aborted sdk runs
fix(p38.1-6): reject inconsistent gate evidence
fix(p38.1-7): bind evidence to canonical gate commands
fix(p38.1-8): make strict audit fail on stale evidence
fix(p38.1-9): use injected realpath throughout ancestor walk
test(p38.1-10): replace tautological and timing-based race tests
ci(p38.1-11): split correctness perf and soak gates
ci(p38.1-12): generate exact-head release attestation
```

---

# 9. Final Zero-Red Gate

从 clean checkout / clean tree 开始执行：

```bash
pnpm install --frozen-lockfile

pnpm typecheck
pnpm test
pnpm build
pnpm test:coverage
pnpm docs:verify

pnpm test:protocol
pnpm test:security
pnpm test:race
pnpm test:chaos

pnpm benchmark:smoke
pnpm capability:audit

# 如果定义为 required：
pnpm test:perf

pnpm release:verify
```

`pnpm test:soak` 是否每次 release required，由 CI policy 决定。

如果不是 required，必须明确：

```text
nightly / scheduled scale gate
```

不能一边在 plan 里说 required，一边 CI 永远不跑。

---

# 10. Final DONE Conditions

- [ ] P38.1-0 baseline truth capture 完成；
- [ ] P38.1-1 hydration duplication regression PASS；
- [ ] P38.1-2 resolver liveness regression PASS；
- [ ] P38.1-3 durable promotion/cancellation regression PASS；
- [ ] P38.1-4 starting cancellation regression PASS；
- [ ] P38.1-5 SDK pre-abort no-run PASS；
- [ ] P38.1-6 evidence consistency PASS；
- [ ] P38.1-7 command provenance PASS；
- [ ] P38.1-8 strict evidenceFresh PASS；
- [ ] P38.1-9 canonical injected-rp PASS；
- [ ] P38.1-10 0 tautology；
- [ ] P38.1-10 0 disconnected counter；
- [ ] P38.1-10 actor/manager ownership tests 0 ordering sleep；
- [ ] P38.1-11 correctness/perf/soak 分类完成；
- [ ] `pnpm typecheck` PASS；
- [ ] `pnpm test` PASS；
- [ ] `pnpm build` PASS；
- [ ] `pnpm test:coverage` PASS；
- [ ] `pnpm docs:verify` PASS；
- [ ] `pnpm test:protocol` PASS；
- [ ] `pnpm test:security` PASS；
- [ ] `pnpm test:race` PASS；
- [ ] `pnpm test:chaos` PASS；
- [ ] `pnpm benchmark:smoke` PASS；
- [ ] `pnpm capability:audit` PASS；
- [ ] Linux exact HEAD CI PASS；
- [ ] Windows exact HEAD CI PASS；
- [ ] Coverage exact HEAD PASS；
- [ ] Release Attestation exact HEAD READY；
- [ ] failed required gates = 0；
- [ ] blocked required gates = 0；
- [ ] not-run required gates = 0；
- [ ] inconsistent evidence = 0；
- [ ] stale SHA evidence = 0；
- [ ] command mismatch evidence = 0。

---

# 11. Hard NO-DONE Rules

下面任意一条成立，P38.1 必须保持 `BLOCKED`：

- Windows 红、Linux 绿；
- Linux 红、Windows 绿；
- Coverage 红；
- Coverage 没跑；
- release attestation skipped；
- attestation 来自旧 SHA；
- evidence command 与 canonical command 不匹配；
- `passed` 和 `exitCode` 不一致；
- `audit --strict` 在 stale evidence 下仍 exit 0；
- followup caller 存在 forever-pending；
- 同一个 durable prompt 可能 duplicate promotion；
- pre-aborted SDK 仍调用 `turn/run`；
- regression 是 tautology；
- regression counter 没接 production path；
- 用 sleep 证明 Actor/Manager ordering；
- 把红项标成 known noise 后继续 READY。

---

# 12. Final Audit 输出格式

Agent 做完后，最终输出必须按如下格式：

```text
# P38.1 Final Audit

HEAD:
<sha>

Working tree:
clean / dirty

## Runtime invariants
INV-P38.1-001 PASS
INV-P38.1-002 PASS
...
INV-P38.1-018 PASS

## Gate results
typecheck          PASS
test               PASS
build              PASS
coverage           PASS
docs               PASS
protocol           PASS
security           PASS
race               PASS
chaos              PASS
benchmark_smoke    PASS
capability_audit   PASS
linux              PASS
windows            PASS
release_attestation READY

## Evidence integrity
headSha match               PASS
command provenance          PASS
passed/exitCode consistency PASS
stale evidence              0
blocked evidence            0
not-run evidence            0

## Regression summary
<逐条列 P38.1 regression + PASS>

## Remaining risks
NONE
或明确列出阻塞项。

## Final verdict
READY / BLOCKED
```

如果还有阻塞项，不允许写：

```text
DONE with known noise
```

---

# 13. P38.1 完成后的路线

如果 exact HEAD 真正 READY：

**停止 P39 大架构升级。**

后续进入：

```text
Champion baseline
  ↓
Failure clustering
  ↓
提出一个 condition-specific challenger
  ↓
paired A/B benchmark
  ↓
quality gate
  ↓
security/race/cost gate
  ↓
PROMOTE 或 REJECT
```

## Benchmark 演化规则

- 一次 challenger 只改变一个主要变量；
- 先解决 champion 真实 failure cluster；
- 不做“全局开启一个机制看看会不会变强”；
- quality 是 hard gate；
- token/tool/latency 是 tie-breaker；
- 成本下降但质量下降 → REJECT；
- 建议每 case 至少 3-run paired repetition；
- 稳定后升级到 5-run；
- 推荐 A/B/A/B 交错，减少 provider backend drift。

---

# 14. 可直接给 Codex / Agent 的执行提示

```text
你现在负责执行 P38.1。

必须严格遵守：

1. 严格按 plan.md 顺序执行，不要跳 phase。
2. 每个 phase 先写能失败的 regression，再修 production code。
3. 每完成一个 phase，立即运行 focused tests + cross-package tests + typecheck。
4. 不要新增与 P38.1 无关的大功能。
5. 不要开始 P39。
6. 不要把红项写成 known noise。
7. 不要用 sleep 证明并发 ordering；使用 barrier / deferred。
8. 不要写 tautological tests。
9. 不要写 disconnected counters。
10. Evidence 必须来自真实 command execution。
11. Release verifier 必须检查 exact HEAD。
12. Release verifier 必须检查 command provenance。
13. Release verifier 必须检查 passed/exitCode consistency。
14. audit --strict 必须检查 evidenceFresh。
15. Followup durable prompt 必须 exactly-once promotion。
16. Followup promotion failure caller 必须 terminal settle。
17. pre-aborted SDK 不得 invoke turn/run。
18. 最终只有 Linux + Windows + Coverage + Required Gates + Attestation 全绿才允许 READY。
19. 如果任何 required gate 红/blocked/not-run，最终 verdict 必须 BLOCKED。
20. 全部完成后，按 plan.md 的 Final Audit 模板做一次全仓库大审查。
```

---

# 15. 一页版 Acceptance Checklist

- [ ] P38.1-0 Baseline truth capture
- [ ] P38.1-1 Followup hydration dedupe
- [ ] P38.1-2 Followup resolver terminal semantics
- [ ] P38.1-3 Durable promotion/cancellation closure
- [ ] P38.1-4 Starting reservation cancel closure
- [ ] P38.1-5 SDK pre-abort no-run
- [ ] P38.1-6 Evidence consistency
- [ ] P38.1-7 Canonical command provenance
- [ ] P38.1-8 Strict evidenceFresh
- [ ] P38.1-9 Canonical injected realpath seam
- [ ] P38.1-10 Regression quality + deterministic race tests
- [ ] P38.1-11 Correctness / perf / soak split
- [ ] P38.1-12 Exact-head CI attestation
- [ ] P38.1-13 Final comprehensive audit
- [ ] Final: Linux PASS
- [ ] Final: Windows PASS
- [ ] Final: Coverage PASS
- [ ] Final: Required gates PASS
- [ ] Final: Attestation READY
- [ ] Final: zero-red

---

# 16. 最终阶段定义

只有在下面全部成立时，才允许正式宣布：

```text
Harness v5 Architecture Closure = COMPLETE
```

必须是：

```text
Runtime correctness          CLOSED
Followup exactly-once        CLOSED
Cancellation late-promotion  CLOSED
SDK streaming lifecycle      CLOSED
Evidence truthfulness        CLOSED
Command provenance           CLOSED
Strict freshness             CLOSED
Canonical path seam          CLOSED
Regression quality           CLOSED
Linux CI                     GREEN
Windows CI                   GREEN
Coverage                     GREEN
Release Attestation          READY
```

否则：

```text
Harness v5 Architecture Closure = BLOCKED
```

不要再出现“基本完成”“known noise 不影响”“本地全绿所以算完成”这种中间态替代硬验收。

P38.1 真正完成后，项目的主线应从：

```text
继续找架构漏洞
```

正式切换为：

```text
用真实 benchmark 提升 champion 的任务成功率
```

这才是后续阶段的主战场。
