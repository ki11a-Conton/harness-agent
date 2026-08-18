# TASK: MEMORY-001

## Goal

Create the `packages/memory` package: a JSONL-backed `MemoryStore` implementation and the §67 memory write gate, per AGENT_ARCHITECTURE_PLAN v2.0 §65–§67, §80, §146.

## Why

Memory must be persisted, reviewable, and deletable (§67), and must not be written unconditionally (write gate, §67). RAG/vector retrieval is deferred (§65 — Phase 3 semantic retrieval is not required for the initial runtime). Memory is learned/probabilistic/mutable and must never silently override authoritative architecture (§146).

## Dependencies

- `@ar/contracts` (provides `MemoryEntry`/`MemoryStore`/`MemoryCandidate`/`MemoryId`/`newMemoryId`, §66)

## Preconditions

- Workspace scaffolded (pnpm + TS + vitest), `packages/contracts` present (CONTRACT-001).
- No third-party runtime dependencies (node built-ins only).

## Scope

### Create

- `tasks/P7/MEMORY-001.md` (this file)
- `packages/memory/package.json`
- `packages/memory/tsconfig.json`
- `packages/memory/src/memory-store.ts` — `JsonlMemoryStore implements MemoryStore`
  - `dataDir/memories.jsonl`, one JSON `MemoryEntry` per line
  - `write` (upsert by id), `get`, `search`, `list`, `update` (unknown id throws), `remove` (soft delete: `deleted: true` + `updatedAt` bump)
  - `search`: case-insensitive substring OR token matching (no vector retrieval, §65); excludes deleted; optional `type` filter
  - `list({ deleted })`: default excludes deleted; `deleted: true` returns only deleted
  - all mutations atomic: rewrite whole file via temp file + rename; corrupt lines are skipped on read (best-effort recovery)
  - errors use contracts `AgentError`/`errorInfo` (`INTERNAL_ERROR`)
- `packages/memory/src/write-gate.ts` — §67 write gate
  - `evaluateCandidate(c: MemoryCandidate, policy?: MemoryWritePolicy): { allowed: boolean; reason: string }`
  - `MemoryWritePolicy`: `minImportance` (default 0.6), `minNovelty` (default 0.4), `episodicMinImportance` (default 0.8)
  - episodic candidates require the higher importance bar
  - no batch/unlimited auto-write API exists: every persistence flow must pass a candidate through the gate first
- `packages/memory/src/index.ts` — exports store, gate, policy type/constant, and the contracts memory types
- `packages/memory/src/memory-store.test.ts` — 10+ cases
- `packages/memory/src/write-gate.test.ts` — 7+ cases

### Modify

- `tsconfig.json` (root references: add `./packages/memory`)

### Forbidden

- No vector/RAG retrieval (§65 deferred)
- No third-party dependencies
- No hard delete of entries (§67 deletable via soft-delete marker)
- No write path that bypasses the candidate gate contract (no bulk auto-write API)

## Contracts

`MemoryStore`/`MemoryEntry`/`MemoryCandidate` from `packages/contracts/src/memory.ts` (§66) — the package implements the interface, it does not redefine it.

## Security Invariants

- Memory writes must be reviewable and deletable (§67) — soft delete keeps provenance.
- No unlimited automatic persistence: the gate is the only path from candidate to store.
- Corruption in the JSONL must never fail the store wholesale (skip line, keep reading).

## Tests

- Store: write/read roundtrip, update, soft delete visibility (get/list/search), search hits/misses, case-insensitivity, token vs substring matching, type filter, persistence across store instances, corrupt-line skip, no leftover temp files after atomic writes, unknown-id errors.
- Gate: high/low importance, low novelty, episodic threshold, custom policy, boundary values (0.6/0.4/0.8 inclusive).

## Acceptance Criteria

- `pnpm typecheck` passes (root, package added to references)
- `pnpm vitest run packages/memory` passes

## Definition of Done

- [ ] Implementation exists
- [ ] Tests exist and pass
- [ ] Security implications checked (write gate, soft delete, no auto-write)
- [ ] Evidence: typecheck + test output
