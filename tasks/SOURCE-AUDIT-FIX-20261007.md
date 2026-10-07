# Source audit fixes — 2026-10-07

User-authorized maintenance of the defects reproduced against main
`7203a01bf83e8ebe25e0971bb65a7bdeac6d9311` in
[the audit](../docs/reviews/source-audit-20261007/README.md).

Scope: B01–B21 correctness/security/integrity defects, B22–B23 development
dependency advisories, D01–D02 documentation consistency. Preserve the original
audit evidence and all existing strategy text and model-quality thresholds.
Do not rewrite plan.md. These deterministic reproductions satisfy the Runtime
freeze exceptions in AGENTS.md; Core continues to depend only on contracts.

Acceptance: convert the counterexamples to correct-behavior regression checks;
run relevant integration/security tests, typecheck and the full suite; exercise
real files, persistence failures, Web restart and verification cancellation.
Report Windows, browser and paid-provider checks separately when not executed.
Record results and remaining limitations in a completion receipt.

Acceptance-tool compatibility: authorize the browser fixture's fixed verifier
through an explicit host rule, trust only its own loopback proxy, and repair
optional perf/soak commands that previously selected zero test files. This does
not change production permissions, benchmark case bytes or quality thresholds.
