# E4-R79 — Fix the Windows command verifier and restore cross-platform CI

Plan: `plan(20260915-052655).md`, task R79 (first of R79–R82).
Scope: `ProcessExecutor` (added argv path), `TaskVerifier` (command dispatch),
and the tests/oracle that exercise them. **No benchmark case content, holdout,
digest, billing or isolation change.** No paid run was performed.

| Field | Value |
| --- | --- |
| Starting SHA | `7798d3a946ad4c8470168a7026166ea280e7b30a` |
| Tested SHA | `78b69ff` (see §7 for the final pushed SHA) |
| Environment | Windows NT 10.0.19044.0 (win32), Node v24.18.1, pnpm 11.21.0, vitest 4.1.10 |
| Provider calls | **0** (no provider is constructed by any test in this task) |

---

## 1. Status summary

| Item | Status | Evidence |
| --- | --- | --- |
| F79-1 platform-unconditional test | **FIXED** | §3, §4 |
| F79-2 structured argv verifier defect | **FIXED** | §2, §3 |
| argv boundary table (spaces/quotes/`$`/`&`/`;`/unicode/empty) | **PASS** | §4 |
| All 6 frozen command specs score correctly | **PASS** | §5 |
| `pnpm test` / `build` / `docs:verify` | **PASS** | §6 |
| Ubuntu + Windows CI | **PASS** | §7 — bound to run id/attempt/head SHA |
| Real-model baseline | **NOT_RUN** | unchanged since R78; cost **UNKNOWN** |

---

## 2. What was actually broken

Two independent defects, confirmed against the live repo rather than taken from
the plan text:

**(a) CI was red on Ubuntu.** GitHub Actions run `34929969915`, attempt 1,
head SHA `7798d3a…`, conclusion `failure`:

| Job | Conclusion |
| --- | --- |
| `install · typecheck · test · build · benchmark-smoke · audit (windows-latest)` | success |
| `install · typecheck · test · build · benchmark-smoke · audit (ubuntu-latest)` | **failure** (step: Unit and integration tests) |
| `coverage gate (ubuntu)` | **failure** (step: Coverage gate) |
| `release attestation (P38-12)` | skipped |

The R77 suite contained a test that hard-asserted `expect(r.passed).toBe(false)`
for a *correct* implementation of `reg-02-fix-reverse`. That is the Windows
verdict; on Ubuntu the verifier returned `true`, so the assertion failed. The
test encoded a platform-specific defect as a universal expectation — it was
guaranteed to be red on one of the two CI platforms.

**(b) The underlying Windows defect.** `TaskVerifier.checkCommand` joined
`command` + `shellQuote(args)` into one string and handed it to the platform
shell. `shellQuote` emitted POSIX single-quote escaping (`` '…' ``), while on
win32 `ProcessExecutor` runs the recipe through `cmd.exe`, which does not
implement it. The recipe was mangled before `node` saw it, so **every**
`kind: "command"` case judged a correct implementation FAILED on Windows. The
measured before/after is in `docs/r79-evidence/r79-probe-raw.txt`.

Deleting the assertion or wrapping it in `skipIf(platform !== 'win32')` would
have made CI green while leaving the user's Windows machine unable to score the
frozen baseline at all. The plan forbids that, and this report records that the
assertion was **replaced by a stronger, platform-independent one**, not removed.

**(c) The defect was also an injection hole.** Because the args were
concatenated into a shell recipe, an argument containing `&` or `;` was executed
as a second command. Observed directly (`docs/r79-evidence/r79-probe-raw.txt`
§2): the arguments `k&echo INJECTED` and `l;echo INJECTED2` both ran.

---

## 3. The fix

**`ProcessExecutor.runArgv`** (new) spawns `spawn(file, args, { shell: false })`.
No shell parses the text, so each argument reaches the child byte-for-byte and a
metacharacter cannot start a second command. Timeout, cancellation, output
truncation, stdout/stderr separation and process-tree cleanup are **shared
verbatim** with the shell path by extracting a single `collect()` helper — the
argv path cannot drift from the shell path on any semantics the verifier relies
on. No simplified executor was copied.

`ProcessExecutor.run` now throws a `TypeError` when neither a `command` string
nor a structured `file` is supplied: an empty recipe must not silently look like
a green verification.

**`TaskVerifier.checkCommand`** gained an explicit, documented dispatch rule:

| Spec shape | Execution | Rationale |
| --- | --- | --- |
| `args` **present** (including `args: []`) | argv, `shell: false` | the spec is a program + argument **vector** |
| `args` **absent** | legacy shell recipe, passed through verbatim | historical callers embed a full recipe in `command` |

The verifier never splits, re-quotes or otherwise re-interprets a recipe string.
`shellQuote` was **deleted** rather than replaced with another hand-written
Windows quoting algorithm, as the plan requires.

---

## 4. Coverage added

| Test | What it pins |
| --- | --- |
| `executor.test.ts` — argv boundary table | 16 argument values (spaces, `'`, `"`, `\`, `()`, `$`, `&`, `;`, `\|`, glob, `<>`, `!`, newline, CJK, empty) arrive **identical** |
| `executor.test.ts` — injection | `a&echo INJECTED`, `b;echo INJECTED`, `c\|echo INJECTED`, `` d`echo x` `` return as **data**; no second command runs |
| `executor.test.ts` — argv lifecycle | timeout, cancellation, output cap and env work on the argv path; real exit code `7`; missing executable reports `error` |
| `executor.test.ts` — fail closed | `run({cwd})` with no contract rejects |
| `task-verifier.test.ts` — dispatch | `args` present ⇒ `runArgv` (shell path is made to **throw** if called); no `args` ⇒ shell path (argv path made to throw); `args: []` ⇒ argv |
| `task-verifier.test.ts` — exit code | nonzero exit surfaces as `exit code 5` |
| R77 oracle — `E4-R79 (was R77 V1)` | correct implementation **PASSES** on both platforms; broken fixture fails; an argv metacharacter cannot execute a second command |

---

## 5. All 6 frozen command specs score correctly

Evaluated through the **REAL `TaskVerifier`** on Windows (not a helper that
re-implements it). Raw output: `docs/r79-evidence/r79-frozen-command-specs.txt`.

| Case | Broken fixture | Correct implementation |
| --- | --- | --- |
| `reg-02-fix-reverse` | FAIL | **PASS** |
| `reg-06-json-parse-test` | FAIL | **PASS** |
| `reg-12-csv-parse` | FAIL | **PASS** |
| `reg-24-error-handling` | FAIL | **PASS** |
| `reg-30-sort-order` | FAIL | **PASS** |
| `stress-10-subagents` (empty `out/parts.md`) | FAIL | **PASS** (10 non-empty lines) |

**Oracle honesty change.** The R77 helper `runCommandSpecDirectly` hand-built a
cmd-native command string and called `ProcessExecutor.run`, i.e. it *bypassed*
the verifier's own command handling. That was necessary while the verifier was
broken, but it meant the oracle could never detect a defect in the code the
benchmark actually runs. It now calls the real `TaskVerifier`. No frozen case
content, expected answer or holdout was modified by this task.

---

## 6. Gates

| Command | Result |
| --- | --- |
| `pnpm build` | exit 0 |
| `pnpm test` | **328 files passed, 5906 tests passed, 3 skipped**, exit 0 |
| `pnpm docs:verify` | `ALL CHECKS PASS`, exit 0 |

**Known pre-existing sensitivity (not a regression from R79).** Three test files
(`benchmark-command.test.ts` E4-R41, `e4-09-production-e2e.test.ts` ×4,
`e4-r55-failure-wiring.test.ts`) fail when the working tree is dirty, because
they drive the promotion path whose clean-tree gate refuses to proceed. This was
verified two ways rather than assumed:

1. With R79's changes present but uncommitted: 3 files failed (6 tests).
2. With R79 committed and all untracked scratch moved outside the tree
   (`git status --porcelain` empty): the same 3 files pass — `148 passed |
   2 skipped` — and the full suite is green.

This matches the R78 finding for the same class of test. It is a property of
those tests (they do not inject the module-local `probeSourceSnapshot`), not of
the verification change made here.

---

## 7. CI evidence

Bound to run id, attempt, head SHA and per-job conclusions in
`docs/r79-evidence/r79-ci.txt`. R79 is not complete unless Windows verify,
Ubuntu verify, coverage and release attestation are all green.

---

## 8. Known boundaries

- **The shell-string path remains, by design.** Legacy callers that put a whole
  recipe in `command` with no `args` still go through the platform shell, so
  their portability semantics are unchanged. Migrating those callers to `args`
  is what makes them platform-consistent.
- **`requirement` specs still fail closed** (no model reviewer wired) — unchanged
  by this task.
- **V2 is unchanged and still real.** The `artifact` verifier checks existence +
  `changedPaths`, never content, so an empty file satisfies `mustChange` unless
  a case adds a content command (as `stress-10-subagents` and the R77 revisions
  do). R79 did not change artifact verification.
- No Linux host is available locally, so the POSIX half of §5 is established by
  CI's `ubuntu-latest` job, not by the author's machine. R82 adds a dedicated
  Linux cold-start job.
