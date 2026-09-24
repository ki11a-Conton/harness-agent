/**
 * E4-07 — AppliedProof machinery + application lifecycle transitions.
 *
 * The rule under test: `applied` is a CLAIM ONLY A REAL RUNTIME can substantiate.
 * A proof must recompute, must describe the current promotion generation, and
 * the application evaluation must fail closed on config drift, on a key whose
 * winning layer is not the runtime (default fallback / environment override),
 * on an empty projection, and on a createHarness error.
 */

import { describe, it, expect } from "vitest";
import {
  APPLIED_PROOF_SCHEMA_VERSION,
  buildAppliedProofV1,
  championApplicationTargetDigestV1,
  computeAppliedProofDigestV1,
  evaluateChampionApplicationV1,
  hashChampionConfigProjectionV1,
  verifyAppliedProofV1,
  type ChampionFieldCheckV1,
} from "./champion-application.js";
import {
  applyPromotion,
  championLifecycleStatus,
  createInitialChampionState,
  markChampionApplicationFailed,
  markChampionApplied,
} from "./champion-state.js";

const CANDIDATE = "memory_retrieval";

function pendingState() {
  const c0 = createInitialChampionState();
  return applyPromotion(c0, CANDIDATE, { memory: true }, "evidence.json");
}

const CHECKS: ChampionFieldCheckV1[] = [
  { key: "featureFlags.memory", intended: true, actual: true, origin: "runtime" },
  { key: "featureFlags.learning", intended: true, actual: true, origin: "runtime" },
  { key: "memory.enabled", intended: true, actual: true, origin: "runtime" },
  { key: "contextBudget.dynamic", intended: 0.25, actual: 0.25, origin: "runtime" },
];

function proofFor(state: ReturnType<typeof pendingState>, over: Record<string, unknown> = {}) {
  return buildAppliedProofV1({
    schemaVersion: APPLIED_PROOF_SCHEMA_VERSION,
    stateDigest: championApplicationTargetDigestV1(state),
    level: state.level,
    candidateId: state.candidateId ?? CANDIDATE,
    targetConfigHash: hashChampionConfigProjectionV1(CHECKS, "intended"),
    appliedConfigHash: hashChampionConfigProjectionV1(CHECKS, "actual"),
    runtimeEntrypoint: "cli",
    sourceSha: "a".repeat(40),
    processId: "pid-1",
    appliedAt: "2026-09-07T00:00:00.000Z",
    ...over,
  });
}

describe("E4-07 config projection hashing", () => {
  it("is order-independent and sensitive to a value change", () => {
    const a = hashChampionConfigProjectionV1(CHECKS, "intended");
    const b = hashChampionConfigProjectionV1([...CHECKS].reverse(), "intended");
    expect(a).toBe(b);
    const drifted: ChampionFieldCheckV1[] = CHECKS.map((c) =>
      c.key === "featureFlags.memory" ? { ...c, intended: false } : c);
    expect(hashChampionConfigProjectionV1(drifted, "intended")).not.toBe(a);
  });
});

describe("E4-07 evaluateChampionApplicationV1", () => {
  it("accepts a faithful application (all keys runtime-sourced, hashes equal)", () => {
    const r = evaluateChampionApplicationV1({ checks: CHECKS });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("applied");
    expect(r.targetConfigHash).toBe(r.appliedConfigHash);
    expect(r.reason).toBeNull();
  });

  it("rejects config drift between intended and actual", () => {
    const drifted = CHECKS.map((c) => (c.key === "memory.enabled" ? { ...c, actual: false } : c));
    const r = evaluateChampionApplicationV1({ checks: drifted });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("applicationFailed");
    expect(r.mismatchedKeys).toContain("memory.enabled");
    expect(r.reason).toMatch(/config drift/);
  });

  it("rejects a key that fell back to defaults instead of the champion layer", () => {
    const defaulted = CHECKS.map((c) => (c.key === "featureFlags.memory" ? { ...c, origin: "defaults" } : c));
    const r = evaluateChampionApplicationV1({ checks: defaulted });
    expect(r.ok).toBe(false);
    expect(r.overriddenKeys.some((k) => k.startsWith("featureFlags.memory"))).toBe(true);
    expect(r.reason).toMatch(/not supplied by the runtime layer/);
  });

  it("rejects an environment override even when the VALUE matches the target", () => {
    // HARNESS_MEMORY=1 can produce the same boolean; that is not the champion
    // having been applied, so it must not be provable.
    const envDriven = CHECKS.map((c) => (c.key === "featureFlags.memory" ? { ...c, origin: "environment" } : c));
    const r = evaluateChampionApplicationV1({ checks: envDriven });
    expect(r.ok).toBe(false);
    expect(r.overriddenKeys.some((k) => k.includes("origin=environment"))).toBe(true);
  });

  it("rejects an empty projection (application of nothing is not proof)", () => {
    const r = evaluateChampionApplicationV1({ checks: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/empty config/);
  });

  it("reports a createHarness failure as applicationFailed", () => {
    const r = evaluateChampionApplicationV1({ checks: CHECKS, createHarnessError: "provider unavailable" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/createHarness failed: provider unavailable/);
  });
});

describe("E4-07 AppliedProof digest + verification", () => {
  it("proof digest recomputes and detects a tampered field", () => {
    const state = pendingState();
    const proof = proofFor(state);
    expect(computeAppliedProofDigestV1(proof)).toBe(proof.proofDigest);
    const tampered = { ...proof, appliedConfigHash: "0".repeat(64) };
    expect(computeAppliedProofDigestV1(tampered)).not.toBe(tampered.proofDigest);
  });

  it("verifies a proof that still describes the current promotion", () => {
    const state = pendingState();
    const proof = proofFor(state);
    const v = verifyAppliedProofV1(proof, {
      stateDigest: championApplicationTargetDigestV1(state),
      level: state.level,
      candidateId: state.candidateId ?? CANDIDATE,
      targetConfigHash: proof.targetConfigHash,
    });
    expect(v.ok).toBe(true);
    expect(v.issues).toEqual([]);
  });

  it("rejects a proof from a previous generation (a newer promotion invalidates it)", () => {
    const state = pendingState();
    const proof = proofFor(state);
    const v = verifyAppliedProofV1(proof, {
      stateDigest: "9".repeat(64),
      level: state.level,
      candidateId: state.candidateId ?? CANDIDATE,
      targetConfigHash: proof.targetConfigHash,
    });
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => /older generation/.test(i))).toBe(true);
  });

  it("rejects a tampered digest, a wrong candidate, and a non-runtime entrypoint", () => {
    const state = pendingState();
    const base = {
      stateDigest: championApplicationTargetDigestV1(state),
      level: state.level,
      candidateId: state.candidateId ?? CANDIDATE,
    };
    const badDigest = { ...proofFor(state), proofDigest: "1".repeat(64) };
    expect(verifyAppliedProofV1(badDigest, { ...base, targetConfigHash: badDigest.targetConfigHash }).ok).toBe(false);
    const wrongCand = proofFor(state, { candidateId: "someone-else" });
    expect(verifyAppliedProofV1(wrongCand, { ...base, targetConfigHash: wrongCand.targetConfigHash }).ok).toBe(false);
    const badEntry = proofFor(state, { runtimeEntrypoint: "cron" });
    expect(verifyAppliedProofV1(badEntry, { ...base, targetConfigHash: badEntry.targetConfigHash }).ok).toBe(false);
  });

  it("rejects a missing / non-object proof", () => {
    expect(verifyAppliedProofV1(undefined, { stateDigest: "x", level: "C1", candidateId: "c", targetConfigHash: "t" }).ok).toBe(false);
  });
});

describe("E4-07 lifecycle transitions", () => {
  it("promote yields APPLICATION_PENDING (applied=false), never APPLIED", () => {
    const state = pendingState();
    expect(state.applied).toBe(false);
    expect(championLifecycleStatus(state)).toBe("APPLICATION_PENDING");
  });

  it("the generation token is stable across applicationPending -> applied", () => {
    const state = pendingState();
    const proof = proofFor(state);
    const applied = markChampionApplied(state, proof);
    expect(championApplicationTargetDigestV1(applied)).toBe(championApplicationTargetDigestV1(state));
    expect(applied.applied).toBe(true);
    expect(applied.validity).toBe("PROVEN");
    expect(championLifecycleStatus(applied)).toBe("APPLIED");
  });

  it("markChampionApplied refuses a stale-generation proof", () => {
    const state = pendingState();
    const stale = proofFor(state, { stateDigest: "5".repeat(64) });
    expect(() => markChampionApplied(state, stale)).toThrow(/stale proof/);
  });

  it("markChampionApplied refuses a proof for a different candidate or level", () => {
    const state = pendingState();
    expect(() => markChampionApplied(state, proofFor(state, { candidateId: "other" }))).toThrow(/candidate/);
    expect(() => markChampionApplied(state, proofFor(state, { level: "C7" }))).toThrow(/level/);
  });

  it("a failed application keeps the claim, clears any proof, and never says applied", () => {
    const state = pendingState();
    const failed = markChampionApplicationFailed(state, {
      schemaVersion: APPLIED_PROOF_SCHEMA_VERSION,
      failedAt: "2026-09-07T00:00:00.000Z",
      runtimeEntrypoint: "cli",
      processId: "pid-2",
      reason: "config drift: featureFlags.memory",
      mismatchedKeys: ["featureFlags.memory"],
      overriddenKeys: [],
      targetConfigHash: "t",
      appliedConfigHash: "a",
    });
    expect(failed.applied).toBe(false);
    expect(failed.appliedProof).toBeUndefined();
    expect(championLifecycleStatus(failed)).toBe("APPLICATION_FAILED");
    // history preserved — the promotion is still auditable
    expect(failed.history.length).toBe(state.history.length);
  });

  it("C0 baseline reports PROVEN", () => {
    expect(championLifecycleStatus(createInitialChampionState())).toBe("PROVEN");
  });
});
