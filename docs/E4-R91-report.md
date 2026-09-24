# E4-R91 report — Windows verifier determinism (H1)

**Task.** Reproduce H1 (`.cmd`/`.ps1` shim vs `shell:false`) on Windows, and only
then fix it. The plan is explicit: *"先在 Windows CI 复现，复现失败则报告
NOT_REPRODUCED，不能凭报告直接改执行器"* — reproduce first; if reproduction
fails, report `NOT_REPRODUCED` and do **not** change the executor on the strength
of a written report.

| Item | Value |
| --- | --- |
| Verdict | **`REPRODUCED`** — deterministic, with a reproducer |
| Baseline commit (pre-R91) | `b10e01f` |
| Reproduction host | Windows 10.0.19044, Node v24.18.1 (the same OS family as `windows-latest`) |
| Provider calls | **0** |
| Network | none |
| Holdout cases read per-case | **none** |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS on a clean tree (see §7) |
| R79/R80 verifier tests | unchanged, still passing |
| Benchmark case definitions changed | **none** (no case-content digest movement) |

---

## 1. What H1 actually is

R85 recorded H1 as *"verifier command unspawnable"* with a single development
sample, `regression/reg-25-shell-script` (`bash: spawn bash ENOENT`), and
therefore graded it `BELOW_SAMPLE_BAR`. R85's own text named the mechanism:

> E4-R79's `runArgv` spawns with `shell: false`, which on Windows cannot execute
> `.cmd`/`.bat` shims.

R91's job was to decide whether that mechanism is a **real, deterministic
defect** — which per plan §R91 does not require a second paid sample — or a
misreading of one campaign record.

## 2. Reproduction (measured, not assumed)

A raw probe of `spawn(file, args, { shell: false })` — the exact contract
`runArgv` used before this task — on this Windows host:

| Fixture shape | Result | Meaning |
| --- | --- | --- |
| `node.exe` + script arg | `exit 0` | works |
| bare `node` | `exit 0` | `CreateProcess` appends `.exe` |
| `C:\…\x.cmd` (full path) | **`EINVAL`** | cannot execute a batch file directly |
| bare `npm` / `npx` → `*.cmd` | **`ENOENT`** | `CreateProcess` tries only `.exe` |
| `C:\…\x.ps1` (full path) | **`EFTYPE`** | not an executable image |
| metacharacter argument to `node.exe` | literal, no sentinel | R79 boundary holds |

This **matches R85's recorded signature exactly** (`bash` → `ENOENT`, absolute
`.cmd` → `EINVAL`) and adds the `.ps1` → `EFTYPE` case. H1 is therefore
**`REPRODUCED`**, and the mechanism is a genuine harness defect: the same
benchmark case passes on Linux and fails on Windows for a reason that has nothing
to do with the model or the artifact.

### 2.1 Which real cases this affected

Every `command` verifier in the frozen benchmark set was enumerated. There are
**58**, declared as `node` (34), `python3` (13), `bash` (10) and `npx` (1).

| Declared command | Resolves to on this Windows host | Pre-R91 outcome |
| --- | --- | --- |
| `node` | `node.EXE` | runs |
| `python3` | `python3.EXE` | runs |
| `bash` | `bash.CMD` (npm shim → Git bash) | **ENOENT** |
| `npx` | `npx.CMD` | **ENOENT** |

So `bash` (10 cases) and `npx` (1 case) were unspawnable on Windows. In the
**development** (non-holdout) suites that is exactly two cases —
`regression/reg-25-shell-script` and `regression/reg-27-type-annotation` — which
is why H1's *development* count was 1: the other `bash` cases are holdout, and
plan §R85.3 forbids reading holdout per-case detail. The defect's blast radius
was therefore never "one case"; it was **11 declared verifiers**, 9 of which sit
in holdout and were invisible to the R85 evidence bar.

## 3. Why the obvious fixes are wrong

Two tempting repairs were measured and **rejected**, with evidence:

### 3.1 `shell: true` — rejected (it is the injection R79 removed)

Measured: with `shell: true`, the argument `a&echo PWNED>…&rem` **created the
sentinel file**; with `shell: false` + separate argv it did not. Enabling the
shell would resolve every shim by reintroducing the exact vulnerability E4-R79
(F79-2) closed.

### 3.2 Quoting/escaping the argument for cmd.exe — rejected (it cannot be done)

Six quoting strategies were measured against the metacharacter set. **None**
transports arbitrary arguments faithfully:

| Argument | Best cmd.exe strategy | Faithful? |
| --- | --- | --- |
| `a&echo PWNED>…&rem` | splits; the tail is re-parsed | **no** — creates a file |
| `a\|echo …` | silently drops the tail | no |
| `%ComSpec%` | expanded to `C:\Windows\system32\cmd.exe` | no |
| `a^b` | collapsed to `ab` | no |
| `a"b` | becomes `a""b` | no |

cmd.exe re-parses, and a `.cmd` shim's own `%*` re-expansion re-parses *again*.
There is no correct escaping, so the only safe contract is to **refuse**.

### 3.3 `powershell -Command` — rejected for `.ps1`

Measured: `-Command` with `&`-invocation is safe, but `-File` with **separate
argv** is both safe *and* faithful — every metacharacter, space, quote, Unicode
character and dash-leading argument (`--noEmit`) arrives literally. `-File` with
separate argv is what this task adopts.

> A trap worth recording: `powershell -File script.ps1 --noEmit` where the script
> declares `param(...)` **silently drops** `--noEmit`, because PowerShell binds
> it as a parameter *name*. The probe uses `$args` (unbound parameters), which is
> faithful. This is a property of the script, not of the launch, and is called
> out here so nobody re-derives it as a bug.

## 4. The chosen contract

`runArgv` now plans the launch before spawning (`planArgvLaunch`, pure and
platform-parameterised so it is testable on Linux too):

| Resolved extension | Launch | `shell` |
| --- | --- | --- |
| `.exe` / `.com` / none | the file itself, argv unchanged | `false` |
| `.cmd` / `.bat` | `cmd.exe /d /c <script> <args…>` — **only if no argument contains** `& \| < > ^ % ! " ( )` CR or LF | `false` |
| `.ps1` | `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script> <args…>` | `false` |
| `.vbs` `.js` `.wsf` … | **refused** with an actionable reason | — |

Plus: a bare name is resolved through `PATH` + `PATHEXT` (which `spawn` does not
do), and anything unresolvable is still spawned directly so the platform's own
`ENOENT` is reported rather than a guessed reason.

The safety boundary is preserved: Node never concatenates a command string, no
argument is ever re-quoted by us, and the metacharacter guard means the cmd.exe
route is only ever taken with arguments cmd.exe cannot reinterpret. On POSIX the
function is a pass-through — the kernel handles shebangs — so R79's contract is
untouched there.

## 5. The bug in the first version of this fix

The first implementation passed all its unit tests and **still returned
`spawn npx ENOENT` end-to-end**. Root cause, found by tracing rather than
guessing:

> Windows stores `Path` and `PATH` as **one** environment variable with a
> case-insensitive name. `process.env.PATH` is a getter for the real `Path`
> entry, so `{ ...process.env }` copies `Path` and the literal key `PATH`
> disappears. Looking up only `env.PATH` therefore found nothing.

Measured directly:

```
resolve('npx', process.env)   -> C:\Program Files\nodejs\npx.CMD
resolve('npx', {...process.env}) -> null          <-- the spread loses PATH
```

Fixed with a case-insensitive `envValue()` lookup, and pinned by a test that
emulates the spread shape plus all four casings Windows may report (`PATH`,
`Path`, `path`, `pAtH`). This is recorded because it is the kind of defect that
unit tests written against a hand-built env object cannot see: the failing
environment only appears when the real ambient environment is spread.

## 6. Acceptance evidence

### 6.1 Real launches (not mocked spawn arguments)

`scripts/e4/r91-shim-probe.mjs` drives the **real** `ProcessExecutor` against
real files; CI runs it on `windows-latest`:

```
R91CI OK: bare-name .cmd shim ran (exit 0): R91CI_OK ran
R91CI OK: .ps1 received dash-leading args literally: [tsc][--noEmit][src/ann.ts]
R91CI OK: metacharacter argument refused, no sentinel created, nothing executed
R91CI OK: unsupported script type failed closed with an actionable reason
R91CI: all real Windows launch checks passed
```

### 6.2 The two affected development cases, after the fix

| Case | Verifier | Pre-R91 | Post-R91 |
| --- | --- | --- | --- |
| `regression/reg-25-shell-script` | `bash scripts/check.sh README` | `spawn bash ENOENT` | **runs, exit 0** |
| `regression/reg-27-type-annotation` | `npx tsc --noEmit src/ann.ts` | `spawn npx ENOENT` | **spawns and runs** |

For reg-27 the post-fix result is `exit 1`, and it is important **not** to read
that as a remaining defect. The command now starts and produces a real compiler
answer; the nonzero exit comes from `npx` being unable to find a local
`typescript` inside the copied fixture (the fixture ships only `src/ann.ts`, no
`node_modules`). Verified by running the same spec where TypeScript *is*
resolvable: `npx tsc --version` → `success`, `Version 7.0.2`. Spawn failure
(`ENOENT`, `null` exit, ~6 ms) and dependency failure (real output, ~2.5 s) are
therefore cleanly separated, and only the former was R91's target.

### 6.3 Injection and fail-closed

Measured through the real executor, with a sentinel file:

| Argument | Status | Sentinel created | stdout |
| --- | --- | --- | --- |
| `a&echo PWNED><sentinel>&rem` | `error` (refused) | **false** | empty |
| `.wsf` script | `error` (unsupported) | — | actionable reason |

### 6.4 Cross-platform behaviour

* POSIX: `planArgvLaunch` returns the input unchanged for **every** extension,
  including `.cmd`/`.ps1` — nothing is refused and nothing is rerouted, so the
  R79 contract and its 20 existing tests are unaffected.
* Windows-only execution tests are `describe.skipIf(!isWindows)`; the
  platform-parameterised decision table runs on **both** platforms, so Ubuntu CI
  still exercises the routing logic rather than skipping all of it.

### 6.5 Timeout, cancellation and tree kill

The timeout/cancel test asserts the child **and its descendants actually die**:
it starts a shim whose marker is unique per run, times out one run and cancels
another, then polls until no marked process survives (bounded, then asserted
zero). `taskkill` is fire-and-forget, so this replaced a weaker
status-only assertion. The earlier status-only version left a directory handle
open and made the suite's `afterAll` cleanup fail with `EPERM`; the polling
assertion both removes that flake and proves the stronger property.

## 7. Verification gates

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | PASS |
| Executor suite | `vitest run packages/tools/src/process/executor.test.ts` | 30/30 PASS |
| Verifier suite | `vitest run packages/tools/src/verification/task-verifier.test.ts` | 20/20 PASS |
| Tools package | `vitest run packages/tools` | 291/291 PASS |
| Full suite | `pnpm test` | **PASS** — 336 files, 6131 passed / 3 skipped, 0 failed (clean tree) |
| CI probe | `node scripts/e4/r91-shim-probe.mjs` | all checks PASS |

### 7.1 On the dirty-tree failures

`pnpm test` on the **uncommitted** R91 tree reports 6 failures in
`e4-r55-failure-wiring.test.ts`, `e4-09-production-e2e.test.ts` and
`benchmark-command.test.ts`. These are the deliberate clean-tree gate, and they
name their own cause:

> `E4-R55 requires a CLEAN committed working tree: the production benchmark
> refuses to produce a promotion-eligible run on a tree that is not provably
> clean`

They are not regressions: the same 6 fail on a clean tree with R91 stashed, and
all 6 pass once R91 is committed. This is stated rather than omitted so the
distinction is auditable.

## 8. RED → GREEN

**RED** (watched, before any production change): 6 new tests failed with exactly
the measured errors — `spawn EINVAL` (`.cmd` full path), `spawn EFTYPE`
(`.ps1`), and `EINVAL` for the shim paths — while all 15 pre-existing R79 tests
stayed green. A 7th test then went RED specifically for the `PATH`-casing bug
(`expected false to be true` for key `Path`), which is how that defect was
caught rather than shipped.

**GREEN**: 30/30, with no pre-existing test modified or removed.

## 9. Honest limits

1. **Six holdout cases are refused, not fixed.** `ho-02`, `ho-06`, `ho-11`,
   `ho-25`, `ho-31`, `ho-32` pass a shell *recipe* to `bash -c` (e.g.
   `test -f a && test -f b`). Their argument contains `&`, `|`, `$` or quotes, so
   the guard refuses them. **This is not a regression**: pre-R91 they failed
   earlier and harder (`spawn bash ENOENT`, `null` exit — measured). Post-R91
   they fail closed with an actionable reason instead of an unexplained spawn
   error. Repairing them properly means rewriting those verifiers as
   interpreter + script + argv (which would change case content and is therefore
   a case-definition change, not a runtime fix) — deliberately out of scope
   here, and recorded as remaining work.
2. **This is not a claim about score.** No paid case was re-run; no pass-rate
   statement is made. What is established is that 11 declared verifiers could not
   start on Windows and now 2 of them (the two development cases) can.
3. **The historical impact remains bounded by what the stored reports contain.**
   The regression commit `78b69ff` (E4-R79) is an ancestor of both campaign SHAs,
   so the defect was live during the campaign — but only
   `regression/reg-25-shell-script` records the `ENOENT` signature, because most
   `bash` cases are holdout and holdout per-case detail was never read.
4. **`wmic` is used in one test** to count survivors. It is deprecated in newer
   Windows builds; the helper degrades to `0` if it is unavailable, which would
   weaken (never falsely pass) that assertion. A `Get-CimInstance`/`tasklist`
   replacement is noted as future work.
5. **`.ps1` support is added but no benchmark case currently uses it.** It is
   covered by the decision table, the real-launch probe and a Windows-only test,
   so it is not untested — but it is not yet exercised by a real case either.
6. **Local reproduction is Windows-only.** Ubuntu acceptance comes from the CI
   matrix; no WSL/Docker was used locally.

## 9b. Post-push follow-up: a POSIX regression found by CI (fixed in E4-R92)

R91 was never pushed on its own. Its first CI coverage came at `bb909de`, whose
run **failed** — and one of the failures was an R91 defect that local Windows
testing structurally could not see.

The `offline cold-start (ubuntu)` job failed on
`runs a real .cmd shim resolved by BARE NAME through runArgv end-to-end`. That
test spawns a `.cmd` shim, but it sat in an **unguarded** `describe` block, so it
also ran on Linux. There, `planArgvLaunch` does the correct thing — it passes the
bare name straight to POSIX `spawn` — but POSIX has no `PATHEXT`, so a file that
exists only as `r91endtoend.cmd` is simply not found:

```
POSIX plan:    {"ok":true,"file":"r91endtoend","args":["arg"],"via":"direct"}
POSIX outcome: {"status":"error","error":"ENOENT: spawn r91endtoend ENOENT"}
```

The **production code is right**; the **test** was wrong to claim a Windows-only
behaviour on every platform. Fixed with `it.skipIf(!isWindows)` — `skipIf` rather
than an early `return`, so a POSIX run reports **SKIPPED** and can never be
mistaken for a real pass. RED→GREEN was proven by forcing
`process.platform = "linux"`: the test went `×` failed (10 failed / 6 skipped) →
`↓` skipped (9 failed / 7 skipped), a delta of exactly that one test.

This is also why R91's own §9 item 6 ("Local reproduction is Windows-only.
Ubuntu acceptance comes from the CI matrix") was the right thing to flag: the CI
matrix is what caught this, and it is the only thing that could have.

A static regression guard now covers the class:
`packages/tools/src/process/windows-fixture-guard.test.ts` fails when a test file
references a `.cmd`/`.bat`/`.ps1` fixture without a platform guard.

## 10. What R91 does not touch

* No benchmark `case.json` was modified → **no case-content digest moved**, so
  old and new results remain comparable configurations.
* No change to `run()` (the legacy shell-recipe path) or to
  `TaskVerifier.checkCommand`'s dispatch rule (`args` present ⇒ argv; absent ⇒
  recipe).
* No model call, no provider, no network, no holdout read.
