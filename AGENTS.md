# Agent Runtime Development Rules

## Read First

Read the relevant task file under `tasks/`.

## Architecture

Core must not depend on UI, providers, business plugins, or external integrations.

All side effects go through ToolOrchestrator.

All side effects are subject to PermissionEngine and SandboxManager.

## Testing

Run:

- unit tests
- integration tests
- relevant security tests

Commands:

- `pnpm typecheck` — tsc -b across all packages
- `pnpm test` — vitest run

## Completion

A task is complete only when its acceptance criteria pass and evidence is reported.

## Forbidden

Do not bypass:

- ToolOrchestrator
- PermissionEngine
- SandboxManager
- Verification

Do not modify unrelated modules.

## Conflict

If task requirements conflict with architecture contracts, stop and report the conflict.