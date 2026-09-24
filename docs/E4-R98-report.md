# E4-R98 report — a hostile budget cannot grow, a lost state cannot refresh, resume stops re-billing

**Task.** Plan §R98 (findings F2/F3/F4): "你负责 F2/F3/F4。目标：预算不因非法数据、
文件丢失或锁竞争而增加；同一案例的已完成结果在恢复时不被重新执行." Four defects were
measured offline against the pre-R98 source; R98 closes all four. **F3** — the
ledger parser accepted hostile counters (grant 3 + `consumed: -100` → `remaining: 103`,
so the allowance *grew*). **F4a** — once the grant was fully consumed, deleting the
ledger file inside the directory let the same open handle reserve again. **F4b** — the
lock was reclaimed purely by **age** (30 s), so a live process holding a lock for 60 s
had it stolen. **F2** — only a call budget existed and no completed-unit set, so a
second run of the SAME plan committed another 16 calls (16 + 16 = 32). R98 also adds
the durable `case×arm×repetition` state machine the plan asks for in §R98 做什么 item 4:
"为 case×arm×repetition 增加持久化执行记录，并与 model-call reservation 建立关联."

**Scope.** `packages/evaluation/src/r97-budget-ledger.ts` (+ test),
`packages/evaluation/src/r97-execution-state.ts` (+ test),
`packages/evaluation/src/r97-driver-closed-loop.test.ts`,
`packages/evaluation/src/index.ts`, `scripts/e4/r97-campaign-driver.mjs`,
`docs/E4-R98-report.md`.

| Item | Value |
| --- | --- |
| Implementation SHA | `6927a2d` — "E4-R98: a hostile budget cannot grow, a lost state cannot refresh, resume stops re-billing" (7 files, +1305 / −72) |
| Baseline SHA | `8dc0b2d` — the plan's 本轮基线 `8dc0b2d4ac911b010ad5773ba801bab7d71b63ec` |
| Changed files | `packages/evaluation/src/r97-budget-ledger.ts` (+397/−72 area), `packages/evaluation/src/r97-execution-state.ts` (**new**, 404 lines), `packages/evaluation/src/r97-budget-ledger.test.ts` (+196), `packages/evaluation/src/r97-execution-state.test.ts` (**new**, 225 lines), `packages/evaluation/src/r97-driver-closed-loop.test.ts` (+52), `packages/evaluation/src/index.ts` (+1), `scripts/e4/r97-campaign-driver.mjs` (+102) |
| Real provider calls | **0** — no provider is constructed on any path exercised here; every test uses an in-process counting fake or drives the ledger/state stores directly |
| Network | none (two tests spawn a real `node` child process; no socket is opened) |
| Paid steps executed | **none** |
| R97/R98 tests | **116 passed / 1 skipped** across the four files — ledger **37**, plan **31**, driver **36** (1 skipped — the real-arm D6 test), execution-state **13** |
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0 |
| CI run | **pending** — no Windows/Ubuntu CI run of `6927a2d` is recorded here, and none is invented |

The four test counts and the two exit codes above are the figures reported green at
`6927a2d`. They were **not re-measured by this report's author**, who did not run the
suite; they are verified here only by reading the test files and counting the `it(`
blocks (ledger 37, execution-state 13, driver 36 with one `it.skipIf`, plan 31), which
agrees with the reported numbers. The plan's `RED复现命令及失关键失败` / `GREEN 命令及
结果` fields are filled from the tests' own recorded strings (§5) rather than from a run
this document performed.

---

## 1. Measured defects

The plan's §0.2 states the measurement method explicitly: "读取了固定 SHA 的源码、提交
差异、报告、AGENTS.md 和最新 CI jobs；下载原始 driver 与 ledger 的文本副本到隔离诊断
目录，使用 Node v24 执行无网络探针"，and "ledger 负数、文件消失、活 owner 旧锁的探针
直接使用原 ledger 模块." So these four are **offline probes against the real module**,
not production incidents. Nothing below claims a live campaign was affected.

### 1.1 F3 — a hostile counter INCREASED the allowance

**Measured RED** (plan §0.2, quoted verbatim in the G6 test comment):

```json
{ "negativeConsumed": { "accepted": true, "grant": 3, "consumed": -100, "remaining": 103 } }
```

The ledger parser **accepted** the file and the derived view reported **`remaining: 103`**
for a grant of 3.

**Mechanism.** Two independent holes in the pre-R98 `parseR97Ledger`, both verified in
`8dc0b2d:packages/evaluation/src/r97-budget-ledger.ts`:

```ts
consumed: typeof r["consumed"] === "number" ? r["consumed"] : null,
```

`typeof -100 === "number"`, so `-100` was taken verbatim with no sign, integrality or
range check. Then the projection summed it as a **negative** contribution:

```ts
committed += e.consumed ?? e.reserved;
const remaining = Math.max(0, file.campaignModelCalls - committed - outstanding - unknown);
```

`3 - (-100) = 103`. The only bound in the projection was `Math.max(0, …)`, which floors
at zero and does nothing about an overshoot in the **upward** direction. The parser never
compared the derived view against `0 <= remaining <= granted` — the invariant the plan
names as the thing that must be refused rather than clamped — so a caller could reserve
against an inflated allowance.

### 1.2 F4a — a deleted ledger read as a fresh full allowance

**Measured RED** (plan §0.2):

```json
{ "ledgerMissingAfterOpen": { "previousGrantFullyConsumed": true, "newReservationGranted": true } }
```

The same test file records the symptom as: *"MEASURED RED: after the grant was fully
consumed, deleting the ledger file inside the diagnostic directory let the SAME open
handle reserve again."*

**Mechanism.** The pre-R98 read path was a single expression:

```ts
const read = async (): Promise<R97LedgerFile> =>
  (await readR97LedgerFile(dir)) ?? emptyLedger(opts.planDigest, opts.campaignModelCalls);
```

`readR97LedgerFile` returns `null` for **ENOENT**, and every read — not only the first
open — mapped that `null` straight to `emptyLedger(...)`, a ledger with zero entries
bound to the full grant. The handle therefore never distinguished "this campaign has no
ledger yet" (true first creation, where minting one is correct) from "this campaign HAD
a ledger and it is gone" (a missing budget, where a fresh allowance is exactly the wrong
answer). The `reserve` that followed read a full `remaining` and succeeded.

### 1.3 F4b — a live owner's old lock was stolen

**Measured RED** (plan §0.2):

```json
{ "liveOwnerOldLock": { "ownerAlive": true, "reservationGrantedDespiteLock": true } }
```

The G8 test states it as: *"MEASURED RED: a lock older than 60s whose owner was ALIVE was
taken over."*

**Mechanism.** Pre-R98 the holder record carried no ownership token, and reclamation was
decided by mtime alone:

```ts
const LOCK_STALE_MS = 30_000;
// A lock whose owner died is STALE. Reclaim it rather than deadlocking
const st = await stat(lockPath);
if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
  await rm(lockPath, { force: true });
  continue;
}
```

There was no `pid` and no liveness probe anywhere on this path: `LOCK_STALE_MS` was a
pure age threshold, and `defaultIsAlive` was used only by `recover()` on ledger entries,
never by `acquireLock`. Age was standing in for liveness, so an owner that was simply
**slow** — a 60 s read-modify-write, a suspended process, a loaded machine — was
indistinguishable from a crashed one and had its lock deleted while still using it. Two
writers could then interleave. The same absence of a token made release unsafe: the
`finally { await rm(lockPath, { force: true }); }` removed whatever lock was present,
including one a second owner had since acquired.

### 1.4 F2 — a second run of the same plan re-billed the whole matrix

**Measured RED** (plan §0.2):

```json
{ "driver": { "firstStatus": "COMPLETE", "secondStatus": "COMPLETE", "firstCalls": 16, "newCallsOnResume": 16, "totalCommitted": 32 } }
```

Both runs reported `COMPLETE`; the second added 16 new logical calls, taking the committed
total from 16 to **32**.

**Mechanism.** The ledger answered only "how many calls may still be made." Nothing
recorded *which* `case × arm` units had finished, so the driver's STEP 4 loop had no way
to skip one:

```js
for (const arm of arms) {
  for (const caseId of plan.authorization.caseIds) {
    const reservation = await ledger.reserve(arm, 1);   // always taken
    … generate …
  }
}
```

With a 320-call grant, a second run of the same plan found 304 calls remaining and
happily spent 16 more. The budget was shared — G2/G5 had already made it cross-process —
but "shared" is not "already done," and the plan's §0.1 F2 entry records exactly this:
"只有调用预算，没有持久化的 case×arm 完成集合."

---

## 2. The fixes

### 2.1 F3 — strict counters, legal state combinations, and a no-clamp invariant

Two constants and one pure function carry the change:
`viewOfR97Ledger(file, { clamp })`, the local `counter(value, field)` validator, and the
four legal `(status, consumed)` combinations.

Every counter is now a non-negative **safe integer**:

```ts
/** A counter must be a non-negative safe integer. */
const counter = (value: unknown, field: string): string | null =>
  typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
    ? `ledger ${field} must be a non-negative safe integer (got ${String(value)})`
    : null;
```

`reserved`, `consumed`, `transportRetries` and the grant all go through it, `pid` must be
a safe integer, `reservedAt` a non-negative finite number, and `reservationId` must be
non-empty **and unique** — "Duplicate ids would make commit/abandon ambiguous and let one
reservation be settled twice."

`(status, consumed)` is now a closed set of four legal combinations rather than a free
pair. The comment states the invariant:

```
// (status, consumed) must be one of the four legal combinations. Every
// other pairing is a file that cannot be trusted to describe the budget.
```

| status | required `consumed` | rule |
| --- | --- | --- |
| `reserved` | `null`/absent | carries a consumed count → refused |
| `unknown` | `null`/absent | carries a consumed count → refused |
| `committed` | non-negative safe integer | `consumed > reserved` → refused |
| `abandoned` | exactly `0` | anything else → refused |

The `remaining` check is no longer allowed to clamp. The doc comment on
`viewOfR97Ledger` records why the flag exists:

```
 *  `clamp` (default true) floors `remaining` at 0 for DISPLAY of a well-formed
 *  ledger. The parser calls it with `clamp: false` so an over-consumed file is
 *  DETECTED (remaining < 0) instead of being silently clamped into validity —
 *  plan §R98 怎么做: "任何计算结果违反 0 <= remaining <= granted 必须拒绝，不能靠
 *  clamp 掩盖错误."
```

and `parseR97Ledger` ends with the refusal:

```
// The derived view is the thing that actually authorizes spending, so the
// invariant is checked HERE rather than by clamping in viewOfR97Ledger: a
// file whose entries exceed the grant is refused, never "limited" to zero
// remaining and then treated as valid for a later top-up.
```

`commit()` applies the same standard to its own arguments — a negative or fractional
`consumed` or `transportRetries` throws — and `reserve()` refuses any count that is not a
positive safe integer.

### 2.2 F4a — FIRST CREATION vs RESUME, with named failure codes

The unnamed `read() ?? emptyLedger()` expression is replaced by an explicitly named
`read` closure guarded by an `established` flag, plus three stable codes
`R97_BUDGET_STATE_MISSING` / `R97_BUDGET_STATE_CORRUPT` / `R97_BUDGET_STATE_MISMATCH`:

```ts
/** True once this handle has seen the ledger on disk. After that, a missing
 *  file is a MISSING STATE, not a fresh campaign. */
let established = false;
```

The substitution is now reachable only on the first-creation branch:

```ts
if (present === null) {
  if (established) {
    throw new Error(
      `E4-R97: ${R97_BUDGET_STATE_MISSING}: the budget ledger for this campaign no longer exists in ${dir} — refusing to treat a lost budget as a fresh full allowance`,
    );
  }
  return emptyLedger(opts.planDigest, opts.campaignModelCalls);
}
```

Damage detected by the reader is likewise re-labelled `BUDGET_STATE_CORRUPT` once the
handle is established, and the original message is preserved behind the code. Identity is
re-validated on **every** read, not once at open:

```
// Every read re-validates the identity, not just the first open: a file
// swapped mid-campaign must not be adopted.
```

A ledger whose `planDigest` or `campaignModelCalls` differs from the authorization throws
`BUDGET_STATE_MISMATCH` — two distinct messages, one for a foreign plan and one for a
re-granted allowance ("a process must never re-grant itself a different allowance"). The
bootstrap write is still performed on first open, so a later process always has a file to
compare against.

The scope of the guarantee is stated in the module rather than implied: local-resume
integrity, not defence against an operator with full filesystem control — see §7.

### 2.3 F4b — owner token + live-pid liveness; age is only a hint

`LOCK_STALE_MS` is deleted. The lock file is now a JSON record
`{ token, pid, host, acquiredAt }`, and `acquireLock` decides reclamation solely on
provable death:

```ts
// A record with an unparseable owner is conservatively OCCUPIED: we cannot
// prove the writer is gone, and stealing a live lock is the worse error.
const ownerGone = holder !== null && holder.token !== "" && !isAlive(holder.pid);
if (ownerGone) {
  // Provably dead owner — the crash this ledger exists to survive. Age is
  // deliberately NOT required: a fast crash must not deadlock the campaign.
  await rm(lockPath, { force: true });
  continue;
}
```

The doc comment on `acquireLock` names the measured defect it closes and the new role of
age — the `age` value survives **only** in the timeout message, never in the decision:

```
 * Measured defect this closes: the previous version reclaimed ANY lock whose
 * mtime was older than 30s, so a live process that had been holding the lock
 * for 60s had it deleted under it and two writers could interleave. Age is now
 * only a HINT used to decide whether to bother reading the owner record; the
 * decision to take over is based on the owner being provably dead.
```

Timeout is separate from takeover: a live owner yields `BUDGET_LOCK_HELD`
("活 owner 超时返回占用错误，不能删锁"). Parsing an unreadable or legacy
plain-text lock yields an **unknown owner**, which is treated as occupied; a legacy
numeric lock is still honoured as an owner hint "so an upgraded binary cannot steal a
lock written by the previous version." Release is token-scoped:

```ts
/** Release the lock ONLY if we still own it. A stale owner whose lock was taken
 *  over must never delete the new owner's lock. */
const holder = parseLockRecord(text);
if (holder === null || holder.token !== token) return; // no longer ours
```

The liveness probe is `defaultIsAlive`, using `process.kill(pid, 0)` and treating `EPERM`
as alive (the process exists, it is just not ours).

### 2.4 F2 — a durable unit state machine, wired into the driver

New module `packages/evaluation/src/r97-execution-state.ts`
(schema `e4-r97-execution-state-v1`, file `execution-state.json`) implements the plan's
state machine:

```
pending ──begin──> running ──complete──> completed
                      │      └─fail────> failed
                      └─(crash / dead owner)─> outcome_unknown
```

A record carries `experimentId, caseId, suite, arm, repetition, attemptId, inputDigest,
reservationId, resultHash, startedAt, endedAt, detail` — the identity the plan asks for
("记录 experimentId、caseId、suite、arm、repetition、attemptId、当前输入摘要、结果hash和
相关 reservation"). Three contract points are enforced in code:

- **`running` is durable before the request leaves.** `begin()` writes the record and
  returns the `attemptId`; the caller may only then dispatch. The module comment states
  the reason: "a crash between 'request sent' and 'result stored' leaves a durable
  `running` record rather than no trace at all."
- **Terminal units are skipped only on identical inputs.** `begin()` on a
  `completed`/`failed` unit with a different `inputDigest` throws `EXEC_INPUT_DRIFT`
  ("已完成结果 hash 或身份错则停止，不直接重跑"); with an identical digest it still throws
  ("a terminal unit is skipped, not restarted"), so the only way past a terminal unit is
  the skip the driver performs.
- **`outcome_unknown` is quarantined.** `recoverInFlight()` reclassifies every `running`
  record as `outcome_unknown` and the allowance stays consumed; `begin()` on it throws
  "it requires an explicit reconciliation decision before it may run again." There is no
  automatic retry path — plan §R98: "UNKNOWN 停止自动重发并保留占用额度，提供明确的单独
  reconciliation 操作."

The store is bound to **both** `experimentId` and `planDigest`, re-validated on every
read, and persists its identity on first open so a foreign store fails immediately rather
than at the first `isDone()` call. Both parsers fail closed: damaging the file must never
look like "nothing has been executed yet," which would re-run and re-bill the campaign.

`parseR97ExecutionState` additionally refuses a `completed`/`failed` record without a
`resultHash` ("without it the record cannot substantiate that a result exists, so it
cannot justify a resume skip") and refuses a store in which one unit key appears twice.

**Driver wiring** (`scripts/e4/r97-campaign-driver.mjs`), inserted as STEP 2b — after the
ledger recovery pass and still **before** `makeProvider()`:

```js
// ---- STEP 2b: the durable case×arm×repetition state (plan §R98 / F2). ----
// The ledger answers "how many calls may still be made"; this answers "which
// units are already finished". Without it a second run of the SAME plan
// committed another 2N calls (measured: 16 then 16 = 32).
const execState = await evaluation.openR97ExecutionState(ledgerDir, {
  experimentId: plan.planDigest,
  planDigest: plan.planDigest,
});
const inFlight = await execState.recoverInFlight();
result.recoveredUnits = inFlight.unknown;
```

The loop now performs the skip the plan requires — "结果与 completed 关联后才允许 resume
skip" — before any reservation is taken:

```js
if (await execState.isDone(unitKey)) { result.skippedUnits += 1; continue; }
if (await execState.mustNotRetry(unitKey)) { result.failures.push({… outcome_unknown …}); continue; }
const reservation = await ledger.reserve(arm, 1);
…
// Persist `running` BEFORE the request is allowed to leave (plan §R98:
// "先持久化 running/reservation，再允许请求发出").
const attemptId = await execState.begin(unitKey, { reservationId: …, inputDigest: inputDigestOf(plan, caseId) });
```

and every call reaches a terminal record: `execState.fail(...)` for a non-`ok` outcome,
`execState.complete(...)` for `ok` — a failed unit is terminal too, so "a resume does not
silently re-bill a call that already produced a result (of failure)." The result object
gains `skippedUnits`, `recoveredUnits` and `completedUnits`, and the COMPLETE reason line
now discloses the skips rather than reporting a bare 16-call run.

Unit identity is `unitKeyOf = experimentId|caseId|suite|arm|repetition`; the driver derives
`suite` from the suite-prefixed case id (`regression/reg-16-cicd-step`), which is an
independent part of the key rather than a re-label of the case.

**Not wired to the ledger's refund path.** The execution-state store and the budget ledger
are deliberately separate files: the store records *identity of work*, the ledger records
*allowance*. A skipped unit takes no reservation at all, which is why the resume is
`logicalCalls: 0` rather than a reserve-then-abandon.

---

## 3. RED → GREEN

Every group below was written as a failing assertion first. The failure strings quoted are
the ones recorded in the test sources and in the plan's §0.2 probe output; the arrow names
what replaced them. This report's author did not re-run the suite, so the GREEN column is
the reported `6927a2d` status, and the counts are the counts the files contain.

| Group | RED (the failing assertion observed first) | GREEN |
| --- | --- | --- |
| **G6** — hostile budget data can never INCREASE the allowance (F3) | `parseR97Ledger({"grant":3,"consumed":-100,…}).ledger` was **non-null** and the projection reported `remaining: 103` — i.e. `expected null to be null` failed on the accepting branch, and any assertion of `remaining <= granted` failed at `103 > 3` | 5 tests: `readR97LedgerFile` rejects `/consumed\|negative\|safe integer\|0 <= consumed/i`; 11 illegal-counter shapes each refused with a named defect; `viewOfR97Ledger` asserted inside `[0, granted]`; negative/fractional `consumed` and `transportRetries` rejected at `commit` |
| **G7** — an ESTABLISHED campaign with missing/foreign state fails closed (F4a) | After `reserve(3)` + `commit(3)` (remaining 0) the ledger file was deleted; `l.reserve("candidate", 1)` **resolved with `ok: true`** instead of rejecting — the assertion `rejects.toThrow(/BUDGET_STATE_MISSING\|missing\|disappear/i)` failed because nothing threw | 4 tests: missing-after-open, swapped-for-another-plan → `BUDGET_STATE_MISMATCH`, corrupted → `CORRUPT`/`not valid JSON`/`damaged`, and a true first creation still bootstrapping (`remaining` 3 → 2) |
| **G8** — lock ownership is by live owner token, not by age (F4b) | A lock whose record named a live `pid` with an mtime 10 minutes old was **stolen**: `openR97BudgetLedger` resolved instead of rejecting, and the stolen lock was deleted — so both `rejects.toThrow(/lock/i)` and `expect(await readFile(lockPath)).toContain("other-owner-token")` failed | 3 tests: a live owner's ancient lock is refused and left byte-intact; a provably dead owner's *young* lock is taken over (real child process, exited, its real pid written into the record); a taker's release never removes a third party's lock |
| **S1** — the unit state machine is durable and resume-safe | No `r97-execution-state` module existed, so the import failed outright; the behavioural RED is that the pre-R98 driver had no unit record at all — the F2 probe reached `secondStatus: COMPLETE` with `newCallsOnResume: 16` | 6 tests: not-done → `running` → `completed`; `failed` is terminal; crash → `outcome_unknown` with `isDone === false` and `mustNotRetry === true`; a completed unit survives a restart with its `resultHash`; the `reservationId` is recorded; the key distinguishes case, arm and repetition |
| **S2** — the execution state fails closed on identity drift | Same absent-module RED; the drift assertions could not be expressed because nothing compared a plan digest, an experiment id or an input digest | 5 tests: different plan digest and different experiment id both rejected; a completed unit re-`begin`-ed with a new `inputDigest` throws `/INPUT_DRIFT\|input digest\|already (completed\|terminal)/i`; a corrupted store rejected; the store is schema-tagged and carries no key/endpoint/host path |
| **S3** — the full 8×2 matrix resumes with zero new work | Same absent-module RED; the pre-R98 behaviour is the measured `16 then 16 = 32` | 2 tests: 16/16 units done on a fresh open with `pending === 0` and 16 records; a partially completed matrix resumes only the 3 missing units |
| **F2 driver tests** — the case-resume group in `r97-driver-closed-loop.test.ts` | `second.result["logicalCalls"]` was **16** where 0 is required, and `second.result["providerRequests"]` was **16** where 0 is required; the budget view after the second run reported `committed: 32` where `16` is required — the plan's summary of this is `expected 16 to be +0` | 2 tests: a second identical run reports `logicalCalls: 0`, `providerRequests: 0`, `reservations.length: 0`, `completedUnits === 2N` and a ledger `committed` that did not move; a partially seeded run executes only the remaining arm (`logicalCalls === N`) |

Contrast that makes the F2 claim precise: after the F2 fix, `completedUnits` after the
second run is `caseCount * 2` — the completed set is still exactly 16 — while
`logicalCalls` is 0. Both halves of the plan's bullet ("第二次正常 resume 新增调用0，完成
记录数量仍16") are asserted separately, so a fix that merely stopped counting would not
pass.

**What was NOT turned red.** The pre-existing D10 group
(`expected 'COMPLETE' not to be 'COMPLETE'` / `expected null to be 'CASE_FAILURES'`) stays
green and is **not** re-claimed here: it is the provider-error defect fixed at `8dc0b2d`,
which is this task's baseline and appears in the plan's §0.1 preamble as "最新 D10 … 保留
此修复." R98 changed the driver's STEP 4 loop (adding the skip and the terminal recording)
without weakening it; the whole D10 group is part of the 36 driver tests counted above.

---

## 4. Acceptance mapping — plan §R98 怎么验收

| Plan bullet (怎么验收) | Evidence |
| --- | --- |
| 以上四个原始 RED 均 GREEN；所有非法输入导致零 provider 请求 | §3 G6/G7/G8 (ledger, pure or file-based, so no provider exists at all) + the two F2 driver tests. The illegal-input → 0 requests link is structural: G6/G7/G8 exercise `parseR97Ledger` / `readR97LedgerFile` / `openR97BudgetLedger` directly, and the driver opens the ledger at STEP 2 and the execution state at STEP 2b, **before** `makeProvider()` at STEP 3 — so a throw on either cannot be reached by a provider. Asserted as a number only for the pre-existing D1 refusal paths (`providerRequests === 0`) |
| 完成8例×2臂后，第二次正常 resume 新增调用0，完成记录数量仍16 | `F2: a SECOND run of the same plan executes ZERO new units (case resume)` — `logicalCalls === 0`, `providerRequests === 0`, `reservations.length === 0`, ledger `committed` unchanged at `2N`, `completedUnits === 2N`. At the store level, S3 asserts `pending === 0` and 16 records |
| 中途终止后只运行从未启动且身份合法的单位；unknown 不自动重试 | S1 (`crash leaves running → outcome_unknown`, `mustNotRetry === true`) and the driver's `mustNotRetry` branch, which pushes a failure record containing `outcome_unknown: the previous attempt may have been billed and requires an explicit reconciliation` and `continue`s **without** reserving. `F2: a partial run resumes ONLY the missing units` asserts the positive half (`logicalCalls === N`). The "身份合法" half is S2's `EXEC_INPUT_DRIFT` refusal |
| 两进程竞争最后1次额度，至多一个成功 | **Partially covered.** G5's `two processes racing for the last call do not both win` spawns two real concurrent `node` children against a grant of 1 and asserts exactly one `ok`, one `BUDGET_EXHAUSTED`, and `outstanding === 1`. This is a real cross-process test using **concurrent spawns**, not an event-synchronised barrier; the plan's stronger form — "测试使用事件同步和故障注入，不靠循环睡眠等偶然时序" — is **not yet covered by R98; see R101** |
| 一个活进程持有旧锁，另一个不能接管 | G8's `REFUSES to steal a lock whose owner is still alive, however old it is`: the record names a **live** pid with a 10-minute-old mtime, acquisition throws within `lockTimeoutMs: 200`, and the loser leaves the winner's token intact. Same-process ownership, so this is not a two-process contention test (**see R101**) |
| 锁持有者死亡可安全恢复；接管后的锁不被旧 owner 释放 | G8's `takes over a lock whose owner is truly dead, even when it is young` (a real child process exits and its real pid is written into the record, so the owner is provably dead) plus `a taker's release never deletes a lock another owner has since acquired` (token-scoped `releaseLock`) |
| 修改 grant、planDigest 或结果hash，恢复非零退出，不给出 COMPLETE | grant and planDigest: G2 (`never re-grant itself a different allowance`, `belongs to a different plan`), G7 (`BUDGET_STATE_MISMATCH` on a swapped file), S2 (`different plan digest`, `different experiment id`). Drift on a finished unit: S2's `EXEC_INPUT_DRIFT`. **The "恢复非零退出" part is only structurally covered** — the driver returns `EXIT_REFUSED` for any non-`COMPLETE` status and these throws propagate out of `runDriver` before STEP 3 — but there is **no R98 test that drives the CLI to a non-zero exit from a tampered ledger**; that end-to-end assertion is **not yet covered here; see R101** |
| Windows/Ubuntu CI 运行真实子进程竞争测试，测试使用事件同步和故障注入，不靠循环睡眠等偶然时序 | **Not yet covered by R98; see R101.** There is no recorded CI run of `6927a2d` in this report, the G5 contention test is Windows-local, and one pre-existing G5 regression test deliberately waits `750 ms` (`await new Promise((r) => setTimeout(r, 750))`) to prove the bootstrap write happens under the lock rather than by racing — that is a sleep by design and would not satisfy this bullet |
| 报告附可复现命令、次数统计和持久文件检查；不再只查"第一次之后remaining下降"就宣称恢复不会重复 | The counts are asserted directly: `committed` before/after the second run, `completedUnits`, `reservations.length`, `providerRequests`, `pending`. Persistent-file checks: G7 reads/removes `budget-ledger.json` on disk, G8 reads `budget-ledger.lock`, S2 reads `execution-state.json`, and both stores are asserted to carry no `sk-`/`Bearer`/`api_key` and no absolute host path. The reproducible commands are the targeted vitest invocations, which this report does not re-run (**see §6**) |

---

## 5. Honest limits

- **The execution-state store is a single atomically-renamed JSON file.** `begin()`,
  `complete()`, `fail()` and `recoverInFlight()` each do read → mutate → temp-write →
  rename, with **no lock**. A crash between computing a result and writing the terminal
  record leaves the unit at `running`, which the next process converts to
  `outcome_unknown`; resolving it requires an explicit reconciliation, and the reserved
  allowance is never returned automatically. Two processes writing the same store
  concurrently can lose an update — the ledger has an exclusive lock, the state store
  does not.
- **The driver's `resultHashOf` is not yet a result.** It currently digests
  `sha256(arm|caseId|outcome)`, so it distinguishes terminal *kinds* and nothing more. The
  R99 execution path must replace it with the hash of the real per-case result artifact.
  Until then a "completed" unit substantiates that a terminal outcome was recorded, not
  that any artifact exists. The same applies to **failed** units: `fail()` stores
  `resultHashOf(arm, caseId, outcome)`, i.e. a failure is also a terminal record with no
  artifact behind it.
- **`resultHash` is never verified against a stored result.** `complete()` requires a
  non-empty hash and `parseR97ExecutionState` requires one for each terminal record, but
  nothing recomputes it from an artifact on resume. The verification that the stored hash
  still describes the stored result belongs to R99, which owns the artifacts.
- **`inputDigestOf` covers the *planned* inputs, not the executed ones.** It hashes the
  plan's frozen case fingerprint, the observed `executingSourceSha` and `DRIVER_VERSION`.
  It does not hash the arm's build, the fixture actually staged, or the model parameters
  as sent.
- **Local-resume integrity is what is guaranteed.** The plan scopes this explicitly — "明确
  保证范围：本地恢复完整性，不声称能防御有文件系统完全控制权的操作者删除全部证据" — and R98
  does not widen it: an operator with full filesystem control can still delete
  `budget-ledger.json`, `execution-state.json`, both locks and every artifact at once.
  What R98 adds is that deleting them *while a handle is open* fails closed
  (`BUDGET_STATE_MISSING`), and that a fresh process re-opening an emptied directory still
  needs an authorization whose digest matches.
- **No exactly-once guarantee across a network boundary.** A reservation is taken before
  the call and committed after it; if the process dies in between, the attempt becomes
  `unknown`/`outcome_unknown` and the unit is quarantined. That is at-most-once *billing*,
  not exactly-once *execution* — the request may have reached the provider and been
  charged without any result being recorded. Plan §R98 states the same limit: "不承诺跨网络
  exactly-once."
- **The liveness probe can in principle be wrong.** `defaultIsAlive` uses
  `process.kill(pid, 0)` and treats `EPERM` as alive. On a long-lived host, pid reuse can
  make a dead owner look alive — the takeover then never happens and the campaign times
  out with `BUDGET_LOCK_HELD` instead. That is the safe direction (refusing to steal a
  live lock is preferred to stealing one), but it is a false-alive, not a proof of death.
  The `host` field is **recorded and never checked**, so a lock written on another machine
  is judged only by its pid.
- **`transportRetries` is a separate physical-attempt counter and is NOT a billing
  bound.** It is recorded per reservation, summed separately in the view, and explicitly
  excluded from `remaining`. The logical-call grant is therefore not a bound on physical
  HTTP attempts, and R98 does not claim it is.
- **The execution state is keyed by `repetition: 1` unconditionally in the driver.** The
  store supports any positive integer repetition and S1 asserts that repetition is part of
  the key, but the driver loop is serial at one repetition, so multi-repetition resume is
  untested end-to-end.
- **The driver still sends the same fixed placeholder request per case.** F1 is out of
  R98's scope (it is R99's), and it remains true that `messages: [{ role: "user", content:
  "r97" }]` is what every unit dispatches. R98 makes resume *not re-run* units; it does not
  make a unit's execution meaningful.
- **`completedUnits` counts `failed` as terminal.** The driver's post-run count is
  `status === "completed" || status === "failed"`, matching `isDone()`. A run that failed
  every unit still reports 2N "completed units"; the distinction between success and
  failure is carried by `status`/`code` (`PARTIAL` + `CASE_FAILURES`) and by `failures[]`,
  not by that field.
- **Counts in the header table were not re-measured here.** The suite was not re-run by
  this report's author. The four file counts were checked against the number of `it(`
  blocks in each file and agree; `pnpm typecheck` / `pnpm build` exit 0 are the reported
  `6927a2d` figures.
- **No CI run is recorded for `6927a2d`.** The table says `pending` deliberately: the
  Windows/Ubuntu cross-process runs the plan asks for are R101's deliverable, and
  inventing a run URL or number would be worse than leaving the row empty.

---

## 6. Files

| File | Change |
| --- | --- |
| `packages/evaluation/src/r97-execution-state.ts` | **new** — the durable `case×arm×repetition` state machine: `pending → running → completed/failed`, crash → `outcome_unknown`, `begin`/`complete`/`fail`/`recoverInFlight`, `unitKeyOf`, fail-closed parser with `EXEC_STATE_MISMATCH`/`CORRUPT`/`INPUT_DRIFT` |
| `packages/evaluation/src/r97-execution-state.test.ts` | **new** — 13 tests / 3 describes (S1 durability and resume-safety, S2 identity drift and fail-closed parsing, S3 the full 8×2 matrix resuming with zero new work) |
| `packages/evaluation/src/r97-budget-ledger.ts` | strict counter and `(status, consumed)` validation with `counter()`; no-clamp `remaining` check via `viewOfR97Ledger(file, { clamp: false })`; `established` flag plus `BUDGET_STATE_MISSING`/`CORRUPT`/`MISMATCH` so first creation cannot be confused with resume; owner-token + `isAlive(pid)` lock with provably-dead takeover and token-scoped release; `LOCK_STALE_MS` removed |
| `packages/evaluation/src/r97-budget-ledger.test.ts` | +196 lines / 3 new describes — G6 (12 tests, hostile counters), G7 (4, established-state fail-closed), G8 (3, lock ownership); 25 → 37 tests |
| `packages/evaluation/src/r97-driver-closed-loop.test.ts` | +52 lines / 2 new tests in the existing D2 describe — F2 full-matrix resume with 0 new calls, and partial resume of only the missing units; result object asserted on `skippedUnits`-driven `logicalCalls`/`completedUnits` |
| `packages/evaluation/src/index.ts` | +1 `export *` line for `r97-execution-state.js` |
| `scripts/e4/r97-campaign-driver.mjs` | STEP 2b opens the execution state next to the ledger and runs `recoverInFlight()` before the provider exists; the STEP 4 loop skips terminal units, quarantines `outcome_unknown`, persists `running` before each request, and records `complete`/`fail`; adds `skippedUnits`/`recoveredUnits`/`completedUnits` to the result and discloses skips in the COMPLETE reason; adds `inputDigestOf` and `resultHashOf` |
| `docs/E4-R98-report.md` | **new** — this report |
