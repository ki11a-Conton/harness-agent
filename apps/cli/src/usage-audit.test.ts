/**
 * E4-10 + E4-R18 + E4-R24 — production usage audit tests.
 *
 * The audit must classify honestly from on-disk evidence and must NOT let a
 * capability claim more reach than the code proves. E4-R18 (N15/N16):
 * `observed` requires STRICT per-run observation evidence — recomputed digest,
 * exact 40-hex SHA match, registered symbol, existing test file, and a
 * SPECIFIC runId (an old successful run can never mask a current failure).
 *
 * E4-R24 (F03/F04): rows are committed ONLY from the test framework's FINAL
 * results (commitObservationRun — what the Vitest reporter calls); rows copied
 * from another run's file are dropped by the loader (inline runId must equal
 * the requested run); a testName that is not declared in its testFile's source
 * is never observed, however correct the row digests look.
 */

import { describe, expect, it, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runUsageAudit, renderUsageAudit, KEY_CAPABILITIES } from "./usage-audit.js";
import {
  computeObservationEvidenceDigest,
  computeObservationResultDigest,
  observationEvidencePathForRun,
  observationCandidatesPathForRun,
  isSafeObservationRunId,
  OBSERVATION_EVIDENCE_SCHEMA_VERSION,
  createObservationRun,
  commitObservationRun,
} from "./observation-evidence.js";

let root = "";
let evDir = "";
const OLD_ENV = process.env.E2E_OBSERVATION_EVIDENCE_DIR;

async function makeRoot(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "usage-audit-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

beforeEach(async () => {
  evDir = await mkdtemp(join(tmpdir(), "usage-audit-ev-"));
  process.env.E2E_OBSERVATION_EVIDENCE_DIR = evDir;
});

afterEach(async () => {
  if (evDir !== "") await rm(evDir, { recursive: true, force: true });
  if (OLD_ENV === undefined) delete process.env.E2E_OBSERVATION_EVIDENCE_DIR;
  else process.env.E2E_OBSERVATION_EVIDENCE_DIR = OLD_ENV;
});

afterAll(async () => { if (root !== "") await rm(root, { recursive: true, force: true }); });

const HEAD = "a".repeat(40);
const TEST_FILE = "apps/cli/src/real.e2e.test.ts";
const TEST_NAME = "real passing chain";

/** Write a STRICT-VALID committed row for one run (real recomputed digest). */
async function writeCommittedRow(
  runId: string,
  opts: {
    capabilityId?: string;
    symbol?: string;
    testedSourceSha?: string;
    testFile?: string;
    testName?: string;
    runStatus?: string;
    digestOverride?: string;
    schemaVersion?: string;
    resultDigestOverride?: string;
  } = {},
): Promise<void> {
  const testFile = opts.testFile ?? TEST_FILE;
  const testName = opts.testName ?? TEST_NAME;
  const runStatus = opts.runStatus ?? "passed";
  const body = {
    schemaVersion: opts.schemaVersion ?? OBSERVATION_EVIDENCE_SCHEMA_VERSION,
    runId,
    capabilityId: opts.capabilityId ?? "cap1",
    symbol: opts.symbol ?? "symbolA",
    entrypoint: "cli" as const,
    testFile,
    testName,
    testedSourceSha: opts.testedSourceSha ?? HEAD,
    runStatus,
    runner: "vitest" as const,
    resultDigest: opts.resultDigestOverride ?? computeObservationResultDigest({ testFile, testName, status: runStatus, runner: "vitest" }),
    invocation: "real benchmark->V3->eval->envelope->startup chain",
  };
  const row = {
    ...body,
    evidenceDigest: opts.digestOverride ?? computeObservationEvidenceDigest(body as never),
  };
  await writeFile(observationEvidencePathForRun(runId), `${JSON.stringify(row)}\n`, "utf8");
}

describe("E4-10 production usage audit", () => {
  it("observed > wired > tested > exported: a symbol reaches observed ONLY with strict per-run evidence", async () => {
    await makeRoot({
      "packages/x/src/index.ts": "export * from './a.js';\nexport function theThing(){}\n",
      "packages/x/src/a.ts": "export function theThing(){}\n",
      "packages/x/src/a.test.ts": "import { theThing } from './a.js'; theThing();\n",
      "apps/cli/src/prod.ts": "import { theThing } from '@ar/x'; theThing();\n",
      "apps/cli/src/real.e2e.test.ts": `import { theThing } from '@ar/x'; theThing();\nit("${TEST_NAME}", () => {});\n`,
    });
    const runId = "run-ok";
    await writeCommittedRow(runId, { capabilityId: "the thing", symbol: "theThing" });
    const r = runUsageAudit({
      root,
      capabilities: [{ capability: "the thing", symbol: "theThing" }],
      runId,
      headSha: HEAD,
    });
    const c = r.capabilities[0]!;
    expect(c.exported).toBe(true);
    expect(c.tested).toBe(true);
    expect(c.wired).toBe(true);
    expect(c.observed).toBe(true);
    expect(c.level).toBe("observed");
    expect(r.ok).toBe(true);
  });

  it("wired but NOT observed is reported honestly (not promoted to observed)", async () => {
    await makeRoot({
      "packages/x/src/index.ts": "export function wiredOnly(){}\n",
      "apps/cli/src/prod.ts": "import { wiredOnly } from '@ar/x'; wiredOnly();\n",
      "packages/x/src/x.test.ts": "import { wiredOnly } from './index.js'; wiredOnly();\n",
    });
    const r = runUsageAudit({ root, capabilities: [{ capability: "wired only", symbol: "wiredOnly" }] });
    const c = r.capabilities[0]!;
    expect(c.wired).toBe(true);
    expect(c.observed).toBe(false);
    expect(c.level).toBe("wired");
    expect(r.ok).toBe(false);
    expect(r.notObserved).toContain("wired only");
  });

  it("exported but never wired is flagged (the exported-only gap)", async () => {
    await makeRoot({
      "packages/x/src/index.ts": "export function exportOnly(){}\n",
    });
    const r = runUsageAudit({ root, capabilities: [{ capability: "export only", symbol: "exportOnly" }] });
    const c = r.capabilities[0]!;
    expect(c.exported).toBe(true);
    expect(c.wired).toBe(false);
    expect(c.observed).toBe(false);
    expect(c.level).toBe("exported");
  });

  it("an absent symbol is reported at every level false", async () => {
    await makeRoot({ "packages/x/src/index.ts": "export function other(){}\n" });
    const r = runUsageAudit({ root, capabilities: [{ capability: "ghost", symbol: "ghostSymbol_zzz" }] });
    const c = r.capabilities[0]!;
    expect(c.exported).toBe(false);
    expect(c.wired).toBe(false);
    expect(c.observed).toBe(false);
    expect(r.notObserved).toContain("ghost");
  });

  it("renders a per-capability line + overall verdict", async () => {
    await makeRoot({ "packages/x/src/index.ts": "export function t(){}\n", "apps/cli/src/e2e.test.ts": "t();\n" });
    const r = runUsageAudit({ root, capabilities: [{ capability: "t", symbol: "t" }] });
    const out = renderUsageAudit(r).join("\n");
    expect(out).toContain("t");
    expect(out).toMatch(/PASS|FAIL/);
  });

  it("KEY_CAPABILITIES lists the seven E4-10 capabilities", () => {
    expect(KEY_CAPABILITIES.map((c) => c.capability)).toEqual([
      "createActivationRecorderV2",
      "classifySecurityOutcomeV2",
      "canonical V3 writer",
      "strict promotion loader",
      "resolveChampionHarness",
      "durable RecoveryStore",
      "GateEvidenceV2 generator",
    ]);
  });

  it("audits the real repository without throwing", () => {
    // process.cwd() is the repo root under vitest.
    const r = runUsageAudit({ root: process.cwd() });
    expect(r.capabilities.length).toBe(KEY_CAPABILITIES.length);
  });
});

describe("E4-R18 strict observation evidence (N15/N16)", () => {
  it("F17: comment/string/import/typeof/file-name can NEVER be observed (no evidence => false)", async () => {
    await makeRoot({
      "apps/cli/src/not-real-e2e.test.ts": [
        "// fictionalCapability is tested here",
        'const s = "fictionalCapability";',
        "import { fictionalCapability } from '@ar/x';",
        "expect(typeof fictionalCapability).toBe('function');",
        "void fictionalCapability;",
      ].join("\n"),
    });
    const r = runUsageAudit({
      root,
      capabilities: [{ capability: "fictionalCapability", symbol: "fictionalCapability" }],
      runId: "no-such-run",
      headSha: HEAD,
    });
    const c = r.capabilities[0]!;
    expect(c.observed).toBe(false);
    expect(c.level).not.toBe("observed");
    expect(r.ok).toBe(false);
    expect(r.notObserved).toContain("fictionalCapability");
  });

  it("N15: a row with a FABRICATED (non-recomputing) digest is never observed", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": `it("${TEST_NAME}", () => {});\n` });
    const runId = "run-bad-digest";
    await writeCommittedRow(runId, { digestOverride: "0".repeat(64) });
    const r = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId, headSha: HEAD });
    expect(r.capabilities[0]!.observed).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("N15: a row with a NULL/unknown testedSourceSha is never observed", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": `it("${TEST_NAME}", () => {});\n` });
    const runId = "run-null-sha";
    // Hand-write a row with a null SHA and a SELF-CONSISTENT digest — the
    // strict reader rejects the unknown SHA before anything else.
    const body = {
      schemaVersion: OBSERVATION_EVIDENCE_SCHEMA_VERSION,
      runId,
      capabilityId: "cap1",
      symbol: "symbolA",
      entrypoint: "cli",
      testFile: TEST_FILE,
      testName: TEST_NAME,
      testedSourceSha: null,
      runStatus: "passed",
      runner: "vitest",
      resultDigest: computeObservationResultDigest({ testFile: TEST_FILE, testName: TEST_NAME, status: "passed", runner: "vitest" }),
      invocation: "real chain",
    };
    const row = { ...body, evidenceDigest: computeObservationEvidenceDigest(body as never) };
    await writeFile(observationEvidencePathForRun(runId), `${JSON.stringify(row)}\n`, "utf8");
    const r = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId, headSha: HEAD });
    expect(r.capabilities[0]!.observed).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("N15: a WRONG symbol row can never satisfy a capability registration", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": `it("${TEST_NAME}", () => {});\n` });
    const runId = "run-wrong-symbol";
    await writeCommittedRow(runId, { symbol: "otherSymbol" });
    const r = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId, headSha: HEAD });
    expect(r.capabilities[0]!.observed).toBe(false);
  });

  it("N15: a row whose testFile does NOT exist under the audited root is never observed", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": `it("${TEST_NAME}", () => {});\n` });
    const runId = "run-fake-test";
    await writeCommittedRow(runId, { testFile: "apps/cli/src/fictional.test.ts" });
    const r = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId, headSha: HEAD });
    expect(r.capabilities[0]!.observed).toBe(false);
  });

  it("N16: a different runId cannot read another run's success (old success never masks a current failure)", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": `it("${TEST_NAME}", () => {});\n` });
    await writeCommittedRow("old-successful-run", {}); // committed PASSED rows exist
    const r = runUsageAudit({
      root,
      capabilities: [{ capability: "cap1", symbol: "symbolA" }],
      runId: "current-failed-run", // this run committed NOTHING
      headSha: HEAD,
    });
    expect(r.capabilities[0]!.observed).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("N16: a test that observes then FAILS leaves no passed proof (the framework final result is failed)", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": `it("${TEST_NAME}", () => {});\n` });
    const runId = "run-then-fail";
    const collector = createObservationRun({
      runId,
      testFile: TEST_FILE,
      testName: TEST_NAME,
      testedSourceSha: HEAD,
      entrypoint: "cli",
    });
    collector.observe({ capabilityId: "cap1", symbol: "symbolA", entrypoint: "cli", invocation: "real chain" });
    // The test's LATER assertion failed — the framework's final result for this
    // test is "failed", so the commit stage publishes NOTHING for it.
    const commit = commitObservationRun(runId, [{ testFile: TEST_FILE, testName: TEST_NAME, status: "failed" }]);
    expect(commit.committedRows).toBe(0);
    expect(commit.droppedCandidates).toBe(1);
    const r = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId, headSha: HEAD });
    expect(r.capabilities[0]!.observed).toBe(false);
    // The committed file exists but is EMPTY — no consumable passed rows.
    expect(await readFile(observationEvidencePathForRun(runId), "utf8")).toBe("");
  });

  it("control: a framework-committed run IS observed with its exact runId", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": `it("${TEST_NAME}", () => {});\n` });
    const runId = "run-committed";
    const collector = createObservationRun({
      runId,
      testFile: TEST_FILE,
      testName: TEST_NAME,
      testedSourceSha: HEAD,
      entrypoint: "cli",
    });
    collector.observe({ capabilityId: "cap1", symbol: "symbolA", entrypoint: "cli", invocation: "real chain" });
    // Before the framework publishes, NO committed file exists (candidates only).
    await expect(readFile(observationEvidencePathForRun(runId))).rejects.toThrow();
    // The framework's final results say the test passed — the commit stage
    // (what the Vitest reporter calls) publishes the rows.
    const commit = commitObservationRun(runId, [{ testFile: TEST_FILE, testName: TEST_NAME, status: "passed" }]);
    expect(commit.committedRows).toBe(1);
    const r = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId, headSha: HEAD });
    const c = r.capabilities[0]!;
    expect(c.observed).toBe(true);
    expect(c.level).toBe("observed");
    expect(r.ok).toBe(true);
  });

  it("a stale-SHA row (valid digest) is never observed at a different HEAD", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": `it("${TEST_NAME}", () => {});\n` });
    const runId = "run-stale";
    await writeCommittedRow(runId, { testedSourceSha: "b".repeat(40) });
    const r = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId, headSha: HEAD });
    expect(r.capabilities[0]!.observed).toBe(false);
  });
});

describe("E4-R24 final-result observation protocol (F03/F04)", () => {
  it("F03: rows copied verbatim from an OLD run file into a NEW run file are NOT observed for the new run", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": `it("${TEST_NAME}", () => {});\n` });
    // A genuinely committed OLD run (all digests recompute over the row body):
    await writeCommittedRow("old-run", {});
    const oldRows = await readFile(observationEvidencePathForRun("old-run"), "utf8");
    expect(oldRows.trim()).not.toBe("");
    // An attacker copies the old rows VERBATIM into the new run's file — the
    // row digests stay valid for the ROW BODY, but the inline runId still says
    // "old-run"; the loader drops the rows for the requested run "new-run".
    await writeFile(observationEvidencePathForRun("new-run"), oldRows, "utf8");
    const rNew = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId: "new-run", headSha: HEAD });
    expect(rNew.capabilities[0]!.observed).toBe(false);
    expect(rNew.ok).toBe(false);
    // Control: the OLD run itself is still observed (the rows are genuine
    // for THEIR OWN run — the copy is rejected, not the original).
    const rOld = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId: "old-run", headSha: HEAD });
    expect(rOld.capabilities[0]!.observed).toBe(true);
  });

  it("F03: a testName not declared in the testFile source is never observed (digests correct or not)", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": `it("${TEST_NAME}", () => {});\n` });
    const runId = "run-ghost-name";
    // The testFile EXISTS and the row's digests recompute — but its testName
    // is declared nowhere in that file.
    await writeCommittedRow(runId, { testName: "a test that was never written" });
    const r = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId, headSha: HEAD });
    expect(r.capabilities[0]!.observed).toBe(false);
  });

  it("F04: candidates with NO matching final outcome are dropped (testFile existing is not proof the test ran)", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": `it("${TEST_NAME}", () => {});\n` });
    const runId = "run-no-outcome";
    const collector = createObservationRun({
      runId, testFile: TEST_FILE, testName: TEST_NAME, testedSourceSha: HEAD, entrypoint: "cli",
    });
    collector.observe({ capabilityId: "cap1", symbol: "symbolA", entrypoint: "cli", invocation: "real chain" });
    // The framework's final results contain NO outcome for this test identity
    // (e.g. the run crashed before finishing it) — nothing is published.
    const commit = commitObservationRun(runId, []);
    expect(commit.committedRows).toBe(0);
    expect(commit.droppedCandidates).toBe(1);
  });

  it("F04: duplicate candidates (retry attempts) dedupe to ONE committed row; same-named mixed outcomes never commit", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": `it("${TEST_NAME}", () => {});\n` });
    const runId = "run-retry";
    const collector = createObservationRun({
      runId, testFile: TEST_FILE, testName: TEST_NAME, testedSourceSha: HEAD, entrypoint: "cli",
    });
    // Two attempts observed the same capability (retry) — identical rows.
    collector.observe({ capabilityId: "cap1", symbol: "symbolA", entrypoint: "cli", invocation: "real chain" });
    collector.observe({ capabilityId: "cap1", symbol: "symbolA", entrypoint: "cli", invocation: "real chain" });
    // Final outcome: the (only) matching test finally passed → one committed row.
    const commit = commitObservationRun(runId, [{ testFile: TEST_FILE, testName: TEST_NAME, status: "passed" }]);
    expect(commit.committedRows).toBe(1);
    expect(commit.droppedCandidates).toBe(0);

    // Same-named tests with MIXED outcomes (one passed, one failed): a
    // candidate for that identity is ambiguous and never committed.
    const runId2 = "run-ambiguous";
    const collector2 = createObservationRun({
      runId: runId2, testFile: TEST_FILE, testName: TEST_NAME, testedSourceSha: HEAD, entrypoint: "cli",
    });
    collector2.observe({ capabilityId: "cap1", symbol: "symbolA", entrypoint: "cli", invocation: "real chain" });
    const commit2 = commitObservationRun(runId2, [
      { testFile: TEST_FILE, testName: TEST_NAME, status: "passed" },
      { testFile: TEST_FILE, testName: TEST_NAME, status: "failed" },
    ]);
    expect(commit2.committedRows).toBe(0);
    expect(commit2.droppedCandidates).toBe(1);
  });

  it("F04: the candidates file is NEVER consumed as evidence (no runStatus/result binding)", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": `it("${TEST_NAME}", () => {});\n` });
    const runId = "run-candidates-only";
    const collector = createObservationRun({
      runId, testFile: TEST_FILE, testName: TEST_NAME, testedSourceSha: HEAD, entrypoint: "cli",
    });
    collector.observe({ capabilityId: "cap1", symbol: "symbolA", entrypoint: "cli", invocation: "real chain" });
    // Candidates exist on disk, but no commit ever ran for this run.
    const candidates = await readFile(observationCandidatesPathForRun(runId), "utf8");
    expect(candidates.trim()).not.toBe("");
    const r = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId, headSha: HEAD });
    expect(r.capabilities[0]!.observed).toBe(false);
  });

  it("F03: runId is a file-name component — traversal-shaped runIds are rejected", () => {
    expect(isSafeObservationRunId("run-1")).toBe(true);
    expect(isSafeObservationRunId("e4-09-1234-1699999999")).toBe(true);
    expect(isSafeObservationRunId("../escape")).toBe(false);
    expect(isSafeObservationRunId("a/b")).toBe(false);
    expect(isSafeObservationRunId("a\\b")).toBe(false);
    expect(isSafeObservationRunId("..")).toBe(false);
    expect(isSafeObservationRunId(".hidden")).toBe(false);
    expect(isSafeObservationRunId("")).toBe(false);
    expect(() => observationEvidencePathForRun("../escape")).toThrow(/unsafe observation runId/);
  });
});

describe("E4-R24 usage-audit CLI argument contract (F03)", () => {
  it("--strict WITHOUT --run fails up front — a strict verdict must name ONE run (no global-history fallback)", async () => {
    const { runCommand } = await import("./commands.js");
    const result = await runCommand(["usage-audit", "--strict"], undefined as never);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("--strict requires --run <runId>");
    expect(result.lines.join("\n")).toContain("DIAGNOSTIC");
  });

  it("unknown arguments are rejected — strict parsing, no silent noise (E4-R24 #3)", async () => {
    const { runCommand } = await import("./commands.js");
    const result = await runCommand(["usage-audit", "--nope"], undefined as never);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain('unknown argument "--nope"');
  });

  it("--run without a value is rejected", async () => {
    const { runCommand } = await import("./commands.js");
    const result = await runCommand(["usage-audit", "--run"], undefined as never);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("--run requires a value");
  });

  it("an unsafe (path-traversal) runId is rejected before any file is touched", async () => {
    const { runCommand } = await import("./commands.js");
    const result = await runCommand(["usage-audit", "--run", "../escape"], undefined as never);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("invalid runId");
  });

  it("--run <id> WITHOUT --strict is an inspection — zero evidence is reported as FAIL but never gates the exit code", async () => {
    const { runCommand } = await import("./commands.js");
    // An empty (never-committed) run never observes anything → every capability
    // FAILs on screen, but inspection (non-strict) never gates the exit code:
    // release-grade gating requires --strict.
    const result = await runCommand(["usage-audit", "--run", "e4-r24-no-such-run-000"], undefined as never);
    expect(result.exitCode).toBe(0);
    const out = result.lines.join("\n");
    expect(out).toContain("single run e4-r24-no-such-run-000 (inspection");
    expect(out).toContain("pass --strict to gate the exit code");
    expect(out).toContain("usage audit: FAIL");
  });

  it("--run <id> --strict returns NON-zero when the named run committed no evidence", async () => {
    const { runCommand } = await import("./commands.js");
    const result = await runCommand(["usage-audit", "--run", "e4-r24-no-such-run-001", "--strict"], undefined as never);
    expect(result.exitCode).toBe(1);
    const out = result.lines.join("\n");
    expect(out).toContain("FAIL");
    expect(out).toContain("usage audit: FAIL");
  });

  it("the dangerous DIAGNOSTIC scan is still available WITHOUT --strict and never claims release-grade status", async () => {
    const { runCommand } = await import("./commands.js");
    const result = await runCommand(["usage-audit"], undefined as never);
    expect(result.exitCode).toBe(0); // diagnostic scans never gate the exit code
    expect(result.lines.join("\n")).toContain("DIAGNOSTIC scan over all committed runs — NOT release-grade");
  });
});
