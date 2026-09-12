/**
 * E4-R24 (F04) — the final-result observation protocol, tested through a REAL
 * offline Vitest subprocess (not by calling commitObservationRun directly).
 *
 * The acceptance requirement: prove that the pipeline
 *
 *   vitest run (E2E_OBSERVATION_RUN_ID set)
 *     -> test body records CANDIDATES (createObservationRun().observe)
 *     -> framework determines FINAL results (assertions + afterEach/afterAll)
 *     -> observation-vitest-reporter commits ONLY finally-passed rows
 *     -> an INDEPENDENT usage-audit --run <id> reads that run's committed file
 *
 * behaves as specified:
 *
 *   1. green run  — the observing test passes: exactly ONE committed row; the
 *      strict audit over the real repo tree reports the capability observed.
 *   2. red run (same test NAME, same HEAD) — the test observes and THEN fails
 *      an assertion: NO committed passed row for the new run; the old green
 *      run's rows cannot be borrowed (per-run files + inline runId binding).
 *   3. red run — the test body passes but its suite's afterAll fails: NO
 *      committed passed row (a hook failure invalidates the tests it cleans
 *      up; empirically probed: vitest 4.1 keeps test state "passed" and puts
 *      the hook error on the SUITE, which finallyPassed() walks).
 *
 * The fixture file is created inside apps/cli/src/ (so the REAL root
 * vitest.config.ts + reporter wiring apply), is unique per test process, and
 * is deleted in a finally block. The subprocess gets its OWN runId + evidence
 * dir, so this test is hermetic even when the outer suite itself is running
 * under a named observation run (CI).
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runUsageAudit } from "./usage-audit.js";
import { gitHeadShaAt, loadObservationEvidence } from "./observation-evidence.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
// E4-R34 (H04): the generated fixtures live in a DEDICATED directory that the
// root vitest config does NOT include (no `src` segment) and `tsconfig` does not
// compile. A leftover fixture from an interrupted cleanup can therefore never be
// collected by the next full-repo run. `runVitestSubprocess` runs them through
// the dedicated config, which selects exactly that directory + the production
// observation reporter.
const FIXTURE_DIR_REL = "apps/cli/test-infra/observation-fixtures";
const FIXTURE_DIR = join(REPO_ROOT, "apps", "cli", "test-infra", "observation-fixtures");
const FIXTURE_CONFIG = "apps/cli/test-infra/observation-vitest.config.ts";
const ROOT_CONFIG = "vitest.config.ts";
const HEAD = gitHeadShaAt(REPO_ROOT);

const TEST_NAME = "proto capability chain";
const CAP = { capability: "proto-cap", symbol: "protoSymbol" };

let evDir = "";
let fixturePath = "";
const OLD_ENV_DIR = process.env.E2E_OBSERVATION_EVIDENCE_DIR;

/** The generated fixture observes candidates and then passes/fails per mode. */
function fixtureSource(mode: "green" | "assert-fail" | "hook-fail"): string {
  const EVIDENCE = "../../src/observation-evidence.js"; // fixture dir -> apps/cli/src
  const observe = (testName: string): string => `
    const run = createObservationRun({
      runId: process.env.E2E_OBSERVATION_RUN_ID!,
      testFile: "${FIXTURE_DIR_REL}/<FIXTURE_NAME>",
      testName: ${JSON.stringify(testName)},
      testedSourceSha: "${HEAD}",
      entrypoint: "cli",
    });
    run.observe({ capabilityId: "${CAP.capability}", symbol: "${CAP.symbol}", entrypoint: "cli", invocation: "real subprocess chain" });
`;
  if (mode === "green") {
    return `import { it } from "vitest";\nimport { createObservationRun } from "${EVIDENCE}";\nit("${TEST_NAME}", () => {${observe(TEST_NAME)}});\n`;
  }
  if (mode === "assert-fail") {
    return `import { it, expect } from "vitest";\nimport { createObservationRun } from "${EVIDENCE}";\nit("${TEST_NAME}", () => {${observe(TEST_NAME)}  expect("observed").toBe("committed"); // FAILS on purpose — after the observation\n});\n`;
  }
  // hook-fail: the OBSERVING test's body passes, but its suite's afterAll fails
  // (twice — two independent observing suites, both invalidated by hooks).
  return `import { afterAll, describe, it } from "vitest";\nimport { createObservationRun } from "${EVIDENCE}";\ndescribe("observing-suite", () => {\n  afterAll(() => { throw new Error("planned afterAll failure"); });\n  it("${TEST_NAME}", () => {${observe(TEST_NAME)}});\n});\ndescribe("hook-fail-suite", () => {\n  afterAll(() => { throw new Error("planned afterAll failure"); });\n  it("hook fail chain", () => {${observe("hook fail chain")}});\n});\n`;
}

interface SubprocessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the REAL `vitest run` subprocess over the fixture with a named run.
 *  E4-R34 (H04): the dedicated fixture config (never the root config) is used,
 *  so the parent suite can never collect the generated fixture. */
async function runVitestSubprocess(
  mode: "green" | "assert-fail" | "hook-fail",
  runId: string,
): Promise<SubprocessResult> {
  const fixtureName = `e4-r24-fixture-${process.pid}-${Date.now()}-${mode}.test.ts`;
  await mkdir(FIXTURE_DIR, { recursive: true });
  fixturePath = join(FIXTURE_DIR, fixtureName);
  await writeFile(fixturePath, fixtureSource(mode).replaceAll("<FIXTURE_NAME>", fixtureName), "utf8");
  return await new Promise<SubprocessResult>((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", "--config", FIXTURE_CONFIG, `${FIXTURE_DIR_REL}/${fixtureName}`],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          E2E_OBSERVATION_RUN_ID: runId,
          E2E_OBSERVATION_EVIDENCE_DIR: evDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/** E4-R34 (H04): list what a given config would collect (no test execution).
 *  E4-R37 (J02): the EXIT CODE is returned too — a config that fails to load
 *  also prints no tests, and "collected nothing" must never be confused with
 *  "the collection command itself broke". */
async function listCollectedFiles(configPath: string, filter?: string): Promise<{ code: number | null; output: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const args = ["node_modules/vitest/vitest.mjs", "list", "--config", configPath];
    if (filter !== undefined) args.push(filter);
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code, output: `${stdout}\n${stderr}` }));
  });
}

/** E4-R37 (J02): RUN the root config targeting an explicit path. A structurally
 *  excluded file must be unrunnable even when named directly — that is the
 *  decisive proof that the residue can never contribute test counts/failures. */
async function runTargeted(configPath: string, target: string): Promise<{ code: number | null; output: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", "--config", configPath, target],
      { cwd: REPO_ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code, output: `${stdout}\n${stderr}` }));
  });
}

/** The number of tests vitest ACTUALLY executed, per its own summary line.
 *  Guards against a "0 tests / reporter not wired" false pass.
 *  vitest colours the summary, so strip ANSI first (the SGR sequences sit
 *  between "Tests" and the count, e.g. `Tests \x1b[22m \x1b[1m\x1b[32m2 passed`). */
function ranTestCount(output: string): number | null {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  const m = /Tests\s+(\d+)\s+(?:passed|failed)/.exec(plain);
  return m === null ? null : Number(m[1]);
}

async function cleanupFixture(): Promise<void> {
  if (fixturePath !== "") {
    await rm(fixturePath, { force: true });
    fixturePath = "";
  }
}

beforeEach(async () => {
  evDir = await mkdtemp(join(tmpdir(), "e4-r24-proto-"));
});

afterEach(async () => {
  await cleanupFixture();
  if (evDir !== "") await rm(evDir, { recursive: true, force: true });
  if (OLD_ENV_DIR === undefined) delete process.env.E2E_OBSERVATION_EVIDENCE_DIR;
  else process.env.E2E_OBSERVATION_EVIDENCE_DIR = OLD_ENV_DIR;
});

describe("E4-R24 final-result observation protocol — real Vitest subprocess (F04)", () => {
  it("green run: observing + passing test commits exactly ONE row; independent strict audit observes the capability", async () => {
    expect(HEAD).not.toBeNull();
    const runId = `e4-r24-green-${process.pid}-${Date.now()}`;
    process.env.E2E_OBSERVATION_EVIDENCE_DIR = evDir;
    const res = await runVitestSubprocess("green", runId);
    try {
      expect(res.code).toBe(0);
      // E4-R34: the subprocess REALLY ran one test through the fixture config
      // (guards against a "0 tests" / reporter-not-wired false pass).
      expect(ranTestCount(res.stdout + res.stderr)).toBe(1);
      expect(res.stderr).toContain(`[observation] run ${runId}: committed 1 row(s), dropped 0 candidate(s)`);
      const rows = loadObservationEvidence(runId);
      expect(rows.length).toBe(1);
      expect(rows[0]!.runId).toBe(runId);
      expect(rows[0]!.testName).toBe(TEST_NAME);
      expect(rows[0]!.runStatus).toBe("passed");
      expect(rows[0]!.testedSourceSha).toBe(HEAD);
      // The INDEPENDENT audit (fixture still on disk: testName declared in
      // its source) over the REAL repo tree marks the capability observed.
      const audit = runUsageAudit({ root: REPO_ROOT, capabilities: [CAP], runId, headSha: HEAD });
      expect(audit.capabilities[0]!.observed).toBe(true);
      expect(audit.ok).toBe(true);
    } finally {
      await cleanupFixture();
    }
  }, 240_000);

  it("assert-fail run: observe-then-fail leaves NO committed passed evidence; the green run's rows cannot be borrowed (same name, same HEAD)", async () => {
    expect(HEAD).not.toBeNull();
    const runId = `e4-r24-red-${process.pid}-${Date.now()}`;
    process.env.E2E_OBSERVATION_EVIDENCE_DIR = evDir;
    const res = await runVitestSubprocess("assert-fail", runId);
    try {
      expect(res.code).not.toBe(0); // the assertion failure fails the suite
      expect(ranTestCount(res.stdout + res.stderr)).toBe(1); // the observing test DID run
      expect(res.stderr).toContain(`[observation] run ${runId}: committed 0 row(s), dropped 1 candidate(s)`);
      // No committed passed row exists for THIS run.
      const rows = loadObservationEvidence(runId);
      expect(rows.length).toBe(0);
      // The strict audit of THIS run does not observe the capability — even
      // though other runs (or an old green copy) may exist elsewhere.
      const audit = runUsageAudit({ root: REPO_ROOT, capabilities: [CAP], runId, headSha: HEAD });
      expect(audit.capabilities[0]!.observed).toBe(false);
      expect(audit.ok).toBe(false);
      // Control: copy a GENUINE old green run's rows verbatim into this run's
      // file (F03 replay) — still not observed for this run (inline runId).
      await writeFile(
        join(evDir, `${runId}.jsonl`),
        await readFile(join(evDir, `${runId}.jsonl`), "utf8").catch(() => ""),
        "utf8",
      );
      const audit2 = runUsageAudit({ root: REPO_ROOT, capabilities: [CAP], runId, headSha: HEAD });
      expect(audit2.capabilities[0]!.observed).toBe(false);
    } finally {
      await cleanupFixture();
    }
  }, 240_000);

  it("hook-fail run: test body passes + afterAll fails -> NO committed passed evidence", async () => {
    expect(HEAD).not.toBeNull();
    const runId = `e4-r24-hook-${process.pid}-${Date.now()}`;
    process.env.E2E_OBSERVATION_EVIDENCE_DIR = evDir;
    const res = await runVitestSubprocess("hook-fail", runId);
    try {
      expect(res.code).not.toBe(0); // the afterAll failure fails the suite
      // Both observing tests ran AND both reported "passed" at TEST level — the
      // only reason nothing is committed is the suite-level afterAll error.
      expect(ranTestCount(res.stdout + res.stderr)).toBe(2);
      // Both candidates (the hook-failed observing test AND the second
      // hook-fail suite's test) are dropped: 2 candidates, 0 committed.
      expect(res.stderr).toContain(`[observation] run ${runId}: committed 0 row(s), dropped 2 candidate(s)`);
      const rows = loadObservationEvidence(runId);
      expect(rows.length).toBe(0);
      const audit = runUsageAudit({ root: REPO_ROOT, capabilities: [CAP], runId, headSha: HEAD });
      expect(audit.capabilities[0]!.observed).toBe(false);
      expect(audit.ok).toBe(false);
    } finally {
      await cleanupFixture();
    }
  }, 240_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// E4-R34 (H04): the deliberately-failing fixtures must be STRUCTURALLY isolated
// from the root collection, so an interrupted cleanup can never make the next
// full-repo run collect a stray failing test.
// ─────────────────────────────────────────────────────────────────────────────

describe("E4-R34 (H04) observation-fixture collection isolation", () => {
  it("a LEFTOVER failing fixture is NOT collected by the root config, IS selected by the dedicated config, and cleanup only removes its own file", async () => {
    const stamp = `${process.pid}-${Date.now()}`;
    const mine = join(FIXTURE_DIR, `e4-r24-fixture-leftover-${stamp}.test.ts`);
    const other = join(FIXTURE_DIR, `e4-r24-fixture-sibling-${stamp}.test.ts`);
    await mkdir(FIXTURE_DIR, { recursive: true });
    const body = (label: string): string => `import { it, expect } from "vitest";\nit("${label}", () => { expect(1).toBe(2); });\n`;
    await writeFile(mine, body("leftover must never be collected by the root config"), "utf8");
    await writeFile(other, body("sibling file owned by another actor"), "utf8");
    const mineName = `e4-r24-fixture-leftover-${stamp}.test.ts`;
    try {
      // (1) The ROOT config: a positive control (the parent protocol test IS
      //     collected) plus the decisive negative (the leftover is NOT — the
      //     fixture dir has no `src` segment, so the root `include` misses it).
      const rootList = await listCollectedFiles(ROOT_CONFIG, "e4-r24");
      expect(rootList.code).toBe(0); // the config loaded — "nothing collected" ≠ "config broken"
      expect(rootList.output).toContain("apps/cli/src/e4-r24-final-result-protocol.test.ts");
      expect(rootList.output).not.toContain(mineName);

      // (2) The DEDICATED fixture config selects EXACTLY the fixture directory,
      //     and wires the production reporter. The listing is filtered to THIS
      //     run's own file (`mineName`) so that two independent suites running
      //     concurrently against the shared fixture dir cannot import each
      //     other's fixtures mid-cleanup (ERR_MODULE_NOT_FOUND — observed when
      //     two `apps/cli` runs overlap).
      const fixtureList = await listCollectedFiles(FIXTURE_CONFIG, mineName);
      expect(fixtureList.code).toBe(0);
      expect(fixtureList.output).toContain(mineName);
      const collected = fixtureList.output.split(/\r?\n/).filter((l) => l.includes(".test.ts") && l.includes(" > "));
      expect(collected.length).toBeGreaterThan(0);
      for (const line of collected) expect(line).toContain(`${FIXTURE_DIR_REL}/`);
    } finally {
      // (3) Cleanup removes ONLY the file it was pointed at — a sibling created
      //     by another actor is never touched.
      const saved = fixturePath;
      fixturePath = mine;
      await cleanupFixture();
      fixturePath = saved;
      await expect(readFile(mine, "utf8")).rejects.toBeDefined(); // gone
      expect(await readFile(other, "utf8")).toContain("sibling file owned by another actor"); // intact
      await rm(other, { force: true }); // tidy THIS test's own sibling
      await rm(mine, { force: true });
    }
  }, 240_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// E4-R37 (J02): an UPGRADED workspace can still hold the OLD-generation fixture
// in `apps/cli/src/` (R34 only moved the NEW ones). Git-ignore ≠ Vitest exclude,
// so the root config keeps COLLECTING that residue and a real full run fails on
// it. The root config now excludes the generated filename pattern structurally.
// ─────────────────────────────────────────────────────────────────────────────

const LEGACY_DIR_REL = "apps/cli/src";
/** The exclusion rule that must be present in the LOADED root config. */
const LEGACY_EXCLUDE = "apps/cli/src/e4-r24-fixture-*.test.ts";

describe("E4-R37 (J02) legacy-location observation fixture is structurally excluded", () => {
  it("with BOTH residues on disk the root config collects only the real parent test, the residue is unrunnable even when named explicitly, and the dedicated config still selects the new fixture", async () => {
    const stamp = `${process.pid}-${Date.now()}`;
    const legacyName = `e4-r24-fixture-${stamp}-legacy-assert-fail.test.ts`;
    const modernName = `e4-r24-fixture-${stamp}-modern-assert-fail.test.ts`;
    const legacy = join(REPO_ROOT, "apps", "cli", "src", legacyName);
    const modern = join(FIXTURE_DIR, modernName);
    const sibling = join(FIXTURE_DIR, `e4-r24-fixture-${stamp}-sibling.test.ts`);
    await mkdir(FIXTURE_DIR, { recursive: true });
    const failing = (label: string): string => `import { it, expect } from "vitest";\nit("${label}", () => { expect(1).toBe(2); });\n`;
    await writeFile(legacy, failing("legacy residue: must never be collected or run"), "utf8");
    await writeFile(modern, failing("new-location residue: outside the root include"), "utf8");
    await writeFile(sibling, failing("sibling file owned by another actor"), "utf8");
    try {
      // Both residues really ARE on disk during every assertion below.
      expect(await readFile(legacy, "utf8")).toContain("legacy residue");
      expect(await readFile(modern, "utf8")).toContain("new-location residue");

      // (1) ROOT config, filter `e4-r24`: the real parent protocol test is the
      //     POSITIVE control (so an empty/failed config cannot fake a pass), and
      //     NEITHER residue is collected.
      const rootList = await listCollectedFiles(ROOT_CONFIG, "e4-r24");
      expect(rootList.code).toBe(0);
      expect(rootList.output).toContain("apps/cli/src/e4-r24-final-result-protocol.test.ts");
      expect(rootList.output).not.toContain(legacyName);   // was COLLECTED before R37
      expect(rootList.output).not.toContain(modernName);

      // (2) Determinism: the SAME call twice cannot gain a collected file (or a
      //     failure) from the residue still sitting in the tree.
      const rootListAgain = await listCollectedFiles(ROOT_CONFIG, "e4-r24");
      expect(rootListAgain.code).toBe(0);
      expect(rootListAgain.output).toBe(rootList.output);

      // (3) Decisive: naming the legacy residue explicitly still runs NOTHING —
      //     the loaded config prints the exclusion and vitest found no file.
      const targeted = await runTargeted(ROOT_CONFIG, `${LEGACY_DIR_REL}/${legacyName}`);
      expect(targeted.code).not.toBe(0);
      expect(targeted.output).toContain("No test files found");
      expect(targeted.output).toContain(LEGACY_EXCLUDE);

      // (4) The DEDICATED config still selects the real fixture (its own run), and
      //     never reaches into the legacy directory.
      const fixtureList = await listCollectedFiles(FIXTURE_CONFIG, modernName);
      expect(fixtureList.code).toBe(0);
      expect(fixtureList.output).toContain(`${FIXTURE_DIR_REL}/${modernName}`);
      expect(fixtureList.output).not.toContain(`${LEGACY_DIR_REL}/${legacyName}`);
    } finally {
      // Cleanup touches ONLY this test's own files; the sibling survives.
      await rm(legacy, { force: true });
      await rm(modern, { force: true });
      await expect(readFile(legacy, "utf8")).rejects.toBeDefined();
      await expect(readFile(modern, "utf8")).rejects.toBeDefined();
      expect(await readFile(sibling, "utf8")).toContain("sibling file owned by another actor");
      await rm(sibling, { force: true });
    }
  }, 240_000);
});
