/**
 * N7 / N7-3 — the pre-registration contract for the v2 challenger.
 *
 * What is proven here, all of it OFFLINE and BEFORE any model result:
 *   - the MAIN schedule is exactly 64 cases × 4 repetitions × 2 arms = 512
 *     logical ARM RUNS, AB/BA balanced at 128/128, and the dry run reports
 *     exactly that with ZERO provider calls;
 *   - the INDEPENDENT HOLDOUT keeps its own 24-case corpus (192 runs) and its
 *     comparison arm is the champion RESOLVED from the real state file, never an
 *     assumption;
 *   - the root identity is a real function of every tunable input (prompt bytes,
 *     source SHA, case set, budget, provider profile, request profile, seed,
 *     gates, arms) — a change to any of them changes the digest, so an old
 *     approval can never authorize a rewritten plan;
 *   - the N7 gates are the N6 gates VALUE FOR VALUE — nothing was loosened;
 *   - the fail-closed refusals hold (wrong case count, holdout leak, holdout role
 *     mismatch, identical arms, a candidate arm that is not the real v2 arm);
 *   - the committed artifacts equal fresh builds from the frozen inputs, and the
 *     generalization to a plan spec did NOT disturb the committed N6 artifacts;
 *   - no artifact claims a model-quality or promotion result: the N7 campaign is
 *     not executed in this round.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_SAFE_GATES,
  CONTEXT_SAFE_PREREGISTRATION_SCHEMA,
  CONTEXT_SAFE_V1_PLAN_SPEC,
  buildContextSafePreregistration,
  computeContextSafePreregistrationDigest,
  contextSafeCaseEntriesFromManifest,
  dryRunContextSafePreregistration,
  type ContextSafePreregistration,
  type ContextSafePreregistrationOptions,
} from "./context-safe-tool-call-efficiency-preregistration.js";
import {
  CONTEXT_SAFE_V2_CANDIDATE_ID,
  CONTEXT_SAFE_V2_COMPARISON_ARM_ID,
  CONTEXT_SAFE_V2_GATES,
  CONTEXT_SAFE_V2_HOLDOUT_CASES,
  CONTEXT_SAFE_V2_HOLDOUT_LOGICAL_RUNS,
  CONTEXT_SAFE_V2_HOLDOUT_PLAN_SPEC,
  CONTEXT_SAFE_V2_LOGICAL_RUNS_PER_EXPERIMENT,
  CONTEXT_SAFE_V2_MAIN_CASES,
  CONTEXT_SAFE_V2_MAIN_PLAN_SPEC,
  CONTEXT_SAFE_V2_PREREGISTRATION_SCHEMA,
  CONTEXT_SAFE_V2_REPETITIONS,
  buildContextSafeV2Preregistration,
  dryRunContextSafeV2Preregistration,
} from "./context-safe-tool-call-efficiency-v2-preregistration.js";
import { getArmFactory } from "./arm-factory.js";
import { stableStringify } from "./manifest.js";
import {
  contextSafeToolCallEfficiencyGuidanceDigest,
  contextSafeToolCallEfficiencyV2GuidanceDigest,
  toolCallEfficiencyGuidanceDigest,
} from "./mechanism-guidance.js";

const REPO = resolve(import.meta.dirname, "../../..");
const EVIDENCE_DIR = join(REPO, "docs", "evidence", "agent-next7-20261006");
const MANIFEST_PATH = join(EVIDENCE_DIR, "case-manifest.json");
const HOLDOUT_MANIFEST_PATH = join(EVIDENCE_DIR, "holdout-case-manifest.json");
const ARTIFACT_PATH = join(EVIDENCE_DIR, "main-preregistration.json");
const HOLDOUT_ARTIFACT_PATH = join(EVIDENCE_DIR, "holdout-preregistration.json");
const CHAMPION_STATE_PATH = join(REPO, "docs", "evolution", "champion-state.json");

/** The N7 bound source: the freeze-time commit of this repository. */
const N7_SOURCE_SHA = "a251af1daf7991280277a99d70bf3a3a6201c66d";

interface ManifestShape {
  suite: { id: string; version: string; caseRoot: string };
  manifestDigest: string;
  cases: { caseId: string; suite: string; condition: string; contentDigest: string; verifierDigest: string }[];
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as ManifestShape;
const holdoutManifest = JSON.parse(readFileSync(HOLDOUT_MANIFEST_PATH, "utf8")) as ManifestShape;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The frozen MAIN inputs. The freeze script uses the SAME numbers; the committed
 * artifact is rebuilt from this and compared, so script and test cannot drift.
 */
function frozenOptions(over: Partial<ContextSafePreregistrationOptions> = {}): ContextSafePreregistrationOptions {
  const factory = getArmFactory();
  return {
    subject: {
      candidateSourceSha: N7_SOURCE_SHA,
      baselineArmDigest: factory.resolveArm(CONTEXT_SAFE_V2_COMPARISON_ARM_ID).digest,
      candidateArmDigest: factory.resolveArm(CONTEXT_SAFE_V2_CANDIDATE_ID).digest,
      runtimeConfigDigest: factory.resolveArm(CONTEXT_SAFE_V2_CANDIDATE_ID).digest,
    },
    provider: {
      providerId: "openai",
      modelId: "workbuddy-deepseek-v4.1-flash",
      endpointBaseUrl: "http://127.0.0.1:8317/v1",
      requestProfile: { budgetTokens: 32_000, temperature: null, stallPolicy: "benchmark-default" },
    },
    cases: contextSafeCaseEntriesFromManifest(manifest.cases),
    suite: { id: manifest.suite.id, version: manifest.suite.version, caseRoot: manifest.suite.caseRoot },
    holdoutPolicy:
      "holdout per-case data is never read into an artifact; the holdout experiment uses its own suite and never participates in prompt tuning",
    selectionProvenanceDigest: manifest.manifestDigest,
    evaluation: { scorerDigest: "c".repeat(64), judgeId: "task-verifier", judgeDigest: "d".repeat(64) },
    schedule: { orderSeed: 20_261_007 },
    budget: {
      maxModelCallsPerRun: 30,
      // AMENDED 2026-10-07 (#2): the campaign-level capacity caps were N5-era values
      // the N7 design never scaled; campaign #2 died with toolCalls 600/600 and
      // inputTokens 2,969,213/3,000,000. Only capacity changed — gates, cases, arms,
      // repetitions, seeds, provider and the call/USD ceilings are untouched.
      maxToolCalls: 32_000,
      // AMENDED 2026-10-07: the pre-registered campaign duration was extended to 12h
      // — see docs/evidence/agent-next7-20261006/BUDGET-AMENDMENT.md.
      maxDurationMs: 43_200_000,
      maxInputTokens: 80_000_000,
      maxOutputTokens: 4_000_000,
      maxTotalTokens: 90_000_000,
      maxUsdMicros: 100_000_000_000,
    },
    ...over,
  };
}

/** The champion the committed holdout artifact was frozen against, RESOLVED. */
function resolvedChampion(): {
  digest: string;
  provenance: { source: string; level: string; candidateId: string | null; stateDigest: string | null };
} {
  const stateText = readFileSync(CHAMPION_STATE_PATH, "utf8");
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
        `validity=${String(state.validity)}, applied=${String(state.applied)})`,
      level: state.level,
      candidateId,
      stateDigest: sha256(stateText.replace(/\r\n/g, "\n")),
    },
  };
}

/** The frozen HOLDOUT inputs (identical to the holdout freeze script). */
function holdoutOptions(): ContextSafePreregistrationOptions {
  const champion = resolvedChampion();
  const factory = getArmFactory();
  return {
    role: "holdout",
    subject: {
      candidateSourceSha: N7_SOURCE_SHA,
      baselineArmDigest: champion.digest,
      candidateArmDigest: factory.resolveArm(CONTEXT_SAFE_V2_CANDIDATE_ID).digest,
      runtimeConfigDigest: factory.resolveArm(CONTEXT_SAFE_V2_CANDIDATE_ID).digest,
      championProvenance: champion.provenance,
    },
    provider: {
      providerId: "openai",
      modelId: "workbuddy-deepseek-v4.1-flash",
      endpointBaseUrl: "http://127.0.0.1:8317/v1",
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
    schedule: { orderSeed: 20_261_008 },
    budget: {
      maxModelCallsPerRun: 30,
      // AMENDED 2026-10-07 (#2): the campaign-level capacity caps were N5-era values
      // the N7 design never scaled; campaign #2 died with toolCalls 600/600 and
      // inputTokens 2,969,213/3,000,000. Only capacity changed — gates, cases, arms,
      // repetitions, seeds, provider and the call/USD ceilings are untouched.
      maxToolCalls: 32_000,
      // AMENDED 2026-10-07: same duration amendment as the main plan.
      maxDurationMs: 43_200_000,
      maxInputTokens: 80_000_000,
      maxOutputTokens: 4_000_000,
      maxTotalTokens: 90_000_000,
      maxUsdMicros: 100_000_000_000,
    },
  };
}

const digestOf = (a: ContextSafePreregistration): string => computeContextSafePreregistrationDigest(a);

describe("N7/N7-3 — context_safe_tool_call_efficiency_v2 pre-registration (main)", () => {
  const artifact = buildContextSafeV2Preregistration(frozenOptions());

  it("1. the frozen schedule is exactly 64 cases × 4 repetitions × 2 arms = 512 logical arm runs, AB/BA balanced", () => {
    expect(CONTEXT_SAFE_V2_MAIN_CASES).toBe(64);
    expect(CONTEXT_SAFE_V2_REPETITIONS).toBe(4);
    expect(CONTEXT_SAFE_V2_LOGICAL_RUNS_PER_EXPERIMENT).toBe(512);
    expect(artifact.dataset.cases).toHaveLength(64);
    expect(artifact.schedule.repetitions).toBe(4);
    expect(artifact.schedule.logicalRuns).toBe(512);
    expect(artifact.schedule.abCount).toBe(128);
    expect(artifact.schedule.baCount).toBe(128);
    expect(artifact.schedule.balanced).toBe(true);
  });

  it("2. the dry run reports exactly 512 logical arm runs and ZERO provider calls", () => {
    const report = dryRunContextSafeV2Preregistration(artifact);
    expect(report.ok, report.problems.join("; ")).toBe(true);
    expect(report.status).toBe("DRY_RUN_ONLY");
    expect(report.logicalRuns).toBe(512);
    expect(report.cases).toBe(64);
    expect(report.providerCalls).toBe(0);
    expect(report.paidProviderCalls).toBe(0);
    // No model result exists for this round, and the artifact never pretends one does.
    expect(report.modelQuality).toBe("NOT_RUN");
    expect(report.promotion).toBe("NOT_RUN");
    expect(report.campaignWorstCaseModelCalls).toBe(30 * 512);
  });

  it("3. the committed main artifact equals a fresh build from the frozen inputs", () => {
    const committed = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as ContextSafePreregistration;
    expect(committed).toEqual(artifact);
    expect(committed.preregistrationDigest).toBe(digestOf(artifact));
    // The N7 schema is its own: it can never be confused with the N6 plan.
    expect(committed.schemaVersion).toBe(CONTEXT_SAFE_V2_PREREGISTRATION_SCHEMA);
    expect(committed.preregistrationDigest).not.toBe("f4833575e139232a0581d631507010b7c0640f190c286194d33645d570d603bd");
  });

  it("4. the plan binds the v2 TEXT: its digest, the resolved v2 arm's digest, and the comparison text", () => {
    expect(artifact.prompt.candidateId).toBe(CONTEXT_SAFE_V2_CANDIDATE_ID);
    expect(artifact.prompt.guidanceDigest).toBe(contextSafeToolCallEfficiencyV2GuidanceDigest());
    expect(artifact.prompt.comparisonCandidateId).toBe(CONTEXT_SAFE_V2_COMPARISON_ARM_ID);
    expect(artifact.prompt.comparisonGuidanceDigest).toBe(toolCallEfficiencyGuidanceDigest());
    // The arm the plan names really carries the v2 bytes…
    const arm = getArmFactory().resolveArm(CONTEXT_SAFE_V2_CANDIDATE_ID);
    expect(arm.promptAdditionsDigest).toBe(contextSafeToolCallEfficiencyV2GuidanceDigest());
    // …and NOT the v1 context-safe text, so an N6 plan can never be read as this one.
    expect(artifact.prompt.guidanceDigest).not.toBe(contextSafeToolCallEfficiencyGuidanceDigest());
    expect(artifact.prompt.guidanceDigest).not.toBe(artifact.prompt.comparisonGuidanceDigest);
    expect(artifact.subject.candidateArmDigest).toBe(arm.digest);
    expect(artifact.subject.baselineArmDigest).not.toBe(artifact.subject.candidateArmDigest);
  });

  it("5. the identity changes when ANY tunable input changes (an old approval cannot ride on a new plan)", () => {
    const base = artifact.preregistrationDigest;
    const variants: [string, ContextSafePreregistration][] = [
      ["order seed", buildContextSafeV2Preregistration(frozenOptions({ schedule: { orderSeed: 20_261_009 } }))],
      [
        "budget ceiling",
        buildContextSafeV2Preregistration(
          frozenOptions({
            budget: { ...frozenOptions().budget, maxUsdMicros: 99_000_000_000 },
          }),
        ),
      ],
      [
        "request profile",
        buildContextSafeV2Preregistration(
          frozenOptions({
            provider: { ...frozenOptions().provider, requestProfile: { budgetTokens: 64_000 } },
          }),
        ),
      ],
      [
        "model id",
        buildContextSafeV2Preregistration(
          frozenOptions({ provider: { ...frozenOptions().provider, modelId: "workbuddy-deepseek-v4.1" } }),
        ),
      ],
      [
        "source sha",
        buildContextSafeV2Preregistration(
          frozenOptions({ subject: { ...frozenOptions().subject, candidateSourceSha: "b".repeat(40) } }),
        ),
      ],
      [
        "case content",
        buildContextSafeV2Preregistration(
          frozenOptions({
            cases: contextSafeCaseEntriesFromManifest(manifest.cases).map((c, i) =>
              i === 0 ? { ...c, contentDigest: "0".repeat(64) } : c,
            ),
          }),
        ),
      ],
      ["selection provenance", buildContextSafeV2Preregistration(frozenOptions({ selectionProvenanceDigest: "a".repeat(64) }))],
      [
        "arm digest",
        buildContextSafeV2Preregistration(frozenOptions({ subject: { ...frozenOptions().subject, runtimeConfigDigest: "9".repeat(64) } })),
      ],
      [
        "gates",
        buildContextSafePreregistration({
          ...frozenOptions(),
          planSpec: {
            ...CONTEXT_SAFE_V2_MAIN_PLAN_SPEC,
            gates: { ...CONTEXT_SAFE_V2_GATES, missingGroupVerifiedPassRateLiftPp: 4 },
          },
        }),
      ],
    ];
    for (const [label, variant] of variants) {
      expect(variant.preregistrationDigest, `${label} did not change the identity`).not.toBe(base);
    }
    // The freeze is deterministic: the same inputs give the same identity.
    expect(buildContextSafeV2Preregistration(frozenOptions()).preregistrationDigest).toBe(base);
  });

  it("6. the N7 gates are the N6 gates VALUE FOR VALUE — nothing was loosened", () => {
    expect(CONTEXT_SAFE_V2_GATES).toEqual(CONTEXT_SAFE_GATES);
    expect(Object.keys(CONTEXT_SAFE_V2_GATES).sort()).toEqual(Object.keys(CONTEXT_SAFE_GATES).sort());
    expect(artifact.evaluation.gates).toEqual(CONTEXT_SAFE_GATES);
    expect(artifact.evaluation.gatesDigest).toBe(sha256(stableStringify(CONTEXT_SAFE_GATES)));
    // A single loosened gate value is representable and really moves the identity.
    expect(CONTEXT_SAFE_V2_GATES.missingGroupVerifiedPassRateLiftPp).toBe(5);
    expect(CONTEXT_SAFE_V2_GATES.newSecurityViolationsMax).toBe(0);
    expect(CONTEXT_SAFE_V2_GATES.newFalseCompleteMax).toBe(0);
    expect(CONTEXT_SAFE_V2_GATES.totalTokensMaxRatioOfBaseline).toBe(1.1);
    expect(CONTEXT_SAFE_V2_GATES.baselineZeroUsesAbsoluteNonGrowth).toBe(true);
    expect(CONTEXT_SAFE_V2_GATES.usageUnknownIsNotZero).toBe(true);
  });

  it("7. fail-closed: wrong case counts, bad SHAs, identical arms and a non-v2 candidate arm are refused", () => {
    const cases = contextSafeCaseEntriesFromManifest(manifest.cases);
    expect(() =>
      buildContextSafeV2Preregistration(frozenOptions({ cases: cases.slice(0, 63) })),
    ).toThrow(/WRONG_CASE_COUNT/);
    expect(() =>
      buildContextSafeV2Preregistration(frozenOptions({ cases: [...cases, { ...cases[0]!, caseId: "n7e-extra" }] })),
    ).toThrow(/WRONG_CASE_COUNT/);
    expect(() =>
      buildContextSafeV2Preregistration(
        frozenOptions({ subject: { ...frozenOptions().subject, candidateSourceSha: "deadbeef" } }),
      ),
    ).toThrow(/INVALID_FIELD/);
    expect(() =>
      buildContextSafeV2Preregistration(
        frozenOptions({
          subject: {
            ...frozenOptions().subject,
            baselineArmDigest: getArmFactory().resolveArm(CONTEXT_SAFE_V2_CANDIDATE_ID).digest,
          },
        }),
      ),
    ).toThrow(/ARMS_IDENTICAL/);
    // A hand-written candidate arm digest is refused: the plan must name the REAL
    // resolved v2 arm.
    expect(() =>
      buildContextSafeV2Preregistration(
        frozenOptions({ subject: { ...frozenOptions().subject, candidateArmDigest: "7".repeat(64) } }),
      ),
    ).toThrow(/CANDIDATE_ARM_NOT_RESOLVED/);
    // Holdout cases may never be frozen into the main plan.
    expect(() =>
      buildContextSafeV2Preregistration({
        ...frozenOptions(),
        cases: contextSafeCaseEntriesFromManifest(holdoutManifest.cases),
      }),
    ).toThrow(/HOLDOUT_LEAK|WRONG_CASE_COUNT/);
  });

  it("8. a plan frozen for another candidate/schema is refused by the dry run", () => {
    const report = dryRunContextSafePreregistration(artifact, CONTEXT_SAFE_V1_PLAN_SPEC);
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toMatch(/schemaVersion|candidateId|guidance digest/);
    // …and the v2 MAIN artifact is not silently dry-run as the HOLDOUT plan.
    const asHoldout = dryRunContextSafePreregistration(artifact, CONTEXT_SAFE_V2_HOLDOUT_PLAN_SPEC);
    expect(asHoldout.ok).toBe(false);
    expect(asHoldout.problems.join("\n")).toMatch(/cases 64 !== 24|logicalRuns 512 !== 192/);
  });

  it("9. the artifact carries no raw endpoint or credential, and no model-result claim", () => {
    const text = JSON.stringify(artifact);
    expect(text).not.toContain("127.0.0.1");
    // No credential-shaped value: an OpenAI-style key is `sk-` plus a long token
    // (`task-verifier` legitimately contains the letters "sk-" without a key).
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    expect(text).not.toContain("http");
    expect(text.toLowerCase()).not.toContain("apikey");
    expect(text.toLowerCase()).not.toContain("api_key");
    expect(text.toLowerCase()).not.toContain("authorization");
    expect(text.toLowerCase()).not.toContain("bearer");
    expect(Object.keys(artifact)).not.toContain("modelQuality");
    expect(Object.keys(artifact)).not.toContain("promotion");
    expect(Object.keys(artifact)).not.toContain("effect");
  });
});

describe("N7/N7-3 — the plan spec generalization did not disturb the N6 plan", () => {
  it("10. the v1 default spec reproduces the committed N6 main artifact", () => {
    expect(CONTEXT_SAFE_V1_PLAN_SPEC.schemaVersion).toBe(CONTEXT_SAFE_PREREGISTRATION_SCHEMA);
    expect(CONTEXT_SAFE_V1_PLAN_SPEC.expectedCases).toBe(24);
    expect(CONTEXT_SAFE_V1_PLAN_SPEC.expectedLogicalRuns).toBe(192);

    const n6Manifest = JSON.parse(
      readFileSync(join(REPO, "docs", "evidence", "agent-next6-20261005", "case-manifest.json"), "utf8"),
    ) as ManifestShape;
    const factory = getArmFactory();
    const rebuilt = buildContextSafePreregistration({
      subject: {
        candidateSourceSha: "8ca36433226d96c52f4480735576ec3c6c15e4bc",
        baselineArmDigest: factory.resolveArm("tool_call_efficiency_v1").digest,
        candidateArmDigest: factory.resolveArm("context_safe_tool_call_efficiency_v1").digest,
        runtimeConfigDigest: factory.resolveArm("context_safe_tool_call_efficiency_v1").digest,
      },
      provider: {
        providerId: "openai",
        modelId: "workbuddy-deepseek-v4.1-flash",
        endpointBaseUrl: "http://127.0.0.1:8317/v1",
        requestProfile: { budgetTokens: 32_000, temperature: null, stallPolicy: "benchmark-default" },
      },
      cases: contextSafeCaseEntriesFromManifest(n6Manifest.cases),
      suite: { id: n6Manifest.suite.id, version: n6Manifest.suite.version, caseRoot: n6Manifest.suite.caseRoot },
      holdoutPolicy:
        "holdout per-case data is never read into an artifact; the holdout experiment uses its own suite and never participates in prompt tuning",
      selectionProvenanceDigest: n6Manifest.manifestDigest,
      evaluation: { scorerDigest: "c".repeat(64), judgeId: "task-verifier", judgeDigest: "d".repeat(64) },
      schedule: { orderSeed: 20_261_005 },
      budget: {
        maxModelCallsPerRun: 30,
        maxToolCalls: 600,
        maxDurationMs: 1_800_000,
        maxInputTokens: 3_000_000,
        maxOutputTokens: 400_000,
        maxTotalTokens: 4_000_000,
        maxUsdMicros: 100_000_000_000,
      },
    });
    const committed = JSON.parse(
      readFileSync(join(REPO, "docs", "evidence", "agent-next6-20261005", "main-preregistration.json"), "utf8"),
    ) as ContextSafePreregistration;
    expect(rebuilt).toEqual(committed);
    const report = dryRunContextSafePreregistration(rebuilt);
    expect(report.ok).toBe(true);
    expect(report.logicalRuns).toBe(192);
  });
});

describe("N7/N7-3 — the independent holdout pre-registration", () => {
  const artifact = buildContextSafeV2Preregistration(holdoutOptions());

  it("11. the holdout keeps its own 24-case corpus → 192 logical arm runs against the RESOLVED champion", () => {
    expect(CONTEXT_SAFE_V2_HOLDOUT_CASES).toBe(24);
    expect(CONTEXT_SAFE_V2_HOLDOUT_LOGICAL_RUNS).toBe(192);
    expect(artifact.role).toBe("holdout");
    expect(artifact.dataset.cases).toHaveLength(24);
    expect(artifact.schedule.logicalRuns).toBe(192);
    expect(artifact.schedule.abCount).toBe(48);
    expect(artifact.schedule.baCount).toBe(48);
    expect(artifact.prompt.candidateId).toBe(CONTEXT_SAFE_V2_CANDIDATE_ID);

    const champion = resolvedChampion();
    expect(artifact.subject.baselineArmDigest).toBe(champion.digest);
    expect(artifact.subject.championProvenance).toEqual(champion.provenance);
    expect(artifact.subject.championProvenance!.source).toContain("docs/evolution/champion-state.json");
    expect(artifact.subject.baselineArmDigest).not.toBe(artifact.subject.candidateArmDigest);

    const report = dryRunContextSafeV2Preregistration(artifact);
    expect(report.ok, report.problems.join("; ")).toBe(true);
    expect(report.logicalRuns).toBe(192);
    expect(report.paidProviderCalls).toBe(0);
    expect(report.promotion).toBe("NOT_RUN");
  });

  it("12. the committed holdout artifact equals a fresh build, and holdout wiring is fail-closed", () => {
    const committed = JSON.parse(readFileSync(HOLDOUT_ARTIFACT_PATH, "utf8")) as ContextSafePreregistration;
    // Re-frozen in the P round (docs/evidence/agent-p-20261006/P-COMPLETION.md):
    // registering a new challenger moves the champion-resolved BASELINE arm
    // snapshot digest (the baseline snapshot lists every registered candidate as
    // OFF), so the plan was re-frozen with the round's own freeze script BEFORE
    // any N7 model result existed. It must reproduce byte-for-byte again, and the
    // frozen arm must still be the champion resolved from the real state file.
    expect(committed).toEqual(artifact);
    expect(committed.subject.baselineArmDigest).toBe(resolvedChampion().digest);
    const frozenReport = dryRunContextSafeV2Preregistration(committed);
    expect(frozenReport.ok, frozenReport.problems.join("; ")).toBe(true);
    expect(frozenReport.logicalRuns).toBe(192);
    expect(frozenReport.paidProviderCalls).toBe(0);
    expect(committed.role).toBe("holdout");
    expect(committed.schemaVersion).toBe(CONTEXT_SAFE_V2_PREREGISTRATION_SCHEMA);

    // A holdout plan without recorded champion provenance is REFUSED.
    const { championProvenance: _omitted, ...subjectWithoutProvenance } = holdoutOptions().subject;
    expect(() =>
      buildContextSafeV2Preregistration({ ...holdoutOptions(), subject: subjectWithoutProvenance }),
    ).toThrow(/CHAMPION_UNRESOLVED/);
    // Main-set cases may never be frozen into the holdout plan.
    expect(() =>
      buildContextSafeV2Preregistration({
        ...holdoutOptions(),
        cases: contextSafeCaseEntriesFromManifest(manifest.cases),
      }),
    ).toThrow(/HOLDOUT_ROLE_MISMATCH|WRONG_CASE_COUNT/);
    // A champion change invalidates the plan (new arm digest + provenance).
    const reChampioned = buildContextSafeV2Preregistration({
      ...holdoutOptions(),
      subject: {
        ...holdoutOptions().subject,
        baselineArmDigest: "e".repeat(64),
        championProvenance: { ...resolvedChampion().provenance, stateDigest: "f".repeat(64) },
      },
    });
    expect(reChampioned.preregistrationDigest).not.toBe(artifact.preregistrationDigest);
  });

  it("13. main and holdout identities are independent of each other", () => {
    const main = buildContextSafeV2Preregistration(frozenOptions());
    expect(artifact.preregistrationDigest).not.toBe(main.preregistrationDigest);
    expect(artifact.dataset.caseSetDigest).not.toBe(main.dataset.caseSetDigest);
    expect(artifact.dataset.selectionProvenanceDigest).not.toBe(main.dataset.selectionProvenanceDigest);
    expect(artifact.schedule.planDigest).not.toBe(main.schedule.planDigest);
    expect(CONTEXT_SAFE_V2_MAIN_PLAN_SPEC.expectedLogicalRuns).toBe(512);
    expect(CONTEXT_SAFE_V2_HOLDOUT_PLAN_SPEC.expectedLogicalRuns).toBe(192);
    expect(CONTEXT_SAFE_V2_MAIN_PLAN_SPEC.candidateGuidanceDigest).toBe(
      CONTEXT_SAFE_V2_HOLDOUT_PLAN_SPEC.candidateGuidanceDigest,
    );
  });
});
