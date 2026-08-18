import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimentCmd } from "./experiment-command.js";

const VALID_CONFIG = JSON.stringify({
  id: "compaction-test",
  description: "Compare compaction strategies",
  variants: [
    { name: "baseline", mechanism: "compaction", overrides: { strategy: "aggressive" } },
    { name: "experimental", mechanism: "compaction", overrides: { strategy: "conservative" } },
  ],
  runs: 3,
});

describe("P2-9 experiment CLI command", () => {
  it("returns exitCode 0 with a valid config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exp-"));
    try {
      const configPath = join(dir, "config.json");
      await writeFile(configPath, VALID_CONFIG, "utf8");

      const result = await experimentCmd([configPath]);
      expect(result.exitCode).toBe(0);
      expect(result.lines[0]).toContain("compaction-test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns exitCode 1 when no path is given", async () => {
    const result = await experimentCmd([]);
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain("usage");
  });

  it("returns exitCode 1 with invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exp-"));
    try {
      const configPath = join(dir, "bad.json");
      await writeFile(configPath, "not json", "utf8");

      const result = await experimentCmd([configPath]);
      expect(result.exitCode).toBe(1);
      expect(result.lines[0]).toContain("error");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns exitCode 1 with missing required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exp-"));
    try {
      const configPath = join(dir, "bad.json");
      await writeFile(configPath, JSON.stringify({}), "utf8");

      const result = await experimentCmd([configPath]);
      expect(result.exitCode).toBe(1);
      expect(result.lines[0]).toContain("error");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});