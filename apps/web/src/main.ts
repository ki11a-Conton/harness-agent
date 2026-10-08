import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Harness } from "@ar/harness";
import { resolveAgentPromptPolicy } from "@ar/harness";
import {
  createHarnessWithChampion,
  DEFAULT_MODEL_ID,
  resolveModelProvider,
  resolveInteractiveModelRef,
  acquireDataDirLease,
} from "@ar/cli";
import type { DataDirLease } from "@ar/cli";
import { createRuntimeRpc, Gateway } from "@ar/gateway";
import type { AgentSummary } from "@ar/gateway";
import { WebChannelAdapter } from "./adapter.js";
import { SessionBindings, TrackingRegistry } from "./bindings.js";
import { WebServer } from "./server.js";

/**
 * Web console entry: compose the production harness (@ar/harness, interactive
 * profile — 11 tools, §24 permission profile, JSONL stores under
 * HARNESS_DATA_DIR, OpenAI-compatible provider or stub), then assemble the
 * gateway + HTTP server on top of the same runtime.
 *
 * The gateway needs an RpcMethodRegistry (not the transport client returned
 * by the CLI), so a fresh registry is bound to the harness runtime; the
 * harness's agent id is used for new sessions.
 */
export async function main(): Promise<number> {
  const lease = await acquireDataDirLease(process.env.HARNESS_DATA_DIR);
  lease?.ref();
  try {
    const result = await startMain(lease);
    lease?.unref();
    return result;
  } catch (error) {
    await lease?.release();
    throw error;
  }
}

async function startMain(lease: DataDirLease | undefined): Promise<number> {
  const dir = lease?.dataDir;
  const agentPromptPolicy = resolveAgentPromptPolicy(process.env.HARNESS_AGENT_PROMPT);
  // E3-01: resolveModelProvider now returns a BillingProvider — unwrap the
  // provider for harness wiring.
  const provider = (await resolveModelProvider({ modelId: process.env.OPENAI_MODEL || DEFAULT_MODEL_ID })).provider;
  const verificationCommand = process.env.HARNESS_VERIFY_COMMAND?.trim();
  // E4-07: Web uses the same production champion application path as CLI.
  // The shared path resolves the pending champion profile, passes it through
  // the real createHarness, verifies the final normalized configuration, and
  // writes an AppliedProof by CAS only after the target configuration matches.
  const championStartup = await createHarnessWithChampion({
    runtimeEntrypoint: "web",
    baseConfig: {
      cwd: process.cwd(),
      ...(dir !== undefined && dir.length > 0 ? { dataDir: dir } : {}),
      profile: "interactive",
      ...(agentPromptPolicy !== undefined ? { agentPromptPolicy } : {}),
      modelProvider: provider,
      model: resolveInteractiveModelRef(provider),
      ...(verificationCommand ? { task: { id: "web-coding", goal: "Complete the user task and pass the configured project check",
        verification: [{ kind: "command" as const, command: verificationCommand }] } } : {}),
    },
    sourceSha: process.env.GIT_SHA ?? null,
  });
  const harness: Harness = championStartup.harness;
  const agentId = harness.agents[0]?.id;
  if (agentId === undefined) {
    await harness.close();
    throw new Error("no agent registered — cannot start web server");
  }

  const bindings = new SessionBindings(dir !== undefined && dir.length > 0 ? resolve(dir, "web-session-bindings.json") : undefined);
  for (const binding of bindings.all()) {
    if (await harness.store.getSession(binding.sessionId) === undefined) {
      await harness.close();
      throw new Error(`Web session binding references a missing session: ${binding.sessionId}`);
    }
  }
  const registry = createRuntimeRpc(harness.runtime, {
    sessionService: harness.sessionService,
    sessions: harness.sessions,
    approvalStore: harness.approvalStore,
    events: harness.events,
  });
  const gatewayRpc = new TrackingRegistry(registry, (session) => bindings.onSessionCreated(session));

  const adapter = new WebChannelAdapter();
  const gateway = new Gateway({
    rpc: gatewayRpc,
    channels: [adapter],
    sessionService: harness.sessionService,
    approvalStore: harness.approvalStore,
    events: harness.events,
    sessionDefaults: { agentId, cwd: process.cwd() },
    route: (from) => bindings.get(from),
    restoredBindings: bindings.all().map((binding) => ({ ...binding, channelId: adapter.id })),
  });
  const server = new WebServer({
    adapter,
    bindings,
    events: harness.events,
    store: harness.store,
    approvalStore: harness.approvalStore,
  });
  try {
    await gateway.start();
    await server.start();
  } catch (error) {
    // Partial startup still owns stores/listeners. Finish cleanup before main
    // releases directory ownership so another host cannot overlap it.
    const results = await Promise.allSettled([server.stop(), gateway.stop()]);
    for (const result of results) if (result.status === "rejected") {
      process.stderr.write(`[degraded] web.startup-cleanup: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}\n`);
    }
    await harness.close();
    throw error;
  }

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => shutdownPromise ??= (async () => {
    process.stdout.write(`[web] ${signal} — shutting down\n`);
    try {
      try { await server.stop(); }
      finally { try { await gateway.stop(); } finally { await harness.close(); } }
      process.exitCode = 0;
    } finally { await lease?.release(); }
  })();
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
