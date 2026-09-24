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
 * Groups P1–P6 cover §R97. Group P7 covers E4-R98/R100 (§0.1 finding F5): the
 * plan-time observation SNAPSHOT is evidence for review, and every fact a run
 * depends on is RE-OBSERVED at the execution boundary.
 *
 * The real two-arm observation is driven by `scripts/e4/r97-plan-driver.mjs` and
 * proven in `r97-driver-closed-loop.test.ts`. This file uses synthetic
 * observations so each refusal path is testable deterministically.
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  buildR97AuthorizationPlan,
  checkExecutionObservationV1,
  computeDriverBuildDigestV1,
  computeExecutionIdentityV1,
  loadR97FrozenSelection,
  parseR97ArmObservation,
  r97ReadinessIssues,
  R97_DRIVER_BUILD_ENTRIES,
  R97_DRAFT_SCHEMA,
  R97_EXECUTION_IDENTITY_SCHEMA,
  R97_PLAN_SCHEMA,
  type R97ArmObservation,
  type R97ExecutionObservationV1,
} from "./r97-plan.js";
import { classifyR92Caps, computeR92AuthorizationDigestV1, type R92AuthorizationV1 } from "./r92-authorization.js";

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
    // E4-R104 (A4): the arm's EXECUTION build digest — the bytes that really run
    // a case. Distinct per arm so a test that conflates the two arms is caught.
    buildDigest: "7".repeat(64),
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
  return {
    baseline: { ...base, ...overB },
    // The two arms are different builds, so their build digests MUST differ —
    // `buildDigest: "8"` is set before `overC` so a test can still override it.
    candidate: { ...cand, buildDigest: "8".repeat(64), ...overC },
  };
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

  // -------------------------------------------------------------------------
  // E4-R104 (A4) 怎么做 8 — the PLAN artifact's version moved with the contract.
  // -------------------------------------------------------------------------
  //
  // A4 added `planObservation.armBuildDigests` and moved the embedded envelope to
  // the v2 contract, so the plan artifact's SHAPE changed. Leaving the label at
  // v1 would let a plan written under the pre-A4 shape claim to be current
  // material. The label must move so "this predates the execution-identity
  // contract" is a checkable fact rather than an assumption.
  it("carries a plan schema label that is NOT the superseded pre-A4 contract", () => {
    expect(R97_PLAN_SCHEMA).not.toBe("e4-r97-finalized-authorization-plan-v1");
    expect(R97_DRAFT_SCHEMA).not.toBe("e4-r97-draft-authorization-plan-v1");
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
      selection: { caseIds: [], digest: "d", caseFingerprints: {}, caseSuites: {} },
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

describe("E4-R98/R100 P7: execution-time facts are re-observed, never inherited from the plan snapshot", () => {
  // Plan §0.1 F5 ("真实执行前必修"): "fake CLI 从 plan.observation 读取快照；runDriver
  // 不重新观测 checkout." And §R100 做什么 #1: "分开计划期观测快照和执行期新观测；快照
  // 可用于审阅，不能充当当前事实."
  //
  // §R100 怎么验收 states the acceptance property these tests prove:
  //
  //   "计划生成后修改实际case、构建文件、模型参数、endpoint、driver字节，而保留旧
  //    observation：每项均在首个外部请求前失败."
  //
  // Every test below changes EXACTLY ONE bound fact while KEEPING the plan-time
  // snapshot intact, and asserts that the execution-time check refuses with the
  // NAMED code for that fact. That is what makes "the snapshot is not current
  // fact" a checked property rather than a comment.

  /** A FRESH observation that MATCHES the finalized envelope exactly. */
  async function freshMatch(plan: Awaited<ReturnType<typeof build>>, over: Partial<R97ExecutionObservationV1> = {}): Promise<R97ExecutionObservationV1> {
    const a = plan.authorization!;
    return {
      now: NOW,
      armShas: { baseline: a.arms.baseline.sha, candidate: a.arms.candidate.sha },
      armDigests: {
        baseline: a.arms.baseline.executionPlanDigest,
        candidate: a.arms.candidate.executionPlanDigest,
      },
      armBuildDigests: {
        baseline: a.arms.baseline.buildDigest ?? null,
        candidate: a.arms.candidate.buildDigest ?? null,
      },
      caseFingerprints: { ...a.caseFingerprints },
      providerId: a.providerId,
      modelId: a.modelId,
      endpointIdentity: a.endpointIdentity,
      driverBuildDigest: a.driverBuildDigest!,
      expandedPlanDigest: plan.planDigest!,
      ...over,
    };
  }

  async function check(plan: Awaited<ReturnType<typeof build>>, over: Partial<R97ExecutionObservationV1> = {}) {
    return checkExecutionObservationV1({ plan, observed: await freshMatch(plan, over) });
  }

  it("1. a freshly observed set of facts that MATCHES the envelope passes with ok:true and NO codes", async () => {
    const plan = await build();
    expect(plan.status).toBe("FINALIZED_AUTHORIZATION_PLAN");
    const result = await check(plan);
    expect(result.issues).toEqual([]);
    expect(result.codes).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("1b. the plan snapshot is HISTORY for review, and `observation` is the SAME object as `planObservation`", async () => {
    // The split is only meaningful if the two names cannot describe different
    // worlds: `observation` is the back-compat alias the driver reads, and
    // `planObservation` is the review snapshot. A divergence between them would
    // reintroduce exactly the two-sources-of-truth defect F5 names.
    const plan = await build();
    expect(plan.planObservation).not.toBeNull();
    expect(plan.observation).toBe(plan.planObservation);
    // The check API takes NO snapshot argument at all: there is no parameter a
    // caller could fill from `plan.planObservation`, so "compare the envelope
    // against its own snapshot" is unrepresentable rather than discouraged.
    const drift = await check(plan, { caseFingerprints: { ...plan.authorization!.caseFingerprints } });
    expect(drift.ok).toBe(true);
  });

  // ---- 2. Each drift code fires IN ISOLATION ------------------------------

  it("2a. EXEC_OBS_ARM_SHA_DRIFT fires alone when one arm's HEAD moved", async () => {
    const plan = await build();
    const r = await check(plan, {
      armShas: { baseline: "9".repeat(40), candidate: plan.authorization!.arms.candidate.sha },
    });
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(["EXEC_OBS_ARM_SHA_DRIFT"]);
    expect(r.issues.join(" ")).toContain('arm "baseline"');
    expect(r.issues.join(" ")).toContain("sourceSha");
  });

  it("2b. EXEC_OBS_ARM_PLAN_DIGEST_DRIFT fires alone when an arm's real dry-run digest changed", async () => {
    const plan = await build();
    const r = await check(plan, {
      armDigests: { baseline: plan.authorization!.arms.baseline.executionPlanDigest, candidate: "9".repeat(64) },
    });
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(["EXEC_OBS_ARM_PLAN_DIGEST_DRIFT"]);
    expect(r.issues.join(" ")).toContain('arm "candidate"');
    expect(r.issues.join(" ")).toContain("executionPlanDigest");
  });

  it("2c. EXEC_OBS_CASE_DRIFT fires for ONE case and NAMES that case id", async () => {
    const plan = await build();
    const approved = plan.authorization!.caseIds;
    // Change exactly ONE case's content, leaving every other fact matching.
    const changed = approved[2]!;
    const drifted = { ...plan.authorization!.caseFingerprints, [changed]: "7".repeat(64) };
    const r = await check(plan, { caseFingerprints: drifted });
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(["EXEC_OBS_CASE_DRIFT"]);
    // The refusal must identify the OFFENDING CASE, not merely say "a case drifted".
    expect(r.issues.join(" ")).toContain(changed);
    expect(r.issues.join(" ")).toContain("fingerprint");
    // And it must NOT name any other case.
    for (const other of approved.filter((id) => id !== changed)) {
      expect(r.issues.join(" ")).not.toContain(other);
    }
  });

  it("2c2. a case approved but NOT observed is EXEC_OBS_CASE_MISSING, not a silent skip", async () => {
    const plan = await build();
    const dropped = plan.authorization!.caseIds[0]!;
    const partial = { ...plan.authorization!.caseFingerprints };
    delete partial[dropped];
    const r = await check(plan, { caseFingerprints: partial });
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(["EXEC_OBS_CASE_MISSING"]);
    expect(r.issues.join(" ")).toContain(dropped);
  });

  it("2d. EXEC_OBS_IDENTITY_DRIFT fires alone for a changed provider id", async () => {
    const plan = await build();
    const r = await check(plan, { providerId: "some-other-provider" });
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(["EXEC_OBS_IDENTITY_DRIFT"]);
    expect(r.issues.join(" ")).toContain("providerId");
  });

  it("2e. EXEC_OBS_IDENTITY_DRIFT fires alone for a changed model id", async () => {
    const plan = await build();
    const r = await check(plan, { modelId: "gpt-4o" });
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(["EXEC_OBS_IDENTITY_DRIFT"]);
    expect(r.issues.join(" ")).toContain("modelId");
  });

  it("2f. EXEC_OBS_IDENTITY_DRIFT fires alone for a changed endpoint identity", async () => {
    const plan = await build();
    const r = await check(plan, { endpointIdentity: "d".repeat(64) });
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(["EXEC_OBS_IDENTITY_DRIFT"]);
    expect(r.issues.join(" ")).toContain("endpointIdentity");
  });

  it("2g. EXEC_OBS_DRIVER_BUILD_DRIFT fires alone when the driver's BYTES changed under an unchanged version label", async () => {
    // The measured defect: `driverVersion` is a human label that does not move
    // when the code changes, so a rewritten driver passed every check. The build
    // digest is derived from the executor's bytes and is bound beside the label.
    const plan = await build();
    expect(plan.authorization!.driverVersion).toBe(plan.driverVersion);
    expect(plan.authorization!.driverBuildDigest).toBe(plan.driverBuildDigest);
    const r = await check(plan, { driverBuildDigest: "0".repeat(64) });
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(["EXEC_OBS_DRIVER_BUILD_DRIFT"]);
    expect(r.issues.join(" ")).toContain("driverBuildDigest");
  });

  it("2h. EXEC_OBS_PLAN_DIGEST_MISMATCH fires alone for a changed expanded plan digest", async () => {
    const plan = await build();
    const r = await check(plan, { expandedPlanDigest: "1".repeat(64) });
    expect(r.ok).toBe(false);
    // Reported twice: the reported expansion disagrees with BOTH the approved
    // label and the envelope's own recomputation. Same named code either way.
    expect(new Set(r.codes)).toEqual(new Set(["EXEC_OBS_PLAN_DIGEST_MISMATCH"]));
    expect(r.issues.join(" ")).toContain("planDigest");
  });

  it("2h2. a top-level-digest-only edit cannot pass: the label and the BODY must agree", async () => {
    // §R100 怎么做: "拒绝只改顶层digest的对象." Rewriting `planDigest` alone leaves
    // the envelope body describing a different plan, and the check recomputes the
    // digest FROM THE BODY.
    const plan = await build();
    const forged = { ...plan, planDigest: "2".repeat(64) };
    const r = await checkExecutionObservationV1({ plan: forged, observed: await freshMatch(plan, { expandedPlanDigest: "2".repeat(64) }) });
    expect(r.ok).toBe(false);
    expect(r.codes).toContain("EXEC_OBS_PLAN_DIGEST_MISMATCH");
  });

  // ---- 3. Expiry / not-yet-valid / unreadable clock ------------------------

  it("3a. EXEC_OBS_EXPIRED refuses a plan whose validity window has passed", async () => {
    const plan = await build({ createdAt: CREATED, validityDays: 1 });
    const r = await check(plan, { now: "2030-01-02T00:00:00.000Z" });
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(["EXEC_OBS_EXPIRED"]);
    expect(r.issues.join(" ")).toContain("expiresAt");
    expect(r.issues.join(" ")).toMatch(/expiry is never extended/);
  });

  it("3b. EXEC_OBS_NOT_YET_VALID refuses a plan whose window has not started", async () => {
    const plan = await build({ createdAt: "2030-01-01T00:00:00.000Z" });
    const r = await check(plan, { now: "2026-09-18T00:00:00.000Z" });
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(["EXEC_OBS_NOT_YET_VALID"]);
    expect(r.issues.join(" ")).toContain("createdAt");
  });

  it("3c. an unreadable execution clock is refused, never treated as inside the window", async () => {
    const plan = await build();
    const r = await check(plan, { now: "not-a-timestamp" });
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(["EXEC_OBS_TIME_INVALID"]);
  });

  // ---- 4. A TAMPERED SELECTION FILE is refused when the plan module loads it

  it("4. a selection whose case list was edited while keeping the OLD digest is REFUSED", async () => {
    // Plan §R100 怎么做: "验证冻结selection内容与digest，不能只读取 parsed.digest 当真."
    // The tampered file is written into a TEMP directory; the committed evidence
    // file under docs/ is never modified.
    const { mkdtemp, rm, writeFile, mkdir, cp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "r97-sel-"));
    try {
      const raw = JSON.parse(await readFile(join(REPO, "docs", "evidence", "e4-r87-case-selection.json"), "utf8")) as {
        cases: Array<{ id: string }>;
        digest: string;
      };
      const originalDigest = raw.digest;
      // Swap the last case for a different one, leaving `digest` UNCHANGED — the
      // exact "swap after binding" attack the freeze exists to stop.
      raw.cases[raw.cases.length - 1] = { ...raw.cases[raw.cases.length - 1], id: "regression/not-a-frozen-case" } as { id: string };

      await mkdir(join(dir, "docs", "evidence"), { recursive: true });
      await writeFile(join(dir, "docs", "evidence", "e4-r87-case-selection.json"), JSON.stringify(raw, null, 2), "utf8");
      // The case files must exist for the loader to get as far as the digest
      // check on a NON-tampered run; copy the benchmark tree.
      await cp(join(REPO, "benchmarks"), join(dir, "benchmarks"), { recursive: true });

      await expect(loadR97FrozenSelection(dir)).rejects.toMatchObject({ code: "SELECTION_DIGEST_MISMATCH" });
      // And the refusal NAMES both digests, so a reader can see what changed.
      await expect(loadR97FrozenSelection(dir)).rejects.toThrow(/recomputed selection digest .* != the committed digest/s);

      // Control: the SAME tampered file with a CORRECTLY recomputed digest now
      // fails a DIFFERENT check (the swapped-in case does not exist on disk),
      // proving the digest check is what caught the first one.
      const { canonicalDigestV1 } = await import("./r97-plan.js");
      const { digest: _drop, ...payload } = raw;
      void originalDigest;
      const reDigested = { ...payload, digest: canonicalDigestV1(payload) };
      await writeFile(join(dir, "docs", "evidence", "e4-r87-case-selection.json"), JSON.stringify(reDigested, null, 2), "utf8");
      await expect(loadR97FrozenSelection(dir)).rejects.toMatchObject({ code: "SELECTION_CASE_UNREADABLE" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("4b. the committed frozen selection still VERIFIES against its own digest", async () => {
    // The control that makes test 4 meaningful: the real evidence file is honest.
    const sel = await loadR97FrozenSelection(REPO);
    expect(sel.caseIds.length).toBe(8);
    expect(sel.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  // ---- 5. The case inventory carries the TRUE suite, and is DIGEST-COVERED --

  it("5a. the case inventory labels the two stress/* cases `stress`, NOT `regression`", async () => {
    // Plan §R100 怎么做: "mixed-suite 用显式 case inventory 保留真实 suite，不能悄悄将
    // stress 全重标 regression 再宣称完全相同实验."
    const plan = await build();
    const inventory = plan.authorization!.caseInventory!;
    expect(inventory.length).toBe(plan.authorization!.caseIds.length);

    const stressCases = plan.authorization!.caseIds.filter((id) => id.startsWith("stress/"));
    const regressionCases = plan.authorization!.caseIds.filter((id) => id.startsWith("regression/"));
    // The frozen selection spans TWO suites — this is the premise of the test.
    expect(stressCases.length).toBe(2);
    expect(regressionCases.length).toBe(6);

    for (const id of stressCases) {
      const entry = inventory.find((e) => e.caseId === id);
      expect(entry, `inventory must record ${id}`).toBeDefined();
      expect(entry!.suite).toBe("stress");
      expect(entry!.suite).not.toBe("regression");
      // The CLI's single-valued `--suite` adaptation is RECORDED, not erased.
      expect(entry!.plannedUnderSuite).toBe("regression");
      expect(entry!.relabelled).toBe(true);
    }
    for (const id of regressionCases) {
      expect(inventory.find((e) => e.caseId === id)!.suite).toBe("regression");
    }
    // The approval package shows the true suite, so a reader cannot mistake it.
    expect(plan.approvalMarkdown).toContain("mixed-suite");
    expect(plan.approvalMarkdown).toContain("TRUE suite");
    expect(plan.approvalMarkdown).toContain("**stress**");
  });

  it("5b. the inventory is INSIDE the envelope, so relabelling a case moves planDigest", async () => {
    const plan = await build();
    // It is an envelope field — not merely a result field — which is what makes
    // it digest-covered.
    expect(plan.authorization!.caseInventory).toBeDefined();
    const tampered = {
      ...plan.authorization!,
      caseInventory: plan.authorization!.caseInventory!.map((e) =>
        e.caseId.startsWith("stress/") ? { ...e, suite: "regression", relabelled: false } : e,
      ),
    };
    const recomputed = computeR92AuthorizationDigestV1(tampered);
    expect(recomputed).not.toBe(plan.planDigest);
  });

  it("5c. execution-time refuses an inventory that disagrees with the case ids", async () => {
    const plan = await build();
    const relabelled = {
      ...plan.authorization!,
      caseInventory: plan.authorization!.caseInventory!.map((e) =>
        e.caseId.startsWith("stress/") ? { ...e, suite: "regression", relabelled: false } : e,
      ),
    };
    const r = await checkExecutionObservationV1({
      plan: { ...plan, authorization: relabelled, planDigest: computeR92AuthorizationDigestV1(relabelled) },
      observed: await freshMatch(plan, { expandedPlanDigest: computeR92AuthorizationDigestV1(relabelled) }),
    });
    expect(r.ok).toBe(false);
    expect(r.codes).toContain("EXEC_OBS_SUITE_INVENTORY_DRIFT");
    expect(r.issues.join(" ")).toContain("stress/");
  });

  // ---- 6. Every single bound field moves planDigest ------------------------

  it("6. changing ANY single bound envelope field moves planDigest", async () => {
    // Plan §R97 line 229: "更改任意绑定字段后旧审批失效." This extends the D8
    // driverVersion case in `r97-driver-closed-loop.test.ts` to EVERY field the
    // R100 work adds, plus the fields a drift code depends on. A field that does
    // NOT move the digest is decorative: the approval would not cover it.
    const plan = await build();
    const base = plan.authorization!;
    const mutations: Record<string, (a: typeof base) => typeof base> = {
      driverVersion: (a) => ({ ...a, driverVersion: "e4-r97-campaign-driver-v99" }),
      driverBuildDigest: (a) => ({ ...a, driverBuildDigest: "0".repeat(64) }),
      caseInventory: (a) => ({
        ...a,
        caseInventory: a.caseInventory!.map((e, i) => (i === 0 ? { ...e, suite: "adversarial", relabelled: true } : e)),
      }),
      providerId: (a) => ({ ...a, providerId: "other" }),
      modelId: (a) => ({ ...a, modelId: "other" }),
      endpointIdentity: (a) => ({ ...a, endpointIdentity: "f".repeat(64) }),
      caseIds: (a) => ({ ...a, caseIds: [...a.caseIds].reverse() }),
      caseFingerprints: (a) => {
        const first = a.caseIds[0]!;
        return { ...a, caseFingerprints: { ...a.caseFingerprints, [first]: "0".repeat(64) } };
      },
      arms: (a) => ({ ...a, arms: { ...a.arms, baseline: { ...a.arms.baseline, sha: "0".repeat(40) } } }),
      expiresAt: (a) => ({ ...a, expiresAt: "2027-01-01T00:00:00.000Z" }),
      outputDir: (a) => ({ ...a, outputDir: ".ci/elsewhere" }),
    };
    for (const [field, mutate] of Object.entries(mutations)) {
      const recomputed = computeR92AuthorizationDigestV1(mutate(base));
      expect(recomputed, `changing ${field} must move planDigest`).not.toBe(plan.planDigest);
    }
  });

  it("6b. a DRAFT/NOT_READY plan with no envelope is refused by the check, never run", async () => {
    const draft = await build({ baseline: null, candidate: null });
    const r = checkExecutionObservationV1({
      plan: draft,
      observed: {
        now: NOW,
        armShas: { baseline: null, candidate: null },
        armDigests: { baseline: null, candidate: null },
        armBuildDigests: { baseline: null, candidate: null },
        caseFingerprints: {},
        providerId: "openai",
        modelId: "gpt-4o-mini",
        endpointIdentity: ENDPOINT,
        driverBuildDigest: "0".repeat(64),
        expandedPlanDigest: "0".repeat(64),
      },
    });
    expect(r.ok).toBe(false);
    expect(r.codes).toContain("EXEC_OBS_NOT_AUTHORIZED");
  });

  it("6c. the driver build digest is derived from the real dependency closure, not a version label", async () => {
    const d1 = await computeDriverBuildDigestV1(REPO);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic: the same bytes give the same digest.
    expect(await computeDriverBuildDigestV1(REPO)).toBe(d1);
    // The ENTRY set is explicit and small — never the whole workspace. What is
    // large is the closure DERIVED from it, which is the point of E4-R104.
    expect(R97_DRIVER_BUILD_ENTRIES).toContain("scripts/e4/r97-campaign-driver.mjs");
    expect(R97_DRIVER_BUILD_ENTRIES.length).toBeLessThan(10);
    // A missing entry is an error, never a silently smaller covered set.
    await expect(computeDriverBuildDigestV1(join(REPO, "does-not-exist"))).rejects.toThrow(/must never shrink silently/);
  });

  it("6d. the ARM WORKER is inside the driver's derived closure (E4-R99)", async () => {
    // Once the driver routes units through the arm worker, the worker's bytes
    // decide what executes a case. If it were NOT covered, rewriting the worker
    // would leave an old approval valid — the exact defect `driverBuildDigest`
    // exists to close.
    const identity = computeExecutionIdentityV1({ rootDir: REPO, entries: R97_DRIVER_BUILD_ENTRIES });
    expect(identity.schema).toBe(R97_EXECUTION_IDENTITY_SCHEMA);
    expect(identity.entries).toContain("scripts/e4/r97-arm-worker.mjs");
    expect(identity.files.map((f) => f.path)).toContain("scripts/e4/r97-arm-worker.mjs");
    // NEGATIVE CONTROL: changing a covered artifact's BYTES changes the digest.
    // Without this, "the worker is covered" could be true while the digest
    // ignored content entirely.
    const { writeFile, rm } = await import("node:fs/promises");
    const root = await syntheticDriverRoot();
    try {
      const before = await computeDriverBuildDigestV1(root);
      // Rewrite ONLY the worker.
      await writeFile(join(root, "scripts/e4/r97-arm-worker.mjs"), "// a rewritten worker\n");
      expect(await computeDriverBuildDigestV1(root)).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("6e. the digest covers the EXECUTING dist closure — and a src-only edit does NOT move it (E4-R104 / A4)", async () => {
    // Plan §T4 怎么做 9: "当前 driver digest 哈希了若干 src/*.ts，但运行导入的是 dist.
    // 修为构建产物身份或可验证的 source→artifact 映射；仅更改执行 dist 也必须导致旧批准
    // 失效." MEASURED: the old list named `packages/evaluation/src/*.ts`, but every
    // process that runs a campaign imports `packages/evaluation/dist/index.js`. The
    // approved digest therefore described files nobody loaded.
    const identity = computeExecutionIdentityV1({ rootDir: REPO, entries: R97_DRIVER_BUILD_ENTRIES });
    const paths = identity.files.map((f) => f.path);
    expect(paths).toContain("packages/evaluation/dist/index.js");
    expect(paths).toContain("scripts/e4/r97-arm-exec.mjs");
    // Normalized + sorted: the digest must not depend on walk order or on the host
    // path separator.
    expect([...paths].sort()).toEqual(paths);
    for (const p of paths) expect(p).not.toContain("\\");
    // A SOURCE file is NOT what the driver imports, so it is not covered. Plan §A4
    // 怎么验收: "只改 src 不误报为'执行了新源码'."
    expect(paths.some((p) => p.startsWith("packages/evaluation/src/"))).toBe(false);
    // The identity is still BOUNDED — plan §R100: "不搞整个工作区不可控hash".
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(identity.externals.length).toBeGreaterThan(0);
    expect(identity.externals).toContain("node:fs");

    const { writeFile, rm } = await import("node:fs/promises");

    // ---- (a) a change to the EXECUTING dist moves the digest. ------------
    const distRoot = await syntheticDriverRoot();
    try {
      const before = await computeDriverBuildDigestV1(distRoot);
      await writeFile(join(distRoot, "packages/evaluation/dist/index.js"), "// a rebuilt executor\n");
      expect(
        await computeDriverBuildDigestV1(distRoot),
        "changing the executing dist alone must invalidate the old approval",
      ).not.toBe(before);
    } finally {
      await rm(distRoot, { recursive: true, force: true }).catch(() => {});
    }

    // ---- (b) a SOURCE-only edit is NOT an execution change. --------------
    const srcRoot = await syntheticDriverRoot();
    try {
      const before = await computeDriverBuildDigestV1(srcRoot);
      await writeFile(join(srcRoot, "packages/evaluation/src/r97-plan.ts"), "// an edited source, never rebuilt\n");
      expect(
        await computeDriverBuildDigestV1(srcRoot),
        "a source-only edit must NOT be reported as a change to what executes",
      ).toBe(before);
    } finally {
      await rm(srcRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // E4-R104 (A4) — the covered set is DERIVED, not enumerated by hand.
  // -------------------------------------------------------------------------
  //
  // MEASURED DEFECT F4 (plan §A4): the driver's covered set was a hand-written
  // nine-name list. Every module the driver reaches through
  // `packages/evaluation/dist/index.js` — the budget channel, the campaign
  // lifecycle, the authorization gate — was outside it, so patching one of those
  // left `driverBuildDigest` byte-identical and the old approval valid.
  //
  // The tests below use a SYNTHETIC root whose import graph has the same SHAPE as
  // the real one. The real repo is not used for the mutation tests because a
  // faithful copy of the real closure would have to recreate the workspace
  // `node_modules/@ar/*` links, and a link that still pointed at the real repo
  // would be testing that repo rather than the copy. Coverage of the REAL closure
  // is asserted separately, against `REPO`, in 6d/6e/6f.
  async function syntheticDriverRoot(): Promise<string> {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "r104-synthetic-driver-"));
    const files: Record<string, string> = {
      // The barrel re-exports the modules that really run a campaign. This is the
      // hop the old file list could not see.
      "packages/evaluation/dist/index.js": [
        'export * from "./r97-budget-channel.js";',
        'export * from "./r97-campaign-lifecycle.js";',
        "",
      ].join("\n"),
      "packages/evaluation/dist/r97-budget-channel.js": "export const channel = 1;\n",
      "packages/evaluation/dist/r97-campaign-lifecycle.js": "export const lifecycle = 1;\n",
      "scripts/e4/r97-campaign-driver.mjs": [
        'import "../../packages/evaluation/dist/index.js";',
        "export const driver = 1;",
        "",
      ].join("\n"),
      "scripts/e4/r97-arm-worker.mjs": "export const worker = 1;\n",
      "scripts/e4/r97-arm-exec.mjs": "export const exec = 1;\n",
      // The child runner the worker SPAWNS. Nothing IMPORTS it — it is named only
      // as a path argument to `spawn` — so the import graph cannot reach it. It is
      // present here so the N2 test can mutate its bytes in isolation.
      "scripts/e4/r97-arm-child-runner.mjs": "export const runner = 1;\n",
      // The reviewed SOURCE. Nothing imports it, so it is outside the identity.
      "packages/evaluation/src/r97-plan.ts": "// the reviewed source, never imported by the driver\n",
    };
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, ...rel.split("/"));
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content);
    }
    return root;
  }

  it("6f. a driver-loaded module that NO hand-written list names is inside the digest", async () => {
    // `packages/evaluation/dist/r97-budget-channel.js` is reached only through the
    // `./r97-budget-channel.js` specifier inside `dist/index.js`. A file list can
    // miss it; an import graph cannot.
    const identity = computeExecutionIdentityV1({ rootDir: REPO, entries: R97_DRIVER_BUILD_ENTRIES });
    const paths = identity.files.map((f) => f.path);
    for (const rel of [
      "packages/evaluation/dist/r97-budget-channel.js",
      "packages/evaluation/dist/r97-campaign-lifecycle.js",
      "packages/evaluation/dist/r92-authorization.js",
      // The security and tool-execution surfaces the acceptance criteria name.
      "packages/security/dist/index.js",
    ]) {
      expect(paths, `${rel} must be inside the driver's execution identity`).toContain(rel);
    }

    const { writeFile, rm } = await import("node:fs/promises");
    const root = await syntheticDriverRoot();
    try {
      const before = await computeDriverBuildDigestV1(root);
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      await writeFile(join(root, "packages/evaluation/dist/r97-budget-channel.js"), "// a patched budget channel\n");
      expect(
        await computeDriverBuildDigestV1(root),
        "patching a module the driver really loads must invalidate the old approval",
      ).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("6g. a driver dependency that cannot be resolved makes the digest NOT ESTABLISHED", async () => {
    // Fail closed: a missing dependency must be a REFUSAL, never a digest over the
    // files that happen to remain — a silently smaller covered set is exactly what
    // the digest exists to prevent.
    const { rm } = await import("node:fs/promises");
    const root = await syntheticDriverRoot();
    try {
      expect(await computeDriverBuildDigestV1(root)).toMatch(/^[0-9a-f]{64}$/);
      await rm(join(root, "packages/evaluation/dist/r97-budget-channel.js"));
      await expect(computeDriverBuildDigestV1(root)).rejects.toThrow(/r97-budget-channel/);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("6h. the child runner the ARM WORKER SPAWNS is inside the driver identity (N2 / F2)", async () => {
    // FINDING F2 (plan §N2). The worker runs every case in a SEPARATE process by
    // spawning `ARM_CHILD_RUNNER_REL` = scripts/e4/r97-arm-child-runner.mjs. That
    // path is a bare STRING handed to `spawn`, NOT an ESM import, so the static
    // import walker that derives the closure could not see it. With the runner
    // outside `R97_DRIVER_BUILD_ENTRIES`, editing its bytes left `driverBuildDigest`
    // byte-identical and an OLD approval kept running the MODIFIED script.
    const identity = computeExecutionIdentityV1({ rootDir: REPO, entries: R97_DRIVER_BUILD_ENTRIES });
    const paths = identity.files.map((f) => f.path);
    expect(
      paths,
      "the spawned child runner must be inside the driver's execution identity",
    ).toContain("scripts/e4/r97-arm-child-runner.mjs");

    // It is the file that is REALLY spawned, not a bystander: the covered path is
    // bound to the worker's own spawn boundary, so the test cannot be satisfied by
    // covering some unrelated file with the same name.
    const { readFile, writeFile, stat, utimes, rm } = await import("node:fs/promises");
    const workerSrc = await readFile(join(REPO, "scripts", "e4", "r97-arm-worker.mjs"), "utf8");
    expect(workerSrc).toMatch(
      /ARM_CHILD_RUNNER_REL\s*=\s*join\(\s*"scripts",\s*"e4",\s*"r97-arm-child-runner\.mjs"\s*\)/,
    );
    expect(workerSrc).toMatch(/spawn\(\s*process\.execPath,\s*\[\s*join\(repoRoot,\s*ARM_CHILD_RUNNER_REL\)/);

    // SAME LENGTH + SAME mtime, DIFFERENT bytes: only the content changes, so a
    // digest that still matched would be proving size/mtime rather than the bytes
    // that execute.
    const root = await syntheticDriverRoot();
    try {
      const target = join(root, "scripts", "e4", "r97-arm-child-runner.mjs");
      const before = await computeDriverBuildDigestV1(root);
      const original = await readFile(target, "utf8");
      const st = await stat(target);
      const mutated = original.replace("1", "2");
      expect(mutated.length, "the mutation must not change the file SIZE").toBe(original.length);
      await writeFile(target, mutated, "utf8");
      await utimes(target, st.atime, st.mtime);
      expect(
        await computeDriverBuildDigestV1(root),
        "editing the spawned child runner must invalidate the old approval",
      ).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }

    // DELETION is a REFUSAL, never a digest over the files that remain.
    const root2 = await syntheticDriverRoot();
    try {
      await rm(join(root2, "scripts", "e4", "r97-arm-child-runner.mjs"));
      await expect(computeDriverBuildDigestV1(root2)).rejects.toThrow(/r97-arm-child-runner/);
    } finally {
      await rm(root2, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ===========================================================================
// E4-R104 (A4) — THE FORMAL PATH BINDS THE ARM'S EXECUTED BYTES.
// ===========================================================================
//
// MEASURED DEFECT F4, formal-path half (plan §A4 做什么 3):
//
//   "明确旧摘要合同的处理；新合同需要重新生成批准材料."
//
// WHAT WAS STILL WRONG AFTER THE FIRST A4 ROUND. The build identity was derived
// correctly and the WORKER refused a mismatched `approvedBuildDigest` — but only
// where a caller opted in, because the formal envelope had no slot for the value
// and the driver never passed it. Measured (`a4/probe-optin.log`):
//
//   J1        namesBuildDigest=true,  ledgerCreated=false
//   J3_OMITTED      refusalFired=false
//   J4_EMPTY_STRING refusalFired=false
//   J5_WHITESPACE   refusalFired=false
//
// i.e. the omitted / empty / whitespace spellings of the field were all silently
// read as "no opinion" instead of as an unbound identity. A plan could therefore
// be approved with nothing at all binding the bytes that run a case — and because
// `dist/` is gitignored (`.gitignore:2`), neither `sha` nor `executionPlanDigest`
// could notice a rebuilt executor.
//
// The tests below are the three halves of the fix:
//   1. the FORMAL plan REFUSES to finalize when an arm binds no build digest;
//   2. an approval that binds one is REFUSED at execution time when the bytes
//      move — with the sha and the plan digest both deliberately unchanged, which
//      is exactly the rebuilt-dist case;
//   3. the refusal happens with NO provider call, so a changed build cannot cost
//      anything before it is caught.
describe("E4-R104 (A4): the formal plan binds the arm's EXECUTED bytes", () => {
  const NEW_BUILD_CODE = "ARM_BUILD_UNBOUND";

  it("1. REFUSES to finalize an arm that binds no EXECUTION build digest", async () => {
    // The formal layer is where the binding is MANDATORY. An arm whose closure
    // could not be established has `buildDigest: null`, and the plan must say so
    // rather than approve material that covers no bytes.
    for (const spelling of [null, ""] as const) {
      const pair = await observedPair({ buildDigest: spelling });
      const plan = await buildR97AuthorizationPlan({
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
      });
      expect(plan.status, `buildDigest ${JSON.stringify(spelling)} must not finalize`).not.toBe(
        "FINALIZED_AUTHORIZATION_PLAN",
      );
      expect(plan.authorizable).toBe(false);
      expect(plan.planDigest).toBeNull();
      const codes = plan.readinessIssues.map((i) => i.code);
      expect(codes, `buildDigest ${JSON.stringify(spelling)} must be refused by name`).toContain(NEW_BUILD_CODE);
      expect(plan.readinessIssues.map((i) => i.detail).join(" ")).toMatch(/build digest/i);
    }
  });

  it("1b. the refusal NAMES the arm, so an operator knows which checkout to rebuild", async () => {
    const pair = await observedPair({}, { buildDigest: null });
    const plan = await buildR97AuthorizationPlan({
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
    });
    const details = plan.readinessIssues.filter((i) => i.code === NEW_BUILD_CODE).map((i) => i.detail);
    expect(details).toHaveLength(1);
    expect(details[0]).toContain('arm "candidate"');
  });

  it("2. a fully-observed pair binds the digest PER ARM and FINALIZES", async () => {
    // The positive half: with both builds established the plan finalizes, and the
    // two arms carry DIFFERENT build digests — one shared value would hide an arm.
    const plan = await build();
    expect(plan.status).toBe("FINALIZED_AUTHORIZATION_PLAN");
    expect(plan.readinessIssues).toEqual([]);
    const a = plan.authorization!;
    expect(a.arms.baseline.buildDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.arms.candidate.buildDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.arms.baseline.buildDigest).not.toBe(a.arms.candidate.buildDigest);
    // It is a REAL envelope field, so it is covered by the approved digest.
    const moved = computeR92AuthorizationDigestV1({
      ...a,
      arms: { ...a.arms, baseline: { ...a.arms.baseline, buildDigest: "0".repeat(64) } },
    });
    expect(moved).not.toBe(plan.planDigest);
  });

  it("3. REFUSES at execution time when the arm's BYTES moved, with sha and plan digest UNCHANGED", async () => {
    // This is the exact rebuilt-`dist` case. `dist/` is gitignored, so the sha and
    // the git-derived plan digest are both byte-identical while the code that runs
    // a case has changed. Only the build digest can see it.
    const plan = await build();
    const a = plan.authorization!;
    const r = checkExecutionObservationV1({
      plan,
      observed: {
        now: NOW,
        armShas: { baseline: a.arms.baseline.sha, candidate: a.arms.candidate.sha },
        armDigests: {
          baseline: a.arms.baseline.executionPlanDigest,
          candidate: a.arms.candidate.executionPlanDigest,
        },
        armBuildDigests: {
          baseline: a.arms.baseline.buildDigest!,
          // The executor was rebuilt: same commit, same plan, different bytes.
          candidate: "9".repeat(64),
        },
        caseFingerprints: { ...a.caseFingerprints },
        providerId: a.providerId,
        modelId: a.modelId,
        endpointIdentity: a.endpointIdentity,
        driverBuildDigest: a.driverBuildDigest!,
        expandedPlanDigest: plan.planDigest!,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(["EXEC_OBS_ARM_BUILD_DRIFT"]);
    expect(r.issues.join(" ")).toContain('arm "candidate"');
    expect(r.issues.join(" ")).toContain("buildDigest");
  });

  it("4. REFUSES an arm whose build digest could NOT be established at execution time", async () => {
    // `null` is "the closure could not be established in that checkout" — drift,
    // never a skip. A missing dependency must not read as an unchanged build.
    const plan = await build();
    const a = plan.authorization!;
    const r = checkExecutionObservationV1({
      plan,
      observed: {
        now: NOW,
        armShas: { baseline: a.arms.baseline.sha, candidate: a.arms.candidate.sha },
        armDigests: {
          baseline: a.arms.baseline.executionPlanDigest,
          candidate: a.arms.candidate.executionPlanDigest,
        },
        armBuildDigests: { baseline: a.arms.baseline.buildDigest!, candidate: null },
        caseFingerprints: { ...a.caseFingerprints },
        providerId: a.providerId,
        modelId: a.modelId,
        endpointIdentity: a.endpointIdentity,
        driverBuildDigest: a.driverBuildDigest!,
        expandedPlanDigest: plan.planDigest!,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(["EXEC_OBS_ARM_BUILD_DRIFT"]);
    expect(r.issues.join(" ")).toMatch(/could not be established/);
  });

  it("5. REFUSES an approval that binds NO build digest, naming regeneration", async () => {
    // The execution-time half of (1): an envelope that predates this contract must
    // be regenerated, not run. Reached when material was written by an older
    // builder or edited; the code names the remedy rather than a generic drift.
    const plan = await build();
    const a = plan.authorization!;
    const stale = {
      ...plan,
      authorization: {
        ...a,
        arms: {
          baseline: { ...a.arms.baseline, buildDigest: undefined },
          candidate: a.arms.candidate,
        },
      } as typeof a,
    };
    const r = checkExecutionObservationV1({
      plan: stale,
      observed: {
        now: NOW,
        armShas: { baseline: a.arms.baseline.sha, candidate: a.arms.candidate.sha },
        armDigests: {
          baseline: a.arms.baseline.executionPlanDigest,
          candidate: a.arms.candidate.executionPlanDigest,
        },
        armBuildDigests: {
          baseline: a.arms.baseline.buildDigest!,
          candidate: a.arms.candidate.buildDigest!,
        },
        caseFingerprints: { ...a.caseFingerprints },
        providerId: a.providerId,
        modelId: a.modelId,
        endpointIdentity: a.endpointIdentity,
        driverBuildDigest: a.driverBuildDigest!,
        // The stale body is internally consistent, so the plan-digest check is
        // satisfied and ONLY the build binding is missing.
        expandedPlanDigest: computeR92AuthorizationDigestV1({
          ...a,
          arms: { baseline: { ...a.arms.baseline, buildDigest: undefined }, candidate: a.arms.candidate } as typeof a.arms,
        } as typeof a),
      },
    });
    expect(r.ok).toBe(false);
    expect(r.codes).toContain("EXEC_OBS_ARM_BUILD_UNBOUND");
    expect(r.issues.join(" ")).toMatch(/regenerated/);
  });

  it("6. the shared ARM build contract derives the SAME digest the worker records", async () => {
    // Plan §A4 怎么做 5: "让计划生成、执行前复核、worker record 和 evidence 使用同一身份
    // 合同." One contract, one value: the exported `computeArmBuildDigestV1` is what
    // the plan, the driver's re-observation and the worker all call, so they cannot
    // drift into describing different builds.
    const { computeArmBuildDigestV1, R97_ARM_BUILD_ENTRIES } = await import("./r97-plan.js");
    expect(typeof computeArmBuildDigestV1).toBe("function");
    // The declared entries are the real barrels the offline executor loads; the
    // closure derived from them is a superset of any hand-written list.
    expect(R97_ARM_BUILD_ENTRIES).toContain("apps/cli/dist/benchmark-command.js");
    expect(R97_ARM_BUILD_ENTRIES).toContain("packages/core/dist/index.js");
    expect(R97_ARM_BUILD_ENTRIES).toContain("packages/evaluation/dist/index.js");
  });
});

