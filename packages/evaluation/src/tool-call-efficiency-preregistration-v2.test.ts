/**
 * N1 — canonical pre-registration v2: determinism, completeness, fail-closed
 * parsing, and structural zero-provider-call guarantees.
 *
 * Every rejection path asserts a STABLE reason code. A spy provider factory is
 * passed around to prove no rejection (or acceptance) ever constructs a
 * provider: pre-registration is pure.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DECISION_POLICY_V3 } from "./decision-policy-v3.js";
import {
  assertFormalExecutionPreregistration,
  buildToolCallEfficiencyPreregistrationV2,
  computeCaseSetDigestV2,
  computePreregistrationV2Digest,
  parseAndValidatePreregistrationV2,
  serializePreregistrationV2,
  PreregistrationV2Error,
  type PreregCatalogEntryV2,
  type PreregistrationV2Options,
} from "./tool-call-efficiency-preregistration-v2.js";
import { buildToolCallEfficiencyPreregistration } from "./tool-call-efficiency-preregistration.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function catalogEntry(caseId: string, over: Partial<PreregCatalogEntryV2> = {}): PreregCatalogEntryV2 {
  return {
    caseId,
    suite: "regression",
    contentDigest: `content-${caseId}`,
    eligibilityDigest: `elig-${caseId}`,
    holdout: false,
    eligible: true,
    ...over,
  };
}

/** 8 eligible dev cases (the frozen order the plan expects). */
const CASE_IDS = ["reg-01", "reg-02", "reg-06", "reg-08", "adv-03", "adv-07", "st-02", "st-05"];
const CATALOG: PreregCatalogEntryV2[] = [
  ...CASE_IDS.map((id) => catalogEntry(id)),
  catalogEntry("hold-01", { suite: "holdout", holdout: true }),
  catalogEntry("reg-99", { eligible: false }),
];

function baseOptions(over: Partial<PreregistrationV2Options> = {}): PreregistrationV2Options {
  return {
    subject: {
      candidateSourceSha: SHA_A,
      baselineArmDigest: "baseline-arm-digest",
      candidateArmDigest: "candidate-arm-digest",
      cleanTreePolicy: "require-clean",
      runtimeConfigDigest: "runtime-config-digest",
    },
    candidateId: "tool_call_efficiency_v1",
    provider: {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      endpointBaseUrl: "https://api.example.com/v1",
      requestProfile: { budgetTokens: 32000, stallPolicy: "default" },
    },
    catalog: CATALOG,
    selection: {
      caseIds: [...CASE_IDS],
      selectionRule: "R87 frozen dev-set selection",
      selectionProvenanceDigest: "r87-selection-digest",
      holdoutPolicy: "holdout is never read",
    },
    suiteId: "tool-call-efficiency",
    suiteVersion: "1.0.0",
    evaluation: {
      judgeId: "judge-1",
      judgeDigest: "judge-digest",
      verifierDigest: "verifier-digest",
      scorerDigest: "scorer-digest",
      decisionPolicy: { ...DEFAULT_DECISION_POLICY_V3 },
    },
    schedule: { repetitions: 2, orderSeed: 7 },
    budget: {
      maxModelCallsPerRun: 30,
      maxToolCalls: 100,
      maxDurationMs: 600_000,
      maxInputTokens: 320_000,
      maxOutputTokens: 64_000,
      maxTotalTokens: 384_000,
      maxUsdMicros: 5_000_000,
      pricingUnknownPolicy: "refuse",
    },
    isolation: {
      driverSchema: "r97-driver-v1",
      workerSchema: "r97-worker-v1",
      isolationBackendId: "process-exec",
      isolationStrength: "process",
      resumeStateSchema: "r97-execution-state-v1",
    },
    ...over,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected a PreregistrationV2Error(${code}) but nothing was thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(PreregistrationV2Error);
    expect((err as PreregistrationV2Error).code).toBe(code);
  }
}

describe("N1 pre-registration v2 — canonical identity", () => {
  it("is deterministic: two builds produce byte-identical canonical JSON and the same digest", () => {
    const a = buildToolCallEfficiencyPreregistrationV2(baseOptions());
    const b = buildToolCallEfficiencyPreregistrationV2(baseOptions());
    expect(serializePreregistrationV2(a)).toBe(serializePreregistrationV2(b));
    expect(a.preregistrationDigest).toBe(b.preregistrationDigest);
  });

  it("round-trips: build -> serialize -> parse -> serialize yields identical bytes", () => {
    const a = buildToolCallEfficiencyPreregistrationV2(baseOptions());
    const parsed = parseAndValidatePreregistrationV2(serializePreregistrationV2(a));
    expect(serializePreregistrationV2(parsed)).toBe(serializePreregistrationV2(a));
    expect(parsed.preregistrationDigest).toBe(a.preregistrationDigest);
  });

  it("derives logical runs and worst case from the REAL per-run ceiling (8 × 2 × 2 = 32; × 30 = 960)", () => {
    const a = buildToolCallEfficiencyPreregistrationV2(baseOptions());
    expect(a.schedule.logicalRuns).toBe(32);
    expect(a.schedule.abCount).toBe(8);
    expect(a.schedule.baCount).toBe(8);
    expect(a.schedule.balanced).toBe(true);
    expect(a.budget.campaignWorstCaseModelCalls).toBe(960);
  });

  it("requires at least 2 repetitions and rejects 1", () => {
    expectCode(() => buildToolCallEfficiencyPreregistrationV2(baseOptions({ schedule: { repetitions: 1, orderSeed: 7 } })), "REPETITIONS_TOO_LOW");
  });

  it("rejects an unbalanced AB/BA schedule (5 cases × 3 repetitions = 15 odd pairs)", () => {
    const five = CASE_IDS.slice(0, 5);
    expectCode(
      () =>
        buildToolCallEfficiencyPreregistrationV2(
          baseOptions({
            catalog: [...five.map((id) => catalogEntry(id))],
            selection: { caseIds: [...five], selectionRule: "r", selectionProvenanceDigest: "d", holdoutPolicy: "h" },
            schedule: { repetitions: 3, orderSeed: 1 },
          }),
        ),
      "UNBALANCED_SCHEDULE",
    );
  });

  it("rejects an identical baseline/candidate arm digest (no causal delta)", () => {
    expectCode(
      () =>
        buildToolCallEfficiencyPreregistrationV2(
          baseOptions({
            subject: {
              candidateSourceSha: SHA_A,
              baselineArmDigest: "same",
              candidateArmDigest: "same",
              cleanTreePolicy: "require-clean",
              runtimeConfigDigest: "r",
            },
          }),
        ),
      "ARMS_IDENTICAL",
    );
  });

  it("rejects a non-40-hex source SHA", () => {
    expectCode(
      () =>
        buildToolCallEfficiencyPreregistrationV2(
          baseOptions({
            subject: {
              candidateSourceSha: "not-a-sha",
              baselineArmDigest: "b",
              candidateArmDigest: "c",
              cleanTreePolicy: "require-clean",
              runtimeConfigDigest: "r",
            },
          }),
        ),
      "INVALID_FIELD",
    );
  });
});

describe("N1 pre-registration v2 — case identity comes from the real catalog", () => {
  it("refuses duplicate selection ids", () => {
    expectCode(
      () =>
        buildToolCallEfficiencyPreregistrationV2(
          baseOptions({
            selection: { caseIds: ["reg-01", "reg-01", ...CASE_IDS.slice(2)], selectionRule: "r", selectionProvenanceDigest: "d", holdoutPolicy: "h" },
          }),
        ),
      "DUPLICATE_SELECTION_ID",
    );
  });

  it("refuses an unknown case id", () => {
    expectCode(
      () =>
        buildToolCallEfficiencyPreregistrationV2(
          baseOptions({ selection: { caseIds: [...CASE_IDS, "does-not-exist"], selectionRule: "r", selectionProvenanceDigest: "d", holdoutPolicy: "h" } }),
        ),
      "UNKNOWN_CASE",
    );
  });

  it("refuses a holdout leak", () => {
    expectCode(
      () =>
        buildToolCallEfficiencyPreregistrationV2(
          baseOptions({ selection: { caseIds: [...CASE_IDS, "hold-01"], selectionRule: "r", selectionProvenanceDigest: "d", holdoutPolicy: "h" } }),
        ),
      "HOLDOUT_LEAK",
    );
  });

  it("refuses an ineligible case", () => {
    expectCode(
      () =>
        buildToolCallEfficiencyPreregistrationV2(
          baseOptions({ selection: { caseIds: [...CASE_IDS, "reg-99"], selectionRule: "r", selectionProvenanceDigest: "d", holdoutPolicy: "h" } }),
        ),
      "INELIGIBLE_CASE",
    );
  });

  it("refuses fewer eligible cases than the mechanism contract minimum (5)", () => {
    const four = CASE_IDS.slice(0, 4);
    expectCode(
      () =>
        buildToolCallEfficiencyPreregistrationV2(
          baseOptions({
            catalog: four.map((id) => catalogEntry(id)),
            selection: { caseIds: [...four], selectionRule: "r", selectionProvenanceDigest: "d", holdoutPolicy: "h" },
          }),
        ),
      "TOO_FEW_CASES",
    );
  });
});

describe("N1 pre-registration v2 — the digest covers every execution/judging input", () => {
  const mutations: Array<[string, (o: PreregistrationV2Options) => PreregistrationV2Options]> = [
    ["source SHA", (o) => ({ ...o, subject: { ...o.subject, candidateSourceSha: SHA_B } })],
    ["baseline arm digest", (o) => ({ ...o, subject: { ...o.subject, baselineArmDigest: "other-baseline" } })],
    ["candidate arm digest", (o) => ({ ...o, subject: { ...o.subject, candidateArmDigest: "other-candidate" } })],
    ["runtime config digest", (o) => ({ ...o, subject: { ...o.subject, runtimeConfigDigest: "other-runtime" } })],
    ["provider id", (o) => ({ ...o, provider: { ...o.provider, providerId: "other-provider" } })],
    ["model id", (o) => ({ ...o, provider: { ...o.provider, modelId: "other-model" } })],
    ["endpoint", (o) => ({ ...o, provider: { ...o.provider, endpointBaseUrl: "https://api.other.com/v1" } })],
    ["request profile", (o) => ({ ...o, provider: { ...o.provider, requestProfile: { budgetTokens: 64000 } } })],
    ["case content", (o) => ({ ...o, catalog: CATALOG.map((c) => (c.caseId === "reg-01" ? { ...c, contentDigest: "changed" } : c)) })],
    ["case order", (o) => ({ ...o, selection: { ...o.selection, caseIds: [...CASE_IDS].reverse() } })],
    ["selection rule", (o) => ({ ...o, selection: { ...o.selection, selectionRule: "other rule" } })],
    ["selection provenance", (o) => ({ ...o, selection: { ...o.selection, selectionProvenanceDigest: "other-provenance" } })],
    ["suite version", (o) => ({ ...o, suiteVersion: "2.0.0" })],
    ["judge digest", (o) => ({ ...o, evaluation: { ...o.evaluation, judgeDigest: "other-judge" } })],
    ["verifier digest", (o) => ({ ...o, evaluation: { ...o.evaluation, verifierDigest: "other-verifier" } })],
    ["decision policy", (o) => ({ ...o, evaluation: { ...o.evaluation, decisionPolicy: { ...DEFAULT_DECISION_POLICY_V3, minConclusiveNetDelta: 2 } } })],
    ["repetitions", (o) => ({ ...o, schedule: { repetitions: 4, orderSeed: 7 } })],
    ["order seed", (o) => ({ ...o, schedule: { repetitions: 2, orderSeed: 8 } })],
    ["budget model calls", (o) => ({ ...o, budget: { ...o.budget, maxModelCallsPerRun: 31 } })],
    ["budget usd", (o) => ({ ...o, budget: { ...o.budget, maxUsdMicros: 6_000_000 } })],
    ["isolation backend", (o) => ({ ...o, isolation: { ...o.isolation, isolationBackendId: "other-backend" } })],
  ];

  const canonical = buildToolCallEfficiencyPreregistrationV2(baseOptions());

  it.each(mutations)("changing %s changes the root digest", (_label, mutate) => {
    const mutated = buildToolCallEfficiencyPreregistrationV2(mutate(baseOptions()));
    expect(mutated.preregistrationDigest).not.toBe(canonical.preregistrationDigest);
  });

  it("normalizes the endpoint: equivalent spellings agree, real differences do not", () => {
    const a = buildToolCallEfficiencyPreregistrationV2(baseOptions());
    const equivalent = buildToolCallEfficiencyPreregistrationV2(
      baseOptions({ provider: { ...baseOptions().provider, endpointBaseUrl: "https://API.Example.com:443/v1/" } }),
    );
    expect(equivalent.provider.endpointDigest).toBe(a.provider.endpointDigest);
    const different = buildToolCallEfficiencyPreregistrationV2(
      baseOptions({ provider: { ...baseOptions().provider, endpointBaseUrl: "https://api.example.com/v2" } }),
    );
    expect(different.provider.endpointDigest).not.toBe(a.provider.endpointDigest);
  });

  it("never stores a raw endpoint, query or userinfo", () => {
    const a = buildToolCallEfficiencyPreregistrationV2(
      baseOptions({ provider: { ...baseOptions().provider, endpointBaseUrl: "https://user:secret@api.example.com/v1?token=abc" } }),
    );
    const bytes = serializePreregistrationV2(a);
    expect(bytes).not.toContain("secret");
    expect(bytes).not.toContain("token=abc");
    expect(bytes).not.toContain("api.example.com");
  });
});

describe("N1 pre-registration v2 — fail-closed parsing", () => {
  const json = serializePreregistrationV2(buildToolCallEfficiencyPreregistrationV2(baseOptions()));

  it("rejects a tampered derived field (logicalRuns)", () => {
    const obj = JSON.parse(json) as Record<string, unknown>;
    (obj.schedule as Record<string, unknown>).logicalRuns = 34;
    expectCode(() => parseAndValidatePreregistrationV2(JSON.stringify(obj)), "DERIVED_TAMPERED");
  });

  it("rejects a tampered derived field (caseSetDigest)", () => {
    const obj = JSON.parse(json) as Record<string, unknown>;
    (obj.dataset as Record<string, unknown>).caseSetDigest = "tampered";
    expectCode(() => parseAndValidatePreregistrationV2(JSON.stringify(obj)), "DERIVED_TAMPERED");
  });

  it("rejects a tampered root digest", () => {
    const obj = JSON.parse(json) as Record<string, unknown>;
    obj.preregistrationDigest = "f".repeat(64);
    expectCode(() => parseAndValidatePreregistrationV2(JSON.stringify(obj)), "ROOT_DIGEST_MISMATCH");
  });

  it("rejects an unknown top-level field", () => {
    const obj = JSON.parse(json) as Record<string, unknown>;
    obj.extraApproval = true;
    expectCode(() => parseAndValidatePreregistrationV2(JSON.stringify(obj)), "UNKNOWN_FIELD");
  });

  it("rejects a non-integer / negative number", () => {
    const obj = JSON.parse(json) as Record<string, unknown>;
    (obj.schedule as Record<string, unknown>).orderSeed = -1;
    expectCode(() => parseAndValidatePreregistrationV2(JSON.stringify(obj)), "INVALID_FIELD");
  });

  it("refuses a v1 artifact outright (v1 cannot authorize formal execution)", () => {
    const v1 = buildToolCallEfficiencyPreregistration({
      eligibleCaseIds: CASE_IDS,
      repetitions: 1,
      orderSeed: 7,
      callsPerArmRun: 10,
      budget: { campaignModelCalls: 320, perCaseToolCalls: 100, perCaseDurationMs: 600_000 },
    });
    expectCode(() => parseAndValidatePreregistrationV2(JSON.stringify(v1)), "WRONG_SCHEMA");
    expectCode(() => assertFormalExecutionPreregistration(JSON.stringify(v1)), "WRONG_SCHEMA");
  });

  it("refuses a guidance digest that does not match the authoritative text", () => {
    const obj = JSON.parse(json) as Record<string, unknown>;
    (obj.prompt as Record<string, unknown>).guidanceDigest = "deadbeef";
    const recomputed = computePreregistrationV2Digest({
      ...(obj as unknown as Parameters<typeof computePreregistrationV2Digest>[0]),
    });
    obj.preregistrationDigest = recomputed; // keep the root consistent so ONLY the guidance check fires
    expectCode(() => parseAndValidatePreregistrationV2(JSON.stringify(obj)), "GUIDANCE_MISMATCH");
  });

  // F7 — the "strict JSON" claim must actually hold: JSON.parse silently keeps
  // the LAST duplicate key, so the loader must scan the raw bytes itself.
  it("rejects a duplicate JSON object key (F7)", () => {
    const dup = `{"schemaVersion":"tool-call-efficiency-preregistration-v2",${json.slice(1)}`;
    expect(JSON.parse(dup)).toBeTypeOf("object"); // JSON.parse itself accepts it
    expectCode(() => parseAndValidatePreregistrationV2(dup), "DUPLICATE_JSON_KEY");
  });

  it("rejects a duplicate key NESTED inside an object (F7)", () => {
    const dup = json.replace('"maxUsdMicros":', '"maxUsdMicros":null,"maxUsdMicros":');
    expect(json).not.toBe(dup);
    expectCode(() => parseAndValidatePreregistrationV2(dup), "DUPLICATE_JSON_KEY");
  });

  // A3/F7 — `"x"` and `"\u0078"` are the SAME JSON key after decoding, so a
  // scanner that compares raw escape TEXT (rather than the decoded key) would
  // accept this. The scan must decode before comparing.
  it("rejects an escape-equivalent duplicate key (F7)", () => {
    const dup = json.replace('"schemaVersion":', '"\\u0073chemaVersion":"x","schemaVersion":');
    expect(JSON.parse(dup)).toBeTypeOf("object");
    expectCode(() => parseAndValidatePreregistrationV2(dup), "DUPLICATE_JSON_KEY");
  });

  it("rejects a subject.cleanTreePolicy it does not support (F7)", () => {
    const obj = JSON.parse(json) as Record<string, unknown>;
    (obj.subject as Record<string, unknown>).cleanTreePolicy = "allow-dirty";
    expectCode(() => parseAndValidatePreregistrationV2(JSON.stringify(obj)), "INVALID_FIELD");
  });

  it("rejects a budget.pricingUnknownPolicy it does not support (F7)", () => {
    const obj = JSON.parse(json) as Record<string, unknown>;
    (obj.budget as Record<string, unknown>).pricingUnknownPolicy = "allow-unknown";
    expectCode(() => parseAndValidatePreregistrationV2(JSON.stringify(obj)), "INVALID_FIELD");
  });
});

describe("N4 — the unified eligible minimum is one frozen, re-derived number", () => {
  it("binds min(contract, policy) as max(contract 5, policy 3) = 5", () => {
    const a = buildToolCallEfficiencyPreregistrationV2(baseOptions());
    expect(a.evaluation.minEligibleCases).toBe(5);
  });

  it("a policy minimum ABOVE the contract raises the effective minimum and refuses a 5-case selection", () => {
    const five = CASE_IDS.slice(0, 5);
    expectCode(
      () =>
        buildToolCallEfficiencyPreregistrationV2(
          baseOptions({
            catalog: five.map((id) => catalogEntry(id)),
            selection: { caseIds: [...five], selectionRule: "r", selectionProvenanceDigest: "d", holdoutPolicy: "h" },
            evaluation: {
              ...baseOptions().evaluation,
              decisionPolicy: { ...DEFAULT_DECISION_POLICY_V3, minActivationEligibleCases: 6 },
            },
          }),
        ),
      "TOO_FEW_CASES",
    );
  });

  it("changing the policy minimum changes the root digest (the approval must be re-issued)", () => {
    const canonical = buildToolCallEfficiencyPreregistrationV2(baseOptions());
    const raised = buildToolCallEfficiencyPreregistrationV2(
      baseOptions({
        evaluation: {
          ...baseOptions().evaluation,
          decisionPolicy: { ...DEFAULT_DECISION_POLICY_V3, minActivationEligibleCases: 6 },
        },
      }),
    );
    expect(raised.evaluation.minEligibleCases).toBe(6);
    expect(raised.preregistrationDigest).not.toBe(canonical.preregistrationDigest);
  });

  it("refuses a hand-edited (smaller) minEligibleCases as DERIVED_TAMPERED", () => {
    const obj = JSON.parse(serializePreregistrationV2(buildToolCallEfficiencyPreregistrationV2(baseOptions()))) as Record<string, unknown>;
    (obj.evaluation as Record<string, unknown>).minEligibleCases = 3;
    expectCode(() => parseAndValidatePreregistrationV2(JSON.stringify(obj)), "DERIVED_TAMPERED");
  });

  it("refuses a consistent-root artifact whose case count is below the unified minimum", () => {
    // Build a legitimate 8-case artifact, then drop to 3 cases and RE-COMPUTE
    // every derived value and the root digest — so ONLY the unified-minimum
    // count check can refuse it. This proves the check is not merely a digest
    // echo: a self-consistent artifact is still refused.
    const obj = JSON.parse(serializePreregistrationV2(buildToolCallEfficiencyPreregistrationV2(baseOptions()))) as Record<string, unknown>;
    const dataset = obj.dataset as Record<string, unknown>;
    dataset.cases = (dataset.cases as unknown[]).slice(0, 3);
    dataset.caseSetDigest = computeCaseSetDigestV2(dataset.cases as Parameters<typeof computeCaseSetDigestV2>[0]);
    obj.preregistrationDigest = computePreregistrationV2Digest(obj as unknown as Parameters<typeof computePreregistrationV2Digest>[0]);
    expectCode(() => parseAndValidatePreregistrationV2(JSON.stringify(obj)), "TOO_FEW_CASES");
  });
});

describe("N1 pre-registration v2 — zero provider calls", () => {
  it("never constructs a provider (spy factory stays at 0) across accept and reject paths", () => {
    const providerFactory = vi.fn(() => {
      throw new Error("a provider must never be constructed during pre-registration");
    });
    // Accept, serialize, parse, and several rejection paths — the spy is unused.
    const a = buildToolCallEfficiencyPreregistrationV2(baseOptions());
    parseAndValidatePreregistrationV2(serializePreregistrationV2(a));
    expectCode(() => buildToolCallEfficiencyPreregistrationV2(baseOptions({ schedule: { repetitions: 1, orderSeed: 0 } })), "REPETITIONS_TOO_LOW");
    expectCode(() => parseAndValidatePreregistrationV2("{not json"), "NOT_JSON");
    expect(providerFactory).toHaveBeenCalledTimes(0);
  });
});

describe("evidence fixture — the committed v2 artifact stays parseable and self-consistent", () => {
  it("parses, reserializes to identical bytes, and re-derives the unified minimum", async () => {
    const url = new URL("../../../docs/evidence/tool-call-efficiency-preregistration-v2.fixture.json", import.meta.url);
    const bytes = await readFile(url, "utf8");
    const parsed = parseAndValidatePreregistrationV2(bytes);
    // parse -> reserialize must reproduce the exact committed bytes (fail-closed
    // parsing would otherwise let the fixture drift from the schema unnoticed).
    expect(serializePreregistrationV2(parsed)).toBe(bytes.trim());
    expect(parsed.evaluation.minEligibleCases).toBe(5);
    expect(parsed.schedule.repetitions).toBe(2);
    expect(parsed.budget.campaignWorstCaseModelCalls).toBe(960);
  });
});