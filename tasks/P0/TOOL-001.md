# TASK: TOOL-001 (TOOL-002 covered)

## Goal

Implement the tool execution pipeline in `packages/tools`: ToolRegistry (describe-only, TOOL-001) and ToolOrchestrator (12-step mandatory pipeline, TOOL-002 / INV-001 / INV-002), plus the first filesystem tool `read_file`.

## Why

Every side effect in the runtime must pass: resolve → validate → normalize → risk → permission → approval → sandbox → execute → timeout/output limits → evidence → events → normalize. No step may be skipped.

## Dependencies

CONTRACT-001, SEC-001 (DeterministicPermissionEngine, SandboxManager, InMemoryApprovalStore/StoreApprovalResolver).

## Scope

### Create

- `packages/tools/package.json`, `tsconfig.json` (deps: @ar/contracts, @ar/security, zod, zod-to-json-schema)
- `packages/tools/src/registry.ts` — ToolRegistry: register/unregister/get/has/list/names/specs (zodToJsonSchema); rejects duplicates and metadata.name mismatch
- `packages/tools/src/orchestrator.ts` — ToolOrchestrator: full pipeline; fail-closed on ask-without-resolver; timeout via AbortController race; output truncation; evidence for file/command/network; events `tool.started` / `tool.completed` / `tool.failed` / `tool.permission_requested` / `tool.permission_resolved` / `approval.created` / `approval.resolved`
- `packages/tools/src/tools/read-file.ts` — read_file (filesystem read, VS-001 seed)
- `packages/tools/src/orchestrator.test.ts` — registry + pipeline tests

### Modify

- `packages/core/src/runtime/runtime.ts` — AgentRuntimeDeps gains `sandboxPolicy`; executeToolCall now passes `permissions` (from agent definition) and `sandboxPolicy` (default: workspace-write, network deny, bounded process) into ToolExecutionContext
- `tsconfig.json` — add `packages/tools` reference

## Contract Notes

- Tool-returned failures surface as `tool.completed` with `status: "failed"`; orchestrator-level failures (schema/permission/approval/sandbox/timeout/internal) surface as `tool.failed`.
- Denied outcomes map to result status `"denied"` (PERMISSION_DENIED / SANDBOX_DENIED / APPROVAL_DENIED).

## Acceptance Criteria

- All pipeline steps are exercised by tests: unknown tool, schema reject, permission deny, sandbox deny (path outside workspace, command not in allowlist), approval allow/deny/cancel/fail-closed, timeout, output cap, tool exception, evidence capture, events.
- Core typecheck passes with the new ToolExecutionContext fields.

## Definition of Done

- [ ] `pnpm typecheck` green
- [ ] `pnpm test` green (87 tests total)
- [ ] Main-agent review done
