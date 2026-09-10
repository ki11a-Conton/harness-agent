/**
 * E4-10 + E4-R18 — production usage audit tests.
 *
 * The audit must classify honestly from on-disk evidence and must NOT let a
 * capability claim more reach than the code proves. E4-R18 (N15/N16):
 * `observed` requires STRICT per-run observation evidence — recomputed digest,
 * exact 40-hex SHA match, registered symbol, existing test file, and a
 * SPECIFIC runId (an old successful run can never mask a current failure).
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runUsageAudit, renderUsageAudit, KEY_CAPABILITIES } from "./usage-audit.js";
import {
  computeObservationEvidenceDigest,
  observationEvidencePathForRun,
  OBSERVATION_EVIDENCE_SCHEMA_VERSION,
  createObservationRun,
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

/** Write a STRICT-VALID committed row for one run (real recomputed digest). */
async function writeCommittedRow(
  runId: string,
  opts: {
    capabilityId?: string;
    symbol?: string;
    testedSourceSha?: string;
    testFile?: string;
    runStatus?: string;
    digestOverride?: string;
    schemaVersion?: string;
  } = {},
): Promise<void> {
  const body = {
    schemaVersion: opts.schemaVersion ?? OBSERVATION_EVIDENCE_SCHEMA_VERSION,
    runId,
    capabilityId: opts.capabilityId ?? "cap1",
    symbol: opts.symbol ?? "symbolA",
    entrypoint: "cli" as const,
    testFile: opts.testFile ?? "apps/cli/src/real.e2e.test.ts",
    testName: "real passing chain",
    testedSourceSha: opts.testedSourceSha ?? HEAD,
    runStatus: opts.runStatus ?? "passed",
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
      "apps/cli/src/real.e2e.test.ts": "import { theThing } from '@ar/x'; theThing();\n",
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
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": "// real chain\n" });
    const runId = "run-bad-digest";
    await writeCommittedRow(runId, { digestOverride: "0".repeat(64) });
    const r = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId, headSha: HEAD });
    expect(r.capabilities[0]!.observed).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("N15: a row with a NULL/unknown testedSourceSha is never observed", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": "// real chain\n" });
    const runId = "run-null-sha";
    // Hand-write a row with a null SHA and a SELF-CONSISTENT digest — the
    // strict reader rejects the unknown SHA before anything else.
    const body = {
      schemaVersion: OBSERVATION_EVIDENCE_SCHEMA_VERSION,
      runId,
      capabilityId: "cap1",
      symbol: "symbolA",
      entrypoint: "cli",
      testFile: "apps/cli/src/real.e2e.test.ts",
      testName: "chain",
      testedSourceSha: null,
      runStatus: "passed",
      invocation: "real chain",
    };
    const row = { ...body, evidenceDigest: computeObservationEvidenceDigest(body as never) };
    await writeFile(observationEvidencePathForRun(runId), `${JSON.stringify(row)}\n`, "utf8");
    const r = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId, headSha: HEAD });
    expect(r.capabilities[0]!.observed).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("N15: a WRONG symbol row can never satisfy a capability registration", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": "// real chain\n" });
    const runId = "run-wrong-symbol";
    await writeCommittedRow(runId, { symbol: "otherSymbol" });
    const r = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId, headSha: HEAD });
    expect(r.capabilities[0]!.observed).toBe(false);
  });

  it("N15: a row whose testFile does NOT exist under the audited root is never observed", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": "// real chain\n" });
    const runId = "run-fake-test";
    await writeCommittedRow(runId, { testFile: "apps/cli/src/fictional.test.ts" });
    const r = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId, headSha: HEAD });
    expect(r.capabilities[0]!.observed).toBe(false);
  });

  it("N16: a different runId cannot read another run's success (old success never masks a current failure)", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": "// real chain\n" });
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

  it("N16: a test that observes then FAILS leaves no passed proof (commit never called)", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": "// real chain\n" });
    const runId = "run-then-fail";
    const collector = createObservationRun({
      runId,
      testFile: "apps/cli/src/real.e2e.test.ts",
      testName: "chain",
      testedSourceSha: HEAD,
      entrypoint: "cli",
    });
    collector.observe({ capabilityId: "cap1", symbol: "symbolA", entrypoint: "cli", invocation: "real chain" });
    // The test's LATER assertion would fail here — commit() is never reached.
    const r = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId, headSha: HEAD });
    expect(r.capabilities[0]!.observed).toBe(false);
    // No file was written by the collector.
    await expect(readFile(observationEvidencePathForRun(runId))).rejects.toThrow();
  });

  it("control: a committed collector run IS observed with its exact runId", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": "// real chain\n" });
    const runId = "run-committed";
    const collector = createObservationRun({
      runId,
      testFile: "apps/cli/src/real.e2e.test.ts",
      testName: "chain",
      testedSourceSha: HEAD,
      entrypoint: "cli",
    });
    collector.observe({ capabilityId: "cap1", symbol: "symbolA", entrypoint: "cli", invocation: "real chain" });
    collector.commit(); // test-end hook AFTER all assertions passed
    const r = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId, headSha: HEAD });
    const c = r.capabilities[0]!;
    expect(c.observed).toBe(true);
    expect(c.level).toBe("observed");
    expect(r.ok).toBe(true);
  });

  it("a stale-SHA row (valid digest) is never observed at a different HEAD", async () => {
    await makeRoot({ "apps/cli/src/real.e2e.test.ts": "// real chain\n" });
    const runId = "run-stale";
    await writeCommittedRow(runId, { testedSourceSha: "b".repeat(40) });
    const r = runUsageAudit({ root, capabilities: [{ capability: "cap1", symbol: "symbolA" }], runId, headSha: HEAD });
    expect(r.capabilities[0]!.observed).toBe(false);
  });
});
