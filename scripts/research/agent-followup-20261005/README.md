# Stream, symbol scope and instruction read acceptance

These probes validate existing engineering contracts. They use local HTTP and
synthetic keys only; they cannot establish real model task quality or promotion.
The implementation specification was committed before production edits in
`plan(20261005-agent-followup-preregistered).md` at `b00299e`.

Build the repository, then run each probe with a fresh output directory:

```bash
node scripts/research/agent-followup-20261005/provider-probe.mjs "$PWD" .ci/agent-followup-20261005/provider-check
python3 scripts/research/agent-followup-20261005/main-accounting.py --root . --out .ci/agent-followup-20261005/main-check --expect-sha <full-source-sha>
node scripts/research/agent-followup-20261005/symbol-production-probe.mjs "$PWD" .ci/agent-followup-20261005/symbol-check
node scripts/research/agent-followup-20261005/scoped-instruction-probe.mjs "$PWD" .ci/agent-followup-20261005/instruction-check
```

The provider probe checks trailing usage and cancellation against actual built
provider HTTP behavior, along with native reader ownership controls. The main
accounting probe is adapted from the previous system-context driver and reuses
its unchanged seed/event worker. It starts the actual CLI and Web main entries,
checks system/AGENTS/memory/tool protocol, and checks durable `model.completed`
records for measured input/output tokens. Cumulative usage snapshots are not
summed twice. The symbol probe uses the production tool registry, orchestrator,
permission engine and sandbox, measuring actual filesystem calls as well as
results. The instruction probe uses real files/descriptors, with labeled
filesystem hooks for race/error injection; the path-scoped strategy stays opt-in.

The probes refuse to overwrite an existing output directory, preserve their
actual requests/events/filesystem observations, and identify source SHA,
tracked dirty state, and source/dist hashes before and after. Exploratory runs
can be dirty; completion requires a fresh clean frozen run.

Commit all implementation, tests, and probes before final acceptance:

```bash
python3 scripts/research/agent-followup-20261005/frozen-acceptance.py . <full-source-sha> .ci/agent-followup-20261005/frozen-<source-sha>
```

The serial runner refuses a dirty source or a different SHA. It fingerprints
tracked inputs and built outputs and executes all added regressions, related
integration/security, production probes, actual CLI/Web accounting, the 27-case
Chromium suite, docs, one named full test run, that run's strict usage audit,
prior evidence integrity and the baseline-to-source diff check. Every command
retains argv, exit status, raw log hash and parsed test counts. All added formal
regressions must execute without skips or todos. A failed/interrupted run keeps
its FAIL manifest and cannot be overwritten by a later success.

Completion documents and archived evidence are committed after the tested
source and must be identified separately. Native Git/curl publication requires
local/remote SHA equality. Credentials are never written into these artifacts.
Windows native execution, paid model calls, real model quality and champion
promotion remain NOT_RUN unless separately proved.
