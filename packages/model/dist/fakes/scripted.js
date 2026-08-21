import { newToolCallId } from "@ar/contracts";
/**
 * ScriptedModelProvider: deterministic event scripts per generate() call.
 * The first provider swapped in/out without any Core changes (MODEL-001).
 */
export class ScriptedModelProvider {
    id = "scripted";
    scripts;
    calls = [];
    abortSignals = [];
    index = 0;
    constructor(scripts) {
        this.scripts = scripts;
    }
    async listModels() {
        return [{ id: "scripted-model", name: "Scripted" }];
    }
    createClient(_model, _config) {
        const provider = this;
        return {
            generate: async function* (_request, signal) {
                const i = provider.index;
                provider.index += 1;
                provider.calls.push(i);
                provider.abortSignals.push(signal);
                const script = provider.scripts[i];
                if (script)
                    yield* script;
            },
        };
    }
    static text(text) {
        return [
            { type: "started", timestamp: 0 },
            { type: "text_delta", text, timestamp: 0 },
            { type: "completed", result: { finishReason: "stop", text }, timestamp: 0 },
        ];
    }
    static toolCall(name, args = {}) {
        return [
            { type: "started", timestamp: 0 },
            { type: "tool_call_delta", toolCall: { id: newToolCallId(), name, args }, timestamp: 0 },
            {
                type: "completed",
                result: { finishReason: "tool_calls", toolCalls: [{ id: newToolCallId(), name, args }] },
                timestamp: 0,
            },
        ];
    }
}
//# sourceMappingURL=scripted.js.map