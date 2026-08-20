import { describe, expect, it } from "vitest";
import type { EventSink, SessionId, TurnId } from "@ar/contracts";
import {
  denialPayload,
  emitSecurityDenial,
  securityErrorCode,
  securityEventType,
} from "./denial.js";

describe("security denial normalization (P0-7)", () => {
  it("maps every dimension to a security.* event type and a distinct error code", () => {
    const pairs: Array<[Parameters<typeof securityEventType>[0], string, string]> = [
      ["network", "security.network_denied", "SANDBOX_NETWORK_DENIED"],
      ["filesystem", "security.filesystem_denied", "SANDBOX_FILESYSTEM_DENIED"],
      ["process", "security.process_denied", "SANDBOX_PROCESS_DENIED"],
      ["permission", "security.permission_denied", "PERMISSION_DENIED"],
      ["injection", "security.injection_denied", "INJECTION_DENIED"],
      ["secret", "security.secret_redacted", "SECRET_REDACTED"],
      ["memory", "security.memory_denied", "MEMORY_DENIED"],
      ["skill", "security.skill_denied", "SKILL_DENIED"],
      ["mcp", "security.mcp_denied", "MCP_DENIED"],
      ["approval", "security.approval_denied", "APPROVAL_DENIED"],
    ];
    for (const [dim, event, code] of pairs) {
      expect(securityEventType(dim)).toBe(event);
      expect(securityErrorCode(dim)).toBe(code);
    }
  });

  it("builds a uniform payload with reason/code/source and optional target+details", () => {
    const p = denialPayload({
      dimension: "memory",
      reason: "secret detected",
      code: "MEMORY_DENIED",
      source: "memory-store",
      target: "mem-1",
      details: ["AWS key"],
    });
    expect(p).toEqual({
      reason: "secret detected",
      code: "MEMORY_DENIED",
      source: "memory-store",
      target: "mem-1",
      details: ["AWS key"],
    });
  });

  it("omits optional target/details when absent", () => {
    const p = denialPayload({ dimension: "network", reason: "deny", code: "SANDBOX_NETWORK_DENIED", source: "sandbox" });
    expect("target" in p).toBe(false);
    expect("details" in p).toBe(false);
  });

  it("emits onto the EventSink with envelope sessionId + turnId", async () => {
    const emitted: unknown[] = [];
    const sink: EventSink = {
      async emit(sessionId, type, payload, turnId) {
        emitted.push({ sessionId, type, payload, turnId });
      },
    };
    const sessionId: SessionId = "sess-1" as SessionId;
    const turnId: TurnId = "turn-1" as TurnId;
    await emitSecurityDenial(sink, sessionId, { dimension: "skill", reason: "injection", code: "SKILL_DENIED", source: "skill-loader", target: "evil.skill" }, turnId);
    expect(emitted).toEqual([
      {
        sessionId,
        type: "security.skill_denied",
        payload: { reason: "injection", code: "SKILL_DENIED", source: "skill-loader", target: "evil.skill" },
        turnId,
      },
    ]);
  });
});