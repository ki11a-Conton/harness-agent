# Harness Agent v5 — P37 Final Closure Plan

> Repository: `ki11a-Conton/harness-agent`
>
> Reviewed baseline HEAD: `7c7e2cd51b9ff656adcd4948c349625bc66deb05`
>
> Mission: **close the remaining correctness/release-integrity gaps after P36.**
>
> This is a closure-only phase. Do not add new memory/planner/delegation/plugin/MCP features.

---

# 0. Non-negotiable rules

1. **Regression test first where practical.**
2. **No `setTimeout` sleeps for concurrency correctness**; use barriers/latches/deferred promises.
3. **One authoritative ownership state** for SessionActor; do not keep patching unrelated booleans.
4. **Every SDK run must terminally settle exactly once** on success, failure, interrupt, abort, protocol error, and transport EOF.
5. **Every release command named by the verifier must actually exist.**
6. **Stale/missing/failed/wrong-kind evidence must fail closed.**
7. **Do not call a failed/not-run gate “known noise” and mark DONE.**
8. **Official release evidence must be bound to an immutable CI commit SHA**, not committed in a way that makes its own embedded HEAD stale.
9. Allowed task states: `DONE`, `BLOCKED`, `IN_PROGRESS`, `NOT_STARTED`.
10. Forbidden task states: `DONE_WITH_NOISE`, `MOSTLY_DONE`, `PASS_EXCEPT`, `GREEN_ENOUGH`.

---

# 1. Delivery map

| Task | Priority | Theme |
|---|---|---|
| P37-0 | P0 | Current baseline truth |
| P37-1 | P0 | SessionActor unified state machine |
| P37-2 | P0 | LoadedSessionManager late-resurrection closure |
| P37-3 | P0 | SDK subscribe-before-run |
| P37-4 | P0 | SDK terminal settlement |
| P37-5 | P1 | SDK bounded event buffer |
| P37-6 | P0 | Real release scripts / correct audit command |
| P37-7 | P0 | Fix evidenceFresh |
| P37-8 | P1 | Validate evidence kind |
| P37-9 | P1 | Correct durability semantics |
| P37-10 | P1 | Canonical path depth fail-closed |
| P37-11 | P1 | Single handoff truth source |
| P37-12 | P0 | CI-bound release attestation |
| P37-13 | P0 | Final zero-red release gate |

---

# P37-0 — Capture current baseline truth

## Do

Before edits, run:

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

If a script does not exist, record **MISSING**, not PASS.

Optionally store local baseline in:

```text
.ci/p37-baseline.json
```

## Acceptance

- exact HEAD captured;
- dirty state captured;
- each gate has PASS/FAIL/MISSING/NOT_RUN;
- no known-noise exemption.

---

# P37-1 — SessionActor unified admission state machine

> Invariant `INV-P37-001`:
>
> **Every operation capable of creating or executing a turn participates in the same linearizable actor ownership state.**

## Current problem

P36 added `starting`, but ownership is still fragmented across:

```text
starting
pendingRun
active
```

Known gaps:

```text
startTurn()      checks starting
runTurn()        does not consistently share starting ownership
createTurn()     does not consistently share starting ownership
drainFollowups() calls runtime.startTurn() outside common admission
```

This still allows mixed-path races.

## Required design

Replace fragmented ownership with one state:

```ts
type ActorExecutionState =
  | { kind: "idle" }
  | {
      kind: "starting";
      source: "new_turn" | "existing_turn" | "followup";
      controller: AbortController;
      requestId: string;
      turnId?: TurnId;
    }
  | {
      kind: "running";
      turn: Turn;
      controller: AbortController;
      outcome: Promise<TurnOutcome>;
    }
  | { kind: "closing" };
```

Equivalent design is allowed only if it proves the same invariant.

All of these must consult/transition the same state:

```text
startTurn
createTurn
runTurn
drainFollowups
interrupt
cancelTurn
close
status
```

No call to a runtime operation that creates/executes a turn may happen without a reservation.

## Followup drain

`drainFollowups()` must not bypass admission.

Correct shape:

```text
settle current turn
→ return actor to idle
→ reserve followup execution
→ dequeue one followup
→ create/start turn
→ promote reservation to running
```

Reserve before an awaited operation that would permit another owner to enter, or revalidate under the same state token after the await.

## Followup resolver association

Do not maintain an independent FIFO of inputs plus a separate FIFO of resolvers if direct `enqueueFollowup()` can enqueue without a resolver.

Prefer:

```ts
interface PendingFollowup {
  id: string;
  input: UserMessage;
  promptId?: PromptId;
  resolve?: (outcome: TurnOutcome) => void;
}
```

or map resolver by stable followup ID.

## Steer semantics

Decide explicitly whether steer requires a current running turn.

Recommended if steer means “inject into current run”:

```text
idle/starting → NO_ACTIVE_TURN
running       → enqueue steer
closing       → CLOSED
```

Do not leave a steer record for an unrelated future turn.

## Required regression tests

### A — `startTurn` vs `runTurn`

Block `runtime.startTurn(A)` with a deterministic latch.

While actor is `starting`, call `runTurn(B)`.

Expected:

```text
runTurn(B) → SESSION_BUSY
```

### B — `startTurn` vs `createTurn`

Same setup. Must not cross the ownership boundary.

### C — direct start vs followup drain

Block queue read/start and interleave a direct start.

Expected:

```text
max live owner = 1
```

### D — 100-way mixed race

Mix:

```text
startTurn
runTurn
createTurn
followup promotion
```

Expected:

```text
successful execution ownership <= 1
```

### E — close during starting

No late promotion.

### F — interrupt/cancel during starting

No late running turn.

### G — resolver pairing

Queue a direct followup without a resolver, then queue via `startTurn(onConflict="queue")`.

The returned promise must settle for the correct followup.

### H — steer while idle

Assert documented behavior.

## Acceptance

- one authoritative actor execution state;
- all entry paths use it;
- no followup bypass;
- no contradictory state combination;
- deterministic mixed race suite green.

---

# P37-2 — LoadedSessionManager late-resurrection closure

> Invariant `INV-P37-002`:
>
> **After `unload(id)` or `manager.close()` wins, no older in-flight load may later install an actor.**

## Current bug

Deleting:

```ts
this.loading.delete(id)
```

does not cancel the already-running `doLoad()` Promise.

An old load may later execute:

```ts
this.actors.set(id, actor)
```

after unload/close has returned.

## Required design

Use generation fencing or cancellation.

Recommended:

```ts
interface LoadingEntry {
  generation: number;
  promise: Promise<SessionActor>;
  controller: AbortController;
}

private readonly generations = new Map<SessionId, number>();
private closed = false;
```

At load:

```text
capture generation
install LoadingEntry before first await
```

Before installing actor:

```ts
if (
  this.closed ||
  currentGeneration !== capturedGeneration ||
  controller.signal.aborted
) {
  await actor.close();
  throw LOAD_CANCELLED;
}
```

At unload:

```text
increment generation
abort/await in-flight load
close installed actor
ensure nothing can install afterward
```

At manager close:

```text
closed = true
invalidate all generations
cancel/await in-flight loads
close actors
```

## Required tests

1. **true load+unload race**: block `getSession()`, unload, then release store;
2. old load cannot resurrect actor;
3. manager close during load cannot be followed by actor install;
4. generation 1 blocked → unload → generation 2 loads → release generation 1 → gen1 cannot overwrite gen2;
5. reload after unload works with new generation;
6. failure fan-out remains single-flight;
7. no leaked loading entries/controllers.

## Acceptance

```text
late actor resurrection = 0
```

---

# P37-3 — SDK subscribe before `turn/run`

> Invariant `INV-P37-003`:
>
> **The SDK subscribes before the first operation that can emit a run event.**

## Current bug

Current logical order is:

```ts
const runPromise = transport.invoke("turn/run", ...);
const hub = new RunEventHub(...);
```

The comment says subscribe-before-run, but invocation has already started.

A synchronous transport can emit before subscription.

## Required fix

Use:

```ts
const hub = new RunEventHub(
  transport,
  threadId,
  turnId,
  opts.signal,
);

const runInvocation = transport.invoke("turn/run", {
  threadId,
  turnId,
});

hub.attachRunInvocation(runInvocation);
```

or an equivalent API where subscription is definitely installed first.

## Required regression test

Create a transport whose `turn/run` handler synchronously emits:

```text
item/delta
item/completed
turn/completed
```

before returning.

Do **not** use `queueMicrotask`.

Expected:

```text
all events observed in order
done completed
```

---

# P37-4 — SDK terminal settlement for protocol errors and EOF

> Invariant `INV-P37-004`:
>
> **Every SDK run terminally settles exactly once.**
>
> Invariant `INV-P37-005`:
>
> **A resolved `{ error }` protocol response is a terminal failure.**

## Bug A — `turn/run` resolved protocol error

The transport contract returns protocol failures as:

```ts
{ error: ... }
```

without necessarily rejecting the Promise.

Do not discard the response with:

```ts
.then(() => {})
```

Inspect it:

```ts
const response = await transport.invoke("turn/run", ...);

if (response.error) {
  hub.fail({
    code: response.error.code,
    message: response.error.message,
    retryable: response.error.retryable,
  });
}
```

## Bug B — transport closes before terminal event

Do not consider “promise remains pending forever” acceptable.

Expose transport close/EOF lifecycle if necessary:

```ts
onClose(handler): () => void
```

If transport closes before a terminal turn event:

```text
done → failed
error.code = STREAM_TERMINATED_BEFORE_TURN_END
```

Suggested:

```ts
{
  status: "failed",
  error: {
    code: "STREAM_TERMINATED_BEFORE_TURN_END",
    retryable: true,
    message: "transport closed before terminal turn event"
  }
}
```

## Exactly-once settlement

Create one function:

```ts
private settleOnce(result: RunResult): void
```

Every terminal path must go through it:

```text
turn/completed
turn/failed
turn/interrupted
local abort
turn/run protocol error
turn/run rejected promise
transport EOF/close
```

Second terminal signal must not resolve twice.

## Required tests

1. resolved `{ error }` from `turn/run` → failed;
2. rejected invoke Promise → failed;
3. EOF before first event → failed;
4. EOF after delta → failed;
5. normal terminal → completed;
6. local abort → interrupted;
7. terminal then transport close → preserve terminal result;
8. duplicate terminal → settle exactly once;
9. local abort vs server interrupt race → deterministic result;
10. **remove tests where “still pending after timeout” counts as PASS**.

## Acceptance

```text
SDK hanging terminal paths = 0
```

---

# P37-5 — Bounded SDK event buffering

> Invariant `INV-P37-006`:
>
> **A slow/absent public event consumer cannot cause unbounded memory growth.**

## Current problem

Current channel is effectively:

```ts
private readonly queue: TurnEvent[] = [];
```

with no upper bound.

## Required design

For P37, prefer a bounded queue.

Example:

```ts
interface PushChannelOptions {
  maxEvents: number;
}
```

Default example:

```text
4096 events
```

When exceeded:

```text
STREAM_BUFFER_OVERFLOW
```

Run must terminally fail or apply real transport backpressure.

Do not silently drop events.

## Required tests

- slow consumer under limit → all events;
- absent consumer + over-limit burst → overflow failure;
- queue never exceeds configured bound;
- `done` still settles;
- early iterator return does not break internal reducer.

---

# P37-6 — Real release scripts and correct capability audit command

> Invariant `INV-P37-007`:
>
> **Every command declared by release verification exists and performs the intended gate.**

## Current mismatch

The release verifier names commands such as:

```text
pnpm test:protocol
pnpm test:security
pnpm test:race
pnpm test:chaos
pnpm audit
```

but the root package scripts do not expose all of them.

Also:

```text
pnpm audit
```

is package-manager dependency auditing, not Harness capability auditing.

## Required root scripts

Add real scripts using actual test paths:

```json
{
  "scripts": {
    "test:protocol": "vitest run <protocol tests>",
    "test:security": "vitest run <security tests>",
    "test:race": "vitest run <race tests>",
    "test:chaos": "vitest run <chaos tests>",
    "capability:audit": "node apps/cli/dist/main.js audit --strict",
    "release:verify": "node apps/cli/dist/main.js release verify"
  }
}
```

If desired, dependency vulnerability audit can be:

```text
deps:audit = pnpm audit
```

Do not conflate the two.

## Update release command table

Change:

```text
capability_audit → pnpm audit
```

to:

```text
capability_audit → pnpm capability:audit
```

## Required tests

- every release gate command is executable from root;
- capability audit runs Harness audit;
- no empty placeholder script;
- docs and code list the same commands.

---

# P37-7 — Fix `evidenceFresh`

> Invariant `INV-P37-008`:
>
> **Stale, missing, failed, malformed, or wrong-kind evidence can never produce `evidenceFresh=PASS`.**

## Current bug pattern

Do not compare a derived boolean with the same expression:

```text
false === false → true
```

That can make stale evidence look fresh.

## Required helper

```ts
function evidenceIsFresh(
  evidence: ExecutionEvidence | undefined,
  expectedKind: ExecutionEvidence["kind"],
  headSha: string | undefined,
): boolean {
  return (
    evidence !== undefined &&
    evidence.passed === true &&
    evidence.kind === expectedKind &&
    headSha !== undefined &&
    evidence.headSha === headSha
  );
}
```

Define exactly which claims are required for the current profile.

Recommended separate fields:

```text
declaredEvidenceFresh
requiredEvidenceFresh
```

Release readiness depends on required evidence.

## Required regression tests

1. missing → FAIL;
2. stale SHA → FAIL;
3. failed → FAIL;
4. malformed → FAIL;
5. wrong kind → FAIL;
6. current SHA + passed + correct kind → PASS;
7. one stale among many → FAIL.

The stale case must reproduce the current `false === false` bug before the fix.

---

# P37-8 — Validate execution evidence kind

> Invariant `INV-P37-009`:
>
> **A benchmark run cannot satisfy a test-run claim and vice versa.**

## Required fix

Inside `executionProven`:

```ts
if (evidence.kind !== kind) return false;
```

Do not leave:

```ts
void kind;
```

## Optional hardening

Use namespaced keys:

```text
capability:context_pipeline
benchmark:regression
gate:typecheck
```

to avoid key collisions.

## Tests

- `test_run` cannot satisfy benchmark;
- `benchmark_run` cannot satisfy integration test;
- `release_gate` cannot satisfy either;
- correct kind succeeds.

---

# P37-9 — Correct durability store mapping and level ordering

> Invariant `INV-P37-010`:
>
> **Durability is derived from the capability's own backing store and compared using explicit durability ordering.**

## Bug A — wrong backing store

Do not read `stores.approval` for every durable-required capability.

Use explicit mapping:

```ts
function backingStoreName(id, introspection) {
  switch (id) {
    case "checkpoint_store":
      return introspection?.stores.checkpoint;
    case "memory_store":
      return introspection?.stores.memory;
    case "ask_user_durable":
      return introspection?.stores.askUser;
    case "approval_durable":
      return introspection?.stores.approval;
    default:
      return undefined;
  }
}
```

Use actual introspection field names.

## Bug B — durability ordering

Define rank:

```ts
const DURABILITY_RANK: Record<DurabilityLevel, number> = {
  none: 0,
  memory: 1,
  process: 2,
  flush: 3,
  durable: 4,
};
```

Then:

```ts
satisfied =
  DURABILITY_RANK[actual] >= DURABILITY_RANK[required];
```

Review whether these levels truly represent that ordering. If naming is semantically wrong, fix naming.

## Remove misleading legacy boolean

Prefer deleting:

```ts
durable: boolean
```

or rename to:

```ts
durabilityRequirementSatisfied
```

Do not render:

```text
durable=true (none/none/true)
```

because readers will interpret it as actual durable persistence.

## Required tests

- approval uses approval store;
- checkpoint uses checkpoint store;
- memory uses memory store;
- ask-user uses askUser store;
- `process < durable`;
- `flush < durable` unless contract explicitly says otherwise;
- actual durable + required durable → true;
- profile requirement does not overwrite actual store property.

---

# P37-10 — Canonicalization depth exhaustion fails closed

> Invariant `INV-P37-011`:
>
> **Ancestor depth exhaustion never returns a potentially non-canonical path.**

## Current problem

After the ancestor walk cap, do not:

```ts
return current;
```

## Required fix

Throw:

```ts
throw new CanonicalizationFailed(
  "depth",
  p,
  "ancestor resolution exceeded maximum depth",
);
```

## Deterministic error testing

Avoid OS-dependent “maybe permission denied” tests.

If necessary, inject:

```ts
interface CanonicalFs {
  realpath(path: string): string;
}
```

Production uses `realpathSync`.

Tests can deterministically throw:

```text
ENOENT
ENOTDIR
EACCES
EPERM
ELOOP
EIO
UNKNOWN
```

## Required tests

- ENOENT fallback works;
- ENOTDIR fallback works;
- EACCES deny;
- EPERM deny;
- ELOOP deny;
- EIO deny;
- unknown deny;
- depth exhaustion deny;
- sandbox maps canonicalization failure to filesystem deny;
- capability guard uses identical semantics.

---

# P37-11 — One canonical handoff truth source

> Invariant `INV-P37-012`:
>
> **There is exactly one authoritative current-state handoff document.**

## Current issue

Do not maintain contradictory:

```text
HANDOFF.md
HANDOVER.md
```

with different current release states.

## Required action

Recommended:

```text
HANDOFF.md = canonical
```

Then either delete `HANDOVER.md` or make it only:

```text
Deprecated: see HANDOFF.md.
```

## HANDOFF must contain

```text
Release status
Release target SHA
Source HEAD
Working tree state
Exact gate commands
Exact gate results
Linux result
Windows result
CI run/artifact/check references
Known limitations
Deferred work
```

If not green:

```text
Release status: BLOCKED
```

Update `plan.md` statuses too; do not leave final checkboxes untouched while another doc says complete.

---

# P37-12 — CI-bound official release attestation

> Invariant `INV-P37-013`:
>
> **Official release evidence is generated for an immutable commit SHA after checkout and attached externally to that SHA.**

## Problem

Tracked evidence containing:

```text
gitSha=A
```

becomes stale when committing it creates:

```text
HEAD=B
```

Do not try to solve this by repeatedly regenerating and committing the evidence.

## Required CI architecture

```text
checkout SHA H
    ↓
verify-linux
verify-windows
coverage
protocol
security
race
chaos
benchmark-smoke
capability-audit
    ↓
release-attestation
```

`release-attestation` depends on all required jobs.

If any required job fails/missing:

```text
READY attestation must not be generated
```

## Official artifact

Generate after all gates:

```json
{
  "schemaVersion": 1,
  "headSha": "<GITHUB_SHA>",
  "generatedAt": "...",
  "gates": [...],
  "releaseReady": true
}
```

Upload as:

```text
release-evidence-<sha>
```

GitHub check/status should also be bound to that SHA.

## CAPABILITY_MATRIX

Choose one:

1. tracked matrix is informational only and does not claim official current-HEAD attestation; or
2. authoritative matrix is generated as CI artifact.

Do not keep a tracked file claiming `evidenceFresh=PASS` when its embedded SHA is stale after commit.

## Tests

- stale local evidence rejected;
- exact CI SHA accepted;
- missing one required gate prevents READY;
- artifact SHA equals CI SHA;
- dirty local tree cannot claim official release.

---

# P37-13 — Final zero-red release gate

P37 cannot be marked DONE before these commands all execute and pass:

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

Required CI:

```text
Linux PASS
Windows PASS
official release attestation READY
```

Final required state:

```text
typecheck                  PASS
full tests                 PASS
build                       PASS
coverage                    PASS
docs                        PASS
benchmark smoke             PASS
protocol                    PASS
security                    PASS
race                        PASS
chaos                       PASS
capability audit            PASS
release verify              PASS
Linux CI                    PASS
Windows CI                  PASS
release attestation         READY

missing release scripts     0
failed required gates       0
not-run required gates      0
known-noise exemptions      0
late actor resurrection     0
mixed actor double-owner    0
SDK hanging terminal paths  0
unbounded SDK queues        0
stale evidence accepted     0
wrong-kind evidence         0
conflicting handoff docs    0
```

---

# 2. Mandatory invariant IDs

Use these IDs in tests/comments:

```text
INV-P37-001  Unified SessionActor ownership state
INV-P37-002  No manager late-load resurrection
INV-P37-003  SDK subscribe-before-run
INV-P37-004  SDK exactly-one terminal settlement
INV-P37-005  Protocol `{error}` is terminal
INV-P37-006  Bounded SDK event buffering
INV-P37-007  Release commands exist and mean what they say
INV-P37-008  Stale evidence cannot be fresh
INV-P37-009  Evidence kind matches claim
INV-P37-010  Durability uses capability's own store
INV-P37-011  Canonicalization depth fails closed
INV-P37-012  One canonical handoff
INV-P37-013  Official attestation bound to immutable CI SHA
```

---

# 3. Required adversarial matrix

## Actor

```text
startTurn vs startTurn
startTurn vs runTurn
startTurn vs createTurn
startTurn vs followup drain
runTurn vs followup drain
close during starting
cancel/interrupt during starting
resolver association mismatch
steer while idle
100-way mixed admission
```

## Manager

```text
100 simultaneous load
blocked load + unload
blocked load + manager.close
gen1 blocked → unload → gen2 load → release gen1
failure fan-out
retry after failure
```

## SDK

```text
synchronous event during turn/run invoke
resolved protocol error
rejected run promise
EOF before first event
EOF after delta
terminal then EOF
duplicate terminal
abort vs terminal
slow consumer
absent consumer
buffer overflow
events + done concurrently
```

## Audit

```text
missing evidence
stale SHA
failed evidence
malformed evidence
wrong evidence kind
one stale among many
checkpoint store mismatch
memory store mismatch
ask-user store mismatch
approval store mismatch
durability rank mismatch
```

## Filesystem

```text
ENOENT
ENOTDIR
EACCES
EPERM
ELOOP
EIO
unknown error
depth cap
symlink escape
junction escape where applicable
```

---

# 4. Exact implementation order

```text
P37-0 baseline
  ↓
P37-1 actor state machine
  ↓
P37-2 manager resurrection
  ↓
P37-3 SDK subscription ordering
  ↓
P37-4 SDK terminal settlement
  ↓
P37-5 bounded SDK buffer
  ↓
P37-6 release scripts
  ↓
P37-7 evidenceFresh
  ↓
P37-8 evidence kind
  ↓
P37-9 durability
  ↓
P37-10 canonical depth
  ↓
P37-11 handoff truth
  ↓
P37-12 CI attestation
  ↓
P37-13 final gates
```

Do not jump directly to P37-13 and hand-edit evidence.

---

# 5. Per-task status format

Every task update must contain:

```text
Status:
Invariant:
Implementation:
Files changed:
Regression test:
Production-path integration test:
Concurrency impact:
Security impact:
Linux:
Windows:
Focused tests:
Full typecheck:
Full tests:
Build:
Coverage:
Release impact:
Remaining blockers:
```

---

# 6. Final instruction to the coding agent

This should be the final closure pass before benchmark-driven evolution.

Do not add features.

Close the invariants.

Prefer:

```text
one actor owner
one manager generation
one SDK terminal settlement
one release command surface
one evidence truth model
one handoff truth source
one immutable CI release attestation
```

When P37 is genuinely green, stop architecture-closure work and return to:

```text
baseline
→ challenger
→ paired benchmark
→ security/race/cost gates
→ promotion or rejection
```

Only mark P37 complete when the current release target has executable, immutable, zero-red evidence.

---

# P37 COMPLETED — Final Closure (all 14 tasks)

- P37-0 baseline captured; P37-1 unified actor state machine; P37-2 manager generation fencing; P37-3/4/5 SDK subscribe-before-run + terminal settlement + bounded buffer; P37-6 real release scripts; P37-7/8 evidence freshness + kind validation; P37-9 durability store mapping; P37-10 canonical depth fail-closed; P37-11 single handoff (HANDOFF.md); P37-12 CI release attestation job added; P37-13 zero-red gates.
- Full suite: 248 files, 4805 tests passed, 0 failed. typecheck/build/docs/production-audit/coverage PASS. release:verify READY.
- Evidence: .ci/p37-baseline.json; .ci/evidence/*.json
