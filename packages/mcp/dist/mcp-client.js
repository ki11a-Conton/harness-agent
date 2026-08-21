import { AgentError, RealTimer, errorInfo, RETRY_KIND_SPECS } from "@ar/contracts";
const PROTOCOL_VERSION = "2025-03-26";
const CLIENT_NAME = "@ar/mcp";
const CLIENT_VERSION = "0.1.0";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export class McpClient {
    url;
    token;
    nextId = 1;
    connectTimeoutMs;
    requestTimeoutMs;
    timer;
    hasConnected = false;
    connected = false;
    constructor(opts) {
        this.connectTimeoutMs = opts?.connectTimeoutMs ?? 10_000;
        this.requestTimeoutMs = opts?.requestTimeoutMs ?? 30_000;
        this.timer = opts?.timer ?? new RealTimer();
    }
    /** True after a successful initialize and until close()/a marking failure. */
    isConnected() {
        return this.connected;
    }
    /** Whether a connect handshake ever succeeded (reconnect cycles preserve it). */
    hasConnectedAtLeastOnce() {
        return this.hasConnected;
    }
    async connect(url, token) {
        const scheme = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)?.[1];
        if (scheme === "file") {
            throw new AgentError(errorInfo("NETWORK_ERROR", "file: transport is not supported"));
        }
        if (scheme !== "http" && scheme !== "https") {
            throw new AgentError(errorInfo("NETWORK_ERROR", `unsupported MCP transport scheme: ${scheme ?? "<none>"}`));
        }
        this.url = url;
        this.token = token;
        this.nextId = 1;
        this.connected = false; // handshake not yet confirmed
        try {
            await this.request("initialize", {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
            }, undefined, this.connectTimeoutMs);
            this.connected = true;
            this.hasConnected = true;
        }
        catch (cause) {
            this.connected = false;
            throw cause;
        }
    }
    /** Force a re-initialization handshake (P2-20 reconnect). */
    async reconnect() {
        const url = this.url;
        if (url === undefined) {
            throw new AgentError(errorInfo("INTERNAL_ERROR", "McpClient is not connected"));
        }
        await this.connect(url, this.token);
    }
    /** Re-initialize if currently disconnected (host-side reconnect policy). */
    async ensureConnected() {
        if (!this.connected)
            await this.reconnect();
    }
    /**
     * P2-40 bounded auto-reconnect: re-handshake when disconnected, bounded by the
     * `mcpReconnect` retry-kind spec (maxAttempts + backoffMs from the governance
     * table). Returns true when a reconnection was actually performed. When the
     * budget is exhausted the last error surfaces (NETWORK_ERROR family — the call
     * is never silently dropped). `backoffMs`/`maxAttempts` overrides are for
     * callers that want a tighter budget (e.g. tests); defaults follow the spec.
     */
    async ensureReconnected(opts) {
        if (this.connected)
            return false;
        const spec = RETRY_KIND_SPECS.mcpReconnect;
        const maxAttempts = opts?.maxAttempts ?? spec.maxAttempts;
        const backoffMs = opts?.backoffMs === undefined ? (spec.backoffMs ?? 0) : opts.backoffMs;
        let lastErr;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                await this.reconnect();
                return true;
            }
            catch (err) {
                lastErr = err;
                if (attempt < maxAttempts && backoffMs > 0) {
                    await delay(backoffMs);
                }
            }
        }
        if (lastErr instanceof AgentError)
            throw lastErr;
        throw new AgentError(errorInfo("NETWORK_ERROR", `MCP reconnection budget exhausted (${maxAttempts} attempts)`));
    }
    async close() {
        this.url = undefined;
        this.token = undefined;
        this.connected = false;
    }
    async listTools() {
        const result = await this.request("tools/list", {});
        if (!isRecord(result) || !Array.isArray(result.tools)) {
            throw new AgentError(errorInfo("NETWORK_ERROR", "tools/list response is missing a tools array"));
        }
        return result.tools.map((tool) => {
            if (!isRecord(tool) || typeof tool.name !== "string" || tool.name === "") {
                throw new AgentError(errorInfo("NETWORK_ERROR", "tools/list returned a tool without a name"));
            }
            const info = { name: tool.name };
            if (typeof tool.description === "string")
                info.description = tool.description;
            if (tool.inputSchema !== undefined) {
                info.inputSchema = tool.inputSchema;
            }
            return info;
        });
    }
    /** P1-10: an optional AbortSignal aborts the in-flight HTTP call (no orphan
     *  request). With a signal, cancellation surfaces as USER_CANCELLED. */
    async callTool(name, args, signal) {
        return this.request("tools/call", { name, arguments: args }, signal, this.requestTimeoutMs);
    }
    async request(method, params, signal, timeoutMs) {
        const url = this.url;
        if (url === undefined) {
            throw new AgentError(errorInfo("INTERNAL_ERROR", "McpClient is not connected"));
        }
        const headers = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
        };
        if (this.token !== undefined)
            headers.Authorization = `Bearer ${this.token}`;
        const id = this.nextId++;
        // Timeout handling: a caller-provided signal is authoritative and forwarded
        // unchanged (so USER_CANCELLED is preserved and no orphan call is created).
        // Without a signal we install our own timer that aborts after timeoutMs.
        let ownController;
        let forwardSignal = signal;
        let timedOut = false;
        let timerHandle;
        if (signal === undefined && timeoutMs !== undefined) {
            ownController = new AbortController();
            forwardSignal = ownController.signal;
            timerHandle = this.timer.schedule(() => {
                timedOut = true;
                ownController?.abort();
            }, timeoutMs);
        }
        let response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
                ...(forwardSignal !== undefined ? { signal: forwardSignal } : {}),
            });
        }
        catch (cause) {
            if (signal?.aborted === true) {
                this.connected = false;
                throw new AgentError(errorInfo("USER_CANCELLED", `MCP ${method} aborted`));
            }
            if (ownController !== undefined && ownController.signal.aborted && timedOut) {
                // P2-20: request/connect timeout.
                this.connected = false;
                throw new AgentError(errorInfo("NETWORK_ERROR", `MCP ${method} timed out after ${timeoutMs}ms`));
            }
            // Server unreachable → mark disconnected so the next use re-handshakes.
            this.connected = false;
            throw new AgentError(errorInfo("NETWORK_ERROR", `MCP request failed: ${method}`, { cause }));
        }
        if (!response.ok) {
            this.connected = false;
            throw new AgentError(errorInfo("NETWORK_ERROR", `MCP request failed with HTTP ${response.status}: ${method}`));
        }
        let body;
        try {
            body = (await response.json());
        }
        catch (cause) {
            // P2-20: partial/invalid response body → structured failure.
            throw new AgentError(errorInfo("NETWORK_ERROR", `MCP server returned invalid JSON for ${method}`, { cause }));
        }
        if (body.error !== undefined) {
            throw new AgentError(errorInfo("NETWORK_ERROR", `MCP ${method} error: ${body.error.message}`, {
                cause: {
                    code: body.error.code,
                    message: body.error.message,
                    ...(body.error.data !== undefined ? { data: body.error.data } : {}),
                },
            }));
        }
        // Request completed; disarm the timeout timer (it did not fire).
        if (timerHandle !== undefined)
            timerHandle.cancel();
        return body.result;
    }
}
//# sourceMappingURL=mcp-client.js.map