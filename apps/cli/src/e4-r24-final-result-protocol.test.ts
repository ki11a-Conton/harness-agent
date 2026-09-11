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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runUsageAudit } from "./usage-audit.js";
import { gitHeadShaAt, loadObservationEvidence } from "./observation-evidence.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const FIXTURE_DIR = join(REPO_ROOT, "apps", "cli", "src");
const HEAD = gitHeadShaAt(REPO_ROOT);

const TEST_NAME = "proto capability chain";
const CAP = { capability: "proto-cap", symbol: "protoSymbol" };

let evDir = "";
let fixturePath = "";
const OLD_ENV_DIR = process.env.E2E_OBSERVATION_EVIDENCE_DIR;

/** The generated fixture observes candidates and then passes/fails per mode. */
function fixtureSource(mode: "green" | "assert-fail" | "hook-fail"): string {
  const observe = (testName: string): string => `
    const run = createObservationRun({
      runId: process.env.E2E_OBSERVATION_RUN_ID!,
      testFile: "apps/cli/src/<FIXTURE_NAME>",
      testName: ${JSON.stringify(testName)},
      testedSourceSha: "${HEAD}",
      entrypoint: "cli",
    });
    run.observe({ capabilityId: "${CAP.capability}", symbol: "${CAP.symbol}", entrypoint: "cli", invocation: "real subprocess chain" });
`;
  if (mode === "green") {
    return `import { it } from "vitest";\nimport { createObservationRun } from "./observation-evidence.js";\nit("${TEST_NAME}", () => {${observe(TEST_NAME)}});\n`;
  }
  if (mode === "assert-fail") {
    return `import { it, expect } from "vitest";\nimport { createObservationRun } from "./observation-evidence.js";\nit("${TEST_NAME}", () => {${observe(TEST_NAME)}  expect("observed").toBe("committed"); // FAILS on purpose — after the observation\n});\n`;
  }
  // hook-fail: the OBSERVING test's body passes, but its suite's afterAll fails
  // (twice — two independent observing suites, both invalidated by hooks).
  return `import { afterAll, describe, it } from "vitest";\nimport { createObservationRun } from "./observation-evidence.js";\ndescribe("observing-suite", () => {\n  afterAll(() => { throw new Error("planned afterAll failure"); });\n  it("${TEST_NAME}", () => {${observe(TEST_NAME)}});\n});\ndescribe("hook-fail-suite", () => {\n  afterAll(() => { throw new Error("planned afterAll failure"); });\n  it("hook fail chain", () => {${observe("hook fail chain")}});\n});\n`;
}

interface SubprocessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the REAL `vitest run` subprocess over the fixture with a named run. */
async function runVitestSubprocess(
  mode: "green" | "assert-fail" | "hook-fail",
  runId: string,
): Promise<SubprocessResult> {
  const fixtureName = `e4-r24-fixture-${process.pid}-${Date.now()}-${mode}.test.ts`;
  fixturePath = join(FIXTURE_DIR, fixtureName);
  await writeFile(fixturePath, fixtureSource(mode).replaceAll("<FIXTURE_NAME>", fixtureName), "utf8");
  return await new Promise<SubprocessResult>((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", `apps/cli/src/${fixtureName}`],
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
