# Memory query work acceptance

From a clean committed checkout:

```sh
node scripts/research/agent-next4-20261005/query-work-probe.mjs /absolute/repo /fresh/output
python3 scripts/research/agent-next4-20261005/frozen-acceptance.py /absolute/repo FULL_SOURCE_SHA /fresh/output
```

Fresh outputs refuse overwrites. Linux runner uses 15 serial gates and freezes source/dist; added regressions without skips, native store operation counts/full frozen-old results, existing actual memory Harness paths, CLI/Web/27 browser scenarios, security, one full suite and same named run strict usage. Query analysis is at most once per request; SQLite FTS's own split is counted separately. Timings are observations, not speedup assertions. No cross-call cache, lexical/FTS ranking changes, row-scan/hydration optimization, paid model calls or model-quality/promotion/Windows-native claims.
