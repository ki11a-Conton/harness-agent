import {
  stableFingerprint,
  type FrozenToolBinding,
  type StepToolRouter,
  type ToolSpec,
} from "@ar/contracts";

/**
 * P23-2 — immutable per-sampling tool world.
 *
 * A `FrozenStepToolRouter` is built ONCE from the mutable process catalog
 * (ToolRegistry) and its internal map is never mutated after construction.
 * The model-visible spec set and the call-resolution bindings are the SAME
 * frozen objects, so MODEL_VISIBLE_WORLD == TOOL_EXECUTION_WORLD for every
 * model-originated action issued under this step.
 */
export class FrozenStepToolRouter implements StepToolRouter {
  readonly id: string;
  readonly fingerprint: string;
  readonly modelVisibleSpecs: readonly ToolSpec[];
  private readonly byName: ReadonlyMap<string, FrozenToolBinding>;
  /** P23-4: permissive mode is OFF in production (a call for a tool absent
   *  from the frozen step fails TOOL_NOT_IN_STEP). Test fakes that drive a
   *  FakeOrchestrator with arbitrary tool names opt into a permissive router
   *  so those names resolve to inert bindings — mirroring the legacy execute()
   *  behavior those tests were written against. */
  private readonly allowUnlisted: boolean;

  constructor(
    bindings: readonly FrozenToolBinding[],
    id: string,
    /** The exact specs advertised to the model. Defaults to the binding specs;
     *  deferred advertisement (P18-2) passes stubbed specs here while the
     *  bindings keep their full schemas for validation/execution. */
    modelVisibleSpecs?: readonly ToolSpec[],
    allowUnlisted = false,
  ) {
    this.allowUnlisted = allowUnlisted;
    this.id = id;
    // Freeze the exact visible set: no re-sorting, no later mutation.
    this.modelVisibleSpecs = modelVisibleSpecs ?? bindings.map((b) => b.spec);
    // P23-1 deterministic fingerprint: canonical key order only — never
    // function.toString(), object identity, random iteration order, memory
    // address or the clock.
    // P23-1 deterministic fingerprint: canonical key order only. The binding
    // SET is sorted by name so equivalent tool worlds give one identity
    // regardless of insertion order; the visible spec ORDER stays preserved
    // separately for advertisement semantics.
    this.fingerprint = stableFingerprint([
      [...bindings]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((b) => ({
          name: b.name,
          spec: b.spec,
          semantics: b.semantics,
          provenance: b.provenance,
        })),
    ]);
    this.byName = new Map(bindings.map((b) => [b.name, b]));
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  resolve(name: string): FrozenToolBinding | undefined {
    const bound = this.byName.get(name);
    if (bound !== undefined) return bound;
    if (!this.allowUnlisted) return undefined;
    // Inert binding for permissive (test) routers — never executes anything
    // meaningful; a FakeOrchestrator ignores it, a real orchestrator would
    // run the empty stub.
    return {
      name,
      spec: { name, description: `(permissive) ${name}`, inputSchema: { type: "object" } as never },
      definition: {
        name,
        description: `(permissive) ${name}`,
        inputSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
        risk: "readonly",
        metadata: { name, version: "1.0.0", sideEffect: false, network: false, filesystem: false, process: false, interactive: false },
        execute: async () => ({ status: "success", output: "" }),
      },
      semantics: { retrySafety: "safe", concurrencySafety: true, cancellable: true, readOnly: true, idempotent: true, sideEffectScope: "none", networkBehavior: "none", outputSensitivity: "low", requiresApproval: false } as never,
      provenance: { kind: "dynamic" },
    };
  }
}
