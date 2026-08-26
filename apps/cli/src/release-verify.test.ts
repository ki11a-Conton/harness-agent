import { describe, expect, it } from "vitest";
import {
  GATE_COMMANDS,
  REQUIRED_GATE_PLATFORMS,
  aggregateGateInstances,
  computeReleaseVerdict,
  parseGateEvidence,
  parseRawEvidence,
  renderReleaseVerdict,
  validateGateEvidenceInstance,
  type RawGateEvidence,
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
    command: GATE_COMMANDS[id],
    ...byId.get(id),
  }));
}

describe("P36-1 release gate truthfulness", () => {
  it("all gates pass at HEAD → ready true, exit 0", () => {
    const verdict = computeReleaseVerdict({ headSha: HEAD, gates: allPassed() });
    expect(verdict.ready).toBe(true);
    expect(verdict.gates.every((g) => g.state === "passed")).toBe(true);
  });

  it("P38.3-12: attestation separates runtimeReleaseReady from championPromotion", () => {
    const verdict = computeReleaseVerdict({ headSha: HEAD, gates: allPassed() });
    // runtime readiness tracks the free deterministic gates exactly...
    expect(verdict.runtimeReleaseReady).toBe(verdict.ready);
    // ...but champion quality is a SEPARATE concern never evaluated here.
    expect(verdict.championPromotion).toEqual({ status: "not_evaluated" });
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

describe("P38.1-6 evidence passed/exitCode consistency", () => {
  it("passed=false but exitCode=0 → BLOCKED, never green", () => {
    // INV-P38.1-008: a declared `passed:false` with exitCode 0 must be blocked.
    const gate = parseGateEvidence(
      JSON.stringify({ gate: "security", headSha: HEAD, command: GATE_COMMANDS.security, exitCode: 0, passed: false }),
      "security.json",
    );
    expect(gate.state).toBe("blocked");
    expect(gate.reason).toContain("passed does not match exitCode");
  });

  it("passed=true but exitCode=1 → BLOCKED, never green", () => {
    const gate = parseGateEvidence(
      JSON.stringify({ gate: "test", headSha: HEAD, command: GATE_COMMANDS.test, exitCode: 1, passed: true }),
      "test.json",
    );
    expect(gate.state).toBe("blocked");
    expect(gate.reason).toContain("passed does not match exitCode");
  });

  it("passed=true, exitCode=0, exact SHA, canonical command → passed", () => {
    const gate = parseGateEvidence(
      JSON.stringify({ gate: "typecheck", headSha: HEAD, command: GATE_COMMANDS.typecheck, exitCode: 0, passed: true }),
      "e.json",
    );
    expect(gate.state).toBe("passed");
    const verdict = computeReleaseVerdict({ headSha: HEAD, gates: allPassed([{ id: gate.id, state: gate.state }]) });
    expect(verdict.ready).toBe(true);
  });

  it("malformed schema → BLOCKED via throw, not silent fallback", () => {
    expect(() => parseGateEvidence("not json", "e.json")).toThrow(/malformed/);
    expect(() => parseGateEvidence(JSON.stringify({ gate: 42, headSha: HEAD, command: "x", exitCode: 0 }), "e.json")).toThrow();
  });
});

describe("P38.1-7 canonical gate command provenance", () => {
  it("wrong command for a gate → BLOCKED", () => {
    // INV-P38.1-009: gate=test claiming to have run `pnpm test:race` must be blocked.
    const gates = allPassed([{ id: "test", command: "pnpm test:race" }]);
    const verdict = computeReleaseVerdict({ headSha: HEAD, gates });
    expect(verdict.ready).toBe(false);
    const test = verdict.gates.find((g) => g.id === "test")!;
    expect(test.state).toBe("blocked");
    expect(test.reason).toContain("command mismatch");
  });

  it("capability audit impersonation → BLOCKED (INV-P38.1-010)", () => {
    // A substitute audit command must NOT stand in for `pnpm capability:audit`.
    const gates = allPassed([
      { id: "capability_audit", command: "node apps/cli/dist/main.js audit --out report.json" },
    ]);
    const verdict = computeReleaseVerdict({ headSha: HEAD, gates });
    expect(verdict.ready).toBe(false);
    const cap = verdict.gates.find((g) => g.id === "capability_audit")!;
    expect(cap.state).toBe("blocked");
    expect(cap.reason).toContain("command mismatch");
  });

  it("exact canonical capability audit command → passed at HEAD", () => {
    const gates = allPassed();
    expect(gates.find((g) => g.id === "capability_audit")!.command).toBe("pnpm capability:audit");
    const verdict = computeReleaseVerdict({ headSha: HEAD, gates });
    expect(verdict.ready).toBe(true);
    expect(verdict.gates.find((g) => g.id === "capability_audit")!.state).toBe("passed");
  });
});

describe("P38.3-5 validateGateEvidenceInstance", () => {
  const VALID_EVIDENCE: RawGateEvidence = {
    schemaVersion: 1,
    kind: "gate",
    gate: "test",
    headSha: HEAD,
    command: GATE_COMMANDS.test,
    exitCode: 0,
    passed: true,
    platform: "linux",
  };

  it("valid evidence → passed", () => {
    const result = validateGateEvidenceInstance({
      evidence: VALID_EVIDENCE,
      expectedHead: HEAD,
      expectedCommand: GATE_COMMANDS.test,
      expectedGate: "test",
      expectedPlatform: "linux",
      sourcePath: "test.json",
    });
    expect(result.state).toBe("passed");
    expect(result.id).toBe("test");
    expect(result.platform).toBe("linux");
  });

  it("unsupported schemaVersion → throws", () => {
    expect(() => validateGateEvidenceInstance({
      evidence: { ...VALID_EVIDENCE, schemaVersion: 0 },
      expectedHead: HEAD,
      expectedCommand: GATE_COMMANDS.test,
      expectedGate: "test",
      expectedPlatform: "linux",
      sourcePath: "test.json",
    })).toThrow(/unsupported schemaVersion/);
  });

  it("wrong kind → throws", () => {
    expect(() => validateGateEvidenceInstance({
      evidence: { ...VALID_EVIDENCE, kind: "benchmark_run" },
      expectedHead: HEAD,
      expectedCommand: GATE_COMMANDS.test,
      expectedGate: "test",
      expectedPlatform: "linux",
      sourcePath: "test.json",
    })).toThrow(/kind.*benchmark_run.*not.*gate/);
  });

  it("wrong gate id → throws", () => {
    expect(() => validateGateEvidenceInstance({
      evidence: { ...VALID_EVIDENCE, gate: "chaos" },
      expectedHead: HEAD,
      expectedCommand: GATE_COMMANDS.test,
      expectedGate: "test",
      expectedPlatform: "linux",
      sourcePath: "test.json",
    })).toThrow(/does not match expected/);
  });

  it("stale headSha → throws", () => {
    expect(() => validateGateEvidenceInstance({
      evidence: { ...VALID_EVIDENCE, headSha: "deadbeef" },
      expectedHead: HEAD,
      expectedCommand: GATE_COMMANDS.test,
      expectedGate: "test",
      expectedPlatform: "linux",
      sourcePath: "test.json",
    })).toThrow(/stale evidence/);
  });

  it("wrong command → throws", () => {
    expect(() => validateGateEvidenceInstance({
      evidence: { ...VALID_EVIDENCE, command: "echo success" },
      expectedHead: HEAD,
      expectedCommand: GATE_COMMANDS.test,
      expectedGate: "test",
      expectedPlatform: "linux",
      sourcePath: "test.json",
    })).toThrow(/command mismatch/);
  });

  it("wrong platform → throws", () => {
    expect(() => validateGateEvidenceInstance({
      evidence: { ...VALID_EVIDENCE, platform: "windows" },
      expectedHead: HEAD,
      expectedCommand: GATE_COMMANDS.test,
      expectedGate: "test",
      expectedPlatform: "linux",
      sourcePath: "test.json",
    })).toThrow(/does not match expected/);
  });

  it("exitCode null → not_run", () => {
    const result = validateGateEvidenceInstance({
      evidence: { ...VALID_EVIDENCE, exitCode: null, passed: false },
      expectedHead: HEAD,
      expectedCommand: GATE_COMMANDS.test,
      expectedGate: "test",
      expectedPlatform: "linux",
      sourcePath: "test.json",
    });
    expect(result.state).toBe("not_run");
  });

  it("exitCode 1 + passed true → blocked (inconsistent)", () => {
    const result = validateGateEvidenceInstance({
      evidence: { ...VALID_EVIDENCE, exitCode: 1, passed: true },
      expectedHead: HEAD,
      expectedCommand: GATE_COMMANDS.test,
      expectedGate: "test",
      expectedPlatform: "linux",
      sourcePath: "test.json",
    });
    expect(result.state).toBe("blocked");
    expect(result.reason).toContain("inconsistent");
  });

  it("exitCode 1 → failed", () => {
    const result = validateGateEvidenceInstance({
      evidence: { ...VALID_EVIDENCE, exitCode: 1, passed: false },
      expectedHead: HEAD,
      expectedCommand: GATE_COMMANDS.test,
      expectedGate: "test",
      expectedPlatform: "linux",
      sourcePath: "test.json",
    });
    expect(result.state).toBe("failed");
  });
});

describe("P38.3-6 aggregateGateInstances", () => {
  it("all required platforms passed → passed", () => {
    const result = aggregateGateInstances({
      id: "test",
      instances: [
        { id: "test", platform: "linux", state: "passed", headSha: HEAD, command: GATE_COMMANDS.test, evidenceRef: "a.json" },
        { id: "test", platform: "windows", state: "passed", headSha: HEAD, command: GATE_COMMANDS.test, evidenceRef: "b.json" },
      ],
      expectedHead: HEAD,
    });
    expect(result.state).toBe("passed");
    expect(result.id).toBe("test");
  });

  it("missing required platform → failed", () => {
    const result = aggregateGateInstances({
      id: "test",
      instances: [
        { id: "test", platform: "linux", state: "passed", headSha: HEAD, command: GATE_COMMANDS.test, evidenceRef: "a.json" },
      ],
      expectedHead: HEAD,
    });
    expect(result.state).toBe("failed");
    expect(result.reason).toContain("missing required platform windows");
  });

  it("red required platform → failed", () => {
    const result = aggregateGateInstances({
      id: "test",
      instances: [
        { id: "test", platform: "linux", state: "passed", headSha: HEAD, command: GATE_COMMANDS.test, evidenceRef: "a.json" },
        { id: "test", platform: "windows", state: "failed", headSha: HEAD, command: GATE_COMMANDS.test, evidenceRef: "b.json" },
      ],
      expectedHead: HEAD,
    });
    expect(result.state).toBe("failed");
    expect(result.reason).toContain("windows failed");
  });

  it("coverage has single platform only", () => {
    const result = aggregateGateInstances({
      id: "coverage",
      instances: [
        { id: "coverage", platform: "coverage", state: "passed", headSha: HEAD, command: GATE_COMMANDS.coverage, evidenceRef: "cov.json" },
      ],
      expectedHead: HEAD,
    });
    expect(result.state).toBe("passed");
  });

  it("duplicate linux cannot substitute for missing windows", () => {
    const result = aggregateGateInstances({
      id: "test",
      instances: [
        { id: "test", platform: "linux", state: "passed", headSha: HEAD, command: GATE_COMMANDS.test, evidenceRef: "a.json" },
        { id: "test", platform: "linux", state: "passed", headSha: HEAD, command: GATE_COMMANDS.test, evidenceRef: "c.json" },
      ],
      expectedHead: HEAD,
    });
    expect(result.state).toBe("failed");
    expect(result.reason).toContain("missing required platform windows");
  });
});

describe("REQUIRED_GATE_PLATFORMS shape", () => {
  it("every REQUIRED_GATE has a platform entry", () => {
    for (const gate of ["typecheck", "test", "build", "coverage", "docs", "benchmark_smoke", "protocol", "security", "race", "chaos", "capability_audit"] as RequiredGateId[]) {
      expect(REQUIRED_GATE_PLATFORMS[gate]).toBeDefined();
      expect(REQUIRED_GATE_PLATFORMS[gate].length).toBeGreaterThan(0);
    }
  });

  it("coverage is single-platform", () => {
    expect(REQUIRED_GATE_PLATFORMS.coverage).toEqual(["coverage"]);
  });

  it("non-coverage gates require linux+windows", () => {
    for (const gate of ["typecheck", "test", "build", "docs", "benchmark_smoke", "protocol", "security", "race", "chaos", "capability_audit"] as RequiredGateId[]) {
      expect(REQUIRED_GATE_PLATFORMS[gate]).toEqual(["linux", "windows"]);
    }
  });
});

describe("parseRawEvidence", () => {
  it("full valid evidence → RawGateEvidence", () => {
    const raw = parseRawEvidence(
      JSON.stringify({ schemaVersion: 1, kind: "gate", gate: "test", headSha: HEAD, command: GATE_COMMANDS.test, exitCode: 0, passed: true, platform: "linux" }),
      "e.json",
    );
    expect(raw.gate).toBe("test");
    expect(raw.schemaVersion).toBe(1);
    expect(raw.kind).toBe("gate");
  });

  it("missing gate id → throws", () => {
    expect(() => parseRawEvidence(JSON.stringify({ headSha: HEAD }), "e.json")).toThrow(/missing gate/);
  });

  it("unknown gate id → throws", () => {
    expect(() => parseRawEvidence(JSON.stringify({ gate: "bogus", headSha: HEAD, command: "x", exitCode: 0 }), "e.json")).toThrow(/unknown gate/);
  });

  it("non-JSON → throws", () => {
    expect(() => parseRawEvidence("{nope", "e.json")).toThrow(/malformed/);
  });
});
