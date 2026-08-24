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
    /** P35-2: the StepExecutionSnapshot pipeline (P23) is composed — every
     *  model call binds to a frozen world snapshot (tools/MCP/policy/context).
     *  True for the production composition root (the runtime always builds a
     *  snapshot before sampling). Optional so audit test fixtures that omit
     *  it are treated as "not proven" rather than falsely authoritative. */
    stepSnapshot?: boolean;
  };
  /** P0-3: connected MCP transports (present only when ≥1 server connected). */
  mcp?: {
    servers: number;
    tools: string[];
  };
  /** P16-4: durability truth — the harness reports whether it is DURABLE or
   *  IN-MEMORY, and when a durability-required feature (approval/ask_user/
   *  checkpoint/long-run recovery) is enabled WITHOUT a durable store it is
   *  marked `degraded` with the specific reasons. An audit must never claim
   *  production-readiness for a degraded harness. */
  persistence: {
    mode: "durable" | "in-memory";
    degraded: boolean;
    reasons: string[];
    /** Store class actually wired per durability-required feature. */
    stores: {
      approval: string;
      askUser?: string;
      checkpoint?: string;
    };
  };
}