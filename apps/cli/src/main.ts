import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { ModelProvider, ModelRef, PermissionPolicy } from "@ar/contracts";
import { defaultSandboxPolicy } from "@ar/harness";
import { createHarnessWithChampion } from "./champion-application.js";
import { createRuntimeRpc, InMemoryTransport } from "@ar/gateway";
import {
  createProductionTools,
  PRODUCTION_TOOL_NAMES,
  ToolRegistry,
} from "@ar/tools";
import type { CommandDeps } from "./commands.js";
import { runCommand } from "./commands.js";
import { preregCmd, type PreregCommandDeps } from "./prereg-command.js";
import { createProductionPreregRunner } from "./prereg-production-runner.js";
import { formalExecutionProfile } from "./prereg-execution-identity.js";
import {
  OFFLINE_CONTENT_PROFILE_ID,
  resolveOfflineProfileCapability,
  resolveModelProvider,
  DEFAULT_REAL_MODEL_ID,
  STUB_PROVIDER_ID,
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

export const DEFAULT_SYSTEM_PROMPT = [
  "You are the harness agent running inside a workspace.",
  "",
  "Capabilities:",
  "- read_file / search_files: inspect workspace files (allowed automatically)",
  "- write_file / edit_file: modify workspace files (require approval)",
  "- exec: run commands in the workspace shell (requires approval)",
  "",
  "State-changing actions ask for approval and are denied until approved.",
  "When a tool result reports [denied], do not retry it blindly — report the outcome.",
].join("\n");

/** Default request model id for a real provider; the provider may still apply
 *  its own env-based default (e.g. OPENAI_MODEL) when configured. Sourced from
 *  the provider-identity module so the default can never drift. */
export const DEFAULT_MODEL_ID = DEFAULT_REAL_MODEL_ID;

export interface DefaultDepsOptions {
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

  const deps = await createDefaultDeps({ ...(dir !== undefined && dir.length > 0 ? { dataDir: dir } : {}) });
  const result = await runCommand(args, deps);
  for (const line of result.lines) {
    process.stdout.write(`${line}\n`);
  }
  return result.exitCode;
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
 * The identity is RE-OBSERVED here from the same `formalExecutionProfile(env)`
 * source the runner's observer uses, and not minted: a caller cannot hand this
 * function an endpoint, so it cannot be used to launder an arbitrary paid
 * endpoint into the non-billable admission class. Since Phase D the selection is
 * passed IN (`{ offlineProfileId }`), so the offline identity is reported only
 * because this profile is genuinely selected — and a real provider config
 * alongside it is a refusal, not a preference.
 *
 * Returns a ZERO-ARGUMENT thunk, not a value: the capability is only built when
 * the gate actually asks for it, and a factory cannot be serialized into a
 * JSON artifact, env var or marker.
 */
export function offlineTransportForPrereg(
  env: NodeJS.ProcessEnv = process.env,
): (() => unknown) | undefined {
  // S3/F4 (Phase D) — the identity is re-observed WITH the selection NAMED, so
  // the observer reports the offline identity only because the offline profile
  // is genuinely the selected provider for this process — never by guessing.
  // A real provider configuration alongside the selection THROWS
  // (`ProviderIdentityConflictError`), which is the required refusal: the two
  // are never reconciled by preference, and no seam is produced.
  let observed: { providerId: string; modelId: string; endpointBaseUrl: string | null };
  try {
    observed = formalExecutionProfile(env, { offlineProfileId: PREREG_OFFLINE_PROFILE_ID }).provider;
  } catch {
    return undefined;
  }
  const resolution = resolveOfflineProfileCapability({
    profileId: PREREG_OFFLINE_PROFILE_ID,
    identity: {
      providerId: observed.providerId,
      modelId: observed.modelId,
      endpointBaseUrl: observed.endpointBaseUrl,
    },
    env,
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
 * transport seam when — and only when — `offlineTransportForPrereg()` can bind
 * it to the identity this process actually observes. On a real-provider
 * environment that returns `undefined`, the key is absent, and the gate still
 * refuses a fixture-mode authorization with
 * `FIXTURE_TRANSPORT_NOT_NON_BILLABLE`.
 */
export function preregCommandDeps(env: NodeJS.ProcessEnv = process.env): PreregCommandDeps {
  const offlineTransport = offlineTransportForPrereg(env);
  return {
    runner: {
      ...createProductionPreregRunner(),
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
  const dataDir = options.dataDir;
  const modelProvider = options.provider ?? (await resolveModelProvider()).provider;
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
      cwd: process.cwd(),
      ...(dataDir !== undefined ? { dataDir } : {}),
      profile: "interactive",
      modelProvider,
      model: defaultModelRef(modelProvider, options.model),
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
      workspaceRoot: process.cwd(),
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

function defaultModelRef(
  provider: ModelProvider,
  model?: { providerId: string; modelId: string },
): ModelRef {
  if (model !== undefined) return model;
  return {
    providerId: provider.id,
    modelId: provider.id === STUB_PROVIDER_ID ? "stub-model" : DEFAULT_MODEL_ID,
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