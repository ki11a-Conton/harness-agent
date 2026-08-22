import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { auditCmd, buildCapabilityMatrix, capabilityStatusOf, probeWorkspace, type AuditInput } from "./audit.js";
import { createDefaultDeps } from "./main.js";
import { runCommand } from "./commands.js";

/** Repository root = apps/cli/src → ../../.. (tests run against the real tree). */
const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function tmpOut(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-audit-"));
  cleanupDirs.push(dir);
  return dir;
}

describe("audit benchmark profile — real workspace probes (P0-1)", () => {
  it("probes the real benchmark suites: adversarial=13, stress=11, regression=30, holdout=30 (P4-1/P4-2)", async () => {
    const probe = await probeWorkspace({ root: REPO_ROOT, gitSha: async () => undefined });
    expect(probe.benchmarkSuites.adversarial).toEqual({ exists: true, caseCount: 13 });
    expect(probe.benchmarkSuites.stress).toEqual({ exists: true, caseCount: 11 });
    expect(probe.benchmarkSuites.regression).toEqual({ exists: true, caseCount: 30 });
    expect(probe.benchmarkSuites.holdout).toEqual({ exists: true, caseCount: 30 });
  });

  it("parses the README claims: regression 30, holdout 30 (no longer planned)", async () => {
    const probe = await probeWorkspace({ root: REPO_ROOT, gitSha: async () => undefined });
    const regression = probe.readmeClaims.find((c) => c.suite === "regression");
    const holdout = probe.readmeClaims.find((c) => c.suite === "holdout");
    expect(regression).toEqual({ suite: "regression", claimed: 30, planned: false });
    expect(holdout).toEqual({ suite: "holdout", claimed: 30, planned: false });
  });

  it("sees the real packages and CI workflow (linux and windows both present)", async () => {
    const probe = await probeWorkspace({ root: REPO_ROOT, gitSha: async () => undefined });
    expect(probe.packages.memory).toBe(true);
    expect(probe.packages.context).toBe(true);
    expect(probe.integrationTests.suite_conformance).toBe(true);
    expect(probe.ciWorkflow.exists).toBe(true);
    expect(probe.ciWorkflow.ubuntu).toBe(true);
    // P10-6: the promotion gate now runs BOTH platforms.
    expect(probe.ciWorkflow.windows).toBe(true);
  });

  it("derives the real repo state: adversarial + regression + holdout all benchmarked (P4-1/P4-2)", async () => {
    const probe = await probeWorkspace({ root: REPO_ROOT, gitSha: async () => undefined });
    const input: AuditInput = {
      ...probe,
      introspection: {
        profile: "interactive",
        registeredTools: [
          "read_file",
          "write_file",
          "edit_file",
          "search_files",
          "grep_search",
          "repo_tree",
          "symbol_search",
          "repo_map",
          "discover_commands",
          "env_snapshot",
          "exec",
          "update_plan",
        ],
        stores: {
          session: "MemSessionStore",
          events: "MemEventStore",
          approval: "InMemoryApprovalStore",
          artifacts: "InMemoryArtifactStore",
        },
        features: {
          context: true,
          verifier: false,
          checkpoint: false,
          artifacts: true,
          memory: false,
          learning: false,
          delegation: false,
          scheduler: false,
          mcp: false,
          plugins: false,
          skills: true,
          usageAccounting: false,
          runBudget: false,
        },
        persistence: {
          mode: "in-memory",
          degraded: false,
          reasons: [],
          stores: { approval: "InMemoryApprovalStore" },
        },
      },
    };
    const matrix = buildCapabilityMatrix(input);
    expect(capabilityStatusOf(matrix.records.find((r) => r.id === "adversarial_suite")!)).toBe("benchmarked");
    expect(capabilityStatusOf(matrix.records.find((r) => r.id === "regression_suite")!)).toBe("benchmarked");
    expect(capabilityStatusOf(matrix.records.find((r) => r.id === "holdout_suite")!)).toBe("benchmarked");
    expect(matrix.records.find((r) => r.id === "regression_suite")!.evidence[0]?.note).toContain("30");
  });

  it("createDefaultDeps with a dataDir wires durable stores honestly (checkpoint + approval)", async () => {
    const dir = await tmpOut();
    const deps = await createDefaultDeps({ dataDir: dir });
    expect(deps.introspection.profile).toBe("interactive");
    expect(deps.introspection.stores.session).toBe("JSONLSessionStore");
    expect(deps.introspection.stores.events).toBe("JSONLEventStore");
    expect(deps.introspection.stores.checkpoint).toBe("DurableCheckpointStore");
    expect(deps.introspection.stores.approval).toBe("DurableApprovalStore");
    expect(deps.introspection.features.checkpoint).toBe(true);
    expect(deps.introspection.features.memory).toBe(false);
  });

  it("`agent audit --out` writes CAPABILITY_MATRIX.json + .md and exits 0 on truthful docs (P4-1)", async () => {
    const deps = await createDefaultDeps();
    const out = await tmpOut();
    const result = await runCommand(["audit", "--out", out], deps);
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(await readFile(join(out, "CAPABILITY_MATRIX.json"), "utf8")) as {
      records: unknown[];
      gitSha?: string;
    };
    expect(json.records.length).toBe(21);
    const md = await readFile(join(out, "CAPABILITY_MATRIX.md"), "utf8");
    expect(md).toContain("# CAPABILITY MATRIX");
    expect(md).toContain("| regression_suite | benchmarked |");
    expect(md).toContain("audit: OK");
  });

  it("`agent audit --json` emits a parseable matrix and exits 0 when truthful", async () => {
    const deps = await createDefaultDeps();
    const result = await runCommand(["audit", "--json"], deps);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.lines.join("\n")) as { records: { id: string }[] };
    expect(parsed.records.map((r) => r.id)).toContain("regression_suite");
  });

  it("unknown audit flags are rejected with usage", async () => {
    const deps = await createDefaultDeps();
    const result = await runCommand(["audit", "--nope"], deps);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("unknown flag");
  });
});