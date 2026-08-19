import { describe, expect, it } from "vitest";
import {
  PolicyConfigRegistry,
  hashPolicyConfig,
  stableSerializeConfig,
  PolicyVersionError,
} from "./policy-versioning.js";

function evidence(suite: string, caseId: string, before: number, after: number) {
  return [{ benchmark: { suite, caseId, beforeScore: before, afterScore: after } }];
}

describe("P2-17 policy config versioning — publish & provenance", () => {
  it("stamps a per-policy version with a stable hash + reason + evidence", () => {
    const reg = new PolicyConfigRegistry();
    const v1 = reg.publish({
      policy: "retry",
      config: { maxRetries: 3, backoff: "linear" },
      changeReason: "increase rescues",
      candidateSource: "benchmark",
      benchmarkEvidence: evidence("regression", "r3", 0.8, 0.92),
    });
    expect(v1.policy).toBe("retry");
    expect(v1.version).toBe(1);
    expect(v1.hash).toBe(hashPolicyConfig({ maxRetries: 3, backoff: "linear" }));
    expect(v1.active).toBe(true);
    expect(reg.getActive("retry")!.hash).toBe(v1.hash);
  });

  it("keeps an independent version counter per policy", () => {
    const reg = new PolicyConfigRegistry();
    reg.publish({ policy: "retry", config: { a: 1 }, changeReason: "r1" });
    reg.publish({ policy: "retry", config: { a: 2 }, changeReason: "r2" });
    reg.publish({ policy: "compaction", config: { x: 1 }, changeReason: "c1" });
    expect(reg.count("retry")).toBe(2);
    expect(reg.count("compaction")).toBe(1);
    expect(reg.getActive("retry")!.version).toBe(2);
    expect(reg.getActive("compaction")!.version).toBe(1);
  });

  it("hash is stable regardless of object key order", () => {
    expect(hashPolicyConfig({ a: 1, b: 2 })).toBe(hashPolicyConfig({ b: 2, a: 1 }));
    expect(stableSerializeConfig({ b: 2, a: 1 })).toBe(stableSerializeConfig({ a: 1, b: 2 }));
  });
});

describe("P2-17 policy config versioning — validation", () => {
  it("rejects empty policy, missing config and missing reason", () => {
    const reg = new PolicyConfigRegistry();
    expect(() => reg.publish({ policy: " ", config: { a: 1 }, changeReason: "r" })).toThrowError(
      PolicyVersionError,
    );
    expect(() =>
      reg.publish({ policy: "p", config: undefined as unknown as Record<string, unknown>, changeReason: "r" }),
    ).toThrowError(PolicyVersionError);
    expect(() => reg.publish({ policy: "p", config: { a: 1 }, changeReason: "" })).toThrowError(
      PolicyVersionError,
    );
  });

  it("rejects a duplicate config hash for the same policy", () => {
    const reg = new PolicyConfigRegistry();
    reg.publish({ policy: "scheduler", config: { burst: 5 }, changeReason: "r1" });
    expect(() =>
      reg.publish({ policy: "scheduler", config: { burst: 5 }, changeReason: "r2" }),
    ).toThrowError(/identical to an existing version/);
  });
});

describe("P2-17 policy config versioning — rollback & trace", () => {
  it("rolls back one policy without affecting another", () => {
    const reg = new PolicyConfigRegistry();
    reg.publish({ policy: "retry", config: { maxRetries: 2 }, changeReason: "r1" });
    reg.publish({ policy: "retry", config: { maxRetries: 6 }, changeReason: "r2 bad" });
    reg.publish({ policy: "verification", config: { gate: "strict" }, changeReason: "v1" });

    const rolled = reg.rollback("retry", 1);
    expect(rolled.config).toEqual({ maxRetries: 2 });
    expect(reg.getActive("retry")!.version).toBe(1);
    expect(reg.getActive("verification")!.version).toBe(1); // untouched
    expect(reg.getVersion("retry", 2)!.active).toBe(false);
  });

  it("rolls back to an unknown version → error", () => {
    const reg = new PolicyConfigRegistry();
    reg.publish({ policy: "p", config: { a: 1 }, changeReason: "r" });
    expect(() => reg.rollback("p", 7)).toThrowError(/no version 7/);
  });

  it("exportTrace gives the active policy→(version, hash, change) map for a manifest", () => {
    const reg = new PolicyConfigRegistry();
    reg.publish({ policy: "retry", config: { maxRetries: 3 }, changeReason: "r1" });
    reg.publish({ policy: "compaction", config: { ratio: 0.5 }, changeReason: "c1" });
    reg.publish({ policy: "retry", config: { maxRetries: 4 }, changeReason: "r2 from benchmark" });
    const trace = reg.exportTrace();
    expect(Object.keys(trace).sort()).toEqual(["compaction", "retry"]);
    expect(trace["retry"]!.version).toBe(2);
    expect(trace["retry"]!.hash).toBe(hashPolicyConfig({ maxRetries: 4 }));
    // rollback reflects in the trace: retry goes back to v1.
    reg.rollback("retry", 1);
    const trace2 = reg.exportTrace();
    expect(trace2["retry"]!.version).toBe(1);
  });
});

describe("P2-17 policy config versioning — integrity & snapshot", () => {
  it("detects a config mutated in place after publication", () => {
    const reg = new PolicyConfigRegistry();
    const v = reg.publish({ policy: "mem-rank", config: { k: 12 }, changeReason: "r1" });
    expect(reg.verifyIntegrity().ok).toBe(true);
    (v.config as { k: number }).k = 999;
    const result = reg.verifyIntegrity();
    expect(result.ok).toBe(false);
    expect(result.violated).toEqual([{ policy: "mem-rank", version: 1 }]);
  });

  it("round-trips through a snapshot preserving policy provenance", () => {
    const reg = new PolicyConfigRegistry();
    reg.publish({ policy: "retry", config: { a: 1 }, changeReason: "r1", candidateSource: "human" });
    reg.publish({ policy: "retry", config: { a: 2 }, changeReason: "r2" });

    const restored = new PolicyConfigRegistry();
    restored.importSnapshot(reg.exportSnapshot());
    expect(restored.count("retry")).toBe(2);
    expect(restored.getActive("retry")!.version).toBe(2);
    expect(restored.getVersion("retry", 1)!.candidateSource).toBe("human");
    expect(restored.getVersion("retry", 1)!.hash).toBe(hashPolicyConfig({ a: 1 }));
  });
});