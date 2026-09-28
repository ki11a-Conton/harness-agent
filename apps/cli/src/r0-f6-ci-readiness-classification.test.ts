/**
 * R0 / F6 — RED counterexamples for `scripts/e4/ci-readiness.mjs:105-140`
 * (plan(20260928-105425).md §R0 line 62 and §R7 lines 199-219).
 *
 * THE DEFECT (P1): the forward basis is inferred from PROSE
 *
 *     readinessText.includes("SYNTHETIC") ? "SYNTHETIC_FIXTURE_BUILD"
 *                                         : "REAL_DUAL_PINNED_BUILD"
 *
 * so ANY other string — lowercase `synthetic`, an empty string, an unrelated
 * sentence — is classified as a REAL dual pinned build and can render
 * `realBuildOfflineReady = PASS`. A doc/wording edit therefore moves a gate.
 * Separately, `platforms.ubuntu.status` is the hardcoded literal `NOT_PROVEN`,
 * so a genuine artifact produced ON ubuntu-latest still reports Ubuntu as
 * unproven.
 *
 * THESE TESTS ARE DELIBERATELY RED. They assert the TARGET (post-R7) behaviour.
 * They must not be collected by `pnpm test`: the root config EXCLUDES exactly
 * these two files and `r0-gaps-vitest.config.ts` selects them (the same
 * H04/B0/N0 arrangement as `prereg-n0-gaps.test.ts`).
 * R7 owns the fix; R0 does NOT touch production source.
 *
 * HOW THIS REPRODUCES BEHAVIOURALLY (not by string-matching the source): the
 * real script is executed with mutated `--e2e` inputs and its real JSON output
 * artifact is asserted. Two things make that fast and deterministic:
 *   - the three nested gate subprocesses (`pnpm test:n0-gaps`,
 *     `pnpm test:red-next-gaps`, docs smoke) are neutralised by a `pnpm` shim
 *     first on PATH. The assertion targets the CLASSIFICATION, not the gates;
 *     a real unshimmed run (~45 s) is recorded in the R0 matrix.
 *   - the Ubuntu case overrides `process.platform` to `linux` through a
 *     `--import` preload, so the Linux branch really executes. This is a
 *     SIMULATION, not a real Ubuntu runner: Ubuntu-Actions itself was NOT run
 *     (the matrix says so explicitly).
 *
 * OFFLINE: local files + local child processes only. No provider, no key, no
 * network, no paid request.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "e4", "ci-readiness.mjs");

const CREATED: string[] = [];
afterAll(() => {
  for (const dir of CREATED) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup only */
    }
  }
});

interface ReadinessArtifact {
  os: { label: string; platform: string; arch: string; node: string };
  platforms: { windows: { status: string }; ubuntu: { status: string; detail: string } };
  commandExits: Record<string, number | null>;
  counts: Record<string, number | null>;
  forwardBasis: string | null;
  levels: Record<string, { status: string; basis: string; blocker?: string | null }>;
}

function runReadiness(
  readiness: string | null,
  opts: { linuxSimulation?: boolean; osLabel?: string } = {},
): { exitCode: number | null; artifact: ReadinessArtifact; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "r0-f6-"));
  CREATED.push(dir);

  const e2e: Record<string, unknown> = {
    ok: true,
    positiveExecution: {
      providerFactoryCalls: 0,
      physicalProviderCalls: 124,
      ledgerCommitted: 124,
      journalChargedTokens: 248,
      evidenceVerified: 124,
      evidenceUnverified: 0,
      decision: "INCONCLUSIVE",
    },
    positiveForward: {
      physicalStubRequests: 124,
      ledgerCommitted: 124,
      journalChargedTokens: 248,
      aggregateTokensDelta: 248,
    },
  };
  if (readiness !== null) e2e["readiness"] = { productionOfflineReady: readiness };

  const e2ePath = join(dir, "e2e.json");
  writeFileSync(e2ePath, JSON.stringify(e2e), "utf8");
  const outPath = join(dir, "readiness.json");

  // Neutralise the three nested gate subprocesses: the subject of these tests is
  // the classification of `readiness.productionOfflineReady`, never the gates.
  const shimDir = join(dir, "bin");
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, "pnpm.cmd"), "@echo off\r\nexit /b 0\r\n", "utf8");
  writeFileSync(join(shimDir, "pnpm"), "#!/bin/sh\nexit 0\n", "utf8");

  const args = [SCRIPT, "--e2e", e2ePath, "--out", outPath, "--os-label", opts.osLabel ?? "windows-local"];
  let nodeArgs = args;
  if (opts.linuxSimulation === true) {
    // A minimal preload that makes the Linux/Ubuntu branch actually execute.
    const preload = join(dir, "platform-linux.mjs");
    writeFileSync(
      preload,
      'Object.defineProperty(process, "platform", { value: "linux", configurable: true });\n',
      "utf8",
    );
    nodeArgs = ["--import", pathToFileURL(preload).href, ...args];
  }

  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: `${shimDir};${process.env["PATH"] ?? ""}` },
  });
  const artifact = JSON.parse(readFileSync(outPath, "utf8")) as ReadinessArtifact;
  return { exitCode: result.status, artifact, stderr: result.stderr ?? "" };
}

describe("R0/F6 — readiness is classified from prose, and Ubuntu is hardcoded NOT_PROVEN", () => {
  it("R0-F6-0 (control, PASSES today): the script really runs and the fixture counts really reach the artifact", () => {
    const { exitCode, artifact } = runReadiness("SYNTHETIC fixture arm builds (writeArmCheckout equals this)");
    expect(artifact.os.label).toBe("windows-local");
    expect(artifact.counts["forwardJournalChargedTokens"]).toBe(248);
    // The script exits 0 when it wrote an artifact, whatever the levels say.
    expect(exitCode).toBe(0);
  });

  it("R0-F6-A (RED): LOWERCASE 'synthetic' prose must not be classified as a REAL dual pinned build", () => {
    const { artifact } = runReadiness("synthetic fixture arm builds (writeArmCheckout equals this)");
    // TARGET: an unrecognised prose value is NOT a real build (plan §R7 #1: only
    // known enums plus matching evidence may set REAL; unknown is NOT_PROVEN).
    expect(artifact.forwardBasis).not.toBe("REAL_DUAL_PINNED_BUILD");
    expect(artifact.levels["realBuildOfflineReady"]?.status).not.toBe("PASS");
  });

  it("R0-F6-B (RED): an EMPTY readiness string must not be classified as a REAL dual pinned build", () => {
    const { artifact } = runReadiness("");
    // TARGET: empty is UNKNOWN, never REAL (the code comment itself promises
    // "an unreadable statement is UNKNOWN, not real").
    expect(artifact.forwardBasis).not.toBe("REAL_DUAL_PINNED_BUILD");
    expect(artifact.levels["realBuildOfflineReady"]?.status).not.toBe("PASS");
  });

  it("R0-F6-C (RED): UNRELATED text must not be classified as a REAL dual pinned build", () => {
    const { artifact } = runReadiness("forward closed loop completed; evidence verified by the local harness");
    // TARGET: prose that names no known basis at all cannot upgrade a gate.
    expect(artifact.forwardBasis).not.toBe("REAL_DUAL_PINNED_BUILD");
    expect(artifact.levels["realBuildOfflineReady"]?.status).not.toBe("PASS");
  });

  it("R0-F6-D (control, PASSES today): an ABSENT readiness field is already fail-closed", () => {
    const { artifact } = runReadiness(null);
    // The current code handles ABSENCE conservatively — only a present-but-
    // unrecognised STRING is misclassified. This control isolates the defect.
    expect(artifact.forwardBasis).not.toBe("REAL_DUAL_PINNED_BUILD");
    expect(artifact.levels["realBuildOfflineReady"]?.status).not.toBe("PASS");
  });

  it("R0-F6-E (RED): on a Linux/Ubuntu run this process's OWN platform must be MEASURED, not hardcoded NOT_PROVEN", () => {
    const { artifact } = runReadiness("SYNTHETIC fixture arm builds (writeArmCheckout equals this)", {
      linuxSimulation: true,
      osLabel: "ubuntu-latest",
    });
    // Sanity (passes today): the preload really moved the process onto the
    // Linux branch, so the RED below is the hardcode — not a failed simulation.
    expect(artifact.os.platform).toBe("linux");
    expect(artifact.platforms.windows.status).toBe("NOT_OBSERVED");
    // TARGET: this platform was measured by this process, so Ubuntu is MEASURED
    // (plan §R7 #2: "fix the Ubuntu field still writing NOT_PROVEN").
    expect(artifact.platforms.ubuntu.status).toBe("MEASURED");
  });
});
