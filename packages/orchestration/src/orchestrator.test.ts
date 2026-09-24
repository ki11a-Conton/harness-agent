// P33-5/6/10 — Orchestrator reconcile loop integration tests.
import { describe, expect, it } from "vitest";
import { Orchestrator } from "./reconciler.js";
import { FakeTracker } from "./tracker.js";
import { createState, scheduler, statusOf } from "./scheduler.js";
import { retryDue, RetryScheduler } from "./retry-policy.js";
import { workId, type WorkItem } from "./work-item.js";
import { sanitizeKey, hashSuffix, workspaceFor } from "./workspace-manager.js";
import { runWorker, type WorkerRequest } from "./worker.js";

let clock = 0;
const now = () => clock;

function item(id: string, patch: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    identifier: `GH-${id}`,
    title: `item ${id}`,
    state: "todo",
    labels: [],
    dispatchable: true,
    ...patch,
  };
}

/** Empty turn stream (worker never produces model text). */
async function* emptyEvents(): AsyncGenerator<never> {
  // no events
}

/** Fake App Server client: records each started thread; worker completes
 *  immediately unless `hold` is set (keeps the worker running so reconcile
 *  stop paths can be observed). */
function fakeClient(records: string[] = [], hold = false) {
  return {
    async startThread(opts: { agentName: string; cwd: string }) {
      records.push(`${opts.agentName}@${opts.cwd}`);
      return {
        threadId: `t-${records.length}`,
        async runStreamed() {
          return {
            events: emptyEvents(),
            done: hold
              ? new Promise<never>(() => {}) // never settles: worker stays running
              : Promise.resolve({ status: "completed", items: [] }),
          };
        },
        async run() {
          return { status: "completed", items: [] };
        },
      };
    },
  };
}

describe("P33-5 Orchestrator reconcile loop", () => {
  it("dispatches dispatchable candidates within capacity", async () => {
    clock = 0;
    const tracker = new FakeTracker();
    tracker.insert(item("a"));
    tracker.insert(item("b"));
    tracker.insert(item("c"));
    const records: string[] = [];
    const orch = new Orchestrator({
      tracker,
      client: fakeClient(records) as never,
      now,
      agentName: "agent",
      workspaceRoot: "/ws",
      maxConcurrent: 2,
    });
    await orch.tick();
    expect(records).toHaveLength(2); // capacity 2
    expect(statusOf(orch.snapshot, workId("a"))).toBe("running");
    expect(statusOf(orch.snapshot, workId("c"))).toBe("unknown"); // over capacity
  });

  it("re-validates candidates immediately before claim (fresh read wins)", async () => {
    clock = 0;
    const tracker = new FakeTracker();
    tracker.insert(item("ghost", { dispatchable: true }));
    // Simulate external state change between listCandidates and the claim
    // read: the item is no longer dispatchable when re-validated.
    const orig = tracker.listCandidates.bind(tracker);
    tracker.listCandidates = async () => {
      const candidates = await orig();
      // After listing, mutate the item to non-dispatchable before read.
      tracker.update("ghost", { dispatchable: false });
      return candidates;
    };
    const records: string[] = [];
    const orch = new Orchestrator({
      tracker,
      client: fakeClient(records) as never,
      now: () => clock,
      agentName: "agent",
      workspaceRoot: "/ws",
      maxConcurrent: 4,
    });
    await orch.tick();
    expect(records).toHaveLength(0); // re-validation saw it as non-dispatchable
  });

  it("does not dispatch non-dispatchable candidates", async () => {
    clock = 0;
    const tracker = new FakeTracker();
    tracker.insert(item("a", { dispatchable: false }));
    const records: string[] = [];
    const orch = new Orchestrator({
      tracker,
      client: fakeClient(records) as never,
      now,
      agentName: "agent",
      workspaceRoot: "/ws",
    });
    await orch.tick();
    expect(records).toHaveLength(0);
  });

  it("retry policy backs off and retries only eligible items", async () => {
    clock = 0;
    const tracker = new FakeTracker();
    tracker.insert(item("a", { dispatchable: true }));
    const records: string[] = [];
    let fails = 1; // first worker fails
    const flaky = {
      async startThread(opts: { agentName: string; cwd: string }) {
        records.push(`${opts.agentName}@${opts.cwd}`);
        return {
          threadId: "t",
          async runStreamed() {
            if (fails > 0) {
              fails -= 1;
              return {
                events: emptyEvents(),
                done: Promise.reject(new Error("transient")),
              };
            }
            return {
              events: emptyEvents(),
              done: Promise.resolve({ status: "completed", items: [] }),
            };
          },
          async run() {
            return { status: "completed", items: [] };
          },
        };
      },
    };
    const rs = new RetryScheduler({ baseDelayMs: 1000, factor: 2, maxDelayMs: 10000, maxAttempts: 3 }, () => clock);
    const orch = new Orchestrator({
      tracker,
      client: flaky as never,
      now: () => clock,
      agentName: "agent",
      workspaceRoot: "/ws",
      retry: rs,
      maxConcurrent: 4,
    });
    await orch.tick(); // first worker fails → retry scheduled
    // Workers run asynchronously; yield the event loop so the fake worker
    // settles (real workers take time too — tick never blocks on them).
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(statusOf(orch.snapshot, workId("a"))).toBe("retrying");
    // Not due yet — no new worker.
    await orch.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(records).toHaveLength(1);
    // Advance clock past backoff → retry becomes eligible.
    clock = 5000;
    await orch.tick();
    expect(statusOf(orch.snapshot, workId("a"))).toBe("running");
    // Second successful worker → terminal.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await orch.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await orch.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(statusOf(orch.snapshot, workId("a"))).toBe("terminal");
  });
});

describe("P33-6 stop workers when external state invalidates them", () => {
  it("item becoming terminal stops the running worker", async () => {
    clock = 0;
    const tracker = new FakeTracker();
    tracker.insert(item("a"));
    const records: string[] = [];
    const orch = new Orchestrator({
      tracker,
      client: fakeClient(records, true) as never, // hold: worker stays running
      now: () => clock,
      agentName: "agent",
      workspaceRoot: "/ws",
    });
    await orch.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(statusOf(orch.snapshot, workId("a"))).toBe("running");

    // External state moves the item to terminal → next tick stops it.
    tracker.update("a", { state: "done" });
    await orch.tick();
    expect(statusOf(orch.snapshot, workId("a"))).toBe("terminal");
  });

  it("item becoming inactive stops the running worker", async () => {
    clock = 0;
    const tracker = new FakeTracker();
    tracker.insert(item("a"));
    const records: string[] = [];
    const orch = new Orchestrator({
      tracker,
      client: fakeClient(records, true) as never,
      now: () => clock,
      agentName: "agent",
      workspaceRoot: "/ws",
    });
    await orch.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(statusOf(orch.snapshot, workId("a"))).toBe("running");

    tracker.update("a", { state: "inactive", dispatchable: false });
    await orch.tick();
    expect(statusOf(orch.snapshot, workId("a"))).toBe("terminal");
  });

  it("explicit cancellation stops the worker", async () => {
    clock = 0;
    const tracker = new FakeTracker();
    tracker.insert(item("a"));
    const records: string[] = [];
    const orch = new Orchestrator({
      tracker,
      client: fakeClient(records, true) as never,
      now: () => clock,
      agentName: "agent",
      workspaceRoot: "/ws",
    });
    await orch.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(statusOf(orch.snapshot, workId("a"))).toBe("running");

    await orch.stop(workId("a"));
    expect(statusOf(orch.snapshot, workId("a"))).toBe("terminal");
  });
});