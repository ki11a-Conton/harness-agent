import { describe, expect, it } from "vitest";
import { AgentError, errorInfo, type AgentEvent } from "@ar/contracts";
import { DesktopClient } from "./desktop-client.js";
import { InMemoryTransport } from "./transport.js";

describe("desktop run terminal event drain", () => {
  it.each([false, true])("delivers the final event before propagating an RPC rejection (failed: %s)", async failed => {
    const { client, server } = InMemoryTransport.pair();
    const seen: AgentEvent[] = [];
    const terminal = { type: failed ? "turn.failed" : "turn.completed", sequence: 1 } as AgentEvent;
    let finished = false;
    server.connect({
      async invoke(method, params) {
        if (method === "session.run") {
          finished = true;
          if (failed) throw new AgentError(errorInfo("MODEL_ERROR", "controlled model failure"));
          return { status: "completed", toolCalls: 0, iterations: 1 };
        }
        if (method === "session.subscribe") {
          const after = (params as { afterSequence: number }).afterSequence;
          return finished && after < 1 ? [terminal] : [];
        }
        throw new Error(`unexpected RPC ${method}`);
      },
    });
    const desktop = new DesktopClient({ transport: client, pollDelayMs: 1 });
    const result = desktop.run("session", "turn", event => seen.push(event));
    if (failed) await expect(result).rejects.toMatchObject({ info: { code: "MODEL_ERROR", message: "controlled model failure" } });
    else await expect(result).resolves.toEqual({ status: "completed", toolCalls: 0, iterations: 1 });
    expect(seen).toEqual([terminal]);
  });
});
