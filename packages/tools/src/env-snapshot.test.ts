import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newWorkingState } from "@ar/contracts";
import {
  noteSnapshotInWorkingState,
  snapshotEnvironment,
  snapshotSummary,
  type EnvironmentSnapshot,
} from "./env-snapshot.js";

let ws = "";

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "ar-env-"));
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "x" }));
  writeFileSync(join(ws, "pnpm-lock.yaml"), "# lock\n");
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "src/a.ts"), "export {}", "utf8");
  // set deterministic probe env
  process.env["SNAP_TEST_API_KEY"] = "super-secret-zzz";
  process.env["SNAP_TEST_SAFE"] = "public";
});

afterAll(() => {
  delete process.env["SNAP_TEST_API_KEY"];
  delete process.env["SNAP_TEST_SAFE"];
  rmSync(ws, { recursive: true, force: true });
});

function minimal(probeLimit = 0, extra: Partial<Parameters<typeof snapshotEnvironment>[0]> = {}): Parameters<typeof snapshotEnvironment>[0] {
  return { cwd: ws, probeLimit, networkMode: "deny", availableTools: ["read_file", "exec"], ...extra };
}

describe("P2-32 snapshotEnvironment", () => {
  it("captures os, cwd, tools, and supplied network policy without probing", async () => {
    const snap = await snapshotEnvironment(minimal(0));
    expect(snap.os.platform).toBeTruthy();
    expect(snap.cwd).toBe(ws);
    expect(snap.network.mode).toBe("deny"); // supplied, never probed
    expect(snap.tools.available).toEqual(["read_file", "exec"]);
    expect(snap.tools.count).toBe(2);
    expect(snap.runtimes.length).toBe(0); // probeLimit 0 → nothing spawned
  });

  it("never captures env values; only the names of sensitive keys (redacted)", async () => {
    const snap = await snapshotEnvironment(minimal(0));
    expect(snap.security.envValuesRedacted).toBe(true);
    expect(snap.security.sensitiveEnvKeysPresent).toContain("SNAP_TEST_API_KEY");
    expect(snap.security.sensitiveEnvKeysPresent).not.toContain("SNAP_TEST_SAFE");
    const json = JSON.stringify(snap);
    expect(json.includes("super-secret-zzz")).toBe(false); // value never leaked
  });

  it("detects the package manager from the lockfile resolved via repo cache input", async () => {
    const snap = await snapshotEnvironment({ cwd: ws, probeLimit: 0, networkMode: "deny" });
    expect(snap.packageManager.detected).toBe("pnpm");
    expect(snap.packageManager.lockfile).toBe("pnpm-lock.yaml");
  });

  it("git state is present and well-formed (available may be false on non-git dirs)", async () => {
    const snap: EnvironmentSnapshot = await snapshotEnvironment({ cwd: ws, probeLimit: 0, networkMode: "deny" });
    expect(typeof snap.git.available).toBe("boolean");
    if (snap.git.available) {
      expect(typeof snap.git.branch).toBe("string");
      expect(typeof snap.git.dirtyFiles).toBe("number");
      expect(snap.git.head).toBeTruthy();
    }
  });

  it("snapshotSummary is a compact single line", async () => {
    const snap = await snapshotEnvironment(minimal(0));
    const s = snapshotSummary(snap);
    expect(s).toContain(`cwd=${ws}`);
    expect(s).toContain("net=deny");
    expect(s).toContain("tools=2");
    expect(s.split("\n")).toHaveLength(1);
  });

  it("noteSnapshotInWorkingState records the summary into WorkingState (deduped)", async () => {
    const snap = await snapshotEnvironment(minimal(0));
    const state = newWorkingState("understand env");
    noteSnapshotInWorkingState(state, snap);
    const entry = snapshotSummary(snap);
    expect(state.importantFacts).toContain(entry);
    noteSnapshotInWorkingState(state, snap);
    expect(state.importantFacts.filter((f) => f === entry)).toHaveLength(1);
  });
});