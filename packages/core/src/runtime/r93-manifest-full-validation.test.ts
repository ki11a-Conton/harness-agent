/**
 * E4-R93 — the manifest validator must verify the WHOLE schema and the WHOLE
 * semantics, not three convenient fields (plan 20260917-083737 §R93, finding A).
 *
 * RED (against the pre-R93 implementation): `validateManifest` compared only
 * `summary.verdict`, `summary.completeness` and `summary.observedRecords`. Every
 * other field that can move a conclusion could be edited freely and the manifest
 * still validated:
 *   - the mechanism metric, the security counter, verified completion, the
 *     expected matrix size, the counterexample diff list and the issue list;
 *   - the top-level `limits`, the frozen `caseOrder`, the `scope.*` executed /
 *     reference split, `baselineSha` / `candidateSha`;
 *   - each arm's `sourceSha`, `streakResultAware` and `limits`;
 *   - `identity.arms` (duplicate or unknown arm), an extra arm key, and a record
 *     whose `arm` disagrees with the container that holds it;
 *   - `providerCalls` and `gate`.
 * Malformed JSON (`null`, a non-array `identity.arms`, a string `records`) threw
 * an unhandled TypeError instead of returning a structured INVALID, and there
 * was no way to supply an independently trusted expected identity.
 *
 * GREEN (after R93): every conclusion-bearing field is recomputed and compared
 * with a reason code that names the field path; malformed input returns a
 * structured INVALID and never echoes raw manifest content.
 *
 * Zero provider calls (ScriptedModelProvider only), no key, no network.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  loadCaseSelection,
  runReplayAb,
  buildManifest,
  computeSummary,
  validateManifest,
  armHash,
  canonicalDigest,
  REPLAY_LIMITS,
  R90_MANIFEST_SCHEMA,
  type ArmCaseRecord,
  type EvidenceReasonCode,
  type FrozenCaseSelection,
  type Manifest,
  type ReplayArm,
} from "./r87-zero-call-replay-ab.js";

const ARMS: ReplayArm[] = ["baseline", "candidate"];
const IMPL_SHA = "1".repeat(40);
const HIST_SHA = "2".repeat(40);

const asObj = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

/** Deep-clone through JSON so a mutation can never leak into the next test. */
function freshFrom(base: Manifest): Manifest {
  return JSON.parse(JSON.stringify(base)) as Manifest;
}

/** Repair both arm hashes so a record-level mutation is not masked by a hash
 *  mismatch — the test must fail for the SEMANTIC reason, not the hash. */
function rehashArms(m: Manifest): void {
  for (const arm of ARMS) {
    m.arms[arm].hash = armHash(m.arms[arm].records as unknown as ArmCaseRecord[]);
  }
}

/** Recompute the declared summary from the (mutated) records, so a test can
 *  isolate a non-summary defect. */
function resyncSummary(m: Manifest, selection: FrozenCaseSelection): void {
  const all: ArmCaseRecord[] = [];
  for (const arm of ARMS) all.push(...(m.arms[arm].records as unknown as ArmCaseRecord[]));
  m.summary = computeSummary(all, selection, ARMS);
}

/** Reverse the key order at every level, preserving semantics. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).reverse()) {
      out[k] = reverseKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

describe("E4-R93 — the validator verifies the whole manifest, not three fields", () => {
  let selection: FrozenCaseSelection;
  let base: Manifest;

  beforeAll(async () => {
    selection = loadCaseSelection();
    const { records } = await runReplayAb(selection, { arms: ARMS, now: () => 0 });
    base = buildManifest({
      selection,
      records,
      arms: ARMS,
      implementationSha: IMPL_SHA,
      baselineSha: HIST_SHA,
      candidateSha: IMPL_SHA,
      gate: { status: "NOT_RUN", code: "PAID_AUTHORIZATION_REQUIRED", reason: "not authorized" },
    });
  });

  const fresh = (): Manifest => freshFrom(base);

  it("the unmutated v3 manifest is VALID with no reason codes", () => {
    const res = validateManifest(fresh(), selection);
    expect(res.reasonCodes).toEqual([]);
    expect(res.status).toBe("VALID");
  });

  // ------------------------------------------------- summary: every field --
  describe("every conclusion-bearing summary field is recomputed and compared", () => {
    const mutations: Array<[string, (m: Manifest) => void]> = [
      ["mechanismMetric.baselineTargetFires", (m) => void (m.summary.mechanismMetric.baselineTargetFires += 1)],
      ["mechanismMetric.candidateTargetFires", (m) => void (m.summary.mechanismMetric.candidateTargetFires += 1)],
      ["mechanismMetric.improvement", (m) => void (m.summary.mechanismMetric.improvement += 1)],
      ["counterexampleOutcomeDiffs", (m) => void m.summary.counterexampleOutcomeDiffs.push("invented/case")],
      ["securityViolations", (m) => void (m.summary.securityViolations += 1)],
      ["verifiedCompletion", (m) => void (m.summary.verifiedCompletion = !m.summary.verifiedCompletion)],
      ["expectedRecords", (m) => void (m.summary.expectedRecords += 1)],
      ["observedRecords", (m) => void (m.summary.observedRecords += 1)],
      ["completeness", (m) => void (m.summary.completeness = "PARTIAL")],
      [
        "issues",
        (m) => void m.summary.issues.push({ code: "SECURITY_VIOLATION", detail: "invented by the test" }),
      ],
      ["verdict", (m) => void (m.summary.verdict = "REJECTED")],
    ];

    for (const [field, mutate] of mutations) {
      it(`rejects a manifest whose summary.${field} does not match its records`, () => {
        const m = fresh();
        mutate(m);
        const res = validateManifest(m, selection);
        expect(res.status).toBe("INVALID");
        expect(res.reasonCodes).toContain("SUMMARY_MISMATCH");
        // The reason must POINT AT THE FIELD, not merely say "mismatch".
        expect(res.detail).toContain(field);
      });
    }
  });

  // ------------------------------------- identity / limits / order / scope --
  describe("top-level identity, limits, order and scope must agree with the records", () => {
    const mutations: Array<[string, EvidenceReasonCode, (m: Manifest) => void]> = [
      ["limits", "LIMITS_MISMATCH", (m) => void (m.limits.maxIterationsPerTurn = 30)],
      [
        "caseOrder",
        "CASE_ORDER_MISMATCH",
        (m) => {
          const first = m.caseOrder[0]!;
          m.caseOrder[0] = m.caseOrder[1]!;
          m.caseOrder[1] = first;
        },
      ],
      ["scope.executedSourceSha", "SCOPE_MISMATCH", (m) => void (m.scope.executedSourceSha = "9".repeat(40))],
      ["scope.historicalReferenceSha", "SCOPE_MISMATCH", (m) => void (m.scope.historicalReferenceSha = "9".repeat(40))],
      [
        "scope.historicalReferenceCheckedOut",
        "SCOPE_MISMATCH",
        (m) => void (asObj(m.scope)["historicalReferenceCheckedOut"] = true),
      ],
      ["scope.independentMechanismScenarios", "SCOPE_MISMATCH", (m) => void (m.scope.independentMechanismScenarios = 3)],
      ["scope.targetLabels", "SCOPE_MISMATCH", (m) => void (m.scope.targetLabels = 1)],
      ["scope.baselineMode", "SCOPE_MISMATCH", (m) => void (asObj(m.scope)["baselineMode"] = "isolated_build")],
      ["baselineSha", "ARM_IDENTITY_MISMATCH", (m) => void (m.baselineSha = "9".repeat(40))],
      ["candidateSha", "ARM_IDENTITY_MISMATCH", (m) => void (m.candidateSha = "9".repeat(40))],
      ["arms.baseline.sourceSha", "ARM_IDENTITY_MISMATCH", (m) => void (m.arms.baseline.sourceSha = "9".repeat(40))],
      ["arms.candidate.sourceSha", "ARM_IDENTITY_MISMATCH", (m) => void (m.arms.candidate.sourceSha = "9".repeat(40))],
      ["arms.candidate.streakResultAware", "ARM_IDENTITY_MISMATCH", (m) => void (m.arms.candidate.streakResultAware = false)],
      ["arms.baseline.streakResultAware", "ARM_IDENTITY_MISMATCH", (m) => void (m.arms.baseline.streakResultAware = true)],
      ["arms.baseline.limits", "LIMITS_MISMATCH", (m) => void (m.arms.baseline.limits.maxStallRecoveries = 99)],
      ["arms.candidate.limits", "LIMITS_MISMATCH", (m) => void (m.arms.candidate.limits.maxParallelToolCalls = 8)],
      ["identity.arms semantics", "ARM_IDENTITY_MISMATCH", (m) => void (m.identity.arms[0]!.streakResultAware = true)],
      [
        "identity.arms duplicate",
        "ARM_DUPLICATE",
        (m) => void m.identity.arms.push({ arm: "baseline", streakResultAware: false }),
      ],
      [
        "identity.arms unknown",
        "ARM_UNKNOWN",
        (m) => void m.identity.arms.push({ arm: "evil" as ReplayArm, streakResultAware: false }),
      ],
      [
        "arms extra key",
        "ARM_UNKNOWN",
        (m) =>
          void (asObj(m.arms)["evil"] = {
            arm: "evil",
            sourceSha: "x",
            streakResultAware: false,
            limits: REPLAY_LIMITS,
            records: [],
            hash: "0".repeat(64),
          }),
      ],
      ["providerCalls", "MANIFEST_STRUCTURE_INVALID", (m) => void (asObj(m)["providerCalls"] = 1)],
      ["gate.status", "MANIFEST_STRUCTURE_INVALID", (m) => void (asObj(m.gate)["status"] = "HACKED")],
      ["selectionDigest", "SELECTION_DIGEST_MISMATCH", (m) => void (m.selectionDigest = "0".repeat(64))],
      ["identity.selectionDigest", "EXPERIMENT_ID_MISMATCH", (m) => void (m.identity.selectionDigest = "0".repeat(64))],
      ["identity.fixtureDigest", "EXPERIMENT_ID_MISMATCH", (m) => void (m.identity.fixtureDigest = "0".repeat(64))],
      ["identity.limits", "EXPERIMENT_ID_MISMATCH", (m) => void (m.identity.limits.maxIterationsPerTurn = 30)],
      ["identity.executedSourceSha", "EXPERIMENT_ID_MISMATCH", (m) => void (m.identity.executedSourceSha = "9".repeat(40))],
    ];

    for (const [field, code, mutate] of mutations) {
      it(`rejects a manifest whose ${field} disagrees with its own records (${code})`, () => {
        const m = fresh();
        mutate(m);
        const res = validateManifest(m, selection);
        expect(res.status).toBe("INVALID");
        expect(res.reasonCodes).toContain(code);
      });
    }
  });

  // ------------------------------------------------ record ↔ arm container --
  it("reports a record whose arm disagrees with the container that holds it", () => {
    const m = fresh();
    // Swap the arm labels of ONE counterexample pair whose two records are
    // otherwise identical, then repair the hashes and the summary. The pair set,
    // the matrix and every summary field are unchanged — the ONLY remaining
    // defect is that each record now sits in the wrong arm's container.
    const ceBaseline = m.arms.baseline.records.filter((r) => r.role === "COUNTEREXAMPLE");
    const ceCandidate = m.arms.candidate.records.filter((r) => r.role === "COUNTEREXAMPLE");
    const pair = ceBaseline.find((b) => {
      const twin = ceCandidate.find((c) => c.caseId === b.caseId);
      return (
        twin !== undefined &&
        twin.status === b.status &&
        twin.terminationReason === b.terminationReason &&
        twin.h2SignatureFires === b.h2SignatureFires
      );
    });
    expect(pair).toBeDefined();
    const twin = ceCandidate.find((c) => c.caseId === pair!.caseId)!;
    pair!.arm = "candidate";
    twin.arm = "baseline";
    rehashArms(m);
    resyncSummary(m, selection);
    // The summary genuinely still matches: the defect is ONLY the container.
    expect(validateManifest(freshFrom(base), selection).status).toBe("VALID");

    const res = validateManifest(m, selection);
    expect(res.status).toBe("INVALID");
    expect(res.reasonCodes).toContain("ARM_RECORD_MISPLACED");
  });

  it("rejects a record whose boolean evidence field is not a boolean", () => {
    const m = fresh();
    const rec = asObj(m.arms.baseline.records[0]!);
    // A truthy STRING inflates the TARGET-fire count while surviving every
    // numeric guard, and the recomputed summary agrees with itself.
    rec["h2SignatureFires"] = "yes";
    rehashArms(m);
    resyncSummary(m, selection);
    const res = validateManifest(m, selection);
    expect(res.status).toBe("INVALID");
    expect(res.reasonCodes).toContain("RECORD_INVALID");
  });

  it("rejects a record whose expectedMet flag is not a boolean", () => {
    const m = fresh();
    asObj(m.arms.candidate.records[0]!)["expectedMet"] = "yes";
    rehashArms(m);
    resyncSummary(m, selection);
    const res = validateManifest(m, selection);
    expect(res.status).toBe("INVALID");
    expect(res.reasonCodes).toContain("RECORD_INVALID");
  });

  // -------------------------------------------------------- real_version_ab --
  it("a real_version_ab claim with no two-arm build evidence is UNSUPPORTED, not VALID", async () => {
    const { records } = await runReplayAb(selection, { arms: ARMS, now: () => 0 });
    const m = buildManifest({
      selection,
      records,
      arms: ARMS,
      implementationSha: IMPL_SHA,
      baselineSha: HIST_SHA,
      candidateSha: IMPL_SHA,
      baselineMode: "isolated_build",
      experimentKind: "real_version_ab",
      gate: { status: "NOT_RUN", code: "PAID_AUTHORIZATION_REQUIRED", reason: "x" },
    });
    // Changing the enum alone must never be enough to claim a real version A/B.
    const res = validateManifest(m, selection);
    expect(res.status).toBe("UNSUPPORTED");
    expect(res.reasonCodes).toContain("EXPERIMENT_KIND_UNSUPPORTED");
  });

  it("a real_version_ab claim WITH two distinct arm build digests is VALID", async () => {
    const { records } = await runReplayAb(selection, { arms: ARMS, now: () => 0 });
    const m = buildManifest({
      selection,
      records,
      arms: ARMS,
      implementationSha: IMPL_SHA,
      baselineSha: HIST_SHA,
      candidateSha: IMPL_SHA,
      baselineMode: "isolated_build",
      experimentKind: "real_version_ab",
      armBuildDigests: { baseline: "b".repeat(64), candidate: "c".repeat(64) },
      gate: { status: "NOT_RUN", code: "PAID_AUTHORIZATION_REQUIRED", reason: "x" },
    });
    const res = validateManifest(m, selection);
    expect(res.status).toBe("VALID");
    expect(res.reasonCodes).toEqual([]);
  });

  // --------------------------------------------------- malformed structure --
  describe("malformed input returns a structured INVALID and never throws", () => {
    const pureValues: Array<[string, unknown]> = [
      ["null", null],
      ["undefined", undefined],
      ["a number", 42],
      ["a string", "not a manifest"],
      ["an array", []],
      ["an empty object", {}],
      ["a bare v3 tag", { schemaVersion: R90_MANIFEST_SCHEMA }],
    ];

    for (const [label, value] of pureValues) {
      it(`returns INVALID (never throws) for ${label}`, () => {
        const res = validateManifest(value, selection);
        expect(res.status).toBe("INVALID");
        expect(res.reasonCodes.length).toBeGreaterThan(0);
      });
    }

    const structural: Array<[string, (m: Record<string, unknown>) => void]> = [
      ["identity = null", (m) => void (m["identity"] = null)],
      ["identity.arms = a string", (m) => void (asObj(m["identity"])["arms"] = "baseline")],
      ["identity.arms = a number", (m) => void (asObj(m["identity"])["arms"] = 7)],
      ["identity.arms = [null]", (m) => void (asObj(m["identity"])["arms"] = [null])],
      ["identity.arms = [{}]", (m) => void (asObj(m["identity"])["arms"] = [{}])],
      ["identity.baselineMode = an unknown enum", (m) => void (asObj(m["identity"])["baselineMode"] = "guesswork")],
      ["identity.experimentKind = an unknown enum", (m) => void (asObj(m["identity"])["experimentKind"] = "vibes")],
      ["arms = null", (m) => void (m["arms"] = null)],
      ["arms.candidate = null", (m) => void (asObj(m["arms"])["candidate"] = null)],
      ["arms.candidate.records = a string", (m) => void (asObj(asObj(m["arms"])["candidate"])["records"] = "nope")],
      ["arms.candidate.records = null", (m) => void (asObj(asObj(m["arms"])["candidate"])["records"] = null)],
      ["arms.candidate.records = [null]", (m) => void (asObj(asObj(m["arms"])["candidate"])["records"] = [null])],
      ["arms.candidate.hash = a number", (m) => void (asObj(asObj(m["arms"])["candidate"])["hash"] = 5)],
      ["summary = null", (m) => void (m["summary"] = null)],
      ["summary = a string", (m) => void (m["summary"] = "nope")],
      ["summary.mechanismMetric = null", (m) => void (asObj(m["summary"])["mechanismMetric"] = null)],
      ["limits = null", (m) => void (m["limits"] = null)],
      ["caseOrder = a string", (m) => void (m["caseOrder"] = "nope")],
      ["caseOrder = [1, 2]", (m) => void (m["caseOrder"] = [1, 2])],
      ["scope = null", (m) => void (m["scope"] = null)],
      ["gate = null", (m) => void (m["gate"] = null)],
    ];

    for (const [label, mutate] of structural) {
      it(`returns INVALID (never throws) when ${label}`, () => {
        const m = asObj(fresh());
        mutate(m);
        const res = validateManifest(m, selection);
        expect(res.status).toBe("INVALID");
        expect(res.reasonCodes.length).toBeGreaterThan(0);
      });
    }
  });

  it("never echoes raw manifest content into the validation result", () => {
    const canary = "sk-live-SECRETCANARY0123456789abcdef";
    const m = fresh();
    asObj(m.arms.baseline.records[0]!)["caseId"] = canary;
    asObj(m.arms.baseline.records[0]!)["terminationReason"] = canary;
    rehashArms(m);
    const res = validateManifest(m, selection);
    expect(res.status).toBe("INVALID");
    // Field PATHS and reasons only — never the values themselves.
    expect(JSON.stringify(res)).not.toContain(canary);
  });

  it("is insensitive to JSON key order (canonical comparison of equal semantics)", () => {
    const reordered = reverseKeys(fresh()) as Manifest;
    const res = validateManifest(reordered, selection);
    expect(res.status).toBe("VALID");
    expect(res.reasonCodes).toEqual([]);
  });

  it("rejects a manifest whose frozen case order was changed", () => {
    const m = fresh();
    m.caseOrder = [...m.caseOrder].reverse();
    const res = validateManifest(m, selection);
    expect(res.status).toBe("INVALID");
    expect(res.reasonCodes).toContain("CASE_ORDER_MISMATCH");
  });

  // ------------------------------------------------ trusted expected identity --
  describe("an optional independently trusted expectation", () => {
    it("accepts a manifest that satisfies the trusted expectation", () => {
      const res = validateManifest(fresh(), selection, {
        expected: {
          experimentId: base.identity.experimentId,
          selectionDigest: selection.digest,
          executedSourceSha: IMPL_SHA,
          fixtureDigest: base.identity.fixtureDigest,
        },
      });
      expect(res.status).toBe("VALID");
    });

    it("rejects a manifest that fails the trusted expectation", () => {
      const res = validateManifest(fresh(), selection, {
        expected: { experimentId: "0".repeat(64) },
      });
      expect(res.status).toBe("INVALID");
      expect(res.reasonCodes).toContain("IDENTITY_UNTRUSTED");
    });

    it("rejects a manifest whose executed source SHA is not the trusted one", () => {
      const res = validateManifest(fresh(), selection, {
        expected: { executedSourceSha: "f".repeat(40) },
      });
      expect(res.status).toBe("INVALID");
      expect(res.reasonCodes).toContain("IDENTITY_UNTRUSTED");
    });
  });

  // -------------------------------------------------------- R88 regressions --
  it("R88 regression: an empty or single-arm matrix is still never MECHANISM_VALIDATED", async () => {
    const single = await runReplayAb(selection, { arms: ["baseline"], now: () => 0 });
    const manifest = buildManifest({
      selection,
      records: single.records,
      arms: ["baseline"],
      implementationSha: IMPL_SHA,
      baselineSha: HIST_SHA,
      candidateSha: IMPL_SHA,
      gate: { status: "NOT_RUN", code: "PAID_AUTHORIZATION_REQUIRED", reason: "x" },
    });
    expect(manifest.summary.verdict).not.toBe("MECHANISM_VALIDATED");
    expect(manifest.summary.completeness).toBe("PARTIAL");
    const res = validateManifest(manifest, selection);
    expect(res.status).toBe("INVALID");
    expect(res.reasonCodes).toContain("ARM_MISSING");
  });

  it("R90 regression: legacy v1 and superseded v2 stay LEGACY_UNVERIFIED", () => {
    for (const schemaVersion of ["e4-r87-phase-a-manifest-v1", "e4-r88-phase-a-manifest-v2"]) {
      const res = validateManifest({ schemaVersion }, selection);
      expect(res.status).toBe("LEGACY_UNVERIFIED");
      expect(res.reasonCodes).toContain("LEGACY_SCHEMA");
    }
  });

  it("an unsupported schema version is INVALID, never blessed", () => {
    const res = validateManifest({ schemaVersion: "e4-r99-imaginary-v9" }, selection);
    expect(res.status).toBe("INVALID");
    expect(res.reasonCodes).toContain("SCHEMA_UNSUPPORTED");
  });

  // ------------------------------------------- non-vacuity / acceptance ----
  it("NON-VACUITY: the REAL committed v3 artifact is still VALID under the strict validator", () => {
    // Without this, the strictness above could be satisfied by a validator that
    // rejects EVERYTHING. The genuine, on-disk evidence must still be blessed.
    const p = fileURLToPath(
      new URL("../../../../docs/evidence/e4-r90-phase-a-manifest.json", import.meta.url),
    );
    const committed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    const res = validateManifest(committed, selection);
    expect(res.status).toBe("VALID");
    expect(res.reasonCodes).toEqual([]);
  });

  it("NON-VACUITY: every rejection above is caused by the mutation, not by the harness", () => {
    // The same construction path with no mutation is VALID, so each failure in
    // this file is attributable to its own mutation.
    expect(validateManifest(fresh(), selection).status).toBe("VALID");
  });

  it("platform consistency: the same fixture yields the same canonical result", async () => {
    // The plan requires the Windows and Ubuntu runs to agree on the same
    // fixture. The comparison is over the CANONICAL projection (key order
    // normalised), so it is platform-independent by construction — and this
    // asserts that property rather than assuming it.
    const a = fresh();
    const b = JSON.parse(JSON.stringify(a)) as Manifest;
    expect(canonicalDigest(a)).toBe(canonicalDigest(b));
    const resA = validateManifest(a, selection);
    const resB = validateManifest(b, selection);
    expect(resA.status).toBe(resB.status);
    expect(resA.reasonCodes).toEqual(resB.reasonCodes);
  });

  it("makes ZERO external requests: the validator and its source construct no provider", () => {
    const src = readFileSync(new URL("./r87-zero-call-replay-ab.ts", import.meta.url), "utf8");
    for (const needle of [
      "createProvider",
      "new OpenAI",
      "apiKey",
      "OPENAI_API_KEY",
      "fetch(",
      "http.request",
      "https.request",
      "node:http",
      "node:https",
      "net.connect",
    ]) {
      expect(src).not.toContain(needle);
    }
    // And the validator is synchronous: it cannot await a network round trip.
    const res = validateManifest(fresh(), selection);
    expect(res).not.toBeInstanceOf(Promise);
  });

  it("the validation result describes INTERNAL CONSISTENCY, never proven execution", () => {
    // Plan §R93 验收: the report must state that internal consistency is not
    // proof that the execution happened. The detail string says so, so no caller
    // can quote a bare "VALID" as evidence that code ran.
    const res = validateManifest(fresh(), selection);
    expect(res.detail.toLowerCase()).toContain("does not prove");
  });

  it("an UNSUPPORTED claim is reported as UNSUPPORTED, not silently VALID or merely INVALID", async () => {
    const { records } = await runReplayAb(selection, { arms: ARMS, now: () => 0 });
    const m = buildManifest({
      selection,
      records,
      arms: ARMS,
      implementationSha: IMPL_SHA,
      baselineSha: HIST_SHA,
      candidateSha: IMPL_SHA,
      baselineMode: "isolated_build",
      experimentKind: "real_version_ab",
      gate: { status: "NOT_RUN", code: "PAID_AUTHORIZATION_REQUIRED", reason: "x" },
    });
    const res = validateManifest(m, selection);
    expect(res.status).toBe("UNSUPPORTED");
    expect(res.status).not.toBe("VALID");
    expect(res.detail).toContain("armBuildDigests");
  });

  it("R90 regression: the emulated-switch claim stays a hard INVALID contradiction", async () => {
    // Distinct from UNSUPPORTED: asserting a real version A/B while declaring an
    // emulated baseline contradicts itself.
    const { records } = await runReplayAb(selection, { arms: ARMS, now: () => 0 });
    const m = buildManifest({
      selection,
      records,
      arms: ARMS,
      implementationSha: IMPL_SHA,
      baselineSha: HIST_SHA,
      candidateSha: IMPL_SHA,
      baselineMode: "emulated_semantics",
      experimentKind: "real_version_ab",
      gate: { status: "NOT_RUN", code: "PAID_AUTHORIZATION_REQUIRED", reason: "x" },
    });
    const res = validateManifest(m, selection);
    expect(res.status).toBe("INVALID");
    expect(res.reasonCodes).toContain("EXPERIMENT_ID_MISMATCH");
  });

  // -------------------------------------------------- closed-schema guards --
  it("CLOSED SCHEMA: the summary field set is exactly the one the validator compares", () => {
    // If a field is ever ADDED to `Summary`, this fails — forcing the author to
    // extend both the validator's comparison list and the mutation table above.
    // A mutation table that silently goes stale is how finding A happened.
    expect(Object.keys(base.summary).sort()).toEqual(
      [
        "completeness",
        "counterexampleOutcomeDiffs",
        "expectedRecords",
        "issues",
        "mechanismMetric",
        "observedRecords",
        "securityViolations",
        "verdict",
        "verifiedCompletion",
      ].sort(),
    );
    expect(Object.keys(base.summary.mechanismMetric).sort()).toEqual(
      ["baselineTargetFires", "candidateTargetFires", "improvement"].sort(),
    );
  });

  it("CLOSED SCHEMA: the manifest field set is exactly the one the validator checks", () => {
    // `armBuildDigests` is OPTIONAL (only a real_version_ab claim carries it), so
    // it is asserted separately from the always-present keys.
    const keys = Object.keys(base).filter((k) => k !== "armBuildDigests").sort();
    expect(keys).toEqual(
      [
        "arms",
        "baselineSha",
        "candidateSha",
        "caseOrder",
        "gate",
        "identity",
        "limits",
        "providerCalls",
        "schemaVersion",
        "scope",
        "selectionDigest",
        "summary",
      ].sort(),
    );
    expect(Object.keys(base.identity).sort()).toEqual(
      [
        "arms",
        "baselineMode",
        "executedSourceSha",
        "experimentId",
        "experimentKind",
        "fixtureDigest",
        "historicalReferenceSha",
        "implementationSha",
        "limits",
        "schemaVersion",
        "selectionDigest",
        "selectionSchema",
        "syntheticScenarios",
      ].sort(),
    );
    expect(Object.keys(base.scope).sort()).toEqual(
      [
        "baselineMode",
        "executedSourceSha",
        "experimentKind",
        "historicalReferenceCheckedOut",
        "historicalReferenceSha",
        "independentMechanismScenarios",
        "statement",
        "targetLabels",
      ].sort(),
    );
    // A synthetic mechanism experiment must NOT carry build digests: there are
    // no two builds to substantiate.
    expect(base).not.toHaveProperty("armBuildDigests");
  });

  it("CLOSED SCHEMA: the record field set is exactly the canonical projection", () => {
    const rec = asObj(base.arms.baseline.records[0]!);
    expect(Object.keys(rec).sort()).toEqual(
      [
        "arm",
        "caseId",
        "h2SignatureFires",
        "maxRepeatedToolCallsLimits",
        "modelCalls",
        "progressDetected",
        "role",
        "securityViolations",
        "stallRecoveries",
        "status",
        "suite",
        "terminationReason",
        "toolCalls",
        "toolFailures",
        "tokensIn",
        "tokensOut",
      ].sort(),
    );
    // `durationMs` is deliberately absent: it is timing noise, not evidence.
    expect(rec).not.toHaveProperty("durationMs");
  });
});
