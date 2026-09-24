/**
 * E4-R88 — evidence-gate regression suite (plan 20260917-001821 §R88, findings F1/F2).
 *
 * RED (against the pre-R88 implementation):
 *   F1 — `computeSummary` derived the expected set from the OBSERVED results, so
 *        a set of baseline TARGET failures with zero candidate records reported
 *        improvement = 3 while the empty `every(...)` verified-completion guard
 *        was vacuously true → MECHANISM_VALIDATED on incomplete evidence.
 *   F2 — `runReplayAb` never verified the frozen selection digest itself, and its
 *        resume path keyed only on `caseId/arm`, so foreign/stale records were
 *        silently absorbed as this experiment's results.
 *
 * GREEN (after R88): no complete, identity-consistent paired result ⇒ never
 * MECHANISM_VALIDATED; every negative case carries a stable reason code.
 *
 * Zero provider calls (ScriptedModelProvider only), no key, no network.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCaseSelection,
  runReplayAb,
  computeSummary,
  buildManifest,
  validateManifest,
  R87_SELECTION_DIGEST,
  R88_MANIFEST_SCHEMA,
  R90_MANIFEST_SCHEMA,
  type ArmCaseRecord,
  type FrozenCaseSelection,
  type ReplayArm,
} from "./r87-zero-call-replay-ab.js";

const ARMS: ReplayArm[] = ["baseline", "candidate"];

describe("E4-R88 — incomplete or foreign evidence must never be validated", () => {
  let selection: FrozenCaseSelection;
  let full: ArmCaseRecord[];

  beforeAll(async () => {
    selection = loadCaseSelection();
    full = (await runReplayAb(selection, { arms: ARMS, now: () => 0 })).records;
  });

  // ---------------------------------------------------------------- F1 ----
  it("F1 RED repro: baseline TARGET failures with zero candidate records must NOT be MECHANISM_VALIDATED", () => {
    // The reviewer's exact reproducer: only baseline TARGET records exist, so
    // the verified-completion guard iterates an EMPTY set and is vacuously true.
    const baselineTargets = full.filter((r) => r.arm === "baseline" && r.role === "TARGET");
    expect(baselineTargets.length).toBe(3);
    const summary = computeSummary(baselineTargets, selection, ARMS);
    expect(summary.mechanismMetric.baselineTargetFires).toBe(3);
    expect(summary.mechanismMetric.candidateTargetFires).toBe(0);
    expect(summary.verdict).not.toBe("MECHANISM_VALIDATED");
    expect(summary.completeness).toBe("PARTIAL");
    expect(summary.issues.map((i) => i.code)).toContain("ARM_MISSING");
  });

  it("F1: a SINGLE-ARM run may persist state but is never COMPLETE or validated", async () => {
    const { records } = await runReplayAb(selection, { arms: ["baseline"], now: () => 0 });
    const summary = computeSummary(records, selection, ["baseline"]);
    expect(summary.completeness).toBe("PARTIAL");
    expect(summary.verdict).not.toBe("MECHANISM_VALIDATED");
    expect(summary.issues.map((i) => i.code)).toContain("ARM_MISSING");
  });

  it("F1: the complete, identity-consistent paired run is still MECHANISM_VALIDATED", () => {
    const summary = computeSummary(full, selection, ARMS);
    expect(summary.completeness).toBe("COMPLETE");
    expect(summary.issues).toEqual([]);
    expect(summary.expectedRecords).toBe(selection.cases.length * ARMS.length);
    expect(summary.observedRecords).toBe(selection.cases.length * ARMS.length);
    expect(summary.verdict).toBe("MECHANISM_VALIDATED");
  });

  it("F1: an all-empty record set is PARTIAL/INCONCLUSIVE with RECORDS_EMPTY", () => {
    const summary = computeSummary([], selection, ARMS);
    expect(summary.verdict).not.toBe("MECHANISM_VALIDATED");
    expect(summary.completeness).toBe("PARTIAL");
    expect(summary.issues.map((i) => i.code)).toContain("RECORDS_EMPTY");
  });

  it("F1: a single missing pair makes the matrix incomplete (PARTIAL, never validated)", () => {
    const dropped = full.filter(
      (r) => !(r.caseId === selection.cases[0]!.id && r.arm === "candidate"),
    );
    const summary = computeSummary(dropped, selection, ARMS);
    expect(summary.completeness).toBe("PARTIAL");
    expect(summary.verdict).not.toBe("MECHANISM_VALIDATED");
    expect(summary.issues.map((i) => i.code)).toContain("MATRIX_INCOMPLETE");
  });

  it("F1: a duplicated (case, arm) record is REJECTED", () => {
    const summary = computeSummary([...full, full[0]!], selection, ARMS);
    expect(summary.verdict).toBe("REJECTED");
    expect(summary.issues.map((i) => i.code)).toContain("DUPLICATE_RECORD");
  });

  it("F1: an unknown case id is REJECTED", () => {
    const alien = { ...full[0]!, caseId: "regression/not-in-the-frozen-selection" };
    const summary = computeSummary([...full, alien], selection, ARMS);
    expect(summary.verdict).toBe("REJECTED");
    expect(summary.issues.map((i) => i.code)).toContain("UNKNOWN_CASE");
  });

  it("F1: a wrong suite or role for a known case is REJECTED", () => {
    const target = full.find((r) => r.role === "TARGET")!;
    const wrongSuite = full.map((r) =>
      r === target ? { ...r, suite: r.suite === "regression" ? "adversarial" : "regression" } : r,
    );
    const s1 = computeSummary(wrongSuite, selection, ARMS);
    expect(s1.verdict).toBe("REJECTED");
    expect(s1.issues.map((i) => i.code)).toContain("CASE_SUITE_MISMATCH");

    // Flip the role to the OPPOSITE of the frozen one, so it is a real mismatch.
    const wrongRole = full.map((r) =>
      r === target
        ? { ...r, role: (r.role === "TARGET" ? "COUNTEREXAMPLE" : "TARGET") as typeof r.role }
        : r,
    );
    const s2 = computeSummary(wrongRole, selection, ARMS);
    expect(s2.verdict).toBe("REJECTED");
    expect(s2.issues.map((i) => i.code)).toContain("CASE_ROLE_MISMATCH");
  });

  it("F1: non-finite and negative metrics are REJECTED", () => {
    const nan = full.map((r, i) => (i === 0 ? { ...r, toolCalls: Number.NaN } : r));
    const s1 = computeSummary(nan, selection, ARMS);
    expect(s1.verdict).toBe("REJECTED");
    expect(s1.issues.map((i) => i.code)).toContain("METRIC_NOT_FINITE");

    const negative = full.map((r, i) => (i === 0 ? { ...r, stallRecoveries: -1 } : r));
    const s2 = computeSummary(negative, selection, ARMS);
    expect(s2.verdict).toBe("REJECTED");
    expect(s2.issues.map((i) => i.code)).toContain("METRIC_NEGATIVE");
  });

  it("F1: an unmet expectation is REJECTED even when the target fire count dropped", () => {
    // Candidate target that fails for a NON-target reason (expect not met).
    const unmet = full.map((r) =>
      r.arm === "candidate" && r.role === "TARGET"
        ? { ...r, status: "failed", terminationReason: "model_error", expectedMet: false }
        : r,
    );
    const summary = computeSummary(unmet, selection, ARMS);
    expect(summary.mechanismMetric.improvement).toBe(3);
    expect(summary.verdict).toBe("REJECTED");
    expect(summary.issues.map((i) => i.code)).toContain("EXPECT_NOT_MET");
  });

  it("F1: a counterexample regression or a security violation is REJECTED", () => {
    const ce = full.find((r) => r.role === "COUNTEREXAMPLE" && r.arm === "candidate")!;
    const regressed = full.map((r) =>
      r === ce ? { ...r, status: r.status === "completed" ? "failed" : "completed" } : r,
    );
    const s1 = computeSummary(regressed, selection, ARMS);
    expect(s1.verdict).toBe("REJECTED");
    expect(s1.issues.map((i) => i.code)).toContain("COUNTEREXAMPLE_REGRESSION");

    const violating = full.map((r, i) => (i === 0 ? { ...r, securityViolations: 1 } : r));
    const s2 = computeSummary(violating, selection, ARMS);
    expect(s2.verdict).toBe("REJECTED");
    expect(s2.issues.map((i) => i.code)).toContain("SECURITY_VIOLATION");
  });

  // ---------------------------------------------------------------- F2 ----
  it("F2a: runReplayAb fails closed when the selection digest does not verify", async () => {
    const tampered = JSON.parse(JSON.stringify(selection)) as FrozenCaseSelection;
    tampered.cases = tampered.cases.slice(0, 2);
    await expect(runReplayAb(tampered, { arms: ["baseline"], now: () => 0 })).rejects.toThrow(
      /SELECTION_DIGEST_MISMATCH|digest/i,
    );
  });

  it("F2b: resume refuses a state file that is not this experiment's identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r88-foreign-"));
    const statePath = join(dir, "run-state.jsonl");
    writeFileSync(
      statePath,
      JSON.stringify({
        kind: "header",
        schemaVersion: "e4-r88-run-state-v1",
        identity: { experimentId: "some-other-experiment", selectionDigest: R87_SELECTION_DIGEST },
      }) + "\n",
    );
    await expect(
      runReplayAb(selection, { arms: ["baseline"], now: () => 0, runStatePath: statePath }),
    ).rejects.toThrow(/EXPERIMENT_ID_MISMATCH/);
  });

  it("F2b: resume refuses an unknown case, an unknown arm and a duplicate record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r88-strict-"));
    const statePath = join(dir, "run-state.jsonl");
    const fresh = await runReplayAb(selection, {
      arms: ["baseline"],
      now: () => 0,
      runStatePath: statePath,
    });
    const header = readFileSync(statePath, "utf8").trim().split("\n")[0]!;
    const recordLine = readFileSync(statePath, "utf8").trim().split("\n")[1]!;
    expect(fresh.executed.length).toBe(selection.cases.length);

    // unknown case id
    writeFileSync(
      statePath,
      header + "\n" + recordLine.replace(/"caseId":"[^"]+"/, '"caseId":"ghost/case"') + "\n",
    );
    await expect(
      runReplayAb(selection, { arms: ["baseline"], now: () => 0, runStatePath: statePath }),
    ).rejects.toThrow(/UNKNOWN_CASE|RECORD_HASH_MISMATCH/);

    // duplicate record
    writeFileSync(statePath, header + "\n" + recordLine + "\n" + recordLine + "\n");
    await expect(
      runReplayAb(selection, { arms: ["baseline"], now: () => 0, runStatePath: statePath }),
    ).rejects.toThrow(/DUPLICATE_RECORD/);
  });

  it("F2b: reusing state after the implementation SHA changes fails BEFORE running any arm", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r88-sha-"));
    const statePath = join(dir, "run-state.jsonl");
    await runReplayAb(selection, {
      arms: ARMS,
      now: () => 0,
      runStatePath: statePath,
      implementationSha: "impl-aaa",
    });
    const before = readFileSync(statePath, "utf8");
    await expect(
      runReplayAb(selection, {
        arms: ARMS,
        now: () => 0,
        runStatePath: statePath,
        implementationSha: "impl-bbb",
      }),
    ).rejects.toThrow(/EXPERIMENT_ID_MISMATCH/);
    expect(readFileSync(statePath, "utf8")).toBe(before); // untouched
  });

  it("F2b: single-arm state can be EXTENDED into a full A/B, but never narrowed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r88-extend-"));
    const statePath = join(dir, "run-state.jsonl");
    const first = await runReplayAb(selection, {
      arms: ["baseline"],
      now: () => 0,
      runStatePath: statePath,
    });
    // The experiment identity does NOT depend on the declared subset, so the
    // same state file can legitimately grow into the full paired run.
    const second = await runReplayAb(selection, {
      arms: ["baseline", "candidate"],
      now: () => 0,
      runStatePath: statePath,
    });
    expect(second.experimentId).toBe(first.experimentId);
    expect(second.executed.length).toBe(selection.cases.length); // only candidate ran
    expect(second.records.length).toBe(selection.cases.length * 2);
    expect(computeSummary(second.records, selection, ARMS).verdict).toBe("MECHANISM_VALIDATED");

    // Narrowing back to baseline alone must be refused: results would be orphaned.
    await expect(
      runReplayAb(selection, { arms: ["baseline"], now: () => 0, runStatePath: statePath }),
    ).rejects.toThrow(/ARM_UNEXPECTED/);
  });

  it("F2b: a truncated tail record is reported and re-run, never treated as complete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r88-trunc-"));
    const statePath = join(dir, "run-state.jsonl");
    const { executed } = await runReplayAb(selection, {
      arms: ["baseline"],
      now: () => 0,
      runStatePath: statePath,
    });
    const lines = readFileSync(statePath, "utf8").trim().split("\n");
    // Simulate a crash mid-write of the last record.
    writeFileSync(statePath, lines.slice(0, -1).join("\n") + "\n" + lines.at(-1)!.slice(0, 40));
    const again = await runReplayAb(selection, {
      arms: ["baseline"],
      now: () => 0,
      runStatePath: statePath,
    });
    expect(again.incompleteRecovered.length).toBe(1);
    expect(again.executed.length).toBe(1); // only the unconfirmed arm re-ran
    expect(executed.length).toBe(selection.cases.length);
  });

  it("F2b: a malformed record BEFORE the tail is corruption, not a recoverable tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r88-corrupt-"));
    const statePath = join(dir, "run-state.jsonl");
    await runReplayAb(selection, { arms: ["baseline"], now: () => 0, runStatePath: statePath });
    const lines = readFileSync(statePath, "utf8").trim().split("\n");
    lines[1] = lines[1]!.slice(0, 30); // corrupt a middle record
    writeFileSync(statePath, lines.join("\n") + "\n");
    await expect(
      runReplayAb(selection, { arms: ["baseline"], now: () => 0, runStatePath: statePath }),
    ).rejects.toThrow(/STATE_TRUNCATED/);
  });

  // ----------------------------------------------------- identity/config --
  it("resume state binds schema, selection digest, implementation SHA, arms, limits and fixture digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r88-header-"));
    const statePath = join(dir, "run-state.jsonl");
    const res = await runReplayAb(selection, {
      arms: ARMS,
      now: () => 0,
      runStatePath: statePath,
      implementationSha: "impl-x",
    });
    const header = JSON.parse(readFileSync(statePath, "utf8").split("\n")[0]!) as {
      kind: string;
      schemaVersion: string;
    } & Record<string, unknown>;
    expect(header.kind).toBe("header");
    expect(header.schemaVersion).toBe("e4-r88-run-state-v1");
    expect(header.selectionDigest).toBe(R87_SELECTION_DIGEST);
    expect(header.implementationSha).toBe("impl-x");
    expect(header.experimentId).toBe(res.experimentId);
    expect(header.limits).toEqual({
      maxRepeatedIdenticalToolCalls: 3,
      maxStallRecoveries: 1,
      maxPatternStallRecoveries: 1,
      maxIterationsPerTurn: 20,
      maxParallelToolCalls: 1,
    });
    expect(typeof header.fixtureDigest).toBe("string");
    expect((header.arms as Array<{ arm: string }>).map((a) => a.arm)).toEqual(ARMS);
    // Every result line binds the experimentId and carries a stable hash.
    for (const line of readFileSync(statePath, "utf8").trim().split("\n").slice(1)) {
      const rec = JSON.parse(line) as { kind: string; experimentId: string; hash: string };
      expect(rec.kind).toBe("record");
      expect(rec.experimentId).toBe(res.experimentId);
      expect(rec.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("a complete resume reproduces exactly the fresh run's hashes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r88-hash-"));
    const statePath = join(dir, "run-state.jsonl");
    await runReplayAb(selection, { arms: ARMS, now: () => 0, runStatePath: statePath });
    const resumed = await runReplayAb(selection, {
      arms: ARMS,
      now: () => 0,
      runStatePath: statePath,
    });
    expect(resumed.executed).toEqual([]); // nothing re-billed
    const manifest = buildManifest({
      selection,
      records: resumed.records,
      arms: ARMS,
      implementationSha: "impl",
      baselineSha: "baseline-sha",
      candidateSha: "candidate-sha",
      gate: { status: "NOT_RUN", code: "PAID_AUTHORIZATION_REQUIRED", reason: "not authorized" },
    });
    const fresh = buildManifest({
      selection,
      records: full,
      arms: ARMS,
      implementationSha: "impl",
      baselineSha: "baseline-sha",
      candidateSha: "candidate-sha",
      gate: { status: "NOT_RUN", code: "PAID_AUTHORIZATION_REQUIRED", reason: "not authorized" },
    });
    expect(manifest.arms.baseline.hash).toBe(fresh.arms.baseline.hash);
    expect(manifest.arms.candidate.hash).toBe(fresh.arms.candidate.hash);
    expect(manifest.summary.verdict).toBe("MECHANISM_VALIDATED");
    expect(manifest.summary.completeness).toBe("COMPLETE");
  });

  it("hashes are timing-independent (a resume must not change the evidence hash)", () => {
    const a = full.map((r) => ({ ...r, durationMs: 0 }));
    const b = full.map((r) => ({ ...r, durationMs: 123456 }));
    const ma = buildManifest({
      selection,
      records: a,
      arms: ARMS,
      implementationSha: "impl",
      baselineSha: "b",
      candidateSha: "c",
      gate: { status: "NOT_RUN", code: "PAID_AUTHORIZATION_REQUIRED", reason: "x" },
    });
    const mb = buildManifest({
      selection,
      records: b,
      arms: ARMS,
      implementationSha: "impl",
      baselineSha: "b",
      candidateSha: "c",
      gate: { status: "NOT_RUN", code: "PAID_AUTHORIZATION_REQUIRED", reason: "x" },
    });
    expect(mb.arms.baseline.hash).toBe(ma.arms.baseline.hash);
    expect(mb.arms.candidate.hash).toBe(ma.arms.candidate.hash);
  });

  // ----------------------------------------------------------- validator --
  it("the offline validator recomputes hashes/verdict and rejects tampered evidence", async () => {
    const manifest = buildManifest({
      selection,
      records: full,
      arms: ARMS,
      implementationSha: "impl",
      baselineSha: "b",
      candidateSha: "c",
      gate: { status: "NOT_RUN", code: "PAID_AUTHORIZATION_REQUIRED", reason: "x" },
    });
    // R90 §2: the emitted schema is now v3. The v2 artifact stays on disk as a
    // versioned erratum but is no longer blessed (see the v2 case below).
    expect(manifest.schemaVersion).toBe(R90_MANIFEST_SCHEMA);
    const ok = validateManifest(manifest, selection);
    expect(ok.status).toBe("VALID");
    expect(ok.reasonCodes).toEqual([]);

    // Tamper: flip a candidate target record so the declared hash no longer holds.
    const tampered = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
    const rec = tampered.arms.candidate.records.find(
      (r) => r.role === "TARGET",
    ) as Record<string, unknown>;
    rec.h2SignatureFires = true;
    const bad = validateManifest(tampered, selection);
    expect(bad.status).toBe("INVALID");
    expect(bad.reasonCodes.length).toBeGreaterThan(0);
  });

  it("the validator refuses to bless an incomplete or foreign manifest", () => {
    const partial = buildManifest({
      selection,
      records: full.filter((r) => r.arm === "baseline"),
      arms: ARMS,
      implementationSha: "impl",
      baselineSha: "b",
      candidateSha: "c",
      gate: { status: "NOT_RUN", code: "PAID_AUTHORIZATION_REQUIRED", reason: "x" },
    });
    const res = validateManifest(partial, selection);
    expect(res.status).toBe("INVALID");
    expect(res.reasonCodes).toContain("ARM_MISSING");

    const foreign = buildManifest({
      selection,
      records: full,
      arms: ARMS,
      implementationSha: "impl",
      baselineSha: "b",
      candidateSha: "c",
      gate: { status: "NOT_RUN", code: "PAID_AUTHORIZATION_REQUIRED", reason: "x" },
    });
    foreign.selectionDigest = "0".repeat(64);
    expect(validateManifest(foreign, selection).status).toBe("INVALID");
  });

  it("the legacy R87 manifest stays readable but is never blessed as verified", () => {
    const legacyPath = join(process.cwd(), "docs", "evidence", "e4-r87-phase-a-manifest.json");
    if (!existsSync(legacyPath)) {
      expect(true).toBe(true);
      return;
    }
    const legacy = JSON.parse(readFileSync(legacyPath, "utf8")) as { schemaVersion: string };
    expect(legacy.schemaVersion).toBe("e4-r87-phase-a-manifest-v1");
    const res = validateManifest(legacy, selection);
    expect(res.status).toBe("LEGACY_UNVERIFIED");
    expect(res.detail).toMatch(/legacy|unverified/i);
  });

  it("R90: the superseded v2 manifest stays readable but is NOT re-blessed", () => {
    const v2Path = join(process.cwd(), "docs", "evidence", "e4-r88-phase-a-manifest.json");
    if (!existsSync(v2Path)) {
      expect(true).toBe(true);
      return;
    }
    const v2 = JSON.parse(readFileSync(v2Path, "utf8")) as { schemaVersion: string };
    // A versioned erratum: the historical artifact is preserved on disk, never
    // deleted, and never silently re-blessed under the corrected schema.
    expect(v2.schemaVersion).toBe("e4-r88-phase-a-manifest-v2");
    const res = validateManifest(v2, selection);
    expect(res.status).toBe("LEGACY_UNVERIFIED");
    expect(res.detail).toMatch(/emulated|executedSourceSha|superseded/i);
  });

  it("R90: an emulated-switch experiment may not claim a real version A/B", () => {
    const lying = buildManifest({
      selection,
      records: full,
      arms: ARMS,
      implementationSha: "impl",
      baselineSha: "b",
      candidateSha: "c",
      gate: { status: "NOT_RUN", code: "PAID_AUTHORIZATION_REQUIRED", reason: "x" },
      experimentKind: "real_version_ab",
      baselineMode: "emulated_semantics",
    });
    const res = validateManifest(lying, selection);
    expect(res.status).toBe("INVALID");
    expect(res.reasonCodes).toContain("EXPERIMENT_ID_MISMATCH");
  });

  it("the validator is offline: it constructs no provider and opens no network", () => {
    const src = readFileSync(
      new URL("./r87-zero-call-replay-ab.ts", import.meta.url),
      "utf8",
    );
    for (const needle of ["createProvider", "new OpenAI", "apiKey", "OPENAI_API_KEY", "fetch(", "http.request"]) {
      expect(src).not.toContain(needle);
    }
  });
});
