import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { newSessionId, newWorkingState } from "@ar/contracts";
import { scopedContextFromWorkingState } from "@ar/agents";
import { ScriptedModelProvider } from "@ar/model";
import { TaskVerifier, ProcessExecutor } from "@ar/tools";
import { DefaultChildWorkspaceManager } from "./workspace-manager.js";
import { MemSessionStore } from "./mem-stores.js";
import { createHarness } from "./create-harness.js";
import { defaultSandboxPolicy } from "@ar/core";

const directories: string[] = [];
async function scratch() { const dir = await mkdtemp(join(tmpdir(), "audit-boundary-")); directories.push(dir); return dir; }
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

it("B01/B02: protected constraints fail explicitly instead of being omitted or cut", () => {
  const state = newWorkingState("goal"); state.constraints = ["DO NOT DELETE /protected"];
  expect(() => scopedContextFromWorkingState(state, { maxEntries: 1 })).toThrow(/complete Constraints/);
  expect(() => scopedContextFromWorkingState(state, { maxBlockChars: 12 })).toThrow(/complete Constraints/);
  for (const budget of [0, -1, NaN, Infinity, 1.5]) expect(() => scopedContextFromWorkingState(state, { maxEntries: budget })).toThrow(RangeError);
});

it("B21: snapshot writes and reads cannot mutate the frozen policy by reference", async () => {
  const store = new MemSessionStore(); const id = newSessionId();
  const original = { tools: { allow: ["read_file"] } };
  await store.saveStateSnapshot(id, original); original.tools.allow.push("exec");
  const first = await store.loadStateSnapshot(id) as typeof original; first.tools.allow.push("write_file");
  expect(await store.loadStateSnapshot(id)).toEqual({ tools: { allow: ["read_file"] } });
});

it("B04: a tampered payload hash cannot mutate the parent's file", async () => {
  const root = await scratch(); await writeFile(join(root, "a.bin"), "parent");
  const manager = new DefaultChildWorkspaceManager(); const child = await manager.create({ parentRoot: root, childSessionId: newSessionId(), writable: true });
  try {
    await writeFile(join(child.root, "a.bin"), Buffer.from([255, 0, 254]));
    const patch = await child.diff(); patch.entries[0]!.contentHash = "0".repeat(64);
    const result = await manager.apply(root, patch);
    expect(result.applied).toEqual([]); expect(result.skipped[0]?.detail).toContain("hash mismatch");
    expect(await readFile(join(root, "a.bin"), "utf8")).toBe("parent");
  } finally { await child.dispose(); }
});

it.skipIf(process.platform === "win32")("B05: chmod-only changes propagate and concurrent parent chmod conflicts", async () => {
  const root = await scratch(); await writeFile(join(root, "script.sh"), "#!/bin/sh\nexit 0\n"); await chmod(join(root, "script.sh"), 0o644);
  const manager = new DefaultChildWorkspaceManager(); const child = await manager.create({ parentRoot: root, childSessionId: newSessionId(), writable: true });
  try {
    await chmod(join(child.root, "script.sh"), 0o755); const patch = await child.diff();
    expect(patch.entries[0]?.kind).toBe("modified"); await chmod(join(root, "script.sh"), 0o600);
    expect((await manager.apply(root, patch)).conflicts).toHaveLength(1);
    await chmod(join(root, "script.sh"), 0o644); expect((await manager.apply(root, patch)).applied).toEqual(["script.sh"]);
    expect((await stat(join(root, "script.sh"))).mode & 0o777).toBe(0o755);
  } finally { await child.dispose(); }
});

it("B16: a standalone verifier without an authorized command adapter fails closed", async () => {
  const root = await scratch(); const marker = join(root, "forbidden");
  const result = await new TaskVerifier().verify({ id: "audit", goal: "g", verification: [{ kind: "command", command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`] }] }, { sessionId: newSessionId(), cwd: root, changedPaths: [], transcript: "", runStartedAt: Date.now() });
  expect(result.passed).toBe(false); expect(result.checks[0]?.error?.message).toContain("authorized execution adapter");
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it("B16: an authorized structured command runs, and metacharacter argv remains inert", async () => {
  const root = await scratch(); const marker = join(root, "args.txt"); const literal = "literal; echo injected > another-file";
  const harness = await createHarness({ cwd: root, profile: "test", model: { providerId: "scripted", modelId: "scripted-model" }, modelProvider: new ScriptedModelProvider([ScriptedModelProvider.text("done")]), task: { id: "audit", goal: "g", verification: [{ kind: "command", command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},process.argv[1])`, literal] }] } });
  try {
    harness.agents[0]!.permissions = { rules: [], defaultEffect: "allow" };
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: root }); const turn = await harness.runtime.startTurn(session.id, "verify");
    const result = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(result.terminationReason).toBe("verified_complete"); expect(await readFile(marker, "utf8")).toBe(literal);
    await expect(readFile(join(root, "another-file"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await harness.events.list(session.id)).some((e) => e.type === "tool.intent_persisted")).toBe(true);
  } finally { await harness.close(); }
});

it("B19: cancellation during a real verification process reaps it and emits one cancelled terminal", async () => {
  const root = await scratch(); const ready = join(root, "ready"); const release = join(root, "release"); const escaped = join(root, "after-cancel"); const abort = new AbortController();
  const code = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){fs.writeFileSync(${JSON.stringify(escaped)},'bad');process.exit(0)}},10)`;
  const harness = await createHarness({ cwd: root, profile: "test", model: { providerId: "scripted", modelId: "scripted-model" }, modelProvider: new ScriptedModelProvider([ScriptedModelProvider.text("done")]), task: { id: "audit", goal: "g", verification: [{ kind: "command", command: process.execPath, args: ["-e", code] }] } });
  try {
    harness.agents[0]!.permissions = { rules: [], defaultEffect: "allow" };
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: root }); const turn = await harness.runtime.startTurn(session.id, "verify");
    const pending = harness.runtime.runTurn(session.id, turn.id, abort.signal);
    let started = false;
    for (let attempt = 0; attempt < 300; attempt++) { try { await readFile(ready); started = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }
    abort.abort(); expect(started).toBe(true); const result = await pending;
    await writeFile(release, "released"); await new Promise((resolve) => setTimeout(resolve, 100));
    expect(result.status).toBe("cancelled"); await expect(readFile(escaped)).rejects.toMatchObject({ code: "ENOENT" });
    const events = await harness.events.list(session.id); expect(events.filter((e) => e.type === "verification.completed")).toHaveLength(0); expect(events.filter((e) => e.type === "turn.cancelled")).toHaveLength(1);
  } finally { abort.abort(); await harness.close(); }
});

it("B19: an already aborted primitive never spawns an argv child", async () => {
  const root = await scratch(); const marker = join(root, "before-spawn"); const abort = new AbortController(); abort.abort();
  expect((await new ProcessExecutor().runArgv({ file: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`], cwd: root, signal: abort.signal })).status).toBe("cancelled");
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["read-only", "strong", "budget", "deadline"] as const)("B16: verification independently honors the %s execution boundary", async (boundary) => {
  const root = await scratch(); const workspace = join(root, "workspace"); await mkdir(workspace);
  const marker = join(root, "outside-workspace"); const sandbox = defaultSandboxPolicy();
  if (boundary === "read-only") sandbox.filesystem.mode = "read-only";
  if (boundary === "strong") sandbox.process.confinement = "strong";
  let reservations = 0;
  const harness = await createHarness({ cwd: workspace, profile: "test", sandboxPolicy: sandbox,
    model: { providerId: "scripted", modelId: "scripted-model" }, modelProvider: new ScriptedModelProvider([ScriptedModelProvider.text("done")]),
    ...(boundary === "budget" ? { toolDispatchBudget: { reserve: async () => { reservations++; return { ok: false, reason: "TOOL_BUDGET_EXHAUSTED", settle: async () => {} }; } } } : {}),
    ...(boundary === "deadline" ? { campaignDeadlineAtMs: Date.now() - 1 } : {}),
    task: { id: "audit", goal: "g", verification: [{ kind: "command", command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`] }] } });
  try {
    harness.agents[0]!.permissions = { rules: [], defaultEffect: "allow" };
    const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd: workspace });
    const turn = await harness.runtime.startTurn(session.id, "verify");
    const result = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
    expect(result.status).toBe("failed"); await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    if (boundary === "budget") expect(reservations).toBeGreaterThan(0);
    expect((await harness.events.list(session.id)).some((event) => event.type === "verification.completed")).toBe(false);
  } finally { await harness.close(); }
});
