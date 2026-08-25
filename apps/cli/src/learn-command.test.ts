// P2-7: `agent learn` lifecycle commands — explicit evaluation and promotion
// with write-gate re-checks and sandbox isolation.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newMemoryId, newSessionId, newTurnId, type MemoryStore } from "@ar/contracts";
import { JsonlMemoryStore } from "@ar/memory";
import type { LearningCandidate } from "@ar/learning";
import { JsonlCandidateStore } from "@ar/harness";
import { learnCmd } from "./learn-command.js";

let tempDirs: string[] = [];
async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-learn-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

function goodCandidate(id = "lc-test"): LearningCandidate {
  return {
    id,
    kind: "memory",
    content: "when a tool fails with ENOENT, search the repository tree first",
    proposedAt: 1000,
    securityChecked: true,
    sourceCandidate: {
      content: "when a tool fails with ENOENT, search the repository tree first",
      type: "procedural",
      sourceSession: newSessionId(),
      importance: 0.8,
      confidence: 0.7,
      novelty: 0.5,
      stability: 0.6,
      structured: {
        when: "a tool fails with ENOENT",
        do: "search the repository tree",
        avoid: "guessing paths again",
        rootCause: "tool",
        outcome: "failure",
        evidenceRefs: ["ev-1"],
      },
    },
  };
}

function weakCandidate(id = "lc-weak"): LearningCandidate {
  const c = goodCandidate(id);
  c.sourceCandidate = { ...c.sourceCandidate!, importance: 0.1 };
  return c;
}

describe("P2-7: learn candidates", () => {
  it("reports an empty queue", async () => {
    const dataDir = await tempDataDir();
    const result = await learnCmd(["candidates"], { candidates: new JsonlCandidateStore({ dataDir }) });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("no learning candidates queued");
  });

  it("lists queued candidates with status", async () => {
    const dataDir = await tempDataDir();
    const store = new JsonlCandidateStore({ dataDir });
    await store.add(goodCandidate());
    const result = await learnCmd(["candidates"], { candidates: store });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("lc-test");
    expect(result.lines.join("\n")).toContain("pending evaluation");
  });
});

describe("P2-7: learn evaluate", () => {
  it("rejects an unknown candidate id", async () => {
    const dataDir = await tempDataDir();
    const result = await learnCmd(["evaluate", "nope"], { candidates: new JsonlCandidateStore({ dataDir }) });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("unknown candidate");
  });

  it("rejects a candidate below the write-gate threshold", async () => {
    const dataDir = await tempDataDir();
    const store = new JsonlCandidateStore({ dataDir });
    await store.add(weakCandidate());
    const result = await learnCmd(["evaluate", "lc-weak"], { candidates: store });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("write gate rejects");
  });

  it("passes a healthy candidate through the sandbox", async () => {
    const dataDir = await tempDataDir();
    const store = new JsonlCandidateStore({ dataDir });
    await store.add(goodCandidate());
    const result = await learnCmd(["evaluate", "lc-test"], { candidates: store });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("write gate: allowed");
    expect(result.lines.join("\n")).toContain("sandbox: clean");
  });
});

describe("P2-7: learn promote", () => {
  it("refuses promotion without a wired memory store", async () => {
    const dataDir = await tempDataDir();
    const store = new JsonlCandidateStore({ dataDir });
    await store.add(goodCandidate());
    const result = await learnCmd(["promote", "lc-test"], { candidates: store });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("no memory store wired");
  });

  it("promotes a healthy candidate into the memory store and dequeues it", async () => {
    const dataDir = await tempDataDir();
    const candidates = new JsonlCandidateStore({ dataDir });
    await candidates.add(goodCandidate());
    const memory: MemoryStore = new JsonlMemoryStore({ dataDir: join(dataDir, "mem") });
    const result = await learnCmd(["promote", "lc-test"], {
      candidates,
      memoryStore: memory,
      cwd: dataDir, // a non-git temp dir → path identity → scope "workspace"
    });

    expect(result.exitCode).toBe(0);
    const lines = result.lines.join("\n");
    expect(lines).toContain("PROMOTED");
    expect(lines).toContain("memory id:");

    // The candidate is gone from the queue and its lesson is persisted.
    expect(await candidates.get("lc-test")).toBeUndefined();
    const entries = await memory.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.content).toContain("ENOENT");
    expect(entries[0]!.structured).toBeDefined();
    expect(entries[0]!.scope).toBe("workspace"); // path identity → workspace
  });

  it("rejects a weak candidate at promotion time too", async () => {
    const dataDir = await tempDataDir();
    const candidates = new JsonlCandidateStore({ dataDir });
    await candidates.add(weakCandidate());
    const memory: MemoryStore = new JsonlMemoryStore({ dataDir: join(dataDir, "mem") });
    const result = await learnCmd(["promote", "lc-weak"], {
      candidates,
      memoryStore: memory,
      cwd: "/workspace",
    });
    expect(result.exitCode).toBe(1);
    expect(await candidates.get("lc-weak")).toBeDefined(); // still queued
  });
});

describe("P2-7: learn reevaluate", () => {
  it("summarizes pending and promoted candidates", async () => {
    const dataDir = await tempDataDir();
    const store = new JsonlCandidateStore({ dataDir });
    await store.add(goodCandidate());
    const result = await learnCmd(["reevaluate"], { candidates: store });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("1 pending candidate(s)");
  });
});

describe("P17-1/P17-2: learn promote gates", () => {
  function withMetadata(over: Partial<import("@ar/contracts").MemoryCandidate>): LearningCandidate {
    const c = goodCandidate();
    c.sourceCandidate = { ...c.sourceCandidate!, ...over };
    return c;
  }

  it("rejects a QUARANTINED candidate (untrusted pollution) — never auto-promoted", async () => {
    const dataDir = await tempDataDir();
    const candidates = new JsonlCandidateStore({ dataDir });
    await candidates.add(withMetadata({
      promotionState: "quarantined",
      pollutionSources: ["mcp:mcp_search"],
    }));
    const memory: MemoryStore = new JsonlMemoryStore({ dataDir: join(dataDir, "mem") });
    const result = await learnCmd(["promote", "lc-test"], { candidates, memoryStore: memory, cwd: "/workspace" });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("quarantined");
    expect(await candidates.get("lc-test")).toBeDefined(); // still queued
    expect((await memory.list())).toHaveLength(0); // nothing persisted
  });

  it("rejects a DERIVABLE fact (re-obtainable from repo) — not stored long-term", async () => {
    const dataDir = await tempDataDir();
    const candidates = new JsonlCandidateStore({ dataDir });
    await candidates.add(withMetadata({
      derivability: { verdict: "derivable", reason: "re-derivable from repo/git/config" },
    }));
    const memory: MemoryStore = new JsonlMemoryStore({ dataDir: join(dataDir, "mem") });
    const result = await learnCmd(["promote", "lc-test"], { candidates, memoryStore: memory, cwd: "/workspace" });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("derivable");
    expect((await memory.list())).toHaveLength(0);
  });

  it("promotes a non-derivable pending candidate and preserves provenance", async () => {
    const dataDir = await tempDataDir();
    const candidates = new JsonlCandidateStore({ dataDir });
    await candidates.add(withMetadata({
      promotionState: "pending",
      derivability: { verdict: "non-derivable", reason: "user preference" },
      sourceTurn: newTurnId(),
      securityScan: { checked: true, passed: true, at: 1000 },
    }));
    const memory: MemoryStore = new JsonlMemoryStore({ dataDir: join(dataDir, "mem") });
    const result = await learnCmd(["promote", "lc-test"], { candidates, memoryStore: memory, cwd: "/workspace" });
    expect(result.exitCode).toBe(0);
    const entries = await memory.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.derivability?.verdict).toBe("non-derivable");
    expect(entries[0]!.sourceTurn).toBeDefined();
    expect(entries[0]!.securityScan?.passed).toBe(true);
  });
});
