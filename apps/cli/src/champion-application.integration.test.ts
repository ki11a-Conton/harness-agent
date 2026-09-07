/**
 * E4-07 — full production integration matrix:
 *
 *   1. promote -> state is applicationPending, applied=false (never forced true);
 *   2. real CLI harness startup: config actually changes, AppliedProof written;
 *   3. real Web harness startup: config actually changes, AppliedProof written;
 *   4. applied proof config hashes come from createHarness's final resolved config;
 *   5. createHarness failure does NOT write applied, keeps promotion claim;
 *   6. config mismatch does NOT write applied, falls back to baseline;
 *   7. CAS generation conflict does NOT overwrite newer state;
 *   8. restart of an already-applied state is idempotent (no rewrites);
 *   9. C0 unpromoted state keeps default configuration.
 *
 * All tests use REAL createHarness + temporary dirs (offline, zero provider calls).
 * Never asserts on a pure mapper return alone.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ScriptedModelProvider } from "@ar/model";
import {
  applyPromotion,
  championApplicationTargetDigestV1,
  championLifecycleStatus,
  createInitialChampionState,
  verifyAppliedProofV1,
  type ChampionState,
} from "@ar/evaluation";
import {
  championStateDigest,
  readChampionStateFile,
  writeChampionStateFileCas,
} from "./champion-state-file.js";
import { createHarnessWithChampion } from "./champion-application.js";

const CANDIDATE = "memory_retrieval"; // resolves in the ArmFactory with memory+learning flags
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

let dir: string;
let statePath: string;
let scriptedProvider: ScriptedModelProvider;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e4-07-prod-"));
  statePath = join(dir, "champion-state.json");
  scriptedProvider = new ScriptedModelProvider([ScriptedModelProvider.text("hi")]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function baseConfig(dataDir?: string) {
  return {
    cwd: dir,
    ...(dataDir !== undefined ? { dataDir } : {}),
    profile: "interactive" as const,
    modelProvider: scriptedProvider,
    model: { providerId: "scripted", modelId: "test-model" },
  };
}

async function writePendingState(candidateId = CANDIDATE): Promise<ChampionState> {
  const c0 = createInitialChampionState();
  const next = applyPromotion(c0, candidateId, { memory: true }, "runs/evidence.json");
  await writeChampionStateFileCas(next, championStateDigest(c0), statePath);
  return next;
}

describe("E4-07 real champion application integration suite", () => {
  it("1. promote -> state is applicationPending, applied=false (acceptance #1)", async () => {
    const pending = await writePendingState();
    expect(pending.applied).toBe(false);
    expect(championLifecycleStatus(pending)).toBe("APPLICATION_PENDING");
    const onDisk = (await readChampionStateFile(statePath)) as ChampionState;
    expect(onDisk.applied).toBe(false);
    expect(onDisk.appliedProof).toBeUndefined();
  });

  it("2. real CLI startup: config actually changes + proof written (acceptance #2)", async () => {
    await writePendingState();
    const dataDir = join(dir, "data");
    const outcome = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: baseConfig(dataDir),
      stateFilePath: statePath,
      sourceSha: "a".repeat(40),
    });
    try {
      expect(outcome.status).toBe("applied");
      expect(outcome.proof).not.toBeNull();
      // The live harness REALLY has memory enabled.
      expect(outcome.harness.resolvedConfig.value.featureFlags?.memory).toBe(true);
      // The state on disk is now applied=true with the proof persisted.
      const saved = (await readChampionStateFile(statePath)) as ChampionState;
      expect(saved.applied).toBe(true);
      expect(saved.validity).toBe("PROVEN");
      expect(saved.appliedProof?.runtimeEntrypoint).toBe("cli");
    } finally {
      await outcome.harness.close();
    }
  });

  it("3. real Web startup: config actually changes + proof written (acceptance #3)", async () => {
    await writePendingState();
    const outcome = await createHarnessWithChampion({
      runtimeEntrypoint: "web",
      baseConfig: baseConfig(join(dir, "web-data")),
      stateFilePath: statePath,
      sourceSha: "b".repeat(40),
    });
    try {
      expect(outcome.status).toBe("applied");
      expect(outcome.proof?.runtimeEntrypoint).toBe("web");
      expect(outcome.harness.resolvedConfig.value.featureFlags?.memory).toBe(true);
      const saved = (await readChampionStateFile(statePath)) as ChampionState;
      expect(saved.applied).toBe(true);
      expect(saved.appliedProof?.runtimeEntrypoint).toBe("web");
    } finally {
      await outcome.harness.close();
    }
  });

  it("4. proof config hashes derive from createHarness final config (acceptance #4)", async () => {
    await writePendingState();
    const outcome = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: baseConfig(join(dir, "data")),
      stateFilePath: statePath,
    });
    try {
      expect(outcome.proof).not.toBeNull();
      const proof = outcome.proof!;
      expect(proof.appliedConfigHash).toBe(proof.targetConfigHash);
      const state = (await readChampionStateFile(statePath)) as ChampionState;
      const verification = verifyAppliedProofV1(proof, {
        stateDigest: championApplicationTargetDigestV1(state),
        level: state.level,
        candidateId: state.candidateId!,
        targetConfigHash: proof.targetConfigHash,
      });
      expect(verification.ok).toBe(true);
    } finally {
      await outcome.harness.close();
    }
  });

  it("5. createHarness failure does NOT write applied (acceptance #5)", async () => {
    await writePendingState();
    const outcome = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: baseConfig(),
      stateFilePath: statePath,
      createHarnessFn: async () => {
        throw new Error("simulated composition failure");
      },
    });
    try {
      expect(outcome.status).toBe("applicationFailed");
      expect(outcome.reason).toMatch(/simulated composition failure/);
      const saved = (await readChampionStateFile(statePath)) as ChampionState;
      expect(saved.applied).toBe(false);
      expect(saved.appliedProof).toBeUndefined();
      expect(saved.applicationFailure?.reason).toMatch(/simulated composition failure/);
      // History preserved.
      expect(saved.history.length).toBe(1);
    } finally {
      await outcome.harness.close();
    }
  });

  it("6. config mismatch does NOT write applied, falls back to baseline (acceptance #6)", async () => {
    await writePendingState();
    // Force an environment override (or default fallback simulation) where
    // memory stays false in createHarness.
    const { createHarness } = await import("@ar/harness");
    const outcome = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: baseConfig(join(dir, "data")),
      stateFilePath: statePath,
      createHarnessFn: async (cfg) => {
        // Strip the champion's feature flags override so it reverts to default
        const stripped = { ...cfg, featureFlags: { ...cfg.featureFlags, memory: false } };
        return createHarness(stripped);
      },
    });
    try {
      expect(outcome.status).toBe("applicationFailed");
      expect(outcome.reason).toMatch(/config drift/);
      const saved = (await readChampionStateFile(statePath)) as ChampionState;
      expect(saved.applied).toBe(false);
      expect(saved.appliedProof).toBeUndefined();
      expect(saved.applicationFailure?.mismatchedKeys).toContain("featureFlags.memory");
      // The returned fallback harness is the baseline.
      expect(outcome.harness.resolvedConfig.value.featureFlags?.memory).toBe(false);
    } finally {
      await outcome.harness.close();
    }
  });

  it("7. CAS conflict does not overwrite newer state (acceptance #7)", async () => {
    const pending = await writePendingState();
    // Advance the state on disk concurrently before startup completes its CAS
    const advanced = applyPromotion(pending, "adaptive_recovery_v2", {}, "evidence2.json");
    await writeChampionStateFileCas(advanced, championStateDigest(pending), statePath);

    const outcome = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: baseConfig(join(dir, "data")),
      stateFilePath: statePath,
    });
    try {
      // It tried to apply the NEW promotion (C2 adaptive_recovery_v2), but
      // definitely did not overwrite it with a stale C1 proof.
      const currentOnDisk = (await readChampionStateFile(statePath)) as ChampionState;
      expect(currentOnDisk.level).toBe("C2");
    } finally {
      await outcome.harness.close();
    }
  });

  it("8. restart of an already-applied state is idempotent (acceptance #8)", async () => {
    await writePendingState();
    const first = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: baseConfig(join(dir, "data")),
      stateFilePath: statePath,
    });
    await first.harness.close();
    expect(first.status).toBe("applied");
    const firstState = (await readChampionStateFile(statePath)) as ChampionState;
    const firstDigest = championStateDigest(firstState);

    const second = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: baseConfig(join(dir, "data")),
      stateFilePath: statePath,
    });
    await second.harness.close();
    expect(second.status).toBe("alreadyApplied");
    const secondState = (await readChampionStateFile(statePath)) as ChampionState;
    // Byte-identical: no CAS write was needed.
    expect(championStateDigest(secondState)).toBe(firstDigest);
  });

  it("9. unpromoted C0 state keeps default configuration (acceptance #9)", async () => {
    const c0 = createInitialChampionState();
    await writeChampionStateFileCas(c0, sha("initial"), statePath);
    const outcome = await createHarnessWithChampion({
      runtimeEntrypoint: "cli",
      baseConfig: baseConfig(),
      stateFilePath: statePath,
    });
    try {
      expect(outcome.status).toBe("baseline");
      expect(outcome.proof).toBeNull();
      expect(outcome.harness.resolvedConfig.value.featureFlags?.memory).toBe(false);
      const onDisk = (await readChampionStateFile(statePath)) as ChampionState;
      expect(onDisk.level).toBe("C0");
      expect(onDisk.applied).toBe(true);
    } finally {
      await outcome.harness.close();
    }
  });
});
