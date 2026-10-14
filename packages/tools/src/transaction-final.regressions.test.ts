import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceChangeTransaction } from "./transaction.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "final-transaction-")); roots.push(root);
  const workspace = join(root, "project"), outside = join(root, "outside"); await fs.mkdir(workspace); await fs.mkdir(outside);
  return { workspace, outside };
}
const directoryLink = (target: string, path: string) => fs.symlink(target, path, process.platform === "win32" ? "junction" : "dir");

it("refuses a real ancestor directory link before it can read or overwrite an outside file", async () => {
  const { workspace, outside } = await fixture(); await fs.writeFile(join(outside, "secret.txt"), "outside untouched");
  await directoryLink(outside, join(workspace, "link"));
  const txn = new WorkspaceChangeTransaction({ root: workspace });
  await expect(txn.snapshot([{ path: "link/secret.txt", content: "outside overwritten" }])).rejects.toThrow();
  expect(txn.entries()).toEqual([]); expect(await fs.readFile(join(outside, "secret.txt"), "utf8")).toBe("outside untouched");
});

it("rechecks ancestors after snapshot and before commit or rollback", async () => {
  const { workspace, outside } = await fixture(); const directory = join(workspace, "src"); await fs.mkdir(directory);
  await fs.writeFile(join(directory, "a.txt"), "before"); await fs.writeFile(join(outside, "a.txt"), "external");
  const txn = new WorkspaceChangeTransaction({ root: workspace }); await txn.snapshot([{ path: "src/a.txt", content: "after" }]);
  await fs.rename(directory, join(workspace, "original-src")); await directoryLink(outside, directory);
  await expect(txn.commit()).rejects.toThrow(); await expect(txn.rollback()).rejects.toThrow();
  expect(await fs.readFile(join(outside, "a.txt"), "utf8")).toBe("external");
});

it("refuses bytes that cannot round-trip through the transaction's encoding before any edit", async () => {
  const { workspace } = await fixture(); const path = join(workspace, "binary.dat"), original = Buffer.from([0, 255, 254, 128, 65]);
  await fs.writeFile(path, original); const txn = new WorkspaceChangeTransaction({ root: workspace });
  await expect(txn.snapshot([{ path: "binary.dat", content: "text" }])).rejects.toThrow();
  expect(txn.entries()).toEqual([]); expect(await fs.readFile(path)).toEqual(original);
});

it.runIf(process.platform !== "win32")("preserves executable mode through both commit and rollback", async () => {
  const { workspace } = await fixture(); const path = join(workspace, "run.sh"); await fs.writeFile(path, "#!/bin/sh\necho before\n"); await fs.chmod(path, 0o755);
  const txn = new WorkspaceChangeTransaction({ root: workspace }); await txn.snapshot([{ path: "run.sh", content: "#!/bin/sh\necho after\n" }]);
  await txn.commit(); expect((await fs.stat(path)).mode & 0o777).toBe(0o755);
  await txn.rollback(); expect((await fs.stat(path)).mode & 0o777).toBe(0o755); expect(await fs.readFile(path, "utf8")).toBe("#!/bin/sh\necho before\n");
});

it("a failed snapshot batch keeps the previous intents without staging a partial new batch", async () => {
  const { workspace } = await fixture(); await fs.mkdir(join(workspace, "directory"));
  const txn = new WorkspaceChangeTransaction({ root: workspace }); await txn.snapshot([{ path: "earlier.txt", content: "earlier" }]);
  await expect(txn.snapshot([{ path: "partial.txt", content: "must not be staged" }, { path: "directory", content: "invalid" }])).rejects.toThrow();
  expect(txn.entries().map(entry => entry.path)).toEqual(["earlier.txt"]);
});

it("metadata I/O failure is propagated, rather than classified as an absent file", async () => {
  const { workspace } = await fixture(); const error = Object.assign(new Error("metadata I/O failed"), { code: "EIO" });
  vi.spyOn(fs, "stat").mockRejectedValue(error); vi.spyOn(fs, "lstat").mockRejectedValue(error);
  const txn = new WorkspaceChangeTransaction({ root: workspace }); await expect(txn.snapshot([{ path: "a.txt", content: "new" }])).rejects.toThrow();
  expect(txn.entries()).toEqual([]);
});
