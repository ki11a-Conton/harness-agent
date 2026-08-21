import { describe, expect, it } from "vitest";
import { newAgentId, newApprovalId, newSessionId, } from "@ar/contracts";
import { InMemoryPermissionGrantStore } from "./permission-grant.js";
const SID = newSessionId();
const AID = newAgentId();
function grant(over = {}) {
    return {
        sessionId: SID,
        grantKey: "exec@npm install *",
        bound: "session",
        approvalId: newApprovalId(),
        agentId: AID,
        grantedAt: 0,
        expiresAt: 1000,
        remainingUses: undefined,
        ...over,
    };
}
describe("InMemoryPermissionGrantStore (P2-44)", () => {
    it("a session grant is returned until its hard expiry", async () => {
        const store = new InMemoryPermissionGrantStore(() => 500);
        await store.grant(grant({ expiresAt: 1000 }));
        expect((await store.get(SID, "exec@npm install *"))?.expiresAt).toBe(1000);
        expect((await store.list(SID))).toHaveLength(1);
    });
    it("a grant past its expiry is never returned", async () => {
        const store = new InMemoryPermissionGrantStore(() => 500);
        await store.grant(grant({ expiresAt: 400 }));
        expect((await store.get(SID, "exec@npm install *"))).toBeUndefined();
    });
    it("a grant whose time expires is dropped on read", async () => {
        const store = new InMemoryPermissionGrantStore(() => 500);
        await store.grant(grant({ expiresAt: 600 }));
        // at t=500 the grant is still visible
        expect((await store.get(SID, "exec@npm install *"))?.expiresAt).toBe(600);
        const later = new InMemoryPermissionGrantStore(() => 700);
        // new clock: same logical key would have expired by construction; simulate by
        // checking list prunes expired grants.
        await later.grant(grant({ expiresAt: 600 }));
        expect((await later.list(SID))).toHaveLength(0);
    });
    it("consume decrements bounded usage and drops the grant at zero", async () => {
        const store = new InMemoryPermissionGrantStore(() => 500);
        await store.grant(grant({ bound: "one_tool", remainingUses: 1, expiresAt: 9999 }));
        expect((await store.consume(SID, "exec@npm install *", 600))).toBeUndefined();
        expect((await store.get(SID, "exec@npm install *"))).toBeUndefined();
    });
    it("a one_call grant is consumed by a single use", async () => {
        const store = new InMemoryPermissionGrantStore(() => 500);
        await store.grant(grant({ bound: "one_call", remainingUses: 1, expiresAt: 9999 }));
        // one_call ⇒ exactly one call; consuming it drops the grant.
        expect((await store.consume(SID, "exec@npm install *", 600))).toBeUndefined();
        expect((await store.list(SID))).toHaveLength(0);
    });
    it("a session grant stays alive across consumes until expiry", async () => {
        const store = new InMemoryPermissionGrantStore(() => 500);
        await store.grant(grant({ bound: "session", remainingUses: undefined, expiresAt: 9999 }));
        const after = await store.consume(SID, "exec@npm install *", 600);
        expect(after).toBeDefined(); // session grants are not usage-limited
        expect((await store.get(SID, "exec@npm install *"))).toBeDefined();
    });
    it("a new grant for the same key replaces the prior one", async () => {
        const store = new InMemoryPermissionGrantStore(() => 500);
        await store.grant(grant({ expiresAt: 1000 }));
        await store.grant(grant({ expiresAt: 9999 }));
        expect((await store.get(SID, "exec@npm install *"))?.expiresAt).toBe(9999);
    });
});
//# sourceMappingURL=permission-grant.test.js.map