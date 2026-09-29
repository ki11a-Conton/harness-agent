/**
 * S0a — F1/F2 counter-examples for plan(20260929-015956).md §4. task-1.
 *
 * These tests assert the CORRECT behaviour of the FORMAL arm path, which does
 * not have it yet, so they are RED by design. They are NOT `test.fails`, NOT
 * skipped and NOT inverted: a green run is the acceptance signal for S1/S2.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `packages/harness/src/tool-budget-binding.test.ts` proves the SEAM works when a
 * host supplies `toolDispatchBudget` to `createHarness`. It cannot prove the
 * FORMAL path supplies it, because the formal path never calls `createHarness`:
 *
 *   campaign -> production runner -> isolated worker (child process)
 *            -> the ARM'S OWN `runOneCase` -> the arm's own ToolOrchestrator
 *
 * Baseline recon (docs/evidence/next-baseline.md §3):
 *   - `apps/cli/src` has NO reference to `toolBudget` / `toolDispatchBudget`;
 *   - `PreregisteredArmContext` carries no budget and the `runArm` call site
 *     forwards none;
 *   - `RunOneCaseOptions` carries no budget;
 *   - the arm's real `new ToolOrchestrator(...)` is built without one;
 *   - the worker timeout calls only `child.kill()`, and the driver builds
 *     `new AbortController().signal` inline per model stream (prereg-arm-executor
 *     L1024) and discards the controller, so nobody can abort it.
 *
 * F1: a campaign tool cap of 1 must stop the SECOND real `write_file` dispatch
 *     before its side effect. Today both land.
 * F2: when the worker times out, the provider's AbortSignal must be aborted and
 *     the driver must return inside a bounded window. Today the child is killed
 *     but the in-flight stream is never cancelled and the driver never returns.
 *
 * OFFLINE: local arm modules, in-process provider, no socket. Zero external
 * requests. F2 races a watchdog so a failure can never hang CI.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest, ProviderConfig } from "@ar/contracts";
import {
  DEFAULT_DECISION_POLICY_V3,
  R97_ARM_BUILD_ENTRIES,
  TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2,
  buildToolCallEfficiencyPreregistrationV2,
  captureEndpointIdentity,
  computeThresholdDigestV3,
  mechanismContractFor,
  openPreregisteredCampaignGate,
  runPreregisteredCampaign,
  serializePreregistrationV2,
  stableStringify,
  toolCallEfficiencyGuidanceDigest,
  type ArmRunRef,
  type PreregisteredArmContext,
  type PreregisteredCampaignObservationV2,
  type PreregistrationV2Options,
  type ToolCallEfficiencyPreregistrationV2,
} from "@ar/evaluation";
import {
  ARM_DEADLINE_EXCEEDED,
  ARM_PROBE_EXPORT,
  ARM_WORKER_ABI_UNSUPPORTED,
  ARM_WORKER_TIMEOUT,
  FIXTURE_CHECKOUT_MARKER_FILENAME,
  WORKER_CLEANUP_GRACE_MS,
  createFixtureCheckoutTrust,
  createPreregArmExecutor,
} from "./prereg-arm-executor.js";
import { R97_ARM_ABI } from "./r97-arm-abi.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRATCH_ROOT = join(REPO_ROOT, ".ci", "r0-f8-scratch");
const REAL_CASE_ID = "stress-repeated-tool-failures";
const ARM_ENTRY_REL = "apps/cli/dist/benchmark-command.js";
/** The repo's OWN built tools package — the arm's real orchestrator dependency. */
const TOOLS_DIST = pathToFileURL(join(REPO_ROOT, "packages", "tools", "dist", "index.js")).href;

/** Deterministic, out-of-repo observation path (never pollutes the work tree). */
function observationPath(marker: string, mode: "budget" | "model"): string {
  return join(tmpdir(), `r0-f8-observation-${marker}-${mode}.json`);
}

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
 * The arm's OWN build entry — a REAL, loadable module that imports the repo's
 * real `@ar/tools` build and builds a REAL `ToolOrchestrator`.
 *
 *   mode "budget": performs TWO real `write_file` dispatches, honouring
 *     `opts.toolBudget` if (and only if) the worker forwarded one.
 *   mode "model":  makes ONE model call through the worker's proxy provider and
 *     iterates it forever — only an abort can end it.
 *
 * Either way it writes the RAW observation to a deterministic temp path, so the
 * assertions read real files rather than trusting returned prose.
 */
function armEntrySource(marker: string, mode: "budget" | "model", declareAbi = true): string {
  return `
import { existsSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolOrchestrator, ToolRegistry, writeFileTool } from ${JSON.stringify(TOOLS_DIST)};

export const ${ARM_PROBE_EXPORT} = "probe:${marker}";
${
  declareAbi
    ? `export const R97_ARM_ABI = ${JSON.stringify(R97_ARM_ABI)};`
    : `// OLD-ABI build: deliberately exports no R97_ARM_ABI capability list.`
}

const OBS = ${JSON.stringify(observationPath(marker, mode))};

function baseOutcome(caseDef) {
  return {
    caseId: caseDef.id,
    status: "failed",
    actualStatus: "completed",
    events: [],
    metrics: { turn_count: 1, tool_call_count: 0, tokens_input: 0, tokens_output: 0, context_tokens: 0, compaction_count: 0, duration_ms: 0, retry_count: 0, verification_failures: 0, human_interventions: 0, estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 0 },
    violations: [],
    reason: "r0-f8",
    suite: caseDef.suite || "regression",
    judgeVersion: "1.0.0",
    terminationReason: "verified_incomplete",
  };
}

export async function runOneCase(caseDef, opts, _suite) {
  const workspace = mkdtempSync(join(tmpdir(), "r0-f8-arm-ws-"));
  const registry = new ToolRegistry();
  registry.register(writeFileTool);
  const orchestrator = new ToolOrchestrator({
    registry,
    workspaceRoot: workspace,
    events: { async emit() {} },
    // F1: the arm CAN honour a budget — but only if the worker forwarded one.
    ...(opts.toolBudget !== undefined ? { toolBudget: opts.toolBudget } : {}),
  });
  const permissions = { rules: [
    { action: "read", resource: "file", effect: "allow" },
    { action: "edit", resource: "file", effect: "allow" },
  ] };
  const sandboxPolicy = {
    filesystem: { mode: "workspace-write", allowedPaths: [workspace] },
    network: { mode: "deny" },
    process: { timeoutMs: 5000, maxOutputBytes: 65536 },
  };
  const sessionId = "s1";

  if (${JSON.stringify(mode)} === "model") {
    let entered = false;
    try {
      const client = opts.provider.createClient({ id: "arm-fixture" }, {});
      entered = true;
      const signal = new AbortController().signal;
      for await (const ev of client.generate({ messages: [] }, signal)) {
        if (ev.type === "completed" || ev.type === "error") break;
      }
    } catch (err) {
      writeFileSync(OBS, JSON.stringify({ marker: ${JSON.stringify(marker)}, mode: "model", entered, error: String(err && err.message ? err.message : err) }, null, 2));
      throw err;
    }
    writeFileSync(OBS, JSON.stringify({ marker: ${JSON.stringify(marker)}, mode: "model", entered, error: null }, null, 2));
    return baseOutcome(caseDef);
  }

  const results = [];
  for (const name of ["first.txt", "second.txt"]) {
    const callId = "call-" + name;
    const r = await orchestrator.execute(
      { id: callId, sessionId, turnId: "t1", agentId: "a1", call: { id: callId, name: "write_file", args: { path: join(workspace, name), content: "written-by-" + name } } },
      { sessionId, turnId: "t1", agentId: "a1", cwd: workspace, signal: new AbortController().signal, permissions, sandboxPolicy },
    );
    results.push({ name, status: r.status, reasonCode: r.metadata && r.metadata.reasonCode ? r.metadata.reasonCode : null, output: String(r.output ?? "").slice(0, 400), error: r.error ? JSON.stringify(r.error).slice(0, 400) : null });
  }
  writeFileSync(OBS, JSON.stringify({
    marker: ${JSON.stringify(marker)},
    mode: "budget",
    budgetForwarded: opts.toolBudget !== undefined,
    results,
    workspace,
    filesOnDisk: ["first.txt", "second.txt"].filter((n) => existsSync(join(workspace, n))),
  }, null, 2));
  const outcome = baseOutcome(caseDef);
  outcome.metrics.tool_call_count = results.length;
  return outcome;
}
`;
}

/** Build a real, loadable arm checkout with distinct entry bytes. */
async function makeArmCheckout(
  dir: string,
  marker: string,
  mode: "budget" | "model",
  declareAbi = true,
): Promise<void> {
  for (const rel of R97_ARM_BUILD_ENTRIES) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(
      abs,
      rel === ARM_ENTRY_REL ? armEntrySource(marker, mode, declareAbi) : `export {}; // stub:${marker}\n`,
      "utf8",
    );
  }
  await writeFile(
    join(dir, FIXTURE_CHECKOUT_MARKER_FILENAME),
    `${JSON.stringify({ writer: "r0-f8-formal-budget-cancel-gaps.test.ts", marker })}\n`,
    "utf8",
  );
}

function inertProvider(): ModelProvider {
  return {
    id: "r0-f8-inert",
    async listModels() {
      return [];
    },
    createClient() {
      return {
        // eslint-disable-next-line require-yield
        async *generate(_req: ModelRequest, _signal: AbortSignal): AsyncGenerator<ModelEvent> {
          throw new Error("the F1 arm entry performs no model call");
        },
      };
    },
  };
}

function armRef(): ArmRunRef {
  return { armId: "candidate", caseId: REAL_CASE_ID, repetition: 0, orderIndex: 0 };
}

const PREREG_DIGEST = "1".repeat(64);
const PLAN_DIGEST = "2".repeat(64);

/** A minimal campaign budget implementing the real structural capability. */
function countingBudget(cap: number): {
  budget: unknown;
  refusals: () => number;
} {
  let held = 0;
  let refusals = 0;
  return {
    refusals: () => refusals,
    budget: {
      async reserve() {
        if (held >= cap) {
          refusals += 1;
          return { ok: false, reason: "TOOL_BUDGET_EXHAUSTED", async settle() {} };
        }
        held += 1;
        return { ok: true, async settle() {} };
      },
    },
  };
}

describe("S0a/F1 — the FORMAL arm path must enforce the campaign tool cap before the side effect", () => {
  it("[F1] with a campaign tool cap of 1, only the FIRST of two real writes lands", async () => {
    const base = await scratch("f1-base");
    const cand = await scratch("f1-cand");
    await makeArmCheckout(base, "baseline", "budget");
    await makeArmCheckout(cand, "candidate", "budget");

    const obsPath = observationPath("candidate", "budget");
    rmSync(obsPath, { force: true });

    const budget = countingBudget(1);
    const evidenceDir = join(await scratch("f1-ev"), "pair-0-candidate");
    const executor = createPreregArmExecutor({
      rootDir: REPO_ROOT,
      env: { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand },
      trustedFixtureCheckouts: createFixtureCheckoutTrust(base, cand),
      workerTimeoutMs: 120_000,
    });

    const arm = armRef();
    // F1: the campaign's durable tool budget must reach the ARM's orchestrator.
    // Today the context has no such field and the executor drops it.
    await executor(arm, {
      provider: inertProvider(),
      armRunId: "pair-0-candidate",
      arm,
      preregistrationDigest: PREREG_DIGEST,
      planDigest: PLAN_DIGEST,
      isolation: { isolationBackendId: "process-exec", isolationStrength: "process" },
      evidenceDir,
      ...({ toolDispatchBudget: budget.budget } as Record<string, unknown>),
    });

    expect(existsSync(obsPath), "the arm wrote no observation file").toBe(true);
    const observation = JSON.parse(await readFile(obsPath, "utf8")) as {
      budgetForwarded: boolean;
      results: Array<{ name: string; status: string; reasonCode: string | null }>;
      workspace: string;
      filesOnDisk: string[];
    };

    expect(
      observation.budgetForwarded,
      "F1: the campaign tool budget never reached the arm's ToolOrchestrator, so maxToolCalls is unenforced on the formal path",
    ).toBe(true);
    // Independently re-derive the REAL side effects from disk.
    expect(existsSync(join(observation.workspace, "first.txt"))).toBe(true);
    expect(
      existsSync(join(observation.workspace, "second.txt")),
      "F1: the second tool dispatch ran even though the campaign cap was 1 — the side effect happened",
    ).toBe(false);
    expect(observation.results[1]!.status).toBe("failed");
    expect(observation.results[1]!.reasonCode).toBe("TOOL_BUDGET_EXHAUSTED");
    expect(budget.refusals()).toBeGreaterThan(0);
  }, 180_000);
});

describe("S0a/F2 — a worker timeout must cancel the in-flight model stream", () => {  it("[F2] the provider's AbortSignal is aborted and the driver returns inside a bounded window", async () => {
    const base = await scratch("f2-base");
    const cand = await scratch("f2-cand");
    await makeArmCheckout(base, "baseline", "model");
    await makeArmCheckout(cand, "candidate", "model");

    const obsPath = observationPath("candidate", "model");
    rmSync(obsPath, { force: true });

    let signalAborted = false;
    let providerEntered = false;
    let releaseHang: (() => void) | null = null;

    const hanging: ModelProvider = {
      id: "r0-f8-hanging",
      async listModels() {
        return [];
      },
      createClient(_model: never, _config: ProviderConfig) {
        return {
          async *generate(_req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
            providerEntered = true;
            signal.addEventListener("abort", () => {
              signalAborted = true;
            });
            // Never yields a terminal event: only an abort (or the test's own
            // cleanup) can end this generator.
            await new Promise<void>((resolve) => {
              releaseHang = resolve;
              if (signal.aborted) return resolve();
              signal.addEventListener("abort", () => resolve());
            });
          },
        };
      },
    };

    const evidenceDir = join(await scratch("f2-ev"), "pair-0-candidate");
    const executor = createPreregArmExecutor({
      rootDir: REPO_ROOT,
      env: { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand },
      trustedFixtureCheckouts: createFixtureCheckoutTrust(base, cand),
      workerTimeoutMs: 1_500,
    });

    const arm = armRef();
    const started = Date.now();
    const WATCHDOG = Symbol("watchdog");
    // The plan requires an EXTERNAL watchdog: a driver that never returns must
    // fail the test, not hang CI.
    const raced = await Promise.race([
      executor(arm, {
        provider: hanging,
        armRunId: "pair-0-candidate",
        arm,
        preregistrationDigest: PREREG_DIGEST,
        planDigest: PLAN_DIGEST,
        isolation: { isolationBackendId: "process-exec", isolationStrength: "process" },
        evidenceDir,
      }).then(
        () => "settled" as const,
        (err: unknown) => err,
      ),
      new Promise<typeof WATCHDOG>((resolve) => setTimeout(() => resolve(WATCHDOG), 12_000)),
    ]);
    const elapsed = Date.now() - started;
    // Never leave the local generator hanging, even when the assertion fails.
    if (releaseHang !== null) (releaseHang as () => void)();

    expect(elapsed, "the watchdog fired: the driver never returned").toBeLessThan(12_000);
    expect(providerEntered, "the provider was never entered").toBe(true);
    expect(
      signalAborted,
      "F2: the worker timed out but the provider's AbortSignal was never aborted — the in-flight model stream cannot be cancelled",
    ).toBe(true);
    expect(raced, "the driver did not settle before the watchdog").not.toBe(WATCHDOG);
    // The driver must classify the stop with a STABLE reason, inside the declared
    // window: the timeout plus the explicit cleanup grace, plus scheduler slack.
    expect(String(raced)).toContain(ARM_WORKER_TIMEOUT);
    expect(elapsed, "the driver exceeded timeout + cleanup grace").toBeLessThan(1_500 + WORKER_CLEANUP_GRACE_MS + 3_000);
  }, 60_000);

  it("[F2] a provider that IGNORES its AbortSignal still cannot keep the driver waiting", async () => {
    const base = await scratch("f2-ignore-base");
    const cand = await scratch("f2-ignore-cand");
    await makeArmCheckout(base, "baseline", "model");
    await makeArmCheckout(cand, "candidate", "model");

    let providerEntered = false;
    let releaseHang: (() => void) | null = null;
    const deaf: ModelProvider = {
      id: "r0-f8-deaf",
      async listModels() {
        return [];
      },
      createClient(_model: never, _config: ProviderConfig) {
        return {
          async *generate(_req: ModelRequest, _signal: AbortSignal): AsyncGenerator<ModelEvent> {
            providerEntered = true;
            // DELIBERATELY never looks at the signal and never yields.
            await new Promise<void>((resolve) => {
              releaseHang = resolve;
            });
          },
        };
      },
    };

    const evidenceDir = join(await scratch("f2-ignore-ev"), "pair-0-candidate");
    const executor = createPreregArmExecutor({
      rootDir: REPO_ROOT,
      env: { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand },
      trustedFixtureCheckouts: createFixtureCheckoutTrust(base, cand),
      workerTimeoutMs: 1_200,
    });

    const arm = armRef();
    const started = Date.now();
    const WATCHDOG = Symbol("watchdog");
    const raced = await Promise.race([
      executor(arm, {
        provider: deaf,
        armRunId: "pair-0-candidate",
        arm,
        preregistrationDigest: PREREG_DIGEST,
        planDigest: PLAN_DIGEST,
        isolation: { isolationBackendId: "process-exec", isolationStrength: "process" },
        evidenceDir,
      }).then(
        () => "settled" as const,
        (err: unknown) => err,
      ),
      new Promise<typeof WATCHDOG>((resolve) => setTimeout(() => resolve(WATCHDOG), 12_000)),
    ]);
    const elapsed = Date.now() - started;
    if (releaseHang !== null) (releaseHang as () => void)();

    // THE POINT: "stop waiting" must not depend on the provider cooperating. The
    // result is UNCONFIRMED — the driver never claims the remote request was
    // revoked, only that it stopped waiting for it.
    expect(providerEntered).toBe(true);
    expect(raced, "the watchdog fired: a deaf provider parked the driver").not.toBe(WATCHDOG);
    expect(String(raced)).toContain(ARM_WORKER_TIMEOUT);
    expect(elapsed, "the driver exceeded timeout + cleanup grace").toBeLessThan(1_200 + WORKER_CLEANUP_GRACE_MS + 3_000);
  }, 60_000);

  it("[F2] a real HTTP stub observes its connection CLOSED after the client cancels", async () => {
    const base = await scratch("f2-http-base");
    const cand = await scratch("f2-http-cand");
    await makeArmCheckout(base, "baseline", "model");
    await makeArmCheckout(cand, "candidate", "model");

    let serverSawClose = false;
    let requestArrived = false;
    const server = createServer((req, res) => {
      requestArrived = true;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n");
      // NEVER end the response: only a client cancellation can close it.
      req.on("close", () => {
        serverSawClose = true;
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const streaming: ModelProvider = {
      id: "r0-f8-http-stub",
      async listModels() {
        return [];
      },
      createClient(_model: never, _config: ProviderConfig) {
        return {
          async *generate(_req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
            const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ stream: true }),
              signal,
            });
            const reader = res.body?.getReader();
            if (reader === undefined) return;
            for (;;) {
              const { done } = await reader.read();
              if (done) break;
            }
          },
        };
      },
    };

    const evidenceDir = join(await scratch("f2-http-ev"), "pair-0-candidate");
    const executor = createPreregArmExecutor({
      rootDir: REPO_ROOT,
      env: { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand },
      trustedFixtureCheckouts: createFixtureCheckoutTrust(base, cand),
      workerTimeoutMs: 1_500,
    });

    const arm = armRef();
    const WATCHDOG = Symbol("watchdog");
    try {
      const raced = await Promise.race([
        executor(arm, {
          provider: streaming,
          armRunId: "pair-0-candidate",
          arm,
          preregistrationDigest: PREREG_DIGEST,
          planDigest: PLAN_DIGEST,
          isolation: { isolationBackendId: "process-exec", isolationStrength: "process" },
          evidenceDir,
        }).then(
          () => "settled" as const,
          (err: unknown) => err,
        ),
        new Promise<typeof WATCHDOG>((resolve) => setTimeout(() => resolve(WATCHDOG), 12_000)),
      ]);
      expect(raced, "the watchdog fired").not.toBe(WATCHDOG);
      expect(String(raced)).toContain(ARM_WORKER_TIMEOUT);
      expect(requestArrived, "the local stub never received the request").toBe(true);
      // Give the server a moment to observe the socket teardown.
      for (let i = 0; i < 40 && !serverSawClose; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(
        serverSawClose,
        "F2: the driver aborted but the server never observed its connection closing — the transport was not really cancelled",
      ).toBe(true);
    } finally {
      // Cleanup runs even when an assertion failed.
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  it("[F2] an ALREADY-EXPIRED campaign makes 0 model requests and 0 tool dispatches", async () => {
    const base = await scratch("f2-expired-base");
    const cand = await scratch("f2-expired-cand");
    await makeArmCheckout(base, "baseline", "budget");
    await makeArmCheckout(cand, "candidate", "budget");

    let providerEntries = 0;
    const counting: ModelProvider = {
      id: "r0-f8-expired-counting",
      async listModels() {
        return [];
      },
      createClient() {
        return {
          // eslint-disable-next-line require-yield
          async *generate(): AsyncGenerator<ModelEvent> {
            providerEntries += 1;
            throw new Error("no request may be issued after the campaign deadline");
          },
        };
      },
    };

    const budget = countingBudget(1);
    const evidenceDir = join(await scratch("f2-expired-ev"), "pair-0-candidate");
    const executor = createPreregArmExecutor({
      rootDir: REPO_ROOT,
      env: { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand },
      trustedFixtureCheckouts: createFixtureCheckoutTrust(base, cand),
      workerTimeoutMs: 60_000,
    });

    const arm = armRef();
    const err = await executor(arm, {
      provider: counting,
      armRunId: "pair-0-candidate",
      arm,
      preregistrationDigest: PREREG_DIGEST,
      planDigest: PLAN_DIGEST,
      isolation: { isolationBackendId: "process-exec", isolationStrength: "process" },
      evidenceDir,
      toolDispatchBudget: budget.budget as never,
      // The deadline is in the PAST: a resume must reuse it, not re-derive it.
      campaignDeadlineAtMs: Date.now() - 60_000,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err, "an expired campaign was admitted").not.toBeNull();
    expect(String(err)).toContain(ARM_DEADLINE_EXCEEDED);
    expect(providerEntries, "a model request was issued after the campaign deadline").toBe(0);
    expect(budget.refusals(), "a tool dispatch was attempted after the campaign deadline").toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// S1 acceptance (a) — an OLD-ABI arm is refused BEFORE the first model request
// ---------------------------------------------------------------------------

describe("S1 — an arm build without the tool-budget ABI cannot run on the formal path", () => {
  it("[F1/ABI] refuses an arm that declares no tool-budget capability, with 0 model requests", async () => {
    const base = await scratch("abi-base");
    const cand = await scratch("abi-cand");
    await makeArmCheckout(base, "baseline", "model");
    // The candidate is a build that WOULD make a model call if it were allowed to
    // run, and declares NO `R97_ARM_ABI` — an old-ABI arm.
    await makeArmCheckout(cand, "candidate", "model", false);

    let providerEntries = 0;
    const counting: ModelProvider = {
      id: "r0-f8-abi-counting",
      async listModels() {
        return [];
      },
      createClient() {
        return {
          // eslint-disable-next-line require-yield
          async *generate(): AsyncGenerator<ModelEvent> {
            providerEntries += 1;
            throw new Error("no model request may be issued before the ABI pre-check passes");
          },
        };
      },
    };

    const budget = countingBudget(1);
    const evidenceDir = join(await scratch("abi-ev"), "pair-0-candidate");
    const executor = createPreregArmExecutor({
      rootDir: REPO_ROOT,
      env: { R97_ARM_BASELINE_DIR: base, R97_ARM_CANDIDATE_DIR: cand },
      trustedFixtureCheckouts: createFixtureCheckoutTrust(base, cand),
      workerTimeoutMs: 60_000,
    });

    const arm = armRef();
    const err = await executor(arm, {
      provider: counting,
      armRunId: "pair-0-candidate",
      arm,
      preregistrationDigest: PREREG_DIGEST,
      planDigest: PLAN_DIGEST,
      isolation: { isolationBackendId: "process-exec", isolationStrength: "process" },
      evidenceDir,
      toolDispatchBudget: budget.budget as never,
      campaignDeadlineAtMs: Date.now() + 600_000,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err, "the executor admitted an arm build that cannot honour the campaign tool budget").not.toBeNull();
    expect(String(err)).toContain(ARM_WORKER_ABI_UNSUPPORTED);
    // THE POINT OF THE PRE-CHECK: the refusal happened before the arm ran, so the
    // provider was never entered and no quota was spent.
    expect(providerEntries, "a model request was issued before the ABI pre-check").toBe(0);
    expect(budget.refusals()).toBe(0);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// S1 acceptance (b) — the FORMAL campaign entry actually forwards the budget
// ---------------------------------------------------------------------------

const N5_FIXTURE = JSON.parse(
  readFileSync(join(REPO_ROOT, "scripts", "e4", "fixtures", "n5-prereg-config.json"), "utf8"),
) as PreregistrationV2Options;
const GATE_NOW = 1_700_000_000_000;

function gatePrereg(): ToolCallEfficiencyPreregistrationV2 {
  return buildToolCallEfficiencyPreregistrationV2(structuredClone(N5_FIXTURE));
}

function gateObservation(): PreregisteredCampaignObservationV2 {
  const caseContentDigests: Record<string, string> = {};
  const eligibilityDigests: Record<string, string> = {};
  for (const caseId of N5_FIXTURE.selection.caseIds) {
    caseContentDigests[caseId] = `content-${caseId}`;
    eligibilityDigests[caseId] = `elig-${caseId}`;
  }
  const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
  return {
    candidateSourceSha: N5_FIXTURE.subject.candidateSourceSha,
    cleanTree: true,
    baselineArmDigest: N5_FIXTURE.subject.baselineArmDigest,
    candidateArmDigest: N5_FIXTURE.subject.candidateArmDigest,
    guidanceDigest: toolCallEfficiencyGuidanceDigest(),
    contractDigest: sha256(stableStringify(mechanismContractFor(TOOL_CALL_EFFICIENCY_CANDIDATE_ID_V2))),
    runtimeConfigDigest: N5_FIXTURE.subject.runtimeConfigDigest,
    providerId: N5_FIXTURE.provider.providerId,
    modelId: N5_FIXTURE.provider.modelId,
    endpointDigest: captureEndpointIdentity(N5_FIXTURE.provider.endpointBaseUrl ?? null)!,
    requestProfileDigest: sha256(stableStringify(N5_FIXTURE.provider.requestProfile)),
    caseContentDigests,
    eligibilityDigests,
    selectionProvenanceDigest: N5_FIXTURE.selection.selectionProvenanceDigest,
    decisionPolicyDigest: computeThresholdDigestV3(DEFAULT_DECISION_POLICY_V3),
    usdMicrosPerCall: 0,
    endpointIsLoopback: false,
  };
}

function gateAuthorization(a: ToolCallEfficiencyPreregistrationV2): string {
  return JSON.stringify({
    schemaVersion: "tool-call-efficiency-authorization-v2",
    preregistrationDigest: a.preregistrationDigest,
    candidateSourceSha: a.subject.candidateSourceSha,
    baselineArmDigest: a.subject.baselineArmDigest,
    candidateArmDigest: a.subject.candidateArmDigest,
    providerId: a.provider.providerId,
    modelId: a.provider.modelId,
    endpointDigest: a.provider.endpointDigest,
    caps: {
      maxModelCalls: a.budget.campaignWorstCaseModelCalls,
      maxToolCalls: a.budget.maxToolCalls,
      maxDurationMs: a.budget.maxDurationMs,
      maxInputTokens: a.budget.maxInputTokens,
      maxOutputTokens: a.budget.maxOutputTokens,
      maxTotalTokens: a.budget.maxTotalTokens,
      maxUsdMicros: a.budget.maxUsdMicros,
    },
    issuedAtMs: 1_000,
    expiresAtMs: 9_000_000_000_000,
    approvalId: "approval-1",
    allowResume: true,
    paid: true,
  });
}

describe("S1 — the FORMAL campaign entry forwards the durable tool budget", () => {
  it("[F1] runArm receives the admission's own budget object and its ONE deadline", async () => {
    const dir = await scratch("s1-campaign");
    const claimsDir = await mkdtemp(join(await scratch("s1-claims"), "claims-"));
    const previousClaims = process.env["R97_CAMPAIGN_CLAIMS_DIR"];
    process.env["R97_CAMPAIGN_CLAIMS_DIR"] = claimsDir;
    try {
      const artifact = gatePrereg();
      const admission = await openPreregisteredCampaignGate({
        preregistrationJson: serializePreregistrationV2(artifact),
        authorizationJson: gateAuthorization(artifact),
        observation: gateObservation(),
        budgetDir: join(dir, "budget"),
        mode: "first-run",
        now: () => GATE_NOW,
        makeProvider: () => inertProvider(),
      });
      expect(admission.status, JSON.stringify(admission).slice(0, 400)).toBe("ADMITTED");
      if (admission.status !== "ADMITTED") throw new Error("setup: the campaign was not admitted");
      const admitted = admission;

      const seen: Array<{ armRunId: string; hasBudget: boolean; sameObject: boolean; deadline: number | undefined }> = [];
      await runPreregisteredCampaign({
        admission: admitted,
        prereg: artifact,
        resultsDir: join(dir, "runs"),
        runArm: async (arm, ctx: PreregisteredArmContext) => {
          seen.push({
            armRunId: ctx.armRunId,
            hasBudget: ctx.toolDispatchBudget !== undefined,
            // Identity, not merely presence: a driver that built its OWN budget
            // would enforce a SECOND cap that the campaign's ledger never sees.
            sameObject: ctx.toolDispatchBudget === admitted.toolDispatchBudget,
            deadline: ctx.campaignDeadlineAtMs,
          });
          return {
            status: "failed" as const,
            tokensUsed: 0,
            evidence: {
              executorId: "s1-forwarding-probe",
              traceDigest: "a".repeat(64),
              verifiedCompletion: false,
              securityViolations: 0,
              activationEvidenceDigest: null,
            },
          };
        },
        now: () => GATE_NOW,
      });

      expect(seen.length, "the campaign scheduled no arm run").toBeGreaterThan(0);
      expect(
        seen.every((s) => s.hasBudget),
        `F1: the campaign handed runArm a context with NO tool budget (${JSON.stringify(seen.slice(0, 2))})`,
      ).toBe(true);
      expect(seen.every((s) => s.sameObject)).toBe(true);
      expect(
        seen.every((s) => s.deadline === admitted.campaignDeadlineAtMs),
        "F1: the campaign deadline never reached the arm context",
      ).toBe(true);
    } finally {
      if (previousClaims === undefined) delete process.env["R97_CAMPAIGN_CLAIMS_DIR"];
      else process.env["R97_CAMPAIGN_CLAIMS_DIR"] = previousClaims;
    }
  }, 90_000);
});
