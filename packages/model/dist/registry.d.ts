import type { ModelClient, ModelProvider, ModelRef, ProviderConfig } from "@ar/contracts";
/**
 * ModelRegistry: named provider lookup. Core never touches this —
 * the runtime receives a ModelProvider directly (dependency injection).
 */
export declare class ModelRegistry {
    private providers;
    register(provider: ModelProvider): void;
    get(providerId: string): ModelProvider;
    list(): ModelProvider[];
    createClient(ref: ModelRef, config?: ProviderConfig): ModelClient;
}
//# sourceMappingURL=registry.d.ts.map