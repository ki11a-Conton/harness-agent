import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ScriptedModelProvider } from "@ar/model";
import { assertToolProtocol, type ModelRequest } from "@ar/contracts";
import { createHarness } from "./create-harness.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "coding-verification-")); roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  return root;
}
async function harness(root: string, count = 1) {
  return createHarness({ cwd: root, profile: "test", model: { providerId: "scripted", modelId: "scripted-model" },
    modelProvider: new ScriptedModelProvider(Array.from({ length: count * 8 }, () => ScriptedModelProvider.text("done"))),
    task: { id: "coding", goal: "verify the current project" },
  });
}
it("C03: verification discovers the session project rather than the host parent", async () => {
  const root = await fixture(); const cwd = join(root, "child"); await mkdir(cwd);
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(7)"' } }));
  const h = await harness(root);
  try {
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    const turn = await h.runtime.startTurn(session.id, "verify");
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.terminationReason).toBe("verification_failed");
  } finally { await h.close(); }
});
it("C05: a failed verification command's diagnostics reach the next model request as protected tool data", async () => {
  const cwd = await fixture();
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: 'node -e "console.error(\'ASSERTION_EXPECTED_42_AT_MATH_LINE_7\'); process.exit(8)"' } }));
  const seen: ModelRequest[] = [];
  const provider = new ScriptedModelProvider(Array.from({ length: 8 }, () => ScriptedModelProvider.text("done")));
  const original = provider.createClient.bind(provider);
  provider.createClient = (model, config) => {
    const client = original(model, config);
    return { async *generate(request, signal) { seen.push(request as ModelRequest); yield* client.generate(request, signal); } };
  };
  const h = await createHarness({ cwd, profile: "test", model: { providerId: provider.id, modelId: "scripted-model" }, modelProvider: provider, task: { id: "coding", goal: "fix the failing assertion" } });
  try {
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    const turn = await h.runtime.startTurn(session.id, "fix");
    await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    for (const request of seen) assertToolProtocol(request.messages);
    expect(seen.slice(1).some(request => request.messages.some(message => message.role === "tool" && message.content.includes("ASSERTION_EXPECTED_42_AT_MATH_LINE_7")))).toBe(true);
  } finally { await h.close(); }
});
it("thinking-provider history retains a reasoning field on host verification tool calls", async () => {
  const cwd = await fixture();
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(8)"' } }));
  const seen: ModelRequest[] = [];
  const provider = new ScriptedModelProvider(Array.from({ length: 8 }, () => [
    { type: "reasoning_delta" as const, text: "Inspect the test result", timestamp: 0 }, ...ScriptedModelProvider.text("done"),
  ]));
  const original = provider.createClient.bind(provider);
  provider.createClient = (model, config) => {
    const client = original(model, config);
    return { async *generate(request, signal) { seen.push(request as ModelRequest); yield* client.generate(request, signal); } };
  };
  const h = await createHarness({ cwd, profile: "test", model: { providerId: provider.id, modelId: "scripted-model" }, modelProvider: provider, task: { id: "coding", goal: "fix" } });
  try {
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd }); const turn = await h.runtime.startTurn(session.id, "fix");
    await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    const calls = seen.slice(1).flatMap(request => request.messages.filter(message => message.role === "assistant" && message.toolCalls !== undefined));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(message => message.reasoningContent !== undefined)).toBe(true);
  } finally { await h.close(); }
});
it("C04: changing the project test recipe invalidates the previous passing verification", async () => {
  const cwd = await fixture(); const h = await harness(cwd, 2);
  try {
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    async function run() { const turn = await h.runtime.startTurn(session.id, "verify"); return h.runtime.runTurn(session.id, turn.id, new AbortController().signal); }
    expect((await run()).terminationReason).toBe("verified_complete");
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(9)"' } }));
    expect((await run()).terminationReason).toBe("verification_failed");
  } finally { await h.close(); }
});

it("keeps both parallel verification results in the session and the repair request", async () => {
  const cwd = await fixture();
  // Each command needs its peer to start. A sequential dispatcher would time out.
  await writeFile(join(cwd, "check.cjs"), `
    const fs = require("node:fs");
    const [name, peer] = process.argv.slice(2);
    fs.writeFileSync(name, "");
    const deadline = setTimeout(() => process.exit(9), 5000);
    const poll = setInterval(() => {
      if (!fs.existsSync(peer)) return;
      clearTimeout(deadline);
      clearInterval(poll);
      console.log("diagnostic-" + name);
      process.exitCode = name === "first" ? 1 : 0;
    }, 10);
  `);
  const provider = new ScriptedModelProvider(Array.from({ length: 8 }, () => ScriptedModelProvider.text("done")));
  const seen: ModelRequest[] = [];
  const original = provider.createClient.bind(provider);
  provider.createClient = (model, config) => {
    const client = original(model, config);
    return { async *generate(request, signal) { seen.push(request as ModelRequest); yield* client.generate(request, signal); } };
  };
  const h = await createHarness({ cwd, profile: "test", modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" },
    task: { id: "parallel-checks", goal: "verify both checks", verification: [
      { kind: "command", command: process.execPath, args: ["check.cjs", "first", "second"] },
      { kind: "command", command: process.execPath, args: ["check.cjs", "second", "first"] },
    ] },
  });
  try {
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    const turn = await h.runtime.startTurn(session.id, "verify");
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.terminationReason).toBe("verification_failed");
    assertToolProtocol(await h.store.listMessages(session.id));
    const retry = seen[1]!;
    assertToolProtocol(retry.messages);
    const diagnostics = retry.messages.filter(m => m.role === "tool").map(m => m.content);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.stringContaining("diagnostic-first"), expect.stringContaining("diagnostic-second"),
    ]));
    const steps = (await h.events.list(session.id)).filter(e => e.type === "verification.step_completed");
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps.every(e => e.turnId === turn.id)).toBe(true);
  } finally { await h.close(); }
});

it("reports the stored turn start time on every verification attempt", async () => {
  const cwd = await fixture();
  const times: number[] = [];
  let clock = Date.now();
  const provider = new ScriptedModelProvider(Array.from({ length: 3 }, () => ScriptedModelProvider.text("done")));
  const h = await createHarness({ cwd, profile: "test", modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" }, now: () => clock,
    task: { id: "timed-check", goal: "verify the current run" },
    verification: { verifier: { async verify(_task, context) {
      times.push(context.runStartedAt);
      const passed = times.length === 2;
      return { level: passed ? 3 : 1, passed,
        checks: [{ id: "time", kind: "review", description: "verify the run", passed }],
        evidence: [], startedAt: clock, completedAt: clock };
    } } },
  });
  try {
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    const turn = await h.runtime.startTurn(session.id, "verify");
    clock += 100;
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.terminationReason).toBe("verified_complete");
    expect(times).toEqual([turn.startedAt, turn.startedAt]);
  } finally { await h.close(); }
});
