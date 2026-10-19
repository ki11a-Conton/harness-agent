import type { ModelClient, ModelProvider, ModelRef, ModelRequest, ProviderConfig } from "@ar/contracts";

/**
 * DSH parity for `session/selectModel`: selecting a model for an already started
 * session changes the model of the NEXT request instead of refusing the switch.
 * A session that belongs to the harness the host was started with keeps its
 * native identity, so its provider instance cannot be replaced on a switch. The
 * provider therefore keeps its declared identity and resolves the route of the
 * model it is actually asked to run from the live catalogue, instead of pinning
 * the single route the host was built with.
 *
 * Requests for the host's own route keep the exact previous code path.
 */
export interface SwitchedRoute {
  /** The concrete provider that serves this route (never a stub fallback). */
  provider: ModelProvider;
  /** Catalogue output cap for this route's model, used to clamp `maxTokens`. */
  maximumOutputTokens?: number;
}

export type RouteResolver = (providerKey: string, modelId: string, signal?: AbortSignal) => Promise<SwitchedRoute | undefined>;

export interface RouteAwareProvider {
  /** The wrapped provider, kept for hosts that must retain its exact identity. */
  readonly inner: ModelProvider;
  /** Drop-in replacement for the wrapped provider. */
  readonly provider: ModelProvider;
  install(resolver: RouteResolver): void;
  installRequestTransform(transform: RequestTransform): void;
}
export type RequestTransform = (request: ModelRequest, model: ModelRef) => Promise<ModelRequest>;

/** P27 compares a provider without `getConfigIdentity` by its own enumerable
 * fields, functions included by name. The wrapper must therefore present exactly
 * the same fields, with the same enumerability and the same function names, or an
 * upgraded host would read every stored session as drifted configuration. */
function identityNeutralProvider(inner: ModelProvider, overrides: Record<string, unknown>): ModelProvider {
  const provider = Object.create(Object.getPrototypeOf(inner) ?? Object.prototype) as ModelProvider;
  for (const key of Reflect.ownKeys(inner)) Object.defineProperty(provider, key, Object.getOwnPropertyDescriptor(inner, key)!);
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "function") continue;
    const prior = Object.getOwnPropertyDescriptor(inner, key);
    Object.defineProperty(value, "name", { value: typeof prior?.value === "function" && prior.value.name.length > 0 ? prior.value.name : key, configurable: true });
    Object.defineProperty(provider, key, { value, enumerable: prior?.enumerable ?? false, configurable: true, writable: true });
  }
  // A declared identity must be read from the original instance: providers may
  // hold private fields that only exist on it.
  if (typeof inner.getConfigIdentity === "function") {
    Object.defineProperty(provider, "getConfigIdentity", { value: () => inner.getConfigIdentity!(), enumerable: false, configurable: true, writable: true });
  }
  return provider;
}

/**
 * Wrap `inner` so that models of other routes can be served without replacing
 * it. Identity, model listing and the inner route's own clients are delegated
 * unchanged: a host that is never asked for another route behaves as before.
 */
export function routeAwareProvider(inner: ModelProvider): RouteAwareProvider {
  let resolver: RouteResolver | undefined;
  let transform: RequestTransform | undefined;
  const clamped = (client: ModelClient, maximum: number | undefined): ModelClient => maximum === undefined ? client : {
    generate: (request: ModelRequest, signal: AbortSignal) =>
      client.generate({ ...request, maxTokens: Math.min(request.maxTokens ?? maximum, maximum) }, signal),
  };
  const listModels = () => inner.listModels();
  const createClient: ModelProvider["createClient"] = (model: ModelRef, config: ProviderConfig): ModelClient => {
    const ownClient = model.providerId === inner.id ? inner.createClient(model, config) : undefined;
    return {
      generate: async function* (request: ModelRequest, signal: AbortSignal) {
        if (transform !== undefined) request = await transform(request, model);
        if (ownClient !== undefined) { yield* ownClient.generate(request, signal); return; }
        const route = resolver === undefined ? undefined : await resolver(model.providerId, model.modelId, signal);
        // An unresolvable route stays a provider-level failure: never send
        // another route's model id to this route's upstream.
        const client = route === undefined
          ? inner.createClient(model, config)
          : clamped(route.provider.createClient({ ...model, providerId: route.provider.id }, config), route.maximumOutputTokens);
        yield* client.generate(request, signal);
      },
    };
  };
  const provider = identityNeutralProvider(inner, { listModels, createClient });
  return { inner, provider, install: (next: RouteResolver) => { resolver = next; }, installRequestTransform: next => { transform = next; } };
}
