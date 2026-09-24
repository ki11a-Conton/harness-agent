# E4-R81 — Keyless billed planning, explicit plan identity, endpoint-bound digest

Plan: `plan(20260915-052655).md`, task R81 (third of R79–R82).
Scope: `ExecutionPlanV1` schema, `apps/cli` provider identity + benchmark CLI,
the runbook, and a new helper script. **No provider was contacted; no key was
used for planning; no pricing was invented.**

| Field | Value |
| --- | --- |
| Starting SHA | `edf9b05` (E4-R80) |
| Environment | Windows NT 10.0.19044.0 (win32), Node v24.18.1, pnpm 11.21.0, vitest 4.1.10 |
| Provider calls | **0** |

---

## 1. Status summary

| Item | Status | Evidence |
| --- | --- | --- |
| F81-1 keyless billed dry-run | **FIXED** | §3 |
| F81-2 endpoint bound into the digest | **FIXED** | §4 |
| Secret hygiene (userinfo/query never stored) | **PASS** | §5 |
| Legacy `e4-01` plans non-executable | **PASS** | §6 |
| Runbook ordering contradiction removed | **FIXED** | §7 |
| `plan`/`execute` helper script | **PASS** | §8 |
| Windows/Ubuntu CI | **PASS** | §9 |
| Real-model baseline | **NOT_RUN** | §10 |

---

## 2. The two defects

**F81-1 — the plan identity depended on key PRESENCE.** `providerId`/`modelId`
were derived from `process.env.OPENAI_API_KEY`, and `billingClassForProvider`
returned `offline-test` whenever no key was present. A keyless dry-run could
therefore only ever produce a **stub** plan. The runbook said to fix
provider/model before the dry-run, but its example only set `OPENAI_MODEL` in the
execution phase — so the documented flow either exposed the key early or carried
a stub digest into a billed execution and failed with a digest mismatch.

**F81-2 — the digest did not cover the endpoint.** The plan bound provider and
model but not `OPENAI_BASE_URL`, so changing the endpoint after confirmation left
the confirmed digest valid: the authorization covered strictly less than the run
it was supposed to authorize.

**Measured before/after.** Under `e4-01`, two dry-runs differing ONLY in endpoint
produced the **same** digest. They now differ (`docs/r81-evidence/r81-plan-identity.txt` §4).

---

## 3. F81-1 — planning without a key

Explicit identity flags are now the source of truth, with a documented precedence:
**explicit flag > environment > stub**.

| Flag | Accepted values |
| --- | --- |
| `--provider` | exactly `openai` — the only externally-billed provider this build can actually resolve |
| `--model` | any non-empty model id |
| `--endpoint` | a valid absolute http(s) URL |

Rejecting any other `--provider` value is deliberate: recording an unsupported id
as the plan identity would authorize a plan naming a provider that cannot be
resolved at execution time.

Billing class now follows the **planned identity**, not key presence, so:

- a keyless `--provider openai` dry-run is `external-billed` with
  `providerCalls: 0` and exit 0 — it never connects, so it needs no key;
- execution still requires **all** of: a resolvable provider, credentials,
  `RUN_PAID_BENCHMARKS=1`, a positive model-call cap, and a matching digest —
  each refused **before the first `generate`**.

The executor also now derives its model id from the **confirmed plan** rather than
re-reading the environment, closing the drift window between confirmation and
execution.

## 4. F81-2 — the endpoint enters the digest

`--endpoint` is normalized to a **non-secret identity** (sha256 over
`protocol//host[:port]path`) and folded into the plan as `endpointIdentity`, so it
is covered by `planDigest`. Normalization rules are explicit and tested:

| Input | Digest |
| --- | --- |
| `https://api.example.test/v1` | baseline |
| `https://API.Example.Test/v1` (host case) | **same** |
| `https://api.example.test/v1/` (trailing slash) | **same** |
| `https://api.example.test:443/v1` (default port) | **same** |
| `https://api.example.test/v2` (path) | **different** |
| `http://api.example.test/v1` (scheme) | **different** |

`null` is a legal, meaningful value: "the provider's built-in default endpoint".
Changing the provider, model, endpoint, any of the four budgets, the case
contents, or the source tree invalidates a previously confirmed digest, and every
such change is refused with `providerCalls = 0`.

## 5. Secret hygiene

Userinfo and query tokens in `--endpoint` are stripped by normalization and never
reach the plan, the printed summary, the artifact or the saved digest file. The
tests assert the raw URL, the password and the query token are all ABSENT from the
emitted plan while `endpointIdentity` is present as 64-hex.

## 6. Migration: `e4-01` → `e4-02`

Adding a digest field without a version change would silently reinterpret old
artifacts as if they had been endpoint-authorized. Instead:

- new plans are written as **`e4-02`**, which always carries `endpointIdentity`;
- **`e4-01` plans still PARSE** — their history is not erased — but
  `parseExecutionPlan` flags them `legacy: true`, and
  `executionPlanAuthorizationIssue()` refuses them as execution authorization with
  an explicit message telling the operator to re-run the dry-run;
- `e4-01` is not an error at parse time, precisely so old evidence remains
  readable and auditable.

No artifact is silently upgraded.

## 7. Runbook corrections

`docs/E4-R74-baseline-runbook.md`:

- **§2** now fixes `--provider`/`--model`/`--endpoint` at the dry-run, explicitly
  keyless, and states that the dry-run needs no credentials.
- **§3** is retitled and reduced to *adding credentials and the paid switch only*;
  it warns that changing any identity parameter there invalidates the §2 digest.
  The old contradiction ("§3 sets the model but §2 already bound it") is gone.
- **§2.1** adds endpoint normalization and endpoint-change invalidation.
- **§2.1.1** documents that legacy `e4-01` digests are not reusable.
- **§2.3** documents the helper script.

## 8. `plan` / `execute` helper script

`scripts/baseline-plan.ps1` splits the flow so a paid run cannot happen by
accident. Both phases were exercised for real (evidence §1–§3):

| Guard | Behaviour |
| --- | --- |
| `plan` without all four budget caps | refused, naming the missing flag |
| `plan` | never reads or writes a secret; forces `RUN_PAID_BENCHMARKS` unset; asserts `providerCalls === 0` before saving |
| `plan` on a path containing a space | works |
| `execute` without `-PlanDigest` | refused — **never** auto-reuses the last saved digest |
| `execute` without `-AuthorizePaidRun` | refused |
| `execute` with a key but a wrong digest | `plan digest mismatch`, before any provider call |

The script writes only the digest (`plan.digest`, 64 hex chars) — verified to
contain no endpoint credential, and no key is ever written to disk.

## 9. Gates and CI

| Command | Result |
| --- | --- |
| `pnpm build` | exit 0 |
| execution-plan suites (R22/R27/R28/R33/R38/R43) | 52 passed — legacy plans still parse |
| `apps/cli/src/benchmark-command.test.ts` (E4-R81 block) | 11 passed |
| `pnpm test` on a clean tree | green (see `docs/E4-R82-report.md` for the final run) |

CI: the R81 commit is validated by the final full-matrix run recorded in
`docs/E4-R82-report.md`, bound to run id, attempt and head SHA.

## 10. Boundaries

- **`--provider openai` is a plan-identity statement, not a connectivity claim.**
  A dry-run only records that this id is the one the plan is authorized against.
- **The four caps remain partly operator discipline.** The CLI enforces a
  positive `--max-model-calls` and the digest match for billed runs; the other
  three are validated when supplied. The runbook requires all four as policy and
  the helper script now refuses to run without them.
- **No pricing is asserted anywhere.** The sample plan's `estimatedCostUsd` is the
  operator's own cap; real baseline cost remains **UNKNOWN**.
- The real baseline remains **NOT_RUN** — nothing here authorizes it.
