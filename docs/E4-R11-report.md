# E4-R11 Report — paid-run evidence calibrated, attribution narrowed

## What was done (offline, no new paid runs)

1. **Surviving evidence indexed.** The original run directory
   `%TEMP%\e411-c17d0c9a` still exists (cases, out/out2/out3/out4,
   `paired-experiment.json`, per-arm journal records, `v3-baseline/v3-candidate`,
   the crux-case fixtures and the evaluator runner). SHA-256 for every file was
   captured and recorded in `docs/E4-11-report.md` (movable evidence index). No
   original file was rebuilt from report numbers — and none was rewritten.
2. **Over-claim corrected.** The old text asserted the endpoint/model "is not
   capable" of a well-formed exec call and that "any exec-requiring case cannot
   complete through it". That exceeded the evidence (ONE malformed call in ONE
   run). The report now states the calibrated observation: a malformed `exec`
   call was observed once, the harness fail-closed correctly, and **no real-model
   ACCEPT was achieved with this provider/model on this case** — not a claim the
   endpoint can never produce one.
3. **Usage semantics fixed.** Runs where the endpoint returned no `usage` are now
   marked **usage unknown/missing** — never tokens=0 / cost=0 — and the
   budget-execution semantics are bounded accordingly.
4. **Digest binding clarified (R01).** Attempts 1–2 reused one `--plan-digest`
   across provider/model changes; per the R01 execution identity contract that
   digest did NOT bind provider/model, so those runs are no longer described as
   proof of a "confirmed full execution plan" — provider/model binding exists
   only from R01's `executionIdentityDigest` forward.
5. No fabrication: `promotionEligible=false` (insecure-local), HTTP 429 in
   Attempt 1, `INCONCLUSIVE` / stop-execution in Attempts 2–3 remain as recorded.

## Verification

- Only documentation changed (`docs/E4-11-report.md`); no source, no test, no CI.
- The evidence index was generated from the live temp directory with `Get-FileHash
  -Algorithm SHA256` (original bytes, not rehashed copies).
- `git status` clean after commit.

## Committed file

- `docs/E4-11-report.md` (calibrated attribution + usage-missing semantics +
  movable evidence index).

## Honest limits

- If the temp directory is deleted, the run becomes "original evidence
  unverifiable" (report-only) — this report does not claim otherwise.
- The provider-request/response bodies were not retained beyond the artifacts
  listed; deep tool-call-level normalization analysis (R11 last items) needs the
  raw endpoint transcripts, which were not preserved — recorded, not faked.