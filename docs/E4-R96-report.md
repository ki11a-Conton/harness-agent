# E4-R96 report — the Windows script path resolves in the cwd it runs in, and the execution boundary is measured

**Task.** Plan §R96 (finding G): make Windows command resolution use the SAME cwd
the process actually spawns in, complete the shim-path/argument/interpreter
contract, and remove sensitive-argument echo from failure messages.

**Scope.** `packages/tools/src/process/executor.ts` and its tests.

| Item | Value |
| --- | --- |
| Base SHA | `44a9d5b` (working tree on top of it) |
| Real provider calls | **0** — no provider is constructed anywhere in this change |
| Network | none |
| Paid steps executed | **none** |
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0 |
| R96 test file | 25 passed / 25 |
| `packages/tools` suite | 25 files, 325 tests, all passed |

---

## 1. The defect (finding G), restated from source

`resolveWindowsCommand` decided whether a script exists with a path that was
resolved against the **parent process's** cwd:

```ts
if (file.includes("\\") || file.includes("/")) return existsSync(file) ? file : null;
```

…while `runArgv` spawned with `opts.cwd`:

```ts
const plan = planArgvLaunch(opts.file, opts.args ?? [], env);   // no cwd
const child = spawn(plan.file, plan.args, { cwd: opts.cwd, ... });
```

With `parent cwd = A` and `opts.cwd = B` the two disagree. Two outcomes, and the
second is the dangerous one:

1. `./tool.cmd` exists only under B → `existsSync` misses it → the file is NOT
   recognised as a `.cmd`, so it is NOT routed through cmd.exe → CreateProcess
   cannot run a `.cmd` → the spawn fails with EINVAL/ENOENT.
2. `./tool.cmd` exists under BOTH → the resolver returns the path under **A** and
   hands THAT to cmd.exe. The plan runs, exit code 0, and the **wrong script** ran.

Plan §R96 line 188 names exactly this: "父 cwd 与子 cwd 不同的正例执行正确脚本，不会误跑父目录同名文件."

Two further gaps were in the same function (plan §R96 lines 179 and 181):

- the cmd-metacharacter refusal inspected only the **arguments**; the resolved
  **script path** was interpolated into `cmd.exe /d /c <path>` unchecked;
- the refusal echoed the offending argument with `JSON.stringify(arg)`, and a
  verifier argument can carry a credential.

## 2. What was built

### 2.1 One cwd for resolution and spawn

`resolveWindowsCommand(file, env, cwd?)` takes the execution cwd and uses it as
the base for every **relative** resolution:

- a relative script path (`./tool.cmd`, `.\tool.cmd`) resolves against it;
- a relative `PATH` entry (`.`) resolves against it.

`planArgvLaunch(file, args, env, platform, cwd?)` threads it through, and
`runArgv` passes `opts.cwd` to the planner **and** to `spawn`, so the script that
is resolved is the script that is executed.

A BARE name is still a pure `PATH` lookup. No implicit current-directory search
was added — plan §R96 line 177 forbids it for compatibility, and it would let an
unrelated file in the working directory hijack a resolved command. There is a test
for exactly that.

`isAbsolutePath` is deliberately host-independent (`/^[A-Za-z]:[\\/]/` plus UNC)
because `path.isAbsolute` is host-specific: on Linux `C:\x` is not absolute, and
the decision table is asserted on every platform — that is what makes it
CI-coverable rather than Windows-only.

### 2.2 The measurement that sets the path rule

The path rule is **measured**, not guessed. Harmless fixtures in temp dirs, real
`spawnSync("cmd.exe", ["/d","/c", script], {shell:false})`:

| path contains | cmd.exe result |
| --- | --- |
| `plain`, `sp ace`, `中文` | ran the script (exit 0) — **safe, accepted** |
| `(` `)` | `'C:\…\par'` is not recognized — the path was **truncated** |
| `&` | `'C:\…\am'` is not recognized |
| `^` | the system cannot find the path |
| `;` `=` | `'C:\…\semi'` / `'C:\…\eq'` is not recognized |
| `%` | ran **only because no variable `cent` existed**; with `cent=XXX` defined, `per%cent%` FAILED — environment-dependent, so refused |
| `!` | ran only because delayed expansion is off by default — a cmd.exe option, not a property of the path, so refused |

The `%` case was verified by re-running the same fixture with `cent` defined and
observing the failure. That is why `%` and `!` are refused despite "working".

Space and non-ASCII are deliberately **absent** from the refusal set: they are
transported correctly and refusing them would break the ordinary Windows path with
a space in it. There is a test that they are still accepted.

The check is scoped to the **cmd.exe route only**. Measured separately:
`powershell -File <path>` transports `& % ! ^ ( )` in a PATH correctly, because
PowerShell is not cmd.exe and receives the path as one argv entry. Copying the cmd
rule to that route would be an unjustified restriction, and the tests pin that it
is not copied.

### 2.3 The refusal no longer echoes the argument

```ts
`refused to launch ${resolved} via cmd.exe: argument ${i} contains a cmd metacharacter. ` +
```

The index and the reason are kept; the value is gone. A canary-shaped credential in
an argument is asserted to appear in neither `plan.reason` nor `out.error`,
`out.stdout` or `out.stderr` — including when a *different* argument is the
offender and when the *path* is the offender.

### 2.4 The interpreter and execution-policy statement

`.ps1` routes through `pwsh`, then `powershell`, then `powershell.exe`, with
`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>` and separate
argv. The source now states explicitly that `-ExecutionPolicy Bypass` relaxes the
policy for **this process only** and does **not** override an AppLocker/WDAC/group
policy that forbids the script — such a refusal surfaces as a non-zero exit and is
reported, never worked around. A test asserts the source makes no such claim.

### 2.5 The PATH/ComSpec trust scope is stated, not implied

Plan §R96 line 179 asks for the trust range to be explicit. The source now carries
a `SCOPE OF TRUST` block: `PATH` and `ComSpec` come from the caller's environment
and are **trusted as given** — an attacker who can set either can already choose
what runs, so re-validating them here would add no protection. The interpreter
search inherits that same trust. This prevents a reader mistaking the resolver for
a sandbox.

### 2.6 Unchanged by design

`shell: false` is kept on every route (a test asserts the spawn options directly),
the global cmd-argument restriction is **not** relaxed, `shell: true` is never a
default, and the timeout/cancel/tree-kill lifecycle and R80 error precedence are
untouched — `runArgv` still funnels through the same `collect`.

## 3. Runtime Freeze assessment (P38.4-11)

`packages/tools/src/process/executor.ts` is runtime-adjacent, so the freeze was
assessed before touching it. This change qualifies under **criterion 1: a
deterministic correctness bug with a reproducer**:

- the reproducer is exact and platform-real (parent cwd ≠ opts.cwd, same-named
  script in both) and is exercised by a real-process test;
- outcome 2 above is a silent wrong-program execution, not a style issue;
- criterion 2 also applies to §2.3: the previous code wrote an
  attacker-influenced argument value into a returned error.

No behaviour was changed for its own sake: `shell:false`, the metacharacter
refusal, the routing table, and the process lifecycle are all preserved, and the
existing R79/R91/R92 tests pass unchanged.

## 4. RED → GREEN

### RED (before implementation)

`Tests 10 failed | 13 passed (23)`, exit 1. The failures are the defects
reproduced, not merely missing API:

| RED assertion | Meaning |
| --- | --- |
| `expected 'failed' to be 'success'` — "runs the script under opts.cwd, NOT the parent cwd's same-named namesake" | The real-process end-to-end proof: the runner failed to run the correct script at all |
| `expected 'failed' to be 'error'` — "REFUSES a .cmd path with a metacharacter and creates no sentinel" | A metacharacter-bearing script path was launched instead of refused |
| `expected true to be false` (×6) | A `.cmd` path containing `(`, `&`, `^`, `;`, `=`, `%`, `!` was accepted |
| secret canary assertions | `JSON.stringify(arg)` echoed the credential into the error |

### GREEN (after implementation)

`Tests 25 passed (25)`, and the regression suites unchanged:
`packages/tools` 25 files / **325 passed**, including the existing R91
`executor.test.ts` (30), `task-verifier.test.ts` (20) and the static
`windows-fixture-guard.test.ts` (9).

## 5. Non-vacuity — every guard mutation-tested

Each guard was reverted in isolation and the R96 file re-run; the source was
restored byte-identically and the restore verified by SHA256
(`f53db661e1c35d674494e86e6212480ed637460c40d5959ee01002846b95f418`, unchanged).

| Mutation | Result |
| --- | --- |
| M1 relative script path resolves against the PARENT cwd (finding G1) | **CAUGHT** — 4 failed |
| M2 `planArgvLaunch` does not thread cwd into resolution | **CAUGHT** — 2 failed |
| M3 the cmd SCRIPT PATH metacharacter check is removed (finding G2) | **CAUGHT** — 3 failed |
| M4 `runArgv` passes no cwd to the planner | **CAUGHT** — 1 failed |
| M5 the refusal echoes the offending argument again (finding G3) | **CAUGHT** — 2 failed |
| M6 a relative PATH entry resolves against the PARENT cwd | **CAUGHT** — 1 failed |
| M7 the `.cmd` route accepts a metacharacter-bearing PATH | **CAUGHT** — 3 failed |

## 6. Verification

| Gate | Command | Result |
| --- | --- | --- |
| Types | `pnpm typecheck` | exit 0 |
| R96 | `pnpm vitest run packages/tools/src/process/r96-windows-execution-boundary.test.ts` | 25 passed |
| Package | `pnpm vitest run packages/tools` | 25 files, 325 tests passed |
| Whitespace | `git diff --check` | exit 0 |
| Line endings | no file is mixed CRLF/LF | verified |

The R96 test file is platform-correct by construction: the pure decision table runs
on **every** platform (the repo's `windows-fixture-guard.test.ts` static scan
passes), and only the real-process describe is `describe.skipIf(!isWindows)`, so
POSIX reports SKIPPED rather than a silent pass. Plan §R96 line 190 is satisfied:
Ubuntu's native execution is unchanged and the Windows-only real-execution tests
are explicitly skipped there. No Linux installation was required or performed.

## 7. Honest limits

- **The path rule is measured on this machine only.** The table above is one
  Windows host. `cmd.exe` parsing is not versioned in a way I can enumerate, so
  the rule is deliberately conservative: it refuses anything measured to change
  behaviour and anything whose safety depends on ambient state (`%`, `!`).
- **`PATH`/`ComSpec` remain trusted.** Stated explicitly rather than fixed; a
  compromised environment is out of scope for this function.
- **The `%`/`!` refusal can reject a legitimate path.** A directory literally named
  `per%cent%` is now refused for the cmd.exe route. That is a real false positive,
  chosen deliberately over a silent mis-execution; the reason string says so and
  names the workaround.
- **No `cmd.exe` injection was demonstrated end-to-end.** Finding G's injection
  impact was, as the plan states, unproven by measurement. What IS proven here is
  that a metacharacter in the path changes what cmd.exe executes (truncation), and
  that a same-named script under the parent cwd is the one that used to be chosen.
- **`Test-IsLink`-style OS integration is not touched by R96.** The link detection
  fix belongs to R94's runner and is reported there.
- **Findings F (R97)** is untouched: `r92AuthorizationGate` is still not wired into
  the generic `agent benchmark` path.

## 8. Files

| File | Change |
| --- | --- |
| `packages/tools/src/process/executor.ts` | `cwd`-aware resolution (script path + relative PATH entry), host-independent `isAbsolutePath`, `CMD_PATH_METACHARACTERS` with the measured table, cmd-path refusal, secret-free refusal text, `.ps1` policy statement, `SCOPE OF TRUST` |
| `packages/tools/src/process/r96-windows-execution-boundary.test.ts` | **new** — 25 tests across 5 describes |
