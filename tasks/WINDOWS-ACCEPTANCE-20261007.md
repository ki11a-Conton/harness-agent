# Genuine Windows acceptance — 2026-10-07

The user requests genuine Windows execution of the remaining platform checks.
Paid-model experiments are being run separately on the user's own computer.

Use the repository's Windows GitHub Actions runners, native Git and GitHub HTTP
API. Do not use the GitHub connector, Wine, mocked platform values, or Linux
results as evidence of genuine Windows execution. Preserve the user's original
workspace and the existing source-audit acceptance package.

Scope: follow the CI run for main `b94ded5424bc1b7b32550ff07f2df3714de23f20`,
investigate any Windows failures, and make only deterministic correctness,
security, integrity or acceptance-tool portability fixes justified by evidence.
Do not change model strategies, frozen benchmark cases, or quality thresholds.

Acceptance: install, typecheck, build and the standard test suite on real
Windows; verify that the ten Windows-only process tests omitted on Linux were
executed; collect runner/job identity, exact tested SHA, raw logs and artifact
hashes. Report formal/readiness/release gates separately, including any unmet
requirements. No paid providers are required for this work.

Run `37597081529` reproduced four Windows failures: the executor returned before
asynchronous taskkill completed; a scope-test assertion assumed POSIX separators;
a parent-directory replacement fixture assumed an open directory could be
renamed on NTFS; the Web follow-up test gave durable cancellation only one second.
The production fix waits for taskkill completion and reports termination failure
explicitly. Fixtures keep their scope, failed-capture and durable-terminal
assertions while accommodating observed native platform behavior.

Dedicated Windows acceptance also inspects real child/grandchild PIDs at the
returned cancellation/timeout boundary. Structured public check annotations bind
every final case state to the genuine host and exact workflow SHA; their hashes
allow receipt verification when Azure artifact downloads are unavailable.

Windows execution acceptance: PASS at
`0cf4549f4f040b8abc983cafc4fcac4805041dab`, genuine Windows run
`37611869373`, job `112760760987`. All ten pre-existing Windows-native tests and
both new child/grandchild completion checks executed and passed: 179 passed,
0 failed, 1 POSIX-only skip, 13 files. Acceptance-report parser: 4 passed.
The same source's standard Windows CI install, typecheck, full unit/integration
test step, build and strict usage audit passed in run `37611869402`.
That CI run finally passed all ten jobs, including both main verify jobs,
both formal offline legs, both R97/R98 closed loops, coverage, cold-start,
dual-platform acceptance and release attestation.

Local clean-source full acceptance: 9,032 passed, 0 failed, 14 explicit skips;
security: 2,135 passed. The Linux container needed a real child subreaper to
supply normal orphan reaping; no test assertions or Runtime kill paths were
changed for that host setup. Source SHA remained unchanged for the whole run.

Evidence is archived in
[Windows acceptance completion](../docs/evidence/windows-acceptance-20261007/COMPLETION.md).
Public native-run annotations preserve all final case states losslessly and
their digest was independently verified. GitHub artifact digest metadata is
recorded; direct Azure raw-log/ZIP downloads are blocked by the workspace proxy,
so their original bytes are not claimed to have been independently downloaded
or hash-verified. Formal/readiness/release results are reported separately in
the completion report. No paid-model quality verdict follows from these checks.
