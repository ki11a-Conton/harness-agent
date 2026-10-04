import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LearningCandidate } from "@ar/learning";
import { CANDIDATES_FILE_NAME, JsonlCandidateStore } from "./candidate-store.js";

const dirs: string[] = [];
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "ar-candidate-transaction-"));
  dirs.push(dataDir);
  const file = join(dataDir, CANDIDATES_FILE_NAME);
  return { dataDir, file, store: new JsonlCandidateStore({ dataDir }) };
}
function candidate(id: string, content = "original"): LearningCandidate {
  return { id, content, kind: "memory", proposedAt: 1000, securityChecked: true };
}
async function obstruct(file: string) {
  const backup = `${file}.backup`;
  await rename(file, backup);
  await mkdir(file);
  return async () => {
    await rm(file, { recursive: true });
    await rename(backup, file);
  };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("candidate persistence transactions with real filesystem failures", () => {
  it("failed add exposes no ghost and succeeds after the target directory is removed", async () => {
    const { dataDir, file, store } = await fixture();
    expect(await store.list()).toEqual([]);
    await mkdir(file);
    await expect(store.add(candidate("new"))).rejects.toThrow();
    expect(await store.list()).toEqual([]);
    expect(await store.get("new")).toBeUndefined();
    await rm(file, { recursive: true });
    expect(await new JsonlCandidateStore({ dataDir }).list()).toEqual([]);
    await store.add(candidate("new"));
    expect(await new JsonlCandidateStore({ dataDir }).get("new")).toEqual(candidate("new"));
  });

  it("failed add with a file replacing its parent directory retains the empty cache", async () => {
    const { dataDir, store } = await fixture();
    await store.list();
    await rm(dataDir, { recursive: true });
    await writeFile(dataDir, "parent obstruction", "utf8");
    await expect(store.add(candidate("new"))).rejects.toThrow();
    expect(await store.list()).toEqual([]);
    expect(await store.get("new")).toBeUndefined();
    await rm(dataDir);
    await mkdir(dataDir);
    expect(await new JsonlCandidateStore({ dataDir }).list()).toEqual([]);
    await store.add(candidate("new"));
    expect(await new JsonlCandidateStore({ dataDir }).get("new")).toEqual(candidate("new"));
  });

  it("failed update retains the old record and durable bytes until a successful retry", async () => {
    const { dataDir, file, store } = await fixture();
    await store.add(candidate("kept"));
    const originalBytes = await readFile(file, "utf8");
    const restore = await obstruct(file);
    await expect(store.update(candidate("kept", "replacement"))).rejects.toThrow();
    expect(await store.get("kept")).toEqual(candidate("kept"));
    expect(await store.list()).toEqual([candidate("kept")]);
    await restore();
    expect(await readFile(file, "utf8")).toBe(originalBytes);
    expect(await new JsonlCandidateStore({ dataDir }).get("kept")).toEqual(candidate("kept"));
    await store.update(candidate("kept", "replacement"));
    expect(await new JsonlCandidateStore({ dataDir }).get("kept")).toEqual(candidate("kept", "replacement"));
  });

  it("failed remove retains the old record and durable bytes until a successful retry", async () => {
    const { dataDir, file, store } = await fixture();
    await store.add(candidate("kept"));
    const originalBytes = await readFile(file, "utf8");
    const restore = await obstruct(file);
    await expect(store.remove("kept")).rejects.toThrow();
    expect(await store.get("kept")).toEqual(candidate("kept"));
    expect(await store.list()).toEqual([candidate("kept")]);
    await restore();
    expect(await readFile(file, "utf8")).toBe(originalBytes);
    expect(await new JsonlCandidateStore({ dataDir }).get("kept")).toEqual(candidate("kept"));
    await store.remove("kept");
    expect(await new JsonlCandidateStore({ dataDir }).list()).toEqual([]);
  });

  it.each(["list", "add"] as const)("retries an initial %s read failure without losing existing history", async (operation) => {
    const { dataDir, file, store } = await fixture();
    await store.add(candidate("history"));
    const restore = await obstruct(file);
    const reopened = new JsonlCandidateStore({ dataDir });
    await expect(operation === "list" ? reopened.list() : reopened.add(candidate("new"))).rejects.toThrow();
    await restore();
    await reopened.add(candidate("new"));
    expect((await reopened.list()).map((c) => c.id)).toEqual(["history", "new"]);
    expect((await new JsonlCandidateStore({ dataDir }).list()).map((c) => c.id)).toEqual(["history", "new"]);
  });

  it.each(["add", "update", "remove"] as const)("readers see the committed snapshot while %s is serializing its real filesystem write", async (operation) => {
    const { dataDir, store } = await fixture();
    await store.add(candidate("kept"));
    let reading: Promise<LearningCandidate[]> | undefined;
    let observe = false;
    // Serialization starts before atomicWriteFile's first awaited filesystem call.
    // The accessor schedules a real store read at this exact boundary; persistence
    // and filesystem primitives remain unchanged.
    const observed = candidate(operation === "remove" ? "sentinel" : "kept", "replacement");
    Object.defineProperty(observed, "content", { enumerable: true, get() {
      if (observe) reading = store.list();
      return "replacement";
    } });
    if (operation === "remove") await store.add(observed);
    const before = await store.list();
    observe = true;
    await (operation === "add" ? store.add(observed) : operation === "update" ? store.update(observed) : store.remove("kept"));
    expect(reading).toBeDefined();
    expect(await reading).toEqual(before);
    const after = await store.list();
    expect(after).toEqual(await new JsonlCandidateStore({ dataDir }).list());
    expect(await store.get("kept")).toEqual(operation === "remove" ? undefined : candidate("kept", "replacement"));
  });

  it("concurrent initial reads and same-instance additions preserve every acknowledged record", async () => {
    const { dataDir, store } = await fixture();
    await Promise.all([store.list(), store.get("missing"), ...Array.from({ length: 20 }, (_, i) => store.add(candidate(`c-${i}`)))]);
    const expected = Array.from({ length: 20 }, (_, i) => `c-${i}`).sort();
    expect((await store.list()).map((c) => c.id).sort()).toEqual(expected);
    expect((await new JsonlCandidateStore({ dataDir }).list()).map((c) => c.id).sort()).toEqual(expected);
  });

  it("successful mutations preserve schema, overwrite behavior and missing-id semantics", async () => {
    const { dataDir, file, store } = await fixture();
    await store.add(candidate("same"));
    await store.add(candidate("same", "overwritten"));
    await store.update(candidate("missing"));
    await store.remove("missing");
    expect(await new JsonlCandidateStore({ dataDir }).list()).toEqual([candidate("same", "overwritten")]);
    const record = JSON.parse((await readFile(file, "utf8")).trim());
    expect(record.schemaVersion).toBe(1);
    expect(record.candidate).toEqual(candidate("same", "overwritten"));
    await store.update(candidate("same", "updated"));
    expect(await new JsonlCandidateStore({ dataDir }).get("same")).toEqual(candidate("same", "updated"));
    await store.remove("same");
    expect(await new JsonlCandidateStore({ dataDir }).list()).toEqual([]);
  });
});
