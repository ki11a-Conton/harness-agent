import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { ModelProvider, ModelRef, PermissionPolicy } from "@ar/contracts";
import { createHarness, defaultSandboxPolicy } from "@ar/harness";
import { createRuntimeRpc, InMemoryTransport } from "@ar/gateway";
import {
  createProductionTools,
  PRODUCTION_TOOL_NAMES,
  ToolRegistry,
} from "@ar/tools";
import type { CommandDeps } from "./commands.js";
import { runCommand } from "./commands.js";
import { resolveModelProvider, STUB_PROVIDER_ID } from "./provider.js";

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
 *  its own env-based default (e.g. OPENAI_MODEL) when configured. */
export const DEFAULT_MODEL_ID = "gpt-4o-mini";

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
  const deps = await createDefaultDeps({ ...(dir !== undefined && dir.length > 0 ? { dataDir: dir } : {}) });
  const result = await runCommand(args, deps);
  for (const line of result.lines) {
    process.stdout.write(`${line}\n`);
  }
  return result.exitCode;
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
  const modelProvider = options.provider ?? (await resolveModelProvider());
  const memoryEnabled = options.memory === true || process.env.HARNESS_MEMORY === "1";
  if (memoryEnabled && dataDir === undefined) {
    throw new Error("memory is enabled but no dataDir is configured (--data-dir or HARNESS_DATA_DIR) — refusing to write memories into the workspace");
  }
  const harness = await createHarness({
    cwd: process.cwd(),
    ...(dataDir !== undefined ? { dataDir } : {}),
    profile: "interactive",
    modelProvider,
    model: defaultModelRef(modelProvider, options.model),
    ...(memoryEnabled ? { featureFlags: { memory: true, learning: true } } : {}),
  });
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