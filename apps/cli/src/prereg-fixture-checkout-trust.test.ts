/**
 * R1 / F2 — a MARKER FILE IS NOT A TRUST ANCHOR (P0 security boundary).
 * plan(20260928-105425).md §R1 (F2); AGENTS.md Runtime Freeze P38.4-11 clause 2
 * (security vulnerability) is the sanctioned justification for the code change.
 *
 * THE DEFECT THIS FILE PINS (baseline a85db6dc, prereg-arm-executor.ts:415-429)
 * ---------------------------------------------------------------------------
 * The executor trusted a checkout SOLELY because `.r97-synthetic-fixture-checkout`
 * existed (`existsSync`). Possession of a filename is not provenance: any writer
 * can create, copy, hard-link or symlink that file into an arbitrary tree, and the
 * executor would then START that tree — i.e. run arbitrary code — claiming it was
 * a harness-authored synthetic fixture. Meanwhile a genuine source checkout is
 * refused because `egressIsolationCapability().available === false`.
 *
 * WHAT IS ASSERTED HERE (baseline-API only, so the RED failure is the TARGET
 * assertion and not a missing export)
 * --------------------------------------------------------------------------
 * A self-written marker, a copied marker, a hard-linked marker and a symlinked
 * marker must each be REFUSED with `EGRESS_ISOLATION_UNAVAILABLE`, BEFORE the
 * child starts: the arm build's import-time side effect must not exist and the two
 * local counting servers ("loopback relay -> pretend billed upstream") must both
 * read 0. A swapped entry behind an intact marker is refused too.
 *
 * SAFETY: only the two 127.0.0.1 counter servers this file starts are contacted
 * (and only if the executor wrongly starts the child). No provider, no key, no
 * external host, no cost.
 */

import { existsSync, linkSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelEvent, ModelProvider, ModelRequest, ProviderConfig } from "@ar/contracts";
import { R97_ARM_BUILD_ENTRIES, type ArmRunRef, type PreregisteredArmContext } from "@ar/evaluation";
import { EGRESS_ISOLATION_UNAVAILABLE, FIXTURE_CHECKOUT_MARKER_FILENAME } from "./prereg-arm-executor.js";
import { createProductionPreregRunner } from "./prereg-production-runner.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const REAL_CASE_ID = "stress-repeated-tool-failures";
const ARM_ENTRY_REL = "apps/cli/dist/benchmark-command.js";
const PREREG_DIGEST = "1".repeat(64);
const PLAN_DIGEST = "2".repeat(64);

let scratchDirs: string[] = [];
let servers: Server[] = [];

async function scratch(name: string): Promise<string> {
  // INSIDE the repo on purpose: the checkouts must resolve as ES modules (the
  // repo's `"type": "module"`), exactly as the shipped fixture writer's do. A
  // scratch dir under the OS temp dir would have no package.json and the arm
  // entry would fail for a reason that has nothing to do with trust. `.ci/` is
  // git-ignored and removed in afterEach.
  const root = join(REPO_ROOT, ".ci", "r1-fixture-trust-scratch");
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

// ---------------------------------------------------------------------------
// Two local counters: a loopback relay that forwards to a pretend billed upstream
// ---------------------------------------------------------------------------

interface CountingRelay {
  relayUrl: string;
  relayHits: () => number;
  upstreamHits: () => number;
  close: () => Promise<void>;
}

async function startCountingRelay(): Promise<CountingRelay> {
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
    relayUrl: `http://127.0.0.1:${relayAddr.port}/attacker-egress`,
    relayHits: () => relayHits,
    upstreamHits: () => upstreamHits,
    close: async () => {
      await Promise.all(
        [relay, upstream].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// The arm fixture: import-time side effect + a real outbound request
// ---------------------------------------------------------------------------

function armOutcomeSource(marker: string, relayUrl: string): string[] {
  return [
    "export async function runOneCase(caseDef, _opts, _suite) {",
    // The egress happens INSIDE the async body (not as top-level await, which a
    // CJS-resolved checkout would reject), so a started worker really completes
    // one request to the loopback relay before returning.
    `  const egress = await fetch(${JSON.stringify(relayUrl)});`,
    "  await egress.text();",
    "  return {",
    "    caseId: caseDef.id,",
    "    status: 'failed',",
    "    actualStatus: 'completed',",
    "    events: [],",
    "    metrics: { turn_count: 0, tool_call_count: 0, tokens_input: 0, tokens_output: 0, context_tokens: 0, compaction_count: 0, duration_ms: 0, retry_count: 0, verification_failures: 0, human_interventions: 0, estimated_cost: 0, usage_unknown: 0, cache_tokens_read: 0, cache_tokens_created: 0, model_call_count: 0 },",
    "    violations: [],",
    `    reason: 'r1-probe:${marker}',`,
    "    suite: caseDef.suite || 'stress',",
    "    judgeVersion: '1.0.0',",
    "    terminationReason: 'verified_incomplete',",
    "  };",
    "}",
    "",
  ];
}

/**
 * Write a loadable arm checkout whose entry, AT IMPORT TIME, records that it ran
 * and makes one real request to the loopback relay. If the executor starts this
 * tree, both counters move — measured, not inferred.
 */
async function makeArmCheckout(
  dir: string,
  marker: string,
  opts: { sideEffectPath: string; relayUrl: string },
): Promise<void> {
  const prefix = [
    `import { writeFileSync } from "node:fs";`,
    `writeFileSync(${JSON.stringify(opts.sideEffectPath)}, "RAN");`,
  ];
  for (const rel of R97_ARM_BUILD_ENTRIES) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    const source = rel === ARM_ENTRY_REL
      ? [
          ...prefix,
          `export const R97_ARM_PROBE = "probe:${marker}";`,
          ...armOutcomeSource(marker, opts.relayUrl),
        ].join("\n")
      : `export const R1_SIBLING_STUB = ${JSON.stringify(`sibling:${marker}`)};\n`;
    await writeFile(abs, source, "utf8");
  }
}

async function writeMarker(dir: string, writer: string): Promise<void> {
  await writeFile(
    join(dir, FIXTURE_CHECKOUT_MARKER_FILENAME),
    `${JSON.stringify({ writer, schema: "r97-synthetic-fixture-checkout-v1" })}\n`,
    "utf8",
  );
}

function fakeProvider(): ModelProvider {
  return {
    id: "r1-fake",
    async listModels() {
      return [];
    },
    createClient(_m: never, _c: ProviderConfig) {
      return {
        async *generate(_r: ModelRequest, _s: AbortSignal): AsyncGenerator<ModelEvent> {
          yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2 }, timestamp: 0 };
          yield { type: "completed", result: { finishReason: "stop" }, timestamp: 0 };
        },
      };
    },
  };
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

async function catchCode(fn: () => Promise<unknown>): Promise<{ code: string | null; detail: string }> {
  try {
    await fn();
    return { code: null, detail: "" };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return {
      code: typeof code === "string" ? code : `NO_CODE`,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The shared setup: a counting relay plus a candidate checkout with a marker. */
async function scenario(name: string): Promise<{
  relay: CountingRelay;
  baselineDir: string;
  candidateDir: string;
  evidenceDir: string;
  sideEffectPath: string;
}> {
  const relay = await startCountingRelay();
  const outDir = await scratch(`${name}-out`);
  const sideEffectPath = join(outDir, "child-ran.txt");
  const baselineDir = await scratch(`${name}-baseline`);
  const candidateDir = await scratch(`${name}-candidate`);
  const evidenceDir = await scratch(`${name}-evidence`);
  await makeArmCheckout(baselineDir, "baseline", { sideEffectPath, relayUrl: relay.relayUrl });
  await writeMarker(baselineDir, "r1-test-baseline");
  await makeArmCheckout(candidateDir, "candidate", { sideEffectPath, relayUrl: relay.relayUrl });
  return { relay, baselineDir, candidateDir, evidenceDir, sideEffectPath };
}

async function expectRefusedBeforeStart(s: {
  relay: CountingRelay;
  baselineDir: string;
  candidateDir: string;
  evidenceDir: string;
  sideEffectPath: string;
}): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    R97_ARM_BASELINE_DIR: s.baselineDir,
    R97_ARM_CANDIDATE_DIR: s.candidateDir,
  };
  const production = createProductionPreregRunner({ rootDir: REPO_ROOT, env });
  const outcome = await catchCode(async () => production.runArm(armRef("candidate"), await contextFor(s.evidenceDir, "candidate")));
  expect(
    outcome.code,
    `a marker-only checkout must be refused before the worker starts (observed: code=${String(
      outcome.code,
    )}, detail=${outcome.detail.slice(0, 300)}, childRan=${existsSync(s.sideEffectPath)}, relayHits=${s.relay.relayHits()}, upstreamHits=${s.relay.upstreamHits()})`,
  ).toBe(EGRESS_ISOLATION_UNAVAILABLE);
  // The child never ran...
  expect(existsSync(s.sideEffectPath)).toBe(false);
  // ...so neither the loopback relay nor its pretend billed upstream saw anything.
  expect(s.relay.relayHits()).toBe(0);
  expect(s.relay.upstreamHits()).toBe(0);
}

describe("R1/F2 — a marker file cannot upgrade an arbitrary checkout into a trusted fixture", () => {
  it("[F2.1][RED TARGET] a SELF-WRITTEN marker must not start the checkout", async () => {
    const s = await scenario("self-written");
    await writeMarker(s.candidateDir, "attacker:self-written");
    await expectRefusedBeforeStart(s);
  }, 180_000);

  it("[F2.2] a COPIED marker must not start the checkout", async () => {
    const s = await scenario("copied");
    // Copying the marker's BYTES from a tree that legitimately carries one is the
    // cheapest possible forgery; the bytes are identical, only provenance differs.
    const bytes = await readFile(join(s.baselineDir, FIXTURE_CHECKOUT_MARKER_FILENAME), "utf8");
    await writeFile(join(s.candidateDir, FIXTURE_CHECKOUT_MARKER_FILENAME), bytes, "utf8");
    await expectRefusedBeforeStart(s);
  }, 180_000);

  it("[F2.3] a HARD-LINKED marker must not start the checkout (lstat cannot see it)", async () => {
    const s = await scenario("hardlinked");
    // A hard link shares the inode with the trusted marker: it is not a symlink,
    // so an `lstat().isSymbolicLink()` check alone would not catch it. Only the
    // out-of-band trust grant can.
    linkSync(join(s.baselineDir, FIXTURE_CHECKOUT_MARKER_FILENAME), join(s.candidateDir, FIXTURE_CHECKOUT_MARKER_FILENAME));
    await expectRefusedBeforeStart(s);
  }, 180_000);

  it("[F2.4] a SYMLINKED marker must not start the checkout", async (ctx) => {
    const s = await scenario("symlinked");
    try {
      symlinkSync(join(s.baselineDir, FIXTURE_CHECKOUT_MARKER_FILENAME), join(s.candidateDir, FIXTURE_CHECKOUT_MARKER_FILENAME), "file");
    } catch (err) {
      // This Windows host denies file symlinks (EPERM) without elevation, so the
      // case is NOT_OBSERVED here rather than silently claimed.
      ctx.skip(`this host cannot create a file symlink: ${(err as { code?: string }).code ?? String(err)}`);
      return;
    }
    await expectRefusedBeforeStart(s);
  }, 180_000);

  it("[F2.5] a SWAPPED ENTRY behind an intact marker must not start the checkout", async () => {
    const s = await scenario("swapped-entry");
    await writeMarker(s.candidateDir, "attacker:swapped-entry");
    // Proof of the swap: the entry's bytes (and therefore the build digest) change
    // while the marker stays exactly where it was.
    const entryPath = join(s.candidateDir, ARM_ENTRY_REL);
    const before = await readFile(entryPath, "utf8");
    await writeFile(entryPath, `${before}\nexport const SWAPPED = "swapped-after-marker";\n`, "utf8");
    expect(await readFile(entryPath, "utf8")).not.toBe(before);
    // The baseline digest must stay distinct or ARM_BUILD_IDENTICAL would mask the
    // trust decision being measured here.
    await expectRefusedBeforeStart(s);
  }, 180_000);
});
