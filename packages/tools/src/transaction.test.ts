import { mkdtempSync, promises as fs, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NotAFileError,
  OutOfBoundsError,
  TransactionApplyError,
  WorkspaceChangeTransaction,
} from "./transaction.js";

let ws = "";
beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "txn-"));
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));

describe("P2-26 WorkspaceChangeTransaction", () => {
  it("creates files on commit and rollback removes them", async () => {
    const txn = new WorkspaceChangeTransaction({ root: ws });
    await txn.snapshot([{ path: "a.txt", content: "hello" }]);
    expect(txn.state).toBe("open");
    expect(txn.entries()).toHaveLength(1);
    expect(txn.entries()[0]!.kind).toBe("create");

    const res = await txn.commit();
    expect(res.state).toBe("committed");
    expect(txn.state).toBe("committed");
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("hello");

    await txn.rollback();
    expect(txn.state).toBe("rolled_back");
    await expect(fs.stat(join(ws, "a.txt"))).rejects.toThrow();
  });

  it("rollback restores byte-for-byte overwritten content", async () => {
    const f = join(ws, "keep.txt");
    const original = "line1\nline2\nsecret\n";
    writeFileSync(f, original);
    // Simulate the tricky case: a write tool replaces content with a new value.
    const txn = new WorkspaceChangeTransaction({ root: ws });
    await txn.snapshot([{ path: "keep.txt", content: "TINY REPLACEMENT" }]);
    await txn.commit();
    expect(readFileSync(f, "utf8")).toBe("TINY REPLACEMENT");
    await txn.rollback();
    expect(readFileSync(f, "utf8")).toBe(original);
    expect(await fs.stat(f)).toBeDefined();
  });

  it("rollback removes a generated path that did not exist before the txn", async () => {
    const txn = new WorkspaceChangeTransaction({ root: ws });
    // A path that does not exist when the txn starts; plan with no content
    // expresses "should not exist" (delete/absent after). Rollback must restore
    // the original absent state — i.e. keep it absent.
    await txn.snapshot([{ path: "tmp-artifact.log" }]);
    expect(txn.entries()[0]!.kind).toBe("delete");
    await txn.commit();
    await expect(fs.stat(join(ws, "tmp-artifact.log"))).rejects.toThrow();
    await txn.rollback();
    // original state was absent → still absent
    await expect(fs.stat(join(ws, "tmp-artifact.log"))).rejects.toThrow();
    expect(txn.state).toBe("rolled_back");
  });

  it("supports nested create via parent dirs", async () => {
    const txn = new WorkspaceChangeTransaction({ root: ws });
    await txn.snapshot([{ path: "nested/deep/base.ts", content: "export {};" }]);
    await txn.commit();
    expect(readFileSync(join(ws, "nested", "deep", "base.ts"), "utf8")).toBe("export {};");
    await txn.rollback();
    // parents may remain (empty dirs are harmless), file must be gone
    await expect(fs.stat(join(ws, "nested", "deep", "base.ts"))).rejects.toThrow();
  });

  it("resolves relative paths against root and rejects escapes", async () => {
    const txn = new WorkspaceChangeTransaction({ root: ws });
    await expect(
      txn.snapshot([{ path: "../outside.txt", content: "x" }]),
    ).rejects.toBeInstanceOf(OutOfBoundsError);
    await expect(
      txn.snapshot([{ path: join(ws, "..", "sibling.txt"), content: "x" }]),
    ).rejects.toBeInstanceOf(OutOfBoundsError);
    // A sibling-name collision (/tmp/ws2) is NOT inside /tmp/ws.
    await expect(
      txn.snapshot([{ path: `${ws}2.txt`, content: "x" }]),
    ).rejects.toBeInstanceOf(OutOfBoundsError);
  });

  it("rejects a directory as a transaction target", async () => {
    const dir = join(ws, "adir");
    await fs.mkdir(dir, { recursive: true });
    const txn = new WorkspaceChangeTransaction({ root: ws });
    await expect(txn.snapshot([{ path: "adir", content: "x" }])).rejects.toBeInstanceOf(NotAFileError);
  });

  it("blocks snapshot/commit after the transaction finished", async () => {
    const txn = new WorkspaceChangeTransaction({ root: ws });
    await txn.snapshot([{ path: "once.txt", content: "v1" }]);
    await txn.commit();
    await expect(txn.snapshot([{ path: "other.txt", content: "x" }])).rejects.toThrow(/already committed/);
    await expect(txn.commit()).rejects.toThrow(/already committed/);
  });

  it("all-or-nothing: a failed commit rolls back earlier writes", async () => {
    // A regular file as a parent dir makes the SECOND write fail deterministically
    // (mkdir('blocker') fails), regardless of whether we run as root.
    writeFileSync(join(ws, "blocker"), "i am a file, not a directory");
    const txn = new WorkspaceChangeTransaction({ root: ws });
    await txn.snapshot([
      { path: "applied-first.txt", content: "FIRST" },
      { path: "blocker/sub/x.txt", content: "SECOND" },
    ]);
    const err = await txn.commit().then(
      () => null,
      (e) => e as unknown,
    );
    expect(err).toBeInstanceOf(TransactionApplyError);
    expect((err as TransactionApplyError).applied).toEqual([join(ws, "applied-first.txt")]);
    // all-or-nothing: the first applied file must have been rolled back → absent.
    await expect(fs.stat(join(ws, "applied-first.txt"))).rejects.toThrow();
    // and the blocked file was never created.
    await expect(fs.stat(join(ws, "blocker", "sub", "x.txt"))).rejects.toThrow();
    expect(txn.state).toBe("open");
  });

  it("rollback is idempotent", async () => {
    const txn = new WorkspaceChangeTransaction({ root: ws });
    await txn.snapshot([{ path: "idy.txt", content: "z" }]);
    await txn.commit();
    await txn.rollback();
    await expect(txn.rollback()).resolves.toBeUndefined();
    expect(txn.state).toBe("rolled_back");
  });
});