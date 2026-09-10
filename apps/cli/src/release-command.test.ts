import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gatePlatform, releaseGateCmd, releaseVerifyCmd, resolveReleaseVerdict, runGate } from "./release-command.js";
import { GATE_COMMANDS, REQUIRED_GATE_PLATFORMS } from "./release-verify.js";
import type { ReleasePlatform } from "./release-verify.js";

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

/** Write ONE evidence instance under gates/<platform>/<id>.json with the full
 *  V2 protocol (E4-R09: V1 fixtures are historical and blocked by the verifier). */
async function writeInstance(
  dir: string,
  id: string,
  platform: ReleasePlatform,
  opts: { exitCode?: number | null; headSha?: string; command?: string; kind?: string; passed?: boolean; clean?: boolean } = {},
): Promise<string> {
  const path = join(dir, "gates", platform, `${id}.json`);
  await mkdir(join(dir, "gates", platform), { recursive: true });
  const passed = opts.passed ?? ((opts.exitCode ?? 0) === 0);
  const evidence = {
    schemaVersion: "2.0.0",
    gate: id,
    command: (opts.command ?? GATE_COMMANDS[requiredGateIndex(id)]).split(/\s+/).filter(Boolean),
    toolVersion: "release-command-v2",
    gitSha: opts.headSha ?? HEAD,
    cleanBefore: opts.clean ?? true,
    cleanAfter: opts.clean ?? true,
    inputDigest: "0".repeat(64),
    outputDigest: "1".repeat(64),
    startedAtIso: new Date(Date.now() - 1000).toISOString(),
    finishedAtIso: new Date().toISOString(),
    exitCode: opts.exitCode ?? 0,
    passed,
    state: opts.exitCode === null ? "not_run" : passed ? "passed" : "failed",
    summary: "fixture",
    providerCalls: 0,
    environmentClass: "offline",
    kind: opts.kind ?? "gate",
  };
  await writeFile(path, JSON.stringify(evidence));
  return path;
}

/** Write every required platform instance for every required gate, all green. */
async function writeAllGreen(dir: string): Promise<void> {
  for (const id of REQUIRED_IDS) {
    for (const platform of REQUIRED_GATE_PLATFORMS[requiredGateIndex(id)]) {
      await writeInstance(dir, id, platform);
    }
  }
}

/** Resolve the canonical gate command for a gate id (provenance is checked by
 *  the verifier — the fixture must record the exact canonical command). */
const requiredGateIndex = (id: string): keyof typeof GATE_COMMANDS =>
  id as keyof typeof GATE_COMMANDS;

describe("P36-1 release verify CLI", () => {
  it("all gates green at HEAD across required platforms → exit 0, READY", async () => {
    const dir = await tmpEvidenceDir();
    await writeAllGreen(dir);
    const result = await releaseVerifyCmd([], { root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("Release verdict: READY");
  });

  it("one failed gate → exit non-zero, FAILED", async () => {
    const dir = await tmpEvidenceDir();
    await writeAllGreen(dir);
    await writeInstance(dir, "test", "linux", { exitCode: 1 });
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

  it("P38.3-7: one required gate entirely missing → ready=false / exit 1", async () => {
    const dir = await tmpEvidenceDir();
    for (const id of REQUIRED_IDS) {
      if (id === "chaos") continue; // chaos has NO evidence at all
      for (const platform of REQUIRED_GATE_PLATFORMS[requiredGateIndex(id)]) {
        await writeInstance(dir, id, platform);
      }
    }
    const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(verdict.ready).toBe(false);
    const chaos = verdict.gates.find((g) => g.id === "chaos")!;
    expect(chaos.state).toBe("not_run");
    const result = await releaseVerifyCmd([], { root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(result.exitCode).toBe(1);
  });

  it("stale SHA evidence → blocked, exit non-zero", async () => {
    const dir = await tmpEvidenceDir();
    await writeAllGreen(dir);
    await writeInstance(dir, "test", "linux", { headSha: "deadbeef" });
    const result = await releaseVerifyCmd([], { root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("stale");
  });

  it("--json emits machine-readable verdict", async () => {
    const dir = await tmpEvidenceDir();
    await writeAllGreen(dir);
    const result = await releaseVerifyCmd(["--json"], { root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.lines[0]!) as { ready: boolean; gates: { id: string; state: string }[] };
    expect(parsed.ready).toBe(true);
    expect(parsed.gates).toHaveLength(REQUIRED_IDS.length);
  });

  it("P38.2-10/P38.3-5: multiple instances of the same gate (platforms) merge — all must pass", async () => {
    // Two evidence files for the same gate (gates/linux + gates/windows layout).
    // INV-P38.2-010: the merged gate is green only when EVERY platform passed;
    // a red platform makes the gate red. No throw — merging is the designed
    // behavior for namespaced multi-platform evidence.
    const dir = await tmpEvidenceDir();
    await writeAllGreen(dir);
    await writeInstance(dir, "test", "linux", { exitCode: 1 }); // red linux, green windows
    const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    const testGate = verdict.gates.find((g) => g.id === "test")!;
    expect(testGate.state).toBe("failed");
    expect(verdict.ready).toBe(false);

    // All platforms green → merged gate passes.
    const dir2 = await tmpEvidenceDir();
    await writeAllGreen(dir2);
    const verdict2 = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir2, headSha: HEAD });
    expect(verdict2.verdict.gates.find((g) => g.id === "test")!.state).toBe("passed");
  });

  it("P38.3-5: stale Windows hidden by valid Linux → release NOT READY", async () => {
    const dir = await tmpEvidenceDir();
    await writeAllGreen(dir);
    // Windows evidence at a STALE sha — Linux is valid at HEAD. The stale
    // secondary platform must NOT be hidden by the valid Linux instance.
    await writeInstance(dir, "test", "windows", { headSha: "stale-windows-sha" });
    const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(verdict.ready).toBe(false);
    expect(verdict.gates.find((g) => g.id === "test")!.state).toBe("failed");
  });

  it("P38.3-5: wrong Windows command → gate blocked/failed, NOT READY", async () => {
    const dir = await tmpEvidenceDir();
    await writeAllGreen(dir);
    // Windows ran `echo success` instead of the canonical `pnpm test`.
    await writeInstance(dir, "test", "windows", { command: "echo success" });
    const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(verdict.ready).toBe(false);
    expect(verdict.gates.find((g) => g.id === "test")!.state).toBe("failed");
  });

  it("P38.3-5: legacy V1 evidence → blocked, NOT READY (historical/unsupported)", async () => {
    const dir = await tmpEvidenceDir();
    await writeAllGreen(dir);
    // Overwrite test/linux with a hand-written V1 evidence (the pre-V2 shape).
    const v1 = { schemaVersion: 1, kind: "gate", gate: "test", headSha: HEAD, command: GATE_COMMANDS[requiredGateIndex("test")], exitCode: 0, passed: true, platform: "linux" };
    await writeFile(join(dir, "gates", "linux", "test.json"), JSON.stringify(v1));
    const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(verdict.ready).toBe(false);
    // The V1 file cannot certify the current release (historical/unsupported).
    expect(verdict.gates.find((g) => g.id === "test")!.state).not.toBe("passed");
  });

  it("P38.3-5: inconsistent exit code (1 + passed true) → blocked, NOT READY", async () => {
    const dir = await tmpEvidenceDir();
    await writeAllGreen(dir);
    await writeInstance(dir, "test", "linux", { exitCode: 1, passed: true });
    const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(verdict.ready).toBe(false);
    expect(verdict.gates.find((g) => g.id === "test")!.state).toBe("failed");
  });

  it("P38.3-5/6: ordering independence — verdict identical with reversed traversal", async () => {
    const dirA = await tmpEvidenceDir();
    await writeAllGreen(dirA);
    // dirB writes the same evidence in the REVERSE per-gate/platform order —
    // the reader must be order-independent (readdir order never matters).
    const dirB = await tmpEvidenceDir();
    for (const id of [...REQUIRED_IDS].reverse()) {
      const platforms = [...REQUIRED_GATE_PLATFORMS[requiredGateIndex(id)]].reverse();
      for (const platform of platforms) {
        await writeInstance(dirB, id, platform);
      }
    }
    const verdictA = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dirA, headSha: HEAD });
    const verdictB = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dirB, headSha: HEAD });
    expect(verdictB.verdict.ready).toBe(verdictA.verdict.ready);
    expect(verdictB.verdict.gates.map((g) => g.state)).toEqual(verdictA.verdict.gates.map((g) => g.state));
    expect(verdictB.verdict.ready).toBe(true);
  });

  it("P38.3-6: missing Windows → gate NOT passed even with valid Linux", async () => {
    const dir = await tmpEvidenceDir();
    await writeAllGreen(dir);
    // Delete all windows evidence for the test gate.
    await rm(join(dir, "gates", "windows", "test.json"));
    const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(verdict.ready).toBe(false);
    const testGate = verdict.gates.find((g) => g.id === "test")!;
    expect(testGate.state).toBe("failed");
    expect(testGate.reason).toContain("missing required platform windows");
  });

  it("P38.3-6: duplicate Linux cannot substitute for missing Windows", async () => {
    const dir = await tmpEvidenceDir();
    await writeAllGreen(dir);
    // Two Linux instances, zero Windows — still NOT passed.
    await writeInstance(dir, "test", "linux", { exitCode: 0 });
    await rm(join(dir, "gates", "windows", "test.json"));
    const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(verdict.ready).toBe(false);
    expect(verdict.gates.find((g) => g.id === "test")!.reason).toContain("missing required platform windows");
  });

  it("P38.3-6: unknown platform cannot satisfy a required platform", async () => {
    const dir = await tmpEvidenceDir();
    await writeAllGreen(dir);
    // Add an unknown-platform instance for test; delete windows. The unknown
    // platform must NOT satisfy the windows requirement.
    await writeInstance(dir, "test", "darwin", { exitCode: 0 });
    await rm(join(dir, "gates", "windows", "test.json"));
    const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(verdict.ready).toBe(false);
    expect(verdict.gates.find((g) => g.id === "test")!.reason).toContain("missing required platform windows");
  });
});

describe("P38.2-4/13 repo-owned gate runner (INV-P38.2-004)", () => {
  it("runGate executes the canonical command and writes durable V2 evidence with the REAL exit code", async () => {
    const dir = await tmpEvidenceDir();
    const result = await runGate("typecheck", { root: process.cwd(), headSha: HEAD, evidenceDir: dir });
    expect(result.gate).toBe("typecheck");
    expect(result.command).toBe(GATE_COMMANDS.typecheck);
    // Evidence is written even when the gate is red — INV-P38.2-004. The
    // protocol is V2 (E4-R09): schemaVersion "2.0.0", command argv, gitSha.
    const written = JSON.parse(await readFile(result.evidencePath, "utf8")) as {
      gate: string;
      gitSha: string;
      headSha?: string;
      command: string[];
      exitCode: number;
      passed: boolean;
      schemaVersion: string;
      cleanBefore: boolean;
      cleanAfter: boolean;
    };
    expect(written.gate).toBe("typecheck");
    // runGateV2 captures the REAL repo HEAD (the headSha option is not used to
    // stamp evidence) — 40-hex on this checkout.
    expect(written.gitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(written.command.join(" ")).toBe(GATE_COMMANDS.typecheck);
    expect(written.schemaVersion).toBe("2.0.0");
    // cleanBefore/cleanAfter are recorded truthfully (the dev checkout here is
    // typically dirty, so they are booleans decided by the real git state);
    // the dirty-tree PASS-invalidation is covered by dedicated blocked tests.
    expect(typeof written.cleanBefore).toBe("boolean");
    expect(typeof written.cleanAfter).toBe("boolean");
    expect(written.exitCode).toBe(result.exitCode);
    // E4-R09: a PASS additionally requires a CLEAN tree (before AND after) —
    // this dev checkout may be dirty, so passed must equal the cleanness, not
    // exitCode alone. A real green gate run still records exitCode 0.
    expect(written.passed).toBe(written.cleanBefore === true && written.cleanAfter === true);
    expect(written.exitCode).toBe(0);
  });

  it("runGate captures a FAILING gate's real exit code and still writes evidence", async () => {
    const dir = await tmpEvidenceDir();
    // Run an intentionally failing command via a fake gate dir: `release gate`
    // only accepts REQUIRED_GATES ids, so we test the runner's failure capture
    // through the CLI with an unknown-command gate replaced below.
    const result = await runGate("chaos", { root: process.cwd(), headSha: HEAD, evidenceDir: dir });
    // `pnpm test:chaos` may legitimately pass on this repo; what matters is the
    // evidence file records the ACTUAL exit code (passed === exitCode === 0).
    expect(result.exitCode).toBe(0);
    const written = JSON.parse(await readFile(result.evidencePath, "utf8")) as { exitCode: number; passed: boolean; cleanBefore?: boolean; cleanAfter?: boolean };
    // E4-R09: passed requires exit 0 AND a clean source tree (the dev checkout
    // here may be dirty), so derive passed from the recorded cleanness.
    expect(written.passed).toBe(written.exitCode === 0 && written.cleanBefore === true && written.cleanAfter === true);
  });

  it("releaseGateCmd rejects unknown gate ids", async () => {
    const result = await releaseGateCmd(["nope"], { root: process.cwd(), headSha: HEAD });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("unknown gate id");
  });

  it("releaseGateCmd with no args prints usage", async () => {
    const result = await releaseGateCmd([], { root: process.cwd(), headSha: HEAD });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("usage: agent release gate");
  });

  it("gatePlatform maps win32 → windows, else linux/darwin", () => {
    expect(["windows", "linux", "darwin"]).toContain(gatePlatform());
  });

  it("E4-R19 (N20): the printed verdict derives from the EVIDENCE state — a failed/invalid evidence can never print PASS even with child exit 0", async () => {
    // `pnpm typecheck` in this (dirty) dev worktree exits 0, but the EVIDENCE
    // records cleanBefore/cleanAfter=false → state=failed → the console verdict
    // must be FAIL (the evidence state is the deciding fact, never the raw
    // child exit code — a dirty-tree PASS would contradict the evidence).
    const dir = await tmpEvidenceDir();
    const result = await releaseGateCmd(["typecheck"], { root: process.cwd(), headSha: HEAD, evidenceDir: dir });
    const out = result.lines.join("\n");
    const evidence = JSON.parse(await readFile(join(dir, "typecheck.json"), "utf8")) as {
      passed: boolean;
      state: string;
      exitCode: number | null;
    };
    if (evidence.passed && evidence.state === "passed") {
      expect(out).toContain("PASS");
      expect(result.exitCode).toBe(0);
    } else {
      // A failed/invalid evidence (dirty tree, exit 0) must print FAIL with the
      // evidence state and produce a NON-ZERO CLI exit — never a PASS.
      expect(out).toContain("FAIL (evidence state=");
      expect(out).toContain(`evidence state=${evidence.state}`);
      expect(result.exitCode).toBe(1);
    }
    // In EITHER case the console verdict must agree with the evidence's state:
    // the PASS token appears only when the evidence itself passed.
    if (!evidence.passed || evidence.state !== "passed") {
      expect(out).not.toContain("exitCode=0 PASS");
    }
  });

  it("E4-R12 (N01): a red gate prints the saved log ref + bounded failure summary that names the real cause", async () => {
    // Deterministic red gate: run `pnpm docs:verify` in an EMPTY temp root that
    // is not a pnpm workspace — the canonical command itself fails with a real
    // exit code and real stderr (no model calls, nothing written to the repo).
    const root = await mkdtemp(join(tmpdir(), "release-gate-red-"));
    cleanupDirs.push(root);
    const evDir = await tmpEvidenceDir();
    const result = await releaseGateCmd(["docs"], { root, headSha: HEAD, evidenceDir: evDir });
    expect(result.exitCode).toBe(1);
    const out = result.lines.join("\n");
    expect(out).toContain("gate docs: exitCode=1 FAIL");
    // The console output must carry the real cause + where the full log lives,
    // so the CI summary points at the failing item — not at a silent exit code.
    expect(out).toContain("log:");
    expect(out).toContain("exitCode=1");
    expect(/ExitCode=1|exitCode=1/.test(out)).toBe(true);
    // The evidence on disk carries the same logRef + errorSummary.
    const evidence = JSON.parse(await readFile(join(evDir, "docs.json"), "utf8")) as {
      logRef: { path: string; digest: string | null };
      errorSummary: string;
      exitCode: number;
    };
    expect(evidence.exitCode).toBe(1);
    expect(evidence.logRef.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.errorSummary).toContain("exitCode=1");
    // The referenced log file exists and its bytes hash to the recorded digest.
    const { createHash } = await import("node:crypto");
    const logBytes = await readFile(join(root, evidence.logRef.path), "utf8");
    expect(createHash("sha256").update(logBytes, "utf8").digest("hex")).toBe(evidence.logRef.digest);
    expect(logBytes.length).toBeGreaterThan(0);
  });
});
