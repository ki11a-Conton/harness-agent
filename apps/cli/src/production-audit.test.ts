import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runProductionAudit } from "./production-audit.js";

let root = "";

async function makeRoot(files: Record<string, string>) {
  root = await mkdtemp(join(tmpdir(), "prod-audit-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}

const GOOD_CREATE_HARNESS = `
import { ToolOrchestrator } from "@ar/tools";
const orchestrator = new ToolOrchestrator({
  registry,
  approval,
  events,
});
const runtime = new AgentRuntime({
  sandboxPolicy: config.sandboxPolicy ?? preset.sandbox,
});
const approvalStore = new DurableApprovalStore(join(dataDir, "approval-store.json"));
const checkpointStore = new DurableCheckpointStore({ dataDir });
const askUserStore = new JSONLAskUserStore({ dataDir });
`;

const GOOD_WORKER = `
export function workerAgentDefinition() {
  return {
    name: "worker-w",
    systemPrompt: "ISOLATED copy of the parent workspace",
    permissions: {
      rules: [
        { action: "edit", resource: "file", effect: "allow" },
        { action: "exec", resource: "network", effect: "deny" },
      ],
    },
  };
}
`;

const GOOD_SOURCE = `
export function good() {
  try {
    run();
  } catch (err) {
    process.stderr.write("[degraded] failed: " + err.message);
  }
  const cast = value as never; // plain cast — whitelisted
  return cast;
}
`;

beforeEach(() => {
  root = "";
});
afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

describe("P22-3 production audit", () => {
  it("passes a clean tree (matrix generated, no silent catch, no gates, retry spec, isolation)", async () => {
    await makeRoot({
      "CAPABILITY_MATRIX.md": "# CAPABILITY MATRIX\n- generatedAt: 2026\n| id | status | implemented | productionWired |",
      "packages/harness/src/create-harness.ts": GOOD_CREATE_HARNESS,
      "packages/harness/src/worker-agent.ts": GOOD_WORKER,
      "packages/app/src/index.ts": GOOD_SOURCE,
    });
    const result = runProductionAudit({ root });
    for (const check of result.checks) {
      expect(check.passed, `${check.name}: ${check.detail}`).toBe(true);
    }
    expect(result.ok).toBe(true);
  });

  it("flags a silent catch in production sources", async () => {
    await makeRoot({
      "CAPABILITY_MATRIX.md": "# CAPABILITY MATRIX\n- generatedAt: 2026\n| id | status | implemented | productionWired |",
      "packages/harness/src/create-harness.ts": GOOD_CREATE_HARNESS,
      "packages/harness/src/worker-agent.ts": GOOD_WORKER,
      "packages/app/src/index.ts": "run().catch(() => {});",
    });
    const result = runProductionAudit({ root });
    const check = result.checks.find((c) => c.name === "no silent catch")!;
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("index.ts");
  });

  it("flags a fabricated literal as never", async () => {
    await makeRoot({
      "CAPABILITY_MATRIX.md": "# CAPABILITY MATRIX\n- generatedAt: 2026\n| id | status | implemented | productionWired |",
      "packages/harness/src/create-harness.ts": GOOD_CREATE_HARNESS,
      "packages/harness/src/worker-agent.ts": GOOD_WORKER,
      "packages/app/src/index.ts": 'const id = "" as never;',
    });
    const result = runProductionAudit({ root });
    const check = result.checks.find((c) => c.name === "no production as never escape (whitelist: type casts)")!;
    expect(check.passed).toBe(false);
    expect(check.detail).toContain('""');
  });

  it("flags an unsafe path-prefix security check", async () => {
    await makeRoot({
      "CAPABILITY_MATRIX.md": "# CAPABILITY MATRIX\n- generatedAt: 2026\n| id | status | implemented | productionWired |",
      "packages/harness/src/create-harness.ts": GOOD_CREATE_HARNESS,
      "packages/harness/src/worker-agent.ts": GOOD_WORKER,
      "packages/app/src/index.ts": 'if (path.startsWith("/safe")) allow(path);',
    });
    const result = runProductionAudit({ root });
    const check = result.checks.find((c) => c.name === "no unsafe path-prefix security check")!;
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("index.ts");
  });

  it("fails when the capability matrix is missing", async () => {
    await makeRoot({
      "packages/harness/src/create-harness.ts": GOOD_CREATE_HARNESS,
      "packages/harness/src/worker-agent.ts": GOOD_WORKER,
      "packages/app/src/index.ts": GOOD_SOURCE,
    });
    const result = runProductionAudit({ root });
    expect(result.checks[0]!.passed).toBe(false);
    expect(result.ok).toBe(false);
  });
});
