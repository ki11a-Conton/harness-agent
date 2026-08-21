import { describe, expect, it } from "vitest";
import { newAgentId, newSessionId, newTurnId } from "@ar/contracts";
import { DeterministicPermissionEngine } from "./permission.js";
const AID = newAgentId();
const SID = newSessionId();
const TID = newTurnId();
function req(over = {}) {
    return {
        action: "exec",
        resource: "command",
        agentId: AID,
        sessionId: SID,
        ...over,
    };
}
describe("PermissionEngine", () => {
    it("allow when a rule matches", async () => {
        const engine = new DeterministicPermissionEngine();
        const policy = {
            rules: [{ action: "exec", resource: "command", pattern: "npm test", effect: "allow" }],
        };
        const d = await engine.evaluate(req({ target: "npm test" }), policy);
        expect(d.effect).toBe("allow");
    });
    it("deny when a rule matches", async () => {
        const engine = new DeterministicPermissionEngine();
        const policy = {
            rules: [{ action: "exec", resource: "command", pattern: "rm -rf *", effect: "deny" }],
        };
        const d = await engine.evaluate(req({ target: "rm -rf somefile" }), policy);
        expect(d.effect).toBe("deny");
        const d2 = await engine.evaluate(req({ target: "rm -rf /" }), policy);
        expect(d2.effect).toBe("ask");
    });
    it("double-star patterns cross separators", async () => {
        const engine = new DeterministicPermissionEngine();
        const policy = {
            rules: [{ action: "exec", resource: "command", pattern: "rm -rf **", effect: "deny" }],
        };
        const d = await engine.evaluate(req({ target: "rm -rf /" }), policy);
        expect(d.effect).toBe("deny");
    });
    it("ask when no rule matches (default)", async () => {
        const engine = new DeterministicPermissionEngine();
        const d = await engine.evaluate(req({ target: "unknown cmd" }), { rules: [] });
        expect(d.effect).toBe("ask");
    });
    it("respects policy defaultEffect", async () => {
        const engine = new DeterministicPermissionEngine();
        const d = await engine.evaluate(req(), { rules: [], defaultEffect: "deny" });
        expect(d.effect).toBe("deny");
    });
    it("specific rule beats general rule", async () => {
        const engine = new DeterministicPermissionEngine();
        const policy = {
            rules: [
                { action: "exec", resource: "command", pattern: "**/*", effect: "deny", scope: "global" },
                { action: "exec", resource: "command", pattern: "npm test", effect: "allow", scope: "session" },
            ],
        };
        const d = await engine.evaluate(req({ target: "npm test" }), policy);
        expect(d.effect).toBe("allow");
    });
    it("deny wins on equally-specific conflicts", async () => {
        const engine = new DeterministicPermissionEngine();
        const policy = {
            rules: [
                { action: "*", resource: "*", pattern: "npm test", effect: "allow", scope: "global" },
                { action: "*", resource: "*", pattern: "npm test", effect: "deny", scope: "global" },
            ],
        };
        const d = await engine.evaluate(req({ target: "npm test" }), policy);
        expect(d.effect).toBe("deny");
    });
    it("unknown action falls back to default", async () => {
        const engine = new DeterministicPermissionEngine();
        const policy = {
            rules: [{ action: "read", resource: "file", pattern: "**/*", effect: "allow" }],
            defaultEffect: "deny",
        };
        const d = await engine.evaluate(req({ action: "banana", resource: "foo", target: "x" }), policy);
        expect(d.effect).toBe("deny");
    });
    it("rules without pattern match any target", async () => {
        const engine = new DeterministicPermissionEngine();
        const policy = {
            rules: [{ action: "read", resource: "file", effect: "allow" }],
        };
        const d = await engine.evaluate(req({ action: "read", resource: "file", target: "whatever" }), policy);
        expect(d.effect).toBe("allow");
    });
    it("glob pattern matches nested paths", async () => {
        const engine = new DeterministicPermissionEngine();
        const policy = {
            rules: [{ action: "edit", resource: "file", pattern: "src/**/*.ts", effect: "allow" }],
        };
        const d = await engine.evaluate(req({ action: "edit", resource: "file", target: "src/a/b/c.ts" }), policy);
        expect(d.effect).toBe("allow");
        const d2 = await engine.evaluate(req({ action: "edit", resource: "file", target: "docs/x.md" }), policy);
        expect(d2.effect).toBe("ask");
    });
});
describe("glob matcher", () => {
    it("**/ matches zero or more segments", async () => {
        const { matchGlob } = await import("./glob.js");
        expect(matchGlob("**/*.ts", "a.ts")).toBe(true);
        expect(matchGlob("**/*.ts", "a/b/c.ts")).toBe(true);
        expect(matchGlob("src/**/*.ts", "src/a.ts")).toBe(true);
        expect(matchGlob("*.md", "docs/readme.md")).toBe(true);
        expect(matchGlob("*.md", "readme.md")).toBe(true);
        expect(matchGlob("a?.txt", "ab.txt")).toBe(true);
        expect(matchGlob("a?.txt", "abc.txt")).toBe(false);
    });
});
//# sourceMappingURL=permission.test.js.map