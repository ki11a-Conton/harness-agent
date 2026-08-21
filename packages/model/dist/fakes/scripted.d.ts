import type { ModelEvent, ModelProvider, ModelRef, ProviderConfig } from "@ar/contracts";
export type Script = Array<ModelEvent> | AsyncIterable<ModelEvent>;
/**
 * ScriptedModelProvider: deterministic event scripts per generate() call.
 * The first provider swapped in/out without any Core changes (MODEL-001).
 */
export declare class ScriptedModelProvider implements ModelProvider {
    readonly id = "scripted";
    readonly scripts: Script[];
    calls: number[];
    abortSignals: AbortSignal[];
    private index;
    constructor(scripts: Script[]);
    listModels(): Promise<{
        id: string;
        name: string;
    }[]>;
    createClient(_model: ModelRef, _config: ProviderConfig): {
        generate: (_request: unknown, signal: AbortSignal) => AsyncGenerator<ModelEvent, void, any>;
    };
    static text(text: string): ModelEvent[];
    static toolCall(name: string, args?: Record<string, unknown>): ModelEvent[];
}
//# sourceMappingURL=scripted.d.ts.map