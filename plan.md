# Harness Agent v5 — P36 Release Integrity & Linearizability Closure Plan

> Repository: `ki11a-Conton/harness-agent`
>
> Reviewed baseline: current `main` around commit `b413f4f80833b642878816d8f3a06a353d8e069b`
>
> This plan starts at **PHASE 36**.
>
> P23–P35 are treated as implemented foundations, but **their status is NOT trusted blindly**.
> If source-level verification discovers that an invariant is not actually satisfied,
> P36 MUST fix the production path and update the historical status truthfully.
>
> Mission:
>
> **Turn Harness v5 from “feature-complete with documented known noise” into a release-integrity-closed runtime where session ownership is linearizable, SDK streaming semantics are truthful, process policy cannot be bypassed by shell composition, capability evidence is execution-backed, and a release task cannot be marked DONE unless every required gate is actually green.**

---

# 0. READ THIS BEFORE WRITING CODE

You are the coding agent implementing this plan.

Do **not** begin by adding abstractions.

Do **not** begin by creating `V2`, `V3`, `Fixed`, `New`, `Safe`, or duplicate implementations.

First inspect the current repository and verify every assumption against source.

The source code and executable evidence are authoritative.

A task is **NOT DONE** because:

- a previous `plan.md` says DONE;
- `HANDOFF.md` says the failure is “known noise”;
- a test file exists;
- a benchmark case exists;
- an implementation is present but not production-wired;
- a failure predates the current patch;
- a code path has a comment claiming an invariant;
- a capability matrix says `implemented`;
- a local workaround makes `tsc` emit;
- a test passes only when run in isolation;
- the change did not introduce the failing test;
- an assertion is weakened until green;
- a race failure is non-deterministic.

A task is DONE only when:

1. the production path satisfies the invariant;
2. the invariant is directly tested;
3. relevant package tests pass;
4. full typecheck passes;
5. full test suite passes;
6. full build passes;
7. required coverage passes;
8. required race/chaos/security suites pass;
9. benchmark smoke passes;
10. capability/release evidence references the current HEAD;
11. no required gate is skipped, ignored, or renamed to “noise”.

---

# 1. NON-NEGOTIABLE EXECUTION RULES

## Rule 1 — Red means red

If a required release command exits non-zero:

```text
releaseReady = false
```

There is no exception for:

```text
pre-existing failure
known noise
platform noise
race noise
test harness issue
only test code type error
not caused by this phase
```

Those descriptions may be useful for triage.

They may **not** convert a failed gate into PASS.

---

## Rule 2 — Do not weaken standards to make P36 pass

Forbidden:

- lowering coverage thresholds;
- deleting failing tests without proving they are invalid;
- adding broad `.skip`, `.only`, `test.todo`, platform-wide skip;
- excluding race tests from `tsconfig`;
- changing CI to ignore command exit codes;
- converting a required test into documentation;
- replacing real benchmark execution with file existence;
- replacing integration tests with helper-only unit tests;
- catching an error and returning success;
- changing release status semantics from “PASS” to “best effort”;
- marking a phase DONE with unresolved required gates.

If a test is genuinely invalid, repair the test so it tests the intended invariant.

---

## Rule 3 — Fix the invariant, not the symptom

Examples:

Bad:

```text
SESSION_BUSY test expects the wrong message
→ update regex only
```

Good:

```text
determine whether two same-session starts can race
→ fix actor admission linearizability
→ test typed error code
→ keep message non-authoritative
```

Bad:

```text
SDK stream hangs
→ add timeout
```

Good:

```text
separate public event consumption from internal result reduction
→ prove both can consume the same run concurrently
```

---

## Rule 4 — No hidden asynchronous ownership gaps

Any invariant of the form:

```text
exactly one owner
at most one active turn
one load per session
one durable commit
one terminal settlement
```

must remain true across every `await`.

If ownership is checked before an `await`, ownership must be reserved before that `await`.

---

## Rule 5 — Security decisions fail closed on ambiguity

If the runtime cannot prove:

- a filesystem path’s canonical identity;
- a command is a single permitted invocation;
- a shell-composed command is explicitly authorized;
- a cached approval covers equal-or-narrower authority;
- an MCP generation matches the originating step;
- an unsafe side effect definitely did not commit;

then deny / reconcile / require explicit approval.

Never guess.

---

## Rule 6 — Tests must exercise production paths

A P36 invariant test should normally flow through the real public or production composition path.

Preferred:

```text
Harness/AppServer/SessionActor/SandboxManager/Audit CLI
```

Avoid proving a production invariant only by directly invoking a pure helper.

Helpers still need unit tests, but production-path tests are mandatory.

---

## Rule 7 — Evidence must distinguish existence from execution

These are different facts:

```text
test file exists
test was executed
test passed at HEAD

benchmark case exists
benchmark suite was executed
benchmark suite passed at HEAD
```

Never collapse them.

---

## Rule 8 — Keep P36 narrow

P36 is a closure phase.

Do not add:

- new memory architecture;
- new subagent roles;
- new planner types;
- new plugin systems;
- new MCP transports;
- new UI features;
- new benchmark categories unless required to prove a P36 bug;
- new “smart” heuristics unrelated to release integrity.

If a new feature idea appears, record it under `Deferred after P36`.

---

# 2. CURRENT SOURCE AUDIT — ISSUES P36 MUST CLOSE

This section is a starting hypothesis. Re-verify before editing.

---

## 2.1 Release status truthfulness gap

Current P35 release reporting marks completion even though the documented run included:

- failing tests;
- blocked typecheck/build;
- coverage not run;
- benchmark smoke not run;
- chaos/race not fully green.

This violates the plan’s own completion rule.

P36 must make this mechanically impossible.

---

## 2.2 SessionActor admission race

Current `DefaultSessionActor.startTurn()` conceptually performs:

```ts
if (active === undefined && pendingRun === undefined) {
  const turn = await runtime.startTurn(...);
  return executeTurn(turn);
}
```

The actor does not necessarily reserve ownership before the awaited `runtime.startTurn()`.

Two simultaneous callers can pass the admission check before either becomes active.

P36 must make same-session turn admission linearizable.

---

## 2.3 LoadedSessionManager load race

Current manager pattern conceptually performs:

```ts
const existing = actors.get(id);
if (existing) return existing;

const session = await store.getSession(id);
const actor = new DefaultSessionActor(...);
actors.set(id, actor);
return actor;
```

Two concurrent loads may both miss the map before the store read resolves.

P36 must single-flight or serialize creation so one logical session has exactly one live actor in a manager.

---

## 2.4 SDK `runStreamed()` double-consumer semantic gap

The public API exposes:

```ts
{
  events: AsyncIterable<TurnEvent>;
  done: Promise<RunResult>;
}
```

but `done` is currently derived by consuming the same single-consumer event channel.

A user consuming `events` and awaiting `done` can race with the internal reducer.

P36 must make both surfaces independently correct over the same run.

---

## 2.5 Process allowlist glob / shell composition gap

The semantic process gate correctly parses shell operators for normal command matching.

However, broad glob matching is evaluated in a way that can authorize a shell-composed command before composition semantics are rejected.

Example threat:

```text
allowedCommands = ["git *"]
target = "git status; echo pwned"
```

The target is a composed shell command and must not be admitted by a normal argv/glob rule.

P36 must separate:

```text
plain invocation policy
vs
explicit shell composition policy
```

---

## 2.6 Canonical path ambiguity gap

The canonicalizer currently falls back after broad `realpath` failures.

Only path-not-found style errors should enter “deepest existing ancestor + tail” fallback.

Permission, loop, I/O, and unknown canonicalization failures must fail closed.

Depth-limit exhaustion must fail closed.

---

## 2.7 Capability audit evidence gap

Current audit can infer:

```text
integrationTested = test file exists
benchmarkExercised = benchmark directory/case count exists
```

This proves repository content, not execution.

P36 must introduce execution-backed evidence.

---

## 2.8 Durability semantics gap

Current matrix can report `durable=true` merely because the current profile does not require durability.

That mixes:

```text
actual capability durability
profile durability requirement
profile requirement satisfaction
```

P36 must model these separately.

---

## 2.9 Audit OK semantics gap

Current `audit: OK` can mean only that README benchmark counts match on-disk counts.

This label is too broad.

P36 must distinguish at least:

```text
documentationClaims
capabilityProfileSatisfaction
releaseGate
```

---

# 3. P36 DELIVERY MAP

| Task | Priority | Theme |
| --- | --- | --- |
| P36-0 | P0 | Baseline truth capture |
| P36-1 | P0 | Release gate truthfulness |
| P36-2 | P0 | SessionActor linearizability |
| P36-3 | P0 | LoadedSessionManager single-flight |
| P36-4 | P0 | SDK stream/result semantic closure |
| P36-5 | P0 | Process policy shell-composition closure |
| P36-6 | P1 | Filesystem canonicalization fail-closed |
| P36-7 | P1 | Execution-backed capability evidence |
| P36-8 | P1 | Durability / audit semantic model |
| P36-9 | P1 | Race + chaos suite stabilization |
| P36-10 | P1 | Cross-platform invariant matrix |
| P36-11 | P1 | Champion/release evidence binding |
| P36-12 | P0 | Zero-red release candidate gate |
| P36-13 | P2 | Documentation / migration / handoff truth |

Do not reorder P36-12 before P36-1..11 are complete.

---

# PHASE 36-0 — Baseline Truth Capture

> Priority: P0
>
> Goal: establish the exact current failure set before changing source.

## Why

P36 must distinguish:

```text
existing red baseline
new regressions
fixed failures
remaining failures
```

without using the existing baseline as an excuse to pass release.

## Implementation

Before edits, run and persist raw outputs for:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:coverage
pnpm docs:verify
pnpm benchmark:smoke
```

Also identify the exact available commands for:

```text
race suite
chaos suite
security suite
protocol conformance
production audit
champion evaluation smoke
```

If a command is not exposed in `package.json`, locate the real test paths and record them.

Create a machine-readable baseline artifact, for example:

```text
.ci/p36-baseline.json
```

Suggested schema:

```ts
interface GateRunEvidence {
  gate: string;
  command: string;
  headSha: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  passed: boolean;
  summary?: {
    testFilesPassed?: number;
    testFilesFailed?: number;
    testsPassed?: number;
    testsFailed?: number;
  };
  logPath: string;
}

interface P36Baseline {
  headSha: string;
  dirty: boolean;
  gates: GateRunEvidence[];
}
```

Do not commit massive logs unless repository conventions already commit CI logs.

The JSON summary may be committed if appropriate.

## Required tests

Unit-test parser/serializer if introducing reusable gate-evidence code.

## Acceptance criteria

- exact baseline HEAD recorded;
- every required gate attempted;
- exit code captured exactly;
- failed gates remain `passed=false`;
- “not run” is represented explicitly, never as PASS.

## Forbidden shortcuts

- do not omit slow gates;
- do not change commands before capturing baseline;
- do not classify a failure as “noise” inside the pass/fail field.

## Status block

```text
Status:
Baseline HEAD:
Implementation:
Commands run:
Failures observed:
Evidence:
Windows:
Linux:
Notes:
```

---

# PHASE 36-1 — Release Gate Truthfulness

> Priority: P0
>
> Goal: make it impossible for a release task to report PASS while required gates are red or not run.

## Design

Introduce a typed release gate model.

Example:

```ts
type GateState =
  | "passed"
  | "failed"
  | "not_run"
  | "blocked";

interface ReleaseGateResult {
  id:
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
  state: GateState;
  headSha: string;
  command: string;
  evidenceRef?: string;
  reason?: string;
}

interface ReleaseVerdict {
  headSha: string;
  ready: boolean;
  gates: ReleaseGateResult[];
}
```

Rule:

```text
ready = true
IFF
every required gate.state == "passed"
AND
every gate.headSha == release HEAD
```

No baseline exception.

## Implementation

Add a release verification command or evolve an existing one.

Suggested CLI:

```text
agent release verify
agent release verify --json
```

It must:

1. resolve current HEAD;
2. run or ingest authoritative gate evidence;
3. reject stale evidence from another SHA;
4. reject dirty-tree evidence unless explicitly using a dirty-tree development mode;
5. report each gate separately;
6. exit non-zero when any required gate is failed/not_run/blocked.

The human-readable output should say:

```text
Release verdict: FAILED

typecheck        FAILED
test             FAILED
build            BLOCKED
coverage         NOT_RUN
benchmark_smoke  NOT_RUN
...
```

Never:

```text
Release verdict: complete with known noise
```

## Plan/Handoff status rules

Update coding-agent instructions:

A phase may use:

```text
DONE
BLOCKED
IN_PROGRESS
NOT_STARTED
```

A required gate failure implies:

```text
P36-12 = BLOCKED
```

not DONE.

## Required tests

1. all gates pass → exit 0;
2. one failed → exit non-zero;
3. one not_run → exit non-zero;
4. one blocked → exit non-zero;
5. stale SHA evidence → exit non-zero;
6. missing evidence → exit non-zero;
7. “pre-existing” reason with failed state → still exit non-zero;
8. current-head all green → ready true.

## Acceptance criteria

- release success cannot be produced from red evidence;
- status cannot silently downgrade failed to passed;
- current HEAD binding is enforced;
- CLI exit code matches verdict.

## Forbidden shortcuts

- do not interpret `reason` text;
- do not special-case “known noise”;
- do not mark blocked commands as passed.

---

# PHASE 36-2 — SessionActor Linearizability

> Priority: P0
>
> Invariant:
>
> ```text
> INV-P36-001
> For one session actor, at most one turn admission may own execution at any instant,
> including the interval before runtime.startTurn() resolves.
> ```

## Why

An actor that checks ownership before an `await` but reserves ownership after it has a race window.

## Required architecture

Use one explicit actor lifecycle state.

Suggested:

```ts
type ActorRunState =
  | { kind: "idle" }
  | {
      kind: "starting";
      requestId: string;
      controller: AbortController;
    }
  | {
      kind: "running";
      turn: Turn;
      controller: AbortController;
      outcome: Promise<TurnOutcome>;
    }
  | {
      kind: "closing";
    };
```

Alternative implementations are allowed if they prove the same linearizability.

Do not keep multiple weak booleans/maps that can contradict each other.

## Admission rule

Ownership reservation must happen synchronously before the first awaited operation that can yield to another caller.

Pseudo:

```ts
if (state.kind !== "idle") {
  resolve conflict explicitly;
}

const reservation = reserveStarting();

try {
  const turn = await runtime.startTurn(...);
  promoteStartingToRunning(reservation, turn);
} catch (err) {
  releaseReservation(reservation);
  throw err;
}
```

## Conflict semantics

While `starting`:

- `busy` → typed `SESSION_BUSY`;
- `steer` → only allowed if semantics can target a valid running/sampling turn; otherwise typed refusal;
- `queue` → may durably enqueue future input;
- do not invent a fake current turn id.

Document exact behavior.

## Cancellation

A cancel/close arriving during `starting` must cancel the reserved start and must not later promote into a running turn.

Required invariant:

```text
close/cancel wins before promotion
=> no late turn starts after actor closed
```

## Required tests

### Test A — simultaneous admission

Use a runtime fake whose `startTurn()` blocks before returning.

```ts
const a = actor.startTurn(A);
await fake.waitUntilStartTurnEntered();

const b = actor.startTurn(B);

expect b => SESSION_BUSY

release A
```

### Test B — true Promise.all race

```ts
const [a, b] = await Promise.allSettled([
  actor.startTurn(A),
  actor.startTurn(B),
]);
```

Repeat enough times under deterministic gates.

Expected:

```text
fulfilled admissions = 1
SESSION_BUSY = 1
```

### Test C — starting + close

- reserve start;
- call close;
- release runtime start;
- assert no running turn survives;
- no resource leak.

### Test D — starting + cancel

Same as close but targeted cancellation.

### Test E — queued followup

Must not execute until current turn reaches terminal settlement.

### Test F — actor active identity

No later handle may overwrite a still-owning handle.

## Acceptance criteria

- no same-actor double admission;
- no late promotion after close;
- all conflicts typed;
- existing steer/followup semantics preserved;
- race test stable in repeated runs.

## Forbidden shortcuts

- do not rely only on `AgentRuntime.runTurn()` to reject the second call;
- SessionActor itself must be authoritative;
- do not “fix” by adding arbitrary sleeps.

---

# PHASE 36-3 — LoadedSessionManager Single-Flight Ownership

> Priority: P0
>
> Invariant:
>
> ```text
> INV-P36-002
> Within one LoadedSessionManager, concurrent load(sessionId) calls resolve to the exact same actor instance.
> ```

## Implementation

Use a single-flight table.

Example:

```ts
private actors = new Map<SessionId, SessionActor>();
private loading = new Map<SessionId, Promise<SessionActor>>();
```

Algorithm:

```text
if actors has id:
  return actor

if loading has id:
  return same promise

create load promise
store it before await
on success:
  install actor exactly once
finally:
  clear loading entry
```

## Unload interaction

Define behavior when `unload(id)` races with `load(id)`.

Choose and document one policy, e.g.:

```text
unload waits for in-flight load, then closes actor
```

or:

```text
unload marks cancellation and load resolves as closed
```

Do not leave ambiguous.

## Failure interaction

If `store.getSession()` fails:

- all concurrent load callers see the same failure;
- loading slot clears;
- a later retry may try again.

## Required tests

1. 100 concurrent `load(id)` → same object identity;
2. store read counter == 1 for a single-flight burst;
3. load failure fan-out → all fail, retry later succeeds;
4. load + unload race leaves no loaded actor;
5. close manager during load leaves no live actor;
6. two different session ids may load concurrently.

## Acceptance criteria

- one live actor per session id per manager;
- no duplicate actor construction under concurrent load;
- no leaked loading promises.

---

# PHASE 36-4 — SDK Event Stream / Done Semantic Closure

> Priority: P0
>
> Invariants:
>
> ```text
> INV-P36-003
> Public `events` consumption must not steal data from `done`.
>
> INV-P36-004
> `done` must represent the reduction of the same ordered event sequence exposed to the caller.
> ```

## Required public behavior

This must work:

```ts
const run = await thread.runStreamed("task");

const observed: TurnEvent[] = [];

const consume = (async () => {
  for await (const event of run.events) {
    observed.push(event);
  }
})();

const [result] = await Promise.all([
  run.done,
  consume,
]);
```

Expected:

- `observed` contains every event exactly once;
- `done` settles;
- `done` reflects the same terminal event/items/usage;
- no deadlock;
- no event stealing.

## Implementation options

### Preferred — broadcast + internal reducer

Transport event arrives once:

```text
transport
   ↓
RunEventHub
   ├─→ public event queue
   └─→ internal reducer state
```

The internal reducer should update incrementally on `push`, not by iterating the public queue.

### Acceptable — tee with two independent bounded consumers

Only if backpressure and cleanup are correct.

## Requirements

- bounded buffering;
- deterministic event order;
- terminal event delivered once;
- unsubscribe exactly once;
- abort interrupts server;
- local iterator return does not cancel `done` unless API explicitly documents that behavior;
- `done` does not require user to consume `events`;
- user consumption does not require awaiting `done`.

## Terminal semantics

Explicitly define:

```text
turn/completed
turn/failed
turn/interrupted
transport EOF before terminal
abort before server terminal
```

Unexpected EOF must not silently become completed.

Suggested:

```text
terminal event absent + transport closes
=> failed / protocol error
```

unless local abort semantics intentionally classify interrupted.

## Required tests

1. consume events + await done concurrently;
2. await done without consuming events;
3. consume events without awaiting done;
4. slow public consumer;
5. terminal failure;
6. interrupt;
7. immediate abort;
8. iterator early return;
9. transport closes before terminal;
10. duplicate terminal event is rejected/ignored deterministically;
11. event order identical raw client vs SDK;
12. large event burst stays within configured buffer policy.

## Acceptance criteria

- no single-consumer caveat remains in public API docs;
- conformance test no longer needs to avoid awaiting `done`;
- same stream truth is mechanically proven.

## Forbidden shortcuts

- do not solve with timeout;
- do not copy all events unbounded forever;
- do not document “events and done must not be used together”.

---

# PHASE 36-5 — Process Policy Shell-Composition Closure

> Priority: P0
>
> Invariant:
>
> ```text
> INV-P36-005
> A plain-command allowlist rule cannot authorize shell composition.
> ```

## Threat model

A rule such as:

```text
git *
pnpm test*
node *
```

must not authorize:

```text
git status; echo pwned
git status && whoami
git status || curl ...
pnpm test | sh
node app.js > secret.txt
```

unless an explicit policy independently authorizes shell composition.

## Required decision order

Change policy flow to:

```text
1. parse target invocation
2. detect shell composition
3. classify launch surface
4. apply denied surface policy
5. if composed:
     require explicit shell-composition authorization
     DO NOT apply ordinary argv/glob extension rules
6. if plain:
     evaluate program/argv allowlist
7. apply network intent policy
```

## Policy model

Preferred:

```ts
interface ProcessPolicy {
  allowedCommands?: string[];
  allowedShellCommands?: string[]; // explicit high-risk exact rules
}
```

or a typed rule:

```ts
type CommandRule =
  | { kind: "argv"; program: string; argvPrefix?: string[] }
  | { kind: "exact_shell"; command: string };
```

Do not overload a broad glob to mean both.

## Compatibility

If preserving legacy string rules:

- legacy glob rules apply only to non-composed invocations;
- composed commands require exact explicit shell rule;
- document the migration.

## Required tests

### POSIX

```text
allow ["git *"]

git status                       ALLOW
git status --short               ALLOW
git status; echo pwned           DENY
git status && whoami             DENY
git status || true               DENY
git status | cat                 DENY
git status $(whoami)             DENY
git status `whoami`              DENY
git status
whoami                          DENY
git status > out                 DENY
```

### Windows CMD

```text
dir & whoami                     DENY
dir && whoami                    DENY
dir | findstr x                  DENY
```

### PowerShell

```text
Get-ChildItem; whoami            DENY
Get-ChildItem | Out-File x       DENY
$(whoami)                        DENY
```

### Explicit shell policy

If introduced:

- exact authorized composed command may pass;
- extension of it may not pass;
- different cwd/environment/authority must not reuse approval if approval is involved.

## Acceptance criteria

- broad plain globs cannot admit composition;
- normal argv extension still works;
- network gate still applies.

---

# PHASE 36-6 — Filesystem Canonicalization Fail-Closed

> Priority: P1
>
> Invariant:
>
> ```text
> INV-P36-006
> Path containment decisions are allowed only when canonical identity is proven.
> ```

## Error taxonomy

Do not catch every `realpath` failure as “path missing”.

Differentiate at least:

### Fallback-eligible

```text
ENOENT
ENOTDIR
```

These may use deepest-existing-ancestor fallback.

### Fail-closed

```text
EACCES
EPERM
ELOOP
EIO
UNKNOWN
depth limit exceeded
invalid device/path semantics
```

Return typed canonicalization failure.

## Contract

Prefer:

```ts
type CanonicalPathResult =
  | { ok: true; path: string }
  | {
      ok: false;
      code: "permission" | "symlink_loop" | "io" | "depth" | "invalid" | "unknown";
      message: string;
    };
```

or throw a typed security error.

Do not silently return a partially canonical path.

## Required tests

1. missing leaf → canonical ancestor fallback works;
2. missing nested tail with `..` cannot escape;
3. permission denied → deny;
4. symlink loop → deny;
5. depth exhaustion → deny;
6. symlink escape → deny;
7. Windows junction/case behavior where available;
8. POSIX root case;
9. control chars → deny;
10. relative path resolve against cwd.

Where real OS setup is difficult, inject the filesystem resolver primitive for deterministic error taxonomy tests, plus at least one real-filesystem integration test.

## Acceptance criteria

- only explicit missing-path errors fallback;
- every ambiguous canonicalization failure denies;
- capability guard and sandbox share the same canonicalization semantics.

---

# PHASE 36-7 — Execution-Backed Capability Evidence

> Priority: P1
>
> Goal: stop claiming a capability is tested merely because a test file exists.

## New evidence model

Separate static and execution evidence.

Example:

```ts
interface StaticEvidence {
  kind: "source" | "test_file" | "benchmark_case" | "ci_config";
  ref: string;
}

interface ExecutionEvidence {
  kind:
    | "test_run"
    | "benchmark_run"
    | "coverage_run"
    | "ci_run"
    | "release_gate";
  headSha: string;
  command: string;
  passed: boolean;
  generatedAt: string;
  artifactRef?: string;
}
```

Capability fields should become conceptually:

```text
implemented       <- source/static evidence
productionWired   <- runtime introspection
testDeclared      <- test file exists
integrationTested <- current-HEAD passing execution evidence
benchmarkDeclared <- cases exist
benchmarkExercised<- current-HEAD successful benchmark evidence
```

## Evidence freshness

Execution evidence is valid only if:

```text
evidence.headSha == audited HEAD
```

Optionally allow ancestor evidence only for unchanged files if you implement a precise dependency proof.

Do not implement that optimization in P36 unless necessary.

Simplest safe rule: exact HEAD.

## Evidence source

Preferred:

```text
.ci/evidence/*.json
```

generated by commands/CI.

Examples:

```text
.ci/evidence/tests.json
.ci/evidence/coverage.json
.ci/evidence/benchmark-smoke.json
.ci/evidence/security.json
.ci/evidence/race.json
```

## CI integration

Each CI gate should emit machine-readable evidence.

The audit command may consume local evidence or CI-produced artifacts.

If evidence missing:

```text
integrationTested = false
benchmarkExercised = false
```

## Required tests

1. test file exists, no run evidence → not tested;
2. failed test run → not tested;
3. passing evidence stale SHA → not tested;
4. passing evidence current SHA → tested;
5. benchmark cases exist, no run → not exercised;
6. benchmark current-HEAD pass → exercised;
7. malformed evidence → fail closed;
8. evidence path missing → fail closed.

## Acceptance criteria

- file existence no longer equals execution success;
- matrix tells static declaration vs executed proof apart.

---

# PHASE 36-8 — Durability & Audit Semantic Model

> Priority: P1

## Problem

Current-style:

```text
durable=true
```

can mean:

```text
profile did not require durability
```

instead of:

```text
actual backing store is durable across restart
```

This is semantically misleading.

## New model

Suggested:

```ts
type DurabilityLevel =
  | "none"
  | "memory"
  | "process"
  | "flush"
  | "durable";

interface CapabilityDurability {
  actual: DurabilityLevel;
  required: DurabilityLevel;
  satisfied: boolean;
}
```

For example:

```text
approval store = InMemoryApprovalStore
actual = memory

interactive-ephemeral
required = none
satisfied = true

champion
required = durable
satisfied = false
```

The matrix must never render:

```text
durable=true
```

for an in-memory store merely because current profile does not require durability.

## Security posture

Similarly distinguish:

```text
actualSecurityMode
requiredSecurityMode
securitySatisfied
```

if current matrix uses one field for the promised profile mode.

## Audit summary split

Replace ambiguous `audit: OK` with explicit summaries:

```text
Documentation claims: PASS
Profile capability requirements: FAIL
Execution evidence freshness: FAIL
Release gate: FAIL
```

Possible JSON:

```ts
interface AuditVerdict {
  documentationClaimsOk: boolean;
  profileRequirementsOk: boolean;
  evidenceFresh: boolean;
  releaseReady?: boolean;
}
```

## CLI exit semantics

Define separate commands/options:

```text
agent audit
agent audit --strict
agent release verify
```

Recommended:

- `agent audit` reports facts and exits non-zero on malformed/contradictory evidence;
- `agent audit --strict` exits non-zero when profile requirements are unmet;
- `agent release verify` enforces all release gates.

## Required tests

1. in-memory approval + ephemeral profile → actual memory, satisfied yes;
2. in-memory approval + champion → satisfied no;
3. durable approval + champion → satisfied yes;
4. docs true but profile degraded → documentation PASS, profile FAIL;
5. profile pass but release gate missing → release FAIL;
6. markdown labels unambiguous.

## Acceptance criteria

- actual capability properties are never inferred from “not required”;
- `OK` cannot be misread as release readiness.

---

# PHASE 36-9 — Race & Chaos Suite Stabilization

> Priority: P1
>
> Goal: remove the category “known race noise” from release gating.

## Rule

A race test is either:

```text
valid and passing
```

or:

```text
invalid and repaired/replaced
```

It is never “expected red”.

## Procedure for each current failing race test

For every failing race file:

1. write the invariant it intends to prove;
2. determine whether failure is:
   - product bug;
   - test harness race;
   - incorrect assertion;
   - nondeterministic timer dependency;
   - leaked resource;
   - global shared state;
3. repair production or test accordingly;
4. replace wall-clock sleeps with deterministic gates where possible;
5. run repeatedly.

## Deterministic synchronization

Prefer:

```text
Deferred/Barrier/Latch
fake model provider gates
fake store gates
fake orchestrator gates
injected clock/timer
```

Avoid:

```ts
await sleep(10)
```

for correctness assertions.

## Required stress loop

Expose a command such as:

```text
pnpm test:race
```

and make it run key concurrency tests multiple times or through a deterministic race matrix.

Examples:

- simultaneous `SessionActor.startTurn`;
- manager concurrent load;
- cancel during starting;
- close during tool execution;
- SDK abort during streaming;
- durability crash windows;
- MCP single-flight generation;
- event sequence allocation.

## Chaos suite

Expose:

```text
pnpm test:chaos
```

if not already available.

Chaos must be deterministic enough for CI.

## Acceptance criteria

- zero known-red race tests;
- zero flaky retries in CI;
- race and chaos are real release gates.

## Forbidden shortcuts

- no retrying the full test command until green;
- no `--retry` used to hide flakes;
- no platform skip unless invariant is truly platform-inapplicable and there is an equivalent platform-specific test.

---

# PHASE 36-10 — Cross-Platform Invariant Matrix

> Priority: P1

## Scope

At minimum verify both Linux and Windows for:

```text
path canonicalization
process command parsing
shell operator detection
session actor concurrency
SQLite/JSONL durability
App Server transport
SDK conformance
capability audit
release verify
```

## CI

Keep Linux + Windows.

Add explicit named jobs if necessary:

```text
verify-linux
verify-windows
coverage-linux
security-matrix
release-evidence
```

Do not rely on a comment saying both platforms are covered.

## Platform-specific semantics

Tests must explicitly account for:

```text
POSIX shell
cmd.exe
PowerShell
drive letters
UNC
case-insensitive path option
separator normalization
```

## Acceptance criteria

- release candidate requires both verify platforms green;
- platform-specific failures cannot be reclassified as noise.

---

# PHASE 36-11 — Champion & Release Evidence Binding

> Priority: P1
>
> Goal: ensure Champion claims use real current-HEAD benchmark data.

## Champion promotion record

Create or evolve:

```ts
interface ChampionPromotionEvidence {
  candidateId: string;
  baselineId: string;
  headSha: string;
  modelIdentity: string;
  benchmarkSuites: string[];
  runIds: string[];
  metrics: {
    passedDelta: number;
    verifiedCompletionDelta: number;
    tokensDelta: number;
    costDelta: number;
    toolCallsDelta: number;
    recoveryDelta: number;
  };
  securityGatePassed: boolean;
  raceGatePassed: boolean;
  crossPlatformPassed: boolean;
  promoted: boolean;
}
```

## Promotion rule

Promotion may not occur if:

```text
releaseReady == false
```

or:

```text
security/race/cross-platform gates red
```

Even if benchmark quality improved.

## Required tests

1. better benchmark + red security → no promotion;
2. better benchmark + stale SHA → no promotion;
3. better benchmark + green release → promotable;
4. missing paired cases → hard fail;
5. stub-mode result cannot be labeled real-model superiority.

## Acceptance criteria

- Champion remains evidence-gated;
- current HEAD identity is included.

---

# PHASE 36-12 — Zero-Red Release Candidate Gate

> Priority: P0
>
> This phase may not be marked DONE until every required gate is green.

## Required commands

At minimum:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:coverage
pnpm docs:verify
pnpm benchmark:smoke
```

Plus real project commands for:

```text
production audit
protocol conformance
security regression
race suite
chaos suite
cross-platform CI
```

If a named script does not exist, create a stable package script for it.

Recommended final scripts:

```json
{
  "test:security": "...",
  "test:race": "...",
  "test:chaos": "...",
  "test:protocol": "...",
  "release:verify": "..."
}
```

## Required final state

```text
typecheck               PASS
full tests              PASS
build                    PASS
coverage                 PASS
docs verify              PASS
benchmark smoke          PASS
production audit         PASS
protocol conformance     PASS
security                 PASS
race                     PASS
chaos                    PASS
linux CI                 PASS
windows CI               PASS
capability evidence SHA  == HEAD
release evidence SHA     == HEAD
```

And:

```text
failed required gates    0
blocked required gates   0
not-run required gates   0
known-noise exemptions   0
ignored failures         0
```

## Release verdict

Only then:

```text
Harness v5 release candidate: READY
```

Anything else:

```text
BLOCKED
```

## Required artifact

Generate:

```text
RELEASE_EVIDENCE.json
RELEASE_EVIDENCE.md
```

Suggested fields:

```ts
{
  headSha,
  generatedAt,
  dirty,
  platformEvidence,
  gates,
  capabilityAuditRef,
  championEvidenceRef?,
  releaseReady
}
```

## Acceptance criteria

- current HEAD has a complete machine-readable proof bundle;
- release verification is reproducible;
- P36-12 status is derived from gate evidence, not handwritten.

---

# PHASE 36-13 — Documentation / Handoff Truth Closure

> Priority: P2

## Update

At minimum:

```text
HANDOFF.md
plan.md
docs/architecture/session-actor.md
docs/architecture/app-server.md
docs/architecture/durability.md
docs/architecture/tool-snapshot.md
docs/migration.md
CAPABILITY_MATRIX.md
```

Add:

```text
docs/architecture/release-integrity.md
```

## release-integrity.md must explain

- release gate state model;
- why “pre-existing failure” is still release red;
- execution-backed evidence;
- SHA freshness;
- SessionActor linearizability;
- SDK stream truth;
- security shell-composition policy;
- capability durability semantics.

## Handoff rules

HANDOFF must contain:

```text
Current HEAD
Dirty tree?
Exact gate commands
Exact gate results
Known limitations
Deferred work
```

If release not green, first line must say:

```text
Release status: BLOCKED
```

Do not bury it under prose.

## Acceptance criteria

- docs agree with executable evidence;
- no “DONE” section contradicts red gate output.

---

# 4. MANDATORY CODE-LEVEL INVARIANTS

These invariant IDs should appear in tests.

---

## INV-P36-001 — Session Turn Admission Linearizability

```text
per SessionActor:
successful concurrent execution ownership <= 1
```

including the `runtime.startTurn()` await window.

---

## INV-P36-002 — Single Actor Per Loaded Manager Session

```text
concurrent load(id) calls
→ same SessionActor identity
```

---

## INV-P36-003 — SDK Public Stream Independence

```text
consume(events) concurrently with await done
→ no event loss, no deadlock
```

---

## INV-P36-004 — SDK Reducer Truth

```text
done result
==
reduction of the exact event sequence exposed for that run
```

---

## INV-P36-005 — Plain Allowlist Cannot Authorize Shell Composition

```text
argv/glob allow rule
!=
shell composition authority
```

---

## INV-P36-006 — Canonicalization Ambiguity Fails Closed

```text
cannot prove canonical path
→ deny
```

---

## INV-P36-007 — Execution Evidence Is HEAD-Bound

```text
tested/benchmarked claim
requires passing execution evidence for current HEAD
```

---

## INV-P36-008 — Actual Durability Is Not Profile Requirement

```text
actualDurability
independent from
requiredDurability
```

---

## INV-P36-009 — Release Success Is Conjunctive

```text
releaseReady
==
ALL(required gates == passed)
```

---

## INV-P36-010 — No Known-Noise Release Exception

```text
failed gate + reason "known noise"
still means
releaseReady == false
```

---

# 5. REQUIRED ADVERSARIAL TEST MATRIX

## Concurrency

```text
100 simultaneous actor.startTurn
100 simultaneous manager.load
start + close
start + cancel
run + steer
run + queue
queue + close
two sessions concurrent
```

## SDK

```text
events + done together
slow events consumer
done only
events only
abort before first event
abort mid-stream
server failure
server EOF without terminal
duplicate terminal
large event burst
```

## Process security

```text
git status; echo pwned
git status && whoami
git status || true
git status | sh
git status $(whoami)
git status `whoami`
git status\nwhoami
git status > out
cmd /c dir & whoami
powershell -Command "Get-ChildItem; whoami"
```

## Filesystem security

```text
../ escape
non-existent tail + ..
symlink escape
junction escape where applicable
EACCES
EPERM
ELOOP
deep path limit
UNC
drive-letter path
case-folded collision
```

## Evidence

```text
test file exists but no execution
stale SHA
failed run
malformed JSON
missing evidence
benchmark cases exist but never executed
```

---

# 6. EXACT IMPLEMENTATION ORDER

Use this order:

```text
P36-0 baseline truth
  ↓
P36-1 release truth model
  ↓
P36-2 SessionActor linearizability
  ↓
P36-3 manager single-flight
  ↓
P36-4 SDK stream closure
  ↓
P36-5 process security
  ↓
P36-6 path fail-closed
  ↓
P36-7 execution evidence
  ↓
P36-8 audit/durability semantics
  ↓
P36-9 race/chaos stabilization
  ↓
P36-10 cross-platform matrix
  ↓
P36-11 champion evidence binding
  ↓
P36-12 zero-red release gate
  ↓
P36-13 docs/handoff
```

Do not mark P36-12 DONE before P36-9 and P36-10 are green.

---

# 7. CODING AGENT TASK PROCEDURE

For every subtask:

## Step A — Source audit

Before editing:

1. identify production callers;
2. identify public exports;
3. identify tests;
4. identify current failure;
5. identify architecture constraints;
6. identify platform differences;
7. write a short task implementation note.

## Step B — Add failing regression test first where practical

The test should reproduce the bug before the production fix.

For race bugs, use deterministic gates.

## Step C — Minimal production fix

Do not refactor unrelated modules.

## Step D — Focused verification

Run:

```text
target unit tests
target integration tests
target security/race tests
typecheck for affected packages
```

## Step E — Cross-module verification

Run all directly affected packages.

## Step F — Full verification

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
```

For security/release tasks also run:

```bash
pnpm test:coverage
pnpm docs:verify
pnpm benchmark:smoke
```

and P36 dedicated suites.

## Step G — Only then update status

Each task update must include:

```text
Status:
Implementation:
Files changed:
Regression test:
Integration test:
Security impact:
Concurrency impact:
Windows:
Linux:
Full typecheck:
Full tests:
Build:
Coverage:
Notes:
```

Do not write `DONE` while required fields are red.

---

# 8. STATUS DEFINITIONS

## DONE

All task acceptance criteria pass.

## BLOCKED

A required dependency or gate is red.

Must include exact blocker.

## IN_PROGRESS

Implementation underway.

## NOT_STARTED

No production work started.

Forbidden status labels:

```text
DONE_WITH_NOISE
MOSTLY_DONE
FUNCTIONALLY_DONE
PASS_EXCEPT
GREEN_ENOUGH
```

---

# 9. RELEASE EVIDENCE FORMAT

Recommended:

```json
{
  "schemaVersion": 1,
  "headSha": "...",
  "dirty": false,
  "generatedAt": "...",
  "gates": [
    {
      "id": "typecheck",
      "command": "pnpm typecheck",
      "state": "passed",
      "exitCode": 0,
      "headSha": "...",
      "artifactRef": ".ci/release/typecheck.log"
    }
  ],
  "releaseReady": true
}
```

Rule:

```text
releaseReady=true
requires
every required gate state=passed
```

---

# 10. DEFINITION OF P36 COMPLETE

P36 is complete only if all are true:

## Runtime ownership

- [ ] simultaneous actor start is linearizable
- [ ] manager load is single-flight
- [ ] close/cancel cannot leave late-started turn
- [ ] same session max active execution is 1
- [ ] different sessions can execute concurrently

## SDK

- [ ] `events` + `done` usable together
- [ ] no single-consumer caveat
- [ ] no deadlock
- [ ] same ordered event truth
- [ ] abort reaches server
- [ ] unexpected EOF not silently completed

## Security

- [ ] glob cannot authorize shell composition
- [ ] argv extension still works
- [ ] POSIX operators tested
- [ ] CMD operators tested
- [ ] PowerShell operators tested
- [ ] ambiguous path canonicalization denies
- [ ] symlink/junction escape tested

## Audit

- [ ] static existence separated from executed proof
- [ ] execution evidence bound to HEAD
- [ ] actual durability modeled separately
- [ ] profile requirement satisfaction explicit
- [ ] docs claim status separate from release status
- [ ] stale evidence rejected

## Release

- [ ] typecheck PASS
- [ ] full tests PASS
- [ ] build PASS
- [ ] coverage PASS
- [ ] docs PASS
- [ ] benchmark smoke PASS
- [ ] security PASS
- [ ] protocol PASS
- [ ] race PASS
- [ ] chaos PASS
- [ ] Linux CI PASS
- [ ] Windows CI PASS
- [ ] current HEAD evidence complete
- [ ] no known-noise exemptions
- [ ] releaseReady true

---

# 11. WHAT NOT TO DO AFTER P36

Do not immediately add more mechanisms.

After P36, the preferred development mode is:

```text
baseline
→ challenger
→ paired benchmark
→ security/race/release gates
→ promotion or rejection
```

New capability work should require a measurable hypothesis.

Example:

```text
Hypothesis:
memory retrieval improves verified completion on long-context tasks
without increasing false-complete rate > X
and token cost > Y
```

Then evaluate.

Do not enable a mechanism merely because it exists.

---

# 12. DEFERRED AFTER P36

Record but do not implement during P36 unless required for correctness:

- OS-level process sandbox;
- remote executor;
- plugin process isolation;
- distributed SessionActor ownership;
- multi-process lease/fencing;
- advanced benchmark statistics;
- model-provider redundancy;
- remote release evidence attestation.

---

# 13. FINAL INSTRUCTION TO THE CODING AGENT

The objective of P36 is not to add more architecture.

The objective is to make the following statements **mechanically true**:

```text
1. A session has one live execution owner, including across await boundaries.

2. Loading the same session concurrently cannot create two actors.

3. SDK users may consume events and await done at the same time without stealing events.

4. A normal command allowlist cannot authorize shell composition.

5. A filesystem decision is denied when canonical identity cannot be proven.

6. The capability matrix can distinguish source existence from executed proof.

7. In-memory durability is never labeled durable merely because a profile does not require durability.

8. “audit OK” cannot be confused with “release ready”.

9. A failed or not-run required gate can never produce releaseReady=true.

10. Harness v5 is only called a release candidate when the entire required gate set is green on the current HEAD.
```

Do the work in order.

Add a failing regression test before the fix where practical.

Do not suppress failures.

Do not downgrade standards.

Do not call red gates noise.

Do not mark DONE early.

When P36-12 finally says:

```text
Release verdict: READY
```

that statement must be backed by current-HEAD executable evidence, not confidence, comments, or prior status text.
