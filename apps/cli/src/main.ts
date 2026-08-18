import { pathToFileURL } from "node:url";
import { delimiter, resolve } from "node:path";
import type {
  AgentDefinition,
  AgentEvent,
  EventStore,
  ModelProvider,
  ModelRef,
  PermissionPolicy,
  SessionStore,
} from "@ar/contracts";
import { newAgentId, newEventId } from "@ar/contracts";
import { AgentRuntime, defaultSandboxPolicy } from "@ar/core";
import { FileSkillLoader } from "@ar/skills";
import { createRuntimeRpc, InMemoryTransport } from "@ar/gateway";
import { JSONLEventStore } from "@ar/events";
import { JSONLSessionStore, SessionService } from "@ar/session";
import { InMemoryApprovalStore, StoreApprovalResolver, detectPromptInjection, redactSecrets } from "@ar/security";
import {
  capabilityOf,
  semanticsOf,
  editFileTool,
  execTool,
  readFileTool,
  searchFilesTool,
  ToolOrchestrator,
  ToolRegistry,
  writeFileTool,
} from "@ar/tools";
import type { CommandDeps } from "./commands.js";
import { runCommand } from "./commands.js";
import { MemEventStore, MemSessionStore } from "./mem-stores.js";
import { resolveModelProvider, STUB_PROVIDER_ID } from "./provider.js";

/** Builtin tool set every `createDefaultDeps` host registers (VS-001/EXEC-001). */
export const BUILTIN_TOOLS = [
  readFileTool,
  writeFileTool,
  editFileTool,
  searchFilesTool,
  execTool,
] as const;

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
  /** Enables persistent stores (JSONLSessionStore + JSONLEventStore) under
   *  dataDir; when absent, in-memory stores are used (doctor reports WARNING). */
  dataDir?: string;
  /** Agent model ref; defaults to the resolved provider + DEFAULT_MODEL_ID. */
  model?: { providerId: string; modelId: string };
  /** Test/advanced injection: replaces env-based provider resolution. */
  provider?: ModelProvider;
}

export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const tool of BUILTIN_TOOLS) registry.register(tool);
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
 * Default host wiring: real tool registration (§24 build permission profile),
 * persistent stores when a dataDir is provided (JSONL), the OpenAI-compatible
 * provider when OPENAI_API_KEY is set, and the real ToolOrchestrator pipeline
 * (permission → approval → sandbox).
 */
export async function createDefaultDeps(options: DefaultDepsOptions = {}): Promise<CommandDeps> {
  // Persistence: with a dataDir the host uses the real JSONL stores; without
  // one it falls back to the in-memory fakes below (one-shot hosts don't need
  // disk state — agent doctor reports which mode is active).
  const dataDir = options.dataDir;
  const store: SessionStore = dataDir !== undefined ? new JSONLSessionStore({ dataDir }) : new MemSessionStore();
  const events: EventStore = dataDir !== undefined ? new JSONLEventStore({ dataDir }) : new MemEventStore();
  const approvalStore = new InMemoryApprovalStore();
  const toolRegistry = new ToolRegistry();
  registerBuiltinTools(toolRegistry);
  const orchestrator = new ToolOrchestrator({
    registry: toolRegistry,
    approval: new StoreApprovalResolver(approvalStore),
    workspaceRoot: process.cwd(),
    events: {
      async emit(sessionId, type, payload, turnId) {
        await events.append({
          id: newEventId(),
          sessionId,
          ...(turnId !== undefined ? { turnId } : {}),
          sequence: 0, // both JSONL and Mem stores assign the real sequence
          timestamp: Date.now(),
          type,
          payload,
        });
      },
    },
  });
  const modelProvider = options.provider ?? (await resolveModelProvider());
  // Task 3: skill index — AR_SKILL_ROOTS is a path-delimiter-separated list of
  // skill package roots. Unset/empty env produces no roots; discover() errors
  // propagate to the caller (bubbling like instruction discovery).
  // Task A: onSecurityDenied fires when a skill body is rejected for injection
  // or secrets; the event is logged to stderr so the host can observe it.
  const skillLoader = new FileSkillLoader({
    onSecurityDenied: (event) => {
      // P0-7: structured stderr record. Startup-time rejections (no session
      // yet) cannot become events in the trail; the host sees them here.
      process.stderr.write(
        `[security] source=${event.source} detection=${event.detection} target=${event.path} reasons=${event.reasons.join(",")}\n`,
      );
    },
  });
  const skillRoots = (process.env.AR_SKILL_ROOTS ?? "")
    .split(delimiter)
    .map((root) => root.trim())
    .filter((root) => root.length > 0);
  const agent: AgentDefinition = {
    id: newAgentId(),
    name: "main",
    description: "default CLI agent",
    mode: "primary",
    model: defaultModelRef(modelProvider, options.model),
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    tools: { allow: BUILTIN_TOOLS.map((t) => t.name) },
    permissions: DEFAULT_PERMISSIONS,
    skills: {},
    limits: { maxToolCalls: 50 },
  };
  const runtime = new AgentRuntime({
    store,
    events,
    modelProvider,
    orchestrator,
    agents: [agent],
    sandboxPolicy: defaultSandboxPolicy(),
    // Advertise the registered tools to the model provider.
    toolSpecs: toolRegistry.specs(),
    // plan.md Phase 3: retry gating + concurrency planning from tool metadata.
    toolCapabilityOf: (name) => capabilityOf(toolRegistry.get(name)),
    // P1-11: side-effect/checkpoint/resume decisions follow tool semantics
    // from the registry, never tool-name hardcodes.
    toolSemanticsOf: (name) => semanticsOf(toolRegistry.get(name)),
    // Task 3: feed the discovered skill index into the context pipeline
    // (runtime maps Skill -> {name, description} and emits skill.discovered).
    skills: () => skillLoader.discover({ roots: skillRoots, maxSkills: 100 }),
    // P0-8: rendered tool output is scanned for prompt injection and withheld
    // on a hit (fail-closed) before it reaches the model.
    injectionDetector: (content) => detectPromptInjection(content),
    // P1-13: tool output is redacted before it crosses any boundary (message
    // content, artifact files) — same gate the benchmark runner uses. The
    // redacted count also reclassifies artifacts as high-sensitivity.
    outputRedactor: (content) => redactSecrets(content),
  });
  const sessionService = new SessionService({ store });
  const registry = createRuntimeRpc(runtime, {
    sessionService,
    approvalStore,
    events,
    listAgents: () => [agent],
    listTools: () => toolRegistry.specs(),
    listSkills: () => [],
  });
  const { client, server } = InMemoryTransport.pair();
  server.connect(registry);
  return {
    rpc: client,
    store,
    events,
    sessionService,
    approvalStore,
    runtime,
    doctor: {
      modelProvider,
      sandboxPolicy: defaultSandboxPolicy(),
      permissions: agent.permissions,
      workspaceRoot: process.cwd(),
      toolRegistry,
      skills: undefined,
      plugins: undefined,
      sessionStore: store,
      eventStore: events,
      dataDir,
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

// --- in-memory fakes (CLI scaffold fallback when no dataDir is configured;
//     shared with the benchmark command via mem-stores.ts) --------------------
// MemSessionStore / MemEventStore live in mem-stores.ts.

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