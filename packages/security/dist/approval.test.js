import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newAgentId, newApprovalId, newSessionId } from "@ar/contracts";
import { DurableApprovalStore, InMemoryApprovalStore, StoreApprovalResolver, } from "./approval.js";
const AID = newAgentId();
const SID = newSessionId();
function makeRequest(over = {}) {
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
    };
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
        expect(() => store.resolve("approval_none", "allow")).toThrow(/unknown/);
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
describe("Approval scope + audit (P2-44)", () => {
    it("createApprovalRequest carries an explicit decision scope", () => {
        const store = new InMemoryApprovalStore();
        const resolver = new StoreApprovalResolver(store, { now: () => 1000 });
        const req = resolver.createApprovalRequest({
            sessionId: SID,
            agentId: AID,
            action: "exec",
            target: "npm install",
            reason: "expand",
            scope: "session",
        });
        expect(req.scope).toBe("session");
        const defaulted = resolver.createApprovalRequest({
            sessionId: SID,
            agentId: AID,
            action: "exec",
            target: "npm install",
            reason: "no scope",
        });
        expect(defaulted.scope).toBe("one_call");
    });
    it("resolved decisions are recorded in an append-only audit log", async () => {
        const store = new InMemoryApprovalStore(() => 100);
        const resolver = new StoreApprovalResolver(store, { now: () => 100 });
        const req = makeRequest({ expiresAt: 100_000 });
        const waitP = resolver.resolve(req, new AbortController().signal);
        store.resolve(req.id, "allow", "user-1");
        await waitP;
        const log = store.listDecisions(SID);
        expect(log).toHaveLength(1);
        expect(log[0].value).toBe("allow");
        expect(log[0].decidedBy).toBe("user-1");
        expect(log[0].scope).toBe("one_call");
        expect(log[0].action).toBe("exec");
        expect(log[0].target).toBe("rm -rf /");
        // deny for a second session is recorded separately and filtered
        const store2 = new InMemoryApprovalStore(() => 100);
        const resolver2 = new StoreApprovalResolver(store2, { now: () => 100 });
        const req2 = makeRequest({ expiresAt: 100_000 });
        void resolver2.resolve(req2, new AbortController().signal);
        store2.resolve(req2.id, "deny");
        expect(store2.listDecisions(SID)).toHaveLength(1);
        expect(store2.listDecisions(SID)[0].value).toBe("deny");
    });
    it("cancelAll records cancelled decisions for audit", async () => {
        const store = new InMemoryApprovalStore();
        const resolver = new StoreApprovalResolver(store);
        const req = makeRequest({ expiresAt: 100_000 });
        void resolver.resolve(req, new AbortController().signal);
        store.cancelAll(SID);
        expect(store.listDecisions(SID)).toHaveLength(1);
        expect(store.listDecisions(SID)[0].value).toBe("cancelled");
    });
});
describe("DurableApprovalStore (P2-44)", () => {
    function tmpFile() {
        return mkdtemp(join(tmpdir(), "ha-approval-")).then((dir) => join(dir, "approvals.json"));
    }
    it("persists pending requests and decisions across a restart", async () => {
        const file = await tmpFile();
        try {
            const store = new DurableApprovalStore(file, { now: () => 100 });
            const req = makeRequest({ expiresAt: 100_000 });
            store.create(req);
            expect(store.listPending(SID).map((r) => r.id)).toEqual([req.id]);
            // "restart": a fresh store re-hydrates the pending request from disk.
            const restarted = new DurableApprovalStore(file, { now: () => 200 });
            expect(restarted.listPending(SID).map((r) => r.id)).toEqual([req.id]);
            // The re-hydrated request is resolvable, and the decision is auditable.
            restarted.resolve(req.id, "allow", "user-9");
            expect(restarted.listPending(SID)).toHaveLength(0);
            expect(restarted.listDecisions(SID)).toHaveLength(1);
            expect(restarted.listDecisions(SID)[0].value).toBe("allow");
            expect(restarted.listDecisions(SID)[0].decidedBy).toBe("user-9");
            // A second restart still sees the audit log.
            const afterRestart = new DurableApprovalStore(file, { now: () => 300 });
            expect(afterRestart.listDecisions(SID)).toHaveLength(1);
            expect(afterRestart.listPending(SID)).toHaveLength(0);
        }
        finally {
            await rm(join(file, ".."), { recursive: true, force: true });
        }
    });
    it("decision records carry scope, expired flag, and action/target for audit", async () => {
        const file = await tmpFile();
        try {
            const store = new DurableApprovalStore(file, { now: () => 100 });
            const req = makeRequest({ scope: "session", expiresAt: 100_000 });
            store.create(req);
            store.resolve(req.id, "allow", "admin");
            const record = store.listDecisions(SID)[0];
            expect(record.scope).toBe("session");
            expect(record.expired).toBe(false);
            expect(record.decidedBy).toBe("admin");
            expect(record.target).toBe("rm -rf /");
        }
        finally {
            await rm(join(file, ".."), { recursive: true, force: true });
        }
    });
    it("idempotently re-hydrates when a request already exists in the live store", async () => {
        const file = await tmpFile();
        try {
            const store = new DurableApprovalStore(file, { now: () => 100 });
            const req = makeRequest({ expiresAt: 100_000 });
            store.create(req);
            // Re-constructing from the same disk state must not throw.
            const restarted = new DurableApprovalStore(file, { now: () => 100 });
            expect(restarted.listPending(SID)).toHaveLength(1);
        }
        finally {
            await rm(join(file, ".."), { recursive: true, force: true });
        }
    });
});
describe("Approval scope taxonomy guard", () => {
    it("in-memory store records a request with a missing scope as one_call on resolve", async () => {
        const store = new InMemoryApprovalStore(() => 100);
        const req = makeRequest({ expiresAt: 100_000 });
        store.create(req);
        store.resolve(req.id, "allow");
        expect(store.listDecisions(SID)[0].scope).toBe("one_call");
    });
});
//# sourceMappingURL=approval.test.js.map