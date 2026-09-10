import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  digestOfText,
  verifyEvolutionLedger,
  deriveFactsFromHoldout,
  type EvolutionLedger,
} from "./evolution-ledger.js";

async function makeRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "e2-12-"));
}

async function makeRuns(repo: string): Promise<void> {
  await mkdir(join(repo, "runs"), { recursive: true });
}

function mkLedger(overrides: Partial<EvolutionLedger> = {}): EvolutionLedger {
  return {
    schemaVersion: "2.0.0",
    generatedAtIso: "2026-09-01T00:00:00.000Z",
    reviewBaselineSha: "abc",
    activeChampion: { level: "C0", candidateId: null, validity: "PROVEN" },
    experiments: [
      {
        experimentId: "E1-NEXT-004",
        candidateId: "adaptive_recovery_v2",
        parentCandidateId: null,
        artifacts: [{ path: "runs/candidate.json", digest: digestOfText("c"), role: "candidate" }],
        derived: { caseCount: 2, passedCount: 1, totalDurationMs: 100, securityBreaches: null },
        rawDecision: "ACCEPT",
        currentValidity: "INVALID_PROVENANCE",
        reasonCodes: ["SOURCE_DIRTY"],
        qualitySummary: null,
        securitySummary: null,
        activationSummary: null,
        paidAuthorization: { authorized: true },
        championTransitionRefs: [],
        humanNotes: null,
      },
    ],
    ...overrides,
  };
}

describe("E2-12 evolution ledger verify", () => {
  const HOLDOUT_JSON = JSON.stringify({ results: [
  { duration_ms: 50, success: true },
  { duration_ms: 50, success: true },
] });

it("1. valid ledger verifies OK (refs exist, digests match, facts recompute)", async () => {
    const repo = await makeRepo();
    try {
      await makeRuns(repo);
      await writeFile(join(repo, "runs", "candidate.json"), HOLDOUT_JSON, "utf8");
      const ledger = mkLedger({
        experiments: [{
          ...mkLedger().experiments[0]!,
          artifacts: [{ path: "runs/candidate.json", digest: digestOfText(HOLDOUT_JSON), role: "candidate" }],
          derived: { caseCount: 2, passedCount: 2, totalDurationMs: 100, securityBreaches: null },
        }],
      });
      const result = await verifyEvolutionLedger(ledger, repo);
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("2. missing reference fails when the file does not exist (no silent pass)", async () => {
    const repo = await makeRepo();
    try {
      const result = await verifyEvolutionLedger(mkLedger(), repo); // runs/ never created
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === "MISSING_REFERENCE")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("3. digest mismatch fails after the referenced file changes", async () => {
    const repo = await makeRepo();
    try {
      await makeRuns(repo);
      const HOLDOUT = JSON.stringify({ results: [] });
      await writeFile(join(repo, "runs", "candidate.json"), HOLDOUT, "utf8");
      const ledger = mkLedger({
        experiments: [{
          ...mkLedger().experiments[0]!,
          artifacts: [{ path: "runs/candidate.json", digest: digestOfText(HOLDOUT), role: "candidate" }],
          derived: { caseCount: 0, passedCount: 0, totalDurationMs: 0, securityBreaches: null },
        }],
      });
      const before = await verifyEvolutionLedger(ledger, repo);
      expect(before.ok).toBe(true);
      // Tamper the artifact.
      await writeFile(join(repo, "runs", "candidate.json"), "TAMPERED", "utf8");
      const after = await verifyEvolutionLedger(mkLedger(), repo);
      expect(after.ok).toBe(false);
      expect(after.issues.some((i) => i.code === "DIGEST_MISMATCH")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("4. derived summary mismatch fails (hand-written count conflicts with artifact)", async () => {
    const repo = await makeRepo();
    try {
      await makeRuns(repo);
      await writeFile(
        join(repo, "runs", "candidate.json"),
        JSON.stringify({ results: [
          { duration_ms: 50, success: true },
          { duration_ms: 50, success: true },
          { duration_ms: 50, success: false },
        ] }),
        "utf8",
      );
      const ledger = mkLedger({
        experiments: [{
          ...mkLedger().experiments[0]!,
          artifacts: [{ path: "runs/candidate.json", digest: digestOfText(JSON.stringify({ results: [{ duration_ms: 50, success: true }, { duration_ms: 50, success: true }, { duration_ms: 50, success: false }] })), role: "candidate" }],
          derived: { caseCount: 3, passedCount: 1, totalDurationMs: 150, securityBreaches: null }, // wrong: passedCount should be 2
        }],
      });
      const result = await verifyEvolutionLedger(ledger, repo);
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === "SUMMARY_MISMATCH")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("5. legacy ACCEPT evidence is flagged (never promotion-eligible)", async () => {
    const repo = await makeRepo();
    try {
      await makeRuns(repo);
      await writeFile(join(repo, "runs", "candidate.json"), "c", "utf8");
      const ledger = mkLedger({
        experiments: [{
          ...mkLedger().experiments[0]!,
          currentValidity: "HISTORICAL_ONLY",
          rawDecision: "ACCEPT",
        }],
      });
      const result = await verifyEvolutionLedger(ledger, repo);
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === "LEGACY_PROMOTION_ELIGIBLE")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("6. AR2 double-layer: PROVEN validity is contradicted (E2 audit forbids)", async () => {
    const repo = await makeRepo();
    try {
      await makeRuns(repo);
      await writeFile(join(repo, "runs", "candidate.json"), "c", "utf8");
      const ledger = mkLedger({
        experiments: [{
          ...mkLedger().experiments[0]!,
          currentValidity: "PROVEN", // contradiction: adaptive_recovery_v2 cannot be PROVEN
        }],
      });
      const result = await verifyEvolutionLedger(ledger, repo);
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === "AR2_VALIDITY_CONTRADICTION")).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("deriveFactsFromHoldout recomputes counts + duration purely", () => {
    const derived = deriveFactsFromHoldout({
      results: [
        { duration_ms: 100, success: true },
        { duration_ms: 200, success: false },
        { success: true }, // no duration -> 0
      ],
    });
    expect(derived).toEqual({ caseCount: 3, passedCount: 2, totalDurationMs: 300, securityBreaches: null });
    expect(deriveFactsFromHoldout({ results: "not-array" as never })).toBeNull();
  });

  it("9. E4-R12 (N02): CRLF checkout bytes are NOT silently normalized — DIGEST_MISMATCH stays loud", async () => {
    const repo = await makeRepo();
    try {
      await makeRuns(repo);
      // Pretty-printed JSON so the artifact actually contains line breaks —
      // a CRLF checkout then changes the raw bytes (the digest binds LF bytes).
      const HOLDOUT = JSON.stringify({ results: [{ duration_ms: 50, success: true }] }, null, 2);
      await writeFile(join(repo, "runs", "candidate.json"), HOLDOUT, "utf8");
      const ledger = mkLedger({
        experiments: [{
          ...mkLedger().experiments[0]!,
          artifacts: [{ path: "runs/candidate.json", digest: digestOfText(HOLDOUT), role: "candidate" }],
          derived: { caseCount: 1, passedCount: 1, totalDurationMs: 50, securityBreaches: null },
        }],
      });
      // Simulate a Windows fresh checkout with core.autocrlf rewriting LF→CRLF:
      // the raw-byte contract must FAIL LOUDLY (never normalize inside the
      // verifier, which would disguise real tampering as a line-ending quirk).
      const crlf = await verifyEvolutionLedger(ledger, repo, {
        readFile: async (p) => (await readFile(p, "utf8")).replace(/\n/g, "\r\n"),
      });
      expect(crlf.ok).toBe(false);
      expect(crlf.issues.some((i) => i.code === "DIGEST_MISMATCH")).toBe(true);
      // The LF-bytes read (the .gitattributes `text eol=lf` checkout contract)
      // still verifies — the recorded digests bind to git blob bytes.
      const lf = await verifyEvolutionLedger(ledger, repo);
      expect(lf.ok).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
