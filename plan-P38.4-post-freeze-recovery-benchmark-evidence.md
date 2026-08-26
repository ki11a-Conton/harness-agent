# Harness Agent v5 — P38.4 Post-Freeze Recovery & Benchmark Evidence Closure Plan

> **Plan type:** Post-freeze maintenance / proof closure / benchmark-evidence hardening  
> **NOT:** a new architecture phase  
> **Reviewed repository:** `ki11a-Conton/harness-agent`  
> **Reviewed baseline HEAD:** `9f5e2720dc5299de88e80c0bc88bab0449acb41d`  
> **Architecture status entering this plan:** `FROZEN`  
> **Runtime release status entering this plan:** `READY` on the reviewed exact SHA  
> **Primary objective:** close the remaining same-T crash-recovery liveness proof gap, preserve the already-frozen Runtime architecture, import the operator's completed 84-case benchmark truth without fabricating missing data, and strengthen paired-evaluation provenance so future work moves from “building Harness” to “evolving the Agent”.

---

# 0. How the coding agent must execute this plan

This file is an **execution contract**, not a suggestion list.

The coding agent must:

1. Read this entire file before making changes.
2. Record the actual starting Git HEAD.
3. Inspect the current implementation before editing.
4. Preserve the frozen Runtime architecture unless a change is strictly necessary to satisfy an invariant in this plan.
5. Do one task at a time.
6. After every task:
   - run the task-specific tests,
   - inspect the diff,
   - verify the invariant,
   - record evidence.
7. Do **not** declare a task done merely because a test passes.
8. Do **not** use tautological tests, sleep-based race tests, or assertions disconnected from the production fake/runtime under test.
9. Do **not** automatically rerun paid real-model benchmarks if already-completed local artifacts exist.
10. Do **not** fabricate benchmark counts, pass rates, costs, token totals, model names, judge versions, or SHA provenance when artifacts are absent.
11. Do **not** weaken release gates, security checks, quality gates, coverage thresholds, or existing deterministic tests to make CI green.
12. Do **not** introduce a P39-style architecture rewrite.
13. Finish with the complete release/test gate listed at the end of this document.
14. Produce a final execution report using the exact reporting format in this plan.

If any exact path in this plan has moved since the reviewed SHA, locate the symbol by code search and document the replacement path rather than creating duplicate implementations.

---

# 1. Reviewed baseline truth

The plan was written against:

```text
repository:
ki11a-Conton/harness-agent

reviewed HEAD:
9f5e2720dc5299de88e80c0bc88bab0449acb41d
```

At that reviewed SHA, the following were already considered materially complete:

```text
SessionActor single-owner model
followup reserve-before-promotion
followup durable prompt identity
followup hydration dedupe
bind-before-execute
promoted prompt recovery visibility via listRecoverable()
late-cancel reservation revocation
LoadedSessionManager stale-finally race closure
SDK live streaming
SDK terminal settlement / listener cleanup
bounded PushChannel failure semantics
canonical-path deterministic taxonomy work
strict release gate command/evidence validation
multi-platform exact-SHA release evidence
benchmark measurement vs champion quality separation
Linux CI
Windows CI
coverage
release attestation
```

Therefore **this plan must not reopen those subsystems wholesale**.

The remaining concerns are narrower:

```text
A. promoted P -> bound nonterminal T recovery proves safety,
   but same-T liveness is not yet demonstrated end-to-end.

B. full benchmark was reported completed by the operator,
   but the repository does not contain sufficient sanitized artifacts
   to verify the complete 84-case result.

C. run-level provenance exists,
   but paired comparison should make per-case effective configuration
   and controlled differences harder to misattribute.

D. HANDOVER contains volatile exact-SHA/run-id facts that become stale
   as soon as another commit is made.
```

---

# 2. Scope

## 2.1 In scope

This plan covers:

```text
P38.4-0   Freeze baseline and prove current state before edits
P38.4-1   Define same-T recovery contract for bound nonterminal followups
P38.4-2   Implement/reuse same-T recovery ownership without T2
P38.4-3   Add deterministic crash-boundary recovery tests
P38.4-4   Reconcile terminal/recovery failure paths fail-closed
P38.4-5   Import/sanitize completed 84-case benchmark artifacts
P38.4-6   Add benchmark artifact completeness + truth validation
P38.4-7   Add per-case provenance and controlled-difference hashes
P38.4-8   Strengthen champion paired comparability checks
P38.4-9   Generate truthful aggregate benchmark summary/failure clusters
P38.4-10  Remove volatile release SHA/run-id from HANDOVER static truth
P38.4-11  Add freeze guardrails / no-architecture-drift documentation
P38.4-12  Deterministic test audit for all new work
P38.4-13  Final zero-red release verification
P38.4-14  Closure declaration and handoff to benchmark-driven evolution
```

---

# 3. Non-goals

The agent must NOT use this plan as permission to:

- redesign SessionActor from scratch;
- replace the Runtime state machine;
- invent a new event-sourcing architecture;
- replace the store abstraction wholesale;
- rewrite LoadedSessionManager;
- replace SDK streaming;
- add a new scheduler unless a recovery owner already cannot be expressed through existing abstractions;
- add a distributed consensus system;
- add network leases unless the repository already supports multi-process ownership and the bug concretely requires it;
- redesign the benchmark case schema unrelated to provenance;
- rerun all paid benchmarks merely because artifact import is inconvenient;
- change champion quality thresholds to make a candidate pass;
- change test expectations to match buggy behavior;
- treat `benchmark command exited 0` as evidence that model quality passed;
- treat missing benchmark suites as zero;
- treat partial benchmark suites as full suites;
- claim “84/84 executed” unless the imported artifacts prove the 84 expected case identities are present.

If a change starts to look like a new architecture project, stop and solve the narrower invariant instead.

---

# 4. Mandatory invariants

All tasks must preserve these invariants.

## INV-P38.4-001 — One durable prompt, one durable turn lineage

For a durable followup prompt `P`:

```text
P may bind to at most one durable Turn identity T.
```

Once:

```text
P.status == promoted
P.promotedTurnId == T
```

the system must never create `T2` from the same prompt.

---

## INV-P38.4-002 — Bind before execution

No tool/model execution for a promoted followup may begin before durable lineage exists:

```text
P -> T
```

The existing bind-before-execute invariant must remain true.

---

## INV-P38.4-003 — Same-T recovery liveness

If the process crashes after `P -> T` is durable but before `T` reaches a terminal state, restart recovery must do exactly one of:

```text
A. resume/execute the SAME durable T, or
B. deterministically terminalize the SAME T with a durable failure/cancel reason
```

It must never silently leave `P=promoted` + `T=nonterminal` forever.

It must never create `T2`.

---

## INV-P38.4-004 — Recovery is idempotent

Running recovery more than once over the same persisted state must not:

```text
duplicate T execution,
duplicate tool side effects due solely to duplicate recovery ownership,
create T2,
double-consume P,
double-settle a caller,
or corrupt terminal state.
```

If exactly-once tool side effects cannot be guaranteed across a process crash because the provider/tool itself is not transactional, the code and docs must state the real guarantee precisely.

Do not claim a stronger guarantee than implemented.

---

## INV-P38.4-005 — Terminal prompt reconciliation

If:

```text
P.status == promoted
P.promotedTurnId == T
T.status is terminal
```

then recovery should reconcile `P` toward consumed state without creating a new turn.

A failure to mark consumed must be:

```text
observable,
retryable/reconcilable,
and never converted into replay-as-new-turn behavior.
```

---

## INV-P38.4-006 — Missing bound turn fails closed

If:

```text
P.status == promoted
P.promotedTurnId == T
store.getTurn(T) == undefined
```

the system must NOT reinterpret `P` as pending and create another turn.

It must emit a typed/structured degraded recovery signal and expose the condition for repair.

---

## INV-P38.4-007 — Benchmark truth is artifact-derived

All committed benchmark result claims must be derived from imported artifacts.

Forbidden:

```text
operator said it passed -> write pass
folder name says 84 -> write 84
missing suite -> write 0/30
partial suite -> treat as full suite
CLI exit code 0 -> quality pass
```

---

## INV-P38.4-008 — No secret import

The benchmark evidence importer/sanitizer must never intentionally commit:

```text
API keys,
Authorization headers,
provider secrets,
raw environment dumps,
credentials,
tokens,
private filesystem paths when avoidable,
unredacted sensitive tool outputs,
or user-private content unnecessary for aggregate evidence.
```

---

## INV-P38.4-009 — Full-suite completeness is identity-based

A suite is `complete` only when the set of expected benchmark case IDs equals the set of imported result case IDs.

Not just:

```text
array.length == expectedCount
```

Required:

```text
no missing case IDs
no unexpected case IDs
no duplicate case IDs
```

---

## INV-P38.4-010 — Paired evaluation attribution

A baseline/challenger comparison must prove that comparison context is compatible.

At minimum compare:

```text
case identity
suite/case version or fixture digest
judge version
provider/model identity where policy requires
tool schema/policy digest
environment/evaluation policy digest
feature prerequisites/effective case features
```

The mechanism under test must be represented explicitly as the controlled difference.

---

## INV-P38.4-011 — Runtime release and benchmark quality stay separate

`runtimeReleaseReady` remains a deterministic release property.

Real-model benchmark/champion quality remains a separate quality property.

A poor model benchmark must not falsify Runtime CI.

A green Runtime CI must not be represented as model-quality success.

---

## INV-P38.4-012 — Static docs are not volatile attestation storage

`HANDOVER.md` must not embed a “latest exact SHA” or “latest workflow run id” that becomes stale on the next commit.

Canonical exact-SHA release truth lives in CI/release evidence.

---

## INV-P38.4-013 — No sleep-based race proof

New concurrency/recovery tests must use:

```text
Deferred
Barrier
Latch
explicit promise gates
observable state transitions
instrumented fake runtime/store
```

Forbidden as correctness proof:

```ts
await new Promise((resolve) => setTimeout(resolve, 10));
```

A timeout may exist only as a test runner safety bound, not as the synchronization primitive.

---

## INV-P38.4-014 — Old implementation must fail the new regression

For each bug/proof gap fixed here, at least one deterministic regression test must demonstrate behavior that the pre-fix implementation would fail.

---

# 5. P38.4-0 — Freeze baseline and inspect before editing

## Problem background

This plan is intentionally post-freeze.

The biggest risk now is an agent “helpfully” rebuilding already-correct subsystems.

## Do

Before editing:

```bash
git status --short
git rev-parse HEAD
git log -1 --oneline
```

Record:

```text
START_HEAD=<actual sha>
WORKTREE_CLEAN=<true|false>
```

If `START_HEAD != 9f5e2720...`, do NOT reset user work.

Instead:

1. record the drift;
2. inspect intervening commits;
3. verify whether the findings still exist;
4. adapt paths only where necessary;
5. preserve all newer correct work.

Run the free baseline:

```bash
pnpm typecheck
pnpm test
pnpm build
```

If these are red before edits, classify failures:

```text
pre-existing
environmental
plan-related
```

Do not silently fix unrelated failures.

## Inspect

At minimum inspect:

```text
packages/core/src/runtime/session-actor.ts
apps/cli/src/benchmark-command.ts
apps/cli/src/benchmark-command.test.ts
apps/cli/src/champion-eval.ts
apps/cli/src/champion-eval.test.ts
apps/cli/src/release-command.ts
apps/cli/src/release-verify.ts
HANDOVER.md
benchmarks/results/
```

Locate definitions/usages for:

```text
InboxStore
listRecoverable
promotedTurnId
startTurn
runTurn
resume/recover/reconcile turn
EvalOutcome
effectiveConfig
runtimeConfigHash
judgeVersion
buildPairedReport
evaluateChampionQuality
```

Use:

```bash
rg -n "interface InboxStore|type InboxStore|class .*Inbox" .
rg -n "listRecoverable|promotedTurnId|markConsumed|bindReservedFollowup" packages apps
rg -n "recover|resume|reconcile|nonterminal|pending.*turn|running.*turn" packages apps
rg -n "effectiveConfig|runtimeConfigHash|judgeVersion|EvalOutcome" packages apps
```

## Acceptance

P38.4-0 is DONE only when:

- actual start SHA is recorded;
- baseline status is recorded;
- relevant recovery owner is located or explicitly proven absent;
- benchmark source/result structure is located;
- no production code has yet been changed.

---

# 6. P38.4-1 — Define the same-T recovery contract

## Problem background

Current production behavior already prevents a promoted prompt from replaying as a fresh followup.

That proves:

```text
no T2
```

But the reviewed code path for:

```text
P promoted -> T nonterminal
```

currently comments that recovery “owns lineage T” without, by itself, proving who resumes or terminalizes that T.

This is a **liveness proof gap**.

## Do

Before implementation, write a short code comment/design note near the recovery logic defining the state transitions.

Required recovery table:

| Prompt | Bound Turn | Required action |
|---|---|---|
| pending | none | eligible for normal followup reservation |
| promoted | missing ID | fail closed + degraded recovery record |
| promoted | turn missing | fail closed + degraded recovery record |
| promoted | T completed | consume/reconcile P |
| promoted | T failed | consume/reconcile P |
| promoted | T cancelled | consume/reconcile P |
| promoted | T pending/created | recover SAME T |
| promoted | T running but no live owner after restart | recover SAME T under existing restart semantics |
| consumed | any | never replay |

Explicitly document what “recover SAME T” means in this repository.

Possible valid implementations:

```text
A. existing Runtime API can run an already-created Turn object;
B. existing recovery coordinator can resume durable Turn by ID;
C. SessionActor can adopt durable T and call runtime.runTurn(T, ...);
D. if provider/tool replay cannot safely resume, deterministically terminalize T
   and expose typed recovery failure.
```

Do not invent `startTurn()` to recover T.

`startTurn()` creates new identity and therefore is forbidden for the promoted lineage.

## Important semantic decision

If `runtime.runTurn(T)` is restart-safe for an already-created nonterminal Turn, use it.

If it is not, use the repository's existing recovery path.

If neither exists, add the smallest explicit API necessary, such as conceptually:

```ts
recoverTurn(turn: Turn, options): TurnHandle
```

but only after proving the existing runtime cannot express the operation.

Prefer reuse over new abstraction.

## Acceptance

P38.4-1 is DONE only when the codebase contains one unambiguous owner for:

```text
promoted P + nonterminal bound T after restart
```

and the contract explicitly forbids creating T2.

---

# 7. P38.4-2 — Implement or connect same-T recovery ownership

## Problem background

Safety without liveness can strand durable work forever:

```text
P promoted
T nonterminal
restart
P skipped forever
T never resumed
```

## Do

Add recovery behavior to the existing recovery lifecycle.

The preferred shape is:

```text
hydrate/recover durable state
        |
        v
P promoted?
        |
        v
load promotedTurnId T
        |
        +-- terminal --> reconcile P consumed
        |
        +-- nonterminal --> acquire local recovery ownership for SAME T
                                |
                                v
                          run/resume SAME T
                                |
                                v
                           terminal outcome
                                |
                                v
                          consume/reconcile P
```

### Ownership rule

At most one live actor/recovery owner may attempt to run T inside the process.

Use the already-existing actor ownership/generation/reservation concepts when possible.

Do not create a parallel ownership system unless absolutely required.

### Required behavior on restart

For a durable nonterminal T:

```text
startTurn call count = 0
recovered run/resume call count = 1
recovered turn ID = original T.id
```

### Required behavior if two recovery triggers race

Example:

```text
actor hydration
manager recovery scan
```

If both can observe T:

```text
only one may own execution
the other must observe/adopt/skip
```

If only one recovery trigger exists in production, test that exact trigger.

### Required behavior if actor closes during recovery

Do not create another T.

Either:

```text
existing T is cancelled/terminalized,
or durable recovery remains available to the next owner.
```

### Required behavior if recovery execution throws before terminalization

Do not convert the prompt to pending.

Keep lineage:

```text
P -> T
```

and persist/emit a recovery failure associated with T.

Whether T becomes `failed` or remains recoverable must follow existing Turn semantics.

## Acceptance

- no call to `startTurn` is used to recover an already-bound prompt;
- same T is resumed or terminalized;
- only one local owner runs T;
- prompt lineage never goes backward from promoted to fresh pending merely to retry;
- failures remain associated with T.

---

# 8. P38.4-3 — Deterministic crash-boundary tests

This is the most important test task.

Do not use sleeps.

Create instrumented fakes with counters and barriers.

Suggested test file:

```text
packages/core/src/runtime/session-actor.test.ts
```

or a dedicated:

```text
packages/core/src/runtime/session-actor.recovery.test.ts
```

if the existing test file is already too large.

## Test A — crash after bind, before run

Arrange:

```text
P admitted
T created
P -> T bound
runTurn has NOT started
simulate process death by discarding actor
construct fresh actor/manager with same durable stores
trigger recovery
```

Assert:

```text
startTurn calls after restart == 0
run/recover calls after restart == 1
run/recover turn.id == original T.id
no T2 exists
P never returns to fresh pending
after T terminal:
  P == consumed
```

This is the core liveness regression.

---

## Test B — repeated recovery is idempotent

Arrange same durable:

```text
P promoted -> T pending
```

Trigger recovery twice concurrently using a barrier.

Assert:

```text
same T only
run/recover count == 1
startTurn count == 0
max concurrent owners for T == 1
```

---

## Test C — bound T already terminal

Arrange:

```text
P promoted -> T
T completed
```

Restart.

Assert:

```text
runTurn count == 0
startTurn count == 0
P consumed
```

Repeat for:

```text
failed
cancelled
```

Use table-driven tests if clear.

---

## Test D — missing bound turn

Arrange:

```text
P promoted
promotedTurnId = T
T absent
```

Assert:

```text
no startTurn
no runTurn
no T2
P not silently reset to pending
typed/observable degraded recovery condition exists
```

Avoid an assertion that only checks stderr text if there is a structured event/error path available.

---

## Test E — malformed promoted prompt without turn ID

Arrange:

```text
P.status = promoted
P.promotedTurnId = undefined
```

Assert fail-closed:

```text
no replay
no startTurn
no runTurn
diagnostic/recovery-required signal
```

---

## Test F — crash after T terminal but before prompt consume

Arrange:

```text
P promoted -> T
T completed
P still promoted
```

Restart.

Assert:

```text
T is not re-executed
P is consumed
no T2
```

---

## Test G — recovery cancellation

Arrange:

```text
P -> T
T nonterminal
recovery ownership acquired
cancel/close before execution gate opens
```

Assert exact repository semantics:

```text
either T terminalized cancelled
or T remains durably recoverable
```

Always assert:

```text
no T2
no duplicate run
```

---

## Test H — caller/result behavior where applicable

If a pre-crash caller Deferred cannot logically survive process restart, do not pretend it does.

Instead verify:

```text
durable state is correct
post-restart query/result APIs expose T outcome
no in-memory resolver leak is expected to survive process death
```

Document this semantic boundary.

---

## Determinism requirements

Every concurrency test must expose barriers such as:

```ts
const entered = deferred<void>();
const release = deferred<void>();

runtime.runTurn = async (...) => {
  runCalls++;
  entered.resolve();
  await release.promise;
  ...
};
```

Do not use:

```ts
setTimeout
sleep
eventual 20ms
```

to “give recovery time”.

## Acceptance

All eight scenarios are covered or a written note explains why a scenario is impossible in the actual architecture.

The old reviewed implementation must fail at least Test A if no same-T recovery owner existed.

---

# 9. P38.4-4 — Recovery failure reconciliation must be observable and fail-closed

## Problem background

A good recovery system must not hide impossible durable states.

Current code already emits degraded messages for malformed promoted records and missing bound Turns.

That is directionally correct.

## Do

Audit whether recovery diagnostics are:

```text
structured enough to test,
stable enough to operate,
and not solely ephemeral stderr strings.
```

Prefer an existing event/diagnostic mechanism.

If the codebase has an existing:

```text
EventStore
audit event
runtime diagnostic
degraded event
session event
```

reuse it.

Only add a new typed diagnostic if no suitable existing mechanism exists.

Suggested diagnostic identities conceptually:

```text
inbox.promotion_identity_missing
inbox.bound_turn_missing
inbox.bound_turn_recovery_failed
inbox.prompt_consume_reconciliation_failed
```

Do not expose secrets or full prompt contents in operational diagnostics by default.

Include IDs:

```text
sessionId
promptId
turnId when known
error category/code
```

## Retry semantics

For recoverable storage errors:

```text
do not mark P consumed unless the durable consume succeeds
do not create T2
allow later reconciliation
```

For an unrecoverable malformed state:

```text
fail closed
leave evidence
do not replay
```

## Acceptance

Every fail-closed branch has a deterministic test that proves:

```text
no replay
no new turn
observable diagnostic
```

---

# 10. P38.4-5 — Import the already-completed 84-case benchmark truth

## Problem background

The repository currently truthfully says that a complete operator run was reported, but complete local artifacts were not available in the checkout.

The user has explicitly stated that the full benchmark run has now been completed.

The next task is therefore **artifact preservation**, not automatically paying for another run.

## Hard rule

First search for already-existing local benchmark artifacts.

Do NOT run paid model benchmarks before searching.

Search:

```bash
find . -maxdepth 6 -type f \( \
  -name '*summary*.json' -o \
  -name '*runs*.json' -o \
  -name '*result*.json' -o \
  -name '*report*.json' -o \
  -name '*.jsonl' \
\) | sort

find .ci benchmarks -type f | sort
```

Also inspect ignored/untracked locations:

```bash
git status --short --ignored
```

If the user's full artifacts are outside the repo but accessible in the working machine, import from that existing path.

If they truly cannot be found:

```text
DO NOT fabricate.
DO NOT silently rerun paid suites.
Mark import BLOCKED: source artifacts unavailable.
Continue the other P38.4 tasks.
```

---

## Expected suite inventory

The full benchmark contract currently expected by this plan is:

```text
regression:   30
holdout:      30
adversarial:  13
stress:       11
----------------
total:        84
```

Before hard-coding these counts, verify against the repository's authoritative case manifests.

If repository truth differs, use the repository manifests and document the difference.

The final completeness check MUST use case IDs from manifests, not only numeric constants.

---

## Sanitized committed layout

Create a stable result directory such as:

```text
benchmarks/results/<date>-<provider-or-model-slug>-full/
```

The committed sanitized package should contain, where data exists:

```text
manifest.json
regression-summary.json
holdout-summary.json
adversarial-summary.json
stress-summary.json
overall-summary.json
overall-summary.md
runs.sanitized.json
```

If keeping all per-case sanitized runs is too large, split by suite:

```text
regression-runs.sanitized.json
holdout-runs.sanitized.json
adversarial-runs.sanitized.json
stress-runs.sanitized.json
```

Do not commit huge raw provider transcripts merely to prove a count.

---

## Required manifest fields

At minimum:

```json
{
  "schemaVersion": 1,
  "source": "real-model",
  "createdAt": "...",
  "gitSha": "...",
  "provider": "...",
  "model": "...",
  "mode": "real-model",
  "suiteManifestDigest": "...",
  "judgeVersion": "...",
  "expectedCases": {
    "regression": 30,
    "holdout": 30,
    "adversarial": 13,
    "stress": 11,
    "total": 84
  },
  "observedCases": {
    "regression": 30,
    "holdout": 30,
    "adversarial": 13,
    "stress": 11,
    "total": 84
  },
  "complete": true,
  "sanitized": true
}
```

Only include fields actually derivable from artifacts/config.

If provider/model is absent in source evidence, write:

```json
"provider": null
```

or fail the completeness policy if provider identity is mandatory.

Do not guess.

---

## Required per-suite summary fields

At minimum:

```json
{
  "suite": "regression",
  "expectedCaseIds": [],
  "observedCaseIds": [],
  "missingCaseIds": [],
  "unexpectedCaseIds": [],
  "duplicateCaseIds": [],
  "complete": true,
  "cases": 30,
  "passed": 0,
  "failed": 0,
  "verifiedComplete": 0,
  "falseComplete": 0,
  "failureCategories": {
    "model_capability": 0,
    "tool_selection": 0,
    "security_denial": 0,
    "verification_failure": 0,
    "context_limit": 0,
    "model_error": 0,
    "harness": 0,
    "judge": 0,
    "infrastructure": 0,
    "unknown": 0
  },
  "toolCalls": 0,
  "tokens": {
    "input": 0,
    "output": 0,
    "total": 0
  },
  "costUsd": null,
  "durationMs": null
}
```

Use the repository's actual category taxonomy if names differ.

Do not coerce missing cost to `$0`.

Use `null` for genuinely unavailable values.

---

# 11. P38.4-6 — Add benchmark artifact validation and sanitization

## Goal

A future reviewer should be able to run one free deterministic command and answer:

```text
Are these benchmark artifacts complete?
Are the claims mathematically consistent?
Are there duplicate/missing cases?
Do the summaries match the per-case runs?
Are obvious secrets present?
```

## Preferred implementation location

Inspect existing benchmark CLI first:

```text
apps/cli/src/benchmark-command.ts
apps/cli/src/benchmark-command.test.ts
```

Do not create a second unrelated benchmark framework.

Add the smallest command/subcommand or internal utility that fits current CLI conventions.

Conceptual commands are acceptable such as:

```bash
agent benchmark validate <result-dir>
agent benchmark summarize <result-dir>
```

Use the repository's established argument style.

---

## Validation rules

Hard fail when:

```text
duplicate case IDs
missing required case IDs
unexpected case IDs unless explicitly allowed by manifest version
summary cases != per-case count
summary passed + failed != cases
complete=true while missingCaseIds is non-empty
gitSha missing when required
judgeVersion inconsistent inside one supposedly comparable run
suite name mismatch
non-finite token/cost counts
negative counts
malformed JSON
```

---

## Secret scan

Add a conservative sanitizer/validator for committed sanitized outputs.

At minimum flag keys matching case-insensitively:

```text
authorization
api_key
apikey
access_token
refresh_token
secret
password
cookie
set-cookie
x-api-key
```

Also consider obvious bearer strings:

```text
Bearer <token>
sk-...
```

Do not overpromise perfect secret detection.

The point is a last-line guard.

---

## Summary derivation

The committed summary must be generated from sanitized per-case results, not manually typed.

Provide a deterministic function:

```text
summarizeBenchmarkRuns(runs, expectedManifest)
```

or equivalent.

The function should return:

```text
suite counts
pass/fail
verified completion
failure clusters
security violations
tool calls
token totals
cost where available
duration where available
completeness metadata
```

## Acceptance

A test intentionally corrupting one count must fail validation.

A test removing one case must fail completeness.

A test duplicating one case must fail completeness.

A test inserting a secret-shaped key must fail sanitization validation.

A valid fixture must produce stable deterministic summary JSON.

---

# 12. P38.4-7 — Per-case provenance and controlled-difference hashes

## Problem background

The benchmark runner already records useful effective configuration and a run-level `runtimeConfigHash`.

That is good.

However, individual cases may enable different prerequisites:

```text
memory
MCP
delegation/subagent
scheduler
special tool sets
schema advertisement
```

A run-level hash alone can obscure case-specific differences.

## Do

Extend per-case benchmark outcome provenance with two concepts.

### A. Evaluation context hash

This hash covers attributes that SHOULD remain compatible across baseline/challenger.

Conceptually:

```text
caseId
case fixture/version digest
judge version
provider/model policy identity as required
tool schema/policy digest
suite version
security policy version
case prerequisite features
environment contract
```

Name suggestion:

```text
evaluationContextHash
```

### B. Candidate configuration hash

This covers the actual agent/challenger configuration under test.

Conceptually:

```text
maxSteps
context pipeline strategy
memory strategy
specialist routing
tool selection strategy
recovery strategy
compaction strategy
candidate/challenger flags
```

Name suggestion:

```text
candidateConfigHash
```

If the existing `runtimeConfigHash` already represents B correctly, reuse/rename carefully rather than duplicating.

### C. Explicit controlled difference

Add metadata that explains what changed:

```json
{
  "experiment": {
    "candidate": "adaptive-recovery-5",
    "controlledDifference": [
      "recovery.strategy"
    ]
  }
}
```

Do not infer the controlled difference from arbitrary JSON diff at evaluation time if it can be recorded explicitly at run creation.

---

## Canonical hashing requirements

Use stable canonical serialization.

Requirements:

```text
object key ordering stable
undefined handled consistently
arrays order-sensitive where semantically meaningful
no timestamps in config hash
no random IDs in config hash
no secrets in hash input object persisted as plaintext
```

If the repo already has a canonical hash helper, reuse it.

## Acceptance

Tests prove:

```text
same effective case context -> same evaluationContextHash
changed case fixture -> different evaluationContextHash
changed judge version -> different evaluationContextHash
changed candidate-only knob -> evaluationContextHash unchanged
changed candidate-only knob -> candidateConfigHash changed
object key insertion order does not change hash
```

---

# 13. P38.4-8 — Strengthen champion paired comparability

## Existing files

Primary:

```text
apps/cli/src/champion-eval.ts
apps/cli/src/champion-eval.test.ts
```

At the reviewed SHA, champion quality already checks:

```text
same case set
compatible judge version
no new harness/judge/infrastructure failures
security non-regression
P21-4 quality gates
```

Preserve these.

## Add

Add explicit comparability checks for provenance.

Suggested quality check fields:

```ts
checks: {
  sameCaseSet: boolean;
  compatibleJudgeVersion: boolean;
  compatibleEvaluationContext: boolean;
  controlledDifferenceDeclared: boolean;
  candidateActuallyDiffers: boolean;
  noNewInfrastructureFailures: boolean;
  securityNonRegression: boolean;
  qualityGates: boolean;
}
```

### compatibleEvaluationContext

For each paired case:

```text
baseline.evaluationContextHash
==
candidate.evaluationContextHash
```

If not equal:

```text
comparison is not attributable
quality verdict must fail closed
```

### candidateActuallyDiffers

Avoid meaningless “challenger equals baseline” comparisons.

At minimum one candidateConfigHash should differ if the experiment claims a challenger.

If the command is being used for pure repeatability/repetition analysis, allow an explicit mode where same config is expected.

Do not silently infer.

### controlledDifferenceDeclared

For promotion-quality comparisons:

```text
challenger metadata must identify intended mechanism difference
```

If old historical results lack this metadata:

- do not break all historical parsing unnecessarily;
- support a legacy/informational mode if needed;
- but do not issue a strong promotion verdict without enough provenance.

---

## Failure messages

Messages must be specific, e.g.:

```text
case adv-07 evaluation context mismatch:
baseline=a1...
candidate=b9...
results are not attributable to candidate configuration
```

Not merely:

```text
quality failed
```

---

## Tests

Add at least:

1. same context + candidate differs -> comparable;
2. judge same but fixture hash differs -> FAIL;
3. tool policy differs unexpectedly -> FAIL via context hash;
4. candidate config identical while challenger claim made -> FAIL;
5. controlledDifference missing in strict promotion mode -> FAIL;
6. historical/legacy run behavior is explicit and truthful;
7. security regression still fails even when provenance passes;
8. extra candidate case still fails.

## Acceptance

Champion promotion cannot PASS if comparison provenance is materially incompatible.

---

# 14. P38.4-9 — Truthful 84-case overall report and failure clustering

## Goal

After sanitized import, generate an overall report that answers the questions a maintainer actually needs.

Required top table:

```text
Suite          Passed / Cases     Pass rate
regression     X / 30             ...
holdout        X / 30             ...
adversarial    X / 13             ...
stress         X / 11             ...
TOTAL          X / 84             ...
```

Only show `/84` when completeness is proven.

If one suite is incomplete:

```text
TOTAL: INCOMPLETE
```

not:

```text
X/84
```

---

## Failure clustering

Aggregate failures into repository-supported categories.

Recommended high-level buckets:

```text
model_capability
tool_selection
security_denial
verification_failure
context_limit
model_error
harness
judge
infrastructure
unknown
```

For each category include:

```text
count
case IDs
suite breakdown
```

Example:

```text
model_error: 8
  adversarial: 8
  cases:
    - ...
```

---

## Security section

Separate:

```text
security probes failed because model stopped/errored
```

from:

```text
actual security violation occurred
```

These are not equivalent.

Report both:

```text
security-case pass rate
security violation count
```

---

## Infrastructure quality section

Report:

```text
harness failures
judge failures
infrastructure failures
```

independently from model-quality failures.

This makes it possible to tell whether the Harness or the Agent is the bottleneck.

---

## Efficiency section

Where artifacts provide data:

```text
total tool calls
median tool calls/case
input tokens
output tokens
total tokens
cost
duration
```

For unavailable metrics use:

```text
N/A
```

not zero.

---

## Provenance section

Include:

```text
run git SHA
provider/model
judge version
suite manifest digest
sanitized artifact directory
complete=true/false
```

## Acceptance

`overall-summary.md` is generated from machine-readable sanitized evidence.

No hand-edited pass count is authoritative.

---

# 15. P38.4-10 — Make HANDOVER static and non-self-invalidating

## Problem background

At the reviewed SHA, `HANDOVER.md` correctly states:

```text
Architecture: FROZEN
Runtime release: READY
```

but also embeds a previous workflow run ID and previous attestation SHA.

Any commit updating that SHA creates a new SHA, making the document stale again.

## Do

Replace volatile text with stable authority semantics.

Preferred shape:

```md
Architecture: FROZEN

Runtime release truth:
The canonical release truth is the exact-SHA GitHub Actions
release-evidence / release-attestation artifact for the commit being evaluated.

Do not treat this file as a substitute for exact-SHA CI evidence.
```

Keep historical release numbers only if explicitly labeled:

```text
historical example
```

and not “current truth”.

Update README/CONTRIBUTING only if they currently point users to HANDOVER as the exact-SHA attestation source.

## Add docs verification

If `apps/cli/src/docs-verify.ts` already validates release-truth claims, add a rule that rejects patterns like:

```text
Release SHA: <hex>
latest run: <id>
current attestation: <hex>
```

inside the canonical static handover section.

Do not ban all commit hashes in historical documentation globally.

## Acceptance

A new commit after editing HANDOVER does not make HANDOVER semantically false.

---

# 16. P38.4-11 — Freeze guardrails

## Goal

Prevent future coding agents from interpreting every benchmark failure as a reason to rewrite Runtime architecture.

## Do

Add a concise repository rule in the canonical contributor/architecture location.

Required policy:

```text
Runtime architecture is frozen.

Runtime changes after P38.4 require at least one of:
1. deterministic correctness bug with a reproducer;
2. security vulnerability;
3. release integrity defect;
4. benchmark failure proven to originate in Harness infrastructure rather than model/agent strategy;
5. measured performance regression attributable to Runtime.

Model-quality failures alone are not permission to rewrite Runtime.
They should first produce a challenger at the Agent strategy layer.
```

Also state:

```text
benchmark -> failure cluster -> hypothesis -> challenger -> paired eval
```

is now the default development loop.

Do not create a huge governance framework.

A short section is enough.

## Acceptance

A future agent reading the canonical docs can distinguish:

```text
Runtime maintenance
vs
Agent evolution
```

without guessing.

---

# 17. P38.4-12 — Audit all new tests for proof quality

Before final gates, manually inspect new tests.

Reject and rewrite any test containing one of these anti-patterns.

## Anti-pattern A — tautology

Forbidden:

```ts
expect(x === undefined || x !== undefined).toBe(true);
```

## Anti-pattern B — disconnected counter

Forbidden:

```ts
let runCalls = 0;
// fake runtime used by test never increments this
expect(runCalls).toBe(0);
```

Every counter must live inside or be incremented by the actual fake used by production code.

## Anti-pattern C — sleep synchronization

Forbidden:

```ts
await new Promise((r) => setTimeout(r, 20));
```

for race ordering.

## Anti-pattern D — checking only final state

A race test that only asserts:

```text
eventually completed
```

is insufficient if the invariant is:

```text
runTurn exactly once
startTurn zero
same T
max concurrency one
```

Instrument the exact operations.

## Anti-pattern E — mock bypasses production path

Do not “test” recovery by directly calling the helper that already assumes correct state.

At least one integration-level Actor/Manager test must trigger recovery through the production entry path used after restart.

## Anti-pattern F — snapshot as correctness proof

Snapshots are acceptable for report formatting, but not sufficient for ownership/durability invariants.

## Acceptance

Every new correctness invariant has an assertion tied to actual production control flow.

---

# 18. Suggested implementation order

Follow this order unless code inspection proves a dependency requires a small change.

```text
1. P38.4-0 baseline
2. P38.4-1 recovery contract
3. P38.4-2 same-T recovery
4. P38.4-3 crash tests
5. P38.4-4 recovery diagnostics
6. run core tests
7. P38.4-5 find/import local benchmark artifacts
8. P38.4-6 validator/sanitizer
9. P38.4-7 provenance hashes
10. P38.4-8 champion comparability
11. P38.4-9 overall summary
12. P38.4-10 HANDOVER
13. P38.4-11 freeze guardrails
14. P38.4-12 test proof audit
15. P38.4-13 full gates
16. P38.4-14 closure report
```

---

# 19. Per-task execution report format

After every task append a short report to the agent's working notes / final response.

Use:

```md
## P38.4-X Report

### Changed
- file:
- symbol:
- reason:

### Invariant proved
- INV-P38.4-...

### Tests run
```bash
...
```

### Result
- passed:
- failed:
- skipped:

### Negative proof
- old behavior that this test would fail:
- why the new test is not tautological:

### Remaining risk
- none / describe precisely
```

Do not write “done” without evidence.

---

# 20. Recovery design constraints in more detail

This section exists to prevent overengineering.

## 20.1 Reuse current durable Turn identity

The recovery API must consume an existing durable Turn.

Bad:

```ts
const t2 = await runtime.startTurn(sessionId, originalPrompt);
```

Good conceptually:

```ts
const t = await store.getTurn(boundTurnId);
await runtime.runTurn(t, ...);
```

or:

```ts
await runtime.recoverTurn(boundTurnId, ...);
```

if that is the repository's established abstraction.

---

## 20.2 Separate “resume same turn” from “replay side effects”

A durable Turn ID does not automatically imply exactly-once external side effects.

If a tool call was sent externally immediately before process death and the system cannot know whether it committed, recovery may face an ambiguous side-effect boundary.

Do not hide this.

If existing tool invocation IDs/idempotency keys solve it, verify and test them.

If they do not, document the guarantee as something like:

```text
The Harness guarantees one durable Turn lineage and no duplicate Turn creation.
External side-effect exactly-once depends on tool/provider idempotency at
ambiguous process-crash boundaries.
```

This plan does NOT require building distributed transactions across arbitrary tools.

---

## 20.3 Recovery of `running` durable state

If a stored Turn says `running` after process restart, there is by definition no old in-memory owner.

The code must decide using existing semantics whether:

```text
running -> recoverable
```

or:

```text
running -> failed/interrupted due to process loss
```

Both can be legitimate.

But the decision must be deterministic and same-T.

Forbidden:

```text
ignore forever
create T2
```

---

## 20.4 Recovery of `pending/created`

This is the strongest same-T resume candidate.

A Turn durably created but never executed should normally be runnable under the same ID.

Test this case explicitly.

---

# 21. Benchmark artifact migration rules

## 21.1 Preserve raw source outside committed sanitized output

If raw artifacts contain sensitive/full transcripts:

```text
keep them local/ignored
```

and generate:

```text
runs.sanitized.json
```

for Git.

Do not delete the user's raw files unless explicitly intended.

---

## 21.2 Sanitization should be deterministic

Given identical raw artifacts, sanitizer output must be stable except for explicitly generated metadata that is intentionally variable.

Prefer no new timestamp when re-sanitizing the same source unless the timestamp is clearly `sanitizedAt`, not run provenance.

Run provenance should come from source.

---

## 21.3 Do not mutate benchmark semantics during import

Importing old results must not retroactively rejudge them with a different judge unless explicitly labeled as a rejudge.

Preserve:

```text
original judgeVersion
original passed/failed
original grade
original failure category
```

If a derived failure-cluster mapper is new, label it as derived metadata.

---

## 21.4 Case manifest digest

Build the digest from authoritative case definitions/manifests, not from result ordering.

Canonicalize case identity list.

For example conceptually:

```text
sha256(
  canonical_json({
    suiteVersion,
    cases: [
      {id, fixtureDigest, judgePolicyVersion, prerequisites},
      ...
    ]
  })
)
```

Use existing repository hashing utilities if available.

---

# 22. Champion evaluation experiment semantics

The repo is now in benchmark-driven evolution mode.

A future experiment should look like:

```text
Champion baseline
  vs
Challenger: exactly one declared mechanism hypothesis
```

Examples:

```text
adaptive recovery only on recovery-class failures
memory retrieval only on memory-required cases
context expansion only under measured context pressure
schema advertisement only for tool-discovery failures
```

Avoid global “turn everything on” challengers unless that is the hypothesis.

The evaluator should help catch accidental confounders.

---

# 23. Optional but valuable: repeated real-model comparison support

This is optional for P38.4.

Do NOT block closure on it if it becomes large.

If existing EvalOutcome schema already supports repetition IDs/seeds, strengthen aggregation.

Future desired methodology:

```text
3 repetitions minimum
5 preferred for important champion decisions
interleaved baseline/challenger ordering where provider drift matters
paired case-level analysis
```

Potential metadata:

```text
replicateIndex
experimentRunId
providerRequestWindow
```

But do not add a large statistics framework here.

This belongs to later benchmark evolution if needed.

---

# 24. P38.4-13 — Full final verification

After all implementation work:

## 24.1 Diff audit

Run:

```bash
git status --short
git diff --stat
git diff
```

Inspect for:

```text
accidental generated files
raw secrets
raw paid-model transcripts
large binary artifacts
unrelated refactors
weakened tests
changed gate thresholds
volatile SHA inserted into HANDOVER
```

---

## 24.2 Secret check

Use repository-native secret scanning if available.

Also manually search the newly committed benchmark directory for obvious secret keys.

For example:

```bash
rg -n -i \
  "authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|bearer " \
  benchmarks/results
```

Review every hit.

Do not blindly delete legitimate words such as “security secret handling” from documentation; inspect context.

---

## 24.3 Core deterministic gates

Run:

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

If scripts have been renamed in newer HEAD, use canonical current equivalents and document them.

---

## 24.4 Benchmark evidence validation

Run the newly added deterministic artifact validation command.

Conceptually:

```bash
pnpm agent benchmark validate benchmarks/results/<full-run>
```

or repository-equivalent.

It must prove:

```text
regression complete
holdout complete
adversarial complete
stress complete
total complete
no duplicate IDs
no missing IDs
summary matches runs
sanitization checks pass
```

If source artifacts are unavailable and the import task is legitimately BLOCKED:

- Runtime closure may still complete;
- benchmark evidence closure may not be labeled complete;
- final report must explicitly state the block.

---

## 24.5 Champion evaluator unit tests

Run the focused CLI tests, for example:

```bash
pnpm vitest apps/cli/src/champion-eval.test.ts
pnpm vitest apps/cli/src/benchmark-command.test.ts
```

Use workspace-appropriate invocation.

Also ensure full `pnpm test` covers them.

---

## 24.6 Platform CI

Push the final candidate and require exact-SHA GitHub Actions evidence.

Required:

```text
Ubuntu verify = success
Windows verify = success
coverage gate = success
release attestation = success
```

The release attestation must correspond to the exact pushed candidate SHA.

No stale prior SHA is acceptable as proof.

---

# 25. Hard DONE criteria

P38.4 is DONE only if every applicable statement below is true.

## Runtime recovery

- [ ] promoted durable prompt cannot create T2;
- [ ] bound nonterminal T has an explicit post-restart owner;
- [ ] restart uses same T identity;
- [ ] recovery does not call `startTurn` for bound T;
- [ ] repeated recovery cannot duplicate execution inside one process ownership model;
- [ ] terminal T reconciles P consumed;
- [ ] missing T fails closed;
- [ ] malformed promoted state fails closed;
- [ ] no sleep-based correctness tests were added;
- [ ] old implementation fails at least one new recovery regression.

## Benchmark truth

- [ ] existing local full-run artifacts were searched before any paid rerun;
- [ ] no paid rerun happened merely for convenience;
- [ ] sanitized evidence contains no intentional secrets;
- [ ] expected case IDs come from authoritative manifests;
- [ ] no duplicate case IDs;
- [ ] no missing case IDs if `complete=true`;
- [ ] no unexpected IDs if `complete=true`;
- [ ] summary is machine-derived;
- [ ] missing metrics use null/N/A rather than invented zero;
- [ ] partial results are labeled partial;
- [ ] `/84` claim appears only if all 84 identities are proven.

## Paired evaluation provenance

- [ ] per-case evaluation context is represented deterministically;
- [ ] candidate configuration is represented deterministically;
- [ ] intended controlled difference is explicit;
- [ ] incompatible evaluation context fails promotion-quality verdict;
- [ ] challenger-equals-baseline cannot masquerade as a meaningful experiment;
- [ ] existing security and quality gates remain intact.

## Documentation

- [ ] HANDOVER contains no self-invalidating “current exact SHA” claim;
- [ ] canonical exact-SHA release truth points to CI/release evidence;
- [ ] Runtime architecture remains documented as FROZEN;
- [ ] benchmark-driven Agent evolution is documented as default next phase.

## Release

- [ ] typecheck green;
- [ ] tests green;
- [ ] build green;
- [ ] coverage green;
- [ ] docs verify green;
- [ ] benchmark smoke green;
- [ ] protocol green;
- [ ] security green;
- [ ] race green;
- [ ] chaos green;
- [ ] capability audit green;
- [ ] release verify green;
- [ ] Linux CI green on final exact SHA;
- [ ] Windows CI green on final exact SHA;
- [ ] release attestation green on final exact SHA.

---

# 26. Failure handling rules

If any task cannot be completed:

Do not hide it.

Use:

```text
BLOCKED
```

with:

```text
what is missing
why it blocks proof
what was verified anyway
what must happen next
```

Examples:

```text
BLOCKED: full benchmark source artifacts cannot be located.
No paid rerun was performed.
Runtime maintenance tasks completed.
Repository continues to truthfully mark full benchmark evidence unavailable.
```

This is better than invented evidence.

---

# 27. What must NOT happen in the final report

Forbidden final claims:

```text
"everything perfect"
"exactly once guaranteed everywhere"
"84 benchmark complete"
"release ready"
```

unless the evidence proves each statement.

Use scoped claims.

Good:

```text
Same-turn durable lineage recovery: PROVED by deterministic restart tests.

External tool side-effect exactly-once: depends on tool/provider idempotency
across ambiguous process-crash boundaries.

84-case benchmark artifact completeness: VERIFIED.

Runtime release: READY on exact SHA <sha>, attestation green.
```

---

# 28. Final execution report template

The coding agent must finish with:

```md
# P38.4 Final Report

## Baseline
- reviewed-plan baseline:
- actual start HEAD:
- final HEAD:

## Architecture
- Runtime architecture: FROZEN / changed (if changed, explain why)
- new architecture introduced: YES/NO

## Recovery closure
- same-T recovery owner:
- promoted -> nonterminal T behavior:
- startTurn on recovery calls:
- run/recover same-T calls:
- duplicate T2 regression:
- repeated recovery regression:
- terminal reconciliation regression:
- missing-T fail-closed regression:

## Benchmark evidence
- source artifacts located:
- paid rerun performed: YES/NO
- sanitized result directory:
- manifest digest:
- regression:
- holdout:
- adversarial:
- stress:
- total completeness:
- missing case IDs:
- duplicate case IDs:
- unexpected case IDs:
- secret scan:

## Provenance
- evaluationContextHash:
- candidateConfigHash/runtimeConfigHash:
- controlledDifference:
- champion comparability checks:

## Docs
- HANDOVER volatile SHA/run IDs removed:
- canonical release truth source:

## Gates
| Gate | Result |
|---|---|
| typecheck | |
| test | |
| build | |
| coverage | |
| docs:verify | |
| benchmark:smoke | |
| protocol | |
| security | |
| race | |
| chaos | |
| capability:audit | |
| release:verify | |
| Ubuntu CI | |
| Windows CI | |
| release attestation | |

## Known remaining risks
- ...

## Final verdict
Harness v5 architecture closure: COMPLETE / NOT COMPLETE
Runtime architecture: FROZEN / NOT FROZEN
Runtime release target: <exact SHA or N/A>
RuntimeReleaseReady: TRUE/FALSE
84-case benchmark evidence: VERIFIED / PARTIAL / UNAVAILABLE
Known release-gate noise: <number>
Required not-run gates: <number>
Required stale evidence: <number>

## Next phase
Benchmark-driven Agent evolution only:
failure cluster -> hypothesis -> challenger -> paired eval -> promote/reject
```

---

# 29. Expected successful end state

The ideal P38.4 exit is:

```text
Harness v5 architecture closure: COMPLETE

Runtime architecture:
FROZEN

Durable followup:
P -> T before execute
same-T restart recovery proved
no T2
terminal reconciliation proved

Release:
exact SHA green on Linux
exact SHA green on Windows
coverage green
release attestation green
runtimeReleaseReady=true

Benchmark evidence:
84 case identities verified
sanitized artifacts committed
aggregate summary machine-derived
failure clusters available
no fabricated metrics

Experiment system:
per-case evaluation context proved
candidate configuration proved
controlled difference explicit
champion evaluator fails closed on confounded comparisons

Documentation:
static HANDOVER does not chase HEAD SHA
CI/release evidence is canonical exact-SHA truth

Next development mode:
STOP changing Runtime architecture
USE benchmark failures to design Agent challengers
```

---

# 30. After P38.4 — development policy

Once this plan passes, do not create:

```text
P38.5 architecture hardening
P39 runtime closure
P40 final-final runtime closure
```

merely because another model benchmark performs poorly.

Instead:

```text
1. Read full 84-case result.
2. Cluster failures.
3. Rank clusters by frequency and severity.
4. Determine whether failure belongs to:
   - model capability,
   - prompt/strategy,
   - tool selection,
   - memory,
   - context,
   - recovery strategy,
   - verification,
   - security behavior,
   - Harness infrastructure.
5. If NOT Harness infrastructure:
   create a narrow challenger.
6. Run baseline vs challenger under comparable provenance.
7. Promote only if quality policy passes.
8. Reject otherwise.
```

Runtime changes after this point require a concrete Runtime bug/security/release-integrity reproducer.

---

# 31. Recommended first evolution analysis after closure

Once the full 84-case evidence is imported, generate a ranked table:

```text
Rank | Failure cluster | Count | Affected suites | Candidate hypothesis
```

Then inspect the top cluster.

Do not start with whichever mechanism seems most interesting.

Start with the evidence.

Examples:

```text
model_error
verification_failure
tool_selection
context_limit
security_denial
```

For every proposed challenger write:

```text
Hypothesis:
The top failure cluster happens because X.

Controlled change:
Only Y changes.

Expected improvement:
Cases A/B/C.

Non-regression set:
Cases D/E/F already passing must remain passing.

Promotion rule:
Existing champion quality policy + provenance compatibility.
```

This is the new normal workflow.

---

# 32. Final stop condition

When all hard DONE criteria pass, print exactly this semantic conclusion in the execution report:

```text
Harness v5 architecture closure: COMPLETE
Runtime architecture: FROZEN
Runtime release target: <FINAL_EXACT_SHA>
Official release attestation: READY
Known release-gate noise: 0
Required not-run gates: 0
Required stale evidence: 0
```

Then separately print one of:

```text
84-case benchmark evidence: VERIFIED
```

or, only if artifacts truly remain unavailable:

```text
84-case benchmark evidence: UNAVAILABLE — no claim fabricated
```

After that:

```text
STOP Runtime closure work.
BEGIN benchmark-driven Agent evolution.
```
