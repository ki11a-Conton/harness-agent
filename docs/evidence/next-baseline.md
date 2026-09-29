# Next-round baseline — plan(20260929-015956).md

Task: **S0a** (`task-1`) — fix the baseline and record it before any fix is written.
Scope: baseline facts only. This file does **not** claim F1/F2/F3 are fixed.

## 1. Working tree at the time of this record

| Item | Value |
| --- | --- |
| Working directory | `D:\Harness Agent` |
| HEAD (driver) | `f23de8edcfb32d53fbed9cb12202d5f32cbf8e28` |
| `origin/main` | `f23de8edcfb32d53fbed9cb12202d5f32cbf8e28` (local == remote) |
| Plan review SHA | `349559dd098901c4b77549d207863e8b42cc9e1d` |
| Commits past the review SHA | 3 (`560ec24` R3/F4 mid-stream abort, `8fce634` evidence, `f23de8e` handover) |
| Nature of those 3 commits | evaluation source (mid-stream abort) + docs/evidence only — **no** change to F1/F2/F3 |
| Tree state | clean except the untracked plan file `plan(20260929-015956).md` |
| Node | `v24.18.1` |
| pnpm | `11.21.0` (`C:\Users\s5605\AppData\Roaming\npm\pnpm.ps1`) |
| Platform | Windows (win32). Ubuntu is exercised only through GitHub Actions. |

Git chain: `f23de8e` ← `8fce634` ← `560ec24` ← `349559d` ← `afc84b7` ← `a85db6d` ← `9df60bd` ← `34a6871`.

## 2. CI state

Read through the unauthenticated GitHub API
(`https://api.github.com/repos/ki11a-Conton/harness-agent/actions/runs`); no token is
available in this environment, so job logs cannot be downloaded.

| Run | SHA | Status | Conclusion | Note |
| --- | --- | --- | --- | --- |
| `36512611114` | `f23de8e` | completed | **success** | 7/7 jobs — the current HEAD |
| `36510360479` | `8fce634` | completed | success | |
| `36510326612` | `560ec24` | completed | cancelled | superseded by the next push |
| `36508490472` | `349559d` | completed | success | the run the plan cites |
| `36437529000` | `afc84b7` | completed | failure | pre-`349559d`; the single `R7-F6-H` Ubuntu role assertion |

Per plan §4 item 2 the run cited there (`36508490472`) was `completed/success` with all
7 jobs successful; the newer run `36512611114` on the current HEAD is also
`completed/success`. **A later HEAD invalidates this green** — every subsequent change
needs its own run.

## 3. Re-confirmed open defects (source-level, this baseline)

| ID | Pri | Re-confirmed fact |
| --- | --- | --- |
| F1 | P0 | `toolDispatchBudget` exists only in `packages/evaluation/src/tool-call-efficiency-formal-run.ts` (L1915 declared on `FormalRunAdmission`, L2137 created, L2151 passed into the admission). A grep of `apps/cli/src` for `toolBudget\|toolDispatchBudget` returns **no matches**. `PreregisteredArmContext` (`tool-call-efficiency-paired-campaign.ts` L111-128) has no budget field; the `runArm` call site (L450-465) forwards no budget; `launchArmWorker`'s `runOptions` (`prereg-arm-executor.ts` L898-907) carries none; `RunOneCaseOptions` (`benchmark-command.ts` L1640-1656) has no budget field; the real `new ToolOrchestrator` (L2046) is built with no `toolBudget` and no `dispatchDeadlineAtMs`. |
| F2 | P0 | `prereg-arm-executor.ts` L986-989 — the worker timer calls only `child.kill()`. L1024 — `for await (const event of client.generate(frame.request, new AbortController().signal))`: the controller is constructed inline and discarded, so nobody can abort the in-flight stream. `scripts/e4/prereg-arm-isolated-worker.mjs` L113 — `async *generate(request, _signal)` ignores the signal. |
| F3 | P1 | `scripts/e4/ci-readiness.mjs` `verifyRealEvidence()` L195-240 — `buildDigest` is only checked for non-emptiness (L220-221); `e2e.runId` is compared only when present (L208); no arm/verifier/journal file is ever opened. The forward branch can therefore PASS on self-reported JSON. |

## 4. The seam that already works (for contrast)

`packages/harness/src/create-harness.ts` L281-289 **does** forward
`config.toolDispatchBudget` → `ToolOrchestrator({ toolBudget })` and
`config.campaignDeadlineAtMs` → `dispatchDeadlineAtMs: () => campaignDeadlineAtMs`.
`packages/tools/src/orchestrator.ts` L298-331 **does** enforce the deadline and take the
pre-dispatch reservation before the tool body. `packages/harness/src/tool-budget-binding.test.ts`
proves that path with a real harness (B1/B2/B3).

The defect is therefore **not** the seam — it is that the formal arm path
(`campaign → production runner → isolated worker → arm's own runOneCase`) never supplies
the seam. A `createHarness` unit test cannot detect that, which is exactly why S1's
acceptance requires the formal campaign entry.

## 5. S0 counter-examples

Test file: `apps/cli/src/r0-f8-formal-budget-cancel-gaps.test.ts` (new, owned by `task-1`).

Command:

```powershell
cd "D:\Harness Agent"
npx vitest run apps/cli/src/r0-f8-formal-budget-cancel-gaps.test.ts
```

Result at `f23de8e` (tree dirty with this new test only), exit code **1**:

```text
❯ apps/cli/src/r0-f8-formal-budget-cancel-gaps.test.ts (2 tests | 2 failed) 13.47s
    × [F1] with a campaign tool cap of 1, only the FIRST of two real writes lands
    × [F2] the provider's AbortSignal is aborted and the driver returns inside a bounded window
 Test Files  1 failed (1)
      Tests  2 failed (2)
```

Both failures are the **target behaviour**, not an import/build/collection failure: the
real executor launched the real isolated worker as a child process, the worker loaded the
arm's real build entry, and that entry built a real `ToolOrchestrator` from the repo's own
`packages/tools/dist/index.js`.

### F1 — raw observation (the decisive evidence)

The arm wrote this after two `write_file` dispatches with a campaign cap of **1**:

```json
{
  "marker": "candidate",
  "mode": "budget",
  "budgetForwarded": false,
  "results": [
    { "name": "first.txt",  "status": "success", "reasonCode": null },
    { "name": "second.txt", "status": "success", "reasonCode": null }
  ],
  "workspace": "C:\\Users\\s5605\\AppData\\Local\\Temp\\r0-f8-arm-ws-7IxFyD",
  "filesOnDisk": ["first.txt", "second.txt"]
}
```

`budgetForwarded: false` is the defect: the campaign's durable tool budget never reached
the arm's orchestrator, because `PreregisteredArmContext` carries no budget, the `runArm`
call site forwards none, `RunOneCaseOptions` has no field for it, and the arm's real
`new ToolOrchestrator(...)` is therefore built without `toolBudget`.

`filesOnDisk: ["first.txt", "second.txt"]` with both dispatches `success` is the
CONSEQUENCE: **two real side effects executed under a cap of one**. The test asserts on
the real files on disk and on the real dispatch results, so it distinguishes "the model
declared two tool calls" from "two side effects executed" — the latter is what happened.

### F2 — raw observation

```text
AssertionError: the watchdog fired: the driver never returned: expected 12437 to be less than 12000
```

The worker's `workerTimeoutMs` was **1500 ms**, yet the driver had not returned after
**12 437 ms** — the external watchdog ended the test rather than CI hanging. This is the
defect the plan records at §1.2 F2: the timeout timer calls only `child.kill()`, and the
driver builds `new AbortController().signal` inline per model stream
(`prereg-arm-executor.ts` L1024) and discards the controller, so the in-flight provider
stream can never be aborted and `launchArmWorker` never settles.

### Status

| Counter-example | Owner | Status |
| --- | --- | --- |
| F1 (formal arm ignores the campaign tool cap) | `task-1` | **LANDED, RED for the target reason** |
| F2 (worker timeout does not cancel the provider stream) | `task-1` | **LANDED, RED for the target reason** |
| F3 (forged JSON yields `realBuildOfflineReady=PASS`) | `task-9` | IN PROGRESS |

Per plan §4, these tests are **not** `test.fails`, not skipped and not inverted. They turn
green when S1 and S2 land the fixes — that green is S1's and S2's acceptance signal, not
this task's.


## 6. Explicitly NOT_RUN in this baseline

- No paid/real model request was made. `paidExperimentRun` = `NOT_RUN`, `championPromotion` = `NOT_RUN`.
- No full `pnpm test` was run locally for this record; the full-suite state above comes from CI.
- The mutation gate was **not** run (it mutates source and belongs in an isolated clean worktree, serially).
- No Linux command was run locally.
