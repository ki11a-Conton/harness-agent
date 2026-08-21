import { stat } from "node:fs/promises";
import { STUB_PROVIDER_ID } from "./provider.js";
/** Number of tools a wired CLI host registers (production coding profile,
 *  plan.md P0-5 — previously 5, now the full 11-tool production set). */
const EXPECTED_BUILTIN_TOOLS = 11;
const PROBE_SESSION = "session_doctor_probe";
/** Run every §87 check; each check reports independently, never throws. */
/** P12-2: host environment — OS, Node, pnpm, platform parity note. Pure
 *  runtime facts, no stores touched. */
function checkEnvironment() {
    const nodeVersion = process.versions.node;
    const platform = process.platform;
    const isWindows = platform === "win32";
    const osName = isWindows ? "Windows" : platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;
    const detail = `${osName} / Node ${nodeVersion}${isWindows ? " (Windows parity: covered by dedicated CI)" : " (cross-platform CI required for path/fs/process changes)"}`;
    return { name: "environment", status: "OK", detail };
}
export async function runChecks(deps) {
    return [
        await checkEnvironment(),
        await checkModelProvider(deps),
        await checkSandbox(deps),
        await checkPermissions(deps),
        await checkWorkspace(deps),
        await checkToolRegistry(deps),
        await checkSkills(deps),
        await checkPlugins(deps),
        await checkSessionStore(deps),
        await checkEventStore(deps),
        await checkPersistence(deps),
        await checkContextBudget(deps),
    ];
}
async function checkModelProvider(deps) {
    const provider = deps.modelProvider;
    if (provider === undefined) {
        return { name: "model provider", status: "ERROR", detail: "no model provider configured" };
    }
    if (provider.id === STUB_PROVIDER_ID) {
        return {
            name: "model provider",
            status: "WARNING",
            detail: "stub provider active — no real model configured (set OPENAI_API_KEY)",
        };
    }
    try {
        const models = await provider.listModels();
        if (models.length === 0) {
            return { name: "model provider", status: "WARNING", detail: `provider ${provider.id} advertises no models` };
        }
        return { name: "model provider", status: "OK", detail: `${provider.id}: ${models.length} model(s)` };
    }
    catch (err) {
        return { name: "model provider", status: "ERROR", detail: `provider ${provider.id} failed: ${messageOf(err)}` };
    }
}
async function checkSandbox(deps) {
    const policy = deps.sandboxPolicy;
    if (policy === undefined) {
        return { name: "sandbox", status: "ERROR", detail: "no sandbox policy configured" };
    }
    return {
        name: "sandbox",
        status: "OK",
        detail: `filesystem=${policy.filesystem.mode} network=${policy.network.mode}`,
    };
}
async function checkPermissions(deps) {
    const policy = deps.permissions;
    if (policy === undefined) {
        return { name: "permissions", status: "ERROR", detail: "no permission policy configured" };
    }
    if (policy.rules.length === 0) {
        return { name: "permissions", status: "WARNING", detail: "no rules; default effect applies" };
    }
    return { name: "permissions", status: "OK", detail: `${policy.rules.length} rule(s)` };
}
async function checkWorkspace(deps) {
    const root = deps.workspaceRoot;
    if (root === undefined) {
        return { name: "workspace", status: "WARNING", detail: "workspace root not configured" };
    }
    try {
        const info = await stat(root);
        if (!info.isDirectory()) {
            return { name: "workspace", status: "ERROR", detail: `not a directory: ${root}` };
        }
        return { name: "workspace", status: "OK", detail: root };
    }
    catch (err) {
        return { name: "workspace", status: "ERROR", detail: `not accessible: ${root} (${messageOf(err)})` };
    }
}
async function checkToolRegistry(deps) {
    const registry = deps.toolRegistry;
    if (registry === undefined) {
        return { name: "tool registry", status: "ERROR", detail: "no tool registry configured" };
    }
    const count = registry.list().length;
    if (count < EXPECTED_BUILTIN_TOOLS) {
        return {
            name: "tool registry",
            status: "ERROR",
            detail: `only ${count} of ${EXPECTED_BUILTIN_TOOLS} builtin tools registered`,
        };
    }
    return { name: "tool registry", status: "OK", detail: `${count} tool(s)` };
}
async function checkSkills(deps) {
    const loader = deps.skills;
    if (loader === undefined) {
        return { name: "skills", status: "WARNING", detail: "skill loader not configured" };
    }
    if (deps.workspaceRoot === undefined) {
        return { name: "skills", status: "WARNING", detail: "no workspace root to scan" };
    }
    try {
        const skills = await loader.discover({ roots: [deps.workspaceRoot] });
        if (skills.length === 0) {
            return { name: "skills", status: "WARNING", detail: "no skills discovered" };
        }
        return { name: "skills", status: "OK", detail: `${skills.length} skill(s) discovered` };
    }
    catch (err) {
        return { name: "skills", status: "ERROR", detail: `skill discovery failed: ${messageOf(err)}` };
    }
}
async function checkPlugins(deps) {
    const host = deps.plugins;
    if (host === undefined) {
        return { name: "plugins", status: "WARNING", detail: "plugin host not configured (optional)" };
    }
    return { name: "plugins", status: "OK", detail: `${host.list().length} plugin(s)` };
}
async function checkSessionStore(deps) {
    const store = deps.sessionStore;
    if (store === undefined) {
        return { name: "session store", status: "ERROR", detail: "no session store configured" };
    }
    try {
        await store.listSessions();
        return { name: "session store", status: "OK", detail: `reachable${typeName(store)}` };
    }
    catch (err) {
        return { name: "session store", status: "ERROR", detail: messageOf(err) };
    }
}
async function checkEventStore(deps) {
    const store = deps.eventStore;
    if (store === undefined) {
        return { name: "event store", status: "ERROR", detail: "no event store configured" };
    }
    try {
        await store.list(PROBE_SESSION);
        return { name: "event store", status: "OK", detail: `reachable${typeName(store)}` };
    }
    catch (err) {
        return { name: "event store", status: "ERROR", detail: messageOf(err) };
    }
}
async function checkPersistence(deps) {
    if (deps.dataDir === undefined) {
        return {
            name: "persistence",
            status: "WARNING",
            detail: "in-memory stores (pass --data-dir or set HARNESS_DATA_DIR)",
        };
    }
    return { name: "persistence", status: "OK", detail: `dataDir=${deps.dataDir}` };
}
async function checkContextBudget(deps) {
    if (deps.contextBudgetFallback === true) {
        return {
            name: "context budget",
            status: "WARNING",
            detail: `model context window unknown — conservative fallback ${deps.contextBudgetMaxTokens ?? "?"} tokens used`,
        };
    }
    return {
        name: "context budget",
        status: "OK",
        detail: deps.contextBudgetMaxTokens === undefined
            ? "not reported by the harness"
            : `context window known (maxTokens=${deps.contextBudgetMaxTokens})`,
    };
}
function typeName(value) {
    const name = value.constructor?.name;
    return name === undefined || name === "Object" ? "" : ` (${name})`;
}
function messageOf(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
//# sourceMappingURL=doctor.js.map