import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createDefaultDeps } from "@ar/cli";
import { createRuntimeRpc, Gateway } from "@ar/gateway";
import type { AgentSummary } from "@ar/gateway";
import { WebChannelAdapter } from "./adapter.js";
import { SessionBindings, TrackingRegistry } from "./bindings.js";
import { WebServer } from "./server.js";

/**
 * Web console entry: reuse the CLI's default host wiring (5 builtin tools,
 * §24 permission profile, JSONL stores under HARNESS_DATA_DIR, OpenAI-
 * compatible provider or stub), then assemble the gateway + HTTP server.
 *
 * The gateway needs an RpcMethodRegistry (not the transport client returned
 * by createDefaultDeps), so a fresh registry is bound to the same runtime;
 * the CLI's agent id is discovered through agent.list.
 */
export async function main(): Promise<number> {
  const dir = process.env.HARNESS_DATA_DIR;
  const deps = await createDefaultDeps({
    ...(dir !== undefined && dir.length > 0 ? { dataDir: dir } : {}),
  });
  const agents = (await deps.rpc.request("agent.list")) as AgentSummary[];
  const agentId = agents[0]?.id;
  if (agentId === undefined) {
    throw new Error("no agent registered — cannot start web server");
  }

  const bindings = new SessionBindings();
  const registry = createRuntimeRpc(deps.runtime, {
    sessionService: deps.sessionService,
    approvalStore: deps.approvalStore,
    events: deps.events,
  });
  const gatewayRpc = new TrackingRegistry(registry, (session) => bindings.onSessionCreated(session));

  const adapter = new WebChannelAdapter();
  const gateway = new Gateway({
    rpc: gatewayRpc,
    channels: [adapter],
    sessionService: deps.sessionService,
    approvalStore: deps.approvalStore,
    events: deps.events,
    sessionDefaults: { agentId, cwd: process.cwd() },
  });
  await gateway.start();

  const server = new WebServer({
    adapter,
    bindings,
    events: deps.events,
    store: deps.store,
    approvalStore: deps.approvalStore,
  });
  await server.start();

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`[web] ${signal} — shutting down\n`);
    await server.stop();
    await gateway.stop();
    process.exitCode = 0;
  };
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
