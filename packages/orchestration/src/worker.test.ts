// P33-10 — Worker drives the App Server (never Core).
import { describe, expect, it } from "vitest";
import { runWorker } from "./worker.js";

async function* noEvents(): AsyncGenerator<never> {
  // no model text
}

function thread(done: Promise<unknown>) {
  return {
    threadId: "t1",
    async runStreamed() {
      return { events: noEvents(), done };
    },
  };
}

function clientFor(thread: unknown) {
  return {
    async startThread() {
      return thread;
    },
  };
}

const REQ = {
  itemId: "a",
  prompt: "Work on GH-1",
  workspaceDir: "/w/GH-1-abc123",
  agentName: "agent",
};

describe("P33-10 worker via App Server SDK", () => {
  it("starts a thread with the workspace as cwd and the workflow prompt", async () => {
    const seen: Array<{ agentName: string; cwd: string }> = [];
    const client = {
      async startThread(opts: { agentName: string; cwd: string }) {
        seen.push(opts);
        return thread(Promise.resolve({ status: "completed", items: [] }));
      },
    };
    const res = await runWorker(client as never, REQ);
    expect(seen).toEqual([{ agentName: "agent", cwd: "/w/GH-1-abc123" }]);
    expect(res.status).toBe("completed");
  });

  it("maps a failed turn to WorkerResult.failed", async () => {
    const res = await runWorker(
      clientFor(
        thread(
          Promise.resolve({
            status: "failed",
            items: [],
            error: { code: "E", message: "model failed", retryable: true },
          }),
        ),
      ) as never,
      REQ,
    );
    expect(res.status).toBe("failed");
    expect(res.error?.retryable).toBe(true);
  });

  it("maps an interrupted turn to interrupted", async () => {
    const res = await runWorker(
      clientFor(thread(Promise.resolve({ status: "interrupted", items: [] }))) as never,
      REQ,
    );
    expect(res.status).toBe("interrupted");
  });

  it("propagates transport errors as failed", async () => {
    const res = await runWorker(
      clientFor(thread(Promise.reject(new Error("transport down")))) as never,
      REQ,
    );
    expect(res.status).toBe("failed");
    expect(res.error?.message).toBe("transport down");
  });
});