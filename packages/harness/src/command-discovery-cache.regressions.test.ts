import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandDiscoveryService } from "./command-discovery-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ar-command-cache-")); roots.push(root);
  const dataDir = join(root, ".cache"); await mkdir(dataDir);
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(11)"' } }));
  return { root, dataDir };
}

describe("T1: invalidate only incompatible persisted discovery generations", () => {
  it("ignores legacy unversioned hints and lazily rediscovers the real root test", async () => {
    const { root, dataDir } = await fixture();
    for (let index = 0; index < 61; index++) {
      const dir = join(root, "packages", `p${String(index).padStart(2, "0")}`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    }
    await writeFile(join(dataDir, "command-hints.jsonl"), JSON.stringify({ cwd: root, commands: { test: 'node -e "process.exit(0)"' }, summary: { test: 'node -e "process.exit(0)"' }, discoveredAt: 1000 }) + "\n");
    const service = new CommandDiscoveryService({ dataDir, now: () => 2000 });
    await service.loadPersisted();
    expect(service.hints(root)).toBeUndefined();
    const hints = await service.maybeDiscover(root);
    expect(hints?.commands.test).toBe('node -e "process.exit(11)"');
    expect(hints?.discoveredAt).toBe(2000);
    const persisted = (await readFile(join(dataDir, "command-hints.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(persisted.at(-1)!)).toMatchObject({ discoveryVersion: "root-entrypoints-v1" });
  });

  it("keeps compatible current-version hints warm without a new discovery", async () => {
    const { root, dataDir } = await fixture();
    await writeFile(join(dataDir, "command-hints.jsonl"), JSON.stringify({ discoveryVersion: "root-entrypoints-v1", cwd: root, commands: { test: "frozen warm command" }, summary: { test: "frozen warm command" }, discoveredAt: 1000 }) + "\n");
    const service = new CommandDiscoveryService({ dataDir, now: () => 2000 });
    await service.loadPersisted();
    const hints = await service.maybeDiscover(root);
    expect(hints?.commands.test).toBe("frozen warm command");
    expect(hints?.discoveredAt).toBe(1000);
    expect((await readFile(join(dataDir, "command-hints.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("does not let an incompatible later row replace a valid cached generation", async () => {
    const { root, dataDir } = await fixture();
    const current = { discoveryVersion: "root-entrypoints-v1", cwd: root, commands: { test: "current" }, summary: { test: "current" }, discoveredAt: 1000 };
    const old = { cwd: root, commands: { test: "old" }, summary: { test: "old" }, discoveredAt: 500 };
    await writeFile(join(dataDir, "command-hints.jsonl"), [current, old].map(row => JSON.stringify(row)).join("\n") + "\n");
    const service = new CommandDiscoveryService({ dataDir }); await service.loadPersisted();
    expect(service.hints(root)?.commands.test).toBe("current");
  });
});
