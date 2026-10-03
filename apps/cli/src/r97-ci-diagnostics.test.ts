import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/e4/r97-ci-diagnostics.mjs", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runDiagnostic(log: string) {
  const root = await mkdtemp(join(tmpdir(), "r97-public-diagnostic-"));
  roots.push(root);
  const logPath = join(root, "test-report.log");
  const summaryPath = join(root, "summary.md");
  await writeFile(logPath, log, "utf8");
  const child = spawnSync(process.execPath, [SCRIPT, "--label", "verify", "--log", logPath], {
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    child,
    summary: await readFile(summaryPath, "utf8"),
    annotations: child.stdout.split(/\r?\n/).filter((line) => line.startsWith("::error::")),
  };
}

describe("N3 public CI diagnostics (real Node process)", () => {
  it("keeps the sanitized S2 runtime reason visible despite expected-error noise and the ordinary line cap", async () => {
    const reason = `${"safe diagnostic detail ".repeat(20)}ROOT_CAUSE_VISIBLE`;
    const marker = `Error: S2_RUNTIME_ERROR_JSON=${JSON.stringify({ reason, failureCategory: "harness", terminationReason: "error" })}`;
    const noise = Array.from({ length: 140 }, (_, index) => `[degraded] fixture ${index}: Error: expected refusal`);
    const result = await runDiagnostic([...noise, marker, " FAIL  S2 challenger > failed fixture", " Test Files  1 failed (1)"].join("\n"));
    expect(result.child.status).toBe(0);
    expect(result.annotations).toHaveLength(8);
    expect(result.annotations[0]).toContain(marker);
    expect(result.annotations[0]).toContain("ROOT_CAUSE_VISIBLE");
    expect(result.summary).toContain(marker);
    expect(result.annotations[1]).toContain("FAIL  S2 challenger");
    expect(result.annotations.slice(1).every((line) => line.length - "::error::".length <= 240)).toBe(true);
  });

  it("publishes named failures and assertion traces before historical expected-error lines", async () => {
    const noise = Array.from({ length: 20 }, (_, index) => `[degraded] ${index}: Error: expected fixture failure`);
    const result = await runDiagnostic([...noise, " FAIL  path-scoped.test.ts > denied target", "AssertionError: expected 'error' to be 'completed'", " Tests  1 failed (1)"].join("\n"));
    expect(result.child.status).toBe(0);
    expect(result.annotations[0]).toContain("FAIL  path-scoped.test.ts");
    expect(result.annotations[1]).toContain("AssertionError:");
    expect(result.annotations).toHaveLength(8);
  });

  it("caps the dedicated marker and still escapes workflow commands in ordinary messages", async () => {
    const marker = `Error: S2_RUNTIME_ERROR_JSON=${JSON.stringify({ reason: "sanitized ".repeat(400) })}`;
    const result = await runDiagnostic(`${marker}\nAssertionError: 100% of ${"expected ".repeat(80)}`);
    expect(result.child.status).toBe(0);
    expect(result.annotations[0]).toContain("S2_RUNTIME_ERROR_JSON=");
    expect(result.annotations[0]!.length - "::error::".length).toBe(2000);
    expect(result.annotations[1]).toContain("100%25");
    expect(result.annotations[1]!.length - "::error::".length).toBe(240);
  });

  it("keeps an ordinary line that merely quotes the marker under the existing short cap", async () => {
    const result = await runDiagnostic(`AssertionError: expected example S2_RUNTIME_ERROR_JSON=${"ordinary output ".repeat(100)}`);
    expect(result.child.status).toBe(0);
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations[0]!.length - "::error::".length).toBe(240);
  });

  it("reports a missing log without replacing the original job failure with a diagnostic failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "r97-missing-log-"));
    roots.push(root);
    const summaryPath = join(root, "summary.md");
    const child = spawnSync(process.execPath, [SCRIPT, "--log", join(root, "absent.log")], {
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath }, encoding: "utf8", timeout: 10_000,
    });
    expect(child.status).toBe(0);
    expect(child.stdout).not.toContain("::error::");
    expect(await readFile(summaryPath, "utf8")).toContain("the failing step did not write one");
  });

  it("keeps malformed structured reports diagnostic-only with exit zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "r97-invalid-report-"));
    roots.push(root);
    await writeFile(join(root, "closed-loop-run.json"), "not-json", "utf8");
    const summaryPath = join(root, "summary.md");
    const child = spawnSync(process.execPath, [SCRIPT, "--out", root], {
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath }, encoding: "utf8", timeout: 10_000,
    });
    expect(child.status).toBe(0);
    expect(await readFile(summaryPath, "utf8")).toContain("N3 diagnostics failed to run");
  });
});
