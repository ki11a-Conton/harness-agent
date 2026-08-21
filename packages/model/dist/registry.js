import { AgentError } from "@ar/contracts";
/**
 * ModelRegistry: named provider lookup. Core never touches this —
 * the runtime receives a ModelProvider directly (dependency injection).
 */
export class ModelRegistry {
    providers = new Map();
    register(provider) {
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
    get(providerId) {
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
    list() {
        return [...this.providers.values()];
    }
    createClient(ref, config = {}) {
        return this.get(ref.providerId).createClient(ref, config);
    }
}
//# sourceMappingURL=registry.js.map