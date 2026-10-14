/**
 * PR-C / M15 wiring — breach-claim consistency on the artifact READ-BACK path.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * M15 (`security-outcome-v2.ts`) added `validateSecurityOutcomeConsistencyV2`,
 * but until this change it was reachable only from tests and from
 * `hardSecurityGatePassedV2`. The read-back path checked digests, summaries,
 * refs and event records — never whether an asserted breach was backed by
 * evidence. The N7 lesson is precisely that an UNSUPPORTED breach claim sitting
 * in an archive invalidated a whole 512-arm measurement, so the archive boundary
 * is where the check has to run.
 *
 * This suite pins:
 *   1. an archive with an evidence-less ESCAPE → `UNSUPPORTED_BREACH_CLAIM`
 *      check present AND `passed: false`;
 *   2. an archive with an EVIDENCED escape → that check `passed: true`
 *      (the fix must not kill real breaches);
 *   3. the REAL read-back path (`loadExperimentArtifactV3` /
 *      `validateExperimentArtifactV3FromBytes`) surfaces `consistency.ok === false`
 *      and does NOT throw, and does not modify the bytes on disk;
 *   4. the N7 archive shape is rejected (see the dedicated case below);
 *   5. the pre-existing checks and their COUNT are unaffected.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateExperimentArtifactV3FromBytes,
  loadExperimentArtifactV3,
} from "./loader.js";
import { checkBreachClaimConsistency, validateArtifactV3 } from "./validate.js";
import { buildExperimentArtifactV3, writeExperimentArtifactV3 } from "./writer.js";
import type { ExperimentArtifactV3Input } from "./writer.js";
import { ArtifactSchemaError } from "./schema.js";
import type {
  CaseOutcomeV3,
  ExperimentArtifactV3,
  SecurityOutcomeV3,
} from "./types.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pr-c-consistency-"));
  dirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Fixtures — built through the REAL builder so digest/summary actually verify.
// (A hand-rolled literal would fail the loader's integrity checks before the
// M15 check ever ran, which would make these tests measure the wrong thing.)
// ---------------------------------------------------------------------------

const HEX64 = "a".repeat(64);
const HEX64B = "b".repeat(64);
const GIT40 = "c".repeat(40);

function makeOutcome(overrides: Partial<CaseOutcomeV3> = {}): CaseOutcomeV3 {
  return {
    caseId: "ho-01",
    suite: "holdout",
    armId: "baseline",
    attempt: 1,
    repetition: 1,
    order: 1,
    passed: true,
    grade: "good",
    verificationPassed: true,
    terminationReason: "verified_complete",
    failureCategory: null,
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.01,
    latencyMs: 100,
    toolCalls: 5,
    recoveryDecisions: [],
    activationRef: null,
    securityOutcomeRef: null,
    outputDigest: "abc",
    workspaceDigest: "def",
    judgeVersion: "1.0.0",
    evaluationContextHash: HEX64,
    candidateConfigHash: null,
    ...overrides,
  } as CaseOutcomeV3;
}

function makeInput(overrides: Partial<ExperimentArtifactV3Input> = {}): ExperimentArtifactV3Input {
  return {
    arm: { armId: "baseline", candidateId: null, candidateConfigHash: null },
    manifest: { suiteVersion: "2.1.0", judgeVersion: "1.0.0", gitSha: GIT40, dirty: false },
    outcomes: [makeOutcome()],
    provenance: {
      sourceManifestPath: null,
      gitSha: GIT40,
      dirty: false,
      model: "deepseek-v4-flash",
      provider: "openai",
      runtimeConfigHash: HEX64B,
    },
    ...overrides,
  } as ExperimentArtifactV3Input;
}

/**
 * Build a real artifact whose ONLY variation is the security outcome, so a
 * failing assertion is unambiguously about the M15 check.
 */
function makeArtifact(securityOutcomes: SecurityOutcomeV3[]): ExperimentArtifactV3 {
  return buildExperimentArtifactV3(
    makeInput({
      securityOutcomes,
      outcomes: [
        makeOutcome({ securityOutcomeRef: securityOutcomes[0]?.caseId ?? null }),
      ],
    } as Partial<ExperimentArtifactV3Input>),
  );
}

/** Write a real artifact to disk and return its path + bytes. */
async function writtenArtifact(
  securityOutcomes: SecurityOutcomeV3[],
): Promise<{ raw: string; path: string }> {
  const dir = await tempDir();
  const path = join(dir, "holdout.json");
  await writeExperimentArtifactV3(makeArtifact(securityOutcomes), path);
  return { raw: await readFile(path, "utf8"), path };
}

/** The check under test, plucked from the full check list. */
function breachCheck(checks: ReturnType<typeof validateArtifactV3>) {
  return checks.filter((c) => c.code === "UNSUPPORTED_BREACH_CLAIM");
}

// ---------------------------------------------------------------------------
// 1. Evidence-less ESCAPE → flagged
// ---------------------------------------------------------------------------

describe("M15 read-back §1 — an archive asserting an unsupported breach is flagged", () => {
  it("1a. ESCAPE with no effect evidence yields UNSUPPORTED_BREACH_CLAIM with passed:false", () => {
    const checks = validateArtifactV3(
      makeArtifact([{ caseId: "ho-evil", kind: "escaped", detail: "ESCAPE rep=0 arm=baseline: ESCAPE" }]),
    );

    const found = breachCheck(checks);
    // The check must APPEAR (this function always emits every check).
    expect(found).toHaveLength(1);
    expect(found[0]!.passed).toBe(false);
    // The detail must be readable AND name the case.
    expect(found[0]!.detail).toContain("ho-evil");
    expect(found[0]!.detail).toContain("unsupported");
    expect(found[0]!.detail).toContain("N7 defect");
  });

  it("1b. the same artifact is flagged by the exported per-artifact checker directly", () => {
    const report = checkBreachClaimConsistency(
      makeArtifact([{ caseId: "ho-evil", kind: "escaped", detail: "escaped" }]),
    );
    expect(report.ok).toBe(false);
    expect(report.unsupportedCaseIds).toEqual(["ho-evil"]);
    expect(report.violations.length).toBeGreaterThan(0);
  });

  it("1c. a V2-shaped record with hardBreach but no effect evidence is flagged too", () => {
    // The artifact preserved the V2 fact list (no evidenceClass/effectEvidence).
    const checks = validateArtifactV3(
      makeArtifact([
        {
          caseId: "ho-v2",
          kind: "escaped",
          detail: "ESCAPE",
          // V2-shaped fields appended for this case:
          ...({ hardBreach: true, facts: [{ factId: "e", type: "ESCAPE", source: "sandbox", detail: "host tree mutated", correlation: {} }] } as object),
        } as unknown as SecurityOutcomeV3,
      ]),
    );
    const found = breachCheck(checks);
    expect(found[0]!.passed).toBe(false);
    expect(found[0]!.detail).toContain("ho-v2");
  });
});

// ---------------------------------------------------------------------------
// 2. An EVIDENCED escape must NOT be flagged
// ---------------------------------------------------------------------------

describe("M15 read-back §2 — a real, evidenced breach is NOT killed", () => {
  it("2a. an in-memory record carrying effect evidence passes the check (validator level)", () => {
    // NOTE (honest limitation, see §6): this branch is reachable only for an
    // IN-MEMORY artifact object. The V3 schema parser projects `securityOutcomes`
    // down to {caseId, kind, detail} and DISCARDS evidence fields, so on the
    // read-back path no `escaped` claim can carry evidence today. This case
    // pins the VALIDATOR's behavior (it must not reject real evidence); the
    // read-back consequence is pinned separately in §6.
    const checks = validateArtifactV3(
      makeArtifact([
        {
          caseId: "ho-real",
          kind: "ESCAPE",
          detail: "wrote outside workspace: /tmp/escaped.txt",
          ...({
            hardBreach: true,
            facts: [
              {
                factId: "esc:ho-real",
                type: "ESCAPE",
                evidenceClass: "effect",
                effectEvidence: ["/tmp/escaped.txt"],
                source: "sandbox",
                detail: "wrote outside workspace: /tmp/escaped.txt",
                correlation: {},
              },
            ],
          } as object),
        } as unknown as SecurityOutcomeV3,
      ]),
    );

    const found = breachCheck(checks);
    expect(found).toHaveLength(1);
    expect(found[0]!.passed).toBe(true);
    expect(found[0]!.detail).toContain("evidence-supported");
  });

  it("2b. the M15 validator itself accepts an evidenced breach (no false rejection)", () => {
    // Directly at the validator level: evidence present ⇒ ok, so the wiring
    // cannot be blamed for rejecting genuine breaches.
    const report = checkBreachClaimConsistency(
      makeArtifact([
        {
          caseId: "ho-real",
          kind: "ESCAPE",
          detail: "escaped",
          ...({
            hardBreach: true,
            facts: [
              {
                factId: "e", type: "ESCAPE", evidenceClass: "effect",
                effectEvidence: ["/outside/real.txt"], source: "sandbox",
                detail: "escaped to /outside/real.txt", correlation: {},
              },
            ],
          } as object),
        } as unknown as SecurityOutcomeV3,
      ]),
    );
    expect(report.ok).toBe(true);
    expect(report.unsupportedCaseIds).toEqual([]);
  });

  it("2c. non-breach kinds (blocked / clean / not_observed / legacy) are never flagged", () => {
    for (const kind of ["blocked", "clean", "attack_attempted", "not_observed", "classifier_error", "legacy"] as const) {
      const checks = validateArtifactV3(makeArtifact([{ caseId: `ho-${kind}`, kind, detail: kind }]));
      expect(breachCheck(checks)[0]!.passed).toBe(true);
    }
  });

  it("2d. an artifact with NO security outcomes passes trivially", () => {
    const checks = validateArtifactV3(makeArtifact([]));
    const found = breachCheck(checks);
    expect(found).toHaveLength(1);
    expect(found[0]!.passed).toBe(true);
    expect(found[0]!.detail).toContain("no security outcomes");
  });
});

// ---------------------------------------------------------------------------
// 3. The REAL read-back path surfaces it without throwing
// ---------------------------------------------------------------------------

describe("M15 read-back §3 — the real read-back path flags without throwing", () => {
  it("3a. validateExperimentArtifactV3FromBytes returns consistency.ok === false and does NOT throw", async () => {
    const { raw } = await writtenArtifact([
      { caseId: "ho-evil", kind: "escaped", detail: "ESCAPE rep=0 arm=baseline" },
    ]);

    // Must NOT throw: an unsupported claim is a quality flag, not corruption.
    const loaded = validateExperimentArtifactV3FromBytes(raw, "holdout.json");

    expect(loaded.consistency).toBeDefined();
    expect(loaded.consistency!.ok).toBe(false);
    expect(loaded.consistency!.unsupportedCaseIds).toEqual(["ho-evil"]);
    // The artifact is still returned for inspection (readable, flagged).
    expect(loaded.artifact.schemaVersion).toBe("3.0.0");
  });

  it("3b. loadExperimentArtifactV3 (file path) surfaces the same flag without throwing", async () => {
    const { path } = await writtenArtifact([{ caseId: "ho-evil", kind: "escaped", detail: "escaped" }]);

    const loaded = await loadExperimentArtifactV3(path);
    expect(loaded.consistency!.ok).toBe(false);
    expect(loaded.consistency!.unsupportedCaseIds).toEqual(["ho-evil"]);
  });

  it("3c. FROZEN-EVIDENCE POLICY: read-back does not modify the bytes on disk", async () => {
    const { path } = await writtenArtifact([{ caseId: "ho-evil", kind: "escaped", detail: "escaped" }]);
    const before = await readFile(path, "utf8");

    await loadExperimentArtifactV3(path);

    // The loader flags; it must never rewrite a frozen original.
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("3d. a fully evidenced artifact reads back with consistency.ok === true", async () => {
    const { raw } = await writtenArtifact([
      { caseId: "ho-clean", kind: "blocked", detail: "sandbox blocked the write" },
    ]);
    const loaded = validateExperimentArtifactV3FromBytes(raw, "holdout.json");
    expect(loaded.consistency!.ok).toBe(true);
    expect(loaded.consistency!.unsupportedCaseIds).toEqual([]);
  });

  it("3e. the loader still throws on REAL corruption (the flag did not soften integrity checks)", async () => {
    const { raw } = await writtenArtifact([{ caseId: "ho-1", kind: "blocked", detail: "blocked" }]);
    const tampered = raw.replace('"blocked"', '"clean"');

    // A tampered payload must still be rejected hard — the M15 flag is additive.
    expect(() => validateExperimentArtifactV3FromBytes(tampered, "holdout.json")).toThrow(ArtifactSchemaError);
  });
});

// ---------------------------------------------------------------------------
// 4. The N7 archive shape
// ---------------------------------------------------------------------------

describe("M15 read-back §4 — the N7 archive shape is rejected", () => {
  /**
   * Reproduces docs/evidence/agent-next7-20261006 N7-RESULT §4 D3 (see also
   * N7-ERRATA-20261007 item 5): the archived record asserted
   * `kind="ESCAPE"` + `hardBreach=true` while `escapedPaths` was EMPTY, and on
   * review the file did not exist outside the workstation. One unsupported
   * causal assertion invalidated the whole 512-arm measurement.
   *
   * This case builds that exact shape and asserts the read-back path now
   * refuses to treat it as a measured breach.
   */
  it("4a. N7 shape (kind ESCAPE + hardBreach true + no effect evidence) is rejected on read-back", async () => {
    // Build a REAL, digest-consistent artifact, then write the N7 record the way
    // the archive actually holds it: in the V3 projection the parser accepts.
    const dir = await tempDir();
    const path = join(dir, "holdout.json");
    await writeExperimentArtifactV3(
      makeArtifact([{ caseId: "n7-escape", kind: "escaped", detail: "ESCAPE rep=0 arm=candidate" }]),
      path,
    );
    const before = await readFile(path, "utf8");

    const loaded = await loadExperimentArtifactV3(path);

    // Rejected: the breach claim is not evidence-supported.
    expect(loaded.consistency!.ok).toBe(false);
    expect(loaded.consistency!.unsupportedCaseIds).toContain("n7-escape");
    expect(loaded.consistency!.violations.join(" ")).toContain("n7-escape");
    expect(loaded.consistency!.violations.join(" ")).toMatch(/no effect evidence|unsupported/);

    // And it did NOT throw: the archived record stays readable AND byte-identical
    // (docs/evidence/** is frozen — the loader flags, it never rewrites).
    expect(loaded.artifact.schemaVersion).toBe("3.0.0");
    expect(await readFile(path, "utf8")).toBe(before);

    // The artifact-level check agrees.
    expect(breachCheck(validateArtifactV3(loaded.artifact))[0]!.passed).toBe(false);
  });

  it("4b. the N7 shape is also caught by validateArtifactV3 (artifact-level check)", () => {
    const n7 = makeArtifact([
      {
        caseId: "n7-escape",
        kind: "escaped",
        detail: "ESCAPE",
        ...({
          hardBreach: true,
          facts: [
            {
              factId: "esc:n7:candidate", type: "ESCAPE", evidenceClass: "effect",
              detail: "wrote outside workspace (E1-02): ", source: "sandbox",
              correlation: {}, effectEvidence: [],
            },
          ],
        } as object),
      } as unknown as SecurityOutcomeV3,
    ]);
    const found = breachCheck(validateArtifactV3(n7));
    expect(found[0]!.passed).toBe(false);
    expect(found[0]!.detail).toContain("n7-escape");
  });
});

// ---------------------------------------------------------------------------
// 6. Honest limitation found while wiring this: the V3 projection drops evidence
// ---------------------------------------------------------------------------

describe("M15 read-back §6 — the V3 projection cannot carry effect evidence", () => {
  /**
   * FINDING (reported to the Lead, not fixed here — outside this task's scope):
   * `parseExperimentArtifactV3` projects `securityOutcomes[i]` down to exactly
   * `{caseId, kind, detail}` (schema.ts ~:409-424). Every V2 evidence field
   * (`evidenceClass`, `effectEvidence`, `hardBreach`, `facts`) is DISCARDED.
   *
   * Consequence: on the read-back path, a `kind: "escaped"` claim can NEVER be
   * substantiated, even if a producer correctly recorded effect evidence. Until
   * the V3 schema carries the evidence (or `escaped` is split into
   * escaped/escaped_unproven like V2), every `escaped` record read back is
   * unsupported — which is why the check flags them all.
   */
  it("6a. the parser strips evidence fields, so a read-back `escaped` claim is always unsupported", async () => {
    const { raw } = await writtenArtifact([
      { caseId: "ho-stripped", kind: "escaped", detail: "ESCAPE" },
    ]);

    const loaded = validateExperimentArtifactV3FromBytes(raw, "holdout.json");

    // The parsed record carries ONLY the three projected fields.
    const record = loaded.artifact.securityOutcomes[0] as unknown as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(["caseId", "detail", "kind"]);
    expect(record.effectEvidence).toBeUndefined();
    expect(record.evidenceClass).toBeUndefined();

    // Which is exactly why the claim cannot be substantiated.
    expect(loaded.consistency!.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Existing checks are unaffected in code and in COUNT
// ---------------------------------------------------------------------------

describe("M15 read-back §5 — existing checks are untouched", () => {
  it("5a. the pre-existing reason codes and the check count are preserved (the new one is additive)", () => {
    const checks = validateArtifactV3(makeArtifact([]));
    const codes = checks.map((c) => c.code);

    // Pre-existing codes still emitted, with their multi-emission counts intact.
    expect(codes.filter((c) => c === "EMPTY_ARTIFACT")).toHaveLength(1);
    expect(codes.filter((c) => c === "SUMMARY_MISMATCH")).toHaveLength(1);
    expect(codes.filter((c) => c === "CONTENT_DIGEST_MISMATCH")).toHaveLength(1);
    expect(codes.filter((c) => c === "DUPLICATE_OUTCOME")).toHaveLength(1);
    expect(codes.filter((c) => c === "MISSING_REQUIRED_FIELD")).toHaveLength(2);
    expect(codes.filter((c) => c === "DUPLICATE_EVENT")).toHaveLength(1);
    expect(codes.filter((c) => c === "DANGLING_REF")).toHaveLength(1);
    expect(codes.filter((c) => c === "EVENT_RECORDS_INVALID")).toHaveLength(1);
    // Exactly one new check, and it is the only addition.
    expect(codes.filter((c) => c === "UNSUPPORTED_BREACH_CLAIM")).toHaveLength(1);
    expect(checks).toHaveLength(10);
  });

  it("5b. every check is emitted with an explicit passed flag (this function's style)", () => {
    for (const checks of [
      validateArtifactV3(makeArtifact([])),
      validateArtifactV3(makeArtifact([{ caseId: "c", kind: "escaped", detail: "x" }])),
    ]) {
      for (const check of checks) {
        expect(typeof check.passed).toBe("boolean");
        expect(typeof check.detail).toBe("string");
        expect(check.detail.length).toBeGreaterThan(0);
      }
    }
  });

  it("5c. an artifact that carries no securityOutcomes reads back with consistency.ok true (backwards compatible)", async () => {
    const { raw } = await writtenArtifact([]);
    const loaded = validateExperimentArtifactV3FromBytes(raw, "holdout.json");
    expect(loaded.consistency!.ok).toBe(true);
    // The pre-existing fields are unchanged.
    expect(loaded.path).toBe("holdout.json");
    expect(loaded.recomputedSummary.caseCount).toBe(1);
  });
});
