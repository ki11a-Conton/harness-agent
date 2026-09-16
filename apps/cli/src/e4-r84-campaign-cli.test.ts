/**
 * E4-R84 (F84-1) — CLI wiring for `agent benchmark campaign validate`.
 *
 * The validator itself is unit-tested in
 * `packages/evaluation/src/campaign-validate.test.ts`. THIS file tests the CLI
 * contract a user actually types: subcommand dispatch, flag parsing, exit
 * codes, and the two properties that must never regress —
 *
 *   1. it makes ZERO provider calls (no provider is ever constructed), and
 *   2. it FAILS CLOSED (exit non-zero) on a campaign that is not evidence.
 *
 * Everything runs against the committed synthetic fixture, so the suite is
 * hermetic: no network, no key, no real campaign, no absolute paths.
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBenchmarkCommand } from "./benchmark-command.js";

const FIXTURE = join("scripts", "benchmark", "fixtures", "r84-campaign");
const FIXTURE_CAMPAIGN = join(FIXTURE, "campaign");
const FIXTURE_CASES = join(FIXTURE, "cases");
const SUITES = "adversarial,stress";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "e4-r84-cli-"));
  tempDirs.push(dir);
  return dir;
}

/** A throwaway copy of the fixture campaign, safe to mutate. */
async function copyFixture(): Promise<string> {
  const dir = await tempDir();
  const target = join(dir, "campaign");
  await cp(FIXTURE_CAMPAIGN, target, { recursive: true });
  return target;
}

function out(lines: string[]): string {
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe("E4-R84 CLI — dispatch and usage", () => {
  it("`benchmark campaign` with no subcommand is a usage error", async () => {
    const res = await runBenchmarkCommand(["campaign"], undefined);
    expect(res.exitCode).toBe(1);
    expect(out(res.lines)).toContain("benchmark campaign validate");
  });

  it("`benchmark campaign --help` exits 0 and documents every flag", async () => {
    const res = await runBenchmarkCommand(["campaign", "--help"], undefined);
    expect(res.exitCode).toBe(0);
    const text = out(res.lines);
    for (const flag of ["--json", "--cases", "--suites", "--summary", "--emit-evidence", "--evidence", "--expect-digest", "--expect"]) {
      expect(text).toContain(flag);
    }
    // The fail-closed contract is stated where a user will read it.
    expect(text).toContain("Fails closed");
  });

  it("an unknown campaign subcommand is rejected and does not run anything", async () => {
    const res = await runBenchmarkCommand(["campaign", "triage", FIXTURE_CAMPAIGN], undefined);
    expect(res.exitCode).toBe(1);
    expect(out(res.lines)).toContain('unknown subcommand "triage"');
  });

  it("`campaign validate` without a campaign root is a usage error", async () => {
    const res = await runBenchmarkCommand(["campaign", "validate"], undefined);
    expect(res.exitCode).toBe(1);
    expect(out(res.lines)).toContain("Usage: agent benchmark campaign validate");
  });

  it("`benchmark campaign` does not swallow a normal benchmark run", async () => {
    // The dispatch is on argv[0] only; an ordinary flag run still reaches the
    // regular parser (which reports the missing provider here).
    const res = await runBenchmarkCommand(["--suite", "regression", "--dry-run"], undefined);
    expect(out(res.lines)).not.toContain("benchmark campaign validate");
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("E4-R84 CLI — a valid campaign", () => {
  it("exits 0 and separates PROCESS success from CASE success", async () => {
    const res = await runBenchmarkCommand(
      ["campaign", "validate", FIXTURE_CAMPAIGN, "--cases", FIXTURE_CASES, "--suites", SUITES],
      undefined,
    );
    expect(res.exitCode).toBe(0);
    const text = out(res.lines);
    expect(text).toContain("VALID");
    // The two statistics are labelled separately and never merged.
    expect(text).toContain("process execution:");
    expect(text).toContain("case outcome:");
    expect(text).toMatch(/stored cases \(runner exit 0 \+ report on disk\):\s+3/);
    expect(text).toMatch(/passed \(harness verified completion\):\s+1/);
    expect(text).toMatch(/failed:\s+2/);
    expect(text).toMatch(/model calls:\s+20/);
    expect(text).toMatch(/tokens \(in\/out\):\s+650 \/ 120/);
    expect(text).toContain("expected cases (versioned source): 3");
  });

  it("--json emits a parseable result with the same numbers", async () => {
    const res = await runBenchmarkCommand(
      ["campaign", "validate", FIXTURE_CAMPAIGN, "--cases", FIXTURE_CASES, "--suites", SUITES, "--json"],
      undefined,
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(out(res.lines)) as {
      ok: boolean;
      reasonCodes: string[];
      rootDigest: string;
      summary: { storedCases: number; passed: number; processRunSuccesses: number; processRunFailures: number };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.reasonCodes).toEqual([]);
    expect(parsed.rootDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.summary.storedCases).toBe(3);
    expect(parsed.summary.passed).toBe(1);
    // Process success and case success are BOTH present and DIFFERENT.
    expect(parsed.summary.processRunSuccesses).toBe(3);
    expect(parsed.summary.processRunFailures).toBe(0);
  });

  it("--expect restricts the accepted source SHAs and rejects an undeclared one", async () => {
    const ok = await runBenchmarkCommand(
      ["campaign", "validate", FIXTURE_CAMPAIGN, "--cases", FIXTURE_CASES, "--suites", SUITES, "--expect", "aaaa1111,bbbb2222"],
      undefined,
    );
    expect(ok.exitCode).toBe(0);

    const bad = await runBenchmarkCommand(
      ["campaign", "validate", FIXTURE_CAMPAIGN, "--cases", FIXTURE_CASES, "--suites", SUITES, "--expect", "aaaa1111"],
      undefined,
    );
    expect(bad.exitCode).toBe(1);
    expect(out(bad.lines)).toContain("CAMPAIGN_SOURCE_SHA_DRIFT");
  });
});

// ---------------------------------------------------------------------------
// Fail-closed
// ---------------------------------------------------------------------------

describe("E4-R84 CLI — fail-closed", () => {
  it("a missing campaign root is non-zero", async () => {
    const dir = await tempDir();
    const res = await runBenchmarkCommand(
      ["campaign", "validate", join(dir, "nope"), "--cases", FIXTURE_CASES, "--suites", SUITES],
      undefined,
    );
    expect(res.exitCode).toBe(1);
    expect(out(res.lines)).toContain("CAMPAIGN_ROOT_MISSING");
  });

  it("a summary-only tree (no raw reports) is non-zero", async () => {
    const dir = await tempDir();
    const root = join(dir, "summary-only");
    await mkdir(root, { recursive: true });
    await cp(join(FIXTURE_CAMPAIGN, "campaign-summary.json"), join(root, "campaign-summary.json"));
    await writeFile(join(root, "manifest.jsonl"), "", "utf8");
    const res = await runBenchmarkCommand(
      ["campaign", "validate", root, "--cases", FIXTURE_CASES, "--suites", SUITES],
      undefined,
    );
    expect(res.exitCode).toBe(1);
    expect(out(res.lines)).toContain("CAMPAIGN_NO_CASE_ARTIFACTS");
  });

  it("--suites with no suite names is a usage error", async () => {
    const res = await runBenchmarkCommand(
      ["campaign", "validate", FIXTURE_CAMPAIGN, "--cases", FIXTURE_CASES, "--suites", ","],
      undefined,
    );
    expect(res.exitCode).toBe(1);
    expect(out(res.lines)).toContain("--suites requires at least one suite name");
  });

  it("--evidence with a non-existent file is a usage error, not a silent pass", async () => {
    const dir = await tempDir();
    const res = await runBenchmarkCommand(
      ["campaign", "validate", FIXTURE_CAMPAIGN, "--cases", FIXTURE_CASES, "--suites", SUITES, "--evidence", join(dir, "missing.json")],
      undefined,
    );
    expect(res.exitCode).toBe(1);
    expect(out(res.lines)).toContain("cannot read --evidence");
  });

  it("--evidence with malformed JSON is a usage error", async () => {
    const dir = await tempDir();
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{ not json", "utf8");
    const res = await runBenchmarkCommand(
      ["campaign", "validate", FIXTURE_CAMPAIGN, "--cases", FIXTURE_CASES, "--suites", SUITES, "--evidence", bad],
      undefined,
    );
    expect(res.exitCode).toBe(1);
    expect(out(res.lines)).toContain("is not valid JSON");
  });

  it("--evidence that is valid JSON but not an evidence manifest is rejected", async () => {
    const dir = await tempDir();
    const wrong = join(dir, "wrong.json");
    await writeFile(wrong, JSON.stringify({ hello: "world" }), "utf8");
    const res = await runBenchmarkCommand(
      ["campaign", "validate", FIXTURE_CAMPAIGN, "--cases", FIXTURE_CASES, "--suites", SUITES, "--evidence", wrong],
      undefined,
    );
    expect(res.exitCode).toBe(1);
    expect(out(res.lines)).toContain("missing rootDigest/artifactHashes");
  });

  it("--expect-digest and --evidence that disagree are rejected", async () => {
    const dir = await tempDir();
    const ev = join(dir, "evidence.json");
    await runBenchmarkCommand(
      ["campaign", "validate", FIXTURE_CAMPAIGN, "--cases", FIXTURE_CASES, "--suites", SUITES, "--emit-evidence", ev],
      undefined,
    );
    const res = await runBenchmarkCommand(
      ["campaign", "validate", FIXTURE_CAMPAIGN, "--cases", FIXTURE_CASES, "--suites", SUITES,
        "--evidence", ev, "--expect-digest", "0".repeat(64)],
      undefined,
    );
    expect(res.exitCode).toBe(1);
    expect(out(res.lines)).toContain("disagree on the root digest");
  });

  it("a case with no stored report is non-zero and named", async () => {
    const root = await copyFixture();
    await rm(join(root, "results", "stress", "syn-str-1"), { recursive: true, force: true });
    const res = await runBenchmarkCommand(
      ["campaign", "validate", root, "--cases", FIXTURE_CASES, "--suites", SUITES],
      undefined,
    );
    expect(res.exitCode).toBe(1);
    const text = out(res.lines);
    expect(text).toContain("CAMPAIGN_MISSING_CASE");
    expect(text).toContain("stress/syn-str-1");
  });

  it("a changed byte is non-zero once the recorded evidence is supplied", async () => {
    const dir = await tempDir();
    const ev = join(dir, "evidence.json");
    const emit = await runBenchmarkCommand(
      ["campaign", "validate", FIXTURE_CAMPAIGN, "--cases", FIXTURE_CASES, "--suites", SUITES, "--emit-evidence", ev],
      undefined,
    );
    expect(emit.exitCode).toBe(0);

    // `duration_ms` is deliberately chosen: the submitted summary does NOT
    // aggregate it, so this is a change ONLY the artifact hash can catch. That
    // isolates exactly what --evidence adds.
    const root = await copyFixture();
    const reportPath = join(root, "results", "stress", "syn-str-1", "stress.json");
    const text = await readFile(reportPath, "utf8");
    expect(text).toContain('"duration_ms": 1234');
    await writeFile(reportPath, text.replace('"duration_ms": 1234', '"duration_ms": 9999'), "utf8");

    // Without --evidence: still VALID. The digest moved (tamper-EVIDENT), but
    // nothing recorded the original, so there is nothing to compare against.
    const withoutEvidence = await runBenchmarkCommand(
      ["campaign", "validate", root, "--cases", FIXTURE_CASES, "--suites", SUITES],
      undefined,
    );
    expect(withoutEvidence.exitCode).toBe(0);
    expect(out(withoutEvidence.lines)).toContain("VALID");

    // With --evidence: the same byte change FAILS and the file is named.
    const withEvidence = await runBenchmarkCommand(
      ["campaign", "validate", root, "--cases", FIXTURE_CASES, "--suites", SUITES, "--evidence", ev],
      undefined,
    );
    expect(withEvidence.exitCode).toBe(1);
    const outText = out(withEvidence.lines);
    expect(outText).toContain("CAMPAIGN_ARTIFACT_HASH_MISMATCH");
    expect(outText).toContain("syn-str-1/stress.json");
    // The finding must not echo the file's contents.
    expect(outText).not.toContain("duration_ms");
  });
});

// ---------------------------------------------------------------------------
// Evidence emission
// ---------------------------------------------------------------------------

describe("E4-R84 CLI — evidence emission", () => {
  it("--emit-evidence writes a manifest that leaks nothing and re-validates", async () => {
    const dir = await tempDir();
    const ev = join(dir, "evidence.json");
    const res = await runBenchmarkCommand(
      ["campaign", "validate", FIXTURE_CAMPAIGN, "--cases", FIXTURE_CASES, "--suites", SUITES, "--emit-evidence", ev],
      undefined,
    );
    expect(res.exitCode).toBe(0);
    expect(out(res.lines)).toContain("evidence manifest written to");

    const raw = await readFile(ev, "utf8");
    // No absolute path, no user dir, no endpoint, no key.
    expect(raw).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(raw).not.toMatch(/Users|AppData|\/home\//);
    expect(raw).not.toMatch(/https?:\/\//);
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    expect(raw).not.toMatch(/\b[0-9a-f]{40}\b/);

    const parsed = JSON.parse(raw) as {
      schemaVersion: number;
      kind: string;
      rootDigest: string;
      artifactHashes: unknown[];
      cases: unknown[];
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.kind).toBe("campaign-evidence");
    expect(parsed.artifactHashes.length).toBeGreaterThan(0);
    expect(parsed.cases).toHaveLength(3);

    // Round-trip: the emitted manifest validates its own campaign.
    const recheck = await runBenchmarkCommand(
      ["campaign", "validate", FIXTURE_CAMPAIGN, "--cases", FIXTURE_CASES, "--suites", SUITES, "--evidence", ev],
      undefined,
    );
    expect(recheck.exitCode).toBe(0);
  });

  it("--emit-evidence is REFUSED for a campaign that does not validate", async () => {
    const dir = await tempDir();
    const ev = join(dir, "evidence.json");
    const root = await copyFixture();
    await rm(join(root, "results", "stress", "syn-str-1"), { recursive: true, force: true });
    const res = await runBenchmarkCommand(
      ["campaign", "validate", root, "--cases", FIXTURE_CASES, "--suites", SUITES, "--emit-evidence", ev],
      undefined,
    );
    expect(res.exitCode).toBe(1);
    expect(out(res.lines)).toContain("CAMPAIGN_MISSING_CASE");
    // Nothing was written: an invalid campaign cannot produce evidence.
    await expect(readFile(ev, "utf8")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The zero-provider-call property
// ---------------------------------------------------------------------------

describe("E4-R84 CLI — zero provider calls", () => {
  it("runs with NO provider argument and still works (it never needs one)", async () => {
    // Every call in this file passes `undefined` as the provider. If the
    // command ever constructed or required a provider, the happy-path tests
    // above would fail rather than pass. This test states the invariant
    // explicitly so a future change cannot quietly introduce a provider.
    const res = await runBenchmarkCommand(
      ["campaign", "validate", FIXTURE_CAMPAIGN, "--cases", FIXTURE_CASES, "--suites", SUITES, "--json"],
      undefined,
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(out(res.lines)) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it("does not require or read an API key from the environment", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const res = await runBenchmarkCommand(
        ["campaign", "validate", FIXTURE_CAMPAIGN, "--cases", FIXTURE_CASES, "--suites", SUITES],
        undefined,
      );
      expect(res.exitCode).toBe(0);
      expect(out(res.lines)).not.toContain("OPENAI_API_KEY");
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});
