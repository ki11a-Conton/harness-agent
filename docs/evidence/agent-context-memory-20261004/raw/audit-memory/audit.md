# Memory search audit, 2026-10-04

Read-only source audit; only this ignored evidence directory was written. Baseline source HEAD `17aa6c7471faf8bdec020b45bfe7b9bb45470131`; the baseline JSON records SHA-256 of the actual imported build and its source files. Sources were unchanged, and the existing build was newer than the relevant memory source. No remote or paid provider calls were made. The provider is an explicitly scripted local client; its captured requests went through the real `createHarness` / `MemoryRuntimeBridge` / Runtime context pipeline.

## Contract and freeze exception

`AGENTS.md` permits Runtime maintenance for a "deterministic correctness bug with a reproducer". `tasks/P7/MEMORY-001.md` requires "case-insensitive substring OR token matching", soft-delete filtering, optional type filter, and forbids vector/RAG dependencies. The prior completed evidence report explicitly deferred Chinese FTS. This probe reproduces substring omissions even for English; it is a backend contract failure independent of model strategy or model quality.

The persisted structured strategy is existing contract data. The bridge renders `When`, `Do`, and `Avoid` instead of `content`, but both stores search only `content`. A legitimate query whose term is solely in the rendered strategy yields no entry, no memory reference, and no model-visible block. This is a deterministic disconnect between retrieval and existing model-visible memory data, not a justification to redesign Core.

## Measured baseline

`baseline.json` contains 30 isolated store cases: 21 pass and 9 fail. The 9 failures are JSONL structured when/do/avoid and SQLite English substring, Chinese substring, mixed substring, and structured when/do/avoid. Both stores retain the controls: full English token hit, English miss, Chinese miss, deleted exclusion, type filter, exact scope filter, owner session hit, foreign session suppression, and inactive suppression.

12 full Harness cases produce 12 actual scripted generate requests: 6 pass and 6 fail. JSONL Chinese/mixed content is injected correctly; SQLite has no body or memory reference for the same queries. Both backends omit structured When/Do-only queries. All turns are completed and all providers emit exactly one request. The six omissions have no usefulness injection counter, matching the captured request rather than merely a search API assertion.

Additional positive-FTS control: store an exact Chinese-token entry `端口配置` and a Chinese-substring entry `调试端口配置时先检查环境变量。`; query `端口配置`. JSONL returns both. SQLite returns only the exact token. Therefore changing fallback to run only when FTS returns zero rows will leave a proven omission when FTS already has a valid hit.

## Root causes and minimum repair

1. SQLite `search` uses unicode61 FTS token matching, runs LIKE only on exceptions, and accepts a successful empty or partial result as complete. Supplement FTS-ranked candidates with literal case-insensitive substring hits, deduplicate by memory id, and preserve existing FTS ranking of genuine FTS hits. Use parameters and a literal substring operation such as `instr`, or escape LIKE metacharacters `%` and `_`; a user query must not become a wildcard query. Run the supplement when FTS has positive hits too.
2. Centralize lexical search text as existing `content` plus valid structured `when`, `do`, and `avoid`. Do not search evidence refs, provenance, confidence, rootCause/outcome, labels, or arbitrary metadata; they are not the advisory body. JSONL can reuse its current substring/token matcher over that text. SQLite can supplement on these three persisted JSON fields without a new vector index or schema redesign. Use valid-JSON guards for SQL JSON extraction, and keep malformed metadata fail-closed via the existing decoder. A schema-index alternative is larger and requires migration, update, reopen, and JSONL-import backfill acceptance; it is unnecessary for the demonstrated small repair.
3. Preserve the shared unsafe-content check, lifecycle gate, trusted session identity, soft deletion, type/exact-scope search filters, ranking components, and Top-K. Do not broaden memory scope, persist retrieved memory, change provider requests, bypass ToolOrchestrator, or touch Core.
4. Keep runtime candidate count explicitly bounded. The current `MemoryStore.search` contract has no limit and both stores can return all hits; Top-K bounds model output but not the candidate population. If adding an optional limit for production retrieval, retain backward-compatible behavior for callers that omit it, validate finite positive bounded values, cap both FTS and supplement at the database before mapping, deduplicate, and avoid a global `store.list()` fallback. JSONL already reads its JSONL file and should bound matching candidates rather than introduce another whole-store read. A mandatory silent truncation for existing `search` callers would be an unrelated contract change. The root plan should state the chosen production cap and ordering and include a large-population cap control.

## Preregistered acceptance proposal for the root plan

- Replay this exact baseline specification: store cases 30/30, model request cases 12/12, positive-FTS supplement 2/2 backends. This yields 9 corrected store misses and 6 corrected real request omissions; miss and exclusion controls stay unchanged.
- Extend controls for literal `%`/`_`, whitespace/empty query, Unicode case matching, updated/removed lesson terms, structured Avoid real request, malformed metadata/state, and reopen/migration if the implementation affects the persisted search representation.
- Search only the rendered strategy fields plus content; references, provenance, rootCause/outcome and fake labels cannot create hits. Preserve prior hostile structured write/read controls and all inactive/session exclusions.
- For the explicitly chosen production candidate cap, use more than the cap of actual matching rows and prove bounded store candidates, bounded Top-K output, unique ids, and deterministic order. Document truncation behavior; do not claim unbounded complete recall from a bounded candidate set.
- Run package memory tests, bridge/Harness integration and relevant security tests, then root typecheck/build and required acceptance checks. Keep exact source/probe hashes and captured original requests. Paid calls and real-model quality remain `0` / `NOT_RUN`.

This audit proposes a targeted maintenance patch. It does not modify source/tests, claim model-quality improvement, or assess unrelated memory feedback concurrency and bridge.close deferred defects.
