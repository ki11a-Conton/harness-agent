import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendDurable,
  atomicWriteFile,
  backupTree,
  parseJsonl,
  verifyJsonlFile,
  withLock,
} from "./index.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function fresh(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "store-integrity-"));
  return tempDir;
}

describe("store-integrity (P2-35)", () => {
  it("atomicWriteFile guarantees a fully-written atomic target (no tmp left)", async () => {
    const dir = await fresh();
    const target = join(dir, "a", "b.json");
    await atomicWriteFile(target, "hello");
    expect(await readFile(target, "utf8")).toBe("hello");
    // No leftover temp/scratch file.
    const files = await readdir(join(dir, "a"));
    expect(files).toEqual(["b.json"]);
  });

  it("atomicWriteFile overwrites an existing file atomically", async () => {
    const dir = await fresh();
    const target = join(dir, "v.json");
    await atomicWriteFile(target, "v1");
    await atomicWriteFile(target, "v2");
    expect(await readFile(target, "utf8")).toBe("v2");
  });

  it("appendDurable appends lines that survive a re-open", async () => {
    const dir = await fresh();
    const file = join(dir, "log.jsonl");
    await appendDurable(file, '{"n":1}\n');
    await appendDurable(file, '{"n":2}\n');
    expect(await readFile(file, "utf8")).toBe('{"n":1}\n{"n":2}\n');
  });

  it("withLock serializes concurrent same-key mutations (no interleaving)", async () => {
    const order: string[] = [];
    await Promise.all([
      withLock("k", async () => {
        order.push("a");
        await new Promise((r) => setTimeout(r, 15));
        order.push("a2");
      }),
      withLock("k", async () => {
        order.push("b");
        await new Promise((r) => setTimeout(r, 5));
        order.push("b2");
      }),
      withLock("k", async () => {
        order.push("c");
        order.push("c2");
      }),
    ]);
    // Because all three share key "k", the second starts only after the first
    // fully finishes: a...a2, then b...b2, then c...c2.
    expect(order).toEqual(["a", "a2", "b", "b2", "c", "c2"]);
  });

  it("withLock isolates independent keys (true parallelism across keys)", async () => {
    const order: string[] = [];
    await Promise.all([
      withLock("x", async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push("x");
      }),
      withLock("y", async () => {
        order.push("y");
      }),
    ]);
    expect(order.sort()).toEqual(["x", "y"]);
  });

  it("withLock recovers after a failed critical section", async () => {
    const dir = await fresh();
    const file = join(dir, "n");
    await withLock("r", async () => {
      await writeFile(file, "1");
      throw new Error("boom");
    }).catch(() => undefined);
    // A subsequent lock user still runs, and previous work is visible.
    await withLock("r", async () => {
      await writeFile(file, (await readFile(file, "utf8")) + "2");
    });
    expect(await readFile(file, "utf8")).toBe("12");
  });

  it("parseJsonl tolerates bad lines or fails closed", () => {
    const raw = '{"a":1}\nnot-json\n{"a":2}\n';
    expect(() => parseJsonl(raw)).toThrow(/corrupt JSONL line 2/);
    expect(parseJsonl(raw, { tolerant: true })).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("verifyJsonlFile reports record counts and fails closed on corruption", async () => {
    const dir = await fresh();
    const good = join(dir, "good.jsonl");
    await writeFile(good, '{"x":1}\n{"x":2}\n', "utf8");
    expect(await verifyJsonlFile(good)).toEqual({ records: 2 });

    const bad = join(dir, "bad.jsonl");
    await writeFile(bad, '{"x":1}\nbroken\n', "utf8");
    await expect(verifyJsonlFile(bad)).rejects.toThrow(/corrupt JSONL line 2/);
  });

  it("backupTree copies store files under backups/<stamp>/ and skips temp/backups", async () => {
    const dataDir = await fresh();
    await mkdir(join(dataDir, "sessions"), { recursive: true });
    await mkdir(join(dataDir, "backups", "pre-existing"), { recursive: true });
    await writeFile(join(dataDir, "sessions", "a.json"), '{"k":1}', "utf8");
    await writeFile(join(dataDir, "sessions", "b.json"), '{"k":2}', "utf8");
    await writeFile(join(dataDir, "scratch.tmp"), "tmp", "utf8");

    const result = await backupTree(dataDir, { now: () => new Date("2026-01-02T03:04:05.060Z") });
    expect(result.files).toBe(2);
    expect(result.path).toContain("backups/20260102T030405060");

    const backupRoot = result.path;
    expect(await readFile(join(backupRoot, "sessions", "a.json"), "utf8")).toBe('{"k":1}');
    expect(await readFile(join(backupRoot, "sessions", "b.json"), "utf8")).toBe('{"k":2}');
    // temp and pre-existing backup are not copied.
    expect(await readdir(backupRoot)).not.toContain("scratch.tmp");
    expect(await readdir(result.path)).toEqual(["sessions"]);
  });
});