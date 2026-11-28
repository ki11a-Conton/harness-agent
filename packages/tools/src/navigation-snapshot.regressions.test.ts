import { promises as fs } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createGrepScanSummary, grepFiles, symbolSearch } from "./navigate.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const native = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const budget = 512 * 1024;
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), "nav-snapshot-")); });
afterEach(async () => {
  vi.mocked(open).mockReset().mockImplementation(native.open);
  await fs.rm(root, { recursive: true, force: true });
});

async function search(mode: "grep" | "symbol") {
  const summary = createGrepScanSummary();
  const opts = { root, relPath: "source.py", summary };
  const hits = mode === "grep"
    ? await grepFiles({ ...opts, literal: true, pattern: "Target" })
    : (await symbolSearch({ ...opts, symbol: "Target" })).hits;
  return { hits, summary };
}

it.each(["grep", "symbol"] as const)("%s rejects a file that grows after its descriptor was measured", async mode => {
  const path = join(root, "source.py");
  await fs.writeFile(path, "def Target():\n    pass\n");
  for (const overflow of [true, false]) {
    let bytesRead = 0;
    let appended = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await native.open(...args);
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        const snapshot = await stat();
        await fs.appendFile(path, overflow ? Buffer.alloc(budget, 32) : "more\n");
        appended = true;
        return snapshot;
      });
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...args: Parameters<typeof handle.read>) => {
        const [buffer, offset, length, position] = args as unknown as [Buffer, number, number, number | null];
        const result = await read(buffer, offset, length, position);
        bytesRead += result.bytesRead;
        return result;
      });
      return handle;
    });
    const result = await search(mode);
    expect(appended).toBe(true);
    expect(result.hits).toEqual([]);
    expect(result.summary).toMatchObject({ complete: false, scannedFiles: 0, skippedOversizedFiles: overflow ? 1 : 0 });
    if (overflow) expect(bytesRead).toBe(budget + 1);
    else expect(result.summary).toHaveProperty("changedFiles", 1);
    await fs.writeFile(path, "def Target():\n    pass\n");
  }
});

it.each(["grep", "symbol"] as const)("%s includes an unchanged file exactly at the byte limit", async mode => {
  const header = Buffer.from("def Target(): # 中文\r\n");
  await fs.writeFile(join(root, "source.py"), Buffer.concat([header, Buffer.alloc(budget - header.length, 32)]));
  const result = await search(mode);
  expect(result.hits).toHaveLength(1);
  expect(result.summary).toMatchObject({ complete: true, scannedFiles: 1, skippedOversizedFiles: 0 });
});
