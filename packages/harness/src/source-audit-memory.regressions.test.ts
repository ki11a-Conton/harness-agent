import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { newMemoryId, newSessionId, type MemoryScope } from "@ar/contracts";
import { ScriptedModelProvider } from "@ar/model";
import { createHarness } from "./create-harness.js";

it.each(["jsonl", "sqlite"] as const)("B18: %s isolates repositories, preserves same-repo reuse and explicit global sharing", async (backend) => {
  const root = await mkdtemp(join(tmpdir(), "audit-memory-")); const data = join(root, "data");
  const [a, b, clone] = ["a", "b", "clone"].map((name) => join(root, name));
  const open = (cwd: string, scope?: MemoryScope) => createHarness({ cwd, dataDir: data, profile: "test", model: { providerId: "scripted", modelId: "scripted-model" }, modelProvider: new ScriptedModelProvider([]), memory: { enabled: true, ...(backend === "sqlite" ? { dbPath: data } : {}), ...(scope ? { scope } : {}) } });
  try {
    for (const dir of [a!, b!, clone!]) {
      await mkdir(dir); execFileSync("git", ["init", "--quiet", dir]);
      execFileSync("git", ["-C", dir, "remote", "add", "origin", `https://example.invalid/${dir === b ? "b" : "a"}.git`]);
    }
    for (const scope of ["repository", "global"] as const) {
      const id = newMemoryId(); const first = await open(a!, scope);
      try { await first.memoryStore!.write({ id, content: "shared ownership boundary", type: "explicit", sourceSession: newSessionId(), importance: 1, confidence: 1, novelty: 1, stability: 1, scope, createdAt: Date.now(), updatedAt: Date.now(), deleted: false }); }
      finally { await first.close(); }
      for (const dir of [b!, clone!]) {
        const next = await open(dir, scope);
        try { const result = await next.memoryBridge!.retrieve({ sessionId: newSessionId(), goal: "shared ownership boundary", cwd: dir, recordFeedback: false }); expect(result.items.some((item) => item.memory.id === id)).toBe(scope === "global" || dir === clone); }
        finally { await next.close(); }
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
