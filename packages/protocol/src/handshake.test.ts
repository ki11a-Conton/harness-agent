import { describe, expect, it } from "vitest";
import { InitializeGate } from "./handshake.js";
import { ProtocolError } from "./errors.js";

const SERVER_INFO = { name: "harness", version: "0.1.0" } as const;

describe("P29-2 initialize handshake", () => {
  it("returns protocol version + server info + negotiated capabilities", () => {
    const gate = new InitializeGate();
    const result = gate.initialize(
      { clientInfo: { name: "harness_cli", version: "1.0.0" }, capabilities: { streamingItems: true, approvalForms: true } },
      SERVER_INFO,
    );
    expect(result.protocolVersion).toBe("1");
    expect(result.serverInfo).toEqual(SERVER_INFO);
    expect(result.capabilities).toEqual({ streamingItems: true, approvalForms: true });
  });

  it("defaults capabilities when not supplied", () => {
    const gate = new InitializeGate();
    const result = gate.initialize({ clientInfo: { name: "x", version: "0" } }, SERVER_INFO);
    expect(result.capabilities).toEqual({ streamingItems: false, approvalForms: false });
  });

  it("rejects repeated initialize with ALREADY_INITIALIZED", () => {
    const gate = new InitializeGate();
    gate.initialize({ clientInfo: { name: "x", version: "0" } }, SERVER_INFO);
    expect(() => gate.initialize({ clientInfo: { name: "x", version: "0" } }, SERVER_INFO)).toThrow(
      ProtocolError,
    );
  });

  it("rejects mutating request before initialize with NOT_INITIALIZED", () => {
    const gate = new InitializeGate();
    expect(() => gate.requireInitialized()).toThrowError(/not initialized/);
  });

  it("allows mutating request after initialize", () => {
    const gate = new InitializeGate();
    gate.initialize({ clientInfo: { name: "x", version: "0" } }, SERVER_INFO);
    expect(() => gate.requireInitialized()).not.toThrow();
  });
});