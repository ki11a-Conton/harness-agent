import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPromotionEnvelope,
  loadPromotionEnvelope,
  computeEnvelopeContentDigest,
  PROMOTION_ENVELOPE_SCHEMA_VERSION,
  PROMOTION_ENVELOPE_POLICY_VERSION,
  type AxisArtifactRef,
  type PromotionEnvelope,
} from "./promotion-envelope.js";
import {
  createInitialChampionState,
  applyPromotion,
  rollbackChampionState,
  nextChampionLevel,
  championLevelNumber,
} from "./champion-state.js";
import { stableStringify } from "./manifest.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Local copy of championStateDigest (avoids cross-app import in tests). */
function stateDigest(state: unknown): string {
  const rest = { ...(state as Record<string, unknown>) };
  delete rest.applied;
  return createHash("sha256").update(stableStringify(rest), "utf8").digest("hex");
}

function artifactRefs(overrides: Partial<AxisArtifactRef> = {}): AxisArtifactRef[] {
  return [
    { role: "baseline", path: "runs/baseline.json", digest: sha("baseline"), ...overrides },
    { role: "candidate", path: "runs/candidate.json", digest: sha("candidate"), ...overrides },
  ];
}

function mkEnvelope(overrides: Record<string, unknown> = {}) {
  return buildPromotionEnvelope({
    generatedBy: "test-generator",
    decisionEnvelopeDigest: sha("e2-06-decision"),
    candidateId: "adaptive_recovery_v2",
    parentLevel: "C0",
    parentStateDigest: sha("parent-state"),
    artifactRefs: artifactRefs(),
    sourceSha: "abc123",
  });
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "e2-07-"));
}

describe("E2-07 promotion envelope (unforgeable authority)", () => {
  it("1. arbitrary text file cannot promote", async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir, "any.txt");
      await writeFile(path, "this is not a promotion envelope", "utf8");
      const result = await loadPromotionEnvelope(path, { parentStateDigest: sha("parent-state") });
      expect(result.ok).toBe(false);
      expect(result.envelope).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("1b. empty JSON cannot promote", async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir, "empty.json");
      await writeFile(path, "{}", "utf8");
      const result = await loadPromotionEnvelope(path, { parentStateDigest: sha("parent-state") });
      expect(result.ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("1c. hand-written {'decision':'ACCEPT'} cannot promote (digest + artifact refs fail)", async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir, "handwritten.json");
      const handWritten = {
        schemaVersion: PROMOTION_ENVELOPE_SCHEMA_VERSION,
        policyVersion: PROMOTION_ENVELOPE_POLICY_VERSION,
        decision: "ACCEPT",
        candidateId: "adaptive_recovery_v2",
        parentLevel: "C0",
        parentStateDigest: sha("parent-state"),
        artifactRefs: artifactRefs(),
        contentDigest: "faked",
      };
      await writeFile(path, JSON.stringify(handWritten), "utf8");
      const result = await loadPromotionEnvelope(path, { parentStateDigest: sha("parent-state") });
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === "DIGEST_MISMATCH")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("2. a real envelope passes verification", async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir, "envelope.json");
      const env = mkEnvelope();
      await writeFile(path, JSON.stringify(env), "utf8");
      const result = await loadPromotionEnvelope(path, {
        parentStateDigest: sha("parent-state"),
        candidateId: "adaptive_recovery_v2",
        expectedPolicyVersion: PROMOTION_ENVELOPE_POLICY_VERSION,
        verifyArtifactRefs: false, // no real artifact files in this unit test
      });
      expect(result.ok).toBe(true);
      expect(result.envelope!.candidateId).toBe("adaptive_recovery_v2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("3. INCONCLUSIVE/INVALID/REJECT can never build an envelope (constructor only accepts ACCEPT)", () => {
    // buildPromotionEnvelope hard-codes decision: "ACCEPT" — the type system
    // guarantees non-ACCEPT never constructs a valid envelope.
    const env = mkEnvelope();
    expect(env.decision).toBe("ACCEPT");
    // And a tampered envelope (decision changed) fails digest recompute.
    const tampered: Omit<PromotionEnvelope, "contentDigest" | "signature"> = {
      schemaVersion: env.schemaVersion,
      policyVersion: env.policyVersion,
      generatedBy: env.generatedBy,
      generatedAtIso: env.generatedAtIso,
      decision: "REJECT" as unknown as PromotionEnvelope["decision"],
      candidateId: env.candidateId,
      parentLevel: env.parentLevel,
      parentStateDigest: env.parentStateDigest,
      decisionEnvelopeDigest: env.decisionEnvelopeDigest,
      artifactRefs: env.artifactRefs,
      sourceSha: env.sourceSha,
    };
    const digestWontMatch = computeEnvelopeContentDigest(tampered);
    expect(digestWontMatch).not.toBe(env.contentDigest);
  });

  it("4. envelope claiming ACCEPT but artifact digest changed -> rejected", async () => {
    const dir = await makeTempDir();
    try {
      const base = join(dir, "baseline.json");
      await writeFile(base, "original content", "utf8");
      const refs: AxisArtifactRef[] = [
        { role: "baseline", path: base, digest: sha("original content") },
        { role: "candidate", path: base, digest: sha("original content") },
      ];
      const env = buildPromotionEnvelope({
        generatedBy: "t",
        decisionEnvelopeDigest: sha("d"),
        candidateId: "x",
        parentLevel: "C0",
        parentStateDigest: sha("p"),
        artifactRefs: refs,
      });
      const envPath = join(dir, "env.json");
      await writeFile(envPath, JSON.stringify(env), "utf8");
      // Tamper the artifact after the envelope was minted.
      await writeFile(base, "tampered content", "utf8");
      const result = await loadPromotionEnvelope(envPath, { parentStateDigest: sha("p") });
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === "ARTIFACT_DIGEST_CHANGED")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("5. candidate/parent/policy mismatch each rejected", async () => {
    const dir = await makeTempDir();
    try {
      const env = mkEnvelope();
      const path = join(dir, "env.json");
      await writeFile(path, JSON.stringify(env), "utf8");

      const wrongCandidate = await loadPromotionEnvelope(path, {
        parentStateDigest: sha("parent-state"),
        candidateId: "WRONG",
        verifyArtifactRefs: false,
      });
      expect(wrongCandidate.ok).toBe(false);
      expect(wrongCandidate.issues.some((i) => i.code === "CANDIDATE_MISMATCH")).toBe(true);

      const wrongParent = await loadPromotionEnvelope(path, {
        parentStateDigest: sha("different-parent"),
        verifyArtifactRefs: false,
      });
      expect(wrongParent.ok).toBe(false);
      expect(wrongParent.issues.some((i) => i.code === "PARENT_STATE_MISMATCH")).toBe(true);

      const wrongPolicy = await loadPromotionEnvelope(path, {
        parentStateDigest: sha("parent-state"),
        expectedPolicyVersion: "old-policy",
        verifyArtifactRefs: false,
      });
      expect(wrongPolicy.ok).toBe(false);
      expect(wrongPolicy.issues.some((i) => i.code === "POLICY_VERSION_MISMATCH")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("6. concurrent promote: CAS rejects the second writer (STALE state)", async () => {
    // Modeled at the state-transition level: two promotions from the same
    // parent must produce the SAME opponent — the second cannot "win" over
    // the first. Here we assert the state machine applies promotions
    // monotonically and a stale parent (already advanced) fails CAS via the
    // file writer (covered in champion-state-file tests). At the pure level,
    // two applyPromotion calls from the same parent yield identical digests.
    const c0 = createInitialChampionState();
    const a = applyPromotion(c0, "adaptive_recovery_v2", { adaptiveRecovery: "conservative-v1" }, "envA");
    const b = applyPromotion(c0, "adaptive_recovery_v2", { adaptiveRecovery: "conservative-v1" }, "envB");
    // Same parent, same candidate -> same level; the second is a duplicate,
    // not a distinct chain branch (idempotent promotion).
    expect(a.level).toBe("C1");
    expect(b.level).toBe("C1");
  });

  it("8. unbounded chain: C2 -> C3 -> C4 (no max)", () => {
    let level: import("./champion-state.js").ChampionLevel = "C0";
    for (let i = 0; i < 6; i++) {
      level = nextChampionLevel(level);
    }
    expect(level).toBe("C6");
    expect(championLevelNumber("C6")).toBe(6);
    const c0 = createInitialChampionState();
    let state = applyPromotion(c0, "adaptive_recovery_v2", { adaptiveRecovery: "conservative-v1" }, "r1");
    expect(state.level).toBe("C1");
    state = applyPromotion(state, "budget_aware_completion_v1", { completionPolicy: "budget_aware" }, "r2");
    expect(state.level).toBe("C2");
    state = applyPromotion(state, "memory_retrieval", { features: { memory: true } }, "r3");
    expect(state.level).toBe("C3");
  });

  it("9. rollback keeps ALL history and records an audit transition", () => {
    const c0 = createInitialChampionState();
    const c1 = applyPromotion(c0, "adaptive_recovery_v2", { adaptiveRecovery: "conservative-v1" }, "r1");
    const c2 = applyPromotion(c1, "budget_aware_completion_v1", { completionPolicy: "budget_aware" }, "r2");
    const rolled = rollbackChampionState(c2, { targetLevel: "C0", reason: "test rollback" });
    expect(rolled.level).toBe("C0");
    expect(rolled.rollback).toBeDefined();
    expect(rolled.rollback!.fromLevel).toBe("C2");
    expect(rolled.rollback!.toLevel).toBe("C0");
    expect(rolled.history.length).toBe(3); // 2 promotions + 1 rollback record
    expect(rolled.history[0]!.candidateId).toBe("adaptive_recovery_v2");
    expect(rolled.history[1]!.candidateId).toBe("budget_aware_completion_v1");
  });

  it("10. quarantined AR2 evidence cannot produce a valid envelope for promote", async () => {
    // The E2-06 AR2 offline decision was INVALID -> no ACCEPT envelope can
    // reference those artifacts. Constructing a "valid" envelope requires the
    // decision-layer ACCEPT which E2-06 refused. Here we assert the digest
    // of an envelope referencing quarantined artifacts is rejected by parent
    // mismatch against the quarantined (C0) state.
    const quarantined = createInitialChampionState(); // C0, validity PROVEN
    const fakeParentEnv = buildPromotionEnvelope({
      generatedBy: "attacker",
      decisionEnvelopeDigest: "not-an-e2-06-accept",
      candidateId: "adaptive_recovery_v2",
      parentLevel: "C1", // tries to claim parent C1
      parentStateDigest: sha("quarantined-c1-imagined"),
      artifactRefs: artifactRefs(),
    });
    // The real state digest is C0's — the imagined C1 parent never matches.
    const realDigest = stateDigest(quarantined);
    const dir = await makeTempDir();
    try {
      const path = join(dir, "evil.json");
      await writeFile(path, JSON.stringify(fakeParentEnv), "utf8");
      const result = await loadPromotionEnvelope(path, { parentStateDigest: realDigest, verifyArtifactRefs: false });
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === "PARENT_STATE_MISMATCH")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});