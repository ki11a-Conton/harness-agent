# Command diagnostic feedback evidence

`validation.json` binds the working-tree checks to SHA-256 digests of the changed
source files. `SHA256SUMS` covers the original receipt bytes. The clean full-suite
result and exact final main CI are separate, subsequent acceptance stages.

`paired-baseline/` and `paired-candidate/` contain the actual compiler/check/test
child receipts and the **tool-role** messages in the next provider request. The
baseline config loads only the old `exec.ts` from main `bddf6f64`; both sides use
the same real Harness, Orchestrator, executor and context-budget infrastructure.
Baseline framework reports three expected failures; candidate reports three
passes. Each failed command exits 1, each replay makes two deterministic provider
requests, and each observed tool message is 4356 bytes. This measures diagnostic
transport, not model quality or real-repository task success. Paid calls: zero.

`upstream/` preserves the exact pi source and MIT license from collection commit
`1a46ea13de9a3f5e6987c5dd0319b2000fe49c92`. The full license was also checked in
the emitted JavaScript. The adaptation retains only bounded in-memory suffixes.

`original-bdd-ci/` preserves the previous main's genuine failures. Windows UI
failed because a child owner could not obtain its fixed compatibility lease;
the read-only projection identifies the original artifact and byte hashes.
The Ubuntu nested full-suite held-a barrier failure has a deterministic
same-shaped reproduction when the old fixture pauses B's ordinary live unlock.
The exact original scheduler interleaving was not captured and is not claimed.
Neither failure was hidden by rerunning the original CI.

The fresh-fixture helper prepares a real empty owner before browser checks,
reallocates only a never-published busy fixture after draining its owned child,
and keeps the selected directory on restart. Product lease policy is unchanged.
`ui/` records 30 scenarios/75 checks; `connection/` records 10 checks, two
languages and both launch histories. Those were local working-tree fixture runs,
not the final clean installed archive or native Windows proof. Expected console
errors during intentional host loss are preserved in the original reports.

`takeover-preserved-red.log` is an intentional one-failure control with the old
first-removal fixture hook. `takeover-unsafe-red.log` is an intentional
one-failure control: a fault-injected guard in isolated test children produces
actual `overlap=true`. The normal fixture passes both schedules and the leftover
guard case. Production budget ledger code and all original time limits remain
unchanged. The configs under `scripts/research/exec-diagnostics-20261016/` reproduce
these controls; they are not included in the default full test run.
