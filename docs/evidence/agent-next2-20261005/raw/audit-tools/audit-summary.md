# Production filesystem tool audit — baseline 320cf3e

Read-only audit; no tracked files changed. The exact source SHA is `320cf3e0bd87d714d17d95709e10c0ddf56d9c5d`. Both scripts invoke the built canonical production tool profile through `ToolRegistry -> ToolOrchestrator -> DeterministicPermissionEngine -> SandboxManager`; their wrappers observe native filesystem calls without replacing outcomes. Before/after Git identity and relevant source/build hashes match. No model/provider/connector calls occur.

## Recommended narrow fix: scoped search results are not usable tool paths

`tasks/P0/VS-001.md:46` says search_files returns workspace-relative POSIX paths; input paths resolve against `context.cwd`. `packages/tools/src/tools/search-files.ts:58,64` uses the selected traversal root for both glob matching and output. With `cwd=<workspace>`, `path=src`, `pattern=root.ts`, the tool returns `root.ts` for `src/root.ts`. Passing that returned result to read_file succeeds on `<workspace>/root.ts`, reading the wrong file. This is a deterministic correctness bug, not a model quality finding.

Exact baseline script: `baseline-probe.mjs`; stdout/stderr retained; `baseline-search-paths/result.json` contains all requests, results, native read/list operations, hashes and terminal summary. Fifteen cases ran: ten controls passed; five scoped output assertions failed. The failing cases cover relative scope, normalized relative alias, absolute scope alias, basename wrong-file read loop, and a session whose cwd is a nested workspace directory. The root-scope control is correct.

Minimal fix: retain `relative(selectedRoot, abs)` as the glob candidate, but append `relative(context.cwd, abs).split(sep).join('/')` as the returned tool path. Do not change traversal scope, ignores, symlink handling, permissions, schema, cap, ordering or error outcomes. Optional description clarification should explicitly say outputs resolve against the session cwd.

Acceptance must check actual search -> read closed loops and distinct root/scoped sentinels, rather than assert a copied implementation formula. Require relative and absolute/normalized scope aliases, nested cwd, selected-root-relative glob matching, basename matching, POSIX formatting, result cap, default root unchanged, ignored directories, existing descendant symlink no-follow, allowed selected subtree-only enumeration, permission/sandbox/schema rejection with zero enumeration, and missing/unreadable roots failing truthfully. Run related integration/security suites plus the root's frozen acceptance; no need to weaken runtime policy contracts.

## Separate proven defect, do not expand the narrow fix without preregistration

`tasks/P0/VS-001.md:25` declares read_file abort-aware, but `read-file.ts:34` calls fs.readFile without a signal and without excluding special files. Native FIFO reads block even after the caller aborts. `fifo-resource-probe.mjs` and `baseline-fifo/result.json` prove:

- A real FIFO times out at 62 ms for a 60 ms limit while one native read and one file lock entry remain active. A second read queues on the same lock and times out at 41 ms for a 40 ms limit. The pending read/lock clear only when a safe rescue writer runs at 350 ms.
- Caller cancellation at 20 ms on another real FIFO does not return until the rescue writer runs at 180 ms; result cancelled at 181 ms.
- A real regular file control succeeds in 1 ms and leaves zero lock entries.

All FIFO resources were deliberately unblocked and removed; no dangling worker remains. A robust fix requires regular-descriptor validation with nonblocking open, abort-aware actual read and reliable descriptor cleanup. A pre-read path stat alone has a race and cannot provide that boundary. This larger change should be separately scoped and preregistered if selected; it is not part of the proposed two-line search output repair.

## Existing compatibility contracts explicitly preserved

Do not change permissive read_file UTF-8 decoding: r4-file-regressions.test.ts already requires versioned reads of invalid UTF-8 to return the raw-byte hash/count with replacement-decoded content. Do not treat structured output bypass of process.maxOutputBytes as a new defect: orchestrator.ts explicitly states structured payloads retain their contract and are budgeted at the model-facing boundary. No hypothetical new output policy, binary rejection, scope policy or agent strategy has been proposed from this audit.
