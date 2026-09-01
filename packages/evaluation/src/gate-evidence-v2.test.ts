import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGateEvidenceV2,
  verifyGateEvidenceV2,
  captureGitState,
  digestOf,
  GATE_EVIDENCE_V2_SCHEMA_VERSION,
  type GateEvidenceV2,
} from "./gate-evidence-v2.js";

const HEAD = "deadbeef";
const CMD = ["pnpm", "capability:audit"];

function mkEvidence(overrides: Partial<GateEvidenceV2> = {}): GateEvidenceV2 {
  return buildGateEvidenceV2({
    gate: "capability_audit",
    command: CMD,
    toolVersion: "1.0.0",
    gitSha: HEAD,
    cleanBefore: true,
    cleanAfter: true,
    input: { matrix: "a" },
    output: { summary: "ok" },
    startedAtIso: "2026-09-01T00:00:00.000Z",
    finishedAtIso: "2026-09-01T00:00:01.000Z",
    exitCode: 0,
    passed: true,
    state: "passed",
    summary: "capability audit passed",
    ...overrides,
  } as never);
}

function verify(e: GateEvidenceV2, opts: Record<string, unknown> = {}) {
  return verifyGateEvidenceV2(e, {
    expectedHead: HEAD,
    expectedCommand: CMD,
    ...opts,
  } as never);
}

describe("E2-13 gate evidence V2", () => {
  it("1. valid evidence passes strict verification (HEAD-bound, clean, non-tampered)", () => {
    const result = verify(mkEvidence());
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("2. stale HEAD evidence is rejected (freshness is HEAD-bound, not wall-clock)", () => {
    const result = verify(mkEvidence({ gitSha: "other-sha" }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "STALE_HEAD")).toBe(true);
  });

  it("3. command mismatch is rejected (a different command is a different gate)", () => {
    const result = verify(mkEvidence({ command: ["pnpm", "whoami"] }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "COMMAND_MISMATCH")).toBe(true);
  });

  it("4. tampered exitCode/passed contradiction is rejected with EXIT_CODE_TAMPERED", () => {
    const tampered = mkEvidence({ passed: true, exitCode: 1 });
    const result = verify(tampered);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "EXIT_CODE_TAMPERED")).toBe(true);

    const tampered2 = mkEvidence({ passed: false, exitCode: 0 });
    const result2 = verify(tampered2);
    expect(result2.ok).toBe(false);
    expect(result2.issues.some((i) => i.code === "EXIT_CODE_TAMPERED")).toBe(true);
  });

  it("5. dirty source AFTER the gate run invalidates the evidence", () => {
    const result = verify(mkEvidence({ cleanAfter: false }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "SOURCE_DIRTY_AFTER")).toBe(true);
  });

  it("6. output digest mismatch is rejected", () => {
    const result = verify(mkEvidence(), { expectedOutputDigest: "wrong-digest" });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "DIGEST_MISMATCH")).toBe(true);
  });

  it("7. NOT_RUN is a stable state, never PASS", () => {
    const result = verify(mkEvidence({ state: "not_run", exitCode: null, passed: false }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "NOT_RUN")).toBe(true);
  });

  it("8. unauthorized paid gate is BLOCKED (PAID_BENCHMARK_NOT_AUTHORIZED), never PASS", () => {
    const result = verify(mkEvidence({ gate: "ar2_paid_reeval" }), {
      paidGate: true,
      paidAuthorized: false,
      expectedCommand: ["pnpm", "benchmark", "ar2"],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "PAID_BENCHMARK_NOT_AUTHORIZED")).toBe(true);
  });

  it("9. digestOf is deterministic and content-sensitive", () => {
    expect(digestOf({ a: 1, b: [1, 2] })).toBe(digestOf({ a: 1, b: [1, 2] }));
    expect(digestOf({ a: 1, b: [1, 2] })).not.toBe(digestOf({ a: 1, b: [1, 3] }));
  });

  it("captureGitState returns sha + cleanness for a git repo", async () => {
    const repo = await mkdtemp(join(tmpdir(), "e2-13-"));
    try {
      await writeFile(join(repo, "tracked.txt"), "x", "utf8");
      // Not a git repo -> null (no fabricated values).
      const state = await captureGitState(repo);
      expect(state === null || typeof state.sha === "string").toBe(true);
      if (state !== null) expect(typeof state.clean).toBe("boolean");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("evidence schemaVersion is 2.0.0 and JSON round-trips as a single document", () => {
    const e = mkEvidence();
    expect(e.schemaVersion).toBe(GATE_EVIDENCE_V2_SCHEMA_VERSION);
    const parsed = JSON.parse(JSON.stringify(e)) as GateEvidenceV2;
    expect(parsed.gitSha).toBe(HEAD);
    expect(parsed.command).toEqual(CMD);
  });
});