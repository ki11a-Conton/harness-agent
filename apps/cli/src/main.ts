import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import type { ModelProvider, PermissionPolicy, TaskSpec } from "@ar/contracts";
import { defaultSandboxPolicy, DEFAULT_MAIN_SYSTEM_PROMPT, resolveAgentPromptPolicy } from "@ar/harness";
import { createHarnessWithChampion } from "./champion-application.js";
import { createRuntimeRpc, InMemoryTransport } from "@ar/gateway";
import {
  createProductionTools,
  PRODUCTION_TOOL_NAMES,
  ToolRegistry,
} from "@ar/tools";
import type { CommandDeps } from "./commands.js";
import { runCommand } from "./commands.js";
import { createTerminalRunHost } from "./terminal-run-host.js";
import { preregCmd, type PreregCommandDeps, type PreregResolvedSelection } from "./prereg-command.js";
import { createProductionPreregRunner } from "./prereg-production-runner.js";
import {
  PRICING_PER_CALL_TOKEN_ENVELOPE,
  formalExecutionProfile,
  resolvePricingBasis,
  type FormalExecutionProfile,
  type PricingResolution,
} from "./prereg-execution-identity.js";
import type { PricingExecutionGuard } from "@ar/evaluation";
import {
  OFFLINE_CONTENT_PROFILE_ID,
  OFFLINE_PROVIDER_ID,
  resolveOfflineProfileCapability,
  resolveModelProvider,
  resolveInteractiveModelRef,
  DEFAULT_REAL_MODEL_ID,
  type OfflineProfileId,
} from "./provider.js";

/**
 * Builtin tool set every `createDefaultDeps` host registers. Single source:
 * packages/tools/src/production-tools.ts (plan.md P0-5) — the 11-tool coding
 * profile. Kept as a names+registry helper so CLI/benchmark share one list.
 */
export const BUILTIN_TOOLS = PRODUCTION_TOOL_NAMES;

/** §24 "build" profile: reads allowed; edits/exec/network ask for approval. */
export const DEFAULT_PERMISSIONS: PermissionPolicy = {
  rules: [
    { action: "read", resource: "file", effect: "allow" },
    { action: "edit", resource: "file", effect: "ask" },
    { action: "exec", resource: "command", effect: "ask" },
    { action: "exec", resource: "network", effect: "ask" },
  ],
};

/** Exact legacy base used by the harness, before context/champion suffixes. */
export const DEFAULT_SYSTEM_PROMPT = DEFAULT_MAIN_SYSTEM_PROMPT;

/** Default request model id for a real provider; the provider may still apply
 *  its own env-based default (e.g. OPENAI_MODEL) when configured. Sourced from
 *  the provider-identity module so the default can never drift. */
export const DEFAULT_MODEL_ID = DEFAULT_REAL_MODEL_ID;

export interface DefaultDepsOptions {
  /** Explicit project root; never change the process-global cwd. */
  cwd?: string;
  task?: TaskSpec;
  /** Enables persistent stores (JSONL session/event, durable approval +
   *  checkpoint) under dataDir; when absent, in-memory stores are used
   *  (doctor reports WARNING). */
  dataDir?: string;
  /** Agent model ref; defaults to the resolved provider + DEFAULT_MODEL_ID. */
  model?: { providerId: string; modelId: string };
  /** Test/advanced injection: replaces env-based provider resolution. */
  provider?: ModelProvider;
  /** P2: enable the memory + learning pipeline (pre-turn retrieval, post-turn
   *  reflection, `agent learn` promotion). Requires a dataDir — memories are
   *  never written into the workspace. */
  memory?: boolean;
  /** Explicit Agent policy; otherwise HARNESS_AGENT_PROMPT (default legacy). */
  agentPrompt?: "legacy" | "coding-v1";
}

export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const tool of createProductionTools({
    networkMode: "deny",
    availableTools: () => registry.names(),
  })) {
    registry.register(tool);
  }
}

/** Entry point: parse `agent <command> [args]` (process.argv includes the
 *  node binary and the script path) and run the command. */
export async function main(argv: string[]): Promise<number> {
  const { args, dataDir } = extractDataDirFlag(argv.slice(2));
  const dir = dataDir ?? process.env.HARNESS_DATA_DIR;

  // The pre-registration chain is dispatched BEFORE the interactive host is
  // constructed. `prereg validate` performs 0 provider calls, and `prereg run`
  // may only construct a provider AFTER the fail-closed formal gate admits the
  // campaign — so routing through `createDefaultDeps` (which resolves a model
  // provider from the environment) would build a billable provider first.
  if (isPreProviderCommand(args)) {
    const result = await preregCmd(args.slice(1), preregCommandDeps());
    return writeLines(result.lines, result.exitCode);
  }

  let cwd: string | undefined; let task: TaskSpec | undefined;
  if (args[0] === "run") {
    if (args.length !== 3 && !(args.length === 5 && args[3] === "--verify" && args[4]?.trim())) {
      return writeLines(["agent run: expected <cwd> <text> [--verify <command>]"], 1);
    }
    cwd = resolve(args[1]!);
    try { if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory"); }
    catch { return writeLines([`agent run: invalid project directory ${JSON.stringify(cwd)}`], 1); }
    args[1] = cwd;
    if (args[3] === "--verify") {
      task = { id: "cli-coding", goal: args[2]!, verification: [{ kind: "command", command: args[4]! }] };
      args.splice(3);
    }
  }
  const deps = await createDefaultDeps({ ...(cwd !== undefined ? { cwd } : {}), ...(task !== undefined ? { task } : {}),
    ...(dir !== undefined && dir.length > 0 ? { dataDir: resolve(dir) } : {}) });
  const host = args[0] === "run" ? createTerminalRunHost() : undefined;
  if (host !== undefined) deps.runHost = host;
  try {
    const result = await runCommand(args, deps);
    return writeLines(result.lines, result.exitCode);
  } finally {
    host?.close();
    await deps.close?.();
  }
}

/** Commands dispatchable without the interactive host (no provider/harness). */
export function isPreProviderCommand(args: string[]): boolean {
  return args[0] === "prereg";
}

/**
 * S3/F4 (Phase C) — the REPOSITORY-FIXED offline profile this build runs.
 *
 * It is a compile-time literal in the shipped source. There is deliberately no
 * CLI flag, no env var, no JSON field, no marker file and no path that can
 * change it: `preregCommandDeps()` is the only caller, and it names the
 * constant. An unknown/absent id is a REFUSAL (never a fallback), which is why
 * `resolveOfflineProfileCapability` is the function that turns this into a
 * transport — see `offlineTransportForPrereg`.
 */
export const PREREG_OFFLINE_PROFILE_ID: OfflineProfileId = OFFLINE_CONTENT_PROFILE_ID;

/**
 * N2 (F30-2) — resolve the ONE execution selection the `prereg` chain runs on.
 *
 * Every fact below is derived from the SAME `env`, in ONE place, and handed to
 * every consumer as a single object:
 *
 *   profile              the execution identity, request profile and digests,
 *                        observed WITH the offline selection named;
 *   pricing              the per-call basis, from the SAME env (never a second
 *                        `process.env` read that could disagree);
 *   offlineProfileSelected  TRUE only when the identity this process actually
 *                        reports IS the built-in offline identity;
 *   pricingGuard         the send-boundary price check, armed only when there is
 *                        an executable priced basis to stand behind.
 *
 * A REAL provider configuration alongside the fixed offline selection is a
 * CONFLICT, and the conflict is resolved by DROPPING the offline selection —
 * never by hiding the credential-bearing provider, and never by silently
 * reporting an offline identity while a real one is constructible. That keeps
 * `ProviderIdentityConflictError` the refusal it was written to be while leaving
 * the observer and the provider factory reading the SAME identity.
 */
export function resolvePreregSelection(env: NodeJS.ProcessEnv = process.env): PreregResolvedSelection {
  let profile: FormalExecutionProfile;
  let offlineProfileSelected = false;
  try {
    profile = formalExecutionProfile(env, { offlineProfileId: PREREG_OFFLINE_PROFILE_ID });
    offlineProfileSelected = profile.provider.providerId === OFFLINE_PROVIDER_ID;
  } catch {
    // The offline selection and a real provider configuration cannot both be
    // honoured. The real configuration is the one that is NOT dropped.
    profile = formalExecutionProfile(env);
  }
  const pricing = resolvePricingBasis(
    profile.provider.providerId,
    {
      modelId: profile.provider.modelId,
      endpointBaseUrl: profile.provider.endpointBaseUrl,
      // The PER-CALL envelope a per-call price must cover — never the per-RUN
      // conversation budget (see PRICING_PER_CALL_TOKEN_ENVELOPE).
      requiredTokenCeiling: PRICING_PER_CALL_TOKEN_ENVELOPE,
    },
    env,
  );
  const pricingGuard = pricingExecutionGuardFor(pricing);
  return {
    env,
    profile,
    pricing,
    offlineProfileSelected,
    ...(pricingGuard !== undefined ? { pricingGuard } : {}),
  };
}

/**
 * N2 (F30-5) — build the send-boundary guard from the selection's OWN basis.
 *
 * It takes the pricing resolution that is part of `PreregResolvedSelection`, so
 * the guard can never be armed against a basis this process did not resolve. It
 * returns `undefined` — never a synthetic `0` window, never a null-window guard —
 * when there is nothing billable to stand behind:
 *
 *   - no basis at all (an unpriceable provider or endpoint): the money-bounded
 *     gate refuses such a campaign on its own (`PRICING_UNKNOWN`);
 *   - the `unbilled_stub` basis: the stub transport makes no externally-billed
 *     call, so it has no price window a send could outlive. Arming a guard here
 *     would refuse every stub send as "no windowed validity", which would be a
 *     behaviour change with no billing fact behind it.
 *
 * A basis that DID resolve has already passed `pricingExecutionEligibility`
 * (windowed, unexpired, covering the envelope, explicit currency), so its window
 * is a real interval and the guard re-checks exactly that interval at every
 * physical send and retry.
 */
export function pricingExecutionGuardFor(pricing: PricingResolution): PricingExecutionGuard | undefined {
  if (!pricing.ok) return undefined;
  const basis = pricing.basis;
  if (basis.basisKind === "unbilled_stub") return undefined;
  if (basis.sourceKind === null) return undefined;
  if (basis.validity.issuedAt === null || basis.validity.expiresAt === null) return undefined;
  return {
    amountUsdMicros: basis.usdMicrosPerCall,
    basisDigest: basis.pricingDigest,
    sourceKind: basis.sourceKind,
    currency: basis.currency,
    issuedAtMs: Date.parse(basis.validity.issuedAt),
    expiresAtMs: Date.parse(basis.validity.expiresAt),
    coveredTokenCeiling: basis.coverage.coveredTokenCeiling,
    requiredTokenCeiling: basis.coverage.requiredTokenCeiling ?? PRICING_PER_CALL_TOKEN_ENVELOPE,
  };
}

/**
 * S3/F4 (Phase C) — build the offline transport factory for the prereg chain.
 *
 * Returns `undefined` — meaning "no seam at all", so the gate keeps its
 * unchanged refusal path — whenever the offline profile cannot be justified:
 *
 *   - the environment carries a REAL provider configuration (the capability
 *     and the resolved provider must agree, so an offline run may never be
 *     reported while a credential-bearing provider is constructible), or
 *   - the OBSERVED identity is not the offline profile's identity.
 *
 * The identity is RE-OBSERVED from the ONE selection (N2/F30-2), never minted: a
 * caller cannot hand this function an endpoint, so it cannot be used to launder an
 * arbitrary paid endpoint into the non-billable admission class. The selection is
 * passed IN (`preregCommandDeps` resolves it), so the offline identity is reported
 * only because this profile is genuinely selected — and a real provider config
 * alongside it is a refusal, not a preference.
 *
 * Returns a ZERO-ARGUMENT thunk, not a value: the capability is only built when
 * the gate actually asks for it, and a factory cannot be serialized into a
 * JSON artifact, env var or marker.
 */
export function offlineTransportForPrereg(
  env: NodeJS.ProcessEnv = process.env,
): (() => unknown) | undefined {
  return offlineTransportForSelection(resolvePreregSelection(env));
}

/** The capability thunk for an ALREADY-RESOLVED selection. This is the only
 *  place the selection is turned into a transport, so the capability and the
 *  observer can never be derived from two different environments. */
function offlineTransportForSelection(selection: PreregResolvedSelection): (() => unknown) | undefined {
  // The offline identity is a FACT about the selection, not a preference: if the
  // selection resolved to a real or stub identity there is no offline profile to
  // bind a capability to, and no seam is produced.
  if (!selection.offlineProfileSelected) return undefined;
  const observed = selection.profile.provider;
  const resolution = resolveOfflineProfileCapability({
    profileId: PREREG_OFFLINE_PROFILE_ID,
    identity: {
      providerId: observed.providerId,
      modelId: observed.modelId,
      endpointBaseUrl: observed.endpointBaseUrl,
    },
    env: selection.env,
  });
  if (!resolution.ok) return undefined;
  return () => resolution.capability;
}

/**
 * The `prereg` chain runs against its OWN adapter and never needs the
 * interactive host. S2/F1b wires the PRODUCTION adapter here, so the shipped
 * `node apps/cli/dist/main.js prereg …` path can actually run the formal chain:
 * `observe` re-derives the CURRENT execution identity from the real checkout
 * (git HEAD, clean-tree, arm checkouts, benchmark case bytes) and the
 * environment the provider will be resolved from. It never echoes the
 * artifact's own claims back as "observed", and anything it cannot certify is
 * reported unobservable so the gate REFUSES rather than fabricating a match.
 * `makeProvider` is invoked only after the fail-closed gate admits.
 *
 * S3/F4 (Phase C): the adapter additionally carries the built-in offline
 * transport seam when — and only when — the selection reports the offline
 * identity. On a real-provider environment that seam is absent, and the gate
 * still refuses a fixture-mode authorization with
 * `FIXTURE_TRANSPORT_NOT_NON_BILLABLE`.
 *
 * N2 (F30-2): the adapter is built from the SAME resolved selection as the seam
 * and the pricing guard. The injected `env` is threaded into
 * `createProductionPreregRunner({ env })`, so the observer and the provider
 * factory read THAT environment and never `process.env` — the run's capability
 * and its observed/built identity can no longer describe two different
 * executions.
 */
export function preregCommandDeps(env: NodeJS.ProcessEnv = process.env): PreregCommandDeps {
  const selection = resolvePreregSelection(env);
  const offlineTransport = offlineTransportForSelection(selection);
  return {
    selection,
    runner: {
      // N2 (F30-2) — the SELECTION is handed over, not merely its env: the
      // observer then reports the very identity `prereg build` bound (for the
      // offline profile that is `offline-scripted`, which a bare keyless
      // re-derivation would report as `stub` → a false identity drift that made
      // the release CLI unable to run the profile it had just built).
      ...createProductionPreregRunner({ selection }),
      ...(offlineTransport !== undefined ? { offlineTransport } : {}),
    },
  };
}

function writeLines(lines: readonly string[], exitCode: number): number {
  for (const line of lines) process.stdout.write(`${line}\n`);
  return exitCode;
}

/** Pull `--data-dir <path>` / `--data-dir=<path>` out of argv before command
 *  dispatch, so runCommand only ever sees `agent <command> [args]`. */
export function extractDataDirFlag(argv: string[]): { args: string[]; dataDir?: string } {
  const args: string[] = [];
  let dataDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--data-dir") {
      dataDir = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
    } else {
      args.push(arg);
    }
  }
  return { args, dataDir };
}

/**
 * Default host wiring via the @ar/harness production composition root
 * (plan.md P0-3): interactive profile (read allow, edit/exec/network ask),
 * the 11-tool production registry, ContextPipeline + budget, skills and
 * artifact stores, persistent stores when a dataDir is provided (JSONL +
 * durable approval/checkpoint), the OpenAI-compatible provider when
 * OPENAI_API_KEY is set, and the real ToolOrchestrator pipeline (permission
 * → approval → sandbox).
 */
export async function createDefaultDeps(options: DefaultDepsOptions = {}): Promise<CommandDeps> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const dataDir = options.dataDir;
  // Resolve before provider construction; invalid policies fail closed.
  const agentPromptPolicy = resolveAgentPromptPolicy(options.agentPrompt ?? process.env.HARNESS_AGENT_PROMPT);
  const modelProvider = options.provider ?? (await resolveModelProvider({ modelId: options.model?.modelId ?? (process.env.OPENAI_MODEL || DEFAULT_MODEL_ID) })).provider;
  const memoryEnabled = options.memory === true || process.env.HARNESS_MEMORY === "1";
  if (memoryEnabled && dataDir === undefined) {
    throw new Error("memory is enabled but no dataDir is configured (--data-dir or HARNESS_DATA_DIR) — refusing to write memories into the workspace");
  }
  // E4-07: the CLI production composition root uses the shared champion
  // application path. It reads the champion state, applies the resolved profile
  // through the real createHarness, verifies the final normalized config, and
  // writes an AppliedProof by CAS only after the configuration matches.
  const championStartup = await createHarnessWithChampion({
    runtimeEntrypoint: "cli",
    baseConfig: {
      cwd,
      ...(options.task !== undefined ? { task: options.task } : {}),
      ...(dataDir !== undefined ? { dataDir } : {}),
      profile: "interactive",
      ...(agentPromptPolicy !== undefined ? { agentPromptPolicy } : {}),
      modelProvider,
      model: resolveInteractiveModelRef(modelProvider, options.model),
      ...(memoryEnabled ? { featureFlags: { memory: true, learning: true } } : {}),
    },
    sourceSha: process.env.GIT_SHA ?? null,
  });
  const harness = championStartup.harness;
  const registry = createRuntimeRpc(harness.runtime, {
    sessionService: harness.sessionService,
    sessions: harness.sessions,
    approvalStore: harness.approvalStore,
    events: harness.events,
    listAgents: () => harness.agents,
    listTools: () => harness.registry.specs(),
    listSkills: () => [],
  });
  const { client, server } = InMemoryTransport.pair();
  server.connect(registry);
  return {
    close: () => harness.close(),
    rpc: client,
    store: harness.store,
    events: harness.events,
    sessionService: harness.sessionService,
    approvalStore: harness.approvalStore,
    introspection: harness.introspect(),
    resolvedConfig: harness.resolvedConfig,
    ...(harness.candidates !== undefined ? { candidates: harness.candidates } : {}),
    ...(harness.memoryStore !== undefined ? { memoryStore: harness.memoryStore } : {}),
    ...(harness.askUserStore !== undefined ? { askUserStore: harness.askUserStore } : {}),
    ...(harness.checkpointStore !== undefined ? { checkpointStore: harness.checkpointStore } : {}),
    doctor: {
      modelProvider,
      sandboxPolicy: defaultSandboxPolicy(),
      permissions: harness.agents[0]!.permissions,
      workspaceRoot: cwd,
      toolRegistry: harness.registry,
      skills: undefined,
      plugins: undefined,
      sessionStore: harness.store,
      eventStore: harness.events,
      dataDir,
      contextBudgetFallback: harness.context.budgetFallback,
      contextBudgetMaxTokens: harness.context.budget.maxTokens,
    },
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
