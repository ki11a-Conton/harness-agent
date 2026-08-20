import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newEventId, newSessionId, type AgentEvent } from "@ar/contracts";
import { JSONLEventStore } from "./event-store.js";

/**
 * P5-1: JSONL store performance characteristics (1k / 10k / 50k scale).
 *
 * The assertions are DETERMINISTIC (read-traffic counters), not wall-clock:
 * - Before P5-2 the store re-read the whole JSONL file on every append —
 *   2_000 appends to one session parsed ~2M lines (O(n²)).
 * - After P5-2 the cache keeps appends O(1); the same run parses 0 lines
 *   after the first touch. The test fails loudly if quadratic behaviour ever
 *   returns, without depending on machine speed.
 *
 * Wall-clock figures are printed (p50/p95 window approximations) for the
 * plan.md record and for a human running `vitest run --reporter=verbose`.
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
  return mkdtemp(join(tmpdir(), "harness-events-perf-"));
}

describe("P5-1/P5-2: JSONL event store scaling", () => {
  it("appends 1k events to one session with O(1) read traffic per append", async () => {
    const dataDir = await freshDataDir();
    try {
      const store = new JSONLEventStore({ dataDir });
      const sid = newSessionId();
      const started = performance.now();
      for (let i = 0; i < 1_000; i++) {
        await store.append({ ...makeEvent(), sessionId: sid });
      }
      const elapsed = performance.now() - started;
      const stats = store.debugStats();
      // Quadratic behaviour would parse ~500k lines here; linear parses 0
      // (file didn't exist on first touch, cache served the rest).
      expect(stats.linesRead).toBeLessThan(1_000);
      // The log is still fully durable on disk.
      const events = await store.list(sid);
      expect(events).toHaveLength(1_000);
      console.log(
        `[P5-1] 1k appends: ${elapsed.toFixed(1)}ms, linesRead=${stats.linesRead}, cached=${stats.cachedSessions}`,
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("10k appends stay linear (p50/p95 windows) and list is instant", async () => {
    const dataDir = await freshDataDir();
    try {
      const store = new JSONLEventStore({ dataDir });
      const sid = newSessionId();
      const windows: number[] = [];
      const started = performance.now();
      let windowStart = started;
      for (let i = 0; i < 10_000; i++) {
        await store.append({ ...makeEvent(), sessionId: sid });
        if ((i + 1) % 500 === 0) {
          windows.push(performance.now() - windowStart);
          windowStart = performance.now();
        }
      }
      const elapsed = performance.now() - started;
      const sorted = [...windows].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
      const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
      // Every window is 500 appends; a linear store keeps them roughly flat.
      // Quadratic would grow ~linearly with each window. Loose factor check.
      const max = Math.max(...windows);
      expect(max).toBeLessThan(p50 * 12 + 2_000);
      expect(store.debugStats().linesRead).toBeLessThan(100);
      expect(await store.list(sid)).toHaveLength(10_000);
      console.log(
        `[P5-1] 10k appends: ${elapsed.toFixed(1)}ms total, window p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("50k appends complete without pathological blow-up (recorded for plan.md)", async () => {
    const dataDir = await freshDataDir();
    try {
      const store = new JSONLEventStore({ dataDir });
      const sid = newSessionId();
      const started = performance.now();
      for (let i = 0; i < 50_000; i++) {
        await store.append({ ...makeEvent(), sessionId: sid });
      }
      const elapsed = performance.now() - started;
      const diskBytes = statSync(join(dataDir, `${sid}.jsonl`)).size;
      console.log(
        `[P5-1] 50k appends: ${elapsed.toFixed(1)}ms, linesRead=${store.debugStats().linesRead}, ` +
          `diskBytes=${diskBytes}`,
      );
      expect(await store.list(sid)).toHaveLength(50_000);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("interleaved sessions keep independent O(1) appends (multi-session scale)", async () => {
    const dataDir = await freshDataDir();
    try {
      const store = new JSONLEventStore({ dataDir });
      const sessions = Array.from({ length: 20 }, () => newSessionId());
      for (let i = 0; i < 2_000; i++) {
        await store.append({ ...makeEvent(), sessionId: sessions[i % sessions.length]! });
      }
      const stats = store.debugStats();
      // Each session was loaded exactly once (first touch) — at most 20 line
      // parses, never 2k*20.
      expect(stats.linesRead).toBeLessThanOrEqual(20);
      expect(stats.cachedSessions).toBe(sessions.length);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
