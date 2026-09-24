import { describe, expect, it } from "vitest";
import { resolveFeatureFlags, resolveProfile } from "./profiles.js";

describe("P21-5 champion profile v1", () => {
  it("trusted surface defaults ON (context/checkpoint/artifacts/skills/observability)", () => {
    const flags = resolveFeatureFlags("champion", undefined);
    expect(flags.context).toBe(true);
    expect(flags.checkpoint).toBe(true);
    expect(flags.artifacts).toBe(true);
    expect(flags.skills).toBe(true);
    expect(flags.observability).toBe(true);
  });

  it("evidence-gated mechanisms default OFF (memory/delegation/learning)", () => {
    const flags = resolveFeatureFlags("champion", undefined);
    expect(flags.memory).toBe(false);
    expect(flags.delegation).toBe(false);
    expect(flags.learning).toBe(false);
  });

  it("trust-surface mechanisms default OFF (mcp/plugins)", () => {
    const flags = resolveFeatureFlags("champion", undefined);
    expect(flags.mcp).toBe(false);
    expect(flags.plugins).toBe(false);
  });

  it("permissions are batch-style: network denied, edits/exec ask", () => {
    const preset = resolveProfile("champion");
    const rules = preset.permissions.rules;
    const edit = rules.find((r) => r.action === "edit" && r.resource === "file");
    const network = rules.find((r) => r.action === "exec" && r.resource === "network");
    expect(edit?.effect).toBe("ask");
    expect(network?.effect).toBe("deny");
  });

  it("agrees with the P21-2 candidate default policies (yes/evidence/no)", () => {
    const flags = resolveFeatureFlags("champion", undefined);
    // "yes" candidates are ON in the champion preset.
    expect(flags.context).toBe(true); // context_pipeline_v5 -> yes
    // "evidence" candidates are OFF until proven (P21-4).
    expect(flags.memory).toBe(false); // memory_retrieval -> evidence
    expect(flags.delegation).toBe(false); // delegation -> evidence
    // "no" candidates are OFF.
    expect(flags.mcp).toBe(false);
    expect(flags.plugins).toBe(false);
  });
});
