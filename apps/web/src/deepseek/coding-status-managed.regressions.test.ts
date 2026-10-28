import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newAgentId, newEventId, newMessageId, newSessionId, newToolCallId, newTurnId,
  type AgentEvent, type EventType, type Message, type ModelProvider, type Session } from "@ar/contracts";
import { createHarness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import { projectSessionHistory } from "./projections.js";
import { codingStatusOf } from "./coding-status.js";

function fixture() {
  const session: Session = { id: newSessionId(), agentId: newAgentId(), model: { providerId: "fixture", modelId: "coding" }, cwd: process.cwd(), status: "active", createdAt: 1, updatedAt: 1 };
  const events: AgentEvent[] = [], messages: Message[] = [];
  let turnId = newTurnId(), time = 1;
  function event(type: EventType, payload: Record<string, unknown> = {}) {
    events.push({ id: newEventId(), sessionId: session.id, turnId, sequence: events.length, timestamp: ++time, type, payload });
  }
  function message(role: Message["role"], content: string, extra: Partial<Message> = {}) {
    messages.push({ id: newMessageId(), sessionId: session.id, turnId, role, content, createdAt: ++time, ...extra });
  }
  function begin() { turnId = newTurnId(); message("user", "Run the actual command"); event("turn.started", { text: "Run the actual command" }); }
  function call(name: string, args: Record<string, unknown>, output: unknown, failed = false, raw = false) {
    const call = { id: newToolCallId(), name, args };
    event("model.started", { callId: call.id }); message("assistant", "", { toolCalls: [call] });
    event("model.completed", { text: "", toolCalls: 1, finishReason: "tool_calls" });
    event("tool.requested", { toolCallId: call.id, name, args }); event("tool.started", { toolCallId: call.id, tool: name });
    message("tool", raw ? String(output) : JSON.stringify(output), { toolCallId: call.id });
    event(failed ? "tool.failed" : "tool.completed", { toolCallId: call.id, tool: name, status: failed ? "failed" : "success" });
  }
  const status = () => codingStatusOf(projectSessionHistory({ session, events, messages }));
  begin();
  return { begin, call, event, status };
}
const command = { command: "node", args: ["check.cjs"] };
const chunk = (text: string, offset = 0) => ({ stream: "stdout", text, offset });

describe("actual history projection of managed coding commands", () => {
  it("folds running and terminal polls once per owner job, preserving incremental output and ordinary exec", () => {
    const f = fixture();
    f.call("exec_start", command, { jobId: "one", state: "running", exitCode: null, chunks: [chunk("READY\n")] });
    expect(f.status().commands).toMatchObject([{ jobId: "one", state: "running", exitCode: null, failed: false, detail: "READY\n" }]);
    f.call("exec_poll", { jobId: "one" }, { jobId: "one", state: "running", chunks: [chunk("READY\n")] });
    f.call("exec_poll", { jobId: "one" }, { jobId: "one", state: "succeeded", exitCode: 0, chunks: [chunk("READY\nDONE\n")] });
    f.call("exec_poll", { jobId: "one" }, { jobId: "one", state: "running", chunks: [chunk("READY\n")] });
    f.call("exec", { command: "node", args: ["verify.cjs"] }, { exitCode: 2, stderr: "verification failed" });
    f.event("turn.completed");
    const status = f.status();
    expect(status.commands).toHaveLength(2);
    expect(status.commands[0]).toMatchObject({ command: 'node "check.cjs"', jobId: "one", state: "succeeded", exitCode: 0, failed: false, detail: "READY\nDONE\n" });
    expect(status.commands[1]).toMatchObject({ command: 'node "verify.cjs"', exitCode: 2, failed: true });
    expect(status.commands[1]!.state).toBeUndefined(); expect(status.verification).toBe("unrun");
  });
  it.each([ ["failed", 2], ["timed_out", null], ["cancelled", null], ["unknown", null] ] as const)("preserves %s rather than inventing success", (state, exitCode) => {
    const f = fixture(); f.call("exec_start", command, { jobId: "job", state: "running", chunks: [] });
    f.call(state === "cancelled" ? "exec_cancel" : "exec_poll", { jobId: "job" }, { jobId: "job", state, exitCode, chunks: [chunk("actual diagnostic")] });
    f.event("turn.completed");
    expect(f.status().commands).toMatchObject([{ state, exitCode, failed: true, detail: "actual diagnostic" }]);
    expect(f.status().verification).toBe("unrun");
  });
  it("keeps same-text commands with different jobs separate and ignores mismatched or denied receipts", () => {
    const f = fixture();
    for (const jobId of ["one", "two"]) f.call("exec_start", command, { jobId, state: "running" });
    f.call("exec_poll", { jobId: "one" }, { jobId: "two", state: "succeeded", exitCode: 0 });
    f.call("exec_cancel", { jobId: "one" }, "[denied] stale pollToken", true, true);
    expect(f.status().commands.map(row => row.state)).toEqual(["running", "running"]);
    f.call("exec_poll", { jobId: "two" }, { jobId: "two", state: "failed", exitCode: 4 });
    expect(f.status().commands.map(row => [row.jobId, row.state, row.exitCode])).toEqual([["one", "running", null], ["two", "failed", 4]]);
    expect(f.status().commands[0]!.detail).toContain("stale pollToken");
  });
  it("projects job recovery, unknown interruption and an ended turn without a terminal observation", () => {
    const f = fixture();
    for (const jobId of ["one", "two", "three"]) f.call("exec_start", command, { jobId, state: "running" });
    f.call("exec_jobs", {}, { jobs: [{ jobId: "one", state: "failed" }], interrupted: [{ jobId: "two", state: "unknown" }, { jobId: "unowned", state: "succeeded" }] });
    f.event("turn.cancelled");
    expect(f.status().commands.map(row => row.state)).toEqual(["failed", "unknown", "unknown"]);
    expect(f.status().commands[2]!.detail).toContain("without a confirmed command outcome");
    f.begin(); expect(f.status().commands).toEqual([]); expect(f.status().verification).toBe("unrun");
  });
  it("keeps malformed start outcomes unknown, preserves row/output bounds and redacts diagnostics", () => {
    const f = fixture();
    f.call("exec_start", command, "invalid JSON", false, true);
    expect(f.status().commands).toMatchObject([{ state: "unknown", exitCode: null, failed: true }]);
    const secret = "sk-" + "a".repeat(40);
    for (let i = 0; i < 25; i++) f.call("exec_start", { ...command, args: [String(i)] }, { jobId: String(i), state: "failed", exitCode: 1, incomplete: true, lostBytes: 12, chunks: [chunk("x".repeat(2200) + "\n" + secret)] });
    const status = f.status(); expect(status.commands).toHaveLength(20);
    expect(status.commands.every(row => row.detail.length <= 2000)).toBe(true);
    expect(JSON.stringify(status)).not.toContain(secret);
  });
});

it("shows the principal native managed process as well as its real verifier through Harness -> browser projection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "coding-managed-status-"));
  let step = 0, jobId = "", state = "", pollToken = 0;
  const provider: ModelProvider = { id: "coding-status-managed", listModels: async () => [{ id: "scripted", capabilities: { contextWindowTokens: 128000 } }],
    createClient: () => ({ async *generate(request) {
      step++;
      for (const message of request.messages.filter(message => message.role === "tool")) {
        jobId = [...message.content.matchAll(/"jobId"\s*:\s*"([^"]+)"/g)].at(-1)?.[1] ?? jobId;
        state = [...message.content.matchAll(/"state"\s*:\s*"([^"]+)"/g)].at(-1)?.[1] ?? state;
        pollToken = Number([...message.content.matchAll(/"pollToken"\s*:\s*(\d+)/g)].at(-1)?.[1] ?? pollToken);
      }
      if (step === 1) yield* ScriptedModelProvider.toolCall("exec_start", { command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('executed','actual');console.log('ACTUAL_MANAGED_RESULT');setTimeout(()=>{},200)"], yieldMs: 0 });
      else if (state === "running") yield* ScriptedModelProvider.toolCall("exec_poll", { jobId, pollToken, waitMs: 1000 });
      else yield* ScriptedModelProvider.text("Command finished.");
    } }),
  };
  const harness = await createHarness({ cwd, dataDir: join(cwd, "state"), profile: "test", modelProvider: provider, model: { providerId: provider.id, modelId: "scripted" },
    featureFlags: { skills: false, delegation: false, mcp: false, memory: false }, managedCommands: { enabled: true, maxJobMs: 5000 }, limits: { maxDurationMs: 10000, maxToolCalls: 15 },
    task: { id: "managed-status", goal: "Run and verify command", completionPolicy: { requiresVerification: true }, verification: [{ kind: "command", command: process.execPath,
      args: ["-e", "if(require('node:fs').readFileSync('executed','utf8')!=='actual')process.exit(1)"] }] } });
  let session: Session | undefined;
  let outcome: Awaited<ReturnType<typeof harness.runtime.runTurn>> | undefined;
  let messages: Message[] | undefined;
  let events: AgentEvent[] | undefined;
  let projection: ReturnType<typeof projectSessionHistory> | undefined;
  let status: ReturnType<typeof codingStatusOf> | undefined;
  let failed = false;
  try {
    session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
    const turn = await harness.runtime.startTurn(session.id, "Run the actual command and report its exit.");
    outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    session = (await harness.store.getSession(session.id))!;
    // Match the browser's consistent snapshot order: read messages before the
    // event prefix that commits them, and prove that no suffix was withheld.
    messages = await harness.store.listMessages(session.id);
    events = await harness.events.list(session.id);
    projection = projectSessionHistory({ session, messages, events });
    status = codingStatusOf(projection);
    const diagnostic = JSON.stringify({ outcome: { status: outcome.status, terminationReason: outcome.terminationReason, error: outcome.error },
      sourceCursor: projection.sourceCursor, finalSequence: events.at(-1)?.sequence, status });
    expect(outcome, diagnostic).toMatchObject({ status: "completed", terminationReason: "verified_complete" });
    expect(projection.sourceCursor, diagnostic).toBe(events.at(-1)?.sequence);
    expect(await readFile(join(cwd, "executed"), "utf8"), diagnostic).toBe("actual");
    expect(status.commands, diagnostic).toHaveLength(2);
    expect(status.commands[0], diagnostic).toMatchObject({ jobId, state: "succeeded", exitCode: 0, failed: false });
    expect(status.commands[0]!.detail, diagnostic).toContain("ACTUAL_MANAGED_RESULT");
    expect(status.commands[1]!.jobId, diagnostic).toBeUndefined(); expect(status.commands[1]!.exitCode, diagnostic).toBe(0);
    expect(status.verification, diagnostic).toBe("passed");
  } catch (error) {
    failed = true;
    const directory = process.env.E4_09_DIAG_DIR;
    if (directory) {
      try {
        if (session !== undefined) {
          messages ??= await harness.store.listMessages(session.id);
          events ??= await harness.events.list(session.id);
        }
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `coding-status-managed-${session?.id ?? process.pid}.json`), JSON.stringify({
          error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
          outcome, session, messages, events, projection, status,
        }, null, 2), { flag: "wx" });
      } catch (diagnosticError) {
        console.error("Could not preserve managed coding projection failure:", diagnosticError);
      }
    }
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try { await harness.close(); } catch (error) { cleanupErrors.push(error); }
    try { await rm(cwd, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length > 0) {
      const cleanupError = cleanupErrors.length === 1 ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, "Managed coding projection cleanup failed");
      if (!failed) throw cleanupError;
      console.error("Managed coding projection cleanup also failed:", cleanupError);
    }
  }
}, 30000);
