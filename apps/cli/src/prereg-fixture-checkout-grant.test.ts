/**
 * R1/F2 — the POSITIVE half: a properly controlled fixture still runs, and only a
 * test-host trust capability can make it trusted.
 * plan(20260928-105425).md §R1 (F2).
 *
 * WHAT IS ASSERTED HERE (green-only: it uses the capability added by R1)
 * ---------------------------------------------------------------------
 *   G1  a checkout pinned by an injected `createFixtureCheckoutTrust` capability
 *       really runs: the arm's own build is loaded in the child, its import-time
 *       side effect exists, its ONE model call is serviced, and — as a
 *       NON-VACUITY control — its real request to the loopback relay reaches the
 *       pretend billed upstream (both counters 1). The zeros asserted everywhere
 *       else are therefore measured, not vacuous.
 *   G2  an entry SWAPPED after the capability was issued is REFUSED before the
 *       child starts (pinned entry hash / build closure mismatch), 0 counters.
 *   G3  the marker DELETED after the capability was issued is REFUSED, 0 counters.
 *   G4  a COPIED tree (identical marker, different directory) is REFUSED: the
 *       capability pins canonical directories, so a copy is not the trusted tree.
 *   G5  a marker replaced by a SYMLINK after the capability was issued is REFUSED
 *       (skipped only where the host forbids file symlinks — reported, not hidden).
 *
 * SAFETY: the only contact is the two 127.0.0.1 counter servers this file starts.
 * No provider credential, no external host, no cost.
 */

import { existsSync, linkSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest, ProviderConfig } from "@ar/contracts";
import { R97_ARM_BUILD_ENTRIES, type ArmRunRef, type PreregisteredArmContext } from "@ar/evaluation";
import {
  EGRESS_ISOLATION_UNAVAILABLE,
  FIXTURE_CHECKOUT_MARKER_FILENAME,
  createFixtureCheckoutTrust,
} from "./prereg-arm-executor.js";
import { createProductionPreregRunner } from "./prereg-production-runner.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const REAL_CASE_ID = "stress-repeated-tool-failures";
const ARM_ENTRY_REL = "apps/cli/dist/benchmark-command.js";
const PREREG_DIGEST = "1".repeat(64);
const PLAN_DIGEST = "2".repeat(64);

let scratchDirs: string[] = [];
let servers: Server[] = [];

async function scratch(name: string): Promise<string> {
  const root = join(REPO_ROOT, ".ci", "r1-fixture-grant-scratch");
  await mkdir(root, { recursive: true });
  const d = await mkdtemp(join(root, `${name}-`));
  scratchDirs.push(d);
  return d;
}

beforeEach(() => undefined);
afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function startCountingRelay(): Promise<{
  relayUrl: string;
  relayHits: () => number;
  upstreamHits: () => number;
}> {
  let upstreamHits = 0;
  const upstream = createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream-ok");
  });
  servers.push(upstream);
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upAddr = upstream.address();
  if (upAddr === null || typeof upAddr === "string") throw new Error("no loopback port");
  const upstreamUrl = `http://127.0.0.1:${upAddr.port}`;

  let relayHits = 0;
  const relay = createServer((req, res) => {
    relayHits += 1;
    const proxied = httpRequest(`${upstreamUrl}${req.url ?? "/"}`, { method: req.method }, (up) => {
      res.writeHead(up.statusCode ?? 502, { "content-type": "text/plain" });
      up.pipe(res);
    });
    proxied.on("error", () => {
      res.writeHead(502);
      res.end("upstream unreachable");
    });
    req.pipe(proxied);
  });
  servers.push(relay);
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", () => resolve()));
  const relayAddr = relay.address();
  if (relayAddr === null || typeof relayAddr === "string") throw new Error("no loopback port");
  return {
    relayUrl: `http://127.0.0.1:${relayAddr.port}/trusted-egress`,
    relayHits: () => relayHits,
    upstreamHits: () => upstreamHits,
  };
}

function armEntrySource(marker: string, relayUrl: string | null, sideEffectPath: string): string {
  return [
    `import { writeFileSync } from "node:fs";`,
    `writeFileSync(${JSON.stringify(sideEffectPath)}, "RAN");`,
    `export const R97_ARM_PROBE = "probe:${marker}";`,
    "export async function runOneCase(caseDef, opts, _suite) {",
    ...(relayUrl === null
      ? []
      : [`  const egress = await fetch(${JSON.stringify(relayUrl)});`, "  await egress.text();"]),
    "  const client = opts.provider.createClient({ id: 'arm-fixture' }, {});",
    "  let input = 0;",
    "  let output = 0;",
    "  for await (const ev of client.generate({ messages: [] }, new AbortController().signal)) {",
    "    if (ev.type === 'usage') { input += ev.usage.inputTokens; output += ev.usage.outputTokens; }",
    "    if (ev.type === 'completed' || ev.type === 'error') break;",
    "  }",
    "  return {",
    "    caseId: caseDef.id,",
    "    status: 'failed',",
    "    actualStatus: 'completed',",
    "    events: [],",
    "    metrics: { turn_count: 1, tool_call_count: 0, tokens_input: input, tokens_output: output, context_tokens: 0, compaction_count: 0, duration_ms: 0, retry_count: 0, verification_failures: 0, human_interventions: 0, estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 1 },",
    "    violations: [],",
    `    reason: 'r1-grant:${marker}',`,
    "    suite: caseDef.suite || 'stress',",
    "    judgeVersion: '1.0.0',",
    "    terminationReason: 'verified_incomplete',",
    "  };",
    "}",
    "",
  ].join("\n");
}

async function makeArmCheckout(
  dir: string,
  marker: string,
  opts: { sideEffectPath: string; relayUrl: string | null; withMarker?: boolean },
): Promise<void> {
  for (const rel of R97_ARM_BUILD_ENTRIES) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    const source = rel === ARM_ENTRY_REL
      ? armEntrySource(marker, opts.relayUrl, opts.sideEffectPath)
      : `export const R1_GRANT_SIBLING_STUB = ${JSON.stringify(`sibling:${marker}`)};\n`;
    await writeFile(abs, source, "utf8");
  }
  if (opts.withMarker !== false) {
    await writeFile(
      join(dir, FIXTURE_CHECKOUT_MARKER_FILENAME),
      `${JSON.stringify({ writer: "scripts/e4/prereg-production-e2e.mjs", schema: "r97-synthetic-fixture-checkout-v1", marker })}\n`,
      "utf8",
    );
  }
}

function fakeProvider(): { provider: ModelProvider; entered: () => number } {
  let entered = 0;
  const provider: ModelProvider = {
    id: "r1-grant-fake",
    async listModels() {
      return [];
    },
    createClient(_m: never, _c: ProviderConfig) {
      return {
        async *generate(_r: ModelRequest, _s: AbortSignal): AsyncGenerator<ModelEvent> {
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

async function contextFor(evidenceDir: string, armId: "baseline" | "candidate"): Promise<PreregisteredArmContext> {
  return {
    provider: fakeProvider().provider,
    armRunId: `${armId}-run`,
    arm: armRef(armId),
    preregistrationDigest: PREREG_DIGEST,
    planDigest: PLAN_DIGEST,
    isolation: { isolationBackendId: "process-exec", isolationStrength: "process" },
    evidenceDir,
  };
}

async function catchOutcome(fn: () => Promise<unknown>): Promise<{ code: string | null; detail: string }> {
  try {
    await fn();
    return { code: null, detail: "" };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return { code: typeof code === "string" ? code : "NO_CODE", detail: err instanceof Error ? err.message : String(err) };
  }
}

describe("R1/F2 — a test-host trust capability is what makes a fixture checkout runnable", () => {
  it("[G1] a PINNED fixture checkout really runs (and its egress is really what the counters see)", async () => {
    const relay = await startCountingRelay();
    const sideEffectPath = join(await scratch("g1-out"), "child-ran.txt");
    const baselineDir = await scratch("g1-baseline");
    const candidateDir = await scratch("g1-candidate");
    const evidenceDir = await scratch("g1-evidence");
    await makeArmCheckout(baselineDir, "baseline", { sideEffectPath, relayUrl: null });
    await makeArmCheckout(candidateDir, "candidate", { sideEffectPath, relayUrl: relay.relayUrl });

    const trust = createFixtureCheckoutTrust(baselineDir, candidateDir);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      R97_ARM_BASELINE_DIR: baselineDir,
      R97_ARM_CANDIDATE_DIR: candidateDir,
    };
    const runner = createProductionPreregRunner({ rootDir: REPO_ROOT, env, trustedFixtureCheckouts: trust });
    const fake = fakeProvider();
    const arm = armRef("candidate");
    const outcome = await runner.runArm(arm, {
      provider: fake.provider,
      armRunId: "g1-candidate",
      arm,
      preregistrationDigest: PREREG_DIGEST,
      planDigest: PLAN_DIGEST,
      isolation: { isolationBackendId: "process-exec", isolationStrength: "process" },
      evidenceDir: join(evidenceDir, "g1-candidate"),
    });

    // The child really ran, serviced its model call through the driver's channel...
    expect(existsSync(sideEffectPath)).toBe(true);
    expect(fake.entered()).toBeGreaterThan(0);
    expect(outcome.evidence).toBeDefined();
    // ...and its REAL request to the loopback relay reached the pretend upstream.
    // This is the non-vacuity control for every 0 asserted in the refusal cases.
    expect(relay.relayHits()).toBe(1);
    expect(relay.upstreamHits()).toBe(1);
  }, 180_000);

  it("[G2] an entry SWAPPED after the capability was issued is REFUSED before the child starts", async () => {
    const relay = await startCountingRelay();
    const sideEffectPath = join(await scratch("g2-out"), "child-ran.txt");
    const baselineDir = await scratch("g2-baseline");
    const candidateDir = await scratch("g2-candidate");
    const evidenceDir = await scratch("g2-evidence");
    await makeArmCheckout(baselineDir, "baseline", { sideEffectPath, relayUrl: null });
    await makeArmCheckout(candidateDir, "candidate", { sideEffectPath, relayUrl: relay.relayUrl });

    const trust = createFixtureCheckoutTrust(baselineDir, candidateDir);
    // Swap AFTER the pin: the marker still says "fixture", the bytes no longer do.
    const entryPath = join(candidateDir, ARM_ENTRY_REL);
    await writeFile(entryPath, `${await readFile(entryPath, "utf8")}\nexport const SWAPPED_AFTER_PIN = true;\n`, "utf8");

    const env: NodeJS.ProcessEnv = { ...process.env, R97_ARM_BASELINE_DIR: baselineDir, R97_ARM_CANDIDATE_DIR: candidateDir };
    const runner = createProductionPreregRunner({ rootDir: REPO_ROOT, env, trustedFixtureCheckouts: trust });
    const r = await catchOutcome(async () => runner.runArm(armRef("candidate"), await contextFor(evidenceDir, "candidate")));
    expect(r.code, r.detail).toBe(EGRESS_ISOLATION_UNAVAILABLE);
    expect(r.detail).toContain("pinned");
    expect(existsSync(sideEffectPath)).toBe(false);
    expect(relay.relayHits()).toBe(0);
    expect(relay.upstreamHits()).toBe(0);
  }, 180_000);

  it("[G3] a marker DELETED after the capability was issued is REFUSED before the child starts", async () => {
    const relay = await startCountingRelay();
    const sideEffectPath = join(await scratch("g3-out"), "child-ran.txt");
    const baselineDir = await scratch("g3-baseline");
    const candidateDir = await scratch("g3-candidate");
    const evidenceDir = await scratch("g3-evidence");
    await makeArmCheckout(baselineDir, "baseline", { sideEffectPath, relayUrl: null });
    await makeArmCheckout(candidateDir, "candidate", { sideEffectPath, relayUrl: relay.relayUrl });

    const trust = createFixtureCheckoutTrust(baselineDir, candidateDir);
    unlinkSync(join(candidateDir, FIXTURE_CHECKOUT_MARKER_FILENAME));

    const env: NodeJS.ProcessEnv = { ...process.env, R97_ARM_BASELINE_DIR: baselineDir, R97_ARM_CANDIDATE_DIR: candidateDir };
    const runner = createProductionPreregRunner({ rootDir: REPO_ROOT, env, trustedFixtureCheckouts: trust });
    const r = await catchOutcome(async () => runner.runArm(armRef("candidate"), await contextFor(evidenceDir, "candidate")));
    expect(r.code, r.detail).toBe(EGRESS_ISOLATION_UNAVAILABLE);
    expect(r.detail).toContain("marker");
    expect(existsSync(sideEffectPath)).toBe(false);
    expect(relay.relayHits()).toBe(0);
    expect(relay.upstreamHits()).toBe(0);
  }, 180_000);

  it("[G4] a COPIED tree (identical marker, different directory) is REFUSED before the child starts", async () => {
    const relay = await startCountingRelay();
    const sideEffectPath = join(await scratch("g4-out"), "child-ran.txt");
    const baselineDir = await scratch("g4-baseline");
    const pinnedDir = await scratch("g4-pinned-candidate");
    const copiedDir = await scratch("g4-copied-candidate");
    const evidenceDir = await scratch("g4-evidence");
    await makeArmCheckout(baselineDir, "baseline", { sideEffectPath, relayUrl: null });
    await makeArmCheckout(pinnedDir, "candidate", { sideEffectPath, relayUrl: relay.relayUrl });
    // The copy carries the SAME marker bytes but is a different directory, and its
    // entry differs so ARM_BUILD_IDENTICAL cannot mask the trust decision.
    await makeArmCheckout(copiedDir, "candidate-copy", { sideEffectPath, relayUrl: relay.relayUrl });

    const trust = createFixtureCheckoutTrust(baselineDir, pinnedDir);
    const env: NodeJS.ProcessEnv = { ...process.env, R97_ARM_BASELINE_DIR: baselineDir, R97_ARM_CANDIDATE_DIR: copiedDir };
    const runner = createProductionPreregRunner({ rootDir: REPO_ROOT, env, trustedFixtureCheckouts: trust });
    const r = await catchOutcome(async () => runner.runArm(armRef("candidate"), await contextFor(evidenceDir, "candidate")));
    expect(r.code, r.detail).toBe(EGRESS_ISOLATION_UNAVAILABLE);
    expect(r.detail).toContain("pinned");
    expect(existsSync(sideEffectPath)).toBe(false);
    expect(relay.relayHits()).toBe(0);
    expect(relay.upstreamHits()).toBe(0);
  }, 180_000);

  it("[G5] a SYMLINKED marker introduced after the capability was issued is REFUSED", async (ctx) => {
    const relay = await startCountingRelay();
    const sideEffectPath = join(await scratch("g5-out"), "child-ran.txt");
    const baselineDir = await scratch("g5-baseline");
    const candidateDir = await scratch("g5-candidate");
    const evidenceDir = await scratch("g5-evidence");
    await makeArmCheckout(baselineDir, "baseline", { sideEffectPath, relayUrl: null });
    await makeArmCheckout(candidateDir, "candidate", { sideEffectPath, relayUrl: relay.relayUrl });

    const trust = createFixtureCheckoutTrust(baselineDir, candidateDir);
    unlinkSync(join(candidateDir, FIXTURE_CHECKOUT_MARKER_FILENAME));
    try {
      symlinkSync(
        join(baselineDir, FIXTURE_CHECKOUT_MARKER_FILENAME),
        join(candidateDir, FIXTURE_CHECKOUT_MARKER_FILENAME),
        "file",
      );
    } catch (err) {
      ctx.skip(`this host cannot create a file symlink: ${(err as { code?: string }).code ?? String(err)}`);
      return;
    }

    const env: NodeJS.ProcessEnv = { ...process.env, R97_ARM_BASELINE_DIR: baselineDir, R97_ARM_CANDIDATE_DIR: candidateDir };
    const runner = createProductionPreregRunner({ rootDir: REPO_ROOT, env, trustedFixtureCheckouts: trust });
    const r = await catchOutcome(async () => runner.runArm(armRef("candidate"), await contextFor(evidenceDir, "candidate")));
    expect(r.code, r.detail).toBe(EGRESS_ISOLATION_UNAVAILABLE);
    expect(existsSync(sideEffectPath)).toBe(false);
    expect(relay.relayHits()).toBe(0);
    expect(relay.upstreamHits()).toBe(0);
  }, 180_000);

  it("[G6] a plain object look-alike capability (what env/JSON could carry) is REFUSED", async () => {
    const relay = await startCountingRelay();
    const sideEffectPath = join(await scratch("g6-out"), "child-ran.txt");
    const baselineDir = await scratch("g6-baseline");
    const candidateDir = await scratch("g6-candidate");
    const evidenceDir = await scratch("g6-evidence");
    await makeArmCheckout(baselineDir, "baseline", { sideEffectPath, relayUrl: null });
    await makeArmCheckout(candidateDir, "candidate", { sideEffectPath, relayUrl: relay.relayUrl });

    // A JSON/env-derived "capability" is exactly what must NOT work.
    const forged = { checkouts: [{ dir: candidateDir }] } as unknown as NonNullable<
      Parameters<typeof createProductionPreregRunner>[0]
    >["trustedFixtureCheckouts"];
    const env: NodeJS.ProcessEnv = { ...process.env, R97_ARM_BASELINE_DIR: baselineDir, R97_ARM_CANDIDATE_DIR: candidateDir };
    const runner = createProductionPreregRunner({ rootDir: REPO_ROOT, env, trustedFixtureCheckouts: forged });
    const r = await catchOutcome(async () => runner.runArm(armRef("candidate"), await contextFor(evidenceDir, "candidate")));
    expect(r.code, r.detail).toBe(EGRESS_ISOLATION_UNAVAILABLE);
    expect(existsSync(sideEffectPath)).toBe(false);
    expect(relay.relayHits()).toBe(0);
    expect(relay.upstreamHits()).toBe(0);
  }, 180_000);

  it("[G7] a HARD-LINKED marker cannot substitute for the capability either", async () => {
    const relay = await startCountingRelay();
    const sideEffectPath = join(await scratch("g7-out"), "child-ran.txt");
    const baselineDir = await scratch("g7-baseline");
    const candidateDir = await scratch("g7-candidate");
    const evidenceDir = await scratch("g7-evidence");
    await makeArmCheckout(baselineDir, "baseline", { sideEffectPath, relayUrl: null });
    await makeArmCheckout(candidateDir, "candidate", { sideEffectPath, relayUrl: relay.relayUrl });
    // No capability at all: a hard link (which lstat cannot flag) is still nothing.
    unlinkSync(join(candidateDir, FIXTURE_CHECKOUT_MARKER_FILENAME));
    linkSync(join(baselineDir, FIXTURE_CHECKOUT_MARKER_FILENAME), join(candidateDir, FIXTURE_CHECKOUT_MARKER_FILENAME));

    const env: NodeJS.ProcessEnv = { ...process.env, R97_ARM_BASELINE_DIR: baselineDir, R97_ARM_CANDIDATE_DIR: candidateDir };
    const runner = createProductionPreregRunner({ rootDir: REPO_ROOT, env });
    const r = await catchOutcome(async () => runner.runArm(armRef("candidate"), await contextFor(evidenceDir, "candidate")));
    expect(r.code, r.detail).toBe(EGRESS_ISOLATION_UNAVAILABLE);
    expect(existsSync(sideEffectPath)).toBe(false);
    expect(relay.relayHits()).toBe(0);
    expect(relay.upstreamHits()).toBe(0);
  }, 180_000);
});
