import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { atomicReplace, atomicWriteFile } from "./index.js";

const fault = vi.hoisted(() => ({ target: "", codes: [] as string[], calls: 0 }));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === fault.target) {
      fault.calls++; const code = fault.codes.shift();
      if (code) throw Object.assign(new Error(`Actual rename fault: ${code}`), { code });
    }
    return fs.rename(...args);
  } };
});
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let directory: string | undefined;
afterEach(async () => {
  Object.defineProperty(process, "platform", originalPlatform); vi.restoreAllMocks();
  fault.target = ""; fault.codes = []; fault.calls = 0;
  if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined;
});
async function fixture(platform: NodeJS.Platform) {
  directory = await mkdtemp(join(tmpdir(), "atomic-replace-real-"));
  const target = join(directory, "state.json"); await writeFile(target, "committed-old");
  fault.target = target; Object.defineProperty(process, "platform", { value: platform });
  return target;
}
it("a real atomic write retries transient Windows rename contention and keeps the committed target until replacement", async () => {
  const target = await fixture("win32"); fault.codes = ["EPERM", "EACCES", "EBUSY"];
  const replacing = atomicWriteFile(target, "committed-new");
  expect(await readFile(target, "utf8")).toBe("committed-old");
  await replacing; expect(await readFile(target, "utf8")).toBe("committed-new");
  expect(fault.calls).toBe(4); expect(await readdir(directory!)).toEqual(["state.json"]);
});
it("Windows contention lasting beyond the former sixteen attempts still commits one complete version", async () => {
  const target = await fixture("win32"); fault.codes = Array(16).fill("EPERM");
  await atomicWriteFile(target, "committed-after-scanner");
  expect(fault.calls).toBe(17); expect(await readFile(target, "utf8")).toBe("committed-after-scanner");
  expect(await readdir(directory!)).toEqual(["state.json"]);
});
it("exhausted Windows contention remains a real failure, preserves the old target and cleans only its own temporary file", async () => {
  const target = await fixture("win32"); fault.codes = Array(32).fill("EPERM");
  await expect(atomicWriteFile(target, "must-not-commit")).rejects.toMatchObject({ code: "EPERM" });
  expect(fault.calls).toBe(20); expect(await readFile(target, "utf8")).toBe("committed-old");
  expect(await readdir(directory!)).toEqual(["state.json"]);
});
it("permanent and POSIX permission failures do not become a delete-and-recreate fallback", async () => {
  const target = await fixture("linux"); fault.codes = ["EPERM"];
  await expect(atomicWriteFile(target, "never")).rejects.toMatchObject({ code: "EPERM" });
  expect(fault.calls).toBe(1); expect(await readFile(target, "utf8")).toBe("committed-old");
  Object.defineProperty(process, "platform", { value: "win32" }); fault.codes = ["EIO"];
  await expect(atomicWriteFile(target, "never")).rejects.toMatchObject({ code: "EIO" });
  expect(fault.calls).toBe(2); expect(await readdir(directory!)).toEqual(["state.json"]);
});
it("concurrent atomic writers at the same millisecond use isolated temporary files and publish complete versions", async () => {
  const target = await fixture(process.platform); vi.spyOn(Date, "now").mockReturnValue(1);
  const versions = Array.from({ length: 8 }, (_, index) => JSON.stringify({ index, content: "actual".repeat(500) }));
  await Promise.all(versions.map(value => atomicWriteFile(target, value)));
  expect(versions).toContain(await readFile(target, "utf8")); expect(await readdir(directory!)).toEqual(["state.json"]);
});
it("an aborted retry never commits the staged replacement", async () => {
  const target = await fixture("win32"), source = join(directory!, "staged.json"); await writeFile(source, "new");
  fault.codes = ["EPERM", "EPERM"]; const controller = new AbortController();
  const pending = atomicReplace(source, target, controller.signal); controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(await readFile(target, "utf8")).toBe("committed-old"); expect(await readFile(source, "utf8")).toBe("new");
});
