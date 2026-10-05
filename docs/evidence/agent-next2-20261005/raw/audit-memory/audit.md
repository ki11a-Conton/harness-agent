# Read-only memory feedback audit (2026-10-05)

Baseline main: `320cf3e0bd87d714d17d95709e10c0ddf56d9c5d`.
No tracked source edits, no paid/live model request, no full-suite or heavyweight benchmark.

## Deterministic correctness defect

`MemoryRuntimeBridge.applyFeedback()` reads a full memory snapshot, applies the pure usefulness transform, then calls `MemoryStore.update()` with the full stale entry. Backend individual mutation locks/transactions do not protect this higher-level read-modify-write cycle.

Production-built `reproduce.mjs` directly invokes both concrete stores and bridge. `baseline.json` records source/dist hashes and all ten cases, stdout/stderr preserved:

- Both backends: eight native concurrent `recordInjected()` calls yield `injectedCount=1`, expected 8. No mock scheduler/hook needed.
- Both backends: a deterministic wrapper schedules a real store.remove after a real store.get captured its snapshot but before the real store.update. Feedback rewrites `deleted=false` and retrieves the deleted memory again (1 item, expected 0).
- Both backends: analogous real editor update of content and lifecycle `deprecated` state is overwritten by feedback; old content and absent active-state marker return.
- Sequential feedback control and delete-before-read control pass on both backends.

Actual built `createHarness` in `harness-reproduce.mjs` runs four concurrent sessions through ordinary pre-turn memory admission and successful offline-model turns. `harness-baseline.json` retains evidence:

- JSONL: 4 completed turns, 4 model requests containing the memory, 4 memory.retrieved events; durable counters retrieved=2 / injected=1 / used=2 / taskSuccess=1, expected 4 each.
- SQLite: all four counters 4 in this incidental Harness schedule. This is a positive control; the separate no-hook direct concurrent bridge reproduction proves SQLite susceptibility too.

## Narrow implementation proposal

Only three production files are needed:

1. `packages/memory/src/memory-store.ts`: add concrete public `recordUsefulnessFeedback(id, feedback): Promise<boolean>`. Under the EXISTING same-store withLock, read the latest whole file, skip unknown/deleted entries, derive usefulness from that latest entry, run unchanged security gate, rewrite atomically. Keep latest content/state/provenance/updatedAt untouched.
2. `packages/memory/src/sqlite-memory-store.ts`: same method; `BEGIN IMMEDIATE`, SELECT latest persisted row, skip unknown/deleted, derive usefulness, unchanged security gate, UPDATE ONLY usefulness column, COMMIT. Do not call write/update (which replace the entire row and rebuild FTS). Rollback on failures. No schema migration/new field.
3. `packages/harness/src/memory-runtime-bridge.ts`: duck-type optional atomic capability; use it for persistent feedback, preserving the existing observed best-effort exception isolation. Existing MemoryStore interface, Core, turn admission/default flags/scoring/strategy untouched.

Custom legacy MemoryStore implementations have no atomic compare-and-mutate capability. A bridge mutex or repeated get cannot safely protect against independent edits/removal. The recommended honest safe fallback is to skip durable feedback and emit one fixed degraded diagnostic per bridge, while preserving retrieval, model admission, turn outcome, and actual admission ROI bookkeeping. Document that external implementations can opt into the optional method to get durable feedback. Do not claim atomicity for stores without this capability.

## Acceptance controls

- Formal before-fix RED tests on both backends for 8-call concurrency and supported-store concurrent delete/edit scheduling.
- All five feedback kinds preserve pure rolling-score semantics and exact counters under same-entry/multiple-entry concurrency, multiple bridge instances, and two store instances for same path.
- Deleted/unknown row no-op; historical tombstone remains reviewable and absent from search/retrieve; retired user state/content/provenance/evidence/confidence/updatedAt survive late feedback.
- Existing security gate remains authoritative on atomic path, failed write rolls back without partially changing entry, a later valid feedback still succeeds.
- SQLite observation proves feedback changes usefulness only and does not rebuild FTS; search results/ranking unaffected before/after feedback.
- Legacy external store lacks capability: no get/update invoked by feedback, fixed once-only diagnosis, successful model turn and memory admission still work, ROI reflects actual admitted blocks. Explicit throwing capability failure remains observed without breaking turn.
- Actual createHarness four concurrent sessions, both persistent backends, all expected feedback counters four, matching four model-visible admissions and events.
- No default memory enabling, model-quality/champion/promotion claim; JSONL original single-writer/interprocess caveat remains unchanged.
