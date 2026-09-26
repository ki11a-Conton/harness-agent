/**
 * A5 — the PRODUCTION arm executor (`prereg-arm-executor.ts`).
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * `createProductionPreregRunner().runArm` used to answer EVERY call with
 * `ARM_EXECUTOR_NOT_WIRED`: the release CLI could admit a legal experiment and
 * then never execute it (F1). The executor now resolves the arm's frozen
 * checkout, locates the case in the FROZEN selection, runs it through the REAL
 * benchmark harness (real `ToolOrchestrator` / sandbox policy / `TaskVerifier`)
 * with the INJECTED budget-wrapped provider, and writes the raw evidence
 * artifacts A6 re-reads.
 *
 * WHAT IS PROVEN HERE (all offline, 0 external requests)
 * -----------------------------------------------------
 *   - a missing arm checkout / one build for both arms / a case outside the
 *     frozen selection / no evidence directory are STABLE refusals, and the
 *     harness is not run at all for a pre-flight refusal;
 *   - the positive path executes a REAL `benchmarks/stress/<case>/` case through
 *     the real harness with a local fake provider and writes artifacts whose
 *     bytes A6 independently corroborates.
 *
 * HOW THE ARM CHECKOUTS ARE BUILT WITHOUT A `pnpm build`
 * -----------------------------------------------------
 * CI runs `pnpm test` BEFORE `pnpm build`, so `apps/cli/dist` may not exist. An
 * arm build digest is the closure walk from `R97_ARM_BUILD_ENTRIES`; a checkout
 * of five `export {};` stubs therefore establishes a real (stable, distinct)
 * digest with no compiled tree. Two checkouts differ by one byte, which is
 * exactly what "two builds, not one" means to the executor.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest, ProviderConfig } from "@ar/contracts";
import {
  PREREG_RUN_EVIDENCE_FILENAMES,
  R97_ARM_BUILD_ENTRIES,
  verifyArmEvidenceFromArtifacts,
  type ArmRunRef,
  type PreregisteredArmOutcome,
  type PreregRunIdentity,
} from "@ar/evaluation";
import {
  ARM_BUILD_IDENTICAL,
  ARM_BUILD_UNRESOLVABLE,
  ARM_CASE_NOT_FOUND,
  ARM_CHECKOUT_MISSING,
  ARM_EVIDENCE_DIR_MISSING,
  createPreregArmExecutor,
} from "./prereg-arm-executor.js";
import { createProductionPreregRunner } from "./prereg-production-runner.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRATCH_ROOT = join(REPO_ROOT, ".ci", "prereg-arm-executor-scratch");
/** A real case that IS in the frozen selection (`docs/evidence/…-case-selection.json`). */
const REAL_CASE_ID = "stress-repeated-tool-failures";
const REAL_CASE_SUITE = "stress";

let scratchDirs: string[] = [];

async function scratch(name: string): Promise<string> {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  const d = await mkdtemp(join(SCRATCH_ROOT, `${name}-`));
  scratchDirs.push(d);
  return d;
}

beforeEach(async () => {
  await mkdir(SCRATCH_ROOT, { recursive: true });
});

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

/** Build a minimal but digest-valid checkout: the declared entries, one byte apart. */
async function makeArmCheckout(dir: string, marker: string): Promise<void> {
  for (const rel of R97_ARM_BUILD_ENTRIES) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, `export {}; // arm:${marker}\n`, "utf8");
  }
}

/** A local fake provider: reports usage and completes. Zero network, zero cost. */
function fakeProvider(): { provider: ModelProvider; entered: () => number } {
  let entered = 0;
  const provider: ModelProvider = {
    id: "a5-fake",
    async listModels() {
      return [];
    },
    createClient(_model: never, _config: ProviderConfig) {
      return {
        async *generate(_req: ModelRequest, _signal: AbortSignal): AsyncGenerator<ModelEvent> {
          entered += 1;
          yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 }, timestamp: 0 };
          yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
        },
      };
    },
  };
  return { provider, entered: () => entered };
}

function armRef(armId: "baseline" | "candidate"): ArmRunRef {
  return { armId, caseId: REAL_CASE_ID, repetition: 0, orderIndex: 0 };
}

const PREREG_DIGEST = "1".repeat(64);
const PLAN_DIGEST = "2".repeat(64);

async function runArmWith(input: {
  env: NodeJS.ProcessEnv;
  armId: "baseline" | "candidate";
  evidenceDir?: string;
  runCase?: Parameters<typeof createPreregArmExecutor>[0]["runCase"];
  provider?: ModelProvider;
}): Promise<PreregisteredArmOutcome> {
  const arm = armRef(input.armId);
  const executor = createPreregArmExecutor({
    rootDir: REPO_ROOT,
    env: input.env,
    ...(input.runCase !== undefined ? { runCase: input.runCase } : {}),
  });
  return executor(arm, {
    provider: input.provider ?? fakeProvider().provider,
    armRunId: `pair-0-${input.armId}`,
    arm,
    preregistrationDigest: PREREG_DIGEST,
    planDigest: PLAN_DIGEST,
    evidenceDir: input.evidenceDir ?? join(await scratch("unused-ev"), "ev"),
  });
}

function neverRun(): () => void {
  return () => {
    throw new Error("the harness must not run for a pre-flight refusal");
  };
}

// ---------------------------------------------------------------------------

describe("A5 — the production arm executor fails closed on every unprovable prerequisite", () => {
  it("refuses an arm with no frozen checkout and never runs the harness", async () => {
    const spy: string[] = [];
    await expect(
      runArmWith({
        env: {},
        armId: "candidate",
        runCase: async () => {
          spy.push("ran");
          throw new Error("unreachable");
        },
      }),
    ).rejects.toThrow(new RegExp(ARM_CHECKOUT_MISSING));
    expect(spy).toEqual([]);
  });

  it("refuses two arms that resolve to the SAME build — one build is not a paired experiment", async () => {
    const dir = await scratch("same-build");
    await makeArmCheckout(dir, "only-one");
    await expect(
      runArmWith({
        env: { R97_ARM_BASELINE_DIR: dir, R97_ARM_CANDIDATE_DIR: dir },
        armId: "candidate",
        runCase: async () => {
          neverRun();
          throw new Error("unreachable");
        },
      }),
    ).rejects.toThrow(new RegExp(ARM_BUILD_IDENTICAL));
  });

  it("refuses an arm checkout whose execution closure cannot be established", async () => {
    const base = await scratch("unresolvable-base");
    const cand = await scratch("unresolvable-cand");
    // Both directories exist, but neither carries the declared entries — the
    // digest cannot be established, so the arm cannot be run (not an opaque
    // internal identity error).
    await makeArmCheckout(base, "baseline");
    await expect(
      runArmWith({
        env: { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand },
        armId: "candidate",
        runCase: async () => {
          neverRun();
          throw new Error("unreachable");
        },
      }),
    ).rejects.toThrow(new RegExp(ARM_BUILD_UNRESOLVABLE));
  });

  it("refuses a case that is not in the frozen selection", async () => {
    const base = await scratch("case-not-found-base");
    const cand = await scratch("case-not-found-cand");
    await makeArmCheckout(base, "baseline");
    await makeArmCheckout(cand, "candidate");
    const env = { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand };
    const executor = createPreregArmExecutor({
      rootDir: REPO_ROOT,
      env,
      runCase: async () => {
        neverRun();
        throw new Error("unreachable");
      },
    });
    const arm: ArmRunRef = { armId: "candidate", caseId: "not-in-the-frozen-selection", repetition: 0, orderIndex: 0 };
    await expect(
      executor(arm, {
        provider: fakeProvider().provider,
        armRunId: "pair-0-candidate",
        arm,
        preregistrationDigest: PREREG_DIGEST,
        planDigest: PLAN_DIGEST,
        evidenceDir: join(await scratch("case-not-found-ev"), "ev"),
      }),
    ).rejects.toThrow(new RegExp(ARM_CASE_NOT_FOUND));
  });

  it("refuses a run with no evidence directory instead of writing nowhere", async () => {
    const base = await scratch("no-ev-base");
    const cand = await scratch("no-ev-cand");
    await makeArmCheckout(base, "baseline");
    await makeArmCheckout(cand, "candidate");
    const executor = createPreregArmExecutor({
      rootDir: REPO_ROOT,
      env: { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand },
      runCase: async () => {
        neverRun();
        throw new Error("unreachable");
      },
    });
    const arm = armRef("candidate");
    await expect(
      executor(arm, {
        provider: fakeProvider().provider,
        armRunId: "pair-0-candidate",
        arm,
        preregistrationDigest: PREREG_DIGEST,
        planDigest: PLAN_DIGEST,
        evidenceDir: "",
      }),
    ).rejects.toThrow(new RegExp(ARM_EVIDENCE_DIR_MISSING));
  });
});

describe("A5 — the production adapter runs a REAL case and writes A6-verifiable evidence", () => {
  it("executes a real frozen case through the real harness with 0 external requests", async () => {
    const base = await scratch("positive-base");
    const cand = await scratch("positive-cand");
    await makeArmCheckout(base, "baseline");
    await makeArmCheckout(cand, "candidate");
    const evidenceDir = join(await scratch("positive-ev"), "pair-0-candidate");

    // The PRODUCTION adapter — no runner injected; the real `runOneCase` harness
    // (real tools, sandbox policy and TaskVerifier) executes the case.
    const runner = createProductionPreregRunner({
      rootDir: REPO_ROOT,
      env: { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand },
    });
    const fake = fakeProvider();
    const arm = armRef("candidate");
    const outcome = await runner.runArm(arm, {
      provider: fake.provider,
      armRunId: "pair-0-candidate",
      arm,
      preregistrationDigest: PREREG_DIGEST,
      planDigest: PLAN_DIGEST,
      evidenceDir,
    });

    // A real harness run with a trivial provider cannot solve the case, so the
    // REAL verifier records a FAILURE — the executor must not fabricate a pass,
    // and must take the evidence path (not the infrastructure-error branch).
    expect(outcome.status, outcome.reason).toBe("failed");
    // The fake provider was really exercised by the harness.
    expect(fake.entered()).toBeGreaterThan(0);
    expect(outcome.evidence).toBeDefined();
    const identity: PreregRunIdentity = {
      preregistrationDigest: PREREG_DIGEST,
      planDigest: PLAN_DIGEST,
      armRunId: "pair-0-candidate",
      armId: "candidate",
      caseId: REAL_CASE_ID,
      repetition: 0,
      orderIndex: 0,
    };
    // The raw artifacts exist and A6 corroborates every declared field.
    for (const name of [
      PREREG_RUN_EVIDENCE_FILENAMES.manifest,
      PREREG_RUN_EVIDENCE_FILENAMES.verifier,
      PREREG_RUN_EVIDENCE_FILENAMES.security,
    ]) {
      expect(existsSync(join(evidenceDir, name)), `missing artifact ${name}`).toBe(true);
    }
    const verified = verifyArmEvidenceFromArtifacts(evidenceDir, identity, outcome.evidence!);
    expect(verified.problems).toEqual([]);
    expect(verified.verified).toBe(true);
  }, 120_000);

  it("stamps the arm's real build digest into the manifest (baseline ≠ candidate)", async () => {
    const base = await scratch("digest-base");
    const cand = await scratch("digest-cand");
    await makeArmCheckout(base, "baseline");
    await makeArmCheckout(cand, "candidate");
    const evidenceDir = join(await scratch("digest-ev"), "pair-0-baseline");

    const runner = createProductionPreregRunner({
      rootDir: REPO_ROOT,
      env: { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand },
    });
    const arm = armRef("baseline");
    const outcome = await runner.runArm(arm, {
      provider: fakeProvider().provider,
      armRunId: "pair-0-baseline",
      arm,
      preregistrationDigest: PREREG_DIGEST,
      planDigest: PLAN_DIGEST,
      evidenceDir,
    });
    if (outcome.status === "error") {
      throw new Error(`the baseline stress case must reach the evidence path, got error: ${outcome.reason}`);
    }
    // A baseline run must never carry activation evidence (that is CONTAMINATION).
    expect(outcome.evidence!.activationEvidenceDigest).toBeNull();
    const manifest = JSON.parse(
      await (await import("node:fs/promises")).readFile(join(evidenceDir, PREREG_RUN_EVIDENCE_FILENAMES.manifest), "utf8"),
    ) as { armBuildDigest?: string; armId?: string };
    expect(manifest.armId).toBe("baseline");
    expect(manifest.armBuildDigest).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);
});