# Evolution E1 — Baseline Evidence (E1-00)

> Task E1-00: freeze the real baseline and reproduce the six known problems.
> This task establishes reproducible facts, test fixtures, and the state ledger.
> It implements NO fixes (those are E1-01..E1-16) and makes NO real-model API calls.

## Baseline facts

- Review HEAD: `84c7163eb68493c6bc4aa59cb78a83d3af7faa03` (`main`)
- Working tree at task start: 3 deleted plan files
  (`plan.md`, `plan-P38.3-RC-M1-final-hardening.md`, `plan-P38.4-post-freeze-recovery-benchmark-evidence.md`)
  — pre-existing deletions from the prior session, not produced by E1-00.
  CAPABILITY_MATRIX.json/.md were restored to HEAD after the full test run polluted them (see Repro 6).
- Node: v24.18.1; pnpm: 11.21.0
- `pnpm typecheck`: PASS
- `pnpm test`: 250 files passed / 1 file failed, 4969 passed / 3 failed / 1 skipped (251 files, 4973 tests)
  - The 3 failures are `packages/tools/src/orchestrator.test.ts` (P2-25 supply-chain gating x2) and
    `packages/tools/src/process/executor.test.ts` — they PASS when run serially
    (`pnpm vitest run <file> --no-file-parallelism` → 40/40).
    Root cause: parallel test isolation defect on this host, not an E1 regression.
    Recorded as a baseline risk; E1-16 final gate must run the full suite and report the same caveat
    if it persists, or investigate as follow-up.
- `pnpm build`: not run in E1-00 (fixes change the build); baseline typecheck is green.

## Deterministic reproductions (all free)

### Repro 1 — `exec cwd` escapes the workspace (P0)

`packages/tools/src/tools/exec.ts` uses `cwd: input.cwd ?? context.cwd`. When the model passes
`cwd: "."`, Node resolves it against the HOST `process.cwd()`, not the session workspace.

Script: `.ci/e1-repro-exec-cwd.mjs`

```
tool result cwd (should be temp, actual is host cwd if bug):
  stdout: D:\Harness Agent
  temp  : C:\Users\s5605\AppData\Local\Temp\e1-repro-uyVgzs
  MATCH_TEMP: false
```

EXPECTED (old): `MATCH_TEMP: false` (host cwd returned). CONFIRMED.
This is why benchmark cases can write into the repo root (observed historically: `out/value.txt`, `cron.txt`).

### Repro 2 — deferred-schema candidate does NOT actually defer (P0)

`decideSchemaAdvert` (packages/contracts/src/schema-advert.ts) only switches to `deferred` when
estimated schema tokens exceed `DEFAULT_MAX_INLINE_SCHEMA_TOKENS` (24_000) AND the tool is not in
`keepFull`. The benchmark tool set (~5 builtins) is far below the threshold and every builtin is in
`keepFull`, so even with `tool_lookup` registered the candidate advert stays `full` with `deferred=[]`.

Script: `.ci/e1-repro-deferred-schema.mjs`

```
baseline advert:  mode=full tokens=130 deferred=[]
candidate advert: mode=full tokens=145 deferred=[]
CANDIDATE_ACTUALLY_DEFERS: false
SCHEMA_DIGEST_SAME: true
```

EXPECTED (old): `CANDIDATE_ACTUALLY_DEFERS: false`, identical digests. CONFIRMED.
The historical "+1 pass" for `tool_selector_deferred_schema` cannot be attributed to deferred schema
advertisement. Also confirmed in `provenanceForCase` (benchmark-command.ts): `candidateConfigHash`
includes `challengerFlags: { [candidate]: true }`, so an unwired/no-op candidate still gets a different
hash — "candidate differs" can be faked by a name/flag change (Repro 2b).

### Repro 3 — memory_retrieval ran against an empty store (P0)

All 30 holdout case.json files have `sources.memory` empty or absent.

Command (free):

```bash
node -e "..."  # scans benchmarks/holdout/*/case.json for sources.memory
```

Result:

```
holdout total cases: 30 with non-empty memory: 0
```

EXPECTED (old): 0 non-empty. CONFIRMED. The historical "-529K tokens" efficiency delta for
`memory_retrieval` cannot be attributed to memory retrieval (empty SQLite store, empty injection block).

### Repro 4 — `agent champion eval` cannot read the committed report object (P0)

Committed challenger artifacts are `{manifest, meta, results, summary}` objects. `champion eval`
expects `EvalOutcome[]` (flat array). Running the public command on committed files:

```bash
node apps/cli/dist/main.js champion eval \
  benchmarks/results/2026-08-27-deepseek-v4-flash/holdout.json \
  benchmarks/results/2026-08-27-deepseek-v4-flash-deferred-schema/holdout.json --mode real-model
```

Result: `champion eval failed: baselineRuns.map is not a function`, exit code 1.

EXPECTED (old): cannot parse report object. CONFIRMED. Committed evidence cannot be reproduced through
the public command without ad-hoc conversion (`.ci/runs-to-evaloutcome.mjs` was used historically).

### Repro 5 — `agent benchmark validate` rejects single-suite challenger dirs (P0)

```bash
node apps/cli/dist/main.js benchmark validate benchmarks/results/2026-08-27-deepseek-v4-flash-deferred-schema
```

Result: `INVALID — ERROR: manifest.json: ENOENT ... manifest.json` (exit 1). The validator requires a
top-level `manifest.json` that single-suite challenger dirs do not produce. Also, `holdout.json` and
`holdout-runs.sanitized.json` are byte-identical (sanitized naming is misleading; there is no real
sanitization metadata).

EXPECTED (old): INVALID, missing manifest. CONFIRMED.

### Repro 6 — `pnpm test` pollutes tracked capability files (P0)

`agent audit --json` without an explicit output dir writes `CAPABILITY_MATRIX.json` and
`CAPABILITY_MATRIX.md` into `process.cwd()`. Running the full `pnpm test` suite modifies these tracked
files:

```
 M CAPABILITY_MATRIX.json
 M CAPABILITY_MATRIX.md
```

EXPECTED (old): tracked files modified by the test run. CONFIRMED. Files were restored to HEAD
(`git checkout -- CAPABILITY_MATRIX.json CAPABILITY_MATRIX.md`) after recording — fixing this is E1-01.

## Decision ledger

`docs/evolution/e1-decision-ledger.json` records the four historical challenger verdicts as
`HISTORICAL_ONLY`:
- `tool_selector_deferred_schema` ACCEPTED → `HISTORICAL_ONLY` (MECHANISM_NOT_ACTIVATED)
- `memory_retrieval` ACCEPTED → `HISTORICAL_ONLY` (MECHANISM_NOT_ACTIVATED / EMPTY_MEMORY_STORE)
- `adaptive_recovery` REJECTED → `HISTORICAL_ONLY` (V1_PROVENANCE_NOT_STRICT)
- `adaptive_context_policy` REJECTED → `HISTORICAL_ONLY` (V1_PROVENANCE_NOT_STRICT)

None are treated as active Champion. Active Champion remains C0 (frozen production baseline) until a
strict, activated, provenance-valid paired rerun is authorized (RUN_PAID_BENCHMARKS=1).

## Known baseline risks (not fixed in E1-00)

1. Parallel test isolation: 3 tests fail under file parallelism but pass serially.
2. Full free gate (`pnpm test`) pollutes the worktree (CAPABILITY_MATRIX). Fix: E1-01.
3. Benchmark workspace isolation absent (repro 1). Fix: E1-02.
4. No-op/unwired candidates can produce different candidate hashes (repro 2b). Fix: E1-03.
5. Historical 25/84 pass rate is a single-run measurement, not a strict baseline. Fix: E1-11 protocol.

## Clean-tree check (E1-00 end)

Expected tracked changes from this task: `docs/evolution/e1-baseline.md`, `docs/evolution/e1-decision-ledger.json`.
`.ci/e1-repro-exec-cwd.mjs`, `.ci/e1-repro-deferred-schema.mjs` are in `.ci/` (gitignored).
No benchmark output or capability-matrix drift.
