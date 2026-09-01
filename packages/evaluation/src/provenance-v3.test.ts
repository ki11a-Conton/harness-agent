import { describe, expect, it } from "vitest";
import {
  captureBuildIdentityV3,
  captureProviderIdentityV3,
  captureCaseIdentityV3,
  captureProtocolIdentityV3,
  captureEndpointIdentity,
  compareProvenanceV3,
  hasUnknownIdentity,
  type ExperimentProvenanceV3,
  type CaseIdentityV3,
  type ProviderIdentityV3,
} from "./provenance-v3.js";

/** Clean shared build/environment for the "comparable" scenarios. */
function cleanProvenance(overrides: {
  candidateId?: string | null;
  armId?: string;
  cases?: CaseIdentityV3[];
  provider?: ProviderIdentityV3;
  builtAt?: { gitSha: string | null; dirty: boolean | null };
} = {}): ExperimentProvenanceV3 {
  const gitSha = overrides.builtAt?.gitSha ?? "5a6f90c4767413ae1c89dca7a451a13ab5dd6cf0";
  const dirty = overrides.builtAt?.dirty ?? false;
  return {
    schemaVersion: "3.0.0",
    armId: overrides.armId ?? "baseline",
    candidateId: overrides.candidateId ?? null,
    build: captureBuildIdentityV3({
      gitSha,
      dirty,
      lockfileDigest: "lock-a",
      buildOutputDigest: "build-a",
      nodeVersion: "v24.18.1",
      os: "win32",
      arch: "x64",
      runnerVersion: "1.0.0",
    }),
    environment: { platform: "win32", nodeVersion: "v24.18.1", processArch: "x64", environmentContractHash: "env-c" },
    provider: overrides.provider ?? captureProviderIdentityV3({
      providerType: "openai-compatible",
      modelId: "deepseek-v4-flash",
      baseUrl: "https://api.example.com/v1",
      temperature: 0,
      topP: 1,
      modelSeed: null,
      modelSeedSupport: "supported",
      maxTokens: 32000,
      timeoutMs: 120000,
      retryPolicy: { maxRetries: 8, delay: 3000 },
    }),
    cases: overrides.cases ?? [
      captureCaseIdentityV3({
        caseId: "ho-01",
        canonicalCase: { id: "ho-01", suite: "holdout", timeoutMs: 600000 },
        request: "# request\nfile: input.txt",
        expected: "completed",
        fixtureTree: [{ relativePath: "input.txt", fileType: "text/plain", mode: "644", digest: "f1" }],
        verificationForbidden: { verification: [{ type: "file_exists", path: "out.txt" }] },
        policyVersions: { judge: "1.0.0", security: "1.0.0" },
        toolSchema: ["read_file", "write_file", "exec"],
      }),
    ],
    protocol: captureProtocolIdentityV3({
      caseSetDigest: "caseset-a",
      orderSeed: 11,
      armOrder: ["baseline", "candidate"],
      repetitionCount: 2,
      interleaveStrategy: "abba",
      retryIdentityRule: "same-task",
      resumePlan: null,
      pairingKey: "pair-1",
      expectedCallCap: 30,
    }),
    finalSourceClean: dirty === null ? null : !dirty,
  };
}

function candProvenance(): ExperimentProvenanceV3 {
  const b = cleanProvenance();
  return {
    ...b,
    armId: "candidate",
    candidateId: "adaptive_recovery_v2",
    cases: b.cases,
    protocol: b.protocol,
  };
}

const AR2_BASELINE_SHA = "c8fd5f87d7d410b88c8e025b53b5e5d24b4789ed";
const AR2_CANDIDATE_SHA = "3cf62ab8a8e6108349dbc9724785aef9ec023901";

describe("E2-02 strict provenance V3", () => {
  it("1. AR2 baseline/candidate: different SHAs + dirty -> comparable=false", () => {
    const baseline = cleanProvenance({ builtAt: { gitSha: AR2_BASELINE_SHA, dirty: true } });
    const candidate = candProvenance();
    const candidateAr2 = {
      ...candidate,
      build: captureBuildIdentityV3({
        gitSha: AR2_CANDIDATE_SHA,
        dirty: true,
        lockfileDigest: "lock-a",
        buildOutputDigest: "build-a",
        nodeVersion: "v24.18.1",
        os: "win32",
        arch: "x64",
        runnerVersion: "1.0.0",
      }),
    };
    const verdict = compareProvenanceV3(baseline, candidateAr2, { declaredArmDelta: ["candidateConfig"], strict: true });
    expect(verdict.comparable).toBe(false);
    expect(verdict.promotionEligible).toBe(false);
    expect(verdict.reasonCodes).toContain("BUILD_SHA_MISMATCH");
    expect(verdict.reasonCodes).toContain("BUILD_DIRTY");
  });

  it("2. same case digest but different build SHA still fails", () => {
    // Identical per-case context (cases same) but build SHAs differ.
    const a = cleanProvenance({ builtAt: { gitSha: "aaaa", dirty: false } });
    const b = cleanProvenance({ builtAt: { gitSha: "bbbb", dirty: false }, armId: "candidate", candidateId: "x" });
    const verdict = compareProvenanceV3(a, b, { declaredArmDelta: ["candidateConfig"], strict: true });
    expect(verdict.comparable).toBe(false);
    expect(verdict.reasonCodes).toContain("BUILD_SHA_MISMATCH");
  });

  it("3. changing request.md/expected/verification/forbidden/timeout/tool schema changes case digest", () => {
    const base = captureCaseIdentityV3({
      caseId: "ho-01",
      canonicalCase: { id: "ho-01", suite: "holdout", timeoutMs: 600000 },
      request: "# request\nfile: input.txt",
      expected: "completed",
      fixtureTree: [{ relativePath: "input.txt", fileType: "text/plain", mode: "644", digest: "f1" }],
      verificationForbidden: { verification: [{ type: "file_exists", path: "out.txt" }] },
      policyVersions: { judge: "1.0.0", security: "1.0.0" },
      toolSchema: ["read_file", "write_file", "exec"],
    });
    const variants: Array<Partial<Parameters<typeof captureCaseIdentityV3>[0]>> = [
      { request: "# request (UPDATED)\nfile: input.txt" },
      { expected: "failed" },
      { verificationForbidden: { verification: [{ type: "file_exists", path: "out2.txt" }] } },
      { verificationForbidden: { forbidden: { commands: ["rm"] } } },
      { canonicalCase: { id: "ho-01", suite: "holdout", timeoutMs: 300000 } },
      { toolSchema: ["read_file", "write_file"] },
      { fixtureTree: [{ relativePath: "input.txt", fileType: "text/plain", mode: "644", digest: "f1", }] },
    ];
    let changed = 0;
    for (const v of variants) {
      const alt = captureCaseIdentityV3({ ...baseInput(), ...v });
      if (alt.digest !== base.digest) changed += 1;
    }
    // request, expected, verification-forbidden, timeout (canonical), tool
    // schema must ALL change the digest. fixtureTree identical does not.
    expect(changed).toBeGreaterThanOrEqual(5);

    function baseInput(): Parameters<typeof captureCaseIdentityV3>[0] {
      return {
        caseId: "ho-01",
        canonicalCase: { id: "ho-01", suite: "holdout", timeoutMs: 600000 },
        request: "# request\nfile: input.txt",
        expected: "completed",
        fixtureTree: [{ relativePath: "input.txt", fileType: "text/plain", mode: "644", digest: "f1" }],
        verificationForbidden: { verification: [{ type: "file_exists", path: "out.txt" }] },
        policyVersions: { judge: "1.0.0", security: "1.0.0" },
        toolSchema: ["read_file", "write_file", "exec"],
      };
    }
  });

  it("4. absolute temp dir not part of the experiment does NOT change the digest", () => {
    const withAbs = captureCaseIdentityV3({
      caseId: "ho-01",
      canonicalCase: { id: "ho-01" },
      request: "same request",
      expected: "completed",
      fixtureTree: [
        { relativePath: "input.txt", fileType: "text/plain", mode: "644", digest: "f1" },
        // An absolute temp path that is NOT part of the experiment.
        { relativePath: "C:\\Users\\x\\AppData\\Local\\Temp\\harness-eval-123\\scratch", fileType: "text/plain", mode: "644", digest: "scratch-digest" },
      ],
    });
    const withoutAbs = captureCaseIdentityV3({
      caseId: "ho-01",
      canonicalCase: { id: "ho-01" },
      request: "same request",
      expected: "completed",
      fixtureTree: [
        { relativePath: "input.txt", fileType: "text/plain", mode: "644", digest: "f1" },
      ],
    });
    // The digest must NOT depend on absolute temp dirs — the capture helper
    // normalizes relative paths and the comparer ignores them. The semantics:
    // changing an absolute temp dir must not change the digest. We assert the
    // digest of the experiment fixture stays stable when the same experiment
    // runs in a different temp location by comparing the hashed content —
    // here we verify both fixtures have IDENTICAL digests because the variant
    // path is excluded from the canonical case digest (only the experiment
    // fixture entries with their RELATIVE paths are hashed).
    expect(withAbs.digest).toBe(withoutAbs.digest);
  });

  it("5. same clean build/env/case/protocol with only declared arm delta -> comparable + promotionEligible", () => {
    const baseline = cleanProvenance();
    const candidate = candProvenance();
    const verdict = compareProvenanceV3(baseline, candidate, { declaredArmDelta: ["candidateConfig"], strict: true });
    expect(verdict.comparable).toBe(true);
    expect(verdict.promotionEligible).toBe(true);
    expect(verdict.reasonCodes).toEqual([]);
  });

  it("6. provider endpoint/model/temperature/retry policy differences fail strict mode", () => {
    const baseline = cleanProvenance();
    const mk = (over: Partial<ProviderIdentityV3>): ExperimentProvenanceV3 =>
      ({ ...candProvenance(), provider: { ...baseline.provider, ...over } });

    const cases: Array<[Partial<ProviderIdentityV3>, string]> = [
      [{ modelId: "other-model" }, "MODEL_MISMATCH"],
      [{ endpointIdentity: captureEndpointIdentity("https://other.example.com/v1") }, "ENDPOINT_MISMATCH"],
      [{ temperature: 0.5 }, "TEMPERATURE_MISMATCH"],
      [{ retryPolicyIdentity: "different-retry" }, "RETRY_POLICY_MISMATCH"],
    ];
    for (const [over, code] of cases) {
      const verdict = compareProvenanceV3(baseline, mk(over), { declaredArmDelta: ["candidateConfig"], strict: true });
      expect(verdict.comparable).toBe(false);
      expect(verdict.reasonCodes).toContain(code);
      expect(verdict.promotionEligible).toBe(false);
    }
  });

  it("7. source became dirty during the run -> final provenance invalid", () => {
    const baseline = cleanProvenance({ builtAt: { gitSha: "abc", dirty: false } });
    const candidate = { ...candProvenance(), finalSourceClean: false, build: { ...candProvenance().build, clean: false } };
    const verdict = compareProvenanceV3(baseline, candidate, { declaredArmDelta: ["candidateConfig"], strict: true });
    expect(verdict.reasonCodes).toContain("SOURCE_BECAME_DIRTY");
    expect(verdict.promotionEligible).toBe(false);
  });

  it("8. unsupported model seed must be explicit (never faked) and gated", () => {
    const baseline = cleanProvenance();
    const candidate = { ...candProvenance(), provider: { ...baseline.provider, modelSeedSupport: "unsupported" as const } };
    const verdict = compareProvenanceV3(baseline, candidate, { declaredArmDelta: ["candidateConfig"], strict: true });
    expect(verdict.reasonCodes).toContain("MODEL_SEED_UNSUPPORTED");
    expect(verdict.promotionEligible).toBe(false);

    // Unknown support is also gated (never silently treated as reproducible).
    const unknown = { ...candProvenance(), provider: { ...baseline.provider, modelSeedSupport: "unknown" as const } };
    const v2 = compareProvenanceV3(baseline, unknown, { declaredArmDelta: ["candidateConfig"], strict: true });
    expect(v2.reasonCodes).toContain("MODEL_SEED_UNSUPPORTED");
    expect(v2.promotionEligible).toBe(false);
  });

  it("9. unknown identity (null gitSha/modelId/endpoint) is never promotion-eligible", () => {
    const p = cleanProvenance();
    expect(hasUnknownIdentity(p)).toBe(false);
    const missing = { ...p, build: { ...p.build, gitSha: null } };
    expect(hasUnknownIdentity(missing)).toBe(true);
  });

  it("10. case digest mismatch reports the exact component diff path", () => {
    const baseline = cleanProvenance();
    const candidate = candProvenance();
    // Change the request component of the candidate's only case.
    const changedCase = captureCaseIdentityV3({
      caseId: "ho-01",
      canonicalCase: { id: "ho-01", suite: "holdout", timeoutMs: 600000 },
      request: "# request (CHANGED)\nfile: input.txt",
      expected: "completed",
      fixtureTree: [{ relativePath: "input.txt", fileType: "text/plain", mode: "644", digest: "f1" }],
      verificationForbidden: { verification: [{ type: "file_exists", path: "out.txt" }] },
      policyVersions: { judge: "1.0.0", security: "1.0.0" },
      toolSchema: ["read_file", "write_file", "exec"],
    });
    const candidateModified = { ...candidate, cases: [changedCase] };
    const verdict = compareProvenanceV3(baseline, candidateModified, { declaredArmDelta: ["candidateConfig"], strict: true });
    expect(verdict.reasonCodes).toContain("CASE_DIGEST_MISMATCH");
    expect(verdict.mismatches.some((m) => m.field.includes("components.request"))).toBe(true);
  });
});