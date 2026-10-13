import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { newAgentId, newSessionId } from "@ar/contracts";
import { DurableApprovalStore, InMemoryApprovalStore, StoreApprovalResolver } from "./approval.js";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

it("browser cancellation removes its pending approval and commits one durable decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "approval-disconnect-")); directories.push(directory);
  const path = join(directory, "approvals.json"); const store = new DurableApprovalStore(path);
  const resolver = new StoreApprovalResolver(store); const sessionId = newSessionId();
  const request = resolver.createApprovalRequest({ sessionId, agentId: newAgentId(), action: "exec", target: "fixture-shell", reason: "Private browser operation" });
  const controller = new AbortController(); const waiting = resolver.resolve(request, controller.signal);
  expect(store.listPending(sessionId)).toHaveLength(1);
  controller.abort(); expect((await waiting).value).toBe("cancelled");
  expect(store.listPending(sessionId)).toEqual([]);
  const reopened = new DurableApprovalStore(path);
  expect(reopened.listPending(sessionId)).toEqual([]);
  expect(reopened.listDecisions(sessionId)).toMatchObject([{ id: request.id, value: "cancelled" }]);
});

it("a timer-expired waiter also leaves no live or durable pending request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "approval-expiry-")); directories.push(directory);
  const path = join(directory, "approvals.json"); const store = new DurableApprovalStore(path);
  const resolver = new StoreApprovalResolver(store, { expiresAfterMs: 20 }); const sessionId = newSessionId();
  const request = resolver.createApprovalRequest({ sessionId, agentId: newAgentId(), action: "exec", target: "fixture-shell", reason: "Expiry fixture" });
  expect((await resolver.resolve(request, new AbortController().signal)).value).toBe("expired");
  const reopened = new DurableApprovalStore(path);
  expect(reopened.listPending(sessionId)).toEqual([]);
  expect(reopened.listDecisions(sessionId)).toMatchObject([{ id: request.id, value: "expired" }]);
});

it("a real user decision is committed exactly once when the resolver resumes", async () => {
  const store = new InMemoryApprovalStore(); const resolver = new StoreApprovalResolver(store);
  const sessionId = newSessionId(), controller = new AbortController();
  const request = resolver.createApprovalRequest({ sessionId, agentId: newAgentId(), action: "edit", target: "fixture.txt", reason: "Allow fixture" });
  const waiting = resolver.resolve(request, controller.signal);
  const decision = store.resolve(request.id, "allow", "fixture-user"); controller.abort();
  expect(await waiting).toEqual(decision);
  expect(store.listDecisions(sessionId)).toHaveLength(1);
  expect(store.listPending(sessionId)).toEqual([]);
});
