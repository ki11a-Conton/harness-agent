import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, link, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import { newEventId, newPromptId, type SandboxPolicy } from "@ar/contracts";
import { unzipSync, strFromU8 } from "fflate";
import { createHostTools } from "./host-tools.js";
import { createFilesService, workspaceMkdirTool, workspaceReadTool } from "./files.js";
import { createWorkspaceService } from "./workspace.js";
import { createTerminalService } from "./terminal.js";
import { createDeliverablesService } from "./deliverables.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function setup(options: { provider?: ScriptedModelProvider; sandbox?: SandboxPolicy } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deepseek-workspace-real-")));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 8 : 0, retryDelay: 50 }));
  const cwd = join(root, "project"), dataDir = join(root, "host-state");
  await Promise.all([mkdir(cwd), mkdir(dataDir)]);
  const provider = options.provider ?? new ScriptedModelProvider([ScriptedModelProvider.text("actual answer")]);
  const harness = await createHarness({ cwd, dataDir, profile: "test", modelProvider: provider, model: { providerId: provider.id, modelId: "scripted-model" }, ...(options.sandbox ? { sandboxPolicy: options.sandbox } : {}) });
  cleanup.push(() => harness.close());
  const tools = createHostTools(harness, cwd, dataDir);
  tools.registerTool(workspaceReadTool); tools.registerTool(workspaceMkdirTool);
  const host = { harness, cwd, dataDir, ...tools };
  const workspace = createWorkspaceService(host), files = createFilesService(host), terminal = createTerminalService(host), deliverables = createDeliverablesService(host);
  cleanup.push(async () => { await terminal.dispose(); deliverables.dispose(); });
  const session = await harness.runtime.createSession({ agent: harness.agents[0]!, cwd });
  const signal = new AbortController().signal;
  return { root, cwd, dataDir, harness, host, tools, workspace, files, terminal, deliverables, session, signal };
}

it("returns real bounded pages, byte ranges and the workspace file tree", async () => {
  const s = await setup();
  await mkdir(join(s.cwd, "src")); await writeFile(join(s.cwd, "src", "真实.ts"), "first\n第二行\nthird\n");
  const base = { workspaceFileScopeId: s.session.id };
  expect(await s.files.call("workspaceFiles/list", { ...base, path: "src" }, s.signal)).toMatchObject({ path: "src", entries: [{ name: "真实.ts", type: "file" }], truncated: false });
  expect(await s.files.call("workspaceFiles/read", { ...base, path: "src/真实.ts", range: { offset: 2, limit: 1 } }, s.signal)).toMatchObject({ text: "第二行", lines: 1, offset: 2, eof: false });
  expect(await s.files.call("workspaceFiles/read", { ...base, path: "src/真实.ts", range: { offset: 4 } }, s.signal)).toMatchObject({ text: "", lines: 0, eof: true });
  const bytes = await s.files.call("workspaceFiles/readBytes", { ...base, path: "真实.ts", options: { baseFile: "src/base.ts", range: { offset: 0, length: 5 } } }, s.signal) as { data: Uint8Array; eof: boolean };
  expect(Buffer.from(bytes.data).toString()).toBe("first"); expect(bytes.eof).toBe(false);
});

it("directory changes start ready and observe both child modifications and deletion without treating directories as regular files", async () => {
  const s = await setup(); await writeFile(join(s.cwd, "item.txt"), "before");
  const controller = new AbortController();
  const watch = s.files.stream("workspaceFiles/changes", { workspaceFileScopeId: s.session.id, path: "" }, controller.signal)[Symbol.asyncIterator]();
  expect((await watch.next()).value).toEqual({ kind: "ready" });
  await writeFile(join(s.cwd, "item.txt"), "actual modification");
  expect((await watch.next()).value).toMatchObject({ kind: "change", change: { absolutePath: s.cwd, version: expect.any(String) } });
  await rm(join(s.cwd, "item.txt"));
  expect((await watch.next()).value).toMatchObject({ kind: "change", change: { absolutePath: s.cwd } });
  controller.abort(); expect((await watch.next()).done).toBe(true);
});

it("a file watch observes deletion and recreation in the same generation", async () => {
  const s = await setup(); const path = join(s.cwd, "restore.txt"); await writeFile(path, "before");
  const controller = new AbortController();
  const feed = s.files.stream("workspaceFiles/changes", { workspaceFileScopeId: s.session.id, path: "restore.txt" }, controller.signal)[Symbol.asyncIterator]();
  expect((await feed.next()).value).toEqual({ kind: "ready" });
  await rm(path); expect((await feed.next()).value).toMatchObject({ kind: "change", change: { absolutePath: path, absent: true } });
  await writeFile(path, "restored content"); expect((await feed.next()).value).toMatchObject({ kind: "change", change: { absolutePath: path, version: expect.any(String) } });
  controller.abort(); expect((await feed.next()).done).toBe(true);
});

it("preview and references reject traversal, unknown Session, escaping symlinks and protected credentials", async () => {
  const s = await setup(); await writeFile(join(s.root, "outside.txt"), "external content");
  const base = { workspaceFileScopeId: s.session.id, range: {} };
  await expect(s.files.call("workspaceFiles/read", { ...base, path: "../outside.txt" }, s.signal)).rejects.toMatchObject({ code: "gateway/forbidden" });
  await expect(s.files.call("workspaceFiles/read", { ...base, workspaceFileScopeId: "unknown", path: "a" }, s.signal)).rejects.toMatchObject({ code: "session/not-found" });
  await symlink(join(s.root, "outside.txt"), join(s.cwd, "link.txt"));
  await expect(s.files.call("workspaceFiles/read", { ...base, path: "link.txt" }, s.signal)).rejects.toMatchObject({ code: "gateway/forbidden" });
  await writeFile(join(s.cwd, ".env"), "NORMAL=value");
  await expect(s.files.call("workspaceFiles/read", { ...base, path: ".env" }, s.signal)).rejects.toMatchObject({ code: "gateway/forbidden" });
  await writeFile(join(s.cwd, "token.txt"), `ghp_${"a".repeat(36)}`);
  await expect(s.files.call("workspaceFiles/read", { ...base, path: "token.txt" }, s.signal)).rejects.toMatchObject({ code: "gateway/forbidden" });
  await expect(s.files.call("fileReferences/list", { agentId: s.session.id, query: "../" }, s.signal)).rejects.toMatchObject({ code: "workspace-file/outside-workspace" });
});

it("permission denial and pre-aborted calls leave directory writes untouched", async () => {
  const s = await setup({ sandbox: { filesystem: { mode: "read-only" }, network: { mode: "deny" }, process: {} } });
  expect(await s.host.executeTool(s.session.id, workspaceMkdirTool.name, { path: s.cwd, name: "must-not-exist" }, s.signal)).toMatchObject({ status: "denied" });
  expect(await s.files.call("directoryPicker/list", { path: s.cwd }, s.signal)).toMatchObject({ entries: [] });
  const cancelled = new AbortController(); cancelled.abort();
  await expect(s.files.call("directoryPicker/createDirectory", { path: s.cwd, name: "also-absent" }, cancelled.signal)).rejects.toBeDefined();
  expect(await s.files.call("directoryPicker/list", { path: s.cwd }, s.signal)).toMatchObject({ entries: [] });
});

it("text pages and byte ranges scan the complete bounded credential snapshot while ordinary binary ranges still work", async () => {
  const s = await setup(); await writeFile(join(s.cwd, "normal-config.txt"), `Visible harmless first line\nAuthorization: Bearer ${"a".repeat(48)}\nSafe last line\n`);
  const base = { workspaceFileScopeId: s.session.id, path: "normal-config.txt" };
  await expect(s.files.call("workspaceFiles/read", { ...base, range: { offset: 1, limit: 1 } }, s.signal)).rejects.toMatchObject({ code: "gateway/forbidden" });
  await expect(s.files.call("workspaceFiles/readBytes", { ...base, options: { range: { offset: 0, length: 7 } } }, s.signal)).rejects.toMatchObject({ code: "gateway/forbidden" });
  await writeFile(join(s.cwd, "normal-binary.dat"), new Uint8Array([0, 255, 128, 1, 2, 3]));
  const result = await s.files.call("workspaceFiles/readBytes", { workspaceFileScopeId: s.session.id, path: "normal-binary.dat", options: { range: { offset: 1, length: 3 } } }, s.signal) as { data: Uint8Array; eof: boolean };
  expect([...result.data]).toEqual([255, 128, 1]); expect(result.eof).toBe(false);
  await expect(s.files.call("workspaceFiles/read", { workspaceFileScopeId: s.session.id, path: "normal-binary.dat", range: {} }, s.signal)).rejects.toMatchObject({ code: "workspace-file/not-text" });
});

it("workspaces persist pin, soft archive, undo and order, while hidden failed host identities never enter membership", async () => {
  const s = await setup();
  const created = await s.workspace.call("workspace/create", { request: { path: s.cwd } }, s.signal) as { workspace: { workspaceId: string } };
  const call = (name: string, request: Record<string, unknown>) => s.workspace.call(name, { request }, s.signal);
  await call("workspace/pinSession", { sessionId: s.session.id });
  await call("workspace/archiveSession", { sessionId: s.session.id });
  expect(await s.harness.store.getSession(s.session.id)).toBeDefined();
  expect(await s.workspace.getArchivedIds()).toEqual([s.session.id]);
  await call("workspace/unarchiveSession", { sessionId: s.session.id }); await call("workspace/pinSession", { sessionId: s.session.id });
  const restarted = createWorkspaceService(s.host); const controller = new AbortController();
  const feed = restarted.stream("workspace/follow", {}, controller.signal)[Symbol.asyncIterator]();
  expect((await feed.next()).value).toMatchObject({ type: "baseline", value: { items: [{ workspaceId: created.workspace.workspaceId, sessionIds: [s.session.id] }], pinnedSessionIds: [s.session.id], archivedSessionIds: [] } });
  controller.abort(); await feed.return?.();
  const raw = await readFile(join(s.dataDir, "deepseek", "workspace-metadata.json"), "utf8");
  expect(raw).not.toContain([...s.tools.hidden][0]);
  await expect(call("workspace/pinSession", { sessionId: [...s.tools.hidden][0] })).rejects.toMatchObject({ code: "session/not-found" });
});

it("archive never reports a durable queued prompt cancelled when its actor has no running turn", async () => {
  const s = await setup(); const promptId = newPromptId();
  await s.harness.inbox.admit({ id: promptId, sessionId: s.session.id, kind: "followup", status: "pending", text: "Retained queued work", admittedAt: Date.now() });
  const request = { sessionId: s.session.id };
  await expect(s.workspace.call("workspace/archiveSession", { request }, s.signal)).rejects.toMatchObject({ code: "workspace/session-active", details: { activity: [{ kind: "queued-prompt", items: [{ id: promptId }] }] } });
  await expect(s.workspace.call("workspace/archiveSession", { request: { ...request, stopActivity: true } }, s.signal)).rejects.toMatchObject({ code: "workspace/session-active" });
  expect(await s.workspace.getArchivedIds()).toEqual([]); expect(await s.harness.inbox.listAll(s.session.id)).toMatchObject([{ id: promptId, status: "pending" }]);
  expect(await s.harness.store.listTurns(s.session.id)).toEqual([]);
});

it("real uploaded bytes retain their receipt across restart and cannot be admitted by a different Session", async () => {
  const s = await setup(), bytes = Buffer.from("const 名称 = 42;\n");
  const uploaded = await s.deliverables.call("fileUploads/upload", { agentId: s.session.id, request: { data: bytes.toString("base64"), name: "../../真实.ts" } }, s.signal) as { receiptId: string; file: { name: string; bytes: number } };
  expect(uploaded.file).toMatchObject({ name: "真实.ts", bytes: bytes.length });
  const restarted = createDeliverablesService({ ...s.host, ...createHostTools(s.harness, s.cwd, s.dataDir) });
  expect(await restarted.resolveUpload(s.session.id, uploaded.receiptId, s.signal)).toMatchObject({ text: bytes.toString(), file: uploaded.file });
  const other = await s.harness.runtime.createSession({ agent: s.harness.agents[0]!, cwd: s.cwd });
  await expect(restarted.resolveUpload(other.id, uploaded.receiptId, s.signal)).rejects.toMatchObject({ code: "session/attachment-invalid" });
  await expect(s.deliverables.call("fileUploads/upload", { agentId: s.session.id, request: { data: "eA=", name: "wrong" } }, s.signal)).rejects.toMatchObject({ code: "session/attachment-invalid" });
});

it("raw HTTP upload validates its carrier, caps streamed bytes and reports unsupported binary admission truthfully", async () => {
  const s = await setup(); const url = `http://localhost/api/session/uploadFileBinary?sessionId=${s.session.id}&name=raw.dat`;
  expect((await s.deliverables.fetch(new Request(url)))?.status).toBe(405);
  expect((await s.deliverables.fetch(new Request(url, { method: "POST", body: "plain" })))?.status).toBe(415);
  const response = await s.deliverables.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array([0, 255, 12]) }));
  const result = await response!.json() as { ok: true; value: { receiptId: string } }; expect(result.ok).toBe(true);
  await expect(s.deliverables.resolveUpload(s.session.id, result.value.receiptId, s.signal)).rejects.toMatchObject({ code: "session/attachment-invalid" });
  const oversized = await s.deliverables.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/octet-stream", "content-length": "4194305" }, body: "x" }));
  expect(await oversized!.json()).toMatchObject({ ok: false, error: { code: "session/attachment-invalid" } });
});

it("a private upload receipt cannot be replaced by a hard link to a retained outside document", async () => {
  const s = await setup(); const uploaded = await s.deliverables.call("fileUploads/upload", { agentId: s.session.id, request: { data: Buffer.from("Actual uploaded text\n").toString("base64"), name: "proof.txt" } }, s.signal) as { receiptId: string };
  const path = join(s.dataDir, "deepseek", "uploads", createHash("sha256").update(s.session.id).digest("hex"), `${uploaded.receiptId}.json`), outside = join(s.root, "retained-upload.json");
  const bytes = await readFile(path, "utf8"); await writeFile(outside, bytes); await rm(path); await link(outside, path);
  await expect(s.deliverables.resolveUpload(s.session.id, uploaded.receiptId, s.signal)).rejects.toMatchObject({ code: "session/attachment-invalid" }); expect(await readFile(outside, "utf8")).toBe(bytes);
});

it("turn captures compare actual coding edits with stable source coordinates, and old uncaptured history never returns today's diff", async () => {
  const provider = new ScriptedModelProvider([ScriptedModelProvider.toolCall("write_file", { path: "actual.txt", content: "first\nnew\n" }), ScriptedModelProvider.text("Written")]);
  const s = await setup({ provider }); await writeFile(join(s.cwd, "actual.txt"), "first\nold\n");
  const append = s.harness.events.appendNew.bind(s.harness.events);
  let immediatelyVisible = false;
  let published!: () => void; const publication = new Promise<void>(done => { published = done; });
  let captureFinished!: () => void; const captureCompletion = new Promise<void>(done => { captureFinished = done; });
  s.harness.events.appendNew = async event => {
    const committed = await append(event);
    if (committed.payload.tool === "web_workspace_changes") {
      const duringPublish = await s.deliverables.fetch(new Request(`http://localhost/api/changes.summary?sessionId=${s.session.id}&seq=${committed.sequence}`));
      immediatelyVisible = duringPublish?.status === 200;
      published();
    }
    await s.deliverables.observe(committed);
    if (["turn.completed", "turn.failed", "turn.cancelled"].includes(committed.type)) captureFinished();
    return committed;
  };
  const actor = await s.harness.sessions.load(s.session.id); await actor.enqueueFollowup({ sessionId: s.session.id, text: "Edit actual.txt" });
  // The terminal event is emitted only after the terminal record is durable.
  // Wait for the actual observer/capture boundary, not a 500-poll speed budget.
  await captureCompletion;
  expect(await s.harness.store.listTurns(s.session.id)).toMatchObject([{ status: "completed" }]);
  let announcement = (await s.harness.events.list(s.session.id)).find(event => event.payload.tool === "web_workspace_changes");
  for (let i = 0; i < 100 && !announcement; i++) { await new Promise(done => setTimeout(done, 5)); announcement = (await s.harness.events.list(s.session.id)).find(event => event.payload.tool === "web_workspace_changes"); }
  expect(announcement).toBeDefined();
  await publication;
  expect(immediatelyVisible).toBe(true);
  // The public HTTP lookup must already work at announcement publication.
  // Numeric in-process convenience keys settle after that append returns.
  await captureCompletion;
  expect(s.deliverables.summary(s.session.id, announcement!.sequence)).toEqual({ turn: 1, files: [{ path: "actual.txt", display: "actual.txt", added: 1, deleted: 1 }], total: 1, added: 1, deleted: 1 });
  expect(await s.deliverables.diff(s.session.id, announcement!.sequence, 0, s.signal)).toMatchObject({ kind: "text", before: true, after: true, hunks: [{ lines: [" first", "-old", "+new"] }], coarse: false });
  await writeFile(join(s.cwd, "actual.txt"), "later unrelated change");
  const response = await s.deliverables.fetch(new Request(`http://localhost/api/changes.diff?sessionId=${s.session.id}&seq=${announcement!.sequence}&index=0`));
  expect((await response!.json()) as unknown).toMatchObject({ kind: "text", hunks: [{ lines: [" first", "-old", "+new"] }] });
  const restarted = createDeliverablesService({ ...s.host, ...createHostTools(s.harness, s.cwd, s.dataDir) });
  expect((await restarted.fetch(new Request(`http://localhost/api/changes.summary?sessionId=${s.session.id}&seq=${announcement!.sequence}`)))?.status).toBe(404);
});

async function checkFormatCapture(before: string, after: string, marker: string, delayMs = 0) {
  const edit = ScriptedModelProvider.toolCall("write_file", { path: "format.txt", content: after });
  const provider = new ScriptedModelProvider([delayMs === 0 ? edit : (async function* () {
    await new Promise(done => setTimeout(done, delayMs));
    yield* edit;
  })(), ScriptedModelProvider.text("Written")]);
  const s = await setup({ provider });
  await writeFile(join(s.cwd, "format.txt"), before);
  const append = s.harness.events.appendNew.bind(s.harness.events);
  let captured!: () => void; const ready = new Promise<void>(resolve => { captured = resolve; });
  s.harness.events.appendNew = async event => {
    const committed = await append(event); await s.deliverables.observe(committed);
    if (["turn.completed", "turn.failed", "turn.cancelled"].includes(committed.type)) captured();
    return committed;
  };
  const actor = await s.harness.sessions.load(s.session.id); await actor.enqueueFollowup({ sessionId: s.session.id, text: "Change file format" });
  await ready;
  expect(await s.harness.store.listTurns(s.session.id)).toMatchObject([{ status: "completed" }]);
  const announcement = (await s.harness.events.list(s.session.id)).find(event => event.payload.tool === "web_workspace_changes")!;
  expect(announcement).toBeDefined();
  const response = await s.deliverables.fetch(new Request(`http://localhost/api/changes.diff?sessionId=${s.session.id}&seq=${announcement.sequence}&index=0`));
  const diff = await response!.json() as { hunks: Array<{ lines: string[] }> };
  expect(diff.hunks).not.toEqual([]); expect(JSON.stringify(diff.hunks)).toContain(marker);
  expect(await readFile(join(s.cwd, "format.txt"), "utf8")).toBe(after);
}

it.each([
  { before: "line", after: "line\n", marker: "No newline at end of file" },
  { before: "line\n", after: "\uFEFFline\n", marker: "\uFEFFline" },
])("actual turn capture retains a format-only coding change ($marker)", async ({ before, after, marker }) => {
  await checkFormatCapture(before, after, marker);
});

it("actual format-only capture waits for committed completion beyond the old polling budget", async () => {
  // The real provider delays its first result; no terminal record or filesystem
  // output is fabricated. The old 500 x 5ms store polling must fail here.
  await checkFormatCapture("line\n", "\uFEFFline\n", "\uFEFFline", 3500);
});

it("exports a genuine ZIP of owned durable records and rejects malformed coordinates/native desktop actions", async () => {
  const s = await setup();
  await s.harness.events.appendNew({ id: newEventId(), sessionId: s.session.id, timestamp: Date.now(), type: "human.message", payload: { text: "durable proof" } });
  const response = await s.deliverables.fetch(new Request(`http://localhost/api/session.export?sessionId=${s.session.id}&includeDescendants=true`));
  expect(response?.headers.get("content-type")).toBe("application/zip");
  const preflight = await s.deliverables.fetch(new Request(`http://localhost/api/session.export?sessionId=${s.session.id}&includeDescendants=true`, { method: "HEAD" }));
  expect(preflight?.status).toBe(200); expect(preflight?.headers.get("content-type")).toBe("application/zip"); expect(await preflight!.text()).toBe("");
  expect((await s.deliverables.fetch(new Request("http://localhost/api/session.export?sessionId=unknown", { method: "HEAD" })))?.status).toBe(404);
  const zip = unzipSync(new Uint8Array(await response!.arrayBuffer()));
  const manifest = JSON.parse(strFromU8(zip["manifest.json"]!)); expect(manifest.sessionIds).toEqual([s.session.id]);
  expect(Object.entries(zip).some(([name, content]) => name.endsWith("/events.json") && strFromU8(content).includes("durable proof"))).toBe(true);
  expect((await s.deliverables.fetch(new Request(`http://localhost/api/session.export?sessionId=${s.session.id}&includeDescendants=garbage`)))?.status).toBe(400);
  expect((await s.deliverables.fetch(new Request(`http://localhost/api/changes.summary?sessionId=${s.session.id}&seq=-1`)))?.status).toBe(400);
  expect(await (await s.deliverables.fetch(new Request("http://localhost/api/present.host")))!.json()).toMatchObject({ available: false, fileManager: null });
  expect((await s.deliverables.fetch(new Request(`http://localhost/api/present.open?sessionId=${s.session.id}&seq=0&index=0`, { method: "POST" })))?.status).toBe(409);
});

it("PTY refuses a read-only Session before allocating a process and rejects cross-Session terminal control", async () => {
  const s = await setup({ sandbox: { filesystem: { mode: "read-only" }, network: { mode: "deny" }, process: {} } });
  await expect(s.terminal.call("terminal/create", { agentId: s.session.id, request: { id: "terminal-id", cols: 80, rows: 24 } }, s.signal)).rejects.toMatchObject({ code: "terminal/unavailable" });
  expect(await s.terminal.call("terminal/list", { sessionId: s.session.id }, s.signal)).toEqual([]);
  await expect(s.terminal.call("terminal/write", { agentId: s.session.id, id: "foreign-terminal", attachmentId: "mine", data: "touch unexpected\n" }, s.signal)).rejects.toMatchObject({ code: "terminal/unavailable" });
  expect(await s.files.call("workspaceFiles/list", { workspaceFileScopeId: s.session.id, path: "" }, s.signal)).toMatchObject({ entries: [] });
});

it("the real PTY provider either proves confined input/resize/process cleanup or refuses unsupported confinement without allocating a terminal", async () => {
  const s = await setup();
  let created: unknown;
  try { created = await s.terminal.call("terminal/create", { agentId: s.session.id, request: { id: "actual-pty", cols: 80, rows: 24 } }, s.signal); }
  catch (error) {
    expect(error).toMatchObject({ code: "terminal/unavailable", details: { code: "SANDBOX_BACKEND_DENIED", platform: process.platform } });
    expect(await s.terminal.call("terminal/list", { sessionId: s.session.id }, s.signal)).toEqual([]);
    expect(s.terminal.active(s.session.id)).toEqual([]);
    return;
  }
  expect(created).toMatchObject({ id: "actual-pty", state: "running" });
  const controller = new AbortController(), attachmentId = "verified-controller";
  const feed = s.terminal.stream("terminal/follow", { agentId: s.session.id, id: "actual-pty", attachmentId }, controller.signal)[Symbol.asyncIterator]();
  expect((await feed.next()).value).toMatchObject({ type: "snapshot", sequence: 0, info: { controllerId: attachmentId } });
  await s.terminal.call("terminal/resize", { agentId: s.session.id, id: "actual-pty", attachmentId, cols: 100, rows: 30 }, s.signal);
  await expect(s.terminal.call("terminal/write", { agentId: s.session.id, id: "actual-pty", attachmentId: "foreign", data: "unexpected\n" }, s.signal)).rejects.toMatchObject({ code: "terminal/control-unavailable" });
  const data = process.platform === "win32" ? "Set-Content -LiteralPath terminal-proof.txt -Value 'ACTUAL_PTY_FILE';\r\n" : "printf 'ACTUAL_PTY_FILE\\n' > terminal-proof.txt\n";
  await s.terminal.call("terminal/write", { agentId: s.session.id, id: "actual-pty", attachmentId, data }, s.signal);
  let actual: unknown;
  for (let i = 0; i < 200; i++) {
    try { actual = await s.files.call("workspaceFiles/read", { workspaceFileScopeId: s.session.id, path: "terminal-proof.txt", range: {} }, s.signal); break; } catch { await new Promise(done => setTimeout(done, 10)); }
  }
  expect(actual).toMatchObject({ text: expect.stringContaining("ACTUAL_PTY_FILE") });
  await s.terminal.closeSession(s.session.id, s.signal);
  expect(await s.terminal.call("terminal/list", { sessionId: s.session.id }, s.signal)).toEqual([]); expect(s.terminal.active(s.session.id)).toEqual([]);
  controller.abort(); await feed.return?.();
  await expect(s.terminal.call("terminal/create", { agentId: s.session.id, request: { id: "actual-pty", cols: 80, rows: 24 } }, s.signal)).rejects.toMatchObject({ code: "terminal/unavailable" });
});
