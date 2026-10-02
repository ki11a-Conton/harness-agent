import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newAgentId, newSessionId, newToolCallId, newTurnId, type ToolExecutionContext } from "@ar/contracts";
import { ToolRegistry } from "./registry.js";
import { ToolOrchestrator } from "./orchestrator.js";
import { readFileTool } from "./tools/read-file.js";
import { writeFileTool } from "./tools/write-file.js";
import { editFileTool } from "./tools/edit-file.js";
import { applyLineRange, applyReplace } from "./edit.js";
import { WorkspaceChangeTransaction } from "./transaction.js";
import { fileLockEntryCount, withFileLock, withFileLocks } from "./file-coordination.js";

// The leaf tools dynamically import node:fs/promises. Forward reads through
// the same promises object the barrier spies on, rather than assuming Node's
// separate named-export binding changes when fs.promises.readFile is spied on.
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, readFile: (...args: Parameters<typeof fs.readFile>) => fs.readFile(...args) };
});

let ws = "";
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
beforeEach(async () => { ws = await fs.mkdtemp(join(tmpdir(), "r4-edit-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(ws, { recursive: true, force: true }); });

function harness(signal = new AbortController().signal, permission: "allow" | "deny" = "allow") {
  const registry = new ToolRegistry();
  for (const tool of [readFileTool, writeFileTool, editFileTool]) registry.register(tool);
  const orch = new ToolOrchestrator({ registry, workspaceRoot: ws });
  const context: ToolExecutionContext = {
    cwd: ws, sessionId: newSessionId(), turnId: newTurnId(), agentId: newAgentId(), signal,
    permissions: { rules: [{ action: "read", resource: "file", effect: permission }, { action: "edit", resource: "file", effect: permission }] },
    sandboxPolicy: { filesystem: { mode: "workspace-write", allowedPaths: [ws] }, network: { mode: "deny" }, process: { timeoutMs: 2000, maxOutputBytes: 100000 } },
  };
  return { context, invoke(name: string, args: Record<string, unknown>) {
    const id = newToolCallId();
    return orch.execute({ id, sessionId: context.sessionId, turnId: context.turnId, agentId: context.agentId, call: { id, name, args } }, context);
  } };
}

/** A real read snapshot is held so an overlapping second participant can
 * enter on the old implementation. A lock makes it wait until the first
 * write finishes instead. The rendezvous releases after both reads or 60ms. */
function holdReads(target: string | string[]) {
  const read = fs.readFile.bind(fs);
  let readers = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const deadline = setTimeout(release, 60);
  vi.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    const snapshot = await read(...args);
    if ((Array.isArray(target) ? target : [target]).includes(String(args[0]))) { readers += 1; if (readers === 2) release(); await barrier; }
    return snapshot;
  }) as typeof fs.readFile);
  return { done() { clearTimeout(deadline); release(); } };
}

describe("R4 cooperative file edits", () => {
  it("preserves independent edits through existing hard-link aliases", async () => {
    const target = join(ws, "hard-original.txt");
    const alias = join(ws, "hard-alias.txt");
    await fs.writeFile(target, "A=0\nB=0\n");
    await fs.link(target, alias);
    expect((await fs.stat(target)).ino).toBe((await fs.stat(alias)).ino);
    const gate = holdReads([target, alias]);
    const results = await Promise.all([
      harness().invoke("edit_file", { path: "hard-original.txt", oldText: "A=0", newText: "A=1" }),
      harness().invoke("edit_file", { path: "hard-alias.txt", oldText: "B=0", newText: "B=1" }),
    ]);
    gate.done();
    expect(results.map((result) => result.status)).toEqual(["success", "success"]);
    expect(await fs.readFile(target, "utf8")).toBe("A=1\nB=1\n");
    expect(await fs.readFile(alias, "utf8")).toBe("A=1\nB=1\n");
    expect(fileLockEntryCount()).toBe(0);
  });

  it("preserves two independent edits from separate sessions and orchestrators", async () => {
    const target = join(ws, "race.txt");
    await fs.writeFile(target, "A=0\nB=0\n");
    const gate = holdReads(target);
    const results = await Promise.all([
      harness().invoke("edit_file", { path: "race.txt", oldText: "A=0", newText: "A=1" }),
      harness().invoke("edit_file", { path: "race.txt", oldText: "B=0", newText: "B=1" }),
    ]);
    gate.done();
    expect(results.map((result) => result.status)).toEqual(["success", "success"]);
    expect(await fs.readFile(target, "utf8")).toBe("A=1\nB=1\n");
  });

  it("serializes append and a concurrent edit without discarding the appended bytes", async () => {
    const target = join(ws, "append-race.txt");
    await fs.writeFile(target, "A=0\n");
    const gate = holdReads(target);
    const results = await Promise.all([
      harness().invoke("edit_file", { path: "append-race.txt", oldText: "A=0", newText: "A=1" }),
      harness().invoke("write_file", { path: "append-race.txt", content: "tail\n", append: true }),
    ]);
    gate.done();
    expect(results.map((result) => result.status)).toEqual(["success", "success"]);
    expect(await fs.readFile(target, "utf8")).toBe("A=1\ntail\n");
  });

  it("makes a versioned read wait for a cooperating edit and report its new bytes", async () => {
    const target = join(ws, "read-race.txt");
    await fs.writeFile(target, "A=0\n");
    const gate = holdReads(target);
    const [edit, read] = await Promise.all([
      harness().invoke("edit_file", { path: "read-race.txt", oldText: "A=0", newText: "A=1" }),
      harness().invoke("read_file", { path: "read-race.txt", versioned: true }),
    ]);
    gate.done();
    expect(edit.status).toBe("success");
    expect(read.output).toEqual({ path: target, content: "A=1\n", bytes: 4, sha256: digest("A=1\n") });
  });

  it("shares file identity through an in-workspace directory alias", async () => {
    const directory = join(ws, "real");
    await fs.mkdir(directory);
    await fs.symlink(directory, join(ws, "alias"), process.platform === "win32" ? "junction" : "dir");
    await fs.writeFile(join(directory, "file.txt"), "A=0\nB=0\n");
    const read = fs.readFile.bind(fs);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const deadline = setTimeout(release, 60);
    let readers = 0;
    vi.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      const value = await read(...args);
      if (String(args[0]).endsWith("file.txt")) { readers += 1; if (readers === 2) release(); await barrier; }
      return value;
    }) as typeof fs.readFile);
    try {
      const results = await Promise.all([
        harness().invoke("edit_file", { path: "real/file.txt", oldText: "A=0", newText: "A=1" }),
        harness().invoke("edit_file", { path: "alias/file.txt", oldText: "B=0", newText: "B=1" }),
      ]);
      expect(results.map((result) => result.status)).toEqual(["success", "success"]);
      expect(await read(join(directory, "file.txt"), "utf8")).toBe("A=1\nB=1\n");
    } finally { clearTimeout(deadline); release(); }
  });

  it("exposes raw-byte version to the model while keeping default read a string", async () => {
    const content = "\ufeff中文\r\nbody\n";
    await fs.writeFile(join(ws, "version.txt"), content);
    const agent = harness();
    const plain = await agent.invoke("read_file", { path: "version.txt" });
    expect(plain.output).toBe(content);
    const versioned = await agent.invoke("read_file", { path: "version.txt", versioned: true });
    expect(versioned.output).toEqual({ path: join(ws, "version.txt"), content, bytes: Buffer.byteLength(content), sha256: digest(content) });
  });

  it("refuses a stale range before any write and permits a reread version", async () => {
    const path = join(ws, "stale.txt");
    await fs.writeFile(path, "A\nB\nC");
    const agent = harness();
    await fs.writeFile(path, "HEADER\nA\nB\nC");
    const before = await fs.readFile(path);
    const result = await agent.invoke("edit_file", { path: "stale.txt", lineStart: 2, lineEnd: 2, replacement: "FIXED_B", expectedSha256: digest("A\nB\nC") });
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ retryable: false, safeToRetry: false });
    expect(result.error?.message).toMatch(/changed|stale|version/i);
    expect(await fs.readFile(path)).toEqual(before);
    const retry = await agent.invoke("edit_file", { path: "stale.txt", lineStart: 3, lineEnd: 3, replacement: "FIXED_B", expectedSha256: digest(before) });
    expect(retry.status).toBe("success");
    expect(await fs.readFile(path, "utf8")).toBe("HEADER\nA\nFIXED_B\nC");
  });

  it.each([false, true])("refuses stale write_file with append=%s without changing bytes", async (append) => {
    const path = join(ws, "write.txt");
    await fs.writeFile(path, "CURRENT");
    const result = await harness().invoke("write_file", { path: "write.txt", content: "REPLACE", append, expectedSha256: digest("OLD") });
    expect(result.status).toBe("failed");
    expect(result.error?.safeToRetry).toBe(false);
    expect(await fs.readFile(path, "utf8")).toBe("CURRENT");
  });

  it("checks content rather than timestamp and accepts an unchanged hash", async () => {
    const path = join(ws, "mtime.txt");
    await fs.writeFile(path, "same");
    await fs.utimes(path, new Date(0), new Date(0));
    const result = await harness().invoke("edit_file", { path: "mtime.txt", oldText: "same", newText: "next", expectedSha256: digest("same") });
    expect(result.status).toBe("success");
  });

  it("rejects invalid expected hashes at schema validation", async () => {
    await fs.writeFile(join(ws, "schema.txt"), "same");
    const result = await harness().invoke("edit_file", { path: "schema.txt", oldText: "same", newText: "next", expectedSha256: "not-a-sha" });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("TOOL_SCHEMA_ERROR");
    expect(await fs.readFile(join(ws, "schema.txt"), "utf8")).toBe("same");
  });

  it("serializes transaction commit with an in-flight tool edit", async () => {
    const target = join(ws, "txn.txt");
    await fs.writeFile(target, "A=0\n");
    const transaction = new WorkspaceChangeTransaction({ root: ws });
    await transaction.snapshot([{ path: "txn.txt", content: "COMMITTED\n" }]);
    const read = fs.readFile.bind(fs);
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      const snapshot = await read(...args);
      if (String(args[0]) === target) { entered(); await wait; }
      return snapshot;
    }) as typeof fs.readFile);
    const edit = harness().invoke("edit_file", { path: "txn.txt", oldText: "A=0", newText: "A=1" });
    await reading;
    let committed = false;
    const commit = transaction.commit().then((value) => { committed = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const committedWhileEditHeld = committed;
    release();
    expect((await edit).status).toBe("success");
    await commit;
    expect(committedWhileEditHeld).toBe(false);
    expect(await read(target, "utf8")).toBe("COMMITTED\n");
  });

  it("fails closed on invalid UTF-8 rather than rewriting unedited bytes", async () => {
    const target = join(ws, "invalid.txt");
    const before = Buffer.from([0xff, 0x0a, 0x41]);
    await fs.writeFile(target, before);
    const result = await harness().invoke("edit_file", { path: "invalid.txt", oldText: "A", newText: "B" });
    expect(result.status).toBe("failed");
    expect(await fs.readFile(target)).toEqual(before);
  });
});

describe("R4 exact editing with local EOL and BOM", () => {
  it("preserves CRLF when replacing a multiline range", () => {
    expect(applyLineRange("one\r\ntwo\r\nthree\r\n", 2, 2, "TWO\nMORE").content).toBe("one\r\nTWO\r\nMORE\r\nthree\r\n");
  });
  it("keeps mixed line endings outside the touched range", () => {
    expect(applyLineRange("head\r\ntarget\nlast\r\n", 2, 2, "changed\nextra").content).toBe("head\r\nchanged\nextra\nlast\r\n");
  });
  it("retains a UTF-8 BOM when editing the first line", () => {
    expect(applyLineRange("\ufeffhead\r\ntail\r\n", 1, 1, "HEAD").content).toBe("\ufeffHEAD\r\ntail\r\n");
  });
  it("uses the touched line EOL for new anchor replacement lines", () => {
    expect(applyReplace("a\r\ntarget\r\nz\n", "target", "new\nextra").content).toBe("a\r\nnew\r\nextra\r\nz\n");
  });
  it("normalizes each all-occurrence replacement only to its own local EOL", () => {
    expect(applyReplace("target\r\nmid\ntarget\nend", "target", "new\nextra", { replaceAll: true }).content).toBe("new\r\nextra\r\nmid\nnew\nextra\nend");
  });
  it("preserves exact matching without unicode folding", () => {
    expect(applyReplace("Ａ\r\nA", "A", "Z").content).toBe("Ａ\r\nZ");
    expect(applyReplace("Ａ", "A", "Z").ok).toBe(false);
  });
  it.each([
    ["\ufeff中文\r\n🙂tail", 1, 1, "新\n行", "\ufeff新\r\n行\r\n🙂tail"],
    ["中文\n🙂tail", 2, 2, "next", "中文\nnext"],
    ["a\r\nb", 2, 2, "", "a"],
    ["a\r\nb\r\n", 2, 99, "next", "a\r\nnext\r\n"],
    ["a\n", 9, 99, "next", "a\n\nnext"],
  ])("preserves the expected bytes of range case %#", (content, start, end, replacement, expected) => {
    expect(Buffer.from(applyLineRange(content as string, start as number, end as number, replacement as string).content)).toEqual(Buffer.from(expected as string));
  });
  it("matches LF multiline anchors against CRLF offsets and retains the BOM from a copied read", () => {
    expect(applyReplace("head\r\nold\r\nblock\r\ntail", "old\nblock", "新\n🙂").content).toBe("head\r\n新\r\n🙂\r\ntail");
    expect(applyReplace("\ufeffhead\r\ntail", "\ufeffhead", "\ufeffHEAD").content).toBe("\ufeffHEAD\r\ntail");
  });
});

describe("R4 cancellation, version and policy boundaries", () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }

  it("cancels an edit waiting for the canonical lock without writing and admits a later edit", async () => {
    const target = join(ws, "cancel.txt");
    await fs.writeFile(target, "before");
    const entered = deferred();
    const release = deferred();
    const holder = withFileLock(target, undefined, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const controller = new AbortController();
    const waiting = harness(controller.signal).invoke("edit_file", { path: "cancel.txt", oldText: "before", newText: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    try {
      expect((await waiting).status).toBe("cancelled");
      expect(await fs.readFile(target, "utf8")).toBe("before");
    } finally { release.resolve(); await holder; }
    expect(fileLockEntryCount()).toBe(0);
    expect((await harness().invoke("edit_file", { path: "cancel.txt", oldText: "before", newText: "later" })).status).toBe("success");
    expect(fileLockEntryCount()).toBe(0);
  });

  it("releases a holder after an exception and leaves independent files free", async () => {
    const target = join(ws, "held.txt");
    await fs.writeFile(target, "held");
    const entered = deferred();
    const release = deferred();
    const holder = withFileLock(target, undefined, async () => { entered.resolve(); await release.promise; throw new Error("fixture failure"); });
    const rejection = expect(holder).rejects.toThrow("fixture failure");
    await entered.promise;
    try {
      expect((await harness().invoke("write_file", { path: "independent.txt", content: "free" })).status).toBe("success");
      expect(await fs.readFile(join(ws, "independent.txt"), "utf8")).toBe("free");
    } finally { release.resolve(); await rejection; }
    expect(fileLockEntryCount()).toBe(0);
    expect((await harness().invoke("edit_file", { path: "held.txt", oldText: "held", newText: "next" })).status).toBe("success");
  });

  it("deduplicates canonical aliases and cleans partially acquired cancelled batches", async () => {
    await fs.mkdir(join(ws, "real"));
    await fs.symlink(join(ws, "real"), join(ws, "alias"), process.platform === "win32" ? "junction" : "dir");
    await withFileLocks([join(ws, "real", "new.txt"), join(ws, "alias", "new.txt")], undefined, async () => {
      expect(fileLockEntryCount()).toBe(1);
    });
    const entered = deferred();
    const release = deferred();
    const holder = withFileLock(join(ws, "z.txt"), undefined, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const controller = new AbortController();
    const batch = withFileLocks([join(ws, "a.txt"), join(ws, "z.txt")], controller.signal, async () => { throw new Error("must not enter"); });
    const rejection = expect(batch).rejects.toThrow(/cancelled/);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await rejection;
    expect(fileLockEntryCount()).toBe(1);
    release.resolve();
    await holder;
    expect(fileLockEntryCount()).toBe(0);
  });

  it("acquires simultaneous inverted batches without a multi-file deadlock", async () => {
    const paths = [join(ws, "batch-a.txt"), join(ws, "batch-b.txt")];
    await Promise.all(paths.map((path) => fs.writeFile(path, "same")));
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 500);
    const entered: string[] = [];
    try {
      const results = await Promise.allSettled([
        withFileLocks(paths, controller.signal, async () => { entered.push("forward"); }),
        withFileLocks([...paths].reverse(), controller.signal, async () => { entered.push("reverse"); }),
      ]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(entered).toEqual(["forward", "reverse"]);
      expect(fileLockEntryCount()).toBe(0);
    } finally { clearTimeout(deadline); controller.abort(); }
  });

  it("reacquires the replacement inode before a queued operation enters", async () => {
    const target = join(ws, "replaced.txt");
    const replacement = join(ws, "replacement.txt");
    const alias = join(ws, "replacement-alias.txt");
    await fs.writeFile(target, "old");
    await fs.writeFile(replacement, "new");
    const oldEntered = deferred();
    const replace = deferred();
    const replaced = deferred();
    const releaseOld = deferred();
    const oldHolder = withFileLock(target, undefined, async () => {
      oldEntered.resolve();
      await replace.promise;
      await fs.rename(replacement, target);
      replaced.resolve();
      await releaseOld.promise;
    });
    await oldEntered.promise;
    let entered = false;
    const queued = withFileLock(target, undefined, async () => { entered = true; });
    replace.resolve();
    await replaced.promise;
    await fs.link(target, alias);
    const newEntered = deferred();
    const releaseNew = deferred();
    const newHolder = withFileLock(alias, undefined, async () => { newEntered.resolve(); await releaseNew.promise; });
    await newEntered.promise;
    try {
      releaseOld.resolve();
      await oldHolder;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(entered).toBe(false);
    } finally {
      releaseOld.resolve();
      releaseNew.resolve();
      await Promise.all([oldHolder, newHolder, queued]);
    }
    expect(entered).toBe(true);
    expect(fileLockEntryCount()).toBe(0);
  });

  it("permits one writer and rejects the second writer sharing a read version", async () => {
    const target = join(ws, "same-version.txt");
    await fs.writeFile(target, "A=0\nB=0\n");
    const expectedSha256 = digest(await fs.readFile(target));
    const gate = holdReads(target);
    const results = await Promise.all([
      harness().invoke("edit_file", { path: "same-version.txt", oldText: "A=0", newText: "A=1", expectedSha256 }),
      harness().invoke("edit_file", { path: "same-version.txt", oldText: "B=0", newText: "B=1", expectedSha256 }),
    ]);
    gate.done();
    expect(results.map((result) => result.status)).toEqual(["success", "failed"]);
    expect(results[1]!.error).toMatchObject({ retryable: false, safeToRetry: false });
    expect(await fs.readFile(target, "utf8")).toBe("A=1\nB=0\n");
  });

  it("fails a pre-write version check if an external modification is observed after the read", async () => {
    const target = join(ws, "external.txt");
    await fs.writeFile(target, "old");
    const read = fs.readFile.bind(fs);
    let first = true;
    vi.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      const bytes = await read(...args);
      if (String(args[0]) === target && first) { first = false; await fs.writeFile(target, "external"); }
      return bytes;
    }) as typeof fs.readFile);
    const result = await harness().invoke("edit_file", { path: "external.txt", oldText: "old", newText: "agent" });
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ retryable: false, safeToRetry: false });
    expect(await read(target, "utf8")).toBe("external");
    expect(fileLockEntryCount()).toBe(0);
  });

  it("returns the actual byte count and hash for a versioned read of invalid UTF-8", async () => {
    const bytes = Buffer.from([0xff, 0x0a, 0x41]);
    await fs.writeFile(join(ws, "raw.bin"), bytes);
    const result = await harness().invoke("read_file", { path: "raw.bin", versioned: true });
    expect(result.output).toEqual({ path: join(ws, "raw.bin"), content: bytes.toString("utf8"), bytes: bytes.length, sha256: digest(bytes) });
  });

  it.each(["edit_file", "write_file"])("fails a versioned %s when the read file was deleted without recreating it", async (name) => {
    const result = await harness().invoke(name, { path: "missing.txt", oldText: "old", newText: "new", content: "new", expectedSha256: digest("old") });
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ retryable: false, safeToRetry: false });
    expect(result.error?.message).toMatch(/version/);
    await expect(fs.stat(join(ws, "missing.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["range", "anchor"])("requires a read version for strict %s edits while retaining the default API", async (mode) => {
    const target = join(ws, "strict.txt");
    const content = "same\nsame\n";
    await fs.writeFile(target, content);
    const args = mode === "range" ? { lineStart: 1, lineEnd: 1, replacement: "next" } : { oldText: "same", newText: "next", occurrence: 2 };
    const strict = await harness().invoke("edit_file", { path: "strict.txt", ...args, profile: "strict" });
    expect(strict.status).toBe("failed");
    expect(strict.error?.message).toMatch(/read_file/);
    expect(await fs.readFile(target, "utf8")).toBe(content);
    expect((await harness().invoke("edit_file", { path: "strict.txt", ...args, profile: "strict", expectedSha256: digest(content) })).status).toBe("success");
    await fs.writeFile(target, content);
    expect((await harness().invoke("edit_file", { path: "strict.txt", ...args })).status).toBe("success");
  });

  it("retains the transaction snapshot's authority across agent edits, commit and rollback", async () => {
    const target = join(ws, "authority.txt");
    const before = "\ufeffBEFORE\r\n";
    await fs.writeFile(target, before);
    const transaction = new WorkspaceChangeTransaction({ root: ws });
    await transaction.snapshot([{ path: "authority.txt", content: "INTENDED\n" }]);
    expect((await harness().invoke("edit_file", { path: "authority.txt", oldText: "BEFORE", newText: "INTERIM" })).status).toBe("success");
    await transaction.commit();
    expect(await fs.readFile(target, "utf8")).toBe("INTENDED\n");
    expect((await harness().invoke("edit_file", { path: "authority.txt", oldText: "INTENDED", newText: "LATER" })).status).toBe("success");
    await transaction.rollback();
    expect(await fs.readFile(target)).toEqual(Buffer.from(before));
    expect(fileLockEntryCount()).toBe(0);
  });

  it.each(["read_file", "write_file", "edit_file"])("keeps permission and symlink escape denials ahead of %s execution", async (name) => {
    const outside = await fs.mkdtemp(join(tmpdir(), "r4-outside-"));
    try {
      await fs.writeFile(join(outside, "secret.txt"), "before");
      await fs.symlink(outside, join(ws, "escape"), process.platform === "win32" ? "junction" : "dir");
      const args = { path: "escape/secret.txt", content: "after", oldText: "before", newText: "after", versioned: true, expectedSha256: digest("before") };
      const denied = await harness().invoke(name, args);
      expect(denied.status).toBe("denied");
      expect(denied.error?.code).toBe("SANDBOX_FILESYSTEM_DENIED");
      await fs.writeFile(join(ws, "inside.txt"), "before");
      const permission = await harness(new AbortController().signal, "deny").invoke(name, { ...args, path: "inside.txt" });
      expect(permission.status).toBe("denied");
      expect(permission.error?.code).toBe("PERMISSION_DENIED");
      expect(await fs.readFile(join(outside, "secret.txt"), "utf8")).toBe("before");
      expect(await fs.readFile(join(ws, "inside.txt"), "utf8")).toBe("before");
      expect(fileLockEntryCount()).toBe(0);
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });
});
