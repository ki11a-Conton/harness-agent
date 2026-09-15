// P3-6 end-to-end: a real worker subagent writes into an ISOLATED child
// workspace and the parent harness physically merges the patch back into the
// parent root. Unlike delegation-tools.test (mock delegator/manager), this
// walks the full createHarness → runtime → real Delegator → real
// DefaultChildWorkspaceManager → ToolOrchestrator path.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  newSessionId,
  newToolCallId,
  newTurnId,
  type AgentDefinition,
  type ModelEvent,
  type ModelProvider,
  type ModelRef,
  type ProviderConfig,
} from "@ar/contracts";
import { createHarness } from "./create-harness.js";

let tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-worker-e2e-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

/** Scripted provider: yields the next ModelEvent script per generate() call. */
function scriptedProvider(script: (ModelEvent[] | ((requestSystem: string) => ModelEvent[]))[]) {
  let index = 0;
  const provider: ModelProvider = {
    id: "scripted-worker",
    async listModels() {
      return [{ id: "w", name: "worker", capabilities: { contextWindowTokens: 128_000 } }];
    },
    createClient(_m: ModelRef, _c: ProviderConfig) {
      return {
        async *generate(request: unknown): AsyncGenerator<ModelEvent, void, void> {
          const entry = script[Math.min(index, script.length - 1)];
          index += 1;
          const entryEvents = typeof entry === "function" ? entry((request as { system?: string }).system ?? "") : (entry ?? []);
          for (const event of entryEvents) yield event;
        },
      };
    },
  };
  const model: ModelRef = { providerId: "scripted-worker", modelId: "w" };
  return { provider, model, calls: () => index };
}

function text(text: string): ModelEvent[] {
  return [
    { type: "started", timestamp: 0 },
    { type: "text_delta", text, timestamp: 0 },
    { type: "completed", result: { finishReason: "stop", text }, timestamp: 0 },
  ];
}

/**
 * R76: the minimal approval poller shared by the delegation tests.
 *
 * It auto-approves whatever the harness raises until `stop()` is called, and
 * `stop()` ALWAYS awaits the loop, so the test can prove that no poller
 * survives the test body (no live timer, no pending `listPending()` call, no
 * unhandled rejection) on BOTH the success and the rejection path.
 *
 * `stop()` is idempotent: calling it twice must not hang or double-resolve.
 */
export function startApprovalPoller(
  harness: { approvalStore: { listPending(): Array<{ id: string }>; resolve(id: string, effect: string, by: string): unknown } },
  opts: { intervalMs?: number; onPoll?: () => void } = {},
): { stop(): Promise<void>; polls: () => number } {
  const intervalMs = opts.intervalMs ?? 10;
  let stopped = false;
  let polls = 0;
  const loop = (async () => {
    while (!stopped) {
      polls += 1;
      opts.onPoll?.();
      for (const req of harness.approvalStore.listPending()) {
        harness.approvalStore.resolve(req.id, "allow", "test");
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  // The poller promise must never reject unhandled: a failure inside the loop
  // is captured and re-surfaced by `stop()` at the await site.
  const settled = loop.then(
    () => null,
    (err: unknown) => err,
  );
  return {
    async stop(): Promise<void> {
      stopped = true;
      const err = await settled;
      if (err !== null) throw err;
    },
    polls: () => polls,
  };
}

function toolCall(name: string, args: Record<string, unknown>): ModelEvent[] {
  const id = newToolCallId();
  return [
    { type: "started", timestamp: 0 },
    { type: "tool_call_delta", toolCall: { id, name, args }, timestamp: 0 },
    {
      type: "completed",
      result: { finishReason: "tool_calls", toolCalls: [{ id, name, args }] },
      timestamp: 0,
    },
  ];
}

describe("P3-6 end-to-end: delegate_worker writes an isolated copy and merges", () => {
  it("child writes to an isolated root; parent physically receives the patch", async () => {
    const cwd = await tempDir();
    const dataDir = await tempDir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "a.ts"), "export const a = 1;\n");

    const fixtureText = "export function helper() { return 42; }\n";
    const { provider, model } = scriptedProvider([
      // 0: parent calls delegate_worker
      toolCall("delegate_worker", { goal: "implement src/helper.ts" }),
      // 1: worker calls write_file inside its isolated root
      toolCall("write_file", { path: "src/helper.ts", content: fixtureText }),
      // 2: worker reports done
      text("wrote src/helper.ts"),
      // 3: parent finishes
      text("the worker implemented it"),
    ]);

    const harness = await createHarness({
      cwd,
      dataDir,
      profile: "interactive",
      modelProvider: provider,
      model,
      delegation: { enabled: true, maxDepth: 2, maxConcurrent: 2 },
    });
    try {
      const main = harness.agents.find((a) => a.name === "main")!;
      // delegate_worker must be registered for the model to call it.
      expect(harness.registry.names()).toContain("delegate_worker");
      const session = await harness.runtime.createSession({ agent: main, cwd });
      const turn = await harness.runtime.startTurn(session.id, "implement the helper");
      // Auto-approve any approval request the delegate_worker tool raises
      // (interactive profile → exec:tool asks for approval).
      //
      // R72: this loop must be bound to the TEST's lifecycle, not to a fixed
      // 200×10ms budget. A fixed budget is a wall-clock race: on a loaded
      // runner the approval request can be raised after the loop has already
      // exited, leaving it pending. The turn then blocks until the 60s
      // approval expiry, the delegation never runs, and the later
      // `readFile(src/helper.ts)` fails with ENOENT — a misleading failure
      // that points at the merge path when the real cause is the harness
      // never approving. The loop now runs until the turn settles.
      //
      // R76 (F2): "the turn settled" must ALSO be established when runTurn
      // REJECTS. In the R72 shape the stop flag was set only after a successful
      // `await runTurn(...)`, so a rejection skipped it entirely: the approved
      // false path left the polling loop running past the test body, still
      // touching `approvalStore` while the OUTER `finally` closed the harness.
      // The stop signal now lives in an inner `finally` that covers both
      // outcomes, and the poller is always awaited.
      const approval = startApprovalPoller(harness);
      let outcome;
      try {
        outcome = await harness.runtime.runTurn(session.id, turn.id, new AbortController().signal);
      } finally {
        await approval.stop();
      }

      expect(outcome.status).toBe("completed");

      // R72: surface the ACTUAL worker/tool/merge outcome before asserting on
      // file content, so a failure never degrades into a bare ENOENT that
      // hides whether the child ran, wrote, or merged. Events are read first
      // because they are the authoritative record of what happened.
      const events = await harness.events.list(session.id);
      const types = events.map((e) => e.type);
      const childSessionId = events.find((e) => e.type === "subagent.started")?.payload.childSessionId as
        | string
        | undefined;
      const mergeOutput = events.find(
        (e) => e.type === "tool.completed" && e.payload.tool === "delegate_worker",
      )?.payload.outputPreview as string | undefined;

      expect(types).toContain("subagent.started");
      expect(types).toContain("subagent.completed");
      // The merge must report the file as applied — not conflicted/skipped.
      expect(mergeOutput).toContain("[workspace merge]");
      expect(mergeOutput).toContain("applied:");

      // The worker's write landed in the PARENT workspace via physical merge.
      const merged = await readFile(join(cwd, "src", "helper.ts"), "utf8");
      expect(merged).toBe(fixtureText);

      // The child session existed and completed its turn; the isolated root is
      // disposed after the delegation (the patch was already extracted).
      expect(childSessionId).toBeTruthy();
      const childTurns = await harness.store.listTurns(childSessionId as never);
      expect(childTurns.at(-1)?.status).toBe("completed");
    } finally {
      await harness.close();
    }
  });
});

/**
 * E4-R76 (F2) — the approval poller must END on the exception path too.
 *
 * R72 bound the poller to the turn's lifecycle with `turnSettled = true` placed
 * AFTER `await runTurn(...)`. That statement only executes on a NORMAL return:
 * when `runTurn` rejects, the flag is never set, `await autoApprove` is never
 * reached, and the loop keeps polling `approvalStore` while the test's outer
 * `finally` closes the harness. These tests drive the exception path in a
 * CONTROLLED way (a rejecting runTurn, no machine load, no real 60s expiry) and
 * assert that the poller stops and the original error survives.
 */
describe("E4-R76 (F2): the approval poller always stops, including when runTurn rejects", () => {
  /** Minimal stand-ins: these tests exercise the POLLER CONTRACT, not the
   *  delegation wiring (which the P3-6 test above already covers end to end). */
  const fakeHarness = () => {
    const pending: Array<{ id: string }> = [];
    const resolved: string[] = [];
    let listCalls = 0;
    return {
      approvalStore: {
        listPending() {
          listCalls += 1;
          return pending;
        },
        resolve(id: string, effect: string, by: string) {
          resolved.push(`${id}:${effect}:${by}`);
          return true;
        },
      },
      pending,
      resolved,
      listCalls: () => listCalls,
    };
  };

  const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

  it("F2 REPRO: the R72 shape leaks the poller when runTurn rejects (no stop flag reachable)", async () => {
    // This is the OLD control flow, reproduced verbatim, to prove the defect is
    // real and not a static-only concern.
    const h = fakeHarness();
    let pollsAfterSettle = 0;
    let settled = false;
    let turnSettled = false;
    const autoApprove = (async () => {
      while (!turnSettled) {
        h.approvalStore.listPending();
        if (settled) pollsAfterSettle += 1;
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
    const runTurn = async (): Promise<void> => {
      throw new Error("runTurn exploded");
    };
    await expect(runTurn()).rejects.toThrow("runTurn exploded");
    settled = true;
    // `turnSettled = true` and `await autoApprove` are UNREACHABLE here — this
    // is exactly the defect. Let the orphaned loop run to prove it is live.
    await tick(60);
    expect(turnSettled).toBe(false);
    expect(pollsAfterSettle).toBeGreaterThan(0);
    // Clean up the deliberately orphaned loop so this test leaves nothing behind.
    turnSettled = true;
    await autoApprove;
  });

  it("F2 FIX: the inner finally stops the poller and preserves the original error", async () => {
    const h = fakeHarness();
    const poller = startApprovalPoller(h);
    await tick(25); // let it poll at least once
    const before = h.listCalls();
    expect(before).toBeGreaterThan(0);

    // The real shape: stop() in an inner finally, so it runs on BOTH outcomes.
    const runTurn = async (): Promise<never> => {
      throw new Error("runTurn exploded");
    };
    const attempt = async (): Promise<unknown> => {
      try {
        return await runTurn();
      } finally {
        await poller.stop();
      }
    };
    // The ORIGINAL error must surface — never masked by a cleanup failure.
    await expect(attempt()).rejects.toThrow("runTurn exploded");

    // The poller is genuinely dead: no further listPending calls after stop.
    const afterStop = h.listCalls();
    await tick(60);
    expect(h.listCalls()).toBe(afterStop);
  });

  it("F2 FIX: stop() is idempotent and awaiting it leaves no live timer", async () => {
    const h = fakeHarness();
    const poller = startApprovalPoller(h, { intervalMs: 5 });
    await tick(20);
    await poller.stop();
    const frozen = h.listCalls();
    // Double-stop must not hang or re-run the loop.
    await poller.stop();
    await tick(30);
    expect(h.listCalls()).toBe(frozen);
  });

  it("F2 FIX: a poller that raises still surfaces its error at stop(), not as an unhandled rejection", async () => {
    const h = fakeHarness();
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => { unhandled.push(err); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const poller = startApprovalPoller(h, {
        intervalMs: 1,
        onPoll: () => { throw new Error("listPending blew up"); },
      });
      await tick(20);
      await expect(poller.stop()).rejects.toThrow("listPending blew up");
      await tick(20);
      // The loop's rejection was consumed by stop() — it must NOT also appear as
      // an unhandled rejection.
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("F2: a LATE approval is still consumed (the R72 win is preserved, not reverted)", async () => {
    // R76 must not regress R72: the poller is lifecycle-bound, NOT budget-bound,
    // so an approval raised long after the first polls is still approved.
    const h = fakeHarness();
    const poller = startApprovalPoller(h, { intervalMs: 5 });
    await tick(30);
    // Simulate the approval arriving "late" — well past any fixed small budget.
    h.pending.push({ id: "late-approval" });
    await tick(30);
    expect(h.resolved).toContain("late-approval:allow:test");
    await poller.stop();
  });
});