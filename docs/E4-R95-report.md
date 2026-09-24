# E4-R95 report — the authorization envelope is parsed, timed and budgeted strictly

**Task.** Plan §R95 (findings D and E): a malformed, expired or unenforceable plan
must be explicitly `NOT_READY` *before* authorization and execution, and must
never report `READY` merely because the authorization variables have not been
exported yet.

**Scope.** `packages/evaluation/src/r92-authorization.ts` and its tests. This
module executes nothing: it builds no provider, imports no HTTP client, and its
only import is `computeRuntimeConfigHash`/`stableStringify` from `manifest.js`.

| Item | Value |
| --- | --- |
| Base SHA | `e7158ec47c93dcd8efc5b155133f6290ff250ce1` |
| Real provider calls | **0** (structurally — the module cannot construct a provider) |
| Network | none |
| Paid steps executed | **none** |
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0 |
| R95 test file | 60 passed / 60 |
| `packages/evaluation` suite | 91 files, 1277 tests, all passed |
| `pnpm docs:verify` | `ALL CHECKS PASS` |
| `git diff --check` | exit 0 |

---

## 1. The defects (findings D and E), restated from source

### D — readiness was computed *after* the authorization variables

`r92AuthorizationGate` checked the auth env vars at line ~531 and returned
`planStatus: "READY_FOR_AUTHORIZATION"` when they were absent — **before** it
evaluated the cap violations at line ~572. So a plan whose budget is
unenforceable (a declared-but-unexecutable cost/token cap, or no global
model-call cap at all) reported itself as approvable precisely *because* nobody
had exported the variables yet. Readiness is a property of the PLAN; it was being
computed as a property of the environment.

### E — every time comparison was guarded by `Number.isFinite`

```ts
const nowMs = Date.parse(facts.now);
const expiresMs = Date.parse(authorization.expiresAt);
if (Number.isFinite(nowMs) && Number.isFinite(expiresMs) && nowMs > expiresMs) { … }
```

`Date.parse` returns `NaN` for an unparseable timestamp, and `Number.isFinite(NaN)`
is `false`, so a malformed `expiresAt` made the expiry check **skip entirely** and
the envelope was treated as unexpired. `r92AuthorizationIssuesV1` had the same
shape for its `expiresAt > createdAt` rule, so a malformed `createdAt` was
equally unchecked. Additionally:

- nothing rejected a timestamp **without a timezone** or a date-only string;
- nothing rejected a `createdAt` in the **future**;
- `nowMs > expiresMs` meant `now == expiresAt` was still treated as VALID;
- the envelope was trusted by TypeScript **type**, not parsed from `unknown`;
- no cap `value` numeric contract existed (NaN, `Infinity`, negative, string and
  unsafe-integer values all passed), nor per-cap uniqueness, nor a
  scope-vs-cap-name check;
- `r92CapViolations` trusted the declaration's own `enforcement`/`blocked` fields;
- case selection excluded only the `holdout/` **prefix**, so `tools/…` or a bare
  id could be selected.

## 2. What was built

All of the following are in `packages/evaluation/src/r92-authorization.ts`.

### 2.1 An explicit time contract

`R92_TIMESTAMP_PATTERN` requires a timezone designator
(`Z` or `±HH:MM`). `parseR92Timestamp(value: unknown): number | null` returns
`null` — never `NaN` — for a non-conforming string, a non-string, or an
**impossible calendar date**. The calendar fields are range-checked
independently of `Date.parse`, because `Date.parse` silently rolls impossible
dates over (`2026-02-30` becomes March 2), which would accept a date that does
not exist.

`parseR92Timestamp("2026-09-20T08:00:00+08:00")` and
`parseR92Timestamp("2026-09-19T20:00:00-04:00")` both equal
`parseR92Timestamp("2026-09-20T00:00:00.000Z")`: an equivalent instant written
three ways is one instant.

### 2.2 Readiness before authorization, in a fixed order

The gate is now two explicit phases, and the phase decides the `planStatus`:

- **Phase 1 — READINESS** (a property of the PLAN; a refusal here is `NOT_READY`
  and no human decision could change it):
  1. the time contract, against `facts.now` only;
  2. structure and static self-consistency;
  3. mode capability and the budget surface;
  4. required observations (source SHA, case fingerprints, provider/model,
     endpoint, per-arm build identity).
- **Phase 2 — AUTHORIZATION** (a property of the ENVIRONMENT; a refusal here
  stays `READY_FOR_AUTHORIZATION` with `runStatus: NOT_RUN`, because the plan
  itself is still approvable): the two env switches and the digest match.

Two helpers, `notReady` and `ready`, make the distinction structural rather than
a property of whichever `return` a reader happens to be looking at.

### 2.3 The boundary is inclusive, and the clock is injected

`nowMs >= expiresMs` is EXPIRED — the instant the window closes is already
closed. `createdMs > nowMs` is `AUTHORIZATION_NOT_YET_VALID`, with **no clock
tolerance** (the plan asks for the tolerance policy to be explicit; the explicit
policy is zero). An unreadable `facts.now` is itself a refusal, because
evaluating expiry against an unreadable clock is exactly the skip this finding is
about.

The gate reads `facts.now` and nothing else. `facts` is a parameter, so a test
injects the clock and the verdict cannot depend on the machine's current time.

### 2.4 One shared cap contract, so a self-report cannot be evidence

`capContract(cap, value, invocationMode)` is the single source of truth for the
`{scope, enforcement, blocked}` triple. `classifyR92Caps` **builds** declarations
with it and `r92CapDeclarationIssues` **checks** declarations against it. Because
the expected label is computed from the cap name, its value and the invocation
mode — never read from the input — an envelope cannot assert a capability the
measured call sites do not have.

`r92CapDeclarationIssues(caps, auth)` reports, per cap name:

- an unknown field (the cap schema is closed) or an unknown cap name;
- a **duplicate** name, and specifically a duplicate that **disagrees** on value
  or scope (a conflicting duplicate has no single authoritative bound);
- a value that is not a **positive safe integer** — rejecting `NaN`, `±Infinity`,
  negatives, zero, strings, non-integers and values beyond `MAX_SAFE_INTEGER`;
- a `scope` that does not match the layer that owns the cap;
- an `enforcement`/`blocked` self-report that contradicts the measured layer;
- missing evidence, and for `maxModelCalls` evidence that does not state whether
  the cap bounds **logical** generate calls or **physical** HTTP/retry attempts;
- `maxLogicalRuns` below `cases × arms × repetitions`, i.e. a cap that cannot
  contain the plan it authorizes;
- a missing required cap.

`classifyR92Caps` now states the unit explicitly in the `maxModelCalls` evidence:
it bounds logical generate calls, and a transport retry is a separate request the
cap does not count — so it is **not** a fully-qualified billing bound.

### 2.5 The envelope is parsed from `unknown`

`parseR92AuthorizationV1(raw: unknown)` never throws. It reports a field path for
every problem and returns a non-null `authorization` only when there is nothing
to report. The whitelist is closed at the top level, inside each arm, and inside
each cap entry. **Unknown fields are named by KEY, never by value** — the value
may be a credential. A plan that tries to carry its own `now` is refused: the
executor's clock is the only trusted time source.

### 2.6 An allow-list for case selection

`R92_SUPPORTED_SUITES = ["regression", "stress"]`. A case id must be
`<suite>/<case>` with a supported suite, so `tools/whatever`, a bare id and
`holdout/reg-16` are all refused. The synthetic `rehearsal/` suite used by
`r92-rehearsal.ts` is accepted by the same rule (so the rehearsal passes the real
validator, not a relaxed copy) but is kept **out** of `R92_SUPPORTED_SUITES`, so
no real plan can select it.

### 2.7 A closed gate-code set

`R92_GATE_CODES` is a `const` array with the type derived from it, so the runtime
list and the type cannot drift. Two codes are new:
`AUTHORIZATION_TIME_INVALID` and `AUTHORIZATION_NOT_YET_VALID`. `CAP_INVALID` is
new, distinguishing a malformed cap declaration from an unenforceable-but-valid
one.

## 3. RED → GREEN

### RED (before implementation)

Against the committed source (`git checkout --` on both files, then restored
byte-identically — verified by SHA256), the R95 test file failed as required:

```text
❯ packages/evaluation/src/r95-authorization-strictness.test.ts (60 tests | 44 failed) 43ms
Test Files  1 failed (1)
     Tests  44 failed | 16 passed (60)
```

The failures were **not** only "the new API does not exist yet". The following
assertions failed against the *old, working* code, i.e. they are the defects
reproduced rather than new surface area:

| RED assertion | Meaning |
| --- | --- |
| `expected true to be false` (×6) | An unparseable `expiresAt`/`createdAt` left `authorizedToExecute` **true** — the skipped-comparison defect |
| `expected 'READY_FOR_AUTHORIZATION' to be 'NOT_READY'` (×2) | The finding-D defect: a blocked cap and a missing global budget both reported READY because the env was empty |
| `expected 'PAID_AUTHORIZATION_REQUIRED' not to be 'PAID_AUTHORIZATION_REQUIRED'` | A plan defect was masked by the missing-authorization code |
| `expiresAt=2026-09-17T00:00:00: expected 'PLAN_INVALID' to be 'AUTHORIZATION_TIME_INVALID'` | A timezone-less timestamp was refused, but as a generic plan error rather than a time error |
| `expected false to be true` | `now == expiresAt` was accepted (exclusive boundary) |

### GREEN (after implementation)

```text
✓ packages/evaluation/src/r95-authorization-strictness.test.ts (60 tests) 30ms
Test Files  1 passed (1)
     Tests  60 passed (60)
```

Regression suites, unchanged behaviour:

```text
✓ packages/evaluation/src/r92-authorization.test.ts (38 tests)
✓ packages/evaluation/src/r92-rehearsal.test.ts (11 tests)
✓ packages/evaluation/src/r92-plan.test.ts (13 tests)
Test Files  4 passed (4)
     Tests  122 passed (122)
```

## 4. Non-vacuity — every guard mutation-tested

Each fix was reverted **in isolation** and the R95 file re-run. The source was
restored byte-identically after each mutation and the restore verified by SHA256
(`5e21d001fdef71b049f5b987a9a0c6248cef0b2d4d5d1d190ef0df17d826a5d4`, unchanged).

| Mutation | Result |
| --- | --- |
| M1 unparseable timestamp is not refused (`Date.parse` + `isFinite` guard restored) | **CAUGHT** — 3 failed |
| M2 expiry boundary exclusive again (`now == expiresAt` accepted) | **CAUGHT** — 1 failed |
| M3 no future-`createdAt` check | **CAUGHT** — 1 failed |
| M4 a bad cap declaration is skipped, so a `NOT_READY` plan reports READY | **CAUGHT** — 2 failed |
| M5 the cap's self-reported `enforcement` is trusted | **CAUGHT** — 1 failed |
| M6 the case-id rule is a `holdout` denylist again, not an allow-list | **CAUGHT** — 1 failed |

**M5 initially ESCAPED**, and the escape was a real weakness in the test rather
than in the code: the "does NOT trust the self-reported enforcement field" case
set `enforcement: "runtime-enforced"` while leaving `blocked: false`, so the
*blocked* check caught the entry and the test passed without ever reading the
field it claimed to test. The fixture now isolates the lie to `enforcement`
alone (`blocked: true`, i.e. what the measured layer implies) and additionally
asserts the issue text names `enforcement`. M5 is caught as a result. This is the
same class of trap that bit the E4-R92 guard (see `docs/E4-R93-report.md` §5).

Two of my own R95 tests were also corrected **before** GREEN, because they would
have passed vacuously:

- "accepts every case in the frozen R87 selection" originally used a 1-element
  list, so the 6–10 count message — which itself contains the word `holdout` —
  satisfied it. It now uses the full 8-case selection and asserts `issues`
  `toEqual([])`.
- The `tools/`, bare-id and `holdout` rejections originally used 1-element lists
  for the same reason. They now splice the bad id into 7 valid ids so the list
  stays at 8 entries and the count rule cannot be the reason.
- The duplicate-cap test originally gated the clean `auth` envelope while
  asserting `authorizedToExecute === false`; it now gates the envelope that
  actually carries the duplicate.

## 5. Verification

| Gate | Command | Result |
| --- | --- | --- |
| Types | `pnpm typecheck` | exit 0 |
| Build | `pnpm build` | exit 0 |
| R95 | `pnpm vitest run packages/evaluation/src/r95-authorization-strictness.test.ts` | 60 passed |
| R92 regression | `pnpm vitest run …r92-authorization.test.ts …r92-plan.test.ts …r92-rehearsal.test.ts` | 62 passed |
| Package | `pnpm vitest run packages/evaluation` | 91 files, 1277 tests passed |
| Full suite (clean tree) | `pnpm test` in `D:\r95-clean-wt` at `481f9f1` | 343 files, 6355 passed, 3 skipped, exit 0 |
| Docs | `pnpm docs:verify` | `ALL CHECKS PASS` |
| Whitespace | `git diff --check` | exit 0 |

The offline rehearsal still reports **12/12 scenarios, 0 failed, 81 fake-provider
requests, 0 external requests**, and the R92 plan still builds and still reports
`READY_FOR_AUTHORIZATION / NOT_RUN`.

### 5.1 The dirty-tree precondition

Per plan §1 line 46, the full `pnpm test` run triggers the repository's existing
clean-tree guard on a dirty working tree. This is recorded as an environment
precondition and re-verified in an isolated clean checkout — the user's
uncommitted changes are **not** stashed or deleted.

`git worktree add --detach D:\r95-clean-wt 481f9f1` → `HEAD` at
`481f9f157d57644dfd2e5a5612ffd92d541b409b`, `git status --porcelain` **empty**:

```text
pnpm test   (in D:\r95-clean-wt)
 Test Files  343 passed (343)
      Tests  6355 passed | 3 skipped (6358)
   Duration  233.41s
EXIT=0
```

The three skipped tests are the pre-existing Windows-only skips
(`it.skipIf`), unchanged by R95.

### 5.2 The plan digest moved — and why that is not a fact change

`docs/E4-R92-report.md` and `docs/E4-R88-R91-evidence-table.md` pinned the R92
plan digest `ffe3bea77e27283917847536a08d351e33f26d2ac0773b59fc590926868970f1`.
It is now `f81cc6700bd0b1b0134e02942b5307e28103e2e2a66dc3aefd98afa7f61b6d8a`.

The digest moved because R95 changed the **content** of the cap declarations, not
because any repository fact changed: `maxModelCalls`'s `evidence` now states the
logical-vs-physical unit, which plan §R95 line 146 requires, and the
scope/enforcement/blocked labels are now derived by the shared `capContract`. The
same SHAs, the same 8 cases, the same selection digest, the same endpoint and the
same expiry produce the new value.

**Neither digest was ever authorized**, so no approval is invalidated. The old
value remains in git history as the R92 value and is explicitly marked
**not to be used for authorization**. This is recorded in `docs/E4-R92-report.md`
§10 "Digest supersession (R95)" rather than silently overwritten.

## 6. Honest limits

- **This module still executes nothing.** Every claim above is about refusing
  invalid input offline. No real provider request was made and no paid step ran.
- **Finding F is untouched by R95.** `r92AuthorizationGate` is implemented and
  its refusals are proven offline, but it is still **not wired into the generic
  `agent benchmark` path**. The env variables remain a convention, not a
  mechanism. That is R97's scope.
- **The caps are labelled, not created.** `maxModelCalls` remains
  runtime-enforced only for a single invocation; `maxEstimatedTokens` and
  `maxEstimatedCostUsd` remain unenforceable at the call layer, so a *declared*
  one is still BLOCKED. R95 makes that honest, it does not make it enforceable.
- **A logical-call cap is not a billing bound.** Stated in the evidence text; no
  physical-request counter was added.
- **No clock tolerance is granted** for a future `createdAt`. That is a policy
  choice, stated explicitly, not a measurement.
- **Findings A/B/C/G** are untouched by R95 (A/B/C were R93/R94; G is R96).

## 7. Files

| File | Change |
| --- | --- |
| `packages/evaluation/src/r92-authorization.ts` | Time contract, `parseR92Timestamp`, `parseR92AuthorizationV1`, `R92_GATE_CODES`, `R92_SUPPORTED_SUITES`, `capContract`, `r92CapDeclarationIssues`, readiness-first gate |
| `packages/evaluation/src/r95-authorization-strictness.test.ts` | **New** — 60 tests across 6 describes |
| `packages/evaluation/src/r92-rehearsal.ts` | Synthetic case ids carry the `rehearsal/` suite prefix so they pass the same allow-list |
| `docs/E4-R92-report.md` | Digest supersession; cap unit stated |
| `docs/E4-R88-R91-evidence-table.md` | New digest; cap unit stated |

### Historical evidence, byte-identical

Unchanged by R95 (asserted by the R94 selfcheck §9 on every run):

- `docs/evidence/e4-r87-phase-a-manifest.json` = `cfecb47172c3d3bb3d4e529985acb902c8babcd44711e6854153aa354ce967e1`
- `docs/evidence/e4-r88-phase-a-manifest.json` = `d3bd5a1d90225a3bd88f1c9ea10f79d371118244bcd3f116856bb9fb0912ec69`
- `docs/evidence/e4-r85-failure-taxonomy.json` = `861557f093fdaac69df56e08c1ac900e1e2462e09fd241d6b78a33bbde3454e8`
