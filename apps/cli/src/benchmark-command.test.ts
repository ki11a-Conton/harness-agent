import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedModelProvider } from "@ar/model";
import { assertWorkspaceIsolated, runBenchmarkCommand } from "./benchmark-command.js";

let tempDirs: string[] = [];

async function makeCaseDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-cli-bench-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    if (rel.includes("/")) {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    }
    await writeFile(abs, content, "utf8");
  }
  return dir;
}

const CASE_DIR = "cases";
const OUT_DIR = "out";

describe("agent benchmark (benchmark-command.ts)", () => {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("rejects unknown flags with usage", async () => {
    const result = await runBenchmarkCommand(["--nope"]);
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain("unknown flag");
    expect(result.lines.join("\n")).toContain("usage: agent benchmark");
  });

  it("rejects a non-numeric --budget", async () => {
    const result = await runBenchmarkCommand(["--budget", "lots"]);
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain("--budget must be a positive integer");
  });

  it("rejects an unknown --suite", async () => {
    const result = await runBenchmarkCommand(["--suite", "nightly"]);
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain("--suite must be one of regression|holdout|adversarial|stress");
  });

  it("fails cleanly when the case directory is missing", async () => {
    const result = await runBenchmarkCommand(
      ["--cases", join(tmpdir(), "no-such-cases-dir")],
      new ScriptedModelProvider([]),
    );
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain("failed to load cases");
  });

  it("fails cleanly when the case directory has no cases", async () => {
    const empty = await makeCaseDir({ "cases/.keep": "" });
    const result = await runBenchmarkCommand(
      ["--cases", join(empty, CASE_DIR)],
      new ScriptedModelProvider([]),
    );
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain("no cases found");
  });

  it("runs a case end-to-end with a scripted model (real tools + verification gate)", async () => {
    const root = await makeCaseDir({
      "cases/single/request.md": "The port must be 8080. Update config.js and run test.js.",
      "cases/single/expected.md": "config.js has port 8080; test.js exits 0.",
      "cases/single/case.json": JSON.stringify({
        verification: [{ kind: "command", command: "node test.js" }],
      }),
      "cases/single/fixture/config.js": "module.exports = { port: 3000 };",
      "cases/single/fixture/test.js": [
        'const config = require("./config.js");',
        'if (config.port !== 8080) { console.error("port must be 8080"); process.exit(1); }',
        'console.log("ok");',
      ].join("\n"),
    });

    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("read_file", { path: "config.js" }),
      ScriptedModelProvider.toolCall("edit_file", {
        path: "config.js",
        oldText: "port: 3000",
        newText: "port: 8080",
      }),
      ScriptedModelProvider.toolCall("exec", { command: "node test.js" }),
      ScriptedModelProvider.text("done"),
    ]);

    const result = await runBenchmarkCommand(
      ["--cases", join(root, CASE_DIR), "--out", join(root, OUT_DIR)],
      provider,
    );

    expect(result.exitCode).toBe(0);
    expect(result.lines.some((line) => line.includes("1/1 passed"))).toBe(true);
    expect(result.lines.some((line) => line.includes("PASS single"))).toBe(true);

    const { existsSync } = await import("node:fs");
    const { readFile } = await import("node:fs/promises");
    const jsonPath = join(root, OUT_DIR, "baseline.json");
    const mdPath = join(root, OUT_DIR, "baseline-summary.md");
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(mdPath)).toBe(true);

    const report = JSON.parse(await readFile(jsonPath, "utf8"));
    expect(report.meta.model.providerId).toBe("scripted");
    expect(report.meta.suite).toBe("regression");
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      task_id: "single",
      suite: "regression",
      success: true,
      actual_status: "completed",
      termination_reason: "verified_complete",
      verification_passed: true,
      tool_calls: 3,
    });
    expect(report.summary.success_rate).toBe(1);

    // P0-6: the run manifest records a reproducible run identity.
    expect(report.manifest).toBeDefined();
    // The manifest model id must agree with the one the run actually used
    // (scripted provider is not the stub → DEFAULT_MODEL_ID).
    expect(report.manifest!.model).toBe(report.meta.model.modelId);
    expect(report.manifest!.provider).toBe("scripted");
    expect(report.manifest!.gitSha === null || typeof report.manifest!.gitSha === "string").toBe(true);
    expect(report.manifest!.dirty === null || typeof report.manifest!.dirty === "boolean").toBe(true);
    expect(report.manifest!.temperature).toBeNull();
    expect(report.manifest!.suiteVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.manifest!.judgeVersion).toBe("1.0.0");
    expect(report.manifest!.runtimeConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.manifest!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.manifest!.platform).toBe(process.platform);
    expect(report.manifest!.nodeVersion).toBe(process.version);
  });

  it("supports --shuffle/--seed: randomized execution, fixed report order", async () => {
    const root = await makeCaseDir({
      "cases/a/request.md": "just finish",
      "cases/a/expected.md": "done",
      "cases/b/request.md": "just finish",
      "cases/b/expected.md": "done",
      "cases/c/request.md": "just finish",
      "cases/c/expected.md": "done",
    });

    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.text("done a"),
      ScriptedModelProvider.text("done b"),
      ScriptedModelProvider.text("done c"),
    ]);

    const result = await runBenchmarkCommand(
      ["--cases", join(root, CASE_DIR), "--out", join(root, OUT_DIR), "--shuffle", "--seed", "42"],
      provider,
    );

    expect(result.exitCode).toBe(0);
    const { readFile } = await import("node:fs/promises");
    const report = JSON.parse(await readFile(join(root, OUT_DIR, "baseline.json"), "utf8"));
    // Report order is always the fixed (input) case order, even when the
    // execution order was shuffled.
    expect(report.results.map((r: { task_id: string }) => r.task_id)).toEqual(["a", "b", "c"]);
    expect(report.summary.total).toBe(3);
    expect(report.manifest).toBeDefined();
  });

  it("rejects a non-numeric --seed", async () => {
    const result = await runBenchmarkCommand(["--seed", "lots"]);
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain("--seed must be a non-negative integer");
  });

  it("prevents cross-case contamination: case B cannot read case A's workspace file", async () => {
    const root = await makeCaseDir({
      "cases/a/request.md": "Write top-secret.txt containing SECRET_A_MARKER_42 into the workspace.",
      "cases/a/expected.md": "top-secret.txt exists with the marker.",
      "cases/a/fixture/app.js": "module.exports = { port: 3000 };",
      "cases/b/request.md": "Read top-secret.txt and app.js, then finish.",
      "cases/b/expected.md": "app.js was read; top-secret.txt must NOT exist in this workspace.",
      "cases/b/fixture/app.js": "module.exports = { port: 3000 };",
    });

    // Case A writes the secret into ITS fresh workspace. Case B then tries to
    // read top-secret.txt — that read MUST fail (ENOENT), because every case
    // gets its own fresh workspace + fresh session/store and A's workspace is
    // deleted after its run. Contamination would make B's read succeed; the
    // guard must keep the marker out of B's workspace.
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("write_file", { path: "top-secret.txt", content: "SECRET_A_MARKER_42" }),
      ScriptedModelProvider.text("done a"),
      ScriptedModelProvider.toolCall("read_file", { path: "top-secret.txt" }),
      ScriptedModelProvider.toolCall("read_file", { path: "app.js" }),
      ScriptedModelProvider.text("done b"),
    ]);

    const result = await runBenchmarkCommand(
      ["--cases", join(root, CASE_DIR), "--out", join(root, OUT_DIR)],
      provider,
    );

    expect(result.exitCode).toBe(0);
    const { readFile } = await import("node:fs/promises");
    const report = JSON.parse(await readFile(join(root, OUT_DIR, "baseline.json"), "utf8"));

    const a = report.results.find((r: { task_id: string }) => r.task_id === "a");
    const b = report.results.find((r: { task_id: string }) => r.task_id === "b");
    expect(a).toMatchObject({ task_id: "a", success: true });
    expect(b).toMatchObject({ task_id: "b", success: true });
    // B attempted the contaminated read and it FAILED (fresh workspace): the
    // runtime auto-retried the failing read (read-only tools are retry-safe),
    // so the retry taxonomy shows tool re-executions. A successful read would
    // show zero retries — that is the contamination failure mode this test
    // must catch.
    expect(b.retry_taxonomy.tool).toBeGreaterThanOrEqual(1);
    expect(b.tool_calls).toBeGreaterThanOrEqual(2);
    // A's secret never surfaces in B's result.
    expect(b.reason ?? "").not.toContain("SECRET_A_MARKER_42");
  });

  describe("assertWorkspaceIsolated (P0-6 contamination guard)", () => {
    it("accepts a workspace containing exactly the fixture files", async () => {
      const root = await makeCaseDir({ "ws/app.js": "x", "ws/sub/nested.txt": "y" });
      await expect(assertWorkspaceIsolated(join(root, "ws"), { "app.js": "x", "sub/nested.txt": "y" })).resolves.toBeUndefined();
    });

    it("rejects a stray file left by a previous run", async () => {
      const root = await makeCaseDir({ "ws/app.js": "x", "ws/leaked.json": "{}" });
      await expect(assertWorkspaceIsolated(join(root, "ws"), { "app.js": "x" })).rejects.toThrow(/not fresh.*unexpected: leaked\.json/);
    });

    it("rejects a missing fixture file", async () => {
      const root = await makeCaseDir({ "ws/app.js": "x" });
      await expect(
        assertWorkspaceIsolated(join(root, "ws"), { "app.js": "x", "config.json": "{}" }),
      ).rejects.toThrow(/not fresh.*missing: config\.json/);
    });
  });

  it("runs --suite holdout from benchmarks/holdout and writes holdout.json", async () => {
    const root = await makeCaseDir({
      "holdout/ho1/request.md": "The port must be 8080. Update config.js and run test.js.",
      "holdout/ho1/expected.md": "config.js has port 8080; test.js exits 0.",
      "holdout/ho1/case.json": JSON.stringify({
        verification: [{ kind: "command", command: "node test.js" }],
      }),
      "holdout/ho1/fixture/config.js": "module.exports = { port: 3000 };",
      "holdout/ho1/fixture/test.js": [
        'const config = require("./config.js");',
        'if (config.port !== 8080) { console.error("port must be 8080"); process.exit(1); }',
        'console.log("ok");',
      ].join("\n"),
    });

    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.toolCall("read_file", { path: "config.js" }),
      ScriptedModelProvider.toolCall("edit_file", {
        path: "config.js",
        oldText: "port: 3000",
        newText: "port: 8080",
      }),
      ScriptedModelProvider.toolCall("exec", { command: "node test.js" }),
      ScriptedModelProvider.text("done"),
    ]);

    const result = await runBenchmarkCommand(
      ["--suite", "holdout", "--cases", join(root, "holdout"), "--out", join(root, "out-h")],
      provider,
    );

    expect(result.exitCode).toBe(0);
    const { existsSync } = await import("node:fs");
    const { readFile } = await import("node:fs/promises");
    const jsonPath = join(root, "out-h", "holdout.json");
    const mdPath = join(root, "out-h", "holdout-summary.md");
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(mdPath)).toBe(true);
    expect(existsSync(join(root, "out-h", "baseline.json"))).toBe(false);

    const report = JSON.parse(await readFile(jsonPath, "utf8"));
    expect(report.meta.suite).toBe("holdout");
    expect(report.results[0]).toMatchObject({
      task_id: "ho1",
      suite: "holdout",
      success: true,
    });
    expect(report.summary.recovery_rate).toBe(0);
  });

  it("--suite without --cases defaults to benchmarks/<suite>", async () => {
    const root = await makeCaseDir({
      "benchmarks/stress/s1/request.md": "run test.js",
      "benchmarks/stress/s1/expected.md": "test.js exits 0",
      "benchmarks/stress/s1/case.json": JSON.stringify({
        verification: [{ kind: "command", command: "node test.js" }],
      }),
      "benchmarks/stress/s1/fixture/test.js": 'console.log("ok");',
    });
    const cwd = process.cwd();
    try {
      process.chdir(root);
      const provider = new ScriptedModelProvider([
        ScriptedModelProvider.toolCall("exec", { command: "node test.js" }),
        ScriptedModelProvider.text("done"),
      ]);
      const result = await runBenchmarkCommand(["--suite", "stress", "--out", "out-s"], provider);
      expect(result.exitCode).toBe(0);
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(root, "out-s", "stress.json"))).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it("records a verification failure when the model stops without fixing the task", async () => {
    const root = await makeCaseDir({
      "cases/fc/request.md": "counter.js is broken. Fix it so test.js passes.",
      "cases/fc/expected.md": "test.js exits 0.",
      "cases/fc/case.json": JSON.stringify({
        verification: [{ kind: "command", command: "node test.js" }],
      }),
      "cases/fc/fixture/counter.js": "module.exports = { next: () => 0 };",
      "cases/fc/fixture/test.js": [
        'const c = require("./counter.js");',
        'if (c.next() !== 1) { console.error("must return 1"); process.exit(1); }',
        'console.log("ok");',
      ].join("\n"),
    });

    // The model claims completion WITHOUT touching the workspace: the runtime
    // verification gate must reject it (inject observation, retry up to the
    // budget) and finally fail the turn with VERIFICATION_FAILED.
    const provider = new ScriptedModelProvider([
      ScriptedModelProvider.text("done, all fixed"),
      ScriptedModelProvider.text("done, all fixed"),
      ScriptedModelProvider.text("done, all fixed"),
    ]);

    const result = await runBenchmarkCommand(
      ["--cases", join(root, CASE_DIR), "--out", join(root, OUT_DIR)],
      provider,
    );

    expect(result.exitCode).toBe(0); // the benchmark run itself never fails
    expect(result.lines.some((line) => line.includes("FAIL fc"))).toBe(true);

    const { readFile } = await import("node:fs/promises");
    const report = JSON.parse(await readFile(join(root, OUT_DIR, "baseline.json"), "utf8"));
    expect(report.results[0]).toMatchObject({
      success: false,
      actual_status: "failed",
      termination_reason: "verification_failed",
      verification_passed: false,
      verification_failures: 3, // three rejected attempts before the budget ran out
      false_complete: false, // the gate caught it → not a false completion
    });
  });
});
