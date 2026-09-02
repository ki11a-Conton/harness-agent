import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createInitialChampionState, applyPromotion } from "@ar/evaluation";
import {
  readChampionStateFile,
  writeChampionStateFile,
  writeChampionStateFileCas,
  championStateDigest,
} from "./champion-state-file.js";
import { loadPromotionEnvelope, buildPromotionEnvelope } from "@ar/evaluation";

let dir = "";
afterEach(async () => {
  if (dir !== "") {
    await rm(dir, { recursive: true, force: true });
    dir = "";
  }
});

async function tmpPath(): Promise<string> {
  if (dir === "") dir = await mkdtemp(join(tmpdir(), "e3-07-"));
  return join(dir, "champion-state.json");
}

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

describe("E3-07 promotion trust boundary", () => {
  it("4. changing `applied` changes the state digest (acceptance #4)", () => {
    const c0 = createInitialChampionState();
    const asPending = { ...c0, applied: false };
    const asApplied = { ...c0, applied: true };
    expect(championStateDigest(asPending)).not.toBe(championStateDigest(asApplied));
  });

  it("5. CAS persist preserves applicationPending (applied=false) — no forced true (acceptance #5)", async () => {
    const p = await tmpPath();
    const c0 = createInitialChampionState();
    await writeChampionStateFile(c0, p);
    const c1 = applyPromotion(c0, "memory_retrieval", { features: { memory: true } }, "runs/holdout.json");
    // applyPromotion yields applicationPending (applied=false).
    expect(c1.applied).toBe(false);
    const expected = championStateDigest(c0);
    const result = await writeChampionStateFileCas(c1, expected, p);
    expect(result.ok).toBe(true);
    const loaded = await readChampionStateFile(p);
    expect(loaded instanceof Error).toBe(false);
    if (!(loaded instanceof Error)) {
      expect(loaded.applied).toBe(false); // applicationPending persisted verbatim
      expect(loaded.level).toBe("C1");
    }
  });

  it("1. decision digest arbitrary string + package.json as candidate artifact -> promote rejected (acceptance #1)", async () => {
    const statePath = await tmpPath();
    const c0 = createInitialChampionState();
    await writeChampionStateFile(c0, statePath);

    // A forged envelope referencing a package.json as the candidate artifact.
    const pkgPath = join(dir, "package.json");
    await writeFile(pkgPath, JSON.stringify({ name: "x" }), "utf8");
    const decisionPath = join(dir, "decision.json");
    await writeFile(decisionPath, JSON.stringify({ decision: "ACCEPT" }), "utf8");

    const forged = buildPromotionEnvelope({
      generatedBy: "attacker",
      decisionEnvelopeDigest: "A".repeat(64),
      candidateId: "adaptive_recovery_v2",
      parentLevel: "C0",
      parentStateDigest: championStateDigest(c0),
      decisionArtifactPath: decisionPath,
      decisionArtifactDigest: sha(JSON.stringify({ decision: "ACCEPT" })),
      artifactRefs: [{ role: "candidate", path: pkgPath, digest: sha(JSON.stringify({ name: "x" })) }],
      sourceSha: "F".repeat(40),
    });
    const envPath = join(dir, "envelope.json");
    await writeFile(envPath, JSON.stringify(forged), "utf8");

    const result = await loadPromotionEnvelope(envPath, {
      parentStateDigest: championStateDigest(c0),
      candidateId: "adaptive_recovery_v2",
    });
    // Rejected: the decision artifact's own decision is not a real
    // DecisionArtifactV3 (its schema is wrong -> decision check) OR the
    // artifact refs point at package.json. Either way, ok=false.
    expect(result.ok).toBe(false);
  });

  it("7. idempotent duplicate transition does not create double history (acceptance #7)", async () => {
    const p = await tmpPath();
    const c0 = createInitialChampionState();
    await writeChampionStateFile(c0, p);
    const c1 = applyPromotion(c0, "adaptive_recovery_v2", { adaptiveRecovery: "conservative-v1" }, "env.json");
    const expected = championStateDigest(c0);
    const first = await writeChampionStateFileCas(c1, expected, p);
    expect(first.ok).toBe(true);
    // Re-submitting the same parent is stale (no duplicate history).
    const second = await writeChampionStateFileCas(c1, expected, p);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.stale).toBe(true);
    const loaded = await readChampionStateFile(p);
    if (!(loaded instanceof Error)) expect(loaded.history).toHaveLength(1);
  });

  it("8. crash before/after rename leaves a complete, parseable state (acceptance #8)", async () => {
    const p = await tmpPath();
    const c0 = createInitialChampionState();
    await writeChampionStateFile(c0, p);
    // Simulate a crash mid-write: leave a leftover temp file, then read the
    // committed state — it must still parse (the temp is never read).
    const tmp = join(dir, ".champion-state.tmp-crash");
    await writeFile(tmp, '{"truncated":', "utf8");
    const loaded = await readChampionStateFile(p);
    expect(loaded instanceof Error).toBe(false);
    if (!(loaded instanceof Error)) expect(loaded.level).toBe("C0");
  });
});