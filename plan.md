# Harness Agent v5 — P38.2 Final RC Evidence & Followup Exactly-Once Closure Plan

> Repository: `ki11a-Conton/harness-agent`
>
> Reviewed baseline HEAD: `b138eae4bf408154ef62a2ee40f204b8b016c1e5`
>
> Purpose: close the final release-candidate correctness and evidence gaps after P38.1.
>
> **NO PAID MODEL/API BENCHMARK IS REQUIRED FOR THIS PLAN.**
>
> This phase is deliberately small. Do not add new agent features, planner features, memory systems, MCP functionality, plugin features, or model capabilities. The objective is to make the current runtime and release-evidence pipeline mechanically trustworthy.

---

## 0. Mission

P38.1 substantially closed the runtime architecture, but the latest exact HEAD still has several RC blockers:

1. Durable followup promotion can execute a turn successfully while `markConsumed()` fails, leaving the prompt `pending`; after restart it can execute again.
2. The CI gate-evidence step runs under `bash -e`, so the first failing gate exits before its real exit code/evidence is captured.
3. Capability execution evidence and release-gate evidence are currently conflated; strict audit expects `capability:*` / `benchmark:*` evidence that CI never creates.
4. Strict audit requires benchmark evidence based on declaration rather than the active release profile, which can incorrectly make Runtime release depend on paid real-model benchmark runs.
5. `benchmark:smoke` currently invokes an adversarial stub benchmark whose cases may fail while the shell still exits 0; the repository already contains a true deterministic free smoke path and should use it.
6. A few residual tests still prove state shape instead of actual historical concurrency.
7. Hydration can permanently suppress retry if its first durable read fails.
8. Release attestation collapses Linux and Windows evidence into one directory/name space.
9. A heavy perf test is still in the default unit/integration lane due to filename classification.

P38.2 must close these issues and then STOP architecture work.

---

# 1. Non-negotiable rules

1. **No paid API requirement.**
   - No OpenAI API key is required.
   - No real-model full regression/holdout/adversarial/stress run is required.
   - Runtime release and Champion promotion must be separate verdicts.

2. **Regression test first where practical.**

3. **No correctness test may rely on `setTimeout` sleeps to create races.**
   Use deferred promises, barriers, latches, injected adapters, or deterministic gates.

4. **No fake-green release evidence.**
   - `passed` must derive from the real command exit code.
   - stale SHA fails closed.
   - wrong command fails closed.
   - missing evidence fails closed.
   - wrong evidence kind fails closed.

5. **No duplicate followup execution after restart.**
   A prompt that has already produced a durable turn must never be promoted into a second turn merely because its final inbox ack failed.

6. **Runtime Release != Champion Promotion.**
   Runtime RC must be provable for free. Paid model quality evaluation is a separate optional gate.

7. Final task status vocabulary only:
   - `DONE`
   - `BLOCKED`
   - `IN_PROGRESS`
   - `NOT_STARTED`

8. Forbidden final labels:
   - `DONE_WITH_NOISE`
   - `MOSTLY_DONE`
   - `PASS_EXCEPT`
   - `GREEN_ENOUGH`

---

# 2. P38.2 delivery map

| Phase | Priority | Goal |
|---|---:|---|
| P38.2-0 | P0 | Capture current truth |
| P38.2-1 | P0 | Durable followup exactly-once identity binding |
| P38.2-2 | P0 | Followup reconciliation after ack failure/restart |
| P38.2-3 | P1 | Hydration retry/single-flight correctness |
| P38.2-4 | P0 | Gate evidence capture under real exit codes |
| P38.2-5 | P0 | Separate gate / capability / benchmark evidence namespaces |
| P38.2-6 | P0 | Profile-scoped strict audit evidence requirements |
| P38.2-7 | P0 | Correct deterministic free benchmark smoke |
| P38.2-8 | P1 | Strengthen real concurrency tests |
| P38.2-9 | P1 | Terminal cancellation persistence truth |
| P38.2-10 | P1 | OS-specific release evidence |
| P38.2-11 | P1 | Tracked capability matrix truthfulness |
| P38.2-12 | P2 | Move heavyweight perf out of default test lane |
| P38.2-13 | P0 | Final free RC gate + attestation |

---

# 3. P38.2-0 — Capture exact baseline truth

## Goal

Record what the current exact HEAD actually does before changing anything.

## Commands

```bash
git rev-parse HEAD
git status --short

pnpm typecheck
pnpm test
pnpm build
pnpm test:coverage
pnpm docs:verify
pnpm benchmark:smoke
pnpm test:protocol
pnpm test:security
pnpm test:race
pnpm test:chaos
pnpm capability:audit
pnpm release:verify
```

## Required recording

Write `.ci/p38.2-baseline.json` or equivalent local artifact containing:

```json
{
  "headSha": "...",
  "workingTreeDirty": false,
  "gates": {
    "typecheck": "PASS|FAIL",
    "test": "PASS|FAIL",
    "build": "PASS|FAIL",
    "coverage": "PASS|FAIL",
    "docs": "PASS|FAIL",
    "benchmark_smoke": "PASS|FAIL",
    "protocol": "PASS|FAIL",
    "security": "PASS|FAIL",
    "race": "PASS|FAIL",
    "chaos": "PASS|FAIL",
    "capability_audit": "PASS|FAIL",
    "release_verify": "PASS|FAIL"
  }
}
```

Do not commit `.ci/` if it remains intentionally ignored.

## Acceptance

- Baseline exact SHA recorded.
- Current failures recorded truthfully.
- No missing command is reported as PASS.

---

# 4. P38.2-1 — Durable followup exactly-once identity binding

## Severity

P0

## Problem

Current followup flow establishes a running turn before durable `markConsumed()`, which correctly avoids consumed-before-owner. However, if the final ack fails, the durable prompt remains `pending` while the turn has already executed.

After restart:

```text
prompt A pending
→ hydration
→ start second turn
→ duplicate side effects possible
```

This violates exactly-once promotion semantics.

## Mandatory invariant

### INV-P38.2-001 — Durable prompt → turn identity binding

Once a followup has successfully created a durable Turn `T`, the durable inbox must remember that prompt `P` is bound to `T` before the turn may be considered promotable again.

A restart must never create another turn for the same durable prompt if `P.promotedTurnId` already exists.

## Recommended contract change

Update `AdmittedPrompt`:

```ts
export interface AdmittedPrompt {
  id: PromptId;
  sessionId: SessionId;
  text: string;
  kind: PromptKind;
  status: PromptStatus;
  admittedAt: number;
  promotedAt?: number;
  consumedAt?: number;
  promotedTurnId?: TurnId;
}
```

Update `InboxStore`:

```ts
markPromoted(id: PromptId, turnId: TurnId): Promise<void>;
markConsumed(id: PromptId): Promise<void>;
```

If backward compatibility matters, introduce a new explicit method rather than silently changing semantics:

```ts
bindPromotion(id: PromptId, turnId: TurnId): Promise<void>;
```

## Required state machine

```text
pending
  ↓ runtime.startTurn() successfully creates durable Turn T
promoted(turnId=T)
  ↓ actor ownership established / run starts
  ↓ terminal / reconciliation
consumed
```

A prompt must never return from `promoted` to `pending` after a durable turn identity exists.

## Critical rule

Do **not** requeue a prompt after a durable turn already exists.

Before durable turn creation:

```text
promotion failure
→ pending/requeue is valid
```

After durable turn creation:

```text
ack failure
→ reconcile against promotedTurnId
→ NEVER create a new turn blindly
```

## Files likely involved

- `packages/contracts/src/inbox.ts`
- `packages/session/src/inbox.ts`
- `packages/core/src/runtime/session-actor.ts`
- relevant JSONL migration/serialization tests
- session actor tests

## Tests

Add deterministic tests:

### Test A — successful bind

```text
followup P
→ create Turn T
→ durable prompt becomes promoted
→ promotedTurnId == T.id
```

### Test B — bind persists across restart

```text
P promoted to T
→ construct fresh queue/store instance
→ hydration does not expose P as new pending followup
```

### Test C — same text different IDs

Two prompts with identical text but different PromptId still produce two independent bindings.

### Test D — no duplicate turn after ack failure

```text
P → T
markConsumed fails
process restart
hydrate
assert runtime.startTurn called 0 additional times for P
```

### Test E — promoted turn identity mismatch fails closed

If persisted prompt references a missing/foreign-session turn, reconciliation must surface a typed degraded/failed condition. Do not silently create a replacement turn without explicit recovery policy.

## Acceptance

```text
duplicate followup turns after restart = 0
promoted prompt without durable turn identity = 0
requeue after durable turn creation = 0
```

---

# 5. P38.2-2 — Followup reconciliation after ack failure/restart

## Severity

P0

## Mandatory invariant

### INV-P38.2-002 — Promoted followups reconcile, not replay

A durable followup in `promoted` state must be reconciled against its bound turn.

## Required reconciliation rules

Recommended policy:

```text
P.status = promoted
P.promotedTurnId = T

if T.status is terminal:
    markConsumed(P)
    do not rerun

if T.status is pending/running/recoverable:
    resume/reconcile T according to runtime recovery policy
    do not create T2

if T missing:
    surface typed reconciliation failure
    fail closed
```

Do not use:

```text
promoted but weird
→ set pending
→ start a new turn
```

unless there is a formally documented recovery contract that proves no duplicate side effect is possible.

## Queue API recommendation

Consider exposing:

```ts
interface ReservedFollowup {
  id: string;
  promptId?: PromptId;
  input: UserMessage;
  promotedTurnId?: TurnId;
}
```

or separate reconciliation APIs.

## Required tests

1. crash after `markPromoted` but before `promoteToRunning`
2. crash after owner established but before `markConsumed`
3. terminal completed turn + prompt still promoted
4. terminal cancelled turn + prompt still promoted
5. terminal failed turn + prompt still promoted
6. missing promoted turn
7. wrong-session promoted turn
8. repeated reconciliation is idempotent

## Acceptance

Reconciliation is idempotent and never creates a duplicate turn for an already-bound prompt.

---

# 6. P38.2-3 — Hydration retry / single-flight correctness

## Severity

P1

## Problem

Current shape can mark hydration completed before durable read succeeds:

```ts
this.hydrated = true;
await this.hydrate();
```

A transient failure can make durable prompts permanently invisible to that actor instance.

## Mandatory invariant

### INV-P38.2-003 — Failed hydration is retryable

`hydrated=true` only after hydration succeeds.

## Recommended implementation

```ts
private hydrated = false;
private hydration: Promise<void> | undefined;

private async ensureHydrated(): Promise<void> {
  if (this.hydrated) return;
  if (this.hydration !== undefined) return this.hydration;

  const p = this.hydrate();
  this.hydration = p;
  try {
    await p;
    this.hydrated = true;
  } finally {
    if (this.hydration === p) {
      this.hydration = undefined;
    }
  }
}
```

Then reservation path calls `ensureHydrated()`.

## Tests

- first `listPending()` throws EIO, second succeeds
- 50 concurrent first hydrations invoke store only once
- failed hydration does not duplicate locally enqueued prompt after retry
- reservation after retry sees durable pending prompt exactly once

---

# 7. P38.2-4 — Real gate evidence capture under `bash -e`

## Severity

P0

## Problem

GitHub Actions currently executes the evidence step with `bash -e -o pipefail`.

Pattern:

```bash
pnpm capability:audit
rc_capability=$?
```

is incorrect when the command exits non-zero because `bash -e` exits before `$?` is captured.

## Mandatory invariant

### INV-P38.2-004 — Every attempted required gate emits truthful evidence

If a gate is executed, its real exit code must be captured and evidence written even when it fails.

## Recommended implementation

Do not rely on global shell state implicitly.

Use helper:

```bash
run_gate() {
  local gate="$1"
  local command="$2"
  local outfile="$3"

  set +e
  eval "$command"
  local rc=$?
  set -e

  # write JSON from rc
  # do not exit here
}
```

Prefer avoiding `eval` if possible. A Node script that executes commands and writes evidence is even safer/cross-platform.

### Stronger recommendation

Create a repository-owned script:

```text
apps/cli/src/gate-runner.ts
```

or:

```text
scripts/run-release-gate.mjs
```

that:

1. receives gate ID
2. resolves canonical command from one source of truth
3. executes it
4. captures exit code
5. writes evidence
6. exits with the same exit code only after evidence is durable

This avoids duplicating JSON construction in YAML.

## Acceptance

A deliberately failing test gate must create:

```json
{
  "gate": "test",
  "exitCode": 1,
  "passed": false
}
```

and the workflow must later fail due to the real red gate, not because evidence generation crashed before writing the file.

---

# 8. P38.2-5 — Separate gate / capability / benchmark evidence namespaces

## Severity

P0

## Problem

Release verifier evidence and capability audit evidence currently share one conceptual bucket but have different semantics.

Release gate evidence examples:

```text
typecheck
build
security
race
```

Capability evidence examples:

```text
capability:context_pipeline
capability:memory_store
capability:advanced_tools
```

Benchmark execution evidence examples:

```text
benchmark:regression_suite
benchmark:holdout_suite
```

These must not be inferred from each other accidentally.

## Mandatory invariant

### INV-P38.2-005 — Evidence type has an explicit namespace and schema

Recommended layout:

```text
.ci/evidence/
  gates/
    typecheck.json
    test.json
    build.json
    ...

  capabilities/
    context_pipeline.json
    checkpoint_store.json
    advanced_tools.json
    ...

  benchmarks/
    benchmark_smoke.json
    regression.json
    holdout.json
    adversarial.json
    stress.json
```

Each file must include explicit type/kind.

Example capability evidence:

```json
{
  "schemaVersion": 1,
  "kind": "test_run",
  "capability": "context_pipeline",
  "headSha": "...",
  "command": "pnpm test",
  "passed": true,
  "generatedAt": "...",
  "artifactRef": "..."
}
```

## Important

A general `pnpm test` result may prove multiple capability test files ran, but the mapping must be explicit and generated from a reviewed manifest, not guessed by test filename at audit time.

Recommended manifest:

```ts
const CAPABILITY_TEST_EVIDENCE = {
  context_pipeline: [...],
  checkpoint_store: [...],
  memory_store: [...],
  advanced_tools: [...],
  ...
};
```

Evidence generation should only mark a capability passed if all required mapped test targets were part of the successful execution lane.

## Acceptance

- Gate evidence cannot be used as capability evidence by key collision.
- Wrong `kind` fails closed.
- Wrong namespace fails closed.
- Missing capability evidence is reported accurately.

---

# 9. P38.2-6 — Profile-scoped strict audit evidence requirements

## Severity

P0

## Problem

Current strict evidence freshness checks all declared benchmark suites, even when the audited profile is interactive runtime and no full real-model benchmark is required.

This incorrectly couples free Runtime release to paid Champion quality evaluation.

## Mandatory invariant

### INV-P38.2-006 — Runtime release does not require paid model benchmark evidence

Split:

```ts
interface AuditVerdict {
  documentationClaimsOk: boolean;
  profileRequirementsOk: boolean;
  declaredEvidenceFresh: boolean;
  requiredEvidenceFresh: boolean;
}
```

`--strict` must gate on:

```text
documentationClaimsOk
&& profileRequirementsOk
&& requiredEvidenceFresh
```

`declaredEvidenceFresh` remains informative.

## Suggested profile policy

### interactive-ephemeral

Required execution evidence:

```text
runtime/core capability tests only
no full benchmark suite execution required
```

### interactive-persistent

Required:

```text
runtime/core capability tests
persistence capability tests
no real-model full suite required
```

### benchmark

Required:

```text
benchmark harness capability tests
free deterministic benchmark smoke
optional suite execution based on explicit audit mode
```

### champion

Required:

```text
full real-model promotion evidence
paired benchmark
cost/quality/latency evaluation
```

Champion evidence is allowed to be `NOT_RUN` without blocking Runtime release.

## CLI recommendation

Keep:

```bash
pnpm capability:audit
```

for runtime release.

Optionally add:

```bash
agent audit --profile champion --require-benchmarks
```

or:

```bash
pnpm champion:audit
```

for paid promotion.

## Acceptance

On a clean runtime RC with no API key:

```text
Runtime strict audit       PASS
Champion benchmark status  NOT_RUN
```

is valid.

---

# 10. P38.2-7 — Correct deterministic free benchmark smoke

## Severity

P0

## Problem

Current root script runs:

```text
agent benchmark --suite adversarial --limit 1 --allow-stub
```

and ordinary benchmark execution returns exit 0 even when the selected agent task itself fails.

The repository already contains a purpose-built deterministic free smoke path:

```text
agent benchmark smoke
```

with a fake provider and token-accounting assertions.

## Mandatory change

Root `package.json`:

```json
{
  "benchmark:smoke": "node apps/cli/dist/main.js benchmark smoke"
}
```

Do not use the adversarial quality case as the Runtime smoke gate.

## Mandatory invariant

### INV-P38.2-007 — Smoke gate tests harness plumbing, not model quality

The free smoke gate must fail for:

- harness cannot execute a turn
- report cannot be written/read
- usage accounting missing
- expected deterministic pipeline behavior broken

It must not claim to measure:

- coding quality
- adversarial task success
- champion performance

## Docs

Explicitly document:

```text
benchmark:smoke = deterministic free pipeline integrity gate
full benchmark = model quality/evolution evidence
```

## Tests

- deterministic fake provider success
- usage tokens missing → exit 1
- report missing → exit 1
- smoke command runs with no `OPENAI_API_KEY`

---

# 11. P38.2-8 — Strengthen concurrency tests so they measure real historical concurrency

## Severity

P1

## Problem

Tests like:

```ts
expect(actor.activeTurn ? 1 : 0).toBeLessThanOrEqual(1)
```

prove only the current shape of the API, not whether two runtime executions overlapped earlier.

## Mandatory invariant

### INV-P38.2-008 — Race tests measure execution overlap at the runtime seam

Use instrumented runtime:

```ts
let activeRuns = 0;
let maxActiveRuns = 0;

async function runTurn(...) {
  activeRuns += 1;
  maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
  try {
    await runGate.promise;
    return outcome;
  } finally {
    activeRuns -= 1;
  }
}
```

Then assert:

```ts
expect(maxActiveRuns).toBe(1);
```

## Required adversarial matrix

- 100 × startTurn
- startTurn vs runTurn(existing)
- startTurn vs createTurn
- followup drain vs direct start
- close during starting
- interrupt during starting
- cancel existing starting run
- followup ack window race

Remove or replace tests where counters are declared but not wired to the production seam.

---

# 12. P38.2-9 — Terminal cancellation persistence truth

## Severity

P1

## Problem

A starting turn can be terminalized as `cancelled` by the actor, but if durable `updateTurn(cancelled)` fails, the method currently logs degraded and still returns a definite cancelled outcome.

This can produce:

```text
caller = cancelled
store  = old nonterminal state
```

## Mandatory invariant

### INV-P38.2-009 — Durable terminal status may not be reported as certain when persistence is uncertain

Choose one explicit contract:

### Option A — fail the operation

Return/throw a typed error:

```text
TURN_TERMINALIZATION_PERSIST_FAILED
```

### Option B — typed uncertain terminal

```text
status = failed
statusDetail = cancellation_persistence_uncertain
```

Do not return a normal clean cancellation without durable truth unless the API explicitly documents ephemeral-only cancellation semantics.

## Tests

- updateTurn success → cancelled
- updateTurn failure → typed persistence uncertainty
- event emit failure separately surfaced
- no runtime.runTurn execution after pre-promotion cancellation

---

# 13. P38.2-10 — OS-specific release evidence

## Severity

P1

## Problem

Linux and Windows evidence currently share identical filenames and are downloaded into the same directory.

This weakens standalone attestation provenance.

## Mandatory invariant

### INV-P38.2-010 — Official attestation proves required platform matrix explicitly

Recommended layout:

```text
.ci/evidence/gates/linux/*.json
.ci/evidence/gates/windows/*.json
.ci/evidence/gates/coverage/*.json
```

Evidence schema:

```json
{
  "runner": {
    "os": "linux"
  }
}
```

or:

```json
{
  "platform": "linux"
}
```

## Required release checks

At minimum:

```text
linux.typecheck PASS
linux.test PASS
linux.build PASS
linux.protocol PASS
linux.security PASS
linux.race PASS
linux.chaos PASS

windows.typecheck PASS
windows.test PASS
windows.build PASS
windows.protocol PASS
windows.security PASS
windows.race PASS
windows.chaos PASS

coverage PASS
```

If some gates intentionally run once only, encode that policy explicitly rather than silently overwriting duplicate evidence.

---

# 14. P38.2-11 — Tracked capability matrix truthfulness

## Severity

P1

## Problem

A tracked matrix embedding HEAD SHA becomes stale as soon as it is committed.

Also diagnostic notes can lag production implementation.

## Mandatory invariant

### INV-P38.2-011 — Repository snapshot is informational; CI artifact is authoritative

Choose one:

### Preferred

Do not commit generated `CAPABILITY_MATRIX.*` at all.

Generate only in CI and upload:

```text
capability-matrix-<sha>
```

### Acceptable

Keep tracked matrix, but make it explicitly informational:

```text
NOT RELEASE EVIDENCE
```

and remove/avoid self-referential authoritative HEAD claims.

Official release verification must use freshly generated CI artifacts at immutable `github.sha`.

## Also fix stale diagnostics

Audit descriptions must reflect current production wiring. For example, if `model.completed` now includes usage, audit text must not claim it does not.

Add tests that compare feature diagnostics against current introspection facts.

---

# 15. P38.2-12 — Move heavyweight perf test out of default lane

## Severity

P2

## Problem

Default test excludes:

```text
**/*.perf.test.ts
**/*.soak.test.ts
```

but `perf-suite.test.ts` does not match and still runs a ~10k-message / 500-session workload in the default lane.

## Change

Rename:

```text
packages/harness/src/perf-suite.test.ts
→ packages/harness/src/perf-suite.perf.test.ts
```

or alter Vitest classification consistently.

## Acceptance

```bash
pnpm test
```

must not execute heavyweight perf/soak tests.

```bash
pnpm test:perf
```

must execute them.

This phase does not require the perf suite to become a release blocker unless explicitly desired.

---

# 16. P38.2-13 — Final free Runtime RC gate

## Severity

P0

## Mandatory final commands

These must require **no paid API key**:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:coverage
pnpm docs:verify
pnpm benchmark:smoke
pnpm test:protocol
pnpm test:security
pnpm test:race
pnpm test:chaos
pnpm capability:audit
pnpm release:verify
```

## GitHub CI requirements

At exact immutable HEAD `H`:

```text
Linux required lane       PASS
Windows required lane     PASS
Coverage                   PASS
Capability strict audit    PASS
Free benchmark smoke       PASS
Release attestation        READY
```

## Official release attestation

Generate only after all required free Runtime gates are green.

Example:

```json
{
  "schemaVersion": 2,
  "headSha": "<GITHUB_SHA>",
  "generatedAt": "...",
  "runtimeReleaseReady": true,
  "championPromotion": {
    "status": "NOT_RUN",
    "reason": "paid real-model benchmark is optional and was not requested for runtime RC"
  }
}
```

This distinction is intentional and required.

---

# 17. Final invariant list

## INV-P38.2-001

A durable followup prompt is bound to exactly one durable turn identity.

## INV-P38.2-002

Promoted followups reconcile against their bound turn; they are never blindly replayed after restart.

## INV-P38.2-003

Failed hydration remains retryable and concurrent hydration is single-flight.

## INV-P38.2-004

Every attempted release gate produces truthful evidence from its actual exit code.

## INV-P38.2-005

Gate, capability, and benchmark evidence have separate explicit namespaces and kinds.

## INV-P38.2-006

Runtime release does not require paid full-model benchmark evidence.

## INV-P38.2-007

`benchmark:smoke` is a deterministic free harness-integrity gate, not a model-quality benchmark.

## INV-P38.2-008

Concurrency tests measure maximum overlapping runtime execution, not only final actor state shape.

## INV-P38.2-009

Cancellation persistence failure cannot be reported as a clean durable cancellation.

## INV-P38.2-010

Official release evidence explicitly proves required Linux and Windows execution.

## INV-P38.2-011

Official capability/release evidence is CI-generated and bound to immutable exact HEAD.

---

# 18. Required followup adversarial matrix

Run deterministic tests for:

```text
enqueue before hydrate
hydrate failure then retry
concurrent hydration single-flight
same text / different prompt IDs
promotion before durable turn creation fails
turn created then promotion binding succeeds
markConsumed failure
restart after markConsumed failure
restart after promoted state
restart after terminal turn but unconsumed prompt
missing promotedTurnId target
wrong-session promotedTurnId
repeated reconciliation
interrupt during durable ack
close during durable ack
100-way actor ownership race
start vs run(existing)
start vs create
start vs followup drain
cancel starting existing turn
```

Expected:

```text
max active runtime executions <= 1
duplicate promoted turns = 0
unsettled queued callers = 0
```

---

# 19. Required release-evidence adversarial matrix

Add tests for:

```text
missing gate evidence
malformed gate evidence
wrong command
wrong SHA
passed=true + exitCode=1
passed=false + exitCode=0
failed gate still writes evidence
linux evidence missing
windows evidence missing
coverage evidence missing
duplicate gate same platform
capability evidence wrong kind
capability evidence stale SHA
benchmark evidence absent under interactive profile
benchmark evidence absent under champion profile
```

Expected:

```text
Runtime release:
  benchmark paid evidence absent -> can still PASS when profile does not require it

Champion promotion:
  required real benchmark evidence absent -> NOT_RUN/BLOCKED, never fake PASS
```

---

# 20. Exact execution order

Follow this order unless a dependency forces a small local adjustment:

```text
P38.2-0
→ P38.2-1
→ P38.2-2
→ P38.2-3
→ P38.2-8
→ P38.2-9
→ P38.2-4
→ P38.2-5
→ P38.2-6
→ P38.2-7
→ P38.2-10
→ P38.2-11
→ P38.2-12
→ P38.2-13
```

Correctness before release plumbing; release plumbing before final attestation.

---

# 21. Per-task reporting format

For every phase, update the working plan/handoff using this exact shape:

```text
Status:
Invariant:
Problem reproduced:
Implementation:
Files changed:
Regression tests added:
Production-path integration test:
Crash/restart impact:
Concurrency impact:
Security impact:
Durability impact:
Linux result:
Windows result:
Focused tests:
Full typecheck:
Full tests:
Build:
Coverage:
Release impact:
Remaining blockers:
```

No phase may be marked DONE without its focused regression tests.

---

# 22. Final zero-red checklist

Only mark **P38.2 COMPLETE** when all of these are true:

```text
followup restart duplicate execution       0
promoted prompt without turn identity      0
hydration permanent-failure latch          0
fake-green gate evidence                   0
gate evidence lost under bash -e           0
wrong-kind capability evidence accepted    0
paid benchmark required for runtime RC      0
false-success benchmark smoke              0
fake max-concurrency tests                  0
clean-cancel on failed persistence         0
Linux/Windows evidence overwrite           0
tracked matrix treated as attestation      0
```

Required free gates:

```text
pnpm typecheck          PASS
pnpm test               PASS
pnpm build              PASS
pnpm test:coverage      PASS
pnpm docs:verify        PASS
pnpm benchmark:smoke    PASS
pnpm test:protocol      PASS
pnpm test:security      PASS
pnpm test:race          PASS
pnpm test:chaos         PASS
pnpm capability:audit  PASS
pnpm release:verify    PASS

Linux CI                PASS
Windows CI              PASS
Coverage CI             PASS
Release attestation     READY
```

Paid real-model full benchmark:

```text
NOT REQUIRED FOR P38.2 RUNTIME RC
```

It must be reported separately, for example:

```text
Champion Promotion Evidence: NOT_RUN
```

This is acceptable and must not make Runtime Release fail.

---

# 23. Stop condition

After P38.2 reaches the final zero-red checklist:

**Do not start P39 architecture work.**

The architecture/runtime closure should be considered complete.

Future work must use the evolution loop:

```text
Runtime champion remains frozen
→ create one challenger
→ run free deterministic regressions first
→ when API budget is available, run paired real-model benchmark
→ compare quality / cost / latency / safety
→ promote or reject
```

Do not resume broad architectural feature accumulation unless a concrete benchmark or production failure proves a missing capability.

---

# 24. Final target state

```text
one durable prompt
→ one durable turn identity
→ one actor owner
→ one terminal outcome

one canonical gate command
→ one real exit code
→ one typed evidence record
→ one immutable-SHA release attestation

Runtime Release
→ fully free and reproducible

Champion Promotion
→ optional paid benchmark when budget exists
```

When the exact current HEAD satisfies these conditions, Harness Agent v5 Runtime should be treated as release-candidate closed.
