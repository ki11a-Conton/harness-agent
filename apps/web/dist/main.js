import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createHarness } from "@ar/harness";
import { DEFAULT_MODEL_ID, resolveModelProvider, STUB_PROVIDER_ID } from "@ar/cli";
import { createRuntimeRpc, Gateway } from "@ar/gateway";
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
export async function main() {
    const dir = process.env.HARNESS_DATA_DIR;
    const provider = await resolveModelProvider();
    const harness = await createHarness({
        cwd: process.cwd(),
        ...(dir !== undefined && dir.length > 0 ? { dataDir: dir } : {}),
        profile: "interactive",
        modelProvider: provider,
        model: {
            providerId: provider.id,
            modelId: provider.id === STUB_PROVIDER_ID ? "stub-model" : DEFAULT_MODEL_ID,
        },
    });
    const agentId = harness.agents[0]?.id;
    if (agentId === undefined) {
        await harness.close();
        throw new Error("no agent registered — cannot start web server");
    }
    const bindings = new SessionBindings();
    const registry = createRuntimeRpc(harness.runtime, {
        sessionService: harness.sessionService,
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
    });
    await gateway.start();
    const server = new WebServer({
        adapter,
        bindings,
        events: harness.events,
        store: harness.store,
        approvalStore: harness.approvalStore,
    });
    await server.start();
    const shutdown = async (signal) => {
        process.stdout.write(`[web] ${signal} — shutting down\n`);
        await server.stop();
        await gateway.stop();
        await harness.close();
        process.exitCode = 0;
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    return 0;
}
const isMain = process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
    main().then((code) => {
        process.exitCode = code;
    }, (err) => {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=main.js.map