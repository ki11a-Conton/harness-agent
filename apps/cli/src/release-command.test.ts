import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { releaseVerifyCmd, resolveReleaseVerdict } from "./release-command.js";
import { GATE_COMMANDS } from "./release-verify.js";

const HEAD = "0123456789abcdef";
const REQUIRED_IDS = ["typecheck","test","build","coverage","docs","benchmark_smoke","protocol","security","race","chaos","capability_audit"];

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function tmpEvidenceDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "release-ev-"));
  cleanupDirs.push(dir);
  return dir;
}

function evidenceFile(id: string, exitCode: number | null): string {
  return JSON.stringify({ gate: id, headSha: HEAD, command: GATE_COMMANDS[requiredGateIndex(id)], exitCode });
}

/** Resolve the canonical gate command for a gate id (provenance is checked by
 *  the verifier — the fixture must record the exact canonical command). */
const requiredGateIndex = (id: string): keyof typeof GATE_COMMANDS =>
  id as keyof typeof GATE_COMMANDS;

describe("P36-1 release verify CLI", () => {
  it("all gates green at HEAD → exit 0, READY", async () => {
    const dir = await tmpEvidenceDir();
    for (const id of REQUIRED_IDS) {
      await writeFile(join(dir, `${id}.json`), evidenceFile(id, 0));
    }
    const result = await releaseVerifyCmd([], { root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("Release verdict: READY");
  });

  it("one failed gate → exit non-zero, FAILED", async () => {
    const dir = await tmpEvidenceDir();
    for (const id of REQUIRED_IDS) {
      await writeFile(join(dir, `${id}.json`), evidenceFile(id, id === "test" ? 1 : 0));
    }
    const result = await releaseVerifyCmd([], { root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("test             FAILED");
  });

  it("missing evidence dir → all not_run, exit non-zero", async () => {
    const dir = await tmpEvidenceDir();
    await rm(dir, { recursive: true, force: true });
    const result = await releaseVerifyCmd([], { root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("typecheck        NOT_RUN");
  });

  it("stale SHA evidence → blocked, exit non-zero", async () => {
    const dir = await tmpEvidenceDir();
    for (const id of REQUIRED_IDS) {
      await writeFile(join(dir, `${id}.json`), JSON.stringify({ gate: id, headSha: id === "test" ? "deadbeef" : HEAD, command: GATE_COMMANDS[requiredGateIndex(id)], exitCode: 0 }));
    }
    const result = await releaseVerifyCmd([], { root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("stale evidence");
  });

  it("--json emits machine-readable verdict", async () => {
    const dir = await tmpEvidenceDir();
    for (const id of REQUIRED_IDS) {
      await writeFile(join(dir, `${id}.json`), evidenceFile(id, 0));
    }
    const result = await releaseVerifyCmd(["--json"], { root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.lines[0]!) as { ready: boolean; gates: { id: string; state: string }[] };
    expect(parsed.ready).toBe(true);
    expect(parsed.gates).toHaveLength(REQUIRED_IDS.length);
  });

  it("resolveReleaseVerdict detects duplicate gate evidence → throws", async () => {
    const dir = await tmpEvidenceDir();
    await writeFile(join(dir, "a.json"), evidenceFile("test", 0));
    await writeFile(join(dir, "b.json"), evidenceFile("test", 1));
    await expect(resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD })).rejects.toThrow(/duplicate evidence/);
  });
});
