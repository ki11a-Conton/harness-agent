/**
 * E4-R92 — the paid-authorization envelope and its pre-provider gate.
 *
 * Plan §R92 requires that a real A/B be presentable for a SPECIFIC user
 * authorization, and that an unauthorized / expired / wrong-digest run be
 * refused BEFORE the first provider request. These tests are all offline: the
 * gate is a pure function of (env, envelope, observed facts), so proving it
 * refuses costs zero provider calls and zero dollars.
 *
 * The tests deliberately separate the two things a reader must not conflate:
 *   - `planStatus: READY_FOR_AUTHORIZATION` — the plan is complete enough to be
 *     authorized by a human;
 *   - `runStatus: NOT_RUN` — nothing has been executed.
 */

import { describe, expect, it } from "vitest";
import {
  R92_AUTHORIZATION_SCHEMA,
  classifyR92Caps,
  computeR92AuthorizationDigestV1,
  r92AuthorizationGate,
  r92AuthorizationIssuesV1,
  r92CapViolations,
  type R92AuthorizationV1,
  type R92ArmBuildMode,
  type R92CapDeclaration,
  type R92CapIntent,
  type R92GateFacts,
} from "./r92-authorization.js";

const h = (c: string) => c.repeat(64);
const sha = (c: string) => c.repeat(40);

/** The real frozen R87 selection: 8 non-holdout dev-set cases (3 H2 TARGET +
 *  5 COUNTEREXAMPLE). Using the actual set keeps the fixture honest about the
 *  6–10 window instead of inventing a convenient size. */
const CASE_IDS = [
  "regression/reg-16-cicd-step",
  "stress/stress-many-artifacts",
  "stress/stress-very-long-json",
  "regression/reg-24-error-handling",
  "regression/reg-03-add-import",
  "regression/reg-14-stack",
  "regression/reg-17-gcd",
  "regression/reg-06-json-parse-test",
];

/** Distinct, VALID hex digits — the alphabet matters: 'g'/'h' are not hex. */
const HEX = "0123456789abcdef";

/** Named case ids for the spots that index the list (noUncheckedIndexedAccess). */
const CASE_A = CASE_IDS[0]!;
const CASE_B = CASE_IDS[1]!;

function fingerprints(seed = 0): Record<string, string> {
  return Object.fromEntries(CASE_IDS.map((id, i) => [id, HEX[(seed + i) % 16]!.repeat(64)]));
}

/** One arm's build identity. Two isolated checkouts necessarily produce two
 *  different execution-plan digests, because the plan binds sourceSha and
 *  treeFingerprint — so identity is bound PER ARM, never once for both. */
function arm(sha: string, digest: string, mode: R92ArmBuildMode = "isolated-checkout") {
  return { sha, executionPlanDigest: digest, buildMode: mode };
}

/** A complete, self-consistent envelope. Individual tests perturb one field. */
function baseAuth(over: Partial<R92AuthorizationV1> = {}): R92AuthorizationV1 {
  const caps = classifyR92Caps(capIntent());
  const auth: R92AuthorizationV1 = {
    schemaVersion: R92_AUTHORIZATION_SCHEMA,
    authorizationId: "e4-r92-dev-mechanism-ab-1",
    createdAt: "2026-09-17T00:00:00.000Z",
    expiresAt: "2026-10-17T00:00:00.000Z",
    scopeStatement:
      "8 non-holdout development-set cases (3 H2 TARGET + 5 COUNTEREXAMPLE), mechanism verification only — NOT population-representative, never a pass-rate claim.",
    selectionDigest: h("1"),
    caseIds: [...CASE_IDS],
    caseFingerprints: fingerprints(),
    arms: {
      baseline: arm(sha("e"), h("b")),
      candidate: arm(sha("f"), h("c")),
    },
    armIdentityMode: "isolated-checkout-build",
    fixScope: "single-fix-H2",
    fixScopeStatement:
      "Single-fix scope: the only functional difference between the two arms is the R86 progress-aware identical-call gate, so a delta is attributable to H2.",
    jointAttributionNote: null,
    invocationMode: "single-invocation-over-frozen-list",
    providerId: "openai",
    modelId: "gpt-4o-mini",
    endpointIdentity: h("2"),
    effectiveModelParams: { budgetTokens: 32000, stallPolicy: { maxRepeatedIdenticalToolCalls: 3 } },
    repetitions: 1,
    serialism: 1,
    caps,
    unknownCostItems: ["USD total: the per-token price is not bound anywhere the runner can read"],
    outputDir: ".ci/r92-ab",
    promotionEligible: false,
    ...over,
  };
  return auth;
}

function capIntent(over: Partial<R92CapIntent> = {}): R92CapIntent {
  return {
    campaignModelCalls: 320,
    perCaseToolCalls: 100,
    perCaseDurationMs: 600_000,
    maxLogicalRuns: 16,
    maxEstimatedTokens: null,
    maxEstimatedCostUsd: null,
    caseCount: 8,
    repetitions: 1,
    armCount: 2,
    invocationMode: "single-invocation-over-frozen-list",
    ...over,
  };
}

function facts(over: Partial<R92GateFacts> = {}): R92GateFacts {
  const auth = baseAuth();
  return {
    now: "2026-09-20T00:00:00.000Z",
    executingSourceSha: auth.arms.candidate.sha,
    observedArmBuilds: {
      baseline: { sha: auth.arms.baseline.sha, executionPlanDigest: auth.arms.baseline.executionPlanDigest },
      candidate: { sha: auth.arms.candidate.sha, executionPlanDigest: auth.arms.candidate.executionPlanDigest },
    },
    observedCaseFingerprints: fingerprints(),
    observedProviderId: auth.providerId,
    observedModelId: auth.modelId,
    observedEndpointIdentity: auth.endpointIdentity,
    ...over,
  };
}

const AUTH_ENV = {
  E4_R92_PAID_AUTH: "1",
  RUN_PAID_BENCHMARKS: "1",
};

function envFor(auth: R92AuthorizationV1, over: Record<string, string | undefined> = {}) {
  return { ...AUTH_ENV, E4_R92_PAID_AUTH_DIGEST: computeR92AuthorizationDigestV1(auth), ...over };
}

describe("E4-R92 authorization digest binds the whole authorization surface", () => {
  it("is a stable 64-hex digest of the same envelope", () => {
    const a = computeR92AuthorizationDigestV1(baseAuth());
    const b = computeR92AuthorizationDigestV1(baseAuth());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it("changes when ANY security-relevant field changes", () => {
    const base = computeR92AuthorizationDigestV1(baseAuth());
    const perturbations: Array<[string, Partial<R92AuthorizationV1>]> = [
      ["expiresAt", { expiresAt: "2026-11-17T00:00:00.000Z" }],
      ["arms.baseline.sha", { arms: { baseline: arm(sha("0"), h("b")), candidate: arm(sha("f"), h("c")) } }],
      ["arms.candidate.sha", { arms: { baseline: arm(sha("e"), h("b")), candidate: arm(sha("1"), h("c")) } }],
      ["arms.baseline.executionPlanDigest", { arms: { baseline: arm(sha("e"), h("d")), candidate: arm(sha("f"), h("c")) } }],
      ["arms.candidate.executionPlanDigest", { arms: { baseline: arm(sha("e"), h("b")), candidate: arm(sha("f"), h("a")) } }],
      ["armIdentityMode", { armIdentityMode: "same-version-controlled-switch" }],
      ["invocationMode", { invocationMode: "per-case-invocation" }],
      ["selectionDigest", { selectionDigest: h("9") }],
      ["endpointIdentity", { endpointIdentity: h("7") }],
      ["providerId", { providerId: "anthropic" }],
      ["modelId", { modelId: "other-model" }],
      ["repetitions", { repetitions: 2 }],
      ["serialism", { serialism: 2 }],
      ["outputDir", { outputDir: ".ci/r92-other" }],
      ["caseIds", { caseIds: [...CASE_IDS, "regression/reg-03-add-import"] }],
      ["caseFingerprints", { caseFingerprints: { ...fingerprints(), [CASE_A]: h("5") } }],
      ["caps", { caps: classifyR92Caps(capIntent({ campaignModelCalls: 321 })) }],
      ["effectiveModelParams", { effectiveModelParams: { budgetTokens: 64000 } }],
      ["unknownCostItems", { unknownCostItems: [] }],
      ["scopeStatement", { scopeStatement: "different scope" }],
      ["fixScope", { fixScope: "joint-multi-fix" }],
    ];
    for (const [label, over] of perturbations) {
      expect(computeR92AuthorizationDigestV1(baseAuth(over)), `digest must change for ${label}`).not.toBe(base);
    }
  });
});

describe("E4-R92 cap classification separates enforceable caps from claimed ones", () => {
  it("marks the campaign model-call cap runtime-enforced only for a single invocation", () => {
    const single = classifyR92Caps(capIntent());
    const mc = single.find((c) => c.cap === "maxModelCalls" && c.scope === "campaign-wide")!;
    expect(mc.enforcement).toBe("runtime-enforced");
    expect(mc.blocked).toBe(false);

    const perCase = classifyR92Caps(capIntent({ invocationMode: "per-case-invocation" }));
    const mc2 = perCase.find((c) => c.cap === "maxModelCalls" && c.scope === "campaign-wide")!;
    expect(mc2.enforcement).not.toBe("runtime-enforced");
    expect(mc2.blocked).toBe(true);
  });

  it("classifies the USD cost cap as unprovable and BLOCKED", () => {
    const caps = classifyR92Caps(capIntent({ maxEstimatedCostUsd: 5 }));
    const usd = caps.find((c) => c.cap === "maxEstimatedCostUsd")!;
    expect(usd.enforcement).toBe("unprovable");
    expect(usd.blocked).toBe(true);
    expect(r92CapViolations(caps).join(" ")).toContain("maxEstimatedCostUsd");
  });

  it("classifies the logical-run cap as preflight-only but NOT blocked (the count is exact)", () => {
    const caps = classifyR92Caps(capIntent({ maxLogicalRuns: 16 }));
    const c = caps.find((x) => x.cap === "maxLogicalRuns")!;
    expect(c.enforcement).toBe("preflight-only");
    expect(c.blocked).toBe(false);
  });

  it("blocks a DECLARED token cap, because actual token use is never re-checked", () => {
    const declared = classifyR92Caps(capIntent({ maxEstimatedTokens: 1_000_000 }));
    const t = declared.find((x) => x.cap === "maxEstimatedTokens")!;
    expect(t.enforcement).toBe("preflight-only");
    expect(t.blocked).toBe(true);
    expect(r92CapViolations(declared).join(" ")).toContain("maxEstimatedTokens");

    // Declaring nothing is an honest unknown, not a blocked claim.
    const undeclared = classifyR92Caps(capIntent({ maxEstimatedTokens: null }));
    const t2 = undeclared.find((x) => x.cap === "maxEstimatedTokens")!;
    expect(t2.blocked).toBe(false);
    expect(r92CapViolations(undeclared)).toEqual([]);
  });

  it("classifies per-case tool-call and duration caps as runtime-enforced", () => {
    const caps = classifyR92Caps(capIntent());
    for (const name of ["maxToolCalls", "maxDurationMs"] as const) {
      const c = caps.find((x) => x.cap === name && x.scope === "per-case")!;
      expect(c.enforcement).toBe("runtime-enforced");
      expect(c.blocked).toBe(false);
    }
  });

  it("reports a violation when a cap claims runtime enforcement it does not have", () => {
    const lying: R92CapDeclaration[] = [
      {
        cap: "maxEstimatedCostUsd",
        scope: "campaign-wide",
        value: 5,
        enforcement: "runtime-enforced",
        blocked: false,
        evidence: "claimed, not measured",
      },
    ];
    expect(r92CapViolations(lying).join(" ")).toContain("maxEstimatedCostUsd");
  });

  it("reports a violation when the campaign model-call cap is absent", () => {
    const caps = classifyR92Caps(capIntent({ campaignModelCalls: null }));
    const issues = r92CapViolations(caps).join(" ");
    expect(issues).toContain("maxModelCalls");
    expect(issues).toContain("global budget");
  });
});

describe("E4-R92 static envelope validation", () => {
  it("accepts a complete envelope", () => {
    expect(r92AuthorizationIssuesV1(baseAuth())).toEqual([]);
  });

  it("requires the dev-set scope statement to deny population representativeness", () => {
    const issues = r92AuthorizationIssuesV1(
      baseAuth({ scopeStatement: "these 8 cases prove the harness got better overall" }),
    ).join(" ");
    expect(issues).toContain("scope");
  });

  it("requires promotionEligible false — a dev-set mechanism run is not a promotion run", () => {
    const issues = r92AuthorizationIssuesV1(
      baseAuth({ promotionEligible: true as unknown as false }),
    ).join(" ");
    expect(issues).toContain("promotionEligible");
  });

  it("requires serialism 1 and repetitions 1", () => {
    expect(r92AuthorizationIssuesV1(baseAuth({ serialism: 2 })).join(" ")).toContain("serialism");
    expect(r92AuthorizationIssuesV1(baseAuth({ repetitions: 3 })).join(" ")).toContain("repetitions");
  });

  it("requires the two arm SHAs to be real and distinct for an isolated build", () => {
    expect(
      r92AuthorizationIssuesV1(
        baseAuth({ arms: { baseline: arm("not-a-sha", h("b")), candidate: arm(sha("f"), h("c")) } }),
      ).join(" "),
    ).toContain("baseline.sha");
    expect(
      r92AuthorizationIssuesV1(
        baseAuth({ arms: { baseline: arm(sha("e"), h("b")), candidate: arm(sha("e"), h("c")) } }),
      ).join(" "),
    ).toContain("distinct");
  });

  it("allows one shared SHA for a same-version controlled switch, but never as two builds", () => {
    const shared = baseAuth({
      armIdentityMode: "same-version-controlled-switch",
      arms: {
        baseline: arm(sha("e"), h("b"), "same-version-switch"),
        candidate: arm(sha("e"), h("c"), "same-version-switch"),
      },
    });
    expect(r92AuthorizationIssuesV1(shared).join(" ")).not.toContain("distinct");
  });

  it("refuses a per-arm build mode that contradicts the experiment's arm-identity mode", () => {
    // An isolated-checkout-build experiment whose baseline claims to be the
    // same-version switch is exactly the falsified provenance the plan forbids.
    const issues = r92AuthorizationIssuesV1(
      baseAuth({
        arms: {
          baseline: arm(sha("e"), h("b"), "same-version-switch"),
          candidate: arm(sha("f"), h("c"), "isolated-checkout"),
        },
      }),
    ).join(" ");
    expect(issues).toContain("baseline.buildMode");
  });

  it("requires the case fingerprint map to cover every declared case", () => {
    const fp = fingerprints();
    delete fp[CASE_B];
    const issues = r92AuthorizationIssuesV1(baseAuth({ caseFingerprints: fp })).join(" ");
    expect(issues).toContain(CASE_B);
  });

  it("requires an expiry after creation", () => {
    const issues = r92AuthorizationIssuesV1(
      baseAuth({ createdAt: "2026-10-17T00:00:00.000Z", expiresAt: "2026-09-17T00:00:00.000Z" }),
    ).join(" ");
    expect(issues).toContain("expiresAt");
  });

  it("requires an endpoint identity — a raw or absent endpoint is not an authorization surface", () => {
    expect(r92AuthorizationIssuesV1(baseAuth({ endpointIdentity: null })).join(" ")).toContain("endpointIdentity");
    expect(
      r92AuthorizationIssuesV1(baseAuth({ endpointIdentity: "https://api.openai.com/v1" })).join(" "),
    ).toContain("endpointIdentity");
  });

  it("keeps the case count inside the planned 6-10 dev-set window", () => {
    const issues = r92AuthorizationIssuesV1(baseAuth({ caseIds: CASE_IDS.slice(0, 3) })).join(" ");
    expect(issues).toContain("6-10");
  });

  it("requires a fix-scope statement so a gain is never wholly attributed to H2 by default", () => {
    const issues = r92AuthorizationIssuesV1(baseAuth({ fixScopeStatement: "" })).join(" ");
    expect(issues).toContain("fixScope");
  });

  it("requires a joint-attribution note when the arms differ by more than the single H2 fix", () => {
    const issues = r92AuthorizationIssuesV1(
      baseAuth({ fixScope: "joint-multi-fix", fixScopeStatement: "several fixes", jointAttributionNote: null }),
    ).join(" ");
    expect(issues).toContain("jointAttributionNote");

    const ok = r92AuthorizationIssuesV1(
      baseAuth({
        fixScope: "joint-multi-fix",
        fixScopeStatement: "several fixes",
        jointAttributionNote: "the delta is joint: H2 + H1, not separable in this run",
      }),
    );
    expect(ok).toEqual([]);
  });
});

describe("E4-R92 gate refuses before the first provider request", () => {
  it("refuses with no authorization present, and reports the deliverable state", () => {
    const r = r92AuthorizationGate({ env: {}, authorization: baseAuth(), facts: facts() });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.code).toBe("PAID_AUTHORIZATION_REQUIRED");
    expect(r.planStatus).toBe("READY_FOR_AUTHORIZATION");
    expect(r.runStatus).toBe("NOT_RUN");
  });

  it("refuses when the envelope itself is missing", () => {
    const r = r92AuthorizationGate({ env: envFor(baseAuth()), authorization: null, facts: facts() });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.planStatus).toBe("NOT_READY");
    expect(r.runStatus).toBe("NOT_RUN");
  });

  it("refuses an expired authorization", () => {
    const auth = baseAuth();
    const r = r92AuthorizationGate({
      env: envFor(auth),
      authorization: auth,
      facts: facts({ now: "2026-12-01T00:00:00.000Z" }),
    });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.code).toBe("AUTHORIZATION_EXPIRED");
  });

  it("refuses a mismatched authorization digest", () => {
    const auth = baseAuth();
    const r = r92AuthorizationGate({
      env: envFor(auth, { E4_R92_PAID_AUTH_DIGEST: h("0") }),
      authorization: auth,
      facts: facts(),
    });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.code).toBe("AUTHORIZATION_DIGEST_MISMATCH");
  });

  it("refuses source-SHA drift", () => {
    const auth = baseAuth();
    const r = r92AuthorizationGate({
      env: envFor(auth),
      authorization: auth,
      facts: facts({ executingSourceSha: sha("9") }),
    });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.code).toBe("IDENTITY_DRIFT");
    expect(r.reason).toContain("sourceSha");
  });

  it("refuses case-content drift", () => {
    const auth = baseAuth();
    const r = r92AuthorizationGate({
      env: envFor(auth),
      authorization: auth,
      facts: facts({ observedCaseFingerprints: { ...fingerprints(), [CASE_A]: h("4") } }),
    });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.code).toBe("CASE_CONTENT_DRIFT");
  });

  it("refuses endpoint drift", () => {
    const auth = baseAuth();
    const r = r92AuthorizationGate({
      env: envFor(auth),
      authorization: auth,
      facts: facts({ observedEndpointIdentity: h("6") }),
    });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.code).toBe("IDENTITY_DRIFT");
    expect(r.reason).toContain("endpointIdentity");
  });

  it("refuses a changed execution-plan digest for either arm", () => {
    const auth = baseAuth();
    const candidateDrift = r92AuthorizationGate({
      env: envFor(auth),
      authorization: auth,
      facts: facts({
        observedArmBuilds: {
          baseline: { sha: auth.arms.baseline.sha, executionPlanDigest: auth.arms.baseline.executionPlanDigest },
          candidate: { sha: auth.arms.candidate.sha, executionPlanDigest: h("5") },
        },
      }),
    });
    expect(candidateDrift.authorizedToExecute).toBe(false);
    expect(candidateDrift.code).toBe("ARM_BUILD_DRIFT");

    const baselineDrift = r92AuthorizationGate({
      env: envFor(auth),
      authorization: auth,
      facts: facts({
        observedArmBuilds: {
          baseline: { sha: auth.arms.baseline.sha, executionPlanDigest: h("5") },
          candidate: { sha: auth.arms.candidate.sha, executionPlanDigest: auth.arms.candidate.executionPlanDigest },
        },
      }),
    });
    expect(baselineDrift.authorizedToExecute).toBe(false);
    expect(baselineDrift.code).toBe("ARM_BUILD_DRIFT");
  });

  it("refuses to record a same-version switch as an isolated historical checkout", () => {
    // The authorization declares two isolated builds, but both arms report the
    // SAME sha — that is one build flipped, i.e. the falsified provenance the
    // plan forbids recording as a historical checkout.
    const auth = baseAuth();
    const r = r92AuthorizationGate({
      env: envFor(auth),
      authorization: auth,
      facts: facts({
        observedArmBuilds: {
          baseline: { sha: auth.arms.candidate.sha, executionPlanDigest: auth.arms.baseline.executionPlanDigest },
          candidate: { sha: auth.arms.candidate.sha, executionPlanDigest: auth.arms.candidate.executionPlanDigest },
        },
      }),
    });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.code).toBe("ARM_IDENTITY_MIXED");
    expect(r.reason).toContain("same-version");
  });

  it("refuses to record an isolated build as a same-version switch", () => {
    const auth = baseAuth({
      armIdentityMode: "same-version-controlled-switch",
      arms: {
        baseline: arm(sha("e"), h("b"), "same-version-switch"),
        candidate: arm(sha("e"), h("c"), "same-version-switch"),
      },
    });
    const r = r92AuthorizationGate({
      env: envFor(auth),
      authorization: auth,
      facts: facts({
        executingSourceSha: auth.arms.candidate.sha,
        observedArmBuilds: {
          baseline: { sha: auth.arms.baseline.sha, executionPlanDigest: auth.arms.baseline.executionPlanDigest },
          candidate: { sha: auth.arms.candidate.sha, executionPlanDigest: auth.arms.candidate.executionPlanDigest },
        },
      }),
    });
    expect(r.authorizedToExecute).toBe(true);

    // Now the runner reports two DIFFERENT builds for a declared switch.
    const twoBuilds = r92AuthorizationGate({
      env: envFor(auth),
      authorization: auth,
      facts: facts({
        executingSourceSha: auth.arms.candidate.sha,
        observedArmBuilds: {
          baseline: { sha: sha("9"), executionPlanDigest: auth.arms.baseline.executionPlanDigest },
          candidate: { sha: auth.arms.candidate.sha, executionPlanDigest: auth.arms.candidate.executionPlanDigest },
        },
      }),
    });
    expect(twoBuilds.authorizedToExecute).toBe(false);
    expect(twoBuilds.code).toBe("ARM_IDENTITY_MIXED");
  });

  it("refuses when an arm's build identity is not observed at all", () => {
    const auth = baseAuth();
    const r = r92AuthorizationGate({
      env: envFor(auth),
      authorization: auth,
      facts: facts({
        observedArmBuilds: {
          baseline: { sha: auth.arms.baseline.sha, executionPlanDigest: auth.arms.baseline.executionPlanDigest },
          candidate: { sha: null, executionPlanDigest: null },
        },
      }),
    });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.code).toBe("ARM_BUILD_DRIFT");
  });

  it("refuses when an unenforceable cap is declared as a hard limit", () => {
    const auth = baseAuth({ caps: classifyR92Caps(capIntent({ maxEstimatedCostUsd: 5 })) });
    const r = r92AuthorizationGate({ env: envFor(auth), authorization: auth, facts: facts() });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.code).toBe("CAP_NOT_ENFORCEABLE");
  });

  it("refuses when the global budget is incomplete", () => {
    const auth = baseAuth({ caps: classifyR92Caps(capIntent({ campaignModelCalls: null })) });
    const r = r92AuthorizationGate({ env: envFor(auth), authorization: auth, facts: facts() });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.code).toBe("BUDGET_INCOMPLETE");
  });

  it("refuses a malformed envelope instead of best-effort executing it", () => {
    const auth = baseAuth({ serialism: 4 });
    const r = r92AuthorizationGate({ env: envFor(auth), authorization: auth, facts: facts() });
    expect(r.authorizedToExecute).toBe(false);
    expect(r.code).toBe("PLAN_INVALID");
  });

  it("permits execution only when the envelope is complete, unexpired and every fact matches", () => {
    const auth = baseAuth();
    const r = r92AuthorizationGate({ env: envFor(auth), authorization: auth, facts: facts() });
    expect(r.authorizedToExecute).toBe(true);
    expect(r.planStatus).toBe("READY_FOR_AUTHORIZATION");
    // The gate never claims a run happened.
    expect(r.runStatus).toBe("NOT_RUN");
    expect(r.code).toBeUndefined();
  });

  it("requires BOTH the R92 authorization and the shared paid-benchmark switch", () => {
    const auth = baseAuth();
    const onlyR92 = r92AuthorizationGate({
      env: envFor(auth, { RUN_PAID_BENCHMARKS: undefined }),
      authorization: auth,
      facts: facts(),
    });
    expect(onlyR92.authorizedToExecute).toBe(false);
    const onlyShared = r92AuthorizationGate({
      env: envFor(auth, { E4_R92_PAID_AUTH: undefined }),
      authorization: auth,
      facts: facts(),
    });
    expect(onlyShared.authorizedToExecute).toBe(false);
  });
});
