import { describe, expect, it, vi } from "vitest";
import type { EventSink, SessionId } from "@ar/contracts";
import {
  degradedEventSink,
  isNodeErrorCode,
  NOOP_ERROR_SINK,
  reportDegraded,
  stderrErrorSink,
} from "./non-fatal.js";

describe("P14-6: NonFatalErrorSink contract", () => {
  it("NOOP_ERROR_SINK reports without throwing (explicit opt-out)", () => {
    expect(() => NOOP_ERROR_SINK.report("x", new Error("boom"))).not.toThrow();
  });

  it("stderrErrorSink writes a synchronous degraded line", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      stderrErrorSink("p14-6").report("subsystem", new Error("boom"));
      const line = write.mock.calls[0]?.[0] as string;
      expect(line).toContain("[p14-6] subsystem: boom");
    } finally {
      write.mockRestore();
    }
  });

  it("degradedEventSink emits runtime.degraded AND falls back to stderr", async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sink: EventSink = {
      async emit(_sid, type, payload) {
        emitted.push({ type, payload });
        return undefined as never;
      },
    };
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      degradedEventSink(sink, "s-1" as SessionId).report("ctx", new Error("nope"), { extra: 1 });
      // event lands with context + reason + meta
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.type).toBe("runtime.degraded");
      expect(emitted[0]!.payload).toMatchObject({
        context: "ctx",
        reason: "nope",
        extra: 1,
      });
      // the synchronous stderr fallback fired FIRST (never lost to an async gap)
      expect(write).toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it("degradedEventSink reports the event-write failure itself (never erases the first report)", async () => {
    const failing: EventSink = {
      async emit() {
        throw new Error("store closed");
      },
    };
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      degradedEventSink(failing, "s-1" as SessionId).report("ctx", new Error("first"));
      // allow the fire-and-forget event attempt to settle
      await new Promise((resolve) => setTimeout(resolve, 10));
      const lines = write.mock.calls.map((c) => c[0] as string).join("\n");
      expect(lines).toContain("[degraded] ctx: first"); // first report
      expect(lines).toContain("event emit failed for ctx"); // second failure reported too
    } finally {
      write.mockRestore();
    }
  });

  it("isNodeErrorCode matches only the specific node error code", () => {
    const enoent = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(isNodeErrorCode(enoent, "ENOENT")).toBe(true);
    expect(isNodeErrorCode(new Error("generic"), "ENOENT")).toBe(false);
    expect(isNodeErrorCode("not-an-error", "ENOENT")).toBe(false);
  });

  it("reportDegraded is the stderr shorthand", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      reportDegraded("x", new Error("y"));
      expect((write.mock.calls[0]?.[0] as string)).toContain("[degraded] x: y");
    } finally {
      write.mockRestore();
    }
  });
});
