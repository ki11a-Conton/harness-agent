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
  loadR97FrozenSelection,
  parseR97ArmObservation,
  r97ReadinessIssues,
  R97_DRIVER_ARTIFACTS,
  R97_DRAFT_SCHEMA,
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

  it("6c. the driver build digest is derived from the enumerated artifacts, not a version label", async () => {
    const d1 = await computeDriverBuildDigestV1(REPO);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic: the same bytes give the same digest.
    expect(await computeDriverBuildDigestV1(REPO)).toBe(d1);
    // The covered set is explicit and small — never the whole workspace.
    expect(R97_DRIVER_ARTIFACTS).toContain("scripts/e4/r97-campaign-driver.mjs");
    expect(R97_DRIVER_ARTIFACTS.length).toBeLessThan(10);
    // A missing artifact is an error, never a silently smaller covered set.
    await expect(computeDriverBuildDigestV1(join(REPO, "does-not-exist"))).rejects.toThrow(/must never shrink silently/);
  });
});
