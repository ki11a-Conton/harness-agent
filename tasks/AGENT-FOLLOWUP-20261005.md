# Agent follow-up correctness maintenance — 2026-10-05

Baseline: `f71b444eec6b4024039716a1a0a01bade22c90b0`.

Read [plan.md](../plan.md) for what changes, implementation boundaries, and acceptance. This task is authorized by the user's request to propose and complete the next agent optimization autonomously, with the earlier authorization to publish main using native Git.

The Runtime Freeze exceptions are deterministic defects with actual reproducers: standard stream usage is lost and cancellation/reader cleanup is incorrect; symbol search both misses non-TS languages and reads outside its approved scope; opt-in instruction capture exceeds its byte contract on malformed UTF-8 and admits incomplete reads or fails the whole discovery on cleanup errors. This is maintenance of existing contracts, not a strategy or architecture rewrite.

No Core production, ToolOrchestrator, PermissionEngine, SandboxManager, Verification, runtime default, model-quality gate, or dependency changes. Never bypass permission/sandbox to make an integration check pass. Preserve failures and baseline results, distinguish clean tested source from completion documentation, and report skipped/unrun surfaces honestly.

Completion requires all preregistered R1–R4 criteria in plan.md, source review, real production-path checks, an exact-source full repository test run with its matching strict usage audit, evidence hashes, and a verified native publication. Prior-run evidence is historical context only.

One related existing provider deadline test also needs oracle maintenance. Its mock returned HTTP success on the second fetch despite the whole-call signal already being permanently timed out; the prior assertion expected a successful completion. The fixture and two-fetch/one-retry assertions remain, while the terminal assertions now require the timeout and prohibit completion/tool deltas. The shared request deadline and retry policy are not reset or loosened. Initial failed targeted logs remain evidence; this test-only correction is covered by the same clean-source model and full suites.

## Completed acceptance

The clean tested source is `2476c23444079a2cba29480b35d65157cf30c0fd`; all 15 mandatory gates passed. There are 95 new regressions with zero skips/todos; the full run passed 8,579 tests with the 12 baseline-identical skips, and its own strict usage audit observed all seven capabilities. Security passed 2,135 tests; the Chromium suite passed 27 cases and 77 assertions. Production provider/symbol/instruction probes passed 31/32/51 cases, and actual CLI/Web main accounting passed seven cases/ten requests.

See [the final evidence report](../docs/evidence/agent-followup-20261005.md), immutable raw artifact index, independent source/runtime/archive review, and the native main source publication receipt. The completion commit contains only documentation, evidence and byte-preserving attributes; runtime, tests and probes remain equal to the frozen tested source. Native publication of that documentation commit is verified separately after commit creation. Paid calls are zero; real model quality, promotion and Windows native execution are NOT_RUN.
