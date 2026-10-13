import { link, mkdir, mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness } from "@ar/harness";
import { ScriptedModelProvider } from "@ar/model";
import { createHostTools } from "./host-tools.js";
import { createOwnerManager } from "./owners.js";

const race = vi.hoisted(() => ({ path: "", armed: false, readBytes: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (String(args[0]) === race.path && race.armed) {
      const stat = handle.stat.bind(handle), read = handle.read.bind(handle);
      Object.defineProperty(handle, "stat", { value: async (...options: Parameters<typeof handle.stat>) => {
        const before = await stat(...options);
        if (race.armed) { race.armed = false; await actual.appendFile(race.path, " ".repeat(2 * 1024 * 1024)); }
        return before;
      } });
      Object.defineProperty(handle, "read", { value: async (...input: Parameters<typeof handle.read>) => { const value = await read(...input); race.readBytes += value.bytesRead; return value; } });
    }
    return handle;
  } };
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { race.armed = false; race.path = ""; for (const action of cleanup.splice(0).reverse()) await action(); });
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-real-owner-index-security-"))); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), dataDir = join(root, "data"); await mkdir(cwd);
  const provider = new ScriptedModelProvider([ScriptedModelProvider.text("Unused")]);
  const harness = await createHarness({ cwd, dataDir, profile: "interactive", modelProvider: provider, model: { providerId: provider.id, modelId: "scripted-model" } }); cleanup.push(() => harness.close());
  const tools = createHostTools(harness, cwd, dataDir), directory = join(dataDir, "deepseek"), path = join(directory, "owners-index.json"); await mkdir(directory);
  const bytes = JSON.stringify({ version: 2, revision: 0, owners: [], aliases: [] });
  const openOwner = () => createOwnerManager(harness, { dataDir, workspace: async () => ({ path: cwd }), executeHostTool: tools.executeHostTool });
  return { root, path, bytes, openOwner };
}

it("the actual controlled owner-index reader rejects a hard link without modifying its outside retained copy", async () => {
  const s = await setup(), outside = join(s.root, "retained-private-index.json"); await writeFile(outside, s.bytes); await link(outside, s.path);
  await expect(s.openOwner()).rejects.toMatchObject({ code: "gateway/internal" }); expect(await readFile(outside, "utf8")).toBe(s.bytes);
});

it("the actual controlled owner-index reader bounds its opened descriptor even if a local writer grows it after stat", async () => {
  const s = await setup(); await writeFile(s.path, s.bytes); Object.assign(race, { path: s.path, armed: true, readBytes: 0 });
  await expect(s.openOwner()).rejects.toMatchObject({ code: "gateway/internal" });
  expect(race.armed).toBe(false); expect(race.readBytes).toBeLessThanOrEqual(2 * 1024 * 1024 + 1);
});
