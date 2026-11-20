import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

it.each([
  { dataStore: "jsonl", lines: 560, fits: true },
  { dataStore: "sqlite", lines: 560, fits: true },
  { dataStore: "jsonl", lines: 1450, fits: false },
] as const)("retains the original check batch only if it fits after compaction ($dataStore, $lines lines)", async ({ dataStore, lines, fits }) => {
  const cwd = await fixture();
  const diagnostic = "CHECKSUM_TARGET_EXPECTED_42";
  await writeFile(join(cwd, "value.txt"), "41\n");
  await writeFile(join(cwd, "check.cjs"), `
    const value = require("node:fs").readFileSync("value.txt", "utf8").trim();
    if (value !== "42") {
      process.stderr.write("compile unit complete\\n".repeat(${lines}));
      console.error("${diagnostic}");
      process.exitCode = 8;
    }
  `);

  const requests: ModelRequest[] = [];
  const summaries: ModelRequest[] = [];
  const provider = new ScriptedModelProvider([]);
  provider.createClient = () => ({ async *generate(rawRequest) {
    const request = rawRequest as ModelRequest;
    if (request.system?.includes("CONTEXT CHECKPOINT COMPACTION")) {
      summaries.push(request);
      // A valid handoff can omit a concrete diagnostic. Recovery must use
      // observed tool evidence, even when the summary names only the failure.
      yield* ScriptedModelProvider.text("A project check failed. Continue the current repair.");
      return;
    }
    requests.push(request);
    if (requests.length === 1) {
      yield* ScriptedModelProvider.text("Initial investigation and working notes. ".repeat(270));
      return;
    }
    if (requests.length === 2 && request.messages.some(message =>
      message.role === "tool" && message.content.includes(diagnostic))) {
      yield* ScriptedModelProvider.toolCall("edit_file", { path: "value.txt", oldText: "41", newText: "42" });
      return;
    }
    yield* ScriptedModelProvider.text("Ready for the project check.");
  } });

  const h = await createHarness({ cwd, dataDir: join(cwd, "state"), dataStore, profile: "test", modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" },
    contextBudget: { maxTokens: 6200, reserved: { system: 0, task: 0, output: 500 }, dynamic: 0 },
    task: { id: "compacted-check", goal: "Repair the project check",
      verification: [
        { kind: "command", command: process.execPath, args: ["check.cjs"] },
        { kind: "command", command: process.execPath, args: ["-e", 'console.log("CHECK_COMPANION")'] },
      ] },
  });
  try {
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    const turn = await h.runtime.startTurn(session.id, "Inspect the project check result, repair value.txt and validate.");
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    const stored = await h.store.listMessages(session.id);
    const failed = stored.find(message => message.role === "tool" && message.content.includes(diagnostic));
    expect(failed?.content).toContain("[failed]");
    expect(summaries.length).toBeGreaterThan(0);
    const repair = requests[1]!;
    expect(repair.messages.some(message => message.contextCheckpoint?.source === "model")).toBe(true);
    const retained = repair.messages.find(message => message.id === failed!.id);
    expect(retained?.content === failed!.content).toBe(fits);
    expect(h.context.pipeline.estimateTextTokens(repair.system ?? "") + h.context.pipeline.estimateMessageTokens(repair.messages))
      .toBeLessThanOrEqual(5700);
    if (fits) {
      expect(retained).toEqual(failed);
      expect(retained?.verificationFailure).toBe(true);
      const request = repair.messages.find(message => message.toolCalls?.some(call => call.id === failed!.toolCallId));
      expect(request?.toolCalls).toHaveLength(2);
      expect(repair.messages.some(message => message.role === "tool" && message.content.includes("CHECK_COMPANION"))).toBe(true);
    }
    for (const request of requests) assertToolProtocol(request.messages);
    const failures = (await h.events.list(session.id)).filter(event => event.type === "verification.failed");
    expect(failures).toHaveLength(fits ? 1 : 3);
    expect(outcome.terminationReason).toBe(fits ? "verified_complete" : "verification_failed");
    expect(await readFile(join(cwd, "value.txt"), "utf8")).toBe(fits ? "42\n" : "41\n");
  } finally { await h.close(); }
});
