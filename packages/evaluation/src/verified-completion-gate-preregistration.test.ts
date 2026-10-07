/**
 * P 轮 — the pre-registration contract for `verified_completion_gate_v1`.
 *
 * Proven here, all OFFLINE and BEFORE any model result:
 *   - the MAIN plan is exactly 64 cases × 4 repetitions × 2 arms = 512 logical ARM
 *     RUNS, AB/BA balanced at 128/128, and the dry run reports that with ZERO
 *     provider calls;
 *   - the INDEPENDENT HOLDOUT keeps the frozen 24-case corpus (192 runs) and its
 *     comparison arm is the champion RESOLVED from the real state file;
 *   - the corpus really IS the frozen N7 corpus (its manifest digests are asserted
 *     literally), which is what makes "the text was written after the corpus" true
 *     rather than merely claimed;
 *   - the root identity is a real function of every tunable input;
 *   - the gates are the N6/N7 gates VALUE FOR VALUE;
 *   - the fail-closed refusals hold (wrong case count, holdout leak, identical
 *     arms, a candidate arm that is not the real gate arm, a non-40-hex source);
 *   - the committed artifacts equal fresh builds, and the P plan does not disturb
 *     the committed N6 or N7 artifacts;
 *   - no artifact claims a model-quality or promotion result.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_SAFE_GATES,
  CONTEXT_SAFE_V1_PLAN_SPEC,
  buildContextSafePreregistration,
  computeContextSafePreregistrationDigest,
  contextSafeCaseEntriesFromManifest,
  dryRunContextSafePreregistration,
  type ContextSafePreregistration,
  type ContextSafePreregistrationOptions,
} from "./context-safe-tool-call-efficiency-preregistration.js";
import { CONTEXT_SAFE_V2_MAIN_PLAN_SPEC, dryRunContextSafeV2Preregistration } from "./context-safe-tool-call-efficiency-v2-preregistration.js";
import { VERIFIED_COMPLETION_GATE_CANDIDATE_ID } from "./candidate-registry.js";
import {
  buildVerifiedCompletionGatePreregistration,
  dryRunVerifiedCompletionGatePreregistration,
  VERIFIED_COMPLETION_GATE_GATES,
  VERIFIED_COMPLETION_GATE_HOLDOUT_CASES,
  VERIFIED_COMPLETION_GATE_HOLDOUT_LOGICAL_RUNS,
  VERIFIED_COMPLETION_GATE_HOLDOUT_PLAN_SPEC,
  VERIFIED_COMPLETION_GATE_LOGICAL_RUNS_PER_EXPERIMENT,
  VERIFIED_COMPLETION_GATE_MAIN_CASES,
  VERIFIED_COMPLETION_GATE_MAIN_PLAN_SPEC,
  VERIFIED_COMPLETION_GATE_PREREGISTRATION_SCHEMA,
  VERIFIED_COMPLETION_GATE_REPETITIONS,
} from "./verified-completion-gate-preregistration.js";
import { getArmFactory } from "./arm-factory.js";
import { stableStringify } from "./manifest.js";
import {
  contextSafeToolCallEfficiencyGuidanceDigest,
  contextSafeToolCallEfficiencyV2GuidanceDigest,
  toolCallEfficiencyGuidanceDigest,
  VERIFIED_COMPLETION_GATE_GUIDANCE_V1,
  verifiedCompletionGateGuidanceDigest,
} from "./mechanism-guidance.js";

const REPO = resolve(import.meta.dirname, "../../..");
const N7_EVIDENCE = join(REPO, "docs", "evidence", "agent-next7-20261006");
const EVIDENCE_DIR = join(REPO, "docs", "evidence", "agent-p-20261006");
const ARTIFACT_PATH = join(EVIDENCE_DIR, "main-preregistration.json");
const HOLDOUT_ARTIFACT_PATH = join(EVIDENCE_DIR, "holdout-preregistration.json");
const CHAMPION_STATE_PATH = join(REPO, "docs", "evolution", "champion-state.json");

/** The P bound source: the freeze-time commit of this repository. */
const P_SOURCE_SHA = "e6fc818c4c6ccf026c63dc73af25d99f462f93f3";

/** The frozen N7 corpus identities — asserted literally (no re-authored corpus). */
const N7_MAIN_MANIFEST_DIGEST = "03a77f3f060e9040ed9ae61bdff8d7e849e646881aa6922f9c52b3c9bcd08fa1";
const N7_HOLDOUT_MANIFEST_DIGEST = "7e8e42fd8f21324342f073bb339763864f9767e01d52972822bb343fe48b2a28";

/** Frozen digests of the earlier rounds: the P plan must not move them. */
const N6_PREREG_DIGEST = "ab9120df8e1436f3a9f497bb9651ea5fe738870824e2dc647242f08ed481cc96";
const N7_PREREG_DIGEST = "d824d5938e45bf5962b476e76fbfc0ce7f4264475d1c8d9d8afd6907f1330b2c";

interface ManifestShape {
  suite: { id: string; version: string; caseRoot: string };
  manifestDigest: string;
  cases: { caseId: string; suite: string; condition: string; contentDigest: string; verifierDigest: string }[];
}

const manifest = JSON.parse(readFileSync(join(N7_EVIDENCE, "case-manifest.json"), "utf8")) as ManifestShape;
const holdoutManifest = JSON.parse(
  readFileSync(join(N7_EVIDENCE, "holdout-case-manifest.json"), "utf8"),
) as ManifestShape;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function frozenOptions(over: Partial<ContextSafePreregistrationOptions> = {}): ContextSafePreregistrationOptions {
  const factory = getArmFactory();
  return {
    subject: {
      candidateSourceSha: P_SOURCE_SHA,
      baselineArmDigest: factory.resolveArm("tool_call_efficiency_v1").digest,
      candidateArmDigest: factory.resolveArm(VERIFIED_COMPLETION_GATE_CANDIDATE_ID).digest,
      runtimeConfigDigest: factory.resolveArm(VERIFIED_COMPLETION_GATE_CANDIDATE_ID).digest,
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
    schedule: { orderSeed: 20_261_009 },
    budget: {
      maxModelCallsPerRun: 30,
      maxToolCalls: 600,
      maxDurationMs: 1_800_000,
      maxInputTokens: 3_000_000,
      maxOutputTokens: 400_000,
      maxTotalTokens: 4_000_000,
      maxUsdMicros: 100_000_000_000,
    },
    ...over,
  };
}

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

function holdoutOptions(): ContextSafePreregistrationOptions {
  const champion = resolvedChampion();
  const factory = getArmFactory();
  return {
    role: "holdout",
    subject: {
      candidateSourceSha: P_SOURCE_SHA,
      baselineArmDigest: champion.digest,
      candidateArmDigest: factory.resolveArm(VERIFIED_COMPLETION_GATE_CANDIDATE_ID).digest,
      runtimeConfigDigest: factory.resolveArm(VERIFIED_COMPLETION_GATE_CANDIDATE_ID).digest,
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
    schedule: { orderSeed: 20_261_010 },
    budget: {
      maxModelCallsPerRun: 30,
      maxToolCalls: 600,
      maxDurationMs: 1_800_000,
      maxInputTokens: 3_000_000,
      maxOutputTokens: 400_000,
      maxTotalTokens: 4_000_000,
      maxUsdMicros: 100_000_000_000,
    },
  };
}

describe("P — verified_completion_gate_v1 pre-registration (main)", () => {
  const artifact = buildVerifiedCompletionGatePreregistration(frozenOptions());

  it("1. the frozen schedule is exactly 64 × 4 × 2 = 512 logical arm runs, AB/BA balanced", () => {
    expect(VERIFIED_COMPLETION_GATE_MAIN_CASES).toBe(64);
    expect(VERIFIED_COMPLETION_GATE_REPETITIONS).toBe(4);
    expect(VERIFIED_COMPLETION_GATE_LOGICAL_RUNS_PER_EXPERIMENT).toBe(512);
    expect(artifact.dataset.cases).toHaveLength(64);
    expect(artifact.schedule.logicalRuns).toBe(512);
    expect(artifact.schedule.abCount).toBe(128);
    expect(artifact.schedule.baCount).toBe(128);
    expect(artifact.schedule.balanced).toBe(true);
  });

  it("2. the dry run reports 512 logical arm runs and ZERO provider calls", () => {
    const report = dryRunVerifiedCompletionGatePreregistration(artifact);
    expect(report.ok, report.problems.join("; ")).toBe(true);
    expect(report.logicalRuns).toBe(512);
    expect(report.cases).toBe(64);
    expect(report.providerCalls).toBe(0);
    expect(report.paidProviderCalls).toBe(0);
    expect(report.modelQuality).toBe("NOT_RUN");
    expect(report.promotion).toBe("NOT_RUN");
    expect(report.campaignWorstCaseModelCalls).toBe(30 * 512);
  });

  it("3. the committed artifact equals a fresh build and the schema is its own", () => {
    const committed = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as ContextSafePreregistration;
    expect(committed).toEqual(artifact);
    expect(committed.preregistrationDigest).toBe(computeContextSafePreregistrationDigest(artifact));
    expect(committed.schemaVersion).toBe(VERIFIED_COMPLETION_GATE_PREREGISTRATION_SCHEMA);
    // Its identity is its own: it can never be read as the N6 or N7 plan.
    expect(committed.preregistrationDigest).not.toBe(N6_PREREG_DIGEST);
    expect(committed.preregistrationDigest).not.toBe(N7_PREREG_DIGEST);
  });

  it("4. the plan binds the gate TEXT, the resolved gate arm, and the frozen N7 corpus", () => {
    expect(artifact.prompt.candidateId).toBe(VERIFIED_COMPLETION_GATE_CANDIDATE_ID);
    expect(artifact.prompt.guidanceDigest).toBe(verifiedCompletionGateGuidanceDigest());
    expect(artifact.prompt.guidanceDigest).toBe(sha256(VERIFIED_COMPLETION_GATE_GUIDANCE_V1));
    expect(artifact.prompt.comparisonCandidateId).toBe("tool_call_efficiency_v1");
    expect(artifact.prompt.comparisonGuidanceDigest).toBe(toolCallEfficiencyGuidanceDigest());
    // The comparison text is the production guidance, and NOT the gate's own text.
    expect(artifact.prompt.guidanceDigest).not.toBe(artifact.prompt.comparisonGuidanceDigest);

    const arm = getArmFactory().resolveArm(VERIFIED_COMPLETION_GATE_CANDIDATE_ID);
    expect(arm.promptAdditionsDigest).toBe(verifiedCompletionGateGuidanceDigest());
    expect(artifact.subject.candidateArmDigest).toBe(arm.digest);
    expect(artifact.subject.baselineArmDigest).not.toBe(artifact.subject.candidateArmDigest);

    // The corpus really is the frozen N7 corpus (same manifests, same cases).
    expect(artifact.dataset.selectionProvenanceDigest).toBe(N7_MAIN_MANIFEST_DIGEST);
    expect(artifact.dataset.suiteId).toBe("n7-evidence");
    expect(artifact.dataset.cases.map((c) => c.caseId)).toEqual(manifest.cases.map((c) => c.caseId));
    // The case-set digest is a deterministic function of the frozen corpus.
    expect(artifact.dataset.caseSetDigest).toBe(
      buildVerifiedCompletionGatePreregistration(frozenOptions()).dataset.caseSetDigest,
    );
    expect(artifact.dataset.caseSetDigest).not.toBe(
      buildVerifiedCompletionGatePreregistration(holdoutOptions()).dataset.caseSetDigest,
    );
  });

  it("5. the identity changes when ANY tunable input changes", () => {
    const base = artifact.preregistrationDigest;
    const variants: [string, ContextSafePreregistration][] = [
      ["order seed", buildVerifiedCompletionGatePreregistration(frozenOptions({ schedule: { orderSeed: 20_261_011 } }))],
      [
        "budget ceiling",
        buildVerifiedCompletionGatePreregistration(
          frozenOptions({ budget: { ...frozenOptions().budget, maxUsdMicros: 99_000_000_000 } }),
        ),
      ],
      [
        "request profile",
        buildVerifiedCompletionGatePreregistration(
          frozenOptions({ provider: { ...frozenOptions().provider, requestProfile: { budgetTokens: 64_000 } } }),
        ),
      ],
      [
        "model id",
        buildVerifiedCompletionGatePreregistration(
          frozenOptions({ provider: { ...frozenOptions().provider, modelId: "workbuddy-deepseek-v4.1" } }),
        ),
      ],
      [
        "source sha",
        buildVerifiedCompletionGatePreregistration(
          frozenOptions({ subject: { ...frozenOptions().subject, candidateSourceSha: "b".repeat(40) } }),
        ),
      ],
      [
        "case content",
        buildVerifiedCompletionGatePreregistration(
          frozenOptions({
            cases: contextSafeCaseEntriesFromManifest(manifest.cases).map((c, i) =>
              i === 0 ? { ...c, contentDigest: "0".repeat(64) } : c,
            ),
          }),
        ),
      ],
      [
        "selection provenance",
        buildVerifiedCompletionGatePreregistration(frozenOptions({ selectionProvenanceDigest: "a".repeat(64) })),
      ],
      [
        "runtime config digest",
        buildVerifiedCompletionGatePreregistration(
          frozenOptions({ subject: { ...frozenOptions().subject, runtimeConfigDigest: "9".repeat(64) } }),
        ),
      ],
      [
        "gates",
        buildContextSafePreregistration({
          ...frozenOptions(),
          planSpec: {
            ...VERIFIED_COMPLETION_GATE_MAIN_PLAN_SPEC,
            gates: { ...VERIFIED_COMPLETION_GATE_GATES, missingGroupVerifiedPassRateLiftPp: 4 },
          },
        }),
      ],
    ];
    for (const [label, variant] of variants) {
      expect(variant.preregistrationDigest, `${label} did not change the identity`).not.toBe(base);
    }
    expect(buildVerifiedCompletionGatePreregistration(frozenOptions()).preregistrationDigest).toBe(base);
  });

  it("6. the gates are the N6/N7 gates VALUE FOR VALUE — nothing loosened", () => {
    expect(VERIFIED_COMPLETION_GATE_GATES).toEqual(CONTEXT_SAFE_GATES);
    expect(artifact.evaluation.gates).toEqual(CONTEXT_SAFE_GATES);
    expect(artifact.evaluation.gatesDigest).toBe(sha256(stableStringify(CONTEXT_SAFE_GATES)));
    expect(VERIFIED_COMPLETION_GATE_GATES.missingGroupVerifiedPassRateLiftPp).toBe(5);
    expect(VERIFIED_COMPLETION_GATE_GATES.newSecurityViolationsMax).toBe(0);
    expect(VERIFIED_COMPLETION_GATE_GATES.newFalseCompleteMax).toBe(0);
    expect(VERIFIED_COMPLETION_GATE_GATES.totalTokensMaxRatioOfBaseline).toBe(1.1);
    expect(VERIFIED_COMPLETION_GATE_GATES.usageUnknownIsNotZero).toBe(true);
  });

  it("7. fail-closed: wrong case counts, bad SHAs, identical arms and a fake candidate arm are refused", () => {
    const cases = contextSafeCaseEntriesFromManifest(manifest.cases);
    expect(() => buildVerifiedCompletionGatePreregistration(frozenOptions({ cases: cases.slice(0, 63) }))).toThrow(
      /WRONG_CASE_COUNT/,
    );
    expect(() =>
      buildVerifiedCompletionGatePreregistration(
        frozenOptions({ cases: [...cases, { ...cases[0]!, caseId: "p-extra" }] }),
      ),
    ).toThrow(/WRONG_CASE_COUNT/);
    expect(() =>
      buildVerifiedCompletionGatePreregistration(
        frozenOptions({ subject: { ...frozenOptions().subject, candidateSourceSha: "deadbeef" } }),
      ),
    ).toThrow(/INVALID_FIELD/);
    expect(() =>
      buildVerifiedCompletionGatePreregistration(
        frozenOptions({
          subject: {
            ...frozenOptions().subject,
            baselineArmDigest: getArmFactory().resolveArm(VERIFIED_COMPLETION_GATE_CANDIDATE_ID).digest,
          },
        }),
      ),
    ).toThrow(/ARMS_IDENTICAL/);
    expect(() =>
      buildVerifiedCompletionGatePreregistration(
        frozenOptions({ subject: { ...frozenOptions().subject, candidateArmDigest: "7".repeat(64) } }),
      ),
    ).toThrow(/CANDIDATE_ARM_NOT_RESOLVED/);
    // Holdout cases may never be frozen into the main plan.
    expect(() =>
      buildVerifiedCompletionGatePreregistration({
        ...frozenOptions(),
        cases: contextSafeCaseEntriesFromManifest(holdoutManifest.cases),
      }),
    ).toThrow(/HOLDOUT_LEAK|WRONG_CASE_COUNT/);
  });

  it("8. a plan frozen for another candidate/schema is refused by the dry run", () => {
    const asN6 = dryRunContextSafePreregistration(artifact, CONTEXT_SAFE_V1_PLAN_SPEC);
    expect(asN6.ok).toBe(false);
    expect(asN6.problems.join("\n")).toMatch(/schemaVersion|candidateId|guidance digest/);
    const asN7 = dryRunContextSafePreregistration(artifact, CONTEXT_SAFE_V2_MAIN_PLAN_SPEC);
    expect(asN7.ok).toBe(false);
    expect(asN7.problems.join("\n")).toMatch(/schemaVersion|candidateId|guidance digest/);
    const asHoldout = dryRunContextSafePreregistration(artifact, VERIFIED_COMPLETION_GATE_HOLDOUT_PLAN_SPEC);
    expect(asHoldout.ok).toBe(false);
    expect(asHoldout.problems.join("\n")).toMatch(/cases 64 !== 24|logicalRuns 512 !== 192/);
  });

  it("9. the artifact carries no raw endpoint or credential, and no model-result claim", () => {
    const text = JSON.stringify(artifact);
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    expect(text).not.toContain("http");
    expect(text.toLowerCase()).not.toContain("apikey");
    expect(text.toLowerCase()).not.toContain("api_key");
    expect(text.toLowerCase()).not.toContain("authorization");
    expect(Object.keys(artifact)).not.toContain("modelQuality");
    expect(Object.keys(artifact)).not.toContain("promotion");
    expect(Object.keys(artifact)).not.toContain("effect");
  });
});

describe("P — the independent holdout pre-registration", () => {
  const artifact = buildVerifiedCompletionGatePreregistration(holdoutOptions());

  it("10. the holdout keeps the frozen 24-case corpus → 192 runs against the RESOLVED champion", () => {
    expect(VERIFIED_COMPLETION_GATE_HOLDOUT_CASES).toBe(24);
    expect(VERIFIED_COMPLETION_GATE_HOLDOUT_LOGICAL_RUNS).toBe(192);
    expect(artifact.role).toBe("holdout");
    expect(artifact.dataset.cases).toHaveLength(24);
    expect(artifact.dataset.selectionProvenanceDigest).toBe(N7_HOLDOUT_MANIFEST_DIGEST);
    expect(artifact.dataset.suiteId).toBe("n7-holdout");
    expect(artifact.schedule.logicalRuns).toBe(192);
    expect(artifact.schedule.abCount).toBe(48);
    expect(artifact.schedule.baCount).toBe(48);
    expect(artifact.prompt.candidateId).toBe(VERIFIED_COMPLETION_GATE_CANDIDATE_ID);

    const champion = resolvedChampion();
    expect(artifact.subject.baselineArmDigest).toBe(champion.digest);
    expect(artifact.subject.championProvenance).toEqual(champion.provenance);

    const report = dryRunVerifiedCompletionGatePreregistration(artifact);
    expect(report.ok, report.problems.join("; ")).toBe(true);
    expect(report.logicalRuns).toBe(192);
    expect(report.paidProviderCalls).toBe(0);
    expect(report.promotion).toBe("NOT_RUN");
  });

  it("11. the committed holdout artifact equals a fresh build, and holdout wiring is fail-closed", () => {
    const committed = JSON.parse(readFileSync(HOLDOUT_ARTIFACT_PATH, "utf8")) as ContextSafePreregistration;
    expect(committed).toEqual(artifact);
    expect(committed.role).toBe("holdout");
    // The committed baseline arm is the CURRENT registry snapshot; registering a
    // future candidate moves it and requires a re-freeze (documented interaction).
    expect(committed.subject.baselineArmDigest).toBe(resolvedChampion().digest);

    const { championProvenance: _omitted, ...subjectWithoutProvenance } = holdoutOptions().subject;
    expect(() =>
      buildVerifiedCompletionGatePreregistration({ ...holdoutOptions(), subject: subjectWithoutProvenance }),
    ).toThrow(/CHAMPION_UNRESOLVED/);
    expect(() =>
      buildVerifiedCompletionGatePreregistration({
        ...holdoutOptions(),
        cases: contextSafeCaseEntriesFromManifest(manifest.cases),
      }),
    ).toThrow(/HOLDOUT_ROLE_MISMATCH|WRONG_CASE_COUNT/);
    const reChampioned = buildVerifiedCompletionGatePreregistration({
      ...holdoutOptions(),
      subject: {
        ...holdoutOptions().subject,
        baselineArmDigest: "e".repeat(64),
        championProvenance: { ...resolvedChampion().provenance, stateDigest: "f".repeat(64) },
      },
    });
    expect(reChampioned.preregistrationDigest).not.toBe(artifact.preregistrationDigest);
  });

  it("12. main and holdout identities are independent, and the P plan does not disturb N6/N7", () => {
    const main = buildVerifiedCompletionGatePreregistration(frozenOptions());
    expect(artifact.preregistrationDigest).not.toBe(main.preregistrationDigest);
    expect(artifact.dataset.caseSetDigest).not.toBe(main.dataset.caseSetDigest);
    expect(artifact.dataset.selectionProvenanceDigest).not.toBe(main.dataset.selectionProvenanceDigest);
    expect(artifact.schedule.planDigest).not.toBe(main.schedule.planDigest);
    expect(VERIFIED_COMPLETION_GATE_MAIN_PLAN_SPEC.expectedLogicalRuns).toBe(512);
    expect(VERIFIED_COMPLETION_GATE_HOLDOUT_PLAN_SPEC.expectedLogicalRuns).toBe(192);

    // The N7 artifacts still reproduce byte-for-byte: the shared builder is
    // default-preserving and the P spec is opt-in only.
    const n7 = JSON.parse(readFileSync(join(N7_EVIDENCE, "main-preregistration.json"), "utf8")) as ContextSafePreregistration;
    expect(n7.preregistrationDigest).toBe(N7_PREREG_DIGEST);
    expect(dryRunContextSafeV2Preregistration(n7).ok).toBe(true);
    // …and the earlier candidates' text digests are untouched.
    expect(contextSafeToolCallEfficiencyGuidanceDigest()).toBe(
      "ce66f3b091752fdb38774914d2d3e5f736c0684930d5162f25ecdb5bed2d56c2",
    );
    expect(contextSafeToolCallEfficiencyV2GuidanceDigest()).toBe(
      "52a80e9c30904b7e3b31d5e7506c9e48300b1ebf4220278c14bd42974809333c",
    );
  });
});
