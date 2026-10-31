import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECK_BARRIER_URL_FILE, CHECK_FIXTURE_SOURCE, createCheckReadBarrier } from "./check-read-barrier.mjs";
import { observeReadOverlap } from "./observe-read-overlap.mjs";
import { ProcessExecutor } from "../../../packages/tools/dist/process/executor.js";
import { createHarness } from "../../../packages/harness/dist/index.js";
import { ScriptedModelProvider } from "../../../packages/model/dist/index.js";

function readEvents(sourcePath, sessionId = "session", turnId = "turn") {
  const at = Date.now();
  return [
    { type: "tool.started", sessionId, turnId, timestamp: at, sequence: 1, payload: { tool: "read_file", toolCallId: "read" } },
    { type: "tool.completed", sessionId, turnId, timestamp: at, sequence: 2, payload: { tool: "read_file", toolCallId: "read", status: "success", evidence: [{ type: "file", source: sourcePath, timestamp: at }] } },
  ];
}
async function jsonLines(cwd, file) {
  return (await readFile(join(cwd, file), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("a gate requires the actual successful source read with its original call/session/turn", async () => {
  const sourcePath = "/fixture/source.cjs", owner = { sessionId: "session", turnId: "turn" };
  const gate = await createCheckReadBarrier({ sourcePath });
  try {
    for (const events of [
      [{ type: "model", stage: "observe", timestamp: Date.now() }],
      [readEvents(sourcePath)[0]],
      readEvents("/fixture/other.cjs"),
      readEvents(sourcePath, "other-session"),
      readEvents(sourcePath, "session", "other-turn"),
      readEvents(sourcePath).map(event => event.type === "tool.completed" ? { ...event, payload: { ...event.payload, status: "failed" } } : event),
      readEvents(sourcePath).map(event => event.type === "tool.completed" ? { ...event, payload: { ...event.payload, toolCallId: "other-call" } } : event),
    ]) assert.throws(() => gate.releaseAfterSuccessfulRead(events, owner), /correlated successful/);
    assert.equal(gate.isReleased(), false);
    const response = fetch(gate.url);
    await gate.connection;
    assert.equal(gate.snapshot().pendingConnections, 1);
    const proof = gate.releaseAfterSuccessfulRead(readEvents(sourcePath), owner);
    assert.equal(proof.kind, "correlated-successful-read");
    assert.equal(proof.toolCallId, "read");
    assert.equal(await (await response).text(), "actual read completed");
    assert.deepEqual(gate.releaseAfterSuccessfulRead([], owner), proof);
  } finally { await gate.close(); }
});

test("baseline explicitly pre-releases its gate instead of deadlocking synchronous exec", async () => {
  const gate = await createCheckReadBarrier({ sourcePath: "/fixture/source.cjs", preReleased: true });
  try {
    assert.equal(await (await fetch(gate.url)).text(), "actual read completed");
    assert.equal(gate.snapshot().releaseProof.kind, "baseline-pre-released");
  } finally { await gate.close(); }
});

test("missing read acknowledgement expires at the original 5000ms process budget and cleans up", { timeout: 15000 }, async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "paired-read-timeout-")));
  const gate = await createCheckReadBarrier({ sourcePath: join(cwd, "source.cjs") });
  try {
    await writeFile(join(cwd, "source.cjs"), "module.exports=1;\n");
    await writeFile(join(cwd, "check.cjs"), CHECK_FIXTURE_SOURCE);
    await writeFile(join(cwd, CHECK_BARRIER_URL_FILE), gate.url);
    const running = new ProcessExecutor().runArgv({ file: process.execPath, args: ["check.cjs"], cwd, timeoutMs: 5000, maxOutputBytes: 65536 });
    await Promise.race([gate.connection, running.then(() => { throw new Error("native command settled before opening its read barrier"); })]);
    const result = await running;
    assert.equal(result.status, "timeout");
    const starts = await jsonLines(cwd, "starts.jsonl");
    assert.equal(starts.length, 1);
    assert.equal((await jsonLines(cwd, "native-work.jsonl")).length, 1);
    await assert.rejects(readFile(join(cwd, "exits.jsonl")), error => error.code === "ENOENT");
    assert.throws(() => process.kill(starts[0].pid, 0), error => error.code === "ESRCH");
    assert.equal(gate.isReleased(), false);
  } finally { await gate.close(); await rm(cwd, { recursive: true, force: true }); }
  assert.equal(gate.snapshot().closed, true);
  assert.equal(gate.snapshot().pendingConnections, 0);
});

test("a real delayed source read overlaps and the identical repair command reuses its release", { timeout: 15000 }, async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "paired-read-real-")));
  const gate = await createCheckReadBarrier({ sourcePath: join(cwd, "source.cjs") });
  let h, session, turn, stage = "start", jobId, pollToken = 0, state, failedId;
  const call = (name, args) => ScriptedModelProvider.toolCall(name, args);
  const provider = {
    id: "paired-read-gate", listModels: async () => [{ id: "offline", capabilities: { contextWindowTokens: 128000 } }],
    createClient: () => ({ async *generate(request) {
      const last = request.messages.filter(message => message.role === "tool").at(-1)?.content ?? "";
      let data; try { data = JSON.parse(last); } catch {}
      if (data?.jobId) { jobId = data.jobId; pollToken = data.pollToken; state = data.state; }
      if (stage === "start") { stage = "ready"; yield* call("exec_start", { command: process.execPath, args: ["check.cjs"], yieldMs: 50 }); return; }
      if (stage === "ready") {
        if (!request.messages.some(message => message.role === "tool" && message.content.includes("STARTED"))) {
          yield* call("exec_poll", { jobId, pollToken, waitMs: 50 }); return;
        }
        // Wait for the native 2s work milestone, without adding a longer time
        // window. An ungated finite fixture has already exited at this point.
        while (await readFile(join(cwd, "native-work.jsonl"), "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; }) === "") {
          assert(Date.now() < turn.startedAt + 5000, "original command budget exhausted");
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        stage = "observe"; yield* call("read_file", { path: "source.cjs" }); return;
      }
      if (stage === "observe") {
        if (!gate.isReleased()) gate.releaseAfterSuccessfulRead(await h.events.list(session.id), { sessionId: session.id, turnId: turn.id });
        if (state === "running") { yield* call("exec_poll", { jobId, pollToken, waitMs: 1000 }); return; }
        failedId = jobId; stage = "retry";
        yield* call("edit_file", { path: "source.cjs", oldText: "module.exports=0;", newText: "module.exports=1;" }); return;
      }
      if (stage === "retry") {
        stage = "recheck";
        yield* call("exec_start", { command: process.execPath, args: ["check.cjs"], yieldMs: 50, supersedes: failedId }); return;
      }
      if (stage === "recheck" && state === "running") { yield* call("exec_poll", { jobId, pollToken, waitMs: 1000 }); return; }
      yield* ScriptedModelProvider.text("Use the actual verification result.");
    } }),
  };
  try {
    await writeFile(join(cwd, "source.cjs"), "module.exports=0;\n");
    await writeFile(join(cwd, "check.cjs"), CHECK_FIXTURE_SOURCE);
    await writeFile(join(cwd, CHECK_BARRIER_URL_FILE), gate.url);
    h = await createHarness({ cwd, dataDir: join(cwd, ".state"), profile: "test", modelProvider: provider, model: { providerId: provider.id, modelId: "offline" }, featureFlags: { skills: false, memory: false, mcp: false, delegation: false }, limits: { maxDurationMs: 15000, maxToolCalls: 30 }, maxIterationsPerTurn: 30, managedCommands: { enabled: true, maxJobMs: 5000 }, sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [cwd] }, network: { mode: "allowlist", hosts: ["127.0.0.1"] }, process: { timeoutMs: 5000, maxOutputBytes: 65536 } }, task: { id: "paired-gate", goal: "repair the actual source", completionPolicy: { requiresVerification: true }, verification: [{ kind: "command", command: process.execPath, args: ["-e", "require('node:assert/strict').equal(require('./source.cjs'),1);require('node:assert/strict').equal(JSON.parse(require('node:fs').readFileSync('exits.jsonl','utf8').trim().split('\\n').at(-1)).code,0)"] }] } });
    session = await h.runtime.createSession({ agent: h.agents[0], cwd });
    turn = await h.runtime.startTurn(session.id, "failure-repair");
    const outcome = await h.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.grade, "verified_complete");
    const starts = await jsonLines(cwd, "starts.jsonl"), exits = await jsonLines(cwd, "exits.jsonl");
    assert.equal(starts.length, 2);
    assert.deepEqual(exits.map(exit => exit.code), [1, 0]);
    const proof = observeReadOverlap({ events: await h.events.list(session.id), starts, exits, sourcePath: join(cwd, "source.cjs") });
    assert.equal(proof.overlapObserved, true);
    assert(proof.reads.some(read => starts[0].at < read.at && read.at < exits[0].at));
    assert.equal(gate.snapshot().releaseProof.kind, "correlated-successful-read");
    assert.equal(gate.snapshot().releaseProof.toolCallId, proof.reads[0].toolCallId);
  } finally { await h?.close(); await gate.close(); await rm(cwd, { recursive: true, force: true }); }
});
