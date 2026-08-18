import type { ModelClient, ModelProvider, ModelRef, ProviderConfig } from "@ar/contracts";
import { AgentError } from "@ar/contracts";

/**
 * ModelRegistry: named provider lookup. Core never touches this —
 * the runtime receives a ModelProvider directly (dependency injection).
 */
export class ModelRegistry {
  private providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): void {
    if (this.providers.has(provider.id)) {
      throw new AgentError({
        code: "INTERNAL_ERROR",
        message: `model provider already registered: ${provider.id}`,
        retryable: false,
        safeToRetry: false,
      });
    }
    this.providers.set(provider.id, provider);
  }

  get(providerId: string): ModelProvider {
    const p = this.providers.get(providerId);
    if (!p) {
      throw new AgentError({
        code: "MODEL_ERROR",
        message: `unknown model provider: ${providerId}`,
        retryable: false,
        safeToRetry: false,
      });
    }
    return p;
  }

  list(): ModelProvider[] {
    return [...this.providers.values()];
  }

  createClient(ref: ModelRef, config: ProviderConfig = {}): ModelClient {
    return this.get(ref.providerId).createClient(ref, config);
  }
}