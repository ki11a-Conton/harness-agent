# E4-R14 — restoring `a6-forged-evidence-accepted` coverage

Branch `e4/r14-mutation-target`, based on local main
`6bf130f7372c9ab748f125b4e8da05006b8898b7`. Zero paid/external requests.

**Result: the full anti-cheat gate is 27/27 CAUGHT, exit 0, tree restored** — with
the mutation itself untouched (its `find`/`replace` are byte-identical; only its
stale status comment changed) and the repair landing in the TEST FIXTURE.

## 1. THE REQUIRED FIRST DECISION — with its evidence

> Were the merged cost/provenance gates INTENDED to reject this fixture?

**No.** They implement a general rule for a JOURNAL-LESS campaign, and this fixture
predates the ledger wiring every production caller uses. Evidence:

1. **The fixture's own stated intent** (`apps/cli/src/prereg-formal-gaps.test.ts`,
   written long before the R2 merge): *"With the candidate winning, EVERY hard gate
   is satisfied and the fabricated evidence is the only thing that could still block
   ACCEPT."* The fixture exists to isolate evidence corroboration as the SOLE
   blocker — that is its documented premise, not an accident.
2. **It held at the review baseline.** `r97-mutation-check.mjs` records `27/27`
   CAUGHT at `a85db6dc`; this mutation was one of the 27.
3. **The two blocking gates changed in R2** (merged `f388a80e`), and only for the
   journal-less case:
   - `comparable: !contaminated && !tokensUncorroborated` →
     `comparable: !contaminated && !costNotObserved`;
     the old `tokensUncorroborated` was `journalTokens === null && selfReportedDelta
     !== 0`, and this fixture's runner reports the SAME `tokensUsed` (1) for both
     arms, so the self-reported delta was exactly 0 and the old gate stayed true;
   - `tokensDelta: journalTokens ?? 0` → `cost.deltaTokens ?? Number.POSITIVE_INFINITY`.
   Both changes were MANDATED by plan §R2 ("a missing ledger must not degrade to 0";
   "no journal ⇒ not proven cost-safe even when the outcome delta is 0"). Neither
   was written to reject this fixture.
4. **The production caller always hands the ledger over.** `preregCmd` reads
   `readCostJournal(budgetDir)` and passes `journal` + `journalChargedTokens`. The
   fixture did not — it was stale relative to the merged API, not deliberately
   journal-less.
5. **The property never moved.** Forged evidence still cannot reach ACCEPT; what was
   lost was the ISOLATION of the one-site mutation, so the honest repair is the
   fixture (task-13's recommendation), not a compound mutation of unrelated
   invariants and not a deleted check.

## 2. The repair

| File | Change |
| --- | --- |
| `apps/cli/src/prereg-formal-gaps.test.ts` | The fixture now reads the DURABLE ledger the campaign really produced (`readCostJournal(join(dir, "budget"))`) and passes it to the aggregate, exactly as the release CLI does. It also asserts the premise explicitly: `cost.basis === "JOURNAL_ZERO_EVIDENCE"`, `gates.costBounded === true`, `gates.provenanceComparable === true`, `gates.artifactIntegrity === false`, and only then `decision !== "ACCEPT"`. |
| `scripts/e4/r97-mutation-check.mjs` | **COMMENTS ONLY.** The `a6-forged-evidence-accepted` definition's stale "dead check" note is replaced by the measured history and the R14 resolution. `find`, `replace`, `suite`, `test`, `anchorOccurrences` and the acceptance rule are byte-identical (`git diff` shows zero non-comment lines). |
| `docs/evidence/E4-R14-report.md` | This record. |

Why the repair is honest, not a weakening:

- The zero is **corroborated, not assumed**. The forged runner never calls
  `ctx.provider`, so the campaign genuinely made no call; the R97 call ledger agrees
  (`providerCalls: 0`) and the cost ledger charged nothing. That is exactly the one
  zero the cost rule permits ("all-zero calls with independent verifiable zero
  evidence"); an ABSENT ledger is still refused as NOT_OBSERVED.
- The fixture is now STRONGER than before: it asserts the premise (cost/provenance
  pass, artifact corroboration fails), so if either gate starts refusing this
  fixture again the test fails LOUDLY instead of passing for an unrelated reason.
- Nothing was deleted, weakened, re-pointed, or hooked. No mutation was removed, no
  `anchorOccurrences` change, no relaxed acceptance filter.

## 3. Measurements (Windows-local, quiet tree)

| Check | Before | After |
| --- | --- | --- |
| `node scripts/e4/r97-mutation-check.mjs --only a6-forged-evidence-accepted` | `[MISSED]`, exit 1 | **`[CAUGHT]`, exit 0**, tree RESTORED |
| full gate `--out …` | 26/27 (1 MISS) | **27/27 CAUGHT, exit 0**, `treeRestored=true`, `ok=true` (T6 5/5, A7 14/14, N5 5/5, S0 2/2) |
| `pnpm exec vitest run packages/evaluation/src/r97-mutation-check.test.ts apps/cli/src/prereg-formal-gaps.test.ts` | 4 failed / 43 passed | **47 passed (47)**, exit 0 |
| `pnpm test:n0-gaps` | — | **12 passed (12)**, exit 0 |
| `pnpm test:red-next-gaps` | — | **14 passed (14)**, exit 0 |
| `pnpm typecheck` | — | **exit 0** |

The mutation JSON for this run records `a6-forged-evidence-accepted: ok=true,
restored=true`, bound to `apps/cli/src/prereg-formal-gaps.test.ts` →
"forged 64-hex evidence with no real trace cannot ACCEPT".

## 4. HAZARD FOUND WHILE MEASURING (operational, not a code defect)

The first three meta-suite runs reported **4 failures naming
`a2-deleted-root-can-be-reclaimed`'s anchor as absent**. They were NOT caused by this
change: a **stray `node scripts/e4/r97-mutation-check.mjs` process was still alive
and walking the mutation list**, mutating production sources underneath the
meta-suite (different target file on each attempt: `r97-budget-channel.ts` with an
EOL-only diff, then `r97-budget-ledger.ts`, then
`tool-call-efficiency-paired-campaign.ts` with a real mutation applied). After
killing that process and restoring the tree (`git checkout -- .`), the same command
reported **47 passed (47)**, and the gate re-run finished with a clean tree and no
surviving process.

**Operational rule for anyone re-running this gate:** the gate mutates PRODUCTION
sources sequentially in the working tree. Running another vitest suite concurrently
— or leaving an orphaned gate process alive — makes unrelated suites fail against
temporarily mutated sources. Verify the tree is clean and no gate process is alive
before trusting either result.

## 5. Reproduction

```powershell
# from the worktree root, on a CLEAN tree with no other vitest running
git status --porcelain                                            # must be empty
node scripts/e4/r97-mutation-check.mjs --only a6-forged-evidence-accepted   # [CAUGHT], exit 0
node scripts/e4/r97-mutation-check.mjs                            # 27/27 CAUGHT, exit 0
pnpm exec vitest run packages/evaluation/src/r97-mutation-check.test.ts apps/cli/src/prereg-formal-gaps.test.ts
pnpm test:n0-gaps
pnpm test:red-next-gaps
pnpm typecheck
```
