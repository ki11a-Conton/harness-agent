import type { ModelEvent, ModelProvider } from "@ar/contracts";
import { errorInfo } from "@ar/contracts";

export const STUB_PROVIDER_ID = "stub";

/** Placeholder provider: makes missing configuration a structured, visible
 *  failure (agent doctor flags it; runs fail with MODEL_ERROR). */
export function stubProvider(): ModelProvider {
  return {
    id: STUB_PROVIDER_ID,
    async listModels() {
      return [];
    },
    createClient() {
      return {
        async *generate(): AsyncGenerator<ModelEvent, void, void> {
          yield {
            type: "error",
            error: errorInfo(
              "MODEL_ERROR",
              "no model provider configured — set OPENAI_API_KEY and restart",
            ),
            timestamp: 0,
          };
        },
      };
    },
  };
}

export interface ResolveModelProviderOptions {
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Default model provider resolution: when OPENAI_API_KEY is present, load the
 * OpenAI-compatible provider from @ar/model; otherwise fall back to the stub
 * (the doctor reports the difference as a WARNING).
 */
export async function resolveModelProvider(opts: ResolveModelProviderOptions = {}): Promise<ModelProvider> {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey === "") return stubProvider();
  const provider = await tryLoadOpenAICompatibleProvider(apiKey, opts.baseUrl);
  return provider ?? stubProvider();
}

async function tryLoadOpenAICompatibleProvider(
  apiKey: string,
  baseUrl?: string,
): Promise<ModelProvider | undefined> {
  try {
    // @ar/model's OpenAICompatibleProvider (packages/model/src/openai.ts) is
    // being added by a parallel session. The structural cast keeps this code
    // valid both before and after that file lands: a missing export simply
    // resolves to the stub provider.
    const mod = (await import("@ar/model")) as {
      OpenAICompatibleProvider?: new (config: {
        apiKey?: string;
        baseUrl?: string;
        modelId?: string;
      }) => ModelProvider;
    };
    const Provider = mod.OpenAICompatibleProvider;
    if (Provider === undefined) return undefined;
    return new Provider({ apiKey, ...(baseUrl !== undefined ? { baseUrl } : {}) });
  } catch {
    return undefined;
  }
}