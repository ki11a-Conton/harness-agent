/**
 * N0 — RED behavior counterexamples for the NEXT round's gaps (N1/N2/N5),
 * CLI side. plan(20260926-175819).md §N0.
 *
 * WHAT THIS FILE IS
 * -----------------
 * N0 does not fix production code. It turns the risks the plan lists into
 * OFFLINE, INDIVIDUALLY RUNNABLE counterexamples that FAIL on the audited HEAD
 * (`1299e5cb`) and become GREEN only when N1/N2/N5 actually close them.
 *
 * Every test here is BEHAVIOURAL: it imports/executes the shipped code (or the
 * shipped worker as a real child process) and asserts on the value, exit code or
 * side effect it produces. No test asserts on source text.
 *
 * SAFETY
 * ------
 * Zero external network, zero real provider, zero cost. The only socket any test
 * opens is a LOOPBACK server it created itself on 127.0.0.1, and only to prove
 * that the arm worker is NOT a network sandbox. Scratch directories live under
 * the gitignored `.ci/` path and are removed per test.
 *
 * THE COUNTEREXAMPLES
 * -------------------
 *   N1  the arm worker requires the loaded build to export `runOneCase` AND a
 *       non-empty `R97_ARM_PROBE`; the SHIPPED `benchmark-command` module
 *       exports `runOneCase` but NO probe, so a real frozen build cannot be an
 *       arm. Only a hand-written fixture satisfies the ABI today.
 *   N2  the pre-registration's declared `isolation` never reaches the executor:
 *       `createProductionPreregRunner` constructs `createPreregArmExecutor`
 *       WITHOUT the isolation contract, so an experiment declaring an
 *       unsupported backend is refused later (or for the wrong reason) instead
 *       of `ARM_ISOLATION_UNSUPPORTED` before any arm work.
 *   N5  the worker environment is built by copying ALL of the driver env and
 *       deleting four provider keys. That is not a credential boundary and not a
 *       network sandbox: an arbitrary inherited variable is visible to the arm
 *       build, and the arm build can reach a loopback endpoint directly.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest, ProviderConfig } from "@ar/contracts";
import {
  R97_ARM_BUILD_ENTRIES,
  type ArmRunRef,
  type PreregisteredArmContext,
  type PreregisteredArmOutcome,
} from "@ar/evaluation";
import {
  ARM_ISOLATION_UNSUPPORTED,
  ARM_PROBE_EXPORT,
  ARM_WORKER_RESULT_SENTINEL,
  PREREG_ARM_WORKER_REL,
  createPreregArmExecutor,
} from "./prereg-arm-executor.js";
import { createProductionPreregRunner } from "./prereg-production-runner.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRATCH_ROOT = join(REPO_ROOT, ".ci", "prereg-n0-scratch");
const WORKER_PATH = join(REPO_ROOT, PREREG_ARM_WORKER_REL);
/** A real case that IS in the frozen selection. */
const REAL_CASE_ID = "stress-repeated-tool-failures";
const ARM_ENTRY_REL = "apps/cli/dist/benchmark-command.js";

const PREREG_DIGEST = "1".repeat(64);
const PLAN_DIGEST = "2".repeat(64);

let scratchDirs: string[] = [];
let servers: Server[] = [];

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
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

/** A local fake provider: reports usage and completes. Zero network, zero cost. */
function fakeProvider(): ModelProvider {
  return {
    id: "n0-fake",
    async listModels() {
      return [];
    },
    createClient(_model: never, _config: ProviderConfig) {
      return {
        async *generate(_req: ModelRequest, _signal: AbortSignal): AsyncGenerator<ModelEvent> {
          yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 }, timestamp: 0 };
          yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
        },
      };
    },
  };
}

/** A minimal arm outcome the driver can accept (no provider call). */
function armOutcomeSource(marker: string): string[] {
  return [
    "export async function runOneCase(caseDef, _opts, _suite) {",
    "  return {",
    "    caseId: caseDef.id,",
    "    status: 'failed',",
    "    actualStatus: 'completed',",
    "    events: [],",
    "    metrics: { turn_count: 0, tool_call_count: 0, tokens_input: 0, tokens_output: 0, context_tokens: 0, compaction_count: 0, duration_ms: 0, retry_count: 0, verification_failures: 0, human_interventions: 0, estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 0 },",
    "    violations: [],",
    `    reason: 'n0-probe:${marker}',`,
    "    suite: caseDef.suite || 'stress',",
    "    judgeVersion: '1.0.0',",
    "    terminationReason: 'verified_incomplete',",
    "  };",
    "}",
    "",
  ];
}

/**
 * Build a real, loadable arm checkout whose entry starts with `prefix` lines
 * (the observable side effect) and then exports the full worker ABI + a minimal
 * `runOneCase`. Two checkouts differ in entry bytes, so they carry distinct
 * build-closure digests.
 */
async function makeArmCheckout(dir: string, marker: string, prefix: string[]): Promise<void> {
  for (const rel of R97_ARM_BUILD_ENTRIES) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    const source = rel === ARM_ENTRY_REL
      ? [...prefix, `export const ${ARM_PROBE_EXPORT} = "probe:${marker}";`, ...armOutcomeSource(marker)].join("\n")
      : `export const N0_SIBLING_STUB_${marker} = ${JSON.stringify(`sibling:${marker}`)};\n`;
    await writeFile(abs, source, "utf8");
  }
}

function armRef(armId: "baseline" | "candidate"): ArmRunRef {
  return { armId, caseId: REAL_CASE_ID, repetition: 0, orderIndex: 0 };
}

async function contextFor(
  evidenceDir: string,
  armId: "baseline" | "candidate",
  // N2 — the isolation contract the DRIVER forwards from the frozen artifact.
  // Defaults to the shipped, honest contract; a test declares something else to
  // prove the adapter validates what the pre-registration actually named.
  isolation: { isolationBackendId: string; isolationStrength: string } = {
    isolationBackendId: "process-exec",
    isolationStrength: "process",
  },
): Promise<PreregisteredArmContext> {
  return {
    provider: fakeProvider(),
    armRunId: `${armId}-run`,
    arm: armRef(armId),
    preregistrationDigest: PREREG_DIGEST,
    planDigest: PLAN_DIGEST,
    isolation,
    evidenceDir,
  };
}

async function catchCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : `NO_CODE:${(err as Error).message}`;
  }
}

/** Spawn the SHIPPED worker directly and parse its one result line. */
function runWorkerRaw(checkoutDir: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; result: Record<string, unknown> | null } {
  const spawned = spawnSync(process.execPath, [WORKER_PATH], {
    input: `${JSON.stringify({ checkoutDir })}\n`,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  const stdout = spawned.stdout ?? "";
  const line = stdout.split("\n").find((l) => l.startsWith(ARM_WORKER_RESULT_SENTINEL));
  let result: Record<string, unknown> | null = null;
  if (line !== undefined) {
    try {
      result = JSON.parse(line.slice(ARM_WORKER_RESULT_SENTINEL.length)) as Record<string, unknown>;
    } catch {
      result = null;
    }
  }
  return { status: spawned.status, stdout, result };
}

// ---------------------------------------------------------------------------
// N1 — the SHIPPED build must satisfy the worker ABI
// ---------------------------------------------------------------------------

describe("N0 RED — N1: the shipped production build cannot be an arm", () => {
  it("[N1] the shipped benchmark-command module must export a non-empty R97_ARM_PROBE and runOneCase", async () => {
    // A REAL module load of the shipped production entry (vitest resolves
    // `./benchmark-command.js` to the TypeScript source). This is the same
    // module a real frozen checkout's `dist/benchmark-command.js` is built from.
    const mod = (await import("./benchmark-command.js")) as Record<string, unknown>;
    expect(typeof mod["runOneCase"]).toBe("function");
    // N1 requires every real arm build to carry the versioned mechanism probe the
    // worker ABI demands; without it the worker refuses the build.
    expect(typeof mod[ARM_PROBE_EXPORT]).toBe("string");
    expect((mod[ARM_PROBE_EXPORT] as string).length).toBeGreaterThan(0);
  }, 60_000);

  it("[N1] CONTROL: the worker refuses a checkout entry that exports runOneCase but no probe", async () => {
    const dir = await scratch("n1-checkout");
    const abs = join(dir, ARM_ENTRY_REL);
    await mkdir(join(abs, ".."), { recursive: true });
    // Exactly the ABI shape the SHIPPED build has: `runOneCase` but no probe.
    await writeFile(abs, "export async function runOneCase() { return { status: 'failed' }; }\n", "utf8");
    const { result, status } = runWorkerRaw(dir, process.env);
    expect(status).not.toBe(0);
    expect(result?.["code"]).toBe("PREREG_WORKER_PROBE_MISSING");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// N2 — the pre-registered isolation must reach the executor
// ---------------------------------------------------------------------------

describe("N0 RED — N2: the pre-registered isolation never reaches the executor", () => {
  it("[N2] the PRODUCTION adapter must refuse an unsupported isolation with ARM_ISOLATION_UNSUPPORTED", async () => {
    const dir = await scratch("n2");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      R97_ARM_BASELINE_DIR: join(dir, "baseline"),
      R97_ARM_CANDIDATE_DIR: join(dir, "candidate"),
    };
    // The pre-registration DECLARES `vm/strong`; the driver forwards that exact
    // contract on the run context.
    const declared = { isolationBackendId: "vm", isolationStrength: "strong" };
    const ctx = await contextFor(dir, "candidate", declared);

    // CONTROL — when the executor is TOLD about the pre-registered isolation it
    // does refuse with the stable code. The check exists and is correct.
    const told = createPreregArmExecutor({
      rootDir: REPO_ROOT,
      env,
      isolation: declared,
    });
    expect(await catchCode(() => told(armRef("candidate"), ctx))).toBe(ARM_ISOLATION_UNSUPPORTED);

    // PRODUCTION — the adapter a release CLI actually uses must reach the SAME
    // refusal from the contract the driver carried. Before the fix it was
    // constructed without the contract and defaulted to the shipped
    // `process-exec`/`process` backend, so an experiment declaring `vm/strong`
    // was silently run under a weaker backend than the artifact named.
    const production = createProductionPreregRunner({ rootDir: REPO_ROOT, env });
    expect(await catchCode(() => production.runArm(armRef("candidate"), ctx))).toBe(ARM_ISOLATION_UNSUPPORTED);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// N5 — the worker is not a credential / network boundary
// ---------------------------------------------------------------------------

describe("N0 RED — N5: the arm worker is neither a credential nor a network boundary", () => {
  it("[N5] the arm build must NOT observe an arbitrary inherited environment variable", async () => {
    const base = await scratch("n5-out");
    const leakPath = join(base, "leaked.txt");
    const baselineDir = await scratch("n5-baseline");
    const candidateDir = await scratch("n5-candidate");
    const evidenceDir = await scratch("n5-evidence");
    const SENTINEL = "N0-LEAKED-SENTINEL-VALUE";
    const prefix = [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(leakPath)}, String(process.env["R97_ESCAPED_SENTINEL"] ?? "NOT_INHERITED"));`,
    ];
    await makeArmCheckout(baselineDir, "baseline", prefix);
    await makeArmCheckout(candidateDir, "candidate", prefix);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      R97_ARM_BASELINE_DIR: baselineDir,
      R97_ARM_CANDIDATE_DIR: candidateDir,
      // An arbitrary variable the worker must NOT see if its environment is a
      // real allowlist rather than "copy everything, delete four keys".
      R97_ESCAPED_SENTINEL: SENTINEL,
    };
    const production = createProductionPreregRunner({ rootDir: REPO_ROOT, env });
    const outcome = await production.runArm(armRef("candidate"), await contextFor(evidenceDir, "candidate"));
    void (outcome as PreregisteredArmOutcome);

    const leaked = existsSync(leakPath) ? await readFile(leakPath, "utf8") : "NOT_INHERITED";
    // N5 requires the worker's environment to be an explicit allowlist: an
    // arbitrary driver variable must not be readable by the arm build.
    expect(leaked).not.toBe(SENTINEL);
  }, 180_000);

  it("[N5] the arm build must NOT be able to make a direct LOOPBACK request", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.end("ok");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no loopback port");
    const url = `http://127.0.0.1:${address.port}/egress`;

    const baselineDir = await scratch("n5-egress-baseline");
    const candidateDir = await scratch("n5-egress-candidate");
    const evidenceDir = await scratch("n5-egress-evidence");
    const prefix = [
      `const res = await fetch(${JSON.stringify(url)});`,
      `await res.text();`,
    ];
    await makeArmCheckout(baselineDir, "baseline", prefix);
    await makeArmCheckout(candidateDir, "candidate", prefix);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      R97_ARM_BASELINE_DIR: baselineDir,
      R97_ARM_CANDIDATE_DIR: candidateDir,
    };
    const production = createProductionPreregRunner({ rootDir: REPO_ROOT, env });
    try {
      await production.runArm(armRef("candidate"), await contextFor(evidenceDir, "candidate"));
    } catch {
      // A refusal after the request left is still a leaked request.
    }

    // N5 requires the arm's egress to be bounded by the budgeted channel: a
    // direct request from the arm build must not reach the network at all.
    expect(hits).toBe(0);
  }, 180_000);
});