import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialChampionState, applyPromotion } from "@ar/evaluation";
import { readChampionStateFile, writeChampionStateFile } from "./champion-state-file.js";

let dir = "";
afterEach(async () => {
  if (dir !== "") {
    await rm(dir, { recursive: true, force: true });
    dir = "";
  }
});

async function tmpPath(): Promise<string> {
  if (dir === "") dir = await mkdtemp(join(tmpdir(), "champion-state-"));
  return join(dir, "champion-state.json");
}

describe("champion-state-file (E1-14)", () => {
  it("missing file returns the initial C0 state (not an error)", async () => {
    const p = await tmpPath();
    const state = await readChampionStateFile(p);
    expect(state instanceof Error).toBe(false);
    if (!(state instanceof Error)) {
      expect(state.level).toBe("C0");
      expect(state.candidateId).toBeNull();
    }
  });

  it("write and read back a C1 state", async () => {
    const p = await tmpPath();
    const c0 = createInitialChampionState();
    const c1 = applyPromotion(c0, "memory_retrieval", { features: { memory: true } }, "runs/holdout.json");
    await writeChampionStateFile(c1, p);
    const loaded = await readChampionStateFile(p);
    expect(loaded instanceof Error).toBe(false);
    if (!(loaded instanceof Error)) {
      expect(loaded.level).toBe("C1");
      expect(loaded.candidateId).toBe("memory_retrieval");
      expect(loaded.evidenceRef).toBe("runs/holdout.json");
      expect(loaded.history).toHaveLength(1);
      expect(loaded.applied).toBe(true); // writeChampionStateFile always marks applied=true
    }
  });

  it("invalid JSON returns an error (fail-closed)", async () => {
    const p = await tmpPath();
    // Write non-JSON data.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(p, "not valid json", "utf8");
    const state = await readChampionStateFile(p);
    expect(state instanceof Error).toBe(true);
  });
});