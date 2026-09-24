/**
 * E4-R85 — CLI wiring for `agent benchmark campaign triage`.
 *
 * The triage engine is unit-tested in
 * `packages/evaluation/src/campaign-triage.test.ts`. THIS file tests the
 * contract a user actually types: subcommand dispatch, the REQUIRED `--out`
 * flag, exit codes, and the properties that must never regress —
 *
 *   1. it makes ZERO provider calls (no provider is ever constructed, no key
 *      is read), and
 *   2. its two output artifacts are deterministic and leak nothing sensitive.
 *
 * Everything runs against the committed synthetic fixture, so the suite is
 * hermetic: no network, no key, no real campaign, no absolute paths.
 */

import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
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
  const dir = await mkdtemp(join(tmpdir(), "e4-r85-cli-"));
  tempDirs.push(dir);
  return dir;
}

function out(lines: string[]): string {
  return lines.join("\n");
}

/** Run triage against the fixture, writing into a fresh temp dir. */
async function runTriage(extra: string[] = []): Promise<{ exitCode: number; lines: string[]; dir: string }> {
  const dir = await tempDir();
  const res = await runBenchmarkCommand(
    ["campaign", "triage", FIXTURE_CAMPAIGN, "--out", dir, "--cases", FIXTURE_CASES, "--suites", SUITES, ...extra],
    undefined,
  );
  return { ...res, dir };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe("E4-R85 CLI — dispatch and usage", () => {
  it("`benchmark campaign --help` documents the triage subcommand and its flags", async () => {
    const res = await runBenchmarkCommand(["campaign", "--help"], undefined);
    expect(res.exitCode).toBe(0);
    const text = out(res.lines);
    expect(text).toContain("campaign triage");
    expect(text).toContain("--out");
    expect(text).toContain("--restricted");
    // The holdout discipline is stated where a user will read it.
    expect(text).toContain("holdout");
  });

  it("`campaign triage --help` exits 0 and names the taxonomy", async () => {
    const res = await runBenchmarkCommand(["campaign", "triage", "--help"], undefined);
    expect(res.exitCode).toBe(0);
    const text = out(res.lines);
    for (const cls of [
      "MODEL_BEHAVIOR", "TOOL_PROTOCOL", "VERIFIER_OR_ORACLE", "HARNESS_CONTROL_FLOW",
      "BUDGET_EXHAUSTION_UNATTRIBUTED", "PROVIDER_OR_TRANSPORT", "SECURITY_POLICY_DENIAL",
      "INSUFFICIENT_EVIDENCE",
    ]) {
      expect(text).toContain(cls);
    }
    expect(text).toContain("0 provider calls");
  });

  it("`campaign triage` without a campaign root is a usage error", async () => {
    const res = await runBenchmarkCommand(["campaign", "triage"], undefined);
    expect(res.exitCode).toBe(1);
    expect(out(res.lines)).toContain("Usage: agent benchmark campaign triage");
  });

  it("`campaign triage` without --out is a usage error (output must be explicit)", async () => {
    const res = await runBenchmarkCommand(["campaign", "triage", FIXTURE_CAMPAIGN], undefined);
    expect(res.exitCode).toBe(1);
    expect(out(res.lines)).toContain("--out");
  });

  it("still rejects a genuinely unknown subcommand", async () => {
    const res = await runBenchmarkCommand(["campaign", "definitely-not-a-subcommand"], undefined);
    expect(res.exitCode).toBe(1);
    expect(out(res.lines)).toContain('unknown subcommand "definitely-not-a-subcommand"');
  });

  it("does not swallow a normal benchmark run", async () => {
    const res = await runBenchmarkCommand(["--suite", "regression", "--dry-run"], undefined);
    expect(out(res.lines)).not.toContain("unknown subcommand");
  });
});

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

describe("E4-R85 CLI — triage artifacts", () => {
  it("writes both artifacts and exits 0 for a valid campaign", async () => {
    const { exitCode, lines, dir } = await runTriage();
    expect(exitCode).toBe(0);
    const json = await readFile(join(dir, "campaign-triage.json"), "utf8");
    const md = await readFile(join(dir, "campaign-triage.md"), "utf8");
    const parsed = JSON.parse(json) as { kind: string; verdict: string; campaignValid: boolean };
    expect(parsed.kind).toBe("campaign-triage");
    expect(parsed.campaignValid).toBe(true);
    expect(parsed.verdict).toMatch(/CONFIRMED_HARNESS_DEFECT|NO_CONFIRMED_HARNESS_DEFECT/);
    expect(md).toContain("# Campaign triage");
    expect(out(lines)).toContain("triage digest");
  });

  it("--json emits the same bytes it wrote to disk", async () => {
    const { lines, dir } = await runTriage(["--json"]);
    const onDisk = await readFile(join(dir, "campaign-triage.json"), "utf8");
    expect(`${out(lines).trimEnd()}\n`).toBe(onDisk);
  });

  it("is byte-identical across two runs (no clock/ordering drift)", async () => {
    const a = await runTriage();
    const b = await runTriage();
    expect(await readFile(join(b.dir, "campaign-triage.json"), "utf8"))
      .toBe(await readFile(join(a.dir, "campaign-triage.json"), "utf8"));
    expect(await readFile(join(b.dir, "campaign-triage.md"), "utf8"))
      .toBe(await readFile(join(a.dir, "campaign-triage.md"), "utf8"));
  });

  it("produces the same digest from a RELOCATED copy of the campaign", async () => {
    const dir = await tempDir();
    const copy = join(dir, "relocated");
    await cp(FIXTURE_CAMPAIGN, copy, { recursive: true });
    const res = await runBenchmarkCommand(
      ["campaign", "triage", copy, "--out", dir, "--cases", FIXTURE_CASES, "--suites", SUITES, "--json"],
      undefined,
    );
    const relocated = JSON.parse(out(res.lines)) as { triageDigest: string };
    const original = await runTriage(["--json"]);
    const baseline = JSON.parse(out(original.lines)) as { triageDigest: string };
    expect(relocated.triageDigest).toBe(baseline.triageDigest);
  });

  it("never leaks an absolute path, endpoint, key or Authorization header", async () => {
    const { dir } = await runTriage();
    for (const name of ["campaign-triage.json", "campaign-triage.md"]) {
      const text = await readFile(join(dir, name), "utf8");
      expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
      expect(text).not.toMatch(/Users|AppData|\/home\//);
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
      expect(text).not.toMatch(/Bearer\s+\S{16,}/);
      expect(text).not.toMatch(/Authorization\s*[:=]/);
      // No timestamp of any kind.
      expect(text).not.toMatch(/\b20\d\d-\d\d-\d\dT/);
    }
  });

  it("does not require or read an API key from the environment", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const { exitCode, lines, dir } = await runTriage();
      expect(exitCode).toBe(0);
      expect(out(lines)).not.toContain("OPENAI_API_KEY");
      const text = await readFile(join(dir, "campaign-triage.json"), "utf8");
      expect(text).not.toContain("OPENAI_API_KEY");
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });

  it("a campaign that does not validate is triaged but exits non-zero", async () => {
    const dir = await tempDir();
    const missing = join(dir, "does-not-exist");
    const res = await runBenchmarkCommand(
      ["campaign", "triage", missing, "--out", dir, "--cases", FIXTURE_CASES, "--suites", SUITES],
      undefined,
    );
    // Attribution over unverified numbers must not look like success.
    expect(res.exitCode).toBe(1);
    expect(out(res.lines)).toContain("campaign valid:      NO");
    // ...but the artifacts are still written, so the failure is inspectable.
    const parsed = JSON.parse(await readFile(join(dir, "campaign-triage.json"), "utf8")) as { campaignValid: boolean };
    expect(parsed.campaignValid).toBe(false);
  });

  it("--restricted moves a suite to aggregate-only", async () => {
    const { lines, dir } = await runTriage(["--restricted", "stress", "--json"]);
    const parsed = JSON.parse(out(lines)) as {
      cases: Array<{ suite: string }>;
      holdout: { cases: number };
      totals: { attributed: number };
    };
    // `stress` is now aggregate-only, exactly like holdout by default.
    expect(parsed.cases.some((c) => c.suite === "stress")).toBe(false);
    expect(parsed.totals.attributed).toBe(2);
    expect(parsed.holdout.cases).toBe(1);
    const text = await readFile(join(dir, "campaign-triage.json"), "utf8");
    expect(text).not.toContain("syn-str-1");
  });
});
