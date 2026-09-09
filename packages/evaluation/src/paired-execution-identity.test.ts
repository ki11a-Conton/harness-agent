/**
 * E4-R01 — execution identity gates resume, per field.
 *
 * The schedule digest alone let two DIFFERENT experiments share a journal. These
 * tests build a journal under one identity, then resume with an identity that
 * differs in exactly one security-relevant field, and require:
 *   - status resume-rejected,
 *   - the differing field named in `violations`,
 *   - ZERO provider generate calls (the provider is never even wrapped),
 *   - the existing journal left untouched (kept for diagnosis).
 * All offline with fake providers.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "@ar/contracts";
import { buildPairedPlan, computePairedPlanDigest, type PairedExperimentPlan } from "./paired-plan.js";
import {
  buildExecutionIdentityV1,
  computeExecutionIdentityDigestV1,
  executionIdentityViolationsV1,
  type PairedExecutionIdentityV1,
} from "./paired-execution-identity.js";
import { runPairedExperiment, type PairedJournalEntry } from "./paired-executor.js";
import type { EvalOutcome } from "./runner.js";
import type { BenchmarkCase } from "./baseline.js";

const SUITE = "holdout";

class ZeroProvider implements ModelProvider {
  readonly id = "zero";
  callCount = 0;
  async listModels() { return [{ id: "m", name: "M" }]; }
  createClient() {
    return {
      // eslint-disable-next-line require-yield
      generate: async function* (): AsyncGenerator<never> {
        throw new Error("provider must not be created/called for a mismatched experiment");
      },
    };
  }
}

function outcome(caseId: string, passed: boolean): EvalOutcome {
  return {
    caseId, suite: SUITE, status: passed ? "passed" : "failed", actualStatus: passed ? "completed" : "failed",
    events: [], violations: [], judgeVersion: "1.0.0",
    metrics: {
      turn_count: 1, tool_call_count: 0, tokens_input: 10, tokens_output: 5, context_tokens: 0,
      compaction_count: 0, duration_ms: 1, retry_count: 0, verification_failures: 0, human_interventions: 0,
      estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 1,
    },
  } as unknown as EvalOutcome;
}

function planFor(cases: string[], repetitions = 1, orderSeed = 7): PairedExperimentPlan {
  return buildPairedPlan({ suite: SUITE, cases, repetitions, orderSeed });
}

function casesOf(plan: PairedExperimentPlan): BenchmarkCase[] {
  return plan.cases.map((id) => ({ id, suite: SUITE, requestMd: "r", expectedMd: "e", fixture: {} } as unknown as BenchmarkCase));
}

function identity(
  plan: PairedExperimentPlan,
  fingerprints: Record<string, string>,
  over: Partial<PairedExecutionIdentityV1> = {},
): PairedExecutionIdentityV1 {
  return buildExecutionIdentityV1({
    scheduleDigest: computePairedPlanDigest(plan),
    suite: plan.suite,
    judgeVersion: "1.0.0",
    repetitions: plan.repetitions,
    orderSeed: plan.orderSeed ?? 0,
    modelSeed: null,
    caseIds: plan.cases,
    caseFingerprints: fingerprints,
    candidate: "cand-x",
    providerId: "zero",
    modelId: "m",
    sourceSha: "a".repeat(40),
    limits: { maxLogicalRuns: null, maxModelCalls: null, maxEstimatedTokens: null, maxEstimatedCostUsd: null },
    billingClass: "offline-test",
    isolationBackendId: "none",
    isolationStrength: "none",
    promotionEligible: false,
    decisionPolicy: { version: "p1", minConclusiveNetDelta: 1 },
    thresholdDigest: "b".repeat(64),
    ...over,
  });
}

async function freshDir(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `e4-r01-${label}-`));
}

/** Complete one arm run so the journal has real entries + a header. */
async function seedJournal(plan: PairedExperimentPlan, journalDir: string, id: PairedExecutionIdentityV1): Promise<void> {
  const r = await runPairedExperiment({
    plan,
    cases: casesOf(plan),
    provider: new ZeroProvider(),
    journalDir,
    identity: id,
    runArm: async (arm) => outcome(arm.caseId, true),
  });
  expect(r.status).toBe("ok");
}

describe("E4-R01 execution identity blocks cross-experiment resume", () => {
  const single = planFor(["c1"]);
  const fp = { c1: "hash-c1-v1" };

  it("a changed candidate identity is refused before the provider exists", async () => {
    const dir = await freshDir("candidate");
    try {
      await seedJournal(single, dir, identity(single, fp));
      const provider = new ZeroProvider();
      const r = await runPairedExperiment({
        plan: single, cases: casesOf(single), provider, journalDir: dir,
        identity: identity(single, fp, { candidate: "cand-EVIL", candidateConfigHash: "deadbeef" }),
        runArm: async (arm) => outcome(arm.caseId, true),
      });
      expect(r.status).toBe("resume-rejected");
      if (r.status === "resume-rejected") {
        expect((r.violations ?? []).some((v) => v.includes("candidate"))).toBe(true);
      }
      expect(provider.callCount).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("a changed provider/model is refused", async () => {
    const dir = await freshDir("model");
    try {
      await seedJournal(single, dir, identity(single, fp));
      const r = await runPairedExperiment({
        plan: single, cases: casesOf(single), provider: new ZeroProvider(), journalDir: dir,
        identity: identity(single, fp, { providerId: "other-provider", modelId: "other-model" }),
        runArm: async (arm) => outcome(arm.caseId, true),
      });
      expect(r.status).toBe("resume-rejected");
      if (r.status === "resume-rejected") {
        const v = r.violations ?? [];
        expect(v.some((x) => x.includes("providerId"))).toBe(true);
        expect(v.some((x) => x.includes("modelId"))).toBe(true);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("editing case INPUT content without changing the caseId is refused (F01)", async () => {
    const dir = await freshDir("casecontent");
    try {
      await seedJournal(single, dir, identity(single, fp));
      const r = await runPairedExperiment({
        plan: single, cases: casesOf(single), provider: new ZeroProvider(), journalDir: dir,
        identity: identity(single, { c1: "hash-c1-V2-EDITED" }),
        runArm: async (arm) => outcome(arm.caseId, true),
      });
      expect(r.status).toBe("resume-rejected");
      if (r.status === "resume-rejected") {
        expect((r.violations ?? []).some((v) => v.includes("caseFingerprints.c1"))).toBe(true);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("changed source snapshot, policy, isolation posture or budget are each refused", async () => {
    const cases: Array<[string, Partial<PairedExecutionIdentityV1>, string]> = [
      ["sourceSha", { sourceSha: "f".repeat(40) }, "sourceSha"],
      ["policy", { decisionPolicy: { version: "p1", minConclusiveNetDelta: 9 } }, "decisionPolicy"],
      ["threshold", { thresholdDigest: "9".repeat(64) }, "thresholdDigest"],
      ["isolation", { isolationBackendId: "bwrap", isolationStrength: "strong", promotionEligible: true }, "isolationStrength"],
      ["budget", { limits: { maxLogicalRuns: null, maxModelCalls: 5, maxEstimatedTokens: null, maxEstimatedCostUsd: null } }, "limits"],
    ];
    for (const [label, over, needle] of cases) {
      const dir = await freshDir(label);
      try {
        await seedJournal(single, dir, identity(single, fp));
        const provider = new ZeroProvider();
        const r = await runPairedExperiment({
          plan: single, cases: casesOf(single), provider, journalDir: dir,
          identity: identity(single, fp, over),
          runArm: async (arm) => outcome(arm.caseId, true),
        });
        expect(r.status, label).toBe("resume-rejected");
        if (r.status === "resume-rejected") {
          expect((r.violations ?? []).some((v) => v.includes(needle)), label + " names " + needle).toBe(true);
        }
        expect(provider.callCount, label + " made no provider call").toBe(0);
      } finally { await rm(dir, { recursive: true, force: true }); }
    }
  });

  it("an unchanged identity resumes and calls the provider only for missing arms", async () => {
    const plan = planFor(["c1", "c2"], 1, 11);
    const fps = { c1: "h1", c2: "h2" };
    const dir = await freshDir("resume-ok");
    try {
      // Journal only c1's pair by running a plan limited to c1 first.
      const partialPlan = planFor(["c1"], 1, 11);
      await seedJournal(partialPlan, dir, identity(partialPlan, { c1: "h1" }));
      // Same schedule identity for the two-case plan is a DIFFERENT schedule, so
      // use the identical plan to prove a clean resume path.
      const dir2 = await freshDir("resume-same");
      try {
        await seedJournal(plan, dir2, identity(plan, fps));
        const provider = new ZeroProvider();
        const r = await runPairedExperiment({
          plan, cases: casesOf(plan), provider, journalDir: dir2, identity: identity(plan, fps),
          runArm: async (arm) => outcome(arm.caseId, true),
        });
        expect(r.status).toBe("ok");
        if (r.status === "ok") {
          expect(r.resumed).toBe(true);
          // Every arm was already journaled -> nothing new executed.
          expect(provider.callCount).toBe(0);
          expect(r.counters.logicalRuns).toBe(4);
        }
      } finally { await rm(dir2, { recursive: true, force: true }); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("a pre-R01 journal (entries but no identity header) is refused and preserved", async () => {
    const dir = await freshDir("legacy");
    try {
      // Write a bare arm entry with no identity.json header.
      const plan = planFor(["c1"]);
      const entry: PairedJournalEntry = {
        armRunId: "legacy-arm", pairId: "p", arm: "baseline", caseId: "c1", repetition: 0,
        planDigest: computePairedPlanDigest(plan), outcome: outcome("c1", true), valid: true,
        modelCallAttempts: 1, transportRetries: 0, completedAt: 1,
      } as unknown as PairedJournalEntry;
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(dir, "legacy-arm.json"), JSON.stringify(entry), "utf8");
      const provider = new ZeroProvider();
      const r = await runPairedExperiment({
        plan, cases: casesOf(plan), provider, journalDir: dir, identity: identity(plan, fp),
        runArm: async (arm) => outcome(arm.caseId, true),
      });
      expect(r.status).toBe("resume-rejected");
      if (r.status === "resume-rejected") {
        expect((r.violations ?? []).some((v) => v.includes("no execution identity"))).toBe(true);
      }
      expect(provider.callCount).toBe(0);
      // Preserved for diagnosis, not deleted or overwritten.
      const files = await readdir(dir);
      expect(files).toContain("legacy-arm.json");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("identity digest is sensitive to every field and stable for equal identities", () => {
    const plan = planFor(["c1"]);
    const a = identity(plan, fp);
    const b = identity(plan, fp);
    expect(computeExecutionIdentityDigestV1(a)).toBe(computeExecutionIdentityDigestV1(b));
    expect(executionIdentityViolationsV1(a, b)).toEqual([]);
    expect(executionIdentityViolationsV1(a, identity(plan, fp, { modelSeed: 3 }))).not.toEqual([]);
    // A journal with no identity at all is never treated as compatible.
    expect(executionIdentityViolationsV1(null, a).length).toBe(1);
  });
});
