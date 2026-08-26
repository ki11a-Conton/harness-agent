# Harness Agent v5 — P38.3 / RC-M1 Final Hardening Plan

> Repository: `ki11a-Conton/harness-agent`  
> Reviewed baseline HEAD: `27f7045edc6e87de1f6ce81a70ceab64a5d4560b`  
> Phase type: **Final maintenance / correctness hardening**  
> Architecture status before this phase: **Runtime Release Closure substantially complete**  
> This phase is **NOT P39** and MUST NOT expand the architecture.  
> Target outcome: close the remaining crash-consistency, evidence-reduction, cancellation-truth, and benchmark-provenance gaps, then freeze Runtime architecture.

---

# 0. Executive directive

This plan is intentionally narrow.

The repository has already reached a point where the core Runtime / SDK / CI / Release pipeline is substantially closed. The current HEAD has green Linux, Windows, coverage, race, chaos, security, capability audit, benchmark smoke and release-attestation jobs.

Therefore this phase MUST NOT introduce another broad redesign.

The only allowed work is:

1. close the final durable followup exactly-once crash window;
2. make promoted-followup reconciliation reachable in production;
3. make multi-platform release evidence validation instance-correct before aggregation;
4. make `release-attestation` job status agree with `runtimeReleaseReady`;
5. make cancellation API semantics truthful about request acceptance vs durable terminal truth;
6. remove or rename weak historical race tests that overclaim invariants;
7. make benchmark manifests describe the effective runtime/challenger wiring actually executed;
8. persist sanitized summaries from the already-completed full benchmark without requiring a paid rerun;
9. run a final zero-red Runtime RC gate;
10. declare architecture freeze after all invariants below are proven.

Do **not** add new memory systems, planning systems, delegation strategies, tool-selection architectures, MCP layers, agent roles, background schedulers, reflection engines, or new benchmark challengers in this phase.

---

# 1. Baseline truth

## 1.1 Exact baseline

All work in this plan starts from:

```text
27f7045edc6e87de1f6ce81a70ceab64a5d4560b
```

The implementation agent MUST record the actual starting HEAD before modifying files.

Required first command:

```bash
git rev-parse HEAD
```

If the starting HEAD differs from the reviewed baseline, do not stop. Instead:

1. record the actual HEAD in the execution report;
2. inspect the intervening diff;
3. determine whether each issue in this plan is already fixed;
4. skip only tasks whose invariant is already fully satisfied by production code **and deterministic regression tests**;
5. never mark a task DONE only because a commit message claims it is done.

## 1.2 Baseline release state

The current release pipeline already has the following intended structure:

```text
Ubuntu verify
Windows verify
Coverage
    ↓
per-gate evidence
    ↓
release-attestation
    ↓
release verify
    ↓
runtimeReleaseReady
```

This architecture is to be retained.

The purpose of P38.3 is to remove the remaining semantic gaps inside that structure, not replace it.

---

# 2. Non-goals

The following are explicitly OUT OF SCOPE.

- No P39 architecture phase.
- No large refactor of `AgentRuntime`.
- No new provider abstraction.
- No new planner.
- No new memory retrieval algorithm.
- No new delegation topology.
- No new MCP generation model.
- No new tool router design.
- No replacement of the SDK protocol.
- No paid benchmark rerun merely to satisfy this plan.
- No requirement to improve benchmark score in this phase.
- No forced promotion of any challenger.
- No threshold gaming.
- No weakening of security/race/coverage gates.
- No deletion of valid failure evidence to make release green.

The already-completed full benchmark should be **preserved and summarized**, not automatically rerun.

---

# 3. P38.3 mandatory invariants

Every invariant below is release-blocking for this phase.

## INV-P38.3-001 — Followup durable identity before execution

A durable followup prompt MUST be bound to exactly one durable `TurnId` before that turn is allowed to begin model/tool execution.

Forbidden ordering:

```text
create turn T
→ run T
→ bind prompt → T
```

Required ordering:

```text
reserve prompt P
→ create durable turn T
→ durably bind P → T
→ establish executable ownership for T
→ run T
```

A crash after turn creation but before binding may leave an orphan non-executed turn, but MUST NOT permit duplicate side effects.

---

## INV-P38.3-002 — One prompt, one execution lineage

For every durable followup prompt `P`:

```text
P.promotedTurnId ∈ {undefined, exactly one TurnId}
```

Once `promotedTurnId = T` is durably recorded:

- no restart may create `T2` for the same prompt;
- no hydration may enqueue that prompt as a new pending followup;
- recovery/reconciliation must follow the lineage of `T`.

---

## INV-P38.3-003 — Promoted recovery is reachable

Production recovery MUST actually observe promoted prompts.

It is invalid to write:

```ts
if (prompt.status === "promoted") { ... }
```

when the preceding store API only returns `status === "pending"`.

The recovery API must explicitly expose recoverable states.

---

## INV-P38.3-004 — Ack failure never causes duplicate execution

If the prompt has already been bound to `TurnId = T`, then failure of the later consumed/ack step MUST NOT requeue or create another turn.

Recovery must reconcile against `T`.

---

## INV-P38.3-005 — Release evidence validated before aggregation

Every individual gate evidence instance MUST be validated against:

- exact immutable HEAD SHA;
- canonical command;
- required evidence schema/kind;
- expected gate id;
- expected platform namespace;
- passing exit status;

**before** multiple platform instances are aggregated into a single gate verdict.

A valid Linux result MUST NOT hide stale or malformed Windows evidence.

---

## INV-P38.3-006 — Required platform set is explicit

For every release gate, the verifier MUST know which platform instances are required.

Examples:

```text
typecheck       linux + windows
test            linux + windows
build           linux + windows
security        linux + windows
race            linux + windows
chaos           linux + windows
coverage        coverage/ubuntu only
```

Two Linux instances MUST NOT be accepted as equivalent to Linux + Windows.

---

## INV-P38.3-007 — Attestation job truth equals artifact truth

If:

```json
"runtimeReleaseReady": false
```

then the GitHub Actions `release attestation` job MUST fail.

A green release-attestation job MUST imply:

```text
runtimeReleaseReady = true
```

---

## INV-P38.3-008 — Cancellation API names its semantics truthfully

A cancellation request accepted before durable terminalization MUST NOT be exposed as if final durable cancellation has already been proven.

The API must distinguish:

```text
request accepted
```

from:

```text
durable terminal status = cancelled
```

and from:

```text
cancellation persistence uncertain
```

---

## INV-P38.3-009 — No overclaiming race test

A test whose only assertion is eventual idle state MUST NOT claim to prove historical max execution concurrency.

Tests named as single-owner / max-concurrency invariants must directly instrument the runtime execution seam.

---

## INV-P38.3-010 — Benchmark manifest describes effective wiring

Every real benchmark report MUST allow a reviewer to determine the actual effective runtime configuration that produced the result.

The configuration identity must include at minimum:

- candidate/challenger id;
- schema advertisement mode;
- memory wiring;
- delegation/subagent wiring;
- scheduler wiring;
- MCP wiring;
- effective model-visible tool set or a deterministic hash of it;
- context policy;
- relevant recovery policy;
- provider/model/temperature;
- git SHA;
- suite version and judge version.

---

## INV-P38.3-011 — Full benchmark evidence may be imported without rerun

The user already completed the paid full benchmark.

This plan MUST NOT require rerunning it if the existing report files are available locally.

Instead:

```text
existing raw benchmark results
→ validate manifest/provenance
→ sanitize
→ generate immutable summary
→ commit summary only
```

If raw results are unavailable, report `benchmark summary import not possible` rather than spending API money automatically.

---

## INV-P38.3-012 — Runtime release and champion promotion remain separate

Runtime release readiness MUST continue to be provable using free deterministic gates.

Champion quality/promotion remains a separate real-model evaluation concern.

The final Runtime release attestation MUST NOT become dependent on paid API availability.

---

# 4. Delivery map

| Phase | Priority | Goal |
|---|---:|---|
| P38.3-0 | P0 | Capture current baseline and existing full benchmark evidence |
| P38.3-1 | P0 | Split followup promotion into durable bind vs consume |
| P38.3-2 | P0 | Bind followup before execution starts |
| P38.3-3 | P0 | Make promoted reconciliation reachable |
| P38.3-4 | P0 | Crash/restart exactly-once regression suite |
| P38.3-5 | P0 | Per-instance release evidence validation |
| P38.3-6 | P0 | Required platform-set verification |
| P38.3-7 | P0 | Release-attestation job truthfulness |
| P38.3-8 | P1 | Cancellation API semantic cleanup |
| P38.3-9 | P1 | Race-test truth cleanup |
| P38.3-10 | P1 | Benchmark effective-wiring manifest |
| P38.3-11 | P1 | Import/sanitize existing 84-case benchmark summary |
| P38.3-12 | P1 | Benchmark measurement vs quality-gate separation |
| P38.3-13 | P0 | Final zero-red Runtime RC gate |
| P38.3-14 | P0 | Architecture freeze / handoff truth |

---

# 5. P38.3-0 — Baseline truth and benchmark evidence discovery

## Purpose

Do not modify behavior before recording the real starting state.

## Do

Record:

```text
git HEAD
working tree status
Node version
pnpm version
current CI workflow definition
current package scripts
current full benchmark files available locally
```

## Commands

```bash
git rev-parse HEAD
git status --short
node --version
pnpm --version
cat package.json
```

Search for existing benchmark outputs, including ignored paths:

```bash
find .ci benchmarks -type f \
  \( -name '*.json' -o -name '*summary*.md' \) \
  2>/dev/null | sort
```

On Windows-compatible execution, use a Node script rather than relying solely on GNU `find`.

## Produce

Create a temporary execution note, for example:

```text
.ci/p38.3/baseline.json
```

It should include:

```json
{
  "phase": "P38.3",
  "startingHead": "...",
  "dirty": false,
  "existingFullBenchmark": {
    "found": true,
    "files": []
  }
}
```

This is local evidence; it does not need to be committed.

## Verify

- Starting HEAD recorded.
- Existing benchmark results discovered before any optional rerun is considered.
- No paid benchmark command executed in this phase automatically.

---

# 6. P38.3-1 — Split followup durable bind from final consume

## Problem

The current queue API combines:

```text
bindPromotion(promptId, turnId)
+
markConsumed(promptId)
```

inside:

```ts
completePromotion(id, turnId)
```

This makes it difficult to establish the correct crash-safe ordering.

## Target state machine

Use explicit phases:

```text
pending
  ↓ reserve
reserved (ephemeral actor state)
  ↓ create durable Turn T
pending + Turn T exists
  ↓ bindPromotion(P,T)
promoted(P→T)
  ↓ begin execution of T
promoted(P→T), running/terminal T
  ↓ terminal reconciliation
consumed(P→T)
```

## Required API shape

Prefer evolving `SessionInputQueue` from:

```ts
reservePendingFollowup()
completePromotion(id, turnId)
releasePromotion(id)
```

into something semantically explicit such as:

```ts
reservePendingFollowup(): Promise<ReservedFollowup | undefined>;

bindReservedFollowup(
  reservationId: string,
  turnId: TurnId,
): Promise<void>;

completeReservedFollowup(
  reservationId: string,
): Promise<void>;

releaseReservedFollowup(
  reservationId: string,
): Promise<void>;
```

Alternative names are allowed, but the two durable steps MUST remain separate:

```text
BIND != CONSUME
```

## Files likely involved

```text
packages/core/src/runtime/session-actor.ts
packages/contracts/src/inbox.ts
packages/session/src/inbox.ts
packages/session/src/*.test.ts
packages/core/src/runtime/session-actor.test.ts
```

Also update every test double implementing `InboxStore` / `SessionInputQueue`.

## Implementation requirements

### bind step

Must durably establish:

```ts
prompt.status = "promoted";
prompt.promotedTurnId = turnId;
prompt.promotedAt = now;
```

### consume step

Must only transition an already-bound prompt:

```ts
promoted → consumed
```

A consume call on a pending unbound prompt should fail closed or be explicitly rejected by invariant checks.

### idempotence

`bindPromotion(id, sameTurnId)` should be idempotent if feasible.

`bindPromotion(id, differentTurnId)` MUST fail closed.

Example:

```text
P already bound to T1
bindPromotion(P, T1) → OK/idempotent
bindPromotion(P, T2) → PROMOTION_CONFLICT
```

This prevents accidental lineage rewrite.

## Tests

### Test 1 — same identity is idempotent

```text
bind(P,T1)
bind(P,T1)
→ promotedTurnId == T1
```

### Test 2 — conflicting identity rejected

```text
bind(P,T1)
bind(P,T2)
→ typed failure
→ still T1
```

### Test 3 — consume requires correct lineage

```text
pending P
consume P
→ reject OR explicit invariant failure
```

### Test 4 — consumed preserves promotedTurnId

```text
bind(P,T1)
consume(P)
→ status consumed
→ promotedTurnId T1 retained
```

## Done when

The codebase has an explicit durable linearization operation:

```text
PromptId → TurnId
```

that is independently testable from final consumption.

---

# 7. P38.3-2 — Bind durable followup identity before execution starts

## Problem

Current ordering allows:

```text
create T
→ promoteToRunning(T)
→ runtime.runTurn(T)
→ bind P→T
```

A process crash between `runTurn` and `bind` may leave `P` pending even though `T` has executed side effects.

## Required ordering

Refactor `drainFollowups()` into:

```text
1. reserve actor slot
2. reserve followup P
3. create durable Turn T
4. revalidate actor reservation
5. bind P → T durably
6. revalidate actor reservation
7. promote T to running / invoke runtime.runTurn
8. when T terminal, mark P consumed
9. settle waiting caller exactly once
```

## Critical rule

There MUST be no call path where:

```ts
runtime.runTurn(...)
```

is reached before the durable prompt-to-turn binding completes successfully.

## Recommended code structure

Do not overload `promoteToRunning()` with persistence.

Keep responsibilities clear:

```ts
const turn = await runtime.startTurn(...);

await queue.bindReservedFollowup(entry.id, turn.id);

assertReservationStillOwned();

const handle = this.promoteToRunning(turn, controller);
```

Then terminal settlement:

```ts
void handle.outcome.then(
  async outcome => {
    await queue.completeReservedFollowup(entry.id);
    settleFollowup(...);
  },
  async err => {
    // terminal lineage still belongs to T
    // reconcile consumption according to durable turn truth
    ...
  }
);
```

## Important failure semantics

### runtime.startTurn fails before T exists

```text
P remains pending
→ release reservation
→ caller rejects FOLLOWUP_PROMOTION_FAILED
```

### bind fails

```text
T exists but MUST NOT execute
P remains pending or uncertain according to store result
→ no runtime.runTurn(T)
```

Do not silently create another turn in the same attempt.

A created-but-unbound turn may be orphaned and should be detectable via diagnostics; duplicate side effects are worse than an orphan record.

### cancellation after bind but before execution

```text
P promoted → T
T has not executed
```

Recovery must continue to regard `T` as P's only lineage.

If the actor decides not to run it, T must be terminalized consistently rather than creating T2.

### process crash after bind, before run

On restart:

```text
P promoted → T
```

must reconcile/resume/terminalize T according to product semantics.

It must never enqueue P as a fresh prompt.

## Deterministic tests

No sleep-based correctness tests.

Use barriers/deferred promises.

### Crash Window A

Barrier after durable `startTurn`, before bind:

```text
P pending
T created
runtime.runTurn calls = 0
```

Simulate restart.

Expected:

- P may be retried because it was never bound;
- T must have zero execution/tool side effects;
- test should document orphan-turn handling.

### Crash Window B

Barrier after bind, before `promoteToRunning`:

```text
P promoted → T
runtime.runTurn calls = 0
```

Fresh actor/recovery:

- no T2 created;
- same lineage T retained.

### Crash Window C

Barrier after run starts:

Assert before allowing any completion:

```text
P.promotedTurnId === T.id
```

This directly proves INV-P38.3-001.

### Bind failure test

Force `InboxStore.bindPromotion` to reject.

Assert:

```text
runtime.runTurn call count == 0
```

and waiting caller terminally rejects.

## Done when

A model/tool execution for a drained durable followup cannot begin until the prompt has a durable `promotedTurnId`.

---

# 8. P38.3-3 — Make promoted reconciliation reachable in production

## Problem

The current hydration logic attempts to handle:

```ts
status === "promoted"
```

but obtains records using a method that only returns pending prompts.

That means the recovery branch is structurally unreachable for the production stores.

## Preferred fix

Add an explicit store API:

```ts
listRecoverable(sessionId: SessionId): Promise<AdmittedPrompt[]>;
```

Semantics:

```text
return followup prompts with:
- pending
- promoted

exclude consumed
```

If changing the store contract would cause disproportionate churn, `listAll()` may be used internally, but an explicit `listRecoverable()` is preferred because it documents recovery semantics.

## Store requirements

Implement consistently in:

```text
MemInboxStore
JSONLInboxStore
SQLite/durable InboxStore implementation if one exists
all test doubles
```

## Recovery state machine

For each recoverable followup:

### pending

```text
no promotedTurnId
→ candidate for local pending queue
```

If a pending prompt unexpectedly has `promotedTurnId`, treat it as inconsistent durable state and fail closed/reconcile, rather than generating T2.

### promoted + promotedTurnId

Load bound turn T.

#### T terminal

```text
completed / failed / cancelled
→ mark prompt consumed
```

#### T nonterminal

Do not enqueue prompt.

Record that recovery owns lineage T.

Depending on existing Runtime recovery semantics, either:

```text
resume/re-run T through existing durable turn path
```

or:

```text
leave promoted and expose recovery-needed diagnostic
```

But never create T2.

### promoted + missing promotedTurnId

This is an invalid/incomplete durable state.

Fail closed and surface diagnostic such as:

```text
PROMOTION_IDENTITY_MISSING
```

Do not requeue as a fresh pending prompt automatically.

## Tests

### Reachability test

Insert a real promoted prompt into every production store implementation.

Call the exact API used by hydration.

Assert promoted prompt is actually observed.

This test must fail against the old `listPending()` behavior.

### terminal reconcile

```text
P promoted → T
T completed
restart
→ P consumed
→ no new startTurn
```

Repeat for:

```text
failed
cancelled
```

### nonterminal reconcile

```text
P promoted → T
T pending/running/recoverable
restart
→ no requeue P
→ no T2
```

### malformed promoted record

```text
status promoted
promotedTurnId missing
```

Expected:

- typed diagnostic/failure;
- no duplicate promotion.

## Done when

The promoted recovery path is covered by tests using the same production query semantics used at runtime.

---

# 9. P38.3-4 — Crash/restart exactly-once regression suite

## Purpose

Previous tests focused on async races inside a live process.

P38.3 must add explicit crash-state-machine tests around durable followups.

## Required failure points

Inject deterministic failure/crash at all transition points:

```text
A. after enqueue/admit
B. after reserve
C. after durable Turn creation
D. after bindPromotion
E. immediately before runtime.runTurn
F. immediately after runtime.runTurn starts
G. after terminal turn persistence
H. before markConsumed
I. after markConsumed
```

## Test harness

Build a reusable deterministic fault injector.

Example shape:

```ts
type PromotionFaultPoint =
  | "after_reserve"
  | "after_turn_create"
  | "after_bind"
  | "before_run"
  | "after_run_start"
  | "after_terminal"
  | "before_consume";
```

Do not simulate crash using arbitrary `setTimeout(10)`.

Use explicit deferred barriers / throwing hooks / store wrappers.

## Core assertions for every restart test

Maintain counters:

```text
turnsCreatedForPrompt
runtimeRunCallsForBoundLineage
toolSideEffectCount
callerSettlementCount
```

Hard assertions:

```text
runtimeRunCalls before durable bind == 0
number of distinct executed TurnIds for one PromptId <= 1
caller settles <= 1
no pending followup reappears after terminal reconciliation
```

For tests whose expected semantics permit retry before bind, explicitly distinguish:

```text
multiple orphan turn records
```

from:

```text
multiple executed lineages
```

The invariant is about execution and prompt identity, not necessarily garbage-free orphan creation before the linearization point.

## Optional orphan cleanup

If simple and safe, add an orphan-turn diagnostic/cleanup path.

Do not turn this into a new distributed transaction architecture.

## Done when

Exactly-once claims are backed by crash-window tests, not comments.

---

# 10. P38.3-5 — Validate each release evidence instance before merge

## Problem

The current release reader groups evidence by gate id and may aggregate platform instances before verifying every instance's SHA/command truth.

A correct first instance can hide a stale or malformed later instance.

## Target pipeline

Required flow:

```text
read raw evidence files
    ↓
parse schema
    ↓
validate each individual evidence instance
    ↓
index by gate + platform
    ↓
check required platform set
    ↓
aggregate gate verdict
    ↓
compute release verdict
```

Forbidden flow:

```text
aggregate first
→ validate only representative/first evidence
```

## Suggested types

Introduce a distinction such as:

```ts
interface RawGateEvidence { ... }

interface ValidatedGateEvidence {
  id: RequiredGateId;
  platform: ReleasePlatform;
  state: "passed" | "failed";
  headSha: string;
  command: string;
  evidenceRef: string;
}
```

Validation function:

```ts
validateGateEvidenceInstance({
  evidence,
  expectedHead,
  expectedCommand,
  expectedGate,
  expectedPlatform,
}): ValidatedGateEvidence
```

## Per-instance validations

Require:

```text
schemaVersion supported
kind == "gate"
gate/id matches filename/content expectation
headSha == exact current HEAD
command == GATE_COMMANDS[gate]
exitCode consistent with passed/state
platform is recognized
```

Consistency examples:

```text
exitCode 0 + passed false → malformed/fail
exitCode 1 + passed true → malformed/fail
```

Do not normalize malformed evidence into PASS.

## Tests

### stale Windows hidden by valid Linux

Input:

```text
Linux PASS @ current SHA
Windows PASS @ stale SHA
```

Expected:

```text
release NOT READY
```

### wrong Windows command

```text
Linux: pnpm test
Windows: echo success
```

Expected fail.

### wrong evidence kind

Gate JSON with:

```json
{"kind":"benchmark_run"}
```

Expected fail.

### inconsistent exit code

```json
{"exitCode":1,"passed":true}
```

Expected fail.

### ordering independence

Reverse directory traversal/order.

Verdict must remain identical.

## Done when

No platform's evidence truth can disappear during aggregation.

---

# 11. P38.3-6 — Enforce required platform sets

## Problem

The verifier should not infer sufficient platform coverage merely from the number of evidence files.

## Add canonical platform policy

Keep it in one source of truth near `GATE_COMMANDS` / `REQUIRED_GATES`.

Example:

```ts
export const REQUIRED_GATE_PLATFORMS = {
  typecheck: ["linux", "windows"],
  test: ["linux", "windows"],
  build: ["linux", "windows"],
  benchmark_smoke: ["linux", "windows"],
  capability_audit: ["linux", "windows"],
  docs: ["linux", "windows"],
  protocol: ["linux", "windows"],
  security: ["linux", "windows"],
  race: ["linux", "windows"],
  chaos: ["linux", "windows"],
  coverage: ["coverage"],
} as const;
```

Naming may differ, but the policy must be explicit and testable.

## Required behavior

### missing Windows

```text
linux PASS
windows missing
→ gate NOT passed
```

### duplicate Linux

```text
linux PASS #1
linux PASS #2
windows missing
→ NOT passed
```

### unknown platform

```text
linux PASS
windows PASS
solaris PASS
```

Unknown evidence may be ignored with diagnostic or rejected, but it MUST NOT satisfy a required platform.

### red required platform

One required platform failed → aggregate failed.

## Coverage special case

Coverage currently runs on Ubuntu only.

Represent this truth explicitly rather than pretending it is cross-platform.

## Done when

Release readiness proves the intended platform matrix, not just existence of some passing files.

---

# 12. P38.3-7 — Make release-attestation job status truthful

## Problem

Current shell pattern can write:

```json
runtimeReleaseReady: false
```

without necessarily failing the Actions step.

## Required pattern

The attestation artifact should always be written, including on a negative verdict, but the job must then fail.

Example:

```bash
set +e
node apps/cli/dist/main.js release verify
VERIFY_RC=$?
set -e

if [ "$VERIFY_RC" -eq 0 ]; then
  READY=true
else
  READY=false
fi

cat > release-attestation.json <<EOF_JSON
{...}
EOF_JSON

if [ "$READY" != "true" ]; then
  echo "release attestation: NOT READY"
  exit 1
fi
```

## Important artifact rule

Ensure upload runs with:

```yaml
if: always()
```

or equivalent, so a red release verdict still leaves debuggable attestation evidence.

Recommended flow:

```text
verify step writes file and exposes rc
upload step always uploads file
final assert step fails job if rc != 0
```

This avoids losing the artifact because a prior step exited early.

## Tests / CI fixture tests

At minimum add unit tests around the reducer/CLI:

```text
all gates valid → ready=true / exit0
one required gate missing → ready=false / exit1
one platform stale → ready=false / exit1
```

And inspect workflow semantics to ensure a false verdict cannot render green.

## Done when

```text
release attestation job green
⇔
runtimeReleaseReady == true
```

---

# 13. P38.3-8 — Cancellation API truth cleanup

## Problem

A `cancelTurn()` call during a starting reservation can return `"cancelled"` before the system knows whether cancelled state can be durably persisted.

Later the corresponding run outcome can become:

```text
failed / cancellation_persistence_uncertain
```

This creates two incompatible interpretations of `"cancelled"`.

## Preferred semantic change

Change request-level result to something like:

```ts
export type CancelRequestResult =
  | "cancel_requested"
  | "not_running";
```

For an already-running turn where the method waits for terminal outcome, either:

1. return the final `TurnStatus` via a separate method/result field; or
2. standardize `cancelTurn()` as request acceptance only and let callers observe terminal state through outcome/status APIs.

Prefer one semantic model across starting and running states.

## Suggested shape

```ts
interface CancelTurnResult {
  disposition:
    | "cancel_requested"
    | "not_running";
  turnId: TurnId;
}
```

If backwards compatibility is important, add a new API/versioned protocol field and deprecate ambiguous `SessionTurnStatus` return semantics.

## Required documentation

Document:

```text
cancel request accepted != durable terminal cancellation confirmed
```

Terminal truth remains in:

```text
TurnOutcome / persisted Turn / terminal event
```

## Tests

### starting cancellation + persistence succeeds

Request result:

```text
cancel_requested
```

Final outcome:

```text
cancelled
```

### starting cancellation + persistence fails

Request result:

```text
cancel_requested
```

Final outcome:

```text
failed
statusDetail=cancellation_persistence_uncertain
```

No caller should receive an early value that claims durable terminal truth.

## Done when

The API cannot be read as “cancelled is durable” before persistence truth is known.

---

# 14. P38.3-9 — Race-test truth cleanup

## Problem

The new P38.2 race tests correctly instrument actual runtime overlap, but older tests still have names/comments that claim single-owner proof while only checking eventual idle state.

## Do

Audit tests containing phrases such as:

```text
max live owner
single owner
successful execution ownership <= 1
max concurrency
```

For each:

### If it directly instruments runtime execution

Keep it.

### If it only asserts final actor state

Either:

- rename to accurately describe admission/final-state behavior; or
- upgrade with counters/barriers; or
- delete if fully superseded by a stronger P38.2/P38.3 test.

## Required instrumentation for concurrency claims

Use:

```ts
let activeRuns = 0;
let maxActiveRuns = 0;
```

around the actual runtime execution seam.

Do not use actor API shape as a proxy for historical execution overlap.

## Timing rule

No correctness assertion may depend on:

```ts
setTimeout(..., 10)
setTimeout(..., 20)
```

Use deterministic barriers.

Polling helpers may be retained only for eventual cleanup assertions if they are not proving the race itself, and should have bounded timeout/error messages.

## Done when

Test names, comments and actual proof strength match.

---

# 15. P38.3-10 — Benchmark effective-wiring manifest

## Problem

The benchmark runner dynamically changes runtime wiring per case and per candidate, but the frozen configuration metadata does not fully encode those changes.

This weakens reproducibility and paired-comparison truth.

## Required metadata

Create an effective configuration object per run and, where required, per case.

Suggested:

```ts
interface BenchmarkEffectiveConfig {
  candidate: string | null;
  provider: string;
  model: string;
  temperature: number | null;

  context: {
    maxTokens: number;
    dynamic: number;
  };

  recovery: {
    adaptive: boolean;
  };

  mechanisms: {
    memory: boolean;
    subagent: boolean;
    scheduler: boolean;
    mcp: boolean;
    deferredSchema: boolean;
  };

  tools: string[];
  toolSetHash: string;
  runtimeConfigHash: string;
}
```

## Hash requirements

`runtimeConfigHash` must change when any meaningful execution wiring changes.

At minimum it must vary for:

```text
baseline
adaptive_recovery
memory_retrieval
tool_selector_deferred_schema
adaptive_context_policy
```

If two configs are behaviorally different but produce the same hash, the implementation is wrong.

## Stable serialization

Continue using deterministic stable serialization.

Arrays whose ordering is semantically irrelevant should be normalized before hashing.

## Per-case mechanism truth

Because some suites turn on mechanisms only when required by a case, the report must expose effective per-case wiring.

Example:

```json
{
  "caseId": "adv-mcp-injection",
  "effectiveFeatures": {
    "mcp": true,
    "memory": false,
    "subagent": false,
    "scheduler": false
  }
}
```

A run-level manifest can contain defaults, but case-level deviations must be represented.

## Tests

### candidate affects hash

```text
baseline hash != adaptive_recovery hash
baseline hash != memory_retrieval hash
```

### case mechanism affects effective config

MCP case and normal case should differ in effective feature set/tool set.

### deterministic repeat

Same exact config serialized with different JS object key insertion order → same hash.

### model/provider changes hash/provenance

Even if runtime mechanics are identical, report provenance must distinguish model/provider.

## Done when

A reviewer can reproduce or reject a benchmark comparison based on manifest truth alone.

---

# 16. P38.3-11 — Import and sanitize the already-completed full benchmark

## Purpose

The user has already paid for and completed the full benchmark.

Do not waste API budget by rerunning it merely to populate repository documentation.

## Expected suite universe

Current benchmark suites contain:

```text
regression   30
holdout      30
adversarial  13
stress       11
----------------
total        84
```

## Discovery

Look for existing outputs in likely ignored/local locations:

```text
.ci/
.ci/bench-*/
benchmarks/*summary*
custom output dirs referenced by command history
```

Do not search environment secrets or print API keys.

## Validate before import

For each found report verify:

```text
suite
case count
gitSha
model
provider
judgeVersion
suiteVersion
runtimeConfigHash or equivalent
timestamp
```

If one suite was run at a different HEAD, do not silently combine it with others as one immutable full run.

Instead record per-suite SHA truth.

## Sanitization

Do NOT commit:

- API keys;
- Authorization headers;
- raw provider request headers;
- user home paths if avoidable;
- complete prompt transcripts unless intentionally public;
- secret-containing tool outputs;
- raw `.ci/` workspace files.

Commit only sanitized summary/provenance.

## Suggested committed layout

```text
benchmarks/results/
  2026-08-26-<model-slug>/
    manifest.json
    regression-summary.json
    holdout-summary.json
    adversarial-summary.json
    stress-summary.json
    overall-summary.md
```

If the date/model differs, use the real values.

## Summary schema

Example:

```json
{
  "schemaVersion": 1,
  "releaseEvidence": false,
  "qualityEvidence": true,
  "source": "existing-real-model-run",
  "headSha": "...",
  "suite": "regression",
  "provider": "...",
  "model": "...",
  "temperature": null,
  "cases": 30,
  "passed": 0,
  "passRate": 0.0,
  "verifiedComplete": 0,
  "modelCalls": 0,
  "toolCalls": 0,
  "tokensInput": 0,
  "tokensOutput": 0,
  "estimatedCostUsd": 0,
  "terminationReasons": {},
  "failuresByCategory": {},
  "runtimeConfigHash": "...",
  "judgeVersion": "...",
  "suiteVersion": "..."
}
```

Use actual values from existing reports. Never invent zeros when data is missing; use `null` or omit the field with a documented reason.

## Overall summary

Include a table:

```text
suite | passed/cases | pass rate | verified | harness failures | infra failures | model failures | tokens | cost
```

Also include failure clustering where the report supports it:

```text
model capability
tool selection
security denial
verification failure
context/limit
infrastructure
judge
harness
```

Do not reinterpret raw failures beyond the data available.

## If no full benchmark files are available

Do not rerun automatically.

Create/update handoff with:

```text
Full benchmark was reported as completed by the operator, but no local report artifact was available to import in this checkout. No paid rerun was performed by P38.3.
```

That is truthful and acceptable.

## Done when

Existing full benchmark quality evidence is preserved in a compact, secret-safe, reviewable form if available.

---

# 17. P38.3-12 — Separate benchmark measurement from benchmark quality verification

## Principle

These are different concepts:

```text
benchmark command succeeded
```

means:

```text
measurement infrastructure ran and produced a valid report
```

It MUST NOT necessarily mean:

```text
agent quality is acceptable
```

Retain that distinction.

## Add explicit verifier

Add or formalize a command such as:

```bash
agent benchmark verify <report-or-directory>
```

or:

```bash
agent champion eval ...
```

as the quality decision layer.

Prefer comparison against a frozen champion rather than arbitrary absolute thresholds.

## Quality policy

For challenger promotion, require at least:

```text
same case set
compatible judge version
compatible suite version
provenance available
no new harness/judge/infrastructure failures
security non-regression
verified completion non-inferiority or improvement
cost/token regression bounded
```

If the project already has a `champion eval` reducer, reuse it instead of creating a duplicate quality engine.

## Do not bind to Runtime release

The free Runtime RC must remain independent from paid real-model quality testing.

The release attestation should continue to say something like:

```json
"runtimeReleaseReady": true,
"championPromotion": {
  "status": "..."
}
```

rather than making Runtime release fail due to an unavailable API key.

## Done when

The CLI/reporting language makes measurement success and quality success impossible to confuse.

---

# 18. P38.3-13 — Final zero-red Runtime RC gate

## Required local commands

Run all repository-owned free gates from a clean checkout/worktree.

At minimum:

```bash
pnpm install --frozen-lockfile
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

Where repository scripts differ, use the canonical current commands from the single source of truth.

## Release gate runner

Also run the repo-owned aggregate gate mechanism if present:

```bash
node apps/cli/dist/main.js release gate --all
node apps/cli/dist/main.js release verify
```

or the package-script equivalent.

## Environment rule

Runtime release validation must use:

```text
OPENAI_API_KEY=""
```

or equivalent explicit no-paid-key environment.

The full benchmark is NOT rerun here.

## GitHub CI

Push final candidate and require:

```text
Ubuntu verify            green
Windows verify           green
Coverage                  green
Release attestation       green
```

Then inspect the artifact and confirm:

```json
headSha == exact pushed SHA
runtimeReleaseReady == true
```

## Evidence assertions

For every required gate:

```text
required platform evidence exists
all instances exact SHA
all commands canonical
all exit codes consistent
all passed
```

## Zero-red rule

No "known noise" exception.

No release if a required free gate is:

```text
failed
missing
not run
stale
wrong command
wrong SHA
wrong platform
malformed
```

---

# 19. P38.3-14 — Architecture freeze and handoff truth

## Goal

Once P38.3 is green, stop the P-number architecture closure loop.

## Update canonical handoff

Use one authoritative document only.

Recommended top section:

```markdown
# Harness v5 Runtime Status

Architecture: FROZEN
Runtime release: READY
Release SHA: <exact SHA>
CI run: <run number / URL if repository convention permits>

Free runtime gates:
- Linux: PASS
- Windows: PASS
- Coverage: PASS
- Security: PASS
- Race: PASS
- Chaos: PASS
- Release attestation: PASS

Real-model benchmark:
- preserved separately as quality evidence
- does not gate Runtime RC
```

Move older P35/P36/P37/P38 historical commentary under:

```text
Historical / superseded
```

Do not let old warnings appear above or alongside current release truth without clear superseded labeling.

## Architecture freeze rule

After this phase, new work should follow:

```text
baseline champion
→ identify failure cluster
→ design ONE challenger
→ paired benchmark
→ security/race/cost checks
→ promote or reject
```

Do NOT open another broad closure phase unless a concrete production correctness defect requires it.

---

# 20. Required implementation details by file area

This section is a navigation map, not a mandate to edit every file.

## Session / followup

Likely:

```text
packages/core/src/runtime/session-actor.ts
packages/core/src/runtime/session-actor.test.ts
packages/contracts/src/inbox.ts
packages/session/src/inbox.ts
packages/session/src/inbox.test.ts
```

Search for:

```text
completePromotion
bindPromotion
reservePendingFollowup
releasePromotion
listPending
listAll
promotedTurnId
drainFollowups
```

## Release evidence

Likely:

```text
apps/cli/src/release-command.ts
apps/cli/src/release-verify.ts
apps/cli/src/release-*.test.ts
.github/workflows/ci.yml
```

Search for:

```text
readGateEvidence
computeReleaseVerdict
parseGateEvidence
GATE_COMMANDS
REQUIRED_GATES
platform
runtimeReleaseReady
```

## Cancellation

Likely:

```text
packages/core/src/runtime/session-actor.ts
packages/gateway/src/*
packages/sdk/src/*
packages/contracts/src/*
```

Search for:

```text
cancelTurn
SessionTurnStatus
cancelled_no_effect
cancellation_persistence_uncertain
```

## Benchmark provenance

Likely:

```text
apps/cli/src/benchmark-command.ts
apps/cli/src/champion-eval.ts
packages/evaluation/src/*
benchmarks/README.md
```

Search for:

```text
runtimeConfigForHash
runtimeConfigHash
candidate
features
manifest
suiteVersion
judgeVersion
```

---

# 21. Deterministic test requirements

P38.3 concurrency/crash correctness tests MUST follow these rules.

## Allowed synchronization

```text
Deferred Promise
Barrier
Latch
Injected store failure
Injected runtime failure
Explicit hook/fault point
AbortController
```

## Not allowed as proof

```text
sleep 10 ms and hope the race occurred
sleep 20 ms and inspect final state
loop until likely enough time passed
```

## Historical-state assertions

When proving a historical invariant, record the historical metric.

Examples:

```ts
maxActiveRuns
runTurnCalls
createdTurnIds
executedTurnIds
sideEffectCount
settlementCount
```

Do not infer history from the final object state.

---

# 22. Required negative tests

A release-quality system is not closed until the failure paths are tested.

Add/retain explicit negative tests for:

```text
bindPromotion failure
bindPromotion conflicting TurnId
consume failure
promoted prompt with missing TurnId
promoted prompt bound to unknown TurnId
stale Linux evidence
stale Windows evidence
wrong canonical command
wrong evidence kind
missing required platform
duplicate same platform
exitCode/passed contradiction
release verify false
cancel persistence failure
benchmark manifest missing candidate truth
```

Every negative test must fail closed.

---

# 23. Migration / compatibility rules

## Durable inbox schema

Adding or tightening promotion identity semantics must account for old records.

Possible legacy states:

```text
pending + no promotedTurnId
promoted + no promotedTurnId
consumed + no promotedTurnId
```

Define explicit policy.

Recommended:

### pending legacy

Treat as genuinely pending if there is no evidence it was previously promoted.

### promoted legacy without TurnId

Do NOT blindly replay.

Surface degraded/recovery-required state.

### consumed legacy

Do not replay.

No need to fabricate `promotedTurnId`.

## API compatibility

If cancellation return type changes, update:

```text
contracts
RPC schema
SDK types
CLI callers
tests
docs
```

If a hard breaking change is undesirable, introduce a versioned/new result object and deprecate ambiguous semantics.

---

# 24. Logging and diagnostics

Do not silently swallow durable inconsistencies.

At minimum surface diagnostics for:

```text
followup bind failure
followup conflicting binding
promoted prompt missing turn identity
bound turn missing from store
consume failure
release evidence wrong platform
release evidence stale SHA
release evidence wrong command
```

Use typed errors where they cross API boundaries.

`stderr [degraded]` is acceptable for best-effort cleanup paths, but release-critical state should be represented in structured result/evidence whenever possible.

---

# 25. Security constraints

The full benchmark import may contain sensitive provider/output data.

Before committing summaries:

1. scan for obvious API-key patterns;
2. exclude Authorization headers;
3. exclude raw environment dumps;
4. exclude absolute home-directory paths when not needed;
5. preserve only aggregate metrics and safe case identifiers;
6. do not commit `.ci/` wholesale.

No security gate may be weakened because adversarial benchmark quality is low.

Benchmark quality failures are not justification to relax sandbox policy.

---

# 26. Benchmark interpretation rules

When generating the full benchmark summary, classify evidence carefully.

## Infrastructure failure

Examples:

```text
provider unavailable
rate limit exhausted in a way that invalidates the case
temp workspace creation failure
harness cannot load case
```

Do not count these as model inability.

## Harness failure

Examples:

```text
runtime exception
wrong tool dispatch
internal state corruption
benchmark plumbing bug
```

These are actionable Runtime defects.

## Judge failure

Examples:

```text
verifier could not read evidence
judge exception
broken expected fixture
```

Do not count as agent quality failure.

## Model/agent failure

Examples:

```text
did not complete task
used wrong tool strategy
failed verification
false completion
ignored safe task after defending injection
```

## Security-policy behavior

Distinguish:

```text
correctly blocked harmful action
```

from:

```text
policy over-blocked a legitimate task
```

Do not optimize pass rate by suppressing security denials without case-level evidence.

---

# 27. No forced benchmark optimization in P38.3

The agent must NOT look at the full benchmark failures and then start making broad behavioral changes inside this same phase.

Why:

P38.3 is a correctness/evidence hardening phase.

Mixing benchmark optimization into it destroys causal attribution.

Correct sequence after P38.3:

```text
freeze P38.3 champion
→ inspect full benchmark failure clusters
→ choose ONE mechanism hypothesis
→ implement ONE challenger
→ paired eval
→ promote/reject
```

---

# 28. Commit discipline

Prefer small reviewable commits.

Suggested sequence:

```text
P38.3-1: split followup bind/consume lifecycle
P38.3-2: bind followup before execution
P38.3-3/4: recovery reachability + crash tests
P38.3-5/6: evidence instance/platform validation
P38.3-7: attestation job truth
P38.3-8/9: cancellation + race test truth
P38.3-10: benchmark effective manifest
P38.3-11/12: benchmark summary import + quality semantics
P38.3-13/14: final RC evidence + handoff freeze
```

Do not squash away useful phase boundaries until all validation is complete.

---

# 29. Per-task agent execution protocol

For every phase, the coding agent must follow:

## A. Inspect

Read current implementation and relevant tests.

Do not patch based only on this plan's snippets.

## B. Reproduce

Before fixing a bug, create or identify a regression test that fails on the old behavior wherever practical.

## C. Implement

Make the smallest change that enforces the invariant.

## D. Verify locally

Run the focused test file/package.

## E. Verify adjacent regressions

Run related package tests/typecheck.

## F. Record

For every completed task, record:

```text
Task:
Files changed:
Invariant proven:
Regression test added:
Focused commands:
Result:
Remaining caveats:
```

## G. Never fake completion

A task is not DONE if:

- production code changed but no regression test proves the bug;
- test only checks final state when invariant is historical;
- code comment claims exactly-once but crash window remains;
- release verifier accepts missing/stale platform evidence;
- benchmark summary contains invented values.

---

# 30. Phase-by-phase acceptance checklist

## P38.3-0

- [x] exact starting HEAD recorded (.ci/p38.3/baseline.json: 27f7045e)
- [x] working tree state recorded
- [x] existing full benchmark outputs searched
- [x] no paid rerun automatically launched

## P38.3-1

- [x] bind and consume are separate operations (bindPromotion / markConsumed)
- [x] same binding idempotent (Test 1)
- [x] conflicting TurnId rejected (Test 2, PROMOTION_CONFLICT)
- [x] consumed record retains lineage (Test 4)

## P38.3-2

- [x] bind happens before runtime execution (bind step 5 < promoteToRunning step 7)
- [x] bind failure means runTurn calls = 0 (bind failure test)
- [x] after run starts, prompt already durable-bound (Crash Window C)
- [x] waiting caller settles exactly once

## P38.3-3

- [x] hydration can actually observe promoted prompts (listRecoverable)
- [x] terminal bound turn → consume
- [x] nonterminal bound turn → no T2
- [x] malformed promoted state fails closed (PROMOTION_IDENTITY_MISSING)

## P38.3-4

- [x] deterministic crash-window matrix exists (followup-crash-matrix.test.ts, points A-I)
- [x] distinct executed TurnIds per PromptId <= 1
- [x] no sleep-based race proof

## P38.3-5

- [x] every evidence instance validated before merge (validateGateEvidenceInstance)
- [x] stale secondary platform fails
- [x] wrong command secondary platform fails
- [x] malformed evidence fails

## P38.3-6

- [x] canonical required platform map exists (REQUIRED_GATE_PLATFORMS)
- [x] missing Windows fails relevant gates
- [x] duplicate Linux cannot substitute Windows
- [x] coverage platform semantics explicit

## P38.3-7

- [x] false release verdict produces red attestation job (ci.yml fail step)
- [x] negative attestation artifact still uploaded (if: always())
- [x] green job implies runtimeReleaseReady true

## P38.3-8

- [x] cancel request semantics no longer overclaim durable state (CancelTurnResult.disposition)
- [x] persistence-uncertain path remains visible (cancellation_persistence_uncertain)
- [x] RPC/SDK types updated consistently

## P38.3-9

- [x] old overclaiming race test removed/renamed/upgraded
- [x] concurrency claims use execution-seam counters

## P38.3-10

- [x] candidate included in effective config/provenance
- [x] case mechanism wiring represented
- [x] effective tool set represented/hashable
- [x] config hash changes when behavior changes

## P38.3-11

- [x] existing 84-case reports imported if available
- [x] no paid rerun required
- [x] summaries are sanitized
- [x] missing fields not fabricated

## P38.3-12

- [x] benchmark run success distinct from quality pass
- [x] existing champion evaluator reused where possible
- [x] Runtime release stays free/API-independent

## P38.3-13

- [x] all free local gates green
- [x] typecheck, test, build, coverage, docs:verify, benchmark:smoke, protocol, security, race, chaos, capability:audit all pass locally
- [x] release gate --all regenerated evidence at HEAD 27f7045e
- [x] audit requiredEvidenceFresh=PASS (evidence at HEAD)
- [x] coverage green (pnpm test:coverage exit 0)
- [x] Linux CI green — run 32964584028 (SHA 33de85f) Ubuntu verify success
- [x] Windows CI green — run 32964584028 (SHA 33de85f) Windows verify success
- [x] attestation green — run 32964584028 release attestation success
- [x] exact SHA verified in artifact — release-evidence-33de85f attestation: headSha=33de85fa23686d082a4e67a4adbcd8b5d6276484, runtimeReleaseReady=true
- [x] CI coverage evidence template fixed — added missing kind:"gate" + platform:"coverage" (first attestation run f77b81f failed: coverage evidence lacked kind → P38.3-5 validation rejected it)

## P38.3-14

- [x] canonical handoff updated (HANDOVER.md)
- [x] architecture marked frozen
- [x] historical status clearly superseded
- [x] no P39 architecture backlog created

---

# 31. Final full audit after implementation

After every task above is complete, perform one final source audit.

Do not merely rerun tests.

Search the source for stale semantics.

## Followup audit searches

```bash
rg "completePromotion|bindPromotion|listPending|listRecoverable|promotedTurnId|drainFollowups" packages apps
```

Questions:

- Can execution start before binding anywhere?
- Can any recovery path turn promoted → pending/requeue?
- Can conflicting TurnIds overwrite lineage?
- Can a caller hang on ack/bind failure?

## Release audit searches

```bash
rg "readGateEvidence|computeReleaseVerdict|REQUIRED_GATES|GATE_COMMANDS|platform|runtimeReleaseReady" apps .github
```

Questions:

- Is every instance validated?
- Is platform identity checked?
- Is exact SHA checked?
- Is canonical command checked?
- Can `READY=false` produce green Actions?

## Cancellation audit searches

```bash
rg "cancelTurn|SessionTurnStatus|cancel_requested|cancellation_persistence_uncertain" packages apps
```

Question:

- Does any public API still claim final cancelled state before durable truth exists?

## Benchmark audit searches

```bash
rg "runtimeConfigHash|runtimeConfigForHash|candidate|features|manifest|effective" apps packages benchmarks
```

Questions:

- Is challenger identity in provenance?
- Is per-case mechanism wiring represented?
- Can two behaviorally different runs share the same claimed configuration?

---

# 32. Final required commands

Run from clean working tree candidate:

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
```

Then regenerate release evidence using the canonical mechanism and run:

```bash
pnpm release:verify
```

or the equivalent canonical CLI command.

Do not use stale `.ci/evidence` from an earlier SHA.

Before release verification:

```bash
rm -rf .ci/evidence
```

or use the repository's official clean-evidence path so old files cannot contaminate the verdict.

Then generate fresh gate evidence for the exact candidate SHA.

---

# 33. Final DONE conditions

P38.3 / RC-M1 is DONE only if every condition below is true.

```text
followup execution before durable bind                  0
followup duplicate executed lineages                    0
unreachable promoted-recovery branches                  0
conflicting prompt→turn rebinding paths                  0
unsettled queue-mode caller promises                     0
stale platform evidence accepted                         0
wrong-command platform evidence accepted                 0
missing required platform accepted                       0
duplicate platform substitution                          0
green attestation jobs with READY=false                  0
cancel APIs overclaiming durable terminal truth          0
overclaiming max-concurrency tests                       0
behaviorally-different benchmark configs same provenance 0
invented benchmark summary values                        0
paid benchmark reruns required for Runtime RC             0
failed required free release gates                       0
missing required free release gates                      0
stale required free release gates                        0
```

And:

```text
Linux CI                PASS
Windows CI              PASS
Coverage                PASS
Protocol                PASS
Security                PASS
Race                    PASS
Chaos                   PASS
Capability Audit        PASS
Benchmark Smoke         PASS
Release Verify          READY
Release Attestation     PASS
Exact SHA binding       PASS
```

---

# 34. Architecture freeze declaration

When the final DONE conditions are satisfied, write the following project-level decision into the canonical handoff/evolution document in equivalent wording:

```text
Harness v5 Runtime Architecture Closure is complete.

P38.3 / RC-M1 closed the remaining crash-consistency and release-evidence
truth gaps. Further broad P-number architecture closure phases are prohibited
without a newly discovered concrete correctness defect.

Future capability work uses the empirical evolution loop:

frozen champion
→ benchmark failure analysis
→ one challenger hypothesis
→ paired evaluation
→ security/race/cost checks
→ promote or reject
```

This declaration is important.

Without it, the project risks endlessly adding architecture instead of improving measured agent capability.

---

# 35. Next-stage operating model after P38.3

This is NOT part of P38.3 implementation, but it defines what happens next.

## Step 1 — Freeze current champion

Tag/record:

```text
git SHA
model/provider used in full benchmark
runtimeConfigHash
judgeVersion
suiteVersion
84-case summary
```

## Step 2 — Cluster failures

Rank real failures by frequency and cost.

Possible buckets:

```text
tool selection
failure to inspect before edit
verification strategy
security over-block
prompt injection handling
context exhaustion
recovery loops
false completion
provider/model errors
harness errors
judge errors
```

## Step 3 — Choose ONE hypothesis

Example:

```text
"Most verified-completion losses come from models stopping after edits without running verification."
```

Then build exactly one challenger targeting that mechanism.

## Step 4 — Paired evaluation

Same cases, same model, compatible provenance.

Compare:

```text
wins/losses/ties
verified completion
security
harness failures
tool calls
tokens
latency/cost
```

## Step 5 — Promote or reject

No forced promotion.

A cheaper but materially less reliable challenger remains rejected.

A more complex challenger without measured benefit remains rejected.

---

# 36. Final agent instruction

The coding agent executing this file must treat it as a **correctness closure contract**, not as a feature wishlist.

Primary rule:

```text
make the existing architecture's claims true
```

not:

```text
add more architecture
```

When a task is complete:

1. prove the invariant with deterministic regression tests;
2. run focused tests;
3. run adjacent tests;
4. continue to the next task without asking for confirmation;
5. after all tasks, run the final full free gate;
6. inspect final CI evidence at the exact SHA;
7. update the canonical handoff;
8. stop.

Do not declare DONE because code compiles.

Do not declare DONE because tests unrelated to the invariant are green.

Do not declare DONE because the plan text says what the implementation should do.

DONE means production behavior, deterministic tests, and release evidence all agree.

---

# 37. Final one-line target

```text
one durable PromptId → one durable TurnId → one execution lineage;
one gate instance → one validated SHA/command/platform truth;
one green attestation → one genuinely READY Runtime release;
then freeze architecture and optimize only from measured benchmark evidence.
```
