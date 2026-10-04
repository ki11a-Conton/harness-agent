import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider, VerificationSpec } from "@ar/contracts";
import { buildVerificationPlan, planToVerificationSpecs } from "../../tools/src/verification/plan-builder.js";
import { discoverCommands, summarize, type DiscoveredCommand } from "../../tools/src/command-discovery.js";
import { createHarness } from "./create-harness.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(scripts: Record<string, string>, files: Record<string, string> = {}): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "ar-verification-trust-"));
  roots.push(cwd);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "verification-fixture", scripts }));
  return cwd;
}

async function run(cwd: string, verification?: VerificationSpec[], planner?: () => VerificationSpec[]) {
  let requests = 0;
  const provider: ModelProvider = {
    id: "verification-fixture",
    async listModels() { return [{ id: "stop", name: "stop", capabilities: { contextWindowTokens: 128_000 } }]; },
    createClient() { return { async *generate() {
      requests++;
      yield { type: "completed" as const, timestamp: 0, result: { finishReason: "stop" as const, text: "done" } };
    } }; },
  };
  const harness = await createHarness({
    cwd, dataDir: join(cwd, ".sessions"), profile: "test", modelProvider: provider,
    model: { providerId: provider.id, modelId: "stop" },
    task: { id: "verify", goal: "finish", ...(verification !== undefined ? { verification } : {}) },
    ...(planner !== undefined ? { verification: { planner } } : {}),
  });
  try {
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
    const turn = await harness.runtime.startTurn(session.id, "finish");
    const outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    return { outcome, events: await harness.events.list(session.id), requests };
  } finally { await harness.close(); }
}

describe("T1: automatic verification preserves project command semantics", () => {
  it.each([7, 0])("executes a quoted expression rather than evaluating its source as a string (exit %i)", async code => {
    const cwd = await fixture({ test: `node -e "process.exit(${code})"` });
    const result = await run(cwd);
    expect(result.outcome.terminationReason).toBe(code === 0 ? "verified_complete" : "verification_failed");
    expect(result.events.some(event => code === 0
      ? event.type === "verification.completed" && event.payload.passed === true
      : event.type === "verification.failed")).toBe(true);
    expect(result.events.some(event => event.type === "verification.step_completed" && event.payload.passed === (code === 0))).toBe(true);
  });

  it("runs the required command after && and blocks completion when it fails", async () => {
    const cwd = await fixture({ test: "node pass.cjs && node required-fail.cjs" }, {
      "pass.cjs": "console.log('FIRST');\n", "required-fail.cjs": "process.exit(9);\n",
    });
    const result = await run(cwd);
    expect(result.outcome.terminationReason).toBe("verification_failed");
    expect(result.events.some(event => event.type === "verification.failed")).toBe(true);
    expect(result.events.some(event => event.type === "verification.step_completed" && event.payload.passed === false)).toBe(true);
  });

  it("executes a valid quoted space path and retains its independent marker", async () => {
    const cwd = await fixture({ test: 'node "test suite/check.cjs"' }, {
      "test suite/check.cjs": "require('node:fs').writeFileSync('checker-ran.txt','actual checker ran');\n",
    });
    const result = await run(cwd);
    expect(result.outcome.terminationReason).toBe("verified_complete");
    await expect(access(join(cwd, "checker-ran.txt"))).resolves.toBeUndefined();
  });

  it("never inserts changed test paths or guesses package cwd for an unknown recipe", () => {
    const command = 'node -e "process.exit(0)"';
    const plan = buildVerificationPlan({ root: "/repo", filesChanged: ["src/a.test.ts;node marker.cjs;tail.test.ts", "src/space name.test.ts", 'src/quoted"name.test.ts'], commands: { test: command } });
    expect(plan.steps).toEqual([{ kind: "command", command, required: true }]);
    expect(planToVerificationSpecs(plan)).toEqual([{ kind: "command", command, description: `planned: ${command}` }]);
  });

  it("cannot execute a marker embedded in a changed-path recipe interpolation", async () => {
    const cwd = await fixture({}, { "pass.cjs": "console.log('PASS');\n", "marker.cjs": "require('node:fs').writeFileSync('injected.txt','bad');\n" });
    const specs = planToVerificationSpecs(buildVerificationPlan({ root: cwd, filesChanged: ["src/a.test.ts;node marker.cjs;tail.test.ts"], commands: { test: "node pass.cjs" } }));
    const result = await run(cwd, undefined, () => specs);
    expect(result.outcome.terminationReason).toBe("verified_complete");
    await expect(access(join(cwd, "injected.txt"))).rejects.toThrow();
  });

  it("keeps explicit program+argv failure authoritative over passing discovered scripts", async () => {
    const cwd = await fixture({ test: 'node -e "process.exit(0)"' });
    const result = await run(cwd, [{ kind: "command", command: process.execPath, args: ["-e", "process.exit(7)"] }]);
    expect(result.outcome.terminationReason).toBe("verification_failed");
  });

  it("transports explicit argv shell characters literally without another process", async () => {
    const value = 'a&node marker.cjs|; $literal "quoted"';
    const cwd = await fixture({}, {
      "check.cjs": `if(process.argv[2]!==${JSON.stringify(value)})process.exit(12);\n`,
      "marker.cjs": "require('node:fs').writeFileSync('injected.txt','bad');\n",
    });
    const result = await run(cwd, [{ kind: "command", command: process.execPath, args: ["check.cjs", value] }]);
    expect(result.outcome.terminationReason).toBe("verified_complete");
    await expect(access(join(cwd, "injected.txt"))).rejects.toThrow();
  });

  it("keeps empty auto verification fail-closed", async () => {
    expect((await run(await fixture({}))).outcome.terminationReason).toBe("verification_failed");
  });
});

describe("T1: root command discovery survives bounded monorepo discovery", () => {
  async function monorepo(reverse: boolean) {
    const files: Record<string, string> = { "required-fail.cjs": "process.exit(11);\n", "smoke.cjs": "console.log('SMOKE');\n" };
    const ids = Array.from({ length: 61 }, (_, index) => index);
    for (const index of reverse ? ids.reverse() : ids) files[`packages/p${String(index).padStart(2, "0")}/package.json`] = JSON.stringify({ name: `p${index}`, scripts: { test: "node smoke.cjs", build: "node smoke.cjs" } });
    return fixture({ "test:watch": "node smoke.cjs", test: "node required-fail.cjs", typecheck: "node smoke.cjs", build: "node required-fail.cjs", "test:coverage": "node smoke.cjs" }, files);
  }

  it("retains canonical root test/typecheck/build under the 60-command cap", async () => {
    const cwd = await monorepo(false);
    const discovered = await discoverCommands(cwd);
    expect(discovered.discovered).toHaveLength(60);
    expect(summarize(discovered.discovered)).toMatchObject({ test: "node required-fail.cjs", typecheck: "node smoke.cjs", build: "node required-fail.cjs" });
    for (const name of ["test", "typecheck", "build"]) expect(discovered.discovered.some(command => command.file === "package.json" && command.scriptName === name)).toBe(true);
  });

  it("keeps discovery and summaries stable across creation and input order", async () => {
    const left = await discoverCommands(await monorepo(false));
    const right = await discoverCommands(await monorepo(true));
    expect(left.discovered).toEqual(right.discovered);
    expect(summarize([...left.discovered].reverse())).toEqual(summarize(left.discovered));
  });

  it("blocks completion on the failed root test even when all child smoke tests pass", async () => {
    const result = await run(await monorepo(false));
    expect(result.outcome.terminationReason).toBe("verification_failed");
    expect(result.events.some(event => event.type === "verification.failed")).toBe(true);
    expect(result.events.some(event => event.type === "verification.step_completed" && event.payload.passed === false)).toBe(true);
  });

  it("selects high-confidence package sources deterministically with canonical script provenance", () => {
    const commands: DiscoveredCommand[] = [
      { kind: "test", command: "low", source: "AGENTS.md", file: "AGENTS.md", confidence: "low" },
      { kind: "test", command: "child", source: "package.json", file: "packages/a/package.json", confidence: "high" },
      { kind: "test", command: "cargo test", source: "Cargo.toml", file: "Cargo.toml", confidence: "high" },
      { kind: "test", command: "variant", source: "package.json", file: "package.json", confidence: "high", scriptName: "test:watch" },
      { kind: "test", command: "canonical", source: "package.json", file: "package.json", confidence: "high", scriptName: "test" },
    ];
    expect(summarize(commands).test).toBe("canonical");
    expect(summarize([...commands].reverse()).test).toBe("canonical");
  });
});
