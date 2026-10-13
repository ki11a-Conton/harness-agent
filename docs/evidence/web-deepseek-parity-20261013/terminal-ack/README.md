# 7ba9eee CI failures and terminal inbox acknowledgement correction

Original source: `7ba9eee0daedb6f0ae02a8cd0892a93e62677286`. Main CI run `38348315036` failed. Coverage failed on the same premature ask-answer test, not a coverage-threshold failure; thresholds remain unchanged. Original artifact byte hashes and bounded failure excerpts were read by diagnostic run `38385407389` without rerunning/reclassifying the source.

The new Core counterexample pauses the actual InboxStore `markConsumed` acknowledgement after a completed model turn. Before the fix, actor `close()` and a concurrent `close()` both returned while that durable write was outstanding: 1 FAIL. This is a deterministic lifecycle correctness defect qualifying under the Runtime freeze rule.

The fix retains terminal followup/recovered-prompt acknowledgement promises, drains them before releasing the actor scope, and shares one close promise. Native owner/Runtime interfaces, permissions and queue admission semantics remain unchanged. Web activity test teardown also closes its actual session service. The Web close regression now waits for the persisted turn to enter `waiting_for_user`; a pending ask record alone does not prove that state transition completed.

Targeted worktree validation: Core actor + Web session + Web activity 113 PASS; typecheck exit 0. This is not final clean-source acceptance. Earlier official UI receipts still prove only the named controls on 7ba9eee (same Linux/Windows archive SHA256 `7ab11e53ca0bb32da0c5cdcefe3df5f074d6ecf40582d3373f8197c47befee43`, 30 cases/75 assertions each); they do not make its failed main CI green.
