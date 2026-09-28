# E4-R16 — why the release-CLI fixture forward run (POS-FWD) is refused, and what restoring it would cost

**Status of this document: READ-ONLY FINDING. Nothing here is a measured result.**
Every claim below is a *source reading* at `2314ce1db40bfa10dc58b0d136e0696450e90cc8`, not an execution:
the E2E script was **not** run, the scenario was **not** replayed, no build and no gate was run for this
note. Counters, exit codes and pass/fail numbers are deliberately absent because none were observed.

| | |
| --- | --- |
| Source SHA read | `2314ce1db40bfa10dc58b0d136e0696450e90cc8` (local main) |
| Basis | R1 (`task-2`) fixture trust + R5 trusted-build posture, as merged |
| Author | `task-16` evidence note, written after standing down from `task-16` itself (owner `r16-fixturepath`) |
| Runtime Freeze | P38.4-11 clause 2 (security boundary) — this note changes **no** runtime code |
| Paid/external requests | none |

Legend: **[READ]** = verified by reading the cited line(s) at the SHA above. **[INFERRED]** = a
consequence drawn from those readings, not itself executed.

---

## 1. The mechanism that actually blocks POS-FWD

### 1.1 POS-FWD declares `process-exec`, and its checkouts are synthetic **[READ]**

- `scripts/e4/prereg-production-e2e.mjs:407-408` builds the campaign config with
  `isolationBackendId: "process-exec"`, `isolationStrength: "process"`; the same declaration is in
  `scripts/e4/fixtures/n5-prereg-config.json:67-68`.
- `scripts/e4/prereg-production-e2e.mjs:504` `writeArmCheckout(dir, marker, activate, entries)` writes the
  declared entries (`apps/cli/dist/benchmark-command.js` plus siblings) and the marker
  (`:523-526`) into **plain directories**: no `git init`, no HEAD, no clean tree.
- `:911` `runPositiveForward(...)` drives the shipped `node apps/cli/dist/main.js` subprocess over those
  two directories and records the outcome at `:991` / `:1021` / `:1029` (`refusedByDesign`, `ok`).

### 1.2 The executor branches on the DECLARED contract, not on the marker **[READ]**

`apps/cli/src/prereg-arm-executor.ts`:

- `:116-119` `SUPPORTED_ISOLATION` includes `"trusted-build": ["no-os-network-sandbox"]`;
  `:243`/`:245` name the two constants; `:791` computes
  `isTrustedBuild = backendId === TRUSTED_BUILD_BACKEND_ID && strength === TRUSTED_BUILD_STRENGTH`
  and `:792` makes `requireGit` true for it.
- `:863-879` — the **trusted-build branch**. An injected `TrustedBuildGrant` is **binding when present**
  (`:867-869` refuses a pinned checkout whose fields moved) but is **not required**: admission then rests
  on the real git identity alone (`:870-875`, `armGitHeadAndClean` + closure digest), and the absent
  network sandbox is *recorded*, not claimed (`:876-879`).
- `:880-888` — the **R1 branch** (any other declared contract, i.e. today's `process-exec`). This calls
  `verifyFixtureCheckoutTrust(deps.trustedFixtureCheckouts, armDir, arm.armId)` and, when that capability
  is absent, refuses `EGRESS_ISOLATION_UNAVAILABLE` **before the child starts**.

### 1.3 Why the capability cannot be handed to a subprocess **[READ]**

`createFixtureCheckoutTrust` (`:180-201`) brands its value with a module-private
`FIXTURE_CHECKOUT_TRUST_BRAND` (`:150`) and `isFixtureCheckoutTrust` (`:202-208`) requires that brand. A
Symbol cannot survive JSON, env or a CLI flag, and `createProductionPreregRunner` only forwards what its
caller injected (`prereg-production-runner.ts:75`, `:292`, `:364-366`). **[INFERRED]** therefore a shipped
subprocess, which has no in-process test host, can never satisfy the R1 branch — the refusal at `:991` is
the correct fail-closed outcome, not a wiring accident.

---

## 2. Consequence for the positive forward run

**[INFERRED, from §1]** The POS-FWD positive path is restorable **only** by switching the campaign's
declared posture to `trusted-build` / `no-os-network-sandbox` **and** pointing the subprocess at two REAL,
clean, git-pinned checkouts:

- `createTrustedBuildGrant` (`:299-339`) requires for each arm a canonical directory, a 40-hex HEAD in a
  git work tree (`:306-309`), a regular non-symlink build entry (`:310-314`), and it pins the closure
  digest and entry hash (`:319-320`). A synthetic non-git tree throws `TRUSTED_BUILD_NOT_PROVEN`.
- `:327-329` refuses `ARM_BUILD_IDENTICAL` when both pins resolve to the same build digest, so a pair of
  work trees at the **same** SHA is not a pair.
- Two distinct-SHA, clean, built checkouts are exactly the real arm pair that `task-15` is producing;
  the same condition is enforced without any grant by `armGitHeadAndClean` (`:364-374`) and
  `armGitIdentity` (`:390-400`).

**No R1 invariant needs weakening for any of this.** The capability stays Symbol-branded and in-process
(`:150`, `:202-208`), the marker stays a regular-file breadcrumb rather than a trust source
(`:133`-area comment and `:881-888`), and an undeclared / marker-only / flag-driven attempt still refuses
`EGRESS_ISOLATION_UNAVAILABLE` at `:883-888` before any request.

---

## 3. What it costs, and what POS-FWD therefore depends on

**[INFERRED]** Restoring the positive phase costs **two real arm builds** plus a **distinct-SHA pair**:
one real git work tree per arm, each built so its declared execution closure resolves, with different
entry bytes so the two closure digests differ. That is the R5 real-pair path, not a fixture trick — and it
is the reason this note names the dependency explicitly:

> **The POS-FWD positive path DEPENDS on the real arm pair. It does not depend on, and must not be
> restored by, any fixture-only mechanism** (marker file, env var, CLI flag, sentinel key, or an
> in-process capability smuggled across the process boundary). Those are precisely the paths R1 closed.

Until that real pair exists on the machine running the E2E, the honest POS-FWD result remains the
recorded refusal (`refusedByDesign` at `:991`/`:1021`, and the readiness text at `:1190`/`:1210`), which is
the outcome `R7`'s status page carries.

---

## 4. What this note does NOT claim

- **Not measured:** the E2E script, `runPositiveForward`, the readiness script, the mutation gate, any
  vitest suite, `pnpm typecheck`, any build. No exit code, counter, HTTP number or pass/fail count was
  observed while writing this note.
- **Not verified at this SHA:** R1's four suites (`prereg-fixture-checkout-trust`,
  `prereg-fixture-checkout-grant`, `tool-call-efficiency-fixture-billing-boundary`,
  `tool-call-efficiency-fixture-transport-grant`) were not re-run here.
- **Not attempted:** any edit to `apps/cli/src/prereg-arm-executor.ts`,
  `prereg-command.ts`, `prereg-production-runner.ts`,
  `packages/evaluation/src/tool-call-efficiency-preregistration-v2.ts` or the E2E script — `task-16`
  belongs to another live owner. The partial uncommitted work in `%TEMP%\r-w7-fixture` was neither read
  nor reused, so this note neither keeps nor rejects it.
- **Unknown stays unknown:** where a quantity was not observed it is omitted rather than set to `0`.
