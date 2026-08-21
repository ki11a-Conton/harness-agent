import { AgentError, errorInfo } from "@ar/contracts";
/**
 * EchoModelProvider: replies with the last user message text, streamed
 * word-by-word. A distinct provider from ScriptedModelProvider, used to
 * prove providers are interchangeable without Core changes.
 */
export class EchoModelProvider {
    options;
    id = "echo";
    constructor(options = {}) {
        this.options = options;
    }
    async listModels() {
        return [{ id: "echo-model", name: "Echo" }];
    }
    createClient(_model, _config) {
        const opts = this.options;
        return {
            generate: async function* (request, signal) {
                const last = [...request.messages].reverse().find((m) => m.role === "user");
                const text = last?.content ?? "";
                const words = text.split(" ").filter((w) => w.length > 0);
                let emitted = 0;
                yield { type: "started", timestamp: Date.now() };
                for (const word of words) {
                    if (signal.aborted) {
                        throw new AgentError(errorInfo("USER_CANCELLED", "cancelled by signal"));
                    }
                    emitted += 1;
                    if (opts.failAfterEvents !== undefined && emitted > opts.failAfterEvents) {
                        throw new AgentError(errorInfo("MODEL_ERROR", "echo provider failed on purpose"));
                    }
                    yield { type: "text_delta", text: `${word} `, timestamp: Date.now() };
                    if (opts.deltaDelayMs)
                        await new Promise((r) => setTimeout(r, opts.deltaDelayMs));
                }
                if (opts.emitUsage) {
                    yield { type: "usage", usage: { inputTokens: 1, outputTokens: words.length }, timestamp: Date.now() };
                }
                yield {
                    type: "completed",
                    result: {
                        finishReason: "stop",
                        text: `${words.join(" ")}${words.length ? " " : ""}`,
                        usage: opts.emitUsage ? { inputTokens: 1, outputTokens: words.length } : undefined,
                    },
                    timestamp: Date.now(),
                };
            },
        };
    }
}
//# sourceMappingURL=echo.js.map