# TASK: SKILL-EVO-001

## Goal

Implement the skill evolution pipeline in `packages/skills` per AGENT_ARCHITECTURE_PLAN v2.0 §70 (v1 → benchmark → v2 → compare → promote/rollback), §49 (Skill lifecycle: eligible/active/deprecated), §50 (evidence-driven skill evaluation), §48 (Skill rules).

## Why

Production skills must never be overwritten blindly (§70). A new skill body must first become a versioned candidate, be benchmarked head-to-head against the active skill (§133 BenchReport), and only be promoted when the evidence shows improvement without a safety regression. Rollback must be able to restore the previous active body and deprecate the failed candidate.

## Dependencies

- `@ar/contracts` — `Skill`/`SkillId`/`newSkillId`/`AgentError` (SKILL-001 types).
- `@ar/evaluation` — `BenchReport` type only (type-only import; no runtime coupling to the eval harness).

## Preconditions

- `packages/skills` exists with `FileSkillLoader` (SKILL-001), root tsconfig references it.
- `packages/evaluation` exists and exports `BenchReport` (BENCH-001).
- No third-party dependencies (node built-ins only).

## Scope

### Create

- `tasks/P7/SKILL-EVO-001.md` (this file)
- `packages/skills/src/skill-store.ts` — persistence surface for evolution
  - `SkillStoreLike`: `save(s: Skill): Promise<void>` (minimum), optional `update?` and `list?` capabilities
  - `JsonlSkillStore implements SkillStoreLike`: `dataDir/skills.jsonl`, one JSON `Skill` per line
  - `save` = upsert keyed by `Skill.id`; `update` replaces an existing record (unknown id throws `AgentError` `INTERNAL_ERROR`); `list` returns every record; `get(id)` returns one record or `undefined`
  - atomic mutations via temp file + rename (mirrors `JsonlMemoryStore`); corrupt lines skipped on read
- `packages/skills/src/skill-evolution.ts` — `SkillEvolver`
  - `createVersion(base: Skill, newBody: string, deps: { now?: () => number }): Skill`
    - new candidate record: fresh `SkillId` (lineage preserved via `path`, so v1 and v2 records can coexist in the id-keyed store — required for rollback to deprecate v2 while restoring v1)
    - `manifest.version` bumped from `headers.version ?? manifest.version`: parseable `x.y.z` → `(x+1).0.0` (e.g. `1.0.0` → `2.0.0`); missing/unparseable → `1.0.0` (covers the loader default `0.0.0`)
    - `status` kept from base, except terminal states (`deprecated`/`removed`) → `eligible`
    - `discoveredAt` from injected `now` (default `Date.now`)
  - `evaluate(deps: { v1: Skill; v2: Skill; bench: () => Promise<BenchReport>; threshold?: number }): Promise<{ decision: "promote" | "rollback" | "hold"; reason: string }>`
    - §70: benchmark first, then compare — never blind overwrite
    - safety regression (`b.safety < a.safety`, i.e. violations increased) → `rollback`, even when success improved
    - success delta beyond `threshold` (default 0) → `promote`; below `-threshold` → `rollback`
    - delta within threshold → winner-count tie-break (per-case `winner`), same margin; else `hold`
    - empty report → `hold`; benchmark throwing → `hold` with the error in the reason
  - `promote(base: Skill, v2: Skill, store: SkillStoreLike): Promise<Skill>`
    - lineage guard: `v2.path !== base.path` → throw `AgentError` `INTERNAL_ERROR`
    - saves `{ ...v2, status: "active" }`, returns it
  - `rollback(base: Skill, store: SkillStoreLike): Promise<Skill>`
    - restores `{ ...base, status: "active" }` via `save`
    - when the store supports `list` + `update`: every other record of the same skill (`path` match) is marked `deprecated` (v2 deprecation, "若 store 支持更新"); otherwise the deprecation is skipped (graceful degradation on minimal stores)
- `packages/skills/src/skill-evolution.test.ts` — 21 cases (see Tests)
- `packages/skills/src/index.ts` — export `SkillEvolver`, `JsonlSkillStore`, `SkillStoreLike`, types

### Modify

- `packages/skills/package.json` — add `@ar/evaluation` workspace dependency
- `packages/skills/tsconfig.json` — add `../evaluation` project reference

### Forbidden

- No bypass of the benchmark→compare gate (§70): nothing writes an active record except `promote`/`rollback`, and both are gated on evidence by the caller contract
- No third-party dependencies
- No changes to `@ar/contracts` (Skill shape is the contract, not redefined)
- No modifications to core/evaluation packages

## Contracts

Signatures above are the contract; `SkillStoreLike` is deliberately minimal (a store needs only `save` for the happy path).

## Security Invariants

- Safety regressions (increased violations) must never promote (§50 evidence-driven, §70 never blind overwrite).
- A benchmark failure must never fake a verdict — it degrades to `hold` with the error surfaced.
- `rollback` preserves the previous active body; the failed candidate is marked `deprecated`, never deleted.

## Tests

- Version bump: `1.0.0`→`2.0.0`, loader default `0.0.0`→`1.0.0`, headers precedence, status kept / terminal→eligible, fresh id + injected clock
- Evaluate: promote (better success, no safety regression), rollback (worse success), hold (equivalent), hold on thrown benchmark (reason contains error), hold on empty report, rollback on safety regression despite success gain, winner-count tie-break promote, threshold gating
- Promote/rollback against a real `JsonlSkillStore` in a temp dir: active + body after promote; rollback restores v1 active and deprecates v2; save-only store degrades gracefully; lineage guard rejects foreign versions
- Store: upsert idempotency, update replaces/throws on unknown id, persistence across instances, corrupt-line skip, missing file → empty

## Acceptance Criteria

- `pnpm typecheck` passes (root)
- `pnpm vitest run packages/skills` passes
- `pnpm test` (full suite) passes — no regressions

## Definition of Done

- [ ] Implementation exists
- [ ] Tests exist and pass (21 cases)
- [ ] Security implications checked (benchmark gate, safety regression, no blind overwrite)
- [ ] Evidence: typecheck + test output
