import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@ar/contracts";
import { newAgentId, newSessionId } from "@ar/contracts";
import { InMemoryApprovalStore, StoreApprovalResolver } from "./approval.js";

const AID = newAgentId();
const SID = newSessionId();

function makeRequest(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: `approval_test_${Math.random()}`,
    sessionId: SID,
    agentId: AID,
    action: "exec",
    target: "rm -rf /",
    reason: "test approval",
    createdAt: Date.now(),
    expiresAt: Date.now() + 100_000,
    ...over,
  } as ApprovalRequest;
}

describe("Approval lifecycle (SEC-002)", () => {
  it("approve", async () => {
    const store = new InMemoryApprovalStore(() => 100);
    const resolver = new StoreApprovalResolver(store, { now: () => 100 });
    const req = makeRequest({ expiresAt: 100_000 });
    const waitP = resolver.resolve(req, new AbortController().signal);
    const decision = store.resolve(req.id, "allow", "user1");
    expect(decision.value).toBe("allow");
    expect(decision.decidedBy).toBe("user1");
    expect((await waitP).value).toBe("allow");
  });

  it("deny", async () => {
    const store = new InMemoryApprovalStore();
    const resolver = new StoreApprovalResolver(store);
    const req = makeRequest();
    const waitP = resolver.resolve(req, new AbortController().signal);
    expect((await store.resolve(req.id, "deny")).value).toBe("deny");
    expect((await waitP).value).toBe("deny");
  });

  it("expire", async () => {
    let t = 0;
    const store = new InMemoryApprovalStore(() => t);
    const resolver = new StoreApprovalResolver(store, { now: () => t });
    const req = makeRequest({ expiresAt: 1000 });
    const waitP = resolver.resolve(req, new AbortController().signal);
    t = 2000;
    expect((await waitP).value).toBe("expired");
  });

  it("late allow after expiry becomes expired", async () => {
    let t = 0;
    const store = new InMemoryApprovalStore(() => t);
    const resolver = new StoreApprovalResolver(store, { now: () => t });
    const req = makeRequest({ expiresAt: 1000 });
    const waitP = resolver.resolve(req, new AbortController().signal);
    t = 2000;
    expect(store.resolve(req.id, "allow").value).toBe("expired");
    expect((await waitP).value).toBe("expired");
  });

  it("cancel via abort signal", async () => {
    const store = new InMemoryApprovalStore();
    const resolver = new StoreApprovalResolver(store);
    const req = makeRequest({ expiresAt: 100_000 });
    const ac = new AbortController();
    const waitP = resolver.resolve(req, ac.signal);
    ac.abort();
    expect((await waitP).value).toBe("cancelled");
  });

  it("duplicate response is rejected", async () => {
    const store = new InMemoryApprovalStore();
    const resolver = new StoreApprovalResolver(store);
    const req = makeRequest({ expiresAt: Date.now() + 100_000 });
    const waitP = resolver.resolve(req, new AbortController().signal);
    store.resolve(req.id, "allow");
    expect(() => store.resolve(req.id, "allow")).toThrow(/already-resolved/);
    expect((await waitP).value).toBe("allow");
  });

  it("resolving an unknown id is rejected", async () => {
    const store = new InMemoryApprovalStore();
    expect(() => store.resolve("approval_none" as never, "allow")).toThrow(/unknown/);
  });

  it("cancelAll settles pending approvals for a session", async () => {
    const store = new InMemoryApprovalStore();
    const resolver = new StoreApprovalResolver(store);
    const req1 = makeRequest({ expiresAt: 100_000 });
    const req2 = makeRequest({ expiresAt: 100_000 });
    const w1 = resolver.resolve(req1, new AbortController().signal);
    const w2 = resolver.resolve(req2, new AbortController().signal);
    store.cancelAll(SID);
    expect((await w1).value).toBe("cancelled");
    expect((await w2).value).toBe("cancelled");
    expect(store.listPending(SID).length).toBe(0);
  });
});