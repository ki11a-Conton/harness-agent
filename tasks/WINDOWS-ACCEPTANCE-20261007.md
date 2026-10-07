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

Status: in progress. Local focused regressions: 154 passed, 0 failed, with
Windows-native cases explicitly skipped. Acceptance-report parser: 3 passed.
The changes must pass real Windows before this task is complete.
