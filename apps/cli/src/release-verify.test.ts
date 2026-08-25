import { describe, expect, it } from "vitest";
import {
  computeReleaseVerdict,
  parseGateEvidence,
  renderReleaseVerdict,
  type ReleaseGateResult,
  type RequiredGateId,
} from "./release-verify.js";

const HEAD = "abc123";
const REQUIRED: RequiredGateId[] = [
  "typecheck",
  "test",
  "build",
  "coverage",
  "docs",
  "benchmark_smoke",
  "protocol",
  "security",
  "race",
  "chaos",
  "capability_audit",
];

function allPassed(overrides: Partial<ReleaseGateResult>[] = []): ReleaseGateResult[] {
  const byId = new Map(overrides.map((o) => [o.id, o]));
  return REQUIRED.map((id) => ({
    id,
    state: "passed",
    headSha: HEAD,
    command: `cmd ${id}`,
    ...byId.get(id),
  }));
}

describe("P36-1 release gate truthfulness", () => {
  it("all gates pass at HEAD → ready true, exit 0", () => {
    const verdict = computeReleaseVerdict({ headSha: HEAD, gates: allPassed() });
    expect(verdict.ready).toBe(true);
    expect(verdict.gates.every((g) => g.state === "passed")).toBe(true);
  });

  it("one gate failed → ready false, gate stays failed", () => {
    const gates = allPassed([{ id: "test", state: "failed", reason: "pre-existing race noise" }]);
    const verdict = computeReleaseVerdict({ headSha: HEAD, gates });
    expect(verdict.ready).toBe(false);
    expect(verdict.gates.find((g) => g.id === "test")!.state).toBe("failed");
  });

  it("one gate not_run → ready false", () => {
    const gates = allPassed([{ id: "coverage", state: "not_run" }]);
    const verdict = computeReleaseVerdict({ headSha: HEAD, gates });
    expect(verdict.ready).toBe(false);
  });

  it("one gate blocked → ready false", () => {
    const gates = allPassed([{ id: "build", state: "blocked", reason: "noEmitOnError" }]);
    const verdict = computeReleaseVerdict({ headSha: HEAD, gates });
    expect(verdict.ready).toBe(false);
  });

  it("stale SHA evidence → blocked, ready false", () => {
    const gates = allPassed([{ id: "test", headSha: "old-sha" }]);
    const verdict = computeReleaseVerdict({ headSha: HEAD, gates });
    expect(verdict.ready).toBe(false);
    const test = verdict.gates.find((g) => g.id === "test")!;
    expect(test.state).toBe("blocked");
    expect(test.reason).toContain("stale evidence");
  });

  it("missing evidence for a required gate → not_run, ready false", () => {
    const gates = allPassed().filter((g) => g.id !== "chaos");
    const verdict = computeReleaseVerdict({ headSha: HEAD, gates });
    expect(verdict.ready).toBe(false);
    expect(verdict.gates.find((g) => g.id === "chaos")!.state).toBe("not_run");
  });

  it("'pre-existing' reason with failed state still → ready false", () => {
    const gates = allPassed([{ id: "race", state: "failed", reason: "pre-existing" }]);
    const verdict = computeReleaseVerdict({ headSha: HEAD, gates });
    expect(verdict.ready).toBe(false);
  });

  it("all green at current head → ready true", () => {
    const gates = allPassed();
    const verdict = computeReleaseVerdict({ headSha: HEAD, gates });
    expect(verdict.ready).toBe(true);
  });

  it("render says FAILED when any gate red, never 'complete with known noise'", () => {
    const gates = allPassed([{ id: "test", state: "failed", reason: "known noise" }]);
    const lines = renderReleaseVerdict(computeReleaseVerdict({ headSha: HEAD, gates }));
    expect(lines.join("\n")).toContain("Release verdict: FAILED");
    expect(lines.join("\n")).not.toContain("complete with known noise");
    expect(lines.join("\n")).toContain("test             FAILED");
  });

  it("parseGateEvidence: exit 0 → passed; exit 1 → failed; null → not_run", () => {
    expect(parseGateEvidence(JSON.stringify({ gate: "typecheck", headSha: HEAD, command: "x", exitCode: 0 }), "e.json").state).toBe("passed");
    expect(parseGateEvidence(JSON.stringify({ gate: "typecheck", headSha: HEAD, command: "x", exitCode: 1 }), "e.json").state).toBe("failed");
    expect(parseGateEvidence(JSON.stringify({ gate: "typecheck", headSha: HEAD, command: "x", exitCode: null }), "e.json").state).toBe("not_run");
  });

  it("parseGateEvidence: malformed JSON → throws", () => {
    expect(() => parseGateEvidence("{nope", "e.json")).toThrow(/malformed/);
  });

  it("parseGateEvidence: missing fields → throws", () => {
    expect(() => parseGateEvidence(JSON.stringify({ gate: "typecheck" }), "e.json")).toThrow(/missing/);
  });

  it("parseGateEvidence: unknown gate id → throws", () => {
    expect(() => parseGateEvidence(JSON.stringify({ gate: "bogus", headSha: HEAD, command: "x", exitCode: 0 }), "e.json")).toThrow(/unknown gate/);
  });
});
