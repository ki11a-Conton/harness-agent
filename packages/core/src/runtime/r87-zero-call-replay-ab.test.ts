/**
 * E4-R87 Phase A — zero-call replay A/B over the frozen, digest-bound case
 * selection (plan §R87: "优先先跑零调用 replay A/B。只有 replay 证明 candidate
 * 命中了目标路径，才进入真实请求授权门。").
 *
 * The frozen selection (`docs/evidence/e4-r87-case-selection.json`, schema
 * `e4-r87-case-selection-v1`, digest 227d00b6…) was committed BEFORE any replay
 * executed; this suite refuses to run on a digest mismatch (plan §R87 #2/#5).
 *
 * Arms:
 *   - baseline  = pre-R86 streak semantics. R86 preserved the pre-R86 contract
 *     byte-for-byte in `AgentState.noteToolCall(name, args)` when no result
 *     fingerprint is supplied (pinned by `agent-state.test.ts` "keeps the
 *     pre-R86 name+args streak"), and the pre-R86 tool-call controller called
 *     exactly that signature (verified against source SHA e9776ba). The replay
 *     reproduces it in-process via `streakResultAware: false` — same runner,
 *     same limits, same case order; only the pre-declared fix differs.
 *   - candidate = the R86 runtime (result fingerprint fed), SHA a203737.
 *
 * Both arms: ScriptedModelProvider only — 0 provider calls, 0 tokens, no key,
 * no network. Serial (concurrency 1), atomic persist after each (case, arm),
 * resume skips already-completed arms (no double billing).
 *
 * Primary metric (R85-defined mechanism metric): on the 3 TARGET cases the
 * baseline arm must reproduce the recorded H2 fingerprint class (tool_limit +
 * tool_failures=0 + stall recovery consumed), the candidate arm must NOT
 * (completes with `stall.progress_detected` evidence). Counterexamples must be
 * outcome-invariant across arms; security violations 0; verified completion
 * must not worsen.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  R87_SELECTION_DIGEST,
  loadCaseSelection,
  verifySelectionDigest,
  runReplayAb,
  armHash,
  legacyArmHash,
  validateManifest,
  computeSummary,
  paidAuthorizationStatus,
  buildManifest,
  type FrozenCaseSelection,
} from "./r87-zero-call-replay-ab.js";

const BASELINE_SHA = "e9776ba66190ea63b1bacb685c91aa900b6935e7";
const CANDIDATE_SHA = "a20373743b56de6a3a110fecdd254737ece71afa";

describe("E4-R87 Phase A — zero-call replay A/B over the frozen case selection", () => {
  let selection: FrozenCaseSelection;

  beforeAll(() => {
    selection = loadCaseSelection();
  });

  it("the committed case selection is digest-bound and loads with the expected shape", () => {
    expect(selection.schemaVersion).toBe("e4-r87-case-selection-v1");
    expect(selection.boundBeforeExecution).toBe(true);
    expect(selection.digest).toBe(R87_SELECTION_DIGEST);
    // Verify the digest is recomputed from the payload, not copied by hand.
    verifySelectionDigest(selection);
    expect(selection.cases.length).toBeGreaterThanOrEqual(6);
    expect(selection.cases.length).toBeLessThanOrEqual(10);
    const targets = selection.cases.filter((c) => c.role === "TARGET");
    const ces = selection.cases.filter((c) => c.role === "COUNTEREXAMPLE");
    expect(targets.length).toBe(3);
    expect(ces.length).toBeGreaterThanOrEqual(1);
    for (const t of targets) {
      expect(t.recorded.fingerprint).toBe(
        "c1aae66dc97dd795d058737188f59d9a4ccf0da41b3b0054eb86d5c3f14b28d8",
      );
    }
  });

  it("FAIL-CLOSED: a tampered selection (case swapped after freezing) fails digest verification", () => {
    const tampered: FrozenCaseSelection = JSON.parse(JSON.stringify(selection));
    tampered.cases = tampered.cases.slice(0, 5); // someone swapped/removed cases post-freeze
    expect(() => verifySelectionDigest(tampered)).toThrow(/digest|mismatch|frozen/i);
  });

  it("BASELINE arm reproduces the recorded H2 fingerprint class on all 3 TARGET cases", async () => {
    const targets = selection.cases.filter((c) => c.role === "TARGET");
    const { records } = await runReplayAb(selection, { arms: ["baseline"], now: () => 0 });
    const baseline = records.filter((r) => r.arm === "baseline");
    expect(baseline.length).toBe(selection.cases.length);

    for (const t of targets) {
      const rec = baseline.find((r) => r.caseId === t.id)!;
      expect(rec.status).toBe("failed");
      expect(rec.terminationReason).toBe("tool_limit");
      expect(rec.maxRepeatedToolCallsLimits).toBeGreaterThan(0);
      expect(rec.toolFailures).toBe(0);
      expect(rec.stallRecoveries).toBeGreaterThan(0);
      expect(rec.progressDetected).toBe(0); // pre-R86: progress invisible to the gate
      expect(rec.h2SignatureFires).toBe(true);
    }
  });

  it("CANDIDATE arm does NOT reproduce the H2 class: TARGET cases complete with progress evidence", async () => {
    const targets = selection.cases.filter((c) => c.role === "TARGET");
    const { records } = await runReplayAb(selection, { arms: ["candidate"], now: () => 0 });
    const candidate = records.filter((r) => r.arm === "candidate");
    expect(candidate.length).toBe(selection.cases.length);

    for (const t of targets) {
      const rec = candidate.find((r) => r.caseId === t.id)!;
      expect(rec.status).toBe("completed");
      expect(rec.maxRepeatedToolCallsLimits).toBe(0);
      expect(rec.toolFailures).toBe(0);
      expect(rec.progressDetected).toBeGreaterThan(0);
      expect(rec.h2SignatureFires).toBe(false);
    }
  });

  it("COUNTEREXAMPLES are outcome-invariant across arms (constant-failure still fails, complete cases still complete, agent_limit still agent_limit)", async () => {
    const { records } = await runReplayAb(selection, { arms: ["baseline", "candidate"], now: () => 0 });
    const baseline = records.filter((r) => r.arm === "baseline");
    const candidate = records.filter((r) => r.arm === "candidate");
    const ces = selection.cases.filter((c) => c.role === "COUNTEREXAMPLE");

    for (const ce of ces) {
      const b = baseline.find((r) => r.caseId === ce.id)!;
      const c = candidate.find((r) => r.caseId === ce.id)!;
      expect(c.status).toBe(b.status);
      expect(c.terminationReason).toBe(b.terminationReason);
      expect(c.maxRepeatedToolCallsLimits).toBe(b.maxRepeatedToolCallsLimits);
      expect(c.h2SignatureFires).toBe(false);
      expect(b.h2SignatureFires).toBe(false);
    }
    // The MODEL_BEHAVIOR counterexample (constant failing tool) still terminates:
    const failing = ces.find((c) => c.trace.kind === "identical-failing")!;
    expect(baseline.find((r) => r.caseId === failing.id)!.status).toBe("failed");
    expect(baseline.find((r) => r.caseId === failing.id)!.toolFailures).toBeGreaterThan(0);
    // verified_complete counterexamples still complete:
    const completed = ces.filter((c) => c.trace.kind === "different-args");
    for (const c of completed) {
      expect(candidate.find((r) => r.caseId === c.id)!.status).toBe("completed");
    }
    // agent_limit counterexample still agent_limit:
    const iter = ces.find((c) => c.trace.kind === "iteration-tool-steps")!;
    expect(candidate.find((r) => r.caseId === iter.id)!.terminationReason).toBe("agent_limit");
  });

  it("PRIMARY mechanism metric: 3 → 0 target H2 fires, zero counterexample diffs, verdict MECHANISM_VALIDATED", async () => {
    const { records } = await runReplayAb(selection, { arms: ["baseline", "candidate"], now: () => 0 });
    const summary = computeSummary(records, selection, ["baseline", "candidate"]);
    expect(summary.mechanismMetric.baselineTargetFires).toBe(3);
    expect(summary.mechanismMetric.candidateTargetFires).toBe(0);
    expect(summary.mechanismMetric.improvement).toBe(3);
    expect(summary.counterexampleOutcomeDiffs).toEqual([]);
    expect(summary.securityViolations).toBe(0);
    expect(summary.verifiedCompletion).toBe(true);
    expect(summary.verdict).toBe("MECHANISM_VALIDATED");
  });

  it("runs STRICTLY SERIAL and atomically persists after each (case, arm); RESUME skips completed arms without re-running", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "r87-ab-"));
    const statePath = join(runDir, "run-state.jsonl");
    const { records, executed } = await runReplayAb(selection, {
      arms: ["baseline", "candidate"],
      now: () => 0,
      runStatePath: statePath,
    });
    expect(executed.length).toBe(selection.cases.length * 2);
    // E4-R88: line 1 is the identity header; every (case, arm) follows as an
    // atomically-persisted record line (tmp+rename).
    const lines = readFileSync(statePath, "utf8").trim().split("\n");
    expect(lines.length).toBe(selection.cases.length * 2 + 1);
    expect((JSON.parse(lines[0]!) as { kind: string }).kind).toBe("header");
    for (const line of lines.slice(1)) {
      const obj = JSON.parse(line) as { kind: string; caseId: string; arm: string };
      expect(obj.kind).toBe("record");
      expect(obj.caseId).toBeTruthy();
      expect(["baseline", "candidate"]).toContain(obj.arm);
    }

    // Interruption simulation: the header plus half the arms are already done.
    const kept = [lines[0]!, ...lines.slice(1, 1 + Math.floor((lines.length - 1) / 2))];
    writeFileSync(statePath, kept.join("\n") + "\n");
    const { executed: executedAgain } = await runReplayAb(selection, {
      arms: ["baseline", "candidate"],
      now: () => 0,
      runStatePath: statePath,
    });
    // Completed arms are NOT re-billed; only the missing half runs.
    expect(executedAgain.length).toBe(lines.length - kept.length);
    const finalLines = readFileSync(statePath, "utf8").trim().split("\n");
    expect(finalLines.length).toBe(lines.length);
    expect(records.length).toBe(selection.cases.length * 2);
  });

  it("per-arm hashes are deterministic and a validator can recompute every summary from the records", async () => {
    const { records } = await runReplayAb(selection, { arms: ["baseline", "candidate"], now: () => 0 });
    const b1 = armHash(records.filter((r) => r.arm === "baseline"));
    const c1 = armHash(records.filter((r) => r.arm === "candidate"));
    // Deterministic: same replay → same hash.
    const { records: again } = await runReplayAb(selection, { arms: ["baseline", "candidate"], now: () => 0 });
    expect(armHash(again.filter((r) => r.arm === "baseline"))).toBe(b1);
    expect(armHash(again.filter((r) => r.arm === "candidate"))).toBe(c1);
    expect(b1).not.toBe(c1); // the fix genuinely changed the mechanism

    // Validator recomputation: hash/summary derive ONLY from the records.
    const manifest = buildManifest({
      selection,
      records,
      arms: ["baseline", "candidate"],
      implementationSha: CANDIDATE_SHA,
      baselineSha: BASELINE_SHA,
      candidateSha: CANDIDATE_SHA,
      gate: paidAuthorizationStatus({}),
    });
    expect(manifest.arms.baseline.hash).toBe(b1);
    expect(manifest.arms.candidate.hash).toBe(c1);
    expect(manifest.summary.verdict).toBe("MECHANISM_VALIDATED");
  });

  it("PAID GATE: without a NEW explicit authorization the paid path is NOT_RUN: PAID_AUTHORIZATION_REQUIRED and never constructs a provider", () => {
    const gate = paidAuthorizationStatus({});
    expect(gate.status).toBe("NOT_RUN");
    expect(gate.code).toBe("PAID_AUTHORIZATION_REQUIRED");
    // R83 key/digest/oral authorization does NOT carry over (plan §R87).
    const withR83Key = paidAuthorizationStatus({ OPENAI_API_KEY: "sk-not-the-r83-key" });
    expect(withR83Key.status).toBe("NOT_RUN");
    const withR83Flag = paidAuthorizationStatus({ RUN_PAID_BENCHMARKS: "1" });
    expect(withR83Flag.status).toBe("NOT_RUN");
  });

  it("SECURITY: the replay is zero-call, the manifest is sanitized, and no secret canary leaks into events or manifest", async () => {
    const SECRET = "S3CR3T-r87-canary-4c2f9a1b";
    // The replay module must not touch any real provider surface.
    const moduleSrc = readFileSync(
      fileURLToPath(new URL("./r87-zero-call-replay-ab.ts", import.meta.url)),
      "utf8",
    );
    for (const needle of ["createProvider", "new OpenAI", "apiKey", "OPENAI_API_KEY", "fetch("]) {
      expect(moduleSrc).not.toContain(needle);
    }

    const { records } = await runReplayAb(selection, {
      arms: ["baseline", "candidate"],
      now: () => 0,
      secretCanary: SECRET,
    });
    const manifest = buildManifest({
      selection,
      records,
      arms: ["baseline", "candidate"],
      implementationSha: CANDIDATE_SHA,
      baselineSha: BASELINE_SHA,
      candidateSha: CANDIDATE_SHA,
      gate: paidAuthorizationStatus({}),
    });
    const manifestJson = JSON.stringify(manifest);
    expect(manifestJson).not.toContain(SECRET);
    // Per-arm records carry only sanitized fields (no args, no outputs).
    for (const arm of ["baseline", "candidate"] as const) {
      for (const rec of manifest.arms[arm].records as Array<Record<string, unknown>>) {
        expect(JSON.stringify(rec)).not.toContain(SECRET);
        expect(rec).not.toHaveProperty("args");
        expect(rec).not.toHaveProperty("output");
        expect(rec).not.toHaveProperty("prompt");
      }
    }
    // The manifest records honest provider-call accounting: 0.
    expect(manifest.providerCalls).toBe(0);
    expect(manifest.gate.status).toBe("NOT_RUN");
    expect(manifest.gate.code).toBe("PAID_AUTHORIZATION_REQUIRED");
    // Limits are identical for both arms and equal the committed policy.
    expect(manifest.limits).toEqual({
      maxRepeatedIdenticalToolCalls: 3,
      maxStallRecoveries: 1,
      maxPatternStallRecoveries: 1,
      maxIterationsPerTurn: 20,
      maxParallelToolCalls: 1,
    });
  });

  it("EMIT MODE (env R88_EMIT_MANIFEST=1): writes the v2 manifest WITHOUT touching the legacy R87 file", async () => {
    const out = fileURLToPath(
      new URL("../../../../docs/evidence/e4-r88-phase-a-manifest.json", import.meta.url),
    );
    const legacyPath = fileURLToPath(
      new URL("../../../../docs/evidence/e4-r87-phase-a-manifest.json", import.meta.url),
    );
    const legacyBefore = existsSync(legacyPath) ? readFileSync(legacyPath, "utf8") : undefined;
    if (process.env.R88_EMIT_MANIFEST !== "1") {
      // Normal runs do not write into the repo tree.
      expect(true).toBe(true);
      return;
    }
    const { records } = await runReplayAb(selection, { arms: ["baseline", "candidate"], now: () => 0 });
    const manifest = buildManifest({
      selection,
      records,
      arms: ["baseline", "candidate"],
      implementationSha: CANDIDATE_SHA,
      baselineSha: BASELINE_SHA,
      candidateSha: CANDIDATE_SHA,
      gate: paidAuthorizationStatus({}),
    });
    writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
    // Self-consistency: the written manifest validates against its own records.
    const written = JSON.parse(readFileSync(out, "utf8")) as typeof manifest;
    expect(validateManifest(written, selection).status).toBe("VALID");
    expect(written.arms.baseline.hash).toBe(manifest.arms.baseline.hash);
    expect(written.arms.candidate.hash).toBe(manifest.arms.candidate.hash);
    expect(written.summary.verdict).toBe("MECHANISM_VALIDATED");
    // The historical v1 manifest must remain byte-identical (never overwritten).
    if (legacyBefore !== undefined) {
      expect(readFileSync(legacyPath, "utf8")).toBe(legacyBefore);
    }
  });

  it("LEGACY: the committed R87 manifest stays readable and its v1 hashes are reproducible", async () => {
    const committedPath = fileURLToPath(
      new URL("../../../../docs/evidence/e4-r87-phase-a-manifest.json", import.meta.url),
    );
    if (!existsSync(committedPath)) {
      expect(true).toBe(true);
      return;
    }
    const committed = JSON.parse(readFileSync(committedPath, "utf8")) as {
      schemaVersion: string;
      selectionDigest: string;
      arms: { baseline: { hash: string }; candidate: { hash: string } };
    };
    expect(committed.schemaVersion).toBe("e4-r87-phase-a-manifest-v1");
    expect(committed.selectionDigest).toBe(selection.digest);
    // The v1 hash is reproducible via the preserved legacy projection...
    const { records } = await runReplayAb(selection, { arms: ["baseline", "candidate"], now: () => 0 });
    expect(legacyArmHash(records.filter((r) => r.arm === "baseline"))).toBe(committed.arms.baseline.hash);
    expect(legacyArmHash(records.filter((r) => r.arm === "candidate"))).toBe(committed.arms.candidate.hash);
    // ...but it is NEVER blessed as verified evidence (plan §R88: legacy/unverified).
    expect(validateManifest(committed, selection).status).toBe("LEGACY_UNVERIFIED");
  });
});
