# TASK: CONTRACT-001

## Goal

Create the stable shared interface package `packages/contracts` per AGENT_ARCHITECTURE_PLAN v2.0 §9–§44.

## Why

Every other subsystem (core, model, tools, security, execution, session, …) must depend only on these contracts. Contracts are the freeze point of the architecture.

## Dependencies

None (built first, per build order `01 contracts`).

## Preconditions

Workspace scaffolded (pnpm + TS + vitest), root AGENTS.md present.

## Scope

### Create

- `packages/contracts/package.json`
- `packages/contracts/tsconfig.json`
- `packages/contracts/src/ids.ts` — opaque branded IDs (§10)
- `packages/contracts/src/errors.ts` — failure taxonomy + retry safety (§44)
- `packages/contracts/src/model.ts` — ModelProvider/ModelClient/ModelEvent (§11)
- `packages/contracts/src/message.ts` — Message model
- `packages/contracts/src/tool.ts` — ToolDefinition/ToolResult/ToolSpec (§12–§13)
- `packages/contracts/src/agent.ts` — AgentDefinition (§23)
- `packages/contracts/src/session.ts` — Session/Turn/SessionStore (§26–§27)
- `packages/contracts/src/event.ts` — AgentEvent/EventStore (§29–§31)
- `packages/contracts/src/permission.ts` — PermissionEngine (§15–§17)
- `packages/contracts/src/approval.ts` — ApprovalRequest/ApprovalResolver (§18)
- `packages/contracts/src/sandbox.ts` — SandboxPolicy (§19)
- `packages/contracts/src/skill.ts` — Skill/Manifest/Stats (§47–§50)
- `packages/contracts/src/memory.ts` — MemoryCandidate/MemoryStore (§65–§67)
- `packages/contracts/src/verification.ts` — Evidence/Verifier/TaskSpec (§41–§43)
- `packages/contracts/src/limits.ts` — RunLimits/DelegationLimits/ContextBudget (§36, §40, §55)
- `packages/contracts/src/context.ts` — ContextBlock/Provenance/CompactionSummary (§32–§38)
- `packages/contracts/src/index.ts`
- `packages/contracts/src/contracts.test.ts`
- `tasks/P0/CONTRACT-001.md` (this file)

### Modify

- `tsconfig.json` (root references)

### Forbidden

- No runtime logic beyond IDs and error-catalog constants
- No provider imports, no UI imports, no `node:fs`-based side effects
- No circular imports between contract files

## Contracts

See the file list above; types are the contract.

## Security Invariants

- Retry safety table (§46) must be present in contracts so policy can rely on it.

## Tests

- ID prefix/collision
- Error retry defaults
- No forbidden imports (purity guard)
- No circular relative imports

## Acceptance Criteria

- `pnpm typecheck` passes
- `pnpm test` (contracts) passes
- contracts compile independently (no other packages exist yet)

## Definition of Done

- [ ] Implementation exists
- [ ] Tests exist and pass
- [ ] Security implications checked (retry table)
- [ ] Evidence: typecheck + test output
