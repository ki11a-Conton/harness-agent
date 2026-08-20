import { describe, expect, it } from "vitest";
import { PromptVersionRegistry, hashRuleContent, RuleVersionError } from "./prompt-versioning.js";

function evidence(suite: string, caseId: string, before: number, after: number) {
  return { benchmark: { suite, caseId, beforeScore: before, afterScore: after } };
}

describe("P2-16 prompt rule versioning — publish & provenance", () => {
  it("stamps version 1 with a hash, reason, candidate source and evidence", () => {
    const reg = new PromptVersionRegistry();
    const v1 = reg.publish({
      content: "You are the harness.",
      changeReason: "initial prompt",
      candidateSource: "human",
      benchmarkEvidence: [evidence("regression", "r1", 0.8, 0.9)],
    });
    expect(v1.version).toBe(1);
    expect(v1.hash).toBe(hashRuleContent("You are the harness."));
    expect(v1.changeReason).toBe("initial prompt");
    expect(v1.candidateSource).toBe("human");
    expect(v1.active).toBe(true);
    expect(reg.getActive()!.hash).toBe(v1.hash);
  });

  it("each publish is an immutable append; only the latest is active", () => {
    const reg = new PromptVersionRegistry();
    const v1 = reg.publish({ content: "a", changeReason: "r1" });
    const v2 = reg.publish({ content: "b", changeReason: "r2" });
    const v3 = reg.publish({ content: "c", changeReason: "r3" });

    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
    expect(reg.list()).toHaveLength(3);
    expect(reg.list().filter((r) => r.active)).toHaveLength(1);
    expect(reg.getActive()!.version).toBe(3);
    // older versions keep their exact content/hash — never mutated.
    expect(reg.getVersion(1)!.content).toBe("a");
    expect(reg.getVersion(1)!.hash).toBe(hashRuleContent("a"));
  });
});

describe("P2-16 prompt rule versioning — validation", () => {
  it("rejects empty content and missing change reason", () => {
    const reg = new PromptVersionRegistry();
    expect(() => reg.publish({ content: "   ", changeReason: "r" })).toThrowError(
      RuleVersionError,
    );
    expect(() => reg.publish({ content: "", changeReason: "r" })).toThrowError(
      RuleVersionError,
    );
    expect(() => reg.publish({ content: "x", changeReason: " " })).toThrowError(
      RuleVersionError,
    );
  });

  it("rejects duplicate content (same hash) — no-op churn is never wanted", () => {
    const reg = new PromptVersionRegistry();
    reg.publish({ content: "rule", changeReason: "r1" });
    expect(() => reg.publish({ content: "rule", changeReason: "r2" })).toThrowError(
      /identical to an existing version/,
    );
  });
});

describe("P2-16 prompt rule versioning — rollback", () => {
  it("rolls back to a prior version and deactivates newer ones", () => {
    const reg = new PromptVersionRegistry();
    reg.publish({ content: "v1", changeReason: "r1" });
    reg.publish({ content: "v2bad", changeReason: "r2 triggered a regression" });
    reg.publish({ content: "v3", changeReason: "r3" });

    const rolled = reg.rollback(1);
    expect(rolled.content).toBe("v1");
    expect(reg.getActive()!.version).toBe(1);
    expect(reg.getVersion(2)!.active).toBe(false);
    expect(reg.getVersion(3)!.active).toBe(false);
    // History is untouched — rollback is re-activation, not deletion.
    expect(reg.list()).toHaveLength(3);
  });

  it("rolling back to the already-active version is a no-op", () => {
    const reg = new PromptVersionRegistry();
    reg.publish({ content: "a", changeReason: "r1" });
    reg.publish({ content: "b", changeReason: "r2" });
    const active = reg.getActive()!;
    expect(reg.rollback(active.version)).toBe(active);
    expect(reg.getActive()!.version).toBe(2);
  });

  it("rolling back to an unknown version throws", () => {
    const reg = new PromptVersionRegistry();
    reg.publish({ content: "a", changeReason: "r1" });
    expect(() => reg.rollback(99)).toThrowError(/no version 99/);
  });
});

describe("P2-16 prompt rule versioning — integrity", () => {
  it("detects content mutated in place after publication", () => {
    const reg = new PromptVersionRegistry();
    const v1 = reg.publish({ content: "trusted content", changeReason: "r1" });
    expect(reg.verifyIntegrity().ok).toBe(true);

    (v1 as { content: string }).content = "tampered!";
    const result = reg.verifyIntegrity();
    expect(result.ok).toBe(false);
    expect(result.violated).toContain(1);
  });

  it("round-trips through a snapshot preserving version + provenance", () => {
    const reg = new PromptVersionRegistry();
    reg.publish({ content: "a", changeReason: "r1", candidateSource: "human" });
    reg.publish({ content: "b", changeReason: "r2" });
    reg.rollback(1);

    const restored = new PromptVersionRegistry();
    restored.importSnapshot(reg.exportSnapshot());
    expect(restored.list()).toHaveLength(2);
    expect(restored.getActive()!.version).toBe(1);
    expect(restored.getVersion(2)!.candidateSource).toBeUndefined();
    expect(restored.getVersion(1)!.hash).toBe(hashRuleContent("a"));
  });
});