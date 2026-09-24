import { describe, expect, it } from "vitest";
import type { HarnessIntrospection } from "@ar/harness";
import {
  buildCapabilityMatrix,
  buildCapabilityMatrixForProfiles,
  CAPABILITY_PROFILES,
  profileOf,
  type AuditInput,
  backingStoreName,
  storeDurabilityLevel,
} from "./audit.js";

/**
 * P20-2 — composition-aware capability matrix. The SAME wiring must be
 * reported differently per profile: ephemeral doesn't require durability,
 * persistent/champion do, benchmark demands harness wiring, champion demands
 * an isolated posture. "Source exists" is never "production" without the
 * profile context.
 */

const EPHEMERAL_INTROSPECTION: HarnessIntrospection = {
  profile: "interactive",
  registeredTools: ["read_file", "grep_search", "repo_tree"],
  stores: {
    session: "MemorySessionStore",
    events: "MemoryEventStore",
  },
  features: {
    context: true,
    verifier: false,
    checkpoint: true,
    artifacts: false,
    memory: true,
    learning: false,
    delegation: false,
    scheduler: false,
    mcp: false,
    plugins: false,
    skills: false,
    stepSnapshot: true,
  },
  persistence: {
    mode: "in-memory",
    degraded: false,
    reasons: [],
    stores: {
      approval: "InMemoryApprovalStore",
      checkpoint: "InMemoryCheckpointStore",
    },
  },
};

const DURABLE_INTROSPECTION: HarnessIntrospection = {
  ...EPHEMERAL_INTROSPECTION,
  registeredTools: [
    "read_file",
    "grep_search",
    "repo_tree",
    "discover_commands",
    "env_snapshot",
    "update_plan",
  ],
  features: { ...EPHEMERAL_INTROSPECTION.features, usageAccounting: true, runBudget: true },
  stores: {
    ...EPHEMERAL_INTROSPECTION.stores,
    session: "JSONLSessionStore",
    events: "JSONLEventStore",
    checkpoint: "DurableCheckpointStore",
    approval: "DurableApprovalStore",
  },
  persistence: {
    mode: "durable",
    degraded: false,
    reasons: [],
    stores: {
      approval: "DurableApprovalStore",
      checkpoint: "DurableCheckpointStore",
    },
  },
};

function input(introspection: HarnessIntrospection): AuditInput {
  return {
    generatedAt: 1_700_000_000_000,
    introspection,
    packages: {
      context: true,
      checkpoint: true,
      artifact: true,
      memory: true,
      learning: true,
      delegation: true,
      scheduler: true,
      ask: true,
      approval: true,
      mcp: true,
      plugin: true,
      skills: true,
      observability: true,
      contracts: true,
    },
    integrationTests: {
      memory: true,
      checkpoint: true,
      delegation: true,
      scheduler: true,
      mcp: true,
      skills: true,
      plugins: true,
      context_pipeline: true,
    },
    benchmarkSuites: {
      regression: { exists: true, caseCount: 3 },
      holdout: { exists: true, caseCount: 2 },
      adversarial: { exists: true, caseCount: 1 },
      stress: { exists: true, caseCount: 1 },
    },
    ciWorkflow: { exists: true, ubuntu: true, windows: true },
    readmeClaims: [],
  };
}

function record(matrix: ReturnType<typeof buildCapabilityMatrix>, id: string) {
  const r = matrix.records.find((x) => x.id === id);
  if (r === undefined) throw new Error(`record ${id} missing`);
  return r;
}

describe("P20-2 profile mapping", () => {
  it("interactive + in-memory => interactive-ephemeral", () => {
    expect(profileOf(input(EPHEMERAL_INTROSPECTION))).toBe("interactive-ephemeral");
  });
  it("interactive + durable => interactive-persistent", () => {
    expect(profileOf(input(DURABLE_INTROSPECTION))).toBe("interactive-persistent");
  });
  it("non-interactive label => benchmark (default audit posture)", () => {
    expect(profileOf(input({ ...DURABLE_INTROSPECTION, profile: "benchmark" }))).toBe("benchmark");
  });
  it("four closed profiles", () => {
    expect(CAPABILITY_PROFILES).toEqual([
      "interactive-ephemeral",
      "interactive-persistent",
      "benchmark",
      "champion",
    ]);
  });
});

describe("P20-2 per-profile durability", () => {
  it("ephemeral profile does NOT demand durability — no degraded reason", () => {
    const matrix = buildCapabilityMatrix(input(EPHEMERAL_INTROSPECTION), "interactive-ephemeral");
    // checkpoint_store is wired (feature on) but the harness is in-memory;
    // ephemeral does not require durability, so durabilitySatisfied is
    // trivially satisfied and NOT degraded — durability is simply not a
    // promise of this profile.
    const checkpoint = record(matrix, "checkpoint_store");
    expect(checkpoint.durabilitySatisfied).toBe(true);
    expect(checkpoint.degradedReason).toBeUndefined();
    expect(matrix.profile).toBe("interactive-ephemeral");
  });

  it("persistent profile on an IN-MEMORY harness degrades durable-required capabilities", () => {
    const matrix = buildCapabilityMatrix(input(EPHEMERAL_INTROSPECTION), "interactive-persistent");
    const checkpoint = record(matrix, "checkpoint_store");
    expect(checkpoint.durabilitySatisfied).toBe(false);
    expect(checkpoint.degradedReason).toMatch(/requires a durable harness/);
    // usage_accounting is required-wired in persistent but the harness did
    // not wire it.
    const usage = record(matrix, "usage_accounting");
    expect(usage.degradedReason).toMatch(/requires usage_accounting wired/);
  });

  it("persistent profile on a DURABLE harness reports durable capabilities", () => {
    const matrix = buildCapabilityMatrix(input(DURABLE_INTROSPECTION), "interactive-persistent");
    const checkpoint = record(matrix, "checkpoint_store");
    expect(checkpoint.durabilitySatisfied).toBe(true);
    expect(checkpoint.degradedReason).toBeUndefined();
  });
});

describe("P20-2 per-profile security mode", () => {
  it("interactive/benchmark promise sandboxed; champion promises isolated", () => {
    const inp = input(DURABLE_INTROSPECTION);
    expect(buildCapabilityMatrix(inp, "interactive-ephemeral").records[0]!.securityMode).toBe("sandboxed");
    expect(buildCapabilityMatrix(inp, "benchmark").records[0]!.securityMode).toBe("sandboxed");
    expect(buildCapabilityMatrix(inp, "champion").records[0]!.securityMode).toBe("isolated");
  });

  it("buildCapabilityMatrixForProfiles produces all four profile matrices", () => {
    const views = buildCapabilityMatrixForProfiles(input(DURABLE_INTROSPECTION));
    expect(Object.keys(views).sort()).toEqual([...CAPABILITY_PROFILES].sort());
    for (const profile of CAPABILITY_PROFILES) {
      expect(views[profile].profile).toBe(profile);
    }
  });

  it("P37-9: backingStoreName maps each capability to its own store", () => {
    const intro = {
      ...DURABLE_INTROSPECTION,
      stores: {
        session: "JSONLSessionStore",
        events: "JSONLEventStore",
        checkpoint: "DurableCheckpointStore",
        memory: "DurableMemoryStore",
        askUser: "JSONLAskUserStore",
        approval: "DurableApprovalStore",
      },
    } as HarnessIntrospection;
    expect(backingStoreName("checkpoint_store", intro)).toBe("DurableCheckpointStore");
    expect(backingStoreName("memory_store", intro)).toBe("DurableMemoryStore");
    expect(backingStoreName("ask_user_durable", intro)).toBe("JSONLAskUserStore");
    expect(backingStoreName("approval_durable", intro)).toBe("DurableApprovalStore");
    expect(backingStoreName("context_pipeline", intro)).toBeUndefined();
  });

  it("P37-9: durability ordering — process < durable, flush < durable", () => {
    expect(storeDurabilityLevel("SQLiteStore")).toBe("process");
    expect(storeDurabilityLevel("JSONLStore")).toBe("durable");
    expect(storeDurabilityLevel("DurableApprovalStore")).toBe("durable");
    expect(storeDurabilityLevel("InMemoryApprovalStore")).toBe("memory");
    expect(storeDurabilityLevel(undefined)).toBe("none");
  });
});
