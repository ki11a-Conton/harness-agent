import { link, mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ActivityStore } from "./activity-store.js";

const race = vi.hoisted(() => ({ armed: false, path: "", outside: "" }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    const stat = await actual.lstat(...args);
    // Deterministic attacker barrier between the regular-file observation
    // and the reader's open. Bytes and the symlink are real filesystem data.
    if (race.armed && String(args[0]) === race.path) {
      race.armed = false; await actual.unlink(race.path); await actual.symlink(race.outside, race.path);
    }
    return stat;
  } };
});

const directories: string[] = [];
afterEach(async () => { race.armed = false; for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

it.skipIf(process.platform === "win32")("a task reader never follows a symlink swapped after its regular-file check", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "actual-task-file-race-"))); directories.push(directory);
  const path = join(directory, "tasks.json"), outside = join(directory, "outside.json");
  await writeFile(path, JSON.stringify({ version: 1, tasks: {} }));
  const outsideBytes = JSON.stringify({ version: 1, tasks: {}, outsideMarker: "private-outside-bytes" }); await writeFile(outside, outsideBytes);
  Object.assign(race, { armed: true, path, outside });
  await expect(new ActivityStore(path).read()).rejects.toThrow();
  expect(race.armed).toBe(false); expect(await readFile(outside, "utf8")).toBe(outsideBytes);
});

it("a task reader checks the opened file's byte bound and refuses corrupt durable state", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "actual-task-file-bound-"))); directories.push(directory);
  const path = join(directory, "tasks.json");
  await writeFile(path, " ".repeat(16 * 1024 * 1024 + 1)); await expect(new ActivityStore(path).read()).rejects.toThrow();
  await writeFile(path, JSON.stringify({ version: 1, tasks: { wrong: {} } })); await expect(new ActivityStore(path).read()).rejects.toThrow();
});

it("task state cannot be a hard link to a different retained file", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "actual-task-file-hardlink-"))); directories.push(directory);
  const path = join(directory, "tasks.json"), outside = join(directory, "outside.json");
  const outsideBytes = JSON.stringify({ version: 1, tasks: {}, outsideMarker: "private-linked-bytes" }); await writeFile(outside, outsideBytes); await link(outside, path);
  await expect(new ActivityStore(path).read()).rejects.toThrow(); expect(await readFile(outside, "utf8")).toBe(outsideBytes);
});
