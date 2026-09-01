import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialChampionState, applyPromotion } from "@ar/evaluation";
import {
  readChampionStateFile,
  writeChampionStateFile,
  writeChampionStateFileCas,
  championStateDigest,
} from "./champion-state-file.js";

let dir = "";
afterEach(async () => {
  if (dir !== "") {
    await rm(dir, { recursive: true, force: true });
    dir = "";
  }
});

async function tmpPath(): Promise<string> {
  if (dir === "") dir = await mkdtemp(join(tmpdir(), "champion-state-"));
  return join(dir, "champion-state.json");
}

describe("champion-state-file (E1-14)", () => {
  it("missing file returns the initial C0 state (not an error)", async () => {
    const p = await tmpPath();
    const state = await readChampionStateFile(p);
    expect(state instanceof Error).toBe(false);
    if (!(state instanceof Error)) {
      expect(state.level).toBe("C0");
      expect(state.candidateId).toBeNull();
    }
  });

  it("write and read back a C1 state", async () => {
    const p = await tmpPath();
    const c0 = createInitialChampionState();
    const c1 = applyPromotion(c0, "memory_retrieval", { features: { memory: true } }, "runs/holdout.json");
    await writeChampionStateFile(c1, p);
    const loaded = await readChampionStateFile(p);
    expect(loaded instanceof Error).toBe(false);
    if (!(loaded instanceof Error)) {
      expect(loaded.level).toBe("C1");
      expect(loaded.candidateId).toBe("memory_retrieval");
      expect(loaded.evidenceRef).toBe("runs/holdout.json");
      expect(loaded.history).toHaveLength(1);
      expect(loaded.applied).toBe(true); // writeChampionStateFile always marks applied=true
    }
  });

  it("invalid JSON returns an error (fail-closed)", async () => {
    const p = await tmpPath();
    // Write non-JSON data.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(p, "not valid json", "utf8");
    const state = await readChampionStateFile(p);
    expect(state instanceof Error).toBe(true);
  });

  it("CAS write succeeds when the expected digest matches (E2-07)", async () => {
    const p = await tmpPath();
    const c0 = createInitialChampionState();
    await writeChampionStateFile(c0, p);
    const c1 = applyPromotion(c0, "adaptive_recovery_v2", { adaptiveRecovery: "conservative-v1" }, "env.json", {
      envelopeDigest: "env-digest",
    });
    const expected = championStateDigest(c0);
    const result = await writeChampionStateFileCas(c1, expected, p);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.digest).toBe(championStateDigest(c1));
    const loaded = await readChampionStateFile(p);
    expect(loaded instanceof Error).toBe(false);
    if (!(loaded instanceof Error)) expect(loaded.level).toBe("C1");
  });

  it("concurrent promote: second CAS write on the same parent is rejected as STALE (E2-07)", async () => {
    const p = await tmpPath();
    const c0 = createInitialChampionState();
    await writeChampionStateFile(c0, p);
    const expected = championStateDigest(c0);

    // Writer A wins.
    const c1a = applyPromotion(c0, "adaptive_recovery_v2", { adaptiveRecovery: "conservative-v1" }, "envA", {
      envelopeDigest: "env-a",
    });
    const a = await writeChampionStateFileCas(c1a, expected, p);
    expect(a.ok).toBe(true);

    // Writer B still holds the SAME parent digest but the file already moved.
    const c1b = applyPromotion(c0, "budget_aware_completion_v1", { completionPolicy: "budget_aware" }, "envB", {
      envelopeDigest: "env-b",
    });
    const b = await writeChampionStateFileCas(c1b, expected, p);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.stale).toBe(true);
  });

  it("idempotent duplicate envelope: same promotion applied twice from the same parent is a STALE reject, not a second C(n) (E2-07)", async () => {
    const p = await tmpPath();
    const c0 = createInitialChampionState();
    await writeChampionStateFile(c0, p);
    const expected = championStateDigest(c0);

    const c1 = applyPromotion(c0, "adaptive_recovery_v2", { adaptiveRecovery: "conservative-v1" }, "env.json", {
      envelopeDigest: "dup-env",
    });
    const first = await writeChampionStateFileCas(c1, expected, p);
    expect(first.ok).toBe(true);

    // Re-submitting the SAME envelope/promotion from the original parent
    // digest is rejected (state already advanced) — no duplicate C1 branch.
    const second = await writeChampionStateFileCas(c1, expected, p);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.stale).toBe(true);
  });
});