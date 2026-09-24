/**
 * E4-R21 (F01) — the production release verify must re-verify evidence bundle
 * refs (artifact + log bytes) from disk, exactly like the generic V2 loader.
 *
 * Pre-fix repro (plan 20260911-013142 §2 F01): a structurally complete V2
 * bundle whose recorded log digest no longer matches the log on disk passed
 * the GENERIC loader's re-verification but still produced
 * `productionReady: true` from `release verify`, because the production path
 * (readFile → parseRawEvidence → validateGateEvidenceInstance) drops
 * logRef/artifactRefs/providerCalls during the lossy mapping and never
 * re-reads the referenced bytes.
 *
 * Every fixture here is offline: no provider, no network, no paid calls.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGateEvidenceV2 } from "@ar/evaluation";
import { releaseVerifyCmd, resolveReleaseVerdict } from "./release-command.js";
import { GATE_COMMANDS, REQUIRED_GATE_PLATFORMS, REQUIRED_GATES } from "./release-verify.js";
import type { ReleasePlatform } from "./release-verify.js";

const HEAD = "a".repeat(40);
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const REQUIRED_IDS = [...REQUIRED_GATES];

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

interface InstanceOptions {
  logContent?: string;
  dropLogRef?: boolean;
  nullLogDigest?: boolean;
  artifactRefs?: Array<{ path: string; digest: string | null }>;
  providerCalls?: number;
  environmentClass?: "offline" | "paid" | "insecure-local";
  exitCode?: number;
}

/** Write ONE complete V2 instance under gates/<platform>/ with a persisted,
 *  digest-bound output log (the E4-R12 protocol the production gate runner
 *  emits). The logRef path is relative to the evidence file's directory. */
async function writeInstance(
  dir: string,
  gate: string,
  platform: ReleasePlatform,
  opts: InstanceOptions = {},
): Promise<{ evidencePath: string; logPath: string }> {
  const gateDir = join(dir, "gates", platform);
  await mkdir(join(gateDir, "logs"), { recursive: true });
  const logRel = `logs/${gate}-${platform}.log`;
  const logAbs = join(gateDir, logRel);
  const logContent = opts.logContent ?? `full output log for ${gate}/${platform}\nexitCode=0 (ok)\n`;
  await writeFile(logAbs, logContent, "utf8");
  const passed = (opts.exitCode ?? 0) === 0;
  const evidence = {
    schemaVersion: "2.0.0",
    kind: "gate",
    gate,
    command: GATE_COMMANDS[gate as keyof typeof GATE_COMMANDS].split(/\s+/).filter(Boolean),
    toolVersion: "e4-r21-fixture",
    gitSha: HEAD,
    cleanBefore: true,
    cleanAfter: true,
    inputDigest: "0".repeat(64),
    outputDigest: "1".repeat(64),
    startedAtIso: new Date(Date.now() - 1000).toISOString(),
    finishedAtIso: new Date().toISOString(),
    exitCode: opts.exitCode ?? 0,
    passed,
    state: passed ? "passed" : "failed",
    summary: "e4-r21 fixture",
    providerCalls: opts.providerCalls ?? 0,
    environmentClass: opts.environmentClass ?? "offline",
    ...(opts.artifactRefs !== undefined ? { artifactRefs: opts.artifactRefs } : {}),
    ...(opts.dropLogRef
      ? {}
      : { logRef: { path: logRel, digest: opts.nullLogDigest ? null : sha256(logContent) } }),
  };
  const evidencePath = join(gateDir, `${gate}.json`);
  await writeFile(evidencePath, JSON.stringify(evidence), "utf8");
  return { evidencePath, logPath: logAbs };
}

async function writeAllGreen(dir: string): Promise<void> {
  for (const gate of REQUIRED_IDS) {
    for (const platform of REQUIRED_GATE_PLATFORMS[gate as keyof typeof REQUIRED_GATE_PLATFORMS]) {
      await writeInstance(dir, gate, platform);
    }
  }
}

/** Read one instance's parsed JSON (single source for tampering a field). */
async function readJson(path: string): Promise<Record<string, unknown>> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), "utf8");
}

describe("E4-R21 (F01) production release evidence re-verification", () => {
  it("valid complete bundle (all gates/platforms, persisted logs) → both the generic loader and the real release verify succeed", async () => {
    const dir = await tmpDir("e4-r21-green-");
    await writeAllGreen(dir);
    // Generic loader: one instance loads as passed (its log bytes verify).
    const generic = await loadGateEvidenceV2(join(dir, "gates", "linux", "test.json"));
    expect(generic.passed).toBe(true);
    expect(generic.state).toBe("passed");
    // Real production entry.
    const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(verdict.ready).toBe(true);
    expect(verdict.runtimeReleaseReady).toBe(true);
    const cli = await releaseVerifyCmd([], { root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(cli.exitCode).toBe(0);
    expect(cli.lines.join("\n")).toContain("Release verdict: READY");
  });

  it("RELEASE_REF_REVERIFY: a tampered log blocks release READY (generic loader already rejected it — the production entry must too)", async () => {
    const dir = await tmpDir("e4-r21-tamper-");
    await writeAllGreen(dir);
    // F01 minimal repro: modify ONE gate's log AFTER the evidence recorded its digest.
    const { logPath } = await writeInstance(dir, "test", "linux"); // fresh, consistent
    const { appendFile } = await import("node:fs/promises");
    await appendFile(logPath, "TAMPERED AFTER THE RUN\n", "utf8");

    // Generic loader (R19 N18): the same bytes-mismatch is already detected.
    const generic = await loadGateEvidenceV2(join(dir, "gates", "linux", "test.json"));
    expect(generic.passed).toBe(false);
    expect(generic.summary).toContain("digest changed");

    // Production entry: must NOT be ready, must name the gate/platform/path.
    const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(verdict.ready).toBe(false);
    const testGate = verdict.gates.find((g) => g.id === "test")!;
    expect(testGate.state).not.toBe("passed");
    expect(testGate.reason).toContain("linux");
    expect(testGate.reason).toContain("logs/test-linux.log");
    const cli = await releaseVerifyCmd([], { root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(cli.exitCode).toBe(1);
    expect(cli.lines.join("\n")).toContain("Release verdict: FAILED");
    expect(cli.lines.join("\n")).toContain("logs/test-linux.log");
  });

  it("a DELETED log blocks release READY (missing required evidence)", async () => {
    const dir = await tmpDir("e4-r21-del-");
    await writeAllGreen(dir);
    await rm(join(dir, "gates", "linux", "logs", "test-linux.log"));
    const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(verdict.ready).toBe(false);
    expect(verdict.gates.find((g) => g.id === "test")!.reason).toContain("logs/test-linux.log");
    const cli = await releaseVerifyCmd([], { root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(cli.exitCode).toBe(1);
  });

  it("DELETING the logRef from the evidence JSON cannot bypass re-verification (a certifying instance must carry a persisted log)", async () => {
    const dir = await tmpDir("e4-r21-dropref-");
    await writeAllGreen(dir);
    const evidencePath = join(dir, "gates", "windows", "security.json");
    const parsed = await readJson(evidencePath);
    delete parsed.logRef;
    await writeJson(evidencePath, parsed);
    const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(verdict.ready).toBe(false);
    const gate = verdict.gates.find((g) => g.id === "security")!;
    expect(gate.reason).toContain("windows");
    expect(gate.reason).toMatch(/log/i);
    const cli = await releaseVerifyCmd([], { root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(cli.exitCode).toBe(1);
  });

  it("a logRef whose digest is null (log never persisted) cannot certify a release", async () => {
    const dir = await tmpDir("e4-r21-nulldigest-");
    await writeAllGreen(dir);
    await writeInstance(dir, "docs", "linux", { nullLogDigest: true });
    const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(verdict.ready).toBe(false);
    expect(verdict.gates.find((g) => g.id === "docs")!.reason).toMatch(/log/i);
  });

  it("a tampered declared artifact blocks release READY and names the artifact path", async () => {
    const dir = await tmpDir("e4-r21-art-");
    for (const gate of REQUIRED_IDS) {
      for (const platform of REQUIRED_GATE_PLATFORMS[gate as keyof typeof REQUIRED_GATE_PLATFORMS]) {
        if (gate === "benchmark_smoke" && platform === "linux") {
          const artRel = "artifacts/smoke-report.md";
          await mkdir(join(dir, "gates", platform, "artifacts"), { recursive: true });
          await writeFile(join(dir, "gates", platform, artRel), "original smoke report\n", "utf8");
          await writeInstance(dir, gate, platform, {
            artifactRefs: [{ path: artRel, digest: sha256("original smoke report\n") }],
          });
        } else {
          await writeInstance(dir, gate, platform);
        }
      }
    }
    // Positive first: the declared artifact verifies.
    expect((await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD })).verdict.ready).toBe(true);
    // Tamper the declared artifact AFTER the evidence was written.
    await writeFile(join(dir, "gates", "linux", "artifacts", "smoke-report.md"), "TAMPERED report\n", "utf8");
    const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(verdict.ready).toBe(false);
    const gate = verdict.gates.find((g) => g.id === "benchmark_smoke")!;
    expect(gate.reason).toContain("linux");
    expect(gate.reason).toContain("artifacts/smoke-report.md");
    const cli = await releaseVerifyCmd([], { root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(cli.exitCode).toBe(1);
  });

  it("an offline gate reporting non-zero providerCalls is rejected by the production entry", async () => {
    const dir = await tmpDir("e4-r21-paid-");
    await writeAllGreen(dir);
    await writeInstance(dir, "race", "linux", { providerCalls: 5, environmentClass: "offline" });
    const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(verdict.ready).toBe(false);
    expect(verdict.gates.find((g) => g.id === "race")!.reason).toMatch(/provider calls/i);
    const cli = await releaseVerifyCmd([], { root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(cli.exitCode).toBe(1);
  });

  it("a certifying instance with a non-offline environmentClass is rejected", async () => {
    const dir = await tmpDir("e4-r21-envclass-");
    await writeAllGreen(dir);
    await writeInstance(dir, "chaos", "linux", { environmentClass: "paid", providerCalls: 1 });
    const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
    expect(verdict.ready).toBe(false);
    expect(verdict.gates.find((g) => g.id === "chaos")!.reason).toMatch(/offline/i);
  });

  it("structurally invalid refs (non-array artifactRefs, null element, missing digest, logRef:null) are rejected without an uncaught exception", async () => {
    const cases: Array<[string, (e: Record<string, unknown>) => void, string]> = [
      ["artifactRefs is not an array", (e) => { e.artifactRefs = "not-an-array"; }, "artifactRefs"],
      ["artifactRefs contains a null element", (e) => { e.artifactRefs = [null]; }, "artifactRefs"],
      ["artifactRef element missing digest", (e) => { e.artifactRefs = [{ path: "a.json" }]; }, "digest"],
      ["logRef is null", (e) => { e.logRef = null; }, "logRef"],
    ];
    for (const [name, mutate, needle] of cases) {
      const dir = await tmpDir("e4-r21-badref-");
      await writeAllGreen(dir);
      const evidencePath = join(dir, "gates", "linux", "protocol.json");
      const parsed = await readJson(evidencePath);
      mutate(parsed);
      await writeJson(evidencePath, parsed);
      const cli = await releaseVerifyCmd([], { root: process.cwd(), evidenceDir: dir, headSha: HEAD });
      expect(cli.exitCode, name).toBe(1);
      expect(cli.lines.join("\n"), name).toContain("Release verdict: FAILED");
      const { verdict } = await resolveReleaseVerdict({ root: process.cwd(), evidenceDir: dir, headSha: HEAD });
      expect(verdict.ready, name).toBe(false);
      // The failure is attributed (the reason names the offending field), never a raw TypeError.
      expect(
        verdict.gates.map((g) => g.reason ?? "").join("\n"),
        name,
      ).toMatch(new RegExp(needle, "i"));
    }
  });

  it("a file at the same relative path under the process cwd cannot change the bundle verdict (no implicit cwd root)", async () => {
    const dir = await tmpDir("e4-r21-cwd-");
    await writeAllGreen(dir);
    const { logPath } = await writeInstance(dir, "test", "linux");
    // Tamper the bundle's log, then plant the ORIGINAL (valid) bytes at the
    // same RELATIVE path under a spoof cwd — a cwd-rooted resolver would find
    // the spoof and flip the verdict back to READY.
    const original = "full output log for test/linux\nexitCode=0 (ok)\n";
    await writeFile(logPath, "TAMPERED\n", "utf8");
    const spoofCwd = await tmpDir("e4-r21-spoof-");
    await mkdir(join(spoofCwd, "logs"), { recursive: true });
    await writeFile(join(spoofCwd, "logs", "test-linux.log"), original, "utf8");
    const originalCwd = process.cwd();
    process.chdir(spoofCwd);
    try {
      const { verdict } = await resolveReleaseVerdict({ root: spoofCwd, evidenceDir: dir, headSha: HEAD });
      expect(verdict.ready).toBe(false);
      expect(verdict.gates.find((g) => g.id === "test")!.reason).toContain("logs/test-linux.log");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("the bundle still verifies after being MOVED to another directory with a different process cwd", async () => {
    const dir = await tmpDir("e4-r21-move-");
    await writeAllGreen(dir);
    const moved = await tmpDir("e4-r21-moved-");
    await cp(join(dir, "gates"), join(moved, "gates"), { recursive: true });
    const elsewhere = await tmpDir("e4-r21-elsewhere-");
    const originalCwd = process.cwd();
    process.chdir(elsewhere);
    try {
      const { verdict } = await resolveReleaseVerdict({ root: elsewhere, evidenceDir: moved, headSha: HEAD });
      expect(verdict.ready).toBe(true);
      const cli = await releaseVerifyCmd([], { root: elsewhere, evidenceDir: moved, headSha: HEAD });
      expect(cli.exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("CI-layout bundle: gates/{linux,windows,coverage}/ keeps strict platform coverage — missing windows is not offset by extra linux", async () => {
    const dir = await tmpDir("e4-r21-cilayout-");
    // Simulate the attestation job's downloaded layout: .ci/evidence/gates/<os>/.
    const evidenceRoot = join(dir, ".ci", "evidence");
    await writeAllGreen(evidenceRoot);
    const { verdict } = await resolveReleaseVerdict({ root: dir, evidenceDir: evidenceRoot, headSha: HEAD });
    expect(verdict.ready).toBe(true);
    // Remove ALL windows evidence for the build gate; add a second linux instance.
    await rm(join(evidenceRoot, "gates", "windows", "build.json"));
    await writeInstance(evidenceRoot, "build", "linux");
    const { verdict: broken } = await resolveReleaseVerdict({ root: dir, evidenceDir: evidenceRoot, headSha: HEAD });
    expect(broken.ready).toBe(false);
    expect(broken.gates.find((g) => g.id === "build")!.reason).toContain("missing required platform windows");
  });
});
