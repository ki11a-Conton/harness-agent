# Agent follow-up correctness maintenance — 2026-10-05

Baseline: `f71b444eec6b4024039716a1a0a01bade22c90b0`.

Read [plan.md](../plan.md) for what changes, implementation boundaries, and acceptance. This task is authorized by the user's request to propose and complete the next agent optimization autonomously, with the earlier authorization to publish main using native Git.

The Runtime Freeze exceptions are deterministic defects with actual reproducers: standard stream usage is lost and cancellation/reader cleanup is incorrect; symbol search both misses non-TS languages and reads outside its approved scope; opt-in instruction capture exceeds its byte contract on malformed UTF-8 and admits incomplete reads or fails the whole discovery on cleanup errors. This is maintenance of existing contracts, not a strategy or architecture rewrite.

No Core production, ToolOrchestrator, PermissionEngine, SandboxManager, Verification, runtime default, model-quality gate, or dependency changes. Never bypass permission/sandbox to make an integration check pass. Preserve failures and baseline results, distinguish clean tested source from completion documentation, and report skipped/unrun surfaces honestly.

Completion requires all preregistered R1–R4 criteria in plan.md, source review, real production-path checks, an exact-source full repository test run with its matching strict usage audit, evidence hashes, and a verified native publication. Prior-run evidence is historical context only.
