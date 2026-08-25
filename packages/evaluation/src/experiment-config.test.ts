import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExperimentConfig, experimentConfigFromObject, validateExperimentConfigObject, parseYaml } from "./experiment-config.js";

const MINIMAL_JSON = {
  id: "compaction-test",
  variants: [
    { name: "aggressive", mechanism: "compaction", overrides: { threshold: 0.8 } },
    { name: "conservative", mechanism: "compaction", overrides: { threshold: 0.5 } },
  ],
};

describe("P2-9 experiment config loader", () => {
  it("parses a valid minimal JSON config", () => {
    const config = experimentConfigFromObject(MINIMAL_JSON);
    expect(config.id).toBe("compaction-test");
    expect(config.variants).toHaveLength(2);
    expect(config.variants[0]!.name).toBe("aggressive");
    expect(config.variants[1]!.mechanism).toBe("compaction");
    expect(config.baseline).toBe("aggressive");
    expect(config.runs).toBe(3);
  });

  it("applies custom runs and baseline", () => {
    const config = experimentConfigFromObject({
      ...MINIMAL_JSON,
      runs: 5,
      baseline: "conservative",
    });
    expect(config.runs).toBe(5);
    expect(config.baseline).toBe("conservative");
  });

  it("validates: missing id returns errors", () => {
    const errors = validateExperimentConfigObject({ variants: [{ name: "a", mechanism: "m" }] });
    expect(errors.some((e) => e.includes("id"))).toBe(true);
  });

  it("validates: empty variants returns errors", () => {
    const errors = validateExperimentConfigObject({ id: "t", variants: [] });
    expect(errors.some((e) => e.includes("variants"))).toBe(true);
  });

  it("validates: invalid baseline returns errors", () => {
    const errors = validateExperimentConfigObject({
      id: "t",
      variants: [{ name: "a", mechanism: "m" }],
      baseline: "nonexistent",
    });
    expect(errors.some((e) => e.includes("baseline"))).toBe(true);
  });

  it("validates: duplicate variant names return errors", () => {
    const errors = validateExperimentConfigObject({
      id: "t",
      variants: [
        { name: "a", mechanism: "m" },
        { name: "a", mechanism: "m2" },
      ],
    });
    expect(errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("loads a JSON config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "expcfg-"));
    try {
      const path = join(dir, "test.json");
      await writeFile(path, JSON.stringify(MINIMAL_JSON), "utf8");
      const config = await loadExperimentConfig(path);
      expect(config.id).toBe("compaction-test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});