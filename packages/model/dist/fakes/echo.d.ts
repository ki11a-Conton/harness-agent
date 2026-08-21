import type { ModelClient, ModelProvider, ModelRef, ProviderConfig } from "@ar/contracts";
export interface EchoOptions {
    /** Delay between text deltas (ms). Used to test cancellation mid-stream. */
    deltaDelayMs?: number;
    /** Simulated provider failure after `failAfterEvents` events. */
    failAfterEvents?: number;
    /** Emit a usage event when done. */
    emitUsage?: boolean;
}
/**
 * EchoModelProvider: replies with the last user message text, streamed
 * word-by-word. A distinct provider from ScriptedModelProvider, used to
 * prove providers are interchangeable without Core changes.
 */
export declare class EchoModelProvider implements ModelProvider {
    private readonly options;
    readonly id = "echo";
    constructor(options?: EchoOptions);
    listModels(): Promise<{
        id: string;
        name: string;
    }[]>;
    createClient(_model: ModelRef, _config: ProviderConfig): ModelClient;
}
//# sourceMappingURL=echo.d.ts.map