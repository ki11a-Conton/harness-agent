// P33 — orchestration unit tests: pure logic (no I/O).
import { describe, expect, it } from "vitest";
import { workId, type WorkItem } from "./work-item.js";
import { createState, scheduler, statusOf } from "./scheduler.js";
import { computeRetryDelay, scheduleRetry, retryDue, DEFAULT_RETRY, RetryScheduler } from "./retry-policy.js";
import { parseWorkflow, WorkflowParseError } from "./workflow-loader.js";
import { sanitizeKey, hashSuffix, workspaceFor } from "./workspace-manager.js";

describe("P33-3 WorkItem", () => {
  it("opaque ref is preserved without interpretation", () => {
    const item: WorkItem = {
      id: "github-42",
      identifier: "GH-42",
      title: "Fix the bug",
      state: "todo",
      labels: ["backend"],
      dispatchable: true,
      opaque: { kind: "github", value: "https://github.com/x/y/issues/42" },
    };
    expect(item.opaque?.kind).toBe("github");
    expect(item.id).toBe("github-42");
  });

  it("workId() brands a string", () => {
    const id = workId("abc");
    expect(id).toBe("abc");
  });
});

describe("P33-4 scheduler state machine invariants", () => {
  it("claim → running ⊆ claimed", () => {
    const s = createState();
    scheduler.claim(s, workId("a"), "w1", 1000);
    expect(s.claimed.has(workId("a"))).toBe(true);
    expect(s.running.get(workId("a"))?.workerId).toBe("w1");
    expect(statusOf(s, workId("a"))).toBe("running");
  });

  it("terminal clears everything and is final", () => {
    const s = createState();
    const id = workId("a");
    scheduler.claim(s, id, "w1", 1000);
    scheduler.block(s, id, "external", 2000);
    scheduler.unblock(s, id);
    scheduler.retry(s, id, 1, 5000);
    scheduler.terminal(s, id);
    expect(s.terminal.has(id)).toBe(true);
    expect(s.running.has(id)).toBe(false);
    expect(s.claimed.has(id)).toBe(false);
    expect(s.blocked.has(id)).toBe(false);
    expect(s.retries.has(id)).toBe(false);
    expect(statusOf(s, id)).toBe("terminal");
  });

  it("running ∩ blocked = ∅ after block", () => {
    const s = createState();
    const id = workId("b");
    scheduler.claim(s, id, "w1", 1000);
    scheduler.block(s, id, "inactive", 2000);
    expect(s.running.has(id)).toBe(false);
    expect(s.blocked.get(id)?.reason).toBe("inactive");
    expect(statusOf(s, id)).toBe("blocked");
  });

  it("claim is idempotent (no-op on re-claim)", () => {
    const s = createState();
    const id = workId("c");
    scheduler.claim(s, id, "w1", 1000);
    scheduler.claim(s, id, "w2", 2000);
    expect(s.running.get(id)?.workerId).toBe("w1"); // first claim wins
  });
});

describe("P33-7 retry policy", () => {
  it("exponential backoff grows, jittered, within max", () => {
    const s1 = scheduleRetry(DEFAULT_RETRY, 0, 0, () => 0.5); // jitter = 0
    const s2 = scheduleRetry(DEFAULT_RETRY, 1, 0, () => 0.5);
    expect(s1.attempt).toBe(1);
    expect(s2.attempt).toBe(2);
    expect(s2.nextAttemptAt - s1.nextAttemptAt).toBeGreaterThan(0); // grows
  });

  it("abandons after maxAttempts (attempt >= maxAttempts → INF)", () => {
    const s = scheduleRetry({ ...DEFAULT_RETRY, maxAttempts: 2 }, 1, 0, () => 0.5);
    // failureCount=1 < maxAttempts=2 → one retry remains, scheduled.
    expect(s.attempt).toBe(2);
    expect(s.nextAttemptAt).not.toBe(Number.POSITIVE_INFINITY);
    // failureCount=2 >= maxAttempts=2 → abandoned.
    const done = scheduleRetry({ ...DEFAULT_RETRY, maxAttempts: 2 }, 2, 0, () => 0.5);
    expect(done.nextAttemptAt).toBe(Number.POSITIVE_INFINITY);
  });

  it("retryDue respects injected clock", () => {
    const s = scheduleRetry(DEFAULT_RETRY, 0, 1000, () => 0.5); // jitter=0 → delay=1000
    expect(s.nextAttemptAt).toBe(2000);
    expect(retryDue(s, 1999)).toBe(false);
    expect(retryDue(s, 2000)).toBe(true);
  });

  it("RetryScheduler uses injected monotonic clock", () => {
    let t = 0;
    const rs = new RetryScheduler(DEFAULT_RETRY, () => t);
    const r = rs.next(0);
    expect(r.nextAttemptAt).toBeGreaterThan(t);
    expect(rs.due(r)).toBe(false);
    t = r.nextAttemptAt;
    expect(rs.due(r)).toBe(true);
  });

  it("computeRetryDelay is deterministic under a fixed jitter", () => {
    expect(computeRetryDelay(DEFAULT_RETRY, 0, 0, () => 0.5)).toBe(
      computeRetryDelay(DEFAULT_RETRY, 0, 0, () => 0.5),
    );
  });
});

describe("P33-8 WORKFLOW.md parser", () => {
  const MD = `---
tracker: fake
polling: 15000
max_concurrent: 3
workspace: .workspaces
---

Work on the assigned item.

Before handoff:
- inspect the repository
- implement the requested change
`;

  it("parses flat front matter + body", () => {
    const cfg = parseWorkflow(MD);
    expect(cfg.tracker).toBe("fake");
    expect(cfg.pollingIntervalMs).toBe(15000);
    expect(cfg.maxConcurrent).toBe(3);
    expect(cfg.workspaceRoot).toBe(".workspaces");
    expect(cfg.prompt).toContain("Work on the assigned item.");
    expect(cfg.prompt).toContain("- implement the requested change");
  });

  it("ignores unknown keys (forward compatibility)", () => {
    const cfg = parseWorkflow("---\ntracker: fake\nfuture_flag: on\n---\nbody");
    expect(cfg.tracker).toBe("fake");
    expect(cfg.prompt).toBe("body");
  });

  it("no front matter → whole doc is prompt", () => {
    const cfg = parseWorkflow("just a prompt\n");
    expect(cfg.tracker).toBeUndefined();
    expect(cfg.prompt).toBe("just a prompt");
  });

  it("invalid known field fails with typed error", () => {
    expect(() => parseWorkflow("---\npolling: abc\n---\nx")).toThrow(WorkflowParseError);
    expect(() => parseWorkflow("---\ntracker: fake")).toThrow(/unterminated/i);
  });
});

describe("P33-9 workspace isolation", () => {
  it("sanitizes identifiers into safe segments", () => {
    expect(sanitizeKey("GH-42: Fix bugs!")).toBe("gh-42-fix-bugs");
    expect(sanitizeKey("!!!")).toBe("item"); // degenerate
    expect(sanitizeKey("ABC-123")).toBe("abc-123");
  });

  it("hashSuffix is stable and different for different ids", () => {
    expect(hashSuffix("a")).toBe(hashSuffix("a"));
    expect(hashSuffix("a")).not.toBe(hashSuffix("b"));
  });

  it("distinct identifiers never share a workspace", () => {
    const w1 = workspaceFor("GH-1", "github-1", "/root");
    const w2 = workspaceFor("GH-1", "github-2", "/root");
    expect(w1.dir).not.toBe(w2.dir);
    // Same item → same dir (deterministic resume).
    const w3 = workspaceFor("GH-1", "github-1", "/root");
    expect(w1.dir).toBe(w3.dir);
  });
});