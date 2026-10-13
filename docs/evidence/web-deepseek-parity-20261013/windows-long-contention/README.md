# Windows long rename contention and role metadata

Original source `9c02f1b101b78f90c09a8479276a2a4d38871bb1`: local full suite 9,470 PASS / 15 skipped; official UI same archive Linux and Windows 30 cases / 75 assertions each. The main CI Windows legs failed; those successes never substitute for the failures.

Original formal Windows log `38385871940`, exported by diagnostic `38387152756`, contains a real `EPERM` replacing the paused turn JSON. The eight-attempt / 710ms retry window was exhausted and the original turn stayed waiting. A deterministic injected actual rename counterexample exceeding those eight attempts fails before the fix. Replacement now allows 16 attempts / 5.13s of retry delays, only on the existing Windows transient error allowlist. Exhaustion remains a visible error; the committed target is never deleted. Web eventual-state tests use a bounded 10s wall-clock deadline covering that legitimate I/O delay.

The independent Windows verify leg also reported ENOTEMPTY while removing a workspace fixture with all operations awaited and no active model. Test removal now applies Node's bounded Windows rm retries; POSIX cleanup remains immediate. This does not replace the separate terminal ACK ownership regression.

An actual restarted official UI showed a UUID for the original role: the new registry lacked its old durable agent ID. The second deterministic RED expects the original cosmetic name while preserving the original ID and READ_ONLY policy. New sessions persist an identity-bound, validated cosmetic metadata record. Registry display metadata retains precedence; legacy/corrupt/mismatched records fall back to the prior ID display. Frozen model/systemPrompt/tools/permissions/skills/limits still come exclusively from the existing validated effective-agent snapshot.

RED: 2 FAIL. Worktree targeted GREEN: 120 PASS, typecheck exit 0. The browser driver adds an actual DOM + projection role-label check after process restart and includes both Core artifacts in its launch identity checks. Final clean-source gates remain pending for the new code.
