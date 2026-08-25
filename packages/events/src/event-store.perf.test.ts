import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newEventId, newSessionId, type AgentEvent } from "@ar/contracts";
import { JSONLEventStore } from "./event-store.js";

/**
 * P5-1/P38.1-11: JSONL store performance gate (`pnpm test:perf`).
 *
 * This is the small, deterministic workload that guards against quadratic
 * read-traffic (linesRead counter), re-admitted as the PERF gate after the
 * 50k/20k fsync soak moved to `event-store.soak.test.ts` (`pnpm test:soak`).
 * `pnpm test` (correctness) excludes both gates.
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
  }, 180_000);

  it("10k appends stay linear (p50/p95 windows) and list is instant", async () => {
    const dataDir = await freshDataDir();
    try {
      const store = new JSONLEventStore({ dataDir });
      const sid = newSessionId();
      // Windows fsync is an order of magnitude slower than Linux and shared
      // runners can be slow (AV scan); keep the quadratic-detection signal
      // (linesRead) while fitting the platform's real disk cost — same
      // pattern as the 50k test below.
      const n = process.platform === "win32" ? 5_000 : 10_000;
      const windowSize = 500;
      const windows: number[] = [];
      const started = performance.now();
      let windowStart = started;
      for (let i = 0; i < n; i++) {
        await store.append({ ...makeEvent(), sessionId: sid });
        if ((i + 1) % windowSize === 0) {
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
      expect(await store.list(sid)).toHaveLength(n);
      console.log(
        `[P5-1] ${n} appends: ${elapsed.toFixed(1)}ms total, window p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 240_000);

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
  }, 180_000);
});
