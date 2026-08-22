# Harness Agent v5 — Codex-Grade Runtime Semantics & Service Boundary Plan

> Repository: `ki11a-Conton/harness-agent`  
> Target branch assumption: current `main` as reviewed on 2026-08-22  
> Previous plan: P14–P22 are treated as completed unless source-level verification below explicitly identifies a semantic gap.  
> This plan starts at **P23** and MUST NOT re-implement completed work under a new name.
>
> Primary reference:
>
> - current `harness-agent` source
> - the 2026-08-21 Codex/Symphony harness source analysis
> - OpenAI Codex architecture patterns: Session → TurnContext → StepContext, frozen tool router, thread lifecycle, App Server, ThreadStore/config/MCP patterns
> - OpenAI Symphony reconciliation model
>
> Mission:
>
> **Move `harness-agent` from a feature-rich, strongly tested Agent Runtime to a semantically closed, service-grade Agent Harness where every model action is bound to the exact world snapshot that produced it, every session has a single authoritative execution owner, every side effect has a durable causal record, and every UI/SDK client uses one stable protocol boundary.**

---

# 0. READ THIS BEFORE WRITING CODE

You are the coding agent implementing this plan.

Do **not** begin by adding files.

First inspect the current repository and verify every assumption in this plan against the current branch.

The source code is authoritative.

A task is not DONE because:

- an interface exists;
- a unit test directly constructs a helper;
- an event contains a field;
- a feature exists behind an unused adapter;
- a method is exported;
- a capability matrix says `implemented`;
- a previous plan says `DONE`;
- a fake test demonstrates the idea.

A task is DONE only when its required **production path** is wired, its semantic invariant is tested, and the full relevant test suite passes.

---

# 1. NON-NEGOTIABLE EXECUTION RULES

## Rule 1 — Preserve the capabilities that are already stronger than a basic Codex clone

Do NOT remove or weaken the existing:

- side-effect intent persistence;
- checkpointing;
- tool execution ledger;
- crash reconciliation;
- fault injection;
- verification gates;
- false-complete grading;
- adaptive/bounded recovery;
- unsafe-tool no-retry invariant;
- ask-user durable suspension;
- run/tree budgets;
- resource conflict semantics;
- output/artifact budgets;
- memory/learning pipeline;
- independent reviewer isolation;
- delegation/workspace isolation;
- usage accounting;
- trace tree;
- champion promotion gates.

Codex is a reference for architectural boundaries, **not a request to replace working reliability mechanisms**.

---

## Rule 2 — No parallel implementation

If an existing primitive can be evolved, evolve it.

Bad:

```text
ToolRegistry
ToolRegistryV2
CodexToolRegistry
FrozenRegistry
```

Good:

```text
ToolRegistry = mutable catalog
StepToolRouter = immutable execution snapshot built from the catalog
```

Bad:

```text
EventStore
JournalStore
SemanticEventStore
RuntimeJournalStore
```

if all four become competing sources of truth.

Prefer one canonical durable trail with explicit projections/fences.

---

## Rule 3 — Production wiring before status updates

For every task:

1. add/modify contracts;
2. wire production composition root;
3. wire runtime call path;
4. add unit tests;
5. add integration/invariant tests;
6. run package-local tests;
7. run full typecheck;
8. run full tests;
9. run build;
10. only then mark the task DONE.

---

## Rule 4 — Fail closed on authority ambiguity

If the runtime cannot prove:

- which tool definition the model saw;
- which MCP generation a call belongs to;
- which permission profile applies;
- whether a non-idempotent side effect committed;
- whether an approval applies to this exact capability;
- whether a thread already has an active turn;

then do not guess.

Return a typed failure, reconciliation state, overload/busy state, or require explicit operator input.

---

## Rule 5 — No hidden global mutable world during a step

Once a sampling request begins, the runtime must not consult a newly mutated global registry/config/MCP view to interpret model-originated calls from that sampling request.

The core invariant of this plan is:

```text
MODEL_VISIBLE_WORLD(step N)
          ==
TOOL_EXECUTION_WORLD(step N)
```

for all model-originated actions.

---

## Rule 6 — No same-session concurrent turns

A logical session/thread may have **at most one active executing turn**.

A second user input while a turn is active must become one of:

- steer input;
- queued follow-up input;
- explicit rejection/busy response;

according to API semantics.

It must never silently become a second concurrent `runTurn()` against the same session.

---

## Rule 7 — Model retry taxonomy must preserve snapshot semantics

Differentiate:

1. **transport/provider retry**  
   same semantic request, same prompt/tool snapshot;
2. **model request retry**  
   same semantic request, same StepExecutionSnapshot;
3. **reactive compaction / context rebuild / tool catalog change / model switch**  
   **new sampling snapshot required**.

Do not reuse a stale StepContext after the actual model-visible prompt/tool universe changes.

---

## Rule 8 — Do not over-copy Codex

Do NOT implement unless this plan explicitly asks for it:

- OpenAI enterprise auth;
- ChatGPT workspace policy;
- marketplace;
- Guardian-specific infrastructure;
- full remote executor;
- full PathUri conversion;
- macOS Seatbelt;
- Linux Landlock/seccomp clone;
- Windows restricted-token clone;
- every Codex App Server endpoint;
- project/thread-section UI features.

We want the architectural invariants, not product-specific bulk.

---

# 2. CURRENT SOURCE AUDIT — WHAT IS ALREADY GOOD

The following current mechanisms should be preserved and used as building blocks.

## 2.1 Existing StepContext

Current contract roughly captures:

```ts
interface StepContext {
  stepId: string;
  sessionId: SessionId;
  turnId: TurnId;
  agentId: AgentId;
  effectiveAgent: EffectiveAgentConfig;
  cwd: string;
  toolSpecs: readonly ToolSpec[];
  policyHash: string;
  contextSelection: {
    blocks: number;
    tokens: number;
    compacted: boolean;
  };
  model: ModelRef;
}
```

The runtime creates one before a model call and threads it into the tool batch.

This is a good start.

**Do not delete it.**

But it is not yet authoritative enough; P23 closes the semantic gap.

---

## 2.2 Existing ToolCallController

Keep:

- bounded concurrency;
- deterministic call-order result observation;
- `ToolSemantics`;
- resource conflict keys;
- cancellable-aware settlement;
- adaptive recovery;
- typed recovery taxonomy;
- stall traces;
- no unsafe automatic retry;
- abort settlement.

P23 changes how the controller resolves a tool, not the useful behaviors around execution.

---

## 2.3 Existing ToolOrchestrator

Keep the existing pipeline:

```text
resolve
validate
normalize
risk
permission
approval
sandbox
persist side-effect intent
execute
timeout/output limits
evidence
events
normalize
```

The important change is that `resolve` must become capable of resolving against a **frozen step binding**, not only the mutable process-wide registry.

---

## 2.4 Existing MCP Tool View

The current `McpToolView` already provides useful concepts:

- schema hashing;
- refresh diff;
- staged refresh;
- snapshot isolation;
- structural mismatch failure.

Reuse the schema/diff logic.

Do not build an unrelated second schema-hash mechanism.

P24 evolves this from a turn-level helper into a production Step binding system.

---

## 2.5 Existing Gateway/RPC

The current gateway already has an important clean boundary:

```text
Gateway
  ↓
RpcMethodRegistry
  ↓
AgentRuntime
```

Keep that principle.

P28 turns it into a proper App Server protocol instead of deleting it.

---

# 3. CURRENT SOURCE AUDIT — VERIFIED GAPS TO FIX

These gaps are the reason this plan exists.

---

## GAP-01 — StepContext is passed around but is not the authoritative tool world

Current model-call code still selects tools from controller-level:

```ts
this.deps.toolSpecs
this.deps.toolSelector
```

instead of using an already-frozen exact `step.toolRouter.modelVisibleSpecs`.

Therefore:

```text
StepContext.toolSpecs
```

is not guaranteed to equal:

```text
the exact schemas passed to model.generate()
```

This violates the core snapshot invariant.

---

## GAP-02 — Reactive compaction can reuse a stale step identity

The current model retry path can:

1. start with a StepContext;
2. hit context-length failure;
3. append a digest;
4. shrink/rebuild history;
5. retry inside `callModelWithRetry`.

The model-visible context changed.

That must be treated as a **new sampling snapshot**, not merely another attempt inside the old snapshot.

---

## GAP-03 — Tool execution still resolves from the global mutable registry

`ToolOrchestrator.execute()` currently does:

```ts
const tool = this.registry.get(request.call.name);
```

The tool definition used at execution time is therefore process-global.

A true step snapshot requires:

```text
model advertised binding X
→ call resolves binding X
```

even if global catalog X is later replaced/removed.

---

## GAP-04 — Tool policy execution reads Turn/global state rather than frozen step authority

The ToolCallController still gates with current turn agent policy and controller/global sandbox/semantics dependencies.

A `stepId` in the event is useful observability, but it is not authority.

The Step execution world must contain the exact policy/permission/environment/router binding used for that call.

---

## GAP-05 — MCP is eager at Harness startup

Current production composition:

```text
for each configured MCP server:
    connect
    discover tools
    register all tools
```

A single misconfigured unused server can abort Harness creation.

This must evolve to:

```text
catalog
→ resolve need
→ lazy connection
→ immutable binding
```

---

## GAP-06 — McpToolView is turn-scoped and not the production tool execution authority

Current `McpToolView` is useful but does not close:

```text
MCP snapshot
→ StepToolRouter
→ actual invocation binding
```

It must be integrated into the production world snapshot.

---

## GAP-07 — Same session can run multiple different turns concurrently

The current RPC in-flight map is keyed by:

```text
${sessionId}:${turnId}
```

It rejects running the exact same turn twice, but does not reject:

```text
session S / turn A
session S / turn B
```

running simultaneously.

That is unsafe for a conversation/session state machine.

---

## GAP-08 — There is no LoadedSession / SessionActor owner

The current `SessionService` is mostly durable CRUD/lifecycle.

Runtime handles such as:

- active turn;
- cancellation;
- input queue;
- active MCP references;
- turn lock;
- pending steer input;

do not have one authoritative session-owned lifecycle object.

---

## GAP-09 — Persistence is strong but lacks a formal durability-boundary contract

The project already has:

- ordered events;
- SQLite WAL;
- JSONL stores;
- side-effect intent persistence;
- checkpoints;
- state snapshots.

But there is not yet one explicit abstraction answering:

```text
"everything through semantic boundary N is durable"
```

for:

- turn start;
- side-effect intent;
- side-effect outcome;
- checkpoint;
- turn completion.

---

## GAP-10 — App protocol is still internal RPC, not a versioned Thread/Turn/Item contract

Current RPC is useful but still:

```text
session.create
session.send
session.run
...
```

with no:

- initialize handshake;
- protocol version;
- client capabilities;
- Thread/Turn/Item DTO layer;
- bounded ingress/outbound backpressure;
- schema generation/golden fixtures.

---

## GAP-11 — No public SDK layer

There is no standalone SDK package with:

```text
HarnessClient
Thread
runStreamed()
run()
```

The CLI still has access to runtime/store internals.

---

## GAP-12 — Config is a direct `HarnessConfig`, not a layered explainable config

Current configuration cannot generally answer:

```text
which layer supplied this key?
what fingerprint did this session freeze?
which keys changed?
is the change allowed to affect current step/turn/session?
```

---

## GAP-13 — Approval records are durable, but authority identity is still stringly typed

Current request has:

```ts
action: string;
target: string;
scope: "one_call" | "one_tool" | "session";
```

The scope is excellent audit metadata, but the runtime still needs a canonical semantic capability identity such as:

```text
exec(command, cwd, environment, permission delta)
file_write(canonical path)
network(origin)
mcp(server generation, tool)
```

for safe approval reuse.

---

## GAP-14 — No Symphony-style external-work reconciliation layer

The existing scheduler/delegator solves **intra-task** agent execution.

It is not the same as:

```text
external work item A
external work item B
external work item C
```

with polling, claims, state reconciliation, retries, and workspace lifecycle.

A separate orchestration layer is still absent.

---

# 4. TARGET ARCHITECTURE AFTER P23–P33

```text
┌──────────────────────────────────────────────────────────────┐
│                         Clients                              │
│ CLI │ Web │ Desktop │ IDE │ TypeScript SDK │ Chat Gateway   │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                     App Server v1                            │
│ initialize / capabilities                                    │
│ thread/* │ turn/* │ item events │ approval/* │ ask/*        │
│ bounded queues │ replay │ backpressure                       │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                    LoadedSessionManager                      │
│ PersistentSession                                            │
│      ↕                                                       │
│ LoadedSession / SessionActor                                 │
│ single active turn │ steer queue │ cancellation │ resources  │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                         Runtime                              │
│ TurnContext                                                  │
│      │                                                       │
│      ▼                                                       │
│ SamplingSnapshot / StepExecutionSnapshot                     │
│ ├─ exact prompt/context identity                             │
│ ├─ exact model                                              │
│ ├─ exact environment                                         │
│ ├─ exact permission profile                                  │
│ ├─ exact skill/instruction snapshot                          │
│ ├─ exact MCP binding generation                              │
│ └─ Frozen StepToolRouter                                     │
│          │                                                   │
│          ├─ modelVisibleSpecs()                              │
│          └─ resolve(call) → FrozenToolBinding                │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                 Tool Execution Pipeline                      │
│ frozen binding                                               │
│ → validation                                                 │
│ → capability request                                         │
│ → permission / approval                                      │
│ → sandbox                                                    │
│ → intent durability fence                                    │
│ → execute                                                    │
│ → outcome durability fence                                   │
│ → checkpoint                                                 │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                Canonical Durable Trail                       │
│ semantic journal/events                                      │
│ projections │ checkpoints │ transcript │ trace               │
│ flush-through fences                                         │
└──────────────────────────────────────────────────────────────┘

ABOVE SINGLE-THREAD HARNESS:

┌──────────────────────────────────────────────────────────────┐
│               Symphony-style Orchestrator                    │
│ WorkTracker → Reconcile → Claim → Workspace → AppServer      │
│ Retry / Stop / Release / Observe                             │
└──────────────────────────────────────────────────────────────┘
```

---

# PHASE 23 — Step World Snapshot V2: Make the Snapshot Authoritative

> Priority: CRITICAL  
> Do this before lazy MCP/App Server.  
> This phase closes the most important semantic gap found in the current code.

---

## P23-1 Split serializable step record from runtime execution snapshot

### Problem

The current `StepContext` mixes audit fields with values that are intended to represent runtime authority, but the actual controllers still use global dependencies.

We need two explicit concepts:

```text
StepRecord
```

for durable/observable identity, and:

```text
StepExecutionSnapshot
```

for actual immutable runtime bindings.

### Do

Introduce:

```ts
export interface StepRecord {
  readonly stepId: StepId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly agentId: AgentId;

  readonly model: ModelRef;

  readonly toolRouterFingerprint: string;
  readonly policyFingerprint: string;
  readonly environmentFingerprint: string;
  readonly contextFingerprint: string;
  readonly instructionFingerprint: string;
  readonly mcpBindingFingerprint?: string;
  readonly skillSnapshotFingerprint?: string;

  readonly createdAt: number;
}
```

Then runtime-only:

```ts
export interface StepExecutionSnapshot {
  readonly record: StepRecord;

  readonly agent: EffectiveAgentConfig;
  readonly environment: EnvironmentSnapshot;
  readonly permissions: PermissionProfileSnapshot;
  readonly tools: StepToolRouter;

  readonly model: ModelSnapshot;
  readonly context: ModelContextSnapshot;
  readonly instructions: InstructionSnapshot;

  readonly mcp?: McpBindingSnapshot;
  readonly skills?: SkillSnapshot;
}
```

### Important

Do not persist function closures/executors inside `StepRecord`.

`StepExecutionSnapshot` may hold runtime object references.

The durable record stores fingerprints/provenance only.

### Files

Candidate locations:

```text
packages/contracts/src/step-context.ts
packages/core/src/runtime/step-execution-snapshot.ts
packages/core/src/runtime/step-snapshot-factory.ts
```

If naming can be improved, do so consistently.

### How

1. Keep compatibility export for current `StepContext` temporarily if public API uses it.
2. Make runtime use `StepExecutionSnapshot`.
3. Add deterministic fingerprint helpers.
4. Fingerprints must canonicalize object key order.
5. No fingerprint may depend on:
   - function `.toString()`;
   - object identity;
   - random iteration order;
   - memory address;
   - `Date.now()` except explicit createdAt outside the hash.

### Acceptance

Unit:

- equivalent snapshots with different object insertion order → same fingerprint;
- changed tool schema → different tool router fingerprint;
- changed permission → different policy fingerprint;
- changed cwd/workspace roots → environment fingerprint changes.

Integration:

- `model.started` event contains `stepId` and snapshot fingerprints;
- `tool.requested` from that model call contains the same `stepId`;
- trace explain can correlate one model call with one execution snapshot.

### DONE definition

Do not mark DONE if only new interfaces exist.

The main runtime loop must create a `StepExecutionSnapshot`.

---

## P23-2 Introduce Frozen `StepToolRouter`

### Goal

Make this true:

```text
tools advertised to model
       ==
bindings available to calls produced by that model request
```

### Do

Create an immutable router.

Suggested shape:

```ts
export interface ToolProvenance {
  readonly kind: "builtin" | "mcp" | "plugin" | "dynamic";
  readonly sourceId?: string;
  readonly generation?: string;
}

export interface FrozenToolBinding {
  readonly name: string;
  readonly spec: ToolSpec;
  readonly definition: ToolDefinition;
  readonly semantics: ToolSemantics;
  readonly provenance: ToolProvenance;
}

export interface StepToolRouter {
  readonly id: string;
  readonly fingerprint: string;
  readonly modelVisibleSpecs: readonly ToolSpec[];

  has(name: string): boolean;
  resolve(name: string): FrozenToolBinding | undefined;
}
```

Use a concrete class whose internal map is private and never mutated after construction.

### Build path

```text
mutable ToolRegistry
       ↓
candidate bindings
       ↓
policy filter
       ↓
deferred exposure / selector
       ↓
collision check
       ↓
freeze
       ↓
StepToolRouter
```

### Critical distinction

`ToolRegistry` remains the process catalog.

`StepToolRouter` is a per-sampling execution snapshot.

Do not replace one with the other.

### How

1. Add a router factory.
2. Convert registry definitions into `FrozenToolBinding`.
3. Apply tool policy.
4. Apply deferred schema logic.
5. Apply goal-based tool selector.
6. Include selected MCP/plugin bindings.
7. Freeze the exact set.
8. Compute router fingerprint.
9. Put router into `StepExecutionSnapshot`.

### Collision rule

If two sources produce the same model-visible name:

```text
builtin:read_file
mcp-X:read_file
```

do not silently last-write-wins.

Fail with typed `TOOL_COLLISION`.

If aliases/namespaces are desired, resolve before freeze.

### Acceptance

Invariant test:

```text
registry has A
build StepRouter S1
registry unregisters A
S1.resolve(A) still resolves the original frozen binding
new StepRouter S2 does not contain A
```

Another:

```text
registry A v1
S1 built
registry replaces A with v2
call from S1 executes v1
call from S2 executes v2
```

This test is mandatory.

---

## P23-3 ModelCallController must consume `step.tools.modelVisibleSpecs` directly

### Current failure mode

The controller currently recomputes:

```ts
toolSelector.select({
  goal: working.goal,
  tools: this.deps.toolSpecs,
});
```

inside `callModelWithRetry()`.

That means StepContext is not authoritative.

### Do

Move **all tool selection before model call** into Step snapshot creation.

Then model controller must receive:

```ts
step: StepExecutionSnapshot
```

and call:

```ts
client.generate({
  messages: step.context.messages,
  system: step.instructions.system,
  tools: [...step.tools.modelVisibleSpecs],
});
```

or equivalent.

### Forbidden after this task

Inside `ModelCallController.callModelWithRetry()` there must be no production lookup of:

```ts
this.deps.toolSpecs
this.deps.toolSelector
registry.specs()
mcp.tools
```

for that already-created request.

### Migration

Controller deps should shrink.

Remove `toolSpecs` / `toolSelector` when no longer required.

Do not leave stale constructor dependencies “for later”.

### Acceptance

Test using selector with changing external state:

```text
selector first call -> [A]
selector second call -> [B]
```

For one Step snapshot:

- selector invoked once before model request;
- model receives A;
- retry of same semantic request receives A;
- tool execution accepts only A.

No second selector invocation in the model controller.

---

## P23-4 Tool execution must resolve the frozen binding, not global registry

### Current failure mode

`ToolOrchestrator.execute()` resolves:

```ts
this.registry.get(request.call.name)
```

at execution time.

### Do

Change the execution seam so the already-resolved binding is passed in.

Option A, recommended:

```ts
interface BoundToolCallRequest extends ToolCallRequest {
  readonly binding: FrozenToolBinding;
}
```

Then:

```ts
orchestrator.executeBound(request, context)
```

and the orchestrator validates against:

```ts
request.binding.definition
```

not the global registry.

Keep a compatibility `execute()` only if external callers require it; production AgentRuntime must use `executeBound`.

### Alternative

Allow orchestrator deps to receive a `ToolResolver` argument per call:

```ts
execute(request, context, resolver)
```

but make sure the resolver is the frozen Step router.

### Do not

Do not copy orchestration logic into StepToolRouter.

Router resolves.

Orchestrator enforces.

### Acceptance

Mandatory drift test:

1. router S1 contains write tool executor that records `"v1"`;
2. model produces call;
3. global registry swaps executor to `"v2"`;
4. execute call from S1;
5. output must be `"v1"`.

A tool produced by S1 that is absent from S1 but present globally must fail:

```text
TOOL_NOT_IN_STEP
```

not execute globally.

---

## P23-5 Step policy must become execution authority

### Do

Capture exact step authority:

```ts
interface PermissionProfileSnapshot {
  readonly toolPolicy: ToolPolicy;
  readonly permissions: PermissionPolicy;
  readonly sandboxPolicy: SandboxPolicy;
  readonly fingerprint: string;
}
```

ToolCallController must gate against:

```ts
step.permissions.toolPolicy
```

not mutable `ctx.agent.tools`.

ToolOrchestrator context must receive:

```ts
permissions: step.permissions.permissions
sandboxPolicy: step.permissions.sandboxPolicy
cwd/environment from step.environment
```

### Acceptance

Test:

1. Step S1 created with write denied.
2. global agent config becomes write allowed.
3. S1 call remains denied.
4. S2 sees allowed.

Inverse test too:

1. S1 allowed.
2. global config narrows.
3. Define explicit policy:
   - either grandfather already-issued S1 call;
   - or force invalidation before execution.

Recommended for authority consistency:

**S1 keeps captured authority unless a host-level emergency revocation epoch changed.**

Add optional revocation epoch for emergency narrowing if needed.

Do not silently mix policies.

---

## P23-6 Define retry vs re-snapshot boundary

### Goal

Fix stale StepContext during reactive compaction.

### Define

```ts
type SamplingAttemptKind =
  | "transport_retry"
  | "model_retry"
  | "reactive_compaction"
  | "context_rebuild"
  | "tool_world_changed"
  | "model_switch";
```

Rules:

### Reuse same StepExecutionSnapshot

Allowed only if all model-visible inputs are semantically identical:

- same messages/context;
- same system/instructions;
- same tool specs;
- same model;
- same policy;
- same environment.

Examples:

```text
HTTP 502 transport retry
provider internal retry
```

### Build new StepExecutionSnapshot

Required when:

```text
context compaction changed messages
system prompt changed
tool set changed
MCP binding changed
model changed
environment changed
permission world changed
```

### Suggested runtime refactor

Move reactive-compaction retry orchestration one level upward.

Instead of hiding context rebuild entirely inside `ModelCallController`, return:

```ts
type ModelCallAction =
  | { kind: "completed"; ... }
  | { kind: "retry_same_snapshot"; ... }
  | { kind: "rebuild_context"; reason: "context_overflow" }
  | { kind: "failed"; ... };
```

Runtime:

```ts
if (action.kind === "rebuild_context") {
  await checkpoint(...);
  rebuild context;
  continue outer sampling loop; // creates NEW step
}
```

### Acceptance

Test:

- first step ID S1 hits context overflow;
- compaction occurs;
- next model request has S2;
- S1.contextFingerprint != S2.contextFingerprint;
- no tool call from S2 is attributed to S1.

---

## P23-7 Snapshot exact context, not an approximation

### Current state

Current context snapshot tracks coarse:

```text
block count
estimated system tokens
compacted flag
```

Useful telemetry, insufficient semantic identity.

### Do

Create:

```ts
interface ModelContextSnapshot {
  readonly messageIds: readonly MessageId[];
  readonly blockIds: readonly string[];
  readonly systemHash: string;
  readonly contextHash: string;
  readonly estimatedTokens: number;
  readonly compacted: boolean;
}
```

Do not duplicate entire transcript in events.

Store IDs/hashes.

### Acceptance

- changing one included message changes contextHash;
- changing excluded old history does not change current contextHash;
- compaction creates a new contextHash;
- replay/explain can state which message IDs were visible to a model call.

---

## P23-8 Add Step snapshot invariant suite

Create a dedicated suite, e.g.:

```text
packages/core/src/runtime/step-snapshot.invariant.test.ts
```

Mandatory cases:

1. tool removed after sampling → old call still resolves old binding;
2. tool added after sampling → old step cannot call it;
3. schema changed after sampling → old schema validates against old binding;
4. policy widened after sampling → old step not widened;
5. policy narrowed after sampling → behavior matches documented revocation rule;
6. selector state changes after sampling → old advertised set unchanged;
7. MCP refresh after sampling → old binding generation unchanged;
8. reactive compaction → new step;
9. provider retry with identical request → same step;
10. event chain model/tool uses same stepId.

### Phase gate

P23 cannot be DONE until all 10 pass through real Runtime integration, not only direct helper construction.

---

---

## PHASE 23 — COMPLETED (Step World Snapshot V2)

Implementation record (production-wired, invariant-tested):

| Sub-task | Evidence                                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P23-1    | `StepRecord` + `StepExecutionSnapshot` + deterministic fingerprint helpers; runtime builds a real snapshot before EVERY model call; `model.started` carries stepId + 5 fingerprints; `tool.requested` shares stepId |
| P23-2    | `FrozenStepToolRouter` (immutable); factory freeze pipeline (policy filter → collision `TOOL_COLLISION` → selector once → deferred advert); S1 survives registry removal/swap                                       |
| P23-3    | `ModelCallController` consumes `step.tools.modelVisibleSpecs`; controller no longer touches toolSpecs/toolSelector/registry; schema-advert moved to contracts                                                       |
| P23-4    | `ToolOrchestrator.executeBound` executes `request.binding.definition`; controller resolves `step.tools.resolve` and fails `TOOL_NOT_IN_STEP`; permissive mode is test-only                                          |
| P23-5    | policy gate + orchestrator context use `step.permissions` (toolPolicy/permissions/sandboxPolicy) and `step.environment.cwd`                                                                                         |
| P23-6    | `SamplingAttemptKind`; controller returns `rebuild_context`; compaction orchestration moved to the runtime outer loop → NEW step                                                                                    |
| P23-7    | `model.started` carries exact `contextMessageIds`/`contextBlockIds`; contextHash == record fingerprint                                                                                                              |
| P23-8    | 10-invariant suite through the real Runtime loop (step-snapshot.invariant.test.ts)                                                                                                                                  |

Commits: P23-1..P23-8 (8 commits). Core runtime suite: 223 tests green; step-snapshot + invariant suites: 38 tests.

# PHASE 24 — MCP Runtime V2: Catalog ≠ Connection ≠ Binding

> Priority: CRITICAL/HIGH  
> Depends on P23 StepToolRouter.

---

## P24-1 Replace eager MCP composition with `McpServerCatalog`

### Current problem

Harness creation connects all configured servers.

### Do

Define catalog descriptors without connecting:

```ts
export interface McpServerDescriptor {
  readonly id: string;
  readonly config: McpServerConfig;
  readonly trust: "trusted" | "untrusted";
  readonly networkBoundary: "loopback" | "internet";
  readonly enabled: boolean;
  readonly requiredByDefault?: boolean;
}
```

`composeMcp()` should become mostly catalog composition.

Do not spawn stdio children or HTTP initialize every server at startup.

### Acceptance

Configure 10 fake MCP servers.

Create Harness.

Assert:

```text
connect count == 0
```

unless explicitly configured as eager/required.

---

## P24-2 Add `McpConnectionManager`

### Responsibilities

```text
getOrConnect(serverId)
reuse
health state
connection generation
refresh
idle close
close all
```

Suggested state:

```ts
type McpConnectionState =
  | { kind: "disconnected" }
  | { kind: "connecting"; promise: Promise<McpConnectionGeneration> }
  | { kind: "ready"; generation: McpConnectionGeneration }
  | { kind: "failed"; error: ErrorInfo; retryAfter?: number };
```

### Concurrency

Two simultaneous steps requiring the same disconnected server must share one connect promise.

Test:

```text
100 concurrent getOrConnect(A)
→ exactly one transport connect
```

### Lifecycle

Harness `close()` closes every connected generation.

No orphan stdio processes.

---

## P24-3 Add need-driven dependency resolver

### Inputs

Resolver may consider:

- explicit MCP server/tool mention;
- selected skill required MCP dependencies;
- selected plugin dependencies;
- tool lookup request;
- explicit host-required servers;
- workflow configuration.

### Do not

Do not connect servers purely because their config exists.

### Suggested interface

```ts
interface McpDependencyResolver {
  resolve(input: {
    goal: string;
    explicitToolNames?: readonly string[];
    selectedSkills: readonly SkillSelection[];
    selectedPlugins: readonly PluginSelection[];
  }): ReadonlySet<McpServerId>;
}
```

### Phase-1 pragmatic policy

If automatic semantic server inference is uncertain:

- allow explicit server tags / declared dependencies;
- keep an optional `requiredByDefault`;
- do not invent fragile LLM-based MCP discovery inside the runtime.

---

## P24-4 Build immutable `McpBindingSnapshot`

### Definition

```ts
interface McpBindingSnapshot {
  readonly id: string;
  readonly fingerprint: string;
  readonly generations: ReadonlyMap<McpServerId, string>;
  readonly tools: readonly McpFrozenToolBinding[];
  readonly createdAt: number;
}
```

Each MCP tool binding must hold:

- server ID;
- connection generation;
- tool name;
- schema hash;
- exact adapter/executor reference;
- trust/provenance.

### Important

A call generated against generation G1 must not silently execute against G2.

---

## P24-5 Integrate MCP bindings into StepToolRouter

Build order:

```text
base tool catalog
+
MCP binding tools
+
plugin/dynamic tools
↓
exposure/selection
↓
Frozen StepToolRouter
```

The main Agent allow list should no longer be permanently constructed from every MCP tool at Harness startup.

Policy should reason over tool provenance/names dynamically.

### Acceptance

- server A needed, server B not needed;
- only A connects;
- router contains A tools;
- B failure irrelevant;
- next step needs B → B connection attempted then.

---

## P24-6 Refresh by generation, never mutate active binding

Reuse current `McpToolView` schema diff ideas.

### Rule

Refresh:

```text
G1 active
tools/list changes
→ construct G2
→ future Step snapshots may bind G2
→ already-created Steps retain G1
```

Never mutate `G1.tools` in place.

### Acceptance

1. G1 schema = `{x:string}`;
2. Step S1 uses G1;
3. refresh produces G2 schema `{x:number}`;
4. S1 generated `{x:"a"}`;
5. S1 still validates/executes using G1;
6. S2 advertises G2.

---

## P24-7 Unused broken server must not kill startup

### Acceptance

Config:

```text
A = valid but not needed
B = invalid executable path but not needed
```

Harness creation succeeds.

A simple task that uses no MCP succeeds.

When a step actually requires B:

- produce typed `MCP_CONNECT_FAILED`;
- event includes server ID;
- unrelated built-in tools remain available;
- no process-wide crash.

---

## P24-8 MCP cache/idle policy

Add configurable:

```ts
interface McpRuntimePolicy {
  idleTtlMs?: number;
  maxConnectedServers?: number;
  connectTimeoutMs?: number;
}
```

Do not overengineer LRU if there are only a few servers, but make lifecycle bounded.

Tests use injected timer.

---

---

## PHASE 24 — COMPLETED (MCP Runtime V2: Catalog ≠ Connection ≠ Binding)

Implementation record:

| Sub-task | Evidence                                                                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P24-1    | `McpServerCatalog` — declaration only, never connects; descriptors carry trust/networkBoundary/enabled/eager/requiredByDefault; `composeMcp` is lazy; eager servers connect only on opt-in `connectEager` |
| P24-2    | `McpConnectionManager` — shared connect promise (100 concurrent → 1 connect), generation lifecycle, idle close, closeAll (no orphan stdio), connect timeout                                               |
| P24-3    | `McpDependencyResolver` — mcp:<id> mentions, known-tool matching, skill/plugin declared deps, requiredByDefault; config existence is never a reason to connect                                            |
| P24-4    | `McpBindingSnapshot` — immutable (id/fingerprint/generations/tools/createdAt); each tool carries serverId+generation+schemaHash+definition ref+trust; G1 never executes G2                                |
| P24-5    | runtime `mcpBindingProvider` freezes per-step MCP world into StepToolRouter (`extraBindings`, provenance kind=mcp); no global registration / no allow-list baking; controller gates by provenance         |
| P24-6    | refresh → new generation; bound snapshot fingerprint changes; step S1 retains G1 while S2 advertises G2                                                                                                   |
| P24-7    | unreachable non-needed server never aborts startup; a step that needs it gets typed `mcp.connect_failed` (recorded + emitted with serverId); built-ins stay available; no crash                           |
| P24-8    | `McpRuntimePolicy` (idleTtlMs/maxConnectedServers/connectTimeoutMs) via descriptor.policy; injected-timer tests                                                                                           |

Commits: P24-1..P24-8 (3 commits). mcp-runtime-v2 13 + mcp-wiring 6 + core/harness/cli 774 green (P4-6 sandbox memory excluded).

# PHASE 25 — SessionActor: Single Owner of Live Session State

> Priority: CRITICAL  
> This closes a real concurrency hole in the current RPC/Gateway path.

---

## P25-1 Separate durable `PersistentSession` from live `LoadedSession`

### Persistent

Contains semantic durable state:

```ts
interface PersistentSession {
  id: SessionId;
  parentId?: SessionId;
  agentId: AgentId;
  model: ModelRef;
  cwd: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
}
```

Existing Session can remain the durable shape.

### Loaded

Runtime only:

```ts
interface LoadedSession {
  readonly persistent: PersistentSession;

  activeTurn?: ActiveTurnHandle;
  readonly inputQueue: SessionInputQueue;
  readonly resourceScope: SessionResourceScope;
  readonly cancellation: AbortController;
}
```

Do not serialize:

- AbortController;
- promises;
- MCP sockets;
- locks;
- timers.

---

## P25-2 Add `SessionActor` / `LoadedSessionManager`

Suggested API:

```ts
interface LoadedSessionManager {
  load(id: SessionId): Promise<SessionActor>;
  unload(id: SessionId): Promise<void>;
  listLoaded(): SessionId[];
}

interface SessionActor {
  startTurn(input: UserInput): Promise<TurnHandle>;
  steer(input: UserInput): Promise<void>;
  enqueueFollowup(input: UserInput): Promise<void>;
  interrupt(): Promise<TurnOutcome | undefined>;
  status(): SessionRuntimeStatus;
}
```

### Hard invariant

Inside one actor:

```text
activeTurn ∈ {0,1}
```

---

## P25-3 Fix RPC same-session concurrency

Replace:

```text
Map<sessionId:turnId, ActiveRun>
```

as the primary lifecycle authority.

The SessionActor owns active run.

### Required behavior

If `turn/start` is called while one is active:

API must explicitly choose one:

```text
BUSY
STEER
QUEUE
```

No silent parallel run.

For compatibility `session.run`, return typed:

```text
SESSION_BUSY
```

if another turn is active.

### Tests

Start A.

Before A settles, start B.

Assert:

```text
runtime.runTurn max concurrent for same session == 1
```

Across different sessions:

```text
S1 turn A
S2 turn B
```

may execute concurrently.

---

## P25-4 Define steer semantics

A steer is input intended to influence the currently active turn.

Suggested:

```ts
interface SteerInput {
  id: PromptId;
  text: string;
  admittedAt: number;
}
```

Use existing Inbox where possible.

### Runtime safe boundary

Steering input is injected:

- before next model sampling;
- never halfway through interpreting an existing tool call;
- never by mutating an already-built Step snapshot.

Therefore:

```text
steer arrives during Step S1
→ S1 tool batch completes/cancels according to policy
→ next sampling snapshot S2 includes steer
```

---

## P25-5 Follow-up queue

A normal user message while a turn runs can be queued as a future turn.

Explicitly distinguish it from steer.

Do not infer based on text.

Protocol should say which operation is used.

---

## P25-6 Session shutdown

`unload` / Harness close must:

1. interrupt active turn;
2. settle non-cancellable in-flight tools correctly;
3. flush journal/fences;
4. close session-bound resources;
5. release MCP references;
6. remove actor from manager.

Idempotent.

---

## P25-7 Fork semantics

Current durable `SessionService.fork()` creates a child relation but does not necessarily provide Codex-like copied semantic history.

Define two distinct operations if needed:

```text
session.spawnChild
```

for subagent parentage, and:

```text
thread.fork
```

for conversational branch.

Do not overload them.

`thread.fork` must specify boundary:

```text
through turn X
before turn X
latest completed
```

If implementing only latest-completed in v1, document it.

---

## PHASE 25 — COMPLETED (SessionActor: Single Owner of Live Session State)

Implementation record (GAP-07/GAP-08 closed — the RPC/gateway concurrency hole):

| Sub-task | Evidence                                                                                                                                                                                                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P25-1    | `PersistentSession` = the contracts `Session` (durable); `LoadedSession` is runtime-only (activeTurn + inputQueue + resourceScope + cancellation) — AbortController/promises/queues/sockets are NEVER serialized                                                                                                           |
| P25-2    | `DefaultSessionActor` + `DefaultLoadedSessionManager` in core (`session-actor.ts`); load idempotent, unload/listLoaded/close; hard invariant `activeTurn ∈ {0,1}`; harness exposes `harness.sessions`; create-harness test proves load→unload→close                                                                        |
| P25-3    | RPC `Map<sessionId:turnId, ActiveRun>` deleted — `session.send/run/cancel` route through the actor; typed `SESSION_BUSY` error code added to contracts; `AgentRuntime.runTurn` per-session guard (max concurrent == 1, bypass-proof); `pendingRun` closes the submit→cancel race; cross-session concurrency proven (S1∥S2) |
| P25-4    | steer admitted through the existing inbox (`kind=steer`); runtime drains at the next sampling boundary only — never mid-tool, never mutating a frozen step snapshot; `startTurn(onConflict:"steer")` returns the running turn's handle                                                                                     |
| P25-5    | followup admitted as `kind=followup` (never text-inferred); actor drains the queue into a NEW turn after the current one settles; gateway converts SESSION_BUSY into `session.followup` + `[queued]` reply                                                                                                                 |
| P25-6    | `unload`/close idempotent: interrupt active turn → settle in-flight tools → release resource scope → remove actor; harness close drains every loaded actor                                                                                                                                                                 |
| P25-7    | `SessionService.spawnChild` (EMPTY child — subagent parentage) vs `threadFork` (copies parent message history, Codex-like branch) — never overloaded; `fork` retained as a spawnChild alias                                                                                                                                |

# PHASE 26 — Durability V2: Canonical Journal & Fences

> Priority: HIGH  
> Preserve current stores; do not rewrite everything into event sourcing at once.

---

## P26-1 Make event sequence allocation atomic at the store boundary

### Problem class

Callers currently often do:

```ts
sequence = await events.nextSequence(sessionId);
events.append({...sequence});
```

Sequence allocation must be store-owned and atomic.

### Do

Add:

```ts
interface EventStore {
  appendNew(
    event: Omit<AgentEvent, "sequence">
  ): Promise<AgentEvent>;
}
```

or change `append` semantics so caller never allocates sequence.

Keep `nextSequence` only for backward compatibility if needed; production writers must stop using it.

### Acceptance

100 concurrent event appends in same session:

- exactly sequences 0..99;
- no duplicate;
- no gap caused by race;
- deterministic ordering is the store commit order.

Test JSONL and SQLite.

---

## P26-2 Promote the event trail into the canonical semantic journal

Do **not** create a second competing log.

Define which event kinds are semantic durability records.

Examples:

```text
turn.input_committed
turn.started
model.started
tool.intent_persisted
tool.execution_started
tool.outcome_committed
checkpoint.committed
approval.created
approval.resolved
turn.completed
turn.failed
turn.cancelled
```

Observability-only deltas may remain non-semantic.

Add helper:

```ts
isSemanticJournalEvent(type): boolean
```

---

## P26-3 Add `DurabilityFence`

Suggested:

```ts
interface DurabilityFenceStore {
  flushThrough(
    sessionId: SessionId,
    sequence: number,
  ): Promise<void>;
}
```

For SQLite:

- transaction commit provides the fence;
- WAL/synchronous policy must be documented honestly.

For JSONL:

- flush file handle;
- use fsync for hard boundary if durability mode promises it.

### Durability profiles

Consider:

```ts
type DurabilityLevel =
  | "memory"
  | "process"
  | "crash_safe";
```

Do not claim crash-safe for a backend that does not fsync.

---

## P26-4 Formalize side-effect lifecycle journal states

For every side-effect tool:

```text
INTENT_PERSISTED
      ↓
EXECUTION_STARTED
      ↓
OUTCOME_COMMITTED
      ↓
CHECKPOINT_COMMITTED (policy)
```

Persist enough identity:

```ts
interface ToolIntentJournalPayload {
  toolCallId: string;
  stepId: string;
  routerFingerprint: string;
  toolBindingFingerprint: string;
  argsHash: string;
  sideEffectScope: string;
  idempotent: boolean;
}
```

Outcome:

```ts
interface ToolOutcomeJournalPayload {
  toolCallId: string;
  status: ToolResult["status"];
  resultHash?: string;
  evidenceHashes?: string[];
}
```

---

## P26-5 Resume reconciliation must classify by journal state

On crash:

### Case A

No intent:

```text
safe to consider not started
```

### Case B

Intent persisted, no execution-start record:

Depending on failpoint and backend certainty:

```text
likely not started
```

but do not assume if process could die after actual start before recording.

Design execution-start ordering carefully.

### Case C

Execution started, no outcome:

```text
UNKNOWN EFFECT
→ reconcile_unknown_effect
```

Never blind retry unsafe tool.

### Case D

Outcome committed, checkpoint missing:

```text
do not re-execute
→ reconstruct working state from committed outcome
→ checkpoint forward
```

### Case E

Checkpoint committed:

resume from checkpoint.

---

## P26-6 SQLite atomic semantic boundary adapter

For SQLite backend, add transaction helpers so logically coupled writes can commit atomically when feasible.

Candidate operation:

```ts
commitToolOutcome({
  toolMessage,
  outcomeEvent,
  checkpoint?,
})
```

Do not expose SQL to core.

Use an optional store capability interface.

Fallback stores use ordered writes + fences and advertise weaker atomicity.

---

## P26-7 Add projections, but keep one truth source

Useful projections:

```text
SessionProjection
TurnProjection
TranscriptProjection
ToolLedgerProjection
TraceProjection
```

A projection may be rebuilt from journal + durable documents.

Do not make a projection independently authoritative.

Add rebuild tests:

```text
delete projection
rebuild
same visible state
```

---

## P26-8 Crash matrix

Use existing fault injection.

At minimum inject kill at:

1. before intent;
2. after intent;
3. after execution start;
4. after effect committed in executor but before outcome write;
5. after outcome write;
6. before checkpoint;
7. after checkpoint;
8. before turn completion;
9. after turn completion event before response to client.

For a non-idempotent fake write tool, verify no crash path performs an automatic duplicate side effect.

---
## PHASE 26 — COMPLETED (Durability V2: Canonical Journal & Fences)

Implementation record (the event trail IS the canonical journal — no second log):

| Sub-task | Evidence |
| --- | --- |
| P26-1 | `EventStore.appendNew` — store-owned atomic sequence allocation; ALL production writers migrated off `nextSequence+append` (runtime emit, gateway, delegator×2, reflection-runner); 100-concurrent append test on JSONL AND SQLite → exactly 0..99, no dup, no gap |
| P26-2 | `isSemanticJournalEvent` + `SEMANTIC_JOURNAL_EVENTS` (contracts): lifecycle/side-effect/gate events are durable records; observability deltas (model.delta/tool.output/retry/security) are not; classification tests cover every EventType |
| P26-3 | `DurabilityLevel` (memory/process/crash_safe) + `DurabilityFenceStore.flushThrough`; JSONL=crash_safe (appendDurable fsyncs), SQLite=process (WAL+NORMAL — HONEST, never over-claimed), mem=memory; runtime flushes the fence BEFORE acking completion (fail-closed) |
| P26-4 | `ToolIntentJournalPayload` extended with stepId/routerFingerprint/toolBindingFingerprint; `BoundToolCallRequest` now carries the frozen step-world identity (filled by tool-call-controller); orchestrator persists it into the intent journal; `ToolOutcomeJournalPayload` typed |
| P26-5 | `classifyCrashJournalState` (Case A not_started / B likely_not_started / C unknown_effect→reconcile / D do_not_reexecute→reconstruct_forward / E resume_from_checkpoint) + unit tests |
| P26-6 | `AtomicToolOutcomeCommitStore` optional capability — SqliteRuntimeStore.commitToolOutcome commits message + outcome event + checkpoint in ONE transaction (rollback on failure); SQL never exposed to core; fallback stores use ordered writes + fences (P26-3) |
| P26-7 | projections module (Session/Turn/Transcript/ToolLedger/Trace) rebuilt from journal + durable docs — never an independent authority; rebuild idempotence tests (rebuild twice → identical visible state) |
| P26-8 | 3 new FaultPoints wired (tool.effect_committed / turn.completing / turn.completed_acked); crash-matrix suite kills at all 9 plan points with a NON-IDEMPOTENT write tool and proves no crash path auto-duplicates the side effect |


# PHASE 27 — Config Layer Stack & Lifecycle-Aware Drift

> Priority: HIGH/MEDIUM

---

## P27-1 Introduce config layers

Do not require TOML unless desired.

The important concept is layering/origin, not file syntax.

Suggested precedence low → high:

```text
defaults
profile
system
user
project
environment
session overrides
explicit runtime overrides
```

Candidate structure:

```ts
interface ConfigLayer {
  readonly id: string;
  readonly source: ConfigLayerSource;
  readonly values: DeepPartial<HarnessConfig>;
  readonly fingerprint: string;
}
```

---

## P27-2 Produce effective config + per-key origins

```ts
interface ResolvedConfig<T> {
  readonly value: T;
  readonly layers: readonly ConfigLayer[];
  readonly origins: ReadonlyMap<string, ConfigOrigin>;
  readonly fingerprint: string;
}
```

Example explain:

```text
sandboxPolicy.network = deny
  from profile:champion

contextBudget.maxTokens = 64000
  from project:.harness/config.json

mcp.github.enabled = true
  from session override
```

---

## P27-3 Classify config keys by lifecycle

Create explicit metadata:

```ts
type ConfigLifecycle =
  | "process_static"
  | "session_frozen"
  | "turn_dynamic"
  | "step_dynamic";
```

Examples:

### process_static

- data store backend;
- data directory.

### session_frozen

- base agent identity;
- default authority ceiling.

### turn dynamic

- task-specific verification plan inputs.

### step dynamic

- model selection if intentionally switchable;
- MCP binding selection;
- tool exposure.

Document every config field.

---

## P27-4 Drift policy

At runtime, when resolved config fingerprint changes:

- process-static → restart required;
- session-frozen widening → reject or require new session;
- session-frozen narrowing → emergency revocation policy;
- step-dynamic → next step only.

Never silently mutate current Step snapshot.

---

## P27-5 Config explain CLI

Add:

```text
agent config explain
agent config explain <key>
```

Output origins/fingerprint, no secrets.

Redact:

- API keys;
- auth headers;
- tokens.

---

# PHASE 28 — Typed Capability Approval V3

> Priority: HIGH for security semantics.

---

## P28-1 Keep durable approval store, replace string identity with typed capability

Current durable store is good.

Evolve request:

```ts
type CapabilityRequest =
  | ExecCapability
  | FileCapability
  | NetworkCapability
  | McpCapability
  | PermissionEscalationCapability;
```

Suggested:

```ts
interface ExecCapability {
  kind: "exec";
  environmentId: string;
  cwd: string;
  argv: readonly string[];
  tty: boolean;
  permissionDelta?: PermissionDelta;
}

interface FileCapability {
  kind: "file";
  operation: "write" | "delete" | "move";
  canonicalPaths: readonly string[];
}

interface NetworkCapability {
  kind: "network";
  protocol: "http" | "https" | "tcp";
  origin: string;
}

interface McpCapability {
  kind: "mcp";
  serverId: string;
  generation: string;
  tool: string;
  argsHash: string;
}
```

Keep legacy `action/target` as display projection during migration.

---

## P28-2 Semantic approval fingerprint

Create canonical:

```ts
approvalFingerprint(capability): string
```

Never include raw secret values.

For exec, identity includes:

- environment;
- cwd;
- argv canonical representation;
- permission delta;
- tty if authority differs.

For MCP:

- server;
- generation or compatibility identity;
- tool;
- requested authority.

---

## P28-3 Make approval scope executable, not audit-only

Current scopes:

```text
one_call
one_tool
session
```

must have defined reuse semantics.

Suggested:

### one_call

Matches only exact request/call.

### one_tool

Matches same semantic tool/capability pattern under equal-or-narrower authority.

### session

May reuse only within same session and exact approved capability scope.

Never:

```text
approve "exec npm test"
→ approve all exec
```

---

## P28-4 Grant cache must support authority subset checks

Implement:

```ts
isCoveredByGrant(request, grant): boolean
```

Fail closed on unknown.

Tests:

- same command/cwd → match;
- same command different cwd → no match;
- less privilege → may match;
- more privilege → no match;
- same MCP tool different server → no;
- same server different generation with changed schema/authority → no.

---

## P28-5 Emergency revocation

Session-level remembered grant can be revoked.

Revocation applies before new execution.

Already-running non-cancellable operation follows documented semantics; do not pretend rollback occurred.

---

# PHASE 29 — App Server Protocol v1

> Priority: HIGH  
> Build on Gateway; do not replace the Runtime.

---

## P29-1 Create protocol package/boundary

Recommended:

```text
packages/protocol/
```

or:

```text
packages/gateway/src/protocol/
```

If this protocol is intended for SDK/other processes, prefer independent package.

It must NOT import `AgentRuntime`.

Define DTOs only.

---

## P29-2 Initialize handshake

First request:

```json
{
  "method": "initialize",
  "id": 1,
  "params": {
    "clientInfo": {
      "name": "harness_cli",
      "version": "..."
    },
    "capabilities": {
      "streamingItems": true,
      "approvalForms": true
    }
  }
}
```

Server returns:

```json
{
  "protocolVersion": "1",
  "serverInfo": {...},
  "capabilities": {...}
}
```

Before initialize:

```text
other mutating requests → NOT_INITIALIZED
```

Repeated initialize:

```text
ALREADY_INITIALIZED
```

---

## P29-3 External primitive names: Thread → Turn → Item

Internally Session can remain.

Protocol maps:

```text
Thread ↔ Session
Turn ↔ Turn
Item ↔ user/model/tool/approval/verification visible item
```

Do not rename all internal packages just to match wire names.

---

## P29-4 Minimum v1 methods

### Thread

```text
thread/start
thread/read
thread/resume
thread/fork
thread/list
thread/loaded/list
```

### Turn

```text
turn/start
turn/interrupt
turn/steer
```

### Approval

```text
approval/respond
```

### Ask user

```text
ask/respond
```

### Introspection

```text
agent/list
tool/list
skill/list
trace/read
```

---

## P29-5 Item model

Create a wire union:

```ts
type ThreadItem =
  | UserMessageItem
  | AgentMessageItem
  | ToolCallItem
  | ToolResultItem
  | FileChangeItem
  | ApprovalItem
  | AskUserItem
  | VerificationItem
  | RuntimeWarningItem;
```

Do not expose chain-of-thought.

Reasoning metadata can be:

- status;
- summary if intentionally generated;
- token usage;

not hidden private reasoning.

---

## P29-6 Protocol Event Mapper

Core events remain core events.

Add:

```text
AgentEvent
   ↓
ProtocolEventMapper
   ↓
item/started
item/delta
item/completed
turn/completed
...
```

Keep mapping deterministic.

Golden tests.

---

## P29-7 Bounded queues and backpressure

Add bounded:

```text
transport ingress queue
request processing queue
outbound notification queue
```

When saturated:

return retryable typed error:

```text
SERVER_OVERLOADED
```

Do not grow arrays forever.

### Acceptance

capacity=2 test:

- hold two requests;
- third is rejected quickly;
- process memory does not accumulate unbounded work;
- client can retry.

---

## P29-8 Replay/resume subscription

Client may subscribe from:

```text
afterSequence
```

The event sequence is authoritative.

Reconnect:

```text
last seen = 42
→ request afterSequence=42
→ get >42 only
```

No duplicates after reducer dedupe.

---

## P29-9 Request idempotency for mutating API

Especially:

- thread/start;
- turn/start;
- approval/respond;
- ask/respond.

Support optional idempotency key.

Retried transport request must not start duplicate turn.

---

## P29-10 Schema generation / fixtures

Generate or maintain JSON Schema.

CI:

- current types → schema;
- compare committed golden;
- protocol-breaking change requires explicit version/migration update.

---

# PHASE 30 — TypeScript SDK & Client-Only UI Path

> Priority: MEDIUM/HIGH after App Server.

---

## P30-1 Create `packages/sdk`

Exports:

```ts
HarnessClient
Thread
ThreadEvent
ThreadItem
RunResult
```

No dependency on `@ar/core`.

Only:

```text
@ar/protocol
transport client
```

---

## P30-2 Stream-first API

Primary:

```ts
const thread = await client.startThread(...);

const { events } = await thread.runStreamed("fix bug");

for await (const event of events) {
  ...
}
```

Convenience:

```ts
const result = await thread.run("fix bug");
```

`run()` is a reducer over `runStreamed()`.

No parallel independent implementation.

---

## P30-3 Reducer truth test

Given exact event fixture:

```text
manual stream reducer
SDK run()
```

must produce identical:

- items;
- finalResponse;
- usage;
- status.

---

## P30-4 Abort

SDK `AbortSignal` maps to `turn/interrupt`.

Do not merely cancel local HTTP reading while server keeps running unknowingly.

---

## P30-5 Migrate CLI toward AppServerClient

Current CLI already uses an in-memory RPC transport but still returns direct runtime/store handles in deps.

Move interactive run/control paths to protocol client.

Admin/doctor may receive explicit admin/introspection services, but ordinary user interactions should not call `AgentRuntime` directly.

Target dependency:

```text
CLI
 ↓
SDK/AppServerClient
 ↓
App Server
 ↓
LoadedSessionManager
 ↓
Runtime
```

Add architecture test preventing:

```text
apps/cli
```

from importing `@ar/core` for ordinary execution after migration.

---

# PHASE 31 — Environment Snapshot & Execution Host Seam

> Priority: MEDIUM  
> Build local-first. Do not implement remote executor yet.

---

## P31-1 Replace naked cwd identity inside Step with EnvironmentSnapshot

Define:

```ts
interface EnvironmentSnapshot {
  readonly id: EnvironmentId;
  readonly cwd: string;
  readonly workspaceRoots: readonly string[];
  readonly shell: ShellSnapshot;
  readonly permissionsFingerprint: string;
  readonly capabilities: EnvironmentCapabilities;
  readonly fingerprint: string;
}
```

Local environment ID can be deterministic for session/workspace.

---

## P31-2 EnvironmentManager

```ts
interface EnvironmentManager {
  resolveForSession(session: PersistentSession): Promise<EnvironmentHandle>;
  snapshot(handle: EnvironmentHandle): Promise<EnvironmentSnapshot>;
}
```

Initial implementation:

```text
LocalEnvironmentManager
```

only.

---

## P31-3 Tool execution reads Step environment

File/shell/sandbox must use:

```text
step.environment
```

not `process.cwd()` or mutable global cwd.

Keep child isolated workspace support, but represent it as an environment/workspace root instead of an out-of-band map when practical.

---

## P31-4 Prepare executor seam without fake remote support

Define capability interface if useful:

```ts
interface Executor {
  filesystem: ExecutorFileSystem;
  exec(...): Promise<...>;
}
```

but only ship local executor.

Do not claim remote support.

---

# PHASE 32 — Skills & Instruction Snapshot Closure

> Priority: MEDIUM  
> Same world-snapshot principle as MCP/tools.

---

## P32-1 Skill snapshot identity

Current skill progressive disclosure is useful.

Add immutable selected snapshot:

```ts
interface SkillSnapshot {
  readonly fingerprint: string;
  readonly selected: readonly {
    name: string;
    source: string;
    bodyHash?: string;
    requiredTools: readonly string[];
    requiredMcpServers: readonly string[];
  }[];
}
```

---

## P32-2 Cache key must include config identity

Do not cache solely by cwd.

Key should include:

```text
cwd
skill roots
config fingerprint
plugin snapshot fingerprint
```

Prevent cross-session leakage when same cwd has different enabled/disabled skill config.

---

## P32-3 InstructionSnapshot

Capture:

```ts
interface InstructionSnapshot {
  readonly sources: readonly InstructionSource[];
  readonly systemHash: string;
  readonly fingerprint: string;
}
```

If AGENTS.md/project instruction changes mid-step:

- current step unchanged;
- next step may see new snapshot.

---

## P32-4 Skill → MCP dependency integration

If selected skill requires MCP server:

```text
skill selection
→ McpDependencyResolver
→ McpBindingSnapshot
→ StepToolRouter
```

Do not start all skill dependencies globally at process startup.

---

# PHASE 33 — Symphony-Style External Work Orchestration

> Priority: MEDIUM/LATER  
> This is above the Harness, not inside AgentRuntime.

---

## P33-1 Create independent orchestration package

Suggested:

```text
packages/orchestration/
├── work-item.ts
├── tracker.ts
├── workflow-loader.ts
├── reconciler.ts
├── scheduler.ts
├── retry-policy.ts
├── workspace-manager.ts
└── worker.ts
```

No dependency from core → orchestration.

Dependency:

```text
orchestration → SDK/AppServer client
```

not:

```text
orchestration → AgentRuntime internals
```

---

## P33-2 Generic WorkTracker

```ts
interface WorkTracker {
  listCandidates(): Promise<WorkItem[]>;
  read(ids: readonly WorkId[]): Promise<WorkItem[]>;
}
```

Do not start with GitHub/Linear-specific core logic.

Use fake tracker first.

---

## P33-3 Normalized WorkItem

```ts
interface WorkItem {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state: string;
  priority?: number;
  labels: string[];
  dispatchable: boolean;
  updatedAt?: number;
}
```

Provider-native opaque reference may be preserved without core interpretation.

---

## P33-4 Authoritative scheduler state

```ts
interface OrchestratorState {
  running: Map<WorkId, RunningEntry>;
  claimed: Set<WorkId>;
  blocked: Map<WorkId, BlockedEntry>;
  retries: Map<WorkId, RetryEntry>;
}
```

Invariants:

```text
running ⊆ claimed
retrying ⊆ claimed
running ∩ blocked = ∅
terminal eventually ∩ running = ∅
```

---

## P33-5 Reconcile before dispatch

Each tick:

```text
reload dynamic workflow config
reconcile running
reconcile blocked
reconcile retry eligibility
compute capacity
list candidates
revalidate candidate immediately before claim
claim
prepare workspace
start Harness thread through App Server
schedule next tick
```

Never only consume a queue and hope state remains valid.

---

## P33-6 Stop workers when external state invalidates them

Cases:

- item becomes terminal;
- item becomes inactive;
- item no longer assigned/routed;
- required label removed;
- explicit cancellation.

Worker gets `turn/interrupt`.

Workspace cleanup policy runs afterward.

---

## P33-7 Retry policy

Transient failures:

```text
exponential backoff + jitter
```

State change may cancel pending retry.

Use injected monotonic timer in tests.

No retry storm after restart.

---

## P33-8 Repository-owned WORKFLOW.md

Implement a minimal contract inspired by Symphony:

```md
---
tracker:
  kind: fake
polling:
  interval_ms: 30000
agent:
  max_concurrent: 4
workspace:
  root: .workspaces
---

Work on the assigned item.

Before handoff:
- inspect the repository
- implement the requested change
- run verification
- summarize evidence
```

Parser:

- optional YAML front matter;
- body = prompt template;
- unknown keys ignored for forward compatibility;
- invalid known fields fail with typed errors.

If adding a YAML dependency is undesirable, choose a documented alternative, but do not silently implement an incompatible pseudo-YAML parser.

---

## P33-9 Per-work-item workspace isolation

Reuse existing child workspace ideas.

Each item gets deterministic sanitized key + collision-resistant hash suffix.

No two distinct identifiers may accidentally share workspace.

---

## P33-10 Worker uses App Server, not Core

Worker:

```text
workspace
→ appServer thread/start
→ turn/start
→ consume events
→ react to tracker reconcile interruption
```

This validates the App Server boundary under a real higher-level consumer.

---

# PHASE 34 — Conformance, Chaos & Race Test Matrix

> Priority: REQUIRED before declaring v5 complete.

---

## P34-1 World-snapshot conformance suite

Create a top-level invariant suite with:

- tool catalog drift;
- MCP drift;
- policy drift;
- instruction drift;
- skill drift;
- model switch;
- context compaction;
- environment drift.

Every test asserts old Step immutable / new Step updated.

---

## P34-2 Same-session race suite

Randomize:

```text
turn start
steer
follow-up
cancel
approval response
ask response
MCP refresh
```

Assert no two `runTurn()` instances for same session overlap.

Use a concurrency probe, not sleeps-only assertions.

---

## P34-3 Tool side-effect crash suite

Use non-idempotent counter/file-append tool.

Inject crash across P26 boundaries.

Assert:

```text
automatic duplicate side effect count = 0
```

for every unsafe path.

---

## P34-4 MCP chaos

Cases:

- connect hangs;
- initialize timeout;
- server dies mid-call;
- tools/list schema changes;
- duplicate tool names;
- malformed schema;
- unused server unavailable;
- reconnect generation changes.

Old Step never silently binds new generation.

---

## P34-5 App Server protocol conformance

Test both:

```text
InMemoryTransport
StdioTransport
```

same contract fixtures.

Cases:

- request before initialize;
- duplicate initialize;
- unknown method;
- malformed params;
- overload;
- reconnect replay;
- duplicate idempotency key;
- interrupt active turn;
- steer active turn;
- concurrent turn rejection.

---

## P34-6 SDK conformance

Same protocol fixture:

- raw client;
- SDK runStreamed;
- SDK run.

Equivalent final state.

---

## P34-7 Config drift matrix

For each lifecycle class:

```text
process_static
session_frozen
turn_dynamic
step_dynamic
```

change config while active and verify documented behavior.

---

## P34-8 Security regression matrix

Must remain green:

- path traversal;
- symlink escapes;
- command injection;
- prompt injection;
- MCP tool-description injection;
- permission widening;
- approval over-reuse;
- unsafe retry;
- writable child workspace escape;
- secret leakage in protocol/config explain.

---

# PHASE 35 — Final Architecture Consolidation & Release Gate

---

## P35-1 Remove stale global dependencies after Step snapshot closure

After P23, search for production runtime reads of:

```text
global toolSpecs
global toolSelector
global registry resolve for model-originated calls
global MCP tool list
ctx.agent.tools for already-snapshotted step authority
```

Delete or narrow obsolete dependencies.

Do not keep two decision sources.

---

## P35-2 Update capability matrix truthfully

Add distinctions:

```text
implemented
productionWired
snapshotAuthoritative
durable
tested
```

Critical capabilities should not merely be “implemented”.

---

## P35-3 Architecture docs

Create/update:

```text
docs/architecture/runtime-scopes.md
docs/architecture/tool-snapshot.md
docs/architecture/session-actor.md
docs/architecture/durability.md
docs/architecture/app-server.md
docs/architecture/mcp-runtime.md
docs/architecture/orchestration.md
```

Each doc must state invariants, not only class diagrams.

---

## P35-4 Migration notes

Public changes:

- StepContext compatibility;
- RPC → App Server;
- SDK package;
- approval typed capability;
- config layers;
- MCP lazy semantics.

Document how old callers migrate.

---

## P35-5 Final commands

At minimum:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:coverage
pnpm docs:verify
```

Plus project-specific:

```text
production-audit
benchmark smoke
protocol conformance
chaos suite
```

Use exact CLI command available after implementation.

---

# 5. MANDATORY CODE-LEVEL INVARIANTS

These should be represented in tests, preferably with names containing the invariant identifier.

---

## INV-V5-001 — Model/Tool Router Identity

For every model-originated tool call:

```text
executedRouterFingerprint
==
advertisedRouterFingerprint
```

---

## INV-V5-002 — Tool Binding Identity

A call from Step S must resolve the tool binding captured by S, never a later global catalog binding.

---

## INV-V5-003 — MCP Generation Identity

A model call advertised using MCP generation G must execute using G or fail explicitly.

Never silently upgrade to G+1.

---

## INV-V5-004 — Policy Non-Widening

Global config changes after Step creation must not silently widen that Step's authority.

---

## INV-V5-005 — Single Active Turn

For a session:

```text
count(active executing turns) <= 1
```

always.

---

## INV-V5-006 — No Vanishing Model Tool Call

Every model-produced tool call must end in one observable settlement:

```text
success
failed
denied
timeout
cancelled
unknown_effect
```

No disappearance on abort.

---

## INV-V5-007 — Unsafe Side Effect Never Blind-Retried

Crash/timeout/unknown outcome of non-safe tool never triggers automatic re-execution.

---

## INV-V5-008 — Approval Cannot Broaden Authority

A cached approval matches only equal-or-narrower semantic capability.

---

## INV-V5-009 — Semantic Journal Sequence

Per session, committed journal sequence is unique and monotonic.

---

## INV-V5-010 — Protocol Isolation

Client/SDK packages do not import AgentRuntime internals.

---

## INV-V5-011 — Event Stream Is SDK Truth

`run()` result is derived from the same stream observable to `runStreamed()`.

---

## INV-V5-012 — Reconciliation Convergence

A work item that becomes ineligible eventually has no active worker.

---

# 6. EXACT IMPLEMENTATION ORDER

Do not parallelize phases that depend on unfinished semantics.

Recommended order:

```text
P23 Step snapshot closure
  ↓
P24 MCP Runtime V2
  ↓
P25 SessionActor
  ↓
P26 Durability fences
  ↓
P27 Config layers
  ↓
P28 Typed approval capability
  ↓
P29 App Server
  ↓
P30 SDK / CLI migration
  ↓
P31 Environment snapshot
  ↓
P32 Skills/instruction snapshot closure
  ↓
P33 Symphony orchestration
  ↓
P34 conformance/chaos
  ↓
P35 consolidation/release
```

Allowed parallel work:

- P27 config utility implementation can start after P23 contracts stabilize;
- protocol DTO design can begin while P26 is underway;
- documentation can be updated continuously.

Do not implement P30 SDK before P29 protocol semantics stabilize.

Do not implement P33 worker by reaching directly into Runtime just because App Server is unfinished.

---

# 7. CODING AGENT TASK PROCEDURE

For **each subtask**, execute this exact procedure.

---

## Step A — Source audit

Before editing:

1. identify all production callers;
2. identify all tests;
3. identify public exports;
4. identify compatibility constraints;
5. write a short implementation note in the task section.

Search for:

```text
imports
constructor deps
factory wiring
composition root
test fakes
CLI/web consumers
```

---

## Step B — State the invariant

Write one sentence:

```text
After this change, X must always be true.
```

If you cannot state it, you do not understand the task yet.

---

## Step C — Implement minimum coherent change

Avoid placeholder classes.

A new abstraction must have a production caller in the same subtask unless the plan explicitly marks it as preparatory.

---

## Step D — Add negative tests first

Examples:

- stale global tool must NOT execute;
- second turn must NOT run concurrently;
- unused broken MCP must NOT kill startup;
- broader approval must NOT reuse narrow grant.

Positive tests are not enough.

---

## Step E — Add integration test

At least one test must pass through the real composition path relevant to the task.

Examples:

```text
createHarness
→ runtime
→ fake model
→ tool call
```

not only:

```text
new StepToolRouter(...)
```

---

## Step F — Run focused tests

Example:

```bash
pnpm vitest run packages/core/src/runtime/step-snapshot.invariant.test.ts
```

Use actual repo command syntax.

---

## Step G — Run dependent packages

If modifying contracts:

```text
contracts + core + tools + harness + gateway + CLI
```

as applicable.

---

## Step H — Full validation

```bash
pnpm typecheck
pnpm test
pnpm build
```

Run coverage at phase gates.

---

## Step I — Update plan status with evidence

Use:

```md
Status: DONE

Implementation:
- ...

Regression Tests:
- ...

Production wiring:
- ...

Commands:
- `pnpm ...` → PASS
```

Do not write only:

```text
Status: DONE
```

---

# 8. RECOMMENDED CODE SKETCH — STEP TOOL ROUTER

This is illustrative; adapt naming to repository conventions.

```ts
export interface FrozenToolBinding {
  readonly name: string;
  readonly spec: ToolSpec;
  readonly definition: ToolDefinition;
  readonly semantics: ToolSemantics;
  readonly provenance: ToolProvenance;
  readonly fingerprint: string;
}

export class FrozenStepToolRouter implements StepToolRouter {
  readonly id: string;
  readonly fingerprint: string;
  readonly modelVisibleSpecs: readonly ToolSpec[];

  private readonly byName: ReadonlyMap<string, FrozenToolBinding>;

  constructor(bindings: readonly FrozenToolBinding[]) {
    const map = new Map<string, FrozenToolBinding>();

    for (const binding of bindings) {
      if (map.has(binding.name)) {
        throw new AgentError(
          errorInfo("TOOL_COLLISION", `duplicate step tool: ${binding.name}`),
        );
      }
      map.set(binding.name, binding);
    }

    this.byName = map;
    this.modelVisibleSpecs = Object.freeze(
      bindings.map((b) => deepFreezeSpec(b.spec)),
    );

    this.fingerprint = fingerprintToolBindings(bindings);
    this.id = `router:${this.fingerprint.slice(0, 16)}`;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  resolve(name: string): FrozenToolBinding | undefined {
    return this.byName.get(name);
  }
}
```

Do not rely on `Object.freeze` alone for security.

The important authority is that there is no mutation API and execution holds the binding reference.

---

# 9. RECOMMENDED CODE SKETCH — STEP SNAPSHOT FACTORY

```ts
export interface StepSnapshotFactoryDeps {
  toolRouterFactory: StepToolRouterFactory;
  environmentManager: EnvironmentManager;
  instructionProvider: InstructionSnapshotProvider;
  skillSnapshotProvider?: SkillSnapshotProvider;
  mcpBindingFactory?: McpBindingFactory;
  now?: () => number;
}

export class StepSnapshotFactory {
  constructor(private readonly deps: StepSnapshotFactoryDeps) {}

  async capture(input: {
    turn: TurnContext;
    working: WorkingState;
    modelContext: PreparedModelContext;
  }): Promise<StepExecutionSnapshot> {
    const environment = await this.deps.environmentManager.snapshotForTurn(input.turn);

    const skills = await this.deps.skillSnapshotProvider?.capture({
      turn: input.turn,
      goal: input.working.goal,
    });

    const mcp = await this.deps.mcpBindingFactory?.capture({
      goal: input.working.goal,
      skills,
      environment,
    });

    const tools = await this.deps.toolRouterFactory.capture({
      turn: input.turn,
      goal: input.working.goal,
      mcp,
      skills,
    });

    const instructions = await this.deps.instructionProvider.capture({
      turn: input.turn,
      environment,
    });

    const context = freezePreparedContext(input.modelContext);

    const record: StepRecord = {
      stepId: newStepId(),
      sessionId: input.turn.sessionId,
      turnId: input.turn.turnId,
      agentId: input.turn.agent.id,
      model: input.turn.agent.model,
      toolRouterFingerprint: tools.fingerprint,
      policyFingerprint: environment.permissionsFingerprint,
      environmentFingerprint: environment.fingerprint,
      contextFingerprint: context.fingerprint,
      instructionFingerprint: instructions.fingerprint,
      ...(mcp !== undefined ? { mcpBindingFingerprint: mcp.fingerprint } : {}),
      ...(skills !== undefined ? { skillSnapshotFingerprint: skills.fingerprint } : {}),
      createdAt: this.deps.now?.() ?? Date.now(),
    };

    return {
      record,
      agent: snapshotEffectiveConfig(input.turn.agent),
      environment,
      permissions: capturePermissionProfile(input.turn, environment),
      tools,
      model: captureModelSnapshot(input.turn.agent.model),
      context,
      instructions,
      ...(mcp !== undefined ? { mcp } : {}),
      ...(skills !== undefined ? { skills } : {}),
    };
  }
}
```

---

# 10. RECOMMENDED CODE SKETCH — SESSION ACTOR

```ts
export class SessionActor {
  private active: ActiveTurnHandle | undefined;
  private readonly followups: UserInput[] = [];

  constructor(
    readonly session: PersistentSession,
    private readonly runtime: AgentRuntime,
  ) {}

  async start(input: UserInput): Promise<TurnHandle> {
    if (this.active !== undefined) {
      throw new AgentError(
        errorInfo("SESSION_BUSY", `session ${this.session.id} already has an active turn`),
      );
    }

    const turn = await this.runtime.startTurn(this.session.id, input.text);
    const controller = new AbortController();

    const promise = this.runtime
      .runTurn(this.session.id, turn.id, controller.signal)
      .finally(() => {
        if (this.active?.turnId === turn.id) {
          this.active = undefined;
        }
      });

    this.active = {
      turnId: turn.id,
      controller,
      promise,
    };

    return {
      turnId: turn.id,
      outcome: promise,
    };
  }

  async steer(input: UserInput): Promise<void> {
    if (this.active === undefined) {
      throw new AgentError(errorInfo("NO_ACTIVE_TURN", "nothing to steer"));
    }

    await this.runtime.admitSteerInput({
      sessionId: this.session.id,
      turnId: this.active.turnId,
      input,
    });
  }

  async interrupt(): Promise<TurnOutcome | undefined> {
    const active = this.active;
    if (active === undefined) return undefined;

    active.controller.abort();
    return active.promise;
  }
}
```

Production implementation may need queue/drain locks; this sketch only shows the ownership rule.

---

# 11. RECOMMENDED CODE SKETCH — LAZY MCP

```ts
export class McpConnectionManager {
  private readonly states = new Map<McpServerId, ConnectionState>();

  constructor(
    private readonly catalog: McpServerCatalog,
    private readonly connector: McpConnector,
  ) {}

  async getOrConnect(
    id: McpServerId,
    signal: AbortSignal,
  ): Promise<McpConnectionGeneration> {
    const current = this.states.get(id);

    if (current?.kind === "ready") return current.generation;
    if (current?.kind === "connecting") return current.promise;

    const descriptor = this.catalog.get(id);
    if (descriptor === undefined || !descriptor.enabled) {
      throw new AgentError(errorInfo("MCP_NOT_CONFIGURED", `unknown MCP server ${id}`));
    }

    const promise = this.connector
      .connect(descriptor, signal)
      .then((connection) => {
        const generation = freezeMcpGeneration(connection);
        this.states.set(id, { kind: "ready", generation });
        return generation;
      })
      .catch((cause) => {
        this.states.set(id, {
          kind: "failed",
          error: normalizeMcpError(cause),
        });
        throw cause;
      });

    this.states.set(id, { kind: "connecting", promise });
    return promise;
  }
}
```

---

# 12. RECOMMENDED TEST PATTERN — TOOL WORLD DRIFT

```ts
it("executes the exact tool binding advertised by the originating step", async () => {
  const seen: string[] = [];

  registry.register(tool("write_x", async () => {
    seen.push("v1");
    return success("v1");
  }));

  const step = await factory.capture(...);

  // Simulate catalog refresh after the model request was formed.
  registry.unregister("write_x");
  registry.register(tool("write_x", async () => {
    seen.push("v2");
    return success("v2");
  }));

  const result = await executeModelCallFromStep(step, {
    name: "write_x",
    args: {},
  });

  expect(result.output).toBe("v1");
  expect(seen).toEqual(["v1"]);
});
```

The real test should flow through `AgentRuntime`, not just call router directly.

---

# 13. RECOMMENDED TEST PATTERN — SAME-SESSION TURN RACE

```ts
it("never executes two turns concurrently inside one session", async () => {
  let active = 0;
  let maxActive = 0;

  modelProvider.blockGenerate(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gate.wait();
    active -= 1;
    return completed();
  });

  const thread = await app.threadStart(...);

  const a = app.turnStart(thread.id, "A");
  await modelProvider.waitUntilEntered();

  const b = app.turnStart(thread.id, "B");

  await expect(b).rejects.toMatchObject({
    code: "SESSION_BUSY",
  });

  gate.release();
  await a;

  expect(maxActive).toBe(1);
});
```

Also test different sessions reach maxActive=2.

---

# 14. WHAT NOT TO CLAIM AFTER THIS PLAN

Even if P23–P35 pass, do not claim:

- “identical to Codex”;
- “Codex-compatible protocol” unless intentionally tested against Codex;
- “remote execution” if only local environment seam exists;
- “exactly-once side effects” for arbitrary external systems.

Correct claim:

```text
The Harness binds model actions to immutable execution snapshots,
serializes live turns per session, uses lazy generation-pinned MCP bindings,
records explicit durability boundaries, and exposes a versioned App Server
protocol with a stream-first SDK.
```

For side effects, prefer:

```text
at-most-once automatic retry for unsafe actions + unknown-effect reconciliation
```

rather than mathematically false “exactly once”.

---

# 15. FINAL ACCEPTANCE CHECKLIST

Do not mark Harness v5 complete unless every checkbox can be proven.

## Step/world

- [ ] exact advertised tool set frozen before sampling
- [ ] execution resolves same frozen binding
- [ ] policy authority frozen
- [ ] context identity frozen
- [ ] reactive compaction creates new sampling snapshot
- [ ] MCP generation frozen per step
- [ ] instruction/skill snapshot identity available

## Session

- [ ] one active turn per session
- [ ] steer is explicit
- [ ] follow-up queue explicit
- [ ] cancel settles tool calls correctly
- [ ] loaded runtime state separated from durable session

## Durability

- [ ] event sequence allocation atomic
- [ ] semantic journal events identified
- [ ] side-effect intent durable
- [ ] side-effect outcome durable
- [ ] checkpoint boundary durable
- [ ] resume classifies unknown effects
- [ ] crash matrix has zero automatic duplicate unsafe effects

## MCP

- [ ] startup does not connect every server
- [ ] unused broken server does not kill Harness
- [ ] same server concurrent need single-flights connect
- [ ] refresh creates new generation
- [ ] old Step keeps old generation
- [ ] lifecycle closes all connected servers

## Approval

- [ ] typed capability identity
- [ ] canonical fingerprint
- [ ] scope actually controls reuse
- [ ] broader request cannot reuse narrower grant
- [ ] audit log preserved

## Protocol

- [ ] initialize required
- [ ] Thread/Turn/Item DTOs independent from Core
- [ ] bounded queues/backpressure
- [ ] interrupt
- [ ] steer
- [ ] replay from sequence
- [ ] idempotent mutating requests
- [ ] schema/golden tests

## SDK

- [ ] no Core dependency
- [ ] runStreamed primary
- [ ] run is reducer
- [ ] AbortSignal reaches server interrupt
- [ ] CLI ordinary execution uses client boundary

## Orchestration

- [ ] generic WorkTracker
- [ ] reconciliation before dispatch
- [ ] state invalidation stops worker
- [ ] bounded concurrency
- [ ] retry backoff
- [ ] isolated workspaces
- [ ] worker drives Harness through App Server

## Release

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm test:coverage`
- [ ] `pnpm docs:verify`
- [ ] production audit
- [ ] benchmark smoke
- [ ] protocol conformance
- [ ] chaos/race suite
- [ ] capability matrix updated
- [ ] migration notes updated

---

# 16. PRIORITY IF TIME IS LIMITED

If implementation resources become constrained, **do not start more surface area**.

Ship in this order:

## Tier 0 — must do

```text
P23 Step snapshot closure
P25 SessionActor
```

These fix correctness.

## Tier 1 — next

```text
P24 MCP Runtime V2
P26 Durability fences
P28 typed approval identity
```

These fix dynamic authority and reliability.

## Tier 2 — service boundary

```text
P29 App Server
P30 SDK
```

These make the Harness consumable as a platform.

## Tier 3 — extensibility

```text
P27 Config layers
P31 Environment seam
P32 skill/instruction snapshot
```

## Tier 4 — long-running automation

```text
P33 Symphony orchestration
```

Do not sacrifice Tier 0 correctness to finish Tier 4 features.

---

# 17. FINAL INSTRUCTION TO THE CODING AGENT

Your objective is **not** to make the repository contain more classes.

Your objective is to make the following statements mechanically true and testable:

```text
1. I can prove which exact world snapshot produced every model-originated action.

2. I can prove the model-advertised tool schema and the executed tool binding
   came from the same frozen router.

3. I can change global MCP/config/tool state without retroactively changing an
   already-issued model action.

4. I can never accidentally run two turns concurrently against one session.

5. I can point to a durable semantic boundary before and after a side effect.

6. I can crash in any tested side-effect window without blindly duplicating an
   unsafe action.

7. A client can drive the complete Agent lifecycle without importing Core.

8. A higher-level reconciler can schedule many independent work items using
   only the public App Server/SDK boundary.
```

When these are true, the project has moved beyond “feature-rich agent runtime”.

It has become a coherent **Agent Harness runtime platform**.

Do each phase carefully.

Do not mark tasks DONE based on declarations.

Prove the invariant through the production path.
