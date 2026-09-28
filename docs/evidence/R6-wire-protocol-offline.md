# R6 — tool-protocol validation at the real request boundary (F7, offline reproduction)

Baseline: `a85db6dcf1004ef1159f62bc0a11de53247a296c` (main HEAD before this task).
Code commit: `13c00e0b476aab1a55b897d8427ef68bc2b8154c` (branch `e4/r6-protocol`).
Worktree: `C:\Users\MECHREV\AppData\Local\Temp\r-wave1-r6` (isolated; the main checkout was never edited).
Platform: Windows 10 / Node `v24.14.0` / vitest 4.1.10 / pnpm workspace.

**LOCAL STUB ONLY.** No relay, no paid provider, no model selection, zero real credentials. The only
network traffic is `127.0.0.1` against an in-process `node:http` stub. The stub key is the literal
throwaway string `sk-local-stub-not-a-real-credential`.

---

## 1. Start/end SHA, files, responsibility changes

| item | value |
|---|---|
| start SHA | `a85db6dcf1004ef1159f62bc0a11de53247a296c` |
| code commit SHA (source + tests) | `13c00e0b476aab1a55b897d8427ef68bc2b8154c` |
| branch | `e4/r6-protocol` |
| tree state at code commit | only the 11 files below; `plan(20260928-105425).md` is untracked in the MAIN checkout and was not touched |

Modified:
- `packages/contracts/src/message-protocol.ts` — unified, complete wire-legality validator; `isToolProtocolValid`/`assertToolProtocol` now delegate to it; `dropOrphanToolResults` repairs only a provably safe leading prefix.
- `packages/model/src/openai.ts` — validates the SERIALIZED body immediately before `fetch`; fails closed locally; attaches the diagnostic bundle to real provider errors; `toOpenAiTool`'s P2-43 failure now carries `provider.kind = "protocol"`.
- `packages/core/src/runtime/turn-helpers.ts` — `decideModelRetry` fails immediately (no retry) for a local protocol refusal.
- `packages/core/src/runtime/turn-helpers.protocol.test.ts` — extended (retry-decision regression).

Added:
- `packages/contracts/src/message-protocol.wire-gap.test.ts` (RED reproducer, baseline API only)
- `packages/contracts/src/message-protocol.wire.test.ts` (complete valid/invalid table)
- `packages/model/src/provider-diagnostics.ts` + `provider-diagnostics.test.ts`
- `packages/model/src/openai.wire-stub.test.ts` (node:http strict stub)
- `packages/core/src/runtime/wire-protocol-e2e.test.ts` (runtime → real provider → strict stub)

Responsibility changes (Runtime Freeze P38.4-11): one deterministic correctness defect with a
reproducer — the helpers named "valid/assert tool protocol" did **not** assert wire legality. The
runtime change is two guarded branches (`dropOrphanToolResults` prefix-only; `decideModelRetry`
no-retry for `provider.kind === "protocol"`); no architecture change, no new side-effect path, and
`ToolOrchestrator`/`PermissionEngine`/`SandboxManager`/`Verification` were not bypassed.

## 2. F-number covered; OLD (RED) target assertion vs NEW (GREEN)

**F7** (P1 / 待行为复验) — `isToolProtocolValid` / `assertToolProtocol` were treated as a protocol
guarantee while only checking MISSING results.

RED target assertion (`packages/contracts/src/message-protocol.wire-gap.test.ts`, run against the
UNMODIFIED baseline source; the file uses only pre-existing exports so it fails on its assertion, not
on an import):

```
expect(isToolProtocolValid([user, tool(call_orphan)]))       .toBe(false)  → RED: received true
expect(isToolProtocolValid([assistant[a], tool(a), tool(a)])) .toBe(false)  → RED: received true
expect(isToolProtocolValid([assistant[a,b], tool(a), tool(b), tool(c)]))     → RED: received true
expect(isToolProtocolValid([assistant[a,a], tool(a)]))        .toBe(false)  → RED: received true
```

Observed RED (baseline source):

```
$ pnpm exec vitest run packages/contracts/src/message-protocol.wire-gap.test.ts
 ❯ packages/contracts/src/message-protocol.wire-gap.test.ts (8 tests | 4 failed)
 Test Files  1 failed (1)
      Tests  4 failed | 4 passed (8)
[exit code: 1]
```

The 4 passing controls at baseline are the shapes the old helper DID catch (`assistant[a,b]` + only
`a`; inserted `system`; complete two-result block; explicit not-executed results).

GREEN (after the change, same file — it was NOT modified between the two runs):

```
$ pnpm exec vitest run packages/contracts/src/message-protocol.wire-gap.test.ts
 ✓ packages/contracts/src/message-protocol.wire-gap.test.ts (8 tests)
 Test Files  1 passed (1)
      Tests  8 passed (8)
[exit code: 0]
```

The unified check now returns a distinct, machine-readable code per shape:
`orphan_tool_result`, `missing_tool_result`, `duplicate_tool_result`, `unexpected_tool_result`,
`duplicate_tool_call_id`, `interleaved_message`, `tool_result_without_id`,
`invalid_tool_call_name`.

## 3. Literal commands, exit codes, counts

**Windows-local (RUN).** Ubuntu/GitHub-Actions: **NOT RUN** (no CI dispatch from this task).

| # | literal command (from the worktree root) | exit | result |
|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile --prefer-offline` | 0 | install ok |
| 2 | `pnpm exec vitest run packages/contracts/src/message-protocol.wire-gap.test.ts` **(baseline source)** | 1 | Test Files 1 failed (1); Tests **4 failed \| 4 passed (8)** — the RED record |
| 3 | `pnpm exec vitest run packages/contracts/src/message-protocol.wire-gap.test.ts packages/contracts/src/message-protocol.test.ts packages/core/src/runtime/turn-helpers.protocol.test.ts` | 0 | 3 files passed; **19 passed** |
| 4 | `pnpm exec vitest run packages/model/src/openai.wire-stub.test.ts packages/model/src/openai.test.ts` | 0 | 2 files passed; **62 passed** |
| 5 | `pnpm exec vitest run packages/core/src/runtime/wire-protocol-e2e.test.ts` | 0 | 1 file passed; **8 passed** |
| 6 | `pnpm exec vitest run <11 targeted files>` (see below) | 0 | 11 files passed; **245 passed, 0 failed, 0 skipped** |
| 7 | `pnpm typecheck` (`tsc -b`) | 0 | first run: 289 pre-existing `TS6305`/`TS7006` errors from unbuilt project-reference outputs in `apps/*`; after that build completed, a re-run reported **0 error lines**, exit 0. The only errors attributable to this task (2 × `AskUserStore.markWithdrawn`) were fixed; no error remains in any file this task touched. |

Command 6 file list (all repo-relative):
`packages/contracts/src/message-protocol.test.ts`,
`packages/contracts/src/message-protocol.wire.test.ts`,
`packages/contracts/src/message-protocol.wire-gap.test.ts`,
`packages/contracts/src/tool-name.test.ts`,
`packages/model/src/openai.test.ts`,
`packages/model/src/openai.wire-stub.test.ts`,
`packages/model/src/provider-diagnostics.test.ts`,
`packages/core/src/runtime/wire-protocol-e2e.test.ts`,
`packages/core/src/runtime/turn-helpers.protocol.test.ts`,
`packages/core/src/runtime/runtime.test.ts`,
`packages/tools/src/orchestrator.test.ts`.

The full `pnpm test` was **NOT run** (a second Vitest pass clobbers the fixed
`E2E_OBSERVATION_RUN_ID` evidence), per the task rules.

P2-41 / P2-43 regression coverage kept intact and strengthened: `runtime.test.ts` (83 tests, calls
`assertToolProtocol` on real transcripts) and `openai.test.ts` (40 tests, the P2-43 fail-closed case)
both pass unchanged; `tool-name.test.ts` and `orchestrator.test.ts` pass unchanged.

## 4. Provider factory calls, physical HTTP, tool counts, dispatches, journal, verifier

| measurement | observed value |
|---|---|
| provider factory calls (`createClient`) | **NOT_OBSERVED** — not instrumented; the runtime calls it once per model call and the request count below is the observable proxy |
| physical HTTP requests, legal flows | `e2e-normal` **2** (asserted), `e2e-parallel` **2** (asserted), `e2e-resume` **2 then 1** (asserted), `e2e-cancel` **1** (all bodies legal; exact count not asserted), `e2e-ask-user` **1 parked** (asserted) then **≥1 resumed**, `e2e-stall-recovery` **≥4** (asserted as ≥4), `e2e-trim` all bodies legal (exact count not asserted) |
| physical HTTP requests, wire-illegal views | **0** — asserted per case in `openai.wire-stub.test.ts` (`invalid-01`…`invalid-08`, `name-04`…`name-08`) and end-to-end in `e2e-corrupt-transcript` (`expect(stub.requests).toHaveLength(0)`) |
| real provider error bundle | stub answered HTTP 400 with the relay's `{"code":11148,...}` body; the error event carried `provider {kind:"http", status:400}` plus a bundle with `toolCallIdCorrelation`, `status:400`, `reason:"http_status"` — asserted content-free (no key, no user text, no tool output) |
| model-declared tool count | **NOT_OBSERVED** — the strict stub is the provider; it declares no tool catalog |
| actual tool dispatches | observed via `FakeOrchestrator`: `e2e-normal` **1** (`read_file`), `e2e-parallel` **2** (`read_file` ×2), `e2e-cancel` **1** |
| journal numbers (ledger/journal ids) | **NOT_OBSERVED** — no journal/ledger numbering is asserted by this task |
| verifier strength | **wire-level and physical**: every scenario parses the raw serialized body the stub received and asserts (a) `findSerializedWireIssues(...) === []`, (b) each assistant `tool_calls` block is followed by exactly its ids, contiguous and in order, (c) every `tool` message directly follows its block, and (d) the physical request count (0 for refusals). No assertion is "a function was called" |

## 5. What remains NOT_OBSERVED / BLOCKED

1. **Real-world verification of 11148 — PENDING.** No relay or paid provider was contacted, so the
   hypothesis in `E4-N8-paid-run-executed.md` §2 stays a hypothesis. What changed is that the next
   occurrence is no longer undiagnosable: a real HTTP 400 now carries the redaction-safe bundle.
2. **Ubuntu / GitHub-Actions run** — NOT RUN. Every number above is Windows-local only.
3. **Model-declared tool count and journal numbers** — NOT_OBSERVED (see §4).
4. **MCP naming** — no mapping was introduced. The name used on the wire is the binding name
   verbatim (identity mapping: reversible by construction, collision-free by construction), gated by
   `TOOL_NAME_PATTERN` at registration (`packages/tools/src/registry.ts`) and at advertisement
   (P2-43). Covered cases: legal names, dots, empty name, 64/65-character boundary, Unicode, newline.
5. **`e2e-trim` depth** — the trim path fired (`context.compacted` observed) and no body contained an
   orphan result, but how many messages the trim actually dropped in that configuration is
   NOT_OBSERVED.
6. **Model quality / benchmark cost** — out of scope and untouched: no model was selected, no
   benchmark started, no USD figure is claimed.
