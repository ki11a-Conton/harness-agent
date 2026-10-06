/**
 * N6 / N2 — the pre-registration contract for
 * `context_safe_tool_call_efficiency_v1` (main experiment).
 *
 * What is proven here, all of it OFFLINE and BEFORE any model result:
 *   - the frozen schedule is exactly 24 cases × 4 repetitions × 2 arms = 192
 *     logical arm runs, AB/BA balanced at 96/96;
 *   - the dry run reports 192 and makes ZERO provider calls;
 *   - the root identity is a real function of every tunable input (prompt bytes,
 *     source SHA, case set, budget, provider profile, gates) — a change to any of
 *     them changes the digest, so an old approval cannot authorize a new plan;
 *   - the fail-closed refusals hold (wrong case count, holdout leak, identical
 *     arms, identical prompts);
 *   - the committed `main-preregistration.json` equals a fresh build from these
 *     same frozen inputs (a hand-edited artifact is refused).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_SAFE_COMPARISON_ARM_ID,
  CONTEXT_SAFE_CANDIDATE_ID,
  CONTEXT_SAFE_GATES,
  CONTEXT_SAFE_LOGICAL_RUNS_PER_EXPERIMENT,
  CONTEXT_SAFE_MAIN_CASES,
  CONTEXT_SAFE_PREREGISTRATION_SCHEMA,
  CONTEXT_SAFE_REPETITIONS,
  buildContextSafePreregistration,
  computeContextSafePreregistrationDigest,
  contextSafeCaseEntriesFromManifest,
  contextSafePairedPlan,
  dryRunContextSafePreregistration,
  type ContextSafePreregistration,
  type ContextSafePreregistrationOptions,
} from "./context-safe-tool-call-efficiency-preregistration.js";
import { getArmFactory } from "./arm-factory.js";
import { contextSafeToolCallEfficiencyGuidanceDigest, toolCallEfficiencyGuidanceDigest } from "./mechanism-guidance.js";

const REPO = resolve(import.meta.dirname, "../../..");
const MANIFEST_PATH = join(REPO, "docs", "evidence", "agent-next6-20261005", "case-manifest.json");
const ARTIFACT_PATH = join(REPO, "docs", "evidence", "agent-next6-20261005", "main-preregistration.json");

interface ManifestShape {
  suite: { id: string; version: string; caseRoot: string };
  manifestDigest: string;
  cases: { caseId: string; suite: string; condition: string; contentDigest: string; verifierDigest: string }[];
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as ManifestShape;

/** The frozen inputs. The freeze script uses the SAME numbers; the committed
 *  artifact is checked against this builder so the two cannot drift. */
function frozenOptions(over: Partial<ContextSafePreregistrationOptions> = {}): ContextSafePreregistrationOptions {
  const factory = getArmFactory();
  return {
    subject: {
      // Bound at execution time; the contract only requires a real 40-hex SHA.
      candidateSourceSha: "a".repeat(40),
      baselineArmDigest: factory.resolveArm(CONTEXT_SAFE_COMPARISON_ARM_ID).digest,
      candidateArmDigest: factory.resolveArm(CONTEXT_SAFE_CANDIDATE_ID).digest,
      runtimeConfigDigest: "b".repeat(64),
    },
    provider: {
      providerId: "openai",
      modelId: "gpt-5",
      requestProfile: { budgetTokens: 32_000, temperature: null, stallPolicy: "benchmark-default" },
    },
    cases: contextSafeCaseEntriesFromManifest(manifest.cases),
    suite: { id: manifest.suite.id, version: manifest.suite.version, caseRoot: manifest.suite.caseRoot },
    holdoutPolicy:
      "holdout per-case data is never read into an artifact; the holdout experiment uses its own suite and never participates in prompt tuning",
    selectionProvenanceDigest: manifest.manifestDigest,
    evaluation: { scorerDigest: "c".repeat(64), judgeId: "task-verifier", judgeDigest: "d".repeat(64) },
    schedule: { orderSeed: 20_261_005 },
    budget: {
      maxModelCallsPerRun: 30,
      maxToolCalls: 600,
      maxDurationMs: 1_800_000,
      maxInputTokens: 3_000_000,
      maxOutputTokens: 400_000,
      maxTotalTokens: 4_000_000,
      maxUsdMicros: null,
    },
    ...over,
  };
}

describe("N6/N2 — context_safe_tool_call_efficiency_v1 pre-registration", () => {
  it("1. the frozen schedule is exactly 192 logical arm runs, AB/BA balanced at 48/48", () => {
    const artifact = buildContextSafePreregistration(frozenOptions());
    expect(artifact.schemaVersion).toBe(CONTEXT_SAFE_PREREGISTRATION_SCHEMA);
    expect(artifact.dataset.cases).toHaveLength(CONTEXT_SAFE_MAIN_CASES);
    expect(artifact.schedule.repetitions).toBe(CONTEXT_SAFE_REPETITIONS);
    expect(CONTEXT_SAFE_MAIN_CASES * CONTEXT_SAFE_REPETITIONS * 2).toBe(CONTEXT_SAFE_LOGICAL_RUNS_PER_EXPERIMENT);
    expect(artifact.schedule.logicalRuns).toBe(192);
    // 96 pairs, strictly alternating AB/BA → 48 of each (balanced).
    expect(artifact.schedule.abCount).toBe(48);
    expect(artifact.schedule.baCount).toBe(48);
    expect(artifact.schedule.abCount + artifact.schedule.baCount).toBe(96);
    expect(artifact.schedule.balanced).toBe(true);
    // The recorded schedule identity is the REAL paired-plan builder's digest.
    const plan = contextSafePairedPlan(artifact);
    expect(plan.totalLogicalRuns).toBe(192);
    expect(plan.pairs).toHaveLength(96);
    expect(plan.planDigest).toBe(artifact.schedule.planDigest);
    // Worst case is model CALLS, not the 192 logical runs.
    expect(artifact.budget.campaignWorstCaseModelCalls).toBe(30 * 192);
  });

  it("2. the dry run reports 192 runs and makes ZERO provider calls", () => {
    const artifact = buildContextSafePreregistration(frozenOptions());
    const report = dryRunContextSafePreregistration(artifact);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.status).toBe("DRY_RUN_ONLY");
    expect(report.logicalRuns).toBe(192);
    expect(report.abCount).toBe(48);
    expect(report.baCount).toBe(48);
    expect(report.balanced).toBe(true);
    expect(report.cases).toBe(24);
    expect(report.repetitions).toBe(4);
    expect(report.campaignWorstCaseModelCalls).toBe(5760);
    // Structural, not measured: a dry run constructs no provider at all.
    expect(report.providerCalls).toBe(0);
    expect(report.paidProviderCalls).toBe(0);
    expect(report.modelQuality).toBe("NOT_RUN");
    expect(report.promotion).toBe("NOT_RUN");
  });

  it("3. the build is a PURE function of its frozen inputs", () => {
    const a = buildContextSafePreregistration(frozenOptions());
    const b = buildContextSafePreregistration(frozenOptions());
    expect(b.preregistrationDigest).toBe(a.preregistrationDigest);
    expect(computeContextSafePreregistrationDigest(a)).toBe(a.preregistrationDigest);
  });

  it("4. the root identity changes when ANY tunable input changes", () => {
    const base = buildContextSafePreregistration(frozenOptions());
    const mutations: [string, Partial<ContextSafePreregistrationOptions>][] = [
      ["source sha", { subject: { ...frozenOptions().subject, candidateSourceSha: "e".repeat(40) } }],
      ["runtime config", { subject: { ...frozenOptions().subject, runtimeConfigDigest: "f".repeat(64) } }],
      ["comparison arm", { subject: { ...frozenOptions().subject, baselineArmDigest: "1".repeat(64) } }],
      ["provider profile", { provider: { providerId: "openai", modelId: "gpt-5", requestProfile: { budgetTokens: 64_000 } } }],
      ["model id", { provider: { providerId: "openai", modelId: "gpt-5-mini", requestProfile: { budgetTokens: 32_000 } } }],
      ["order seed", { schedule: { orderSeed: 7 } }],
      ["budget ceiling", { budget: { ...frozenOptions().budget, maxModelCallsPerRun: 31 } }],
      ["usd ceiling", { budget: { ...frozenOptions().budget, maxUsdMicros: 1_000_000 } }],
      ["case set", { cases: contextSafeCaseEntriesFromManifest(manifest.cases).map((c, i) => (i === 0 ? { ...c, contentDigest: "0".repeat(64) } : c)) }],
      ["verifier set", { cases: contextSafeCaseEntriesFromManifest(manifest.cases).map((c, i) => (i === 3 ? { ...c, verifierDigest: "9".repeat(64) } : c)) }],
      ["selection provenance", { selectionProvenanceDigest: "8".repeat(64) }],
      ["suite version", { suite: { ...manifest.suite, version: "2.0.0" } }],
      ["holdout policy", { holdoutPolicy: "a weaker policy" }],
      ["scorer", { evaluation: { scorerDigest: "7".repeat(64), judgeId: "task-verifier", judgeDigest: "d".repeat(64) } }],
    ];
    for (const [label, over] of mutations) {
      const mutated = buildContextSafePreregistration(frozenOptions(over));
      expect(mutated.preregistrationDigest, `${label} did not change the identity`).not.toBe(base.preregistrationDigest);
    }
    // The prompt bytes are part of the identity through the AUTHORITATIVE
    // constants, so a tampered prompt digest must also change it.
    const tampered: ContextSafePreregistration = {
      ...base,
      prompt: { ...base.prompt, guidanceDigest: "5".repeat(64) },
    };
    expect(computeContextSafePreregistrationDigest(tampered)).not.toBe(base.preregistrationDigest);
    // …and a loosened gate must too.
    const loosened: ContextSafePreregistration = {
      ...base,
      evaluation: { ...base.evaluation, gates: { ...CONTEXT_SAFE_GATES, missingGroupVerifiedPassRateLiftPp: 1 } },
    };
    expect(computeContextSafePreregistrationDigest(loosened)).not.toBe(base.preregistrationDigest);
  });

  it("5. the two arms inject different text, and the prompt identity comes from the constants", () => {
    const artifact = buildContextSafePreregistration(frozenOptions());
    expect(artifact.prompt.candidateId).toBe(CONTEXT_SAFE_CANDIDATE_ID);
    expect(artifact.prompt.guidanceDigest).toBe(contextSafeToolCallEfficiencyGuidanceDigest());
    expect(artifact.prompt.comparisonGuidanceDigest).toBe(toolCallEfficiencyGuidanceDigest());
    expect(artifact.prompt.guidanceDigest).not.toBe(artifact.prompt.comparisonGuidanceDigest);
  });

  it("6. fail-closed refusals: wrong case count, holdout leak, identical arms, identical prompts", () => {
    const cases = contextSafeCaseEntriesFromManifest(manifest.cases);
    expect(() => buildContextSafePreregistration(frozenOptions({ cases: cases.slice(0, 23) }))).toThrow(/WRONG_CASE_COUNT/);
    // 25 DISTINCT ids (a duplicate id would refuse for a different reason).
    const tooMany = [...cases, { ...cases[0]!, caseId: "n6e-extra-case" }];
    expect(tooMany).toHaveLength(25);
    expect(() => buildContextSafePreregistration(frozenOptions({ cases: tooMany }))).toThrow(/WRONG_CASE_COUNT/);
    expect(() =>
      buildContextSafePreregistration(
        frozenOptions({ cases: cases.map((c, i) => (i === 0 ? { ...c, suite: "holdout" } : c)) }),
      ),
    ).toThrow(/HOLDOUT_LEAK/);
    const arms = frozenOptions().subject;
    expect(() =>
      buildContextSafePreregistration(frozenOptions({ subject: { ...arms, baselineArmDigest: arms.candidateArmDigest } })),
    ).toThrow(/ARMS_IDENTICAL/);
    expect(() => buildContextSafePreregistration(frozenOptions({ subject: { ...arms, candidateSourceSha: "not-a-sha" } }))).toThrow(
      /INVALID_FIELD/,
    );
    expect(() =>
      buildContextSafePreregistration(
        frozenOptions({
          provider: {
            providerId: "openai",
            modelId: "gpt-5",
            requestProfile: { budgetTokens: 32_000 },
            endpointBaseUrl: "https://user:pw@example.test/v1?token=x",
          },
        }),
      ),
    ).toThrow(/ENDPOINT_USERINFO/);
  });

  it("7. the committed artifact equals a fresh build from these frozen inputs (no hand edits)", () => {
    const raw = readFileSync(ARTIFACT_PATH, "utf8");
    const committed = JSON.parse(raw) as ContextSafePreregistration;
    const fresh = buildContextSafePreregistration(frozenOptions());
    expect(committed.preregistrationDigest).toBe(fresh.preregistrationDigest);
    expect(committed).toEqual(fresh);
    // The committed artifact itself dry-runs clean and reports zero paid calls.
    const report = dryRunContextSafePreregistration(committed);
    expect(report.ok).toBe(true);
    expect(report.logicalRuns).toBe(192);
    expect(report.paidProviderCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The INDEPENDENT HOLDOUT experiment. Its comparison arm is the CURRENT
// production champion, RESOLVED from the real state file — never assumed C0.
// ---------------------------------------------------------------------------

const HOLDOUT_MANIFEST_PATH = join(REPO, "docs", "evidence", "agent-next6-20261005", "holdout-case-manifest.json");
const HOLDOUT_ARTIFACT_PATH = join(REPO, "docs", "evidence", "agent-next6-20261005", "holdout-preregistration.json");
const holdoutManifest = JSON.parse(readFileSync(HOLDOUT_MANIFEST_PATH, "utf8")) as ManifestShape;

/** The champion the committed artifact was frozen against (C0 at freeze time).
 *  Re-resolving it here is the point: the arm digest must be a real factory
 *  digest, and a champion change must invalidate the plan. */
function resolvedChampion(): {
  digest: string;
  provenance: {
    source: string;
    level: string;
    candidateId: string | null;
    stateDigest: string | null;
  };
} {
  const statePath = join(REPO, "docs", "evolution", "champion-state.json");
  const stateText = readFileSync(statePath, "utf8");
  const state = JSON.parse(stateText) as {
    level: string;
    candidateId: string | null;
    validity: string;
    applied: boolean;
  };
  const candidateId = state.candidateId ?? null;
  return {
    digest: getArmFactory().resolveArm(candidateId).digest,
    provenance: {
      source:
        `docs/evolution/champion-state.json (level=${state.level}, ` +
        `candidateId=${candidateId === null ? "null" : candidateId}, ` +
        `validity=${state.validity}, applied=${String(state.applied)})`,
      level: state.level,
      candidateId,
      stateDigest: createHash("sha256").update(stateText.replace(/\r\n/g, "\n"), "utf8").digest("hex"),
    },
  };
}

function holdoutOptions(over: Partial<ContextSafePreregistrationOptions> = {}): ContextSafePreregistrationOptions {
  const champion = resolvedChampion();
  return {
    role: "holdout",
    subject: {
      candidateSourceSha: "a".repeat(40),
      baselineArmDigest: champion.digest,
      candidateArmDigest: getArmFactory().resolveArm(CONTEXT_SAFE_CANDIDATE_ID).digest,
      runtimeConfigDigest: "b".repeat(64),
      championProvenance: champion.provenance,
    },
    provider: {
      providerId: "openai",
      modelId: "gpt-5",
      requestProfile: { budgetTokens: 32_000, temperature: null, stallPolicy: "benchmark-default" },
    },
    cases: contextSafeCaseEntriesFromManifest(holdoutManifest.cases),
    suite: {
      id: holdoutManifest.suite.id,
      version: holdoutManifest.suite.version,
      caseRoot: holdoutManifest.suite.caseRoot,
    },
    holdoutPolicy:
      "holdout per-case data is never read into an artifact; this plan IS the holdout experiment and never participates in prompt tuning",
    selectionProvenanceDigest: holdoutManifest.manifestDigest,
    evaluation: { scorerDigest: "c".repeat(64), judgeId: "task-verifier", judgeDigest: "d".repeat(64) },
    schedule: { orderSeed: 20_261_006 },
    budget: {
      maxModelCallsPerRun: 30,
      maxToolCalls: 600,
      maxDurationMs: 1_800_000,
      maxInputTokens: 3_000_000,
      maxOutputTokens: 400_000,
      maxTotalTokens: 4_000_000,
      maxUsdMicros: null,
    },
    ...over,
  };
}

describe("N6/N2 — independent holdout pre-registration (champion-resolved)", () => {
  it("1. freezes 192 logical arm runs against the RESOLVED champion, not an assumed C0", () => {
    const artifact = buildContextSafePreregistration(holdoutOptions());
    expect(artifact.role).toBe("holdout");
    expect(artifact.dataset.suiteId).toBe("n6-holdout");
    expect(artifact.dataset.cases).toHaveLength(24);
    expect(artifact.schedule.logicalRuns).toBe(192);
    expect(artifact.schedule.abCount).toBe(48);
    expect(artifact.schedule.baCount).toBe(48);
    expect(artifact.schedule.balanced).toBe(true);

    // The comparison arm is the champion resolved from the real state file, and
    // its provenance is bound into the identity.
    const champion = resolvedChampion();
    expect(artifact.subject.baselineArmDigest).toBe(champion.digest);
    expect(artifact.subject.championProvenance).toEqual(champion.provenance);
    expect(artifact.subject.championProvenance!.source).toContain("docs/evolution/champion-state.json");
    // …and it is a DIFFERENT arm from the candidate.
    expect(artifact.subject.baselineArmDigest).not.toBe(artifact.subject.candidateArmDigest);
  });

  it("2. the dry run reports 192 runs and zero paid calls", () => {
    const report = dryRunContextSafePreregistration(buildContextSafePreregistration(holdoutOptions()));
    expect(report.ok).toBe(true);
    expect(report.logicalRuns).toBe(192);
    expect(report.paidProviderCalls).toBe(0);
    expect(report.modelQuality).toBe("NOT_RUN");
    expect(report.promotion).toBe("NOT_RUN");
  });

  it("3. fail-closed: a holdout plan without champion provenance is REFUSED", () => {
    const base = holdoutOptions();
    const { championProvenance: _omitted, ...subjectWithout } = base.subject;
    void _omitted;
    expect(() => buildContextSafePreregistration({ ...base, subject: subjectWithout })).toThrow(/CHAMPION_UNRESOLVED/);
  });

  it("4. fail-closed: the two case sets may never be mixed", () => {
    // Main-suite cases in the holdout role …
    expect(() =>
      buildContextSafePreregistration({
        ...holdoutOptions(),
        cases: contextSafeCaseEntriesFromManifest(manifest.cases),
      }),
    ).toThrow(/HOLDOUT_ROLE_MISMATCH/);
    // … and holdout cases in the main role (already covered for the main plan,
    // re-asserted here against the same real inputs).
    expect(() =>
      buildContextSafePreregistration({
        ...frozenOptions(),
        cases: contextSafeCaseEntriesFromManifest(holdoutManifest.cases),
      }),
    ).toThrow(/HOLDOUT_LEAK/);
  });

  it("5. the committed holdout artifact equals a fresh build from the same resolved inputs", () => {
    const committed = JSON.parse(readFileSync(HOLDOUT_ARTIFACT_PATH, "utf8")) as ContextSafePreregistration;
    const fresh = buildContextSafePreregistration(holdoutOptions());
    expect(committed).toEqual(fresh);
    expect(committed.role).toBe("holdout");
    const report = dryRunContextSafePreregistration(committed);
    expect(report.ok).toBe(true);
    expect(report.logicalRuns).toBe(192);
    expect(report.paidProviderCalls).toBe(0);
  });

  it("6. the holdout identity is independent of the main experiment's", () => {
    const main = buildContextSafePreregistration(frozenOptions());
    const holdout = buildContextSafePreregistration(holdoutOptions());
    expect(holdout.preregistrationDigest).not.toBe(main.preregistrationDigest);
    expect(holdout.dataset.caseSetDigest).not.toBe(main.dataset.caseSetDigest);
    expect(holdout.dataset.selectionProvenanceDigest).not.toBe(main.dataset.selectionProvenanceDigest);
    // A different comparison arm AND a different order seed.
    expect(holdout.schedule.planDigest).not.toBe(main.schedule.planDigest);
  });
});
