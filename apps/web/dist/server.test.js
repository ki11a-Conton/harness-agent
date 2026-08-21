import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newAgentId, newApprovalId, newEventId } from "@ar/contracts";
import { AgentRuntime } from "@ar/core";
import { ScriptedModelProvider } from "@ar/model";
import { SessionService } from "@ar/session";
import { InMemoryApprovalStore } from "@ar/security";
import { createRuntimeRpc, Gateway } from "@ar/gateway";
import { WebChannelAdapter } from "./adapter.js";
import { SessionBindings, TrackingRegistry } from "./bindings.js";
import { WebServer, FROM_RE } from "./server.js";
const AGENT = {
    id: newAgentId(),
    name: "web-agent",
    description: "web console test agent",
    mode: "primary",
    model: { providerId: "scripted", modelId: "scripted-model" },
    systemPrompt: "you are a web console test agent",
    tools: {},
    permissions: { rules: [] },
    skills: {},
    limits: {},
};
/** In-memory SessionStore (mirrors gateway.test's fake — fakes are per-file). */
class MemSessionStore {
    sessions = new Map();
    turns = new Map();
    messages = [];
    async createSession(session) {
        this.sessions.set(session.id, session);
    }
    async getSession(id) {
        return this.sessions.get(id);
    }
    async updateSession(session) {
        this.sessions.set(session.id, session);
    }
    async listSessions() {
        return [...this.sessions.values()];
    }
    async createTurn(turn) {
        this.turns.set(turn.id, turn);
    }
    async getTurn(id) {
        return this.turns.get(id);
    }
    async updateTurn(turn) {
        this.turns.set(turn.id, turn);
    }
    async listTurns(sessionId) {
        return [...this.turns.values()].filter((t) => t.sessionId === sessionId);
    }
    async appendMessage(message) {
        this.messages.push(message);
    }
    async listMessages(sessionId) {
        return this.messages.filter((m) => m.sessionId === sessionId);
    }
    async listMessagesByTurn(sessionId, turnId) {
        return this.messages.filter((m) => m.sessionId === sessionId && m.turnId === turnId);
    }
    async saveStateSnapshot(_sessionId, _snapshot) { }
    async loadStateSnapshot() {
        return undefined;
    }
}
/** In-memory EventStore (mirrors gateway.test's fake). */
class MemEventStore {
    events = [];
    seq = 0;
    async nextSequence(_sessionId) {
        return this.seq + 1;
    }
    async append(event) {
        const seq = ++this.seq;
        const stored = { ...event, sequence: seq };
        this.events.push(stored);
        return stored;
    }
    async list(sessionId, opts) {
        let list = this.events.filter((e) => e.sessionId === sessionId);
        if (opts?.afterSequence !== undefined) {
            list = list.filter((e) => e.sequence > opts.afterSequence);
        }
        if (opts?.limit !== undefined) {
            list = list.slice(0, opts.limit);
        }
        return list;
    }
    async *stream(sessionId, opts) {
        for (const e of this.events) {
            if (e.sessionId !== sessionId)
                continue;
            if (opts?.afterSequence !== undefined && e.sequence <= opts.afterSequence)
                continue;
            yield e;
        }
    }
}
class FakeOrchestrator {
    calls = [];
    async execute(request, _context) {
        this.calls.push(request);
        return { status: "success", output: "ok" };
    }
}
const harnesses = [];
const readers = [];
async function makeHarness() {
    const store = new MemSessionStore();
    const events = new MemEventStore();
    const clock = { t: 1_000 };
    const provider = new ScriptedModelProvider([
        ScriptedModelProvider.text("ok"),
        ScriptedModelProvider.text("ok"),
        ScriptedModelProvider.text("ok"),
        ScriptedModelProvider.text("ok"),
    ]);
    const orchestrator = new FakeOrchestrator();
    const runtime = new AgentRuntime({
        store,
        events,
        modelProvider: provider,
        orchestrator,
        agents: [AGENT],
    });
    const sessionService = new SessionService({ store });
    const approvalStore = new InMemoryApprovalStore(() => clock.t);
    const rpc = createRuntimeRpc(runtime, { sessionService, approvalStore, events });
    const bindings = new SessionBindings();
    const gatewayRpc = new TrackingRegistry(rpc, (session) => bindings.onSessionCreated(session));
    const adapter = new WebChannelAdapter();
    const gateway = new Gateway({
        rpc: gatewayRpc,
        channels: [adapter],
        sessionService,
        approvalStore,
        events,
        sessionDefaults: { agentId: AGENT.id, cwd: "C:\\work" },
        pollDelayMs: 5,
    });
    await gateway.start();
    const server = new WebServer({
        adapter,
        bindings,
        events,
        store,
        approvalStore,
        host: "127.0.0.1",
        port: 0,
        pollDelayMs: 10,
    });
    const { port } = await server.start();
    const harness = {
        store,
        events,
        approvalStore,
        gateway,
        server,
        adapter,
        bindings,
        base: `http://127.0.0.1:${port}`,
        clock,
    };
    harnesses.push(harness);
    return harness;
}
afterEach(async () => {
    for (const reader of readers.splice(0))
        reader.close();
    for (const h of harnesses.splice(0)) {
        await h.server.stop();
        await h.gateway.stop();
    }
});
const USER = "web-user-1";
function postJson(h, path, body) {
    return fetch(`${h.base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}
async function openSse(h, from = USER) {
    const res = await fetch(`${h.base}/api/events?from=${encodeURIComponent(from)}`);
    expect(res.status).toBe(200);
    const reader = new SseReader(res);
    readers.push(reader);
    return reader;
}
async function waitFor(fn, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await fn();
        if (value !== undefined)
            return value;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out waiting");
}
/** Incremental SSE frame reader over a fetch stream. */
class SseReader {
    buffer = "";
    controller = new AbortController();
    reader;
    pendingRead;
    constructor(response) {
        const body = response.body;
        if (body === null)
            throw new Error("SSE response has no body");
        this.reader = body.getReader();
    }
    /**
     * Shared in-flight read: a read that loses the timeout race stays pending
     * here instead of becoming a ghost consumer of later frames.
     */
    readNext() {
        if (this.pendingRead === undefined) {
            this.pendingRead = this.reader.read().finally(() => {
                this.pendingRead = undefined;
            });
        }
        return this.pendingRead;
    }
    async next(timeoutMs = 4000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            while (true) {
                const idx = this.buffer.indexOf("\n\n");
                if (idx === -1)
                    break;
                const raw = this.buffer.slice(0, idx);
                this.buffer = this.buffer.slice(idx + 2);
                const dataLines = raw.split("\n").filter((l) => l.startsWith("data:"));
                if (dataLines.length === 0)
                    continue; // comment/keepalive frame
                const data = dataLines.map((l) => l.slice(5).trim()).join("\n");
                try {
                    return JSON.parse(data);
                }
                catch {
                    continue;
                }
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                break;
            try {
                const { value, done } = await Promise.race([
                    this.readNext(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("sse read timeout")), Math.max(1, remaining))),
                ]);
                if (done)
                    break;
                if (value !== undefined)
                    this.buffer += new TextDecoder().decode(value);
            }
            catch (err) {
                if (err instanceof Error && err.message === "sse read timeout") {
                    throw new Error("timed out waiting for an SSE frame");
                }
                break; // stream closed (abort/teardown)
            }
        }
        throw new Error("timed out waiting for an SSE frame");
    }
    close() {
        this.controller.abort();
        void this.reader.cancel().catch(() => { });
    }
}
async function waitForFrame(reader, predicate, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const frame = await reader.next(Math.max(250, deadline - Date.now()));
        if (predicate(frame))
            return frame;
    }
    throw new Error("timed out waiting for a matching SSE frame");
}
function isEvent(frame, type) {
    return (frame.type === "event" &&
        typeof frame.event === "object" &&
        frame.event !== null &&
        frame.event.type === type);
}
describe("WebServer HTTP", () => {
    it("serves the index page", async () => {
        const h = await makeHarness();
        const res = await fetch(`${h.base}/`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(await res.text()).toContain("<!DOCTYPE html>");
    });
    it("bootstrap returns a valid from and echoes a valid one", async () => {
        const h = await makeHarness();
        const generated = (await (await fetch(`${h.base}/api/bootstrap`)).json());
        expect(generated.from).toMatch(FROM_RE);
        const echoed = (await (await fetch(`${h.base}/api/bootstrap?from=abc-12345`)).json());
        expect(echoed.from).toBe("abc-12345");
        // Invalid candidates are rejected and replaced with a fresh id.
        const replaced = (await (await fetch(`${h.base}/api/bootstrap?from=bad!from`)).json());
        expect(replaced.from).toMatch(FROM_RE);
        expect(replaced.from).not.toBe("bad!from");
    });
    it("rejects malformed message bodies", async () => {
        const h = await makeHarness();
        const empty = await postJson(h, "/api/messages", {});
        expect(empty.status).toBe(400);
        const blankText = await postJson(h, "/api/messages", { from: USER, text: "   " });
        expect(blankText.status).toBe(400);
        const missingFrom = await postJson(h, "/api/messages", { text: "hi" });
        expect(missingFrom.status).toBe(400);
        const badFrom = await postJson(h, "/api/messages", { from: "bad!from", text: "hi" });
        expect(badFrom.status).toBe(400);
        const notJson = await fetch(`${h.base}/api/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "not json",
        });
        expect(notJson.status).toBe(400);
    });
    it("accepts a valid message and creates a session", async () => {
        const h = await makeHarness();
        const res = await postJson(h, "/api/messages", { from: USER, text: "hello agent" });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        const sessions = await h.store.listSessions();
        expect(sessions).toHaveLength(1);
        expect(h.bindings.get(USER)).toBe(sessions[0].id);
    });
    it("rejects non-command text on the commands endpoint", async () => {
        const h = await makeHarness();
        const res = await postJson(h, "/api/commands", { from: USER, text: "please run a turn" });
        expect(res.status).toBe(400);
    });
    it("accepts approve and cancel command shapes", async () => {
        const h = await makeHarness();
        // Unknown approval ids are the gateway's concern — the shape itself is accepted.
        const approve = await postJson(h, "/api/commands", { from: USER, text: "approve:appr_x1:allow" });
        expect(approve.status).toBe(200);
        const deny = await postJson(h, "/api/commands", { from: USER, text: "approve:appr_x1:deny" });
        expect(deny.status).toBe(200);
        const cancel = await postJson(h, "/api/commands", { from: USER, text: "cancel" });
        expect(cancel.status).toBe(200);
        const badValue = await postJson(h, "/api/commands", { from: USER, text: "approve:appr_x1:maybe" });
        expect(badValue.status).toBe(400);
        const caps = await postJson(h, "/api/commands", { from: USER, text: "Cancel" });
        expect(caps.status).toBe(400);
    });
});
describe("WebServer SSE", () => {
    it("sends a hello frame on connect", async () => {
        const h = await makeHarness();
        const reader = await openSse(h);
        const frame = await reader.next();
        expect(frame).toEqual({ type: "hello" });
    });
    it("adapter.send pushes text frames to the connected recipient only", async () => {
        const h = await makeHarness();
        const readerA = await openSse(h, "web-user-a");
        expect((await readerA.next()).type).toBe("hello");
        await h.adapter.send("web-user-a", "[run] completed turn:t1");
        const pushed = await waitForFrame(readerA, (f) => f.type === "text");
        expect(pushed.text).toBe("[run] completed turn:t1");
        // A second recipient never sees the first recipient's push.
        const readerB = await openSse(h, "web-user-b");
        expect((await readerB.next()).type).toBe("hello");
        await h.adapter.send("web-user-b", "only-b");
        expect((await waitForFrame(readerB, (f) => f.type === "text")).text).toBe("only-b");
        // A's stream is now quiet.
        await expect(readerA.next(250)).rejects.toThrow(/timed out/);
    });
    it("send to a stranger does not throw", async () => {
        const h = await makeHarness();
        await expect(h.adapter.send("nobody_here", "hello?")).resolves.toBeUndefined();
    });
    it("streams a full turn as raw events and assistant text", async () => {
        const h = await makeHarness();
        const reader = await openSse(h);
        expect((await reader.next()).type).toBe("hello");
        const res = await postJson(h, "/api/messages", { from: USER, text: "hello agent" });
        expect(res.status).toBe(200);
        const seen = new Set();
        // The gateway's [run] text reply and the raw event frames race each other
        // (separate poll loops), so collect both until turn.completed is observed.
        let runReply;
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline && (!seen.has("turn.completed") || runReply === undefined)) {
            const frame = await reader.next(Math.max(250, deadline - Date.now()));
            if (isEvent(frame, "turn.completed"))
                seen.add("turn.completed");
            if (frame.type === "text" && String(frame.text).startsWith("[run]"))
                runReply = frame;
        }
        expect(seen.has("turn.completed")).toBe(true);
        expect(runReply?.text).toMatch(/completed/);
        const startIdx = (await h.events.list(h.bindings.get(USER))).length;
        const events = await h.events.list(h.bindings.get(USER));
        expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["session.created", "turn.started", "model.started", "model.completed", "turn.completed"]));
        expect(startIdx).toBeGreaterThan(0);
        // Assistant text arrives as a block frame (runtime does not store deltas).
        const text = await waitForFrame(reader, (f) => f.type === "assistant_text");
        expect(text.text).toBe("ok");
    });
    it("approve command resolves a pending approval and emits human.approval", async () => {
        const h = await makeHarness();
        const reader = await openSse(h);
        await reader.next(); // hello
        await postJson(h, "/api/messages", { from: USER, text: "start" });
        const sessionId = (await h.store.listSessions())[0].id;
        const request = {
            id: newApprovalId(),
            sessionId,
            agentId: AGENT.id,
            action: "exec",
            target: "rm -rf /tmp/x",
            reason: "risky command",
            createdAt: h.clock.t,
            expiresAt: h.clock.t + 60_000,
        };
        h.approvalStore.create(request);
        const res = await postJson(h, "/api/commands", {
            from: USER,
            text: `approve:${request.id}:allow`,
        });
        expect(res.status).toBe(200);
        await waitForFrame(reader, (f) => f.type === "text" && String(f.text).startsWith("[approve]"));
        const human = await waitFor(async () => (await h.events.list(sessionId)).find((e) => e.type === "human.approval"));
        expect(human.payload).toMatchObject({ approvalId: request.id, value: "allow" });
    });
    it("history and sessions endpoints report the stored session", async () => {
        const h = await makeHarness();
        await postJson(h, "/api/messages", { from: USER, text: "hello agent" });
        const sessionId = h.bindings.get(USER);
        await waitFor(async () => {
            const turns = sessionId === undefined ? [] : await h.store.listTurns(sessionId);
            return turns[0]?.status === "completed" ? turns[0] : undefined;
        });
        const history = (await (await fetch(`${h.base}/api/history?from=${USER}`)).json());
        expect(history.sessionId).toBe(sessionId);
        const roles = history.messages.map((m) => m.role);
        expect(roles).toContain("user");
        expect(roles).toContain("assistant");
        expect(history.messages.find((m) => m.role === "assistant")?.content).toBe("ok");
        const list = (await (await fetch(`${h.base}/api/sessions`)).json());
        expect(list.sessions).toContainEqual(expect.objectContaining({ from: USER, sessionId, firstText: "hello agent" }));
    });
});
describe("Frontend assets", () => {
    it("app.js parses under node --check", () => {
        const file = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "app.js");
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    });
});
//# sourceMappingURL=server.test.js.map