import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeWorkspace, type AuditInput } from "./audit.js";

/**
 * P38.2-5/10/11 — `.ci/evidence` is namespaced (gates/<os>/, capabilities/,
 * benchmarks/) and `probeWorkspace` must ingest it RECURSIVELY, keying by the
 * explicit field (never the file name), and synthesize `capability:<id>`
 * test_run evidence ONLY from a passing `test` gate at the exact audited HEAD
 * + the reviewed CAPABILITY_TEST_MANIFEST (INV-P38.2-005/011). A gate evidence
 * file can never satisfy a capability claim and vice versa.
 */

const CLEANUP: string[] = [];
afterEach(async () => {
  while (CLEANUP.length > 0) {
    const dir = CLEANUP.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-evidence-"));
  CLEANUP.push(dir);
  return dir;
}

/** Create the probe files for `core_loop_integration` on disk. */
async function createContextProbeFiles(root: string): Promise<void> {
  await mkdir(join(root, "packages", "context", "src"), { recursive: true });
  await writeFile(join(root, "packages", "context", "src", "pipeline.test.ts"), "// probe");
}

describe("P38.2-5/10/11 recursive evidence probe", () => {
  it("finds gate evidence under gates/<os>/ and keys it gate:<id>", async () => {
    const root = await tmpRoot();
    await mkdir(join(root, ".ci", "evidence", "gates", "linux"), { recursive: true });
    await writeFile(
      join(root, ".ci", "evidence", "gates", "linux", "test.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "gate",
        gate: "test",
        headSha: "git-abc",
        command: "pnpm test",
        exitCode: 0,
        passed: true,
        platform: "linux",
        generatedAt: "2026-01-01T00:00:00Z",
      }),
    );
    const probe = await probeWorkspace({ root, gitSha: async () => "git-abc" });
    const evidence = probe.executionEvidence!;
    expect(evidence["gate:test"]).toBeDefined();
    expect(evidence["gate:test"]!.passed).toBe(true);
    expect(evidence["gate:test"]!.headSha).toBe("git-abc");
    // A gate file must never collide with a capability key.
    expect(evidence["capability:test"]).toBeUndefined();
    expect(evidence["test"]).toBeUndefined();
  });

  it("synthesizes capability:test_run from a passing test gate + manifest", async () => {
    const root = await tmpRoot();
    await mkdir(join(root, ".ci", "evidence", "gates", "linux"), { recursive: true });
    await writeFile(
      join(root, ".ci", "evidence", "gates", "linux", "test.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "gate",
        gate: "test",
        headSha: "git-abc",
        command: "pnpm test",
        exitCode: 0,
        passed: true,
        platform: "linux",
        generatedAt: "2026-01-01T00:00:00Z",
      }),
    );
    await createContextProbeFiles(root);
    const probe = await probeWorkspace({ root, gitSha: async () => "git-abc" });
    const evidence = probe.executionEvidence!;
    const cap = evidence["capability:context_pipeline"];
    expect(cap).toBeDefined();
    expect(cap!.kind).toBe("test_run");
    expect(cap!.passed).toBe(true);
    expect(cap!.headSha).toBe("git-abc");
    expect(cap!.artifactRef).toBe("gate:test");
  });

  it("does NOT synthesize when the test gate is stale vs the audited HEAD", async () => {
    const root = await tmpRoot();
    await mkdir(join(root, ".ci", "evidence", "gates", "linux"), { recursive: true });
    await writeFile(
      join(root, ".ci", "evidence", "gates", "linux", "test.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "gate",
        gate: "test",
        headSha: "git-OLD",
        command: "pnpm test",
        exitCode: 0,
        passed: true,
        platform: "linux",
        generatedAt: "2026-01-01T00:00:00Z",
      }),
    );
    await createContextProbeFiles(root);
    const probe = await probeWorkspace({ root, gitSha: async () => "git-abc" });
    expect(probe.executionEvidence!["capability:context_pipeline"]).toBeUndefined();
  });

  it("does NOT synthesize when the test gate FAILED", async () => {
    const root = await tmpRoot();
    await mkdir(join(root, ".ci", "evidence", "gates", "linux"), { recursive: true });
    await writeFile(
      join(root, ".ci", "evidence", "gates", "linux", "test.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "gate",
        gate: "test",
        headSha: "git-abc",
        command: "pnpm test",
        exitCode: 1,
        passed: false,
        platform: "linux",
        generatedAt: "2026-01-01T00:00:00Z",
      }),
    );
    await createContextProbeFiles(root);
    const probe = await probeWorkspace({ root, gitSha: async () => "git-abc" });
    expect(probe.executionEvidence!["capability:context_pipeline"]).toBeUndefined();
  });

  it("explicit capability evidence file wins over synthesis", async () => {
    const root = await tmpRoot();
    await mkdir(join(root, ".ci", "evidence", "gates", "linux"), { recursive: true });
    await writeFile(
      join(root, ".ci", "evidence", "gates", "linux", "test.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "gate",
        gate: "test",
        headSha: "git-abc",
        command: "pnpm test",
        exitCode: 0,
        passed: true,
        platform: "linux",
        generatedAt: "2026-01-01T00:00:00Z",
      }),
    );
    await mkdir(join(root, ".ci", "evidence", "capabilities"), { recursive: true });
    await writeFile(
      join(root, ".ci", "evidence", "capabilities", "context_pipeline.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "test_run",
        capability: "context_pipeline",
        headSha: "git-abc",
        command: "pnpm test",
        passed: true,
        generatedAt: "2026-01-01T00:00:00Z",
        artifactRef: "explicit",
      }),
    );
    const probe = await probeWorkspace({ root, gitSha: async () => "git-abc" });
    expect(probe.executionEvidence!["capability:context_pipeline"]!.artifactRef).toBe("explicit");
  });

  it("missing evidence dir stays fail-closed (no capability evidence at all)", async () => {
    const root = await tmpRoot();
    const probe = await probeWorkspace({ root, gitSha: async () => "git-abc" });
    expect(probe.executionEvidence).toEqual({});
  });

  it("benchmark evidence under a capability field is namespaced benchmark:<id>", async () => {
    const root = await tmpRoot();
    await mkdir(join(root, ".ci", "evidence", "benchmarks"), { recursive: true });
    await writeFile(
      join(root, ".ci", "evidence", "benchmarks", "regression.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "benchmark_run",
        capability: "regression_suite",
        headSha: "git-abc",
        command: "bench",
        passed: true,
        generatedAt: "2026-01-01T00:00:00Z",
      }),
    );
    const probe = await probeWorkspace({ root, gitSha: async () => "git-abc" });
    expect(probe.executionEvidence!["benchmark:regression_suite"]).toBeDefined();
    expect(probe.executionEvidence!["capability:regression_suite"]).toBeUndefined();
  });

  it("audit input still drives statuses: synthesized evidence makes a capability tested", async () => {
    const root = await tmpRoot();
    await mkdir(join(root, ".ci", "evidence", "gates", "linux"), { recursive: true });
    await writeFile(
      join(root, ".ci", "evidence", "gates", "linux", "test.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "gate",
        gate: "test",
        headSha: "git-abc",
        command: "pnpm test",
        exitCode: 0,
        passed: true,
        platform: "linux",
        generatedAt: "2026-01-01T00:00:00Z",
      }),
    );
    await createContextProbeFiles(root);
    const probe = await probeWorkspace({ root, gitSha: async () => "git-abc" });
    // The probe itself carries the evidence; the matrix builder consumes it.
    const cap = probe.executionEvidence!["capability:context_pipeline"];
    expect(cap).toBeDefined();
    expect((probe as AuditInput).integrationTests.core_loop_integration).toBe(true);
  });
});
