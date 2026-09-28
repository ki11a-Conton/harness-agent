import { describe, expect, it } from "vitest";
import type { SerializedChatMessage } from "@ar/contracts";
import {
  buildProviderDiagnosticBundle,
  diagnosticDigest,
  redactEndpoint,
  PROVIDER_DIAGNOSTIC_SCHEMA,
} from "./provider-diagnostics.js";

/**
 * F7 / R6 — the redaction contract of the provider diagnostic bundle.
 *
 * Real provider errors (HTTP 400/11148 "tool calls and tool results do not
 * match") must be diagnosable from the run artifact WITHOUT the artifact
 * becoming a copy of the user's conversation. These tests pin both halves: the
 * structure that makes 11148 diagnosable, and the absence of secrets/content.
 */

const SECRET = "sk-live-abcdef0123456789";
const USER_TEXT = "please refactor the billing module";
const TOOL_OUTPUT = "sensitive tool stdout: DATABASE_URL=postgres://u:p@h/db";

function assistant(id: string, name = "read_file", extra: SerializedChatMessage[] = []): SerializedChatMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id, type: "function", function: { name, arguments: '{"path":"a.ts"}' } }],
    },
    ...extra,
  ];
}

describe("F7/R6 provider diagnostics — digests and endpoint redaction", () => {
  it("digests are stable, bounded and not reversible", () => {
    expect(diagnosticDigest("local-stub-model")).toBe(diagnosticDigest("local-stub-model"));
    expect(diagnosticDigest("local-stub-model")).toHaveLength(16);
    expect(diagnosticDigest("local-stub-model")).not.toContain("local-stub-model");
    expect(diagnosticDigest("a")).not.toBe(diagnosticDigest("b"));
  });

  it("strips userinfo and query credentials before an endpoint is digested", () => {
    const redacted = redactEndpoint(`https://user:${SECRET}@relay.example.com/v1?api_key=${SECRET}`);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).not.toContain("user:");
    expect(redacted).toContain("relay.example.com/v1");
  });

  it("two different endpoints do not share a digest, and repeats do", () => {
    const a = buildProviderDiagnosticBundle({ reason: "http_status", messages: [], endpoint: "http://127.0.0.1:1/v1" });
    const b = buildProviderDiagnosticBundle({ reason: "http_status", messages: [], endpoint: "http://127.0.0.1:2/v1" });
    const a2 = buildProviderDiagnosticBundle({ reason: "http_status", messages: [], endpoint: "http://127.0.0.1:1/v1" });
    expect(a.endpointDigest).not.toBe(b.endpointDigest);
    expect(a.endpointDigest).toBe(a2.endpointDigest);
    expect(a.schema).toBe(PROVIDER_DIAGNOSTIC_SCHEMA);
    expect(a.status).toBeNull();
  });
});

describe("F7/R6 provider diagnostics — the 11148 signature is recorded", () => {
  it("records an unanswered requested id (the upstream 'do not match' signature)", () => {
    const messages: SerializedChatMessage[] = [
      ...assistant("call_a"),
      { role: "tool", content: "ok", tool_call_id: "call_a" },
      ...assistant("call_b"),
    ];
    const bundle = buildProviderDiagnosticBundle({ reason: "http_status", messages, status: 400 });
    expect(bundle.unansweredToolCallIds).toEqual(["call_b"]);
    expect(bundle.orphanToolResultIndexes).toEqual([]);
    expect(bundle.toolCallIdCorrelation).toEqual([
      { callIndex: 0, callId: "call_a", name: "read_file", resultCount: 1, resultIndexes: [1], duplicatedRequest: false },
      { callIndex: 2, callId: "call_b", name: "read_file", resultCount: 0, resultIndexes: [], duplicatedRequest: false },
    ]);
  });

  it("records an orphan tool result and a duplicated request", () => {
    const orphan: SerializedChatMessage[] = [{ role: "tool", content: "x", tool_call_id: "call_gone" }];
    expect(buildProviderDiagnosticBundle({ reason: "http_status", messages: orphan }).orphanToolResultIndexes).toEqual([0]);

    const duplicated: SerializedChatMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "call_a", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
    ];
    const bundle = buildProviderDiagnosticBundle({ reason: "wire_protocol_violation", messages: duplicated });
    expect(bundle.toolCallIdCorrelation).toHaveLength(1);
    expect(bundle.toolCallIdCorrelation[0]!.duplicatedRequest).toBe(true);
    expect(bundle.request.toolCallCount).toBe(2);
  });

  it("caps the correlation list instead of growing the artifact without bound", () => {
    const many: SerializedChatMessage[] = [];
    for (let i = 0; i < 80; i += 1) {
      const calls = assistant(`call_${i}`);
      many.push(calls[0]!);
    }
    const bundle = buildProviderDiagnosticBundle({ reason: "http_status", messages: many });
    expect(bundle.correlationTruncated).toBe(true);
    expect(bundle.toolCallIdCorrelation).toHaveLength(64);
    expect(bundle.request.toolCallCount).toBe(80);
  });
});

describe("F7/R6 provider diagnostics — never retains keys or content", () => {
  it("records sizes, roles and names but no message text, tool output or key", () => {
    const messages: SerializedChatMessage[] = [
      { role: "user", content: `${USER_TEXT} ${SECRET}` },
      ...[
        {
          role: "assistant" as const,
          content: "",
          tool_calls: [{ id: "call_a", type: "function" as const, function: { name: "read_file", arguments: `{"secret":"${SECRET}"}` } }],
        },
      ],
      { role: "tool", content: TOOL_OUTPUT, tool_call_id: "call_a" },
    ];
    const bundle = buildProviderDiagnosticBundle({
      reason: "http_status",
      messages,
      endpoint: `https://relay.example.com/v1?key=${SECRET}`,
      modelId: "some-model",
      status: 400,
      tools: [{ name: "read_file" }],
    });
    const serialized = JSON.stringify(bundle);

    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain(USER_TEXT);
    expect(serialized).not.toContain("DATABASE_URL");
    expect(serialized).not.toContain(TOOL_OUTPUT);

    expect(bundle.redacted).toBe(true);
    expect(bundle.contentRetained).toBe(false);
    expect(bundle.request.roles).toEqual(["user", "assistant+tool_calls", "tool"]);
    expect(bundle.request.toolNames).toEqual(["read_file"]);
    expect(bundle.request.advertisedToolNames).toEqual(["read_file"]);
    expect(bundle.request.advertisedToolCount).toBe(1);
    expect(bundle.request.contentBytes).toBeGreaterThan(0);
    expect(bundle.request.toolArgumentBytes).toBeGreaterThan(0);
    expect(bundle.request.toolOutputBytes).toBe(TOOL_OUTPUT.length);
  });

  it("never emits a null status as 0 (unknown stays null)", () => {
    const bundle = buildProviderDiagnosticBundle({ reason: "wire_protocol_violation", messages: [] });
    expect(bundle.status).toBeNull();
    expect(bundle.status).not.toBe(0);
  });
});
