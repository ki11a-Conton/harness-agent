# Retry, feedback, scoped search and rehydration acceptance

This round repairs four reproduced engineering defects. The specification was
committed before production changes at `0c70309` in
`plan(20261005-085851).md`; the baseline is `320cf3e`. It does not claim external
model quality, promotion or Windows native acceptance.

Build, then run each actual production probe with a fresh output directory:

```bash
node scripts/research/agent-next2-20261005/provider-retry-probe.mjs "$PWD" .ci/agent-next2-20261005/check-retry
node scripts/research/agent-next2-20261005/memory-feedback-probe.mjs "$PWD" .ci/agent-next2-20261005/check-memory
node scripts/research/agent-next2-20261005/search-path-probe.mjs "$PWD" .ci/agent-next2-20261005/check-search
node scripts/research/agent-next2-20261005/rehydration-budget-probe.mjs "$PWD" .ci/agent-next2-20261005/check-rehydration
```

The retry probe uses native loopback HTTP and actual provider signals, plus
explicit listener/timer ownership controls. The memory probe uses real JSONL
and SQLite stores and actual Harness turns; controlled scheduling hooks are
labeled separately from native concurrent execution. JSONL retains its existing
process-local cooperative lock. Custom stores without the optional atomic
feedback capability keep retrieval and turns, while persistent feedback is
skipped with observable degradation rather than a stale whole-row write.

The search probe uses actual tool registry, orchestrator, permission and sandbox
paths and closes the search-to-read loop. Glob matching is relative to the
selected search scope; returned paths are relative to the execution cwd. The
rehydration probe records actual effective pipeline budgets: Core already adds
the protected active-user cost to task reserve, so it must not be deducted a
second time through `messagesTokens`.

Each probe refuses to overwrite its output and saves source SHA, dirty state,
source/dist hashes, actual cases and relevant request/event/filesystem evidence.
Dirty development runs are exploratory. They do not substitute for a frozen
clean-source acceptance run.

Commit all implementation, tests and probes, then run:

```bash
python3 scripts/research/agent-next2-20261005/frozen-acceptance.py . <full-tested-source-sha> .ci/agent-next2-20261005/frozen-<source-sha>
```

The serial runner binds a clean exact commit and fingerprints all tracked inputs
and built outputs. Its seventeen gates include all new regressions, related
integration, four production probes, the unchanged previous stream-footer
controls, actual CLI/Web main accounting, 27-case Chromium suite, security,
docs, one named full run and that run's strict usage audit, prior artifact
integrity and diff checks. New formal regressions must have zero skips/todos;
the full run must retain all 8,579 baseline passing tests and every new test,
with exactly twelve baseline-identical skips.

Every command preserves argv, exit status, raw log bytes/hash and test counts.
Failed runs remain FAIL and cannot be overwritten. Completion documents and
original raw evidence are committed after tested source and verified separately.
Only native Git/curl use the authorized ephemeral GitHub token; no connector or
credential persistence is involved. Paid model calls are zero.
