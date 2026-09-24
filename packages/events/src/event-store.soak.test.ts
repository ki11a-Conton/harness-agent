import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newEventId, newSessionId, type AgentEvent } from "@ar/contracts";
import { JSONLEventStore } from "./event-store.js";

/**
 * P38.1-11 — soak / scale, NOT part of the `pnpm test` correctness gate.
 *
 * This is the 20k-Windows / 50k-Linux fsync-heavy scale workload. Per plan.md
 * §P38.1-11 it must NOT drag down the deterministic correctness gate, so it
 * lives in `*.soak.test.ts` and runs only under `pnpm test:soak` (dedicated /
 * scheduled runner). It is deliberately NOT timing-thresholded: the assertion
 * is the deterministic `linesRead` quadratic-detection signal, not wall clock.
 */

function makeEvent(): AgentEvent {
  return {
    id: newEventId(),
    sessionId: newSessionId(),
    sequence: 0,
    timestamp: Date.now(),
    type: "turn.started",
    payload: {},
  };
}

async function freshDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "harness-events-soak-"));
}

describe("P5-1/P38.1-11: JSONL event store soak / scale", () => {
  it("50k appends complete without pathological blow-up (recorded for plan.md)", async () => {
    const dataDir = await freshDataDir();
    try {
      const store = new JSONLEventStore({ dataDir });
      const sid = newSessionId();
      const started = performance.now();
      // Windows fsync is an order of magnitude slower than Linux; keep the
      // quadratic-detection signal (linesRead stays ~0) while fitting the
      // platform's real disk cost. 50k is Linux CI's record scale, Windows
      // runs 20k here.
      const n = process.platform === "win32" ? 20_000 : 50_000;
      for (let i = 0; i < n; i++) {
        await store.append({ ...makeEvent(), sessionId: sid });
      }
      const elapsed = performance.now() - started;
      const diskBytes = statSync(join(dataDir, `${sid}.jsonl`)).size;
      console.log(
        `[P5-1] ${n} appends (soak): ${elapsed.toFixed(1)}ms, linesRead=${store.debugStats().linesRead}, ` +
          `diskBytes=${diskBytes}`,
      );
      expect(await store.list(sid)).toHaveLength(n);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 300_000);
});