/**
 * Runtime introspection contract (plan.md P0-1 + P0-3).
 *
 * The composition root reports what it ACTUALLY wired: store implementations
 * by constructor name, registered tool names, and feature flags. The audit
 * (`agent audit`) derives capability status from these facts alone — never
 * from documentation.
 *
 * `usageAccounting` / `runBudget` are P0-1 extensions over the plan sketch:
 * the runtime-internal accounting chain cannot be observed from the host yet,
 * so the host reports what it knows.
 */
export interface HarnessIntrospection {
  profile: string;
  registeredTools: string[];
  stores: {
    session: string;
    events: string;
    checkpoint?: string;
    memory?: string;
    approval?: string;
    askUser?: string;
    artifacts?: string;
  };
  features: {
    context: boolean;
    verifier: boolean;
    checkpoint: boolean;
    artifacts: boolean;
    memory: boolean;
    learning: boolean;
    delegation: boolean;
    scheduler: boolean;
    mcp: boolean;
    plugins: boolean;
    skills: boolean;
    usageAccounting?: boolean;
    runBudget?: boolean;
  };
}