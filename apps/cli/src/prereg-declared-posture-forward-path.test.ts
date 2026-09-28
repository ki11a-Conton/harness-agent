/**
 * R16 — CAN A *DECLARED* POSTURE RESTORE A RELEASE-CLI FIXTURE FORWARD RUN?
 *
 * R1 made the SHIPPED release CLI refuse a marker-only fixture campaign before any
 * request (`FIXTURE_TRANSPORT_NOT_NON_BILLABLE`), and that refusal is CORRECT: no
 * marker, env var or CLI flag may grant a fixture bypass. R5 then built the right
 * primitive — a DECLARED `trusted-build`/`no-os-network-sandbox` posture carried in
 * the digest-bound pre-registration, with a Symbol-branded grant that cannot
 * survive JSON/env. R16 asked whether that posture can restore a genuine
 * RELEASE-CLI FORWARD RUN. The answer is NO, and this suite pins both halves
 * SEPARATELY so the negative is never read as "the declared mode is broken":
 *
 *   THE DECLARED POSTURE IS REAL AND WIRED (through the SHIPPED composition root)
 *   ----------------------------------------------------------------------------
 *   1. `createProductionPreregRunner()` — the exact adapter `preregCommandDeps()`
 *      builds, with NO fixture capability and NO grant — RUNS an arm to a
 *      `passed` outcome under a DECLARED `trusted-build` posture, with ZERO
 *      provider calls. The declared mode is honored by the release wiring.
 *   2. The SAME runner refuses the SAME checkouts when the posture is NOT
 *      declared: `EGRESS_ISOLATION_UNAVAILABLE`, 0 calls. Untrusted stays
 *      untrusted; a marker-only tree is never admitted.
 *
 *   BUT IT DOES NOT LICENSE A FIXTURE TRANSPORT (so POS-FWD stays a refusal)
 *   ----------------------------------------------------------------------
 *   3. The posture is DIGEST-BOUND: `isolation` is part of the canonical source
 *      body, so declaring it MOVES `preregistrationDigest`, and an approval
 *      written for the `process-exec` artifact is then refused
 *      `AUTHORIZATION_DIGEST_MISMATCH` with 0 provider-factory calls. Changing the
 *      declared posture invalidates the approval.
 *   4. A fixture authorization over the trusted-build artifact is STILL refused
 *      `FIXTURE_TRANSPORT_NOT_NON_BILLABLE` — the binding blocker is the transport
 *      admission class, which never reads `isolation`. The CONTROL runs the same
 *      artifact WITH the injected branded capability and is ADMITTED, proving the
 *      capability (not the posture) is what admits, and that the only way to give
 *      the release CLI one would be an env/flag/file bypass — forbidden.
 *
 * R1 INVARIANTS PRESERVED: nothing here constructs a capability from JSON, env or a
 * marker; the brands stay module-private; and (2) keeps `EGRESS_ISOLATION_UNAVAILABLE`
 * for an untrusted checkout.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProvider } from "@ar/contracts";
import {
  DEFAULT_DECISION_POLICY_V3,
  FIXTURE_MODE_SYNTHETIC_OFFLINE,
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
  buildToolCallEfficiencyPreregistrationV2,
  computeThresholdDigestV3,
  createNonBillableFixtureTransport,
  mechanismContractFor,
  openPreregisteredCampaignGate,
  serializePreregistrationV2,
  stableStringify,
  toolCallEfficiencyGuidanceDigest,
  type PreregCatalogEntryV2,
  type PreregisteredCampaignObservationV2,
  type PreregistrationV2Options,
  type ToolCallEfficiencyPreregistrationV2,
} from "@ar/evaluation";
import {
  EGRESS_ISOLATION_UNAVAILABLE,
  TRUSTED_BUILD_BACKEND_ID,
  TRUSTED_BUILD_STRENGTH,
} from "./prereg-arm-executor.js";
import { createProductionPreregRunner } from "./prereg-production-runner.js";

const REPO_ROOT = process.cwd();
const FROZEN_CASE = "reg-12-csv-parse";
/** A loopback address used ONLY as an identity string; no request is made to it. */
const LOOPBACK_ENDPOINT = "http://127.0.0.1:45999/v1";

const TRUSTED = { isolationBackendId: TRUSTED_BUILD_BACKEND_ID, isolationStrength: TRUSTED_BUILD_STRENGTH };
const UNDECLARED = { isolationBackendId: "process-exec", isolationStrength: "process" };

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** A provider that counts every model call, so "refused before the provider" and
 *  "ran without a provider call" are MEASURED zeros, not assumptions. */
function countingProvider(id: string): { provider: ModelProvider; calls: () => number } {
  let calls = 0;
  return {
    provider: {
      id,
      async listModels() {
        return [];
      },
      createClient() {
        return {
          async *generate() {
            calls += 1;
            yield { type: "text_delta", text: "should never be reached", timestamp: 0 };
            yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
          },
        };
      },
    },
    calls: () => calls,
  };
}

const dirs: string[] = [];
async function tempDir(tag: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), `r16-${tag}-`));
  dirs.push(d);
  return d;
}

const COMMON_ENTRIES = [
  "apps/cli/dist/main.js",
  "apps/cli/dist/benchmark-command.js",
  "packages/model/dist/index.js",
  "packages/core/dist/index.js",
  "packages/evaluation/dist/index.js",
];

/**
 * A minimal arm tree whose DECLARED closure resolves and which is a CLEAN git work
 * tree at a 40-hex HEAD, so R5's audited checks are exercised for real. `probe`
 * makes the two arms differ.
 */
async function makeStubArm(dir: string, opts: { probe: string }): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), `${JSON.stringify({ name: `r16-arm-${opts.probe}`, private: true, type: "module" }, null, 2)}\n`, "utf8");
  for (const rel of COMMON_ENTRIES) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    const body =
      rel === "apps/cli/dist/benchmark-command.js"
        ? [
            `export const R97_ARM_PROBE = ${JSON.stringify(opts.probe)};`,
            "export async function runOneCase(caseDef, opts, suite) {",
            "  void opts;",
            "  return {",
            "    caseId: caseDef.id,",
            '    status: "passed",',
            '    actualStatus: "passed",',
            "    events: [],",
            "    metrics: { turn_count: 0, tool_call_count: 0, tokens_input: 3, tokens_output: 2, context_tokens: 0, compaction_count: 0, duration_ms: 0, retry_count: 0, verification_failures: 0, human_interventions: 0, estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 0 },",
            "    violations: [],",
            "    suite: suite,",
            '    judgeVersion: "r16-stub-judge",',
            "  };",
            "}",
          ].join("\n")
        : `export const R16_STUB = ${JSON.stringify(`${rel}:${opts.probe}`)};`;
    await writeFile(abs, `${body}\n`, "utf8");
  }
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=r16", "-c", "user.email=r16@local", "commit", "-q", "-m", `stub arm ${opts.probe}`]);
}

/**
 * Drive the SHIPPED composition root exactly as the release CLI does:
 * `preregCommandDeps()` is `{ runner: createProductionPreregRunner() }` — NO
 * fixture capability, NO trusted-build grant.
 */
async function runThroughShippedRunner(input: {
  baselineDir: string;
  candidateDir: string;
  isolation: { isolationBackendId: string; isolationStrength: string };
  evidenceDir: string;
}): Promise<{ status: string | null; refused: string | null; calls: number }> {
  const counted = countingProvider("r16-counting");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    R97_ARM_BASELINE_DIR: input.baselineDir,
    R97_ARM_CANDIDATE_DIR: input.candidateDir,
  };
  delete env["R97_ARM_REQUIRE_GIT"];
  const runner = createProductionPreregRunner({ rootDir: REPO_ROOT, env });
  try {
    const outcome = await runner.runArm(
      { armId: "baseline", caseId: FROZEN_CASE, repetition: 0, orderIndex: 0 },
      {
        provider: counted.provider,
        armRunId: `r16-pair-${FROZEN_CASE}-0-baseline`,
        arm: { armId: "baseline", caseId: FROZEN_CASE, repetition: 0, orderIndex: 0 },
        preregistrationDigest: "a".repeat(64),
        planDigest: "b".repeat(64),
        isolation: input.isolation,
        evidenceDir: input.evidenceDir,
      } as never,
    );
    return { status: outcome.status, refused: null, calls: counted.calls() };
  } catch (err) {
    return {
      status: null,
      refused: (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err)),
      calls: counted.calls(),
    };
  }
}

// ---------------------------------------------------------------------------
// The pre-registration the gate validates: one build, two postures
// ---------------------------------------------------------------------------

const CASE_IDS = ["reg-01", "reg-02", "reg-06", "reg-08", "adv-03", "adv-07", "st-02", "st-05"];
const REQUEST_PROFILE = { budgetTokens: 32000, stallPolicy: "default" };

const CATALOG: PreregCatalogEntryV2[] = CASE_IDS.map((caseId) => ({
  caseId,
  suite: "regression",
  contentDigest: `content-${caseId}`,
  eligibilityDigest: `elig-${caseId}`,
  holdout: false,
  eligible: true,
}));

function preregOptions(
  isolation: { isolationBackendId: string; isolationStrength: string },
): PreregistrationV2Options {
  return {
    subject: {
      candidateSourceSha: "a".repeat(40),
      baselineArmDigest: "baseline-arm-digest",
      candidateArmDigest: "candidate-arm-digest",
      cleanTreePolicy: "require-clean",
      runtimeConfigDigest: "runtime-config-digest",
    },
    candidateId: TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
    provider: { providerId: "deepseek", modelId: "deepseek-v4-flash", endpointBaseUrl: LOOPBACK_ENDPOINT, requestProfile: REQUEST_PROFILE },
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
      maxUsdMicros: null,
      pricingUnknownPolicy: "refuse",
    },
    isolation: {
      driverSchema: "r97-driver-v1",
      workerSchema: "r97-worker-v1",
      isolationBackendId: isolation.isolationBackendId,
      isolationStrength: isolation.isolationStrength,
      resumeStateSchema: "r97-execution-state-v1",
    },
  };
}

/** The observation the gate compares the artifact against. */
function observationFor(a: ToolCallEfficiencyPreregistrationV2): PreregisteredCampaignObservationV2 {
  const caseContentDigests: Record<string, string> = {};
  const eligibilityDigests: Record<string, string> = {};
  for (const c of a.dataset.cases) {
    caseContentDigests[c.caseId] = c.contentDigest;
    eligibilityDigests[c.caseId] = c.eligibilityDigest;
  }
  return {
    candidateSourceSha: a.subject.candidateSourceSha,
    cleanTree: true,
    baselineArmDigest: a.subject.baselineArmDigest,
    candidateArmDigest: a.subject.candidateArmDigest,
    guidanceDigest: toolCallEfficiencyGuidanceDigest(),
    contractDigest: sha(stableStringify(mechanismContractFor(TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2))),
    runtimeConfigDigest: a.subject.runtimeConfigDigest,
    providerId: a.provider.providerId,
    modelId: a.provider.modelId,
    endpointDigest: a.provider.endpointDigest,
    endpointIsLoopback: true,
    requestProfileDigest: sha(stableStringify(REQUEST_PROFILE)),
    caseContentDigests,
    eligibilityDigests,
    selectionProvenanceDigest: a.dataset.selectionProvenanceDigest,
    decisionPolicyDigest: computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3),
    usdMicrosPerCall: null,
  } as unknown as PreregisteredCampaignObservationV2;
}

function fixtureAuthorizationFor(a: ToolCallEfficiencyPreregistrationV2, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: "tool-call-efficiency-authorization-v2",
    preregistrationDigest: a.preregistrationDigest,
    candidateSourceSha: a.subject.candidateSourceSha,
    baselineArmDigest: a.subject.baselineArmDigest,
    candidateArmDigest: a.subject.candidateArmDigest,
    providerId: a.provider.providerId,
    modelId: a.provider.modelId,
    endpointDigest: a.provider.endpointDigest,
    caps: {
      maxModelCalls: a.budget.campaignWorstCaseModelCalls,
      maxToolCalls: a.budget.maxToolCalls,
      maxDurationMs: a.budget.maxDurationMs,
      maxInputTokens: a.budget.maxInputTokens,
      maxOutputTokens: a.budget.maxOutputTokens,
      maxTotalTokens: a.budget.maxTotalTokens,
      maxUsdMicros: a.budget.maxUsdMicros,
    },
    issuedAtMs: 1_000,
    expiresAtMs: 9_000_000_000_000,
    approvalId: "r16-fixture-approval",
    allowResume: false,
    paid: false,
    fixtureMode: FIXTURE_MODE_SYNTHETIC_OFFLINE,
    ...over,
  });
}

const PREVIOUS_CLAIMS_DIR = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
beforeEach(async () => {
  process.env["R97_CAMPAIGN_CLAIMS_DIR"] = await mkdtemp(join(tmpdir(), "r16-claims-"));
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  if (PREVIOUS_CLAIMS_DIR === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
  else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = PREVIOUS_CLAIMS_DIR;
});

// ---------------------------------------------------------------------------
// The declared posture IS wired into the SHIPPED composition root
// ---------------------------------------------------------------------------

describe("R16 — the DECLARED trusted-build posture through the SHIPPED release wiring", () => {
  it("[R16.1] the shipped production runner RUNS an arm under a DECLARED posture, with zero fixture capability", async () => {
    const work = await tempDir("declared");
    const a = join(work, "arm-a");
    const b = join(work, "arm-b");
    await makeStubArm(a, { probe: "declared-a" });
    await makeStubArm(b, { probe: "declared-b" });
    const r = await runThroughShippedRunner({
      baselineDir: a,
      candidateDir: b,
      isolation: TRUSTED,
      evidenceDir: join(work, "evidence"),
    });
    // `createProductionPreregRunner()` is handed NO fixture capability and NO
    // grant, exactly as `preregCommandDeps()` builds it. The declared mode is
    // self-proving, so the run reaches the shipped worker and passes.
    expect(r.refused).toBeNull();
    expect(r.status).toBe("passed");
    expect(r.calls).toBe(0);
  });

  it("[R16.2] the SAME shipped runner refuses the SAME checkouts when NO posture is declared", async () => {
    const work = await tempDir("undeclared");
    const a = join(work, "arm-a");
    const b = join(work, "arm-b");
    await makeStubArm(a, { probe: "undeclared-a" });
    await makeStubArm(b, { probe: "undeclared-b" });
    const r = await runThroughShippedRunner({
      baselineDir: a,
      candidateDir: b,
      isolation: UNDECLARED,
      evidenceDir: join(work, "evidence"),
    });
    expect(r.refused).toBe(EGRESS_ISOLATION_UNAVAILABLE);
    expect(r.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ...but the posture cannot license the fixture TRANSPORT
// ---------------------------------------------------------------------------

describe("R16 — the declared posture is bound by the approval, and still does not admit a fixture transport", () => {
  it("[R16.3] declaring the posture MOVES the digest, so the old approval is refused AUTHORIZATION_DIGEST_MISMATCH", async () => {
    const processExec = buildToolCallEfficiencyPreregistrationV2(preregOptions(UNDECLARED));
    const trustedBuild = buildToolCallEfficiencyPreregistrationV2(preregOptions(TRUSTED));

    // The posture is VISIBLE in the digest-bound artifact...
    expect(processExec.isolation.isolationBackendId).toBe("process-exec");
    expect(trustedBuild.isolation.isolationBackendId).toBe(TRUSTED_BUILD_BACKEND_ID);
    expect(trustedBuild.isolation.isolationStrength).toBe(TRUSTED_BUILD_STRENGTH);
    // ...and CHANGING it changes the root digest, which is what the approval binds.
    expect(trustedBuild.preregistrationDigest).not.toBe(processExec.preregistrationDigest);

    const counted = countingProvider("r16-factory-probe");
    let factoryCalls = 0;
    const admission = await openPreregisteredCampaignGate({
      preregistrationJson: serializePreregistrationV2(trustedBuild),
      // The approval written for the process-exec artifact.
      authorizationJson: fixtureAuthorizationFor(processExec),
      observation: observationFor(trustedBuild),
      budgetDir: await tempDir("stale-budget"),
      mode: "first-run",
      now: () => 1_700_000_000_000,
      makeProvider: () => {
        factoryCalls += 1;
        return counted.provider;
      },
    });
    expect(admission.status).toBe("REFUSED");
    expect((admission as { code?: string }).code).toBe("AUTHORIZATION_DIGEST_MISMATCH");
    expect(factoryCalls).toBe(0);
    expect(counted.calls()).toBe(0);
  });

  it("[R16.4] a fixture authorization over the trusted-build artifact is STILL refused (and the injected capability is the only thing that admits it)", async () => {
    const trustedBuild = buildToolCallEfficiencyPreregistrationV2(preregOptions(TRUSTED));

    // (a) NO injected capability: the declared posture buys nothing here.
    const counted = countingProvider("r16-no-capability");
    let factoryCalls = 0;
    const refused = await openPreregisteredCampaignGate({
      preregistrationJson: serializePreregistrationV2(trustedBuild),
      authorizationJson: fixtureAuthorizationFor(trustedBuild),
      observation: observationFor(trustedBuild),
      budgetDir: await tempDir("nocap-budget"),
      mode: "first-run",
      now: () => 1_700_000_000_000,
      makeProvider: () => {
        factoryCalls += 1;
        return counted.provider;
      },
    });
    expect(refused.status).toBe("REFUSED");
    expect((refused as { code?: string }).code).toBe("FIXTURE_TRANSPORT_NOT_NON_BILLABLE");
    expect(factoryCalls).toBe(0);
    expect(counted.calls()).toBe(0);

    // (b) CONTROL — the SAME artifact WITH the test host's branded capability is
    // ADMITTED. So the fixture class is gated on the CAPABILITY, not on the
    // posture; and the capability is the one thing a subprocess cannot be given.
    const injected = countingProvider("r16-injected");
    let operatorFactoryCalls = 0;
    const admitted = await openPreregisteredCampaignGate({
      preregistrationJson: serializePreregistrationV2(trustedBuild),
      authorizationJson: fixtureAuthorizationFor(trustedBuild),
      observation: observationFor(trustedBuild),
      budgetDir: await tempDir("cap-budget"),
      mode: "first-run",
      now: () => 1_700_000_000_000,
      makeProvider: () => {
        operatorFactoryCalls += 1;
        throw new Error("FORBIDDEN: the operator's factory must never be entered on the fixture path");
      },
      nonBillableTransport: createNonBillableFixtureTransport({
        endpointBaseUrl: LOOPBACK_ENDPOINT,
        providerId: trustedBuild.provider.providerId,
        modelId: trustedBuild.provider.modelId,
        provider: injected.provider,
      }),
    });
    expect(admitted.status, `code=${(admitted as { code?: string }).code}`).toBe("ADMITTED");
    expect(operatorFactoryCalls).toBe(0);
    expect(injected.calls()).toBe(0);
  });
});
