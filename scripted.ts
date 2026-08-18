import type { ModelEvent, ModelProvider, ModelRef, ProviderConfig } from "@ar/contracts";
import { newToolCallId } from "@ar/contracts";

export type Script = Array<ModelEvent> | AsyncIterable<ModelEvent>;

/**
 * ScriptedModelProvider: deterministic event scripts per generate() call.
 * The first provider swapped in/out without any Core changes (MODEL-001).
 */
export class ScriptedModelProvider implements ModelProvider {
  readonly id = "scripted";
  readonly scripts: Script[];
  calls: number[] = [];
  abortSignals: AbortSignal[] = [];
  private index = 0;

  constructor(scripts: Script[]) {
    this.scripts = scripts;
  }

  async listModels() {
    return [{ id: "scripted-model", name: "Scripted" }];
  }

  createClient(_model: ModelRef, _config: ProviderConfig) {
    const provider = this;
    return {
      generate: async function* (_request: unknown, signal: AbortSignal) {
        const i = provider.index;
        provider.index += 1;
        provider.calls.push(i);
        provider.abortSignals.push(signal);
        const script = provider.scripts[i];
        if (script) yield* script;
      },
    };
  }

  static text(text: string): ModelEvent[] {
    return [
      { type: "started", timestamp: 0 },
      { type: "text_delta", text, timestamp: 0 },
      { type: "completed", result: { finishReason: "stop", text }, timestamp: 0 },
    ];
  }

  static toolCall(name: string, args: Record<string, unknown> = {}): ModelEvent[] {
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