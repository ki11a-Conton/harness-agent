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

## Runtime Freeze (P38.4-11)

Runtime architecture is frozen.

Runtime changes after P38.4 require at least one of:

1. deterministic correctness bug with a reproducer;
2. security vulnerability;
3. release integrity defect;
4. benchmark failure proven to originate in Harness infrastructure rather than model/agent strategy;
5. measured performance regression attributable to Runtime.

Model-quality failures alone are not permission to rewrite Runtime.
They should first produce a challenger at the Agent strategy layer.

The default development loop is:

```text
benchmark -> failure cluster -> hypothesis -> challenger -> paired eval
```

This distinguishes **Runtime maintenance** (fixing a real defect above) from
**Agent evolution** (a challenger at the strategy layer, evaluated by a paired
benchmark). Never guess which one applies.