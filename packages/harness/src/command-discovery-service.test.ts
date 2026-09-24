import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandDiscoveryService } from "./command-discovery-service.js";

let tempDir: string | undefined;
afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function freshRoot(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "cmd-disc-"));
  return tempDir;
}

describe("P7-6: lazy command discovery service", () => {
  it("discovers test/build commands only after a code-changing turn", async () => {
    const root = await freshRoot();
    const dataDir = await freshRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "demo",
        scripts: { test: "vitest run", build: "tsc -b" },
      }),
    );
    const service = new CommandDiscoveryService({ dataDir, now: () => 1000 });

    // Non-code-changing turn: nothing discovered, nothing persisted.
    expect(await service.onCodeChange(root, [])).toBeUndefined();
    expect(service.hints(root)).toBeUndefined();

    // Code-changing turn: lazy discovery fires once.
    const hints = await service.onCodeChange(root, ["src/main.ts"]);
    expect(hints).toBeDefined();
    expect(hints!.commands["test"]).toBe("vitest run");
    expect(hints!.commands["build"]).toBe("tsc -b");

    // importantFacts rendering.
    const facts = service.toImportantFacts(hints!);
    expect(facts).toContain("test command: vitest run");
    expect(facts).toContain("build: tsc -b");

    // Second code-changing turn: cache hit, no re-scan.
    const again = await service.onCodeChange(root, ["src/other.ts"]);
    expect(again!.discoveredAt).toBe(1000);
  });

  it("persists hints and reloads them in a fresh process", async () => {
    const root = await freshRoot();
    const dataDir = await freshRoot();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    const first = new CommandDiscoveryService({ dataDir });
    await first.onCodeChange(root, ["a.ts"]);

    const second = new CommandDiscoveryService({ dataDir });
    await second.loadPersisted();
    expect(second.hints(root)?.commands["test"]).toBe("jest");
  });

  it("returns undefined for workspaces without discoverable commands", async () => {
    const root = await freshRoot();
    const service = new CommandDiscoveryService();
    expect(await service.onCodeChange(root, ["readme.txt"])).toBeUndefined();
  });
});
