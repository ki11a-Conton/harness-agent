import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ScriptedModelProvider } from "@ar/model";
import { assertToolProtocol, newToolCallId, type ModelRequest } from "@ar/contracts";
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

it("keeps a completed write and settles the rest of a serial batch when the turn expires", async () => {
  const cwd = await fixture();
  let clock = 1000;
  const calls = ["first.txt", "second.txt"].map(path => ({
    id: newToolCallId(), name: "write_file", args: { path, content: "committed\n" },
  }));
  const provider = new ScriptedModelProvider([[{ type: "completed", timestamp: clock,
    result: { finishReason: "tool_calls", toolCalls: calls } }]]);
  const h = await createHarness({ cwd, profile: "test", modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" }, now: () => clock,
    maxIterationsPerTurn: 1, limits: { maxDurationMs: 500 },
  });
  try {
    const execute = h.orchestrator.executeBound.bind(h.orchestrator);
    h.orchestrator.executeBound = async (request, context) => {
      const result = await execute(request, context);
      if (request.call.id === calls[0]!.id && result.status === "success") clock += 501;
      return result;
    };
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    const turn = await h.runtime.startTurn(session.id, "Write the two fixtures in order.");
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    const messages = await h.store.listMessages(session.id);
    assertToolProtocol(messages);
    expect(await readFile(join(cwd, "first.txt"), "utf8")).toBe("committed\n");
    await expect(readFile(join(cwd, "second.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(outcome).toMatchObject({ status: "failed", statusDetail: "failed_with_effects", terminationReason: "time_limit" });
    const events = await h.events.list(session.id);
    expect(events.filter(event => event.type === "tool.requested").map(event => event.payload.toolCallId))
      .toEqual([calls[0]!.id]);
    expect(events.filter(event => event.type === "run.limit_reached").map(event => event.payload.limit))
      .toEqual(["maxDurationMs"]);
    expect(messages.filter(message => message.role === "tool").map(message => message.toolCallId))
      .toEqual(calls.map(call => call.id));
    expect(messages.find(message => message.toolCallId === calls[1]!.id)?.content).toContain("did not run");
  } finally { await h.close(); }
});

it.each([false, true])("handles a failing verification planner within the existing retry bound (recovers=%s)", async recovers => {
  const cwd = await fixture();
  const provider = new ScriptedModelProvider(Array.from({ length: 3 }, () => ScriptedModelProvider.text("Ready to verify.")));
  let plans = 0;
  const h = await createHarness({ cwd, profile: "test", modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" },
    task: { id: "planner-failure", goal: "Verify a local check." },
    verification: { async planner() {
      if (++plans === 1 || !recovers) throw new Error("fixture discovery unavailable");
      return [{ kind: "command", command: process.execPath, args: ["-e", "console.log('CHECK_RAN')"] }];
    } },
  });
  try {
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    const turn = await h.runtime.startTurn(session.id, "Run the verification check.");
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    const events = await h.events.list(session.id);
    const failures = events.filter(event => event.type === "verification.failed");
    expect(failures).toHaveLength(recovers ? 1 : 3);
    expect(failures[0]?.payload.error).toContain("fixture discovery unavailable");
    expect(plans).toBe(recovers ? 2 : 3);
    expect(outcome.terminationReason).toBe(recovers ? "verified_complete" : "verification_failed");
    const messages = await h.store.listMessages(session.id);
    assertToolProtocol(messages);
    expect(messages.some(message => message.role === "tool" && message.content.includes("CHECK_RAN"))).toBe(recovers);
    expect((await h.store.getTurn(turn.id))?.status).toBe(recovers ? "completed" : "failed");
  } finally { await h.close(); }
});

it("settles verification calls without running a command after planning exhausts the turn time", async () => {
  const cwd = await fixture();
  let clock = 1000;
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text("Ready to verify.")]);
  const h = await createHarness({ cwd, profile: "test", modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" },
    now: () => clock, limits: { maxDurationMs: 500 },
    task: { id: "verification-deadline", goal: "Run the local check before the deadline." },
    verification: { async planner() {
      clock += 501;
      return [{ kind: "command", command: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync('check-ran.txt', 'started')"] }];
    } },
  });
  try {
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    const turn = await h.runtime.startTurn(session.id, "Run the verification check.");
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(outcome.terminationReason).toBe("time_limit");
    await expect(readFile(join(cwd, "check-ran.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const events = await h.events.list(session.id);
    expect(events.some(event => event.type === "tool.started")).toBe(false);
    const messages = await h.store.listMessages(session.id);
    assertToolProtocol(messages);
    expect(messages.find(message => message.role === "tool")?.content).toContain("did not run");
  } finally { await h.close(); }
});

it.each(["model", "verification"] as const)("refuses %s tool effects when publishing tool.started exhausts the turn time", async source => {
  const cwd = await fixture();
  let clock = 1000;
  const path = "deadline-effect.txt";
  const call = { id: newToolCallId(), name: "write_file", args: { path, content: "started" } };
  const provider = new ScriptedModelProvider(source === "model"
    ? [[{ type: "completed", timestamp: clock, result: { finishReason: "tool_calls", toolCalls: [call] } }]]
    : [ScriptedModelProvider.text("Ready to verify.")]);
  const h = await createHarness({ cwd, profile: "test", modelProvider: provider,
    model: { providerId: provider.id, modelId: "scripted-model" },
    now: () => clock, limits: { maxDurationMs: 500 }, maxIterationsPerTurn: 1,
    ...(source === "verification" ? {
      task: { id: "late-dispatch", goal: "Run a local check." },
      verification: { planner: async () => [{ kind: "command" as const, command: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(path)}, 'started')`] }] },
    } : {}),
  });
  try {
    const append = h.events.append.bind(h.events);
    h.events.append = async event => {
      const saved = await append(event);
      if (event.type === "tool.started") clock += 501;
      return saved;
    };
    const session = await h.runtime.createSession({ agent: h.agents[0]!, cwd });
    const turn = await h.runtime.startTurn(session.id, "Dispatch a tool within the time limit.");
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(clock).toBe(1501);
    await expect(readFile(join(cwd, path), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(outcome.terminationReason).toBe("time_limit");
    const messages = await h.store.listMessages(session.id);
    assertToolProtocol(messages);
    expect(messages.find(message => message.role === "tool")?.content).toContain("did not run");
    const events = await h.events.list(session.id);
    expect(events.filter(event => event.type === "tool.started")).toHaveLength(1);
    expect(events.some(event => event.type === "tool.failed" && event.payload.preDispatch === true)).toBe(true);
    expect(events.some(event => event.type === "tool.completed")).toBe(false);
  } finally { await h.close(); }
});
