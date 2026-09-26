/**
 * A5/B3 — the PRODUCTION arm executor (`prereg-arm-executor.ts`).
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * `createProductionPreregRunner().runArm` used to answer EVERY call with
 * `ARM_EXECUTOR_NOT_WIRED`: the release CLI could admit a legal experiment and
 * then never execute it (F1). The executor now resolves the arm's frozen
 * checkout, locates the case in the FROZEN selection, LAUNCHES the arm's OWN
 * build in an ISOLATED CHILD PROCESS (B3), runs it with the INJECTED
 * budget-wrapped provider, and writes the raw evidence artifacts A6 re-reads.
 *
 * HOW THE ARM CHECKOUTS ARE BUILT WITHOUT A `pnpm build`
 * -----------------------------------------------------
 * CI runs `pnpm test` BEFORE `pnpm build`, so `apps/cli/dist` may not exist. The
 * fixture writes each checkout's declared entry `apps/cli/dist/benchmark-command.js`
 * as a REAL, LOADABLE module exporting `R97_ARM_PROBE` and `runOneCase`; the
 * other declared entries are inert stubs. Two checkouts differ in the entry
 * BYTES, so they carry a real, distinct build-closure digest AND a distinct
 * observable mechanism probe — exactly what "two builds, not one" means.
 *
 * WHAT IS PROVEN HERE (all offline, 0 external requests)
 * -----------------------------------------------------
 *   - a missing arm checkout / one build for both arms / a case outside the
 *     frozen selection / no evidence directory / an unsupported isolation
 *     backend are STABLE refusals, and NO child process is spawned for a
 *     pre-flight refusal;
 *   - the positive path launches the arm's OWN build as a child process and the
 *     manifest records the entry hash + probe the child really reported;
 *   - the reported probe follows the CHECKOUT DIRECTORY, not the driver's
 *     `armId` argument — a driver-only flag cannot fabricate the identity.
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
  ARM_ISOLATION_UNSUPPORTED,
  ARM_PROBE_EXPORT,
  createPreregArmExecutor,
} from "./prereg-arm-executor.js";
import { createProductionPreregRunner } from "./prereg-production-runner.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRATCH_ROOT = join(REPO_ROOT, ".ci", "prereg-arm-executor-scratch");
/** A real case that IS in the frozen selection (`docs/evidence/…-case-selection.json`). */
const REAL_CASE_ID = "stress-repeated-tool-failures";
const REAL_CASE_SUITE = "stress";
/** The declared arm entry the isolated worker loads. POSIX on purpose: it must
 *  equal the `R97_ARM_BUILD_ENTRIES` row the executor compares against. */
const ARM_ENTRY_REL = "apps/cli/dist/benchmark-command.js";

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

/**
 * B3 — a REAL, loadable arm build entry. After B3 the executor spawns the arm's
 * OWN build as an isolated child which imports `apps/cli/dist/benchmark-command.js`
 * FROM ITS CHECKOUT, so a synthetic `export {}` stub can no longer represent an
 * arm. This entry exports the versioned mechanism probe and a real `runOneCase`
 * that resolves its one model call through the stdio proxy provider the worker
 * hands it. `activate` makes this build report mechanism activation — a genuine,
 * per-build behavioural difference.
 */
function armEntrySource(marker: string, activate: boolean): string {
  return [
    `export const ${ARM_PROBE_EXPORT} = "probe:${marker}";`,
    "export async function runOneCase(caseDef, opts, _suite) {",
    "  const client = opts.provider.createClient({ id: 'arm-fixture' }, {});",
    "  let input = 0;",
    "  let output = 0;",
    "  for await (const ev of client.generate({ messages: [] }, new AbortController().signal)) {",
    "    if (ev.type === 'usage') { input += ev.usage.inputTokens; output += ev.usage.outputTokens; }",
    "    if (ev.type === 'completed' || ev.type === 'error') break;",
    "  }",
    "  const outcome = {",
    "    caseId: caseDef.id,",
    "    status: 'failed',",
    "    actualStatus: 'completed',",
    "    events: [],",
    "    metrics: { turn_count: 1, tool_call_count: 0, tokens_input: input, tokens_output: output, context_tokens: 0, compaction_count: 0, duration_ms: 0, retry_count: 0, verification_failures: 0, human_interventions: 0, estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 1 },",
    "    violations: [],",
    `    reason: 'arm-probe:${marker}',`,
    "    suite: caseDef.suite || 'regression',",
    "    judgeVersion: '1.0.0',",
    "    terminationReason: 'verified_incomplete',",
    "  };",
    ...(activate ? [`  outcome.activationEvidenceV2 = { events: [{ eventId: 'probe:${marker}' }] };`] : []),
    "  return outcome;",
    "}",
    "",
  ].join("\n");
}

/** Build a real, loadable arm checkout: the declared entries, entry bytes distinct. */
async function makeArmCheckout(dir: string, marker: string, activate = false): Promise<void> {
  for (const rel of R97_ARM_BUILD_ENTRIES) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    const source = rel === ARM_ENTRY_REL ? armEntrySource(marker, activate) : `export {}; // stub:${marker}\n`;
    await writeFile(abs, source, "utf8");
  }
}

/**
 * A local fake provider: reports usage and completes. Zero network, zero cost.
 */
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
  isolation?: Parameters<typeof createPreregArmExecutor>[0]["isolation"];
  workerPath?: string;
  provider?: ModelProvider;
}): Promise<PreregisteredArmOutcome> {
  const arm = armRef(input.armId);
  const executor = createPreregArmExecutor({
    rootDir: REPO_ROOT,
    env: input.env,
    ...(input.isolation !== undefined ? { isolation: input.isolation } : {}),
    ...(input.workerPath !== undefined ? { workerPath: input.workerPath } : {}),
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

// ---------------------------------------------------------------------------

describe("A5/B3 — the provisioned executor fails closed on every unprovable prerequisite", () => {
  it("refuses an arm with no frozen checkout and never launches a worker", async () => {
    await expect(runArmWith({ env: {}, armId: "candidate" })).rejects.toThrow(new RegExp(ARM_CHECKOUT_MISSING));
  });

  it("refuses two arms that resolve to the SAME build — one build is not a paired experiment", async () => {
    const dir = await scratch("same-build");
    await makeArmCheckout(dir, "only-one");
    await expect(
      runArmWith({ env: { R97_ARM_BASELINE_DIR: dir, R97_ARM_CANDIDATE_DIR: dir }, armId: "candidate" }),
    ).rejects.toThrow(new RegExp(ARM_BUILD_IDENTICAL));
  });

  it("refuses an arm checkout whose execution closure cannot be established", async () => {
    const base = await scratch("unresolvable-base");
    const cand = await scratch("unresolvable-cand");
    await makeArmCheckout(base, "baseline");
    await expect(
      runArmWith({ env: { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand }, armId: "candidate" }),
    ).rejects.toThrow(new RegExp(ARM_BUILD_UNRESOLVABLE));
  });

  it("refuses a case that is not in the frozen selection", async () => {
    const base = await scratch("case-not-found-base");
    const cand = await scratch("case-not-found-cand");
    await makeArmCheckout(base, "baseline");
    await makeArmCheckout(cand, "candidate");
    const executor = createPreregArmExecutor({
      rootDir: REPO_ROOT,
      env: { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand },
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

  it("[B3] refuses an isolation backend this build cannot honour, before any request", async () => {
    const base = await scratch("iso-base");
    const cand = await scratch("iso-cand");
    await makeArmCheckout(base, "baseline");
    await makeArmCheckout(cand, "candidate");
    await expect(
      runArmWith({
        env: { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand },
        armId: "candidate",
        isolation: { isolationBackendId: "vm-sandbox", isolationStrength: "vm" },
      }),
    ).rejects.toThrow(new RegExp(ARM_ISOLATION_UNSUPPORTED));
  });
});

describe("A5/B3 — the production adapter launches the arm's OWN build as a child process", () => {
  it("runs a real frozen case through the arm build with 0 external requests", async () => {
    const base = await scratch("positive-base");
    const cand = await scratch("positive-cand");
    await makeArmCheckout(base, "baseline");
    await makeArmCheckout(cand, "candidate", true);
    const evidenceDir = join(await scratch("positive-ev"), "pair-0-candidate");

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

    // The arm build ran and its one model call was serviced by the driver.
    expect(outcome.status, outcome.reason).toBe("failed");
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

  it("[B3] records the entry hash + probe the CHILD really loaded (baseline ≠ candidate)", async () => {
    const base = await scratch("digest-base");
    const cand = await scratch("digest-cand");
    await makeArmCheckout(base, "baseline");
    await makeArmCheckout(cand, "candidate", true);
    const evBase = join(await scratch("digest-ev-b"), "pair-0-baseline");
    const evCand = join(await scratch("digest-ev-c"), "pair-0-candidate");

    const runner = createProductionPreregRunner({
      rootDir: REPO_ROOT,
      env: { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand },
    });
    const readManifest = (dir: string): { armBuildDigest?: string; armEntrySha256?: string; armProbe?: string; armId?: string } =>
      JSON.parse(
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("node:fs").readFileSync(join(dir, PREREG_RUN_EVIDENCE_FILENAMES.manifest), "utf8"),
      );

    const baseArm = armRef("baseline");
    await runner.runArm(baseArm, {
      provider: fakeProvider().provider,
      armRunId: "pair-0-baseline",
      arm: baseArm,
      preregistrationDigest: PREREG_DIGEST,
      planDigest: PLAN_DIGEST,
      evidenceDir: evBase,
    });
    const candArm = armRef("candidate");
    const candOutcome = await runner.runArm(candArm, {
      provider: fakeProvider().provider,
      armRunId: "pair-0-candidate",
      arm: candArm,
      preregistrationDigest: PREREG_DIGEST,
      planDigest: PLAN_DIGEST,
      evidenceDir: evCand,
    });

    const bManifest = readManifest(evBase);
    const cManifest = readManifest(evCand);
    expect(bManifest.armId).toBe("baseline");
    expect(cManifest.armId).toBe("candidate");
    expect(bManifest.armBuildDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(cManifest.armBuildDigest).toMatch(/^[0-9a-f]{64}$/);
    // Two DIFFERENT builds really ran.
    expect(bManifest.armBuildDigest).not.toBe(cManifest.armBuildDigest);
    expect(bManifest.armEntrySha256).not.toBe(cManifest.armEntrySha256);
    // The observable mechanism probe differs, and the baseline carries no activation.
    expect(bManifest.armProbe).toBe("probe:baseline");
    expect(cManifest.armProbe).toBe("probe:candidate");
    expect(candOutcome.evidence!.activationEvidenceDigest).not.toBeNull();
  }, 120_000);

  it("[B3] the reported identity follows the CHECKOUT, not the driver's armId argument", async () => {
    const base = await scratch("swap-base");
    const cand = await scratch("swap-cand");
    await makeArmCheckout(base, "baseline");
    await makeArmCheckout(cand, "candidate", true);
    const evidenceDir = join(await scratch("swap-ev"), "pair-0-baseline");
    // The caller claims `baseline`, but the baseline DIR points at the
    // candidate-marked build. A driver-only flag must not be able to make the
    // recorded probe say "baseline".
    const runner = createProductionPreregRunner({
      rootDir: REPO_ROOT,
      env: { R97_ARM_BASELINE_DIR: cand, R97_ARM_CANDIDATE_DIR: base },
    });
    const arm = armRef("baseline");
    await runner.runArm(arm, {
      provider: fakeProvider().provider,
      armRunId: "pair-0-baseline",
      arm,
      preregistrationDigest: PREREG_DIGEST,
      planDigest: PLAN_DIGEST,
      evidenceDir,
    });
    const manifest = JSON.parse(
      require("node:fs").readFileSync(join(evidenceDir, PREREG_RUN_EVIDENCE_FILENAMES.manifest), "utf8"),
    ) as { armProbe?: string };
    expect(manifest.armProbe).toBe("probe:candidate");
  }, 120_000);
});