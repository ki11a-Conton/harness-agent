import type {
  ModelEvent,
  ModelProvider,
  ModelRef,
  ProviderConfig,
  ToolCall,
  ToolSpec,
} from "@ar/contracts";
import { errorInfo, newToolCallId } from "@ar/contracts";
import {
  createNonBillableFixtureTransport,
  type NonBillableFixtureTransport,
} from "@ar/evaluation";
import { captureEndpointIdentity, PROVIDER_DEFAULT_ENDPOINT_DIGEST } from "@ar/evaluation";

export const STUB_PROVIDER_ID = "stub";

/** The model id reported for the stub provider (E4-R81: named once, so the plan
 *  identity and the executor cannot drift apart on the literal). */
export const STUB_MODEL_ID = "stub-model";

/** Default model id for a REAL provider when `OPENAI_MODEL` is unset. Named
 *  once here (the provider-identity source) so the observer, the prerun
 *  resolution and `main.ts`'s `DEFAULT_MODEL_ID` cannot drift apart. */
export const DEFAULT_REAL_MODEL_ID = "gpt-4o-mini";

/**
 * E4-R81 (F81-1): the ONLY externally-billed provider this build supports.
 *
 * `--provider` accepts exactly this id. The plan identity must not be an
 * arbitrary free-text string that merely *looks* configured: an unsupported id
 * would let an operator authorize a plan naming a provider that cannot actually
 * be resolved at execution time.
 */
export const REAL_PROVIDER_ID = "openai";

/** The provider id the environment currently implies, if any. */
export function envProviderId(): string {
  return (process.env.OPENAI_MODEL ?? "") !== "" || process.env.OPENAI_API_KEY ? REAL_PROVIDER_ID : STUB_PROVIDER_ID;
}

// ---------------------------------------------------------------------------
// Billing class — E3-01: provider billing classification
// ---------------------------------------------------------------------------

export type BillingClass = "offline-test" | "local-no-cost" | "external-billed";

export interface BillingProvider {
  provider: ModelProvider;
  billingClass: BillingClass;
}

/** Determine the billing class for a provider id + API key presence.
 *  The stub provider and any provider without an API key are "offline-test".
 *  A real OpenAI-compatible provider with an API key is "external-billed".
 *  "local-no-cost" is reserved for future local-only providers (e.g. Ollama). */
export function billingClassForProvider(
  providerId: string,
  apiKeyPresent: boolean,
): BillingClass {
  if (providerId === STUB_PROVIDER_ID) return "offline-test";
  if (apiKeyPresent) return "external-billed";
  return "offline-test";
}

/** Placeholder provider: makes missing configuration a structured, visible
 *  failure (agent doctor flags it; runs fail with MODEL_ERROR). */
export function stubProvider(): ModelProvider {
  return {
    id: STUB_PROVIDER_ID,
    async listModels() {
      return [];
    },
    createClient() {
      return {
        async *generate(): AsyncGenerator<ModelEvent, void, void> {
          yield {
            type: "error",
            error: errorInfo(
              "MODEL_ERROR",
              "no model provider configured — set OPENAI_API_KEY and restart",
            ),
            timestamp: 0,
          };
        },
      };
    },
  };
}

export interface ResolveModelProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  /** E4-R83 (F83-1): explicit model identity. The provider must be constructed
   *  with the SAME identity the plan digest binds — otherwise the digest is
   *  bound to --model/--endpoint but the actual HTTP request would fall back
   *  to the environment or the provider's built-in default. */
  modelId?: string;
}
/**
 * Default model provider resolution: when OPENAI_API_KEY is present, load the
 * OpenAI-compatible provider from @ar/model; otherwise fall back to the stub
 * (the doctor reports the difference as a WARNING).
 *
 * E3-01: returns a BillingProvider with the billing class alongside the
 * provider so the CLI can enforce the paid guard before any call.
 */
export async function resolveModelProvider(
  opts: ResolveModelProviderOptions = {},
): Promise<BillingProvider> {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return { provider: stubProvider(), billingClass: "offline-test" };
  }
  const provider = await tryLoadOpenAICompatibleProvider(apiKey, opts.baseUrl, opts.modelId);
  if (provider === undefined) {
    return { provider: stubProvider(), billingClass: "offline-test" };
  }
  return { provider, billingClass: "external-billed" };
}

async function tryLoadOpenAICompatibleProvider(
  apiKey: string,
  baseUrl?: string,
  modelId?: string,
): Promise<ModelProvider | undefined> {
  try {
    // @ar/model's OpenAICompatibleProvider (packages/model/src/openai.ts) is
    // being added by a parallel session. The structural cast keeps this code
    // valid both before and after that file lands: a missing export simply
    // resolves to the stub provider.
    const mod = (await import("@ar/model")) as {
      OpenAICompatibleProvider?: new (config: {
        apiKey?: string;
        baseUrl?: string;
        modelId?: string;
      }) => ModelProvider;
    };
    const Provider = mod.OpenAICompatibleProvider;
    if (Provider === undefined) return undefined;
    return new Provider({
      apiKey,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(modelId !== undefined ? { modelId } : {}),
    });
  } catch {
    return undefined;
  }
}

// ===========================================================================
// S3 / F4 — THE BUILT-IN OFFLINE FORWARD PROFILE (Phase A)
// ===========================================================================
//
// WHY THIS EXISTS (plan(20260929-015956).md §7, defect F4)
// -------------------------------------------------------
// R1 correctly turned the release CLI's fixture forward run into a REFUSAL
// (`FIXTURE_TRANSPORT_NOT_NON_BILLABLE`), because an endpoint ADDRESS is not
// evidence about billing. What F4 left behind is that a real, controlled,
// completely NON-BILLED forward run through `node apps/cli/dist/main.js` has no
// acceptance evidence at all: `stubProvider()` below yields exactly one
// `MODEL_ERROR` event and therefore CANNOT drive a content task through a real
// `write_file`.
//
// This section supplies the missing half. It is the ONLY place in this build
// that constructs a transport which is *provably* unable to bill, and it makes
// the three things that could go wrong impossible by CONSTRUCTION:
//
//   1. NO SILENT FALLBACK FOR AN UNKNOWN PROFILE.
//      The profile id is a closed, versioned, repository-fixed union. An
//      unknown id is a REFUSAL result — never the stub, never the real
//      provider, never a default profile.
//
//   2. NO OPERATOR MODULE, NO NETWORK, EVER.
//      The profile's transport is scripted in-process. There is no `import()`
//      of a user-supplied path, no `fetch`, no socket, no `http`/`https`. The
//      script is a frozen table in this file, so the answer for a given turn
//      index is fixed at build time.
//
//   3. NO LAUNDERING OF AN ARBITRARY PAID ENDPOINT.
//      `createNonBillableFixtureTransport` is exported to production, so
//      *hiding* it cannot be the trust boundary. The boundary is BINDING: this
//      factory does not accept free-form identity. It takes the OBSERVED
//      identity, re-derives the endpoint digest through the SAME
//      `captureEndpointIdentity` the observer and the gate use, and refuses
//      unless every component is exactly the one on record for this process.
//      A production caller therefore cannot mint a capability for an endpoint
//      it is not already observed to be running against.

/** The version of the offline profile vocabulary. Bump only when the id set,
 *  the refusal semantics or the binding rules change. */
export const OFFLINE_PROFILE_SCHEMA_VERSION = "ar.cli.offlineProfile.v1";

/**
 * THE CLOSED ENUM. Repository-fixed, versioned. Adding a member is a reviewed
 * source change; nothing in `process.env`, in a JSON artifact, in a CLI flag or
 * in a marker file can add one.
 */
export type OfflineProfileId = "offline-scripted-content-v1" | "offline-refusal-v1";

/** The known profiles, frozen so a caller cannot mutate the vocabulary. */
export const KNOWN_OFFLINE_PROFILE_IDS: readonly OfflineProfileId[] = Object.freeze([
  "offline-scripted-content-v1",
  "offline-refusal-v1",
]);

/** The profile that can drive a CONTENT task through a real `write_file`. */
export const OFFLINE_CONTENT_PROFILE_ID = "offline-scripted-content-v1";

/** The profile that can drive NOTHING: a structured refusal, kept so the
 *  pure-refusal path still has a first-class, testable identity. */
export const OFFLINE_REFUSAL_PROFILE_ID = "offline-refusal-v1";

/** Runtime type guard for the closed enum (the array is the single source). */
export function isOfflineProfileId(value: unknown): value is OfflineProfileId {
  return typeof value === "string" && (KNOWN_OFFLINE_PROFILE_IDS as readonly string[]).includes(value);
}

/** The provider id/model id this build reports for an offline profile. Named
 *  once so the plan identity, the observation and the capability cannot drift
 *  apart on the literal. */
export const OFFLINE_PROVIDER_ID = "offline-scripted";
export const OFFLINE_MODEL_ID = "offline-scripted-model";

// ---------------------------------------------------------------------------
// The scripted content task
// ---------------------------------------------------------------------------

/**
 * N2 (F30-4) — the VERSION of the scripted content task table.
 *
 * Bumped when the target, the bytes or the mapping changes, so an artifact/report
 * can state WHICH task script produced a forward run instead of implying that
 * every `offline-scripted-content-v1` run wrote the same thing.
 */
export const OFFLINE_CONTENT_SCRIPT_VERSION = "offline-scripted-task-v1";

/**
 * N2 (F30-4) — THE TASK THE SCRIPT WRITES, AND WHY IT IS A REAL FROZEN CASE.
 *
 * The previous table wrote `offline-forward-proof.txt` with a self-invented
 * marker. No frozen verifier reads that file, so "the offline profile can drive a
 * content task" could never be measured — the proof stopped at "a tool REQUEST
 * was emitted" (see the honest NOT_PROVEN note the Phase D test had to carry).
 *
 * The table now writes the file the FROZEN, NON-HOLDOUT case
 * `regression/reg-22-api-stub` requires, so the case's OWN committed verifier
 * command decides PASS/FAIL. That is what makes a full
 * `runtime → tool dispatch → verifier` forward run measurable on the release
 * entry point instead of inferred.
 *
 * WHY THIS CASE (each is a measured property of the committed case):
 *   1. it is in the committed frozen selection
 *      (`docs/evidence/tool-call-efficiency-case-selection.json`) and NOT in
 *      `benchmarks/holdout`;
 *   2. its fixture is ONE file (`server.js`) the scripted model can write
 *      EXACTLY, so the script needs NEITHER more turns NOR a fabricated verdict;
 *   3. its verifier is a REAL behavioural check — it loads the written file,
 *      binds an ephemeral LOOPBACK port, requests `GET /health` and requires 200
 *      plus `{"ok":true}` — so only a correct write passes it;
 *   4. it is CommonJS over Node built-ins, so it depends neither on ESM syntax
 *      detection nor on a `node --test <dir>` argument form whose behaviour
 *      differs between Node 22 (CI) and Node 24 (measured locally): the same
 *      bytes decide the same way on both.
 *
 * It binds a loopback socket on an ephemeral port and nothing else: no external
 * endpoint, no credential, no billed request.
 *
 * The case itself is NOT modified: nothing under `benchmarks/` changes.
 *
 * Repository-fixed: never read from an artifact or the environment.
 */
export const OFFLINE_CONTENT_TASK = Object.freeze({
  /** The suite the target case lives in (also the `benchmarks/` subdirectory). */
  suite: "regression",
  /** The frozen case this scripted task serves. */
  caseId: "reg-22-api-stub",
  /**
   * The path the scripted model asks `write_file` to write, relative to the
   * case's workspace. It is the SAME file the case fixture ships (`server.js`),
   * so the run is a real edit of real fixture bytes — not a new demo file.
   */
  outputPath: "server.js",
  /** The exact bytes it writes. The verifier's "correct content" is this. */
  content: [
    "const http = require('http');",
    "",
    "const server = http.createServer((req, res) => {",
    "  if (req.url === '/health') {",
    "    res.writeHead(200, { 'content-type': 'application/json' });",
    "    res.end(JSON.stringify({ ok: true }));",
    "    return;",
    "  }",
    "  res.writeHead(404);",
    "  res.end();",
    "});",
    "",
    "module.exports = server;",
    "",
  ].join("\n"),
  /**
   * The one-dimension-wrong control: the fixture's OWN (unfixed) bytes, which
   * answer 404 for every path. Derived from the passing positive by removing
   * exactly the `/health` branch, so the case's own verifier really fails and the
   * derived negative cannot be vacuous.
   */
  wrongContent: [
    "const http = require('http');",
    "",
    "const server = http.createServer((req, res) => {",
    "  res.writeHead(404);",
    "  res.end();",
    "});",
    "",
    "module.exports = server;",
    "",
  ].join("\n"),
});

/**
 * The scripted turn table for the content profile. Each entry is the set of
 * provider events for ONE `generate()` call, in order:
 *
 *   turn 0 — call `write_file` with the fixed task args (finishReason
 *            "tool_calls"), so the runtime really executes the tool;
 *   turn 1..N-1 — emit the final assistant text only, once the tool result has
 *            come back, so the task COMPLETES rather than looping.
 *
 * S3/F4-GAP2 — EXHAUSTION IS EXPLICIT. The table is DELIBERATELY NOT clamped.
 * A run that asks for more turns than the script has is a SCRIPT-EXHAUSTION
 * FAILURE, and it must be distinguishable from a content/verifier failure: a
 * clamped table would keep answering with plausible terminal text, so an
 * over-long run would surface as a confusing red verifier assertion ("the
 * answer is wrong") rather than "the script ran out". See
 * `offlineScriptExhaustedEvents`.
 *
 * S3/F4-PHASEC — WHY THE TURN COUNT IS 3, FROM MEASUREMENTS (not tuning).
 * ---------------------------------------------------------------------
 * The count is NOT chosen to make a test pass. It comes from the recorded
 * real-model behaviour of the frozen content case `reg-12-csv-parse`
 * (`.ci/bench-grok/results/regression/reg-12-csv-parse/` and the
 * `benchmarks/results/*` artifacts), whose `model_calls` were observed as:
 *
 *     11  (termination: model_error)
 *     13  (termination: verified_complete — the case PASSING)
 *     20  (termination: tool_limit)
 *     28  (termination: verification_failed) — seen in four artifacts
 *
 * So a REAL content case uses 11–28 model calls; it NEVER converges in ≤2. The
 * earlier value of 2 was therefore wrong for real content work, and the honest
 * fix is to state the number and its evidence rather than let a Phase D test
 * discover it. 3 is the MINIMUM that lets a case complete
 * (call 1 = the write, calls 2..3 = the terminal answer with one spare for a
 * retry/steer), and it is deliberately NOT 30: padding to the
 * `maxIterationsPerTurn: 30` ceiling would fabricate a run shape no real loop
 * produces, and every extra scripted turn is a turn that cannot fail.
 *
 * KNOWN LIMITATION (stated for Phase D, not hidden): a real content case that
 * genuinely needs 11–28 model calls WILL hit `OFFLINE_SCRIPT_EXHAUSTED` at call
 * 4. That is the intended, explicit behaviour — it reports script exhaustion
 * rather than faking a pass. Raising this constant is a one-line, reviewable
 * change once Phase D measures what the offline content case actually needs.
 */
export const OFFLINE_CONTENT_SCRIPT_TURNS = 3;

/** The greppable reason code emitted when the script is exhausted.
 *
 *  NOTE ON `errorInfo`: `ErrorCode` is a CLOSED union in `@ar/contracts`, so a
 *  provider cannot invent a new code. The exhaustion is therefore carried as
 *  `INTERNAL_ERROR` (structurally correct: the harness/script contract is
 *  broken) with this constant as a greppable, machine-matchable marker in the
 *  message — `error.message.startsWith(OFFLINE_SCRIPT_EXHAUSTED_CODE)`. */
export const OFFLINE_SCRIPT_EXHAUSTED_CODE = "OFFLINE_SCRIPT_EXHAUSTED";

/**
 * The REAL runtime loop (`packages/core/src/runtime/runtime.ts` L933) is
 * `for (let i = 0; i < maxIterationsPerTurn; i++)`, and the benchmark wires
 * `maxIterationsPerTurn: 30` (`apps/cli/src/benchmark-command.ts` L2247/L2727;
 * the runtime default is 20). So the worst case is a BOUNDED, KNOWN number of
 * `generate()` calls per turn — but it is bounded by the LIMIT, not by this
 * script. The script answers `OFFLINE_CONTENT_SCRIPT_TURNS` of those and then
 * fails loudly, which is the honest behaviour.
 */
export const OFFLINE_CONTENT_MAX_MODEL_CALLS_EXPECTED = OFFLINE_CONTENT_SCRIPT_TURNS;

/** The structured exhaustion failure: never a fabricated final answer. */
function offlineScriptExhaustedEvents(index: number): ModelEvent[] {
  const detail =
    `${OFFLINE_SCRIPT_EXHAUSTED_CODE}: the built-in offline content script has ` +
    `${OFFLINE_CONTENT_SCRIPT_TURNS} turn(s) (profile ${OFFLINE_CONTENT_PROFILE_ID}) but the caller asked for ` +
    `model call #${index} — the scripted profile cannot answer beyond its table, so this is a SCRIPT-EXHAUSTION ` +
    `failure and not a content/verifier failure. Raise OFFLINE_CONTENT_SCRIPT_TURNS if the real loop legitimately ` +
    `needs more calls, or fix the loop/limit that is driving the extra call.`;
  return [
    { type: "started", timestamp: 0 },
    { type: "error", error: errorInfo("INTERNAL_ERROR", detail), timestamp: 0 },
  ];
}

function offlineContentTurn(index: number): ModelEvent[] {
  if (index === 0) {
    const call: ToolCall = {
      id: newToolCallId(),
      name: "write_file",
      args: { path: OFFLINE_CONTENT_TASK.outputPath, content: OFFLINE_CONTENT_TASK.content },
    };
    return [
      { type: "started", timestamp: 0 },
      { type: "text_delta", text: "writing the offline proof file", timestamp: 0 },
      { type: "tool_call_delta", toolCall: call, timestamp: 0 },
      { type: "usage", usage: { inputTokens: 0, outputTokens: 0 }, timestamp: 0 },
      {
        type: "completed",
        result: { finishReason: "tool_calls", toolCalls: [call], usage: { inputTokens: 0, outputTokens: 0 } },
        timestamp: 0,
      },
    ];
  }
  // Turns 1..N-1 (see OFFLINE_CONTENT_SCRIPT_TURNS) are the terminal answer:
  // the tool result has come back, so the task completes instead of looping.
  if (index < OFFLINE_CONTENT_SCRIPT_TURNS) {
    const text = `wrote ${OFFLINE_CONTENT_TASK.outputPath}`;
    return [
      { type: "started", timestamp: 0 },
      { type: "text_delta", text, timestamp: 0 },
      { type: "usage", usage: { inputTokens: 0, outputTokens: 0 }, timestamp: 0 },
      { type: "completed", result: { finishReason: "stop", text, usage: { inputTokens: 0, outputTokens: 0 } }, timestamp: 0 },
    ];
  }
  // NO CLAMP. An index past the table is an explicit, greppable failure.
  return offlineScriptExhaustedEvents(index);
}

/**
 * N2 (F30-3) — WHY THE SCRIPT CURSOR IS CONVERSATION-SCOPED, AND WHY IT IS
 * DERIVED FROM THE REQUEST'S OWN TRANSCRIPT.
 *
 * MEASURED DEFECT. The cursor used to be `let turn = 0` in the PROVIDER INSTANCE
 * body. The release driver builds ONE provider for the whole campaign and calls
 * `provider.createClient(...)` for EVERY model request, so two arm-runs of the
 * same campaign shared one cursor: the baseline consumed turns 0/1 and the
 * candidate started at turn 2 — already past its "write the file" step — and then
 * ran off the end of the 3-turn table. The second arm could therefore never
 * perform the task, and a resume/repetition inherited whatever the previous arm
 * had eaten. That is a CROSS-ARM exhaustion, i.e. the arms were not independent.
 *
 * WHY NOT `createClient`. Moving the counter into `createClient` is the tempting
 * one-line "fix" and it is WRONG for the same measurement: the driver creates a
 * NEW client for every model request, so every request would restart at step 0 —
 * the run would write the file forever and never terminate.
 *
 * THE SCOPE THAT MATCHES THE PROTOCOL. A model request's own transcript IS the
 * conversation state, and it is the only thing the provider is actually given.
 * The step is therefore derived from the request:
 *
 *   step = how many ASSISTANT messages the transcript already carries
 *
 * which is exactly "how many model turns this conversation has completed". That
 * makes the cursor per-CONVERSATION (one `runtime.createSession` per arm-run, per
 * case, per repetition), so:
 *
 *   - two arms, several repetitions and a changed order never share a cursor;
 *   - a RESUME re-derives the step from the transcript it is given;
 *   - a RETRY re-sends the same transcript and therefore resolves to the SAME
 *     step — a retry cannot silently advance the script;
 *   - and because the transcript is what the model sees, "the script answered
 *     from where the conversation is" is a property of the request rather than a
 *     hidden mutable counter.
 *
 * A monotone HIGH-WATER mark per conversation guards the one way the transcript
 * can move backwards (context trimming/compaction): a trimmed transcript must
 * never rewind the script into re-writing a file it already wrote.
 *
 * IDENTITY-LESS REQUESTS keep the historical sequential behaviour, so a caller
 * that drives the provider directly with `{ messages: [] }` sees exactly the
 * table order it saw before (and the pinned Phase B tests keep their meaning).
 */
const ANONYMOUS_CONVERSATION = "<no-conversation-identity>";

/**
 * The conversation a request belongs to, and how many model turns of it the
 * request's transcript already shows.
 *
 * A request with NO transcript identity (no `messages`, or messages that carry no
 * `sessionId`) is NOT guessed into a conversation: it is reported as
 * identity-less and handled by the historical anonymous counter.
 */
function conversationProgressOf(request: unknown): { key: string | null; observed: number } {
  const messages = (request as { messages?: unknown } | null | undefined)?.messages;
  if (!Array.isArray(messages)) return { key: null, observed: 0 };
  let key: string | null = null;
  let observed = 0;
  for (const raw of messages) {
    if (raw === null || typeof raw !== "object") continue;
    const message = raw as { role?: unknown; sessionId?: unknown };
    if (message.role === "assistant") observed += 1;
    if (key === null && typeof message.sessionId === "string" && message.sessionId !== "") {
      key = message.sessionId;
    }
  }
  return { key, observed };
}

/**
 * A provider that can drive a CONTENT task and provably never touches a
 * network. It is deliberately NOT `stubProvider()`: the stub's single
 * `MODEL_ERROR` cannot request a tool call, so it can never produce a real
 * `write_file`. It is also deliberately NOT the operator's transport: every
 * value it emits comes from the frozen table above.
 */
export function createOfflineScriptedProvider(input?: {
  providerId?: string;
  modelId?: string;
  /** Called with the tool specs each `generate()` was offered, so a test can
   *  assert the tool was really ADVERTISED before it was called. */
  onTurn?: (turn: number, tools: readonly ToolSpec[]) => void;
  /** S3/F4-GAP2: called when a run asks for more turns than the script has.
   *  The stream ALSO yields a structured error — this is for observability. */
  onExhausted?: (index: number) => void;
}): ModelProvider {
  const id = input?.providerId ?? OFFLINE_PROVIDER_ID;
  const modelId = input?.modelId ?? OFFLINE_MODEL_ID;
  /**
   * N2 (F30-3) — the per-CONVERSATION script cursor (see the doc block above).
   * Keyed by the transcript's own session identity, so the provider can be shared
   * by every arm, repetition and repetition-order without the arms interfering.
   */
  const conversationCursor = new Map<string, number>();
  /** N2 (F30-3) — the historical cursor for requests that carry no conversation
   *  identity at all. Unchanged single-consumer behaviour. */
  let anonymousTurn = 0;
  return {
    id,
    async listModels() {
      return [{ id: modelId, name: "Offline Scripted (built-in, no network)", capabilities: { toolCalling: true } }];
    },
    createClient(_model: ModelRef, _config: ProviderConfig) {
      return {
        async *generate(request: unknown): AsyncGenerator<ModelEvent, void, void> {
          const progress = conversationProgressOf(request);
          let index: number;
          if (progress.key === null) {
            index = anonymousTurn;
            anonymousTurn += 1;
          } else {
            const highWater = conversationCursor.get(progress.key) ?? 0;
            index = Math.max(progress.observed, highWater);
            conversationCursor.set(progress.key, index);
          }
          input?.onTurn?.(index, (request as { tools?: readonly ToolSpec[] }).tools ?? []);
          if (index >= OFFLINE_CONTENT_SCRIPT_TURNS) input?.onExhausted?.(index);
          // Zero I/O. The events are produced from the frozen table.
          yield* offlineContentTurn(index);
        },
      };
    },
  };
}

/**
 * The PURE-REFUSAL transport: it can drive nothing and says so structurally.
 * This is the ONLY legitimate use of the stub shape, and it is kept separate
 * from the content profile precisely so a content task can never be "driven"
 * by an error event.
 */
export function createOfflineRefusalProvider(): ModelProvider {
  return stubProvider();
}

// ---------------------------------------------------------------------------
// The laundering counters (the counting proof)
// ---------------------------------------------------------------------------

/** Why a real transport is considered constructible from the environment. */
export interface OfflineProfileRefusal {
  readonly ok: false;
  readonly code: "UNKNOWN_OFFLINE_PROFILE_ID" | "REAL_PROVIDER_CONFIGURATION_PRESENT" | "OBSERVED_IDENTITY_MISMATCH";
  readonly reason: string;
}

/** The observed identity a capability must be bound to. */
export interface OfflineObservedIdentity {
  readonly providerId: string;
  readonly modelId: string;
  readonly endpointBaseUrl: string | null;
}

export interface OfflineProfileCapability {
  readonly ok: true;
  readonly profileId: OfflineProfileId;
  readonly endpointDigest: string;
  readonly provider: ModelProvider;
  /** The branded capability, created by `@ar/evaluation` in THIS call. */
  readonly capability: NonBillableFixtureTransport;
}

export type OfflineProfileResolution = OfflineProfileCapability | OfflineProfileRefusal;

export interface ResolveOfflineProfileOptions {
  /** The candidate id. NOTHING but a member of the closed enum is accepted. */
  profileId: unknown;
  /** The identity ACTUALLY observed for this process. Required. */
  identity: OfflineObservedIdentity;
  /** The environment to test for a real provider. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: the network-effect counter. */
  counters?: OfflineProfileCounters;
}

/**
 * Whether `env` contains a REAL provider configuration — i.e. whether
 * `envProviderId(env)` says a credential-bearing provider could be built from
 * it. Keyed on the SAME function the rest of the CLI uses, so the test cannot
 * disagree with the product about what "configured" means.
 */
export function envHasRealProviderConfiguration(env: NodeJS.ProcessEnv = process.env): boolean {
  return envProviderIdFrom(env) !== STUB_PROVIDER_ID;
}

/** `envProviderId()` with an injectable record (this build is not permanently
 *  permitted to read the operator's real environment in a test). */
export function envProviderIdFrom(env: NodeJS.ProcessEnv): string {
  return (env["OPENAI_MODEL"] ?? "") !== "" || env["OPENAI_API_KEY"] ? REAL_PROVIDER_ID : STUB_PROVIDER_ID;
}

export interface OfflineProfileCounters {
  /** Times the REAL provider constructor path was entered. ONLY
   *  `instrumentedRealProviderFactory` may increment this — the offline
   *  factory must never touch it, or the quantity being proved (a genuine 0)
   *  would be destroyed. */
  realProviderFactoryEntries: number;
  /** Times a transport was constructed. The offline factory DOES increment
   *  this: it really does build a transport, just not a network-capable one. */
  networkTransportConstructions: number;
}

export function createOfflineProfileCounters(): OfflineProfileCounters {
  return { realProviderFactoryEntries: 0, networkTransportConstructions: 0 };
}

/**
 * THE COUNTER-EXAMPLE ENTRY POINT.
 *
 * This is the ONLY sanctioned way to enter the real, credential-bearing
 * provider path. It increments the counter FIRST and unconditionally, so the
 * count is a MEASURED fact about this process rather than an assertion about
 * which branch was taken. A test can then drive a full offline profile run and
 * assert the count stayed 0 — and, symmetrically, point the SAME code at a
 * real-provider environment and watch the count move.
 *
 * Note the count is incremented even when the load FAILS (no `@ar/model`, no
 * key): "the real factory was never entered" is the claim being proved, and a
 * failed attempt is still an entry.
 */
export async function instrumentedRealProviderFactory(
  counters: OfflineProfileCounters,
  opts: ResolveModelProviderOptions = {},
): Promise<BillingProvider> {
  counters.realProviderFactoryEntries += 1;
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return { provider: stubProvider(), billingClass: "offline-test" };
  }
  counters.networkTransportConstructions += 1;
  const provider = await tryLoadOpenAICompatibleProvider(apiKey, opts.baseUrl, opts.modelId);
  if (provider === undefined) {
    return { provider: stubProvider(), billingClass: "offline-test" };
  }
  return { provider, billingClass: "external-billed" };
}

// ---------------------------------------------------------------------------
// The capability factory
// ---------------------------------------------------------------------------

/**
 * Construct the no-network provider for `profileId` and, IN THE SAME CALL,
 * issue the symbol-branded capability BOUND to that exact provider, providerId,
 * modelId and endpoint digest.
 *
 * REFUSALS (each returns a structured refusal; NONE falls back):
 *   - `UNKNOWN_OFFLINE_PROFILE_ID`        the id is not in the closed enum;
 *   - `REAL_PROVIDER_CONFIGURATION_PRESENT` a real provider is constructible
 *                                         from `env`;
 *   - `OBSERVED_IDENTITY_MISMATCH`        the caller asked to bind an identity
 *                                         this build does not report for the
 *                                         offline profile.
 *
 * The capability is obtainable ONLY here. `createNonBillableFixtureTransport`
 * is still callable by a production module, but this function is the only
 * caller that supplies an identity it did not let the caller choose freely:
 * `endpointBaseUrl` must be `null` (an offline profile has no endpoint at all,
 * so its digest is the provider-default digest and can never be a relay's),
 * and `providerId`/`modelId` must be this build's offline literals.
 */
export function resolveOfflineProfileCapability(
  opts: ResolveOfflineProfileOptions,
): OfflineProfileResolution {
  const counters = opts.counters;

  // (1) THE CLOSED ENUM. An unknown id is a refusal — never a default.
  if (!isOfflineProfileId(opts.profileId)) {
    return {
      ok: false,
      code: "UNKNOWN_OFFLINE_PROFILE_ID",
      reason:
        `offline profile id ${JSON.stringify(opts.profileId)} is not one of the ${KNOWN_OFFLINE_PROFILE_IDS.length} ` +
        `known ${OFFLINE_PROFILE_SCHEMA_VERSION} profiles (${KNOWN_OFFLINE_PROFILE_IDS.join(", ")}) — an unknown ` +
        `profile is refused rather than silently defaulted`,
    };
  }

  // (4) REFUSAL WHEN A REAL PROVIDER IS CONFIGURED. This is checked BEFORE any
  // provider is constructed, so it is impossible to observe as offline while a
  // real provider could be built from the environment.
  const env = opts.env ?? process.env;
  if (envHasRealProviderConfiguration(env)) {
    return {
      ok: false,
      code: "REAL_PROVIDER_CONFIGURATION_PRESENT",
      reason:
        "the environment carries a REAL provider configuration (OPENAI_API_KEY / OPENAI_MODEL), so the offline " +
        "profile is refused: the resolved provider and the capability must agree, and an offline run must never " +
        "be reported while a credential-bearing provider could be constructed from process.env",
    };
  }

  // (3) BINDING. The capability may only name the identity this build actually
  // reports for an offline profile. `endpointBaseUrl: null` is the whole point:
  // an offline transport has NO endpoint, so there is nothing to re-point.
  if (
    opts.identity.providerId !== OFFLINE_PROVIDER_ID ||
    opts.identity.modelId !== OFFLINE_MODEL_ID ||
    opts.identity.endpointBaseUrl !== null
  ) {
    return {
      ok: false,
      code: "OBSERVED_IDENTITY_MISMATCH",
      reason:
        `the offline profile is bound to ${OFFLINE_PROVIDER_ID}/${OFFLINE_MODEL_ID} at a null endpoint, but the ` +
        `caller asked to bind ${opts.identity.providerId}/${opts.identity.modelId} at ` +
        `${JSON.stringify(opts.identity.endpointBaseUrl)} — a capability can only be issued for the identity that ` +
        `was actually observed, so it cannot be applied to an arbitrary endpoint`,
    };
  }

  // (2) The provider. Content profile → the scripted, tool-calling transport;
  // refusal profile → the structured refusal. TWO DIFFERENT OBJECTS, and the
  // stub is never handed to the content profile.
  const provider =
    opts.profileId === OFFLINE_CONTENT_PROFILE_ID
      ? createOfflineScriptedProvider()
      : createOfflineRefusalProvider();

  // The observed endpoint identity, derived through the SAME normalizer the
  // observer and the gate use — never a bespoke digest.
  const endpointDigest =
    captureEndpointIdentity(opts.identity.endpointBaseUrl) ?? PROVIDER_DEFAULT_ENDPOINT_DIGEST;

  // (3) IN THE SAME CALL: bind the branded capability to exactly this provider.
  const capability = createNonBillableFixtureTransport({
    endpointBaseUrl: opts.identity.endpointBaseUrl,
    providerId: OFFLINE_PROVIDER_ID,
    modelId: OFFLINE_MODEL_ID,
    provider,
  });

  // The capability and the resolved provider must always AGREE. Assert it here
  // rather than trusting the two to be kept in step by a caller.
  if (capability.provider !== provider) {
    return {
      ok: false,
      code: "OBSERVED_IDENTITY_MISMATCH",
      reason: "internal: the issued capability does not carry the provider it was constructed with",
    };
  }

  // S3/F4-GAP1 — THE COUNTER IS MEANINGFUL HERE TOO, not merely accepted.
  //
  // Two facts are recorded on the SUCCESS path, so the counting proof does not
  // depend solely on Phase C routing the real path through
  // `instrumentedRealProviderFactory`:
  //
  //   (a) a transport WAS constructed. This site builds one, and the counter
  //       says so — `networkTransportConstructions >= 1` after any successful
  //       resolution. It is deliberately NOT `realProviderFactoryEntries`,
  //       because this site does not construct a NETWORK-CAPABLE transport:
  //       the two counters answer different questions and must not be merged.
  //
  //   (b) this site is STRUCTURALLY INCAPABLE of entering the real factory.
  //       It only ever calls `createOfflineScriptedProvider` /
  //       `createOfflineRefusalProvider` (both pure, in-process) and never
  //       `tryLoadOpenAICompatibleProvider`, and the env gate above already
  //       refused if a real provider was configurable. So the increment of the
  //       real-factory counter can ONLY come from somewhere else. We assert
  //       that invariant instead of assuming it: if the count is already
  //       non-zero here, the two facts disagree and the caller is told.
  //
  // `realProviderFactoryEntries` is intentionally NOT incremented: doing so
  // would MAKE it non-zero and destroy the very quantity being proved.
  if (counters !== undefined) {
    // The real-factory check comes FIRST. A REFUSED resolution constructs no
    // transport at all, so it must not record one — otherwise the counter
    // would report work that never happened.
    if (counters.realProviderFactoryEntries !== 0) {
      return {
        ok: false,
        code: "OBSERVED_IDENTITY_MISMATCH",
        reason:
          `internal: the real-provider factory was entered ${counters.realProviderFactoryEntries} time(s) while ` +
          `resolving the OFFLINE profile ${opts.profileId} — the offline profile must be impossible to obtain once ` +
          `a real provider has been constructed, so this resolution is refused rather than handed out`,
      };
    }
    counters.networkTransportConstructions += 1;
  }

  return { ok: true, profileId: opts.profileId, endpointDigest, provider, capability };
}