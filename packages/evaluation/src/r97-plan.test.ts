/**
 * E4-R97 — the finalized authorization plan.
 *
 * Plan §R97 怎么做 (lines 211-213) forbids three specific things, and this file
 * is organised around proving each is gone:
 *
 *   1. "computeArmPlanDigest 不能用作真实 CLI dry-run 摘要替身" — the arm digests
 *      must be REAL dry-run digests. A draft therefore carries NO envelope.
 *   2. "删掉'observed 值从 authorization 对应字段复制'" — the gate facts must come
 *      from observations. An unobserved arm must read as UNOBSERVED (`null`),
 *      never as a value copied from the envelope.
 *   3. "计划草案有缺失 build/tree fingerprint 或未验证 caps 时 NOT_READY/DRAFT" —
 *      a draft or an unverifiable plan is NOT_READY/DRAFT, and only a plan whose
 *      every bound value is observed is FINALIZED_AUTHORIZATION_PLAN.
 *
 * The real two-arm observation is driven by `scripts/e4/r97-plan-driver.mjs` and
 * proven in `r97-driver-closed-loop.test.ts`. This file uses synthetic
 * observations so each refusal path is testable deterministically.
 */

import { describe, expect, it } from "vitest";
import {
  buildR97AuthorizationPlan,
  parseR97ArmObservation,
  r97ReadinessIssues,
  R97_DRAFT_SCHEMA,
  R97_PLAN_SCHEMA,
  type R97ArmObservation,
} from "./r97-plan.js";
import { classifyR92Caps, type R92AuthorizationV1 } from "./r92-authorization.js";

const REPO = process.cwd();
const NOW = "2026-09-18T00:00:00.000Z";
const CREATED = "2026-09-17T00:00:00.000Z";
/** The endpoint identity is a NORMALIZED DIGEST, never a raw URL — the R92
 *  schema refuses a null/raw value, so a real plan must bind a real digest. */
const ENDPOINT = "e".repeat(64);

/** A synthetic but structurally REAL arm observation. */
function obs(over: Partial<R97ArmObservation> = {}): R97ArmObservation {
  return {
    arm: "baseline",
    checkoutDir: "D:/wt/baseline",
    sourceSha: "1".repeat(40),
    treeFingerprint: null,
    clean: true,
    planDigest: "a".repeat(64),
    providerId: "openai",
    modelId: "gpt-4o-mini",
    endpointIdentity: ENDPOINT,
    caseIds: [],
    cliCaseIds: [],
    caseFingerprints: {},
    effectiveModelParams: { budgetTokens: 32_000 },
    totalLogicalRuns: 16,
    suite: "regression",
    ...over,
  };
}

/** The real frozen case list, so the plan binds the actual selection. */
async function selectionIds(): Promise<string[]> {
  const { loadR97FrozenSelection } = await import("./r97-plan.js");
  return (await loadR97FrozenSelection(REPO)).caseIds;
}
async function selectionFps(): Promise<Record<string, string>> {
  const { loadR97FrozenSelection } = await import("./r97-plan.js");
  return (await loadR97FrozenSelection(REPO)).caseFingerprints;
}

/** Two consistent, fully-observed arms over the REAL frozen selection. */
async function observedPair(overB: Partial<R97ArmObservation> = {}, overC: Partial<R97ArmObservation> = {}) {
  const caseIds = await selectionIds();
  const caseFingerprints = await selectionFps();
  const base = obs({ arm: "baseline", sourceSha: "1".repeat(40), planDigest: "a".repeat(64), caseIds, caseFingerprints });
  const cand = obs({ arm: "candidate", sourceSha: "2".repeat(40), planDigest: "b".repeat(64), caseIds, caseFingerprints });
  return { baseline: { ...base, ...overB }, candidate: { ...cand, ...overC } };
}

async function build(over: Partial<Parameters<typeof buildR97AuthorizationPlan>[0]> = {}) {
  const pair = await observedPair();
  return buildR97AuthorizationPlan({
    repoRoot: REPO,
    baseline: pair.baseline,
    candidate: pair.candidate,
    providerId: "openai",
    modelId: "gpt-4o-mini",
    endpointIdentity: ENDPOINT,
    outputDir: ".ci/r97-ab",
    now: NOW,
    createdAt: CREATED,
    campaignModelCalls: 320,
    ...over,
  });
}

describe("E4-R97 P1: DRAFT vs FINALIZED_AUTHORIZATION_PLAN is structural", () => {
  it("with NO arm observed the plan is a DRAFT that carries no envelope and no digest", async () => {
    const p = await build({ baseline: null, candidate: null });
    expect(p.status).toBe("DRAFT"); // nothing observed yet => plan-in-progress
    expect(p.authorization).toBeNull();
    expect(p.planDigest).toBeNull();
    expect(p.authorizable).toBe(false);
    expect(p.schemaVersion).toBe(R97_DRAFT_SCHEMA);
    expect(p.readinessIssues.map((i) => i.code)).toContain("ARM_NOT_OBSERVED");
  });

  it("with only ONE arm observed the plan is NOT_READY (something WAS observed and is incomplete)", async () => {
    const pair = await observedPair();
    const p = await build({ baseline: pair.baseline, candidate: null });
    expect(p.status).toBe("NOT_READY");
    expect(p.authorization).toBeNull();
    expect(p.planDigest).toBeNull();
    expect(p.readinessIssues.map((i) => i.detail).join(" ")).toMatch(/candidate.*never observed/);
  });

  it("with BOTH arms really observed the plan FINALIZES and carries a digest", async () => {
    const p = await build();
    expect(p.status).toBe("FINALIZED_AUTHORIZATION_PLAN");
    expect(p.authorizable).toBe(true);
    expect(p.schemaVersion).toBe(R97_PLAN_SCHEMA);
    expect(p.authorization).not.toBeNull();
    expect(p.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(p.readinessIssues).toEqual([]);
  });

  it("a DRAFT is never authorizable and never claims a digest, whatever the caps", async () => {
    const p = await build({ baseline: null, candidate: null, campaignModelCalls: 320 });
    expect(p.authorizable).toBe(false);
    expect(p.planDigest).toBeNull();
    expect(p.approvalMarkdown).toContain("DRAFT");
    expect(p.approvalMarkdown).toContain("cannot be approved");
  });
  it("the draft schema and the finalized schema are DIFFERENT values", () => {
    expect(R97_DRAFT_SCHEMA).not.toBe(R97_PLAN_SCHEMA);
  });
});

describe("E4-R97 P2: the observed facts are OBSERVED, never copied from the envelope", () => {
  it("gateFacts carries the arms' OBSERVED shas and real dry-run digests", async () => {
    const pair = await observedPair();
    const p = await build({ baseline: pair.baseline, candidate: pair.candidate });
    expect(p.gateFacts.observedArmBuilds.baseline.sha).toBe(pair.baseline.sourceSha);
    expect(p.gateFacts.observedArmBuilds.baseline.executionPlanDigest).toBe(pair.baseline.planDigest);
    expect(p.gateFacts.observedArmBuilds.candidate.sha).toBe(pair.candidate.sourceSha);
    expect(p.gateFacts.observedArmBuilds.candidate.executionPlanDigest).toBe(pair.candidate.planDigest);
    // And they are the values the CLI actually printed, not plan-time substitutes.
    expect(p.authorization!.arms.baseline.executionPlanDigest).toBe(pair.baseline.planDigest);
    expect(p.authorization!.arms.candidate.executionPlanDigest).toBe(pair.candidate.planDigest);
  });

  it("an UNOBSERVED arm yields null in gateFacts — the R92 anti-copy defect", async () => {
    const pair = await observedPair();
    const p = await build({ baseline: pair.baseline, candidate: null });
    // The old implementation copied `authorization.arms.candidate.sha` into the
    // facts, so an unobserved arm always "matched" itself. It must be null now.
    expect(p.gateFacts.observedArmBuilds.candidate.sha).toBeNull();
    expect(p.gateFacts.observedArmBuilds.candidate.executionPlanDigest).toBeNull();
  });

  it("gateFacts.observedCaseFingerprints come from the ARM, not from the selection file", async () => {
    const caseIds = await selectionIds();
    // The arm reports DIFFERENT fingerprints than the files on disk. That is
    // case drift, and the plan must refuse — while still reporting the ARM's
    // values in the facts (so the drift is visible).
    const lying: Record<string, string> = {};
    for (const id of caseIds) lying[id] = "f".repeat(64);
    const p = await build({ candidate: obs({ arm: "candidate", sourceSha: "2".repeat(40), planDigest: "b".repeat(64), caseIds, caseFingerprints: lying }) });
    expect(p.status).toBe("NOT_READY");
    expect(p.readinessIssues.map((i) => i.code)).toContain("CASE_CONTENT_DRIFT");
    expect(p.gateFacts.observedCaseFingerprints[caseIds[0]!]).toBe("f".repeat(64));
  });

  it("gateFacts.now is the supplied executor clock, never a plan value", async () => {
    const p = await build();
    expect(p.gateFacts.now).toBe(NOW);
    expect(p.authorization!.createdAt).toBe(CREATED);
    expect(p.gateFacts.now).not.toBe(p.authorization!.createdAt);
  });

  it("the previous plan-time substitute digest function is gone from the module", async () => {
    const src = await (await import("node:fs/promises")).readFile(
      new URL("./r97-plan.ts", import.meta.url),
      "utf8",
    );
    // The R92 module's plan-time custom digest must not be reused as a
    // stand-in for the real CLI dry-run digest. Strip comments first: the module
    // DOCUMENTS the prohibition by quoting the plan, and a raw text scan would
    // match that documentation rather than a real call site.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (incl. JSDoc)
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(code).not.toContain("computeArmPlanDigest");
    expect(code).not.toMatch(/e4-r92-arm-execution-plan/);
  });
});

describe("E4-R97 P3: readiness refuses a plan that is not executable as written", () => {
  it("refuses an arm observed on a DIRTY checkout", async () => {
    // Control: a clean pair finalizes.
    const clean = await build();
    expect(clean.status).toBe("FINALIZED_AUTHORIZATION_PLAN");
    // A dirty arm means the digest describes a build that is not the build on
    // disk, so the plan cannot bind a reproducible identity.
    const dirty = await build({
      candidate: obs({
        arm: "candidate",
        sourceSha: "2".repeat(40),
        planDigest: "b".repeat(64),
        treeFingerprint: "c".repeat(64),
        clean: false,
        caseIds: await selectionIds(),
        caseFingerprints: await selectionFps(),
      }),
    });
    expect(dirty.status).toBe("NOT_READY");
    expect(dirty.readinessIssues.map((i) => i.code)).toContain("ARM_CHECKOUT_DIRTY");
  });

  it("refuses two arms that observed the SAME build (one arm standing in for two)", async () => {
    const caseIds = await selectionIds();
    const caseFingerprints = await selectionFps();
    const same = { sourceSha: "1".repeat(40), caseIds, caseFingerprints };
    const p = await build({
      baseline: obs({ arm: "baseline", planDigest: "a".repeat(64), ...same }),
      candidate: obs({ arm: "candidate", planDigest: "a".repeat(64), ...same }),
    });
    expect(p.status).toBe("NOT_READY");
    const codes = p.readinessIssues.map((i) => i.code);
    expect(codes).toContain("ARMS_NOT_DISTINCT");
    // BOTH the sha and the digest collision are reported.
    expect(p.readinessIssues.filter((i) => i.code === "ARMS_NOT_DISTINCT").length).toBe(2);
  });

  it("refuses a case SET that drifted from the frozen selection", async () => {
    const caseIds = await selectionIds();
    const caseFingerprints = await selectionFps();
    // A DIFFERENT SET (one case swapped for an unknown one) is drift.
    const swapped = [...caseIds.slice(0, -1), "regression/not-a-frozen-case"];
    const p = await build({
      candidate: obs({ arm: "candidate", sourceSha: "2".repeat(40), planDigest: "b".repeat(64), caseIds: swapped, caseFingerprints }),
    });
    expect(p.status).toBe("NOT_READY");
    expect(p.readinessIssues.map((i) => i.code)).toContain("CASE_SET_DRIFT");
  });

  it("accepts a different ORDER than the selection file, because loadBenchmarkCases sorts", async () => {
    // MEASURED: `loadBenchmarkCases` sorts its directory entries, so the CLI can
    // never reproduce the selection file's array order. Demanding array equality
    // would reject every real observation, so order is checked BETWEEN the arms
    // instead — and a consistent reordering in both arms is legitimate.
    const caseIds = await selectionIds();
    const caseFingerprints = await selectionFps();
    const sorted = [...caseIds].sort();
    const p = await build({
      baseline: obs({ arm: "baseline", sourceSha: "1".repeat(40), planDigest: "a".repeat(64), caseIds: sorted, caseFingerprints }),
      candidate: obs({ arm: "candidate", sourceSha: "2".repeat(40), planDigest: "b".repeat(64), caseIds: sorted, caseFingerprints }),
    });
    expect(p.status).toBe("FINALIZED_AUTHORIZATION_PLAN");
    // The plan binds the ARM's order, which is the order that will execute.
    expect(p.authorization!.caseIds).toEqual(sorted);
  });

  it("refuses two arms that planned the frozen cases in DIFFERENT orders", async () => {
    // The frozen selection's `armRule` requires "the same case order" in both
    // arms, so a cross-arm order mismatch is a real refusal.
    const caseIds = await selectionIds();
    const caseFingerprints = await selectionFps();
    const p = await build({
      baseline: obs({ arm: "baseline", sourceSha: "1".repeat(40), planDigest: "a".repeat(64), caseIds: [...caseIds].sort(), caseFingerprints }),
      candidate: obs({ arm: "candidate", sourceSha: "2".repeat(40), planDigest: "b".repeat(64), caseIds: [...caseIds].reverse(), caseFingerprints }),
    });
    expect(p.status).toBe("NOT_READY");
    expect(p.readinessIssues.map((i) => i.code)).toContain("ARM_ORDER_MISMATCH");
  });

  it("refuses an arm that planned a SHORTER case list", async () => {
    const caseIds = (await selectionIds()).slice(0, 3);
    const caseFingerprints = await selectionFps();
    const p = await build({
      candidate: obs({ arm: "candidate", sourceSha: "2".repeat(40), planDigest: "b".repeat(64), caseIds, caseFingerprints }),
    });
    expect(p.status).toBe("NOT_READY");
    expect(p.readinessIssues.map((i) => i.code)).toContain("CASE_SET_DRIFT");
  });

  it("refuses an arm whose provider/model/endpoint disagree with the plan", async () => {
    const caseIds = await selectionIds();
    const caseFingerprints = await selectionFps();
    const wrongModel = await build({
      candidate: obs({ arm: "candidate", sourceSha: "2".repeat(40), planDigest: "b".repeat(64), caseIds, caseFingerprints, modelId: "gpt-4o" }),
    });
    expect(wrongModel.readinessIssues.map((i) => i.code)).toContain("ARM_IDENTITY_MISMATCH");

    const wrongEndpoint = await build({
      candidate: obs({ arm: "candidate", sourceSha: "2".repeat(40), planDigest: "b".repeat(64), caseIds, caseFingerprints, endpointIdentity: "d".repeat(64) }),
    });
    expect(wrongEndpoint.readinessIssues.map((i) => i.code)).toContain("ARM_ENDPOINT_MISMATCH");  });

  it("refuses a malformed arm digest or sha", async () => {
    const caseIds = await selectionIds();
    const caseFingerprints = await selectionFps();
    const p = await build({
      candidate: obs({ arm: "candidate", sourceSha: "not-a-sha", planDigest: "short", caseIds, caseFingerprints }),
    });
    const codes = p.readinessIssues.map((i) => i.code);
    expect(codes).toContain("ARM_SOURCE_SHA_INVALID");
    expect(codes).toContain("ARM_PLAN_DIGEST_INVALID");
  });

  it("the cap contract is enforced with the SAME rule the R95 gate applies", () => {
    // A cap the measured layer cannot enforce makes the plan NOT_READY.
    const intent = { campaignModelCalls: 320, perCaseToolCalls: 100, perCaseDurationMs: 600_000, maxLogicalRuns: 16, maxEstimatedTokens: 5000, maxEstimatedCostUsd: null, caseCount: 8, repetitions: 1, armCount: 2, invocationMode: "single-invocation-over-frozen-list" as const };
    const caps = classifyR92Caps(intent);
    // A DECLARED token cap is a claim no layer can honour -> blocked.
    const token = caps.find((c) => c.cap === "maxEstimatedTokens")!;
    expect(token.blocked).toBe(true);
  });
});

describe("E4-R97 P4: the approval package names what a human must decide", () => {
  it("a FINALIZED package names the digest, both arms, expiry, caps and unknowns", async () => {
    const p = await build();
    const md = p.approvalMarkdown;
    for (const needle of ["FINALIZED_AUTHORIZATION_PLAN", "digest", "baseline", "candidate", "Expires", "output", "maxModelCalls", "unknown", "NOT_RUN"]) {
      expect(md.toLowerCase(), `approval package must mention ${needle}`).toContain(needle.toLowerCase());
    }
    expect(md).toContain(p.planDigest!);
    expect(md).toContain(p.driverVersion);
  });

  it("the package states that the arm digests are REAL dry-run digests", async () => {
    const p = await build();
    expect(p.approvalMarkdown).toMatch(/real CLI `--dry-run`/);
    expect(p.approvalMarkdown).toMatch(/NOT\s+plan-time substitutes/);
  });

  it("the package separates logical calls from physical retries", async () => {
    const p = await build();
    expect(p.approvalMarkdown).toMatch(/LOGICAL calls/);
    expect(p.approvalMarkdown).toMatch(/transport retries are recorded SEPARATELY/i);
  });

  it("never claims a real score or a pass-rate improvement", async () => {
    const p = await build();
    expect(p.realScores).toBe(false);
    expect(p.passRateClaim).toBe(false);
    expect(p.approvalMarkdown).not.toMatch(/pass[- ]rate (improved|increased|gain)/i);
  });

  it("states the fix scope without implying later fixes are included", async () => {
    const p = await build();
    expect(p.authorization!.fixScope).toBe("single-fix-H2");
    expect(p.authorization!.jointAttributionNote).toBeNull();
    // The statement itself must carry the prohibition, not just the field.
    expect(p.authorization!.fixScopeStatement).toMatch(/must NOT be described as carrying later shim fixes/);
  });
});

describe("E4-R97 P5: parseR97ArmObservation fails closed on hostile dry-run output", () => {
  it("accepts a well-formed dry-run document", () => {
    const raw = {
      mode: "dry-run",
      providerCalls: 0,
      planDigest: "a".repeat(64),
      sourceSha: "b".repeat(40),
      providerId: "openai",
      modelId: "gpt-4o-mini",
      endpointIdentity: null,
      suite: "regression",
      caseIds: ["regression-x"],
      effectiveModelParams: { budgetTokens: 1 },
      totalLogicalRuns: 2,
    };
    // The fingerprints are supplied by the caller (the CLI does not print them).
    const { observation, issues } = parseR97ArmObservation("baseline", "D:/wt/b", raw, { "regression/x": "c".repeat(64) });
    expect(issues).toEqual([]);
    expect(observation?.planDigest).toBe("a".repeat(64));
    expect(observation?.clean).toBe(true);
    expect(observation?.suite).toBe("regression");
    // The CLI's BARE ids are preserved separately from the mapped ones.
    expect(observation?.cliCaseIds).toEqual(["regression-x"]);
    expect(observation?.caseFingerprints["regression/x"]).toBe("c".repeat(64));
  });

  it("refuses a dry-run document with no suite", () => {
    const { observation, issues } = parseR97ArmObservation("baseline", "d", {
      mode: "dry-run", providerCalls: 0, planDigest: "a".repeat(64), sourceSha: "b".repeat(40),
      providerId: "p", modelId: "m", caseIds: ["x"],
    });
    expect(observation).toBeNull();
    expect(issues.join(" ")).toMatch(/carries no suite/);
  });

  it("refuses a document that is NOT a dry-run", () => {
    const { observation, issues } = parseR97ArmObservation("baseline", "d", { mode: "run", providerCalls: 0, planDigest: "a", sourceSha: "b", providerId: "p", modelId: "m", caseIds: ["x"] });
    expect(observation).toBeNull();
    expect(issues.join(" ")).toMatch(/not "dry-run"/);
  });

  it("refuses a dry-run that reports provider calls", () => {
    const { observation, issues } = parseR97ArmObservation("baseline", "d", { mode: "dry-run", providerCalls: 1, planDigest: "a", sourceSha: "b", providerId: "p", modelId: "m", caseIds: ["x"] });
    expect(observation).toBeNull();
    expect(issues.join(" ")).toMatch(/providerCalls=1/);
  });

  it("never throws on hostile input and names the field", () => {
    for (const hostile of [null, [], 42, "x", {}, { mode: "dry-run", providerCalls: 0 }]) {
      const { observation, issues } = parseR97ArmObservation("candidate", "d", hostile);
      expect(observation).toBeNull();
      expect(issues.length).toBeGreaterThan(0);
      // The reason names a field, never a value that could be a credential.
      expect(issues.join(" ")).toMatch(/arm candidate:/);
    }
  });
});

describe("E4-R97 P6: readiness is computed from observations, independently of any authorization", () => {
  it("reports readiness issues even when no authorization exists at all", () => {
    const intent = { campaignModelCalls: 320, perCaseToolCalls: 100, perCaseDurationMs: 600_000, maxLogicalRuns: 16, maxEstimatedTokens: null, maxEstimatedCostUsd: null, caseCount: 8, repetitions: 1, armCount: 2, invocationMode: "single-invocation-over-frozen-list" as const };
    const caps = classifyR92Caps(intent);
    // A minimal envelope that satisfies ONLY the cap contract. The point of this
    // test is that readiness is computed from OBSERVATIONS alone: no environment
    // variable, no authorization flag and no clock is consulted here.
    const envelope = { caps, endpointIdentity: ENDPOINT, caseIds: [], repetitions: 1, armCount: 2 } as unknown as R92AuthorizationV1;
    const issues = r97ReadinessIssues({
      selection: { caseIds: [], digest: "d", caseFingerprints: {} },
      baseline: null,
      candidate: null,
      caps,
      authorizationForCaps: envelope,
      expectedProviderId: "openai",
      expectedModelId: "gpt-4o-mini",
      expectedEndpointIdentity: ENDPOINT,
    });
    // Two arms unobserved, reported without consulting any environment variable.
    expect(issues.filter((i) => i.code === "ARM_NOT_OBSERVED").length).toBe(2);
  });

  it("a clean selection with both arms observed reports zero readiness issues", async () => {
    const p = await build();
    expect(p.readinessIssues).toEqual([]);
  });});
