# Coding repository tasks v1

This dataset pins 24 actual historical Harness changes: six cross-file tasks, six behavior/feature tasks, six recovery tasks and six session/long-state tasks. Each task records the parent workspace SHA, fixed SHA, independently hashed test oracles and historical changed paths. Requests describe behavior, not a ready-made patch.

This is a single-project retrospective set (TS/JS), not an unseen multi-repository benchmark. Historical tests are not assumed automatically portable to every host. Their pinned parent/fixed checkouts have now been bootstrapped and exercised on Linux: **19 assertion-RED / fixed-GREEN and five manually reviewed missing-feature build-RED / fixed-GREEN**. Raw reports, bootstrap logs and the explicit build-failure reviews are in `docs/evidence/coding-evolution-20261015/historical/summary.json`. The initial task-21 oracle passed on both versions; it was replaced with that fix’s real actor-close race regression and rerun on both checkouts. Windows-sensitive cases must also be checked on Windows. Integrity validation alone is not task-success evidence.

```sh
python scripts/research/coding-evolution-20261015/historical-tasks.py validate
python scripts/research/coding-evolution-20261015/historical-tasks.py prepare --task coding-history-13 --workspace /tmp/coding-history-base --revision base
python scripts/research/coding-evolution-20261015/historical-tasks.py prepare --task coding-history-13 --workspace /tmp/coding-history-fixed --revision fixed
```

Install the frozen dependencies and build separately inside each prepared checkout; never point workspace package links at a different revision's sources. Then run `historical-tasks.py verify --task coding-history-13 --workspace <checkout>`. Record actual exit status, passed/failed/skipped counts and environmental failures. A source fix must not be credited for a bootstrap failure. The tool will not replace an existing directory or silently change fixed oracle bytes.

`runCodingBenchmarkCase` is exported by `@ar/cli` as an adapter to the existing `EvalRunner` and `EvalOutcome`/baseline/paired reporting. A host supplies the prepared checkout, its already admitted model provider, identical budget/permissions/tool configuration, fixed oracle hashes and an independently executed oracle. The adapter checks oracle integrity before and after the turn and after the judge, so “done” prose or weakened tests cannot certify success. It does not create or bypass paid admission, sandboxing or the formal promotion protocol.

For paired runs, use independent checkouts/data directories, same task/model/provider parameters, context/output/call/time budgets, tools and permissions. Compare v1/v2 prompt-only first; summary, retrieval, memory and cache layout are separate controlled axes. Run three paired repetitions with alternating order. Store source/policy/schema/config identities, initial dirty/untracked state, raw events, final diff, independent checks, user interventions, token/cost/latency and cache-observation coverage. Reuse existing `collectRunMetrics`, `runBaseline` and paired evaluation; do not score agent self-reports. No default promotion follows from the adapter's offline scripted tests.
