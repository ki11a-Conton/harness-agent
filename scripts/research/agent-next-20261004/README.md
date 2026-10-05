# Agent efficiency acceptance probes (2026-10-04)

## R1 production system context

Build the repository first, then run:

```bash
python scripts/research/agent-next-20261004/provider-production.py --root . --out .ci/agent-next-20261004/r1-http-<source-sha> --expect-sha <full-source-sha>
```

The output directory must not exist. `provider-system-probe.mjs` is the worker for a real production provider HTTP/SSE check and a safety-gated JSONL memory fixture. The Python driver supplies a synthetic placeholder key and a loopback endpoint in a minimal child environment; it does not read inherited credential values or contact a paid model. It preserves actual wire requests, main process logs, production durable stores, source/dist/probe hashes, and a result receipt.

Five direct cases cover exact multiline Chinese system bytes, historical system messages, empty and absent system fields. Actual CLI main explicitly enables memory, then reads a real file through its normal tool path: both model requests must carry the default system, admitted AGENTS and advisory memory; a separate malicious AGENTS document must produce a rejection event and remain absent on the wire. Actual Web main performs an ordinary reply and a tool loop with the default memory feature disabled. The post-tool requests must preserve the leading system and complete assistant/tool pairs. These are engineering/protocol checks; real model quality and Champion promotion remain `NOT_RUN`.

`sourceTrackedDirtyAtStart/End` distinguishes exploratory working-tree runs from the final frozen source. `--expect-sha` binds the requested commit; fingerprints must remain unchanged throughout either kind of run. Root final acceptance is responsible for requiring a clean source tree.

## R2 complete retrieval equivalence and work reduction

After building, run each probe serially with a fresh output directory:

```bash
node scripts/research/agent-next-20261004/memory-differential-probe.mjs . .ci/agent-next-20261004/r2-differential-<source-sha>
node scripts/research/agent-next-20261004/memory-paired-performance-probe.mjs . .ci/agent-next-20261004/r2-performance-<source-sha>
node scripts/research/agent-next-20261004/memory-harness-probe.mjs . .ci/agent-next-20261004/r2-harness-<source-sha>
```

The common loader verifies the frozen 18f162b retrieval source and compiled bytes, and checks unchanged search/security/lifecycle sources against native Git objects. Both algorithms use the same built production search and gates. The differential probe compares complete results, including score fields and suppression order, on fixed and deterministic varied fixtures. Its tie fixture must report exactly equal total scores and retain the input order in both implementations. Disposable instrumented module copies count tokenizations and pair comparisons; these copies are excluded from timings. The production result must match the instrumented observation, and each scored candidate must be tokenized at most once. A second-call mutation control checks that cached tokens do not survive a retrieval.

The paired performance probe uses the byte-pinned 10,000-row fixture and fixed clock. Baseline and candidate execute serially in alternating AB/BA order, with two warm-ups and five recorded samples per scenario/backend. Both JSONL and SQLite Chinese complete-retrieval medians must improve by at least 50%, and complete results must remain equivalent. Other scenarios are recorded without claiming that every query becomes faster. Keep build, test, and other CPU-heavy work idle during this probe. The Harness probe separately checks the production memory references and request bodies for equivalence.

This is a per-call token cache. Worst-case pair comparisons remain quadratic, retained token Sets consume additional memory, and SQLite supplemental scans remain unchanged. ASCII/Jaccard conflict rules, empty-token Unicode behavior, recall, ranking, scope/session ownership, lifecycle, safety gates, and defaults retain their existing contracts. The probes measure engineering work and elapsed time; they do not establish live model task quality.

## R3 production navigation boundaries

```bash
node scripts/research/agent-next-20261004/navigation-probe.mjs --workspace .
```

Capture its JSON stdout unchanged. The probe creates a real temporary filesystem and invokes built tools through ToolRegistry and ToolOrchestrator with the existing PermissionEngine/Sandbox path. Seven mandatory checks cover 66 immediate directories including an empty directory with one listing, depth zero with no listing, a shared file/directory cap with global stop, capped grep with at most two listings, ignored/generated/symlink entries, outside-path denial, and permission denial before traversal. Permanent regressions additionally cover nested stops, the symbol fallback, verified subpath ancestors, mixed entries, unreadable/missing paths, trusted root aliases, and rejection of intermediate symlink ancestors. The public walkFiles result remains Promise<void>; repo_tree depth is absolute and relative to the workspace root. Directory entries now count toward the same cap as files.

## R4 frozen acceptance

Commit all source, regression, and probe changes first. Start the runner from a clean working tree and use a full source SHA and a fresh Git-ignored output directory:

```bash
python3 scripts/research/agent-next-20261004/frozen-acceptance.py . <full-source-sha> .ci/agent-next-20261004/frozen-<source-sha>
```

The runner refuses a dirty tree or a different commit, then executes build/typecheck, the three new regression files, actual R1 HTTP/CLI/Web checks, all three R2 probes, R3 production navigation, the existing 27-case Chromium browser suite, security/docs checks, one named full-repository test run, strict usage-audit for that same observation run, previous artifact integrity checks, and the baseline-to-source diff check. Commands execute serially and retain their argv, exit codes, raw logs, byte hashes, and receipts. The manifest fingerprints tracked source and built dist bytes before and after commands. New regressions must have no skipped or todo cases. Existing full-suite skips remain visible in the raw summary; they are not new coverage.

The final status is PASS only after every mandatory command and receipt gate passes. An interrupted or failed command produces a FAIL manifest and preserves the failure log. This runner is Linux acceptance; Windows is explicitly NOT_RUN unless separate exact-source CI evidence is recorded. Paid provider calls, live model quality, and Champion promotion remain outside this acceptance. Credentials are not written to the repository or evidence. Final completion documentation and native Git publication receipts must distinguish the tested source commit from any later evidence-only commit.

The first frozen full run at 91967f4 retained three failing legacy wire E2E expectations: they assumed the separate system field was dropped. The existing wire E2E fixture now asserts the leading exact system body and shifts assistant/tool positions explicitly, while preserving full role sequences, legality and durable history assertions. All eight cases run as an additional early gate. The original failed full log and manifest remain unchanged; final acceptance requires a fresh clean commit and full run.
