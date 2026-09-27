/**
 * N5 — the worker's credential and egress trust boundary.
 * plan(20260926-175819).md §N5 (line 89).
 *
 * WHAT THIS FILE PROVES (and what it does NOT)
 * --------------------------------------------
 * PROVEN here, behaviourally and offline:
 *   - the worker environment is an explicit ALLOWLIST: a harmless sentinel, a
 *     proxy variable, a cloud credential, ANOTHER provider's token and
 *     `NODE_OPTIONS` are all absent from the child, while the worker's own
 *     declared inputs still arrive;
 *   - untrusted checkouts (no synthetic-fixture marker) are refused BEFORE the
 *     child starts, with the exact `EGRESS_ISOLATION_UNAVAILABLE` code, and a
 *     loopback counter observes ZERO requests — the refusal is pre-start, never a
 *     post-hoc judgement of a request that already left;
 *   - the refusal is NOT blanket: a synthetic-fixture checkout really runs and
 *     produces an outcome, so the positive budgeted path is intact;
 *   - the capability probe reports the truth (`available: false`), so paid /
 *     untrusted execution stays closed on both platforms.
 *
 * NOT proven here — stated plainly, never implied:
 *   - this is NOT a network sandbox. There is no in-worker egress block; the
 *     fixture path is trusted BY CONSTRUCTION (the harness wrote the tree) and
 *     would still be able to open a socket. `paidExperimentReady` stays false.
 *
 * SAFETY: zero network EXCEPT the loopback counter this file creates on 127.0.0.1
 * (it exists only to prove that nothing reaches it). Zero real provider, zero
 * cost, no key is read.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest, ProviderConfig } from "@ar/contracts";
import {
  R97_ARM_BUILD_ENTRIES,
  type ArmRunRef,
  type PreregisteredArmContext,
} from "@ar/evaluation";
import {
  ARM_PROBE_EXPORT,
  EGRESS_ISOLATION_UNAVAILABLE,
  FIXTURE_CHECKOUT_MARKER_FILENAME,
  buildWorkerEnv,
  egressIsolationCapability,
} from "./prereg-arm-executor.js";
import { createProductionPreregRunner } from "./prereg-production-runner.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRATCH_ROOT = join(REPO_ROOT, ".ci", "prereg-n5-scratch");
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

function fakeProvider(): ModelProvider {
  return {
    id: "n5-fake",
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
    `    reason: 'n5-probe:${marker}',`,
    "    suite: caseDef.suite || 'stress',",
    "    judgeVersion: '1.0.0',",
    "    terminationReason: 'verified_incomplete',",
    "  };",
    "}",
    "",
  ];
}

/**
 * Build a loadable arm checkout. `observationPath` receives a JSON dump of the
 * child's view of the sensitive variables, and `leakPath` the sentinel value.
 */
async function makeArmCheckout(
  dir: string,
  marker: string,
  observationPath: string,
  leakPath: string,
  opts: { fixtureMarker: boolean; fetchUrl?: string },
): Promise<void> {
  const prefix = [
    `import { writeFileSync } from "node:fs";`,
    `writeFileSync(${JSON.stringify(leakPath)}, String(process.env["R97_ESCAPED_SENTINEL"] ?? "NOT_INHERITED"));`,
    `writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify({`,
    `  proxy: process.env["HTTP_PROXY"] ?? null,`,
    `  proxyUpper: process.env["HTTPS_PROXY"] ?? null,`,
    `  aws: process.env["AWS_SECRET_ACCESS_KEY"] ?? null,`,
    `  anthropic: process.env["ANTHROPIC_API_KEY"] ?? null,`,
    `  openai: process.env["OPENAI_API_KEY"] ?? null,`,
    `  nodeOptions: process.env["NODE_OPTIONS"] ?? null,`,
    `  declaration: process.env["R97_ARM_BASELINE_DIR"] ?? null,`,
    `}));`,
    ...(opts.fetchUrl === undefined ? [] : [`const res = await fetch(${JSON.stringify(opts.fetchUrl)});`, `await res.text();`]),
  ];
  for (const rel of R97_ARM_BUILD_ENTRIES) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    const source = rel === ARM_ENTRY_REL
      ? [...prefix, `export const ${ARM_PROBE_EXPORT} = "probe:${marker}";`, ...armOutcomeSource(marker)].join("\n")
      : `export const N5_SIBLING_STUB_${marker} = ${JSON.stringify(`sibling:${marker}`)};\n`;
    await writeFile(abs, source, "utf8");
  }
  if (opts.fixtureMarker) {
    await writeFile(join(dir, FIXTURE_CHECKOUT_MARKER_FILENAME), `${JSON.stringify({ writer: "test", marker })}\n`, "utf8");
  }
}

function armRef(armId: "baseline" | "candidate"): ArmRunRef {
  return { armId, caseId: REAL_CASE_ID, repetition: 0, orderIndex: 0 };
}

async function contextFor(evidenceDir: string, armId: "baseline" | "candidate"): Promise<PreregisteredArmContext> {
  return {
    provider: fakeProvider(),
    armRunId: `${armId}-run`,
    arm: armRef(armId),
    preregistrationDigest: PREREG_DIGEST,
    planDigest: PLAN_DIGEST,
    isolation: { isolationBackendId: "process-exec", isolationStrength: "process" },
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

const SENTINEL_ENV: NodeJS.ProcessEnv = {
  R97_ESCAPED_SENTINEL: "N5-LEAKED-SENTINEL-VALUE",
  HTTP_PROXY: "http://proxy.invalid:3128",
  HTTPS_PROXY: "http://proxy.invalid:3128",
  AWS_SECRET_ACCESS_KEY: "aws-secret-sentinel",
  ANTHROPIC_API_KEY: "anthropic-sentinel",
  NODE_OPTIONS: "--max-old-space-size=64",
};

describe("N5 — the worker environment is an explicit allowlist", () => {
  it("[N5.1] every sensitive variable is dropped while the worker's own inputs survive", () => {
    const built = buildWorkerEnv({
      ...process.env,
      ...SENTINEL_ENV,
      R97_ARM_BASELINE_DIR: "/baseline",
      R97_ARM_CANDIDATE_DIR: "/candidate",
    });
    for (const key of Object.keys(SENTINEL_ENV)) {
      expect(built[key], `${key} must NOT be inherited by the worker`).toBeUndefined();
    }
    // The declared inputs DO arrive — the allowlist is not "pass nothing".
    expect(built["R97_ARM_BASELINE_DIR"]).toBe("/baseline");
    expect(built["R97_ARM_CANDIDATE_DIR"]).toBe("/candidate");
    // ...and the OS essentials node needs to start are present.
    expect(built["PATH"] ?? built["Path"]).toBeDefined();
  }, 30_000);

  it("[N5.2] the capability probe reports the truth: no provable egress boundary", () => {
    const capability = egressIsolationCapability();
    expect(capability.available).toBe(false);
    expect(capability.backend).toBe("none");
    expect(capability.detail.length).toBeGreaterThan(0);
  }, 30_000);
});

describe("N5 — an untrusted checkout is refused BEFORE it starts", () => {
  it("[N5.3] no synthetic-fixture marker ⇒ EGRESS_ISOLATION_UNAVAILABLE and ZERO loopback requests", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.end("ok");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no loopback port");

    const baselineDir = await scratch("n5-untrusted-baseline");
    const candidateDir = await scratch("n5-untrusted-candidate");
    const evidenceDir = await scratch("n5-untrusted-evidence");
    const leakPath = join(await scratch("n5-untrusted-out"), "leaked.txt");
    const obsPath = `${leakPath}.env.json`;
    await makeArmCheckout(baselineDir, "baseline", obsPath, leakPath, { fixtureMarker: false });
    await makeArmCheckout(candidateDir, "candidate", obsPath, leakPath, {
      fixtureMarker: false,
      fetchUrl: `http://127.0.0.1:${address.port}/egress`,
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      R97_ARM_BASELINE_DIR: baselineDir,
      R97_ARM_CANDIDATE_DIR: candidateDir,
    };
    const production = createProductionPreregRunner({ rootDir: REPO_ROOT, env });
    const code = await catchCode(async () => production.runArm(armRef("candidate"), await contextFor(evidenceDir, "candidate")));

    expect(code).toBe(EGRESS_ISOLATION_UNAVAILABLE);
    expect(hits).toBe(0);
    // Pre-start means the child never ran, so its import-time side effect never
    // happened either.
    expect(existsSync(leakPath)).toBe(false);
  }, 180_000);
});

describe("N5 — the refusal is not blanket: the fixture path really runs", () => {
  it("[N5.4] a synthetic-fixture checkout runs, and inherits NONE of the sensitive variables", async () => {
    const outDir = await scratch("n5-fixture-out");
    const leakPath = join(outDir, "leaked.txt");
    const obsPath = join(outDir, "env.json");
    const baselineDir = await scratch("n5-fixture-baseline");
    const candidateDir = await scratch("n5-fixture-candidate");
    const evidenceDir = await scratch("n5-fixture-evidence");
    await makeArmCheckout(baselineDir, "baseline", obsPath, leakPath, { fixtureMarker: true });
    await makeArmCheckout(candidateDir, "candidate", obsPath, leakPath, { fixtureMarker: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...SENTINEL_ENV,
      R97_ARM_BASELINE_DIR: baselineDir,
      R97_ARM_CANDIDATE_DIR: candidateDir,
    };
    const production = createProductionPreregRunner({ rootDir: REPO_ROOT, env });
    const outcome = await production.runArm(armRef("candidate"), await contextFor(evidenceDir, "candidate"));

    // NON-VACUOUS: the child really ran (its import-time writes exist)...
    expect(existsSync(leakPath)).toBe(true);
    expect(await readFile(leakPath, "utf8")).toBe("NOT_INHERITED");
    // ...and the run produced a real outcome rather than a refusal.
    expect(outcome.status).toBeDefined();

    // ...and every sensitive name is absent from the child's OWN view of itself.
    const observed = JSON.parse(await readFile(obsPath, "utf8")) as Record<string, string | null>;
    expect(observed["proxy"]).toBeNull();
    expect(observed["proxyUpper"]).toBeNull();
    expect(observed["aws"]).toBeNull();
    expect(observed["anthropic"]).toBeNull();
    expect(observed["openai"]).toBeNull();
    expect(observed["nodeOptions"]).toBeNull();
    // The declared input DID reach the child (the allowlist is not "nothing").
    expect(observed["declaration"]).toBe(baselineDir);
  }, 180_000);
});
