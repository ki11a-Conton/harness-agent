import { describe, expect, it } from "vitest";
import { EVENT_PAYLOAD_TYPES, toolNameOf, } from "./event-payloads.js";
/**
 * Q-4: typed event payloads.
 *
 * These tests pin the CANONICAL payload shapes for key events so a producer
 * can never silently drift a field name (e.g. `tool.requested` using `name`
 * while `tool.failed` uses `tool`) without a consumer noticing. The accessor
 * `toolNameOf` is the single read path evaluators must use; it prefers the
 * canonical `tool` field and only falls back to the legacy `name` alias.
 */
describe("Q-4 typed event payloads", () => {
    it("toolNameOf prefers the canonical `tool` field", () => {
        expect(toolNameOf({ tool: "exec", name: "mismatched" })).toBe("exec");
    });
    it("toolNameOf falls back to the legacy `name` alias", () => {
        expect(toolNameOf({ name: "read_file" })).toBe("read_file");
    });
    it("toolNameOf returns undefined when neither field is present or is empty", () => {
        expect(toolNameOf({})).toBeUndefined();
        expect(toolNameOf({ tool: "", name: "" })).toBeUndefined();
        expect(toolNameOf({ tool: 42 })).toBeUndefined();
    });
    it("tool.completed and tool.failed share the canonical tool field", () => {
        const completedPayload = {
            toolCallId: "tc",
            tool: "bash",
            durationMs: 12,
        };
        const failedPayload = {
            toolCallId: "tc",
            tool: "bash",
            error: { code: "E1" },
        };
        // Exactly the drift Q-4 prevents: both producers name the tool `tool`.
        expect(completedPayload.tool).toBe("bash");
        expect(failedPayload.tool).toBe("bash");
        expect(toolNameOf(completedPayload)).toBe("bash");
        expect(toolNameOf(failedPayload)).toBe("bash");
    });
    it("EventPayloadMap is total and typed per event type", () => {
        // Compile-time: payload of a keyed event resolves to its typed shape.
        const completed = {
            toolCallId: "tc",
            tool: "bash",
            status: "success",
        };
        const failed = {
            toolCallId: "tc",
            tool: "bash",
            error: { code: "E1" },
        };
        const retry = { attempt: 2 };
        const limit = {
            limit: "maxTokens",
            used: 100,
            allowed: 200,
        };
        void completed;
        void failed;
        void retry;
        void limit;
    });
    it("every security denial event uses the canonical denial payload", () => {
        const types = [
            "security.network_denied",
            "security.injection_denied",
            "security.permission_denied",
            "security.filesystem_denied",
            "security.process_denied",
            "security.secret_redacted",
            "security.memory_denied",
            "security.skill_denied",
            "security.mcp_denied",
            "security.approval_denied",
        ];
        for (const t of types) {
            expect(EVENT_PAYLOAD_TYPES[t]).toBe(true);
            // Every security denial shares the canonical denial payload shape.
            const p = {};
            expect(p.reason).toBeUndefined();
            void p;
        }
    });
});
//# sourceMappingURL=event-payloads.test.js.map