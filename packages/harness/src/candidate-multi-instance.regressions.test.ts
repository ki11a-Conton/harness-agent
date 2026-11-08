import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LearningCandidate } from "@ar/learning";
import { JsonlCandidateStore } from "./candidate-store.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 8 }); });
const candidate = (id: string, content = "observed lesson"): LearningCandidate => ({ id, content, kind: "memory", proposedAt: 1000, securityChecked: true });
async function fixture(alias = false) {
  const dataDir = await mkdtemp(join(tmpdir(), "ar-candidate-clients-")); dirs.push(dataDir);
  const a = new JsonlCandidateStore({ dataDir }), b = new JsonlCandidateStore({ dataDir: alias ? relative(process.cwd(), dataDir) : dataDir });
  await Promise.all([a.list(), b.list()]);
  return { a, b, reopen: () => new JsonlCandidateStore({ dataDir }) };
}

describe("candidate state shared by live harness owners", () => {
  it.each([false, true])("preserves all acknowledged additions from warmed clients (relative alias %s)", async alias => {
    const { a, b, reopen } = await fixture(alias);
    await a.add(candidate("first")); await b.add(candidate("second"));
    expect((await reopen().list()).map(row => row.id).sort()).toEqual(["first", "second"]);
    expect((await a.list()).map(row => row.id).sort()).toEqual(["first", "second"]);
  });
  it("makes successful updates visible to an already loaded peer", async () => {
    const { a, b } = await fixture(); await a.add(candidate("shared"));
    expect(await b.get("shared")).toEqual(candidate("shared"));
    await b.update(candidate("shared", "revised lesson"));
    expect(await a.get("shared")).toEqual(candidate("shared", "revised lesson"));
  });
  it("updates a record added by another owner without losing unrelated rows", async () => {
    const { a, b, reopen } = await fixture(); await a.add(candidate("first"));
    await b.update(candidate("first", "revised")); await a.add(candidate("second"));
    expect(await reopen().get("first")).toEqual(candidate("first", "revised"));
    expect(await reopen().get("second")).toEqual(candidate("second"));
  });
  it("removing through a stale client preserves other owners' committed rows", async () => {
    const { a, b, reopen } = await fixture(); await a.add(candidate("first")); await a.add(candidate("second"));
    await b.remove("first");
    expect(await reopen().list()).toEqual([candidate("second")]);
    expect(await a.get("first")).toBeUndefined();
  });
  it("serializes a concurrent burst from two warmed owners", async () => {
    const { a, b, reopen } = await fixture();
    await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? a : b).add(candidate(`item-${i}`))));
    expect((await reopen().list()).map(row => row.id).sort()).toEqual(Array.from({ length: 16 }, (_, i) => `item-${i}`).sort());
  });
  it("refreshes an initial read when another owner commits before that read returns", async () => {
    const { b, reopen } = await fixture(), reader = reopen();
    const snapshot = reader as unknown as { loadSnapshot(): Promise<void> };
    const load = snapshot.loadSnapshot.bind(reader);
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>(done => { entered = done; });
    const gate = new Promise<void>(done => { release = done; });
    // Pause after a real filesystem snapshot; the peer writes through its
    // unchanged public API before the initial read can publish its result.
    snapshot.loadSnapshot = async () => { await load(); entered(); await gate; };
    const pending = reader.list();
    try { await observed; await b.add(candidate("committed-during-read")); }
    finally { release(); }
    expect(await pending).toEqual([candidate("committed-during-read")]);
    expect(await reader.get("committed-during-read")).toEqual(candidate("committed-during-read"));
  });
});
